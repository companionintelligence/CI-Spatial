/**
 * The service worker's offline queue policy (public/sw.js): which writes are
 * queued, how many are kept and for how long, which replay failures keep a body,
 * which writes are kept longest, what a dropped write is called, and what the
 * installed app can show without a network.
 *
 * The rules are read straight from the script. The queue itself is driven too, in the
 * second half of the file, against a small in-memory stand-in for the worker's
 * IndexedDB (only the calls sw.js makes), so `queueRequest`, `pruneQueue` and the
 * flush run as written. tests/mock-offline-queue.spec.ts covers the real browser.
 *
 * Run: npm run test:sw-queue
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Runs public/sw.js as a classic script in a sandbox with a stub service worker
 * scope. Its top level only registers event listeners and sets constants, so no
 * event fires here, and the rules are read straight from the context.
 */
function loadServiceWorker(): vm.Context {
  const context = vm.createContext({
    self: { addEventListener() {} },
    Request,
    Response,
    URL,
    Headers,
  })
  vm.runInContext(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), context, { filename: 'public/sw.js' })
  return context
}

const sw = loadServiceWorker()
const read = <T>(expression: string) => vm.runInContext(expression, sw) as T
const isQueueableWrite = read<(request: Request, url: URL) => boolean>('isQueueableWrite')

function queued(method: string, path: string) {
  const url = new URL(`https://scan.test${path}`)
  return isQueueableWrite(new Request(url, { method }), url)
}

test('the queue keeps at most 24 writes, for a day, and replays each one at most five times', () => {
  assert.equal(read<number>('MAX_QUEUE_ITEMS'), 24)
  assert.equal(read<number>('MAX_QUEUE_AGE_MS'), 24 * 60 * 60 * 1000)
  assert.equal(read<number>('MAX_FLUSH_ATTEMPTS'), 5)
})

test('a replay that fails with 401, 403, 408 or 429 keeps the body; other statuses under 500 drop it', () => {
  assert.deepEqual([...read<number[]>('RETRIABLE_FLUSH_STATUSES')], [401, 403, 408, 429])
})

test('writes to the scan routes are queued, and reads and inference never are', () => {
  assert.equal(queued('POST', '/upload-scan'), true)
  assert.equal(queued('PUT', '/worlds/default/pins'), true)
  assert.equal(queued('PATCH', '/projects/p1'), true)
  assert.equal(queued('POST', '/sessions/s1/keyframes'), true)
  assert.equal(queued('GET', '/upload-scan'), false, 'a read has nothing to replay')
  assert.equal(queued('POST', '/infer'), false, 'the caller is waiting for the answer')
})

test('the queue matches whole path segments, so a longer route is not swept in', () => {
  assert.equal(queued('POST', '/upload-scanner'), false)
  assert.equal(queued('POST', '/worldsX/pins'), false)
})

test('every icon in the manifest is precached, so the installed app shows it offline', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public/manifest.json'), 'utf8')) as { icons: Array<{ src: string }> }
  const shell = [...read<string[]>('APP_SHELL')]
  for (const icon of manifest.icons) assert.ok(shell.includes(icon.src), `${icon.src} is not in APP_SHELL`)
  assert.ok(shell.includes('/apple-touch-icon.png'), 'iOS fetches the apple touch icon when the app is added to the home screen')
})

// ── The queue, driven ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
type Notice = Record<string, unknown> & { type: string; message?: string }

interface Queue {
  /** The worker's own scope, for calling its functions. */
  call<T>(expression: string): T
  /** What the queue database holds now, oldest key first. */
  rows(): Row[]
  /** Everything the worker told the page, in order. */
  notices: Notice[]
  /** What `indexedDB.open` was asked for. */
  opens: Array<{ name: string; version: number | undefined }>
  /** The worker's clock, which the test moves. */
  setNow(ms: number): void
  /** What a fetch from the worker does: answer, or fail as an offline one does. */
  setFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void
  /** The writes the worker made to the network, in order. */
  sent: Array<{ url: string; method: string }>
  seed(row: Row): void
  /** Delivers a message to the worker as a page's postMessage does. Resolves when the worker has finished with it. */
  message(data: unknown, port?: { postMessage(message: unknown): void }): Promise<void>
}

const OFFLINE = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch')
}

/**
 * The worker with a queue it can really write to. The fake keeps the semantics sw.js leans on: a request
 * reports on a later task, keys come back in ascending order, and a write completes its transaction.
 */
function loadQueue(opts: { abortControllerInScope?: boolean } = {}): Queue {
  const stores = new Map<string, Map<string, Row>>()
  const notices: Notice[] = []
  const sent: Array<{ url: string; method: string }> = []
  const opens: Array<{ name: string; version: number | undefined }> = []
  let now = Date.UTC(2026, 10, 16, 9, 0, 0)
  let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = OFFLINE

  const later = (fn: () => void) => setTimeout(fn, 0)
  const request = <T>(result: () => T) => {
    const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {}
    later(() => {
      req.result = result()
      req.onsuccess?.()
    })
    return req
  }

  function storeApi(rows: Map<string, Row>, tx: { oncomplete?: () => void }) {
    const finish = () => later(() => tx.oncomplete?.())
    return {
      put: (row: Row) => {
        rows.set(row.id, structuredClone(row))
        finish()
      },
      delete: (key: string) => {
        rows.delete(key)
        finish()
      },
      getAll: () => request(() => [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => structuredClone(row))),
      getAllKeys: () => request(() => [...rows.keys()].sort()),
      get: (key: string) => request(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
    }
  }

  const indexedDB = {
    open(name: string, version?: number) {
      opens.push({ name, version })
      const open: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {}
      const db = {
        objectStoreNames: { contains: (store: string) => stores.has(store) },
        createObjectStore: (store: string) => {
          stores.set(store, new Map())
        },
        transaction: (store: string) => {
          const tx: { oncomplete?: () => void; onerror?: () => void; objectStore?: (name: string) => unknown } = {}
          tx.objectStore = () => storeApi(stores.get(store)!, tx)
          return tx
        },
        close: () => {},
      }
      open.result = db
      later(() => {
        open.onupgradeneeded?.()
        open.onsuccess?.()
      })
      return open
    },
  }

  const clients = {
    matchAll: async () => [{ postMessage: (message: Notice) => notices.push(message) }],
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const context = vm.createContext({
    self: { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener), clients, registration: {} },
    indexedDB,
    fetch: (url: string | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.url
      sent.push({ url: target, method: init?.method ?? (typeof url === 'string' ? 'GET' : url.method) })
      return fetchImpl(target, init)
    },
    Request,
    Response,
    URL,
    Headers,
    ...(opts.abortControllerInScope === false ? {} : { AbortController }),
  })
  vm.runInContext(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), context, { filename: 'public/sw.js' })
  // The worker reads the clock as Date.now(); the test moves it so ids carry the order the writes were made in.
  context['__now'] = () => now
  vm.runInContext('Date.now = __now', context)
  // Make the queue's one store exist, as the first open's upgrade does.
  stores.set('requests', new Map())

  return {
    call: <T>(expression: string) => vm.runInContext(expression, context) as T,
    rows: () => [...(stores.get('requests') ?? new Map<string, Row>()).values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    notices,
    opens,
    setNow: (ms) => {
      now = ms
    },
    setFetch: (fn) => {
      fetchImpl = fn
    },
    sent,
    seed: (row) => {
      stores.get('requests')!.set(row.id, row)
    },
    message: async (data, port) => {
      const waiting: Array<Promise<unknown>> = []
      listeners.get('message')!({ data, ports: port ? [port] : [], waitUntil: (work: Promise<unknown>) => waiting.push(work) })
      await Promise.all(waiting)
    },
  }
}

const SCAN = (n: number) => new Request(`https://scan.test/upload-scan`, { method: 'POST', body: `scan-${n}` })
const PLACE = (path = '/projects/proj-1/spatial-frame', method = 'PUT') =>
  new Request(`https://scan.test${path}`, { method, body: JSON.stringify({ frame: {}, expectedRevision: 0 }) })

/** Queues `request` as a page's write would be: a fetch that fails, then the worker's own queue. */
async function offlineWrite(queue: Queue, request: Request, atMs: number): Promise<Response> {
  queue.setNow(atMs)
  const networkOrQueue = queue.call<(request: Request) => Promise<Response>>('networkOrQueue')
  return await networkOrQueue(request)
}

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0)
const kindsOf = (rows: Row[]) => rows.map((row) => row.id.split('-')[1])
const lastDrop = (queue: Queue) => queue.notices.filter((notice) => notice.type === 'offline-dropped').at(-1)

test('a queued write is answered 202 with the queued header, as every caller expects', async () => {
  const queue = loadQueue()
  const reply = await offlineWrite(queue, PLACE(), T0)
  assert.equal(reply.status, 202)
  assert.equal(reply.headers.get(QUEUED_OFFLINE_HEADER), '1')
  assert.equal(queue.rows().length, 1)
})

test('each queued write carries what it is in its id, and ids made before that are still read', () => {
  const queue = loadQueue()
  const kindOfPath = queue.call<(path: string) => string>('queueKindOfPath')
  const kindOfId = queue.call<(id: string) => string>('queueKindOfId')
  assert.equal(kindOfPath('/projects'), 'place')
  assert.equal(kindOfPath('/projects/proj-1'), 'place')
  assert.equal(kindOfPath('/projects/proj-1/spatial-frame'), 'place')
  assert.equal(kindOfPath('/projects/proj-1/reference-photos'), 'place')
  assert.equal(kindOfPath('/upload-scan'), 'scan')
  assert.equal(kindOfPath('/upload-summary'), 'summary')
  assert.equal(kindOfPath('/sessions/s1/keyframes'), 'session')
  assert.equal(kindOfPath('/worlds/default/pins'), 'world')
  assert.equal(kindOfPath('/process-scan'), 'process')
  assert.equal(kindOfPath('/projectsX'), 'other', 'whole path segments, as the queue matches them')

  assert.equal(kindOfId('1700000000000-place-abc123'), 'place')
  assert.equal(kindOfId('1700000000000-scan-abc123'), 'scan')
  assert.equal(kindOfId('1700000000000-abc123'), 'other', 'an id from before kinds were recorded')
  assert.equal(kindOfId('1700000000000-constructor-abc'), 'other', 'a middle part that is not a kind')
  assert.equal(kindOfId('1700000000000-place-abc-def'), 'other', 'an id that is not three parts')
  assert.equal(kindOfId(''), 'other')
})

test('a /projects write survives thirty queued scan writes, and it is the scans that are dropped, oldest first', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, PLACE(), T0)
  for (let n = 0; n < 30; n++) await offlineWrite(queue, SCAN(n), T0 + (n + 1) * 1000)

  const rows = queue.rows()
  assert.equal(rows.length, 24, 'the cap holds')
  assert.equal(kindsOf(rows).filter((kind) => kind === 'place').length, 1, 'the Place write is still queued')
  assert.equal(kindsOf(rows).filter((kind) => kind === 'scan').length, 23)
  // The write that is kept is the Place's, and the scans kept are the 23 newest: 7 of the 30 were dropped, oldest first.
  const kept = rows.filter((row) => row.id.includes('-scan-')).map((row) => new TextDecoder().decode(row.body as ArrayBuffer))
  assert.deepEqual(kept, Array.from({ length: 23 }, (_, i) => `scan-${i + 7}`))

  const drops = queue.notices.filter((notice) => notice.type === 'offline-dropped')
  assert.equal(drops.length, 7, 'every eviction is announced')
  for (const drop of drops) assert.equal(drop.message, 'Dropped 1 scan upload — the offline queue is full.')
})

test('a Place change is dropped only when nothing else is left to drop, oldest first, and the notice says what it was', async () => {
  const queue = loadQueue()
  for (let n = 0; n < 24; n++) await offlineWrite(queue, PLACE(`/projects/proj-${n}/spatial-frame`), T0 + n * 1000)
  assert.equal(queue.rows().length, 24)
  assert.equal(queue.notices.filter((notice) => notice.type === 'offline-dropped').length, 0)

  await offlineWrite(queue, PLACE('/projects/proj-new/spatial-frame'), T0 + 24 * 1000)
  const rows = queue.rows()
  assert.equal(rows.length, 24)
  assert.equal(queue.rows().some((row) => row.url === 'https://scan.test/projects/proj-0/spatial-frame'), false, 'the oldest Place change went')
  assert.equal(queue.rows().some((row) => row.url === 'https://scan.test/projects/proj-new/spatial-frame'), true)
  const drop = queue.notices.filter((notice) => notice.type === 'offline-dropped')
  assert.equal(drop.length, 1)
  assert.equal(drop[0]!.message, 'Dropped 1 Place change — the offline queue is full.')
})

test('a scan is dropped before a Place change even when the Place change is newer', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, SCAN(0), T0)
  for (let n = 0; n < 23; n++) await offlineWrite(queue, PLACE(`/projects/proj-${n}`), T0 + (n + 1) * 1000)
  assert.equal(queue.rows().length, 24)

  await offlineWrite(queue, PLACE('/projects/proj-last'), T0 + 24 * 1000)
  assert.equal(kindsOf(queue.rows()).filter((kind) => kind === 'scan').length, 0, 'the scan went, though it was the oldest only by a second')
  assert.equal(kindsOf(queue.rows()).filter((kind) => kind === 'place').length, 24)
  assert.equal(lastDrop(queue)!.message, 'Dropped 1 scan upload — the offline queue is full.')
})

test('the notice names every kind that went, and counts them', async () => {
  const queue = loadQueue()
  const DAY = 24 * 60 * 60 * 1000
  // Writes more than a day old are dropped whatever they are: a scan, two Place changes, a summary, and one made
  // before kinds were recorded.
  queue.seed({ id: `${T0 - 3 * DAY}-scan-aaaa`, url: 'https://scan.test/upload-scan', method: 'POST' })
  queue.seed({ id: `${T0 - 3 * DAY + 1}-place-bbbb`, url: 'https://scan.test/projects/p1', method: 'PUT' })
  queue.seed({ id: `${T0 - 3 * DAY + 2}-place-cccc`, url: 'https://scan.test/projects/p2', method: 'PUT' })
  queue.seed({ id: `${T0 - 3 * DAY + 3}-summary-dddd`, url: 'https://scan.test/upload-summary', method: 'POST' })
  queue.seed({ id: `${T0 - 3 * DAY + 4}-eeee`, url: 'https://scan.test/upload-scan', method: 'POST' })
  await offlineWrite(queue, SCAN(0), T0)

  const drop = queue.notices.find((notice) => notice.type === 'offline-dropped')!
  assert.equal(drop.message, 'Dropped 1 scan upload, 2 Place changes, 1 scan summary and 1 queued upload — the offline queue is full.')
  assert.equal(drop['count'], 5)
  assert.equal(drop['expired'], 5)
  assert.equal(queue.rows().length, 1, 'only the write just made is left')
})

test('the notice reads each kind as one and as many: scan uploads, keyframe uploads, scan summaries, editor changes, processing requests, Place changes and queued uploads', async () => {
  const DAY = 24 * 60 * 60 * 1000
  const kinds: Array<[string, string, string, string]> = [
    ['scan', '/upload-scan', 'scan upload', 'scan uploads'],
    ['session', '/sessions/s1/keyframes', 'keyframe upload', 'keyframe uploads'],
    ['summary', '/upload-summary', 'scan summary', 'scan summaries'],
    ['world', '/worlds/w1/edit', 'editor change', 'editor changes'],
    ['process', '/process-scan', 'processing request', 'processing requests'],
    ['place', '/projects/p1', 'Place change', 'Place changes'],
  ]
  for (const [kind, path, one, many] of kinds) {
    for (const [count, name] of [[1, one], [2, many]] as const) {
      const queue = loadQueue()
      for (let n = 0; n < count; n++) queue.seed({ id: `${T0 - 3 * DAY + n}-${kind}-a${n}`, url: `https://scan.test${path}`, method: 'PUT' })
      await offlineWrite(queue, SCAN(0), T0)
      const drop = queue.notices.find((notice) => notice.type === 'offline-dropped')!
      assert.equal(drop.message, `Dropped ${count} ${name} — the offline queue is full.`, `${kind} x${count}`)
    }
  }
  // A write made before kinds were recorded is only a queued upload.
  for (const [count, name] of [[1, 'queued upload'], [3, 'queued uploads']] as const) {
    const queue = loadQueue()
    for (let n = 0; n < count; n++) queue.seed({ id: `${T0 - 3 * DAY + n}-old${n}`, url: 'https://scan.test/upload-scan', method: 'POST' })
    await offlineWrite(queue, SCAN(0), T0)
    const drop = queue.notices.find((notice) => notice.type === 'offline-dropped')!
    assert.equal(drop.message, `Dropped ${count} ${name} — the offline queue is full.`)
  }
})

test('a queue written by the worker before kinds were recorded is still pruned and still flushed', async () => {
  const queue = loadQueue()
  // 24 writes in the old id form, as an older worker left them.
  for (let n = 0; n < 24; n++) {
    queue.seed({ id: `${T0 + n}-q${n}x`, url: `https://scan.test/upload-scan?n=${n}`, method: 'POST', headers: [], body: new ArrayBuffer(1), createdAt: T0 + n, attempts: 0 })
  }
  await offlineWrite(queue, PLACE(), T0 + 5000)
  assert.equal(queue.rows().length, 24)
  assert.equal(queue.rows().some((row) => row.id === `${T0}-q0x`), false, 'the oldest old-form write is the one dropped')
  assert.equal(lastDrop(queue)!.message, 'Dropped 1 queued upload — the offline queue is full.')

  // And every one of them replays: the flush does not read the id's shape.
  queue.sent.length = 0
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.equal(queue.rows().length, 0, 'all replayed and removed')
  assert.equal(queue.sent.length, 24)
  assert.equal(queue.notices.filter((notice) => notice.type === 'offline-flushed').length, 24)
})

test('a Place write queued offline replays to the server it was meant for, with the body it had', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, PLACE('/projects/proj-9/spatial-frame'), T0)
  const [row] = queue.rows()
  assert.equal(row!.method, 'PUT')
  assert.equal(row!.url, 'https://scan.test/projects/proj-9/spatial-frame')
  assert.equal(new TextDecoder().decode(row!.body as ArrayBuffer), JSON.stringify({ frame: {}, expectedRevision: 0 }))

  const sent: string[] = []
  queue.setFetch(async (url, init) => {
    sent.push(`${init?.method} ${url}`)
    return new Response('{}', { status: 200 })
  })
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.deepEqual(sent, ['PUT https://scan.test/projects/proj-9/spatial-frame'])
  assert.equal(queue.rows().length, 0)
})

test('the queue database is opened at the version it always was, under the name it always had', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, PLACE(), T0)
  assert.ok(queue.opens.length > 0)
  for (const open of queue.opens) assert.deepEqual(open, { name: 'companion-scan-offline-queue', version: 1 }, 'a bump would lock an older worker out of its own queue')
  assert.equal(queue.call<string>('QUEUE_STORE'), 'requests')
})

// ── The opt-out ──────────────────────────────────────────────────────────────────────────────────

test('a write that asks not to be queued is not one the worker takes over', () => {
  const url = new URL('https://scan.test/projects')
  const asking = new Request(url, { method: 'POST', headers: { [NO_QUEUE_HEADER]: '1' } })
  assert.equal(isQueueableWrite(asking, url), false, 'it fails at once when offline, instead of being answered 202')
  const plain = new Request(url, { method: 'POST' })
  assert.equal(isQueueableWrite(plain, url), true, 'and one that does not ask is queued as before')
  const other = new Request(url, { method: 'POST', headers: { [NO_QUEUE_HEADER]: '0' } })
  assert.equal(isQueueableWrite(other, url), true, 'only the value 1 asks')
  // A Place's frame: the page keeps it in its own database until the server has it, and says so with the header. A
  // page from before that did not, and its write is queued as any Place write is.
  const frame = new URL('https://scan.test/projects/proj-1/spatial-frame')
  assert.equal(isQueueableWrite(new Request(frame, { method: 'PUT', headers: { [NO_QUEUE_HEADER]: '1' } }), frame), false, 'the page\'s frame write fails at once offline, and is retried from the page')
  assert.equal(isQueueableWrite(new Request(frame, { method: 'PUT' }), frame), true, 'a write that does not ask is still a queued Place write')
  const photo = new URL('https://scan.test/projects/proj-1/reference-photos')
  assert.equal(isQueueableWrite(new Request(photo, { method: 'POST' }), photo), true, 'the photos that follow a saved frame are queued if the link drops, and replayed')
})

test('the opt-out header is spelled the same in the worker and in src/shared/offline-queue.ts', () => {
  assert.equal(read<string>('NO_QUEUE_HEADER'), NO_QUEUE_HEADER)
  assert.match(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), new RegExp(`'${NO_QUEUE_HEADER}'`))
})

// ── Withdrawing consent to send camera frames ────────────────────────────────────────────────────
// src/capture/keyframe-consent.ts: turning "Send camera frames" off stops sending at once, and a frame that is waiting
// in this queue for the phone to be back online is sending too. The worker removes them, and a flush that had already
// read the queue does not send them after all.

const FRAME = (n: number, session = 'sess-aaaa') =>
  new Request(`https://scan.test/sessions/${session}/keyframes`, { method: 'POST', body: `frame-${n}` })
const OPEN_SESSION = () => new Request('https://scan.test/sessions', { method: 'POST', body: '{}' })
const FINALIZE = (session = 'sess-aaaa') =>
  new Request(`https://scan.test/sessions/${session}/finalize`, { method: 'POST', body: '{"glbFilename":"a.glb"}' })

test('dropping queued keyframes removes the camera frames and the session opens that made room for them, and only those', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  await offlineWrite(queue, OPEN_SESSION(), T0 + 1000)
  await offlineWrite(queue, FRAME(1, 'sess-bbbb'), T0 + 2000)
  await offlineWrite(queue, FINALIZE(), T0 + 3000)
  await offlineWrite(queue, SCAN(0), T0 + 4000)
  await offlineWrite(queue, PLACE(), T0 + 5000)
  assert.equal(queue.rows().length, 6)

  const dropped = await queue.call<() => Promise<number>>('dropQueuedKeyframes')()
  assert.equal(dropped, 3, 'two frames and one session open')
  const left = queue.rows().map((row) => `${row.method} ${new URL(row.url as string).pathname}`)
  assert.deepEqual(left, ['POST /sessions/sess-aaaa/finalize', 'POST /upload-scan', 'PUT /projects/proj-1/spatial-frame'],
    'the finalize carries counts and a filename and no picture, and a scan or a Place is not a camera frame')
})

test('a frame queued by a worker from before kinds were recorded is dropped too, and an unrelated old row is kept', async () => {
  const queue = loadQueue()
  queue.seed({ id: `${T0}-abcd`, url: 'https://scan.test/sessions/sess-old/keyframes', method: 'POST' })
  queue.seed({ id: `${T0 + 1}-efgh`, url: 'https://scan.test/upload-summary', method: 'POST' })
  queue.seed({ id: `${T0 + 2}-ijkl`, url: 'https://scan.test/sessions/sess-old/keyframes', method: 'PUT' })
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1, 'a PUT is not a camera frame')
  assert.deepEqual(queue.rows().map((row) => row.id), [`${T0 + 1}-efgh`, `${T0 + 2}-ijkl`])
})

test('dropping reads only the rows that can be session writes, so a queued scan body is never loaded', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, SCAN(0), T0)
  await offlineWrite(queue, PLACE(), T0 + 500)
  await offlineWrite(queue, FRAME(0), T0 + 1000)
  queue.call('globalThis.__read = []; { const original = idbGet; idbGet = (db, id) => { __read.push(id); return original(db, id) } }')
  await queue.call<() => Promise<number>>('dropQueuedKeyframes')()
  // Compared by value: the array was made inside the worker's own realm.
  const read = [...queue.call<string[]>('__read')].map((id) => id.split('-')[1])
  assert.deepEqual(read, ['session'], 'the scan and the Place change were not read')
})

test('a flush that had already read the queue does not send a frame that was dropped while it ran', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, PLACE('/projects/proj-1/spatial-frame'), T0)
  await offlineWrite(queue, FRAME(0), T0 + 1000)
  await offlineWrite(queue, PLACE('/projects/proj-2/spatial-frame'), T0 + 2000)

  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  queue.sent.length = 0
  queue.setFetch(async () => {
    if (first) {
      first = false
      await held
    }
    return new Response('{}', { status: 200 })
  })

  const flushing = queue.call<() => Promise<void>>('runQueueFlush')()
  // The flush has read all three rows and is waiting on the first. The person turns sending off.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1)
  release()
  await flushing

  assert.deepEqual(queue.sent.map((request) => request.url), [
    'https://scan.test/projects/proj-1/spatial-frame',
    'https://scan.test/projects/proj-2/spatial-frame',
  ], 'the camera frame was never sent')
  assert.equal(queue.rows().length, 0)
})

/** Runs `work`, and says whether it settled within `ms`: a replay that was not cancelled would never settle. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
}

test('a frame being replayed when sending is withdrawn, and whose replay then fails, is not put back for a later flush', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  let failInFlight!: (error: unknown) => void
  queue.sent.length = 0
  queue.setFetch(() => new Promise<Response>((_resolve, reject) => {
    failInFlight = reject
  }))
  const flushing = queue.call<() => Promise<void>>('runQueueFlush')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1, 'the frame in flight is one of the frames dropped')
  failInFlight(new TypeError('Failed to fetch'))
  await flushing
  assert.equal(queue.rows().length, 0, 'the failed replay did not write the row back: that would resurrect a frame the person said not to send')

  queue.sent.length = 0
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.call<() => Promise<void>>('runQueueFlush')()
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.equal(queue.sent.filter((request) => request.url.endsWith('/keyframes')).length, 0, 'no camera frame is sent after the withdrawal')
})

test('the same when the replay in flight is answered 503, which would otherwise be kept for another try', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  let answerInFlight!: (response: Response) => void
  queue.sent.length = 0
  queue.setFetch(() => new Promise<Response>((resolve) => {
    answerInFlight = resolve
  }))
  const flushing = queue.call<() => Promise<void>>('runQueueFlush')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await queue.call<() => Promise<number>>('dropQueuedKeyframes')()
  answerInFlight(new Response('busy', { status: 503 }))
  await flushing
  assert.equal(queue.rows().length, 0, 'a 503 would normally keep the row for the next flush; this one was withdrawn')
  queue.sent.length = 0
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.equal(queue.sent.length, 0)
})

test('a withdrawal cancels the replay in flight instead of leaving it to finish, and does not cancel one that is not a camera frame', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  const cancelled: string[] = []
  queue.setFetch((url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      cancelled.push(url)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  }))
  const flushing = queue.call<() => Promise<void>>('runQueueFlush')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1)
  assert.equal(await settlesWithin(flushing, 500), true, 'the flush ended, so the replay in flight was cancelled and not waited for')
  assert.deepEqual(cancelled, ['https://scan.test/sessions/sess-aaaa/keyframes'])
  assert.equal(queue.rows().length, 0)

  // A Place change in flight is not a camera frame: a withdrawal leaves it to finish and be removed as sent, even when it drops a
  // camera frame that is waiting behind it.
  const other = loadQueue()
  await offlineWrite(other, PLACE(), T0)
  await offlineWrite(other, FRAME(0), T0 + 1000)
  other.sent.length = 0 // what the worker tried while it was queueing these is not what the flush sends
  let finish!: () => void
  const aborted: boolean[] = []
  other.setFetch((url, init) => new Promise<Response>((resolve) => {
    if (url.includes('/projects/')) {
      init?.signal?.addEventListener('abort', () => aborted.push(true))
      finish = () => resolve(new Response('{}', { status: 200 }))
    } else {
      resolve(new Response('{}', { status: 200 }))
    }
  }))
  const placing = other.call<() => Promise<void>>('runQueueFlush')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await other.call<() => Promise<number>>('dropQueuedKeyframes')(), 1, 'the camera frame waiting behind the Place change is dropped')
  finish()
  await placing
  assert.deepEqual(aborted, [], 'the Place change was not cancelled: only the replay of a frame that was dropped is')
  assert.equal(other.rows().length, 0, 'it was sent and removed as it always is, and the dropped frame was never sent')
  assert.deepEqual(other.sent.map((request) => request.url), ['https://scan.test/projects/proj-1/spatial-frame'])
})

test('a worker scope with no AbortController still replays the queue and still drops frames: it only cannot cancel one in flight', async () => {
  const queue = loadQueue({ abortControllerInScope: false })
  await offlineWrite(queue, PLACE(), T0)
  await offlineWrite(queue, FRAME(0), T0 + 1000)
  queue.sent.length = 0
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.equal(queue.sent.length, 2, 'the flush replays what is queued, as it always did')
  assert.equal(queue.rows().length, 0)

  queue.setFetch(OFFLINE)
  await offlineWrite(queue, FRAME(1), T0 + 2000)
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1)
  // A replay in flight cannot be cancelled here, but its failure still does not put the dropped row back.
  await offlineWrite(queue, FRAME(2), T0 + 3000)
  let failInFlight!: (error: unknown) => void
  queue.setFetch(() => new Promise<Response>((_resolve, reject) => {
    failInFlight = reject
  }))
  const flushing = queue.call<() => Promise<void>>('runQueueFlush')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1)
  failInFlight(new TypeError('Failed to fetch'))
  await flushing
  assert.equal(queue.rows().length, 0)
})

test('what a pass remembers as dropped is forgotten when the pass ends, so the worker holds nothing between flushes', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  await offlineWrite(queue, PLACE(), T0 + 1000)
  // Dropped while no flush is running: the ids are remembered for a pass that may already have read them.
  assert.equal(await queue.call<() => Promise<number>>('dropQueuedKeyframes')(), 1)
  assert.equal(queue.call<number>('droppedQueueIds.size'), 1)
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.call<() => Promise<void>>('runQueueFlush')()
  assert.equal(queue.call<number>('droppedQueueIds.size'), 0, 'a pass that has ended has dealt with everything it read')
})

test('the page asks for the drop with a message and gets the count on the port it sends', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  await offlineWrite(queue, FRAME(1), T0 + 1000)
  await offlineWrite(queue, PLACE(), T0 + 2000)
  const replies: unknown[] = []
  await queue.message({ type: 'dropQueuedKeyframes' }, { postMessage: (message) => replies.push(message) })
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ count: 2 }])
  assert.equal(queue.rows().length, 1)
})

test('a message the worker does not know is ignored, and a flush message still flushes', async () => {
  const queue = loadQueue()
  await offlineWrite(queue, FRAME(0), T0)
  const replies: unknown[] = []
  await queue.message({ type: 'somethingElse' }, { postMessage: (message) => replies.push(message) })
  assert.deepEqual(replies, [])
  assert.equal(queue.rows().length, 1, 'nothing was dropped')
  queue.sent.length = 0
  queue.setFetch(async () => new Response('{}', { status: 200 }))
  await queue.message({ type: 'flushQueue' })
  assert.equal(queue.sent.length, 1, 'the flush message still replays the queue')
})

test('the message name is spelled the same in the worker and in src/capture/keyframe-consent.ts', () => {
  const page = readFileSync(join(ROOT, 'src/capture/keyframe-consent.ts'), 'utf8')
  const name = /DROP_QUEUED_KEYFRAMES_MESSAGE = '([A-Za-z]+)'/.exec(page)?.[1]
  assert.ok(name, 'the page declares the message')
  assert.match(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), new RegExp(`event\\.data\\?\\.type === '${name}'`))
})
