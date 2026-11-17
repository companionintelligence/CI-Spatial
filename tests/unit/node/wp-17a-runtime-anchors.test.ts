/**
 * WP-17a: runtime anchors as an optional accelerator (src/ar/anchors.ts, hooked into src/ar/webxr.ts).
 *
 * The runtime here is a stub that follows the WebXR Anchors Module as read on 2026-11-16, not an emulator, and it is as
 * strict as the real API where a lax stub would hide a bug:
 * - an anchor can only be created inside an active frame, the frame is inactive again when the callback returns, and the
 *   promise of a new anchor is settled by the NEXT frame's update step, so its handle exists only after that frame's callback;
 * - XRFrame.getPose(space, baseSpace) needs both spaces and answers in the base space: the reference space, the viewer space
 *   and an anchor's own space are different objects with different origins, so reading in the wrong one gives wrong numbers;
 * - an anchor the device stops tracking silently leaves XRFrame.trackedAnchors; a deleted anchor throws on anchorSpace;
 * - the viewer pose can be null (tracking lost) while anchors are still served;
 * - persistence follows the module (the map keeps the object, restore refuses a repeat, delete() leaves the record alone) and
 *   can be switched to what a Quest 3 developer reports on the spec tracker: a restore that returns a new object each time,
 *   a delete() that erases the saved record, persistentAnchors that is blank or empty, and a cap that rejects.
 * Nothing depends on iwer's anchor emulation. The provider tests drive the real WebXRProvider frame loop, which three.js
 * registers on the session's requestAnimationFrame, so the hooks in webxr.ts are what is under test and not a copy of them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17a-runtime-anchors.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import {
  ANCHOR_MOVED_ROTATION_DEG,
  ANCHOR_MOVED_TRANSLATION_M,
  ANCHOR_REQUEST_TIMEOUT_MS,
  ANCHORS_FEATURE,
  WebXRAnchors,
  createPersistentAnchorStore,
  createWebXRAnchors,
  persistAnchor,
  restoreAnchors,
  rotationAngleDeg,
  tryCreateAnchor,
  yawAboutVerticalDeg,
  type AnchorCapability,
  type AnchorExpiredEvent,
  type AnchorHandle,
  type AnchorLostEvent,
  type AnchorMovedEvent,
  type AnchorReturnedEvent,
} from '../../../src/ar/anchors.ts'

// --- browser globals the provider touches ----------------------------------------------------------------------------

;(globalThis as { document?: unknown }).document = {
  body: {},
  visibilityState: 'visible',
  addEventListener(): void {},
  createElement: () => ({ play: async () => {} }),
}

interface Point4 {
  x: number
  y: number
  z: number
  w: number
}

/** What the runtime's XRRigidTransform constructor keeps, so a test can read back what an anchor was made from. */
class FakeRigidTransform {
  position: Point4
  orientation: Point4
  constructor(position: Point4, orientation: Point4) {
    this.position = position
    this.orientation = orientation
  }
}
;(globalThis as { XRRigidTransform?: unknown }).XRRigidTransform = FakeRigidTransform

// three.js builds an XRWebGLLayer for the session, and reads the viewport from it on every frame.
;(globalThis as { XRWebGLLayer?: unknown }).XRWebGLLayer = class {
  framebufferWidth = 640
  framebufferHeight = 480
  ignoreDepthValues = false
  getViewport(): object {
    return { x: 0, y: 0, width: 640, height: 480 }
  }
}

/** Values three.js reads back when it builds a renderer. Everything else is a stand-in (as in wp-car-webxr-session.test.ts). */
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

function canvasWithGl(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => glStandIn(),
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

/** The session a start() will be handed, and the options it was asked for. */
const xr: { session: unknown; requests: Array<{ mode: string; options: Record<string, unknown> }> } = {
  session: null,
  requests: [],
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    xr: {
      requestSession: async (mode: string, options: Record<string, unknown>) => {
        xr.requests.push({ mode, options })
        return xr.session
      },
    },
    mediaDevices: { getUserMedia: async () => { throw new Error('no camera in this test') } },
  },
})

// --- a runtime that holds anchors ------------------------------------------------------------------------------------

interface Vec3 {
  x: number
  y: number
  z: number
}
interface PoseData {
  position: Vec3
  rotation: Point4
}

const IDENTITY: Point4 = { x: 0, y: 0, z: 0, w: 1 }
const poseAt = (x: number, y: number, z: number, rotation: Point4 = IDENTITY): PoseData => ({ position: { x, y, z }, rotation })
/** A rotation of `deg` about one world axis. */
const turn = (axis: 'x' | 'y' | 'z', deg: number): Point4 => {
  const half = (deg * Math.PI) / 360
  return { x: axis === 'x' ? Math.sin(half) : 0, y: axis === 'y' ? Math.sin(half) : 0, z: axis === 'z' ? Math.sin(half) : 0, w: Math.cos(half) }
}
/** Rotation a, then rotation b about the axes a has already turned (Hamilton product a times b). */
const compose = (a: Point4, b: Point4): Point4 => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
})
const near = (actual: number, expected: number, within = 1e-9): boolean => Math.abs(actual - expected) <= within

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

/**
 * A space: reference, viewer or an anchor's own. `origin` is where its origin sits in the runtime's own coordinates, so a
 * pose read in this space is the runtime's pose minus it. Moving a reference space's origin is how a test makes the
 * session frame shift against a world that has not moved, which is what an anchor is there to notice.
 */
class FakeSpace {
  name: string
  origin: Vec3
  constructor(name: string, origin: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.name = name
    this.origin = origin
  }
}

class FakeAnchor {
  deleted = false
  /** The runtime throws when asked for this anchor's pose. */
  broken = false
  /** 'paused' stays in trackedAnchors but has no pose; 'stopped' is dropped by the next frame's update step. */
  state: 'tracking' | 'paused' | 'stopped' = 'tracking'
  readonly space = new FakeSpace('anchor')
  /** Where it is, in the runtime's own coordinates. */
  native: PoseData
  world: FakeWorld
  constructor(world: FakeWorld, native: PoseData) {
    this.world = world
    this.native = native
  }
  /** Puts the anchor where `pose` is in the reference space as it stands now. */
  moveTo(pose: PoseData): void {
    const o = this.world.ref.origin
    this.native = { position: { x: pose.position.x + o.x, y: pose.position.y + o.y, z: pose.position.z + o.z }, rotation: { ...pose.rotation } }
  }
  get anchorSpace(): FakeSpace {
    if (this.deleted) throw domError('InvalidStateError', 'the anchor was deleted')
    return this.space
  }
  delete(): void {
    if (this.deleted) return
    this.deleted = true
    this.world.sessionTracked.delete(this)
    this.world.deleteCalls.push(this)
    // What a Quest 3 developer reports on the spec tracker (issue 79): deleting a restored anchor erased its saved record.
    if (this.world.deleteErasesRecord) for (const [uuid, kept] of this.world.persisted) if (kept.anchor === this) this.world.persisted.delete(uuid)
  }
  requestPersistentHandle(): Promise<string> {
    this.world.handleRequests++
    if (this.deleted) return Promise.reject(domError('InvalidStateError', 'the anchor was deleted'))
    return this.world.keep(this)
  }
}

type CreateMode = 'resolve' | 'reject' | 'throw' | 'hang'
interface FrameOptions {
  /** False is a browser with no anchors module: no createAnchor, no trackedAnchors. */
  api?: boolean
  /** False is a browser that has createAnchor but gives no trackedAnchors. */
  set?: boolean
  /** False is a frame in which the viewer cannot be tracked: getViewerPose answers null. */
  viewerPose?: boolean
}

/** A new anchor's promise, waiting for the next update step. `held` ones are never settled by it: a runtime that does not answer. */
interface NewAnchor {
  resolve: (anchor: FakeAnchor) => void
  reject: (error: unknown) => void
  held: boolean
}

interface Kept {
  /** This session's live object for the saved anchor, or null until a restore makes one. */
  anchor: FakeAnchor | null
  /** Where it was saved, in the runtime's own coordinates. */
  native: PoseData
}

class FakeWorld {
  readonly ref = new FakeSpace('local-floor')
  readonly viewer = new FakeSpace('viewer', { x: 0, y: 1.4, z: 0 })
  readonly local = new FakeSpace('local')
  /** The session's set of tracked anchors, which the update step turns into each frame's trackedAnchors. */
  sessionTracked = new Set<FakeAnchor>()
  newAnchors = new Map<FakeAnchor, NewAnchor>()
  bySpace = new Map<FakeSpace, FakeAnchor>()
  everMade: FakeAnchor[] = []
  deleteCalls: FakeAnchor[] = []
  created: Array<{ transform: FakeRigidTransform; space: unknown }> = []
  createMode: CreateMode = 'resolve'
  /** Settles the new anchors that a 'hang' runtime never answered, handing each the anchor it made. */
  hanging: Array<() => FakeAnchor> = []

  persistence: boolean
  /** The map of persistent anchors. It outlives the session, as the device keeps it. */
  persisted = new Map<string, Kept>()
  persistCap = 8
  /** What restorePersistentAnchor hands back for an anchor this session already has live: the module says the same object. */
  restoreObject: 'same' | 'new' = 'same'
  restoreMode: 'ok' | 'hang' | 'refuse' | 'throw' = 'ok'
  deleteMode: 'ok' | 'refuse' | 'hang' = 'ok'
  handleMode: 'ok' | 'hang' | 'blank' = 'ok'
  /** Settles the requestPersistentHandle calls a 'hang' runtime never answered. */
  hangingHandles: Array<() => void> = []
  /** What XRSession.persistentAnchors reports: the keys, blank strings (a Quest Browser bug), nothing, or no such property. */
  listMode: 'keys' | 'blank' | 'empty' | 'absent' = 'keys'
  /** delete() on an anchor also erases the saved record, as reported for a Quest 3. */
  deleteErasesRecord = false
  restoreCalls: string[] = []
  /** How many times the browser was asked for a persistent handle. */
  handleRequests = 0
  nextUuid = 1

  /** The callback three.js registered on the session's requestAnimationFrame: the provider's frame loop runs inside it. */
  loop: ((time: number, frame: unknown) => void) | null = null
  time = 0
  listeners: Record<string, Array<() => void>> = {}
  endCalls = 0
  /** How many times a frame's trackedAnchors was read. */
  trackedReads = 0

  constructor(persistence = false) {
    this.persistence = persistence
  }

  makeAnchor(native: PoseData): FakeAnchor {
    const anchor = new FakeAnchor(this, native)
    if (!this.persistence) (anchor as { requestPersistentHandle?: unknown }).requestPersistentHandle = undefined
    this.sessionTracked.add(anchor)
    this.bySpace.set(anchor.space, anchor)
    this.everMade.push(anchor)
    return anchor
  }

  keep(anchor: FakeAnchor): Promise<string> {
    if (this.handleMode === 'blank') return Promise.resolve('')
    if (this.handleMode === 'hang') {
      return new Promise((resolve, reject) => {
        this.hangingHandles.push(() => void this.keepNow(anchor).then(resolve, reject))
      })
    }
    return this.keepNow(anchor)
  }

  private keepNow(anchor: FakeAnchor): Promise<string> {
    for (const [uuid, kept] of this.persisted) if (kept.anchor === anchor) return Promise.resolve(uuid)
    if (this.persisted.size >= this.persistCap) return Promise.reject(domError('InvalidStateError', 'Maximum number of anchors reached!'))
    const uuid = `00000000-0000-4000-8000-${String(this.nextUuid++).padStart(12, '0')}`
    this.persisted.set(uuid, { anchor, native: { position: { ...anchor.native.position }, rotation: { ...anchor.native.rotation } } })
    return Promise.resolve(uuid)
  }

  /** The runtime stops tracking an anchor: it drops out of every later frame's trackedAnchors, and says nothing. */
  lose(anchor: FakeAnchor): void {
    anchor.state = 'stopped'
  }

  /** The session frame shifts against the world: every anchor now reads this far the other way. */
  shiftFrame(by: Vec3): void {
    this.ref.origin = { x: this.ref.origin.x + by.x, y: this.ref.origin.y + by.y, z: this.ref.origin.z + by.z }
  }

  /**
   * A frame as the runtime hands it to the callback. The runtime's "update anchors" step runs first: it settles the promises
   * of the anchors made in an earlier frame and fills trackedAnchors. Nothing made in this frame is in it.
   */
  frame(options: FrameOptions = {}): any {
    const world = this
    const snapshot = new Set<FakeAnchor>()
    for (const anchor of [...this.sessionTracked]) {
      const waiting = this.newAnchors.get(anchor)
      if (anchor.state === 'stopped') {
        this.sessionTracked.delete(anchor)
        waiting?.reject(domError('InvalidStateError', 'the anchor was never tracked'))
        this.newAnchors.delete(anchor)
        continue
      }
      snapshot.add(anchor)
      if (waiting && !waiting.held) {
        this.newAnchors.delete(anchor)
        waiting.resolve(anchor)
      }
    }
    const frame: any = {
      active: true,
      getViewerPose: (space: unknown) => {
        if (!(space instanceof FakeSpace)) throw new TypeError('getViewerPose takes a reference space')
        if (options.viewerPose === false) return null
        const v = world.viewer.origin
        return {
          transform: { position: { x: v.x - space.origin.x, y: v.y - space.origin.y, z: v.z - space.origin.z }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          views: [{ projectionMatrix: PROJECTION, transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.4, 0, 1]) } }],
        }
      },
      getHitTestResults: () => [],
      getPose(space: unknown, base: unknown): unknown {
        if (!frame.active) throw domError('InvalidStateError', 'the frame is not active')
        if (!(space instanceof FakeSpace) || !(base instanceof FakeSpace)) throw new TypeError('getPose takes the space and the base space')
        const anchor = world.bySpace.get(space)
        if (!anchor) return null
        if (anchor.broken) throw domError('InvalidStateError', 'the anchor was deleted')
        if (anchor.deleted || anchor.state !== 'tracking') return null
        const { position: p, rotation: q } = anchor.native
        // An anchor read in its own space is at the origin of it, whatever the world looks like.
        if (base === space) return { transform: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }
        const o = base.origin
        return { transform: { position: { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }, orientation: { ...q } } }
      },
    }
    if (options.api === false) return frame
    if (options.set !== false) {
      Object.defineProperty(frame, 'trackedAnchors', {
        enumerable: true,
        configurable: true,
        get: () => {
          world.trackedReads++
          return snapshot
        },
      })
    }
    frame.createAnchor = (transform: unknown, space: unknown): Promise<FakeAnchor> => {
      if (!frame.active) return Promise.reject(domError('InvalidStateError', 'the frame is not active'))
      if (!(transform instanceof FakeRigidTransform) || !(space instanceof FakeSpace)) throw new TypeError('createAnchor takes an XRRigidTransform and a space')
      world.created.push({ transform, space })
      if (world.createMode === 'throw') throw new Error('createAnchor exploded')
      if (world.createMode === 'reject') return Promise.reject(domError('NotSupportedError', 'the runtime has no anchor for that'))
      const o = space.origin
      const anchor = world.makeAnchor({
        position: { x: transform.position.x + o.x, y: transform.position.y + o.y, z: transform.position.z + o.z },
        rotation: { ...transform.orientation },
      })
      return new Promise((resolve, reject) => {
        const held = world.createMode === 'hang'
        world.newAnchors.set(anchor, { resolve, reject, held })
        if (held) {
          world.hanging.push(() => {
            world.newAnchors.delete(anchor)
            resolve(anchor)
            return anchor
          })
        }
      })
    }
    return frame
  }

  /** A session in the shape three.js and the provider read. `features: null` is a browser that has no enabledFeatures. Each call is a new session. */
  session(features: string[] | null = ['local-floor', ANCHORS_FEATURE]): any {
    const world = this
    // A new session starts with nothing tracked and nothing live, whatever the last one held.
    this.sessionTracked = new Set()
    this.newAnchors = new Map()
    for (const kept of this.persisted.values()) kept.anchor = null
    const session: any = {
      inputSources: [],
      addEventListener(type: string, listener: () => void) {
        ;(world.listeners[type] ??= []).push(listener)
      },
      removeEventListener(): void {},
      end: async () => {
        world.endCalls++
      },
      requestAnimationFrame(callback: (time: number, frame: unknown) => void): number {
        world.loop = callback
        return 1
      },
      updateRenderState(): void {},
      requestReferenceSpace: async (type: string) => (type === 'viewer' ? world.viewer : type === 'local' ? world.local : world.ref),
    }
    if (features) session.enabledFeatures = features
    if (this.persistence) {
      Object.defineProperty(session, 'persistentAnchors', {
        enumerable: true,
        get: () => {
          if (world.listMode === 'absent') return undefined
          if (world.listMode === 'empty') return []
          const keys = [...world.persisted.keys()]
          return world.listMode === 'blank' ? keys.map(() => '') : keys
        },
      })
      session.restorePersistentAnchor = (uuid: string): Promise<FakeAnchor> => {
        if (world.restoreMode === 'throw') throw new Error('restorePersistentAnchor exploded')
        const kept = world.persisted.get(uuid)
        if (!kept) return Promise.reject(domError('InvalidStateError', 'no such persistent anchor'))
        if (world.restoreMode === 'refuse') return Promise.reject(domError('OperationError', 'Anchor creation failed.'))
        world.restoreCalls.push(uuid)
        // The module refuses a restore of an anchor whose last restore is still waiting for its update step.
        if (kept.anchor && world.newAnchors.has(kept.anchor)) return Promise.reject(domError('InvalidStateError', 'Anchor is already being restored or deleted'))
        let anchor = kept.anchor
        if (!anchor || anchor.deleted || world.restoreObject === 'new') {
          anchor = world.makeAnchor({ position: { ...kept.native.position }, rotation: { ...kept.native.rotation } })
          kept.anchor = anchor
        } else {
          world.sessionTracked.add(anchor)
        }
        const restored = anchor
        return new Promise((resolve, reject) => {
          world.newAnchors.set(restored, { resolve, reject, held: world.restoreMode === 'hang' })
          if (world.restoreMode === 'hang') {
            world.hanging.push(() => {
              world.newAnchors.delete(restored)
              resolve(restored)
              return restored
            })
          }
        })
      }
      session.deletePersistentAnchor = (uuid: string): Promise<void> => {
        const kept = world.persisted.get(uuid)
        if (!kept) return Promise.reject(domError('InvalidStateError', 'no such persistent anchor'))
        if (world.deleteMode === 'refuse') return Promise.reject(domError('OperationError', 'Anchor deletion failed.'))
        if (world.deleteMode === 'hang') return new Promise(() => {})
        world.persisted.delete(uuid)
        kept.anchor?.delete()
        return Promise.resolve()
      }
    }
    return session
  }

  /** Runs the provider's frame loop once. The frame is inactive again when the callback returns. */
  tick(options: FrameOptions = {}): void {
    assert.ok(this.loop, 'the provider never registered its frame loop')
    this.time += 16
    const frame = this.frame(options)
    this.loop(this.time, frame)
    frame.active = false
  }
}

const PROJECTION = (() => {
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1.5
  m[10] = -1
  m[11] = -1
  m[14] = -0.2
  return m
})()

/** Lets the promise callbacks queued by the last frame run. */
const settle = () => new Promise<void>((done) => setImmediate(done))

/**
 * What a promise has settled with by the end of this turn, or 'pending' if it is still waiting. No timer is ticked, so a
 * request that answers here was refused up front and not merely timed out, which is a different thing to pin.
 */
async function byNow<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, settle().then((): 'pending' => 'pending')])
}

/** Starts a provider on the stub runtime. Its own warnings about the missing camera and hit-test are not what these tests are about. */
async function started(world: FakeWorld, session: unknown = world.session()): Promise<WebXRProvider> {
  xr.session = session
  xr.requests.length = 0
  const provider = new WebXRProvider()
  const warn = console.warn
  console.warn = () => undefined
  try {
    await provider.start(canvasWithGl())
  } finally {
    console.warn = warn
  }
  return provider
}

/** A tracker over a stub session, driven one frame at a time with onFrame(), with no provider or three.js in the way. */
function tracker(world: FakeWorld, options: ConstructorParameters<typeof WebXRAnchors>[1] = {}) {
  const anchors = new WebXRAnchors(world.session(), options)
  let time = 0
  return {
    anchors,
    frame(frameOptions: FrameOptions = {}): void {
      time += 16
      const frame = world.frame(frameOptions)
      anchors.onFrame(frame, world.ref as unknown as XRSpace, time)
      frame.active = false
    },
  }
}

/**
 * Makes one anchor and reads it once, so the next frame can measure a move from where it started. An anchor takes three
 * frames to be usable, as in a browser: one to ask, one for the runtime to settle the promise, one to read it.
 */
async function anchorAt(world: FakeWorld, t: ReturnType<typeof tracker>, pose: PoseData): Promise<{ handle: AnchorHandle; anchor: FakeAnchor }> {
  const asking = t.anchors.createAnchor(pose)
  t.frame()
  t.frame()
  const handle = await asking
  assert.ok(handle, 'the runtime made no anchor')
  t.frame()
  return { handle, anchor: world.everMade[world.everMade.length - 1] }
}

function recordMoves(anchors: AnchorCapability): AnchorMovedEvent[] {
  const events: AnchorMovedEvent[] = []
  anchors.onMoved((event) => events.push(event))
  return events
}

function recordLosses(anchors: AnchorCapability): AnchorLostEvent[] {
  const events: AnchorLostEvent[] = []
  anchors.onLost((event) => events.push(event))
  return events
}

// --- the provider asks for anchors, and a session without them still starts ------------------------------------------------

test('start() asks for anchors as an optional feature, never a required one, and keeps the features it always asked for', async () => {
  const world = new FakeWorld()
  const provider = await started(world)
  const asked = xr.requests[0]
  assert.equal(asked.mode, 'immersive-ar')
  assert.deepEqual(asked.options.requiredFeatures, ['hit-test'], 'anchors must not be able to stop a session from starting')
  assert.deepEqual(asked.options.optionalFeatures, ['dom-overlay', 'local-floor', 'anchors'])
  provider.stop()
})

test('a session whose browser did not grant anchors starts, tracks, and reports no anchor capability', async () => {
  const world = new FakeWorld()
  const provider = await started(world, world.session(['local-floor']))
  assert.equal(provider.anchors, undefined)
  assert.equal(await byNow(tryCreateAnchor(provider, poseAt(0, 0, 0))), null, 'a calibration that asks gets its answer at once and goes on')
  world.tick({ api: false })
  assert.equal(provider.isTracking(), true, 'the session carries on without anchors')
  assert.equal(provider.anchors, undefined)
  provider.stop()
})

test('a browser that cannot say what it granted gets the capability until a frame shows the API is missing, and the session carries on', async () => {
  const world = new FakeWorld()
  const provider = await started(world, world.session(null))
  assert.ok(provider.anchors, 'nothing says anchors are absent yet')
  world.tick({ api: false })
  assert.equal(provider.anchors, undefined, 'a frame with no createAnchor or trackedAnchors turns the capability off')
  assert.equal(provider.isTracking(), true)
  provider.stop()
})

test('createWebXRAnchors reads what the browser granted, and says nothing is wrong when it cannot', () => {
  const world = new FakeWorld()
  assert.equal(createWebXRAnchors(world.session(['local-floor'])), null)
  assert.ok(createWebXRAnchors(world.session(['local-floor', 'anchors'])))
  assert.ok(createWebXRAnchors(world.session(null)))
})

test('a provider that was never started has no anchors, and a calibration that asks it gets null at once', async () => {
  const provider = new WebXRProvider()
  assert.equal(provider.anchors, undefined)
  assert.equal(await tryCreateAnchor(provider, poseAt(0, 0, 0)), null)
})

// --- through the provider's own frame loop ------------------------------------------------------------------------------------

test('through the provider: an anchor is made inside a frame, follows a correction as a move, and a lost one is reported', async () => {
  const world = new FakeWorld()
  const provider = await started(world)
  const anchors = provider.anchors
  assert.ok(anchors, 'the browser granted anchors')
  const moves = recordMoves(anchors)
  const losses = recordLosses(anchors)

  const asking = anchors.createAnchor(poseAt(1, 0, 2, turn('y', 30)))
  assert.equal(world.created.length, 0, 'an anchor cannot be made between frames: the runtime refuses outside an active frame')
  world.tick()
  assert.equal(world.created.length, 1)
  assert.equal(world.created[0].space, world.ref, 'made in the reference space the hit was read in, not the viewer space')
  assert.deepEqual(world.created[0].transform.position, { x: 1, y: 0, z: 2, w: 1 })
  assert.equal(await byNow(asking), 'pending', 'the runtime settles a new anchor in the next frame, not this one')
  world.tick()
  const handle = await asking
  assert.ok(handle)
  assert.equal(anchors.anchorPose(handle), null, 'not read yet: the first read is the frame after that')

  world.tick()
  assert.deepEqual(anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 }, 'read in the reference space, where it was made')
  assert.equal(moves.length, 0)

  // The session frame is corrected: the anchor, fixed to the room, now reads a quarter of a metre away.
  world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  world.tick()
  assert.equal(moves.length, 1)
  assert.ok(near(moves[0].step.translationM, 0.25))
  assert.ok(near(moves[0].total.translationM, 0.25))
  assert.equal(moves[0].atMs, world.time, 'stamped with the XR frame time the loop was given')
  assert.deepEqual(anchors.anchorPose(handle)?.position, { x: 1.25, y: 0, z: 2 })

  world.lose(world.everMade[0])
  world.tick()
  assert.equal(losses.length, 1)
  assert.equal(losses[0].handle, handle)
  assert.equal(losses[0].atMs, world.time)
  assert.equal(anchors.anchorPose(handle), null)
  world.tick()
  assert.equal(losses.length, 1, 'a lost anchor is reported once')
  provider.stop()
})

test('through the provider: a person walking about does not move an anchor, and anchors are still made and read while the viewer pose is lost', async () => {
  const world = new FakeWorld()
  const provider = await started(world)
  const anchors = provider.anchors!
  const moves = recordMoves(anchors)
  const asking = anchors.createAnchor(poseAt(0, 0, -1))
  world.tick()
  world.tick()
  const first = (await asking)!
  world.tick()

  world.viewer.origin = { x: 2, y: 1.6, z: -3 }
  world.tick()
  world.viewer.origin = { x: 4, y: 1.5, z: -6 }
  world.tick()
  assert.deepEqual(moves, [], 'the viewer space moves with the head: reading anchors in it would report every step')
  assert.deepEqual(anchors.anchorPose(first)?.position, { x: 0, y: 0, z: -1 })

  const second = anchors.createAnchor(poseAt(1, 0, 1))
  world.tick({ viewerPose: false })
  world.tick({ viewerPose: false })
  const handle = await second
  assert.ok(handle, 'an anchor is made in frames that have no viewer pose')
  world.tick({ viewerPose: false })
  assert.deepEqual(anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 1 }, 'and read in them')
  world.shiftFrame({ x: 0, y: 0, z: 0.5 })
  world.tick({ viewerPose: false })
  assert.equal(moves.length, 2, 'both anchors moved with the frame, and a lost viewer pose did not hide it')
  provider.stop()
})

test('through the provider: stop() deletes the live anchors and says nothing, and the capability is gone', async () => {
  const world = new FakeWorld()
  const provider = await started(world)
  const anchors = provider.anchors!
  const losses = recordLosses(anchors)
  const asking = anchors.createAnchor(poseAt(0, 0, -1))
  world.tick()
  world.tick()
  await asking
  world.tick()
  const anchor = world.everMade[0]
  assert.equal(anchor.deleted, false)

  provider.stop()
  assert.equal(anchor.deleted, true, 'the anchor was left with the runtime')
  assert.equal(provider.anchors, undefined)
  assert.deepEqual(losses, [], 'ending the session is not a lost anchor')
  assert.equal(await anchors.createAnchor(poseAt(0, 0, 0)), null, 'a stopped session makes no anchors')
})

test('through the provider: the browser ending the session deletes the live anchors too', async () => {
  const world = new FakeWorld()
  const provider = await started(world)
  const asking = provider.anchors!.createAnchor(poseAt(0, 0, -1))
  world.tick()
  world.tick()
  await asking
  world.listeners.end[0]()
  assert.equal(world.everMade[0].deleted, true)
  assert.equal(provider.anchors, undefined)
})

test('through the provider: ending a session leaves a saved anchor undeleted, so its record survives even where delete() would erase it', async () => {
  const world = new FakeWorld(true)
  world.deleteErasesRecord = true
  const provider = await started(world)
  const anchors = provider.anchors!
  const asking = anchors.createAnchor(poseAt(0, 0, -1))
  world.tick()
  world.tick()
  const handle = (await asking)!
  world.tick()
  const uuid = (await anchors.requestPersistentHandle(handle))!
  const plain = anchors.createAnchor(poseAt(1, 0, -1))
  world.tick()
  world.tick()
  await plain

  provider.stop()
  assert.deepEqual(world.deleteCalls, [world.everMade[1]], 'the unsaved anchor is deleted; the saved one is left to the runtime')
  assert.ok(world.persisted.has(uuid), 'the record is still there for the next session')
})

// --- creating anchors ------------------------------------------------------------------------------------------------------------

test('createAnchor waits for a frame, never uses one that is no longer active, and makes the anchor from the pose it was given', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const hit = { ...poseAt(0.4, 0, -1.2, turn('y', 90)), distance: 1.3 }
  const asking = t.anchors.createAnchor(hit)
  await settle()
  assert.equal(world.created.length, 0, 'nothing is asked of the runtime until a frame is running')

  const frame = world.frame()
  t.anchors.onFrame(frame, world.ref as unknown as XRSpace, 16)
  frame.active = false
  assert.equal(world.created.length, 1)
  assert.deepEqual(world.created[0].transform.position, { x: 0.4, y: 0, z: -1.2, w: 1 })
  assert.deepEqual(world.created[0].transform.orientation, turn('y', 90))
  t.frame()
  assert.ok(await asking)

  const second = t.anchors.createAnchor(poseAt(0, 0, 0))
  await settle()
  assert.equal(world.created.length, 1, 'the frame that ended is not used again')
  t.frame()
  t.frame()
  assert.ok(await second)
  assert.equal(world.created.length, 2)
})

test('a request made before the reference space exists waits for it, and is not made in a space that is not there', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  const early = world.frame()
  t.anchors.onFrame(early, null, 16)
  early.active = false
  assert.equal(world.created.length, 0)
  t.frame()
  assert.equal(world.created.length, 1)
  t.frame()
  assert.ok(await asking)
})

test('a pose that cannot become an XRRigidTransform answers null without asking the runtime', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const bad = [
    poseAt(Number.NaN, 0, 0),
    poseAt(0, Number.POSITIVE_INFINITY, 0),
    poseAt(0, 0, 0, { x: 0, y: 0, z: 0, w: 0 }),
    { position: { x: 0, y: 0, z: 0 } } as unknown as PoseData,
    null as unknown as PoseData,
  ]
  for (const pose of bad) assert.equal(await byNow(t.anchors.createAnchor(pose)), null, 'refused up front, not after a timeout')
  t.frame()
  assert.equal(world.created.length, 0)
})

test('a rotation with one non-zero part, whichever it is, is a rotation: the runtime is asked, and the pose is kept as given', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const rotations: Point4[] = [{ x: 1, y: 0, z: 0, w: 0 }, { x: 0, y: 1, z: 0, w: 0 }, { x: 0, y: 0, z: 1, w: 0 }, IDENTITY]
  for (const rotation of rotations) void t.anchors.createAnchor(poseAt(0, 0, 0, rotation))
  t.frame()
  assert.deepEqual(world.created.map((c) => c.transform.orientation), rotations)
})

test('a runtime that refuses, throws or has no createAnchor gives null at once, and one refusal does not stop the next anchor', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  world.createMode = 'reject'
  let asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame()
  assert.equal(await byNow(asking), null, 'a refusal answers within the turn: it was not left for the timeout')

  world.createMode = 'throw'
  asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    t.frame()
  } finally {
    console.warn = warn
  }
  assert.equal(await byNow(asking), null, 'a throw answers within the turn too')
  assert.match(String(warnings[0]?.[0]), /\[anchors\] createAnchor threw/, 'a throw is logged, not swallowed')

  world.createMode = 'resolve'
  asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame()
  t.frame()
  assert.ok(await asking, 'an earlier refusal is not remembered')

  asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame({ api: false })
  assert.equal(await byNow(asking), null, 'a frame with no createAnchor ends the wait at once')
  assert.equal(t.anchors.usable, false)
  assert.equal(await t.anchors.createAnchor(poseAt(0, 0, 0)), null)
})

test('an anchor the device drops before its first frame is refused, not left waiting', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame()
  world.lose(world.everMade[0])
  t.frame()
  assert.equal(await byNow(asking), null, 'the update step rejected it, as the module says')
})

test('a runtime that never answers gives null at the timeout, and an anchor that arrives late is deleted rather than left tracked', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld()
  world.createMode = 'hang'
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame()
  assert.equal(world.hanging.length, 1)
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.equal(await asking, null)

  const late = world.hanging[0]()
  await settle()
  assert.equal(late.deleted, true, 'nobody holds this anchor, so it must not stay tracked')
  assert.equal(world.sessionTracked.size, 0)
})

test('a request that waits for a frame that never comes gives null at the timeout, and the frame that comes later does not make it', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld()
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.equal(await asking, null)
  t.frame()
  assert.equal(world.created.length, 0)
})

// --- reading anchors -------------------------------------------------------------------------------------------------------------

test('a move is reported only once it reaches the threshold, measured from the last report and not from the last frame', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(2, 0, 3))
  const moves = recordMoves(t.anchors)

  // Four millimetres a frame: below the 1 cm threshold twice, then over it. A per-frame test would never fire.
  for (let step = 1; step <= 6; step++) {
    anchor.moveTo(poseAt(2 + 0.004 * step, 0, 3))
    t.frame()
  }
  assert.equal(moves.length, 2)
  assert.ok(near(moves[0].step.translationM, 0.012), `first report ${moves[0].step.translationM}`)
  assert.ok(near(moves[1].step.translationM, 0.012), 'the second is measured from the first report')

  t.frame()
  assert.equal(moves.length, 2, 'standing still reports nothing')
})

test('the default thresholds are a centimetre and half a degree: just under is nothing, just over is a report', async () => {
  assert.equal(ANCHOR_MOVED_TRANSLATION_M, 0.01)
  assert.equal(ANCHOR_MOVED_ROTATION_DEG, 0.5)
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)

  anchor.moveTo(poseAt(0.009, 0, 0))
  t.frame()
  assert.equal(moves.length, 0, '9 mm')
  anchor.moveTo(poseAt(0.011, 0, 0))
  t.frame()
  assert.equal(moves.length, 1, '11 mm')

  anchor.moveTo(poseAt(0.011, 0, 0, turn('y', 0.4)))
  t.frame()
  assert.equal(moves.length, 1, '0.4 degrees')
  anchor.moveTo(poseAt(0.011, 0, 0, turn('y', 0.6)))
  t.frame()
  assert.equal(moves.length, 2, '0.6 degrees')
})

test('a shift of exactly the threshold is a report: the threshold is how far it must move, not a distance it must pass', async () => {
  const world = new FakeWorld()
  const t = tracker(world, { movedTranslationM: 0.25 })
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.moveTo(poseAt(0.25, 0, 0))
  t.frame()
  assert.equal(moves.length, 1)
})

test('a threshold given in the options replaces the default, for a shift and for a turn', async () => {
  const world = new FakeWorld()
  const t = tracker(world, { movedTranslationM: 0.1, movedRotationDeg: 5 })
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.moveTo(poseAt(0.05, 0, 0))
  t.frame()
  anchor.moveTo(poseAt(0.05, 0, 0, turn('y', 3)))
  t.frame()
  assert.equal(moves.length, 0, '5 cm and 3 degrees are under the configured thresholds')
  anchor.moveTo(poseAt(0.15, 0, 0, turn('y', 3)))
  t.frame()
  anchor.moveTo(poseAt(0.15, 0, 0, turn('y', 9)))
  t.frame()
  assert.equal(moves.length, 2)
})

test('a slow drift too small to report one step at a time is still visible as a total, which is what a threshold can be tested against', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, -1))
  const moves = recordMoves(t.anchors)

  // The session frame creeps 4 mm a frame for 100 frames: 0.40 m, in a correction too smooth to be a jump.
  for (let frame = 0; frame < 100; frame++) {
    world.shiftFrame({ x: -0.004, y: 0, z: 0 })
    t.frame()
  }
  assert.ok(moves.length > 20, 'it is reported as it goes')
  assert.ok(Math.max(...moves.map((m) => m.step.translationM)) < 0.02, 'no single step comes near a threshold of the size of a jump')
  const last = moves[moves.length - 1]
  assert.ok(last.total.translationM > 0.38 && last.total.translationM <= 0.4 + 1e-9, `the last report says ${last.total.translationM} m`)
  assert.ok(moves.some((m) => m.total.translationM >= 0.3), 'a consumer that waits for 30 cm hears about it, which no step alone would tell it')
  assert.ok(near(t.anchors.anchorDisplacement(handle)!.translationM, 0.4, 1e-9), 'and the current figure is exact')
  const totals = moves.map((m) => m.total.translationM)
  assert.deepEqual([...totals].sort((a, b) => a - b), totals, 'the total only grows while the frame creeps one way')
})

test('anchorDisplacement is the total since the first sighting: null before it, null while unlocatable, and gone with the anchor', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(1, 0, 0, turn('y', 10)))
  t.frame()
  t.frame()
  const handle = (await asking)!
  assert.equal(t.anchors.anchorDisplacement(handle), null, 'not located yet')
  t.frame()
  assert.deepEqual(t.anchors.anchorDisplacement(handle), { translationM: 0, rotationDeg: 0, yawDeg: 0 }, 'located: it is where it started')

  const anchor = world.everMade[0]
  anchor.moveTo(poseAt(1, 0.3, 0.4, turn('y', 40)))
  t.frame()
  const total = t.anchors.anchorDisplacement(handle)!
  assert.ok(near(total.translationM, 0.5))
  assert.ok(near(total.rotationDeg, 30, 1e-6))
  assert.ok(near(total.yawDeg, 30, 1e-6))

  anchor.state = 'paused'
  t.frame()
  assert.equal(t.anchors.anchorDisplacement(handle), null, 'no pose now, no displacement now')
  anchor.state = 'tracking'
  t.frame()
  assert.ok(t.anchors.anchorDisplacement(handle), 'and it is back')
  t.anchors.release(handle)
  assert.equal(t.anchors.anchorDisplacement(handle), null, 'released')
})

test('rebase starts the total from where the anchor is now, and the next move is measured from there', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.moveTo(poseAt(0.5, 0, 0))
  t.frame()
  assert.ok(near(moves[0].total.translationM, 0.5))

  t.anchors.rebase(handle)
  assert.deepEqual(t.anchors.anchorDisplacement(handle), { translationM: 0, rotationDeg: 0, yawDeg: 0 })
  anchor.moveTo(poseAt(0.52, 0, 0))
  t.frame()
  assert.equal(moves.length, 2)
  assert.ok(near(moves[1].total.translationM, 0.02), 'counted from the rebase, not from the first sighting')
  assert.ok(near(moves[1].step.translationM, 0.02))
})

test('rebase also restarts the steps: a move since the rebase that is small is not reported because of an older, unreported one', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.moveTo(poseAt(0.006, 0, 0))
  t.frame()
  assert.equal(moves.length, 0, '6 mm is under the threshold, so it is not reported and the last report is still the start')
  t.anchors.rebase(handle)
  anchor.moveTo(poseAt(0.012, 0, 0))
  t.frame()
  assert.equal(moves.length, 0, '6 mm since the rebase: nothing, although it is 12 mm from the last report before it')
})

test('rebase of an anchor that cannot be located makes its next sighting the new start, and an unknown handle is ignored', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.state = 'paused'
  t.frame()
  t.anchors.rebase(handle)
  anchor.moveTo(poseAt(3, 0, 0))
  anchor.state = 'tracking'
  t.frame()
  assert.equal(moves.length, 0, 'the first sighting after a rebase is a start, not a move')
  assert.deepEqual(t.anchors.anchorDisplacement(handle), { translationM: 0, rotationDeg: 0, yawDeg: 0 })
  t.anchors.rebase({ id: 'nobody' })
})

test('a turn is reported with its size and its yaw, and a tilt of the anchor counts as a move with no yaw', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0, turn('y', 10)))
  const moves = recordMoves(t.anchors)

  anchor.moveTo(poseAt(0, 0, 0, turn('y', 40)))
  t.frame()
  assert.equal(moves.length, 1)
  assert.ok(near(moves[0].step.rotationDeg, 30, 1e-6))
  assert.ok(near(moves[0].step.yawDeg, 30, 1e-6), 'counter-clockwise from above is positive, as in pose-delta.ts')
  assert.equal(moves[0].step.translationM, 0)
  assert.ok(near(moves[0].total.yawDeg, 30, 1e-6))

  anchor.moveTo(poseAt(0, 0, 0, turn('y', 25)))
  t.frame()
  assert.ok(near(moves[1].step.yawDeg, -15, 1e-6), 'the other way is negative')
  assert.ok(near(moves[1].total.yawDeg, 15, 1e-6), 'and the total is from where it started')

  anchor.moveTo(poseAt(0, 0, 0, compose(turn('y', 25), turn('x', 5))))
  t.frame()
  assert.equal(moves.length, 3)
  assert.ok(near(moves[2].step.rotationDeg, 5, 1e-6))
  assert.ok(Math.abs(moves[2].step.yawDeg) < 1e-6, 'a tilt about a horizontal axis is no turn about the vertical')
  assert.ok(Math.abs(moves[2].step.translationM) < 1e-12)
})

test('an anchor whose own up axis lies flat (a wall hit) reports a one degree turn as one degree of yaw, not a jump of about ninety', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const wall = turn('z', 90)
  const { anchor } = await anchorAt(world, t, poseAt(0, 1, 0, wall))
  const moves = recordMoves(t.anchors)
  for (const tilt of [1, 2, 5]) {
    anchor.moveTo(poseAt(0, 1, 0, compose(wall, turn('x', tilt))))
    t.frame()
    const last = moves[moves.length - 1]
    assert.ok(near(last.total.rotationDeg, tilt, 1e-6), `${tilt} degrees of turn`)
    assert.ok(near(last.total.yawDeg, tilt, 1e-6), `${tilt} degrees about the vertical, which is the wall anchor's own x axis`)
  }

  const floor = turn('y', 30)
  anchor.moveTo(poseAt(0, 1, 0, floor))
  t.frame()
  anchor.moveTo(poseAt(0, 1, 0, compose(floor, turn('x', 3))))
  t.frame()
  const tilted = moves[moves.length - 1]
  assert.ok(near(tilted.step.rotationDeg, 3, 1e-6))
  assert.ok(Math.abs(tilted.step.yawDeg) < 1e-6, 'a floor anchor tilted about its own horizontal axis has no yaw')
})

test('yawAboutVerticalDeg is the twist about +Y: signed, wrapped, the same for q and -q, and zero for a turn about a horizontal axis', () => {
  assert.ok(near(yawAboutVerticalDeg(turn('y', 20), turn('y', 50)), 30, 1e-9))
  assert.ok(near(yawAboutVerticalDeg(turn('y', 50), turn('y', 20)), -30, 1e-9))
  const negated = (q: Point4): Point4 => ({ x: -q.x, y: -q.y, z: -q.z, w: -q.w })
  assert.ok(near(yawAboutVerticalDeg(turn('y', 20), negated(turn('y', 50))), 30, 1e-9), 'q and -q are one rotation')
  assert.ok(near(yawAboutVerticalDeg(turn('y', 170), turn('y', -170)), 20, 1e-9), 'across the wrap, the short way')
  assert.ok(Math.abs(yawAboutVerticalDeg(turn('x', 10), turn('x', 70))) < 1e-9)
  assert.ok(Math.abs(yawAboutVerticalDeg(turn('z', 10), turn('z', 70))) < 1e-9)
  assert.equal(yawAboutVerticalDeg(IDENTITY, IDENTITY), 0)
  assert.equal(yawAboutVerticalDeg(IDENTITY, { x: 0, y: 0, z: 0, w: 0 }), 0, 'a zero quaternion has no turn')
})

test('rotationAngleDeg is the shortest turn between two rotations, whichever sign the quaternion has, and never NaN', () => {
  assert.equal(rotationAngleDeg(IDENTITY, IDENTITY), 0)
  assert.ok(near(rotationAngleDeg(turn('y', 20), turn('y', 50)), 30, 1e-9))
  const negated = { x: -turn('y', 50).x, y: -turn('y', 50).y, z: -turn('y', 50).z, w: -turn('y', 50).w }
  assert.ok(near(rotationAngleDeg(turn('y', 20), negated), 30, 1e-9), 'q and -q are one rotation')
  assert.ok(near(rotationAngleDeg(IDENTITY, turn('y', 180)), 180, 1e-9))
  assert.ok(near(rotationAngleDeg(turn('x', 0.001), turn('x', 0.002)), 0.001, 1e-9), 'small angles keep their precision')
  assert.equal(rotationAngleDeg(IDENTITY, { x: 0, y: 0, z: 0, w: 0 }), 0, 'a zero quaternion has no turn')
  assert.ok(near(rotationAngleDeg(turn('y', 20), { x: 0, y: 2 * turn('y', 50).y, z: 0, w: 2 * turn('y', 50).w }), 30, 1e-9), 'a quaternion that is not unit length')
})

test('a stationary anchor whose quaternion does not normalise exactly is never reported as moving, and its angle is zero', async () => {
  // A float32 orientation for which |a.b| / (|a||b|) rounds to 1.0000000000000002 in double precision, which an arccosine turns into NaN.
  const q = { x: -0.21391665935516357, y: -0.7041392922401428, z: -0.3298310935497284, w: -0.591302752494812 }
  assert.ok(rotationAngleDeg(q, q) < 1e-12)
  const world = new FakeWorld()
  const t = tracker(world)
  await anchorAt(world, t, poseAt(0, 0, -1, q))
  const moves = recordMoves(t.anchors)
  for (let frame = 0; frame < 10; frame++) t.frame()
  assert.deepEqual(moves, [], 'nothing moved')
})

test('the move event carries where the anchor is now and when', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  anchor.moveTo(poseAt(0, 0.5, 0))
  t.frame()
  assert.equal(moves[0].handle, handle)
  assert.deepEqual(moves[0].pose.position, { x: 0, y: 0.5, z: 0 })
  assert.ok(moves[0].atMs > 0)
  moves[0].pose.position.y = 99
  assert.equal(t.anchors.anchorPose(handle)?.position.y, 0.5, 'a listener cannot change the cached pose')
  const asked = t.anchors.anchorPose(handle)!
  asked.position.y = -7
  assert.equal(t.anchors.anchorPose(handle)?.position.y, 0.5, 'nor can a caller of anchorPose')
})

test('an anchor the runtime cannot place for a while reads as null and is reported lost, its handle stays, and a displaced return is a move', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(1, 0, 1))
  const moves = recordMoves(t.anchors)
  const losses = recordLosses(t.anchors)
  const returns: AnchorReturnedEvent[] = []
  t.anchors.onReturned((event) => returns.push(event))

  anchor.state = 'paused'
  t.frame()
  assert.equal(t.anchors.anchorPose(handle), null)
  // WP-17b: a listed anchor with no pose used to be silent. The epoch rule counts "returning with a null pose" as a loss, so it is reported
  // (how: 'no-pose'); the handle is kept, because the runtime still lists it and it can come back.
  assert.equal(losses.length, 1)
  assert.equal(losses[0].how, 'no-pose')
  assert.equal(losses[0].handle, handle)

  anchor.state = 'tracking'
  t.frame()
  assert.equal(moves.length, 0, 'back where it was')
  assert.equal(returns.length, 1, 'and reported as back')
  assert.deepEqual(t.anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 1 }, 'the same handle reads again')

  anchor.state = 'paused'
  t.frame()
  assert.equal(losses.length, 2, 'each time it goes is a loss')
  anchor.moveTo(poseAt(1.4, 0, 1))
  anchor.state = 'tracking'
  t.frame()
  assert.equal(moves.length, 1, 'it came back 40 cm from where it was: the frame moved while it was gone')
  assert.ok(near(moves[0].step.translationM, 0.4))
  assert.ok(near(moves[0].total.translationM, 0.4))
  assert.equal(returns.length, 2)
})

test('a frame with nothing asked for and nothing held reads nothing but the one feature check', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  t.frame()
  t.frame()
  assert.equal(world.trackedReads, 0, 'this runs at the headset refresh rate, so an idle frame must stay cheap')

  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  assert.ok(world.trackedReads > 0, 'it reads the set as soon as it holds an anchor')
  t.anchors.release(handle)
  const reads = world.trackedReads
  t.frame()
  assert.equal(world.trackedReads, reads, 'and stops again when the last anchor is given back')
})

test('a runtime that has createAnchor but gives no tracked set is not trusted: the capability turns off and what it held is deleted', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const waiting = t.anchors.createAnchor(poseAt(1, 0, 1))
  t.frame({ set: false })
  assert.equal(t.anchors.usable, false)
  assert.equal(anchor.deleted, true)
  assert.equal(await byNow(waiting), null)
  assert.equal(t.anchors.anchorPose(handle), null)
})

test('a frame that throws when the tracked set is read does not break the frame loop: the capability turns itself off, and whoever waited is let go', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const waiting = t.anchors.createAnchor(poseAt(1, 0, 1))
  const frame = world.frame()
  Object.defineProperty(frame, 'trackedAnchors', {
    get() {
      throw domError('InvalidStateError', 'the frame is not active')
    },
  })
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    assert.doesNotThrow(() => t.anchors.onFrame(frame, world.ref as unknown as XRSpace, 99))
  } finally {
    console.error = original
  }
  assert.match(String(errors[0]?.[0]), /\[anchors\] a frame step failed/)
  assert.equal(t.anchors.usable, false)
  assert.equal(anchor.deleted, true)
  assert.equal(t.anchors.anchorPose(handle), null)
  assert.equal(await byNow(waiting), null)
})

test('a runtime that throws for one anchor does not stop the others being read, and that anchor reads as null', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const first = await anchorAt(world, t, poseAt(0, 0, 0))
  const second = await anchorAt(world, t, poseAt(1, 0, 0))
  const losses = recordLosses(t.anchors)

  first.anchor.broken = true
  second.anchor.moveTo(poseAt(1, 0, 4))
  t.frame()
  assert.equal(t.anchors.anchorPose(first.handle), null)
  assert.deepEqual(t.anchors.anchorPose(second.handle)?.position, { x: 1, y: 0, z: 4 })
  // WP-17b: the runtime still lists it but cannot place it, which is reported as a loss (how: 'no-pose'); the other anchor is not.
  assert.deepEqual(losses.map((loss) => [loss.handle, loss.how]), [[first.handle, 'no-pose']])
})

test('a lost anchor is reported once, kept for the return window, and then forgotten: no pose, no second report, and release has nothing left to do', async () => {
  const world = new FakeWorld()
  const t = tracker(world, { returnWindowMs: 100 })
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  const losses = recordLosses(t.anchors)
  const expired: AnchorExpiredEvent[] = []
  t.anchors.onExpired((event) => expired.push(event))

  world.lose(anchor)
  t.frame()
  t.frame()
  assert.equal(losses.length, 1)
  assert.equal(losses[0].handle, handle)
  assert.equal(losses[0].how, 'left-set')
  assert.equal(t.anchors.anchorPose(handle), null)
  assert.equal(moves.length, 0)
  // WP-17b: a Chrome that empties the tracked set during a tracking loss does not mean the anchor is gone for good, so the handle is
  // kept, and the runtime is not told to drop it, until the window has run out.
  assert.equal(anchor.deleted, false)
  assert.equal(expired.length, 0)

  for (let i = 0; i < 8; i++) t.frame()
  assert.equal(expired.length, 1)
  assert.equal(expired[0].handle, handle)
  assert.equal(anchor.deleted, true, 'the runtime is told to stop tracking what it already dropped, once the window has run out')
  assert.equal(losses.length, 1, 'a lost anchor is reported once')
  t.anchors.release(handle)
  assert.equal(losses.length, 1)
  assert.equal(expired.length, 1)
})

test('release deletes the anchor, reports nothing, and leaves the others alone', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const first = await anchorAt(world, t, poseAt(0, 0, 0))
  const second = await anchorAt(world, t, poseAt(1, 0, 0))
  const losses = recordLosses(t.anchors)

  t.anchors.release(first.handle)
  t.frame()
  assert.equal(first.anchor.deleted, true)
  assert.equal(second.anchor.deleted, false)
  assert.equal(t.anchors.anchorPose(first.handle), null)
  assert.deepEqual(t.anchors.anchorPose(second.handle)?.position, { x: 1, y: 0, z: 0 })
  assert.deepEqual(losses, [])
})

test('dispose deletes everything silently, answers waiting requests with null, and refuses new ones', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const losses = recordLosses(t.anchors)
  const waiting = t.anchors.createAnchor(poseAt(5, 0, 5))
  assert.ok(t.anchors.anchorPose(handle))

  t.anchors.dispose()
  assert.equal(anchor.deleted, true)
  assert.equal(await waiting, null)
  assert.equal(t.anchors.usable, false)
  assert.equal(await t.anchors.createAnchor(poseAt(0, 0, 0)), null)
  t.frame()
  assert.deepEqual(losses, [])
  assert.equal(world.created.length, 1, 'the waiting request was never made')
  assert.equal(t.anchors.anchorPose(handle), null, 'nothing is held any more')
  assert.equal(t.anchors.anchorDisplacement(handle), null)
  t.anchors.dispose()
})

test('dispose stops the reports for good: a listener added before it hears nothing after it', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const moves = recordMoves(t.anchors)
  const losses = recordLosses(t.anchors)
  t.anchors.dispose()
  anchor.moveTo(poseAt(5, 0, 0))
  t.frame()
  world.lose(anchor)
  t.frame()
  assert.deepEqual([moves, losses], [[], []])
})

test('an anchor that arrives after dispose is deleted, not left with the runtime', async () => {
  const world = new FakeWorld()
  world.createMode = 'hang'
  const t = tracker(world)
  const asking = t.anchors.createAnchor(poseAt(0, 0, 0))
  t.frame()
  t.anchors.dispose()
  assert.equal(await asking, null)
  const late = world.hanging[0]()
  await settle()
  assert.equal(late.deleted, true)
})

test('a handle from an earlier session is not read or released by a new one that reuses its id', async () => {
  const world = new FakeWorld()
  const old = tracker(world)
  const stale = (await anchorAt(world, old, poseAt(0, 0, 0))).handle
  old.anchors.dispose()

  const next = tracker(world)
  const current = await anchorAt(world, next, poseAt(3, 0, 0))
  assert.equal(stale.id, current.handle.id, 'the ids repeat from one session to the next, which is the trap')
  assert.equal(next.anchors.anchorPose(stale), null)
  assert.equal(next.anchors.anchorDisplacement(stale), null)
  next.anchors.rebase(stale)
  next.anchors.release(stale)
  assert.equal(current.anchor.deleted, false, 'releasing a stale handle must not delete a live anchor')
  assert.deepEqual(next.anchors.anchorPose(current.handle)?.position, { x: 3, y: 0, z: 0 })
})

test('a listener that throws neither stops the other listeners nor the frame loop, and an unsubscribed one hears nothing', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const heard: number[] = []
  t.anchors.onMoved(() => {
    throw new Error('a listener bug')
  })
  const off = t.anchors.onMoved(() => heard.push(1))
  t.anchors.onMoved(() => heard.push(2))
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    anchor.moveTo(poseAt(1, 0, 0))
    t.frame()
    off()
    anchor.moveTo(poseAt(2, 0, 0))
    t.frame()
  } finally {
    console.error = original
  }
  assert.deepEqual(heard, [1, 2, 2])
  assert.equal(errors.length, 2)
})

test('an unsubscribed loss listener hears nothing, and one that throws does not stop the others', async () => {
  const world = new FakeWorld()
  const t = tracker(world)
  const { anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const heard: string[] = []
  t.anchors.onLost(() => {
    throw new Error('a listener bug')
  })
  const off = t.anchors.onLost(() => heard.push('off'))
  t.anchors.onLost(() => heard.push('on'))
  off()
  const original = console.error
  console.error = () => undefined
  try {
    world.lose(anchor)
    t.frame()
  } finally {
    console.error = original
  }
  assert.deepEqual(heard, ['on'])
})

// --- persistent anchors on the capability -------------------------------------------------------------------------------------

test('a runtime with no persistence (Chrome Android) says so, and every persistence call answers without throwing', async () => {
  const world = new FakeWorld(false)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  assert.equal(t.anchors.supportsPersistence, false)
  assert.equal(await t.anchors.requestPersistentHandle(handle), null)
  assert.equal(t.anchors.persistentIdOf(handle), null)
  assert.deepEqual(await t.anchors.restorePersistentAnchor('00000000-0000-4000-8000-000000000001'), { status: 'no-answer' })
  assert.equal(await t.anchors.deletePersistentAnchor('00000000-0000-4000-8000-000000000001'), false)
  assert.equal(t.anchors.persistentAnchorIds(), null)
})

test('asking for a persistent handle of a handle that is not live, of an anchor that cannot be kept, or that the browser answers blank, is null and records nothing', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  assert.equal(await t.anchors.requestPersistentHandle({ id: 'nobody' }), null, 'a handle this session never made')
  const gone = (await anchorAt(world, t, poseAt(1, 0, 0))).handle
  t.anchors.release(gone)
  assert.equal(await t.anchors.requestPersistentHandle(gone), null, 'a handle that was given back')
  assert.equal(t.anchors.persistentIdOf(gone), null)

  world.handleMode = 'blank'
  assert.equal(await t.anchors.requestPersistentHandle(handle), null, 'a blank answer is no handle')
  assert.equal(t.anchors.persistentIdOf(handle), null)
  world.handleMode = 'ok'

  ;(anchor as { requestPersistentHandle?: unknown }).requestPersistentHandle = undefined
  assert.equal(await t.anchors.requestPersistentHandle(handle), null, 'an anchor with no requestPersistentHandle, on a session that can restore')
  assert.equal(world.persisted.size, 0)
})

test('a saved anchor that was given back can be restored again, and the browser is asked again, since nothing holds it', async () => {
  const world = new FakeWorld(true)
  const one = tracker(world)
  const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
  one.anchors.dispose()

  const two = tracker(world)
  const first = two.anchors.restorePersistentAnchor(uuid)
  two.frame()
  two.frame()
  const a = await first
  assert.equal(a.status, 'restored')
  if (a.status !== 'restored') return
  two.anchors.release(a.handle)

  const again = two.anchors.restorePersistentAnchor(uuid)
  two.frame()
  two.frame()
  const b = await again
  assert.equal(b.status, 'restored', 'not answered with the finished request of the first')
  assert.deepEqual(world.restoreCalls, [uuid, uuid])
})

test('on a runtime that persists: a handle is requested once per anchor, and release leaves the saved anchor to the runtime', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0.5, 0, -2, turn('y', 20)))
  assert.equal(t.anchors.supportsPersistence, true)
  assert.equal(t.anchors.persistentIdOf(handle), null, 'nothing asked yet')
  const uuid = await t.anchors.requestPersistentHandle(handle)
  assert.match(uuid ?? '', /^[0-9a-f-]{36}$/)
  assert.equal(t.anchors.persistentIdOf(handle), uuid)
  assert.equal(await t.anchors.requestPersistentHandle(handle), uuid, 'the same anchor keeps the same handle')
  assert.equal(world.handleRequests, 1, 'and the browser is asked once')
  assert.deepEqual(t.anchors.persistentAnchorIds(), [uuid])

  t.anchors.release(handle)
  assert.equal(anchor.deleted, false, 'a saved anchor is only forgotten here: deleting it is for deletePersistentAnchor')
  assert.deepEqual(world.deleteCalls, [])
  assert.equal(t.anchors.anchorPose(handle), null)
  assert.deepEqual(t.anchors.persistentAnchorIds(), [uuid], 'a persistent anchor outlives the anchor object')
})

test('a saved anchor is restored in the next session where the runtime puts it there, as a live anchor with a handle of its own', async () => {
  const world = new FakeWorld(true)
  const one = tracker(world)
  const { handle } = await anchorAt(world, one, poseAt(0.5, 0, -2, turn('y', 20)))
  const uuid = (await one.anchors.requestPersistentHandle(handle))!
  one.anchors.dispose()

  // The next session's frame has its origin somewhere else; the saved anchor is where the room put it, not where the numbers were.
  world.shiftFrame({ x: 1, y: 0, z: 0 })
  const two = tracker(world)
  assert.deepEqual(two.anchors.persistentAnchorIds(), [uuid])
  const asking = two.anchors.restorePersistentAnchor(uuid)
  assert.equal(await byNow(asking), 'pending', 'the runtime settles a restored anchor in a frame, like a new one')
  two.frame()
  two.frame()
  const restored = await asking
  assert.equal(restored.status, 'restored')
  if (restored.status !== 'restored') return
  assert.equal(two.anchors.persistentIdOf(restored.handle), uuid)
  two.frame()
  assert.deepEqual(two.anchors.anchorPose(restored.handle)?.position, { x: -0.5, y: 0, z: -2 })
  assert.equal((await two.anchors.restorePersistentAnchor('00000000-0000-4000-8000-0000000000ff')).status, 'refused', 'an unknown handle is refused, not a throw')
})

test('restoring one uuid twice is one live anchor with one handle, whether the browser hands back the same object or a new one, and a move is reported once', async () => {
  for (const restoreObject of ['same', 'new'] as const) {
    const world = new FakeWorld(true)
    world.restoreObject = restoreObject
    const one = tracker(world)
    const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
    one.anchors.dispose()

    const two = tracker(world)
    const first = two.anchors.restorePersistentAnchor(uuid)
    two.frame()
    two.frame()
    const a = await first
    assert.equal(a.status, 'restored')
    if (a.status !== 'restored') return
    two.frame()
    const b = await two.anchors.restorePersistentAnchor(uuid)
    assert.deepEqual(b, a, `${restoreObject}: the second ask is answered with the first handle`)
    assert.deepEqual(world.restoreCalls, [uuid], `${restoreObject}: and the browser was asked once`)

    const moves = recordMoves(two.anchors)
    world.persisted.get(uuid)!.anchor!.moveTo(poseAt(0.2, 0, 0))
    two.frame()
    assert.equal(moves.length, 1, `${restoreObject}: one move, one report`)
    two.anchors.release(a.handle)
    assert.equal(world.deleteCalls.length, 0, `${restoreObject}: and giving it back deletes nothing`)
  }
})

test('a restore that hands back an anchor this session already tracks is that anchor: one handle, and the uuid is learned', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  // Saved by something other than this class (the raw API), so the tracker does not know the uuid yet.
  const uuid = await anchor.requestPersistentHandle()
  assert.equal(t.anchors.persistentIdOf(handle), null)

  const asking = t.anchors.restorePersistentAnchor(uuid)
  t.frame()
  t.frame()
  assert.deepEqual(await asking, { status: 'restored', handle })
  assert.equal(t.anchors.persistentIdOf(handle), uuid, 'and from now on it is known as saved, so it is not deleted with the session')
  t.anchors.dispose()
  assert.deepEqual(world.deleteCalls, [])
})

test('two restores of one uuid at once share one browser request, since the browser refuses a repeat while the first waits', async () => {
  const world = new FakeWorld(true)
  const one = tracker(world)
  const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
  one.anchors.dispose()

  const two = tracker(world)
  const both = Promise.all([two.anchors.restorePersistentAnchor(uuid), two.anchors.restorePersistentAnchor(uuid)])
  two.frame()
  two.frame()
  const [a, b] = await both
  assert.equal(a.status, 'restored')
  assert.deepEqual(b, a)
  assert.deepEqual(world.restoreCalls, [uuid])
})

test('a restore that never settles gives no answer at the timeout, and the anchor that arrives late is kept and handed out when asked for again', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld(true)
  const one = tracker(world)
  const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
  one.anchors.dispose()

  const two = tracker(world)
  world.restoreMode = 'hang'
  const restoring = two.anchors.restorePersistentAnchor(uuid)
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.deepEqual(await restoring, { status: 'no-answer' })

  // Asking again while the browser still has not answered joins the wait, instead of being refused as a repeat.
  const again = two.anchors.restorePersistentAnchor(uuid)
  assert.deepEqual(world.restoreCalls, [uuid], 'the browser is not asked a second time')

  const late = world.hanging[0]()
  await settle()
  const answered = await again
  assert.equal(answered.status, 'restored')
  if (answered.status !== 'restored') return
  assert.equal(late.deleted, false, 'a saved anchor that came late is not deleted')
  assert.deepEqual(world.deleteCalls, [])
  assert.deepEqual(await two.anchors.restorePersistentAnchor(uuid), answered, 'and from now on it is simply live')
  two.frame()
  assert.deepEqual(two.anchors.anchorPose(answered.handle)?.position, { x: 0, y: 0, z: 0 }, 'read like any other anchor')
})

test('a restore or a delete of something that cannot be a uuid, or after the session is over, is answered without asking the browser', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  for (const bad of ['', undefined as unknown as string, 7 as unknown as string]) {
    assert.deepEqual(await byNow(t.anchors.restorePersistentAnchor(bad)), { status: 'no-answer' })
  }
  assert.deepEqual(world.restoreCalls, [])

  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  const uuid = (await t.anchors.requestPersistentHandle(handle))!
  t.anchors.dispose()
  assert.equal(await byNow(t.anchors.deletePersistentAnchor(uuid)), false)
  assert.equal(world.persisted.has(uuid), true, 'the saved anchor was not touched by a session that is over')
  assert.deepEqual(await byNow(t.anchors.restorePersistentAnchor(uuid)), { status: 'no-answer' })
  assert.deepEqual(world.restoreCalls, [])
})

test('a restore the browser refuses is refused, a throw is no answer, and neither is left waiting for the timeout', async () => {
  const world = new FakeWorld(true)
  const one = tracker(world)
  const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
  one.anchors.dispose()

  const two = tracker(world)
  world.restoreMode = 'refuse'
  assert.deepEqual(await byNow(two.anchors.restorePersistentAnchor(uuid)), { status: 'refused' })
  world.restoreMode = 'throw'
  assert.deepEqual(await byNow(two.anchors.restorePersistentAnchor(uuid)), { status: 'no-answer' })
  world.restoreMode = 'ok'
  const asking = two.anchors.restorePersistentAnchor(uuid)
  two.frame()
  two.frame()
  assert.equal((await asking).status, 'restored', 'earlier trouble is not remembered')
})

test('a restore waiting on the browser when the session ends is answered with no answer, and what arrives after is not kept', async () => {
  const world = new FakeWorld(true)
  const one = tracker(world)
  const uuid = (await one.anchors.requestPersistentHandle((await anchorAt(world, one, poseAt(0, 0, 0))).handle))!
  one.anchors.dispose()

  const two = tracker(world)
  world.restoreMode = 'hang'
  const restoring = two.anchors.restorePersistentAnchor(uuid)
  two.anchors.dispose()
  assert.deepEqual(await restoring, { status: 'no-answer' })
  world.hanging[0]()
  await settle()
  assert.deepEqual(world.deleteCalls, [], 'the runtime ends it with the session; this class does not delete a saved anchor')
  assert.deepEqual(await two.anchors.restorePersistentAnchor(uuid), { status: 'no-answer' })
})

test('persistentAnchorIds reports what the browser lists without its blank entries, null when it does not say, and nothing here trusts it', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const uuid = (await t.anchors.requestPersistentHandle((await anchorAt(world, t, poseAt(0, 0, 0))).handle))!
  assert.deepEqual(t.anchors.persistentAnchorIds(), [uuid])
  world.listMode = 'blank'
  assert.deepEqual(t.anchors.persistentAnchorIds(), [], 'blank strings are not ids')
  world.listMode = 'empty'
  assert.deepEqual(t.anchors.persistentAnchorIds(), [])
  world.listMode = 'absent'
  assert.equal(t.anchors.persistentAnchorIds(), null)
})

test('deleting a persistent anchor removes it from the browser and is not reported as a lost anchor', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  const uuid = (await t.anchors.requestPersistentHandle(handle))!
  const losses = recordLosses(t.anchors)

  assert.equal(await t.anchors.deletePersistentAnchor(uuid), true)
  assert.equal(t.anchors.anchorPose(handle), null, 'gone as soon as the browser says so')
  t.frame()
  t.frame()
  assert.deepEqual(losses, [], 'the app deleted it; the runtime did not drop it')
  assert.deepEqual(t.anchors.persistentAnchorIds(), [])
  assert.equal(await t.anchors.deletePersistentAnchor(uuid), false, 'a second delete of the same handle is false')
})

test('a frame that comes while a persistent delete is still being confirmed does not read the anchor the app is deleting as lost', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  const uuid = (await t.anchors.requestPersistentHandle(handle))!
  const losses = recordLosses(t.anchors)

  const deleting = t.anchors.deletePersistentAnchor(uuid)
  t.frame()
  assert.equal(await deleting, true)
  t.frame()
  assert.deepEqual(losses, [], 'the runtime drops the live anchor as part of the delete, before the browser has answered')
})

test('a delete the browser refuses leaves the anchor tracked and owned: still read, still reported, and still released at the end of the session', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle, anchor } = await anchorAt(world, t, poseAt(0, 0, 0))
  const uuid = (await t.anchors.requestPersistentHandle(handle))!
  const moves = recordMoves(t.anchors)
  const losses = recordLosses(t.anchors)

  world.deleteMode = 'refuse'
  assert.equal(await t.anchors.deletePersistentAnchor(uuid), false)
  assert.ok(t.anchors.anchorPose(handle), 'the app still holds it, so it must still be readable')
  anchor.moveTo(poseAt(0.3, 0, 0))
  t.frame()
  assert.equal(moves.length, 1, 'and still reports')
  world.lose(anchor)
  t.frame()
  assert.equal(losses.length, 1, 'a real loss afterwards is still a loss: the refused delete did not hide it')
  assert.deepEqual(world.persisted.has(uuid), true)
  assert.deepEqual(world.deleteCalls, [], 'and a lost saved anchor is not deleted either')
})

test('a delete the browser never answers gives false at the timeout and leaves the anchor owned', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  const uuid = (await t.anchors.requestPersistentHandle(handle))!
  world.deleteMode = 'hang'
  const deleting = t.anchors.deletePersistentAnchor(uuid)
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.equal(await deleting, false)
  assert.ok(t.anchors.anchorPose(handle), 'still owned')
  t.anchors.dispose()
})

test('a persistent handle the browser refuses (it is full) or never answers is null, and a handle that arrives late stays on the live anchor', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld(true)
  world.persistCap = 1
  const t = tracker(world)
  const first = await anchorAt(world, t, poseAt(0, 0, 0))
  const second = await anchorAt(world, t, poseAt(1, 0, 0))
  assert.ok(await t.anchors.requestPersistentHandle(first.handle))
  assert.equal(await t.anchors.requestPersistentHandle(second.handle), null, 'Maximum number of anchors reached')

  world.persistCap = 8
  world.handleMode = 'hang'
  const asking = t.anchors.requestPersistentHandle(second.handle)
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.equal(await asking, null, 'no answer in time')
  world.handleMode = 'ok'
  world.hangingHandles[0]()
  await settle()
  const late = t.anchors.persistentIdOf(second.handle)
  assert.match(late ?? '', /^[0-9a-f-]{36}$/, 'it arrived late and was kept on the anchor')
  assert.equal(await t.anchors.requestPersistentHandle(second.handle), late, 'so asking again is answered at once')
})

test('a persistent handle that comes in time is the caller\'s, even if the anchor was given back while the browser answered', async () => {
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  world.handleMode = 'hang'
  const asking = t.anchors.requestPersistentHandle(handle)
  await settle()
  assert.equal(world.handleRequests, 1, 'the browser has the request')
  t.anchors.release(handle)
  world.handleMode = 'ok'
  world.hangingHandles[0]()
  const uuid = await asking
  assert.match(uuid ?? '', /^[0-9a-f-]{36}$/)
  await settle()
  assert.equal(world.persisted.has(uuid!), true, 'it answered in time, so the caller records it and it is not taken back')
})

test('a persistent handle that arrives after the anchor was given back is deleted again, and not left unnamed in the browser', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const world = new FakeWorld(true)
  const t = tracker(world)
  const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
  world.handleMode = 'hang'
  const asking = t.anchors.requestPersistentHandle(handle)
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
  assert.equal(await asking, null)
  t.anchors.release(handle)
  world.handleMode = 'ok'
  world.hangingHandles[0]()
  await settle()
  assert.equal(world.persisted.size, 0, 'nobody can name it, so the slot is given back')
})

test('a persistent handle that arrives after the session ended cannot be taken back, and is left alone without an error', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const world = new FakeWorld(true)
    const t = tracker(world)
    const { handle } = await anchorAt(world, t, poseAt(0, 0, 0))
    world.handleMode = 'hang'
    const asking = t.anchors.requestPersistentHandle(handle)
    context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS)
    assert.equal(await asking, null)
    t.anchors.dispose()
    world.handleMode = 'ok'
    world.hangingHandles[0]()
    await settle()
    // The session is over, so there is nobody to ask: this is the one leak this class cannot close (see requestPersistentHandle).
    assert.equal(world.persisted.size, 1)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// --- an anchor must never stall or break a calibration -----------------------------------------------------------------------

test('tryCreateAnchor never waits on or breaks for an optional anchor: no capability, a throwing, rejecting or empty one answer at once, a silent one at its timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const landmark = { x: 1.2, y: 0.05, z: -0.7 }
  const marker = { x: 1.2, y: 0.05, z: 0.8 }
  const hit = (p: Vec3) => ({ ...poseAt(p.x, p.y, p.z), distance: 1 })

  const offering = (createAnchor: () => Promise<AnchorHandle | null>) => ({ anchors: { createAnchor } as unknown as AnchorCapability })
  const providers: Array<[string, { readonly anchors?: AnchorCapability }, boolean]> = [
    ['no capability', {}, false],
    ['a createAnchor that throws', offering(() => { throw new Error('boom') }), false],
    ['a createAnchor that rejects', offering(() => Promise.reject(new Error('refused'))), false],
    ['a createAnchor that returns null', offering(() => Promise.resolve(null)), false],
    ['a capability with no createAnchor at all', { anchors: {} as unknown as AnchorCapability }, false],
    ['a createAnchor that never answers', offering(() => new Promise(() => {})), true],
  ]
  for (const [name, provider, silent] of providers) {
    const asking = Promise.all([tryCreateAnchor(provider, hit(landmark)), tryCreateAnchor(provider, hit(marker))])
    if (silent) {
      assert.equal(await byNow(asking), 'pending', `${name}: nothing to answer with yet`)
      context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS * 2)
      assert.deepEqual(await asking, [null, null], name)
    } else {
      assert.deepEqual(await byNow(asking), [null, null], `${name}: answers within the turn, no timer needed`)
    }
  }
})

test('tryCreateAnchor returns the handle when the capability gives one, and releases a handle that comes after it gave up', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const given: AnchorHandle = { id: 'given' }
  const released: AnchorHandle[] = []
  const quick = { anchors: { createAnchor: () => Promise.resolve(given), release: (h: AnchorHandle) => released.push(h) } as unknown as AnchorCapability }
  assert.equal(await tryCreateAnchor(quick, poseAt(0, 0, 0)), given)
  assert.equal(released.length, 0, 'a handle that came in time is the caller\'s, not given back')

  let answerLate: (handle: AnchorHandle | null) => void = () => undefined
  const slow = {
    anchors: {
      createAnchor: () => new Promise<AnchorHandle | null>((resolve) => { answerLate = resolve }),
      release: (h: AnchorHandle) => released.push(h),
    } as unknown as AnchorCapability,
  }
  const asking = tryCreateAnchor(slow, poseAt(0, 0, 0))
  context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS * 2)
  assert.equal(await asking, null)
  const late: AnchorHandle = { id: 'late' }
  answerLate(late)
  await settle()
  assert.deepEqual(released, [late], 'nobody holds the late handle, so it is given back')
})

test('a late handle whose release throws, or a late null or rejection, is swallowed: tryCreateAnchor never leaks an unhandled rejection', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const settleLate: Array<(handle: AnchorHandle | null) => void> = []
    const rejectLate: Array<(reason: unknown) => void> = []
    const capability = {
      createAnchor: () => new Promise<AnchorHandle | null>((resolve, reject) => { settleLate.push(resolve); rejectLate.push(reject) }),
      release: () => { throw new Error('release exploded') },
    } as unknown as AnchorCapability
    const asks = [tryCreateAnchor({ anchors: capability }, poseAt(0, 0, 0)), tryCreateAnchor({ anchors: capability }, poseAt(0, 0, 0)), tryCreateAnchor({ anchors: capability }, poseAt(0, 0, 0))]
    context.mock.timers.tick(ANCHOR_REQUEST_TIMEOUT_MS * 2)
    assert.deepEqual(await Promise.all(asks), [null, null, null])
    settleLate[0]({ id: 'late' })
    settleLate[1](null)
    rejectLate[2](new Error('refused late'))
    await settle()
    await settle()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// --- the round trip across sessions -------------------------------------------------------------------------------------------

/** localStorage as a restarted browser keeps it: a plain map that outlives every session of the page. */
function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

/** Two anchors made in one session and kept under a Place, then the session ends. */
async function keepTwo(world: FakeWorld, storage: ReturnType<typeof memoryStorage>, projectId = 'place-a') {
  const one = tracker(world)
  const landmark = await anchorAt(world, one, poseAt(0, 0, 0))
  const marker = await anchorAt(world, one, poseAt(0, 0, 2.5, turn('y', 15)))
  const store = createPersistentAnchorStore(storage)
  const kept = [
    await persistAnchor(one.anchors, store, landmark.handle, { projectId, role: 'landmark' }, 10),
    await persistAnchor(one.anchors, store, marker.handle, { projectId, role: 'heading-marker' }, 11),
  ]
  assert.deepEqual(kept.map((k) => k.ok), [true, true])
  one.anchors.dispose()
  return store
}

test('a kept anchor survives the session: kept in one, restored in the next where it was, and the list is left alone', async () => {
  const world = new FakeWorld(true)
  const storage = memoryStorage()
  await keepTwo(world, storage)
  assert.equal(world.persisted.size, 2, 'the session is over, and the browser still holds what was kept')

  // Session two, after a browser restart: this app's memory is gone, the browser's map and localStorage are not.
  const two = tracker(world)
  const back = await byNowAfterFrames(two, restoreAnchors(two.anchors, createPersistentAnchorStore(storage), { projectId: 'place-a' }))
  assert.deepEqual(back.restored.map((r) => r.entry.role), ['landmark', 'heading-marker'])
  two.frame()
  assert.deepEqual(two.anchors.anchorPose(back.restored[0].handle)?.position, { x: 0, y: 0, z: 0 })
  assert.deepEqual(two.anchors.anchorPose(back.restored[1].handle)?.position, { x: 0, y: 0, z: 2.5 })
  assert.deepEqual(back.forgotten, [])
  assert.equal(createPersistentAnchorStore(storage).list().length, 2)
  assert.deepEqual(world.deleteCalls, [], 'nothing that was kept was deleted along the way')
})

/** Runs frames until a promise that waits on them has settled. A restore of several anchors needs a frame or two for each. */
async function byNowAfterFrames<T>(t: ReturnType<typeof tracker>, promise: Promise<T>): Promise<T> {
  let done = false
  void promise.then(() => (done = true), () => (done = true))
  for (let frame = 0; frame < 20 && !done; frame++) {
    t.frame()
    await settle()
  }
  assert.ok(done, 'the restore did not finish in 20 frames')
  return promise
}

test('the browser listing nothing, or blank entries, does not lose a kept anchor: it is asked for, and restored', async () => {
  for (const listMode of ['empty', 'blank'] as const) {
    const world = new FakeWorld(true)
    const storage = memoryStorage()
    await keepTwo(world, storage)
    world.listMode = listMode

    const two = tracker(world)
    const back = await byNowAfterFrames(two, restoreAnchors(two.anchors, createPersistentAnchorStore(storage), { projectId: 'place-a' }))
    assert.equal(back.restored.length, 2, `persistentAnchors is ${listMode}, and the browser still holds both`)
    assert.deepEqual(back.forgotten, [])
    assert.equal(createPersistentAnchorStore(storage).list().length, 2, 'the device-local list is untouched')
  }
})

test('where deleting an anchor erases its saved record (as reported for a Quest 3), a whole session of use and a restart still restore it', async () => {
  const world = new FakeWorld(true)
  world.deleteErasesRecord = true
  const storage = memoryStorage()
  await keepTwo(world, storage)
  assert.equal(world.persisted.size, 2, 'ending the session did not delete the saved anchors')

  const two = tracker(world)
  const back = await byNowAfterFrames(two, restoreAnchors(two.anchors, createPersistentAnchorStore(storage), { projectId: 'place-a' }))
  assert.equal(back.restored.length, 2)
  two.anchors.release(back.restored[0].handle)
  two.anchors.dispose()
  assert.equal(world.persisted.size, 2, 'giving back and ending a session with restored anchors erases nothing')

  const three = tracker(world)
  const again = await byNowAfterFrames(three, restoreAnchors(three.anchors, createPersistentAnchorStore(storage), { projectId: 'place-a' }))
  assert.equal(again.restored.length, 2)
})

test('when the browser has really lost the anchors, the list drops them only after repeated refusals in separate sessions that are old enough', async () => {
  const world = new FakeWorld(true)
  const storage = memoryStorage()
  await keepTwo(world, storage)
  world.persisted.clear()
  const week = 7 * 24 * 60 * 60 * 1000

  let outcome: Awaited<ReturnType<typeof restoreAnchors>> | undefined
  for (const [session, nowMs] of [[1, 20], [2, 21], [3, week + 22]] as const) {
    const t = tracker(world)
    outcome = await restoreAnchors(t.anchors, createPersistentAnchorStore(storage), { projectId: 'place-a' }, nowMs)
    t.anchors.dispose()
    if (session < 3) {
      assert.equal(outcome.forgotten.length, 0, `session ${session}: not yet`)
      assert.equal(createPersistentAnchorStore(storage).list().length, 2)
    }
  }
  assert.equal(outcome!.forgotten.length, 2, 'three sessions of refusals on entries a week old')
  assert.deepEqual(createPersistentAnchorStore(storage).list(), [])
})
