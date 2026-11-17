/**
 * DetectionStore — an erased session stays erased (wave 3 STORE, wave 4 STORE4).
 *
 * Deleting the live session used to leave its id set, so the next save wrote the
 * erased record back under the same id, and a reload resumed it. persist() does
 * nothing without a database, so these tests open the store against a small
 * in-memory IndexedDB. The store reads the global `indexedDB` when it opens, and
 * that is the seam used here; nothing in src/ had to change for it.
 *
 * detection_store.test.ts has no such seam (it never calls open()), so the fake
 * lives in this file. wp-store4-erase-cross-tab.test.ts keeps its own copy, since
 * tests/unit/node has no shared helper modules.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store-erase.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

type Row = Record<string, unknown>
type Op = 'count' | 'delete' | 'getAll' | 'openCursor' | 'put'

/** The key path each object store is created with, as src/scene/store.ts declares them. */
const KEY_PATHS: Record<string, string> = { sessions: 'sessionId', captures: 'captureId', tripod: 'id' }

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
  openCursor(): FakeRequest
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

/** A held reply: `issued` settles once the request is made, and `release` lets its reply through. */
interface Hold {
  issued: Promise<void>
  release: () => void
}

interface FakeIndexedDB {
  /** Installed as the global `indexedDB` that the store opens. */
  factory: unknown
  /** Keys of the rows now in an object store, in insertion order. */
  keys(storeName: string): unknown[]
  /** Copies of the rows now in an object store, for checking what a write left behind. */
  rows(storeName: string): Row[]
  /** Make the next delete on the sessions store fail, once. */
  failNextSessionDelete(): void
  /** Hold the next `op` on `storeName` until the returned hold is released. */
  hold(storeName: string, op: Op): Hold
  /** Hold the next `op` on `storeName` until the returned function runs. */
  holdNextReply(storeName: string, op: Op): () => void
}

/**
 * Just enough IndexedDB for DetectionStore. A request takes effect when it is made
 * and reports on a later task, as the real API does. A transaction commits once its
 * requests have all reported. A request that fails aborts it, and the writes it made
 * are undone, as in IndexedDB. Every open() shares the same data, so a second store
 * reads what the first one wrote, the way a reload does. Records are copied in and
 * out, so no store can reach another store's objects.
 */
function fakeIndexedDB(): FakeIndexedDB {
  const stores = new Map<string, Map<unknown, Row>>()
  const holds: Array<{ store: string, op: Op, gate: Promise<void>, issued: () => void }> = []
  let failNext = false

  function takeHold(storeName: string, op: Op): Promise<void> | null {
    const index = holds.findIndex((h) => h.store === storeName && h.op === op)
    if (index < 0) return null
    const [held] = holds.splice(index, 1)
    held.issued()
    return held.gate
  }

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

  /** Make one request. Its work happens now. Its reply comes on a later task, unless held. */
  function request(tx: FakeTx, storeName: string, op: Op, run: () => unknown): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    tx.pending++
    let outcome: { ok: true, value: unknown } | { ok: false, error: unknown }
    try {
      if (tx.state !== 'active') throw new Error('transaction is not active')
      outcome = { ok: true, value: run() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    const gate = takeHold(storeName, op)
    const reply = () => {
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
    }
    setTimeout(() => {
      if (gate) void gate.then(reply)
      else reply()
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
      const before = rows.get(key)
      tx.undo.push(() => {
        if (before) rows.set(key, before)
        else rows.delete(key)
      })
      if (next) rows.set(key, next)
      else rows.delete(key)
    }
    return {
      put: (record: Row) => request(tx, name, 'put', () => {
        const copy = structuredClone(record)
        write(copy[keyPath], copy)
        return copy[keyPath]
      }),
      getAll: () => request(tx, name, 'getAll', () => [...rows.values()].map((row) => structuredClone(row))),
      count: (key: unknown) => request(tx, name, 'count', () => (rows.has(key) ? 1 : 0)),
      delete: (key: unknown) => request(tx, name, 'delete', () => {
        if (name === 'sessions' && failNext) {
          failNext = false
          throw new Error('simulated delete failure')
        }
        write(key, null)
      }),
      openCursor: () => openCursor(tx, name, rows, write),
    }
  }

  function openCursor(
    tx: FakeTx,
    name: string,
    rows: Map<unknown, Row>,
    write: (key: unknown, next: Row | null) => void,
  ): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    const keys = [...rows.keys()]
    let at = 0
    const cursorOn = (key: unknown): FakeCursor => ({
      key,
      value: structuredClone(rows.get(key) as Row),
      delete: () => write(key, null),
      update: (next: Row) => write(key, structuredClone(next)),
      continue: () => walk(),
    })
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
    const walk = () => {
      tx.pending++
      setTimeout(deliver, 0)
    }
    // The first step is a request like any other, so a hold on openCursor delays it.
    tx.pending++
    const gate = takeHold(name, 'openCursor')
    setTimeout(() => {
      if (gate) void gate.then(deliver)
      else deliver()
    }, 0)
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
    transaction: (_names: string | string[], _mode?: string) => openTx(),
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

  function hold(storeName: string, op: Op): Hold {
    let release: () => void = () => {}
    let markIssued: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = () => resolve() })
    const issued = new Promise<void>((resolve) => { markIssued = () => resolve() })
    holds.push({ store: storeName, op, gate, issued: markIssued })
    return { issued, release }
  }

  return {
    factory,
    keys: (name: string) => [...(stores.get(name)?.keys() ?? [])],
    rows: (name: string) => [...(stores.get(name)?.values() ?? [])].map((row) => structuredClone(row)),
    failNextSessionDelete: () => { failNext = true },
    hold,
    holdNextReply: (storeName: string, op: Op) => hold(storeName, op).release,
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
async function openStore(): Promise<DetectionStore> {
  const store = new DetectionStore()
  await store.open()
  return store
}

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

/** A server-minted id, the only kind adoptServerSession takes. */
const server = (n: number) => 'sess-erase-' + String(n).padStart(4, '0')

test('deleteSession: a save after the erase does not write the record back', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const erased = store.sessionId
  assert.deepEqual(idb.keys('sessions'), [erased])

  await store.deleteSession(erased)
  assert.deepEqual(idb.keys('sessions'), [])

  await store.saveSnapshot()
  await store.clear()
  await store.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written under the erased id')
  assert.equal(store.detections.size, 0, 'a late detection from the erased scan is dropped')
})

test('deleteSession: a reload after the erase finds nothing to resume', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const erased = store.sessionId
  await store.deleteSession(erased)
  // The autosave that runs after a delete in the page. It must not leave a record behind.
  await store.saveSnapshot()

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 0)
  assert.notEqual(reloaded.sessionId, erased)
  assert.deepEqual(await reloaded.allSessions(), [])
})

test('deleteSession: a capture after the erase starts a session that persists and resumes', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const erased = store.sessionId
  await store.deleteSession(erased)

  const rec = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(1024) })
  const fresh = store.sessionId
  assert.notEqual(fresh, erased, 'the new scan gets its own id')
  assert.equal(rec.sessionId, fresh, 'the capture belongs to the new scan')

  await store.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.deepEqual(idb.keys('sessions'), [fresh], 'only the new session is stored')

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.sessionId, fresh)
  assert.ok(reloaded.detections.has('lamp:1'))
  assert.equal(reloaded.getCapture(rec.captureId)?.sessionId, fresh, 'its capture reloads with it')
})

test('deleteSession: erasing an older session leaves the live one alone', async () => {
  const older = await openStore()
  await older.upsert(one('chair:0', detection('chair')), new Map())
  const olderId = older.sessionId

  const live = await openStore()
  await live.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const liveId = live.sessionId
  assert.notEqual(liveId, olderId)

  await live.deleteSession(olderId)
  assert.equal(live.sessionId, liveId)
  assert.ok(live.detections.has('lamp:1'))
  assert.deepEqual(idb.keys('sessions'), [liveId])

  await live.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [liveId])
})

test('deleteSession: a failed delete leaves the live scan and its record as they were', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const id = store.sessionId

  idb.failNextSessionDelete()
  await assert.rejects(store.deleteSession(id))

  assert.equal(store.sessionId, id)
  assert.ok(store.detections.has('chair:0'))
  assert.deepEqual(idb.keys('sessions'), [id])

  await store.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [id])
})

test('deleteSession: erasing a session drops its captures and their frames', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const kept = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(2048) })
  const failed = await store.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame(2048) })
  await store.attachDetections(kept.captureId, ['chair:0'])
  await store.markCaptureFailed(failed.captureId, 'inference timed out')
  const erased = store.sessionId
  assert.equal(idb.keys('captures').length, 2)

  await store.deleteSession(erased)
  assert.deepEqual(idb.keys('sessions'), [])
  assert.deepEqual(idb.keys('captures'), [], 'the frames go with the session')
  assert.equal(store.getCapture(kept.captureId), undefined)
  assert.equal(store.getCapture(failed.captureId), undefined)
  assert.equal(store.captures.size, 0)

  await store.saveSnapshot()
  assert.deepEqual(idb.keys('captures'), [], 'a later save does not bring a frame back')
})

test('deleteSession: a listener that throws does not change the outcome of the erase (STORE9-4)', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const capture = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  const id = store.sessionId
  const unsubscribe = store.subscribe(() => { throw new Error('listener failed') })

  // The erase goes through. The listener's failure is reported to the console, not thrown to the caller.
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    assert.equal(await store.deleteSession(id), true)
  } finally {
    console.warn = warn
    unsubscribe()
  }
  assert.equal(warnings.length, 1, 'the listener failure is reported once')

  assert.equal(store.sessionId, '', 'the scan is cleared')
  assert.deepEqual(idb.keys('sessions'), [], 'its record is gone')
  assert.deepEqual(idb.keys('captures'), [], 'and so are its frames')
  assert.equal(store.getCapture(capture.captureId), undefined)
})

test('deleteSession: a second erase of the same id waits for the first', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const id = store.sessionId
  idb.failNextSessionDelete()

  const first = store.deleteSession(id)
  const second = store.deleteSession(id)
  await assert.rejects(first, /simulated delete failure/)
  await assert.rejects(second, /simulated delete failure/)

  assert.equal(store.sessionId, id, 'the scan is restored once, by the erase that failed')
  assert.deepEqual(idb.keys('sessions'), [id])

  await store.deleteSession(id)
  assert.deepEqual(idb.keys('sessions'), [])
  assert.equal(store.sessionId, '')
})

test('loadSession: a load during an erase does not adopt the id, and the record stays gone', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const erased = store.sessionId

  const erasing = store.deleteSession(erased)
  const loaded = await store.loadSession(erased)
  await erasing

  assert.equal(loaded, false, 'the id is refused while its erase runs')
  assert.equal(store.sessionId, '')
  assert.deepEqual(idb.keys('sessions'), [])

  await store.saveSnapshot()
  await store.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back under the erased id')
  assert.equal(store.detections.size, 0)
})

test('loadSession: a read made before the erase does not adopt the id once the erase is done', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const erased = store.sessionId

  // The load's read is made while the record still exists; its reply arrives after the erase.
  const release = idb.holdNextReply('sessions', 'getAll')
  const loading = store.loadSession(erased)
  await store.deleteSession(erased)
  release()

  assert.equal(await loading, false, 'the late reply does not bring the id back')
  assert.equal(store.sessionId, '')
  await store.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
})

test('adoptServerSession: an adopt during an erase of that id is refused', async () => {
  const store = await openStore()
  const id = server(1)
  await store.adoptServerSession(id)
  await store.upsert(one('chair:0', detection('chair')), new Map())
  assert.deepEqual(idb.keys('sessions'), [id])

  const erasing = store.deleteSession(id)
  await store.adoptServerSession(id)
  await erasing

  assert.equal(store.sessionId, '', 'the id being erased is not taken back')
  await store.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
})

test('adoptServerSession: an erased id stays refused, a new id takes over, and the next save writes it', async () => {
  const store = await openStore()
  const erased = server(2)
  const next = server(3)
  await store.adoptServerSession(erased)
  await store.upsert(one('chair:0', detection('chair')), new Map())
  await store.deleteSession(erased)
  assert.deepEqual(idb.keys('sessions'), [])

  await store.adoptServerSession(erased)
  assert.equal(store.sessionId, '', 'the erased id is refused')

  await store.adoptServerSession(next)
  assert.equal(store.sessionId, next)
  assert.deepEqual(idb.keys('sessions'), [], 'adopting writes nothing by itself')

  await store.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [next], 'the next save writes the adopted id')
})

test('adoptServerSession: captures an erase has already dropped are not written back', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  for (let i = 1; i <= 3; i++) {
    await store.putCapture({ captureIndex: i, timestamp: Date.now(), pose: pose(), blob: frame() })
  }
  const id = server(4)
  // Hold the reply to the adopt's first capture write, so the erase runs while the adopt is still moving captures.
  const release = idb.holdNextReply('captures', 'put')
  const adopting = store.adoptServerSession(id)
  const erasing = store.deleteSession(id)
  await erasing
  release()
  await adopting

  assert.deepEqual(idb.keys('captures'), [], 'no frame comes back under the erased id')
  assert.deepEqual(idb.keys('sessions'), [])
  assert.equal(store.sessionId, '')
})

test('a saved session is a copy: an edit made in memory reaches storage only when saved', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const live = store.detections.get('chair:0')
  assert.ok(live)
  live.label = 'changed in memory'

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.detections.get('chair:0')?.label, 'chair')
})
