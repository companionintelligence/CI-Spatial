/**
 * Ending a scan and beginning the next one (WP-09b, src/ar/reanchor-host.ts), run against the real scan store, the real
 * epoch log and the real flow, with a page built the way src/main.ts builds it.
 *
 * The claim this holds is the work package's third step: Re-anchor finishes and uploads the current scan through the path
 * it already has, and begins a new one, a second Place entry with a new session id, stamped `<arRunId>.<epoch>` on its
 * detections and captures, calibrated again by the return-visit flow, in the epoch the runtime moved to. Nothing of the
 * old scan is carried over into it, and nothing of it is lost: if it cannot be saved, nothing is ended.
 *
 * The page here mirrors the lines of src/main.ts that make the ports (`createScanHost({...})`): the same calls in the same
 * order on the same real store. tests/unit/node/wp-09b-wiring.test.ts holds main.ts to those lines, and the Playwright
 * spec tests/mock-reanchor.spec.ts runs the real page.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-reanchor-host.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPTURE_SETTLE_LIMIT_MS, carryCalibration, createScanHost, type ExportedScan, type ScanHostTiming } from '../../../src/ar/reanchor-host.ts'
import { ReanchorFlow, type ReanchorHost } from '../../../src/ar/reanchor-flow.ts'
import { ScanFrameEpochLog } from '../../../src/ar/frame-epoch.ts'
import { DetectionStore } from '../../../src/scene/store.ts'
import { isSameCapture } from '../../../src/shared/capture-index.ts'
import type { StoredDetection } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'
import type { ScanCalibration, ScanEntry } from '../../../src/world/types.ts'
import { fakeScanIdb, type FakeScanIdb } from './support/fake-scan-idb.ts'
import { FakeProvider, FakeView, rig, settle, twoPointCalibration, twoPointFrame, waitFor } from './support/reanchor-rig.ts'

let idb: FakeScanIdb

beforeEach(() => {
  idb = fakeScanIdb()
  Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true, writable: true })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
})

const pose = (): CaptureResult['pose'] => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
const frame = (): Blob => new Blob([new Uint8Array(8)], { type: 'image/jpeg' })

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

interface Options {
  exportOutcome?: ExportedScan | 'throw'
  recordThrows?: boolean
  ensureEntryThrows?: boolean
  calibrations?: Array<ScanCalibration | null>
  streaming?: boolean
  empty?: boolean
  /** The calibration waits for `releaseCalibration()`: the person is at the card. */
  holdCalibration?: boolean
  /** A capture is being analysed, until `state.capturing` is set false. */
  capturing?: boolean
  timing?: ScanHostTiming
}

/** A page as src/main.ts builds one: the real store, the real log and flow, and fakes only for what needs a phone or a server. */
async function page(options: Options = {}) {
  const store = new DetectionStore()
  await store.open()
  store.startArRun('run-a')
  const provider = new FakeProvider()
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  const view = new FakeView()

  const calls: string[] = []
  const entries: ScanEntry[] = []
  const exports: Array<{ sessionId: string; calibration: ScanCalibration | undefined; entryId: string; closures: number | undefined }> = []
  const state = {
    sessionScanEntry: null as ScanEntry | null,
    sessionCalibration: undefined as ScanCalibration | undefined,
    pointCount: 400,
    poseHistory: [{ position: { x: 0, y: 1.5, z: 0 } }, { position: { x: 1, y: 1.5, z: 0 } }],
    lastUploadedFilename: undefined as string | undefined,
    currentSessionGlbFilename: undefined as string | undefined,
    keyframesStarted: 0,
    keyframesActive: options.streaming === true,
    resetWith: [] as number[],
    inAutosaveLock: false,
    exportedInLock: false,
    capturing: options.capturing === true,
  }
  if (options.empty) {
    state.pointCount = 0
    state.poseHistory.length = 0
  }

  // As src/main.ts's ensureSessionScanEntry: an entry that exists takes the calibration it was made without.
  const ensureSessionScanEntry = async (): Promise<ScanEntry> => {
    if (options.ensureEntryThrows && state.sessionCalibration && entries.length > 0) throw new Error('the project store is down')
    if (state.sessionScanEntry) {
      if (carryCalibration(state.sessionScanEntry, state.sessionCalibration)) calls.push('updateEntry')
      return state.sessionScanEntry
    }
    calls.push('createEntry')
    const entry: ScanEntry = {
      scanId: `scan-${entries.length + 1}`,
      projectId: 'place-1',
      areaId: null,
      sessionId: store.sessionId,
      name: 'Kitchen scan',
      status: 'draft',
      capturedAt: 1_700_000_000_000 + entries.length,
      ...(state.sessionCalibration ? { calibration: state.sessionCalibration } : {}),
    }
    entries.push(entry)
    state.sessionScanEntry = entry
    return entry
  }

  const resetScanner = (detectionCount: number): void => {
    calls.push('resetScan')
    state.resetWith.push(detectionCount)
    state.pointCount = 0
    state.poseHistory.length = 0
    state.sessionScanEntry = null
    log.reset()
    flow.noteScanReset()
  }

  let outcomes = [...(options.calibrations ?? [twoPointCalibration({ calibratedAt: '2026-11-17T09:31:00.000Z' })])]
  let releaseCalibration: () => void = () => {}
  const calibrationGate = options.holdCalibration ? new Promise<void>((resolve) => { releaseCalibration = resolve }) : null
  /** An export that is not the re-anchor's: what an autosave or a manual export does under the calibration card. */
  const exportNow = async (): Promise<void> => {
    calls.push('exportNow')
    const entry = await ensureSessionScanEntry()
    exports.push({ sessionId: store.sessionId, calibration: entry.calibration, entryId: entry.scanId, closures: log.snapshot().closures?.length })
  }
  const host = createScanHost({
    store: {
      saveSnapshot: async () => {
        calls.push('saveSnapshot')
        return store.saveSnapshot()
      },
      beginSession: async () => {
        calls.push('beginSession')
        return store.beginSession()
      },
      startArRun: (id) => {
        calls.push(`startArRun:${id}`)
        return store.startArRun(id)
      },
      currentRunDetections: () => store.currentRunDetections(),
    },
    exclusive: async (fn) => {
      state.inAutosaveLock = true
      try {
        return await fn()
      } finally {
        state.inAutosaveLock = false
      }
    },
    hasContent: () => state.pointCount > 0 || store.currentRunDetections().size > 0 || state.poseHistory.length > 0,
    exportScan: async () => {
      calls.push('exportScan')
      state.exportedInLock = state.inAutosaveLock
      const entry = await ensureSessionScanEntry()
      exports.push({ sessionId: store.sessionId, calibration: entry.calibration, entryId: entry.scanId, closures: log.snapshot().closures?.length })
      if (options.exportOutcome === 'throw') throw new Error('the upload threw')
      return options.exportOutcome ?? { upload: 'uploaded', uploadedFilename: `scan-${exports.length}.glb` }
    },
    recordUploaded: async (filename) => {
      calls.push('recordUploaded')
      if (options.recordThrows) throw new Error('indexeddb is full')
      const entry = state.sessionScanEntry!
      entry.scanFilename = filename
      entry.status = 'ready'
      state.lastUploadedFilename = filename
      state.currentSessionGlbFilename = filename
    },
    resetScan: resetScanner,
    clearCalibration: () => {
      calls.push('clearCalibration')
      state.sessionCalibration = undefined
      log.forgetCalibration()
    },
    get keyframes() {
      return {
        active: state.keyframesActive,
        start: async () => {
          calls.push('keyframes.start')
          state.keyframesStarted++
        },
      }
    },
    calibrate: async () => {
      calls.push('calibrate')
      if (calibrationGate) await calibrationGate
      const made = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!
      if (made === null) return false
      state.sessionCalibration = made
      log.noteCalibrated(log.currentEpoch)
      return true
    },
    ensureEntry: ensureSessionScanEntry,
    capturing: () => state.capturing,
  }, { pollMs: 1, ...options.timing })
  const reanchorHost: ReanchorHost = {
    ...host,
    storedFrame: () => twoPointFrame(),
    calibration: () => state.sessionCalibration,
    poses: () => state.poseHistory,
    readTap: async () => {
      throw new Error('not used here')
    },
    say: () => {},
  }
  const flow = new ReanchorFlow({ view, host: reanchorHost, epochs: log, arRunId: () => store.arRunId })
  flow.attach(provider)

  // The first scan: calibrated in epoch 0, with something in it.
  const [sofaKey, sofa] = placed('sofa', 0)
  await store.upsert(new Map([[sofaKey, sofa]]), new Map())
  await store.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  state.sessionCalibration = twoPointCalibration({ calibratedAt: '2026-11-17T09:00:00.000Z' })
  log.noteCalibrated(0)
  flow.arm()
  return { store, provider, log, view, flow, state, calls, entries, exports, sofaKey, exportNow, releaseCalibration: () => releaseCalibration(), resetOutcomes: () => (outcomes = []) }
}

// ── The whole sequence ──────────────────────────────────────────────────────────────────────────────

test('Re-anchor ends the scan through the export, and begins a second one with its own session, its own entry and a calibration', async () => {
  const p = await page()
  const firstSession = p.store.sessionId
  p.provider.discontinuity('jump')
  p.provider.discontinuity('recovered')
  assert.equal(p.provider.epoch, 2)
  assert.equal(p.view.kind, 'interruption')

  p.view.press('reanchor')
  await waitFor(() => p.flow.phase === 'watching', 'the new scan to be calibrated and watched')

  // The old scan: saved first, exported with the calibration it was made with, and recorded against its entry.
  assert.deepEqual(p.calls, [
    'saveSnapshot',
    'exportScan',
    'createEntry', // the old scan's entry, made by the export as it always is
    'recordUploaded',
    'beginSession',
    'startArRun:run-a.2',
    'resetScan',
    'clearCalibration',
    'calibrate',
    'createEntry', // the new scan's entry, once it has a calibration
  ])
  assert.equal(p.exports.length, 1)
  assert.equal(p.exports[0]!.sessionId, firstSession)
  assert.equal(p.exports[0]!.calibration?.calibratedAt, '2026-11-17T09:00:00.000Z', 'the finished scan keeps its base calibration')
  assert.equal(p.entries[0]!.status, 'ready')
  assert.equal(p.entries[0]!.scanFilename, 'scan-1.glb')

  // The new scan: a second entry, a new session, the new calibration, in the epoch the runtime moved to.
  assert.equal(p.entries.length, 2, 'a second entry')
  assert.notEqual(p.entries[1]!.sessionId, p.entries[0]!.sessionId, 'with a new session id')
  assert.equal(p.entries[1]!.sessionId, p.store.sessionId)
  assert.notEqual(p.store.sessionId, firstSession)
  assert.equal(p.entries[1]!.calibration?.calibratedAt, '2026-11-17T09:31:00.000Z', 'carrying the calibration the return-visit flow made')
  assert.equal(p.entries[1]!.status, 'draft')
  assert.equal(p.log.calibrationEpoch, 2, 'calibrated in the new epoch')
  assert.equal(p.log.snapshot().calibrationEpoch, 2, 'and the sidecar will say so')
  assert.equal(p.log.snapshot().baseEpoch, 2, 'the new scan began there')
  assert.equal(p.log.frameShifts, 0)
  assert.equal(p.flow.phase, 'watching')
  assert.equal(p.flow.recordingHeld, false)
})

test('the new scan is stamped with the run and the epoch it began in, and the old one is not in its view', async () => {
  const p = await page()
  p.provider.discontinuity()
  p.provider.discontinuity()
  await p.flow.reanchor()

  assert.equal(p.store.arRunId, 'run-a.2')
  assert.equal(p.store.currentRunDetections().size, 0, 'the sofa belongs to the scan that ended')
  const [lampKey, lamp] = placed('lamp', 2)
  await p.store.upsert(new Map([[lampKey, lamp]]), new Map())
  await p.store.putCapture({ captureIndex: 1, timestamp: 9, pose: pose(), blob: frame() })
  assert.equal(p.store.detections.get(lampKey)?.arRunId, 'run-a.2')
  assert.equal(p.store.getCapture(p.store.captureIdFor(1))?.arRunId, 'run-a.2')
  assert.deepEqual([...p.store.currentRunDetections().keys()], [lampKey])

  // The old scan is in the history, as it was saved, stamped with the run it was made in.
  const rows = idb.rows('sessions') as unknown as Array<{ sessionId: string; detections: Array<[string, StoredDetection]> }>
  const old = rows.find((row) => row.detections.some(([key]) => key === p.sofaKey))
  assert.ok(old, 'the old scan\'s record was kept')
  assert.equal(old!.detections[0]![1].arRunId, 'run-a')
})

test('what the old scan held is emptied for the new one, and the page is told how many objects were left behind', async () => {
  const p = await page()
  p.provider.discontinuity()
  await p.flow.reanchor()
  assert.deepEqual(p.state.resetWith, [1], 'one object, read before the store moved on')
  assert.equal(p.state.pointCount, 0)
  assert.equal(p.state.poseHistory.length, 0)
})

test('the calibration is forgotten before the new one is made, so a scan that is not calibrated carries none', async () => {
  const p = await page({ calibrations: [null] })
  p.provider.discontinuity()
  const outcome = await p.flow.reanchor()
  assert.deepEqual(outcome, { ok: true, calibrated: false, epoch: 1 })
  assert.equal(p.state.sessionCalibration, undefined, 'a Clear keeps the calibration; this is not a Clear')
  assert.equal(p.log.calibrationEpoch, null)
  assert.equal(p.entries.length, 1, 'no entry for a scan that has not been exported: the next export makes it, uncalibrated')
  assert.equal(p.flow.phase, 'off')
})

test('the entry of the new scan is made when its calibration is, not before, and making it is not an export', async () => {
  const p = await page()
  p.provider.discontinuity()
  await p.flow.reanchor()
  const entryAt = p.calls.lastIndexOf('createEntry')
  assert.ok(entryAt > p.calls.indexOf('calibrate'), 'after the calibration the entry carries')
  assert.equal(p.calls.slice(p.calls.indexOf('beginSession'), entryAt).includes('createEntry'), false, 'and not before it')
  assert.equal(p.entries.length, 2)
  assert.equal(p.exports.length, 1)
})

// ── When something goes wrong ───────────────────────────────────────────────────────────────────────

test('when the scan cannot be saved nothing is ended: the session, the objects, the calibration and the cloud are as they were', async () => {
  const p = await page({ exportOutcome: { upload: 'failed' } })
  const session = p.store.sessionId
  p.provider.discontinuity()
  const outcome = await p.flow.reanchor()
  assert.deepEqual(outcome, { ok: false, reason: 'save-failed' })
  assert.equal(p.store.sessionId, session)
  assert.equal(p.store.currentRunDetections().size, 1)
  assert.equal(p.store.arRunId, 'run-a')
  assert.equal(p.state.pointCount, 400, 'the point cloud exists nowhere else')
  assert.equal(p.state.sessionCalibration?.calibratedAt, '2026-11-17T09:00:00.000Z')
  assert.deepEqual(p.calls.filter((call) => ['beginSession', 'resetScan', 'clearCalibration', 'calibrate'].includes(call)), [])
  assert.equal(p.flow.recordingHeld, true, 'the choice is still open')
})

test('an upload that throws is a failed save, not a crash', async () => {
  const p = await page({ exportOutcome: 'throw' })
  p.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await p.flow.reanchor(), { ok: false, reason: 'save-failed' })
  } finally {
    console.error = error
  }
  assert.equal(p.calls.includes('beginSession'), false)
})

/** The host over bare ports, for what it answers to the flow and not what the flow does with it. */
function bareHost(
  exportScan: () => Promise<ExportedScan>,
  extra: {
    capturing?: () => boolean
    exclusive?: <T>(fn: () => Promise<T>) => Promise<T>
    timing?: ScanHostTiming
    beginSession?: () => boolean
    steps?: string[]
  } = {},
) {
  const recorded: string[] = []
  const steps = extra.steps ?? []
  const host = createScanHost({
    store: {
      saveSnapshot: async () => true,
      beginSession: () => {
        steps.push('beginSession')
        return extra.beginSession ? extra.beginSession() : true
      },
      startArRun: (id) => {
        steps.push('startArRun')
        return id ?? ''
      },
      currentRunDetections: () => ({ size: 0 }),
    },
    exclusive: extra.exclusive ?? ((fn) => fn()),
    hasContent: () => true,
    exportScan,
    recordUploaded: async (filename) => {
      recorded.push(filename)
    },
    resetScan: () => {
      steps.push('resetScan')
    },
    clearCalibration: () => {
      steps.push('clearCalibration')
    },
    keyframes: null,
    calibrate: async () => false,
    ensureEntry: async () => undefined,
    ...(extra.capturing ? { capturing: extra.capturing } : {}),
  }, extra.timing)
  return { host, recorded, steps }
}

test('a scan is saved when the server says it was and names the file, and for no other reason', async () => {
  const outcomes: ExportedScan[] = [
    { upload: 'uploaded' },
    { upload: 'failed', uploadedFilename: 'earlier.glb' },
    { upload: 'skipped', uploadedFilename: 'earlier.glb' },
    { upload: 'failed' },
  ]
  for (const outcome of outcomes) {
    const { host, recorded } = bareHost(async () => outcome)
    assert.equal(await host.finishScan(), 'failed', JSON.stringify(outcome))
    assert.deepEqual(recorded, [], 'nothing is recorded against a scan that was not saved')
  }
  const saved = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'kitchen.glb' }))
  assert.equal(await saved.host.finishScan(), 'uploaded')
  assert.deepEqual(saved.recorded, ['kitchen.glb'])
})

test('an export that throws answers failed, so the flow is told and the autosave lock is let go', async () => {
  const { host } = bareHost(async () => {
    throw new Error('the upload threw')
  })
  const { error } = console
  console.error = () => {}
  try {
    assert.equal(await host.finishScan(), 'failed')
  } finally {
    console.error = error
  }
})

test('a scan the service worker holds for later is ended: it is safe, and nothing is recorded against its entry yet', async () => {
  const p = await page({ exportOutcome: { upload: 'queued-offline' } })
  p.provider.discontinuity()
  const outcome = await p.flow.reanchor()
  assert.equal(outcome.ok, true)
  assert.equal(p.calls.includes('recordUploaded'), false, 'there is no file name to record')
  assert.equal(p.entries[0]!.status, 'draft')
  assert.equal(p.calls.includes('beginSession'), true)
})

test('an interruption before anything was recorded ends no scan and exports nothing, and the next one still begins', async () => {
  const p = await page({ empty: true })
  await p.store.clear()
  p.provider.discontinuity()
  const outcome = await p.flow.reanchor()
  assert.equal(outcome.ok, true)
  assert.equal(p.exports.length, 0, 'an empty scan is not uploaded')
  assert.deepEqual(p.calls.slice(0, 2), ['saveSnapshot', 'beginSession'])
})

test('bookkeeping that fails does not undo a scan that is on the server', async () => {
  const p = await page({ recordThrows: true })
  p.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    const outcome = await p.flow.reanchor()
    assert.equal(outcome.ok, true, 'the scan was saved, so the next one begins')
  } finally {
    console.error = error
  }
  assert.equal(p.calls.includes('beginSession'), true)
})

test('a new scan whose entry cannot be made yet is still calibrated, and its entry comes with the next export', async () => {
  const p = await page({ ensureEntryThrows: true })
  p.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await p.flow.reanchor(), { ok: true, calibrated: true, epoch: 1 })
  } finally {
    console.error = error
  }
  assert.ok(p.state.sessionCalibration)
  assert.equal(p.entries.length, 1)
})

// ── Taking nothing from the autosave, and keeping the stream ────────────────────────────────────────

test('the scan is exported while no autosave can run', async () => {
  const p = await page()
  p.provider.discontinuity()
  await p.flow.reanchor()
  assert.equal(p.state.exportedInLock, true)
  assert.equal(p.state.inAutosaveLock, false, 'and the lock is let go')
})

test('keyframe streaming that was on is started again for the new scan, and is not started when it was off', async () => {
  const on = await page({ streaming: true })
  on.provider.discontinuity()
  await on.flow.reanchor()
  await waitFor(() => on.state.keyframesStarted > 0, 'the stream to start again')
  assert.equal(on.state.keyframesStarted, 1)
  assert.ok(on.calls.indexOf('resetScan') < on.calls.indexOf('keyframes.start'), 'after the page stopped the old stream')

  const off = await page({ streaming: false })
  off.provider.discontinuity()
  await off.flow.reanchor()
  await settle()
  assert.equal(off.state.keyframesStarted, 0)
})

test('the keyframe session of the scan that ended is linked to the file it was saved as, before the stream is stopped', async () => {
  const p = await page({ streaming: true })
  p.provider.discontinuity()
  await p.flow.reanchor()
  assert.equal(p.state.currentSessionGlbFilename, 'scan-1.glb')
  assert.ok(p.calls.indexOf('recordUploaded') < p.calls.indexOf('resetScan'), 'the page stops the stream inside resetScan, so the name has to be there first')
})

// ── A second break ──────────────────────────────────────────────────────────────────────────────────

test('a second interruption after the first Re-anchor ends the new scan the same way, with the epoch replacing the old one', async () => {
  const p = await page()
  p.provider.discontinuity()
  await p.flow.reanchor()
  p.state.pointCount = 250 // the second scan has recorded something by the time it is interrupted
  p.provider.discontinuity('resumed')
  assert.equal(p.view.kind, 'interruption')
  await p.flow.reanchor()
  assert.equal(p.store.arRunId, 'run-a.2')
  assert.equal(p.entries.length, 3)
  assert.equal(new Set(p.entries.map((entry) => entry.sessionId)).size, 3, 'three scans, three sessions')
  assert.equal(p.exports.length, 2)
  assert.equal(p.exports[1]!.calibration?.calibratedAt, '2026-11-17T09:31:00.000Z', 'the second scan ended keeping the calibration it was made with')
})

// ── An export while the new scan is being calibrated ────────────────────────────────────────────────

test('an export while the new scan is being calibrated makes its entry without a calibration, and the calibration reaches that entry once it is made', async () => {
  const p = await page({ holdCalibration: true })
  p.provider.discontinuity()
  const done = p.flow.reanchor()
  await waitFor(() => p.flow.phase === 'calibrating', 'the new scan to be at the calibration card')

  // An autosave, or a manual export, while the card is open: the entry is made now, and there is no calibration to give it.
  await p.exportNow()
  assert.equal(p.entries.length, 2)
  assert.equal(p.entries[1]!.calibration, undefined, 'it had none yet')
  assert.equal(p.exports.at(-1)!.calibration, undefined, 'and so did what went up')

  p.releaseCalibration()
  assert.deepEqual(await done, { ok: true, calibrated: true, epoch: 1 })
  assert.equal(p.entries.length, 2, 'the entry that exists is the new scan\'s, and no other is made')
  assert.equal(p.entries[1]!.calibration?.calibratedAt, '2026-11-17T09:31:00.000Z', 'it has the calibration now')
  assert.ok(p.calls.lastIndexOf('updateEntry') > p.calls.indexOf('calibrate'), 'given when the calibration was made, by the step that makes the entry')

  // Every later export of the scan says so: this is what the server places it by.
  await p.exportNow()
  assert.equal(p.exports.at(-1)!.calibration?.calibratedAt, '2026-11-17T09:31:00.000Z')
  assert.equal(p.exports.at(-1)!.entryId, p.entries[1]!.scanId)
})

test('an entry that exists before the calibration is made is the one the scan is placed by, and the old scan\'s entry is not touched', async () => {
  const p = await page({ holdCalibration: true })
  p.provider.discontinuity()
  const done = p.flow.reanchor()
  await waitFor(() => p.flow.phase === 'calibrating', 'the new scan to be at the calibration card')
  await p.exportNow()
  p.releaseCalibration()
  await done
  assert.equal(p.entries[0]!.calibration?.calibratedAt, '2026-11-17T09:00:00.000Z', 'the finished scan keeps its base calibration')
  assert.equal(p.entries[0]!.scanFilename, 'scan-1.glb')
  assert.equal(p.entries[1]!.status, 'draft')
})

test('a scan the person continues without calibrating keeps the entry an export made, with no calibration', async () => {
  const p = await page({ holdCalibration: true, calibrations: [null] })
  p.provider.discontinuity()
  const done = p.flow.reanchor()
  await waitFor(() => p.flow.phase === 'calibrating', 'the new scan to be at the calibration card')
  await p.exportNow()
  p.releaseCalibration()
  assert.deepEqual(await done, { ok: true, calibrated: false, epoch: 1 })
  assert.equal(p.entries[1]!.calibration, undefined, 'nothing to carry: the old scan\'s calibration was forgotten')
  assert.equal(p.calls.includes('updateEntry'), false)
})

test('the calibration is given to an entry that has none, once, and an entry that has one keeps it', () => {
  const made = twoPointCalibration({ calibratedAt: '2026-11-17T09:31:00.000Z' })
  const own = twoPointCalibration({ calibratedAt: '2026-11-17T09:00:00.000Z' })

  const bare: { calibration?: ScanCalibration } = {}
  assert.equal(carryCalibration(bare, made), true, 'the entry changed, so the caller saves it')
  assert.equal(bare.calibration, made)
  assert.equal(carryCalibration(bare, made), false, 'nothing to save the second time')

  const calibrated: { calibration?: ScanCalibration } = { calibration: own }
  assert.equal(carryCalibration(calibrated, made), false)
  assert.equal(calibrated.calibration, own, 'an entry with a calibration of its own keeps it')

  const waiting: { calibration?: ScanCalibration } = {}
  assert.equal(carryCalibration(waiting, undefined), false, 'a scan with no calibration has none to give')
  assert.equal('calibration' in waiting, false, 'and the entry is not given an empty one')
})

// ── A capture that is being analysed when Re-anchor is pressed ──────────────────────────────────────

test('the save waits for a capture that is being analysed, and takes the autosave lock only once it is done', async () => {
  let analysing = true
  let clock = 0
  const order: string[] = []
  const { host } = bareHost(async () => {
    order.push('export')
    return { upload: 'uploaded', uploadedFilename: 'kitchen.glb' }
  }, {
    capturing: () => analysing,
    exclusive: (fn) => {
      order.push('lock')
      return fn()
    },
    timing: {
      limitMs: 1_000,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        order.push(`wait ${ms}`)
        if (clock >= 300) analysing = false
      },
    },
  })
  assert.equal(await host.finishScan(), 'uploaded')
  assert.deepEqual(order, ['wait 100', 'wait 100', 'wait 100', 'lock', 'export'], 'before the lock, so the capture\'s own autosave is the one the lock cancels')
})

test('a capture that never answers holds the save for no longer than the limit, and then the scan is ended without it', async () => {
  let clock = 0
  const waits: number[] = []
  const { host } = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'kitchen.glb' }), {
    capturing: () => true,
    timing: {
      limitMs: 1_000,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        waits.push(ms)
      },
    },
  })
  assert.equal(await host.finishScan(), 'uploaded')
  assert.equal(waits.length, 10, 'ten looks of 100 ms, and then it stopped waiting')
  assert.equal(clock, 1_000)
})

test('the limit on the wait is a few times what the page says a capture takes, and is adopted, not measured', () => {
  assert.equal(CAPTURE_SETTLE_LIMIT_MS, 15_000)
})

test('the save does not wait when no capture is being analysed, and a page with no capture path does not look', async () => {
  const waits: number[] = []
  const timing: ScanHostTiming = { sleep: async (ms) => { waits.push(ms) }, now: () => 0 }
  const idle = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), { capturing: () => false, timing })
  assert.equal(await idle.host.finishScan(), 'uploaded')
  const none = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), { timing })
  assert.equal(await none.host.finishScan(), 'uploaded')
  assert.deepEqual(waits, [])
})

test('the wait runs on the real clock when it is not given one', async () => {
  let looks = 0
  const { host } = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), {
    capturing: () => ++looks < 4,
    timing: { pollMs: 2 },
  })
  const started = Date.now()
  assert.equal(await host.finishScan(), 'uploaded')
  assert.equal(looks, 4)
  assert.ok(Date.now() - started >= 4, 'it slept between the looks')
})

test('a capture that finishes while Re-anchor is saving is written into the scan that is ending, and the next scan does not have it', async () => {
  const p = await page({ capturing: true })
  const firstSession = p.store.sessionId
  p.provider.discontinuity()
  const done = p.flow.reanchor()
  await waitFor(() => p.flow.phase === 'finishing', 'the save to begin')
  await new Promise<void>((resolve) => setTimeout(resolve, 25))
  assert.equal(p.calls.includes('saveSnapshot'), false, 'the save is waiting for the capture')

  // The model answers: what main.ts's capture does next is write the objects into the live scan, which is still this one.
  const captureId = p.store.captureIdFor(2)
  await p.store.putCapture({ captureIndex: 2, timestamp: 2, pose: pose(), blob: frame() })
  const stored = p.store.getCapture(captureId)
  const [lampKey, lamp] = placed('lamp', 2)
  assert.equal(isSameCapture(p.store.getCapture(captureId), stored, p.store.sessionId), true, 'the page\'s own guard lets it in')
  await p.store.upsert(new Map([[lampKey, lamp]]), new Map())
  p.state.capturing = false

  assert.deepEqual(await done, { ok: true, calibrated: true, epoch: 1 })
  const rows = idb.rows('sessions') as unknown as Array<{ sessionId: string; detections: Array<[string, StoredDetection]> }>
  const old = rows.find((row) => row.sessionId === firstSession)
  assert.ok(old?.detections.some(([key]) => key === lampKey), 'it is in the record of the scan that ended')
  assert.equal(p.store.currentRunDetections().size, 0, 'and the next scan starts with none')
})

test('a capture that was still being analysed when the scan ended is refused by the page\'s guard, so it is written into neither scan', async () => {
  const p = await page({ capturing: true, timing: { limitMs: 20, pollMs: 2 } })
  p.provider.discontinuity()
  const captureId = p.store.captureIdFor(2)
  await p.store.putCapture({ captureIndex: 2, timestamp: 2, pose: pose(), blob: frame() })
  const stored = p.store.getCapture(captureId)
  const outcome = await p.flow.reanchor() // the capture never answers: the scan is ended without it
  assert.equal(outcome.ok, true)
  assert.equal(isSameCapture(p.store.getCapture(captureId), stored, p.store.sessionId), false, 'the live session is the next scan\'s')
  assert.equal(p.store.currentRunDetections().size, 0)
})

// ── A store that cannot begin a session ─────────────────────────────────────────────────────────────

test('a store that does not begin a session ends nothing: the cloud, the calibration and the run are left as they were', async () => {
  const steps: string[] = []
  const { host } = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), { beginSession: () => false, steps })
  await assert.rejects(() => host.beginScan('run-a.1', 1), /did not begin a new session/)
  assert.deepEqual(steps, ['beginSession'], 'no run was started, nothing was emptied and no calibration was forgotten')
})

test('a store that begins one has the run started and the page emptied, in that order', async () => {
  const steps: string[] = []
  const { host } = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), { steps })
  await host.beginScan('run-a.1', 1)
  assert.deepEqual(steps, ['beginSession', 'startArRun', 'resetScan', 'clearCalibration'])
})

test('the flow turns a store that cannot begin a session into an error that leaves the scan recording, not a held one', async () => {
  const { host } = bareHost(async () => ({ upload: 'uploaded', uploadedFilename: 'a.glb' }), { beginSession: () => false })
  const r = rig()
  r.host.finishScan = host.finishScan
  r.host.beginScan = host.beginScan
  r.calibrateAndArm()
  r.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'error' })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.flow.heldHint, null)
})
