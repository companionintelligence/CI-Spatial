// NOTE: this is a classic (non-module) service worker, so it cannot import
// src/shared/storage-keys.ts. CACHE_VERSION, QUEUE_DB (below), and the
// 'companion-scan-flush' sync tag (self.addEventListener('sync', ...) and
// registerFlushSync() below) are hand-kept in sync with SW_CACHE_NAME,
// OFFLINE_QUEUE_DB_NAME, and SW_SYNC_TAG in that file; sync.test.ts
// (repo root) asserts they haven't drifted. Do not rename any of them —
// see CLAUDE.md's "Do not rename" registry.
const CACHE_VERSION = 'companion-scan-v3'
const APP_SHELL = [
  '/',
  '/index.html',
  '/scanner.html',
  '/viewer.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/webxr.html',
  '/smoke.html',
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
  '/sessions',
  '/jobs',
  '/events',
  '/client-logs',
]

// Mirrors OFFLINE_QUEUE_DB_NAME in src/shared/storage-keys.ts — see the
// note above CACHE_VERSION.
const QUEUE_DB = 'companion-scan-offline-queue'
const QUEUE_STORE = 'requests'
const QUEUEABLE_WRITE_PREFIXES = [
  '/upload-scan',
  '/sessions',
  '/worlds',
  '/projects',
  '/process-scan',
  '/upload-summary',
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
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.method !== 'GET') {
    if (isQueueableWrite(request, url)) {
      event.respondWith(networkOrQueue(request))
    }
    return
  }
  if (API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
    return
  }

  if (request.mode === 'navigate') {
    const fallback = url.pathname.endsWith('/viewer.html') ? '/viewer.html'
      : url.pathname.endsWith('/webxr.html') ? '/webxr.html'
      : '/index.html'
    event.respondWith(networkFirst(request, fallback))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

self.addEventListener('sync', (event) => {
  // 'companion-scan-flush' mirrors SW_SYNC_TAG in src/shared/storage-keys.ts
  // and src/pwa.ts's registration call — see the note above CACHE_VERSION.
  if (event.tag === 'companion-scan-flush') {
    event.waitUntil(flushQueuedRequests())
  }
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'flushQueue') {
    event.waitUntil?.(flushQueuedRequests())
  }
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

function isQueueableWrite(request, url) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return false
  if (url.pathname === '/infer') return false
  return QUEUEABLE_WRITE_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
}

async function networkOrQueue(request) {
  try {
    return await fetch(request.clone())
  } catch {
    const queueId = await queueRequest(request)
    await registerFlushSync()
    await notifyClients({ type: 'offline-queued', queueId, url: request.url, method: request.method })
    return new Response(JSON.stringify({
      ok: false,
      queuedOffline: true,
      queueId,
      message: 'Saved offline and will retry when the network returns.',
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'X-Companion-Queued-Offline': '1' },
    })
  }
}

async function queueRequest(request) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const body = await request.clone().arrayBuffer()
  const headers = Array.from(request.headers.entries())
    .filter(([name]) => !['content-length', 'host'].includes(name.toLowerCase()))
  const db = await openQueueDb()
  await idbPut(db, {
    id,
    url: request.url,
    method: request.method,
    headers,
    body,
    createdAt: Date.now(),
    attempts: 0,
  })
  db.close()
  return id
}

async function flushQueuedRequests() {
  const db = await openQueueDb()
  const items = await idbGetAll(db)
  for (const item of items) {
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: new Headers(item.headers),
        body: item.body,
      })
      if (response.ok || response.status < 500) {
        await idbDelete(db, item.id)
        await notifyClients({ type: 'offline-flushed', queueId: item.id, ok: response.ok, status: response.status })
      } else {
        item.attempts = (item.attempts ?? 0) + 1
        item.lastError = `${response.status}`
        await idbPut(db, item)
      }
    } catch (error) {
      item.attempts = (item.attempts ?? 0) + 1
      item.lastError = error instanceof Error ? error.message : String(error)
      await idbPut(db, item)
    }
  }
  db.close()
}

async function registerFlushSync() {
  try {
    if ('sync' in self.registration) {
      // 'companion-scan-flush' mirrors SW_SYNC_TAG in
      // src/shared/storage-keys.ts — see the note above CACHE_VERSION.
      await self.registration.sync.register('companion-scan-flush')
    }
  } catch {
    // Background Sync is optional on Safari; the page also asks us to flush on online.
  }
}

async function notifyClients(message) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const client of clientsList) client.postMessage(message)
}

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    tx.objectStore(QUEUE_STORE).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly')
    const req = tx.objectStore(QUEUE_STORE).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    tx.objectStore(QUEUE_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
