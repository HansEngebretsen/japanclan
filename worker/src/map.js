/* ParsedEvent → the app's itinerary schema ({defaultCity, stays, itin}).
   String formats must match what the app renders (see MOCK_ITIN in index.html):
     itin[day].main = { ic, t, tz, title, wp, sub: [...] }
     stays[key]     = { title, addr, day, in, out, tz }
   sub-line conventions: "Flight Number UA 837", "Confirmation KX7R2B",
   "Seat(s) 22A, 22C", "Arrive 7/15/2026 4:00 PM GMT+9", "Ends 7:00 PM". */

const TZ_LABELS = {
  "+09:00": "GMT+9",
  "-07:00": "PDT",
  "-08:00": "PST",
  "-04:00": "EDT",
  "-05:00": "EST",
  "+00:00": "GMT",
};

export function tzLabel(offset) {
  if (TZ_LABELS[offset]) return TZ_LABELS[offset];
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset || "");
  if (!m) return "GMT+9";
  const h = Number(m[2]), mm = Number(m[3]);
  return `GMT${m[1]}${h}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

export function localParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], hh: +m[4], mi: +m[5] };
}

export function fmtTime(iso) {
  const p = localParts(iso);
  if (!p) return "";
  const ampm = p.hh >= 12 ? "PM" : "AM";
  const h12 = p.hh % 12 === 0 ? 12 : p.hh % 12;
  return `${h12}:${String(p.mi).padStart(2, "0")} ${ampm}`;
}

function fmtArrive(iso, offset) {
  const p = localParts(iso);
  if (!p) return null;
  return `Arrive ${p.mo}/${p.d}/${p.y} ${fmtTime(iso)} ${tzLabel(offset)}`;
}

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "stay";
}

export function buildMain(ev) {
  const t = fmtTime(ev.startDateTime);
  const tz = tzLabel(ev.timezoneOffset);
  if (ev.type === "flight" || ev.type === "train") {
    const sub = [];
    if (ev.carrierNumber) {
      sub.push(ev.type === "flight" && !/flight/i.test(ev.carrierNumber)
        ? `Flight Number ${ev.carrierNumber}` : ev.carrierNumber);
    }
    if (ev.seats) sub.push(/coach|seat/i.test(ev.seats) ? ev.seats : `Seat(s) ${ev.seats}`);
    if (ev.confirmation) sub.push(`Confirmation ${ev.confirmation}`);
    if (ev.endDateTime) {
      const line = fmtArrive(ev.endDateTime, ev.endTimezoneOffset || ev.timezoneOffset);
      if (line) sub.push(line);
    }
    return { ic: ev.type, t, tz, title: ev.title, wp: ev.locationName || ev.title, sub };
  }
  // event / dining → "event" icon
  const sub = [];
  if (ev.locationName) sub.push(ev.locationName);
  if (ev.address) sub.push(ev.address);
  if (ev.endDateTime) sub.push(`Ends ${fmtTime(ev.endDateTime)}`);
  for (const d of ev.details || []) if (sub.length < 5) sub.push(d);
  return { ic: "event", t, tz, title: ev.title, wp: ev.locationName || ev.title, sub };
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/* Trip grouping: an event belongs to whichever configured trip's date window
   contains its start date (flights define those windows when a trip is set
   up), regardless of which trip the sender defaults to. Sender default only
   breaks ties between overlapping trips. */
export function resolveTripByDate(cfg, ev, fallbackId) {
  const p = localParts(ev.startDateTime);
  if (!p) return null;
  const matches = Object.entries(cfg.trips || {}).filter(([, t]) =>
    t.year === p.y && t.month === p.mo && p.d >= t.firstDay && p.d <= t.lastDay);
  if (!matches.length) return null;
  const hit = matches.find(([id]) => id === fallbackId) || matches[0];
  return { id: hit[0], trip: hit[1] };
}

function minsOf(t) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(t || "");
  if (!m) return 0;
  return ((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}

const ANCHOR_RANK = { flight: 2, train: 1 };

/* Activity feed. It lives on the itinerary doc rather than in pipeline/state
   because the app can already read this doc (firestore.rules → config/itinerary
   `allow read: if isAllowed()`) and already subscribes to it; pipeline/* is
   denied to clients by design. So the feed costs no rules change, no second
   subscription, and no extra reads. UNDO restores a whole-doc snapshot, which
   means an undone event takes its activity line with it. */
export const ACTIVITY_MAX = 50;

function mealWord(t) {
  const m = minsOf(t);
  if (m === null || Number.isNaN(m)) return "dinner";
  if (m < 11 * 60) return "breakfast";
  if (m < 16 * 60) return "lunch";
  return "dinner";
}

/* "Added 7/20 dinner at Gonpachi Nishiazabu" */
export function activityLine(ev, mo, day) {
  const when = `${mo}/${day}`;
  const title = ev.title || "Untitled";
  switch (ev.type) {
    /* "dinner at Gonpachi" reads well; "dinner at Drinks with Kenji" does not.
       A venue name is the signal — without one the title already describes the
       thing, so it stands alone. */
    case "dining": return ev.locationName
      ? `Added ${when} ${mealWord(fmtTime(ev.startDateTime))} at ${title}`
      : `Added ${when} ${title}`;
    case "lodging": return `Added ${when} stay at ${title}`;
    case "flight": return `Added ${when} flight ${title}`;
    case "train": return `Added ${when} train ${title}`;
    default: return `Added ${when} ${title}`;
  }
}

function pushActivity(data, ev, mo, day, now) {
  // `d` lets the app jump straight to the day this entry describes
  const entry = { t: activityLine(ev, mo, day), ts: now, d: day };
  data.activity = [entry, ...(data.activity || [])].slice(0, ACTIVITY_MAX);
}

/* Merge one validated ParsedEvent into itinerary data.
   Returns { data, summary } on success, or { conflict, conflictInfo } when a
   stay would land on nights another property already holds. `conflictInfo`
   carries what the app needs to offer a replace — the nights at stake and
   both properties — so the UI never has to re-derive it.

   opts.replaceStay overrides the refusal: the incoming stay takes the nights
   it asked for, and any property left holding no nights is dropped.
   Never mutates the input. */
export function applyEvent(input, ev, tripCfg, now = Date.now(), opts = {}) {
  const data = {
    ...input,   // carry any field this function doesn't know about (activity), so a write never drops it
    defaultCity: { ...(input.defaultCity || {}) },
    stays: { ...(input.stays || {}) },
    itin: Object.fromEntries(Object.entries(input.itin || {}).map(([k, v]) => [k, { ...v }])),
  };
  const start = localParts(ev.startDateTime);
  const monthNum = tripCfg?.month || start.mo;
  const month = MONTHS[monthNum];

  if (ev.type === "lodging") {
    const inDay = start.d;
    const endP = ev.endDateTime ? localParts(ev.endDateTime) : null;
    const outDay = endP ? endP.d : inDay + 1;
    if (outDay <= inDay) return { conflict: `check-out day (${outDay}) is not after check-in day (${inDay})` };

    // reuse an existing stays key when it's clearly the same property
    let key = null;
    for (const [k, s] of Object.entries(data.stays)) {
      if (s.title && s.title.toLowerCase() === ev.title.toLowerCase()) { key = k; break; }
    }
    if (!key) {
      key = slugify(ev.title);
      if (data.stays[key]) key = `${key}-${inDay}`;
    }
    data.stays[key] = {
      title: ev.title,
      addr: ev.address || ev.locationName || "",
      day: inDay,
      in: fmtTime(ev.startDateTime) || "3:00 PM",
      out: ev.endDateTime ? fmtTime(ev.endDateTime) : "11:00 AM",
      tz: tzLabel(ev.timezoneOffset),
    };
    /* Survey every night first. Reporting only the first clash would make a
       "replace" prompt understate what it is about to overwrite when two
       different hotels sit inside the same range. */
    const clashDays = [], clashKeys = new Set();
    for (let d = inDay; d < outDay; d++) {
      const existing = data.itin[d]?.stay;
      if (existing && existing !== key) { clashDays.push(d); clashKeys.add(existing); }
    }

    if (clashDays.length && !opts.replaceStay) {
      const titles = [...clashKeys].map((k) => data.stays[k]?.title || k);
      return {
        conflict: `${month} ${clashDays[0]} already has stay "${titles[0]}"`,
        conflictInfo: {
          days: clashDays,
          month: monthNum,
          /* `nights` is the property's whole span, so the app can tell a full
             replacement from one that only takes part of an existing stay. */
          existing: [...clashKeys].map((k) => ({
            key: k,
            ...(data.stays[k] || {}),
            nights: Object.entries(data.itin)
              .filter(([, c]) => c.stay === k).map(([d]) => Number(d)).sort((a, b) => a - b),
          })),
          incoming: { ...data.stays[key], key },
          range: { inDay, outDay },
        },
      };
    }

    for (let d = inDay; d < outDay; d++) data.itin[d] = { ...(data.itin[d] || {}), stay: key };

    /* A replaced property may still hold nights outside this range — only drop
       the ones that now hold none, or the itinerary keeps dead stays around. */
    if (clashDays.length) {
      for (const k of clashKeys) {
        const stillUsed = Object.values(data.itin).some((c) => c.stay === k);
        if (!stillUsed) delete data.stays[k];
      }
    }

    pushActivity(data, ev, monthNum, inDay, now);
    return { data, summary: `${ev.title}, ${month} ${inDay}–${outDay}` };
  }

  /* Non-lodging events coexist on a day: flights/trains anchor as `main`,
     everything else joins the day's `more` list (time-sorted). Re-sent
     bookings (same confirmation or title) update in place. */
  const day = start.d;
  const cell = { ...(data.itin[day] || {}) };
  const incoming = buildMain(ev);
  const isSame = (m) => Boolean(m) && (
    (ev.confirmation && (m.sub || []).includes(`Confirmation ${ev.confirmation}`)) ||
    (m.title && m.title.toLowerCase() === ev.title.toLowerCase())
  );
  const more = (cell.more || []).slice();
  const dup = more.findIndex(isSame);

  if (isSame(cell.main)) {
    cell.main = incoming; // schedule change / re-send → update in place
  } else if (dup >= 0) {
    more[dup] = incoming; // update of a secondary event
  } else if (!cell.main) {
    cell.main = incoming;
  } else if ((ANCHOR_RANK[ev.type] || 0) > (ANCHOR_RANK[cell.main.ic] || 0)) {
    more.push(cell.main); // e.g. a flight bumps a dinner out of the anchor slot
    cell.main = incoming;
  } else {
    more.push(incoming);
  }
  if (more.length) {
    more.sort((a, b) => minsOf(a.t) - minsOf(b.t));
    cell.more = more;
  }
  data.itin[day] = cell;
  pushActivity(data, ev, monthNum, day, now);
  const alongside = cell.main === incoming
    ? "" : ` (alongside ${cell.main.title})`;
  return { data, summary: `${ev.title} on ${month} ${day} at ${fmtTime(ev.startDateTime)}${alongside}` };
}

/* Remove one event from a day. `slot` is "main" or an index into `more`, and
   `title` must match what the caller believed it was deleting — the app sends
   both, so a stale view can't delete whatever slid into that position after
   someone else's change. `slot` may also be "stay", which clears the property
   from every night it covers. Returns { data, summary } or { error }.

   Deletions are appended to the activity feed rather than erasing the "Added"
   entry: an activity log is history, and quietly rewriting it would leave the
   feed disagreeing with what people remember doing. */
export function removeEvent(input, { day, slot, title }, tripCfg, now = Date.now()) {
  const data = {
    ...input,
    defaultCity: { ...(input.defaultCity || {}) },
    stays: { ...(input.stays || {}) },
    itin: Object.fromEntries(Object.entries(input.itin || {}).map(([k, v]) => [k, { ...v }])),
  };
  const cell = data.itin[day];
  if (!cell) return { error: "That day has nothing on it." };

  const same = (m) => m && String(m.title || "").toLowerCase() === String(title || "").toLowerCase();
  let removed = null;

  /* A stay spans nights, so removing it clears every day pointing at it, not
     just the one the button was on — leaving half a hotel behind would be
     worse than not offering this at all. */
  if (slot === "stay") {
    const key = cell.stay;
    const s = key && data.stays[key];
    if (!same(s)) return { error: "That stay has changed since you loaded the page — reload and try again." };
    const cleared = [];
    for (const [d, c] of Object.entries(data.itin)) {
      if (c.stay !== key) continue;
      const next = { ...c };
      delete next.stay;
      cleared.push(Number(d));
      if (!next.main && !next.more) delete data.itin[d];
      else data.itin[d] = next;
    }
    delete data.stays[key];
    const mo = tripCfg?.month || 0;
    const span = cleared.length > 1
      ? `${mo}/${Math.min(...cleared)}–${mo}/${Math.max(...cleared)}`
      : `${mo}/${cleared[0]}`;
    const titleLower = String(s.title || "").toLowerCase();
    data.activity = [
      { t: `Removed ${span} stay at ${s.title}`, ts: now, d: Math.min(...cleared), removed: true },
      ...((data.activity || []).filter(a => !(a && String(a.t || "").toLowerCase().includes(titleLower))))
    ].slice(0, ACTIVITY_MAX);
    return { data, summary: s.title };
  }

  if (slot === "main") {
    if (!same(cell.main)) return { error: "That item has changed since you loaded the page — reload and try again." };
    removed = cell.main;
    const more = (cell.more || []).slice();
    // the day keeps its shape: the next event is promoted into the anchor slot
    if (more.length) { cell.main = more.shift(); cell.more = more; }
    else delete cell.main;
    if (cell.more && !cell.more.length) delete cell.more;
  } else {
    const i = Number(slot);
    const more = (cell.more || []).slice();
    if (!Number.isInteger(i) || i < 0 || i >= more.length || !same(more[i])) {
      return { error: "That item has changed since you loaded the page — reload and try again." };
    }
    removed = more[i];
    more.splice(i, 1);
    if (more.length) cell.more = more; else delete cell.more;
  }

  if (!cell.main && !cell.more && !cell.stay) delete data.itin[day];
  else data.itin[day] = cell;

  const mo = tripCfg?.month || 0;
  const titleLower = String(removed.title || "").toLowerCase();
  data.activity = [
    { t: `Removed ${mo}/${day} ${removed.title}`, ts: now, d: day, removed: true },
    ...((data.activity || []).filter(a => !(a && String(a.t || "").toLowerCase().includes(titleLower))))
  ].slice(0, ACTIVITY_MAX);

  return { data, summary: removed.title };
}
