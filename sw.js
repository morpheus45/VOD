// sw.js — PIPSILY v5.0 — mise à jour automatique + notification
const CACHE = "pipsily-v76";
const SHELL = ["./","./index.html","./login.html","./account.html","./player.html","./styles.css?v=74","./player.css","./app.js?v=78","./auth.js","./player.js?v=51","./manifest.webmanifest","./logo.svg","./icons/icon-192.png","./icons/icon-512.png","./version.json"];

// ── Installation : vider anciens caches + mettre en cache le shell ──
self.addEventListener("install", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c => c.addAll(SHELL)))
      // NE PAS appeler skipWaiting() ici — on attend que l'utilisateur accepte
  );
});

// ── Activation : supprimer les vieux caches ──
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Message : SKIP_WAITING vient de l'app quand l'utilisateur accepte la MAJ ──
self.addEventListener("message", e => {
  if(e.data?.type === "SKIP_WAITING"){
    self.skipWaiting().then(() => {
      // Recharger tous les onglets après activation
      self.clients.matchAll({ type:"window" }).then(clients =>
        clients.forEach(c => c.postMessage({ type:"RELOAD" }))
      );
    });
  }
});

// ── Fetch : network-first pour JSON/M3U, cache-first pour assets ──
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

// ── Notification de mise à jour : informer l'app qu'un nouveau SW attend ──
self.addEventListener("install", () => {
  self.clients.matchAll({ type:"window" }).then(clients =>
    clients.forEach(c => c.postMessage({ type:"UPDATE_AVAILABLE" }))
  );
});
