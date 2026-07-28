import { describe, it, expect } from "vitest";
import { DEFAULT_APP_URL } from "../src/config.js";

/* Mirrors the footer construction in src/index.js. The reply is the only part
   of this pipeline a sender ever sees, so its two failure modes both matter:
   staying silent about something that landed, and offering UNDO for something
   that never did. */
function footer({ appliedAny, anyProposed, appUrl = DEFAULT_APP_URL }) {
  const bits = [];
  if (appliedAny && appUrl) bits.push(`See it on the calendar: ${appUrl}`);
  if (appliedAny && !anyProposed) {
    bits.push("Reply UNDO to remove what was just added, or HELP for everything I understand.");
  } else {
    bits.push("Reply HELP for everything I understand.");
  }
  return bits.join("\n\n");
}

describe("reply footer", () => {
  it("links to the app whenever something actually landed", () => {
    expect(footer({ appliedAny: true, anyProposed: false })).toContain(DEFAULT_APP_URL);
    expect(footer({ appliedAny: true, anyProposed: true })).toContain(DEFAULT_APP_URL);
  });

  it("omits the link when nothing was added", () => {
    for (const anyProposed of [true, false]) {
      expect(footer({ appliedAny: false, anyProposed })).not.toContain(DEFAULT_APP_URL);
    }
  });

  /* An UNDO pointing at nothing is worse than no footer: it invites a reply
     that can only answer "nothing of yours to undo". */
  it("only offers UNDO when there is something to undo", () => {
    expect(footer({ appliedAny: true, anyProposed: false })).toContain("UNDO");
    expect(footer({ appliedAny: false, anyProposed: false })).not.toContain("UNDO");
    expect(footer({ appliedAny: false, anyProposed: true })).not.toContain("UNDO");
  });

  /* Both instructions in one message contradict each other — the sender is
     being asked to confirm something and to undo it at the same time. */
  it("does not offer UNDO while something still awaits a yes/no", () => {
    expect(footer({ appliedAny: true, anyProposed: true })).not.toContain("UNDO");
  });

  it("always points at HELP", () => {
    for (const appliedAny of [true, false]) {
      for (const anyProposed of [true, false]) {
        expect(footer({ appliedAny, anyProposed })).toContain("HELP");
      }
    }
  });

  it("honors an appUrl override from config", () => {
    const out = footer({ appliedAny: true, anyProposed: false, appUrl: "https://example.com/trip" });
    expect(out).toContain("https://example.com/trip");
    expect(out).not.toContain(DEFAULT_APP_URL);
  });
});
