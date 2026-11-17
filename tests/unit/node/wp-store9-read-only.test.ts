/**
 * DetectionStore — read-only mode, and the remaining store items of wave 9 (STORE9).
 *
 * STORE9-1: `new DetectionStore({ readOnly: true })` reads on open, as a writable store does, and then
 * writes nothing. It makes no record write or delete, evicts and releases nothing, writes no session record,
 * never re-keys or supersedes, and announces nothing. Each write method is refused and leaves memory and rows
 * as they were, and reads keep working.
 *
 * STORE9-3: an aborted rename batch is not applied. The store keeps its old id and frames, nothing is written
 * under the new id, no rename is announced, and adoptServerSession resolves false. The same adoption goes
 * through once the database accepts the batch.
 *
 * STORE9-4: a listener that throws does not change the outcome of an erase. An erase the database refuses
 * still fails, with the database's error, and the live scan is put back. The erase that succeeds with a
 * throwing listener is in wp-store-erase.test.ts.
 *
 * Two stores in one process stand for two tabs, as in wp-store8-capture-gate.test.ts. This file keeps its own
 * copy of that fake IndexedDB, with three additions: a count of the writes and of the readwrite transactions
 * made, a seed that writes rows without a transaction (as an earlier page would have left them), and a one-shot
 * failure for the next put or delete on a store, which aborts the transaction it is in.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store9-read-only.test.ts
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { CaptureRecord, CaptureStatus } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

type Row = Record<string, unknown>

/** The key path each object store is created with, as src/scene/store.ts declares them. */
const KEY_PATHS: Record<string, string> = { sessions: 'sessionId', captures: 'captureId', tripod: 'id' }

/** The erase channel's name in src/scene/store.ts. */
const ERASE_CHANNEL = 'ci-xr-scan-erase'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

interface FakeRequest {
  result: unknown
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: (() => void) | null
}

interface FakeObjectStore {
  put(record: Row): FakeRequest
  getAll(): FakeRequest
  count(key: unknown): FakeRequest
  delete(key: unknown): FakeRequest
  openCursor(query?: unknown): FakeRequest
}

interface FakeTx {
  pending: number
  state: 'active' | 'done' | 'aborted'
  undo: Array<() => void>
  error: unknown
  oncomplete: (() => void) | null
  onabort: (() => void) | null
  objectStore(name: string): FakeObjectStore
}

interface FakeCursor {
  key: unknown
  value: Row
  delete(): void
  update(value: Row): void
  continue(): void
}

interface FakeIndexedDB {
  /** Installed as the global `indexedDB` that the store opens. */
  factory: unknown
  /** Keys of the rows now in an object store, in insertion order. */
  keys(storeName: string): unknown[]
  /** Copies of the rows now in an object store. */
  rows(storeName: string): Row[]
  /** Writes a row straight into an object store, as an earlier page would have left it. Not a transaction. */
  seed(storeName: string, row: Row): void
  /** Makes the next put or delete on this object store fail. The failure aborts its transaction. */
  failNext(storeName: string, op: 'put' | 'delete'): void
  /** Row writes and deletes made through transactions so far. */
  writes(): number
  /** Readwrite transactions opened so far. */
  readwriteTransactions(): number
}

/**
 * Just enough IndexedDB for DetectionStore. A request takes effect when it is made and reports on a later task,
 * as the real API does. A transaction commits once its requests have all reported. A request that fails aborts
 * it, and the writes it made are undone. Every open() shares the same data, so a second store reads what the
 * first one wrote. Records are copied in and out, so no store can reach another store's objects.
 */
function fakeIndexedDB(): FakeIndexedDB {
  const stores = new Map<string, Map<unknown, Row>>()
  for (const name of Object.keys(KEY_PATHS)) stores.set(name, new Map())
  const armed = new Map<string, 'put' | 'delete'>()
  let writeCount = 0
  let readwriteCount = 0

  /** Commit the transaction once every request has reported, on a later task. */
  function settle(tx: FakeTx): void {
    if (tx.state !== 'active' || tx.pending > 0) return
    setTimeout(() => {
      if (tx.state !== 'active' || tx.pending > 0) return
      tx.state = 'done'
      tx.oncomplete?.()
    }, 0)
  }

  function abort(tx: FakeTx, error: unknown): void {
    if (tx.state !== 'active') return
    tx.state = 'aborted'
    tx.error = error
    for (const undo of tx.undo.reverse()) undo()
    tx.onabort?.()
  }

  /** Make one request. Its work happens now. Its reply comes on a later task. */
  function request(tx: FakeTx, run: () => unknown): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    tx.pending++
    let outcome: { ok: true, value: unknown } | { ok: false, error: unknown }
    try {
      if (tx.state !== 'active') throw new Error('transaction is not active')
      outcome = { ok: true, value: run() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    setTimeout(() => {
      if (tx.state === 'active') {
        if (outcome.ok) {
          req.result = outcome.value
          req.onsuccess?.()
        } else {
          req.error = outcome.error
          req.onerror?.()
          abort(tx, outcome.error)
        }
      }
      tx.pending--
      settle(tx)
    }, 0)
    return req
  }

  function storeOf(tx: FakeTx, name: string): FakeObjectStore {
    const rows = stores.get(name)
    if (!rows) throw new Error('no object store ' + name)
    const keyPath = KEY_PATHS[name] ?? 'id'
    /** Set or remove one row, first recording how to put it back if the transaction aborts. */
    const write = (key: unknown, next: Row | null): void => {
      if (tx.state !== 'active') return
      writeCount++
      const before = rows.get(key)
      tx.undo.push(() => {
        if (before) rows.set(key, before)
        else rows.delete(key)
      })
      if (next) rows.set(key, next)
      else rows.delete(key)
    }
    /** Throws once when a failure is armed for this store and operation. The throw aborts the transaction. */
    const failIfArmed = (op: 'put' | 'delete'): void => {
      if (armed.get(name) !== op) return
      armed.delete(name)
      throw new Error('injected ' + op + ' failure on ' + name)
    }
    return {
      put: (record: Row) => request(tx, () => {
        failIfArmed('put')
        const copy = structuredClone(record)
        write(copy[keyPath], copy)
        return copy[keyPath]
      }),
      getAll: () => request(tx, () => [...rows.values()].map((row) => structuredClone(row))),
      count: (key: unknown) => request(tx, () => (rows.has(key) ? 1 : 0)),
      delete: (key: unknown) => request(tx, () => {
        failIfArmed('delete')
        write(key, null)
      }),
      openCursor: (query?: unknown) => openCursor(tx, rows, write, query),
    }
  }

  /**
   * A cursor over one object store. With a key query it answers with that row alone, or with no row, as
   * IndexedDB does. Without one it walks every row, one step per reply.
   */
  function openCursor(
    tx: FakeTx,
    rows: Map<unknown, Row>,
    write: (key: unknown, next: Row | null) => void,
    query?: unknown,
  ): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    const cursorOn = (key: unknown): FakeCursor => ({
      key,
      value: structuredClone(rows.get(key) as Row),
      delete: () => write(key, null),
      update: (next: Row) => write(key, structuredClone(next)),
      continue: () => walk(),
    })
    if (query !== undefined) {
      if (tx.state !== 'active') throw new Error('transaction is not active')
      tx.pending++
      const found = rows.has(query) ? cursorOn(query) : null
      setTimeout(() => {
        if (tx.state === 'active') {
          req.result = found
          req.onsuccess?.()
        }
        tx.pending--
        settle(tx)
      }, 0)
      return req
    }
    const keys = [...rows.keys()]
    let at = 0
    /** One step of the walk: the next row still stored, or the end of the store. */
    const deliver = () => {
      if (tx.state === 'active') {
        while (at < keys.length && !rows.has(keys[at])) at++
        req.result = at < keys.length ? cursorOn(keys[at++]) : null
        req.onsuccess?.()
      }
      tx.pending--
      settle(tx)
    }
    function walk(): void {
      tx.pending++
      setTimeout(deliver, 0)
    }
    walk()
    return req
  }

  function openTx(): FakeTx {
    const tx: FakeTx = {
      pending: 0,
      state: 'active',
      undo: [],
      error: null,
      oncomplete: null,
      onabort: null,
      objectStore: (name: string) => storeOf(tx, name),
    }
    settle(tx)
    return tx
  }

  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      return {}
    },
    transaction: (_names: string | string[], mode?: string) => {
      if (mode === 'readwrite') readwriteCount++
      return openTx()
    },
    close: () => {},
  }

  const factory = {
    open: (_name: string, _version: number): FakeRequest => {
      const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
      setTimeout(() => {
        req.result = database
        req.onupgradeneeded?.()
        req.onsuccess?.()
      }, 0)
      return req
    },
  }

  return {
    factory,
    keys: (name: string) => [...(stores.get(name)?.keys() ?? [])],
    rows: (name: string) => [...(stores.get(name)?.values() ?? [])].map((row) => structuredClone(row)),
    seed: (name: string, row: Row) => {
      const copy = structuredClone(row)
      stores.get(name)?.set(copy[KEY_PATHS[name] ?? 'id'], copy)
    },
    failNext: (name: string, op: 'put' | 'delete') => {
      armed.set(name, op)
    },
    writes: () => writeCount,
    readwriteTransactions: () => readwriteCount,
  }
}

let idb: FakeIndexedDB

beforeEach(() => {
  idb = fakeIndexedDB()
  Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true, writable: true })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
})

/** A store as a page opens it: a fresh tab over the shared database. */
async function openStore(options?: { readOnly?: boolean }): Promise<DetectionStore> {
  const store = new DetectionStore(options)
  await store.open()
  return store
}

const server = (n: number) => 'sess-store9-' + String(n).padStart(4, '0')
const capId = (sessionId: string, index: number) => sessionId + '-c' + String(index)
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Cases that need the channel to carry a message skip where the runtime has no BroadcastChannel. */
const needsChannel = typeof BroadcastChannel === 'undefined' ? { skip: 'BroadcastChannel is absent in this runtime' } : {}

/** Minimal WorldDetection, as in detection_store.test.ts. */
function detection(label: string, x = 0): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: 'a ' + label,
    bbox: [0, 0, 1, 1],
    worldPos: { x, y: 0, z: 0 },
  } as unknown as WorldDetection
}

function one(key: string, det: WorldDetection): Map<string, WorldDetection> {
  return new Map([[key, det]])
}

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

/** A stand-in JPEG. Only its byte length matters to the store. */
function frame(bytes = 8): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
}

/** The stored rows of one object store, each frame reduced to held or not, so two snapshots compare by content. */
function rowsOf(storeName: string): unknown[] {
  return idb.rows(storeName).map((row) => ('blob' in row ? { ...row, blob: row.blob ? 'held' : null } : row))
}

/** Everything a store holds in memory, reduced to content: the identity, the detections, the selection and the captures. */
function memoryOf(store: DetectionStore): unknown {
  return {
    sessionId: store.sessionId,
    startedAt: store.startedAt,
    detections: [...store.detections.entries()].map(([key, det]) => [key, structuredClone(det)]),
    selected: [...store.selected],
    captures: [...store.captures.values()].map((rec) => ({ ...rec, blob: rec.blob ? 'held' : null })),
  }
}

/** Run a body with console.warn held, and return what the body's warnings were given. */
async function captureWarnings(body: () => Promise<void>): Promise<unknown[][]> {
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    await body()
  } finally {
    console.warn = warn
  }
  return warnings
}

/**
 * Collect every message any store posts on the erase channel while the body runs. With `expected` messages to
 * wait for, the call waits until they have arrived (up to about a second) before it returns what it heard.
 */
async function channelMessages(body: () => Promise<void>, expected = 0): Promise<unknown[]> {
  const stray = new BroadcastChannel(ERASE_CHANNEL)
  const messages: unknown[] = []
  stray.onmessage = (ev: MessageEvent<unknown>) => {
    messages.push(ev.data)
  }
  try {
    await body()
    for (let i = 0; i < 200 && messages.length < expected; i++) await delay(5)
    await delay(30)
    return messages
  } finally {
    stray.close()
  }
}

/** A stored scan of one session, written straight into the database as an earlier page would have left it. */
function seedScan(sessionId: string): void {
  idb.seed('sessions', {
    sessionId,
    startedAt: Date.now() - 60_000,
    detections: [['chair:0', detection('chair')]],
  })
}

/** One stored frame. `byteSize` is what the retention budget counts. */
function seedCapture(sessionId: string, index: number, status: CaptureStatus, byteSize: number, ageMs = 3_000): void {
  idb.seed('captures', {
    captureId: capId(sessionId, index),
    sessionId,
    captureIndex: index,
    timestamp: Date.now() - ageMs,
    pose: pose(),
    blob: frame(8),
    byteSize,
    status,
    detectionKeys: [],
    engine: 'server',
  })
}

/**
 * A scan over the 64 MB retention budget, with one frame past the 7-day age limit. Four frames of 20 MB are held,
 * one of them pending. It is written straight into the database, so no store has released anything when a test
 * opens one.
 */
function seedOverBudget(sessionId: string): void {
  seedScan(sessionId)
  seedCapture(sessionId, 0, 'inferred', 1024, 8 * DAY)
  seedCapture(sessionId, 1, 'inferred', 20 * MB, 3_000)
  seedCapture(sessionId, 2, 'failed', 20 * MB, 2_000)
  seedCapture(sessionId, 3, 'inferred', 20 * MB, 1_000)
  seedCapture(sessionId, 4, 'pending', 20 * MB, 500)
}

/** Every capture a store holds, as content, for comparing what two stores restored. */
function captureSnapshot(store: DetectionStore): unknown[] {
  return [...store.captures.values()].map((rec) => ({ ...rec, blob: rec.blob ? 'held' : null }))
}

// ── Reads on open (STORE9-1) ─────────────────────────────────────────────────

test('a read-only store restores on open exactly what a writable store restores: records, frames and their states', async () => {
  const sess = server(1)
  seedScan(sess)
  seedCapture(sess, 1, 'inferred', 1000)
  seedCapture(sess, 2, 'failed', 1000)
  // A frame dropped for quality keeps its record and the reason.
  idb.seed('captures', {
    captureId: capId(sess, 3),
    sessionId: sess,
    captureIndex: 3,
    timestamp: Date.now() - 1_000,
    pose: pose(),
    blob: null,
    byteSize: 1000,
    status: 'failed',
    detectionKeys: [],
    engine: 'server',
    frameDropped: 'quality',
  })

  const readOnly = await openStore({ readOnly: true })
  const writable = await openStore()
  assert.deepEqual(captureSnapshot(readOnly), captureSnapshot(writable), 'the same records, frames and states')
  assert.equal(readOnly.captures.size, 3)
  assert.ok(readOnly.getCapture(capId(sess, 1))?.blob, 'a held frame comes back with its bytes')
  assert.equal(readOnly.getCapture(capId(sess, 3))?.blob, null)
  assert.equal(readOnly.getCapture(capId(sess, 3))?.frameDropped, 'quality', 'and a dropped frame keeps its reason')
  assert.equal(idb.writes(), 0, 'opening writes nothing')
  assert.equal(idb.readwriteTransactions(), 0, 'and opens no readwrite transaction')
})

test('reads keep working on a read-only store: stored sessions, captures and counts', async () => {
  const sess = server(1)
  seedOverBudget(sess)
  const readOnly = await openStore({ readOnly: true })

  const listed = await readOnly.allSessions()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.sessionId, sess)
  assert.equal(listed[0]?.count, 1)
  const stored = await readOnly.readSession(sess)
  assert.ok(stored?.has('chair:0'), 'a stored session is readable without taking it over')
  assert.notEqual(readOnly.sessionId, sess, 'and reading it does not take it over')

  assert.equal(await readOnly.loadSession(sess), true, 'loading a stored session writes nothing, so it is still allowed')
  assert.ok(readOnly.detections.has('chair:0'))
  assert.deepEqual(readOnly.captureCounts(), { total: 5, pending: 1, inferred: 3, failed: 1, unusable: 0, retained: 5 })
  assert.ok(readOnly.getCapture(capId(sess, 2)), 'a capture is read by its id')
  assert.equal(idb.writes(), 0)
  assert.equal(idb.readwriteTransactions(), 0)
})

test('a read-only store names captures under the session it holds, and starts no session of its own', async () => {
  const readOnly = await openStore({ readOnly: true })
  const before = readOnly.sessionId
  assert.equal(readOnly.captureIdFor(3), before + '-c3')
  assert.equal(readOnly.sessionId, before)
})

// ── Over-budget frames are neither written nor released (STORE9-1) ───────────

test('a read-only store opened on over-budget frames writes nothing and releases nothing', async () => {
  const sess = server(1)
  seedOverBudget(sess)
  const sessionsBefore = rowsOf('sessions')
  const capturesBefore = rowsOf('captures')

  const readOnly = await openStore({ readOnly: true })
  assert.equal([...readOnly.captures.values()].filter((rec) => rec.blob).length, 5, 'every frame is held on open')

  // Each of these would write or release on a writable store. None does here.
  assert.equal(await readOnly.putCapture({ captureIndex: 5, timestamp: Date.now(), pose: pose(), blob: frame() }), false)
  assert.equal(await readOnly.attachDetections(capId(sess, 3), ['chair:0']), false)
  assert.equal(await readOnly.markCaptureFailed(capId(sess, 1), 'inference failed'), false)
  assert.equal(await readOnly.discardFrame(capId(sess, 1), 'budget'), false)
  assert.equal(await readOnly.saveSnapshot(), false)

  assert.deepEqual(rowsOf('sessions'), sessionsBefore)
  assert.deepEqual(rowsOf('captures'), capturesBefore, 'every row is as it was, and every frame still held')
  assert.equal([...readOnly.captures.values()].filter((rec) => rec.blob).length, 5, 'no frame is released from memory either')
  assert.equal(readOnly.getCapture(capId(sess, 0))?.frameDropped, undefined, 'the frame past the age limit is not released')
  assert.equal(idb.writes(), 0)
  assert.equal(idb.readwriteTransactions(), 0)
})

test('control: a writable store on the same over-budget frames releases them, so the set above is really over budget', async () => {
  const sess = server(1)
  seedOverBudget(sess)
  const writable = await openStore()
  const added = await writable.putCapture({ captureIndex: 5, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(added)

  assert.equal(writable.getCapture(capId(sess, 0))?.frameDropped, 'budget', 'the frame past the age limit is released')
  assert.equal(writable.getCapture(capId(sess, 1))?.frameDropped, 'budget', 'then the oldest inferred frame, until the budget holds')
  assert.ok(writable.getCapture(capId(sess, 2))?.blob, 'the failed frame stays')
  assert.ok(writable.getCapture(capId(sess, 3))?.blob, 'and so does the newer inferred one')
  assert.ok(writable.getCapture(capId(sess, 4))?.blob, 'a pending frame is never released')
  assert.ok(writable.getCapture(added.captureId)?.blob)
})

// ── Every write method is refused, and changes neither memory nor rows (STORE9-1) ──

interface Attempt {
  name: string
  /** True when the store must hold the scan live before the call, so the call would write the record. */
  live: boolean
  call: (store: DetectionStore) => Promise<unknown>
  refused: unknown
}

const scan = server(1)
const attempts: Attempt[] = [
  { name: 'upsert', live: true, call: (s) => s.upsert(one('lamp:1', detection('lamp', 1)), new Map()), refused: false },
  { name: 'updateDetection', live: true, call: (s) => s.updateDetection('chair:0', { label: 'sofa' }), refused: false },
  { name: 'clear', live: true, call: (s) => s.clear(), refused: false },
  { name: 'deleteSession', live: true, call: (s) => s.deleteSession(scan), refused: false },
  { name: 'saveSnapshot', live: true, call: (s) => s.saveSnapshot(), refused: false },
  { name: 'adoptServerSession', live: true, call: (s) => s.adoptServerSession(server(31)), refused: false },
  { name: 'putCapture', live: false, call: (s) => s.putCapture({ captureIndex: 9, timestamp: Date.now(), pose: pose(), blob: frame() }), refused: false },
  { name: 'attachDetections', live: false, call: (s) => s.attachDetections(capId(scan, 1), ['chair:0']), refused: false },
  { name: 'markCaptureFailed', live: false, call: (s) => s.markCaptureFailed(capId(scan, 1), 'inference failed'), refused: false },
  { name: 'discardFrame', live: false, call: (s) => s.discardFrame(capId(scan, 1), 'quality'), refused: false },
  { name: 'resumeLatestSession', live: false, call: (s) => s.resumeLatestSession(), refused: 0 },
]

for (const attempt of attempts) {
  test('a read-only store refuses ' + attempt.name + ': it resolves ' + String(attempt.refused) + ', and memory and rows stay as they were', async () => {
    seedOverBudget(scan)
    const readOnly = await openStore({ readOnly: true })
    if (attempt.live) assert.equal(await readOnly.loadSession(scan), true)

    const memoryBefore = memoryOf(readOnly)
    const sessionsBefore = rowsOf('sessions')
    const capturesBefore = rowsOf('captures')
    const writesBefore = idb.writes()
    const readwriteBefore = idb.readwriteTransactions()
    let notified = 0
    readOnly.subscribe(() => {
      notified++
    })

    assert.equal(await attempt.call(readOnly), attempt.refused)
    assert.deepEqual(memoryOf(readOnly), memoryBefore, 'memory is as it was')
    assert.deepEqual(rowsOf('sessions'), sessionsBefore, 'the session rows are as they were')
    assert.deepEqual(rowsOf('captures'), capturesBefore, 'the frame rows are as they were')
    assert.equal(notified, 0, 'no listener is told of a write')
    assert.equal(idb.writes(), writesBefore, 'no row is written or deleted')
    assert.equal(idb.readwriteTransactions(), readwriteBefore, 'no readwrite transaction is opened')
  })
}

test('a read-only store announces nothing: no message reaches the other tabs from any refused write', needsChannel, async () => {
  seedOverBudget(scan)
  const readOnly = await openStore({ readOnly: true })
  assert.equal(await readOnly.loadSession(scan), true)

  const messages = await channelMessages(async () => {
    for (const attempt of attempts) await attempt.call(readOnly)
  })
  assert.deepEqual(messages, [], 'nothing is announced')
})

test('control: a writable store does announce its erase on the channel, so the silence above means something', needsChannel, async () => {
  seedScan(scan)
  const writable = await openStore()
  assert.equal(await writable.loadSession(scan), true)

  const messages = await channelMessages(async () => {
    assert.equal(await writable.deleteSession(scan), true)
  }, 1)
  assert.deepEqual(messages, [scan])
})

test('a read-only store takes no part in the erase channel: another tab erasing the scan leaves what it read in place', needsChannel, async () => {
  seedOverBudget(scan)
  const readOnly = await openStore({ readOnly: true })
  assert.equal(await readOnly.loadSession(scan), true)
  const writable = await openStore()
  assert.equal(await writable.loadSession(scan), true)

  // The erase is announced, and the message is heard by a stray listener, so the read-only store had its chance to hear it.
  const heard = await channelMessages(async () => {
    assert.equal(await writable.deleteSession(scan), true)
  }, 1)
  assert.deepEqual(heard, [scan], 'the erase went out on the channel')

  assert.equal(readOnly.sessionId, scan, 'the read-only store still holds the scan it read')
  assert.ok(readOnly.detections.has('chair:0'))
  assert.ok(readOnly.getCapture(capId(scan, 2)), 'and its frames')
  assert.deepEqual(idb.keys('sessions'), [], 'the erase itself is in the database')
})

// ── An aborted rename batch is not applied (STORE9-3) ────────────────────────

test('an aborted rename batch is not applied: the old id and frames stay, nothing is written under the new id, and no rename is announced', needsChannel, async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = store.sessionId
  const first = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  const second = await store.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(first && second)
  const memoryBefore = memoryOf(store)
  const sessionsBefore = rowsOf('sessions')
  const capturesBefore = rowsOf('captures')

  // The first write of the rename batch is refused, so the batch aborts.
  idb.failNext('captures', 'put')
  let adopted: boolean | undefined
  const messages = await channelMessages(async () => {
    adopted = await store.adoptServerSession(server(41))
  })

  assert.equal(adopted, false, 'an aborted batch is not an adoption')
  assert.equal(store.sessionId, oldId, 'the store keeps the id it had')
  assert.deepEqual(memoryOf(store), memoryBefore, 'and the frames it had, under that id')
  assert.deepEqual(rowsOf('sessions'), sessionsBefore, 'the old session record is as it was, and no record is written under the new id')
  assert.deepEqual(rowsOf('captures'), capturesBefore, 'every frame row is as it was')
  assert.deepEqual(messages, [], 'no rename is announced')
  assert.equal(store.getCapture(first.captureId)?.sessionId, oldId)
  assert.equal(store.getCapture(second.captureId)?.sessionId, oldId)
})

test('after an aborted rename batch the same adoption goes through once the database accepts it', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const first = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(first)

  idb.failNext('captures', 'put')
  assert.equal(await store.adoptServerSession(server(41)), false)

  assert.equal(await store.adoptServerSession(server(41)), true)
  assert.equal(store.sessionId, server(41))
  assert.deepEqual(idb.keys('sessions'), [server(41)], 'the renamed record replaces the old one')
  assert.ok(idb.rows('captures').every((row) => row.sessionId === server(41)), 'and the frames follow it')
  assert.equal(store.getCapture(first.captureId)?.sessionId, server(41))
})

// ── A listener cannot change the outcome of an erase (STORE9-4) ──────────────

test('a listener that throws during an erase the database refuses: the refusal is what the caller gets, and the live scan is back', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const capture = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(capture)
  const id = store.sessionId
  const unsubscribe = store.subscribe(() => {
    throw new Error('listener failed')
  })

  idb.failNext('sessions', 'delete')
  let warnings: unknown[][] = []
  try {
    warnings = await captureWarnings(async () => {
      await assert.rejects(store.deleteSession(id), /injected delete failure on sessions/)
    })
  } finally {
    unsubscribe()
  }

  assert.equal(store.sessionId, id, 'the scan is the live one again')
  assert.ok(store.detections.has('chair:0'))
  assert.ok(store.getCapture(capture.captureId), 'and its frame is held')
  assert.deepEqual(idb.keys('sessions'), [id])
  assert.equal(idb.keys('captures').length, 1)
  assert.ok(warnings.some((args) => args[1] instanceof Error && args[1].message === 'listener failed'), 'the listener failure is reported to the console')
})
