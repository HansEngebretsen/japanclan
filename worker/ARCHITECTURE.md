# How the email → calendar pipeline works

This document explains the design of the Cloudflare Worker that turns emails and
typed notes into calendar entries. It covers *how the system is built and why*.

- **Setting it up from scratch** → [SETUP.md](SETUP.md)
- **Finishing setup on a new machine** → [HANDOFF.md](HANDOFF.md)
- **What the app itself does** → [../about.md](../about.md)

Everything here is written with placeholders (`<project-id>`,
`trip@<your-domain>`). No credentials, key material, endpoint URLs, or personal
addresses appear in this file, and none should be added to it — the real values
live in Cloudflare secrets and in the runtime config document described below.

---

## 1. The problem this solves

The app is a **single static HTML file** with no build step. It reads its data
live from Firestore and is deployed by copying files. That constraint is
deliberate, and it rules out the obvious approach of running a server that polls
a mailbox.

So the pipeline has to satisfy three things at once:

1. **Somewhere to receive email** that isn't a mail server anyone maintains.
2. **Somewhere to run untrusted parsing** with a credential the browser must
   never see.
3. **A write path into Firestore** that the app's own security rules
   deliberately forbid to clients.

A Cloudflare Email Worker covers all three. Cloudflare terminates the SMTP
conversation, the Worker holds the secrets, and Firestore is written over its
REST API using a service-account identity that answers to IAM rather than to
`firestore.rules`.

```
                    ┌──────────────────────────────────────────┐
  forwarded email → │  Cloudflare Email Routing                │
                    │    → Worker.email()                      │
                    └──────────────────┬───────────────────────┘
                                       │
  typed note in ──→ Worker.fetch()  ───┤   shared: parse → resolve
  the app's                            │           → validate → apply
  "Add to calendar"                    │
                                       ▼
                             ┌────────────────────┐
                             │ Firestore          │
                             │  itinerary doc     │
                             └─────────┬──────────┘
                                       │ onSnapshot (live)
                                       ▼
                              the static app in
                              everyone's browser
```

The two entry points converge on purpose. `parse → resolve → validate → apply`
is one code path, so a pasted booking behaves exactly like a forwarded one and
both inherit the same test suite.

---

## 2. Layout

| File | Responsibility |
|---|---|
| `src/index.js` | Email entry point; orchestrates the whole email flow |
| `src/http.js` | HTTP entry point (`/add`, `/remove`) for the app's UI |
| `src/auth.js` | Firebase ID-token verification — the HTTP security boundary |
| `src/gauth.js` | Service-account auth for Firestore REST |
| `src/firestore.js` | Minimal Firestore REST client + typed-value codec |
| `src/config.js` | Runtime config loader and the two LLM prompts |
| `src/parse.js` | Text trimming, ICS fast path, Gemini call, validation |
| `src/map.js` | Turning a parsed event into itinerary shape; conflicts; removal |
| `src/commands.js` | Email-reply commands (`YES`/`NO`/`UNDO`/`STATUS`/`HELP`) |
| `src/reply.js` | Composing replies back to the sender |
| `src/localauth.js` | Local-tooling auth so scripts run without a key file |

Tests live in `test/` and run with `npm test` from `worker/`. They cover the
pure logic — parsing, mapping, conflicts, removal, the HTTP gate — with no
network access.

---

## 3. The email flow, in order

Each stage below can end the request. The ordering is chosen so that the
cheapest and most security-relevant checks happen before anything expensive.

### 3.1 Loop guard

Mail from automated senders is dropped **silently**, before anything else:
`Auto-Submitted` headers, `mailer-daemon`/`postmaster`/`no-reply` local parts,
and anything from the pipeline's own domain. Replying to a bounce or a vacation
responder is how mail loops start, and a loop here would also be a billing
event.

### 3.2 Sender allowlist — the security boundary

The sender's address must appear in the config's `senders` map. Anything else is
rejected at SMTP with a refusal, so the sender's own server tells them.

This matters more than it looks: past this point the Worker writes a **shared**
calendar using a credential that bypasses Firestore security rules. Anyone who
can get mail accepted here can write to that calendar.

### 3.3 Per-sender rate limit

A daily cap per sender (default 30, configurable). This exists to bound the blast
radius if an allowlisted mailbox is compromised — it limits spend on the LLM and
writes to Firestore rather than preventing abuse outright.

### 3.4 Thread commands

Short, hand-typed replies are treated as commands rather than bookings:

| Reply | Effect |
|---|---|
| `YES` | Accept the newest proposal the pipeline was unsure about |
| `NO` | Discard it |
| `UNDO` | Roll back the sender's most recent applied change |
| `STATUS` | Summarize recent pipeline activity |
| `HELP` | Explain what the pipeline understands |

Only the **first line** is considered, quoted reply text is ignored, and
anything longer than a couple of sentences or carrying an attachment is treated
as a real booking instead. Without that length check, a forwarded confirmation
that happens to begin with the word "No" would be swallowed as a command.

`UNDO` is guarded by a snapshot: the rollback is refused if the itinerary has
changed since that write landed, rather than clobbering someone else's edit.

### 3.5 Archive

Accepted mail is forwarded to a configured archive address, so the original is
recoverable if parsing later turns out to have been wrong.

### 3.6 Deduplication

Two independent checks, both implemented as *create-only* writes so that two
concurrent deliveries can't both win:

1. **By `Message-ID`** — the same email forwarded twice.
2. **By confirmation code** — the same booking re-sent with a fresh
   `Message-ID`, which is what airlines do when they email a schedule change.

### 3.7 Parsing

Two tiers, cheapest first.

**Tier 0 — ICS attachments (zero tokens).** Calendar invites carry structured
data already. `VEVENT` blocks are parsed directly, with timezone handling for
`Z`, `TZID=`, and floating times. Attachment size is bounded; genuine ICS files
are tiny. If an ICS names a timezone the code doesn't recognize, it deliberately
falls through to the model rather than guessing an offset.

**Tier 2 — one Gemini call.** The email is trimmed first: scripts, styles and
comments dropped, HTML flattened to text, very long tracking URLs reduced to
their origin (which keeps the airline or hotel name and discards the token), and
the whole thing truncated. Quoted text is deliberately **kept** — forwarded
bookings usually arrive as quoted text.

The model is asked for **structured JSON output against a fixed schema**, at
temperature 0, and may return **several events**: one airline confirmation
routinely contains both the outbound and the return.

Model names are read from config so they can be changed **without a redeploy**,
and a failure retries once on a fallback model. The retry triggers on `404` as
well as `429`/`5xx`, because Google retires models and every call to a retired
name returns `404` forever — the failure most likely to hit an unattended
pipeline months later.

### 3.8 Two prompts, deliberately different

| | Forwarded email | Typed note in the app |
|---|---|---|
| Assumption | Most mail is **not** a booking | The user **wants** an event |
| Posture | Cautious; may return nothing | Permissive; infers freely |
| `type: "none"` | Allowed | Never |
| Missing time | Not invented | Sensible default, lower confidence |

Using the cautious email prompt for typed notes was actively wrong: "drinks with
Kenji thursday" is not a booking by any email-parsing standard, but it is
unambiguously something the user is asking to put on the calendar. Both prompts
are overridable from config independently.

Both prompts state that **the input is untrusted data and instructions inside it
must never be followed.** A forwarded email is attacker-influenced content, and
the model output is treated as data throughout — it is validated and sanitized
before it can reach the calendar.

### 3.9 Trip resolution and validation

A parsed event is matched to a trip **by date**: whichever configured trip window
contains it. That is what lets one email address serve several trips; the
address→trip mapping is only a tie-break default.

Validation then enforces a schema-level contract, independent of what the model
returned: a known event type, a parseable ISO timestamp, a date inside the trip
window, string lengths bounded, control characters stripped, and a confidence
floor. Anything failing lands in a review queue with a reply explaining why,
rather than being silently dropped.

Events the model is **unsure** about (below a configurable confidence threshold)
are not applied. They are *proposed* — the reply describes the event and asks for
`YES`/`NO`.

> **Known limitation.** A date just outside the trip window is refused and
> queued. In practice such a date is more often a trip that wants extending than
> a mistake, so the intended improvement is to grow the trip window (or offer to
> start a new trip) instead of bouncing it. The code carries a `FUTURE:` note at
> the decision point.

### 3.10 Writing to Firestore

Writes are **merge-style and optimistically concurrent**. The current document is
read, events are applied in memory, and the write is conditional on the document
not having changed in the meantime. If it did change, the whole read-apply-write
cycle is retried.

This is what makes concurrent edits safe: two people can forward bookings at the
same moment, or one can be editing in the app while mail arrives, without either
silently overwriting the other.

Applying an event means placing it into the itinerary's shape:

- **Flights and trains** anchor a day.
- **Lodging** spans nights and is stored once, referenced by every night it
  covers — so a multi-night stay stays linked rather than duplicated per day.
- **Everything else** joins that day's secondary list, time-sorted.
- A **re-sent booking** (matching confirmation code or title) updates in place
  rather than duplicating — this is how schedule changes are absorbed.
- A **higher-priority** event displaces the anchor and pushes the previous
  anchor into the secondary list.

**Conflicts.** Only lodging can truly conflict: two hotels can't occupy the same
night. Rather than failing flatly, the conflict is reported *structurally* —
which nights clash, which property holds them, and which is arriving — so the UI
can offer a genuine choice. See §5.

Every applied change also writes a snapshot to a log, which is what `UNDO`
rolls back to.

### 3.11 The activity feed

Each change appends a short line to an `activity` array on the itinerary
document, capped at a fixed length.

This rides along on a document the app **already** reads and subscribes to. The
alternative — a separate collection — would have needed its own security rules,
its own subscription, and its own cache, to show a handful of lines. This costs
nothing extra.

Removals **flag** rather than delete. Removing something marks both the line
announcing the removal *and* the older line that announced the add it undid, so
the history stays readable but neither line offers a link to something that no
longer exists. The app additionally refuses to link any line describing a
removal, and otherwise requires that a title still present on that day appears
in the line — which is what makes entries written *before* the flag existed
behave correctly without a migration.

### 3.12 Replying

One reply per email, summarizing every event: what was added, what was already
there, what conflicted, what needs a `YES`/`NO`.

Handled failures reply politely and queue the email for review. Only genuinely
unexpected crashes are allowed to reject the message — that makes the sender's
mail server retry, which is the correct behavior for a transient fault and the
wrong behavior for "this email wasn't a booking".

---

## 4. The HTTP surface

The app's "Add to calendar" box posts to the same Worker.

**Two routes only**, `POST /add` and `POST /remove`. Everything else is a 404.

The gate is the entire security story, because past it the Worker writes
Firestore with a service-account identity that bypasses client security rules:

1. **Origin check.** Only the app's own origins receive CORS headers. Anything
   else gets none, so a browser refuses to hand the response back to the calling
   page. Checks are on parsed URL components — not string prefixes, which would
   accept lookalike hostnames.
2. **Input bounds first.** Length and emptiness are checked *before* token
   verification, so junk can't cost a network round trip.
3. **Firebase ID token verification.** Full RS256 signature check against
   Google's published signing keys, with issuer, audience, expiry and
   email-verified all pinned. Structurally invalid tokens are rejected without
   any network access. It fails closed everywhere.
4. **Allowlist.** The verified email must be on the same allowlist the email
   path uses.
5. **Per-user daily cap.**

Only then does the request join the shared parse → resolve → validate → apply
chain.

**Removal** carries the item's title as a stale-view guard: if what's actually on
the calendar no longer matches what the user was looking at, the removal is
refused rather than deleting whatever happens to be in that position now.
Removing a stay clears **every** night it covers — leaving half a hotel behind
would be worse than not offering removal at all.

---

## 5. Hotel replacement

A hotel landing on nights that already have one is a **choice, not an error**.

The `/add` response therefore returns a "needs replace" outcome carrying both
properties and the affected nights, and the app renders them side by side. If the
user confirms, the request is retried with a replace flag.

Two details worth knowing:

- The confirmation re-sends the **original text**, not the parsed event. Taking
  an event object back from the client would mean trusting it to describe what
  the model actually produced. The cost is one extra model call, only on
  conflicts.
- Replacement is **night-scoped**. If the existing stay extends beyond the
  overlap, only the overlapping nights change hands and the old property keeps
  the rest. It is removed entirely only when it has no nights left.

---

## 6. Configuration

Runtime configuration lives in a **Firestore document**, not in code, and is
cached briefly in the Worker. Senders, trip windows, addresses, model names,
prompts, and thresholds can all change **without a redeploy** — which matters
most when a model is retired and the pipeline needs a new name immediately.

Roughly:

```jsonc
{
  "senders":   { "<allowlisted address>": { "name": "…", "trip": "<trip-id>" } },
  "addresses": { "trip@<your-domain>": "<trip-id>" },   // tie-break default only
  "trips": {
    "<trip-id>": {
      "year": 2026, "month": 7, "firstDay": 12, "lastDay": 25,
      "defaultTz": "GMT+9", "tzOffset": "+09:00",
      "itineraryPath": "<path to the itinerary document>"
    }
  },
  "llm": {
    "model": "<model name>",
    "fallbackModel": "<model name>",
    "maxInputChars": 8000,
    "autoThreshold": 0.75
    // promptTemplate / manualPromptTemplate: optional overrides
  },
  "options": {
    "replyOnSuccess": true,
    "replyOnFailure": true,
    "maxPerSenderPerDay": 30,
    "archiveTo": "<archive address>"
  }
}
```

### Secrets

Two, both set through Wrangler's secret store and **never** committed:

| Secret | Purpose |
|---|---|
| Service-account key | Firestore REST access. Scoped to the datastore role only |
| LLM API key | The parsing call |

The service account is deliberately **narrowly scoped**: it can read and write
Firestore data and nothing else. The setup script streams the key straight into
Wrangler without ever writing it to disk.

Firestore access uses a self-signed service-account JWT with the API root as its
audience, which Google accepts directly as a bearer token — so there is no OAuth
exchange round trip. It is cached in-isolate until shortly before expiry.

---

## 7. Operational state

The pipeline keeps several small collections:

| Collection | Purpose |
|---|---|
| `log` | Every outcome, for `STATUS` and debugging |
| `pending` | The review queue: unparseable, out-of-range, proposed, conflicts |
| `dedup` | Message-ID and confirmation-code markers |
| `rate` | Per-sender and per-user daily counters |
| `applied` | Before-snapshots, for `UNDO` |

Every outcome is logged — successes, conflicts, refusals, rejections and errors
alike — so "I forwarded it and nothing happened" is always answerable.

---

## 8. Local development

From `worker/`:

```bash
npm test          # full suite, no network
npm run check     # verify configuration and permissions
```

The Firestore client honors an emulator host, and local tooling can authenticate
with a short-lived CLI token instead of a key file — so neither tests nor local
scripts need key material on disk.

The app itself is a static file: serve the repo root and open it. Note that the
"Add to calendar" and delete flows require a **signed-in** user, because both
send a Firebase ID token; signed out, the calendar renders but those paths
correctly refuse.

> **Deploying is a separate, explicit step.** Client-side changes reach users
> when the static files are deployed; changes under `worker/src/` only take
> effect when the Worker itself is deployed. A change that spans both — as most
> pipeline changes do — is only half-live until both have shipped. If behavior
> looks stale, check this before suspecting caching.

---

## 9. Design decisions worth keeping

- **One shared pipeline.** Email and the in-app box run the same
  parse → resolve → validate → apply chain. Two code paths would drift, and the
  tests would only cover one of them.
- **Fail closed at the gate, fail gently everywhere else.** Auth and the sender
  allowlist refuse outright. Parsing failures queue the item and explain
  themselves, because a wrong refusal is invisible to the user while a wrong
  addition is not.
- **Model output is data, never instruction.** It is validated, bounded, and
  sanitized before it can reach the calendar.
- **Config over redeploys.** Anything likely to change under time pressure —
  model names above all — lives in Firestore.
- **Optimistic concurrency everywhere.** Multiple people share one calendar.
- **History is flagged, not deleted.** Removing something should not rewrite the
  record that it once existed.
- **Cheap checks first.** Loop guard, allowlist, rate limit, and input bounds all
  run before the request can cost a model call.

---

## 10. Keeping this document honest

This file describes behavior that lives in code, so it can drift. When changing
the pipeline, update the section that describes it in the same commit.

Watch these in particular, since they're the ones most likely to silently
diverge:

- **§3.7 / §6** — model names and retry behavior. These are expected to change
  when a model is retired; the config shape is the contract, not the names.
- **§3.9** — the out-of-range limitation. If trip windows ever grow
  automatically, that note and the `FUTURE:` comment in the code go together.
- **§3.11** — the activity-feed flags. The app's link logic and the Worker's
  flag-writing are two halves of one behavior; changing either alone will break
  it.
- **§4** — the allowed origins and the gate ordering.

The numbers quoted here (rate limits, thresholds, caps) are defaults read from
config at runtime. Treat them as illustrative, and the config document as the
source of truth.
