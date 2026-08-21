/**
 * 8th Wall OSS engine provider.
 *
 * Prerequisites:
 *   1. Download the engine binary from https://8th.io/xrjs
 *   2. Unzip and place xr.js (and any chunks) into public/
 *   3. index.html must load it:
 *        <script async src="/xr.js" data-preload-chunks="slam"></script>
 *
 * The XR8 global is populated by the script above.  We listen for the
 * 'xrloaded' event before calling start().
 */
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'

type Point3 = { x: number; y: number; z: number }

const MIN_POINT_DISTANCE_M = 0.08
const MAX_POINT_DISTANCE_M = 50

// XR8 is a global injected by xr.js — we declare it to satisfy TypeScript
declare const XR8: {
  addCameraPipelineModule(mod: object): void
  addCameraPipelineModules(mods: object[]): void
  run(opts: { canvas: HTMLCanvasElement; allowedDevices: unknown }): void
  stop(): void
  loadChunk(name: string): Promise<void>
  GlTextureRenderer: { pipelineModule(): object }
  XrController: {
    pipelineModule(): object
    hitTest(
      x: number,
      y: number,
      types: string[],
    ): Array<{
      type: string
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
      distance: number
    }>
  }
  CameraPixelArray: {
    pipelineModule(opts: { luminance: boolean }): object
  }
  XrConfig: { device(): { ANY: unknown } }
}

function finitePoint(p: Point3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function poseDistance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function usefulWorldPoint(p: Point3, pose: Pose): boolean {
  if (!finitePoint(p)) return false
  const dist = poseDistance(p, pose.position)
  return dist >= MIN_POINT_DISTANCE_M && dist <= MAX_POINT_DISTANCE_M
}

function appendPointValue(value: unknown, out: Point3[]): void {
  if (!value) return
  if (Array.isArray(value)) {
    if (value.length >= 3 && value.every((n) => typeof n === 'number')) {
      for (let i = 0; i + 2 < value.length; i += 3) {
        out.push({ x: value[i], y: value[i + 1], z: value[i + 2] })
      }
    } else {
      for (const item of value) appendPointValue(item, out)
    }
    return
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const flat = value as unknown as ArrayLike<number>
    for (let i = 0; i + 2 < flat.length; i += 3) {
      out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] })
    }
    return
  }

  if (typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  const positioned = obj['position'] ?? obj['worldPosition'] ?? obj['point'] ?? obj['coords']
  if (positioned) {
    appendPointValue(positioned, out)
    return
  }

  if (typeof obj['x'] === 'number' && typeof obj['y'] === 'number' && typeof obj['z'] === 'number') {
    out.push({ x: obj['x'], y: obj['y'], z: obj['z'] })
    return
  }

  for (const key of ['points', 'positions', 'worldPoints', 'data']) {
    if (obj[key]) appendPointValue(obj[key], out)
  }
}

function extractPointBatch(source: unknown, pose: Pose): Point3[] {
  const raw: Point3[] = []
  appendPointValue(source, raw)
  return raw.filter((p) => usefulWorldPoint(p, pose))
}

function pointFromUnknown(value: unknown): Point3 | null {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number'
      ? { x, y, z }
      : null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  return typeof obj['x'] === 'number' && typeof obj['y'] === 'number' && typeof obj['z'] === 'number'
    ? { x: obj['x'], y: obj['y'], z: obj['z'] }
    : null
}

function rotationFromUnknown(value: unknown): Pose['rotation'] | null {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, z, w] = value
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && typeof w === 'number'
      ? { x, y, z, w }
      : null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  return typeof obj['x'] === 'number'
    && typeof obj['y'] === 'number'
    && typeof obj['z'] === 'number'
    && typeof obj['w'] === 'number'
    ? { x: obj['x'], y: obj['y'], z: obj['z'], w: obj['w'] }
    : null
}

function poseFromReality(reality: Record<string, unknown>): Pose | null {
  const position = pointFromUnknown(reality['position'] ?? reality['pos'] ?? reality['cameraPosition'])
  const rotation = rotationFromUnknown(reality['rotation'] ?? reality['rot'] ?? reality['cameraRotation'])
  return position && rotation ? { position, rotation } : null
}

function findRealityObject(source: unknown, depth = 0): Record<string, unknown> | null {
  if (!source || typeof source !== 'object' || depth > 3) return null
  const obj = source as Record<string, unknown>
  if (poseFromReality(obj)) return obj

  for (const key of ['reality', 'xrController', 'xrcontroller', 'camera', 'slam']) {
    const nested = findRealityObject(obj[key], depth + 1)
    if (nested) return nested
  }
  return null
}

export class EighthWallProvider implements ARProvider {
  private captureQueue: Array<{
    resolve: (frame: RawFrame) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }> = []
  private latestPose: Pose = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }
  private _slamReady = false
  private _latestWorldPoints: Array<{ x: number; y: number; z: number }> = []
  private _lastTrackingStatus = ''
  private _diagLogged = false
  /** Camera vertical field-of-view in degrees (from intrinsics, else 60° default) */
  private _fovY = 60
  /** Viewport aspect ratio at XR8.run() time */
  private _aspect = 9 / 16

  private _syncReality(source: unknown, label: string, canvas: HTMLCanvasElement): void {
    const reality = findRealityObject(source)
    if (!reality) return

    if (!this._diagLogged) {
      this._diagLogged = true
      console.log(`[8thwall] ${label} reality keys:`, JSON.stringify(Object.keys(reality)))
    }

    const pose = poseFromReality(reality)
    if (!pose) return

    this.latestPose = pose

    const status = (reality['trackingStatus'] as string | undefined) ?? 'UNKNOWN'
    if (status !== this._lastTrackingStatus) {
      console.log('[8thwall] trackingStatus:', status)
      this._lastTrackingStatus = status
    }

    if (!this._slamReady) {
      console.log(`[8thwall] SLAM ready — first pose received via ${label}`)
      this._slamReady = true
    }

    // Camera intrinsics → vertical FOV
    const intr = reality['intrinsics'] as Record<string, unknown> | null | undefined
    if (intr) {
      const fy = (intr['fy'] as number | undefined)
        ?? (intr['focalLength'] as Record<string, number> | undefined)?.y
      const imgH = (intr['height'] as number | undefined) ?? canvas.height
      if (fy && imgH) {
        this._fovY = 2 * Math.atan(imgH / (2 * fy)) * (180 / Math.PI)
      }
    }

    // Harvest world points. xr.js builds vary: some expose worldPoints, others points.
    const newPts = [
      ...extractPointBatch(reality['worldPoints'], this.latestPose),
      ...extractPointBatch(reality['points'], this.latestPose),
    ]
    if (newPts.length > 0) this._latestWorldPoints = newPts
  }

  async start(canvas: HTMLCanvasElement): Promise<void> {
    // Wait for xr.js to finish loading if it hasn't yet
    if (typeof XR8 === 'undefined') {
      await new Promise<void>((resolve) =>
        window.addEventListener('xrloaded', () => resolve(), { once: true }),
      )
    }

    // SLAM chunk may already be preloaded via data-preload-chunks="slam";
    // calling loadChunk again is a no-op if already loaded.
    await XR8.loadChunk('slam')

    const self = this

    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(), // draws camera feed to canvas
      XR8.XrController.pipelineModule(), // enables SLAM 6-DoF tracking + pose
      XR8.CameraPixelArray.pipelineModule({ luminance: false }), // RGBA pixel array
      {
        name: 'ci-scan-capture',

        // onUpdate runs AFTER all module onProcessCpu hooks, so processCpuResult
        // is fully populated (XrController has written its reality pose into it).
        // This is the correct place to read SLAM pose in this xr.js build.
        onUpdate(args: { processCpuResult?: Record<string, unknown>; processGpuResult?: Record<string, unknown>; frameStartResult?: Record<string, unknown> }) {
          self._syncReality(args.processCpuResult ?? args.processGpuResult ?? args.frameStartResult, 'onUpdate', canvas)
        },

        onProcessCpu({ processCpuResult, processGpuResult, frameStartResult }: {
          processCpuResult?: Record<string, unknown>
          processGpuResult: Record<string, unknown>
          frameStartResult?: Record<string, unknown>
        }) {
          self._syncReality(processCpuResult ?? processGpuResult ?? frameStartResult, 'onProcessCpu', canvas)

          // Only do the expensive pixel copy when a capture is pending
          if (self.captureQueue.length === 0) return

          console.log('[capture] onProcessCpu triggered, processGpuResult keys:', Object.keys(processGpuResult))
          const pa = (processGpuResult as { camerapixelarray?: { pixels: Uint8Array; rows: number; cols: number } })
            .camerapixelarray
          console.log('[capture] camerapixelarray:', pa ? `${pa.cols}×${pa.rows} px${pa.pixels?.length}` : 'undefined')
          if (!pa?.pixels) {
            console.warn('[capture] No pixel data in processGpuResult — capture will retry next frame')
            return
          }

          const { pixels, rows: height, cols: width } = pa
          // Copy immediately — the underlying buffer is reused next frame
          const pixelsCopy = new Uint8ClampedArray(pixels)
          const frame: RawFrame = {
            pixels: pixelsCopy,
            width,
            height,
            pose: { ...self.latestPose, position: { ...self.latestPose.position } },
            timestamp: performance.now(),
          }

          // Drain the queue — normally one waiting captureFrame() call.
          const queue = self.captureQueue.splice(0)
          queue.forEach((pending) => {
            clearTimeout(pending.timeout)
            pending.resolve(frame)
          })
        },
      },
    ])

    // XR8 does not resize the canvas itself — it uses canvas.width/canvas.height
    // as the GL viewport.  Set them to the physical pixel size of the screen so
    // GlTextureRenderer renders at full device resolution, not the default 300×150.
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)
    this._aspect = window.innerWidth / window.innerHeight

    XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })

    // Diagnostics only: captures may proceed without stable tracking after the
    // caller's wait timeout, but isTracking() should mean a real pose arrived.
    setTimeout(() => {
      if (!this._slamReady) {
        console.warn('[8thwall] Pose not received in 5 s — capture can continue, but scan geometry will be sparse')
      }
    }, 5000)
  }

  stop(): void {
    XR8.stop()
  }

  captureFrame(timeoutMs = 4000): Promise<RawFrame> {
    if (this.captureQueue.length > 0) {
      return Promise.reject(new Error('Capture already pending'))
    }

    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const idx = this.captureQueue.indexOf(pending)
          if (idx >= 0) this.captureQueue.splice(idx, 1)
          reject(new Error('Timed out waiting for camera frame'))
        }, timeoutMs),
      }
      this.captureQueue.push(pending)
    })
  }

  hitTest(x: number, y: number): HitResult | null {
    const results = XR8.XrController.hitTest(x, y, ['FEATURE_POINT'])
    console.log('[8thwall-hitTest] input:', x, y, 'raw results:', JSON.stringify(results))
    if (!results?.length) return null
    const { position, rotation } = results[0]
    const reportedDistance = results[0].distance
    const computedDistance = position ? poseDistance(position, this.latestPose.position) : NaN
    const distance = Number.isFinite(reportedDistance) && reportedDistance > 0
      ? reportedDistance
      : computedDistance
    if (!position || !usefulWorldPoint(position, this.latestPose)) return null
    return { position, rotation, distance }
  }

  /**
   * Sample feature points at a `gridSize×gridSize` grid of screen coordinates.
   * Skips edges (starts at 1/(gridSize+1)) so border probes don't miss the
   * scene on portrait phones where the camera feed doesn't reach the edge.
   */
  featurePoints(gridSize = 6): Array<{ x: number; y: number; z: number }> {
    // SLAM WASM crashes with an out-of-bounds memory access if the map hasn't
    // been populated yet.  Bail out until the first onProcessCpu pose arrives.
    if (!this._slamReady) return []

    // Use world points harvested directly from the reality GPU result when available
    // — these come for free every frame and avoid separate WASM hit-test calls.
    if (this._latestWorldPoints.length > 0) {
      const pts = this._latestWorldPoints
      this._latestWorldPoints = [] // consume once
      return pts
    }

    // Fall back to grid hit-tests (older xr.js builds that don't expose worldPoints)
    const pts: Array<{ x: number; y: number; z: number }> = []
    const step = 1 / (gridSize + 1)
    for (let r = 1; r <= gridSize; r++) {
      for (let c = 1; c <= gridSize; c++) {
        try {
          const results = XR8.XrController.hitTest(c * step, r * step, ['FEATURE_POINT'])
          if (results?.length && usefulWorldPoint(results[0].position, this.latestPose)) {
            pts.push(results[0].position)
          }
        } catch {
          // Intermittent WASM map miss — skip this probe
        }
      }
    }
    return pts
  }

  getPose(): Pose {
    return {
      position: { ...this.latestPose.position },
      rotation: { ...this.latestPose.rotation },
    }
  }

  isTracking(): boolean {
    return this._slamReady
  }

  getCameraFovY(): number {
    return this._fovY
  }

  getCameraAspect(): number {
    return this._aspect
  }
}

/** Waits for the XR8 global to be available, then returns a provider instance */
export async function createEighthWallProvider(): Promise<EighthWallProvider> {
  if (typeof XR8 === 'undefined') {
    await new Promise<void>((resolve) =>
      window.addEventListener('xrloaded', () => resolve(), { once: true }),
    )
  }
  return new EighthWallProvider()
}
