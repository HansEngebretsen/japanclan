# Local handoff — finish setup in Claude Code on your Mac

The email → calendar pipeline is fully built and pushed. What's left needs
`gcloud`, the Cloudflare MCP, and your browser sessions — all of which live on
your machine, not in the remote container where it was written.

## 1. Pull the branch

```bash
cd ~/sites/japanclan
git fetch origin email-calendar
git checkout email-calendar
git pull
```

## 2. Open Claude Code in that folder and paste this

```
Read worker/HANDOFF.md, worker/SETUP.md, and worker/setup.sh in this repo, then finish setting up the email → calendar pipeline on my machine.

CONTEXT
- This is japanclan: a zero-build static site (index.html) on GitHub Pages at haaans.com/japanclan, backed by Firebase project japanclan2k6 (Firestore + Google auth).
- I'm adding a pipeline where I forward any booking email (flight, hotel, train, dinner) to japan@trips.haaans.com, a Cloudflare Email Worker parses it (ICS fast-path, else one Gemini call), and writes it into the Firestore itinerary doc trips/japan-2026/config/itinerary, which the app renders live. All the code is already written and tested (26 passing tests) in worker/ on the email-calendar branch.
- I have gcloud installed, the Cloudflare MCP connected, and I'm the owner of the japanclan2k6 GCP/Firebase project. There may be a key in .env-instructions in this repo root — read it before asking me for anything, but NEVER print its contents.

ALREADY DONE (don't redo)
- Cloudflare Email Routing is enabled on the trips.haaans.com SUBDOMAIN (root haaans.com MX still points at Mailgun and must stay untouched).
- engebretsenh@gmail.com is verified as a Cloudflare destination address.

WHAT I NEED YOU TO DO
1. Run ./setup.sh from worker/ and drive it to completion. It is idempotent. It creates the japanclan-mail service account, grants ONLY roles/datastore.user, streams a service-account key from gcloud straight into `wrangler secret put GCP_SA_KEY` (it must never be written to disk), prompts for my Gemini API key, deploys the worker, and seeds the Firestore pipeline/config doc using my own gcloud login. If a step fails, diagnose and fix it rather than working around it.
2. Using the Cloudflare MCP, set the routing rule: on the trips.haaans.com subdomain, catch-all → Send to a Worker → japanclan-mail. Confirm the root haaans.com MX records are unchanged afterward.
3. Add the sender allowlist to Firestore pipeline/config → senders: engebretsenh@gmail.com → { name: "Hans", trip: "japan-2026" }, plus anyone else I name.
4. Run `npm run check` in worker/ and get every line to ✅.
5. Walk me through the test sequence in SETUP.md step 6 (forward a real booking, reply UNDO, re-forward for the duplicate path, a free-text "dinner at X on <date> at 7pm", reply STATUS/HELP, and a non-allowlisted sender). Tell me exactly what to send and what I should expect back; I'll report what actually happens and you fix anything that misbehaves.

RULES
- NEVER print, echo, log, or commit a secret, API key, or service-account key. Not into a file, not into the transcript, not into a commit message.
- Do NOT merge this branch into main. All work stays on email-calendar until I've confirmed the whole thing works end to end. Commit and push fixes to email-calendar only.
- Don't change config/firestore.rules — the worker authenticates with IAM, which bypasses rules by design, so they stay as they are.
- Don't add a build step to index.html or split it up; the single-file zero-build design is intentional (see .agents/AGENTS.md).
- If something is genuinely ambiguous or risky, ask me before acting.

Start by reading the three files above plus .agents/AGENTS.md, tell me your plan in a few lines, then go.
```

## 3. What it should end with

- `npm run check` all ✅
- A forwarded booking shows up on the calendar within seconds, with a reply
  saying exactly what was added
- Replying **UNDO** removes it

When that's true, tell me (in the remote session or a new one) and I'll open the
PR to merge `email-calendar` into `main` — not before.

---

## Quick reference for whoever's driving

| File | What it is |
|---|---|
| `worker/SETUP.md` | The human runbook — security model, steps, troubleshooting, cost |
| `worker/setup.sh` | The one-command setup (idempotent; safe to re-run) |
| `worker/check.mjs` | `npm run check` — verifies every step, prints the fix for failures |
| `worker/seed-config.mjs` | `npm run seed` — creates `pipeline/config`; won't overwrite |
| `worker/src/index.js` | Pipeline orchestration (gate → dedup → parse → group → write → reply) |
| `worker/src/parse.js` | ICS fast-path, text trimming, Gemini structured output, validation |
| `worker/src/map.js` | ParsedEvent → the app's `itin`/`stays` schema; trip grouping; collisions |
| `worker/src/commands.js` | YES / NO / UNDO / STATUS / HELP reply commands |
| `worker/VERIFY-DNS-PROMPT.md` | Read-only DNS pre-flight prompt (already used) |
| `.agents/AGENTS.md` | Repo conventions + the pipeline's architecture notes |

**Secrets live in exactly two places, both encrypted, neither on disk:**
`GCP_SA_KEY` and `GEMINI_API_KEY` in Cloudflare's secret store. Local tooling
uses your own `gcloud auth print-access-token` instead of a key file.
