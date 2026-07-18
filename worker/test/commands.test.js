import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/commands.js";
import { icsToEvents } from "../src/parse.js";

describe("parseCommand", () => {
  const mail = (text, attachments = []) => ({ text, attachments });

  it("recognizes the command vocabulary", () => {
    expect(parseCommand(mail("YES"))).toBe("yes");
    expect(parseCommand(mail("yes please!"))).toBe("yes");
    expect(parseCommand(mail("Undo"))).toBe("undo");
    expect(parseCommand(mail("remove that last one"))).toBe("undo");
    expect(parseCommand(mail("no"))).toBe("no");
    expect(parseCommand(mail("status"))).toBe("status");
    expect(parseCommand(mail("help"))).toBe("help");
  });

  it("never mistakes a real booking email for a command", () => {
    expect(parseCommand(mail("Your United confirmation KX7R2B ..." + "x".repeat(300)))).toBeNull();
    expect(parseCommand(mail("dinner at Gonpachi July 20 at 7pm"))).toBeNull();
    expect(parseCommand(mail("YES", [{ filename: "invite.ics" }]))).toBeNull(); // attachment → real content
    expect(parseCommand(mail("> yes\nquoted reply only"))).toBeNull();
    expect(parseCommand(mail(""))).toBeNull();
  });
});

describe("icsToEvents (multi-VEVENT)", () => {
  const ICS = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/Los_Angeles:20260714T133000",
    "SUMMARY:Flight UA837 SFO-HND",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=Asia/Tokyo:20260724T180000",
    "SUMMARY:Flight UA876 HND-SFO",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("returns every VEVENT — outbound AND return flight", () => {
    const evs = icsToEvents(ICS, "+09:00");
    expect(evs).toHaveLength(2);
    expect(evs[0].type).toBe("flight");
    expect(evs[0].startDateTime).toBe("2026-07-14T13:30:00-07:00");
    expect(evs[1].startDateTime).toBe("2026-07-24T18:00:00+09:00");
  });
});
