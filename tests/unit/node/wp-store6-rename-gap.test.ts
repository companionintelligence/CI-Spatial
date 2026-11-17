/**
 * DetectionStore — the rename gap of wave 6 (STORE6), under the single-writer rule of wave 7 (STORE7).
 * A save that finds its record gone because another tab renamed the scan, before this tab
 * has handled the rename message.
 *
 * Tab 1 is live on a local session. Tab 2 renames it to the server's id, and tab 1 writes
 * in the gap, then saves. The save finds the scan moved, so tab 1 is superseded: the save is
 * refused and the renamer's state is what survives. The cases after it keep the other
 * guarantees: a genuine erase by another tab still clears this tab and refuses the id, a
 * session erased here stays erased, and a record with another start time is never adopted.
 * The assertions are on outcomes, not on the path taken to reach them.
 *
 * Stores in one process stand for tabs, as in wp-store5-rename-erase.test.ts. The fake
 * IndexedDB is the same copy as in the other wp-store files. tests/unit/node has no shared
 * helper modules.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store6-rename-gap.test.ts
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

/** A server-minted id, the only kind adoptServerSession takes. Each case takes its own number. */
const server = (n: number) => 'sess-store6-' + String(n).padStart(4, '0')

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every case has a ceiling, so a save that never settles fails its case instead of hanging the file. */
const ceiling = { timeout: 15000 }

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

/** Resolves once a held request is made. Fails, rather than hanging, when it never is. */
async function issued(hold: Hold, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for ' + what)), 2000)
  })
  try {
    await Promise.race([hold.issued, timeout])
  } finally {
    clearTimeout(timer)
  }
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

/**
 * Tab 2 renames the scan it holds to `to`, with the reply to the old record's delete held.
 * Once this resolves, the old record is gone and the renamed one is on disk, while tab 1
 * has not heard of the rename. The returned function lets the rename finish and announce.
 */
async function startRenameGap(tab2: DetectionStore, to: string): Promise<() => Promise<void>> {
  const deleteReply = idb.hold('sessions', 'delete')
  const adopting = tab2.adoptServerSession(to)
  await issued(deleteReply, 'the old record to be deleted')
  return async () => {
    deleteReply.release()
    await adopting
  }
}

/**
 * The rename gap, in the forced order of the scratch reproduction. Tab 1 is live on `scan`,
 * tab 2 renames it, and tab 1 writes in the gap and saves, all before the rename message is
 * handled. The save finds its scan moved, so tab 1 is superseded: the save is refused, and
 * the renamer's state is what survives. With a channel, a marker sent after the rename shows
 * that the rename has had its chance to reach tab 1. Without one, no message is sent at all.
 */
async function renameGap(withChannel: boolean): Promise<void> {
  const other = await openStore()
  await other.upsert(one('lamp:9', detection('lamp', 9)), new Map())
  const otherId = other.sessionId
  const otherFrame = await other.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const scan = tab1.sessionId
  const before = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(scan), true)
  const renamed = server(1)
  const finishRename = await startRenameGap(tab2, renamed)

  // In the gap: a frame under the old id, then a save that finds the old record gone.
  const inGap = await tab1.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  // The rule (STORE7-1): the save finds its scan moved to the renamed record, so tab 1 is superseded and the save
  // is refused. The edit may still show in tab 1's memory, which keeps what it had, but nothing is written.
  assert.equal(await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false, 'the save in the gap is refused')
  assert.equal(tab1.isSuperseded, true, 'tab 1 is superseded')
  assert.equal(tab1.sessionId, scan, 'tab 1 keeps the id it had')
  assert.ok(tab1.detections.has('chair:0'), 'tab 1 still shows what it had')
  assert.equal(tab1.getCapture(before.captureId)?.sessionId, scan)

  await finishRename()
  if (withChannel) {
    // The rename is posted before this marker, and `other` holds the marker's session live. The marker erases
    // it there, so that effect is the wait. Tab 1, superseded already, ignores the rename and the marker alike.
    const stray = new BroadcastChannel(ERASE_CHANNEL_NAME)
    try {
      stray.postMessage(otherId)
      await until(() => other.sessionId === '', 'the other tab to handle the marker')
    } finally {
      stray.close()
    }
  }
  // The rule: a superseded tab ignores a rename that arrives late, so it stays as the save left it.
  assert.equal(tab1.sessionId, scan, 'a rename that arrives late leaves the superseded tab as it was')
  assert.equal(await tab1.saveSnapshot(), false, 'and its later saves are refused too')

  const reloaded = await openStore()
  assert.equal(await reloaded.loadSession(renamed), true)
  assert.equal(reloaded.sessionId, renamed)
  assert.ok(reloaded.detections.has('chair:0'), 'the renamer keeps its detection')
  assert.ok(!reloaded.detections.has('lamp:1'), 'the edit made in the gap is refused, so it is not in the renamed record')
  assert.equal(reloaded.getCapture(before.captureId)?.sessionId, renamed, 'the renamer keeps its frame, under the new id')
  // The frame written in the gap was written under the old id, before tab 1 learnt of the move. The renaming tab
  // does not re-key it, so it stays under the old id and is not part of the renamed scan.
  assert.equal(reloaded.getCapture(inGap.captureId)?.sessionId, scan, 'the gap frame is stored, under the id it was written under, and is not carried into the renamed scan')
  assert.ok(idb.keys('sessions').includes(renamed), 'the scan is stored under the new id')
  assert.ok(!idb.keys('sessions').includes(scan), 'the old id has no record left, and no save writes it back')
}

// ── The rename gap (STORE6-1, STORE6-3) ─────────────────────────────────────

test('the rename gap: a save that finds its scan moved is refused, and the renamer keeps its state', { ...ceiling, ...needsChannel }, () => renameGap(true))

test('the rename gap without the channel: the same outcome, with no message at all', ceiling, () => withoutChannel(() => renameGap(false)))

// ── Every other guarantee of the erase path (STORE6-4) ──────────────────────

test('a genuine erase by another tab clears this tab, and nothing is written back for that id', ceiling, () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const erased = tab1.sessionId
  const kept = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(erased), true)
  await tab2.deleteSession(erased)

  // Tab 1 finds its record gone. No renamed record has its start time, so the save erases the scan here.
  await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.equal(tab1.sessionId, '')
  assert.equal(tab1.detections.size, 0)
  assert.equal(tab1.getCapture(kept.captureId), undefined)

  // Refused from now on: a save writes nothing under the id, and a load of it is refused.
  await tab1.saveSnapshot()
  assert.equal(await tab1.loadSession(erased), false)
  assert.deepEqual(idb.keys('sessions'), [])
  assert.deepEqual(idb.keys('captures'), [])
}))

test('a renamed scan that another tab then erased is not brought back by a stale save', ceiling, () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const scan = tab1.sessionId
  const kept = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(scan), true)
  const renamed = server(3)
  await tab2.adoptServerSession(renamed)
  await tab2.deleteSession(renamed) // the genuine erase of the renamed scan
  assert.deepEqual(idb.keys('sessions'), [])

  // Tab 1 has heard of no rename. Its save finds nothing with its start time and erases the scan here.
  await tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  assert.equal(tab1.sessionId, '')
  assert.equal(tab1.detections.size, 0)
  assert.equal(tab1.getCapture(kept.captureId), undefined)

  await tab1.saveSnapshot()
  // The scan was moved to the renamed id, and then the other tab erased that id. Tab 1 never heard of the move
  // (the listing found nothing), so nothing loads under the renamed id here.
  assert.equal(await tab1.loadSession(renamed), false, 'the scan was moved and then erased by the other tab, so nothing loads under the renamed id')
  assert.deepEqual(idb.keys('sessions'), [])
  assert.deepEqual(idb.keys('captures'), [])
}))

test('a session erased in this tab stays erased, even when the lookup read still lists it', ceiling, () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const scan = tab1.sessionId
  const kept = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(scan), true)
  const renamed = server(4)
  const finishRename = await startRenameGap(tab2, renamed)

  // Tab 1's save reads the sessions store, and that reply is held. The read lists the renamed record.
  const listed = idb.hold('sessions', 'getAll')
  const saving = tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  await issued(listed, 'the lookup read to be made')
  // This tab erases the renamed record while that reply is held, so the reply lists a record this tab has erased.
  await tab1.deleteSession(renamed)
  listed.release()
  await saving
  await finishRename()

  assert.equal(tab1.sessionId, '', 'the scan is not taken to a renamed id this tab erased, so it is cleared here')
  assert.equal(tab1.detections.size, 0)
  assert.equal(tab1.getCapture(kept.captureId), undefined)

  await tab1.saveSnapshot()
  assert.equal(await tab1.loadSession(renamed), false, 'the erased id stays refused')
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back under the renamed id')
  assert.deepEqual(idb.keys('captures'), [])
}))

test('the rename gap: an erase by a third tab after the lookup read clears the scan here, and leaves no frame behind', ceiling, () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const scan = tab1.sessionId
  const kept = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(scan), true)
  const renamed = server(5)
  const finishRename = await startRenameGap(tab2, renamed)
  const inGap = await tab1.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })

  // The lookup read is held, so the answer it gives is the renamed record, as it was when read.
  const listed = idb.hold('sessions', 'getAll')
  const saving = tab1.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  await issued(listed, 'the lookup read to be made')
  // A third tab erases the renamed scan after the read and before tab 1 decides what to do with it.
  const tab3 = await openStore()
  assert.equal(await tab3.loadSession(renamed), true)
  await tab3.deleteSession(renamed)
  listed.release()
  await saving
  await finishRename()

  assert.equal(tab1.sessionId, '', 'the erase by the third tab clears this tab too')
  assert.equal(tab1.detections.size, 0)
  assert.equal(tab1.getCapture(kept.captureId), undefined)
  assert.equal(tab1.getCapture(inGap.captureId), undefined)
  await until(() => idb.keys('captures').length === 0, 'the frame rows of the erased scan to go')
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back under the renamed id')

  await tab1.saveSnapshot()
  assert.deepEqual(idb.keys('sessions'), [])
}))

test('a renamed record with another start time is never adopted', ceiling, () => withoutChannel(async () => {
  const tab1 = await openStore()
  await tab1.upsert(one('chair:0', detection('chair')), new Map())
  const scan = tab1.sessionId
  const kept = await tab1.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })

  // A later scan, renamed by a third tab. Its start time differs from tab 1's scan.
  while (Date.now() === tab1.startedAt) await delay(1)
  const tab3 = await openStore()
  await tab3.upsert(one('lamp:1', detection('lamp', 1)), new Map())
  const tab3Local = tab3.sessionId
  assert.notEqual(tab3.startedAt, tab1.startedAt)
  const other = server(6)
  await tab3.adoptServerSession(other)
  assert.ok(idb.keys('sessions').includes(other), 'the other scan is stored under its server id')
  assert.ok(!idb.keys('sessions').includes(tab3Local), 'and its local record is gone')

  // A second tab erases tab 1's scan for real. The only server record left has another start time.
  const tab2 = await openStore()
  assert.equal(await tab2.loadSession(scan), true)
  await tab2.deleteSession(scan)

  await tab1.upsert(one('chair:9', detection('chair', 9)), new Map())
  assert.equal(tab1.sessionId, '', 'the scan is erased here, not adopted from the other record')
  assert.equal(tab1.detections.size, 0)
  assert.equal(tab1.getCapture(kept.captureId), undefined)
  assert.deepEqual(idb.keys('sessions'), [other], 'the other scan is left as it was')

  const reloaded = await openStore()
  assert.equal(await reloaded.loadSession(other), true)
  assert.equal(reloaded.sessionId, other)
  assert.ok(reloaded.detections.has('lamp:1'), 'the other scan keeps its own detections')
  assert.ok(!reloaded.detections.has('chair:9'))
}))
