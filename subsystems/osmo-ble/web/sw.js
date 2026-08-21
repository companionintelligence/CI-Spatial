// Minimal PWA service worker: network-first (this is a dev tool under active iteration, so
// always prefer the freshest JS), falling back to cache when offline/unreachable — mainly so
// the shell still loads if you're testing on a phone with a flaky connection to this Mac.
const CACHE = 'osmo-ble-v1';
const ASSETS = [
  './',
  './index.html',
  './app.mjs',
  './backend-client.mjs',
  './joystick.mjs',
  './ui.mjs',
  './manifest.json',
  './icon.svg',
  '../protocol/duml.mjs',
  '../protocol/constants.mjs',
  '../protocol/commands.mjs',
  '../protocol/telemetry.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
