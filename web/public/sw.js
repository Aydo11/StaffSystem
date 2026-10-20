// App-shell service worker. It never caches /api responses or uploaded files, so no HR, finance or
// personal records are stored offline. A new version activates on the next visit; nothing in progress is lost
// because visits, drafts and timers live on the server (drafts in the page's own storage).
const SHELL = 'hub-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  if (e.request.mode === 'navigate') {
    // Network first for pages, falling back to the cached shell when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Hashed build assets never change, so cache-first is safe.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
});
