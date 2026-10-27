// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Keeps the app shell available offline and fast to open. API calls and map tiles always go to the network.
const CACHE = 'a2b-v33';
const SHELL = ['/', '/styles.css', '/app.js', '/core.js', '/panels.js', '/nav.js', '/motion.js', '/voice.js', '/vehicle3d.js', '/geo.js', '/icons.js', '/report-types.js', '/map-themes.js', '/places.js', '/text.js', '/sheet-drag.js', '/follow.js', '/presence.js', '/welcome.js', '/update.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Place data is versioned and kept by the browser's own cache; keeping it here too would only grow.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/places/') || url.pathname === '/version.json') return;
  // Network first so new deploys show up straight away; the cache is the fallback when offline.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
