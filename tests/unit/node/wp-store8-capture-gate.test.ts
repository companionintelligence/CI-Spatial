/**
 * DetectionStore — every capture-row write and delete is gated on the move (wave 8, STORE8).
 *
 * A rename moves a scan to the server's id and re-keys its frame rows to it, and the renaming tab is
 * then the only writer of those rows. A tab that still held the old id, and had not heard of the move,
 * used to keep writing them: a stale markCaptureFailed or discardFrame put a row back under the old id,
 * and a stale eviction deleted one. Now each write of a frame row after the frame is taken, each eviction
 * delete, and the re-key a rename makes, reads the stored row in the same readwrite transaction. A row under
 * another session id is left as it is, the write or delete is refused, and a row that shows the move
 * supersedes the tab. A row that does not exist yet is written.
 *
 * The first cases are the store7 review probes (P1, P1b, P1c, P3, P4), made into assertions. The put
 * path, a renamer that keeps writing its own frames, and a frame of an earlier session that the budget
 * still releases come next. Then a stale tab's own move of a scan another tab has moved is undone, and
 * the last case is a second move of a superseded tab (STORE8-2).
 *
 * Two stores in one process stand for two tabs, as in wp-store7-superseded-tab.test.ts. This file keeps
 * its own copy of that fake IndexedDB, with one change: a key query on an object store answers with that
 * row alone, as IndexedDB does, so the 512-frame case stays quick.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-store8-capture-gate.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore, MAX_CAPTURE_ITEMS } from '../../../src/scene/store.ts'
import type { CaptureRecord } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

type Row = Record<string, unknown>

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
  /** Copies of the rows now in an object store, for checking what a write left behind. */
  rows(storeName: string): Row[]
}

/**
 * Just enough IndexedDB for DetectionStore. A request takes effect when it is made and reports on a
 * later task, as the real API does. A transaction commits once its requests have all reported. A
 * request that fails aborts it, and the writes it made are undone. Every open() shares the same data,
 * so a second store reads what the first one wrote, the way a reload does. Records are copied in and
 * out, so no store can reach another store's objects.
 */
function fakeIndexedDB(): FakeIndexedDB {
  const stores = new Map<string, Map<unknown, Row>>()

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
      const before = rows.get(key)
      tx.undo.push(() => {
        if (before) rows.set(key, before)
        else rows.delete(key)
      })
      if (next) rows.set(key, next)
      else rows.delete(key)
    }
    return {
      put: (record: Row) => request(tx, () => {
        const copy = structuredClone(record)
        write(copy[keyPath], copy)
        return copy[keyPath]
      }),
      getAll: () => request(tx, () => [...rows.values()].map((row) => structuredClone(row))),
      count: (key: unknown) => request(tx, () => (rows.has(key) ? 1 : 0)),
      delete: (key: unknown) => request(tx, () => write(key, null)),
      openCursor: (query?: unknown) => openCursor(tx, rows, write, query),
    }
  }

  /**
   * A cursor over one object store. With a key query it answers with that row alone, or with no row,
   * as IndexedDB does. Without one it walks every row, one step per reply.
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
    // The first step is a request like any other.
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

  return {
    factory,
    keys: (name: string) => [...(stores.get(name)?.keys() ?? [])],
    rows: (name: string) => [...(stores.get(name)?.values() ?? [])].map((row) => structuredClone(row)),
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
const server = (n: number) => 'sess-store8-' + String(n).padStart(4, '0')

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

/**
 * A stale tab and a renamer over one scan: the stale tab holds the scan under its local id, the
 * renamer loads it and moves it to the server id. The stale tab has not heard of the move.
 */
async function staleAndRenamer(captures: Array<{ index: number, blob: Blob }>, to: number): Promise<{
  stale: DetectionStore
  renamer: DetectionStore
  oldId: string
  held: CaptureRecord[]
}> {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const held: CaptureRecord[] = []
  for (const c of captures) {
    const rec = await stale.putCapture({ captureIndex: c.index, timestamp: Date.now(), pose: pose(), blob: c.blob })
    assert.ok(rec)
    held.push(rec)
  }
  const renamer = await openStore()
  assert.equal(await renamer.loadSession(oldId), true)
  await renamer.adoptServerSession(server(to))
  return { stale, renamer, oldId, held }
}

// ── A stale write to a renamed frame row is refused (STORE8-1) ──────────────

test('(P1) a stale markCaptureFailed is refused: the renamed frame keeps its row, and the stale tab is superseded', async () => withoutChannel(async () => {
  const { stale, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 21)
  assert.ok(frameRow)
  const rowsBefore = rowsOf('captures')

  // The stale tab has not heard of the move. Its write finds the row under the renamed id, and is refused.
  assert.equal(await stale.markCaptureFailed(frameRow.captureId, 'inference failed'), false)
  assert.equal(stale.isSuperseded, true, 'the refused write shows the move, so the stale tab is superseded')
  assert.deepEqual(rowsOf('captures'), rowsBefore, 'no frame row is written, re-keyed or deleted')
  assert.equal(stale.getCapture(frameRow.captureId)?.status, 'pending', 'the stale tab keeps its record as it was')
  assert.equal(stale.getCapture(frameRow.captureId)?.error, undefined)

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal(reloaded.sessionId, server(21))
  const kept = reloaded.getCapture(frameRow.captureId)
  assert.equal(kept?.sessionId, server(21), 'the renamed frame stays under the renamed id')
  assert.equal(kept?.status, 'pending', 'and it is not marked failed')
  assert.ok(kept?.blob, 'and it is still held')
}))

test('a stale attachDetections is refused: the renamed frame stays pending with no detections attached', async () => withoutChannel(async () => {
  const { stale, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 25)
  assert.ok(frameRow)
  const rowsBefore = rowsOf('captures')

  assert.equal(await stale.attachDetections(frameRow.captureId, ['chair:0']), false)
  assert.equal(stale.isSuperseded, true)
  assert.deepEqual(rowsOf('captures'), rowsBefore, 'the renamed row is as the renamer left it')
  assert.equal(stale.getCapture(frameRow.captureId)?.status, 'pending', 'the stale tab keeps its record as it was')
  assert.deepEqual(stale.getCapture(frameRow.captureId)?.detectionKeys, [])

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal(reloaded.getCapture(frameRow.captureId)?.status, 'pending')
  assert.deepEqual(reloaded.getCapture(frameRow.captureId)?.detectionKeys, [])
}))

test('(P1b) a stale discardFrame is refused: the renamed photo is kept, and the stale tab keeps the frame it held', async () => withoutChannel(async () => {
  const { stale, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 24)
  assert.ok(frameRow)
  const rowsBefore = rowsOf('captures')

  assert.equal(await stale.discardFrame(frameRow.captureId, 'quality'), false)
  assert.equal(stale.isSuperseded, true)
  assert.deepEqual(rowsOf('captures'), rowsBefore, 'the renamer\'s row still holds its photo')
  assert.ok(stale.getCapture(frameRow.captureId)?.blob, 'the stale tab keeps the frame it held')
  assert.equal(stale.getCapture(frameRow.captureId)?.frameDropped, undefined)

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  const kept = reloaded.getCapture(frameRow.captureId)
  assert.equal(kept?.sessionId, server(24))
  assert.ok(kept?.blob, 'the renamed scan still has its photo after a reload')
  assert.equal(kept?.frameDropped, undefined)
}))

test('(P1c) with the channel, a stale markCaptureFailed after the move is refused, and the tab stays superseded', { ...needsChannel, timeout: 15000 }, async () => {
  const { stale, renamer, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 22)
  assert.ok(frameRow)
  const rowsBefore = rowsOf('captures')

  // The move may reach the stale tab by the message or by the refused write, whichever comes first.
  assert.equal(await stale.markCaptureFailed(frameRow.captureId, 'inference failed'), false)
  assert.equal(stale.isSuperseded, true)
  await delay(50)
  assert.equal(stale.isSuperseded, true, 'and the message that follows does not undo it')
  assert.deepEqual(rowsOf('captures'), rowsBefore)
  assert.equal(renamer.getCapture(frameRow.captureId)?.status, 'pending')
  assert.equal(stale.getCapture(frameRow.captureId)?.status, 'pending')
})

test('a stale putCapture that would overwrite a renamed frame is refused, and the stale tab keeps the frame it had', async () => withoutChannel(async () => {
  const { stale, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 23)
  assert.ok(frameRow)
  const rowsBefore = rowsOf('captures')

  // The same capture index names the frame already moved, so the new record would land on its row.
  assert.equal(await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() }), false)
  assert.equal(stale.isSuperseded, true)
  assert.deepEqual(rowsOf('captures'), rowsBefore, 'the renamed row is untouched')
  assert.equal(stale.getCapture(frameRow.captureId), frameRow, 'the stale tab keeps the frame it had, not the refused one')
}))

// ── Eviction never releases or deletes a renamed row (STORE8-1) ─────────────

test('(P3) a stale tab\'s byte-budget release is refused, and the renamer\'s moved photo is kept', async () => withoutChannel(async () => {
  const big = () => new Blob([new Uint8Array(24 * 1024 * 1024)], { type: 'image/jpeg' })
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const first = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: big() })
  assert.ok(first)
  assert.equal(await stale.attachDetections(first.captureId, ['chair:0']), true, 'the frame is attached before the move')

  const renamer = await openStore()
  assert.equal(await renamer.loadSession(oldId), true)
  await renamer.adoptServerSession(server(41))
  assert.equal(renamer.getCapture(first.captureId)?.sessionId, server(41))

  await stale.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: big() })
  await stale.putCapture({ captureIndex: 3, timestamp: Date.now(), pose: pose(), blob: big() })
  assert.equal(stale.isSuperseded, true, 'the refused release showed the move')
  assert.ok(stale.getCapture(first.captureId)?.blob, 'the stale tab keeps the frame it held')

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal(reloaded.sessionId, server(41))
  const kept = reloaded.getCapture(first.captureId)
  assert.equal(kept?.sessionId, server(41))
  assert.ok(kept?.blob, 'the renamed photo is still held')
  assert.equal(kept?.frameDropped, undefined)
  assert.equal(kept?.status, 'inferred')
}))

test('(P4) a stale tab\'s item-cap eviction does not delete the renamer\'s moved capture row', { timeout: 60000 }, async () => withoutChannel(async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const first = await stale.putCapture({ captureIndex: 0, timestamp: Date.now() - 1000, pose: pose(), blob: frame() })
  assert.ok(first)
  assert.equal(await stale.attachDetections(first.captureId, ['chair:0']), true)
  for (let i = 1; i < MAX_CAPTURE_ITEMS; i++) {
    const rec = await stale.putCapture({ captureIndex: i, timestamp: Date.now(), pose: pose(), blob: frame() })
    assert.ok(rec)
    assert.equal(await stale.attachDetections(rec.captureId, []), true)
  }
  assert.equal(stale.captures.size, MAX_CAPTURE_ITEMS)

  const renamer = await openStore()
  assert.equal(await renamer.loadSession(oldId), true)
  await renamer.adoptServerSession(server(42))
  // One more capture takes the stale tab over the item cap, and its oldest inferred record is the moved one.
  const extra = await stale.putCapture({ captureIndex: MAX_CAPTURE_ITEMS, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(extra)
  assert.equal(stale.isSuperseded, true, 'the refused delete showed the move')
  assert.equal(stale.captures.size, MAX_CAPTURE_ITEMS + 1, 'the stale tab keeps every record it held, the moved one included')
  assert.ok(stale.getCapture(first.captureId), 'the moved record stays in the stale tab\'s memory')

  assert.ok(idb.keys('captures').includes(first.captureId), 'the renamer\'s row is not deleted')
  assert.equal(idb.rows('captures').filter((r) => r.sessionId === server(42)).length, MAX_CAPTURE_ITEMS, 'every renamed row is still there')

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal([...reloaded.captures.values()].filter((c) => c.sessionId === server(42)).length, MAX_CAPTURE_ITEMS)
  assert.equal(reloaded.getCapture(first.captureId)?.status, 'inferred')
}))

// ── The writer of the renamed rows is not refused by its own rows ───────────

test('the renamer keeps writing its own frames after the move, so its rows are not refused', async () => withoutChannel(async () => {
  const { renamer, held: [frameRow] } = await staleAndRenamer([{ index: 1, blob: frame() }], 26)
  assert.ok(frameRow)

  assert.equal(await renamer.attachDetections(frameRow.captureId, ['chair:0']), true)
  const later = await renamer.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(later)
  assert.equal(await renamer.discardFrame(frameRow.captureId, 'quality'), true)
  assert.equal(renamer.isSuperseded, false)

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal(reloaded.getCapture(frameRow.captureId)?.status, 'inferred')
  assert.equal(reloaded.getCapture(frameRow.captureId)?.frameDropped, 'quality')
  assert.equal(reloaded.getCapture(later.captureId)?.sessionId, server(26), 'a frame taken after the move is stored under the renamed id')
}))

test('a frame of a session this tab is no longer live on is still released by the byte budget, since its row still carries that id', async () => withoutChannel(async () => {
  const big = () => new Blob([new Uint8Array(24 * 1024 * 1024)], { type: 'image/jpeg' })
  const earlier = await openStore()
  await earlier.upsert(one('chair:0', detection('chair')), new Map())
  const earlierId = earlier.sessionId
  const old = await earlier.putCapture({ captureIndex: 1, timestamp: Date.now() - 1000, pose: pose(), blob: big() })
  assert.ok(old)
  assert.equal(await earlier.attachDetections(old.captureId, ['chair:0']), true)

  // This tab moves on to another scan on the same origin. Nothing was moved, so the earlier frame is still its own.
  const other = await openStore()
  await other.upsert(one('lamp:9', detection('lamp', 9)), new Map())
  assert.equal(await earlier.loadSession(other.sessionId), true)
  assert.equal(earlier.sessionId, other.sessionId)

  const second = await earlier.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: big() })
  const third = await earlier.putCapture({ captureIndex: 3, timestamp: Date.now(), pose: pose(), blob: big() })
  assert.ok(second && third)

  assert.equal(earlier.isSuperseded, false, 'no move was made, so nothing supersedes this tab')
  assert.equal(earlier.getCapture(old.captureId)?.frameDropped, 'budget', 'the earlier session\'s frame is released')
  const row = idb.rows('captures').find((r) => r.captureId === old.captureId)
  assert.equal(row?.sessionId, earlierId, 'its row still carries its own id')
  assert.equal(row?.blob, null, 'and the release reached the row')
  assert.ok(idb.keys('captures').includes(second.captureId), 'a new frame is stored as it always was')
}))

// ── A second move of a superseded tab is heard (STORE8-2) ───────────────────

test('(STORE8-2) a superseded tab hears a second move of its scan, so an erase of the scan at its new id clears it', { ...needsChannel, timeout: 15000 }, async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const r = await openStore()
  assert.equal(await r.resumeLatestSession(), 1)
  await r.adoptServerSession(server(31))
  await until(() => stale.isSuperseded, 'the stale tab to hear of the first move')
  await r.adoptServerSession(server(32))
  assert.equal(await r.deleteSession(server(32)), true)

  await until(() => stale.sessionId === '', 'the stale tab to clear the scan erased at its new id')
  assert.equal(stale.detections.size, 0)
  assert.equal(stale.isSuperseded, true, 'it stays superseded')
  assert.equal(await stale.upsert(one('lamp:1', detection('lamp', 1)), new Map()), false)
  assert.deepEqual(idb.keys('sessions'), [], 'nothing is written back')
})

// ── A re-key that another tab has already made is undone (STORE8-1) ─────────

test('a tab that has not heard of a move re-keys none of the frames the renamer moved, and is superseded', async () => withoutChannel(async () => {
  const stale = await openStore()
  await stale.upsert(one('chair:0', detection('chair')), new Map())
  const oldId = stale.sessionId
  const frameRow = await stale.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(frameRow)

  const renamer = await openStore()
  assert.equal(await renamer.loadSession(oldId), true)
  await renamer.adoptServerSession(server(27))
  const sessionsBefore = rowsOf('sessions')
  const capturesBefore = rowsOf('captures')

  // The stale tab has not heard of the move, and now starts a stream of its own. Its frame row belongs to the renamer.
  assert.equal(await stale.adoptServerSession(server(28)), false)
  assert.equal(stale.isSuperseded, true, 'the move that refused it supersedes it')
  assert.equal(stale.sessionId, oldId, 'it keeps the id it had')
  assert.equal(stale.getCapture(frameRow.captureId)?.sessionId, oldId, 'and the frame it held')
  assert.deepEqual(rowsOf('captures'), capturesBefore, 'no frame row is re-keyed, and the undone batch leaves no trace')
  assert.deepEqual(rowsOf('sessions'), sessionsBefore, 'no session record is written under the id it refused')

  const reloaded = await openStore()
  await reloaded.resumeLatestSession()
  assert.equal(reloaded.sessionId, server(27))
  assert.equal(reloaded.getCapture(frameRow.captureId)?.sessionId, server(27))
}))
