/**
 * WebXR immersive-ar fallback provider.
 *
 * Used on Quest browser and devices where the 8th Wall binary is unavailable.
 * Camera images are captured via a companion getUserMedia() video stream since
 * raw XR camera access (camera-access feature) isn't widely supported yet.
 * Hit-testing uses the WebXR hit-test API.
 */
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'

/**
 * Probe grid subscribed against the viewer space, N x N. Matches
 * DEFAULT_GRID_SIZE in src/ar/scanner.ts:31 (6 -> 36 probes), which is the
 * density the scanner and the 8th Wall provider already assume.
 */
const HIT_GRID_N = 6

/** One scanner interval of grid samples: 750 ms x 60 fps x 36 probes, rounded up. */
const MAX_RECENT_HIT_POINTS = 2048

export class WebXRProvider implements ARProvider {
  private session: XRSession | null = null
  private refSpace: XRReferenceSpace | null = null
  private hitTestSources: XRHitTestSource[] = []
  private hitTestGridState: 'idle' | 'building' | 'ready' | 'failed' = 'idle'
  private viewerSpace: XRReferenceSpace | null = null
  private _fovY = 60
  private _aspect = 1
  private videoStream: MediaStream | null = null
  private videoEl: HTMLVideoElement | null = null
  private offscreen: OffscreenCanvas | null = null
  private offCtx: OffscreenCanvasRenderingContext2D | null = null
  private captureQueue: Array<{
    resolve: (frame: RawFrame) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }> = []
  private latestPose: Pose = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }
  private animFrameId: number | null = null
  /** Surface points sampled from the viewer-ray hit test each frame */
  private _recentHitPoints: Array<{ x: number; y: number; z: number }> = []

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available')

    // Set up a companion video stream for camera pixel data.
    // XR camera-access is too sparsely supported to rely on.
    // Camera denial is non-fatal: tracking/hit-testing still work, only
    // frame capture is unavailable (headsets, emulated runtimes).
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      this.videoEl = document.createElement('video')
      this.videoEl.srcObject = this.videoStream
      this.videoEl.playsInline = true
      this.videoEl.muted = true
      await this.videoEl.play()
    } catch (e) {
      console.warn('[webxr] No camera stream — frame capture disabled:', e)
    }

    this.session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      // Without an explicit root the dom-overlay feature never activates and
      // the entire HTML UI is invisible inside the immersive session
      // (HelloXR on iOS, Quest browser).
      domOverlay: { root: document.body },
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
    this.viewerSpace = viewer

    // Hit-test sources are subscribed on the first frame, not here: the grid
    // is aimed using _fovY/_aspect, which only become real once a viewer pose
    // has been read. Subscribing here would bake in the 60°/1.0 defaults.

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
        if (viewerPose.views.length > 0) {
          const proj = viewerPose.views[0].projectionMatrix
          const fovY = 2 * Math.atan(1 / proj[5]) * (180 / Math.PI)
          const aspect = proj[5] / proj[0]
          if (Number.isFinite(fovY) && fovY > 0) self._fovY = fovY
          if (Number.isFinite(aspect) && aspect > 0) self._aspect = aspect
        }
      }

      // Subscribe the probe grid once the first viewer pose has given us a
      // real FOV and aspect to aim it with.
      if (self.hitTestGridState === 'idle' && self.viewerSpace && viewerPose) {
        self.hitTestGridState = 'building'
        void self.buildHitTestGrid()
      }

      // Sample every probe in the grid each frame. WebXR exposes no SLAM
      // feature points, so surface hits are the only source of geometry —
      // and a single centre ray only ever draws a 1-D trail down the middle
      // of the screen, which the point cloud's 5 cm voxel dedupe then
      // collapses to almost nothing unless the device is moving. Sampling the
      // full grid is what makes this provider's output comparable to 8th
      // Wall's (src/ar/eighthwall.ts:294), which the scanner already assumes
      // when it asks for gridSize=6 (src/ar/scanner.ts:31).
      if (self.hitTestSources.length > 0 && self.refSpace) {
        for (const source of self.hitTestSources) {
          const hits = frame.getHitTestResults(source)
          if (hits.length === 0) continue
          const pose = hits[0].getPose(self.refSpace)
          if (!pose) continue
          const { x, y, z } = pose.transform.position
          self._recentHitPoints.push({ x, y, z })
        }
        // Keep one full scanner interval's worth (750 ms x 60 fps x 36 probes);
        // featurePoints() splices the buffer empty on each tick anyway, so this
        // cap only bites if the scanner stalls.
        const excess = self._recentHitPoints.length - MAX_RECENT_HIT_POINTS
        if (excess > 0) self._recentHitPoints.splice(0, excess)
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
        queue.forEach((pending) => {
          clearTimeout(pending.timeout)
          pending.resolve(frame_)
        })
      }
    }

    this.session.requestAnimationFrame(onXRFrame)
  }

  stop(): void {
    if (this.animFrameId != null) cancelAnimationFrame(this.animFrameId)
    for (const source of this.hitTestSources) source.cancel()
    this.session?.end()
    this.videoStream?.getTracks().forEach((t) => t.stop())
    this.session = null
    this.hitTestSources = []
    this.hitTestGridState = 'idle'
    this.videoStream = null
    this.viewerSpace = null
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

  /**
   * Builds an XRRay through a point on the viewport, expressed in the 0-1
   * normalised coordinates the resolver already uses (0,0 = top-left).
   * Shared by the probe grid and hitTestAsync() so both aim the same way.
   */
  private viewportRay(x: number, y: number): XRRay {
    const ndcX = x * 2 - 1
    const ndcY = 1 - y * 2
    const tanHalfFovY = Math.tan((this._fovY * Math.PI) / 180 / 2)
    const dirX = ndcX * this._aspect * tanHalfFovY
    const dirY = ndcY * tanHalfFovY
    const len = Math.hypot(dirX, dirY, 1) || 1
    return new XRRay(
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dirX / len, y: dirY / len, z: -1 / len, w: 0 },
    )
  }

  /**
   * Subscribes one persistent hit-test source per grid cell, aimed at the cell
   * centre. Hit-test is optional on emulated runtimes (iwer) and some
   * browsers; a total failure downgrades to no feature points, exactly as the
   * single-ray version did.
   */
  private async buildHitTestGrid(): Promise<void> {
    const session = this.session
    const viewer = this.viewerSpace
    const request = session?.requestHitTestSource?.bind(session)
    if (!session || !viewer || !request) {
      console.warn('[webxr] hit-test unavailable — feature points disabled')
      this.hitTestGridState = 'failed'
      return
    }
    const pending: Array<Promise<XRHitTestSource | null>> = []
    for (let row = 0; row < HIT_GRID_N; row++) {
      for (let col = 0; col < HIT_GRID_N; col++) {
        const ray = this.viewportRay((col + 0.5) / HIT_GRID_N, (row + 0.5) / HIT_GRID_N)
        pending.push(
          Promise.resolve(request({ space: viewer, offsetRay: ray }))
            .then((source) => source ?? null)
            .catch(() => null),
        )
      }
    }
    const sources = (await Promise.all(pending))
      .filter((s): s is XRHitTestSource => s != null)
    // The session can end while the subscriptions are in flight.
    if (this.session !== session) {
      for (const source of sources) source.cancel()
      return
    }
    this.hitTestSources = sources
    this.hitTestGridState = sources.length > 0 ? 'ready' : 'failed'
    if (sources.length === 0) {
      console.warn('[webxr] hit-test unavailable — feature points disabled')
    } else if (sources.length < HIT_GRID_N * HIT_GRID_N) {
      console.warn(
        `[webxr] only ${sources.length}/${HIT_GRID_N * HIT_GRID_N} hit-test probes subscribed`,
      )
    }
  }

  featurePoints(_gridSize?: number): Array<{ x: number; y: number; z: number }> {
    // WebXR exposes no SLAM feature points; drain the per-frame probe-grid
    // hit-test samples instead (collected in the XR frame loop above).
    //
    // gridSize is advisory for this provider: the probe grid is subscribed once
    // per session (HIT_GRID_N above, matched to the scanner's default) because
    // XRHitTestSource subscriptions are async and persistent, so the density
    // cannot be renegotiated per call the way 8th Wall's synchronous probe does.
    if (this._recentHitPoints.length === 0) return []
    return this._recentHitPoints.splice(0)
  }

  getPose(): Pose {
    return {
      position: { ...this.latestPose.position },
      rotation: { ...this.latestPose.rotation },
    }
  }

  isTracking(): boolean {
    // WebXR is considered tracking as soon as the session is active
    return this.session !== null
  }

  getCameraFovY(): number {
    return this._fovY
  }

  getCameraAspect(): number {
    return this._aspect
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
    const session = this.session
    if (!session || !this.viewerSpace || !this.refSpace) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const ray = this.viewportRay(x, y)
      const sessionAny = session as any
      if (typeof sessionAny.requestHitTestSource === 'function') {
        sessionAny.requestHitTestSource({ space: this.viewerSpace!, offsetRay: ray })
          .then((source: any) => {
            session.requestAnimationFrame((_time, frame) => {
              const results = frame.getHitTestResults(source)
              source.cancel()
              if (!results.length) { resolve(null); return }
              const pose = results[0].getPose(this.refSpace!)
              if (!pose) { resolve(null); return }
              const { position: p, orientation: q } = pose.transform
              const cp = this.latestPose.position
              resolve({
                position: { x: p.x, y: p.y, z: p.z },
                rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
                distance: Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z),
              })
            })
          })
          .catch(() => resolve(null))
      } else {
        resolve(null)
      }
    })
  }
}

export async function createWebXRProvider(): Promise<WebXRProvider> {
  if (!navigator.xr) throw new Error('WebXR not supported on this device')
  const supported = await navigator.xr.isSessionSupported('immersive-ar')
  if (!supported) throw new Error('immersive-ar session not supported')
  return new WebXRProvider()
}

/** True if this browser can run a native `immersive-ar` WebXR session. */
export async function isImmersiveARSupported(): Promise<boolean> {
  if (!navigator.xr) return false
  try {
    return await navigator.xr.isSessionSupported('immersive-ar')
  } catch {
    return false
  }
}
