const CACHE_NAME = "jc-cache-v6";
const ASSETS = [
  "./",
  "index.html",
  "favicon/favicon.ico",
  "favicon/favicon-16x16.png",
  "favicon/favicon-32x32.png",
  "favicon/apple-touch-icon.png",
  "favicon/icon-192.png",
  "favicon/icon-512.png",
  "favicon/site.webmanifest",
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600;700&family=Noto+Serif+JP:wght@400;700;900&family=Outfit:wght@500;600;700&display=swap",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"
];

self.addEventListener("install", e => {
  self.skipWaiting();   // activate the new worker right away instead of waiting for all tabs to close
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())   // take control of already-open PWA windows immediately
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  // Only ever cache-serve GET requests. Auth/API calls (Firebase sign-in, Firestore,
  // token refresh) are POSTs — leave them, and every other method, untouched so they
  // always hit the live network. Intercepting them was causing auth/network-request-failed.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept Google/Firebase API traffic, even GETs — always go straight to the
  // network so auth and data stay live and are never served stale from cache.
  if (url.hostname.endsWith("googleapis.com") ||
      url.hostname.endsWith("firebaseio.com")) return;
  // App shell is network-first: every launch gets the freshest index.html and the
  // cache is only the offline fallback. Cache-first here would pin installed PWAs
  // to whatever shell was cached when the worker installed, so deploys that touch
  // only index.html would never reach them.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
        return res;
      }).catch(() =>
        caches.match(req).then(r => r || caches.match("index.html"))
      )
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(res => res || fetch(req))
  );
});
