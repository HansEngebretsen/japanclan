/* HTTP surface: the app's "Add to calendar" box.

   Deliberately one route. Past the auth check this worker writes Firestore
   with a service-account JWT, which bypasses firestore.rules, so the gate is
   the whole security story: a verified Firebase ID token, an email on the same
   allowlist the app itself enforces, and a per-user daily cap.

   The parse → resolve → validate → apply chain is the *same* one the email
   path runs, so a pasted booking behaves identically to a forwarded one and
   both inherit the same tests. */

import { loadConfig } from "./config.js";
import { getDoc, setDoc } from "./firestore.js";
import { geminiParseEvents, validateEvent } from "./parse.js";
import { applyEvent, resolveTripByDate, removeEvent } from "./map.js";
import { verifyIdToken, AuthError } from "./auth.js";
import { saInfo } from "./gauth.js";

const MAX_TEXT = 2000;
const MAX_PER_USER_PER_DAY = 40;

/* Only the app's own origins. Anything else gets no CORS headers, so a browser
   refuses to hand the response back to the calling page. */
function allowedOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && (u.hostname === "haaans.com" || u.hostname === "www.haaans.com")) return origin;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return origin;
  } catch { /* not a URL */ }
  return null;
}

function cors(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

/* Every outcome gets logged, not just the successes. A refusal with no record
   of the input is impossible to debug after the fact — which is exactly the
   hole this closes. */
function writeLog(env, email, text, entry) {
  return setDoc(env, `pipeline/state/log/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, {
    from: email, to: "app", subject: String(text || "").slice(0, 200),
    ts: new Date().toISOString(), ...entry,
  }).catch((e) => console.error("log write failed:", e));
}

/* The app's allowlist is the source of truth for who may use the app, so it is
   what gates this too — an email sender isn't automatically an app user, or
   the reverse. Returns the trip to bias parsing toward, or null if not allowed. */
async function allowedTrip(env, cfg, email) {
  for (const [id, trip] of Object.entries(cfg.trips || {})) {
    const path = trip.itineraryPath;
    if (!path) continue;
    const allowPath = path.replace(/\/itinerary$/, "/allowlist");
    const doc = await getDoc(env, allowPath).catch(() => null);
    const emails = (doc?.data?.emails || []).map((e) => String(e).toLowerCase());
    if (emails.includes(email)) return { id, trip };
  }
  // fall back to the mail allowlist, so an emailer keeps working if the app
  // list hasn't caught up
  const sender = cfg.senders?.[email];
  if (sender?.trip && cfg.trips?.[sender.trip]) return { id: sender.trip, trip: cfg.trips[sender.trip] };
  return null;
}

export async function handleFetch(request, env) {
  const origin = allowedOrigin(request.headers.get("Origin"));

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const url = new URL(request.url);
  const route = url.pathname;
  if (request.method !== "POST" || (route !== "/add" && route !== "/remove")) {
    return json({ ok: false, error: "Not found" }, 404, origin);
  }
  if (!origin) return json({ ok: false, error: "Origin not allowed" }, 403, null);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Bad request" }, 400, origin); }

  const text = String(body?.text || "").trim();
  /* Replacing re-sends the original text rather than the parsed event: taking
     an event object from the client would mean trusting it to describe what
     the model actually produced. One extra model call, only on conflicts. */
  const replace = body?.replace === true;
  if (route === "/add") {
    if (!text) return json({ ok: false, error: "Paste some event details first." }, 400, origin);
    if (text.length > MAX_TEXT) {
      return json({ ok: false, error: `That's too long — keep it under ${MAX_TEXT} characters.` }, 400, origin);
    }
  }

  let email;
  try {
    // the Firebase project and the GCP project are the same one; take it from
    // the service-account key rather than trusting a separately-set env var
    ({ email } = await verifyIdToken(body?.idToken, saInfo(env).project_id));
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: "Sign in again to make changes." }, 401, origin);
    console.error("token verification error:", e);
    return json({ ok: false, error: "Couldn't verify your sign-in." }, 500, origin);
  }

  let cfg;
  try { cfg = await loadConfig(env); }
  catch (e) {
    console.error("config load failed:", e);
    return json({ ok: false, error: "Service temporarily unavailable." }, 503, origin);
  }

  const match = await allowedTrip(env, cfg, email);
  if (!match) return json({ ok: false, error: "This account isn't allowed to change the calendar." }, 403, origin);

  // per-user daily cap — bounds Gemini and Firestore use if an account is taken over
  const dayKey = new Date().toISOString().slice(0, 10);
  const rateId = `http-${email.replace(/[^a-z0-9@._-]/g, "_")}-${dayKey}`;
  const rate = await getDoc(env, `pipeline/state/rate/${rateId}`).catch(() => null);
  const used = rate?.data?.count || 0;
  if (used >= MAX_PER_USER_PER_DAY) {
    return json({ ok: false, error: `You've hit today's limit of ${MAX_PER_USER_PER_DAY} changes.` }, 429, origin);
  }
  await setDoc(env, `pipeline/state/rate/${rateId}`, { count: used + 1, ts: new Date().toISOString() })
    .catch((e) => console.error("rate write failed:", e));

  if (route === "/remove") return handleRemove(env, origin, email, cfg, match, body);

  let events;
  try { events = await geminiParseEvents(env, cfg, text, match.trip, "manual"); }
  catch (e) {
    console.error("gemini failed:", e);
    await writeLog(env, email, text, { outcome: "http-error", error: String(e).slice(0, 300) });
    return json({ ok: false, error: "Couldn't read that — try rephrasing it." }, 502, origin);
  }
  if (!events.length) {
    await writeLog(env, email, text, { outcome: "http-unparseable" });
    return json({ ok: false, error: "Couldn't find a date in that. Try naming a day on the calendar." }, 422, origin);
  }

  /* Only two things are worth refusing: no readable date, and a date outside
     the trip. Everything else the parser produced gets added.

     TODO: grow the calendar to fit instead of refusing. A date just outside
     the window is far more likely to be a trip that wants extending than a
     mistake, so this should widen the trip's firstDay/lastDay (and the app's
     CAL_DAYS, which is derived from it) rather than bounce the user. Until
     then the message asks them to pick a date already on the calendar. */
  const added = [];
  let rejects = [];
  for (let attempt = 0; ; attempt++) {
    const cur = await getDoc(env, match.trip.itineraryPath);
    let data = cur?.data || {};
    added.length = 0;
    rejects = [];

    for (const raw of events) {
      const resolved = raw.startDateTime ? resolveTripByDate(cfg, raw, match.id) : null;
      if (!resolved) { rejects.push({ kind: "date", ev: raw }); continue; }
      const v = validateEvent(raw, resolved.trip);
      if (!v.ok) { rejects.push({ kind: v.reason === "out-of-range" ? "date" : "invalid", ev: raw }); continue; }
      const res = applyEvent(data, v.ev, resolved.trip, Date.now(), { replaceStay: replace });
      if (res.conflict) { rejects.push({ kind: "conflict", ev: raw, why: res.conflict, info: res.conflictInfo }); continue; }
      data = res.data;
      added.push({ day: data.activity[0].d, ts: data.activity[0].ts, t: data.activity[0].t });
    }

    if (!added.length) {
      /* Report why it actually failed. Collapsing every rejection into "that
         date isn't on the calendar" was worse than unhelpful — a hotel
         colliding with another hotel on the same nights parses perfectly and
         sits well inside the window, so that message was simply false. */
      const t = match.trip;
      const conflict = rejects.find((r) => r.kind === "conflict");
      const invalid = rejects.find((r) => r.kind === "invalid");

      /* A hotel landing on booked nights isn't really an error — it is a
         choice. Hand the app both properties and the nights at stake so it can
         offer a replace, and let it come back with replace:true. */
      if (conflict?.info) {
        await writeLog(env, email, text, { outcome: "http-stay-conflict", result: conflict.why.slice(0, 300) });
        return json({
          ok: false, needsReplace: true, error: conflict.why,
          conflict: conflict.info,
        }, 409, origin);
      }

      let error;
      if (conflict) {
        error = `${conflict.why}. Those nights are already booked, so this one wasn't added.`;
      } else if (invalid) {
        error = "Couldn't read enough of that to put it on the calendar — try including the date and time.";
      } else {
        error = `That date isn't on the calendar — it runs ${t.month}/${t.firstDay} to ${t.month}/${t.lastDay}. Adjust the date and try again.`;
      }
      await writeLog(env, email, text, {
        outcome: `http-rejected-${conflict ? "conflict" : invalid ? "invalid" : "out-of-range"}`,
        result: events.map((e) => `${e.title || "?"} @ ${e.startDateTime || "no date"} → ${e.endDateTime || ""}`).join(" | ").slice(0, 400),
        error: error.slice(0, 300),
      });
      return json({ ok: false, error }, 422, origin);
    }

    try {
      await setDoc(env, match.trip.itineraryPath, data, cur ? { updateTime: cur.updateTime } : {});
      break;
    } catch (e) {
      if (e.code === "FAILED_PRECONDITION" && attempt < 2) continue; // doc moved under us — redo
      console.error("itinerary write failed:", e);
      return json({ ok: false, error: "Couldn't save that — try again." }, 500, origin);
    }
  }

  await writeLog(env, email, text, {
    outcome: "processed-http", events: added.length,
    result: added.map((a) => a.t).join(" | ").slice(0, 400),
  });

  return json({
    ok: true,
    added: added.length,
    day: added[0].day,        // where the app should land
    ts: added[0].ts,          // so the app can pre-mark this entry as seen
    summary: added.map((a) => a.t).join(", "),
  }, 200, origin);
}

/* Deleting affects everyone on the trip, so the caller has to name both the
   slot and the title it believed was there. removeEvent refuses on a mismatch,
   which is what stops a stale tab from deleting whatever moved into that
   position after somebody else's change. */
async function handleRemove(env, origin, email, cfg, match, body) {
  const day = Number(body?.day);
  const slot = body?.slot;
  const title = String(body?.title || "");
  if (!Number.isInteger(day) || (slot !== "main" && !Number.isInteger(Number(slot))) || !title) {
    return json({ ok: false, error: "Bad request" }, 400, origin);
  }

  for (let attempt = 0; ; attempt++) {
    const cur = await getDoc(env, match.trip.itineraryPath);
    if (!cur) return json({ ok: false, error: "Nothing to remove." }, 404, origin);

    const res = removeEvent(cur.data, { day, slot, title }, match.trip);
    if (res.error) {
      await writeLog(env, email, title, { outcome: "http-remove-rejected", error: res.error });
      return json({ ok: false, error: res.error }, 409, origin);
    }

    try {
      await setDoc(env, match.trip.itineraryPath, res.data, { updateTime: cur.updateTime });
      await writeLog(env, email, title, { outcome: "removed-http", result: res.summary, day });
      return json({
        ok: true, day, summary: res.summary,
        ts: res.data.activity[0].ts,   // pre-mark: the remover doesn't need a dot for their own change
      }, 200, origin);
    } catch (e) {
      if (e.code === "FAILED_PRECONDITION" && attempt < 2) continue;
      console.error("remove write failed:", e);
      return json({ ok: false, error: "Couldn't remove that — try again." }, 500, origin);
    }
  }
}
