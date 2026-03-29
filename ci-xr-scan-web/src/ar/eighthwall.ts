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
  Threejs: {
    pipelineModule(): object
    xrScene(): { scene: THREE.Scene; camera: THREE.Camera; renderer: THREE.WebGLRenderer } | null
  }
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

// Minimal Three.js type references (full types come from @types/three)
declare namespace THREE {
  interface Scene {}
  interface Camera {
    position: { x: number; y: number; z: number }
    quaternion: { x: number; y: number; z: number; w: number }
  }
  interface WebGLRenderer {}
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
      XR8.Threejs.pipelineModule(), // creates Three.js GL scene
      XR8.XrController.pipelineModule(), // enables SLAM 6-DoF tracking
      XR8.CameraPixelArray.pipelineModule({ luminance: false }), // RGBA pixel array
      {
        name: 'ci-scan-capture',

        onProcessCpu({ processGpuResult }: { processGpuResult: Record<string, unknown> }) {
          // Update pose from the Three.js camera (most accurate after SLAM update)
          const xrScene = XR8.Threejs.xrScene?.()
          if (xrScene?.camera) {
            const { camera } = xrScene
            self.latestPose = {
              position: { ...camera.position },
              rotation: { ...camera.quaternion },
            }
          }

          // Only do the expensive pixel copy when a capture is pending
          if (self.captureQueue.length === 0) return

          const pa = (processGpuResult as { camerapixelarray?: { pixels: Uint8Array; rows: number; cols: number } })
            .camerapixelarray
          if (!pa?.pixels) return

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
