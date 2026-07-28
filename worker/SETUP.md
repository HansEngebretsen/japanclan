# Email → Calendar: setup guide

Forward any booking email — a flight, a hotel, a train, a dinner reservation,
anything — to **`trip@trips.haaans.com`** and it appears on the japanclan
calendar within seconds. You get a reply confirming exactly what was added,
and you can control everything by replying in plain words (**UNDO**,
**YES**/**NO**, **STATUS**, **HELP**). One email can contain several bookings
(an airline confirmation with outbound *and* return flights adds both), and
everything you send groups itself into the right trip by date — the flights
define the trip, then hotels and dinners snap to the same days automatically.

This guide sets that up, start to finish, in about 15 minutes of clicking.
No servers, no monthly cost, no credit card.

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
| Service-account key (`GCP_SA_KEY`) | Cloudflare's encrypted secret store only | 🔒 **Never** in git, and never written to your disk at all — `setup.sh` streams it straight from gcloud into Cloudflare |
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
- **No key file exists.** `setup.sh` pipes the service-account key from gcloud
  directly into Cloudflare's secret store — there is no file in `~/Downloads`
  to leak, forget about, or commit by accident. Your *local* tools (`npm run
  seed`, `npm run check`) use your own short-lived gcloud login instead of a
  key. If a secret ever leaks, the "If a secret leaks" section below rotates it
  in two minutes.

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

### 3. Everything else: one command

The rest of the setup — service account, permissions, secrets, deploy, and the
Firestore config — is handled by a script, so there is **no JSON key file to
download, store, or delete**. The key is created by `gcloud` and streamed
directly into Cloudflare's encrypted secret store; it never touches your disk.

First, get a **Gemini API key** (free, no credit card): go to
[aistudio.google.com](https://aistudio.google.com) → **Get API key** →
**Create API key**, and copy it — the script will ask for it.

Then, from this repo:

```bash
cd worker
./setup.sh
```

It signs you in to Google Cloud and Cloudflare (browser popups) if needed, then:

| Step | What it does |
|---|---|
| Service account | Creates `japanclan-mail` if missing |
| Permissions | Grants **Cloud Datastore User** only — Firestore read/write, nothing else |
| `GCP_SA_KEY` | Creates a key and pipes it into Cloudflare (never written to disk) |
| `GEMINI_API_KEY` | Prompts for your key (not echoed) and stores it in Cloudflare |
| Deploy | `wrangler deploy` |
| Config | Seeds the Firestore `pipeline/config` doc using **your own gcloud login** |
| Key hygiene | Warns if more than one key exists, with the command to clean up |

The script is safe to re-run — it checks each step and skips whatever is
already done.

### 4. Route the address to the worker (Cloudflare — the one manual step)

**Email Routing** → **Routing rules**: create a rule for `trip@` on the
`trips.haaans.com` subdomain with the action **Send to a Worker** →
`japanclan-mail`.

One generic address covers every trip: events are grouped by *date*, not by
the address they were sent to, so `trip@` alone serves Japan now and whatever
comes after. A booking whose date falls outside every configured trip window
is parked in `pipeline/state/pending` and the reply says so — see the FUTURE
note in `src/index.js` for the sketch of auto-creating a trip from that signal.

⚠️ **Don't reach for the catch-all.** Cloudflare's Email Routing API has no
subdomain-scoped catch-all — `?subdomain=` is silently ignored and the
`/email/routing/subdomains/…` paths 404. The only catch-all is **zone-wide**,
so enabling it would also cover `@haaans.com` the moment that domain's MX ever
moves off Mailgun onto Cloudflare. A literal per-address rule has no such edge.

Note that the zone will report **`status: misconfigured`** with `mx.foreign`
and `mx.missing` errors. That is expected and correct: it is Email Routing
observing that the *root* `haaans.com` still points at Mailgun, which is
exactly what you want. Do not "fix" it.

### 5. Add the people who may email the calendar, and verify

```bash
npm run check     # verifies every step above and prints the fix for anything missing
```

Then open [Firebase console](https://console.firebase.google.com/project/japanclan2k6/firestore)
→ `pipeline/config` → **`senders`** and add each person allowed to email the
calendar: their email (lowercase) → `{ name, trip: "japan-2026" }`. Trip dates,
timezone, and model are pre-filled; adjust if needed.

### 6. Test it

1. From your own Gmail, forward a real flight or hotel confirmation to
   `trip@trips.haaans.com`.
2. Within a few seconds you should get a reply listing exactly what was added
   (a round-trip confirmation adds **both** flights) — and it's live in the
   app, no refresh needed.
3. Reply **UNDO** → the reply confirms it was removed, and it's gone from the
   app. Forward the original email again to re-add it.
4. Forward the same email again → reply says it's already on the calendar.
5. Send a made-up note like *"dinner at Gonpachi July 20 at 7pm"* → added via
   the AI path, on the same day as anything else already planned.
6. Reply **STATUS** → you get a list of recent activity. **HELP** explains
   all the commands.
7. Ask a friend **not** on the allowlist to send something → they get a
   bounce, nothing is processed.

---

## How it decides where things go

- **Flights define the trip.** A trip in the config is just a date window +
  timezone (set once, from the flights). Every email after that — hotels,
  trains, dinners — is grouped into whichever trip's window contains its date,
  no matter which address it was sent to.
- **Same-day things stack.** A flight, a hotel check-in, and a dinner on the
  same day all show on that day: flights/trains take the day's headline slot,
  everything else lists under it in time order. Re-sent bookings (schedule
  changes) update in place instead of duplicating.
- **When it's not sure, it asks.** If the AI's confidence is low, nothing is
  added — you get a reply describing what it *thinks* the booking is, and you
  answer **YES** or **NO**. Nothing ever lands on the calendar silently wrong.
- **Nothing is ever lost.** Every accepted email is forwarded to your Gmail as
  an archive; anything unreadable or ambiguous is saved in a review queue
  (`pipeline/state/pending`) and the sender is told so.

## Day-to-day

- **Add a person:** Firebase console → `pipeline/config` → `senders` → add
  their email. That's it — no deploys.
- **Add a trip:** add an entry under `trips` (dates + timezone + itinerary
  path) and optionally map an address like `paris@trips.haaans.com` under
  `addresses`. Senders default to their own `trip`.
- **Fix a mistake:** reply **UNDO** to the confirmation email (works while
  nothing else has changed the calendar since). For anything older, edit the
  itinerary doc in the Firebase console.
- **Something didn't parse / hotel overlap:** it's saved in Firestore under
  `pipeline/state/pending` with the reason, and the sender got a reply saying
  so. Add it to the itinerary by hand (see `.agents/AGENTS.md` → "Adding a new
  itinerary day"), then delete the pending doc.
- **Someone's spamming or a key concern:** each sender is capped at 30 emails
  a day (change `options.maxPerSenderPerDay` in the config).
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

- **Service-account key:** list and delete it, then re-run setup — old key dies
  instantly:
  ```bash
  gcloud iam service-accounts keys list --iam-account=japanclan-mail@japanclan2k6.iam.gserviceaccount.com --managed-by=user
  gcloud iam service-accounts keys delete KEY_ID --iam-account=japanclan-mail@japanclan2k6.iam.gserviceaccount.com
  ```
  Then delete `GCP_SA_KEY` in the Cloudflare dashboard and run `./setup.sh`
  again to mint a fresh one.
- **Gemini key:** AI Studio → API keys → delete + recreate →
  `npx wrangler secret put GEMINI_API_KEY`.

## What it costs

Nothing, at this scale: Cloudflare Email Routing and the Workers free tier
(100,000 emails/day allowed; you'll see dozens), Firestore free tier
(~5 reads/writes per email), Gemini free tier (one small call per email, and
zero for emails with calendar attachments). There is no card on file anywhere
in this pipeline.
