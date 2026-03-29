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
          // XrController provides camera pose via processCpuResult.reality
          const reality = (processCpuResult as Record<string, Record<string, unknown>>)?.reality
          if (reality?.rotation && reality?.position) {
            self.latestPose = {
              position: reality.position as { x: number; y: number; z: number },
              rotation: reality.rotation as { x: number; y: number; z: number; w: number },
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
    const pts: Array<{ x: number; y: number; z: number }> = []
    const step = 1 / (gridSize + 1)
    for (let r = 1; r <= gridSize; r++) {
      for (let c = 1; c <= gridSize; c++) {
        const results = XR8.XrController.hitTest(c * step, r * step, ['FEATURE_POINT'])
        if (results?.length) pts.push(results[0].position)
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
