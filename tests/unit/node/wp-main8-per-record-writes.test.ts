/**
 * Per-record writes after an analysis, the summary's capture count and the superseded notice
 * (publish-readiness fix wave 8, package MAIN8, items MAIN8-1 to MAIN8-3).
 *
 * The analysis of a capture writes onto the record its frame was stored as, once inference
 * resolves. Those writes check record identity only. A load of another session leaves that
 * record in the store, so it still has to leave the pending state. Only the write of the
 * capture's detections into the live scan needs the live session.
 *
 * The rules are pure (src/shared/capture-index.ts) and run here against the real DetectionStore,
 * in memory, with no IndexedDB. main.ts is one large DOM module, so the wiring checks read its
 * source the way the other scanner tests do. Those names start "source shape:".
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main8-per-record-writes.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { CaptureRecord } from '../../../src/scene/store.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import { isSameCapture, isSameRecord } from '../../../src/shared/capture-index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const SESSION_A = 'sess-0a1b2c3d-0000-4000-8000-00000000000a'
const SESSION_B = 'sess-0a1b2c3d-0000-4000-8000-00000000000b'

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

function frame(): Blob {
  return new Blob([new Uint8Array(8)], { type: 'image/jpeg' })
}

/** Minimal WorldDetection, as in wp-store7-superseded-tab.test.ts. */
function detection(label: string): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: 'a ' + label,
    bbox: [0, 0, 1, 1],
    worldPos: { x: 1, y: 0, z: 0 },
  } as unknown as WorldDetection
}

let clock = Date.now()
function nextTimestamp(): number {
  clock += 1
  return clock
}

/**
 * One capture the way doCapture makes it: its id comes from the index it is numbered with, the
 * frame is stored, and the record it was stored as is kept for the writes after the analysis.
 */
async function startCapture(store: DetectionStore, captureIndex: number): Promise<{ id: string, captured: CaptureRecord }> {
  const id = store.captureIdFor(captureIndex)
  await store.putCapture({ captureIndex, timestamp: nextTimestamp(), pose: pose(), blob: frame(), engine: 'server' })
  return { id, captured: store.getCapture(id) as CaptureRecord }
}

/**
 * What a load does once it has read the stored record: the store takes over that record's data
 * and identity (DetectionStore.loadSession, after its IndexedDB read). This store has no database,
 * so the step is taken directly rather than through loadSession.
 */
function loadStoredSession(store: DetectionStore, sessionId: string): void {
  const taker = store as unknown as { adopt(record: { sessionId: string, startedAt: number, detections: unknown[] }): void }
  taker.adopt({ sessionId, startedAt: 1_000, detections: [] })
}

// ── MAIN8-1: per-record writes after an analysis ─────────────────────────────────

test('MAIN8-1: after a load of another session during an analysis, the original record leaves the pending state', async () => {
  const store = new DetectionStore()
  const { id, captured } = await startCapture(store, 1) // its analysis is still running
  loadStoredSession(store, SESSION_B) // the user loads another scan meanwhile
  assert.equal(store.sessionId, SESSION_B)

  // The success path's write, behind the per-record check.
  if (isSameRecord(store.getCapture(id), captured)) await store.attachDetections(id, ['chair:1,0,0'])

  assert.equal(store.getCapture(id)?.status, 'inferred', 'the record is no longer pending')
  assert.deepEqual(store.getCapture(id)?.detectionKeys, ['chair:1,0,0'])
})

test('MAIN8-1: after a load of another session during an analysis, a failure marks the original record failed', async () => {
  const store = new DetectionStore()
  const { id, captured } = await startCapture(store, 1)
  loadStoredSession(store, SESSION_B)

  // The failure path's writes, behind the same check.
  if (isSameRecord(store.getCapture(id), captured)) await store.markCaptureFailed(id, 'Server unreachable')
  if (isSameRecord(store.getCapture(id), captured)) await store.discardFrame(id, 'quality')

  const record = store.getCapture(id)
  assert.equal(record?.status, 'failed')
  assert.equal(record?.error, 'Server unreachable')
  assert.equal(record?.blob, null, 'a frame that failed on its own quality is dropped')
  assert.equal(record?.frameDropped, 'quality')
})

test('MAIN8-1: the detections of that analysis are not written into the scan a load has made live', async () => {
  // Control: with no load, the same write lands in the live scan, so the check below is not vacuous.
  const control = new DetectionStore()
  const made = await startCapture(control, 1)
  if (isSameCapture(control.getCapture(made.id), made.captured, control.sessionId)) {
    await control.upsert(new Map([['chair:1,0,0', detection('chair')]]), new Map())
  }
  assert.equal(control.detections.size, 1, 'control: the detections land in the live scan')

  const store = new DetectionStore()
  const { id, captured } = await startCapture(store, 1)
  loadStoredSession(store, SESSION_B)
  // The upsert is the one write that still needs the live session, so it stays refused here.
  if (isSameCapture(store.getCapture(id), captured, store.sessionId)) {
    await store.upsert(new Map([['chair:1,0,0', detection('chair')]]), new Map())
  }
  assert.equal(store.detections.size, 0, 'nothing from the analysis lands in the loaded scan')
})

test('MAIN8-1: a record a Clear removed, or a new record numbered under the same id, is not the capture', async () => {
  const store = new DetectionStore()
  const { id, captured } = await startCapture(store, 1)
  await store.clear()
  assert.equal(isSameRecord(store.getCapture(id), captured), false, 'the record is gone')

  const again = await startCapture(store, 1)
  assert.equal(again.id, id, 'the same id is taken again in the same session')
  assert.equal(isSameRecord(store.getCapture(id), captured), false, 'a different record that took the id is not the capture')
})

test('MAIN8-1: a record re-keyed by adoption is still the capture, and a load of another session leaves it so', async () => {
  const store = new DetectionStore()
  const { id, captured } = await startCapture(store, 1)
  await store.adoptServerSession(SESSION_A) // the keyframe stream opens a server session
  assert.notEqual(store.getCapture(id), captured, 'adoption stores a copy of the record')
  assert.equal(isSameRecord(store.getCapture(id), captured), true)

  loadStoredSession(store, SESSION_B)
  assert.equal(isSameRecord(store.getCapture(id), captured), true, 'the record is still the capture after a load')
})

// ── MAIN8-2: the summary's capture count ─────────────────────────────────────────

test('MAIN8-2: after a Clear the live count is what the store holds, so the summary does not report captures that are gone', async () => {
  const store = new DetectionStore()
  await startCapture(store, 1)
  await startCapture(store, 2)
  assert.equal(store.captureCounts().total, 2)

  await store.clear()
  assert.equal(store.captureCounts().total, 0, 'the Captures figure reads what the store holds')
})

test('MAIN8-2: the live count covers the live session only, so a load leaves the other session out of it', async () => {
  const store = new DetectionStore()
  await startCapture(store, 1)
  await startCapture(store, 2)
  loadStoredSession(store, SESSION_B)
  assert.equal(store.captureCounts().total, 0, 'the loaded session holds no captures here')

  await startCapture(store, 1)
  assert.equal(store.captureCounts().total, 1, 'only the loaded session\'s capture is counted')
})

// ── MAIN8-1 and MAIN8-2: the wiring in main.ts ───────────────────────────────────

test('source shape: MAIN8-1: the per-record check has no live-session condition, and only the upsert keeps one', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /const stillThisCapture = \(captureId: string\) => isSameRecord\(store\.getCapture\(captureId\), storedCapture\)/,
    'the per-record check is record identity only',
  )
  assert.equal(main.split('isSameRecord(').length - 1, 1, 'isSameRecord is used only by the per-record check')
  assert.equal(main.split('isSameCapture(').length - 1, 1, 'isSameCapture is used only by the upsert')
  assert.match(
    main,
    /if \(isSameCapture\(pendingRecord, storedCapture, store\.sessionId\)\) \{\s*const merged = mergeDetections\(store\.currentRunDetections\(\), worldDets\)\s*await store\.upsert\(merged, thumbMap\)/,
    'the upsert keeps its live-session check',
  )
})

test('source shape: MAIN8-2: the summary is given the store\'s live capture count, and not the numbering counter', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /exportSessionSummary\(\{ store, pointCloud, poseHistory, captureCount: store\.captureCounts\('run'\)\.total, geoFix: geoTracker\.snapshot\(\) \?\? undefined \}\)/,
    'the Captures figure is the live count',
  )
  assert.doesNotMatch(main, /exportSessionSummary\(\{[^}]*\bcaptureCount,/, 'the numbering counter is not passed to the summary')
})

// ── MAIN8-3: the superseded notice stays on screen ───────────────────────────────

test('source shape: MAIN8-3: the notice is put back after every write to the status line while the store is superseded', () => {
  const main = read('src/main.ts')
  const made = main.indexOf('const store = readOnlyScanner ? new DetectionStore({ readOnly: true }) : new DetectionStore()')
  const opened = main.indexOf('await store.open()', made)
  assert.ok(made > 0 && opened > made, 'the store is made and then opened in main')
  const wiring = main.slice(made, opened)
  assert.match(wiring, /const statusNode = document\.getElementById\('status-text'\)/, 'the status line is the node watched')
  assert.match(
    wiring,
    /if \(store\.isSuperseded && statusNode\?\.textContent !== SUPERSEDED_NOTICE\) showSuperseded\(\)/,
    'the notice is written again only while superseded, and only when the text has changed',
  )
  assert.match(
    wiring,
    /new MutationObserver\(keepSupersededNotice\)\.observe\(statusNode, \{ childList: true, characterData: true, subtree: true \}\)/,
    'every write to the node is seen',
  )
})
