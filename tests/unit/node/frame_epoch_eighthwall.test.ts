/**
 * Frame epochs on the 8th Wall provider (WP-09): what the real `ci-scan-capture` pipeline
 * module does with scripted reality frames.
 *
 * The fake XR8 is the harness of wp-c-camera-verdict.test.ts, except that it lets start()
 * finish, so the module's own closures (onUpdate, onProcessCpu, onResume) are the code
 * under test and not a copy of them. Each case plays a script of frames with frame times
 * of their own, the way a running engine is assumed to deliver them, and reads the provider's
 * public answers: its epoch, its status, its diagnostics, its pose and the frames it hands out.
 *
 * The order within a tick is the documented one (onProcessGpu, onProcessCpu, onUpdate, onRender,
 * https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule): the harness hands onProcessCpu the
 * camera's pixels and the frame start and nothing else, and hands onUpdate the reality. So the
 * pose reaches the provider at onUpdate, and what onProcessCpu stamps onto a capture is the pose
 * from the tick before. That is how the harness plays it; which of the two hooks a real build
 * puts the reality in is not documented, and the provider reads it from both.
 * `repeatFrame` is the frame start's flag for a tick on which the camera feed has not updated since
 * the last call (https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu): the harness
 * plays the reality of such a tick as the one built last time, published again with a later frame
 * time, which is an assumption about a real build, not a documented fact.
 *
 * The statuses and reasons are the documented LIMITED / NORMAL and INITIALIZING / UNSPECIFIED
 * (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule) and the names this build also
 * handles in case a runtime reports them (NOT_AVAILABLE, RELOCALIZING and the like); DX4 logs which
 * ones a phone does.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_eighthwall.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { FRAME_JUMP_REFRACTORY_MS, MAX_CAPTURE_POSE_AGE_MS, type FrameDiscontinuity } from '../../../src/ar/frame-epoch.ts'

// ─── Browser globals the provider reads ────────────────────────────────────

const documentListeners: Array<{ type: string; listener: () => void }> = []
const doc = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  querySelector: () => null,
  addEventListener(type: string, listener: () => void): void {
    documentListeners.push({ type, listener })
  },
  removeEventListener(type: string, listener: () => void): void {
    const at = documentListeners.findIndex((l) => l.type === type && l.listener === listener)
    if (at >= 0) documentListeners.splice(at, 1)
  },
}
;(globalThis as { document?: unknown }).document = doc
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
  onProcessCpu?: (args: unknown) => void
  onResume?: () => void
}

let modules: Module[] = []
;(globalThis as { XR8?: unknown }).XR8 = {
  loadChunk: async () => {},
  addCameraPipelineModules(mods: Module[]): void {
    modules = mods
  },
  GlTextureRenderer: { pipelineModule: () => ({ name: 'gl' }) },
  Threejs: {
    pipelineModule: () => ({ name: 'three' }),
    xrScene: () => ({ scene: {}, camera: {}, renderer: {} }),
  },
  XrController: { pipelineModule: () => ({ name: 'xr' }), hitTest: () => [] },
  CameraPixelArray: { pipelineModule: () => ({ name: 'pixels' }) },
  XrConfig: { device: () => ({ ANY: 'any' }) },
  stop(): void {},
  run(): void {},
}

function canvas(): HTMLCanvasElement {
  return { width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement
}

// ─── A session, and frames to play into it ─────────────────────────────────

const FRAME_MS = 1000 / 30
type Quat = { x: number; y: number; z: number; w: number }
const yaw = (deg: number): Quat => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) })

interface Frame {
  tMs: number
  x?: number
  y?: number
  z?: number
  rotation?: Quat
  status?: string
  reason?: string
  /** `false` plays the frame without the engine's frame time, as the mock engine does. */
  engineClock?: boolean
  /** The camera feed had not updated this tick: the harness publishes the last reality again (an assumption about a real build). */
  repeatFrame?: boolean
  points?: Array<{ x: number; y: number; z: number }>
}

interface Session {
  provider: EighthWallProvider
  module: Module
  events: FrameDiscontinuity[]
  /**
   * Plays one engine tick: onProcessCpu with the camera's pixels and the frame start, then
   * onUpdate with the reality, as the engine delivers them. A capture that is waiting is
   * answered by this tick's onProcessCpu, with the pose the tick before left.
   */
  play(f: Frame): void
  /** Three steady frames at `x` ending at `tMs`, so what follows has a step before it to be judged against. */
  warm(tMs?: number, x?: number): void
}

function reality(f: Frame): Record<string, unknown> {
  return {
    position: { x: f.x ?? 0, y: f.y ?? 1.5, z: f.z ?? 0 },
    rotation: f.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    ...(f.status === undefined ? {} : { trackingStatus: f.status }),
    ...(f.reason === undefined ? {} : { trackingReason: f.reason }),
    ...(f.points ? { worldPoints: f.points } : {}),
  }
}

async function session(t: { mock: { method: (o: object, m: string, i: () => void) => unknown } }, opts: { hidden?: boolean } = {}): Promise<Session> {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  documentListeners.length = 0
  doc.visibilityState = opts.hidden ? 'hidden' : 'visible'
  modules = []
  const provider = new EighthWallProvider()
  await provider.start(canvas())
  const module = modules.find((m) => m.name === 'ci-scan-capture')
  assert.ok(module?.onUpdate && module.onProcessCpu, 'the capture module was not registered with its hooks')
  const events: FrameDiscontinuity[] = []
  provider.onFrameDiscontinuity((e) => events.push(e))
  return {
    provider,
    module,
    events,
    play(f) {
      const frameStartResult = f.engineClock === false
        ? undefined
        : { frameTime: f.tMs / 1000, ...(f.repeatFrame ? { repeatFrame: true } : {}) }
      module.onProcessCpu?.({
        processGpuResult: { camerapixelarray: { pixels: new Uint8Array(16), rows: 2, cols: 2 } },
        frameStartResult,
      })
      module.onUpdate?.({ processCpuResult: { reality: reality(f) }, frameStartResult })
    },
    warm(tMs = 0, x = 0) {
      for (const dt of [2, 1, 0]) this.play({ tMs: tMs - dt * FRAME_MS, x, status: 'NORMAL' })
    },
  }
}

/** Plays `seconds` of ordinary tracking from the origin, one frame at 30 fps, ending on the last frame time. */
function settle(s: Session, seconds = 1): number {
  let t = 0
  for (; t <= seconds * 1000; t += FRAME_MS) s.play({ tMs: t, status: 'NORMAL', reason: 'UNSPECIFIED' })
  return t - FRAME_MS
}

// ─── Starting, and a provider that has seen nothing ────────────────────────

test('a new provider is at epoch 0 and reports no discontinuity', async (t) => {
  const s = await session(t)
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.deepEqual(s.provider.getTrackingDiagnostics().epoch, 0)
  assert.equal(s.provider.getTrackingDiagnostics().status, 'UNKNOWN')
  assert.equal(s.provider.trackingStatus(), 'UNKNOWN')
})

test('a start-up that goes LIMITED, INITIALIZING, then NORMAL is not a discontinuity', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'LIMITED', reason: 'INITIALIZING' })
  s.play({ tMs: 2_000, status: 'LIMITED', reason: 'RELOCALIZING' })
  s.play({ tMs: 4_000, x: 2, status: 'NORMAL', reason: 'UNSPECIFIED' })
  s.play({ tMs: 4_033, x: 2.02, status: 'NORMAL', reason: 'UNSPECIFIED' })
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.equal(s.events.length, 0)
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
})

// ─── The four ways an epoch begins ─────────────────────────────────────────

test('a 0.31 m jump in one frame starts an epoch, and 0.29 m does not', async (t) => {
  const small = await session(t)
  small.warm()
  small.play({ tMs: FRAME_MS, x: 0.29, status: 'NORMAL' })
  assert.equal(small.provider.getFrameEpoch(), 0)

  const big = await session(t)
  big.warm()
  big.play({ tMs: FRAME_MS, x: 0.31, status: 'NORMAL' })
  assert.equal(big.provider.getFrameEpoch(), 1)
  assert.equal(big.events.length, 1)
  assert.equal(big.events[0].cause, 'jump')
  assert.equal(big.events[0].epoch, 1)
  const d = big.provider.getTrackingDiagnostics()
  assert.equal(d.poseJumps, 1)
  assert.ok(Math.abs(d.lastJumpM - 0.31) < 1e-9)
  assert.equal(d.epoch, 1)
})

test('an in-place 10 degree yaw starts an epoch', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, rotation: yaw(10), status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'jump')
  assert.ok(Math.abs((s.events[0].yawDeg ?? 0) - 10) < 1e-6)
  assert.ok(Math.abs((s.provider.getTrackingDiagnostics().lastJumpDeg ?? 0) - 10) < 1e-6)
})

test('LIMITED with the reason RELOCALIZING, then NORMAL with the pose unchanged, starts an epoch', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  s.play({ tMs: FRAME_MS, status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(s.provider.trackingStatus(), 'LIMITED')
  assert.equal(s.provider.getTrackingDiagnostics().reason, 'RELOCALIZING')
  s.play({ tMs: 2 * FRAME_MS, status: 'NORMAL', reason: 'UNSPECIFIED' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'recovered')
  assert.equal(s.events[0].reason, 'RELOCALIZING')
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
  assert.equal(s.provider.getTrackingDiagnostics().poseJumps, 0, 'a recovery is suspect, not a measured jump')
})

test('LIMITED for a second or more, whatever the reason, starts an epoch when it ends', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  s.play({ tMs: 100, status: 'LIMITED', reason: 'NOT_ENOUGH_TEXTURE' })
  s.play({ tMs: 1_100, x: 0.3, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'recovered')
  assert.equal(s.events[0].reason, 'NOT_ENOUGH_TEXTURE')
})

test('LIMITED for a moment, with no relocalization, does not', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  s.play({ tMs: 100, status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  s.play({ tMs: 400, x: 0.05, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.equal(s.provider.getTrackingDiagnostics().limitedMs, 300)
})

test('a resume (the engine\'s onResume) starts an epoch, and the pose after it is not read as a jump', async (t) => {
  const s = await session(t)
  assert.equal(typeof s.module.onResume, 'function', 'the module has an onResume hook for the engine to call')
  s.play({ tMs: 0, status: 'NORMAL' })
  s.module.onResume?.()
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'resumed')
  // Carried across the room while the engine was paused.
  s.play({ tMs: 30_000, x: 6, status: 'NORMAL' })
  s.play({ tMs: 30_033, x: 6.02, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
})

test('the page coming back from hidden starts an epoch, and so does only that', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  const visibility = documentListeners.filter((l) => l.type === 'visibilitychange')
  assert.equal(visibility.length, 1, 'the provider listens for the page being hidden and shown')
  const [{ listener }] = visibility

  // Shown while it was already shown: nothing came back.
  listener()
  assert.equal(s.provider.getFrameEpoch(), 0)

  doc.visibilityState = 'hidden'
  listener()
  assert.equal(s.provider.getFrameEpoch(), 0, 'going away starts nothing')
  doc.visibilityState = 'visible'
  listener()
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'resumed')
})

test('the engine\'s onResume and the page\'s return are one resume, in either order', async (t) => {
  const a = await session(t)
  a.play({ tMs: 0, status: 'NORMAL' })
  const [{ listener: listenerA }] = documentListeners.filter((l) => l.type === 'visibilitychange')
  doc.visibilityState = 'hidden'
  listenerA()
  doc.visibilityState = 'visible'
  listenerA()
  a.module.onResume?.()
  assert.equal(a.provider.getFrameEpoch(), 1)

  const b = await session(t)
  b.play({ tMs: 0, status: 'NORMAL' })
  const [{ listener: listenerB }] = documentListeners.filter((l) => l.type === 'visibilitychange')
  b.module.onResume?.()
  doc.visibilityState = 'hidden'
  listenerB()
  doc.visibilityState = 'visible'
  listenerB()
  assert.equal(b.provider.getFrameEpoch(), 1)
})

test('stop() takes the page listener away, and a later session starts an epoch of its own', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  s.provider.stop()
  assert.equal(documentListeners.filter((l) => l.type === 'visibilitychange').length, 0)
  // A second start() is a new engine session and a new map.
  await s.provider.start(canvas())
  const module = modules.find((m) => m.name === 'ci-scan-capture')
  module?.onUpdate?.({ processCpuResult: { reality: reality({ tMs: 90_000, x: 8, status: 'NORMAL' }) }, frameStartResult: { frameTime: 90 } })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[s.events.length - 1].cause, 'resumed')
})

// ─── The mock engine's frames, which carry no frame time ───────────────────

test('frames with no engine frame time are timed by the page clock, and a jump is still seen', async (t) => {
  // public/test-fixtures/xr8-mock.js calls onUpdate({ processCpuResult }) and nothing else.
  const s = await session(t)
  for (let i = 0; i < 3; i++) s.play({ tMs: 0, status: 'NORMAL', engineClock: false })
  s.play({ tMs: 0, x: 0.5, status: 'NORMAL', engineClock: false })
  assert.equal(s.provider.getFrameEpoch(), 1)
})

test('a frame with no status at all (the mock engine\'s first frames) has its jumps seen and never a recovery', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0 })
  s.play({ tMs: FRAME_MS, x: 0.02 })
  s.play({ tMs: 2 * FRAME_MS, x: 0.04 })
  s.play({ tMs: 3 * FRAME_MS, x: 0.6 })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.provider.trackingStatus(), 'UNKNOWN')
})

// ─── NOT_AVAILABLE: a frame with no pose ───────────────────────────────────

test('a pose published while NOT_AVAILABLE is not taken: the last real pose is kept', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, x: 2, y: 1.4, status: 'NORMAL' })
  s.play({ tMs: FRAME_MS, x: 2.04, y: 1.4, status: 'NORMAL' })
  // The identity default, which is where the origin is and not where the camera is.
  s.play({ tMs: 2 * FRAME_MS, x: 0, y: 0, z: 0, status: 'NOT_AVAILABLE' })
  assert.equal(s.provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.equal(s.provider.isTracking(), true, 'tracking has started; this is the status, not the latch')
  assert.deepEqual(s.provider.getPose().position, { x: 2.04, y: 1.4, z: 0 })
  s.play({ tMs: 3 * FRAME_MS, x: 2.08, y: 1.4, status: 'NORMAL' })
  assert.deepEqual(s.provider.getPose().position, { x: 2.08, y: 1.4, z: 0 })
  assert.equal(s.provider.getFrameEpoch(), 0, 'no jump back to the origin and out again')
})

test('before the first pose, a NOT_AVAILABLE frame is taken as it always was', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, x: 0, y: 0, z: 0, status: 'NOT_AVAILABLE' })
  assert.equal(s.provider.isTracking(), true)
})

test('a capture asked for while the pose is held through NOT_AVAILABLE is refused once the held pose is too old', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, x: 2, status: 'NORMAL' })
  s.play({ tMs: FRAME_MS, x: 2.04, status: 'NORMAL' })
  // The engine loses the pose. What it publishes is not one, and the provider keeps 2.04.
  s.play({ tMs: FRAME_MS + 100, x: 0, y: 0, status: 'NOT_AVAILABLE' })

  // Held for less than the bound at the next tick: the pose is still current enough to stamp.
  const fresh = s.provider.captureFrame(60_000)
  s.play({ tMs: FRAME_MS + MAX_CAPTURE_POSE_AGE_MS - 10, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  assert.equal((await fresh).pose.position.x, 2.04)

  // Held for longer than the bound.
  const stale = s.provider.captureFrame(60_000)
  const refused = assert.rejects(stale, /Tracking lost/)
  s.play({ tMs: FRAME_MS + MAX_CAPTURE_POSE_AGE_MS + 50, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  await refused

  // Tracking returns: the pose is taken fresh again, and captures work with it.
  s.play({ tMs: FRAME_MS + 600, x: 2.1, status: 'NORMAL' })
  const back = s.provider.captureFrame(60_000)
  s.play({ tMs: FRAME_MS + 633, x: 2.12, status: 'NORMAL' })
  assert.equal((await back).pose.position.x, 2.1)
})

test('the bound is 200 ms: a pose held 190 ms is stamped and one held 210 ms is refused', async (t) => {
  for (const [heldMs, stamped] of [[190, true], [210, false]] as const) {
    const s = await session(t)
    s.play({ tMs: 0, x: 2, status: 'NORMAL' })
    s.play({ tMs: FRAME_MS, x: 2.04, status: 'NORMAL' })
    s.play({ tMs: FRAME_MS + 50, x: 0, y: 0, status: 'NOT_AVAILABLE' })
    const capture = s.provider.captureFrame(60_000)
    const settled = capture.then(() => 'stamped', (e: Error) => e.message)
    s.play({ tMs: FRAME_MS + heldMs, x: 0, y: 0, status: 'NOT_AVAILABLE' })
    assert.equal(await settled === 'stamped', stamped, `held ${heldMs} ms`)
  }
})

test('a pose that is read every tick is current however long the gap before the tick was, so a stall does not refuse a capture', async (t) => {
  // A main-thread stall (an autosave, a GC) delivers one engine tick 250 ms after the one before it,
  // with tracking NORMAL throughout. The tick that ends the stall brings the pose; the capture
  // that was pending is stamped, and not refused for the time the page was busy.
  for (const gapMs of [33, 100, 190, 210, 250, 400]) {
    const s = await session(t)
    s.warm()
    const capture = s.provider.captureFrame(60_000)
    s.play({ tMs: gapMs, x: 0.02, status: 'NORMAL' })
    assert.ok((await capture).pixels, `a ${gapMs} ms gap between ticks refused the capture`)
  }
})

test('a pose held through NOT_AVAILABLE stops being held the tick the engine has one again', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  assert.ok((s.provider.getTrackingDiagnostics().poseAgeMs ?? 0) >= 0)
  s.play({ tMs: 3 * FRAME_MS, x: 0.01, status: 'NORMAL' })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 0)
  const capture = s.provider.captureFrame(60_000)
  s.play({ tMs: 4 * FRAME_MS, x: 0.02, status: 'NORMAL' })
  assert.ok((await capture).pixels)
})

test('the diagnostics say how old the pose a capture would carry is: 0 while one arrives every tick, growing while it is held', async (t) => {
  const s = await session(t)
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, undefined, 'no pose yet')
  s.warm()
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 0)
  s.play({ tMs: 100, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  s.play({ tMs: 250, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 250)
  s.play({ tMs: 300, x: 0.01, status: 'NORMAL' })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 0)
})

test('a capture is not refused while the pose is current, whatever the status says', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  s.play({ tMs: FRAME_MS, status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  const limited = s.provider.captureFrame(60_000)
  s.play({ tMs: 2 * FRAME_MS, status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  assert.ok((await limited).pixels, 'the frame was handed over')
})

test('a capture stamps the epoch its pose was read in', async (t) => {
  const s = await session(t)
  s.warm()
  const before = s.provider.captureFrame(60_000)
  s.play({ tMs: FRAME_MS, status: 'NORMAL' })
  assert.equal((await before).epoch, 0)

  s.play({ tMs: 2 * FRAME_MS, x: 1, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  const after = s.provider.captureFrame(60_000)
  s.play({ tMs: 3 * FRAME_MS, x: 1.02, status: 'NORMAL' })
  const frame = await after
  assert.equal(frame.epoch, 1)
  assert.equal(frame.pose.position.x, 1, 'the pose the tick before left, in the epoch it began')
})

// ─── Points harvested before the shift are not carried across it ───────────

test('points harvested before a discontinuity and not yet drained are dropped, not filed under the new epoch', async (t) => {
  const s = await session(t)
  const before = [{ x: 1, y: 0, z: -2 }, { x: 1.2, y: 0, z: -2 }]
  const after = [{ x: 4, y: 0, z: -2 }]
  s.warm()
  s.play({ tMs: FRAME_MS, status: 'NORMAL', points: before })
  s.play({ tMs: 2 * FRAME_MS, x: 0.5, status: 'NORMAL', points: after })
  assert.equal(s.provider.getFrameEpoch(), 1)
  // The scanner drains once a tick, and stamps whatever epoch is current. What it gets is
  // the frame that carried the discontinuity, in the new epoch, and nothing of the old.
  assert.deepEqual(s.provider.featurePoints(), after)
})

test('a discontinuity frame that brings no points of its own leaves the scanner nothing, not the old epoch\'s points', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, status: 'NORMAL', points: [{ x: 1, y: 0, z: -2 }, { x: 1.2, y: 0, z: -2 }] })
  s.play({ tMs: 2 * FRAME_MS, x: 0.5, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  // The scanner drains once a tick and stamps the epoch that is current by then: filing the
  // first frame's points under it would put two points of the old frame into the new one.
  assert.deepEqual(s.provider.featurePoints(), [])
})

test('without a discontinuity the latest frame\'s points are still what the scanner drains', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL', points: [{ x: 1, y: 0, z: -2 }] })
  s.play({ tMs: FRAME_MS, x: 0.02, status: 'NORMAL', points: [{ x: 2, y: 0, z: -2 }] })
  assert.deepEqual(s.provider.featurePoints(), [{ x: 2, y: 0, z: -2 }])
})

// ─── What a person doing the scan looks like ───────────────────────────────

test('a walk at 1.5 m/s with a 180 degree-per-second turn and late frames is no discontinuity', async (t) => {
  const s = await session(t)
  let tMs = 0
  let i = 0
  while (tMs < 20_000) {
    const sec = tMs / 1000
    s.play({ tMs, x: 1.5 * sec, z: 0.3 * Math.sin(sec), rotation: yaw(180 * Math.min(sec % 5, 1) + 180 * Math.floor(sec / 5)), status: 'NORMAL', reason: 'UNSPECIFIED' })
    // Mostly 30 fps; every thirtieth frame is delivered 200 ms late.
    tMs += ++i % 30 === 0 ? 200 : FRAME_MS
  }
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.equal(s.provider.getTrackingDiagnostics().poseJumps, 0)
})

// ─── What the provider says it is ──────────────────────────────────────────

test('onFrameDiscontinuity returns the way to stop listening, and takes any number of listeners', async (t) => {
  const s = await session(t)
  const second: number[] = []
  const stop = s.provider.onFrameDiscontinuity((e) => second.push(e.epoch))
  s.warm()
  s.play({ tMs: FRAME_MS, x: 1, status: 'NORMAL' })
  stop()
  // Past the refractory window, with steady frames to judge a step against.
  s.warm(FRAME_JUMP_REFRACTORY_MS + 1_000, 1)
  s.play({ tMs: FRAME_JUMP_REFRACTORY_MS + 1_000 + FRAME_MS, x: 3, status: 'NORMAL' })
  assert.deepEqual(second, [1])
  assert.deepEqual(s.events.map((e) => e.epoch), [1, 2])
})

test('the diagnostics keep the fields the calibration readout reads', async (t) => {
  const s = await session(t)
  s.play({ tMs: 0, status: 'NORMAL' })
  const d = s.provider.getTrackingDiagnostics()
  assert.equal(typeof d.status, 'string')
  assert.equal(typeof d.poseJumps, 'number')
  assert.equal(typeof d.lastJumpM, 'number')
})

// ─── Ticks on which the camera has no new image ────────────────────────────

/**
 * A camera at `cameraFps` on a page that renders at `pageHz`, turning at `degPerSec` about the
 * vertical: one engine tick per rendering frame, the reality new on the ticks the camera gave an
 * image and the last one again, with the tick's later frame time, on the others.
 */
function turnOnSlowCamera(s: Session, opts: { cameraFps: number; pageHz: number; degPerSec: number; seconds: number; flag: boolean }): void {
  const tick = 1000 / opts.pageHz
  const every = Math.round(opts.pageHz / opts.cameraFps)
  let reality = 0
  for (let i = 0; i * tick <= opts.seconds * 1000; i++) {
    const fresh = i % every === 0
    if (fresh) reality = (opts.degPerSec * i * tick) / 1000
    s.play({
      tMs: i * tick,
      rotation: yaw(reality),
      status: 'NORMAL',
      ...(fresh || !opts.flag ? {} : { repeatFrame: true }),
    })
  }
}

test('a plain turn is not a shift when the camera is slower than the page: the engine\'s repeated frames are not frames', async (t) => {
  // A 15 fps camera on a 60 Hz page: three ticks in four re-publish the reality built last time.
  // Fed to the detector, each is a step of nothing over a rendering interval and the next is a whole
  // camera frame's turn over one: 19 false epochs in two seconds at 120 degrees a second.
  for (const [cameraFps, pageHz] of [[15, 60], [20, 60], [24, 60], [10, 60], [15, 120], [30, 120]] as const) {
    for (const degPerSec of [90, 150, 200]) {
      const s = await session(t)
      turnOnSlowCamera(s, { cameraFps, pageHz, degPerSec, seconds: 2, flag: true })
      assert.equal(s.provider.getFrameEpoch(), 0, `${cameraFps} fps camera, ${pageHz} Hz page, ${degPerSec} degrees a second`)
    }
  }
})

test('the same ticks without the engine\'s repeat flag do read as shifts, so the cases above are a real test of the flag', async (t) => {
  const s = await session(t)
  turnOnSlowCamera(s, { cameraFps: 15, pageHz: 60, degPerSec: 150, seconds: 2, flag: false })
  assert.ok(s.provider.getFrameEpoch() > 0)
})

test('a repeat tick adds nothing to the detector, and a shift on the camera\'s next image is still seen', async (t) => {
  const s = await session(t)
  // Camera at 15 fps on a 60 Hz page, still, for a second; then its next image is 0.5 m along.
  const tick = 1000 / 60
  let x = 0
  for (let i = 0; i <= 60; i++) {
    const fresh = i % 4 === 0
    s.play({ tMs: i * tick, x, status: 'NORMAL', ...(fresh ? {} : { repeatFrame: true }) })
  }
  const steps = s.provider.getTrackingDiagnostics().motion?.steps ?? 0
  assert.equal(steps, 15, 'sixteen camera images are fifteen steps, whatever the number of ticks between them')
  x = 0.5
  s.play({ tMs: 64 * tick, x, status: 'NORMAL' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'jump')
})

test('a repeat tick still takes the engine\'s status, so a loss that begins on one is seen', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, status: 'LIMITED', reason: 'RELOCALIZING', repeatFrame: true })
  assert.equal(s.provider.trackingStatus(), 'LIMITED')
})

// ─── What a listener finds when it is told ─────────────────────────────────

test('a listener told of a jump finds the provider already in the new epoch, with the new pose, and the new frame\'s points', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, status: 'NORMAL', points: [{ x: 1, y: 0, z: -2 }] })
  const seen: Array<{ epoch: number; x: number; points: Array<{ x: number }> }> = []
  s.provider.onFrameDiscontinuity(() => {
    // What a listener that pauses recording and finalises the scan would read.
    seen.push({ epoch: s.provider.getFrameEpoch(), x: s.provider.getPose().position.x, points: s.provider.featurePoints() })
  })
  s.play({ tMs: 2 * FRAME_MS, x: 1.6, status: 'NORMAL', points: [{ x: 4, y: 0, z: -2 }] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].epoch, 1)
  assert.equal(seen[0].x, 1.6, 'the pose of the frame that carried the jump, not the one before it')
  assert.deepEqual(seen[0].points.map((p) => p.x), [4], 'only the new frame\'s points, none of the old epoch\'s')
})

test('a listener told of a recovery finds the new pose, and none of the old frame\'s points', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, status: 'NORMAL', points: [{ x: 1, y: 0, z: -2 }] })
  const seen: Array<{ epoch: number; x: number; points: number }> = []
  s.provider.onFrameDiscontinuity(() => seen.push({ epoch: s.provider.getFrameEpoch(), x: s.provider.getPose().position.x, points: s.provider.featurePoints().length }))
  s.play({ tMs: 2 * FRAME_MS, x: 0.5, status: 'LIMITED', reason: 'RELOCALIZING' })
  s.play({ tMs: 3 * FRAME_MS, x: 0.5, status: 'NORMAL', reason: 'UNSPECIFIED' })
  assert.deepEqual(seen, [{ epoch: 1, x: 0.5, points: 0 }])
})

test('the listeners are told once the frame has been read, even when the frame is one the pose is held through', async (t) => {
  const s = await session(t)
  s.warm()
  const heard: number[] = []
  s.provider.onFrameDiscontinuity((e) => heard.push(e.epoch))
  s.play({ tMs: FRAME_MS, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  s.module.onResume?.()
  assert.deepEqual(heard, [1], 'a resume is told at once: there is no frame to wait for')
})

// ─── One trip away ─────────────────────────────────────────────────────────

test('a resume, the seconds the runtime then spends LIMITED while it starts over, and its return are one epoch', async (t) => {
  const s = await session(t)
  s.warm()
  s.module.onResume?.()
  s.play({ tMs: 10_000, x: 3, status: 'LIMITED', reason: 'INITIALIZING' })
  s.play({ tMs: 11_000, x: 3, status: 'LIMITED', reason: 'RELOCALIZING' })
  s.play({ tMs: 12_500, x: 3.1, status: 'NORMAL', reason: 'UNSPECIFIED' })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.deepEqual(s.events.map((e) => e.cause), ['resumed'])
})

test('the page coming back records how long it was away', async (t) => {
  const s = await session(t)
  let clock = 5_000
  t.mock.method(performance, 'now', () => clock)
  s.warm()
  const [{ listener }] = documentListeners.filter((l) => l.type === 'visibilitychange')
  doc.visibilityState = 'hidden'
  listener()
  clock += 4_200
  doc.visibilityState = 'visible'
  listener()
  assert.equal(s.events[0].cause, 'resumed')
  assert.equal(s.events[0].hiddenMs, 4_200)
})

test('stop() clears the held pose and its age', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: 100, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  s.provider.stop()
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, undefined)
})

test('a page that was already hidden when the session started records how long it was away when it comes back', async (t) => {
  let clock = 20_000
  t.mock.method(performance, 'now', () => clock)
  const s = await session(t, { hidden: true })
  s.warm()
  const [{ listener }] = documentListeners.filter((l) => l.type === 'visibilitychange')
  clock += 7_500
  doc.visibilityState = 'visible'
  listener()
  assert.equal(s.events[0].cause, 'resumed')
  assert.equal(s.events[0].hiddenMs, 7_500)
})

// ─── The reality at the other hook, and a pose that is fresh again ─────────

test('a repeat tick is not fed to the detector at onProcessCpu either, for an engine build that hands the reality there', async (t) => {
  // The comments in src/ar/eighthwall.ts read `processCpuResult ?? processGpuResult ?? frameStartResult`
  // at both hooks, because builds differ in which one carries the reality.
  const s = await session(t)
  const tick = 1000 / 60
  let reality = 0
  for (let i = 0; i * tick <= 2_000; i++) {
    const fresh = i % 4 === 0
    if (fresh) reality = (150 * i * tick) / 1000
    s.module.onProcessCpu?.({
      processCpuResult: { reality: { position: { x: 0, y: 1.5, z: 0 }, rotation: yaw(reality), trackingStatus: 'NORMAL' } },
      processGpuResult: {},
      frameStartResult: { frameTime: (i * tick) / 1000, ...(fresh ? {} : { repeatFrame: true }) },
    })
  }
  assert.equal(s.provider.getFrameEpoch(), 0)
})

test('a pose that is fresh again is not held: a stall after tracking returns does not refuse the capture that was waiting', async (t) => {
  const s = await session(t)
  s.warm()
  s.play({ tMs: FRAME_MS, x: 0, y: 0, status: 'NOT_AVAILABLE' })
  s.play({ tMs: 2 * FRAME_MS, x: 0.01, status: 'NORMAL' })
  // The page stalls for 250 ms; the tick that ends it finds a capture waiting.
  const capture = s.provider.captureFrame(60_000)
  s.play({ tMs: 2 * FRAME_MS + 250, x: 0.02, status: 'NORMAL' })
  assert.ok((await capture).pixels, 'refused for the gap before the tick, with tracking back')
})
