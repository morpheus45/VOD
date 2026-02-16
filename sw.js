const CACHE_NAME="vod-pwa-v12-20260216163645";
const ASSETS=[
  "./",
  "./index.html",
  "./admin.html",
  "./panel.html",
  "./vitrine.js",
  "./admin.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install",(e)=>{
  e.waitUntil(
    caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",(e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.map(k=>k!==CACHE_NAME?caches.delete(k):null)))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",(e)=>{
  if(e.request.method!=="GET") return;
  const url = new URL(e.request.url);

  if(url.pathname.endsWith("/vod.json") || url.pathname.endsWith("/vod.m3u")){
    e.respondWith(
      fetch(e.request).then(r=>r).catch(()=>caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request))
  );
});
