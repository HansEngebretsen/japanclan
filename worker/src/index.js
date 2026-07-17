/* japanclan-mail: email → parse → Firestore itinerary.
   Flow (see ../SETUP.md): gate sender → archive copy → dedup → ICS fast path
   or one Gemini call → validate → merge into the itinerary doc → reply.
   Handled failures land in pipeline/state/pending and reply politely; only
   truly unexpected crashes bounce (so the sender's server retries). */

import PostalMime from "postal-mime";
import { loadConfig } from "./config.js";
import { getDoc, setDoc } from "./firestore.js";
import { trimEmail, extractIcsEvent, geminiParse, validateEvent } from "./parse.js";
import { applyEvent } from "./map.js";
import { replyTo } from "./reply.js";

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nowIso() { return new Date().toISOString(); }
function logId() { return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; }

export default {
  async email(message, env, ctx) {
    const started = Date.now();
    const from = (message.from || "").toLowerCase();
    const to = (message.to || "").toLowerCase();

    let cfg;
    try {
      cfg = await loadConfig(env);
    } catch (e) {
      console.error("config load failed:", e);
      message.setReject("Service temporarily unavailable"); // sender's server will retry
      return;
    }

    const writeLog = (entry) =>
      setDoc(env, `pipeline/state/log/${logId()}`, {
        from, to, subject: message.headers.get("subject") || "", ts: nowIso(),
        ms: Date.now() - started, ...entry,
      }).catch((e) => console.error("log write failed:", e));

    // ---- security boundary: only allowlisted senders proceed ----
    const sender = cfg.senders?.[from];
    if (!sender) {
      ctx.waitUntil(writeLog({ outcome: "rejected-sender" }));
      message.setReject("Address not authorized");
      return;
    }

    // ---- trip routing: To-address override, else sender's default trip ----
    const plusStripped = to.replace(/\+[^@]*@/, "@");
    const tripId = cfg.addresses?.[to] || cfg.addresses?.[plusStripped] || sender.trip;
    const trip = cfg.trips?.[tripId];

    const pending = (status, extra = {}) =>
      setDoc(env, `pipeline/state/pending/${crypto.randomUUID()}`, {
        tripId: tripId || null, from, subject: message.headers.get("subject") || "",
        receivedAt: nowIso(), status, ...extra,
      }).catch((e) => console.error("pending write failed:", e));

    try {
      if (!trip?.itineraryPath) throw new Error(`no trip config for "${tripId}"`);

      // durable archive of every accepted email (verified destination address)
      if (cfg.options?.archiveTo) {
        try { await message.forward(cfg.options.archiveTo); }
        catch (e) { console.error("archive forward failed:", e); }
      }

      const parsed = await PostalMime.parse(message.raw);
      const messageId = parsed.messageId || message.headers.get("message-id") || crypto.randomUUID();

      // ---- dedup #1: exact same email re-forwarded (create-only write is race-safe) ----
      try {
        await setDoc(env, `pipeline/state/dedup/${await sha256(messageId)}`,
          { kind: "message-id", tripId, ts: nowIso() }, { mustNotExist: true });
      } catch (e) {
        if (e.code === "ALREADY_EXISTS") {
          if (cfg.options?.replyOnSuccess !== false) {
            await replyTo(message, "Already added this one to the calendar — nothing to do. 👍");
          }
          await writeLog({ outcome: "duplicate-message" });
          return;
        }
        throw e;
      }

      // ---- parse: ICS fast path (0 tokens), else one Gemini call ----
      let tier = 0;
      let ev = extractIcsEvent(parsed, trip);
      if (!ev) {
        tier = 2;
        const text = trimEmail(parsed, cfg.llm?.maxInputChars || 8000);
        ev = await geminiParse(env, cfg, text, trip);
      }

      const v = validateEvent(ev, trip);
      if (!v.ok) {
        await pending(v.reason, { parsed: ev ? JSON.parse(JSON.stringify(ev)) : null });
        if (cfg.options?.replyOnFailure !== false) {
          await replyTo(message, v.reason === "out-of-range"
            ? "That looks like it falls outside the trip dates, so I didn't add it. It's saved in the review queue."
            : "Couldn't confidently read a booking or event out of this email. It's saved in the review queue.");
        }
        await writeLog({ outcome: v.reason, tier });
        return;
      }
      ev = v.ev;

      // ---- dedup #2: same booking re-sent with a new Message-ID ----
      if (ev.confirmation) {
        const key = await sha256(`${tripId}|${ev.type}|${ev.confirmation}|${ev.startDateTime}`);
        try {
          await setDoc(env, `pipeline/state/dedup/${key}`,
            { kind: "confirmation", tripId, confirmation: ev.confirmation, ts: nowIso() },
            { mustNotExist: true });
        } catch (e) {
          if (e.code === "ALREADY_EXISTS") {
            if (cfg.options?.replyOnSuccess !== false) {
              await replyTo(message, `Confirmation ${ev.confirmation} is already on the calendar — nothing to do. 👍`);
            }
            await writeLog({ outcome: "duplicate-confirmation", tier });
            return;
          }
          throw e;
        }
      }

      // ---- merge write with optimistic concurrency (retry once) ----
      let summary = null;
      for (let attempt = 0; ; attempt++) {
        const cur = await getDoc(env, trip.itineraryPath);
        const res = applyEvent(cur?.data || {}, ev, trip);
        if (res.conflict) {
          await pending("conflict", { parsed: JSON.parse(JSON.stringify(ev)), conflict: res.conflict });
          if (cfg.options?.replyOnFailure !== false) {
            await replyTo(message, `Couldn't add "${ev.title}": ${res.conflict}. It's saved in the review queue for manual placement.`);
          }
          await writeLog({ outcome: "conflict", tier });
          return;
        }
        try {
          await setDoc(env, trip.itineraryPath, res.data, cur ? { updateTime: cur.updateTime } : {});
          summary = res.summary;
          break;
        } catch (e) {
          if (e.code === "FAILED_PRECONDITION" && attempt < 1) continue; // doc changed underneath us — re-read once
          throw e;
        }
      }

      if (cfg.options?.replyOnSuccess !== false) {
        await replyTo(message, `Added to the calendar ✅\n\n${summary}\n\nIt's live in the app now.`);
      }
      await writeLog({ outcome: "added", tier, summary });
    } catch (err) {
      console.error("pipeline error:", err);
      await pending("error", { error: String(err).slice(0, 500) });
      try {
        if (cfg.options?.replyOnFailure !== false) {
          await replyTo(message, "Something went wrong processing this email. It's saved in the review queue.");
        }
      } catch (e) { console.error("failure reply failed:", e); }
      await writeLog({ outcome: "error", error: String(err).slice(0, 300) });
    }
  },
};
