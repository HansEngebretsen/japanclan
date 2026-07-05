# Japan Clan 一族

A single-file trip planner for a July 2026 Japan trip (Tokyo + Hokkaido). Browse only-in-Japan
things to **eat / do / buy**, collect them as stamped "coins," see the day-by-day itinerary, and
split the shared Hans↔Spencer IOU ledger.

Everything lives in one file: [`index.html`](index.html) — inline HTML, CSS, and JS, no build step.

## Features

- **Browse & collect** – 125+ curated items with filters (Eat/Do/Buy/July, Anywhere/Tokyo/Hokkaido).
  Tap a coin to "stamp" it. Works offline; stamps persist in `localStorage`.
- **Itinerary panel** – tap a calendar day to see that day's flight / train / hotel / event, with
  Google-Maps links to each waypoint and a hotel line for where you're sleeping.
- **Shared IOU ledger** – a two-party (Hans↔Spencer) split-the-bill drawer. Local until you sign in,
  then live-synced across everyone in the group.
- **Sign-in sync (Firebase)** – optional. Sign in with Google to sync your stamps, see everyone
  else's stamps, and share the live ledger.

## How sync works

The app is **local-first**: with no sign-in it runs entirely from `localStorage`. Signing in with
Google (Firebase Auth) layers on a shared [Cloud Firestore](https://firebase.google.com/docs/firestore)
backend:

| Data | Signed out | Signed in |
| --- | --- | --- |
| Your stamps (`coins`) | localStorage | merged up to `pins/{uid}`, cached locally |
| Everyone's stamps | — | read from all `pins/*`, shown as badges on cards |
| IOU ledger | local array | shared `ledger/*` collection, live via `onSnapshot` |

Firestore layout (`trips/japan-2026/`): `ledger/{id}`, `pins/{uid}`, `roster/list`.

### Access

Anyone with a Google account can sign in, **capped at 13 people** total (enforced in the security
rules via the roster document). The public Firebase web keys in the HTML are **not secrets** — access
is enforced server-side by [`firestore.rules`](firestore.rules), not by hiding the config.

## Firebase project

- Project: `japanclan2k6`
- Services: Firestore (rules in [`firestore.rules`](firestore.rules)), Auth (Google provider)
- Config files: [`firebase.json`](firebase.json), [`.firebaserc`](.firebaserc)

Deploy rules changes with the Firebase CLI:

```sh
npx firebase-tools deploy --only firestore:rules
```

## Deployment

Hosted as static files at **haaans.com**. The site is marked `noindex` (meta tag + `robots.txt`) so it
stays out of search engines.

Before deploying:

1. **Authorized domains** – in the Firebase console (Authentication → Settings → Authorized domains),
   add `haaans.com` (and `localhost` for local testing) so Google sign-in is allowed from that origin.

## Local development

Serve the folder over http (Firebase Auth needs `http://localhost`, not `file://`):

```sh
npx serve .        # serves index.html at http://localhost:3000
```
