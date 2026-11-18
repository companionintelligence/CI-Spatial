/**
 * The native AR provider: ARKit on iOS and ARCore on Android, driven through the ScanAR
 * Capacitor plugin. It sits beside the 8th Wall and WebXR providers as a third runtime and
 * implements the same ARProvider contract, so the scanner above it does not change.
 *
 * Division of labour:
 *   - The native layer runs the AR session and shows the camera in a view BEHIND the WebView,
 *     which is made transparent. It fits the whole camera image inside the WebView ("contain"),
 *     as the 8th Wall provider does, so a keyframe is the full, uncropped frame and its lens
 *     matches the overlay.
 *   - This provider draws the scanner's Three.js scene on the overlay canvas, from the native
 *     camera pose and projection, every frame.
 *   - Pose, points, and hit samples arrive as events. The synchronous ARProvider methods read
 *     the latest copy, as the 8th Wall provider reads its SLAM state.
 *
 * Fallback: when the native session cannot start, start() gives the same canvas to the
 * `fallback` provider (8th Wall, then WebXR), and every later call is forwarded to it.
 *
 * The optional members of ARProvider (src/ar/provider.ts) are what the alignment flows read, and a provider that omits one
 * says "no signal": the flow works without it. What this provider says, for each, while the native session runs, and after a
 * hand-over (every one of them is the web runtime's, as it is, or absent when the web runtime has none):
 *
 *   getFrameEpoch, onFrameDiscontinuity, getTrackingDiagnostics
 *       Frame epochs, from the one detector the web runtimes use (src/ar/frame-epoch.ts, FrameEpochTracker), fed the pose
 *       events and the one tracking state a pose cannot carry (no more poses are coming). The jump rule and its threshold are
 *       that file's, and nothing is repeated here. What it sees is what the plugin reports: a pose that steps by more than a
 *       hand can, tracking that is missing for RECOVERY_SUSPECT_MS and comes back, and, on iOS only, ARKit's own
 *       `limited.relocalizing`. ARCore reports no relocalization, so on Android a relocalization that does not pass through a
 *       long enough loss or a jump is not seen, and nothing stands in for the signal it does not give. The native layer sends
 *       no epoch of its own and no reset, and none is made up.
 *   scaleKind, scaleMode, scaleReady
 *       'metric', 'native-metric' and true: the unit is the metre on the platform SDKs' contract, which is adopted, not
 *       measured (ADR 0005 rule 5). ARCore documents its Pose translation in metres; the ARKit pages read for this name no unit.
 *   imagePointToHitTestPoint
 *       The point itself: the native layer fits the whole camera image in the overlay rect and takes a hit test in the rect's
 *       normalised coordinates, so an image point and a hit-test point are one point.
 *   hitTestBurstAsync
 *       Absent. A hit test over the bridge comes back with no frame to pair it with (its pose, status and time), so a native
 *       tap is read with one hit (`source: 'single-hit'`, scatter not measured).
 *   anchors
 *       Absent. This member is the runtime anchors of src/ar/anchors.ts (AnchorCapability, the WebXR Anchors Module's shape: any
 *       number of handles, moved and lost events, release), and neither plugin offers that. The iOS plugin has no anchor method.
 *       The Android plugin has one origin anchor, `setOriginAnchor()` and `getOriginAnchor()` (native-bridge.ts): a single ARCore
 *       anchor that a new placement replaces, read back on request, with no events. This provider does not call them, and they
 *       are not the capability this member would be.
 *
 * NONE OF THIS HAS RUN ON A DEVICE (ADR 0009): the plugin's behaviour is what native-bridge.ts documents and the two native
 * sources show, and tests/unit/node/wp-09b-native-provider.test.ts runs it against a fake plugin.
 */
import * as THREE from 'three'
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'
import type { AnchorCapability } from './anchors'
import type { TrackingStatus } from './tracking-quality'
import { FrameEpochTracker, type FrameDiscontinuity, type FrameDiscontinuityListener, type TrackingDiagnostics } from './frame-epoch.ts'
import { FIRST_POSE_TIMEOUT_MS, firstFrameVerdict, startFailureVerdict, type PreflightVerdict } from './preflight.ts'
import { poseDistance, usefulWorldPoint } from './point-filter.ts'
import { imagePointToViewportPoint, type ImageHitTestContract, type ViewSize } from '../spatial/resolver.ts'
import type { ScaleKind, ScaleMode } from '../world/scale-mode.ts'
import {
  aspectFromProjection,
  base64ToBytes,
  decodeFloat32Base64,
  fovYDegFromProjection,
  isMatrix16,
  poseFromTransform,
  trackingReasonFromNative,
  trackingStatusFromNative,
} from './native-codec.ts'
import {
  scanARPlugin,
  type NativeHitSample,
  type NativeHitsEvent,
  type NativeListenerHandle,
  type NativePointsEvent,
  type NativePoseEvent,
  type NativeRect,
  type NativeWorldMapSaved,
  type NativeWorldMapStart,
  type ScanARPlugin,
} from './native-bridge.ts'

/** Hit-test samples per side of the overlay rect. 20 gives a 5% grid, which is enough to place a decal. */
const HIT_GRID = 20
/** Feature points held between featurePoints() calls. Past this, new points are dropped. */
const POINT_BUFFER_LIMIT = 6000
/** Vertical field of view used until the first projection arrives: the same fallback 8th Wall uses. */
const DEFAULT_FOV_Y_DEG = 60
/** Class on <html> while the native camera shows through the page. */
const NATIVE_CLASS = 'native-ar'
const NATIVE_STYLE_ID = 'native-ar-style'

type Point3 = { x: number; y: number; z: number }

export type JpegDecoder = (jpeg: Uint8Array, width: number, height: number) => Promise<Uint8ClampedArray>

/** The part of a three.js renderer this provider uses. Injectable, so tests need no WebGL. */
export interface NativeRenderer {
  setPixelRatio(ratio: number): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  render(scene: THREE.Scene, camera: THREE.Camera): void
  dispose(): void
}

export interface NativeARProviderOptions {
  /** The plugin. Defaults to the shell's ScanAR plugin. null means there is no native layer. */
  plugin?: ScanARPlugin | null
  /** Builds the web runtime used when the native session cannot start. Omitted: a failed start rejects. */
  fallback?: () => Promise<ARProvider>
  /** Turns a JPEG into RGBA pixels at the frame's size. Defaults to createImageBitmap plus a canvas. */
  decodeJpeg?: JpegDecoder
  /** Builds the renderer on the overlay canvas. Defaults to a transparent THREE.WebGLRenderer. */
  createRenderer?: (canvas: HTMLCanvasElement) => NativeRenderer
  /** Requests the next frame and returns a handle to cancel it. Defaults to requestAnimationFrame. */
  schedule?: (callback: () => void) => unknown
  cancel?: (handle: unknown) => void
  /** Monotonic milliseconds. Defaults to performance.now(). */
  now?: () => number
  /** Ask the native layer for depth as well (LiDAR, or ARCore's depth API). Defaults to false. */
  depth?: boolean
  /**
   * A saved world map (iOS) to start from, so this session relocalizes into the coordinates of the scan that
   * saved it. A name with no saved map starts a fresh session, and worldMapState() reports `missing`.
   */
  worldMap?: string
}

function identityPose(): Pose {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

function clampCell(value: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.round(value)))
}

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  ;(handle as { unref?: () => void }).unref?.()
}

function devicePixelRatioOrOne(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
}

/** Places the overlay canvas over the native camera rect, in CSS pixels, with a transparent background. */
function placeCanvas(canvas: HTMLCanvasElement, rect: NativeRect): void {
  const style = canvas.style
  style.position = 'fixed'
  style.left = `${rect.x}px`
  style.top = `${rect.y}px`
  style.width = `${rect.width}px`
  style.height = `${rect.height}px`
  style.background = 'transparent'
}

/** Lets the native camera show through the page while the native session runs. */
function enterTransparentPage(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.add(NATIVE_CLASS)
  if (document.getElementById(NATIVE_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = NATIVE_STYLE_ID
  style.textContent = `html.${NATIVE_CLASS}, html.${NATIVE_CLASS} body { background: transparent !important; }`
  document.head.appendChild(style)
}

function leaveTransparentPage(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.remove(NATIVE_CLASS)
}

/** A native frame time (seconds on the native layer's clock) as the tracker's milliseconds, or null for an event that carries none. */
function frameClockMs(timestamp: unknown): number | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp * 1000 : null
}

/** What `startFailureVerdict()` says of a refused camera, which is the one failure here that a person can do something about. */
const CAMERA_REFUSED = new Error('camera permission denied')

/** Whether the page would tell the person their camera is refused for this failure (`startFailureVerdict`, src/ar/preflight.ts). */
function refusedCamera(failure: unknown): boolean {
  return startFailureVerdict(failure).headline === startFailureVerdict(CAMERA_REFUSED).headline
}

/**
 * The failure the page is handed when the native session cannot start and the web runtime that took over cannot either (the page
 * classifies it with startFailureVerdict, and the web runtimes in a WebView mostly say "WebXR not supported", which is true and
 * is not why the person is stuck). The native runtime's failure is the one the shell is built around, so it is reported, unless
 * the web runtime was refused the camera and the native session was not: a refused camera is what the person can fix, so it is
 * never hidden behind the other. The failure not reported is the new error's `cause`, and the page's log has both.
 */
function reportedStartFailure(native: unknown, web: unknown): Error {
  const chosen = refusedCamera(web) && !refusedCamera(native) ? web : native
  const other = chosen === native ? web : native
  const error = new Error(chosen instanceof Error ? chosen.message : String(chosen), { cause: other })
  if (chosen instanceof Error) error.name = chosen.name
  return error
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** The default JPEG decoder: a browser image decode, read back as RGBA. */
async function decodeJpegToRgba(jpeg: Uint8Array, width: number, height: number): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(new Blob([jpeg as unknown as BlobPart], { type: 'image/jpeg' }))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D canvas is unavailable, so the frame cannot be decoded')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height).data
  } finally {
    bitmap.close()
  }
}

function defaultRenderer(canvas: HTMLCanvasElement): NativeRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setClearColor(0x000000, 0)
  return renderer
}

/** The longest world map name the native side accepts: the limit ScanARPlugin.swift applies to a file name. */
export const WORLD_MAP_NAME_MAX = 64
const WORLD_MAP_NAME = /^[A-Za-z0-9_-]+$/

/**
 * The world map name for a Place, or undefined when the Place has none. The default world is shared by every scan
 * made without a Place, so it never gets a map: it would mix unrelated rooms. A name the native side could not use
 * as a file name is dropped here, so it can never fail a native start.
 */
export function worldMapNameFor(world: string | null | undefined): string | undefined {
  if (!world || world === 'default') return undefined
  if (world.length > WORLD_MAP_NAME_MAX || !WORLD_MAP_NAME.test(world)) return undefined
  return world
}

/** The Place named in the page address (?world=), as a world map name. Undefined outside a browser. */
function worldMapNameFromPage(): string | undefined {
  if (typeof location === 'undefined') return undefined
  return worldMapNameFor(new URLSearchParams(location.search).get('world'))
}

/** What a requested world map came to: the native start's state, or 'unsupported' where the platform keeps none. */
export type WorldMapState = NativeWorldMapStart | 'unsupported'

/** A listener of discontinuities, and where it is subscribed: to this provider's own tracker, and to the web runtime once one has taken over. */
interface DiscontinuitySubscription {
  listener: FrameDiscontinuityListener
  offNative: () => void
  offWeb: (() => void) | null
}

export class NativeARProvider implements ARProvider, ImageHitTestContract {
  private readonly plugin: ScanARPlugin | null
  private readonly fallback: (() => Promise<ARProvider>) | null
  private readonly decodeJpeg: JpegDecoder
  private readonly makeRenderer: (canvas: HTMLCanvasElement) => NativeRenderer
  private readonly scheduleFrame: (callback: () => void) => unknown
  private readonly cancelFrame: (handle: unknown) => void
  private readonly now: () => number
  private readonly depth: boolean
  private readonly worldMapName: string | null

  /** Set once the native session has failed and the web runtime has taken over. */
  private delegate: ARProvider | null = null
  /** Why the native session did not start, when it fell back. */
  private failure: string | null = null
  private verdictCallback: ((verdict: PreflightVerdict) => void) | null = null
  private verdictTimer: ReturnType<typeof setTimeout> | null = null
  private handles: NativeListenerHandle[] = []
  private nativeRunning = false
  private startedAt: number | null = null
  private renderer: NativeRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private frameHandle: unknown = null
  private captureInFlight = false
  private firstPoseAt: number | null = null
  private pose: Pose = identityPose()
  private transform: number[] | null = null
  private projection: number[] | null = null
  private tracking: TrackingStatus = 'UNKNOWN'
  private fovYDeg = DEFAULT_FOV_Y_DEG
  private aspect = 1
  private pendingPoints: Point3[] = []
  private hitGrid: { cols: number; rows: number; samples: NativeHitSample[] } | null = null
  /**
   * Frame epochs of the native session: the same detector the web runtimes use, fed here and nowhere else. Held-back events are
   * told to listeners once a pose has been read to the end (`flush()`), so a listener that asks the provider finds its epoch, its
   * pose and the points it has not been handed all of one frame.
   */
  private readonly epochs = new FrameEpochTracker({}, { deferNotify: true })
  /** The native frame time, in milliseconds, of the last pose the tracker was given. Null before one, and after the session ends. */
  private lastFrameMs: number | null = null
  private warnedNoFrameTime = false
  /** The last tracking line written to the console, so a status is logged when it changes and not at every pose. */
  private loggedTracking: string | null = null
  private readonly subscriptions = new Set<DiscontinuitySubscription>()
  /** The world map state the last native start reported. Null when no map was asked for. */
  /** Whether the platform keeps world maps, from the plugin's capabilities. False until the native session starts. */
  private worldMapSupported = false
  private worldMapResult: WorldMapState | null = null

  constructor(options: NativeARProviderOptions = {}) {
    this.plugin = options.plugin !== undefined ? options.plugin : scanARPlugin()
    this.fallback = options.fallback ?? null
    this.decodeJpeg = options.decodeJpeg ?? decodeJpegToRgba
    this.makeRenderer = options.createRenderer ?? defaultRenderer
    this.scheduleFrame = options.schedule ?? ((callback) => requestAnimationFrame(() => callback()))
    this.cancelFrame = options.cancel ?? ((handle) => cancelAnimationFrame(handle as number))
    this.now = options.now ?? (() => performance.now())
    this.depth = options.depth ?? false
    this.worldMapName = options.worldMap !== undefined
      ? (worldMapNameFor(options.worldMap) ?? null)
      : (worldMapNameFromPage() ?? null)
  }

  /** Why the native session did not start and the web runtime took over. Null while native is running. */
  nativeFailure(): string | null {
    return this.failure
  }

  /** `native` while the ARKit / ARCore session runs, `fallback` once the web runtime has taken over. */
  activeRuntime(): 'native' | 'fallback' | 'idle' {
    if (this.delegate) return 'fallback'
    return this.nativeRunning ? 'native' : 'idle'
  }

  /**
   * The web runtime (8th Wall or WebXR) that took over after the native session failed to start, or null while the native session
   * runs. For a screen or a log that has to say which runtime the numbers come from: every call the scanner makes is forwarded to
   * it already.
   */
  webRuntime(): ARProvider | null {
    return this.delegate
  }

  /**
   * What the saved world map came to when the native session started: `loaded` (the session starts from it and
   * relocalizes into its coordinates), `missing` (no map has that name), `unreadable` (a file exists but does not
   * decode), or `unsupported` (this platform keeps no world maps). Null when no map was asked for, or the native
   * session is not running.
   */
  worldMapState(): WorldMapState | null {
    if (this.delegate) return null
    return this.nativeRunning ? this.worldMapResult : null
  }

  /**
   * Saves the native session's world map under `name`, so a later session with that name relocalizes into
   * this room's coordinates. The map stays on the phone. Rejects when the native session is not running, and
   * on platforms without world maps.
   */
  async saveWorldMap(name: string): Promise<NativeWorldMapSaved> {
    if (this.delegate) throw new Error('World maps need the native AR session, which is not running')
    const plugin = this.plugin
    if (!plugin || !this.nativeRunning) throw new Error('Native AR is not running')
    if (!this.worldMapSupported || !plugin.saveWorldMap) throw new Error('World maps are not available on this platform')
    return plugin.saveWorldMap({ name })
  }

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (this.delegate) {
      await this.delegate.start(canvas)
      return
    }
    try {
      await this.startNative(canvas)
    } catch (err) {
      await this.teardownNative()
      if (!this.fallback) throw err
      this.failure = err instanceof Error ? err.message : String(err)
      console.warn('[native-ar] the native session did not start; using the web runtime:', this.failure)
      try {
        const delegate = await this.fallback()
        this.delegate = delegate
        if (this.verdictCallback) delegate.onPreflightVerdict?.(this.verdictCallback)
        // Listeners were attached before this start, as src/main.ts attaches the epoch log and the re-anchor flow; the web runtime
        // is the one whose frames they have to hear now.
        for (const subscription of this.subscriptions) this.subscribeToWeb(subscription)
        await delegate.start(canvas)
      } catch (webFailure) {
        console.warn('[native-ar] the web runtime did not start either:', webFailure instanceof Error ? webFailure.message : String(webFailure))
        throw reportedStartFailure(err, webFailure)
      }
    }
  }

  private async startNative(canvas: HTMLCanvasElement): Promise<void> {
    const plugin = this.plugin
    if (!plugin) throw new Error('the ScanAR plugin is not available in this build')
    // Listen before starting, so the first pose cannot be lost in between.
    this.handles = await Promise.all([
      plugin.addListener('pose', (e) => this.onPose(e)),
      plugin.addListener('points', (e) => this.onPoints(e)),
      plugin.addListener('hits', (e) => this.onHits(e)),
      plugin.addListener('tracking', (e) => this.onTracking(e.state)),
      plugin.addListener('error', (e) => console.warn('[native-ar]', e.message)),
    ])
    // Only a platform that keeps world maps is asked for one. Android would ignore the name, and a null result would
    // then read as "none was asked for", so 'unsupported' says what happened instead.
    const capabilities = await plugin.capabilities().catch(() => null)
    this.worldMapSupported = capabilities?.worldMap === true
    const sendMap = this.worldMapName !== null && this.worldMapSupported
    const result = await plugin.start(
      sendMap
        ? { depth: this.depth, hitGrid: HIT_GRID, worldMap: this.worldMapName ?? undefined }
        : { depth: this.depth, hitGrid: HIT_GRID },
    )
    if (this.worldMapName === null) this.worldMapResult = null
    else if (!this.worldMapSupported) this.worldMapResult = 'unsupported'
    else this.worldMapResult = result.worldMap ?? null
    this.nativeRunning = true
    this.startedAt = this.now()
    const rectAspect = result.rect.height > 0 ? result.rect.width / result.rect.height : 1
    this.aspect = result.cameraAspect > 0 ? result.cameraAspect : rectAspect
    placeCanvas(canvas, result.rect)
    this.renderer = this.makeRenderer(canvas)
    this.renderer.setPixelRatio(devicePixelRatioOrOne())
    this.renderer.setSize(result.rect.width, result.rect.height, false)
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera()
    this.camera.matrixAutoUpdate = false
    enterTransparentPage()
    this.scheduleNextFrame()
    this.armVerdict()
  }

  stop(): void {
    if (this.delegate) {
      this.delegate.stop()
      return
    }
    void this.teardownNative()
  }

  private async teardownNative(): Promise<void> {
    if (this.verdictTimer !== null) {
      clearTimeout(this.verdictTimer)
      this.verdictTimer = null
    }
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle)
      this.frameHandle = null
    }
    const handles = this.handles
    this.handles = []
    await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)))
    if (this.nativeRunning && this.plugin) await this.plugin.stop().catch(() => undefined)
    this.nativeRunning = false
    this.worldMapResult = null
    // A later start is a new map: its first trustworthy frame begins a new epoch instead of being compared with this session's.
    this.epochs.noteSessionEnd()
    this.lastFrameMs = null
    this.warnedNoFrameTime = false
    this.loggedTracking = null
    this.renderer?.dispose()
    this.renderer = null
    this.scene = null
    this.camera = null
    leaveTransparentPage()
  }

  private scheduleNextFrame(): void {
    this.frameHandle = this.scheduleFrame(() => this.renderFrame())
  }

  private renderFrame(): void {
    this.frameHandle = null
    if (!this.nativeRunning || !this.renderer || !this.scene || !this.camera) return
    if (this.transform && this.projection) {
      this.camera.matrixWorld.fromArray(this.transform)
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()
      this.camera.projectionMatrix.fromArray(this.projection)
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
      this.renderer.render(this.scene, this.camera)
    }
    this.scheduleNextFrame()
  }

  // ── Native events ─────────────────────────────────────────────────────────

  private onPose(event: NativePoseEvent): void {
    if (!this.nativeRunning) return
    if (!isMatrix16(event.transform)) {
      console.warn('[native-ar] dropped a pose event with a malformed transform')
      return
    }
    const pose = poseFromTransform(event.transform)
    const status = trackingStatusFromNative(event.tracking)
    const reason = trackingReasonFromNative(event.tracking)
    this.logTracking(status, reason)
    try {
      this.watchFrame(event.timestamp, pose, status, reason)
      this.pose = pose
      this.transform = event.transform.slice()
      this.tracking = status
      if (isMatrix16(event.projection)) {
        this.projection = event.projection.slice()
        this.fovYDeg = fovYDegFromProjection(event.projection)
        this.aspect = aspectFromProjection(event.projection)
      }
      if (this.firstPoseAt === null) {
        this.firstPoseAt = this.now()
        this.emitVerdict()
      }
    } finally {
      this.epochs.flush()
    }
  }

  /**
   * Gives the frame to the epoch tracker, before the pose cache is overwritten, as the web providers do. The clock is the native
   * frame time and not the page's: events can be held back by the bridge (the WebView is paused with the app), and a pause is as
   * long as the frame times either side of it say, not as the time the page took to hear. A pose with no frame time cannot be
   * watched, and the page says so once instead of going without.
   */
  private watchFrame(timestamp: unknown, pose: Pose, status: TrackingStatus, reason: string | undefined): void {
    const tMs = frameClockMs(timestamp)
    if (tMs === null) {
      if (!this.warnedNoFrameTime) {
        this.warnedNoFrameTime = true
        console.warn('[native-ar] pose events carry no frame time, so frame shifts cannot be watched in this session')
      }
      return
    }
    // The same frame again, or a clock that went back, is not a new observation, and the tracker must not be fed one (see `observe`).
    if (this.lastFrameMs !== null && tMs <= this.lastFrameMs) return
    this.lastFrameMs = tMs
    const shift = this.epochs.observe({ tMs, pose, status, reason })
    if (shift) this.noteFrameShift(shift)
  }

  /**
   * The status and reason are written to the console on every change, and each discontinuity as it begins, in the form the web
   * providers use (`[8thwall] trackingStatus:`, `[webxr] frame discontinuity`): a device run reads them from there over the
   * ?debug=remote relay, and it is what sizes the thresholds in ./frame-epoch.ts (device experiment DX4).
   */
  private logTracking(status: TrackingStatus, reason: string | undefined): void {
    const line = reason && reason !== status ? `${status} (${reason})` : status
    if (line === this.loggedTracking) return
    this.loggedTracking = line
    console.log('[native-ar] trackingStatus:', line)
  }

  /**
   * A discontinuity began a new epoch. What was gathered from the frame before it is not handed over in the new one: the points
   * not yet drained and the hit grid were read in the old frame, and a drain or a hit test stamps whatever epoch is current. The
   * frame that carried the discontinuity is read after this, in the new epoch.
   */
  private noteFrameShift(shift: FrameDiscontinuity): void {
    this.pendingPoints = []
    this.hitGrid = null
    console.warn(`[native-ar] frame discontinuity ${shift.epoch}: ${shift.cause}`, JSON.stringify(shift))
  }

  /**
   * The epoch the frame captured at native time `tMs` was recorded in: the epoch of the last discontinuity at or before it. A frame
   * the provider has not seen the end of (newer than every pose it has been given) is in the epoch it is in.
   */
  private epochAt(tMs: number | null): number {
    if (tMs === null) return this.epochs.epoch
    const log = this.epochs.log
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.atMs <= tMs) return log[i]!.epoch
    }
    return log.length > 0 ? log[0]!.epoch - 1 : this.epochs.epoch
  }

  private onPoints(event: NativePointsEvent): void {
    if (!this.nativeRunning || !Array.isArray(event.points)) return
    for (let i = 0; i + 2 < event.points.length; i += 3) {
      if (this.pendingPoints.length >= POINT_BUFFER_LIMIT) break
      const p = { x: event.points[i], y: event.points[i + 1], z: event.points[i + 2] }
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) this.pendingPoints.push(p)
    }
  }

  private onHits(event: NativeHitsEvent): void {
    if (!this.nativeRunning) return
    const { cols, rows, samples } = event
    if (!(cols > 0 && rows > 0) || !Array.isArray(samples) || samples.length !== cols * rows) return
    this.hitGrid = { cols, rows, samples }
  }

  private onTracking(state: string): void {
    const status = trackingStatusFromNative(state)
    this.tracking = status
    this.logTracking(status, trackingReasonFromNative(state))
    // The one state a pose cannot carry: no more poses are coming (ARKit interrupted, ARCore paused with the app). Every other
    // state arrives inside the next pose, whose frame time dates it. This event has no frame time, so it is dated by the last pose:
    // the loss began no earlier than that, and how long it lasted is read from the frame times either side, not from when the
    // page happened to hear of it (a page that was paused too hears it late).
    if (status !== 'NOT_AVAILABLE' || this.lastFrameMs === null) return
    try {
      this.epochs.observe({ tMs: this.lastFrameMs, pose: null, status })
    } finally {
      this.epochs.flush()
    }
  }

  // ── Preflight ─────────────────────────────────────────────────────────────

  onPreflightVerdict(callback: (verdict: PreflightVerdict) => void): void {
    this.verdictCallback = callback
    this.delegate?.onPreflightVerdict?.(callback)
  }

  private armVerdict(): void {
    this.emitVerdict()
    const timer = setTimeout(() => {
      this.verdictTimer = null
      this.emitVerdict()
    }, FIRST_POSE_TIMEOUT_MS)
    unrefTimer(timer)
    this.verdictTimer = timer
  }

  private emitVerdict(): void {
    if (!this.verdictCallback) return
    this.verdictCallback(firstFrameVerdict({
      sawCameraFrame: this.nativeRunning,
      sawPose: this.firstPoseAt !== null,
      elapsedMs: this.startedAt === null ? 0 : this.now() - this.startedAt,
    }))
  }

  // ── ARProvider ────────────────────────────────────────────────────────────

  getScene(): THREE.Scene | null {
    if (this.delegate) return this.delegate.getScene?.() ?? null
    return this.scene
  }

  getTrackingDiagnostics(): TrackingDiagnostics {
    if (this.delegate?.getTrackingDiagnostics) return this.delegate.getTrackingDiagnostics()
    if (this.delegate) return { status: this.delegate.trackingStatus(), poseJumps: 0, lastJumpM: 0 }
    // The status is the one trackingStatus() answers, which a tracking event updates between two poses.
    return { ...this.epochs.diagnostics(), status: this.tracking }
  }

  async captureFrame(timeoutMs = 4000): Promise<RawFrame> {
    if (this.delegate) return this.delegate.captureFrame(timeoutMs)
    if (!this.plugin || !this.nativeRunning) throw new Error('Native AR is not running')
    if (this.captureInFlight) throw new Error('Capture already pending')
    this.captureInFlight = true
    try {
      const frame = await withTimeout(
        this.plugin.captureFrame({ depth: false }),
        timeoutMs,
        'Timed out waiting for camera frame',
      )
      // The epoch the frame was captured in, read before the decode, which can take a while: a discontinuity in between must not
      // label a frame of the old coordinate frame with the new one (RawFrame.epoch).
      const epoch = this.epochAt(frameClockMs(frame.timestamp))
      const pixels = await this.decodeJpeg(base64ToBytes(frame.jpegBase64), frame.width, frame.height)
      return {
        pixels,
        width: frame.width,
        height: frame.height,
        pose: poseFromTransform(frame.transform),
        timestamp: frame.timestamp,
        epoch,
      }
    } finally {
      this.captureInFlight = false
    }
  }

  /**
   * The LiDAR or ARCore depth map for the current frame, in metres, or null when the device
   * cannot give one. Not part of ARProvider: only the native runtime has depth.
   */
  async captureDepth(): Promise<{ width: number; height: number; meters: Float32Array } | null> {
    if (this.delegate || !this.plugin || !this.nativeRunning) return null
    const frame = await this.plugin.captureFrame({ depth: true })
    if (!frame.depth) return null
    const { width, height } = frame.depth
    return { width, height, meters: decodeFloat32Base64(frame.depth.metersBase64, width * height) }
  }

  /**
   * A hit from the latest grid of samples, nearest to the point. The grid is refreshed by the
   * native layer a few times a second, so this answers without a round trip. Callers that need
   * the exact point use hitTestAsync().
   */
  hitTest(x: number, y: number): HitResult | null {
    if (this.delegate) return this.delegate.hitTest(x, y)
    const grid = this.hitGrid
    if (!grid || !Number.isFinite(x) || !Number.isFinite(y)) return null
    const col = clampCell(x * grid.cols - 0.5, grid.cols)
    const row = clampCell(y * grid.rows - 0.5, grid.rows)
    // The nearest sample can miss a surface its neighbour hits, so look one cell out.
    let best: HitResult | null = null
    let bestDistance = Infinity
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) continue
        const hit = this.sampleToHit(grid.samples[r * grid.cols + c])
        if (!hit) continue
        const distance = Math.hypot((c + 0.5) / grid.cols - x, (r + 0.5) / grid.rows - y)
        if (distance < bestDistance) {
          best = hit
          bestDistance = distance
        }
      }
    }
    return best
  }

  /** An exact hit test at normalised coordinates of the overlay rect, asked of the native session. */
  async hitTestAsync(x: number, y: number): Promise<HitResult | null> {
    if (this.delegate) {
      return this.delegate.hitTestAsync ? this.delegate.hitTestAsync(x, y) : this.delegate.hitTest(x, y)
    }
    if (!this.plugin || !this.nativeRunning) return null
    return this.sampleToHit(await this.plugin.hitTest({ x, y }))
  }

  private sampleToHit(sample: NativeHitSample | undefined): HitResult | null {
    if (!sample || !sample.hit || !Array.isArray(sample.position) || sample.position.length !== 3) return null
    const [x, y, z] = sample.position
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    const position = { x, y, z }
    const q = sample.rotation
    const rotation = Array.isArray(q) && q.length === 4
      ? { x: q[0], y: q[1], z: q[2], w: q[3] }
      : { x: 0, y: 0, z: 0, w: 1 }
    const reported = sample.distance
    const distance = typeof reported === 'number' && reported > 0 ? reported : poseDistance(position, this.pose.position)
    return { position, rotation, distance }
  }

  /** Feature points gathered since the last call, kept inside the 8th Wall distance band. Each point is returned once. */
  featurePoints(): Array<{ x: number; y: number; z: number }> {
    if (this.delegate) return this.delegate.featurePoints()
    if (!this.nativeRunning || this.pendingPoints.length === 0) return []
    const points = this.pendingPoints
    this.pendingPoints = []
    return points.filter((p) => usefulWorldPoint(p, this.pose))
  }

  getPose(): Pose {
    if (this.delegate) return this.delegate.getPose()
    return { position: { ...this.pose.position }, rotation: { ...this.pose.rotation } }
  }

  isTracking(): boolean {
    if (this.delegate) return this.delegate.isTracking()
    return this.firstPoseAt !== null
  }

  trackingStatus(): TrackingStatus {
    if (this.delegate) return this.delegate.trackingStatus()
    return this.tracking
  }

  getCameraFovY(): number {
    if (this.delegate) return this.delegate.getCameraFovY()
    return this.fovYDeg
  }

  getCameraAspect(): number {
    if (this.delegate) return this.delegate.getCameraAspect()
    return this.aspect
  }

  // ── The optional members the alignment flows read ─────────────────────────────────────────────────
  //
  // Where a web runtime has taken over, each of these is that runtime's, and a member it does not have reads as absent here too:
  // the flows decide by presence (calibrationEpochField, calibrationTapSampler, stampScale), and a wrapper that answered for a
  // runtime that does not would claim an epoch, a unit or a burst nothing measured. That is why they are accessors that give the
  // function, or undefined, and not methods that always answer. The function is bound to the runtime, so a caller that keeps it
  // keeps the right `this`. The page reads them after start() except the discontinuity listeners, which it attaches before.

  /**
   * Calls `listener` at each discontinuity: the native session's while it runs, and the web runtime's once one has taken over,
   * whichever was the case when the listener was attached. The returned function ends the subscription in both.
   */
  onFrameDiscontinuity(listener: FrameDiscontinuityListener): () => void {
    const subscription: DiscontinuitySubscription = { listener, offNative: this.epochs.subscribe(listener), offWeb: null }
    this.subscriptions.add(subscription)
    this.subscribeToWeb(subscription)
    return () => {
      this.subscriptions.delete(subscription)
      subscription.offNative()
      subscription.offWeb?.()
      subscription.offWeb = null
    }
  }

  private subscribeToWeb(subscription: DiscontinuitySubscription): void {
    if (this.delegate && !subscription.offWeb) subscription.offWeb = this.delegate.onFrameDiscontinuity?.(subscription.listener) ?? null
  }

  /** The epoch the runtime is in: the native session's own tracker's, or the web runtime's. Absent when the web runtime keeps none. */
  get getFrameEpoch(): ARProvider['getFrameEpoch'] {
    const web = this.delegate
    if (!web) return () => this.epochs.epoch
    const forwarded = web.getFrameEpoch
    return forwarded ? () => forwarded.call(web) : undefined
  }

  /**
   * Absent while the native session runs: a hit test over the bridge answers with no frame to pair it with (its pose, its status,
   * its time), so there is nothing a burst could say of each frame, and a native tap is read with one hit, as `sampleTap()` does
   * for a provider without a burst (`TapSample.source` says `single-hit` and its scatter is null). The web runtime's, after a hand-over.
   *
   * `calibrationTapSampler()` decides whether to tell a person to hold still when the page builds it, before the session starts,
   * and there is no burst then, so it never does here. After a hand-over to a runtime that has a burst the burst runs, and the
   * person is still not told to hold still: the tap is refused for scatter if the phone moved, which says so.
   */
  get hitTestBurstAsync(): ARProvider['hitTestBurstAsync'] {
    const web = this.delegate
    const forwarded = web?.hitTestBurstAsync
    return forwarded ? forwarded.bind(web) : undefined
  }

  /**
   * `'metric'` while the native session runs, on the platform SDKs' contract: ARCore documents its `Pose` translation in metres
   * (https://developers.google.com/ar/reference/java/com/google/ar/core/Pose), and the ARKit pages read for this
   * (`ARCamera.transform`, `ARPlaneAnchor.extent`) name no unit, so the iOS half rests on the same contract and is adopted, not
   * measured (ADR 0005 rule 5). The web runtime's after a hand-over, which for 8th Wall in its default scale is `'arbitrary'`: a
   * scan made there is not stamped metric because the shell is native.
   */
  get scaleKind(): ARProvider['scaleKind'] {
    const web = this.delegate
    if (!web) return (): ScaleKind => 'metric'
    const forwarded = web.scaleKind
    return forwarded ? (since) => forwarded.call(web, since) : undefined
  }

  /** True while the native session runs: there is no estimate to wait for. The web runtime's after a hand-over. */
  get scaleReady(): ARProvider['scaleReady'] {
    const web = this.delegate
    if (!web) return () => true
    const forwarded = web.scaleReady
    return forwarded ? () => forwarded.call(web) : undefined
  }

  /** `'native-metric'` while the native session runs (src/world/scale-mode.ts). The web runtime's after a hand-over. */
  get scaleMode(): ARProvider['scaleMode'] {
    const web = this.delegate
    if (!web) return (): ScaleMode => 'native-metric'
    const forwarded = web.scaleMode
    return forwarded ? (since) => forwarded.call(web, since) : undefined
  }

  /** Runtime anchors: the web runtime's when it has them (WebXR, where the browser grants the feature), otherwise none. */
  get anchors(): AnchorCapability | undefined {
    return this.delegate?.anchors
  }

  /**
   * Where a point on the captured camera frame is, in the coordinates `hitTestAsync()` takes. The native layer shows the whole
   * camera image in the overlay rect and takes a hit test in that rect's normalised coordinates, and the captured frame is the
   * whole image, so the point is its own: no crop, whatever window surrounds the rect. After a hand-over it is the web runtime's
   * own mapping, or, for one with none, the window cover-crop the resolver gives any provider.
   */
  imagePointToHitTestPoint(
    x: number,
    y: number,
    imageSize: ViewSize | undefined,
    viewportSize: ViewSize | undefined,
  ): { x: number; y: number } {
    const web = this.delegate as (ARProvider & Partial<ImageHitTestContract>) | null
    if (!web) return { x, y }
    return typeof web.imagePointToHitTestPoint === 'function'
      ? web.imagePointToHitTestPoint(x, y, imageSize, viewportSize)
      : imagePointToViewportPoint(x, y, imageSize, viewportSize)
  }
}

/** A native AR provider. Pass `fallback` to keep the web runtimes as the way back when native cannot start. */
export function createNativeARProvider(options: NativeARProviderOptions = {}): NativeARProvider {
  return new NativeARProvider(options)
}
