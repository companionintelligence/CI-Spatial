/**
 * Capture ids, stale writes, the adoption failure path and the superseded notice
 * (publish-readiness fix wave 7, package MAIN7, items MAIN7-1 to MAIN7-3).
 *
 * A capture's record id is its session id, then `-c`, then its index. Its analysis writes
 * onto that record when inference resolves. A Clear keeps the session, so the counter must
 * not fall back to what the store holds: a capture still being analysed owns its index.
 * And a write after an analysis may only land on the record it was made for, never on a
 * new record that took the same id.
 *
 * The rules are pure (src/shared/capture-index.ts) and run here against the real
 * DetectionStore, in memory, with no IndexedDB. main.ts is one large DOM module, so the
 * wiring checks read its source the way the other scanner tests do. Those names start
 * "source shape:".
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main7-capture-ids.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DetectionStore } from '../../../src/scene/store.ts'
import type { CaptureRecord } from '../../../src/scene/store.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'
import {
  captureCountFor,
  highestCaptureIndex,
  isSameCapture,
  isSameRecord,
  type StoredCaptureIndex,
} from '../../../src/shared/capture-index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const SESSION_A = 'sess-0a1b2c3d-0000-4000-8000-00000000000a'
const SESSION_B = 'sess-0a1b2c3d-0000-4000-8000-00000000000b'

const SUPERSEDED_COPY = 'This scan is open in another tab. Changes here are not saved. Reload this page to continue.'

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

function frame(): Blob {
  return new Blob([new Uint8Array(8)], { type: 'image/jpeg' })
}

/** A stored capture as the counter reads it: its session and its index. */
function stored(sessionId: string, captureIndex: number): StoredCaptureIndex {
  return { sessionId, captureIndex }
}

let clock = 1_000
function nextTimestamp(): number {
  clock += 1
  return clock
}

/**
 * The scanner's capture counter, driven as main.ts drives it: brought onto the live session
 * (followCaptureSession), advanced by one for each frame, then left on the session the
 * capture was made in.
 */
function scannerCounter(store: DetectionStore) {
  const left = new Map<string, number>()
  let counted = store.sessionId
  let count = highestCaptureIndex(store.captures.values(), store.sessionId)

  function follow(): void {
    const live = store.sessionId
    if (live !== counted) left.set(counted, count)
    count = captureCountFor(live, counted, count, store.captures.values(), left)
    counted = live
  }

  return {
    /** The index the next frame is numbered with, as doCapture takes it. */
    next(): number {
      follow()
      count += 1
      return count
    },
    /** Called once the frame's id is known, as main.ts does with captureCountSession. */
    settle(): void {
      counted = store.sessionId
    },
    /** Called before a Clear's reset runs, as resetScanner does. */
    reset(): void {
      follow()
    },
  }
}

/** One capture the way doCapture makes it: number it, store the frame, keep the record it was stored as. */
async function startCapture(store: DetectionStore, counter: ReturnType<typeof scannerCounter>) {
  const captureIndex = counter.next()
  const id = store.captureIdFor(captureIndex)
  counter.settle()
  await store.putCapture({ captureIndex, timestamp: nextTimestamp(), pose: pose(), blob: frame(), engine: 'server' })
  return { id, captured: store.getCapture(id) as CaptureRecord }
}

// ── MAIN7-1: capture ids and stale writes ────────────────────────────────────────

test('MAIN7-1: a Clear then a capture never reuses an id issued earlier in the page life', async () => {
  const store = new DetectionStore()
  const counter = scannerCounter(store)
  const first = await startCapture(store, counter) // analysis still in flight
  await store.clear() // Clear: the store empties and the session stays
  assert.equal(
    highestCaptureIndex(store.captures.values(), store.sessionId),
    0,
    'after a Clear the store alone says 0, which is why the counter must not be read from it',
  )
  counter.reset()
  const second = await startCapture(store, counter)
  await store.clear()
  counter.reset()
  const third = await startCapture(store, counter)

  assert.equal(first.id, store.sessionId + '-c1')
  assert.equal(second.id, store.sessionId + '-c2', 'the count did not fall back to the empty store')
  assert.equal(third.id, store.sessionId + '-c3')
  assert.equal(new Set([first.id, second.id, third.id]).size, 3, 'no two captures in this page life share an id')
})

test('MAIN7-1: a load of another session resets the count to that session\'s highest index', () => {
  const captures = [stored(SESSION_A, 1), stored(SESSION_A, 2), stored(SESSION_A, 3), stored(SESSION_B, 1), stored(SESSION_B, 2)]
  // The counter was 3 for A. Loading B resumes at B's highest stored index, 2.
  assert.equal(captureCountFor(SESSION_B, SESSION_A, 3, captures, new Map()), 2)
  // Loading A back, with nothing left in memory that A issued after the stored captures, gives A's highest.
  assert.equal(captureCountFor(SESSION_A, SESSION_B, 2, captures, new Map()), 3)
  // A session with nothing stored starts at 0.
  assert.equal(captureCountFor(SESSION_B, SESSION_A, 3, [stored(SESSION_A, 1)], new Map()), 0)
})

test('MAIN7-1: a session loaded back after a Clear resumes from the index it issued, not from the store', () => {
  // A issued index 4 while it was live. A Clear then removed its records, B was loaded, and A is loaded back.
  const captures = [stored(SESSION_B, 1), stored(SESSION_B, 2)]
  const left = new Map([[SESSION_A, 4]])
  assert.equal(captureCountFor(SESSION_A, SESSION_B, 2, captures, left), 4)
})

test('MAIN7-1: the same session keeps the larger of its counter and its stored highest index', () => {
  // A Clear: nothing stored for A now, and the counter had reached 5.
  assert.equal(captureCountFor(SESSION_A, SESSION_A, 5, [], new Map()), 5)
  // Stored captures above the counter raise it, and nothing lowers it.
  assert.equal(captureCountFor(SESSION_A, SESSION_A, 2, [stored(SESSION_A, 7)], new Map()), 7)
  assert.equal(captureCountFor(SESSION_A, SESSION_A, 2, [stored(SESSION_A, 1)], new Map()), 2)
})

test('MAIN7-1: a stale analysis cannot write onto a new record that takes the same id', async () => {
  const store = new DetectionStore()
  const counter = scannerCounter(store)
  const stale = await startCapture(store, counter) // its analysis is still running
  await store.clear()
  // The bug this guards: the counter fell back, so the next frame was numbered 1 again.
  const fresh = await store.putCapture({ captureIndex: 1, timestamp: nextTimestamp(), pose: pose(), blob: frame(), engine: 'server' })
  assert.equal(fresh.captureId, stale.id, 'the new record holds the id the stale analysis was given')

  // The write the capture handler makes after its analysis, behind the same per-record check.
  if (isSameRecord(store.getCapture(stale.id), stale.captured)) {
    await store.attachDetections(stale.id, ['chair:1,0,0'])
  }
  const current = store.getCapture(fresh.captureId)
  assert.equal(current?.status, 'pending', 'the new record was not marked inferred')
  assert.deepEqual(current?.detectionKeys, [], 'no detection key from the stale analysis landed on it')
})

test('MAIN7-1: the same capture still passes, both for its own record and for a copy re-keyed by adoption', async () => {
  const store = new DetectionStore()
  const made = await store.putCapture({ captureIndex: 1, timestamp: 5_000, pose: pose(), blob: frame(), engine: 'server' })
  const captured = store.getCapture(made.captureId)
  assert.equal(isSameCapture(captured, captured, store.sessionId), true, 'the record itself')

  // Adopting a server session re-keys the record: a copy under the new session, with the same captureId and timestamp.
  await store.adoptServerSession(SESSION_A)
  const moved = store.getCapture(made.captureId)
  assert.notEqual(moved, captured, 'adoption stores a copy of the record')
  assert.equal(moved?.sessionId, SESSION_A)
  assert.equal(isSameCapture(moved, captured, SESSION_A), true, 'the copy is still this capture')
})

test('MAIN7-1: a record of another session, a missing record and a missing live session never pass', async () => {
  const store = new DetectionStore()
  const made = await store.putCapture({ captureIndex: 1, timestamp: 6_000, pose: pose(), blob: frame(), engine: 'server' })
  const captured = store.getCapture(made.captureId)
  assert.equal(isSameCapture(captured, captured, SESSION_B), false, 'a load moved the live scan on')
  assert.equal(isSameCapture(captured, captured, ''), false, 'there is no live session')
  assert.equal(isSameCapture(undefined, captured, store.sessionId), false, 'the record has gone')
  assert.equal(isSameCapture(captured, undefined, store.sessionId), false, 'nothing was captured to compare with')
})

// ── MAIN7-1 and MAIN7-3: the wiring in main.ts ───────────────────────────────────

test('source shape: MAIN7-1: a reset and each capture bring the counter onto the live session before a frame is numbered', () => {
  const main = read('src/main.ts')
  const reset = main.indexOf('function resetScanner(detectionCount: number): void {')
  const resetEnd = main.indexOf('await router.probeWebGPU()', reset)
  assert.ok(reset > 0 && resetEnd > reset, 'resetScanner is in main')
  assert.match(main.slice(reset, resetEnd), /followCaptureSession\(\)/, 'the reset follows the live session')

  const docStart = main.indexOf('async function doCapture() {')
  const follow = main.indexOf('followCaptureSession()', docStart)
  const numbered = main.indexOf('const captureIndex = ++captureCount', docStart)
  const issued = main.indexOf('pendingCaptureId = store.captureIdFor(captureIndex)', docStart)
  assert.ok(docStart > 0 && follow > docStart, 'doCapture follows the live session')
  assert.ok(numbered > follow, 'the counter follows the session before the frame is numbered')
  assert.ok(issued > numbered, 'the id is taken from the numbered frame')
  assert.match(
    main.slice(issued, issued + 120),
    /captureCountSession = store\.sessionId/,
    'the counter is kept on the session the capture was made in',
  )
})

test('source shape: MAIN7-1: every write that follows an analysis checks that its id still holds the same capture', () => {
  const main = read('src/main.ts')
  const docStart = main.indexOf('async function doCapture() {')
  const persisted = main.indexOf('const capturePersisted = store.putCapture(', docStart)
  const kept = main.indexOf('storedCapture = store.getCapture(pendingCaptureId)', docStart)
  const analysed = main.indexOf('const rawDets = await router.infer(blob)', docStart)
  assert.ok(persisted > docStart && kept > persisted, 'the record the frame was stored as is kept, straight after the write')
  assert.ok(analysed > kept, 'inference is awaited after the record is kept')

  // The untracked branch awaits the frame write, then marks the record. Guarded there too.
  const untracked = main.indexOf('if (stillThisCapture(pendingCaptureId)) await store.markCaptureFailed(pendingCaptureId,', docStart)
  assert.ok(untracked > docStart && untracked < analysed, 'the untracked branch checks the capture before it marks it')

  const afterAnalysis = [
    'if (isSameCapture(pendingRecord, storedCapture, store.sessionId)) {',
    'if (stillThisCapture(pendingCaptureId)) await store.attachDetections(pendingCaptureId, [...captureKeys])',
    'if (stillThisCapture(id)) void store.markCaptureFailed(id,',
    "isFrameUnusable(q) && stillThisCapture(id) ? store.discardFrame(id, 'quality') : undefined",
  ]
  for (const write of afterAnalysis) {
    const at = main.indexOf(write, docStart)
    assert.ok(at > analysed, 'guarded after the analysis: ' + write)
  }
  const upsert = main.indexOf('await store.upsert(merged, thumbMap)', docStart)
  assert.ok(upsert > main.indexOf('if (isSameCapture(pendingRecord, storedCapture, store.sessionId)) {', docStart), 'the upsert sits inside its check')
})

test('source shape: MAIN7-1: the adoption keeps Math.max and keeps the counter on the session it adopted', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('kfStreamer.onSessionId = (sessionId) => {')
  assert.ok(start > 0, 'the session-id hook is in main')
  const body = main.slice(start, main.indexOf('// A tap during a start or stop', start))
  assert.match(body, /captureCount = Math\.max\(captureCount, highestCaptureIndex\(store\.captures\.values\(\), store\.sessionId\)\)/)
  assert.match(body, /captureCountSession = store\.sessionId/)
})

test('source shape: MAIN7-3: the adoption has a rejection handler that logs the error and does not rethrow', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('kfStreamer.onSessionId = (sessionId) => {')
  const body = main.slice(start, main.indexOf('// A tap during a start or stop', start))
  const handler = body.indexOf('}, (err: unknown) => {')
  assert.ok(handler > 0, 'the adoption has a second argument to then, for a failure')
  const failure = body.slice(handler)
  assert.match(failure, /console\.error\('\[main\] could not finish adopting the server session; the scan carries on under it:', err\)/, 'the failure is logged')
  assert.doesNotMatch(failure, /throw\b/, 'the failure is not rethrown')
  assert.doesNotMatch(body, /\.catch\(\(\) => \{\s*\}\)/, 'no failure is swallowed silently')
})

// ── MAIN7-2: the superseded notice ───────────────────────────────────────────────

test('source shape: MAIN7-2: the store package provides the superseded API that the scanner wiring reads', () => {
  const store = read('src/scene/store.ts')
  assert.match(store, /get isSuperseded\(\): boolean \{/, 'a boolean getter for whether this store was superseded')
  assert.match(store, /onSuperseded\(listener: \(\) => void\): \(\) => void \{/, 'a listener registration that returns an unsubscribe')
})

test('source shape: MAIN7-2: the superseded notice is wired once, where the store is made, with the copy as written', () => {
  const main = read('src/main.ts')
  assert.equal(main.split(SUPERSEDED_COPY).length - 1, 1, 'the copy appears once, exactly as written')
  assert.equal(main.split('store.onSuperseded(').length - 1, 1, 'the listener is registered once')
  const made = main.indexOf('const store = readOnlyScanner ? new DetectionStore({ readOnly: true }) : new DetectionStore()')
  const wired = main.indexOf('store.onSuperseded(', made)
  const opened = main.indexOf('await store.open()', made)
  assert.ok(made > 0 && wired > made && wired < opened, 'the notice is wired where the store is created, before it opens')
  const wiring = main.slice(made, opened)
  assert.doesNotMatch(wiring, /if \(store\.isSuperseded\) showSuperseded\(\)/, 'no branch for a store that is already superseded: the listener above hears any supersession, including one during open()')
  assert.match(wiring, /const SUPERSEDED_NOTICE = 'This scan is open in another tab\. Changes here are not saved\. Reload this page to continue\.'/, 'the copy, exactly as written')
  assert.match(wiring, /const showSuperseded = \(\) => overlay\.setStatus\(SUPERSEDED_NOTICE, 'sticky'\)/, 'the notice goes into the status line, held')
})

// ── MAIN8-5: the counter copy above is checked against main.ts ───────────────────

test('source shape: MAIN8-5: main.ts numbers captures with captureCountFor from the shared module, and keeps no copy of it', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /import \{[^}]*\bcaptureCountFor\b[^}]*\} from '\.\/shared\/capture-index\.ts'/,
    'the rule is imported from src/shared/capture-index.ts',
  )
  assert.doesNotMatch(main, /(?:function|const) captureCountFor\b/, 'main.ts defines no copy of the rule')

  // The steps the counter takes when the live session may have changed, in main.ts's own words.
  // scannerCounter.follow above takes the same steps; a change to either one fails here.
  const start = main.indexOf('function followCaptureSession(): void {')
  assert.ok(start > 0, 'followCaptureSession is in main')
  const steps = main
    .slice(start, main.indexOf('\n  }\n', start))
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
  assert.deepEqual(steps, [
    'const live = store.sessionId',
    'if (live !== captureCountSession) leftCaptureCount.set(captureCountSession, captureCount)',
    'captureCount = captureCountFor(live, captureCountSession, captureCount, store.captures.values(), leftCaptureCount)',
    'captureCountSession = live',
  ], 'followCaptureSession takes the steps that scannerCounter copies')
})
