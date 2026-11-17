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
 */
import * as THREE from 'three'
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'
import type { TrackingStatus } from './tracking-quality'
import { FIRST_POSE_TIMEOUT_MS, firstFrameVerdict, type PreflightVerdict } from './preflight.ts'
import { POSE_JUMP_THRESHOLD_M, poseDistance, usefulWorldPoint } from './point-filter.ts'
import {
  aspectFromProjection,
  base64ToBytes,
  decodeFloat32Base64,
  fovYDegFromProjection,
  isMatrix16,
  poseFromTransform,
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

export class NativeARProvider implements ARProvider {
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
  private poseJumps = 0
  private lastJumpM = 0
  private lastTranslation: Point3 | null = null
  /** The world map state the last native start reported. Null when no map was asked for. */
  private worldMapResult: 'loaded' | 'missing' | null = null

  constructor(options: NativeARProviderOptions = {}) {
    this.plugin = options.plugin !== undefined ? options.plugin : scanARPlugin()
    this.fallback = options.fallback ?? null
    this.decodeJpeg = options.decodeJpeg ?? decodeJpegToRgba
    this.makeRenderer = options.createRenderer ?? defaultRenderer
    this.scheduleFrame = options.schedule ?? ((callback) => requestAnimationFrame(() => callback()))
    this.cancelFrame = options.cancel ?? ((handle) => cancelAnimationFrame(handle as number))
    this.now = options.now ?? (() => performance.now())
    this.depth = options.depth ?? false
    this.worldMapName = options.worldMap ? options.worldMap : null
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
   * Whether the saved world map was found when the native session started: `loaded` when the session
   * relocalizes into it, `missing` when no map has that name. Null when none was asked for, or the native
   * session is not running.
   */
  worldMapState(): 'loaded' | 'missing' | null {
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
    if (!plugin.saveWorldMap) throw new Error('World maps are not available on this platform')
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
      const delegate = await this.fallback()
      this.delegate = delegate
      if (this.verdictCallback) delegate.onPreflightVerdict?.(this.verdictCallback)
      await delegate.start(canvas)
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
    const result = await plugin.start(
      this.worldMapName
        ? { depth: this.depth, hitGrid: HIT_GRID, worldMap: this.worldMapName }
        : { depth: this.depth, hitGrid: HIT_GRID },
    )
    this.worldMapResult = result.worldMap ?? null
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
    this.trackJump(pose.position)
    this.pose = pose
    this.transform = event.transform.slice()
    this.tracking = trackingStatusFromNative(event.tracking)
    if (isMatrix16(event.projection)) {
      this.projection = event.projection.slice()
      this.fovYDeg = fovYDegFromProjection(event.projection)
      this.aspect = aspectFromProjection(event.projection)
    }
    if (this.firstPoseAt === null) {
      this.firstPoseAt = this.now()
      this.emitVerdict()
    }
  }

  private trackJump(position: Point3): void {
    const previous = this.lastTranslation
    this.lastTranslation = { ...position }
    if (!previous) return
    const moved = poseDistance(position, previous)
    if (Number.isFinite(moved) && moved > POSE_JUMP_THRESHOLD_M) {
      this.poseJumps += 1
      this.lastJumpM = moved
    }
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
    this.tracking = trackingStatusFromNative(state)
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

  getTrackingDiagnostics(): { status: string; poseJumps: number; lastJumpM: number } {
    if (this.delegate?.getTrackingDiagnostics) return this.delegate.getTrackingDiagnostics()
    if (this.delegate) return { status: this.delegate.trackingStatus(), poseJumps: 0, lastJumpM: 0 }
    return { status: this.tracking, poseJumps: this.poseJumps, lastJumpM: this.lastJumpM }
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
      const pixels = await this.decodeJpeg(base64ToBytes(frame.jpegBase64), frame.width, frame.height)
      return {
        pixels,
        width: frame.width,
        height: frame.height,
        pose: poseFromTransform(frame.transform),
        timestamp: frame.timestamp,
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
}

/** A native AR provider. Pass `fallback` to keep the web runtimes as the way back when native cannot start. */
export function createNativeARProvider(options: NativeARProviderOptions = {}): NativeARProvider {
  return new NativeARProvider(options)
}
