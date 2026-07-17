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

/* Merge one validated ParsedEvent into itinerary data.
   Returns { data, summary } on success or { conflict: "reason" }.
   Never mutates the input. */
export function applyEvent(input, ev, tripCfg) {
  const data = {
    defaultCity: { ...(input.defaultCity || {}) },
    stays: { ...(input.stays || {}) },
    itin: Object.fromEntries(Object.entries(input.itin || {}).map(([k, v]) => [k, { ...v }])),
  };
  const start = localParts(ev.startDateTime);
  const month = MONTHS[tripCfg?.month || start.mo];

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
    for (let d = inDay; d < outDay; d++) {
      const existing = data.itin[d]?.stay;
      if (existing && existing !== key) {
        return { conflict: `${month} ${d} already has stay "${data.stays[existing]?.title || existing}"` };
      }
      data.itin[d] = { ...(data.itin[d] || {}), stay: key };
    }
    return { data, summary: `${ev.title}, ${month} ${inDay}–${outDay}` };
  }

  const day = start.d;
  const existing = data.itin[day]?.main;
  if (existing) {
    const sameConf = ev.confirmation && existing.sub?.some((l) => l === `Confirmation ${ev.confirmation}`);
    const sameTitle = existing.title && existing.title.toLowerCase() === ev.title.toLowerCase();
    if (!sameConf && !sameTitle) {
      return { conflict: `${month} ${day} already has "${existing.title}"` };
    }
  }
  data.itin[day] = { ...(data.itin[day] || {}), main: buildMain(ev) };
  return { data, summary: `${ev.title} on ${month} ${day} at ${fmtTime(ev.startDateTime)}` };
}
