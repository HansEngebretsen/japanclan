const CACHE_NAME = "jc-cache-v1";
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
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
