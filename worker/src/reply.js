/* Auto-replies to the sender via Cloudflare's built-in reply support —
   no outbound email vendor needed. */

import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";

export async function replyTo(message, bodyText) {
  const msg = createMimeMessage();
  msg.setSender({ addr: message.to, name: "japanclan" });
  msg.setRecipient(message.from);
  const subj = message.headers.get("subject") || "your email";
  msg.setSubject(/^re:/i.test(subj) ? subj : `Re: ${subj}`);
  const mid = message.headers.get("message-id");
  if (mid) {
    msg.setHeader("In-Reply-To", mid);
    msg.setHeader("References", mid);
  }
  msg.addMessage({ contentType: "text/plain", data: bodyText });
  await message.reply(new EmailMessage(message.to, message.from, msg.asRaw()));
}
