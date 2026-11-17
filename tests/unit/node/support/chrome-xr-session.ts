/**
 * A WebXR runtime stand-in that is in the states Chrome with ARCore can be in, for the anchor tests (WP-17b).
 *
 * It copies what the anchor research read in Chromium's sources and the specs (r3-anchors-notes.md, sections 4 and 7), and says
 * where each state comes from. It is not an emulator and it has not been compared with a device: whether Chrome really does any
 * of the loss behaviours below, and whether the same XRAnchor object comes back after one, is what device experiment DX6
 * records. What a test built on it shows is what the app does when Chrome does.
 *
 *   - Without the feature. `XRFrame.createAnchor` exists in the browser, but a session that was not granted 'anchors' makes it
 *     reject with NotSupportedError ("Anchors feature is not supported by the session."), and its `trackedAnchors` is an empty
 *     set, not an error. `enabledFeatures` (Chrome 111 and later) says what was granted; before that it is absent.
 *   - Creation. createAnchor returns a promise that the NEXT frame's update step settles, and the anchor is in `trackedAnchors`
 *     from that frame. It is only valid inside an active frame (InvalidStateError otherwise). While the runtime cannot locate
 *     the origin it is postponed, and a request older than 3 s fails with OperationError ("Anchor creation failed.").
 *   - A paused anchor stays in `trackedAnchors` and `getPose(anchor.anchorSpace, ...)` answers null.
 *   - A frame with no data (the runtime has no camera tracking) clears the session's anchors: `trackedAnchors` is empty for as
 *     many frames as the loss lasts. What follows is not known, so both are here: the same objects come back, or new objects
 *     come back and the old ones are orphans that the runtime no longer updates (their space still answers, with the last pose
 *     they had, which an app must not read as where the anchor is).
 *   - `reset` is a reference-space event; `transform` is the move of the origin or null when the runtime cannot say. It is
 *     dispatched on every space of the session.
 *   - A hidden session gets no frames.
 *   - No persistence: no `restorePersistentAnchor`, no `requestPersistentHandle` (Chrome has none).
 *
 * The frame loop of src/ar/webxr.ts is the real one: `world.session()` hands out the callback three.js registers with
 * `requestAnimationFrame`, and `world.tick()` calls it with a frame in the state the test chose.
 */
import { strict as assert } from 'node:assert'

export interface Vec3 {
  x: number
  y: number
  z: number
}
export interface Quat4 {
  x: number
  y: number
  z: number
  w: number
}
export interface PoseData {
  position: Vec3
  rotation: Quat4
}

export const IDENTITY: Quat4 = { x: 0, y: 0, z: 0, w: 1 }
export const poseAt = (x: number, y: number, z: number, rotation: Quat4 = IDENTITY): PoseData => ({ position: { x, y, z }, rotation })

/** A rotation of `deg` about one world axis. */
export const turn = (axis: 'x' | 'y' | 'z', deg: number): Quat4 => {
  const half = (deg * Math.PI) / 360
  return { x: axis === 'x' ? Math.sin(half) : 0, y: axis === 'y' ? Math.sin(half) : 0, z: axis === 'z' ? Math.sin(half) : 0, w: Math.cos(half) }
}

export function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

/** What the runtime's XRRigidTransform constructor keeps, so a test can read back what an anchor was made from. */
export class FakeRigidTransform {
  position: Quat4
  orientation: Quat4
  constructor(position: Quat4, orientation: Quat4) {
    this.position = position
    this.orientation = orientation
  }
}

/** A space: reference, viewer or an anchor's own. `origin` is where it sits in the runtime's own coordinates. It is an event target. */
export class ChromeSpace {
  readonly name: string
  origin: Vec3
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  constructor(name: string, origin: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.name = name
    this.origin = origin
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
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

export class ChromeAnchor {
  deleted = false
  /** 'paused': listed, but its pose is null. */
  state: 'tracking' | 'paused' = 'tracking'
  /** True once the runtime no longer updates this object (it was cleared from the session's anchors). */
  orphan = false
  readonly space: ChromeSpace
  /** Where it is, in the runtime's own coordinates. An orphan keeps the last value it had. */
  native: PoseData
  private readonly world: ChromeWorld
  constructor(world: ChromeWorld, native: PoseData) {
    this.world = world
    this.native = native
    this.space = new ChromeSpace('anchor')
  }
  /** Puts the anchor where `pose` is in the reference space as it stands now. */
  moveTo(pose: PoseData): void {
    const o = this.world.floor.origin
    this.native = { position: { x: pose.position.x + o.x, y: pose.position.y + o.y, z: pose.position.z + o.z }, rotation: { ...pose.rotation } }
  }
  get anchorSpace(): ChromeSpace {
    if (this.deleted) throw domError('InvalidStateError', 'the anchor was deleted')
    return this.space
  }
  delete(): void {
    if (this.deleted) return
    this.deleted = true
    this.world.deleteCalls.push(this)
  }
}

export interface FrameOptions {
  /** 'none': getViewerPose answers null. 'emulated': a pose with `emulatedPosition` true. Default: a tracked pose. */
  viewerPose?: 'tracked' | 'none' | 'emulated'
  /** Milliseconds since the last frame. Default 16. */
  dtMs?: number
}

interface Waiting {
  anchor: ChromeAnchor | null
  at: PoseData
  createdAtMs: number
  resolve: (anchor: ChromeAnchor) => void
  reject: (error: unknown) => void
}

export class ChromeWorld {
  readonly floor = new ChromeSpace('local-floor')
  readonly viewer = new ChromeSpace('viewer', { x: 0, y: 1.4, z: 0 })
  readonly local = new ChromeSpace('local')
  /** What `enabledFeatures` says. Null is a Chrome before 111, which cannot say. */
  features: string[] | null
  /** Whether the session was granted 'anchors', which is what decides what createAnchor does, whatever `features` says. */
  granted: boolean
  /** The frame clock, ms. The provider is given it as the XR frame time. */
  time = 1_000
  /** False: the runtime cannot locate the origin yet, so creation is postponed, and fails after 3 s. */
  localizable = true
  /** The anchors the runtime holds, in the order they were made. */
  live: ChromeAnchor[] = []
  everMade: ChromeAnchor[] = []
  deleteCalls: ChromeAnchor[] = []
  created: Array<{ transform: FakeRigidTransform; space: unknown }> = []
  /** What createAnchor refused, as the error name and message, in order. */
  refused: Array<{ name: string; message: string }> = []
  /** Frames still to be handed an empty `trackedAnchors`: a no-data frame clears the anchors the session holds. */
  emptyFrames = 0
  /** What comes back after those frames: the same objects, or new ones for the same anchors (the old ones become orphans). */
  returnAs: 'same' | 'new' = 'same'
  /** A new object made for an anchor that was cleared, by the anchor it replaces. */
  successors = new Map<ChromeAnchor, ChromeAnchor>()
  /** How many times a frame's `trackedAnchors` was read. */
  trackedReads = 0
  /** The callback three.js registered on the session's requestAnimationFrame: the provider's frame loop runs inside it. */
  loop: ((time: number, frame: unknown) => void) | null = null
  listeners: Record<string, Array<() => void>> = {}
  visibilityState: 'visible' | 'visible-blurred' | 'hidden' = 'visible'
  private waiting: Waiting[] = []
  private readonly bySpace = new Map<ChromeSpace, ChromeAnchor>()

  constructor(options: { features?: string[] | null; granted?: boolean } = {}) {
    this.features = options.features === undefined ? ['local-floor', 'anchors'] : options.features
    this.granted = options.granted ?? true
  }

  /**
   * Puts the frame clock on the page's clock, in whole milliseconds. The provider stamps a `reset` or a return to view with
   * performance.now(), and the frames carry the XR clock, which is the same one. Whole milliseconds because a fractional start
   * makes sums like three frames of 1000 ms come out a few ulps short of 3000, and a test that asks "is it 3 s yet" then fails on
   * some runs and not on others.
   */
  syncClockToPage(): void {
    this.time = Math.round(performance.now())
  }

  /** The session frame shifts against the room: every anchor now reads this far the other way. */
  shiftFrame(by: Vec3): void {
    this.floor.origin = { x: this.floor.origin.x + by.x, y: this.floor.origin.y + by.y, z: this.floor.origin.z + by.z }
  }

  /**
   * The runtime reports that the origin moved: `reset` on every space, with the move of the origin in `transform`, or null when it
   * cannot say. It does not move anything: a test that wants the frame to shift calls shiftFrame() as well.
   */
  reset(transform: { position: Vec3; orientation: Quat4 } | null | undefined): void {
    for (const space of [this.floor, this.viewer, this.local]) space.fire('reset', transform === undefined ? {} : { transform })
  }

  /** The session is hidden or shown again, and says so. A hidden session gets no frames: tick() refuses. */
  setVisibility(state: 'visible' | 'visible-blurred' | 'hidden'): void {
    this.visibilityState = state
    for (const listener of [...(this.listeners.visibilitychange ?? [])]) listener()
  }

  /** The camera loses tracking: for the next `frames` frames the session's anchors are cleared, and then come back as `returnAs` says. */
  loseTracking(frames: number, returnAs: 'same' | 'new' = this.returnAs): void {
    this.emptyFrames = frames
    this.returnAs = returnAs
  }

  /** A runtime that has a frame's update step: it settles the creations, then builds the set this frame will show. */
  private update(): Set<ChromeAnchor> {
    // Creations still waiting: made when the origin can be located, failed when they are 3 s old.
    for (const entry of [...this.waiting]) {
      if (this.localizable) {
        this.waiting.splice(this.waiting.indexOf(entry), 1)
        const anchor = entry.anchor ?? this.make(entry.at)
        entry.resolve(anchor)
      } else if (this.time - entry.createdAtMs >= 3_000) {
        this.waiting.splice(this.waiting.indexOf(entry), 1)
        this.refused.push({ name: 'OperationError', message: 'Anchor creation failed.' })
        entry.reject(domError('OperationError', 'Anchor creation failed.'))
      }
    }
    if (this.emptyFrames > 0) {
      this.emptyFrames--
      if (this.emptyFrames === 0) this.comeBack()
      return new Set()
    }
    return new Set(this.live.filter((anchor) => !anchor.deleted))
  }

  /** The anchors the runtime holds come back after a loss, as the same objects or as new ones. */
  private comeBack(): void {
    if (this.returnAs === 'same') return
    this.live = this.live.map((old) => {
      if (old.deleted) return old
      old.orphan = true
      const fresh = this.make({ position: { ...old.native.position }, rotation: { ...old.native.rotation } }, true)
      fresh.state = old.state
      this.successors.set(old, fresh)
      return fresh
    })
  }

  private make(native: PoseData, replacing = false): ChromeAnchor {
    const anchor = new ChromeAnchor(this, native)
    this.bySpace.set(anchor.space, anchor)
    this.everMade.push(anchor)
    if (!replacing) this.live.push(anchor)
    return anchor
  }

  /** A frame as the runtime hands it to the callback. Nothing made in it is in its `trackedAnchors`. */
  frame(options: FrameOptions = {}): any {
    const world = this
    const snapshot = this.update()
    const frame: any = {
      active: true,
      getViewerPose: (space: unknown) => {
        if (!(space instanceof ChromeSpace)) throw new TypeError('getViewerPose takes a reference space')
        if (options.viewerPose === 'none') return null
        const v = world.viewer.origin
        return {
          transform: { position: { x: v.x - space.origin.x, y: v.y - space.origin.y, z: v.z - space.origin.z }, orientation: { ...IDENTITY } },
          emulatedPosition: options.viewerPose === 'emulated',
          views: [],
        }
      },
      getHitTestResults: () => [],
      getPose(space: unknown, base: unknown): unknown {
        if (!frame.active) throw domError('InvalidStateError', 'the frame is not active')
        if (!(space instanceof ChromeSpace) || !(base instanceof ChromeSpace)) throw new TypeError('getPose takes the space and the base space')
        const anchor = world.bySpace.get(space)
        if (!anchor) return null
        if (anchor.deleted || anchor.state === 'paused') return null
        const { position: p, rotation: q } = anchor.native
        const o = base.origin
        return { transform: { position: { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }, orientation: { ...q } } }
      },
    }
    Object.defineProperty(frame, 'trackedAnchors', {
      enumerable: true,
      configurable: true,
      get: () => {
        world.trackedReads++
        return world.granted ? snapshot : new Set()
      },
    })
    frame.createAnchor = (transform: unknown, space: unknown): Promise<ChromeAnchor> => {
      const refuse = (name: string, message: string): Promise<ChromeAnchor> => {
        world.refused.push({ name, message })
        return Promise.reject(domError(name, message))
      }
      // Blink checks the feature first, and a Blink exception on a promise-returning method is a rejection.
      if (!world.granted) return refuse('NotSupportedError', 'Anchors feature is not supported by the session.')
      if (!frame.active) return refuse('InvalidStateError', 'The frame is not active.')
      if (!(transform instanceof FakeRigidTransform)) return refuse('InvalidStateError', 'No XRRigidTransform specified.')
      if (!(space instanceof ChromeSpace)) return refuse('InvalidStateError', 'No XRSpace specified.')
      world.created.push({ transform, space })
      const o = space.origin
      const at: PoseData = {
        position: { x: transform.position.x + o.x, y: transform.position.y + o.y, z: transform.position.z + o.z },
        rotation: { ...transform.orientation },
      }
      return new Promise((resolve, reject) => {
        world.waiting.push({ anchor: null, at, createdAtMs: world.time, resolve, reject })
      })
    }
    return frame
  }

  /** The session a start() will be handed. Each call is a new session, which starts with no anchors. */
  session(): any {
    const world = this
    this.live = []
    this.waiting = []
    this.emptyFrames = 0
    const session: any = {
      inputSources: [],
      renderState: {},
      get visibilityState() {
        return world.visibilityState
      },
      addEventListener(type: string, listener: () => void) {
        ;(world.listeners[type] ??= []).push(listener)
      },
      removeEventListener(type: string, listener: () => void) {
        world.listeners[type] = (world.listeners[type] ?? []).filter((l) => l !== listener)
      },
      end: async () => {},
      requestAnimationFrame(callback: (time: number, frame: unknown) => void): number {
        world.loop = callback
        return 1
      },
      updateRenderState(): void {},
      requestReferenceSpace: async (type: string) => (type === 'viewer' ? world.viewer : type === 'local' ? world.local : world.floor),
    }
    if (this.features) session.enabledFeatures = this.features
    return session
  }

  /** Runs the provider's frame loop once, on the frame clock. The frame is inactive again when the callback returns. */
  tick(options: FrameOptions = {}): void {
    assert.ok(this.loop, 'the provider never registered its frame loop')
    assert.notEqual(this.visibilityState, 'hidden', 'a hidden session gets no frames')
    this.time += options.dtMs ?? 16
    // The camera stream keeps delivering, or the provider would refuse a capture as a frozen frame.
    video.currentTime += (options.dtMs ?? 16) / 1000
    const frame = this.frame(options)
    this.loop(this.time, frame)
    frame.active = false
  }
}

// --- the browser around the provider -----------------------------------------------------------------------------------------

/** The camera stream's <video>: its clock is advanced by the test, once per frame, so the stream reads as live. */
export const video = {
  srcObject: null as unknown,
  playsInline: false,
  muted: false,
  readyState: 4,
  currentTime: 0,
  videoWidth: 4,
  videoHeight: 4,
  play: async (): Promise<void> => {},
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

export function canvasWithGl(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => glStandIn(),
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

/** Installs the browser globals the provider touches. Call once, before the first start(). */
export function installBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>
  g.document = {
    body: {},
    visibilityState: 'visible',
    addEventListener(): void {},
    createElement: () => video,
  }
  g.self = { requestAnimationFrame: () => 0, cancelAnimationFrame(): void {} }
  g.XRRigidTransform = FakeRigidTransform
  g.XRWebGLLayer = class {
    framebufferWidth = 640
    framebufferHeight = 480
    ignoreDepthValues = false
    getViewport(): object {
      return { x: 0, y: 0, width: 640, height: 480 }
    }
  }
  g.XRRay = class {
    origin: unknown
    direction: unknown
    constructor(origin: unknown, direction: unknown) {
      this.origin = origin
      this.direction = direction
    }
  }
  g.OffscreenCanvas = class {
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
}

/** What navigator.xr.requestSession was asked for, and the session it hands back. */
export const xr: { session: unknown; requests: Array<{ mode: string; options: Record<string, unknown> }> } = { session: null, requests: [] }

/** Points navigator at a runtime that hands out `session`, and a camera that works. Call before each start(). */
export function installNavigator(session: unknown): void {
  xr.session = session
  xr.requests.length = 0
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
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop(): void {} }] }) },
    },
  })
}
