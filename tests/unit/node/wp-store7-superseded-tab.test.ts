/**
 * DetectionStore — a superseded tab writes nothing (wave 7, STORE7).
 *
 * A rename moves a scan from its local id to the server's id, and the tab that renamed
 * it is then the only writer of the renamed record and its frames. A tab that still held
 * the old id is superseded. It keeps the state it had, and every write it makes is refused,
 * so the renamed record keeps exactly the renamer's data. These cases cover the rule through
 * the channel and through the channel-free lookup, each write path of the store, the reload,
 * and the listener that reports the move. The last cases show that a genuine erase is not a move.
 *
 * Two stores in one process stand for two tabs, as in wp-store5-rename-erase.test.ts, which
 * holds the same fake IndexedDB. tests/unit/node has no shared helper modules, so this file
 * keeps its own copy.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store7-superseded-tab.test.ts
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
const server = (n: number) => 'sess-store7-' + String(n).padStart(4, '0')

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Cases that need the channel to deliver a message skip where the runtime has no
 * BroadcastChannel. The other cases run either way.
 */
const needsChannel = typeof BroadcastChannel === 'undefined' ? { skip: 'BroadcastChannel is absent in this runtime' } : {}

/** Wait for a condition that only a delivered message or a finished step can make true. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await delay(5)
  }
  assert.fail('timed out waiting for ' + what)
}

/**
 * Run a body in a runtime without BroadcastChannel. A store made inside has no
 * channel, so no message reaches it, and none of its messages reach another store.
 */
async function withoutChannel(body: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  Reflect.deleteProperty(globalThis, 'BroadcastChannel')
  try {
    assert.equal(typeof BroadcastChannel, 'undefined')
    await body()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'BroadcastChannel', saved)
  }
}

/** The stored rows of one object store, with each frame reduced to held or not, so two snapshots compare by content. */
function rowsOf(storeName: string): unknown[] {
  return idb.rows(storeName).map((row) => ('blob' in row ? { ...row, blob: row.blob ? 'held' : null } : row))
}

// ── The renamer keeps its data (STORE7-2) ───────────────────────────────────

test('(A) the renamer adds a desk and a stale tab saves: the renamed record keeps the renamer\'s chair and desk, and the stale save is refused', needsChannel, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const kept = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(1))
  await renamer.upsert(one('desk:1', detection('desk', 1)), new Map())
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')

  // The rule: a superseded tab's save is refused, and the renamer's record is what survives.
  assert.equal(await stale.upsert(one('lamp:2', detection('lamp', 2)), new Map()), false, 'the stale save is refused')
  assert.equal(stale.sessionId, oldId, 'the stale tab keeps the id it had')

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 2)
  assert.equal(reloaded.sessionId, server(1))
  assert.deepEqual([...reloaded.detections.keys()].sort(), ['chair:0', 'desk:1'], 'the renamer\'s chair and desk, and nothing from the stale tab')
  assert.equal(reloaded.getCapture(kept.captureId)?.sessionId, server(1), 'the renamed frame is still there')
  assert.deepEqual(idb.keys('sessions'), [server(1)], 'only the renamed record is stored')
})

test('(A) with no channel, the lookup finds the scan moved: the stale save is refused and the renamed record keeps the renamer\'s data', async () => withoutChannel(async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(2))
  await renamer.upsert(one('desk:1', detection('desk', 1)), new Map())

  // The save finds its record gone. The listing finds the renamed record with the same start time, so the scan
  // was moved, not erased. This store is superseded, keeps the id it had, and the save is refused.
  assert.equal(await stale.upsert(one('lamp:2', detection('lamp', 2)), new Map()), false, 'the stale save is refused')
  assert.equal(stale.isSuperseded, true, 'the stale tab is superseded, not cleared')
  assert.equal(stale.sessionId, oldId)
  assert.ok(stale.detections.has('chair:0'), 'the stale tab keeps what it had')

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 2)
  assert.deepEqual([...reloaded.detections.keys()].sort(), ['chair:0', 'desk:1'], 'the renamed record holds the renamer\'s data only')
  assert.deepEqual(idb.keys('sessions'), [server(2)], 'nothing is written under the old id')
}))

test('(D) the renamer clears the scan and a stale tab saves a lamp: the renamed record stays empty, the lamp is not written, and the renamer\'s later frame survives', needsChannel, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(3))
  // Clear drops the frames the scan held, as it always has. A frame taken after the clear is the renamer's, and it survives.
  assert.equal(await renamer.clear(), true)
  const later = await renamer.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(later, 'the renamer takes a frame after the clear')
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')

  // The rule: the stale save is refused, so the lamp is not written and the renamed record stays empty.
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'the lamp save is refused')
  assert.equal(stale.isSuperseded, true)
  assert.equal(stale.sessionId, oldId)

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 0, 'the renamed record stays empty')
  assert.equal(reloaded.sessionId, server(3))
  assert.equal(reloaded.detections.size, 0)
  assert.deepEqual(idb.keys('sessions'), [server(3)])
  const stored = idb.rows('sessions')[0]
  assert.deepEqual(stored.detections, [], 'the stored record has no lamp in it')
  assert.deepEqual(idb.keys('captures'), [later.captureId], 'the renamer\'s later frame is the only one stored')
  assert.equal(reloaded.getCapture(later.captureId)?.sessionId, server(3), 'and it survives under the renamed id')
})

// ── Refused writes (STORE7-3) ───────────────────────────────────────────────

test('a superseded store refuses every write path: nothing is written to IndexedDB, and each call resolves false', needsChannel, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const held = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(held)

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(4))
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')

  const sessionsBefore = rowsOf('sessions')
  const capturesBefore = rowsOf('captures')
  const keysBefore = [...stale.detections.keys()]
  const labelsBefore = [...stale.detections].map(([key, det]) => [key, det.label])
  const heldBefore = [...stale.captures.keys()]
  const statusesBefore = [...stale.captures].map(([id, rec]) => [id, rec.status])
  const framesBefore = [...stale.captures].map(([id, rec]) => [id, rec.blob ? 'held' : null, rec.frameDropped ?? null])

  // Each write path the store has, called as its callers call it. The capture handler does not await putCapture.
  const pendingFrame = stale.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'upsert')
  assert.equal(await stale.updateDetection('chair:0', { label: 'table' }), false, 'updateDetection')
  assert.equal(await pendingFrame, false, 'putCapture, not awaited by its caller')
  assert.equal(await stale.attachDetections(held.captureId, ['chair:0']), false, 'attachDetections')
  assert.equal(await stale.markCaptureFailed(held.captureId, 'inference failed'), false, 'markCaptureFailed')
  assert.equal(await stale.discardFrame(held.captureId, 'quality'), false, 'discardFrame')
  assert.equal(await stale.saveSnapshot(), false, 'saveSnapshot')
  assert.equal(await stale.clear(), false, 'clear')
  assert.equal(await stale.deleteSession(oldId), false, 'deleteSession of the id it held')
  assert.equal(await stale.deleteSession(server(4)), false, 'deleteSession of the renamed id')
  assert.equal(await stale.adoptServerSession(server(5)), false, 'adoptServerSession')
  assert.equal(await stale.loadSession(server(4)), false, 'loadSession')
  assert.equal(await stale.resumeLatestSession(), 0, 'resumeLatestSession resumes nothing')

  assert.deepEqual(rowsOf('sessions'), sessionsBefore, 'no session row is written, re-keyed or deleted')
  assert.deepEqual(rowsOf('captures'), capturesBefore, 'no frame row is written, re-keyed or deleted')
  assert.equal(stale.sessionId, oldId, 'the id did not change')
  assert.deepEqual([...stale.detections.keys()], keysBefore, 'the in-memory detections are as the move left them')
  assert.deepEqual([...stale.detections].map(([key, det]) => [key, det.label]), labelsBefore, 'each in-memory label is as the move left it')
  assert.deepEqual([...stale.captures.keys()], heldBefore, 'and so are the in-memory frames')
  assert.deepEqual([...stale.captures].map(([id, rec]) => [id, rec.status]), statusesBefore, 'each in-memory capture keeps its status')
  assert.deepEqual([...stale.captures].map(([id, rec]) => [id, rec.blob ? 'held' : null, rec.frameDropped ?? null]), framesBefore, 'each in-memory frame is held as it was')
  assert.ok(stale.getCapture(held.captureId)?.blob, 'the refused discard left the frame in memory')
})

// ── Notification (STORE7-1, d) ──────────────────────────────────────────────

test('onSuperseded: each listener hears of the move once, an unsubscribed one does not, and a listener that throws does not reject the save', needsChannel, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const heard: string[] = []
  const unsubscribe = stale.onSuperseded(() => { heard.push('kept') })
  const dropped = stale.onSuperseded(() => { heard.push('dropped') })
  stale.onSuperseded(() => { throw new Error('listener failed') })
  dropped()
  assert.equal(stale.isSuperseded, false, 'not superseded before the move')

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(6))
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)
  assert.equal(await stale.saveSnapshot(), false)
  assert.deepEqual(heard, ['kept'], 'the subscribed listener hears of the move once, and the unsubscribed one not at all')
  unsubscribe()
})

test('a listener that throws does not reject the save that finds the scan moved', async (t) => withoutChannel(async () => {
  t.mock.method(console, 'warn', () => {})
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  stale.onSuperseded(() => { throw new Error('listener failed') })

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(7))
  // Resolves to false. A rejection here would be an unhandled one on the callers that do not await.
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)
  assert.equal(stale.isSuperseded, true)
}))

// ── Reload (STORE7-4) ───────────────────────────────────────────────────────

test('after a reload the page resumes the renamed session through the normal path, and the old id is never written again', needsChannel, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(8))
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)

  // The reload: a fresh page over the same database, resuming through resumeLatestSession as the page does at boot.
  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.sessionId, server(8), 'the page resumes the renamed session')
  assert.ok(reloaded.detections.has('chair:0'))
  assert.equal(reloaded.isSuperseded, false, 'the reloaded page holds the renamed scan, so it is not superseded')

  await reloaded.upsert(one('desk:2', detection('desk', 2)), new Map())
  // The tab that was superseded is still open. Its writes are refused, and nothing is written under its old id.
  assert.equal(await stale.saveSnapshot(), false)
  assert.equal(await stale.clear(), false)
  assert.deepEqual(idb.keys('sessions'), [server(8)], 'the old id is never written again')
  assert.ok(!idb.keys('sessions').includes(oldId))

  const again = await openStore()
  assert.equal(await again.resumeLatestSession(), 2)
  assert.deepEqual([...again.detections.keys()].sort(), ['chair:0', 'desk:2'], 'the renamed scan has the renamer\'s edits, and nothing from the stale tab')
})

// ── Moves are not erases (STORE7-1, the boundary) ───────────────────────────

test('a genuine erase by another tab clears this tab, and is not a move', needsChannel, async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const erased = tab1.sessionId

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(erased), true)
  await tab2.deleteSession(erased)
  await until(() => tab1.sessionId === '', 'tab 1 to drop the erased scan')

  assert.equal(tab1.isSuperseded, false, 'an erase is not a move: tab 1 is not superseded')
  assert.equal(await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'and nothing is written back for the erased id')
  assert.deepEqual(idb.keys('sessions'), [])
})

test('with no channel, a genuine erase found by the lookup clears this tab, and is not a move', async () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const erased = tab1.sessionId

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(erased), true)
  await tab2.deleteSession(erased)

  // No record carries the start time any more, so the lookup finds nothing to follow.
  assert.equal(await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)
  assert.equal(tab1.sessionId, '')
  assert.equal(tab1.isSuperseded, false, 'an erase is not a move')
  assert.deepEqual(idb.keys('sessions'), [])
}))

test('an erase of the scan a tab was moved to clears that tab from memory, and writes no row', needsChannel, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const held = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const renamer = await openStore()
  assert.equal(await renamer.resumeLatestSession(), 1)
  await renamer.adoptServerSession(server(9))
  await until(() => stale.isSuperseded, 'the stale tab to hear of the rename')
  assert.equal(stale.detections.size, 1, 'the move leaves the stale tab showing what it had')

  // The renaming tab's user then erases the renamed scan. That is a genuine erase, and this tab hears of it.
  await renamer.deleteSession(server(9))
  await until(() => stale.sessionId === '', 'the stale tab to drop the erased scan')
  assert.equal(stale.detections.size, 0)
  assert.equal(stale.getCapture(held.captureId), undefined, 'and its frame leaves memory')
  assert.equal(stale.isSuperseded, true, 'it stays superseded')
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back')
})

test('a tab that holds another scan is not superseded by a rename of a scan it does not hold', needsChannel, async () => {
  const other = await openStore()
  await other.upsert(one('lamp:9', detection('lamp', 9)), new Map())
  const otherId = other.sessionId

  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const scan = stale.sessionId
  const scanFrame = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  // A tab that holds the other scan live, and has the moved scan's frame in memory from its open.
  const bystander = await openStore()
  assert.equal(await bystander.loadSession(otherId), true)
  assert.ok(bystander.getCapture(scanFrame.captureId), 'the bystander loaded the frame of the scan that will move')

  const renamer = await openStore()
  assert.equal(await renamer.loadSession(scan), true)
  await renamer.adoptServerSession(server(10))
  await until(() => bystander.getCapture(scanFrame.captureId) === undefined, 'the bystander to drop the moved frame')

  assert.equal(bystander.isSuperseded, false, 'it does not hold the moved scan, so it is not superseded')
  assert.equal(bystander.sessionId, otherId)
  assert.equal(await bystander.upsert(one('desk:2', detection('desk', 2)), new Map()), true, 'its own scan still saves')
  assert.deepEqual(idb.keys('sessions').sort(), [otherId, server(10)].sort())
  assert.equal(idb.keys('captures').includes(scanFrame.captureId), true, 'the frame is still stored, under the renamed id')
})
