self.addEventListener('install', event => {
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    const regs = await self.registration.unregister();
    await self.clients.claim();
    const clientsArr = await self.clients.matchAll({ type: 'window' });
    for (const client of clientsArr) {
      client.postMessage({ type: 'SW_DISABLED' });
    }
  })());
});
self.addEventListener('fetch', () => {});
