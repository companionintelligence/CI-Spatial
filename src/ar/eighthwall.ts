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

export class EighthWallProvider implements ARProvider {
  private captureQueue: Array<(frame: RawFrame) => void> = []
  private latestPose: Pose = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }
  /** True once the SLAM WASM map has received its first frame — hit-tests are unsafe before this */
  private _slamReady = false
  /** Latest SLAM world points from the reality GPU result — fresher than grid hit-tests */
  private _latestWorldPoints: Array<{ x: number; y: number; z: number }> = []
  private _lastTrackingStatus = ''
  private _diagLogged = false

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

        onProcessCpu({ processGpuResult, processCpuResult }: {
          processGpuResult: Record<string, unknown>
          processCpuResult: Record<string, unknown>
        }) {
          // Log keys once on first frame to see the real structure on this xr.js build
          if (!self._diagLogged) {
            self._diagLogged = true
            console.log('[8thwall] processGpuResult keys:', Object.keys(processGpuResult))
            console.log('[8thwall] processCpuResult keys:', Object.keys(processCpuResult))
            const gpuR = (processGpuResult as Record<string, Record<string, unknown>>)?.reality
            const cpuR = (processCpuResult as Record<string, Record<string, unknown>>)?.reality
            console.log('[8thwall] processGpuResult.reality:', gpuR ? JSON.stringify(Object.keys(gpuR)) : 'absent')
            console.log('[8thwall] processCpuResult.reality:', cpuR ? JSON.stringify(Object.keys(cpuR)) : 'absent')
          }

          // XrController writes to processCpuResult.reality; processGpuResult.reality is
          // the texture renderer's GPU context with a different structure.
          // We check both so the code works across xr.js build variants.
          const cpuReality = (processCpuResult as Record<string, Record<string, unknown>>)?.reality
          const gpuReality = (processGpuResult as Record<string, Record<string, unknown>>)?.reality
          const reality = (cpuReality?.position ? cpuReality : gpuReality?.position ? gpuReality : null)

          if (reality?.rotation && reality?.position) {
            self.latestPose = {
              position: reality.position as { x: number; y: number; z: number },
              rotation: reality.rotation as { x: number; y: number; z: number; w: number },
            }

            // Log tracking status transitions
            const status = (reality.trackingStatus as string | undefined) ?? 'UNKNOWN'
            if (status !== self._lastTrackingStatus) {
              console.log('[8thwall] trackingStatus:', status)
              self._lastTrackingStatus = status
            }

            // SLAM is safe to use as soon as we receive a pose (even LIMITED tracking)
            if (!self._slamReady) {
              console.log('[8thwall] SLAM ready — first pose received')
              self._slamReady = true
            }

            // Harvest world points directly from the reality object rather than
            // firing expensive grid hit-tests.  The format is either:
            //   reality.worldPoints = [{x,y,z}, ...]
            //   reality.worldPoints = { points: Float32Array, numPoints: number }
            const wp = reality.worldPoints as Record<string, unknown> | null | undefined
            if (wp) {
              const newPts: Array<{ x: number; y: number; z: number }> = []
              if (Array.isArray(wp)) {
                // Array-of-objects format
                for (const p of wp as Array<{ x?: number; y?: number; z?: number }>) {
                  if (typeof p?.x === 'number') newPts.push({ x: p.x, y: p.y ?? 0, z: p.z ?? 0 })
                }
              } else if (wp.points instanceof Float32Array || Array.isArray(wp.points)) {
                // Flat packed-float format: [x0,y0,z0, x1,y1,z1, ...]
                const flat = wp.points as ArrayLike<number>
                for (let i = 0; i + 2 < flat.length; i += 3) {
                  newPts.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] })
                }
              }
              if (newPts.length > 0) self._latestWorldPoints = newPts
            }
          }

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

          // Drain the queue — every waiting captureFrame() call gets this frame
          const queue = self.captureQueue.splice(0)
          queue.forEach((resolve) => resolve(frame))
        },
      },
    ])

    // XR8 does not resize the canvas itself — it uses canvas.width/canvas.height
    // as the GL viewport.  Set them to the physical pixel size of the screen so
    // GlTextureRenderer renders at full device resolution, not the default 300×150.
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)

    XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })

    // Fallback: if SLAM hasn't provided a pose within 5 s of XR8.run(),
    // unlock the capture button anyway so the app remains usable.
    setTimeout(() => {
      if (!this._slamReady) {
        console.warn('[8thwall] Pose not received in 5 s — forcing _slamReady=true (pose may be at origin)')
        this._slamReady = true
      }
    }, 5000)
  }

  stop(): void {
    XR8.stop()
  }

  captureFrame(): Promise<RawFrame> {
    return new Promise((resolve) => {
      this.captureQueue.push(resolve)
    })
  }

  hitTest(x: number, y: number): HitResult | null {
    const results = XR8.XrController.hitTest(x, y, ['FEATURE_POINT'])
    if (!results?.length) return null
    const { position, rotation, distance } = results[0]
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
          if (results?.length) pts.push(results[0].position)
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
