# Pre-flight check prompt (paste into Gemini in Chrome)

Use this **before** starting `SETUP.md`. It asks Gemini to look at your open
Cloudflare and GitHub tabs and confirm the email pipeline will work with your
existing DNS — **without changing anything**.

**How to use it**

1. In Chrome, open two tabs and sign in:
   - **Tab A** — <https://dash.cloudflare.com> → click **haaans.com** → left sidebar **DNS** → **Records**
   - **Tab B** — <https://github.com/HansEngebretsen/japanclan/blob/email-calendar/worker/SETUP.md>
2. Open Gemini in Chrome and paste everything in the box below.
3. Paste its answer back to Claude if anything comes back ⚠️ or ❌.

---

```
You are helping me verify — READ ONLY — whether a planned email pipeline is compatible with my existing DNS setup. I have two Chrome tabs open: a Cloudflare DNS records page for the domain haaans.com, and a GitHub page showing a setup guide called SETUP.md.

ABSOLUTE RULES — follow these exactly:
- Do NOT click any button that creates, edits, deletes, enables, disables, or saves anything.
- Do NOT add DNS records, do NOT enable Email Routing, do NOT start any wizard, do NOT modify any setting.
- You may only READ what is already displayed, and you may navigate to READ-ONLY views (clicking a left-sidebar section like "DNS" or "Email" to view its current state is fine; clicking "Add record", "Enable", "Get started", "Save", or "Continue" in a setup flow is NOT).
- If a page asks you to confirm or save something, STOP and report that instead.
- Do not read, copy, or repeat any API tokens, keys, or secrets. If you see one, say "a secret is visible on screen" and nothing more.

WHAT I AM PLANNING (from the SETUP.md tab, for context):
I want to receive email at addresses on the SUBDOMAIN trips.haaans.com (for example japan@trips.haaans.com) using Cloudflare Email Routing, and have those emails handled by a Cloudflare Worker. My root domain haaans.com already receives email through a different provider, and that must remain untouched. The website haaans.com is served by GitHub Pages and must keep working.

PLEASE CHECK AND REPORT THE FOLLOWING, IN ORDER:

1. NAMESERVERS / ZONE: On the Cloudflare tab, confirm that haaans.com is an active zone in this Cloudflare account (look at the domain's Overview or the DNS page for a status like "Active"). Report the exact status text you see.

2. ROOT MX RECORDS: In DNS → Records, find any MX records whose name is haaans.com (the root/apex). List each one exactly: name, mail server value, and priority. State plainly which email provider they point to.

3. SUBDOMAIN COLLISION: Search the DNS records list for ANY record whose name contains "trips" (for example trips.haaans.com, or a wildcard record *.haaans.com). Report every match with its type, name, and value — or state clearly that there are none.

4. WEBSITE RECORDS: Report the record(s) for the root haaans.com and for www — their type (A / AAAA / CNAME), value, and whether the proxy status shows "Proxied" (orange cloud) or "DNS only" (grey cloud).

5. EMAIL ROUTING STATUS: Navigate to the "Email" section in the left sidebar to VIEW its current state only. Report whether Email Routing appears already enabled for this zone, and whether any subdomains are listed. Do not enable anything, and do not proceed past any screen that would create records.

6. PLAN FEASIBILITY: Based only on what you actually saw, answer these four questions with YES / NO / UNSURE plus one sentence of evidence each:
   a. Is haaans.com fully managed by Cloudflare DNS (so Cloudflare Email Routing is available)?
   b. Would adding Email Routing on the subdomain trips.haaans.com leave the ROOT haaans.com MX records unchanged?
   c. Is there anything already at trips.haaans.com that would conflict with new MX records?
   d. Would this change affect the GitHub Pages website at haaans.com in any way?

7. FINAL VERDICT: Give me one of these three, with a one-paragraph explanation in plain language:
   - "GO — safe to proceed with SETUP.md as written"
   - "GO WITH CAUTION — proceed, but note the following: ..."
   - "STOP — this conflicts with the current setup because: ..."

Format your entire answer as a short bulleted report under the headings 1–7 above. Do not summarize the SETUP.md guide back to me, and do not perform any of its steps. Again: read only — change nothing.
```

---

## What the answers should look like (so you can sanity-check Gemini)

| Item | Expected healthy answer |
|---|---|
| 1. Zone | haaans.com is **Active** on Cloudflare (nameservers `ines`/`isaac.ns.cloudflare.com`) |
| 2. Root MX | Two records → `mxa.mailgun.org` and `mxb.mailgun.org`, priority 10 — this is your existing mail, and it must stay |
| 3. `trips` records | **None** — a clean subdomain to claim |
| 4. Website | Root/`www` pointing at GitHub Pages, unaffected by mail changes |
| 5. Email Routing | Probably not enabled yet — that's fine, SETUP.md step 1 turns it on |
| 6. Feasibility | a YES, b YES, c NO, d NO |
| 7. Verdict | **GO** |

**If you get "STOP" or a surprise in items 2–3**, paste Gemini's report back to me
before touching anything — the two things that would actually matter are a
wildcard `*.haaans.com` record (could collide with the subdomain) or the zone
not being fully on Cloudflare.

## Why this is safe to run

Everything in the prompt is a read: it looks at DNS records and status text you
can already see. Adding email on `trips.haaans.com` later only creates records
**on that subdomain** — root MX (Mailgun) and the GitHub Pages records are
never touched, which is exactly what items 2 and 4 are there to prove.
