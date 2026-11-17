/**
 * Frame epochs on the WebXR provider (WP-09): what the real frame loop does with a fake
 * XRSession.
 *
 * What WebXR says about the viewer, and what the provider makes of it:
 *   - a reference space fires `reset` when its origin moves, with the move in `transform`
 *     (null when the runtime cannot say). Spec: dispatched before the frames that use the
 *     new origin, and not for a loss and regain inside one stable mapping.
 *   - `getViewerPose()` answers null only while no pose has ever been determined (section
 *     5.1 populates the pose with force emulation on, so once there has been one the answer
 *     after a loss is the last known pose with `emulatedPosition` true): a frame with no
 *     pose reads NOT_AVAILABLE, and is "nothing to record against yet".
 *   - `XRPose.emulatedPosition` is true when the position is estimated rather than read
 *     from sensors, and estimates drift: it reads LIMITED. This is how a runtime that
 *     follows the spec says tracking was lost after the first pose, and the pose that comes
 *     with it is the last known one again, so it is not a fresh pose for a capture.
 *   - the session fires `visibilitychange`; a return from `hidden` is a resume.
 *
 * UNVERIFIED on hardware: whether Chrome with ARCore or a Quest really sets
 * emulatedPosition, or answers null, during a tracking loss, and how often either fires a
 * `reset` (device experiment DX6). These tests are of what the provider does when they do.
 *
 * The frame loop is the real one: the fake session hands out the callback three.js's XR
 * animation registers with `requestAnimationFrame`, and the cases call it with a fake
 * XRFrame, so `onXRFrame` in src/ar/webxr.ts runs as it does on a device.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_webxr.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import { FRAME_JUMP_REFRACTORY_MS, MAX_CAPTURE_POSE_AGE_MS, type FrameDiscontinuity } from '../../../src/ar/frame-epoch.ts'

// ─── Browser globals the provider touches ──────────────────────────────────

/** The camera stream's <video>: its clock is advanced by the test, once per frame. */
const video = {
  srcObject: null as unknown,
  playsInline: false,
  muted: false,
  readyState: 4,
  currentTime: 0,
  videoWidth: 4,
  videoHeight: 4,
  play: async (): Promise<void> => {},
}

;(globalThis as { document?: unknown }).document = {
  body: {},
  visibilityState: 'visible',
  addEventListener(): void {},
  createElement: () => video,
}
;(globalThis as { self?: unknown }).self = { requestAnimationFrame: () => 0, cancelAnimationFrame(): void {} }
;(globalThis as { XRWebGLLayer?: unknown }).XRWebGLLayer = class {
  framebufferWidth = 640
  framebufferHeight = 480
  ignoreDepthValues = false
  getViewport(): object {
    return { x: 0, y: 0, width: 640, height: 480 }
  }
}
;(globalThis as { XRRay?: unknown }).XRRay = class {
  origin: unknown
  direction: unknown
  constructor(origin: unknown, direction: unknown) {
    this.origin = origin
    this.direction = direction
  }
}
;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  width: number
  height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  getContext(): object {
    return {
      drawImage(): void {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }
  }
}

/** Values three.js reads back when it builds a renderer. Everything else is a stand-in. */
const glValues: Record<string, unknown> = {
  getParameter: (p: unknown) => (p === 'VERSION' ? 'WebGL 2.0 (test stub)' : 0),
  getSupportedExtensions: () => [],
  getContextAttributes: () => ({ xrCompatible: true, antialias: false, depth: true, stencil: false, alpha: true }),
  getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
  getExtension: () => null,
  getError: () => 0,
  checkFramebufferStatus: () => 0x8cd5,
}

/** A WebGL2 stand-in: any call returns another stand-in, and a GL constant reads back as its own name. */
function glStandIn(): unknown {
  const target = function (): void {}
  const stand: unknown = new Proxy(target, {
    get(_target, prop) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === Symbol.iterator) return function* () {}
        return undefined
      }
      if (prop === 'then') return undefined
      if (Object.hasOwn(glValues, prop)) return glValues[prop]
      if (/^[A-Z0-9_]+$/.test(prop)) return prop
      return stand
    },
    apply: () => stand,
    construct: () => stand as object,
  })
  return stand
}

function canvas(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => glStandIn(),
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

// ─── A fake session ────────────────────────────────────────────────────────

class FakeSpace {
  listeners = new Map<string, Set<(e: unknown) => void>>()
  addEventListener(type: string, listener: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  removeEventListener(type: string, listener: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  /** What a runtime does: fire the event at every listener. */
  fire(type: string, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...event })
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

type Quat = { x: number; y: number; z: number; w: number }
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

interface PoseSpec {
  x?: number
  y?: number
  z?: number
  orientation?: Quat
  emulated?: boolean
}

class FakeSession {
  visibilityState: 'visible' | 'visible-blurred' | 'hidden' = 'visible'
  renderState = {}
  listeners = new Map<string, Set<() => void>>()
  endCalls = 0
  frameCallback: ((time: number, frame: unknown) => void) | null = null
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
  async end(): Promise<void> {
    this.endCalls++
  }
  requestAnimationFrame(callback: (time: number, frame: unknown) => void): number {
    this.frameCallback = callback
    return 1
  }
  updateRenderState(): void {}
  async requestReferenceSpace(): Promise<FakeSpace> {
    return new FakeSpace()
  }
}

/** An XRFrame whose viewer pose is `pose`, or none. No views, so nothing is rendered. */
function frameOf(pose: PoseSpec | null): object {
  return {
    getViewerPose: () =>
      pose === null
        ? null
        : {
            transform: {
              position: { x: pose.x ?? 0, y: pose.y ?? 1.4, z: pose.z ?? 0 },
              orientation: pose.orientation ?? IDENTITY,
            },
            emulatedPosition: pose.emulated ?? false,
            views: [],
          },
    getHitTestResults: () => [],
  }
}

interface Internals {
  refSpace: FakeSpace | null
  viewerSpace: FakeSpace | null
  session: FakeSession | null
  pushHitPoint(x: number, y: number, z: number): void
}
const internals = (p: WebXRProvider): Internals => p as unknown as Internals

const FRAME_MS = 1000 / 72

interface Session {
  provider: WebXRProvider
  fake: FakeSession
  events: FrameDiscontinuity[]
  /** The provider's own floor space and viewer space: the two a runtime fires `reset` on. */
  floor: FakeSpace
  viewer: FakeSpace
  /** One XR frame at `tMs`, with the camera's video advanced as a live stream's would be. */
  frame(tMs: number, pose: PoseSpec | null): void
}

async function session(t: { mock: { method: (o: object, m: string, i: () => void) => unknown } }): Promise<Session> {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'info', () => {})
  video.currentTime = 0
  const fake = new FakeSession()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      xr: { requestSession: async () => fake },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop(): void {} }] }) },
    },
  })
  const provider = new WebXRProvider()
  await provider.start(canvas())
  const floor = internals(provider).refSpace
  const viewer = internals(provider).viewerSpace
  assert.ok(floor && viewer && fake.frameCallback, 'the session did not reach its frame loop')
  const events: FrameDiscontinuity[] = []
  provider.onFrameDiscontinuity((e) => events.push(e))
  return {
    provider,
    fake,
    events,
    floor,
    viewer,
    frame(tMs, pose) {
      video.currentTime += 1 / 72
      fake.frameCallback?.(tMs, frameOf(pose))
    },
  }
}

// ─── The provider hears the runtime ────────────────────────────────────────

test('start() listens for reset on the floor space and the viewer space, and for the session\'s visibility', async (t) => {
  const s = await session(t)
  assert.equal(s.floor.count('reset'), 1)
  assert.equal(s.viewer.count('reset'), 1)
  assert.equal(s.fake.count('visibilitychange'), 1)
})

test('stop() takes those listeners away', async (t) => {
  const s = await session(t)
  s.provider.stop()
  assert.equal(s.floor.count('reset'), 0)
  assert.equal(s.viewer.count('reset'), 0)
  assert.equal(s.fake.count('visibilitychange'), 0)
})

test('a reset or a visibility change from a session that has ended does not touch the one that replaced it', async (t) => {
  // An event already on its way when stop() ran reaches a handler the runtime still holds,
  // and by then the provider is running a second session of its own.
  const s = await session(t)
  s.frame(0, { x: 1 })
  const resets = [...(s.floor.listeners.get('reset') ?? [])]
  const visibility = [...(s.fake.listeners.get('visibilitychange') ?? [])]
  assert.ok(resets.length > 0 && visibility.length > 0)
  s.provider.stop()

  const next = new FakeSession()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      xr: { requestSession: async () => next },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop(): void {} }] }) },
    },
  })
  await s.provider.start(canvas())
  next.frameCallback?.(90_000, frameOf({ x: 12 }))
  next.frameCallback?.(90_000 + FRAME_MS, frameOf({ x: 12.01 }))
  const epoch = s.provider.getFrameEpoch()
  assert.equal(epoch, 1, 'the new session started its own epoch')

  for (const listener of resets) listener({ type: 'reset' })
  s.fake.visibilityState = 'hidden'
  for (const listener of visibility) listener()
  s.fake.visibilityState = 'visible'
  for (const listener of visibility) listener()
  assert.equal(s.provider.getFrameEpoch(), epoch, 'an event from the old session moved the new one\'s epoch')
})

test('before its first frame the provider is at epoch 0 and says UNKNOWN', async (t) => {
  const s = await session(t)
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.equal(s.provider.trackingStatus(), 'UNKNOWN')
  assert.equal(s.provider.getTrackingDiagnostics().epoch, 0)
})

// ─── reset ─────────────────────────────────────────────────────────────────

test('a reset event bumps the epoch and carries the runtime\'s transform', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.01 })
  const transform = { position: { x: 0.4, y: 0, z: -0.3 }, orientation: { x: 0, y: Math.sin(0.1), z: 0, w: Math.cos(0.1) } }
  s.floor.fire('reset', { transform })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events.length, 1)
  assert.equal(s.events[0].cause, 'reset')
  assert.equal(s.events[0].epoch, 1)
  assert.deepEqual(s.events[0].transform, transform)
  assert.ok(Math.abs((s.events[0].translationM ?? 0) - 0.5) < 1e-9)
  assert.ok(Math.abs((s.events[0].yawDeg ?? 0) - (0.2 * 180) / Math.PI) < 1e-9)
  const d = s.provider.getTrackingDiagnostics()
  assert.equal(d.epoch, 1)
  assert.equal(d.poseJumps, 1)
})

test('a reset with no transform is an epoch with no numbers', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.floor.fire('reset', {})
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].transform, null)
  assert.equal(s.events[0].translationM, undefined)
})

test('the pose after a reset is in the new origin and is not read as a jump', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.floor.fire('reset', { transform: { position: { x: 3, y: 0, z: 0 }, orientation: IDENTITY } })
  s.frame(FRAME_MS, { x: -2 })
  s.frame(2 * FRAME_MS, { x: -1.99 })
  assert.equal(s.provider.getFrameEpoch(), 1)
})

test('a reset on both spaces for one move is one epoch', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.floor.fire('reset', {})
  s.viewer.fire('reset', {})
  assert.equal(s.provider.getFrameEpoch(), 1)
  s.frame(FRAME_MS, { x: 1.01 })
  s.viewer.fire('reset', {})
  assert.equal(s.provider.getFrameEpoch(), 2, 'a later reset, after a frame, is a new one')
})

test('a reset before the first pose starts nothing: there was no old frame yet', async (t) => {
  const s = await session(t)
  s.floor.fire('reset', {})
  assert.equal(s.provider.getFrameEpoch(), 0)
})

test('the probe hits sampled before a reset and not yet drained are dropped', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  internals(s.provider).pushHitPoint(1, 0, -2)
  internals(s.provider).pushHitPoint(1.1, 0, -2)
  s.floor.fire('reset', {})
  assert.deepEqual(s.provider.featurePoints(), [])
  // Hits sampled after it are the new epoch's.
  internals(s.provider).pushHitPoint(5, 0, -2)
  assert.deepEqual(s.provider.featurePoints(), [{ x: 5, y: 0, z: -2 }])
})

// ─── A null viewer pose, and an emulated one ───────────────────────────────

test('a frame with no viewer pose reads NOT_AVAILABLE, and a pose reads NORMAL again', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
  s.frame(FRAME_MS, null)
  assert.equal(s.provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.equal(s.provider.getTrackingDiagnostics().status, 'NOT_AVAILABLE')
  s.frame(2 * FRAME_MS, { x: 1.01 })
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
})

test('a first frame with no viewer pose reads NOT_AVAILABLE, not UNKNOWN: the spec answers null while none has ever been determined', async (t) => {
  const s = await session(t)
  s.frame(0, null)
  assert.equal(s.provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.equal(s.provider.getFrameEpoch(), 0, 'establishing tracking is not losing it')
})

test('a pose whose position is emulated reads LIMITED', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.01, emulated: true })
  assert.equal(s.provider.trackingStatus(), 'LIMITED')
  s.frame(2 * FRAME_MS, { x: 1.02 })
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
})

test('the status feeds trackingIsUsable, so points and keyframes stop while it is not NORMAL', async (t) => {
  const { trackingIsUsable } = await import('../../../src/ar/tracking-quality.ts')
  const s = await session(t)
  s.frame(0, { x: 1 })
  assert.equal(trackingIsUsable(s.provider.trackingStatus()), true)
  s.frame(FRAME_MS, null)
  assert.equal(trackingIsUsable(s.provider.trackingStatus()), false)
  s.frame(2 * FRAME_MS, { x: 1, emulated: true })
  assert.equal(trackingIsUsable(s.provider.trackingStatus()), false)
})

test('no pose for a second or more starts an epoch when it returns; a dropped frame does not', async (t) => {
  const brief = await session(t)
  brief.frame(0, { x: 1 })
  brief.frame(FRAME_MS, null)
  brief.frame(2 * FRAME_MS, { x: 1.01 })
  assert.equal(brief.provider.getFrameEpoch(), 0)

  const long = await session(t)
  long.frame(0, { x: 1 })
  long.frame(FRAME_MS, null)
  long.frame(1_500, null)
  long.frame(1_000 + FRAME_MS, { x: 1.4 })
  assert.equal(long.provider.getFrameEpoch(), 1)
  assert.equal(long.events[0].cause, 'recovered')
  assert.ok((long.provider.getTrackingDiagnostics().notAvailableMs ?? 0) > 0)
})

test('an emulated position for a second or more starts an epoch when real tracking returns', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1, emulated: true })
  s.frame(1_500, { x: 1, emulated: true })
  s.frame(1_600, { x: 1.2 })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'recovered')
})

// ─── Captures ──────────────────────────────────────────────────────────────

test('a capture is stamped with the epoch its pose was read in', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  const first = s.provider.captureFrame(60_000)
  s.frame(FRAME_MS, { x: 1.01 })
  assert.equal((await first).epoch, 0)

  s.floor.fire('reset', {})
  const second = s.provider.captureFrame(60_000)
  s.frame(2 * FRAME_MS, { x: -3 })
  const frame = await second
  assert.equal(frame.epoch, 1)
  assert.equal(frame.pose.position.x, -3)
})

test('a capture asked for while the viewer pose is missing is refused once the last pose is too old', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.02 })

  // The pose is a few frames old: still current enough to stamp.
  const recent = s.provider.captureFrame(60_000)
  s.frame(FRAME_MS + MAX_CAPTURE_POSE_AGE_MS - 1, null)
  assert.equal((await recent).pose.position.x, 1.02)

  // The pose is older than the bound.
  const stale = s.provider.captureFrame(60_000)
  const refused = assert.rejects(stale, /Tracking lost/)
  s.frame(FRAME_MS + MAX_CAPTURE_POSE_AGE_MS + 1, null)
  await refused

  // The viewer is placed again: captures work.
  const back = s.provider.captureFrame(60_000)
  s.frame(FRAME_MS + 400, { x: 1.2 })
  assert.equal((await back).pose.position.x, 1.2)
})

test('a capture is not refused for a pose the session has never had', async (t) => {
  // Before the first pose there is nothing to be too old; main.ts waits for tracking to start.
  const s = await session(t)
  const early = s.provider.captureFrame(60_000)
  s.frame(0, null)
  s.frame(1_000, null)
  assert.ok((await early).pixels, 'the frame was handed over with the default pose, as before')
})

// ─── Visibility ────────────────────────────────────────────────────────────

test('the session coming back from hidden starts an epoch; going hidden, or blurred, does not', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.fake.visibilityState = 'visible-blurred'
  s.fake.fire('visibilitychange')
  s.fake.visibilityState = 'visible'
  s.fake.fire('visibilitychange')
  assert.equal(s.provider.getFrameEpoch(), 0, 'losing focus is not leaving')

  s.fake.visibilityState = 'hidden'
  s.fake.fire('visibilitychange')
  assert.equal(s.provider.getFrameEpoch(), 0)
  s.fake.visibilityState = 'visible'
  s.fake.fire('visibilitychange')
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'resumed')

  // And the pose that follows, a long way off, is not a second shift.
  s.frame(30_000, { x: 9 })
  s.frame(30_000 + FRAME_MS, { x: 9.01 })
  assert.equal(s.provider.getFrameEpoch(), 1)
})

// ─── Walking ───────────────────────────────────────────────────────────────

test('a walk at 1.5 m/s with a 180 degree-per-second turn at 72 Hz is no discontinuity', async (t) => {
  const s = await session(t)
  for (let i = 0; i < 72 * 20; i++) {
    const tMs = i * FRAME_MS + (i % 9) * 1.5 // a little jitter in the frame times
    const sec = tMs / 1000
    const turn = (180 * Math.min(sec % 5, 1) + 180 * Math.floor(sec / 5)) * (Math.PI / 360)
    s.frame(tMs, { x: 1.5 * sec, z: 0.3 * Math.sin(sec), orientation: { x: 0, y: Math.sin(turn), z: 0, w: Math.cos(turn) } })
  }
  assert.equal(s.provider.getFrameEpoch(), 0)
  assert.equal(s.provider.getTrackingDiagnostics().poseJumps, 0)
  assert.equal(s.provider.trackingStatus(), 'NORMAL')
})

// ─── A session that ends and another that starts ───────────────────────────

test('stop() then start() is a new session, and its first pose starts an epoch', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.provider.stop()
  assert.equal(s.provider.trackingStatus(), 'UNKNOWN')

  const next = new FakeSession()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      xr: { requestSession: async () => next },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop(): void {} }] }) },
    },
  })
  await s.provider.start(canvas())
  next.frameCallback?.(90_000, frameOf({ x: 12 }))
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[s.events.length - 1].cause, 'resumed')
})

// ─── A runtime that follows the spec answers a loss with emulated poses ────

test('a capture asked for during an emulated stretch is refused once the last tracked pose is too old', async (t) => {
  // The spec has getViewerPose answer the last known pose with emulatedPosition true once tracking
  // is lost, and null only if there never was one. So after a loss a runtime keeps answering, with a
  // pose that is the same one each frame, and the age of the pose is the time since a tracked one.
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.02 })
  s.frame(2 * FRAME_MS, { x: 1.02, emulated: true })

  const recent = s.provider.captureFrame(60_000)
  s.frame(FRAME_MS + MAX_CAPTURE_POSE_AGE_MS - 10, { x: 1.02, emulated: true })
  assert.equal((await recent).pose.position.x, 1.02, 'still current enough to stamp')

  const stale = s.provider.captureFrame(60_000)
  const refused = assert.rejects(stale, /Tracking lost/)
  s.frame(FRAME_MS + MAX_CAPTURE_POSE_AGE_MS + 10, { x: 1.02, emulated: true })
  await refused

  // A tracked pose is a fresh one: captures work again.
  const back = s.provider.captureFrame(60_000)
  s.frame(FRAME_MS + 700, { x: 1.4 })
  assert.equal((await back).pose.position.x, 1.4)
})

test('a second of emulated poses, then a tracked one, is a recovery, and none of it is stamped onto a capture in between', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.01 })
  for (let ms = 100; ms <= 1_600; ms += 100) {
    s.frame(ms, { x: 1.01, emulated: true })
    if (ms === 600) {
      const during = s.provider.captureFrame(60_000)
      const settled = during.then(() => 'stamped', (e: Error) => e.message)
      s.frame(ms + 10, { x: 1.01, emulated: true })
      assert.match(await settled, /Tracking lost/)
    }
  }
  s.frame(1_700, { x: 1.9 })
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'recovered')
})

test('the diagnostics say how old the last tracked pose is, as of the last frame: 0 while tracked, growing while emulated or missing', async (t) => {
  const s = await session(t)
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, undefined, 'before the first tracked pose')
  s.frame(0, { x: 1 })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 0)
  s.frame(300, { x: 1, emulated: true })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 300)
  s.frame(450, null)
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 450)
  s.frame(500, { x: 1.1 })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 0)
})

// ─── One trip away ─────────────────────────────────────────────────────────

test('the session coming back and the runtime\'s reset for it, before the first frame, are one epoch with the runtime\'s own transform', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(FRAME_MS, { x: 1.01 })
  s.fake.visibilityState = 'hidden'
  s.fake.fire('visibilitychange')
  s.fake.visibilityState = 'visible'
  s.fake.fire('visibilitychange')
  // The spec has reset dispatched before the first frame that uses the new origin.
  const transform = { position: { x: 0.9, y: 0, z: 0.3 }, orientation: { x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) } }
  s.floor.fire('reset', { transform })
  assert.equal(s.provider.getFrameEpoch(), 1, 'one epoch for one trip')
  assert.deepEqual(s.events.map((e) => [e.epoch, e.cause]), [[1, 'resumed'], [1, 'reset']])
  assert.deepEqual(s.events[1].transform, transform)
  assert.ok(Math.abs((s.events[1].translationM ?? 0) - Math.hypot(0.9, 0.3)) < 1e-9)
  assert.equal(s.provider.getTrackingDiagnostics().poseJumps, 1)
  // The frame after it is in the new origin, and is not a second shift.
  s.frame(30_000, { x: -4 })
  s.frame(30_000 + FRAME_MS, { x: -3.99 })
  assert.equal(s.provider.getFrameEpoch(), 1)
})

test('the session coming back records how long it was away', async (t) => {
  const s = await session(t)
  let clock = 8_000
  t.mock.method(performance, 'now', () => clock)
  s.frame(0, { x: 1 })
  s.fake.visibilityState = 'hidden'
  s.fake.fire('visibilitychange')
  clock += 12_345
  s.fake.visibilityState = 'visible'
  s.fake.fire('visibilitychange')
  assert.equal(s.events[0].hiddenMs, 12_345)
})

test('a listener told of a reset finds the epoch already advanced and none of the old origin\'s probe hits', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  internals(s.provider).pushHitPoint(1, 0, -2)
  const seen: Array<{ epoch: number; points: number }> = []
  s.provider.onFrameDiscontinuity(() => seen.push({ epoch: s.provider.getFrameEpoch(), points: s.provider.featurePoints().length }))
  s.floor.fire('reset', {})
  assert.deepEqual(seen, [{ epoch: 1, points: 0 }])
})

test('a listener told of a jump finds the new frame\'s pose', async (t) => {
  const s = await session(t)
  for (let i = 0; i < 4; i++) s.frame(i * FRAME_MS, { x: 1 })
  const seen: number[] = []
  s.provider.onFrameDiscontinuity(() => seen.push(s.provider.getPose().position.x))
  s.frame(4 * FRAME_MS, { x: 1.8 })
  assert.deepEqual(seen, [1.8])
})

test('a quick sweep at 72 Hz is not a shift, and a shift in the middle of one is seen', async (t) => {
  const s = await session(t)
  const sweep = (sec: number): number => {
    const u = Math.min(1, Math.max(0, (sec - 1) / 0.4))
    return 90 * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5)
  }
  const at = (sec: number, extraDeg = 0) => {
    const half = ((sweep(sec) + extraDeg) * Math.PI) / 360
    return { x: 1.2 * sec, orientation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) } }
  }
  for (let i = 0; i < 72 * 3; i++) s.frame(i * FRAME_MS, at((i * FRAME_MS) / 1000))
  assert.equal(s.provider.getFrameEpoch(), 0)
  // A second sweep, and the map turns 14 degrees under the camera in the middle of it.
  const later = FRAME_JUMP_REFRACTORY_MS + 10_000
  for (let i = 0; i < 72 * 2; i++) {
    const ms = later + i * FRAME_MS
    const into = (ms - later) / 1000
    s.frame(ms, at(into, into >= 1.2 ? 14 : 0))
  }
  assert.equal(s.provider.getFrameEpoch(), 1)
  assert.equal(s.events[0].cause, 'jump')
})

test('the bound is 200 ms: a last tracked pose 190 ms old is stamped and one 210 ms old is refused', async (t) => {
  for (const [ageMs, stamped] of [[190, true], [210, false]] as const) {
    const s = await session(t)
    s.frame(0, { x: 1 })
    s.frame(FRAME_MS, { x: 1.02 })
    s.frame(FRAME_MS + 50, { x: 1.02, emulated: true })
    const capture = s.provider.captureFrame(60_000)
    const settled = capture.then(() => 'stamped', (e: Error) => e.message)
    s.frame(FRAME_MS + ageMs, { x: 1.02, emulated: true })
    assert.equal(await settled === 'stamped', stamped, `${ageMs} ms old`)
  }
})

test('stop() clears the pose age with the rest of the session', async (t) => {
  const s = await session(t)
  s.frame(0, { x: 1 })
  s.frame(300, { x: 1, emulated: true })
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, 300)
  s.provider.stop()
  assert.equal(s.provider.getTrackingDiagnostics().poseAgeMs, undefined)
})
