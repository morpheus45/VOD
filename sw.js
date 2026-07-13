// sw.js — PIPSILY v5.2 — coquille en RÉSEAU D'ABORD (MAJ instantanées, plus
// besoin de vider le cache) ; assets immuables en cache d'abord.
const CACHE = "pipsily-v242";
const SHELL = ["./","./index.html","./login.html","./account.html","./admin.html","./player.html","./install.html","./vitrine.html","./merci.html","./samsung-tv.html","./styles.css?v=106","./player.css","./app.js?v=181","./auth.js","./player.js?v=51","./manifest.webmanifest","./logo.svg","./icons/icon-192.png","./icons/icon-512.png","./cosmos.html","./version.json","./icons/splash/splash-750x1334.png","./icons/splash/splash-1170x2532.png","./icons/splash/splash-1179x2556.png","./icons/splash/splash-1290x2796.png","./icons/splash/splash-1320x2868.png","./icons/splash/splash-1668x2388.png","./icons/splash/splash-2048x2732.png"];

// ── Installation : vider anciens caches + mettre en cache le shell ──
// Promise.allSettled → une image manquante ne casse plus toute l'installation
self.addEventListener("install", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c =>
        Promise.allSettled(SHELL.map(url => c.add(url).catch(() => {})))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activation : supprimer vieux caches + prendre le contrôle des pages ──
// PAS de RELOAD forcé — évite la bannière "mise à jour" à chaque démarrage
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Message SKIP_WAITING (bouton "Mettre à jour" dans l'app) ──
self.addEventListener("message", e => {
  if(e.data?.type === "SKIP_WAITING"){
    self.skipWaiting().then(() => {
      self.clients.matchAll({ type:"window" }).then(clients =>
        clients.forEach(c => c.postMessage({ type:"RELOAD" }))
      );
    });
  }
});

// ── Fetch ─────────────────────────────────────────────────────────────────
//  RÉSEAU D'ABORD pour la COQUILLE de l'app (navigations + HTML/JS/CSS) et les
//  données (JSON/M3U) → toute mise à jour déployée s'applique dès le prochain
//  lancement, SANS avoir à vider le cache. Le cache ne sert que de secours
//  hors-ligne. CACHE D'ABORD uniquement pour les assets immuables (icônes,
//  splash, logo, police) → démarrage rapide.
//
//  (Avant : cache-first sur le HTML/JS → l'ancienne version était reservie et
//   la nouvelle n'arrivait qu'au 2e lancement, d'où les MAJ qui "ne passaient
//   pas" sur la TV.)
self.addEventListener("fetch", e => {
  const { request } = e;
  if(request.method !== "GET") return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  const isData  = url.pathname.endsWith(".json") || url.pathname.endsWith(".m3u");
  const isShell = request.mode === "navigate" || /\.(html|js|css)$/i.test(url.pathname);

  if(isData || isShell){
    // Réseau d'abord, cache en secours.
    e.respondWith(
      fetch(request).then(r => {
        if(sameOrigin && r.ok){
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(request, clone)).catch(()=>{});
        }
        return r;
      }).catch(() =>
        caches.match(request).then(c =>
          c || (request.mode === "navigate" ? caches.match("./index.html") : c)
        )
      )
    );
    return;
  }

  // Assets immuables : cache d'abord, réseau si absent.
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(r => {
      if(sameOrigin && r.ok){
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(request, clone)).catch(()=>{});
      }
      return r;
    }))
  );
});
