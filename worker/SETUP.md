# Email → Calendar: setup guide

Forward any booking email — a flight, a hotel, a train, a dinner reservation,
anything — to **`japan@trips.haaans.com`** and it appears on the japanclan
calendar within seconds. This guide sets that up, start to finish, in about
15 minutes of clicking. No servers, no monthly cost, no credit card.

```
you forward an email ──▶ Cloudflare receives it (trips.haaans.com)
                              │
                        japanclan-mail worker
                              │  checks the sender is on your allowlist
                              │  reads the booking (ICS attachment, or one Gemini AI call)
                              ▼
                    Firestore itinerary doc  ──▶  live on the app calendar
                              │
                    you get a reply: "Added ✅"
```

---

## Security, before anything else

This repo is **public**, so it's worth being clear about what is and isn't safe:

| Thing | Where it lives | Public? |
|---|---|---|
| Worker code (this folder) | GitHub | ✅ Public — contains no secrets |
| Service-account key (`GCP_SA_KEY`) | Cloudflare's encrypted secret store only | 🔒 **Never** in git, never in a file that stays on disk |
| Gemini API key (`GEMINI_API_KEY`) | Cloudflare's encrypted secret store only | 🔒 Same |
| Sender allowlist, trip config | Firestore `pipeline/config` (clients can't read it) | 🔒 Private, but not secret-level |
| Itinerary (flights, confirmations) | Firestore, unchanged — clients still can't write it | 🔒 Same as today |

Ground rules baked into the design:

- **Only allowlisted senders work.** Email from anyone else is rejected before
  any parsing happens, with no reply (so strangers can't even confirm the
  address exists). Cloudflare verifies SPF/DKIM first, so the From address
  can't be trivially spoofed.
- **Least privilege.** The service account you'll create can read/write
  Firestore data and *nothing else* — it can't touch billing, rules, auth, or
  other Google services. Your Firestore security rules are not modified.
- **Nothing secret ever gets committed.** The two secrets are pasted once into
  Cloudflare (`wrangler secret put`) and the key file deleted. If either ever
  leaks, the "If a secret leaks" section below rotates it in two minutes.

---

## One-time setup

You already have everything this builds on: haaans.com is on Cloudflare, and
the Firebase project is `japanclan2k6`.

### 1. Turn on email for `trips.haaans.com` (Cloudflare)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **haaans.com** →
   **Email** → **Email Routing**.
2. Open **Settings** → **Add subdomain** → enter `trips` → confirm.
   Cloudflare adds the MX/SPF DNS records for the subdomain automatically.
3. ⚠️ Sanity check: this must be the **subdomain** flow. Your root domain's
   mail (`@haaans.com`, currently on Mailgun) is untouched — if the dashboard
   ever warns about changing MX records on **haaans.com itself**, stop and
   re-check step 2.

### 2. Verify your Gmail as a destination (Cloudflare)

Still in **Email Routing** → **Destination addresses** → **Add address** →
`engebretsenh@gmail.com` → click the link in the confirmation email you get.
(The worker forwards a copy of every accepted email here, so you always have
an archive even if something goes wrong downstream.)

### 3. Create the service account (Google Cloud)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) — make
   sure the project selector at the top says **japanclan2k6**.
2. **IAM & Admin** → **Service Accounts** → **Create service account**.
   - Name: `japanclan-mail`
   - Role: **Cloud Datastore User** (that's Firestore read/write — nothing more).
   - Skip "grant users access", click **Done**.
3. Open the new account → **Keys** tab → **Add key** → **Create new key** →
   **JSON**. A file downloads (e.g. `japanclan2k6-a1b2c3.json`).
4. 🔒 Treat that file like a password. You'll paste it in step 5 and then
   **delete it**. Don't move it into this repo folder, don't email it,
   don't screenshot it.

### 4. Get a Gemini API key (Google AI Studio)

Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** →
**Create API key**. Copy it. (Free tier — no card, and this pipeline's few
calls a day sit far below its limits.)

### 5. Deploy the worker and set the secrets

In a terminal, from this repo:

```bash
cd worker
npm install
npx wrangler login                 # opens a browser to your Cloudflare account

npx wrangler secret put GCP_SA_KEY
#  → when prompted, paste the ENTIRE contents of the JSON key file from step 3
#    (open it in a text editor, select all, copy, paste, Enter)

npx wrangler secret put GEMINI_API_KEY
#  → paste the key from step 4

npx wrangler deploy
```

Now delete the downloaded key file (and empty the trash):

```bash
rm ~/Downloads/japanclan2k6-*.json
```

### 6. Route the address to the worker (Cloudflare)

**Email Routing** → **Routing rules**: on the `trips.haaans.com` subdomain,
set the **catch-all** action to **Send to a Worker** → `japanclan-mail`.
(Catch-all means `japan@`, `paris@`, anything `@trips.haaans.com` all reach
the worker — future trips need zero extra Cloudflare setup.)

### 7. Create the config (Firestore)

The worker reads everything it's allowed to do from one Firestore doc, so you
can change senders/trips/prompts later without touching code. Seed it from the
repo (uses the same key file — do this **before** deleting it in step 5, or
re-download a key):

```bash
cd worker
GCP_SA_KEY_FILE=~/Downloads/japanclan2k6-*.json npm run seed
```

Then open [Firebase console](https://console.firebase.google.com/project/japanclan2k6/firestore)
→ `pipeline/config` and edit:

- **`senders`** — add each person allowed to email the calendar:
  their email (lowercase) → `{ name, trip: "japan-2026" }`.
- Everything else (trip dates, timezone, model) is pre-filled for the
  Japan trip; adjust if needed.

### 8. Test it

1. From your own Gmail, forward a real flight or hotel confirmation to
   `japan@trips.haaans.com`.
2. Within a few seconds you should get a reply — *"Added to the calendar ✅"* —
   and the event is live in the app (no refresh needed).
3. Forward the same email again → reply says it's already on the calendar.
4. Send a made-up note like *"dinner at Gonpachi July 20 at 7pm"* → added via
   the AI path.
5. Ask a friend **not** on the allowlist to send something → they get a
   bounce, nothing is processed.

---

## Day-to-day

- **Add a person:** Firebase console → `pipeline/config` → `senders` → add
  their email. That's it — no deploys.
- **Add a trip:** add an entry under `trips` (dates + timezone + itinerary
  path) and optionally map an address like `paris@trips.haaans.com` under
  `addresses`. Senders default to their own `trip`.
- **Something didn't parse / date conflict:** it's saved in Firestore under
  `pipeline/state/pending` with the reason, and the sender got a reply saying
  so. Add it to the itinerary by hand (see `.agents/AGENTS.md` → "Adding a new
  itinerary day"), then delete the pending doc.
- **See what's been happening:** `pipeline/state/log` has one entry per email
  (who, what, outcome, how long it took). Live tail: `cd worker && npx wrangler tail`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No reply, nothing in the app | Check `pipeline/state/log` in Firestore; if empty, check the route in step 6 is bound to the worker. `npx wrangler tail` shows live errors. |
| Sender got a bounce | Their address isn't in `senders` (add it), or the worker crashed before handling — check `wrangler tail`. Bounced mail is retried by the sender's mail server, so a transient failure usually self-heals. |
| Reply says "couldn't confidently read" | The email had no clear booking. It's in `pipeline/state/pending` — add it manually. |
| Gemini errors in the log | Free-tier daily limit or model rename. In `pipeline/config` → `llm.model`, switch to `gemini-2.5-flash-lite`. No redeploy needed. |
| Wrong time/timezone on an event | Fix the event in the Firebase console (itinerary doc), and consider tightening `llm.promptTemplate` in config. |

## If a secret leaks

- **Service-account key:** Google Cloud console → IAM & Admin → Service
  Accounts → `japanclan-mail` → Keys → delete the key. Create a new one and
  `npx wrangler secret put GCP_SA_KEY` again. Old key is dead instantly.
- **Gemini key:** AI Studio → API keys → delete + recreate →
  `npx wrangler secret put GEMINI_API_KEY`.

## What it costs

Nothing, at this scale: Cloudflare Email Routing and the Workers free tier
(100,000 emails/day allowed; you'll see dozens), Firestore free tier
(~5 reads/writes per email), Gemini free tier (one small call per email, and
zero for emails with calendar attachments). There is no card on file anywhere
in this pipeline.
