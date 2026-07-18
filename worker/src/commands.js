/* Email-thread commands: senders control the pipeline by replying in plain
   words — no consoles, no dashboards. Only the first few words of the body
   are considered, and only from allowlisted senders (gated upstream). */

const COMMANDS = [
  { cmd: "yes", re: /^(yes|confirm|add( it)?|approve|y)\b/i },
  { cmd: "no", re: /^(no|cancel|dismiss|skip|n)\b/i },
  { cmd: "undo", re: /^(undo|remove|revert|delete that)\b/i },
  { cmd: "status", re: /^status\b/i },
  { cmd: "help", re: /^(help|\?)$/i },
];

/* A command email is a SHORT hand-typed note — anything long is a real
   forwarded booking and must go to the parser even if it starts with "no". */
export function parseCommand(parsed) {
  if (parsed.attachments?.length) return null;
  const body = (parsed.text || "").trim();
  if (!body || body.length > 200) return null;
  const firstLine = body.split("\n", 1)[0].trim();
  // ignore quoted reply remnants ("On ... wrote:") — only the typed part counts
  if (!firstLine || firstLine.startsWith(">")) return null;
  for (const { cmd, re } of COMMANDS) {
    if (re.test(firstLine)) return cmd;
  }
  return null;
}

export const HELP_TEXT = `Here's how this works:

• Forward any booking email (flight, hotel, train, dinner…) and it's added to the trip calendar automatically. You'll get a reply confirming exactly what was added.
• If I'm not sure about something, I'll describe what I think it is — reply YES to add it or NO to discard it.
• Reply UNDO to remove the last thing you added.
• Reply STATUS to see the last few things that happened.

That's it — everything happens right here over email.`;
