import { describe, it, expect } from "vitest";
import { applyEvent, buildMain, fmtTime, tzLabel, slugify } from "../src/map.js";

const TRIP = { year: 2026, month: 7, firstDay: 12, lastDay: 25, tzOffset: "+09:00" };

const FLIGHT = {
  type: "flight", title: "SFO → HND",
  startDateTime: "2026-07-14T13:30:00-07:00", endDateTime: "2026-07-15T16:00:00+09:00",
  timezoneOffset: "-07:00", endTimezoneOffset: "+09:00",
  locationName: "Haneda Airport", address: null,
  confirmation: "KX7R2B", seats: "22A, 22C", carrierNumber: "UA 837",
  details: [], confidence: 0.95,
};

describe("formatting helpers", () => {
  it("formats times like the app", () => {
    expect(fmtTime("2026-07-14T13:30:00-07:00")).toBe("1:30 PM");
    expect(fmtTime("2026-07-16T00:05:00+09:00")).toBe("12:05 AM");
    expect(fmtTime("2026-07-16T12:00:00+09:00")).toBe("12:00 PM");
  });
  it("labels timezones like the app", () => {
    expect(tzLabel("+09:00")).toBe("GMT+9");
    expect(tzLabel("-07:00")).toBe("PDT");
    expect(tzLabel("+05:30")).toBe("GMT+5:30");
  });
  it("slugifies stay keys", () => {
    expect(slugify("Park Hyatt Tokyo")).toBe("park-hyatt-tokyo");
  });
});

describe("buildMain", () => {
  it("builds a flight main matching MOCK_ITIN conventions byte-for-byte", () => {
    expect(buildMain(FLIGHT)).toEqual({
      ic: "flight", t: "1:30 PM", tz: "PDT", title: "SFO → HND", wp: "Haneda Airport",
      sub: [
        "Flight Number UA 837",
        "Seat(s) 22A, 22C",
        "Confirmation KX7R2B",
        "Arrive 7/15/2026 4:00 PM GMT+9",
      ],
    });
  });
  it("builds an event main with venue/address/ends lines", () => {
    const main = buildMain({
      type: "event", title: "Giants game",
      startDateTime: "2026-07-16T18:00:00+09:00", endDateTime: "2026-07-16T19:00:00+09:00",
      timezoneOffset: "+09:00", locationName: "Tokyo Dome",
      address: "1-3-61 Koraku, Bunkyo City, Tokyo 112-0004, Japan", details: [],
    });
    expect(main).toEqual({
      ic: "event", t: "6:00 PM", tz: "GMT+9", title: "Giants game", wp: "Tokyo Dome",
      sub: ["Tokyo Dome", "1-3-61 Koraku, Bunkyo City, Tokyo 112-0004, Japan", "Ends 7:00 PM"],
    });
  });
});

describe("applyEvent", () => {
  it("adds a flight to an empty itinerary keyed by local departure day", () => {
    const res = applyEvent({}, FLIGHT, TRIP);
    expect(res.conflict).toBeUndefined();
    expect(res.data.itin[14].main.title).toBe("SFO → HND");
    expect(res.summary).toBe("SFO → HND on July 14 at 1:30 PM");
  });

  it("spreads a lodging stay across nights and preserves existing day data", () => {
    const base = { itin: { 16: { main: { ic: "event", title: "Giants game", sub: [] } } } };
    const res = applyEvent(base, {
      type: "lodging", title: "Shibuya Excel Hotel Tokyu",
      startDateTime: "2026-07-15T15:00:00+09:00", endDateTime: "2026-07-19T11:00:00+09:00",
      timezoneOffset: "+09:00", locationName: "Shibuya Excel Hotel Tokyu",
      address: "1-12-2 Dogenzaka, Shibuya City, Tokyo", details: [],
    }, TRIP);
    expect(res.conflict).toBeUndefined();
    const key = "shibuya-excel-hotel-toky";
    expect(res.data.stays[key]).toEqual({
      title: "Shibuya Excel Hotel Tokyu", addr: "1-12-2 Dogenzaka, Shibuya City, Tokyo",
      day: 15, in: "3:00 PM", out: "11:00 AM", tz: "GMT+9",
    });
    for (const d of [15, 16, 17, 18]) expect(res.data.itin[d].stay).toBe(key);
    expect(res.data.itin[19]).toBeUndefined();
    expect(res.data.itin[16].main.title).toBe("Giants game"); // untouched
  });

  it("overwrites same-confirmation main (schedule change) but conflicts on a different event", () => {
    const first = applyEvent({}, FLIGHT, TRIP);
    // same confirmation, new time → update in place
    const changed = applyEvent(first.data, { ...FLIGHT, startDateTime: "2026-07-14T15:00:00-07:00" }, TRIP);
    expect(changed.conflict).toBeUndefined();
    expect(changed.data.itin[14].main.t).toBe("3:00 PM");
    // different event same day → conflict, itinerary untouched
    const other = applyEvent(first.data, {
      type: "event", title: "TeamLab", startDateTime: "2026-07-14T10:00:00+09:00",
      timezoneOffset: "+09:00", details: [],
    }, TRIP);
    expect(other.conflict).toContain('July 14 already has "SFO → HND"');
  });

  it("conflicts when nights overlap a different stay", () => {
    const base = { stays: { hakodate: { title: "La Vista Hakodate Bay" } }, itin: { 19: { stay: "hakodate" } } };
    const res = applyEvent(base, {
      type: "lodging", title: "JR Tower Hotel Nikko Sapporo",
      startDateTime: "2026-07-19T15:00:00+09:00", endDateTime: "2026-07-22T11:00:00+09:00",
      timezoneOffset: "+09:00", details: [],
    }, TRIP);
    expect(res.conflict).toContain("July 19 already has stay");
  });

  it("does not mutate its input", () => {
    const base = { itin: {}, stays: {} };
    applyEvent(base, FLIGHT, TRIP);
    expect(base.itin).toEqual({});
  });
});
