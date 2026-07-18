/* Parsing pipeline: trim email text, try the zero-cost ICS fast path, else one
   Gemini structured-output call. All paths emit the same ParsedEvent shape:
   { type, title, startDateTime, endDateTime?, timezoneOffset, endTimezoneOffset?,
     locationName?, address?, confirmation?, seats?, carrierNumber?, details[], confidence } */

import { DEFAULT_PROMPT } from "./config.js";

/* ---------- text trimming ---------- */

export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return s;
}

/* NOTE: forwarded bookings often arrive as quoted text, so we deliberately do
   NOT strip quote blocks — only cruft that carries no booking facts. */
export function trimEmail(parsed, maxChars = 8000) {
  let body = (parsed.text || "").trim();
  if (!body) body = htmlToText(parsed.html || "");
  // long tracking URLs → just the host (keeps airline/hotel names, drops tokens)
  body = body.replace(/https?:\/\/[^\s)>\]]{60,}/g, (u) => {
    try { return new URL(u).origin; } catch { return ""; }
  });
  body = body.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const head = [
    parsed.subject ? `Subject: ${parsed.subject}` : null,
    parsed.from?.address ? `From: ${parsed.from.name || ""} <${parsed.from.address}>` : null,
    parsed.date ? `Date: ${parsed.date}` : null,
  ].filter(Boolean).join("\n");
  return `${head}\n\n${body}`.slice(0, maxChars);
}

/* ---------- Tier 0: ICS fast path (zero tokens) ---------- */

const TZ_OFFSETS = {
  "Asia/Tokyo": "+09:00", "Japan": "+09:00", "Asia/Sapporo": "+09:00",
  "America/Los_Angeles": "-07:00", "America/Denver": "-06:00",
  "America/Chicago": "-05:00", "America/New_York": "-04:00",
  "UTC": "+00:00", "Etc/UTC": "+00:00",
};

function icsDateToIso(value, tzid, defaultOffset) {
  // 20260714T133000Z | 20260714T133000 (+TZID) | 20260714 (all-day)
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", , z] = m;
  if (z) {
    const offset = defaultOffset || "+09:00";
    const om = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!om) return null;
    const mins = (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi) + mins * 60000);
    const p = (n) => String(n).padStart(2, "0");
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00${offset}`;
  }
  const offset = (tzid && TZ_OFFSETS[tzid]) || (tzid ? null : defaultOffset);
  if (!offset) return null; // unknown named zone → let Gemini handle it
  return `${y}-${mo}-${d}T${hh}:${mi}:00${offset}`;
}

function classifySummary(s) {
  const t = s.toLowerCase();
  if (/flight|✈/.test(t)) return "flight";
  if (/train|rail|shinkansen/.test(t)) return "train";
  if (/hotel|check.?in|stay|ryokan|inn\b|resort/.test(t)) return "lodging";
  if (/dinner|lunch|breakfast|restaurant|omakase|reservation at/.test(t)) return "dining";
  return "event";
}

export function icsToEvents(icsText, defaultOffset) {
  const unfolded = String(icsText).replace(/\r?\n[ \t]/g, "");
  const events = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let block;
  while ((block = re.exec(unfolded)) && events.length < 5) {
    const ev = vevent(block[1], defaultOffset);
    if (ev) events.push(ev);
  }
  return events;
}

export function icsToEvent(icsText, defaultOffset) {
  return icsToEvents(icsText, defaultOffset)[0] || null;
}

function vevent(body, defaultOffset) {
  const props = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Z-]+)((?:;[^:]+)?):(.*)$/.exec(line.trim());
    if (!m) continue;
    const tzid = /TZID=([^;:]+)/.exec(m[2] || "");
    props[m[1]] = { value: m[3], tzid: tzid ? tzid[1] : null };
  }
  if (!props.DTSTART || !props.SUMMARY?.value) return null;
  const start = icsDateToIso(props.DTSTART.value, props.DTSTART.tzid, defaultOffset);
  if (!start) return null;
  const end = props.DTEND ? icsDateToIso(props.DTEND.value, props.DTEND.tzid, defaultOffset) : null;
  const summary = props.SUMMARY.value.replace(/\\,/g, ",").replace(/\\n/g, " ").trim();
  const location = props.LOCATION ? props.LOCATION.value.replace(/\\,/g, ",").trim() : null;
  const desc = props.DESCRIPTION ? props.DESCRIPTION.value.replace(/\\n/g, "\n") : "";
  const conf = /(?:confirmation|conf(?:irmation)?\s*(?:no|number|code)?|record locator|booking (?:ref|reference|id))[\s#:.]*([A-Z0-9]{5,10})\b/i.exec(desc);
  return {
    type: classifySummary(summary),
    title: summary.slice(0, 80),
    startDateTime: start,
    endDateTime: end,
    timezoneOffset: start.slice(-6),
    locationName: location,
    address: null,
    confirmation: conf ? conf[1] : null,
    seats: null,
    carrierNumber: null,
    details: [],
    confidence: 0.9,
  };
}

export function extractIcsEvents(parsed, tripCfg) {
  const defaultOffset = tripCfg?.tzOffset || "+09:00";
  const out = [];
  const seen = new Set();
  for (const a of parsed.attachments || []) {
    const isIcs = /text\/calendar/i.test(a.mimeType || "") || /\.ics$/i.test(a.filename || "");
    if (!isIcs) continue;
    if ((a.content?.byteLength || a.content?.length || 0) > 1_000_000) continue; // ICS files are tiny; skip anything suspicious
    try {
      const content = typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content);
      for (const ev of icsToEvents(content, defaultOffset)) {
        const key = `${ev.title}|${ev.startDateTime}`;
        if (!seen.has(key)) { seen.add(key); out.push(ev); }
      }
    } catch { /* fall through to Gemini */ }
  }
  return out;
}

/* ---------- Tier 2: Gemini structured output ---------- */

const EVENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: ["flight", "train", "lodging", "event", "dining", "none"] },
    title: { type: "STRING" },
    startDateTime: { type: "STRING" },
    endDateTime: { type: "STRING", nullable: true },
    timezoneOffset: { type: "STRING" },
    endTimezoneOffset: { type: "STRING", nullable: true },
    locationName: { type: "STRING", nullable: true },
    address: { type: "STRING", nullable: true },
    confirmation: { type: "STRING", nullable: true },
    seats: { type: "STRING", nullable: true },
    carrierNumber: { type: "STRING", nullable: true },
    details: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "NUMBER" },
  },
  required: ["type", "title", "startDateTime", "timezoneOffset", "confidence"],
};

/* One email can hold several bookings (outbound + return flights, multi-night
   packages), so the model returns an array. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: { events: { type: "ARRAY", items: EVENT_SCHEMA } },
  required: ["events"],
};

async function geminiCall(env, model, prompt, text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${prompt}\n\nEMAIL:\n"""\n${text}\n"""` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    const err = new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const out = await res.json();
  const raw = out.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned no candidate text");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.events) ? parsed.events.slice(0, 5) : [];
}

/* Returns ParsedEvent[]. Retries once; a quota/availability failure retries on
   the fallback model so a tightened free tier never silently kills the
   pipeline. Both model names are config-switchable without a redeploy. */
export async function geminiParseEvents(env, cfg, text, tripCfg) {
  const model = cfg.llm?.model || "gemini-2.5-flash";
  const fallback = cfg.llm?.fallbackModel || "gemini-2.5-flash-lite";
  const tripWindow = tripCfg
    ? `the trip runs ${tripCfg.year}-${String(tripCfg.month).padStart(2, "0")}-${tripCfg.firstDay} to ${tripCfg.year}-${String(tripCfg.month).padStart(2, "0")}-${tripCfg.lastDay}, default timezone ${tripCfg.defaultTz || "GMT+9"} (${tripCfg.tzOffset || "+09:00"})`
    : "unknown trip window";
  const prompt = (cfg.llm?.promptTemplate || DEFAULT_PROMPT)
    .replace("{{tripWindow}}", tripWindow)
    .replace("{{today}}", new Date().toISOString().slice(0, 10));
  try {
    return await geminiCall(env, model, prompt, text);
  } catch (e) {
    console.error("gemini primary failed:", e.message);
    const retryModel = (e.status === 429 || e.status >= 500) && fallback !== model ? fallback : model;
    return await geminiCall(env, retryModel, prompt, text);
  }
}

/* ---------- validation / sanitization (applies to every parse path) ---------- */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function clean(s, max) {
  if (s === null || s === undefined) return null;
  const out = String(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return out || null;
}

export function validateEvent(ev, tripCfg) {
  if (!ev || typeof ev !== "object") return { ok: false, reason: "unparseable" };
  if (ev.type === "none" || !["flight", "train", "lodging", "event", "dining"].includes(ev.type)) {
    return { ok: false, reason: "unparseable" };
  }
  if (typeof ev.confidence === "number" && ev.confidence < 0.5) return { ok: false, reason: "unparseable" };
  const m = ISO_RE.exec(ev.startDateTime || "");
  if (!m) return { ok: false, reason: "unparseable" };
  if (tripCfg) {
    const [, y, mo, d] = m;
    if (Number(y) !== tripCfg.year || Number(mo) !== tripCfg.month
      || Number(d) < tripCfg.firstDay || Number(d) > tripCfg.lastDay) {
      return { ok: false, reason: "out-of-range" };
    }
    if (ev.type === "lodging" && ev.endDateTime) {
      const e = ISO_RE.exec(ev.endDateTime);
      if (!e || Number(e[3]) > tripCfg.lastDay) return { ok: false, reason: "out-of-range" };
    }
  }
  if (ev.endDateTime && !ISO_RE.test(ev.endDateTime)) ev.endDateTime = null;
  const out = {
    type: ev.type,
    title: clean(ev.title, 80) || "Untitled",
    startDateTime: ev.startDateTime,
    endDateTime: ev.endDateTime || null,
    timezoneOffset: /^[+-]\d{2}:\d{2}$/.test(ev.timezoneOffset || "") ? ev.timezoneOffset : (tripCfg?.tzOffset || "+09:00"),
    endTimezoneOffset: /^[+-]\d{2}:\d{2}$/.test(ev.endTimezoneOffset || "") ? ev.endTimezoneOffset : null,
    locationName: clean(ev.locationName, 100),
    address: clean(ev.address, 140),
    confirmation: clean(ev.confirmation, 20),
    seats: clean(ev.seats, 60),
    carrierNumber: clean(ev.carrierNumber, 60),
    details: Array.isArray(ev.details) ? ev.details.map((d) => clean(d, 90)).filter(Boolean).slice(0, 6) : [],
    confidence: typeof ev.confidence === "number" ? ev.confidence : 1,
  };
  return { ok: true, ev: out };
}
