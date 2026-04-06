const CACHE_NAME = "iptv-premium-v2-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./player.html",
  "./styles.css",
  "./player.css",
  "./app.js",
  "./player.js",
  "./manifest.webmanifest",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        const url = new URL(request.url);
        if (url.origin === self.location.origin && !url.pathname.endsWith(".json") && !url.pathname.endsWith(".m3u")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    }).catch(() => caches.match("./index.html"))
  );
});
