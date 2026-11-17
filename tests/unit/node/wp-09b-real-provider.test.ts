/**
 * One scan, one frame, with the real tracker under it (WP-09b): the 8th Wall provider's own discontinuity detector, the
 * scanner, the point cloud, the epoch log, the quality monitor, the scan store (over a fake IndexedDB), the flow and the
 * scan host, wired the way src/main.ts wires them and driven by scripted reality frames.
 *
 * The fake-provider tests (wp-09b-reanchor-flow.test.ts, wp-09b-reanchor-host.test.ts) hold each decision. What only the real
 * tracker can say is whether the claim the work package makes holds from end to end: that a scan which is held while the
 * choice is open has points from one epoch only, that Re-anchor leaves the scan it ends in one epoch and begins one in the
 * epoch the runtime moved to, that a shift while a drift check is open is held like any other, and that what the editor is
 * told (the sidecar, the verdict) says what was recorded. A relocalization here is the engine reporting LIMITED with the
 * reason RELOCALIZING and then NORMAL with the camera stepped a little: the tracker's "recovered" path (src/ar/frame-epoch.ts).
 *
 * The page's lines are mirrored (the tick that adds points, the entry, the reset, the ports): tests/unit/node/wp-09b-wiring.test.ts
 * holds src/main.ts to them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-real-provider.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { DEFAULT_INTERVAL_MS, RoomScanner } from '../../../src/ar/scanner.ts'
import { ScanFrameEpochLog } from '../../../src/ar/frame-epoch.ts'
import { PointCloud } from '../../../src/scene/pointcloud.ts'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'
import { DetectionStore } from '../../../src/scene/store.ts'
import { ReanchorFlow } from '../../../src/ar/reanchor-flow.ts'
import { carryCalibration, createScanHost } from '../../../src/ar/reanchor-host.ts'
import * as copy from '../../../src/ar/reanchor-copy.ts'
import { fakeScanIdb } from './support/fake-scan-idb.ts'
import { FakeView, twoPointCalibration, twoPointFrame, waitFor } from './support/reanchor-rig.ts'
import type { ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'
import { frameEpochFieldsFromMeta } from '../../../server/frame_epoch_fields.ts'
import { trackingNote } from '../../../src/viewer/scan-calibration-chip.ts'
import type { Pose } from '../../../src/ar/provider.ts'

;(globalThis as { document?: unknown }).document = {
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
}

interface EngineModule {
  name: string
  onUpdate?: (args: unknown) => void
}
let modules: EngineModule[] = []
;(globalThis as { XR8?: unknown }).XR8 = {
  loadChunk: async () => {},
  addCameraPipelineModules(mods: EngineModule[]): void {
    modules = mods
  },
  GlTextureRenderer: { pipelineModule: () => ({ name: 'gl' }) },
  Threejs: { pipelineModule: () => ({ name: 'three' }), xrScene: () => ({ scene: {}, camera: {}, renderer: {} }) },
  XrController: { pipelineModule: () => ({ name: 'xr' }), hitTest: () => [] },
  CameraPixelArray: { pipelineModule: () => ({ name: 'pixels' }) },
  XrConfig: { device: () => ({ ANY: 'any' }) },
  stop(): void {},
  run(): void {},
}

type Point = { x: number; y: number; z: number }

/** `n` points on a floor at height `y`, scattered a few millimetres: what the engine reports as the surface it has mapped. */
function floor(n: number, y: number, seed: number): Point[] {
  let s = seed >>> 0
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  return Array.from({ length: n }, () => ({ x: (rand() - 0.5) * 4, y: y + (rand() - 0.5) * 0.008, z: -1 - rand() * 3 }))
}

const FRAME_MS = 1000 / 30

let idb: ReturnType<typeof fakeScanIdb>
beforeEach(() => {
  idb = fakeScanIdb()
  Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true, writable: true })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
})

type TestContextLike = {
  mock: {
    method: (object: object, name: string, implementation: () => void) => unknown
    timers: { enable(options: { apis: string[] }): void; tick(ms: number): void }
  }
}

interface WorldOptions {
  frame?: ProjectSpatialFrame | null
}

interface Export {
  sessionId: string
  summary: ReturnType<ScanQualityMonitor['summary']>
  frameEpochs: ReturnType<ScanFrameEpochLog['snapshot']>
  calibration: ScanCalibration | undefined
  epochCounts: Array<{ epoch: number; count: number }>
}

async function world(t: TestContextLike, options: WorldOptions = {}) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setInterval'] })

  const provider = new EighthWallProvider()
  const clock = { t: 0 }
  const cloud = new PointCloud(0.05, () => clock.t)
  const log = new ScanFrameEpochLog()
  const monitor = new ScanQualityMonitor()
  const scanner = new RoomScanner()
  const store = new DetectionStore()
  await store.open()
  const poseHistory: Pose[] = []
  let sessionCalibration: ScanCalibration | undefined
  let sessionScanEntry: { sessionId: string; calibration?: ScanCalibration } | null = null
  const entries: Array<{ sessionId: string; calibration?: ScanCalibration }> = []
  const exportsMade: Export[] = []
  const said: string[] = []
  const view = new FakeView()
  const selected = { frame: options.frame === undefined ? twoPointFrame() : options.frame }

  log.attach(provider)
  await provider.start({ width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement)
  store.startArRun('run-a')
  const engine = modules.find((candidate) => candidate.name === 'ci-scan-capture')
  assert.ok(engine?.onUpdate, 'the provider put its capture module into the engine')

  // ---- The page's own lines (src/main.ts) ----
  const currentQualitySummary = () =>
    monitor.summary({
      pointCount: cloud.count,
      detectionCount: store.currentRunDetections().size,
      poseCount: poseHistory.length,
      keyframeCount: 5,
      frameShifts: log.frameShifts - flow.heldShifts,
      limitedMs: log.limitedMs,
      closureExceeded: log.closureExceeded,
    })
  async function ensureSessionScanEntry() {
    if (sessionScanEntry) {
      carryCalibration(sessionScanEntry, sessionCalibration)
      return sessionScanEntry
    }
    sessionScanEntry = { sessionId: store.sessionId, ...(sessionCalibration ? { calibration: sessionCalibration } : {}) }
    entries.push(sessionScanEntry)
    return sessionScanEntry
  }
  function resetScanner(): void {
    cloud.clear()
    poseHistory.length = 0
    sessionScanEntry = null
    monitor.reset()
    log.reset()
    flow.noteScanReset()
  }
  const scanHost = createScanHost({
    store,
    exclusive: (fn) => fn(),
    hasContent: () => cloud.count > 0 || store.currentRunDetections().size > 0 || poseHistory.length > 0,
    exportScan: async () => {
      await ensureSessionScanEntry()
      exportsMade.push({
        sessionId: store.sessionId,
        summary: currentQualitySummary(),
        frameEpochs: log.snapshot(cloud),
        calibration: sessionCalibration,
        epochCounts: cloud.epochCounts(),
      })
      return { upload: 'uploaded', uploadedFilename: `scan-${exportsMade.length}.glb` }
    },
    recordUploaded: async () => {},
    resetScan: resetScanner,
    clearCalibration: () => {
      sessionCalibration = undefined
      log.forgetCalibration()
    },
    keyframes: null,
    calibrate: async () => {
      const startEpoch = log.currentEpoch
      sessionCalibration = twoPointCalibration({ calibratedAt: '2026-11-17T09:31:00.000Z' })
      log.noteCalibrated(startEpoch)
      return true
    },
    ensureEntry: ensureSessionScanEntry,
  })
  const flow = new ReanchorFlow({
    view,
    epochs: log,
    arRunId: () => store.arRunId,
    host: {
      ...scanHost,
      storedFrame: () => selected.frame ?? null,
      calibration: () => sessionCalibration,
      poses: () => poseHistory,
      readTap: async () => {
        throw new Error('no tap in this test')
      },
      say: (text) => said.push(text),
    },
  })
  flow.attach(provider)

  // The scanner's tick, as main.ts's callback to it: nothing is added while recording is held.
  scanner.start(provider, (frame) => {
    const held = flow.recordingHeld
    if (!held) cloud.add(frame.points, frame.epoch)
    if (provider.isTracking() && !held) poseHistory.push(frame.pose)
    monitor.tick(provider, cloud)
  })

  // ---- The engine ----
  let frameMs = 0
  let x = 0
  const play = (f: { status: string; reason?: string; floorY?: number; seed?: number; x?: number }): void => {
    if (f.x !== undefined) x = f.x
    engine.onUpdate?.({
      processCpuResult: {
        reality: {
          position: { x, y: 1.5, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          trackingStatus: f.status,
          ...(f.reason ? { trackingReason: f.reason } : {}),
          ...(f.floorY === undefined ? {} : { worldPoints: floor(60, f.floorY, f.seed ?? 1) }),
        },
      },
      frameStartResult: { frameTime: frameMs / 1000 },
    })
    frameMs += FRAME_MS
    x += 0.0005
  }
  let seedN = 100
  const frames = (floorY = 0): void => {
    const n = Math.round(DEFAULT_INTERVAL_MS / FRAME_MS)
    for (let i = 0; i < n; i++) play({ status: 'NORMAL', ...(i === n - 1 ? { floorY, seed: seedN++ } : {}) })
  }
  const tick = (): void => {
    clock.t += DEFAULT_INTERVAL_MS
    t.mock.timers.tick(DEFAULT_INTERVAL_MS)
  }
  /** Walk for `ticks` scanner ticks, the floor mapped at `floorY`. */
  const walk = (ticks: number, floorY = 0): void => {
    for (let i = 0; i < ticks; i++) {
      frames(floorY)
      tick()
    }
  }
  /** The engine loses tracking and regains it after a relocalization, the pose stepped 0.2 m: the tracker's "recovered" path. */
  const relocalize = (): void => {
    play({ status: 'LIMITED', reason: 'RELOCALIZING', x: x + 0.2 })
    play({ status: 'NORMAL', reason: 'UNSPECIFIED' })
  }

  /** The first scan: some content, calibrated in epoch 0 and armed, as main.ts does once the calibration is made. */
  async function firstScan(): Promise<void> {
    walk(6)
    await store.upsert(new Map([['sofa:0.0,0.0,0.0', { label: 'sofa', confidence: 0.9, description: 'a sofa', bbox: [0, 0, 1, 1], worldPos: { x: 0, y: 0, z: 0 }, worldRot: { x: 0, y: 0, z: 0, w: 1 }, captureTimestamp: 1 } as never]]), new Map())
    sessionCalibration = twoPointCalibration({ calibratedAt: '2026-11-17T09:00:00.000Z' })
    log.noteCalibrated(0)
    flow.arm()
  }

  return {
    provider, cloud, log, store, flow, view, entries, exportsMade, said, poseHistory, selected,
    walk, relocalize, firstScan, currentQualitySummary,
    epochs: () => cloud.epochCounts().map((count) => count.epoch),
    setCalibration: (calibration: ScanCalibration | undefined) => {
      sessionCalibration = calibration
    },
  }
}

test('a shift after the calibration holds the scan; Re-anchor ends it in one epoch and begins the next in the epoch the runtime is in', async (t) => {
  const w = await world(t)
  await w.firstScan()
  const before = w.cloud.count
  assert.ok(before > 0)
  assert.equal(w.flow.phase, 'watching')

  w.relocalize()
  assert.equal(w.provider.getFrameEpoch(), 1, 'the tracker called it a discontinuity')
  assert.equal(w.flow.phase, 'prompting')
  assert.equal(w.flow.recordingHeld, true)
  const posesAtHold = w.poseHistory.length

  // The scanner keeps ticking while the person decides, and the floor it maps is now 10 cm higher: none of it is recorded.
  w.walk(4, 0.1)
  assert.equal(w.cloud.count, before, 'no points were added while the choice was open')
  assert.equal(w.poseHistory.length, posesAtHold, 'no poses either')
  assert.deepEqual(w.epochs(), [0])

  w.relocalize() // another, with the banner open
  assert.equal(w.provider.getFrameEpoch(), 2)
  assert.equal(w.flow.heldShifts, 2)
  assert.match(w.view.current!.text, /2 times/)

  w.view.press('reanchor')
  await waitFor(() => w.flow.phase === 'watching', 'the new scan to be calibrated and watched')
  const old = w.exportsMade[0]!
  assert.deepEqual(old.epochCounts.map((count) => count.epoch), [0], 'the scan that ended holds points from one epoch')
  assert.equal(old.frameEpochs.mixedEpochs, false)
  assert.equal(old.summary.frameShifts, 0, 'and is not counted as shifted for interruptions after which nothing was recorded')
  assert.equal(old.frameEpochs.jumpCount, 2, 'though the sidecar says what the tracker reported')
  assert.equal(old.frameEpochs.currentEpoch, 2)

  w.walk(5, 0.3)
  assert.deepEqual(w.epochs(), [2], 'the new scan is in the epoch the runtime moved to, and in one')
  assert.equal(w.log.frameShifts, 0)
  assert.equal(w.store.arRunId, 'run-a.2')
  assert.equal(w.entries.length, 2)
  assert.equal(w.entries[1]!.calibration?.calibratedAt, '2026-11-17T09:31:00.000Z', 'the new scan\'s entry has the calibration the return visit made')
})

test('a shift while a drift check is open holds the scan like any other, so what was recorded is still one epoch', async (t) => {
  const w = await world(t)
  await w.firstScan()
  w.view.handlers!.check()
  assert.equal(w.flow.phase, 'checking')
  const before = w.cloud.count

  w.relocalize()
  assert.equal(w.flow.phase, 'prompting', 'the check is over: its taps would be in two frames')
  assert.equal(w.flow.recordingHeld, true)
  w.walk(3, 0.1)
  assert.equal(w.cloud.count, before, 'nothing was recorded after the shift')
  assert.deepEqual(w.epochs(), [0], 'the cloud is one epoch')
  assert.equal(w.flow.heldShifts, 1)
  assert.equal(w.currentQualitySummary().frameShifts, 0)

  await w.flow.reanchor()
  assert.deepEqual(w.exportsMade[0]!.epochCounts.map((count) => count.epoch), [0])
  assert.equal(w.exportsMade[0]!.frameEpochs.mixedEpochs, false)
})

test('Keep going records on into the same scan, which holds points from both sides and says so to the editor', async (t) => {
  const w = await world(t)
  await w.firstScan()
  w.relocalize()
  w.view.press('keep')
  assert.equal(w.flow.recordingHeld, false)
  w.walk(3, 0.1)

  const summary = w.currentQualitySummary()
  assert.equal(summary.frameShifts, 1)
  assert.notEqual(summary.status, 'ready', 'Keep going leaves the scan marked for review')
  const sidecar = JSON.parse(JSON.stringify({ qualitySummary: summary, frameEpochs: w.log.snapshot(w.cloud) }))
  assert.equal(sidecar.frameEpochs.mixedEpochs, true)
  const fields = frameEpochFieldsFromMeta(sidecar)
  assert.deepEqual(fields, { frameShifts: 1, mixedEpochs: true }, 'what the server hands the editor')
  const note = trackingNote({ qualitySummary: { ...sidecar.qualitySummary, ...fields } })
  assert.equal(note?.line, 'Tracking interrupted 1 time')
  assert.equal(note?.note, 'Points from before and after may not line up')

  w.relocalize() // another after Keep going is asked about again
  assert.equal(w.flow.phase, 'prompting')
})

test('a shift while the calibration was running is put to the person once it is armed, and the scan it was recorded into says it is mixed', async (t) => {
  const w = await world(t)
  w.walk(6)
  const startEpoch = w.log.currentEpoch // main.ts reads this before the calibration flow runs
  w.relocalize() // the shift comes while the person is placing the points
  assert.equal(w.flow.phase, 'off')
  w.walk(3, 0.1) // the scanner records on under the calibration card
  w.setCalibration(twoPointCalibration({ calibratedAt: '2026-11-17T09:00:00.000Z' }))
  w.log.noteCalibrated(startEpoch)
  w.flow.arm()

  assert.equal(w.flow.phase, 'prompting', 'the Place\'s saved points are older than this calibration, so a re-anchor is on offer')
  assert.equal(w.flow.heldShifts, 0, 'geometry was recorded after it, so none of it is held back')
  assert.equal(w.currentQualitySummary().frameShifts, 1)
  assert.deepEqual(w.epochs(), [0, 1])

  await w.flow.reanchor()
  assert.deepEqual(w.exportsMade[0]!.epochCounts.map((count) => count.epoch), [0, 1], 'the scan that ended really is mixed, and says so')
  assert.equal(w.exportsMade[0]!.frameEpochs.mixedEpochs, true)
  assert.equal(w.exportsMade[0]!.summary.frameShifts, 1)
  w.walk(4, 0.2)
  assert.deepEqual(w.epochs(), [1], 'the new scan is in one epoch')
})

test('a first calibration that ran across a shift set the Place\'s saved points itself: no re-anchor is offered against them', async (t) => {
  const calibratedAt = '2026-11-17T09:00:00.000Z'
  const w = await world(t, { frame: twoPointFrame({ createdAt: calibratedAt, separationM: 1 }) })
  w.walk(6)
  const startEpoch = w.log.currentEpoch
  w.relocalize()
  w.walk(3, 0.1)
  w.setCalibration(twoPointCalibration({ calibratedAt, separationM: 1 }))
  w.log.noteCalibrated(startEpoch)
  w.flow.arm()

  assert.equal(w.view.shown.length, 0, 'no banner')
  assert.equal(w.flow.recordingHeld, false, 'recording goes on')
  assert.deepEqual(w.said, [copy.FRAME_SET_ACROSS_SHIFT_WARNING])
  assert.equal(w.currentQualitySummary().frameShifts, 1)
  assert.notEqual(w.currentQualitySummary().status, 'ready', 'the scan is marked for review')
  assert.ok(w.log.snapshot(w.cloud).mixedEpochs)
})
