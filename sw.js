const CACHE_NAME  = "pipsiflix-shell-v30";
const APP_SHELL   = [
  "./",
  "./index.html",
  "./player.html",
  "./styles.css",
  "./player.css",
  "./app.js",
  "./player.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if(request.method !== "GET") return;

  const url    = new URL(request.url);
  const isData = url.pathname.endsWith(".json") || url.pathname.endsWith(".m3u");

  if(isData){
    // Données : réseau en priorité, cache en fallback
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Shell : cache first + mise à jour réseau en arrière-plan
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if(url.origin === self.location.origin && response.ok){
          const copy = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => {});
        }
        return response;
      });
      return cached ||
        networkFetch.catch(() =>
          request.mode === "navigate" ? caches.match("./index.html") : cached
        );
    })
  );
});
