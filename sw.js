const CACHE_NAME = "jc-cache-v2";
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
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
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
  e.respondWith(
    caches.match(req).then(res => res || fetch(req))
  );
});
