/**
 * DetectionStore — a rename is not an erase, and the erase fixes of wave 5 (STORE5).
 *
 * A rename moves a scan from its local id to the server's id, and it is not an erase.
 * A tab still on the old id is superseded by the rename (STORE7-1): it keeps its state
 * and writes nothing more, so the renamed record keeps only the renamer's data. An erase
 * must take only the rows that still belong to the erased id. The other tests cover
 * the rest of the wave's erase fixes: the order of the first step, the restore after
 * a failed erase, a listener that throws, a channel that will not open, a read still
 * in flight, and a frame another tab wrote after this tab opened.
 *
 * Two stores in one process stand for two tabs, as in wp-store4-erase-cross-tab.test.ts.
 * Where a test needs the channel to deliver a message, it waits for an observable effect
 * of that message, not for a fixed time. The fake IndexedDB is the same copy as in the
 * other two wp-store files. tests/unit/node has no shared helper modules.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store5-rename-erase.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

/** The channel name src/scene/store.ts announces erases and renames on. */
const ERASE_CHANNEL_NAME = 'ci-xr-scan-erase'

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
const server = (n: number) => 'sess-store5-' + String(n).padStart(4, '0')

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

// ── A rename is not an erase (STORE5-1) ─────────────────────────────────────

test('a rename: a tab still on the old id is superseded, and its later save is refused', needsChannel, async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = tab1.sessionId
  const before = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.resumeLatestSession(), 1)
  await tab2.adoptServerSession(server(1))
  // Waits for the rename to reach tab 1. Tab 1 does not follow the rename any more: it is superseded,
  // keeps the id it had, and writes nothing more. The renaming tab is the only writer of the renamed record.
  await until(() => tab1.isSuperseded, 'tab 1 to learn of the rename')

  assert.equal(tab1.sessionId, oldId, 'tab 1 keeps the id it had')
  assert.equal(await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'a save from tab 1 is refused')
  assert.deepEqual(idb.keys('sessions'), [server(1)], 'nothing is written under the old id')

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.sessionId, server(1))
  assert.ok(reloaded.detections.has('chair:0'), 'the renamer keeps its detection')
  assert.ok(!reloaded.detections.has('lamp:1'), 'the edit tab 1 made after the rename is refused, so it is not in the renamed record')
  assert.equal(reloaded.getCapture(before.captureId)?.sessionId, server(1), 'the renamed frame is still there')
})

test('a rename: with no BroadcastChannel, a stale save leaves the renamed frame in place', async () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const before = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.resumeLatestSession(), 1)
  await tab2.adoptServerSession(server(2))

  // Tab 1 never hears of the rename, so its save finds the old record gone. The listing finds the renamed record
  // (same start time, see persist), so tab 1 is superseded by it. Its save is refused and it writes nothing.
  // The rule: a save that finds its scan moved is refused, and the renamer's state is what survives.
  assert.equal(await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'the save is refused')
  assert.equal(tab1.isSuperseded, true, 'tab 1 is superseded')
  assert.deepEqual(idb.keys('sessions'), [server(2)], 'nothing is written back under the old id')

  const reloaded = await openStore()
  // The count is one: the renamer's chair. The edit tab 1 made without the channel is refused, not re-keyed
  // into the renamed record, so the renamed record holds only the renamer's data and frame.
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.sessionId, server(2))
  assert.ok(reloaded.detections.has('chair:0'), 'the renamer keeps its detection')
  assert.ok(!reloaded.detections.has('lamp:1'), 'the edit tab 1 made without the channel is refused, not kept')
  assert.equal(reloaded.getCapture(before.captureId)?.sessionId, server(2), 'the renamed frame survives')
}))

test('a rename: a frame the stale tab writes before the message arrives stays under the old id', needsChannel, async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = tab1.sessionId
  const first = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.resumeLatestSession(), 1)
  await tab2.adoptServerSession(server(3))

  // Tab 1 has not heard of the rename yet, so this frame is written under the old id, while tab 1 still holds it live.
  const second = await tab1.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.equal(second.sessionId, oldId)
  await until(() => tab1.isSuperseded, 'tab 1 to learn of the rename')
  // The rule: the rename re-keys nothing in tab 1. The renaming tab is the only writer of the renamed record and
  // its frames, so the frame tab 1 wrote before the message stays under the old id.
  assert.equal(tab1.getCapture(second.captureId)?.sessionId, oldId, 'the frame is not re-keyed in memory')

  const reloaded = await openStore()
  assert.equal(await reloaded.resumeLatestSession(), 1)
  assert.equal(reloaded.sessionId, server(3))
  assert.equal(reloaded.getCapture(first.captureId)?.sessionId, server(3), 'the renamer\'s frame is under the new id')
  assert.equal(reloaded.getCapture(second.captureId)?.sessionId, oldId, 'the stale tab\'s frame is not carried over')
  assert.ok(!idb.keys('sessions').includes(oldId), 'and no record is written under the old id')
})

test('a rename: an erase message naming the old id, arriving after the rename, does not take the renamed frames', needsChannel, async () => {
  // Another session's frame. The watcher opened below holds it too, so the last message below has an effect to wait for.
  const other = await openStore()
  await other.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const otherId = other.sessionId
  const otherFrame = await other.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = tab1.sessionId
  const scanFrame = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const watcher = await openStore()
  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(oldId), true)
  await tab2.adoptServerSession(server(4))
  await until(() => tab1.isSuperseded, 'tab 1 to learn of the rename')

  const stray = new BroadcastChannel(ERASE_CHANNEL_NAME)
  try {
    stray.postMessage(oldId)
    stray.postMessage(otherId)
    await until(() => watcher.getCapture(otherFrame.captureId) === undefined, 'the watcher to handle the last message')
  } finally {
    stray.close()
  }

  // Tab 1 is superseded, so it ignores both messages: it keeps the id and the frame it had. Only the watcher,
  // which does not hold the moved scan, reacts to them, and it deletes no row of the renamed scan.
  assert.equal(tab1.sessionId, oldId)
  assert.ok(tab1.getCapture(scanFrame.captureId), 'tab 1 still holds its frame in memory')
  const reloaded = await openStore()
  assert.equal(await reloaded.loadSession(server(4)), true)
  assert.equal(reloaded.getCapture(scanFrame.captureId)?.sessionId, server(4), 'the renamed frame is still stored, under the new id')
})

// ── Erase order and guards (STORE5-3 to STORE5-9) ───────────────────────────

test('an erase: a listener notified during it cannot take back the id being erased', async () => {
  const store = await openStore()
  const id = server(5)
  await store.adoptServerSession(id)
  await store.upsert(one('chair:0', detection('chair')), new Map())
  assert.deepEqual(idb.keys('sessions'), [id])

  let readopted: Promise<void> | undefined
  const unsubscribe = store.subscribe(() => {
    // The erase notifies with the live id already cleared. Adopting the same id from here must be refused.
    if (store.sessionId === '') readopted = store.adoptServerSession(id)
  })
  await store.deleteSession(id)
  unsubscribe()
  await readopted

  assert.equal(store.sessionId, '', 'the id being erased is not taken back')
  await store.saveSnapshot()
  await store.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back under the erased id')
  assert.equal(store.detections.size, 0)
})

test('a read still in flight when its session is erased does not bring the frame back', needsChannel, async () => {
  const writer = await openStore()
  await writer.upsert(one('chair:0', detection('chair')), new Map())
  const erased = writer.sessionId
  const late = await writer.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const reader = await openStore()
  assert.ok(reader.getCapture(late.captureId), 'the reader holds the frame')
  // A second read of the captures, answered only after the erase has reached the reader.
  const read = idb.hold('captures', 'getAll')
  const reopening = reader.open()
  await read.issued
  await writer.deleteSession(erased)
  await until(() => reader.getCapture(late.captureId) === undefined, 'the reader to drop the erased frame')
  read.release()
  await reopening

  assert.equal(reader.getCapture(late.captureId), undefined, 'the reply to the read made before the erase does not bring it back')
  assert.deepEqual(idb.keys('captures'), [])
})

test('a failed erase does not bring back a scan that another tab erased meanwhile', needsChannel, async () => {
  // Another session's frame, held by the failing tab. The last message below is that session's erase.
  const sentinel = await openStore()
  await sentinel.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const sentinelId = sentinel.sessionId
  const sentinelFrame = await sentinel.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const failing = await openStore()
  await failing.upsert(one('chair:0', detection('chair')), new Map())
  const erased = failing.sessionId
  assert.ok(failing.getCapture(sentinelFrame.captureId))

  const other = await openStore()
  assert.equal(await other.loadSession(erased), true)

  // The failing tab's delete is the next one on sessions. It fails, and its reply is held until the other tab has erased.
  idb.failNextSessionDelete()
  const releaseReply = idb.holdNextReply('sessions', 'delete')
  const failedErase = failing.deleteSession(erased)

  await other.deleteSession(erased)
  await sentinel.deleteSession(sentinelId)
  await until(() => failing.getCapture(sentinelFrame.captureId) === undefined, 'the failing tab to handle the last message')
  releaseReply()

  await assert.rejects(failedErase, /simulated delete failure/)
  assert.equal(failing.sessionId, '', 'the id another tab erased is not brought back')
  assert.equal(failing.detections.size, 0)
  await failing.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written under the erased id')
})

test('an erase: a listener that throws does not reject the save that finds the record gone', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const erasing = await openStore()
  await erasing.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasing.sessionId
  const other = await openStore()
  assert.equal(await other.loadSession(erased), true)
  await erasing.deleteSession(erased)

  other.subscribe(() => {
    if (other.sessionId === '') throw new Error('listener failed')
  })
  // Whether or not the erase message has been handled yet, this save finds the record gone and clears the scan.
  await other.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.equal(other.sessionId, '')
  await other.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
})

test('an erase: a listener that throws while the erase arrives by message is reported, not thrown', needsChannel, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const erasing = await openStore()
  await erasing.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasing.sessionId
  const other = await openStore()
  assert.equal(await other.loadSession(erased), true)
  other.subscribe(() => {
    if (other.sessionId === '') throw new Error('listener failed')
  })

  await erasing.deleteSession(erased)
  await until(() => other.sessionId === '', 'the other tab to drop the erased session')
  await other.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
})

test('a runtime whose BroadcastChannel will not open still runs the store', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  class RefusingChannel {
    constructor() {
      throw new Error('channel refused')
    }
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: RefusingChannel, configurable: true, writable: true })
  try {
    const store = await openStore()
    await store.upsert(one('chair:0', detection('chair')), new Map())
    const erased = store.sessionId
    await store.deleteSession(erased)
    await store.saveSnapshot()
    assert.deepEqual(idb.keys('sessions'), [], 'the erase holds in this tab')
    assert.equal(store.sessionId, '')
  } finally {
    if (saved) Object.defineProperty(globalThis, 'BroadcastChannel', saved)
  }
})

test('clearing a session takes every frame out of memory before anything is awaited', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const first = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  const second = await store.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  // Hold the walk over the captures store, so the row deletes are still in flight when clear() returns.
  const walk = idb.hold('captures', 'openCursor')
  const clearing = store.clear()
  assert.equal(store.getCapture(first.captureId), undefined, 'the first frame is out of memory')
  assert.equal(store.getCapture(second.captureId), undefined, 'so is the second, which a loop that awaits each delete has not reached yet')
  walk.release()
  await clearing
  assert.deepEqual(idb.keys('captures'), [])
})

test('an erase removes a frame another tab wrote after this tab opened', async () => {
  const eraser = await openStore() // opened before the frame exists
  const writer = await openStore()
  await writer.upsert(one('chair:0', detection('chair')), new Map())
  const erased = writer.sessionId
  assert.equal(await eraser.loadSession(erased), true)
  const late = await writer.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.equal(eraser.getCapture(late.captureId), undefined, 'the eraser never loaded the frame')

  await eraser.deleteSession(erased)
  assert.deepEqual(idb.keys('sessions'), [])
  assert.deepEqual(idb.keys('captures'), [], 'the frame goes with the session')
})

test('a failed erase keeps the record and its frames together', async () => {
  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const capture = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  const erased = store.sessionId

  idb.failNextSessionDelete()
  const releaseReply = idb.holdNextReply('sessions', 'delete')
  const erasing = store.deleteSession(erased)
  // The frame's row goes inside the erase's transaction, before the failure is reported.
  await until(() => idb.keys('captures').length === 0, 'the frame row to go inside the transaction')
  releaseReply()

  await assert.rejects(erasing, /simulated delete failure/)
  assert.deepEqual(idb.keys('sessions'), [erased])
  assert.deepEqual(idb.keys('captures'), [capture.captureId], 'the abort puts the frame row back')
  assert.ok(store.getCapture(capture.captureId), 'and the frame is held in memory again')
  assert.equal(store.sessionId, erased)
})
