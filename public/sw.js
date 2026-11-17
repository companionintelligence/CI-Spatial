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
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/webxr.html',
  '/smoke.html',
  '/xr.js',
  '/xr-slam.js',
]

// Every server path a page reads with GET. A path missing here falls through to
// staleWhileRevalidate, which answers from the cache first and only overwrites an
// entry on a 2xx, so one bad 200 is served for good.
const API_PREFIXES = [
  '/health',
  '/capabilities', // GET /capabilities?versions=0: the maps read their tile source from it, and a stale one would outlive a change
  '/memory',
  '/authenticate',
  '/project-locations',
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

// wave 05 ticket 0002 (docs/factory/05-on-device-inference/0002-browser-model-provisioning.md):
// src/inference/model-provisioning.ts fetches the ~2.2 GB LFM2.5-VL model
// files from here with resumable `Range` requests. Excluded from this
// worker's fetch handling entirely (not routed into staleWhileRevalidate,
// not added to any cache below) for two reasons: (1) the Cache API's
// `put()` rejects a 206 Partial Content response — every resumed chunk
// would throw — and (2) `cache.match()` doesn't distinguish a plain GET
// from a ranged one, so a stale whole-file hit could be served back for a
// request that asked for a specific byte range. Model requests fall through
// to the browser's normal networking untouched; model-provisioning.ts keeps
// its own verified copy in IndexedDB. Additive only, per CLAUDE.md's "Do not
// rename" — CACHE_VERSION and QUEUE_DB above are unchanged.
const MODEL_PATH_PREFIX = '/models/'

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
// Oldest-first alone dropped the wrong thing. A Place write (the frame a
// calibration just made, a rename) is the oldest write of an offline session and
// every capture after it is one more autosaved scan, so about 22 captures pushed
// the calibration out first. Writes to /projects are therefore marked durable
// (see DURABLE_QUEUE_KINDS) and are evicted only when nothing else is left to.
//
// The bound is count + age, not bytes. Measuring bytes means reading every
// queued body into memory to add them up, which is the allocation this cap
// exists to prevent; the item cap is deliberately low enough to stand in for
// it. See the ticket note in the PR for a size-indexed alternative.
const MAX_QUEUE_ITEMS = 24
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000
/** Replay attempts before a request is given up on and dropped. */
const MAX_FLUSH_ATTEMPTS = 5

/**
 * Statuses below 500 a later replay could still answer differently, so the
 * queued body is kept and the failure counted as an attempt.
 *
 * The flush used to delete on any status under 500, which meant an expired
 * world token (401), a token the client re-mints on its next load (403), a
 * request timeout (408) or a rate limit (429) permanently destroyed a scan the
 * user had been told was saved and would sync. Everything else under 500 is a
 * genuine rejection — replaying the same bytes gets the same answer — including
 * 413, which no retry can shrink.
 */
const RETRIABLE_FLUSH_STATUSES = [401, 403, 408, 429]

const QUEUEABLE_WRITE_PREFIXES = [
  '/upload-scan',
  '/sessions',
  '/worlds',
  '/projects',
  '/process-scan',
  '/upload-summary',
]

// What a queued write is, by the path it went to. The kind is written into the queue id
// (`<ms>-<kind>-<random>`), so pruneQueue can tell a Place change from a scan upload from the keys
// alone, without loading a body (see pruneQueue). An id made before kinds were recorded is
// `<ms>-<random>`: it reads as 'other' and is not durable, and it is still flushed like any other.
// The queue database, its store and its version are unchanged (CLAUDE.md, "Do not rename"): an older
// worker that still holds a queue opened at version 1 keeps working on a queue this one wrote to.
const QUEUE_KIND_PREFIXES = [
  ['/projects', 'place'],
  ['/upload-scan', 'scan'],
  ['/upload-summary', 'summary'],
  ['/sessions', 'session'],
  ['/worlds', 'world'],
  ['/process-scan', 'process'],
]

// How a kind reads in the notice that says it was dropped: [one, many].
const QUEUE_KIND_NAMES = {
  place: ['Place change', 'Place changes'],
  scan: ['scan upload', 'scan uploads'],
  summary: ['scan summary', 'scan summaries'],
  session: ['keyframe upload', 'keyframe uploads'],
  world: ['editor change', 'editor changes'],
  process: ['processing request', 'processing requests'],
  other: ['queued upload', 'queued uploads'],
}

// The kinds pruneQueue evicts last. Only a write to a Place qualifies: it carries the one reference
// a Place keeps (its frame), and a later scan upload does not supersede it.
const DURABLE_QUEUE_KINDS = ['place']

// A page that must be told "not now" when it is offline, rather than have a write kept and replayed
// later, sends this header with the value '1'. Two writes do: creating a Place or an Area, where a queued
// write would make the Place after the person was told it was not made; and a Place's frame, which the
// page keeps in its own database until the server holds it (src/project/frame-sync.ts), so that a second
// calibration replaces the first instead of both being replayed in the order they were queued, and the same
// frame is not queued again each time the page retries. Mirrors NO_QUEUE_HEADER in
// src/shared/offline-queue.ts, and tests/unit/node/sw_offline_queue.test.ts asserts the two agree.
const NO_QUEUE_HEADER = 'X-Companion-No-Queue'

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
  if (url.pathname.startsWith(MODEL_PATH_PREFIX)) return  // see MODEL_PATH_PREFIX above

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
  } else if (event.data?.type === 'dropQueuedKeyframes') {
    // Mirrors DROP_QUEUED_KEYFRAMES_MESSAGE in src/capture/keyframe-consent.ts. The page waits for the count on the
    // port it sends, and treats no answer as "this worker does not know the message".
    const reply = event.ports?.[0]
    event.waitUntil?.(dropQueuedKeyframes().then(
      (count) => reply?.postMessage({ count }),
      () => reply?.postMessage({ count: null }),
    ))
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
  if (request.headers.get(NO_QUEUE_HEADER) === '1') return false
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
  const id = `${Date.now()}-${queueKindOfPath(new URL(request.url).pathname)}-${Math.random().toString(36).slice(2)}`
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

/** The kind of write a path is: see QUEUE_KIND_PREFIXES. */
function queueKindOfPath(pathname) {
  for (const [prefix, kind] of QUEUE_KIND_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return kind
  }
  return 'other'
}

/**
 * The kind recorded in a queue id. Ids are `<ms>-<kind>-<random>`; one made before kinds were
 * recorded is `<ms>-<random>` and is 'other', as is any id whose middle part is not a kind.
 */
function queueKindOfId(id) {
  const parts = String(id).split('-')
  const kind = parts.length === 3 ? parts[1] : 'other'
  return Object.prototype.hasOwnProperty.call(QUEUE_KIND_NAMES, kind) ? kind : 'other'
}

function isDurableQueueId(id) {
  return DURABLE_QUEUE_KINDS.includes(queueKindOfId(id))
}

/** "2 scan uploads and 1 Place change", for the notice that names what was dropped. */
function describeQueueKinds(keys) {
  const counts = new Map()
  for (const key of keys) {
    const kind = queueKindOfId(key)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts = [...counts].map(([kind, count]) => `${count} ${QUEUE_KIND_NAMES[kind][count === 1 ? 0 : 1]}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
}

/**
 * Drop queued requests that are too old or over the item cap, oldest first.
 *
 * Reads keys only. Ids are `${Date.now()}-${kind}-${random}`, so they sort chronologically and carry
 * their own timestamp and kind, which means age, order and durability come for free without
 * deserializing a single body. Loading the bodies to decide what to evict would allocate exactly the
 * memory the cap is here to avoid.
 *
 * Over the cap, writes that are not durable go first, oldest first, and a durable write (a Place
 * change) goes only when nothing else is left. The notice names what was dropped by kind.
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
  const evicted = overflow > 0
    ? [...live.filter((key) => !isDurableQueueId(key)), ...live.filter(isDurableQueueId)].slice(0, overflow)
    : []

  const dropped = [...expired, ...evicted]
  for (const key of dropped) await idbDelete(db, key)

  if (dropped.length > 0) {
    await notifyClients({
      type: 'offline-dropped',
      count: dropped.length,
      expired: expired.length,
      evicted: evicted.length,
      message: `Dropped ${describeQueueKinds(dropped)} — the offline queue is full.`,
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
    // Read into this pass before a person withdrew consent to send it: not replayed (see dropQueuedKeyframes).
    if (droppedQueueIds.delete(item.id)) continue
    // The one request in flight, so that a withdrawal can cancel it (see dropQueuedKeyframes). A scope without
    // AbortController replays as it always did, and a withdrawal then only drops what has not started.
    const control = typeof AbortController === 'function' ? new AbortController() : null
    replayInFlight = { id: item.id, control }
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: new Headers(item.headers),
        body: item.body,
        signal: control?.signal,
      })
      if (response.ok) {
        await idbDelete(db, item.id)
        await notifyClients({ type: 'offline-flushed', queueId: item.id, ok: true, status: response.status })
      } else if (response.status >= 500 || RETRIABLE_FLUSH_STATUSES.includes(response.status)) {
        await recordFailedAttempt(db, item, `${response.status}`)
      } else {
        // Permanent, so the body does go — but under its own message type.
        // 'offline-flushed' reads as a delivered upload everywhere it lands, so
        // reporting a dropped body through it is indistinguishable from success;
        // this notice is the only sign the user gets that the scan is gone.
        await idbDelete(db, item.id)
        await notifyClients({
          type: 'offline-rejected',
          queueId: item.id,
          url: item.url,
          status: response.status,
          message: response.status === 413
            ? 'A queued upload was too large for the server and could not be saved.'
            : `The server rejected a queued upload (${response.status}) — it could not be saved.`,
        })
      }
    } catch (error) {
      await recordFailedAttempt(db, item, error instanceof Error ? error.message : String(error))
    } finally {
      replayInFlight = null
    }
  }
  // Every row this pass read has been replayed, skipped or restored by now: what was dropped while it ran has been dealt
  // with, and what is still remembered would only sit in memory. (A drop after this adds its ids for the next pass.)
  droppedQueueIds.clear()
  db.close()
}

/**
 * Ids of queued uploads that were dropped while a flush that had already read them was running. The flush skips them,
 * and a replay that was in flight when its row was dropped does not put the row back when it fails (recordFailedAttempt).
 * Only this worker's own run remembers them: a worker that has been stopped and started again reads the queue afresh,
 * and the rows are already gone from it.
 */
const droppedQueueIds = new Set()

/** The queued request being replayed right now, with what cancels it (null where the scope cannot cancel), or null. */
let replayInFlight = null

/** Whether a queued request is a camera frame (POST /sessions/<id>/keyframes) or the request that opens a session for them. */
function isKeyframeUpload(item) {
  if (item?.method !== 'POST') return false
  let path
  try {
    path = new URL(item.url).pathname
  } catch {
    return false
  }
  return path === '/sessions' || /^\/sessions\/[^/]+\/keyframes$/.test(path)
}

/**
 * Removes the keyframe uploads from the queue, and resolves with how many there were. Called when a person withdraws
 * consent to send camera frames (src/capture/keyframe-consent.ts), so that frames held for when the phone is back
 * online are not sent after all. Nothing else is touched: the finalize that closes a session carries counts and a
 * filename, not a picture.
 *
 * Only rows that can be a session write are read: a row made since kinds were recorded names its kind in its id, and
 * one made before is 'other', so both are looked at. A scan upload, whose body is the large one, never is.
 */
async function dropQueuedKeyframes() {
  const db = await openQueueDb()
  try {
    let dropped = 0
    for (const key of await idbGetAllKeys(db)) {
      const kind = queueKindOfId(key)
      if (kind !== 'session' && kind !== 'other') continue
      if (!isKeyframeUpload(await idbGet(db, key))) continue
      droppedQueueIds.add(key)
      await idbDelete(db, key)
      dropped += 1
      // A replay in flight is cancelled rather than left to finish: the person said no, and its answer, a failure or a
      // success, must not matter. (A reply that had already come back cannot be taken back.)
      if (replayInFlight?.id === key) replayInFlight.control?.abort()
    }
    return dropped
  } finally {
    db.close()
  }
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
  // The row was dropped while this replay was in flight (a person withdrew consent to send it). Writing it back would
  // resurrect a camera frame the person said not to send, for the next flush to replay.
  if (droppedQueueIds.has(item.id)) return
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

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly')
    const req = tx.objectStore(QUEUE_STORE).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
