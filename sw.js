// sw.js — PIPSIFLIX v3.1 — cache bust forcé
const CACHE = "pipsiflix-v31";
const SHELL = ["./","./index.html","./player.html","./styles.css","./player.css","./app.js","./player.js","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c => c.addAll(SHELL)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage({ type:"RELOAD" }))))
  );
});

self.addEventListener("fetch", e => {
  const { request } = e;
  if(request.method !== "GET") return;
  const url = new URL(request.url);
  const isData = url.pathname.endsWith(".json") || url.pathname.endsWith(".m3u");
  if(isData){
    e.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }
  e.respondWith(
    caches.match(request).then(cached => {
      const net = fetch(request).then(r => {
        if(url.origin === self.location.origin && r.ok){
          caches.open(CACHE).then(c => c.put(request, r.clone())).catch(()=>{});
        }
        return r;
      });
      return cached || net.catch(() => request.mode === "navigate" ? caches.match("./index.html") : cached);
    })
  );
});
