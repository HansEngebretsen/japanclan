# Japan Clan · Agent Rules

## Architecture

Single-file static web app. Everything lives in `index.html` — inline `<style>`, inline `<script>`, no build step, no bundler.

### File structure (after reorg)

```
index.html              ← the entire app (HTML + CSS + JS)
favicon/                ← favicons, PWA icons, web manifest
  favicon.ico
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png
  icon-192.png
  icon-512.png
  icon-maskable-512.png
  site.webmanifest
config/                 ← Firebase backend config (NOT deployed to static site)
  firestore.rules
  firestore.indexes.json
firebase.json           ← Firebase CLI config (points into config/)
.firebaserc             ← Firebase project alias
robots.txt
README.md
.github/workflows/deploy.yml
```

### Deployment

- Hosted on **GitHub Pages** at `haaans.com` (custom domain, subdirectory `/japanclan/`).
- Deploy workflow: `.github/workflows/deploy.yml` rsyncs to `_site/`, excluding `.git`, `.github`, `.agents`, `config/`, `firebase.json`, `.firebaserc`, `README.md`.
- **All asset paths in `index.html` MUST be relative** (e.g. `favicon/favicon.ico`, never `/favicon/favicon.ico`) so the site works at any base path.
- The site is `noindex` / `nofollow` (meta tag + `robots.txt`).

### Firebase

- Project: `japanclan2k6`. Services: Firestore + Auth (Google provider).
- Firebase CLI config files live in `config/`. `firebase.json` at root references them via `config/firestore.rules` and `config/firestore.indexes.json`.
- The Firebase web SDK is loaded via CDN (`firebase-*-compat.js` v10.12.2). Config object is inline at `window.JC_FB_CONFIG` (~L709).
- Firestore path: `trips/japan-2026/{ledger,pins,roster}`.
- The `firestore.rules` enforce a 13-person roster cap and self-only writes.
- Deploy rules: `npx firebase-tools deploy --only firestore:rules`

## Code Map (index.html)

Reference these line ranges for targeted edits:

| Section                | Lines       | What it is                                                    |
|------------------------|-------------|---------------------------------------------------------------|
| `<head>` / meta        | 1 – 19      | Charset, viewport, favicon links, manifest link, Google Fonts |
| CSS variables / skins   | 20 – 138    | `:root` vars + 6 named skins (sumi, samurai, ai, matcha, sushi, beni), each with light+dark, structural vars, decorative rules |
| CSS layout              | 140 – 619   | All component styles (calendar, itinerary, cards, filters, ledger, settings dialog, modals) |
| HTML body               | 620 – 739   | Header, calendar, itinerary panel, filters, grid, modals, ledger drawer, footer |
| Firebase SDK scripts    | 741 – 754   | CDN `<script>` tags + `JC_FB_CONFIG` object                  |
| JS: Store / state       | 756 – 766   | localStorage wrapper, state init                              |
| JS: Theme               | 768 – 782   | Light/dark toggle, status-bar color sync                      |
| JS: Calendar            | 784 – 923   | `DAYS`, `CAL_DAYS`, `ITIN{}`, day rendering, itinerary panel  |
| JS: ITEMS data          | 931 – 1063  | The 125+ item catalog (`ITEMS` array)                         |
| JS: Runtime / render    | 1065 – 1297 | Filters, card rendering, coin toggle, modal                   |
| JS: Ledger (warikan)    | 1300 – 1567 | IOU drawer, expense CRUD, inline editing, paste-to-add        |
| JS: Settings / skins    | 1241 – 1275 | Esc-triggered settings dialog, skin picker, THEMES array      |
| JS: Firebase sync       | 1572 – 1691 | Auth UI, Firestore subscriptions (pins, ledger, roster)       |

## Editing Guidelines

### Adding a new item
Append an object to the `ITEMS` array (~L894–1026). Format:
```js
{id:"x_slug", cat:"eat|do|buy|july", reg:"either|tokyo|hokkaido", area:"jp|district", lvl:1-3, name:"Name", note:"One sentence — continuation after dash.", tip:"Pro tip.", flag:"Summer|Book|Free|Cash|Exclusive|Only Hokkaido"}
```
- `id` must be unique; prefix with `e_`, `d_`, `b_`, `k_`, or `j_` by category.
- `lvl` maps to ¥/¥¥/¥¥¥ price indicator (0 = none, for july category).
- For `july` items add `when`, `vd` ("go"/"maybe"/"miss"), and `vt` fields.

### Adding a new itinerary day
Add an entry to the `ITIN` object (~L786–798):
```js
DAY_NUM: {main:{t:"TIME", ic:"flight|train|hotel|event", title:"Title", wp:"Google Maps query", sub:["Line 1","Line 2"]}, stay:{title:"Hotel", wp:"Hotel query", day:CHECK_IN_DAY}}
```

### Adding a new color skin
1. Add CSS variables for `[data-skin="id"]` and `[data-skin="id"][data-theme="dark"]` blocks (~L40–105).
2. Add an entry to the `THEMES` array (~L1186–1193).

### Changing cities on the calendar
Edit `DEFAULT_CITY` (~L751). Hokkaido cities are auto-detected via the `HOK` set (~L754).

### Modifying the IOU ledger
The ledger is a two-party (Hans ↔ Spencer) split. Names are hardcoded in the HTML (~L665-666) and in `expNets()` / `renderLedger()`. To change names: search for "hans" and "spencer" (case-insensitive) and replace consistently.

### CSS theming
All colors flow through CSS custom properties on `:root` / `[data-theme="dark"]`. Never use hardcoded color values — always use `var(--name)`. The key vars:
- `--paper` (background), `--card` (card bg), `--ink` (text), `--seal` (accent/red), `--line` (borders)

### Path rules
- **Never use absolute paths** (`/favicon/...`). Always relative (`favicon/...`).
- The manifest `start_url` is `"../"` because the manifest lives in `favicon/`.
- Icon src in `site.webmanifest` are relative to the manifest file.

### Mobile Preview (Local Server)
To test the site locally with live-reloading on a mobile device, run:
```bash
npm run preview
```
This triggers a custom `browser-sync` script (`preview.js`) that:
- Spawns a local server.
- Watches for changes in `index.html`, `favicon/**/*`, `sw.js`, `config/**/*`, and `img/**/*` and auto-refreshes.
- Prints a clean, easy-to-read **External IP URL** in the terminal.
- Allows Safari Web Inspector debugging over Wi-Fi, since it doesn't block proxy traffic.

**Agent Instruction:** When running the mobile preview for the user, check the terminal output for the URL. If the URL is exactly `http://192.168.86.30:3000`, you MUST embed the pre-generated static QR code in your chat response using this exact markdown: `![QR Code](/Users/hansengebretsen/Sites/japanclan/.agents/qr.png)`. If the URL is anything else (e.g., a different port or IP), just provide the text URL to the user.


## Don'ts
- Don't split `index.html` into separate files — the single-file design is intentional.
- Don't upgrade the Firebase SDK from compat to modular without explicit approval.
- Don't add a build step (webpack, vite, etc.) — this is a zero-build project.
- Don't change `noindex` / `nofollow` — this is a private trip planner.
- Don't change Firebase security rules without reviewing the roster-cap logic.
