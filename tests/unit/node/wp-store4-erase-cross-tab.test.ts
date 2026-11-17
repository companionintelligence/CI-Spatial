/**
 * DetectionStore — an erase holds in every tab on the origin (wave 4, STORE4-2).
 *
 * Two stores in one process stand for two tabs. They share one fake IndexedDB,
 * and Node's BroadcastChannel stands in for the one a browser gives the tabs.
 * A message reaches the other store on a later turn, so a test waits for it
 * wherever the assertion depends on it, and also covers a write that comes
 * before the message does.
 *
 * The fake is a copy of the one in wp-store-erase.test.ts. tests/unit/node has
 * no shared helper modules, so each file keeps its own.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store4-erase-cross-tab.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

/** The channel name src/scene/store.ts announces erases on. */
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

/** A tab: a store opened over the shared database. */
async function openStore(): Promise<DetectionStore> {
  const store = new DetectionStore()
  await store.open()
  return store
}

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

function frame(bytes = 8): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Cases that need the channel to deliver a message skip where the runtime has no
 * BroadcastChannel. The write-back and no-channel cases run either way.
 */
const needsChannel = typeof BroadcastChannel === 'undefined' ? { skip: 'BroadcastChannel is absent in this runtime' } : {}

/** Wait for a condition that only a delivered message can make true. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await delay(5)
  }
  assert.fail('timed out waiting for ' + what)
}

test('an erase in one tab stops another tab writing the record back, even before the message lands', async () => {
  const erasingTab = await openStore()
  await erasingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasingTab.sessionId
  const otherTab = await openStore()
  assert.equal(await otherTab.loadSession(erased), true)

  await erasingTab.deleteSession(erased)
  // No wait: the other tab writes in the same turn, before its broadcast can arrive.
  await otherTab.upsert(one('lamp:1', detection('lamp', 1)), new Map())

  assert.deepEqual(idb.keys('sessions'), [], 'the erased record is not written back')
  assert.equal(otherTab.sessionId, '', 'the write that found the record gone clears the scan')
  assert.equal(otherTab.detections.size, 0)
})

test('an erase in one tab clears the scan of another tab once the message lands', needsChannel, async () => {
  const erasingTab = await openStore()
  await erasingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasingTab.sessionId
  const otherTab = await openStore()
  assert.equal(await otherTab.loadSession(erased), true)

  await erasingTab.deleteSession(erased)
  await until(() => otherTab.sessionId === '', 'the other tab to drop the erased session')

  await otherTab.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  await otherTab.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [], 'the other tab does not write the erased record back')
  assert.equal(otherTab.detections.size, 0)
})

test('the other tab drops the erased session\'s frames from memory', needsChannel, async () => {
  const erasingTab = await openStore()
  await erasingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasingTab.sessionId
  const capture = await erasingTab.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const otherTab = await openStore()
  assert.ok(otherTab.getCapture(capture.captureId), 'the other tab loaded the frame')

  await erasingTab.deleteSession(erased)
  await until(() => otherTab.getCapture(capture.captureId) === undefined, 'the frame to leave the other tab')
  assert.equal(otherTab.captures.size, 0)
  assert.deepEqual(idb.keys('captures'), [])
})

test('a tab holding another session live is not disturbed by the erase', needsChannel, async () => {
  const erasingTab = await openStore()
  await erasingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasingTab.sessionId
  // A frame of the erased session, so the other tab has something the erase removes and the wait below can see.
  const frameOfErased = await erasingTab.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const otherTab = await openStore()
  await otherTab.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const own = otherTab.sessionId
  assert.notEqual(own, erased)
  assert.ok(otherTab.getCapture(frameOfErased.captureId), 'the other tab holds the frame of the erased session')

  await erasingTab.deleteSession(erased)
  // The frame leaving the other tab shows that the erase message has been handled there.
  await until(() => otherTab.getCapture(frameOfErased.captureId) === undefined, 'the other tab to drop the erased frame')
  assert.equal(otherTab.sessionId, own)
  assert.ok(otherTab.detections.has('lamp:1'))

  await otherTab.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [own])
})

test('an erase by a tab that does not hold the session still clears it in the tab that does', needsChannel, async () => {
  const creatingTab = await openStore()
  await creatingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = creatingTab.sessionId

  const holdingTab = await openStore()
  assert.equal(await holdingTab.loadSession(erased), true)

  const elsewhere = await openStore()
  await elsewhere.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.notEqual(elsewhere.sessionId, erased)

  await elsewhere.deleteSession(erased)
  await until(() => holdingTab.sessionId === '', 'the holding tab to drop the session')

  await holdingTab.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [elsewhere.sessionId], 'only the other session is stored')
})

test('a load in another tab that read the record before the erase does not adopt it', needsChannel, async () => {
  const erasingTab = await openStore()
  await erasingTab.upsert(one('chair:0', detection('chair')), new Map())
  const erased = erasingTab.sessionId

  const otherTab = await openStore()
  assert.equal(await otherTab.loadSession(erased), true)

  // A second load, whose read is made before the erase and answered after the other tab hears of it.
  const release = idb.holdNextReply('sessions', 'getAll')
  const reloading = otherTab.loadSession(erased)
  await erasingTab.deleteSession(erased)
  await until(() => otherTab.sessionId === '', 'the other tab to drop the erased session')
  release()

  assert.equal(await reloading, false)
  await otherTab.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
})

test('a boot that read the record before another tab erased it does not resume it', needsChannel, async () => {
  const olderTab = await openStore()
  await olderTab.upsert(one('chair:0', detection('chair')), new Map())
  const older = olderTab.sessionId
  await delay(5) // a later startedAt, so the newer session sorts first

  const newerTab = await openStore()
  await newerTab.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const newer = newerTab.sessionId
  // A frame of the newer session, so the booting tab holds something its erase removes, and the wait below can see it.
  const frameOfNewer = await newerTab.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const booting = new DetectionStore()
  await booting.open()
  assert.ok(booting.getCapture(frameOfNewer.captureId), 'the booting tab loaded the newer frame')
  // The boot's read is made while both records exist; its reply arrives after the newer one is erased.
  const release = idb.holdNextReply('sessions', 'getAll')
  const resuming = booting.resumeLatestSession()
  await newerTab.deleteSession(newer)
  // The frame leaving the booting tab shows that the erase message has been handled before the reply is released.
  await until(() => booting.getCapture(frameOfNewer.captureId) === undefined, 'the booting tab to drop the erased frame')
  release()

  assert.equal(await resuming, 1, 'the older session is resumed')
  assert.equal(booting.sessionId, older)
  assert.deepEqual(idb.keys('sessions'), [older])
})

test('a stray message on the erase channel does not touch the live scan', needsChannel, async () => {
  // Another session's frame, loaded here, so the last message below has an effect to wait for.
  const elsewhere = await openStore()
  await elsewhere.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const other = elsewhere.sessionId
  await elsewhere.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const store = await openStore()
  await store.upsert(one('chair:0', detection('chair')), new Map())
  const live = store.sessionId
  assert.equal(store.captures.size, 1, 'the store holds the other session\'s frame')

  const stray = new BroadcastChannel(ERASE_CHANNEL_NAME)
  stray.postMessage(42)
  stray.postMessage('')
  stray.postMessage({ sessionId: live })
  stray.postMessage(new String(live)) // a non-string that matches the live id: the typeof guard must refuse it
  stray.postMessage([live])
  // The last message is a real erase of the other session. Messages on one channel arrive in order,
  // so once that frame has left this store, every stray message before it has been handled.
  stray.postMessage(other)
  await until(() => store.captures.size === 0, 'the store to handle the last message')
  stray.close()

  assert.equal(store.sessionId, live)
  assert.ok(store.detections.has('chair:0'))
})

test('with no BroadcastChannel the erase still holds in this tab', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  Reflect.deleteProperty(globalThis, 'BroadcastChannel')
  try {
    assert.equal(typeof BroadcastChannel, 'undefined')
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
