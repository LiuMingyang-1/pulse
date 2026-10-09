// Pulse service worker — bump CACHE_VERSION to invalidate old caches.
const CACHE_VERSION = 'pulse-v7';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Never cache API responses — always network.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for hashed static assets and icons/manifest.
  if (url.pathname.startsWith('/_astro/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, clone));
        }
        return res;
      })),
    );
    return;
  }

  // Network-first for HTML; fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  );
});
