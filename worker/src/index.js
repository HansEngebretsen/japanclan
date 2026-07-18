/* japanclan-mail: email → parse → Firestore itinerary.
   Flow (see ../SETUP.md): loop-guard → gate sender → rate-limit → commands
   (YES/NO/UNDO/STATUS/HELP) → archive copy → dedup → parse ALL bookings in the
   email (ICS fast path, else one Gemini call) → group each into a trip by
   date → validate → auto-add (or propose, when unsure) → merge write → one
   reply summarizing everything. Handled failures land in
   pipeline/state/pending and reply politely; only truly unexpected crashes
   bounce (so the sender's server retries). */

import PostalMime from "postal-mime";
import { loadConfig } from "./config.js";
import { getDoc, setDoc, deleteDoc, latestDocs } from "./firestore.js";
import { trimEmail, extractIcsEvents, geminiParseEvents, validateEvent } from "./parse.js";
import { applyEvent, resolveTripByDate, fmtTime, localParts } from "./map.js";
import { replyTo } from "./reply.js";
import { parseCommand, HELP_TEXT } from "./commands.js";

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nowIso() { return new Date().toISOString(); }
function logId() { return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; }

function describe(ev) {
  const p = localParts(ev.startDateTime);
  const when = p ? `${p.mo}/${p.d} at ${fmtTime(ev.startDateTime)}` : "unknown time";
  return `${ev.title} (${ev.type}, ${when})`;
}

/* Never talk to robots: skip bounces, autoresponders, and our own domain so a
   vacation reply or delivery notice can't start a mail loop. */
function isAutomated(message, from) {
  const auto = (message.headers.get("auto-submitted") || "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(mailer-daemon|postmaster|no-?reply|donotreply)@/i.test(from)) return true;
  const ourDomain = (message.to || "").split("@")[1];
  if (ourDomain && from.endsWith(`@${ourDomain}`)) return true;
  return false;
}

export default {
  async email(message, env, ctx) {
    const started = Date.now();
    const from = (message.from || "").toLowerCase();
    const to = (message.to || "").toLowerCase();

    if (isAutomated(message, from)) return; // drop silently

    let cfg;
    try {
      cfg = await loadConfig(env);
    } catch (e) {
      console.error("config load failed:", e);
      message.setReject("Service temporarily unavailable"); // sender's server will retry
      return;
    }

    const subject = message.headers.get("subject") || "";
    const writeLog = (entry) =>
      setDoc(env, `pipeline/state/log/${logId()}`, {
        from, to, subject, ts: nowIso(), ms: Date.now() - started, ...entry,
      }).catch((e) => console.error("log write failed:", e));
    const safeReply = async (text) => {
      try { await replyTo(message, text); }
      catch (e) { console.error("reply failed:", e); }
    };

    // ---- security boundary: only allowlisted senders proceed ----
    const sender = cfg.senders?.[from];
    if (!sender) {
      ctx.waitUntil(writeLog({ outcome: "rejected-sender" }));
      message.setReject("Address not authorized");
      return;
    }

    // ---- per-sender daily cap (bounds Gemini/Firestore use if an account is compromised) ----
    const day = nowIso().slice(0, 10);
    const rateId = `${from.replace(/[^a-z0-9@._-]/g, "_")}-${day}`;
    const max = cfg.options?.maxPerSenderPerDay ?? 30;
    const rate = await getDoc(env, `pipeline/state/rate/${rateId}`).catch(() => null);
    const count = rate?.data?.count || 0;
    if (count >= max) {
      await writeLog({ outcome: "rate-limited" });
      await safeReply(`You've hit today's limit of ${max} emails — try again tomorrow.`);
      return;
    }
    ctx.waitUntil(setDoc(env, `pipeline/state/rate/${rateId}`, { count: count + 1, ts: nowIso() })
      .catch((e) => console.error("rate write failed:", e)));

    const pending = (status, extra = {}) =>
      setDoc(env, `pipeline/state/pending/${crypto.randomUUID()}`, {
        from, subject, receivedAt: nowIso(), ts: nowIso(), status, ...extra,
      }).catch((e) => console.error("pending write failed:", e));

    try {
      const parsed = await PostalMime.parse(message.raw);

      // ---- thread commands: the whole UX lives in email replies ----
      const cmd = parseCommand(parsed);
      if (cmd) {
        await this.handleCommand(cmd, { message, env, cfg, from, safeReply, writeLog });
        return;
      }

      const provisionalId = cfg.addresses?.[to] || cfg.addresses?.[to.replace(/\+[^@]*@/, "@")] || sender.trip;
      const provisionalTrip = cfg.trips?.[provisionalId];

      // durable archive of every accepted email (verified destination address)
      if (cfg.options?.archiveTo) {
        try { await message.forward(cfg.options.archiveTo); }
        catch (e) { console.error("archive forward failed:", e); }
      }

      // ---- dedup #1: exact same email re-forwarded (create-only write is race-safe) ----
      const messageId = parsed.messageId || message.headers.get("message-id") || crypto.randomUUID();
      try {
        await setDoc(env, `pipeline/state/dedup/${await sha256(messageId)}`,
          { kind: "message-id", ts: nowIso() }, { mustNotExist: true });
      } catch (e) {
        if (e.code === "ALREADY_EXISTS") {
          await safeReply("Already handled this exact email — nothing to do. 👍");
          await writeLog({ outcome: "duplicate-message" });
          return;
        }
        throw e;
      }

      // ---- parse every booking in the email ----
      let tier = 0;
      let events = extractIcsEvents(parsed, provisionalTrip);
      if (!events.length) {
        tier = 2;
        const text = trimEmail(parsed, cfg.llm?.maxInputChars || 8000);
        events = await geminiParseEvents(env, cfg, text, provisionalTrip);
      }
      if (!events.length) {
        await pending("unparseable");
        await safeReply("Couldn't find a booking or event in this email. It's saved in the review queue — reply HELP for what I can read.");
        await writeLog({ outcome: "unparseable", tier });
        return;
      }

      // ---- per-event: group into a trip by date, validate, band by confidence ----
      const autoThreshold = cfg.llm?.autoThreshold ?? 0.75;
      const lines = [];
      const byTrip = new Map(); // tripId → { trip, events: [] }
      let anyProposed = false;

      for (const raw of events) {
        const resolved = raw.startDateTime ? resolveTripByDate(cfg, raw, provisionalId) : null;
        if (!resolved) {
          const v0 = validateEvent(raw, null);
          await pending("out-of-range", { parsed: v0.ok ? v0.ev : null });
          lines.push(`✳️ ${raw.title || "One item"} — falls outside every trip window, saved for review.`);
          continue;
        }
        const v = validateEvent(raw, resolved.trip);
        if (!v.ok) {
          await pending(v.reason, { parsed: null });
          lines.push(`✳️ ${raw.title || "One item"} — couldn't read it confidently, saved for review.`);
          continue;
        }
        const ev = v.ev;
        if (ev.confidence < autoThreshold) {
          await pending("proposed", { parsed: JSON.parse(JSON.stringify(ev)), tripId: resolved.id });
          lines.push(`❓ I *think* this is ${describe(ev)} — reply YES to add it, NO to discard.`);
          anyProposed = true;
          continue;
        }
        // dedup #2: same booking re-sent with a new Message-ID
        if (ev.confirmation) {
          const key = await sha256(`${resolved.id}|${ev.type}|${ev.confirmation}|${ev.startDateTime}`);
          try {
            await setDoc(env, `pipeline/state/dedup/${key}`,
              { kind: "confirmation", tripId: resolved.id, ts: nowIso() }, { mustNotExist: true });
          } catch (e) {
            if (e.code === "ALREADY_EXISTS") {
              lines.push(`↩️ ${describe(ev)} — already on the calendar.`);
              continue;
            }
            throw e;
          }
        }
        if (!byTrip.has(resolved.id)) byTrip.set(resolved.id, { trip: resolved.trip, events: [] });
        byTrip.get(resolved.id).events.push(ev);
      }

      // ---- one merge-write per trip, with optimistic concurrency + undo snapshot ----
      for (const [tripId, group] of byTrip) {
        for (let attempt = 0; ; attempt++) {
          const cur = await getDoc(env, group.trip.itineraryPath);
          let data = cur?.data || {};
          const applied = [];
          for (const ev of group.events) {
            const res = applyEvent(data, ev, group.trip);
            if (res.conflict) {
              await pending("conflict", { parsed: JSON.parse(JSON.stringify(ev)), tripId, conflict: res.conflict });
              lines.push(`⚠️ ${describe(ev)} — ${res.conflict}. Saved for manual placement.`);
            } else {
              data = res.data;
              applied.push(res.summary);
            }
          }
          if (!applied.length) break;
          try {
            const afterUpdateTime = await setDoc(env, group.trip.itineraryPath, data,
              cur ? { updateTime: cur.updateTime } : {});
            for (const s of applied) lines.push(`✅ Added: ${s}`);
            ctx.waitUntil(setDoc(env, `pipeline/state/applied/${logId()}`, {
              from, ts: nowIso(), tripId, itineraryPath: group.trip.itineraryPath,
              before: cur?.data || {}, afterUpdateTime, summary: applied.join("; "),
            }).catch((e) => console.error("applied write failed:", e)));
            break;
          } catch (e) {
            if (e.code === "FAILED_PRECONDITION" && attempt < 1) continue; // doc changed underneath us — redo once
            throw e;
          }
        }
      }

      const footer = anyProposed
        ? "" : "\n\nReply UNDO to remove what was just added, or HELP for everything I understand.";
      await safeReply(`${lines.join("\n")}${footer}`);
      await writeLog({ outcome: "processed", tier, events: events.length, result: lines.join(" | ").slice(0, 400) });
    } catch (err) {
      console.error("pipeline error:", err);
      await pending("error", { error: String(err).slice(0, 500) });
      await safeReply("Something went wrong processing this email. It's saved in the review queue.");
      await writeLog({ outcome: "error", error: String(err).slice(0, 300) });
    }
  },

  async handleCommand(cmd, { env, cfg, from, safeReply, writeLog }) {
    if (cmd === "help") {
      await safeReply(HELP_TEXT);
      await writeLog({ outcome: "cmd-help" });
      return;
    }

    if (cmd === "status") {
      const logs = await latestDocs(env, "pipeline/state", "log", 8);
      const lines = logs
        .filter((l) => !String(l.data.outcome || "").startsWith("cmd-"))
        .slice(0, 6)
        .map((l) => `• ${l.data.ts?.slice(5, 16).replace("T", " ")} — ${l.data.outcome}: ${(l.data.result || l.data.subject || "").slice(0, 90)}`);
      await safeReply(lines.length ? `Recent activity:\n\n${lines.join("\n")}` : "No activity yet.");
      await writeLog({ outcome: "cmd-status" });
      return;
    }

    if (cmd === "undo") {
      const applied = (await latestDocs(env, "pipeline/state", "applied", 10))
        .find((d) => d.data.from === from);
      if (!applied) {
        await safeReply("Nothing of yours to undo.");
        await writeLog({ outcome: "cmd-undo-none" });
        return;
      }
      const cur = await getDoc(env, applied.data.itineraryPath);
      if (!cur || cur.updateTime !== applied.data.afterUpdateTime) {
        await safeReply("The calendar has changed since that was added, so I won't auto-undo it. Remove it in the app/console if needed.");
        await writeLog({ outcome: "cmd-undo-stale" });
        return;
      }
      await setDoc(env, applied.data.itineraryPath, applied.data.before || {}, { updateTime: cur.updateTime });
      await deleteDoc(env, applied.path);
      await safeReply(`Removed: ${applied.data.summary} ✅`);
      await writeLog({ outcome: "cmd-undo", result: applied.data.summary });
      return;
    }

    // yes / no — resolve the sender's newest pending proposal
    const proposal = (await latestDocs(env, "pipeline/state", "pending", 10))
      .find((d) => d.data.from === from && d.data.status === "proposed");
    if (!proposal) {
      await safeReply("Nothing waiting on a yes/no from you right now.");
      await writeLog({ outcome: `cmd-${cmd}-none` });
      return;
    }
    if (cmd === "no") {
      await deleteDoc(env, proposal.path);
      await safeReply("Discarded. 👍");
      await writeLog({ outcome: "cmd-no" });
      return;
    }
    // YES → apply the stored event with the normal write path
    const ev = proposal.data.parsed;
    const tripId = proposal.data.tripId;
    const trip = cfg.trips?.[tripId];
    if (!ev || !trip) {
      await safeReply("That proposal isn't valid anymore — forward the original email again.");
      await deleteDoc(env, proposal.path);
      await writeLog({ outcome: "cmd-yes-invalid" });
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const cur = await getDoc(env, trip.itineraryPath);
      const res = applyEvent(cur?.data || {}, ev, trip);
      if (res.conflict) {
        await safeReply(`Couldn't add it: ${res.conflict}. It stays in the review queue.`);
        await writeLog({ outcome: "cmd-yes-conflict" });
        return;
      }
      try {
        const afterUpdateTime = await setDoc(env, trip.itineraryPath, res.data,
          cur ? { updateTime: cur.updateTime } : {});
        await setDoc(env, `pipeline/state/applied/${logId()}`, {
          from, ts: nowIso(), tripId, itineraryPath: trip.itineraryPath,
          before: cur?.data || {}, afterUpdateTime, summary: res.summary,
        });
        await deleteDoc(env, proposal.path);
        await safeReply(`Added: ${res.summary} ✅\n\nReply UNDO to remove it.`);
        await writeLog({ outcome: "cmd-yes", result: res.summary });
        return;
      } catch (e) {
        if (e.code === "FAILED_PRECONDITION" && attempt < 1) continue;
        throw e;
      }
    }
  },
};
