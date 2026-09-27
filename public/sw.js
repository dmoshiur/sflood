const CACHE_NAME = 'floodguard-shell-v1';
const APP_SHELL = ['/', '/app', '/manifest.webmanifest', '/floodguard-mark.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put('/', response.clone()));
      return response;
    }).catch(async () => {
      const cached = await caches.match(request) || await caches.match('/');
      if (cached) return cached;
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard offline</title><main style="font-family:system-ui;padding:2rem"><h1>Offline preview</h1><p>No network. FloodGuard never uses cached readings as current conditions. Reconnect to load new telemetry.</p></main>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});

self.addEventListener('push', (event) => {
  let data = { title: 'FloodGuard update', body: 'A new sample update is available.', url: '/app' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* Ignore a malformed demo push. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'FloodGuard update', {
    body: data.body || 'Open FloodGuard to review this update.',
    icon: '/floodguard-mark.svg',
    badge: '/floodguard-mark.svg',
    tag: data.tag || 'floodguard-status',
    data: { url: data.url || '/app' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/app';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return clients.openWindow(target);
  }));
});
