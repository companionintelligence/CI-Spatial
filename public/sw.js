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
// Offline-queue bounds. Without these the queue grew without limit: autosave
// exports a full GLB 1.2s after every capture and auto-capture fires every
// 2.5s, so ten minutes offline meant hundreds of multi-MB bodies in IndexedDB.
// When that finally hit quota the write rejected inside networkOrQueue() and
// the page saw a bare network error with nothing to explain it.
//
// Eviction is oldest-first and it is real data loss, so it is announced to
// clients rather than done quietly. Oldest-first is the right side to lose:
// repeated autosaves of a scan supersede each other, so the newest body is
// the one worth keeping.
//
// The bound is count + age, not bytes. Measuring bytes means reading every
// queued body into memory to add them up, which is the allocation this cap
// exists to prevent; the item cap is deliberately low enough to stand in for
// it. See the ticket note in the PR for a size-indexed alternative.
const MAX_QUEUE_ITEMS = 24
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000
/** Replay attempts before a request is given up on and dropped. */
const MAX_FLUSH_ATTEMPTS = 5

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
    let queueId
    try {
      queueId = await queueRequest(request)
    } catch (error) {
      // Storage refused the write — quota, or a broken IndexedDB. Letting this
      // reject would reject event.respondWith() too, and the page would see a
      // bare network error indistinguishable from being offline, having in
      // fact just lost the scan. 507 is not 2xx and carries no queued header,
      // so every caller reads it as the failure it is.
      await notifyClients({
        type: 'offline-queue-failed',
        url: request.url,
        message: 'Could not save this upload for later — device storage is full.',
      })
      return new Response(JSON.stringify({
        ok: false,
        queuedOffline: false,
        error: 'queue-write-failed',
        message: 'Could not save this upload for later — device storage is full.',
        detail: error instanceof Error ? error.message : String(error),
      }), { status: 507, headers: { 'Content-Type': 'application/json' } })
    }
    await registerFlushSync()
    await notifyClients({ type: 'offline-queued', queueId, url: request.url, method: request.method })
    return new Response(JSON.stringify({
      ok: false,
      queuedOffline: true,
      queueId,
      message: 'Saved offline and will retry when the network returns.',
    }), {
      status: 202,
      // 'X-Companion-Queued-Offline' mirrors QUEUED_OFFLINE_HEADER in
      // src/shared/offline-queue.ts. It is the ONLY thing that distinguishes a
      // queued write from a delivered one: this response is 202, so resp.ok is
      // true for it. sync.test.ts asserts the two literals agree.
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
  try {
    await pruneQueue(db)
    await idbPut(db, {
      id,
      url: request.url,
      method: request.method,
      headers,
      body,
      createdAt: Date.now(),
      attempts: 0,
    })
  } finally {
    db.close()
  }
  return id
}

/**
 * Drop queued requests that are too old or over the item cap, oldest first.
 *
 * Reads keys only. Ids are `${Date.now()}-${random}`, so they sort
 * chronologically and carry their own timestamp — which means age and order
 * come for free without deserializing a single body. Loading the bodies to
 * decide what to evict would allocate exactly the memory the cap is here to
 * avoid.
 */
async function pruneQueue(db) {
  const keys = await idbGetAllKeys(db)
  const now = Date.now()
  const expired = []
  const live = []

  for (const key of keys) {
    const createdAt = Number(String(key).split('-')[0])
    if (Number.isFinite(createdAt) && now - createdAt > MAX_QUEUE_AGE_MS) expired.push(key)
    else live.push(key)
  }

  // Leave room for the request about to be written.
  const overflow = live.length - (MAX_QUEUE_ITEMS - 1)
  const evicted = overflow > 0 ? live.slice(0, overflow) : []

  const dropped = [...expired, ...evicted]
  for (const key of dropped) await idbDelete(db, key)

  if (dropped.length > 0) {
    await notifyClients({
      type: 'offline-dropped',
      count: dropped.length,
      expired: expired.length,
      evicted: evicted.length,
      message: `Dropped ${dropped.length} queued upload(s) — the offline queue is full.`,
    })
  }
  return dropped.length
}

/**
 * Serializes flushes. Both the `sync` event and the `flushQueue` message can
 * fire for the same reconnect — src/pwa.ts sends the message and registers the
 * sync on every `online` event and on load — and two concurrent passes read
 * the same rows and replay the same request twice, uploading a scan twice.
 */
let flushInFlight = null

function flushQueuedRequests() {
  flushInFlight ??= runQueueFlush().finally(() => { flushInFlight = null })
  return flushInFlight
}

async function runQueueFlush() {
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
        await recordFailedAttempt(db, item, `${response.status}`)
      }
    } catch (error) {
      await recordFailedAttempt(db, item, error instanceof Error ? error.message : String(error))
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

/**
 * Count a failed replay, and give up once it has failed enough times.
 *
 * `attempts` was incremented here and never read by anything, so a request the
 * server will never accept was retried on every reconnect forever, holding a
 * slot and its bytes against the queue for the life of the install.
 */
async function recordFailedAttempt(db, item, lastError) {
  const attempts = (item.attempts ?? 0) + 1
  if (attempts >= MAX_FLUSH_ATTEMPTS) {
    await idbDelete(db, item.id)
    await notifyClients({
      type: 'offline-gave-up',
      queueId: item.id,
      url: item.url,
      attempts,
      lastError,
      message: `Gave up on a queued upload after ${attempts} attempts.`,
    })
    return
  }
  await idbPut(db, { ...item, attempts, lastError })
}

/** Keys only — no bodies deserialized. See pruneQueue(). */
function idbGetAllKeys(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly')
    const req = tx.objectStore(QUEUE_STORE).getAllKeys()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror = () => reject(req.error)
  })
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
