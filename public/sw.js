/* FloodGrid service worker: offline app shell only.
   Telemetry is never served from cache as current data: every /api request goes
   straight to the network so the UI can never show a stale reading as live. */

const CACHE_NAME = 'floodgrid-shell-v3';
const APP_SHELL = ['/', '/status', '/devices', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((path) => new Request(path, { cache: 'reload' }))).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API responses: they must always come from the server.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put('/', response.clone()));
        return response;
      }).catch(async () => {
        const cached = await caches.match(request) || await caches.match('/');
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGrid offline</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Offline</h1><p>The app shell is cached, but live telemetry is not. Cached readings are never shown as current conditions. Reconnect to load new data.</p></main>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'FloodGrid status update', body: 'Open FloodGrid to review the latest update.', url: '/app/alerts' };
  try {
    if (event.data) payload = { ...payload, ...JSON.parse(event.data.text()) };
  } catch {
    /* keep the default payload */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url || '/app/alerts' },
      tag: `floodgrid-${payload.severity || 'update'}`,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/app/alerts';
  event.waitUntil(self.clients.openWindow(target));
});
