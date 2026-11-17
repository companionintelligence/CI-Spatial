/**
 * Frame epochs end to end (WP-09): the real 8th Wall provider, scanner, point cloud, scan
 * log and quality monitor, wired the way src/main.ts wires them, through one scan that
 * loses its map partway.
 *
 * The case the package exists for. A scan is walked, its floor locks at y = 0. Tracking is
 * lost and the engine relocalizes, and from then on its frame puts the same floor 0.10 m
 * (and, in a second scan, 0.30 m) higher. Before epochs the cloud mixed both frames, the lowest band stayed the floor, the
 * lock never followed, and the scan still read ready. Now the points carry their epoch, the
 * live floor follows the new frame, the old frame's floor is kept, the sidecar record says
 * the cloud spans two frames, and the verdict is not 'ready'.
 *
 * What main.ts does with each of these is checked against its source in
 * frame_epoch_wiring.test.ts; this plays the same calls in the same order.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_integration.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { DEFAULT_INTERVAL_MS, RoomScanner } from '../../../src/ar/scanner.ts'
import { ScanFrameEpochLog } from '../../../src/ar/frame-epoch.ts'
import { PointCloud } from '../../../src/scene/pointcloud.ts'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'

// ─── The fake engine (the harness of frame_epoch_eighthwall.test.ts) ───────

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

interface Module {
  name: string
  onUpdate?: (args: unknown) => void
}
let modules: Module[] = []
;(globalThis as { XR8?: unknown }).XR8 = {
  loadChunk: async () => {},
  addCameraPipelineModules(mods: Module[]): void {
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

/** A seeded scatter of `n` points on a horizontal plane at `y`, a few metres in front of the camera. */
function floor(n: number, y: number, seed: number): Point[] {
  let s = seed >>> 0
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  return Array.from({ length: n }, () => ({ x: (rand() - 0.5) * 4, y: y + (rand() - 0.5) * 0.008, z: -1 - rand() * 3 }))
}

const FRAME_MS = 1000 / 30

/**
 * One scan that loses its map partway, and everything the app keeps of it. The engine's new
 * frame puts the same floor `shiftM` higher than the old one did.
 */
async function scanThatLosesItsMap(t: { mock: { method: (o: object, m: string, i: () => void) => unknown; timers: { enable(o: { apis: string[] }): void; tick(ms: number): void } } }, shiftM: number) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setInterval'] })

  // Everything main.ts makes, made the way it makes it.
  const provider = new EighthWallProvider()
  const clock = { t: 0 }
  const cloud = new PointCloud(0.05, () => clock.t)
  const log = new ScanFrameEpochLog()
  const monitor = new ScanQualityMonitor()
  const scanner = new RoomScanner()
  log.attach(provider)
  await provider.start({ width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement)
  const engine = modules.find((m) => m.name === 'ci-scan-capture')
  assert.ok(engine?.onUpdate)

  scanner.start(provider, (frame) => {
    cloud.add(frame.points, frame.epoch)
    monitor.tick(provider, cloud)
  })

  let frameMs = 0
  const play = (f: { status: string; reason?: string; floorY?: number; seed?: number; x?: number }): void => {
    engine.onUpdate?.({
      processCpuResult: {
        reality: {
          position: { x: f.x ?? 0.02 * (frameMs / 1000), y: 1.5, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          trackingStatus: f.status,
          ...(f.reason ? { trackingReason: f.reason } : {}),
          ...(f.floorY === undefined ? {} : { worldPoints: floor(60, f.floorY, f.seed ?? 1) }),
        },
      },
      frameStartResult: { frameTime: frameMs / 1000 },
    })
    frameMs += FRAME_MS
  }
  /** The engine's frames for one scanner interval; the last carries the points the scanner will drain. */
  const frames = (f: { status: string; reason?: string; floorY: number; seed: number }): void => {
    const n = Math.round(DEFAULT_INTERVAL_MS / FRAME_MS)
    for (let i = 0; i < n; i++) play({ status: f.status, reason: f.reason, ...(i === n - 1 ? { floorY: f.floorY, seed: f.seed } : {}) })
  }
  const tick = (): void => {
    clock.t += DEFAULT_INTERVAL_MS
    t.mock.timers.tick(DEFAULT_INTERVAL_MS)
  }

  // ── The first stretch: ordinary tracking, the floor at y = 0, locked. ──
  for (let i = 0; i < 9; i++) {
    frames({ status: 'NORMAL', floorY: 0, seed: 100 + i })
    tick()
  }
  assert.equal(provider.getFrameEpoch(), 0)
  assert.equal(cloud.groundEstimate()?.locked, true, 'precondition: the floor is locked in the first frame')
  assert.ok(Math.abs(cloud.groundEstimate()!.y) < 0.02)
  const firstStretch = cloud.count

  // ── A last harvest in the first frame, not yet drained, and then the map is lost ──
  // and relocalized. The engine says so once, and the camera has not moved.
  frames({ status: 'NORMAL', floorY: 0, seed: 150 })
  play({ status: 'LIMITED', reason: 'RELOCALIZING', x: 0.2 })
  play({ status: 'NORMAL', reason: 'UNSPECIFIED', x: 0.2 })
  assert.equal(provider.getFrameEpoch(), 1)
  // The scanner drains now. The points it had not yet taken were recorded in the old frame,
  // and filing them under the new epoch would put the first frame's floor into the second.
  tick()
  assert.deepEqual(cloud.epochCounts(), [{ epoch: 0, count: firstStretch }], 'old-frame points were filed under the new epoch')

  // ── The second stretch: the same floor, `shiftM` higher in the engine's new frame. ──
  for (let i = 0; i < 10; i++) {
    frames({ status: 'NORMAL', reason: 'UNSPECIFIED', floorY: shiftM, seed: 200 + i })
    tick()
  }
  scanner.stop()

  return { provider, cloud, log, monitor, firstStretch }
}

for (const shiftM of [0.10, 0.30]) {
  test(`a scan that loses its map partway, the floor 0.${Math.round(shiftM * 100)} m higher after: the cloud, the floor, the sidecar record and the verdict all say so`, async (t) => {
    const { provider, cloud, log, monitor, firstStretch } = await scanThatLosesItsMap(t, shiftM)

    // The provider counted it, once, and said what kind it was.
    assert.equal(provider.getFrameEpoch(), 1)
    assert.equal(log.frameShifts, 1)

    // The cloud kept each point's epoch, and none of the first stretch was refiled under the second.
    assert.deepEqual(cloud.epochCounts().map((c) => c.epoch), [0, 1])
    assert.equal(cloud.epochCounts()[0].count, firstStretch, 'the first frame\'s points are all still epoch 0')
    assert.ok(cloud.epochCounts()[1].count > 0)

    // The live floor followed the new frame and locked there. Before epochs it stayed at 0:
    // the old points were still the lowest band, and a shift of 0.10 m is inside the unlock tolerance.
    const live = cloud.groundEstimate()!
    assert.equal(live.epoch, 1)
    assert.equal(live.locked, true)
    assert.ok(Math.abs(live.y - shiftM) < 0.02, `the live floor stayed at ${live.y}`)
    // And the first frame's floor is still on record.
    const [old, current] = cloud.groundObjects()
    assert.equal(old.epoch, 0)
    assert.ok(Math.abs(old.y) < 0.02)
    assert.equal(current.epoch, 1)

    // The sidecar record says the cloud spans two frames, and which floor the exporter should draw.
    const record = log.snapshot(cloud)
    assert.equal(record.mixedEpochs, true)
    assert.equal(record.jumpCount, 1)
    assert.deepEqual(record.epochs.map((e) => [e.epoch, e.cause]), [[0, 'start'], [1, 'recovered']])
    assert.equal(record.floorEpoch, 0)
    assert.equal(record.jumps[0].reason, 'RELOCALIZING')
    assert.ok(Math.abs((record.epochs[0].ground?.y ?? 9) - 0) < 0.02)
    assert.ok(Math.abs((record.epochs[1].ground?.y ?? 9) - shiftM) < 0.02)

    // The verdict is not 'ready', and says why first.
    const summary = monitor.summary({
      pointCount: cloud.count,
      detectionCount: 0,
      poseCount: 20,
      keyframeCount: 5,
      frameShifts: log.frameShifts,
      limitedMs: log.limitedMs,
    })
    assert.notEqual(summary.status, 'ready')
    assert.equal(summary.frameShifts, 1)
    assert.equal(summary.recommendations[0], 'Tracking was interrupted: parts may be shifted')
  })
}

// ─── A scan with quick re-aims and no shift in it ──────────────────────────

const minJerk = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5
}

/**
 * A minute of ordinary scanning with no frame shift in it: the camera stays where it is and turns
 * `reaimDeg` in `reaimMs` every four seconds (a minimum-jerk sweep, the way a hand re-aims), the
 * engine reports NORMAL throughout, and the room's feature points do not depend on the heading.
 * Everything main.ts makes is made the way it makes it.
 */
async function scanWithReaims(
  t: { mock: { method: (o: object, m: string, i: () => void) => unknown; timers: { enable(o: { apis: string[] }): void; tick(ms: number): void } } },
  fps: number,
  reaimMs: number,
  reaimDeg: number,
) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setInterval'] })
  const provider = new EighthWallProvider()
  const clock = { t: 0 }
  const cloud = new PointCloud(0.05, () => clock.t)
  const log = new ScanFrameEpochLog()
  const monitor = new ScanQualityMonitor()
  const scanner = new RoomScanner()
  log.attach(provider)
  await provider.start({ width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement)
  const engine = modules.find((m) => m.name === 'ci-scan-capture')
  assert.ok(engine?.onUpdate)
  scanner.start(provider, (frame) => {
    cloud.add(frame.points, frame.epoch)
    monitor.tick(provider, cloud)
  })

  let seed = 11
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const points = (n: number): Point[] =>
    Array.from({ length: n }, () => (rand() < 0.4
      ? { x: (rand() - 0.5) * 4, y: (rand() - 0.5) * 0.01, z: -1 - rand() * 3 }
      : { x: (rand() - 0.5) * 4, y: rand() * 2.4, z: -4.2 }))
  const turned = (deg: number) => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) })

  const frameMs = 1000 / fps
  let nextTick = DEFAULT_INTERVAL_MS
  for (let tm = 0; tm < 60_000; tm += frameMs) {
    const n = Math.floor(tm / 4000)
    const heading = reaimDeg * n + reaimDeg * minJerk((tm - n * 4000 - 1000) / reaimMs)
    engine.onUpdate?.({
      processCpuResult: {
        reality: {
          position: { x: 0, y: 1.5, z: 0 },
          rotation: turned(heading),
          trackingStatus: 'NORMAL',
          trackingReason: 'UNSPECIFIED',
          worldPoints: points(40),
        },
      },
      frameStartResult: { frameTime: tm / 1000 },
    })
    while (tm >= nextTick) {
      clock.t = nextTick
      t.mock.timers.tick(DEFAULT_INTERVAL_MS)
      nextTick += DEFAULT_INTERVAL_MS
    }
  }
  scanner.stop()
  return { provider, cloud, log, monitor }
}

for (const [label, fps, reaimMs, reaimDeg] of [
  ['gentle re-aims (60 degrees in 0.8 s, peak 140 degrees a second) at 30 fps', 30, 800, 60],
  ['ordinary re-aims (90 degrees in 0.4 s, peak 420 degrees a second) at 30 fps', 30, 400, 90],
  ['the same ordinary re-aims at 120 fps', 120, 400, 90],
  ['the same ordinary re-aims at 60 fps', 60, 400, 90],
] as const) {
  test(`a minute of ${label} is one epoch: no shift, the floor locked, the verdict not about a frame`, async (t) => {
    const { provider, cloud, log, monitor } = await scanWithReaims(t, fps, reaimMs, reaimDeg)
    assert.equal(provider.getFrameEpoch(), 0, 'a quick turn read as the map moving')
    assert.equal(log.frameShifts, 0)
    assert.equal(cloud.epochCounts().length, 1, 'the cloud was split into epochs')
    assert.equal(cloud.groundEstimate()?.locked, true, 'the floor was refitted at every false epoch and never settled')
    const summary = monitor.summary({
      pointCount: cloud.count,
      detectionCount: 0,
      poseCount: 80,
      keyframeCount: 5,
      frameShifts: log.frameShifts,
      limitedMs: log.limitedMs,
    })
    assert.equal(summary.frameShifts, 0)
    assert.ok(!summary.recommendations.includes('Tracking was interrupted: parts may be shifted'))
    assert.equal(log.snapshot(cloud).mixedEpochs, false)
  })
}
