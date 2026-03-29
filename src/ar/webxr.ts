/**
 * WebXR immersive-ar fallback provider.
 *
 * Used on Quest browser and devices where the 8th Wall binary is unavailable.
 * Camera images are captured via a companion getUserMedia() video stream since
 * raw XR camera access (camera-access feature) isn't widely supported yet.
 * Hit-testing uses the WebXR hit-test API.
 */
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'

export class WebXRProvider implements ARProvider {
  private session: XRSession | null = null
  private refSpace: XRReferenceSpace | null = null
  private hitTestSource: XRHitTestSource | null = null
  private videoStream: MediaStream | null = null
  private videoEl: HTMLVideoElement | null = null
  private offscreen: OffscreenCanvas | null = null
  private offCtx: OffscreenCanvasRenderingContext2D | null = null
  private captureQueue: Array<(frame: RawFrame) => void> = []
  private latestPose: Pose = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }
  private animFrameId: number | null = null

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available')

    // Set up a companion video stream for camera pixel data.
    // XR camera-access is too sparsely supported to rely on.
    this.videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    this.videoEl = document.createElement('video')
    this.videoEl.srcObject = this.videoStream
    this.videoEl.playsInline = true
    this.videoEl.muted = true
    await this.videoEl.play()

    this.session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
    })

    const gl = canvas.getContext('webgl2', { xrCompatible: true }) as WebGL2RenderingContext
    await this.session.updateRenderState({ baseLayer: new XRWebGLLayer(this.session, gl) })

    const [localFloor, viewer] = await Promise.all([
      this.session.requestReferenceSpace('local-floor').catch(() =>
        this.session!.requestReferenceSpace('local'),
      ),
      this.session!.requestReferenceSpace('viewer'),
    ])
    this.refSpace = localFloor

    this.hitTestSource = await this.session.requestHitTestSource!({ space: viewer }) ?? null

    // Main XR frame loop
    const self = this
    function onXRFrame(time: number, frame: XRFrame) {
      self.session!.requestAnimationFrame(onXRFrame)

      // Update pose
      const viewerPose = frame.getViewerPose(self.refSpace!)
      if (viewerPose) {
        const { position: p, orientation: q } = viewerPose.transform
        self.latestPose = {
          position: { x: p.x, y: p.y, z: p.z },
          rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
        }
      }

      // Resolve pending captureFrame() calls
      if (self.captureQueue.length > 0 && self.videoEl && self.videoEl.readyState >= 2) {
        const w = self.videoEl.videoWidth
        const h = self.videoEl.videoHeight
        if (!self.offscreen || self.offscreen.width !== w || self.offscreen.height !== h) {
          self.offscreen = new OffscreenCanvas(w, h)
          self.offCtx = self.offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D
        }
        self.offCtx!.drawImage(self.videoEl, 0, 0)
        const imageData = self.offCtx!.getImageData(0, 0, w, h)
        const frame_: RawFrame = {
          pixels: imageData.data,
          width: w,
          height: h,
          pose: { ...self.latestPose, position: { ...self.latestPose.position } },
          timestamp: time,
        }
        const queue = self.captureQueue.splice(0)
        queue.forEach((resolve) => resolve(frame_))
      }
    }

    this.session.requestAnimationFrame(onXRFrame)
  }

  stop(): void {
    if (this.animFrameId != null) cancelAnimationFrame(this.animFrameId)
    this.hitTestSource?.cancel()
    this.session?.end()
    this.videoStream?.getTracks().forEach((t) => t.stop())
    this.session = null
    this.hitTestSource = null
    this.videoStream = null
  }

  captureFrame(): Promise<RawFrame> {
    return new Promise((resolve) => this.captureQueue.push(resolve))
  }

  featurePoints(_gridSize?: number): Array<{ x: number; y: number; z: number }> {
    // WebXR does not expose SLAM feature points — return empty so the point
    // cloud stays empty and the exporter falls back to detection-only export.
    return []
  }

  getPose(): Pose {
    return {
      position: { ...this.latestPose.position },
      rotation: { ...this.latestPose.rotation },
    }
  }

  hitTest(x: number, y: number): HitResult | null {
    // WebXR hit-test must happen inside a frame callback.
    // This synchronous call returns the result from the most recent frame
    // for the screen-centre as a rough proxy.
    // For accurate per-bbox hit-tests call captureAndHitTest() asynchronously.
    void x; void y
    // Return null — the spatial resolver will use the async path below.
    return null
  }

  /**
   * Performs a real WebXR hit-test during the next animation frame.
   * Used by the spatial resolver when this provider is active.
   */
  hitTestAsync(x: number, y: number): Promise<HitResult | null> {
    return new Promise((resolve) => {
      if (!this.session || !this.hitTestSource || !this.refSpace) {
        resolve(null)
        return
      }
      this.session.requestAnimationFrame((_time, frame) => {
        const results = frame.getHitTestResults(this.hitTestSource!)
        if (!results.length) { resolve(null); return }
        const pose = results[0].getPose(this.refSpace!)
        if (!pose) { resolve(null); return }
        const { position: p, orientation: q } = pose.transform
        // x/y used for ray origin in future; for now use viewer ray hit
        void x; void y
        resolve({
          position: { x: p.x, y: p.y, z: p.z },
          rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
          distance: Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z),
        })
      })
    })
  }
}

export async function createWebXRProvider(): Promise<WebXRProvider> {
  if (!navigator.xr) throw new Error('WebXR not supported on this device')
  const supported = await navigator.xr.isSessionSupported('immersive-ar')
  if (!supported) throw new Error('immersive-ar session not supported')
  return new WebXRProvider()
}
