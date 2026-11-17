/**
 * `DetectionStore.beginSession()` (WP-09b, src/scene/store.ts): the store's half of a re-anchor.
 *
 * A scan that is begun again after the runtime redefined its origin is in another frame, so what it stores must not be
 * written into the record of the scan before. The scan being left stays in the history exactly as its last save left it;
 * the new one has its own session id and no record until something is saved into it (an empty record written now would
 * list as "0 objects" in the history drawer, which is why boot writes none either). The AR run is a separate step
 * (`startArRun`): stamping what the new scan stores with `<run>.<epoch>` is what keeps what the old scan stored out of it.
 * The switch is synchronous, so nothing can be recorded into the old session between the end of one scan and the start of
 * the next.
 *
 * Opens the store against a small in-memory IndexedDB (./support/fake-scan-idb.ts), as wp-ar-run-reload.test.ts does.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-store-begin-session.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { StoredDetection } from '../../../src/scene/store.ts'
import { arRunIdAtEpoch } from '../../../src/shared/ar-run-id.ts'
import { isServerSessionId } from '../../../src/shared/session-id.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'
import { fakeScanIdb, type FakeScanIdb } from './support/fake-scan-idb.ts'

let idb: FakeScanIdb

beforeEach(() => {
  idb = fakeScanIdb()
  Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true, writable: true })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
})

async function openStore(options: ConstructorParameters<typeof DetectionStore>[0] = {}): Promise<DetectionStore> {
  const store = new DetectionStore(options)
  await store.open()
  return store
}

function placed(label: string, x: number): [string, WorldDetection] {
  return [`${label}:${x.toFixed(1)},0.0,0.0`, {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0, 0, 1, 1],
    worldPos: { x, y: 0, z: 0 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1_000,
  } as unknown as WorldDetection]
}

const pose = (): CaptureResult['pose'] => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
const frame = (): Blob => new Blob([new Uint8Array(8)], { type: 'image/jpeg' })

type SessionRow = { sessionId: string; startedAt: number; detections: Array<[string, StoredDetection]> }
const sessionRows = (): SessionRow[] => idb.rows('sessions') as unknown as SessionRow[]

test('the scan being left stays in the history as it was saved; the new one has its own id and nothing in it', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  const old = store.sessionId
  const oldDetections = store.detections
  store.toggleSelect(key)
  assert.equal(store.selected.size, 1, 'the person had the sofa selected')

  assert.equal(store.beginSession(), true)

  assert.notEqual(store.sessionId, old, 'a new session')
  assert.equal(isServerSessionId(store.sessionId), false, 'a local id: it names no directory on the server')
  assert.equal(store.detections.size, 0, 'the new scan has nothing in it')
  assert.equal(store.selected.size, 0, 'and nothing selected: the sofa is not in this scan')
  assert.equal(oldDetections.size, 1, 'the map the old scan handed out still holds the old scan\'s detections')
  const rows = sessionRows()
  assert.deepEqual(rows.map((row) => row.sessionId), [old], 'the old record is in the history and the new one has no record yet')
  assert.deepEqual(rows[0]!.detections.map(([k]) => k), [key], 'and it holds what the old scan held')
})

test('the new session has a record once something is saved into it, and the old one is not touched by that', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  const old = store.sessionId
  store.beginSession()
  store.startArRun(arRunIdAtEpoch('run-a', 2))
  const [lampKey, lamp] = placed('lamp', 2)
  await store.upsert(new Map([[lampKey, lamp]]), new Map())

  const rows = sessionRows()
  assert.equal(rows.length, 2)
  const byId = new Map(rows.map((row) => [row.sessionId, row]))
  assert.deepEqual(byId.get(old)!.detections.map(([k]) => k), [key], 'the old scan\'s record is as it was')
  assert.deepEqual(byId.get(store.sessionId)!.detections.map(([k]) => k), [lampKey])
  assert.ok(byId.get(store.sessionId)!.startedAt >= byId.get(old)!.startedAt, 'and it started later, so a reload resumes it')
})

test('the new scan starts when it begins, not when the old one did, so a reload resumes the newer of the two', async () => {
  const realNow = Date.now
  let clock = 1_700_000_000_000
  Date.now = () => clock
  try {
    const store = await openStore()
    store.startArRun('run-a')
    const [key, sofa] = placed('sofa', 0)
    await store.upsert(new Map([[key, sofa]]), new Map())
    const old = store.sessionId
    clock += 600_000
    store.beginSession()
    const [lampKey, lamp] = placed('lamp', 2)
    await store.upsert(new Map([[lampKey, lamp]]), new Map())
    const started = new Map(sessionRows().map((row) => [row.sessionId, row.startedAt]))
    assert.equal(started.get(store.sessionId), 1_700_000_600_000, 'the time the second scan began')
    assert.equal(started.get(old), 1_700_000_000_000, 'and the first is as it was')
  } finally {
    Date.now = realNow
  }
})

test('what the new scan stores is stamped with the run and the epoch, and what the old one stored is not in its view', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  await store.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  const oldCapture = store.captureIdFor(1)

  store.beginSession()
  const runId = arRunIdAtEpoch('run-a', 3)
  store.startArRun(runId)
  assert.equal(store.arRunId, 'run-a.3')
  assert.equal(store.serverSessionOfThisRun, null, 'a server session the run before opened is not this scan\'s')

  const [lampKey, lamp] = placed('lamp', 2)
  await store.upsert(new Map([[lampKey, lamp]]), new Map())
  await store.putCapture({ captureIndex: 1, timestamp: 2, pose: pose(), blob: frame() })
  assert.equal(store.detections.get(lampKey)?.arRunId, 'run-a.3', 'a detection carries the epoch')
  assert.deepEqual([...store.currentRunDetections().keys()], [lampKey])
  const newCapture = store.captureIdFor(1)
  assert.notEqual(newCapture, oldCapture, 'capture numbering starts again under the new session: the ids cannot collide')
  assert.equal(store.getCapture(newCapture)?.arRunId, 'run-a.3', 'a capture record carries it too')
  assert.equal(store.getCapture(oldCapture)?.arRunId, 'run-a', 'and the old scan\'s capture still carries the run it was taken in')
})

test('the old scan\'s captures stay under its id and are not counted for the new one', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  await store.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  await store.putCapture({ captureIndex: 2, timestamp: 2, pose: pose(), blob: frame() })
  const old = store.sessionId
  assert.equal(store.captureCounts('session').total, 2)

  store.beginSession()

  assert.equal(store.captureCounts('session').total, 0, 'the live scan has none')
  assert.equal([...store.captures.values()].filter((record) => record.sessionId === old).length, 2, 'the old scan keeps both')
  assert.equal((idb.rows('captures') as Array<{ sessionId: string }>).filter((row) => row.sessionId === old).length, 2, 'in the database too')
})

test('the switch is synchronous: a detection stored in the same turn lands in the new scan, never the old one', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const old = store.sessionId
  const [key, sofa] = placed('sofa', 0)
  const stored = (async () => {
    store.beginSession()
    return store.upsert(new Map([[key, sofa]]), new Map())
  })()
  await stored
  assert.notEqual(store.sessionId, old)
  const rows = sessionRows()
  assert.equal(rows.length, 1, 'one record: the new scan\'s')
  assert.notEqual(rows[0]!.sessionId, old)
  assert.deepEqual(rows[0]!.detections.map(([k]) => k), [key])
})

test('listeners are told, so the pins and the panel stop showing the scan that ended', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  const sizes: number[] = []
  store.subscribe((detections) => sizes.push(detections.size))
  store.beginSession()
  assert.deepEqual(sizes, [0])
})

test('a store that cannot write has no scan of its own to end, and nothing changes', async () => {
  const readOnly = await openStore({ readOnly: true })
  const before = readOnly.sessionId
  assert.equal(readOnly.beginSession(), false)
  assert.equal(readOnly.sessionId, before)
})

test('with no database the session still moves on: the store is then memory only', async () => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
  const store = new DetectionStore()
  await store.open()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  const old = store.sessionId
  assert.equal(store.beginSession(), true)
  assert.notEqual(store.sessionId, old)
  assert.equal(store.detections.size, 0)
})

test('a session started after an erase has no live id to save: beginning one still works', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const [key, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[key, sofa]]), new Map())
  await store.deleteSession(store.sessionId)
  assert.equal(store.sessionId, '', 'the erased live session left none')
  assert.equal(store.beginSession(), true)
  assert.notEqual(store.sessionId, '')
  assert.deepEqual(sessionRows(), [], 'nothing was written for the scan that was erased')
})

test('beginning twice gives three scans, each with its own record as it was saved', async () => {
  const store = await openStore()
  store.startArRun('run-a')
  const ids: string[] = [store.sessionId]
  for (const [label, x] of [['sofa', 0], ['lamp', 2], ['plant', 4]] as const) {
    const [key, detection] = placed(label, x)
    await store.upsert(new Map([[key, detection]]), new Map())
    if (label !== 'plant') {
      store.beginSession()
      ids.push(store.sessionId)
    }
  }
  assert.equal(new Set(ids).size, 3)
  assert.deepEqual(sessionRows().map((row) => row.detections.length), [1, 1, 1])
})
