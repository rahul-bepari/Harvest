/* =====================================================================
   HARVEST — sw.js (pwa section)
   Offline-first strategy:
   - App shell (HTML/CSS/JS/manifest) and the bundled crop dataset are
     precached on install and served cache-first, since they change only
     when the app itself is updated (version bump below).
   - Anything else (e.g. the weather API, an optional Supabase call) is
     network-first — try the network, fall back to cache if offline, and
     never blocks the app from working with zero connectivity.
   ===================================================================== */
const CACHE_VERSION = "harvest-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.webmanifest",
  "./data/crops.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept writes (e.g. Supabase POSTs)

  const url = new URL(req.url);
  const isAppShell = url.origin === self.location.origin;

  if (isAppShell) {
    // cache-first for our own files — instant load, works fully offline
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached))
    );
  } else {
    // network-first for external calls (weather API, Supabase) so data
    // stays fresh when online, but still degrades to a cached copy
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
