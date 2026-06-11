const CACHE_VERSION = 'companion-scan-v1'
const APP_SHELL = [
  '/',
  '/index.html',
  '/scanner.html',
  '/viewer.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/xr.js',
  '/xr-slam.js',
]

const API_PREFIXES = [
  '/health',
  '/infer',
  '/upload-scan',
  '/upload-summary',
  '/process-scan',
  '/projects',
  '/worlds',
  '/scans',
  '/scan-locations',
  '/rtc-signal',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_VERSION)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
    return
  }

  if (request.mode === 'navigate') {
    const fallback = url.pathname.endsWith('/viewer.html') ? '/viewer.html' : '/index.html'
    event.respondWith(networkFirst(request, fallback))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(CACHE_VERSION)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    return (await cache.match(request))
      ?? (await cache.match(fallbackPath))
      ?? Response.error()
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION)
  const cached = await cache.match(request)
  const fresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone())
    return response
  }).catch(() => null)

  return cached ?? (await fresh) ?? Response.error()
}
