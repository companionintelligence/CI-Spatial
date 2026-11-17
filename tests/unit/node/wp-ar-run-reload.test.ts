/**
 * DetectionStore — a reload starts a new AR run, and what an earlier run saved stays out of the view (WP-02).
 *
 * A position is only meaningful in the SLAM frame that produced it, and a page load starts a new frame.
 * Boot used to resume the newest stored session straight into the live scan, so the new page drew the old
 * run's pins at wrong places and exported them under the new run's calibration. The store now stamps every
 * detection and capture with the run that placed it, resumes the record as before, and answers
 * `currentRunDetections()` with only what this page's run placed.
 *
 * These tests open the store against a small in-memory IndexedDB, as wp-store-erase.test.ts does, and
 * reload by opening a second store over the same data. "A record from the build before this one" is written
 * straight into the fake the way that build wrote it, with no run on anything: that is how the tests show
 * a stored record from before this change still loads.
 *
 * tests/unit/node has no shared helper modules, so the fake is this file's own copy of the one in
 * wp-store-erase.test.ts, plus seed() and a log of open() calls.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-ar-run-reload.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { StoredDetection } from '../../../src/scene/store.ts'
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
  /** Write a row straight into an object store, as an older build left it. */
  seed(storeName: string, row: Row): void
  /** Every open() the store made: the database name and version it asked for. */
  opens: Array<{ name: string, version: number }>
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
  // The three stores exist from the start, so a row can be seeded before any store opens the database.
  for (const name of Object.keys(KEY_PATHS)) stores.set(name, new Map())
  const opens: Array<{ name: string, version: number }> = []
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
    open: (name: string, version: number): FakeRequest => {
      opens.push({ name, version })
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
    seed: (storeName: string, row: Row) => {
      const keyPath = KEY_PATHS[storeName] ?? 'id'
      stores.get(storeName)?.set(row[keyPath], structuredClone(row))
    },
    opens,
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

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────────

/** A page as main.ts boots it: a fresh store over the shared database, resumed. AR has not started yet. */
async function bootPage(): Promise<{ store: DetectionStore, resumed: number }> {
  const store = new DetectionStore()
  await store.open()
  const resumed = await store.resumeLatestSession()
  return { store, resumed }
}

/** What a capture of one object yields to upsert(): the key main.ts files it under, and the detection. */
function placed(label: string, x: number, z = 0): [string, WorldDetection] {
  return [`${label}:${x.toFixed(1)},0.0,${z.toFixed(1)}`, {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0, 0, 1, 1],
    worldPos: { x, y: 0, z },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1_000,
  } as unknown as WorldDetection]
}

/** A detection as the build before this one wrote it: every field a capture gave it, and no run. */
function legacyDetection(label: string, x: number): StoredDetection {
  return {
    detectionId: `det-legacy-${label}`,
    label,
    confidence: 0.8,
    description: `an old ${label}`,
    bbox: [0, 0, 1, 1],
    worldPos: { x, y: 0, z: 0 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 5_000,
    lastSeenAt: 5_000,
    captureIndex: 1,
    observations: [],
    thumbnailDataUrl: 'data:image/jpeg;base64,OLD',
  } as unknown as StoredDetection
}

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

function frame(): Blob {
  return new Blob([new Uint8Array(8)], { type: 'image/jpeg' })
}

/** The stored session rows, with the detections as the record holds them: [key, detection] pairs. */
function sessionRows(): Array<{ sessionId: string, startedAt: number, detections: Array<[string, StoredDetection]> }> {
  return idb.rows('sessions') as unknown as Array<{ sessionId: string, startedAt: number, detections: Array<[string, StoredDetection]> }>
}

// ── A reload ───────────────────────────────────────────────────────────────────────────────────────

test('a record another run stamped comes back with its session and stays out of the view, before and after AR starts', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [key, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[key, sofa]]), new Map())
  const sessionId = first.store.sessionId

  const reloaded = await bootPage()
  assert.equal(reloaded.resumed, 1, 'the detection came back: resume still reports what it loaded')
  assert.equal(reloaded.store.sessionId, sessionId, 'the session continues rather than forking')
  assert.equal(reloaded.store.detections.get(key)?.arRunId, 'run-1', 'and it still says which run it belongs to')
  assert.equal(reloaded.store.currentRunDetections().size, 0, 'but until AR starts there is no frame for it to be in')
  assert.equal(reloaded.store.previousRunCount(), reloaded.resumed, 'the boot notice counts exactly what came back')

  reloaded.store.startArRun('run-2')
  assert.equal(reloaded.store.currentRunDetections().size, 0, 'and when AR starts it is a new run, so it still is not')
  assert.equal(reloaded.store.previousRunCount(), 1)
})

test('the same run\'s record is adopted into the view: the id is what decides, not the age of the record', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [key, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[key, sofa]]), new Map())
  const sessionId = first.store.sessionId

  // Within one page the run does not change, so loading the session back (the history drawer) is the same run.
  const samePage = new DetectionStore()
  await samePage.open()
  samePage.startArRun('run-1')
  assert.equal(await samePage.loadSession(sessionId), true)
  assert.deepEqual([...samePage.currentRunDetections().keys()], [key], 'its own run\'s detection is in the view')

  const otherPage = new DetectionStore()
  await otherPage.open()
  otherPage.startArRun('run-2')
  assert.equal(await otherPage.loadSession(sessionId), true)
  assert.equal(otherPage.detections.size, 1, 'loaded and editable')
  assert.equal(otherPage.currentRunDetections().size, 0, 'but another run\'s is not in the view')
})

test('a record from the build before this one loads, and counts as an earlier run after any reload', async () => {
  idb.seed('sessions', {
    sessionId: 'local-legacy',
    startedAt: 1_000,
    detections: [['sofa:0.0,0.0,0.0', legacyDetection('sofa', 0)], ['lamp:2.0,0.0,0.0', legacyDetection('lamp', 2)]],
  })

  const { store, resumed } = await bootPage()
  assert.equal(resumed, 2, 'both detections are back')
  assert.equal(store.sessionId, 'local-legacy')
  assert.equal(store.detections.get('sofa:0.0,0.0,0.0')?.description, 'an old sofa')
  assert.equal(store.detections.get('sofa:0.0,0.0,0.0')?.thumbnailDataUrl, 'data:image/jpeg;base64,OLD', 'nothing the old build wrote is lost')
  assert.equal(store.currentRunDetections().size, 0)

  store.startArRun('anything-at-all')
  assert.equal(store.currentRunDetections().size, 0, 'no run id can claim a record that has none')
  assert.equal(store.previousRunCount(), 2)
  // A missing field must not match anything, not even another missing one.
  assert.equal(store.isCurrentRun({ arRunId: undefined }), false)
})

test('a run that writes into a resumed session leaves the earlier run\'s detections in the stored record, each under its own run', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [kSofa, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[kSofa, sofa]]), new Map())

  const second = await bootPage()
  second.store.startArRun('run-2')
  const [kLamp, lamp] = placed('lamp', 3)
  await second.store.upsert(new Map([[kLamp, lamp]]), new Map())
  assert.deepEqual([...second.store.currentRunDetections().keys()], [kLamp])

  const [row] = sessionRows()
  assert.equal(sessionRows().length, 1, 'one session record, not a fork')
  assert.deepEqual(
    Object.fromEntries(row!.detections.map(([key, det]) => [key, det.arRunId])),
    { [kSofa]: 'run-1', [kLamp]: 'run-2' },
  )

  const third = await bootPage()
  assert.equal(third.resumed, 2)
  third.store.startArRun('run-3')
  assert.equal(third.store.currentRunDetections().size, 0, 'a third page sees both as earlier runs\'')
  assert.equal(third.store.previousRunCount(), 2)
})

test('the same object found again after a reload does not overwrite the stored record of it', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const key = 'chair:1.0,0.0,2.0'
  await first.store.upsert(new Map([[key, { ...placed('chair', 1, 2)[1], description: 'the chair, run 1' } as WorldDetection]]), new Map())

  const second = await bootPage()
  second.store.startArRun('run-2xxxxxxx')
  await second.store.upsert(new Map([[key, { ...placed('chair', 1, 2)[1], description: 'the chair, run 2' } as WorldDetection]]), new Map())

  const [row] = sessionRows()
  const stored = new Map(row!.detections)
  assert.equal(stored.size, 2, 'both survived to disk')
  assert.equal(stored.get(key)?.description, 'the chair, run 1')
  assert.equal(stored.get(key)?.arRunId, 'run-1')
  assert.equal(stored.get(`${key}@run-2xxx`)?.description, 'the chair, run 2')
  assert.equal(stored.get(`${key}@run-2xxx`)?.arRunId, 'run-2xxxxxxx')
})

test('an earlier run\'s detection can be relabelled, is saved with its run, and stays an earlier run\'s', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [key, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[key, sofa]]), new Map())

  const { store } = await bootPage()
  store.startArRun('run-2')
  assert.equal(await store.updateDetection(key, { label: 'armchair' }), true)
  assert.equal(store.detections.get(key)?.arRunId, 'run-1')
  assert.equal(store.currentRunDetections().size, 0)
  const stored = new Map(sessionRows()[0]!.detections)
  assert.equal(stored.get(key)?.label, 'armchair')
  assert.equal(stored.get(key)?.arRunId, 'run-1', 'an edit does not move a detection into another frame')
})

test('what the history drawer reads of another session carries each detection\'s run', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [key, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[key, sofa]]), new Map())
  const sessionId = first.store.sessionId
  idb.seed('sessions', { sessionId: 'local-legacy', startedAt: 1_000, detections: [['lamp:2.0,0.0,0.0', legacyDetection('lamp', 2)]] })

  const reader = new DetectionStore()
  await reader.open()
  reader.startArRun('run-1')
  const mine = await reader.readSession(sessionId)
  assert.equal(reader.isCurrentRun(mine!.get(key)!), true, 'a row of this page\'s own run is not labelled as an earlier one')
  const old = await reader.readSession('local-legacy')
  assert.equal(reader.isCurrentRun(old!.get('lamp:2.0,0.0,0.0')!), false)
  assert.equal(reader.arRunId, 'run-1', 'reading changes nothing about the live run')
})

test('deleting the live session from History ends the scan, not the run: the next capture is still this run\'s', async () => {
  const { store } = await bootPage()
  store.startArRun('run-1')
  const [kSofa, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[kSofa, sofa]]), new Map())
  assert.equal(await store.deleteSession(store.sessionId), true)
  assert.equal(store.sessionId, '', 'no live session until the next write starts one')
  assert.equal(store.arRunId, 'run-1', 'but the AR runtime is the same one')

  const capture = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(capture)
  const [kLamp, lamp] = placed('lamp', 3)
  await store.upsert(new Map([[kLamp, lamp]]), new Map())
  assert.deepEqual([...store.currentRunDetections().keys()], [kLamp], 'the lamp found after the delete is in view')
  assert.equal(store.getCapture(capture.captureId)?.arRunId, 'run-1')
})

// ── The keyframe session an export may name ──────────────────────────────────────────────────────────

test('a resumed record keeps the server session an earlier run opened, and an export may not name it', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [kSofa, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[kSofa, sofa]]), new Map())
  const streamed = 'sess-11111111-2222-4333-8444-555555555555'
  assert.equal(await first.store.adoptServerSession(streamed), true)
  assert.equal(first.store.serverSessionOfThisRun, streamed, 'the run that streamed it may name it')

  const reloaded = await bootPage()
  assert.equal(reloaded.store.sessionId, streamed, 'the record continues under the id it was keyed by')
  reloaded.store.startArRun('run-2')
  assert.equal(reloaded.store.serverSessionOfThisRun, null, 'but its keyframes are in run 1\'s frame, not this run\'s')

  // This run opens a session of its own: that one is named, and the record moves to it.
  const own = 'sess-66666666-7777-4888-8999-000000000000'
  assert.equal(await reloaded.store.adoptServerSession(own), true)
  assert.equal(reloaded.store.serverSessionOfThisRun, own)
  assert.deepEqual(sessionRows().map((row) => row.sessionId), [own], 'one record, renamed, as before')

  // And a third page resumes that record, and again does not own its session.
  const third = await bootPage()
  third.store.startArRun('run-3')
  assert.equal(third.store.sessionId, own)
  assert.equal(third.store.serverSessionOfThisRun, null)
})

test('a server session opened after the live one was erased is this run\'s, and is named', async () => {
  const { store } = await bootPage()
  store.startArRun('run-1')
  await store.upsert(new Map([placed('sofa', 0)]), new Map())
  assert.equal(await store.deleteSession(store.sessionId), true)
  assert.equal(store.sessionId, '', 'no live session: nothing to carry over to the one that opens')

  const streamed = 'sess-66666666-7777-4888-8999-000000000000'
  assert.equal(await store.adoptServerSession(streamed), true)
  assert.equal(store.sessionId, streamed)
  assert.equal(store.serverSessionOfThisRun, streamed, 'streaming started in this run, so its keyframes are this run\'s')
})

test('loading a stored server session does not make its keyframes this run\'s either', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  await first.store.upsert(new Map([placed('sofa', 0)]), new Map())
  const streamed = 'sess-11111111-2222-4333-8444-555555555555'
  await first.store.adoptServerSession(streamed)

  const other = new DetectionStore()
  await other.open()
  other.startArRun('run-1')                  // the same run: the keyframes of its own session are its own
  assert.equal(await other.loadSession(streamed), true)
  assert.equal(other.serverSessionOfThisRun, null, 'loaded, not opened: this page never streamed it')
})

// ── Captures ───────────────────────────────────────────────────────────────────────────────────────

test('a capture row from the build before this one loads, and a new capture carries its run through a reload', async () => {
  idb.seed('captures', {
    captureId: 'local-legacy-c1',
    sessionId: 'local-legacy',
    captureIndex: 1,
    timestamp: 1_000,
    pose: pose(),
    blob: null,
    byteSize: 8,
    status: 'inferred',
    detectionKeys: ['sofa:0.0,0.0,0.0'],
    engine: 'server',
    frameDropped: 'budget',
  })
  idb.seed('sessions', { sessionId: 'local-legacy', startedAt: 1_000, detections: [['sofa:0.0,0.0,0.0', legacyDetection('sofa', 0)]] })

  const { store } = await bootPage()
  const old = store.getCapture('local-legacy-c1')
  assert.ok(old, 'the capture is back')
  assert.equal(old.arRunId, undefined, 'and says no run, because none was recorded')
  assert.equal(old.status, 'inferred')

  store.startArRun('run-1')
  const fresh = await store.putCapture({ captureIndex: 2, timestamp: 2_000, pose: pose(), blob: frame() })
  assert.ok(fresh)
  assert.equal(fresh.arRunId, 'run-1')
  const row = idb.rows('captures').find((r) => r['captureId'] === fresh.captureId)
  assert.equal(row?.['arRunId'], 'run-1', 'the stamp is on the stored row')

  const reloaded = await bootPage()
  assert.equal(reloaded.store.getCapture(fresh.captureId)?.arRunId, 'run-1', 'and it comes back with the capture')
})

// ── What did not change ─────────────────────────────────────────────────────────────────────────────

test('the database keeps its name and version, and the session record keeps its three fields', async () => {
  const first = await bootPage()
  first.store.startArRun('run-1')
  const [key, sofa] = placed('sofa', 0)
  await first.store.upsert(new Map([[key, sofa]]), new Map())
  await first.store.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  await bootPage()

  assert.ok(idb.opens.length >= 2)
  for (const open of idb.opens) assert.deepEqual(open, { name: 'ci-xr-scan', version: 3 }, 'the "Do not rename" database, and no version bump for a field nothing indexes')
  const [row] = sessionRows()
  assert.deepEqual(Object.keys(row!).sort(), ['detections', 'sessionId', 'startedAt'], 'the run is on the detections, not a new column of the record')
})
