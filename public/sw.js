// Bargo service worker: keeps the app shell available offline.
// Network first, so a new deploy is never hidden behind an old cache.
// API calls and map services are never cached by this worker.
const VERSION = 'bargo-v3';
const SHELL = ['/', '/style.css', '/app.js', '/tilemap.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  // One missing file must never stop the worker installing (that also stops "Install app").
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || Response.error())),
  );
});

// ---- Phone alerts (Web Push) ----
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* plain text */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return; // the open app already shows it
    await self.registration.showNotification(d.title || 'Bargo', {
      body: d.body || '', tag: d.tag || 'bargo', renotify: true, icon: '/icons/icon-192.png', vibrate: [120, 60, 120], data: { jobId: d.jobId || null },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const jobId = event.notification.data && event.notification.data.jobId;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { await wins[0].focus(); wins[0].postMessage({ type: 'open-job', jobId }); return; }
    await self.clients.openWindow(jobId ? `/?job=${jobId}` : '/');
  })());
});
