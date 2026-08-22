/**
 * WebXR immersive-ar fallback provider.
 *
 * Used on Quest browser and devices where the 8th Wall binary is unavailable.
 * Camera images are captured via a companion getUserMedia() video stream since
 * raw XR camera access (camera-access feature) isn't widely supported yet.
 * Hit-testing uses the WebXR hit-test API.
 *
 * A THREE.WebGLRenderer is bound to the session's own WebGL2 context so the
 * calibration decal (and anything else world-locked) can render on top of
 * the passthrough — via renderer.xr.setSession(), not hand-rolled framebuffer
 * binding, so Three.js's own well-tested XR machinery owns the frame loop,
 * viewport, and XRWebGLLayer wiring instead of us re-deriving it. This is
 * the less-proven half of the calibration-decal work (the 8th Wall side has
 * a working in-repo reference; this doesn't) — needs verification on a real
 * WebXR device, not just review.
 */
import * as THREE from 'three'
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'
import { DEFAULT_GRID_SIZE, DEFAULT_INTERVAL_MS as SCAN_INTERVAL_MS } from './scanner'

/**
 * Probe grid subscribed against the viewer space, N x N. Imported rather than
 * restated so the scanner's contract and this provider's grid cannot drift.
 */
const HIT_GRID_N = DEFAULT_GRID_SIZE

/** Highest XR frame rate we size buffers for — Quest runs 72/90/120 Hz. */
const MAX_XR_FPS = 120

/** Rebuilds allowed while recovering a partially subscribed probe grid. */
const MAX_GRID_ATTEMPTS = 2

/**
 * One scanner interval of grid samples at the highest refresh rate we expect —
 * 0.75 s x 120 fps x 36 probes = 3240 — derived rather than hard-coded so it
 * tracks the scanner's cadence and the grid size. Sizing it from a 60 fps
 * assumption silently discarded ~37% of samples on a 120 Hz headset, and this
 * provider exists for Quest, which runs at 72/90/120.
 */
const MAX_RECENT_HIT_POINTS = Math.ceil(
  (SCAN_INTERVAL_MS / 1000) * MAX_XR_FPS * HIT_GRID_N * HIT_GRID_N,
)

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
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private decalCamera: THREE.PerspectiveCamera | null = null
  /**
   * Surface points sampled from the probe grid each frame, as a flat xyz ring
   * buffer. A plain array of {x,y,z} allocated up to 36 objects per frame
   * (~4300/s at 120 Hz), all garbage on the next drain — real GC pressure
   * inside an XR render loop. Objects are now materialised once per drain
   * instead, in featurePoints().
   */
  private _hitBuf = new Float32Array(MAX_RECENT_HIT_POINTS * 3)
  private _hitWrite = 0
  private _hitCount = 0
  /** Set once a viewer pose has yielded a real projection — see buildHitTestGrid(). */
  private _haveRealProjection = false
  /** Rebuild attempts spent recovering a partially subscribed grid. */
  private _gridAttempts = 0
  /** First subscription error seen, kept so the failure warning can name a cause. */
  private _gridError: unknown = null

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available')

    // requestSession() must run while the user gesture that triggered start()
    // is still active. Awaiting getUserMedia()'s permission prompt first burns
    // through that window, so requestSession() then rejects with
    // "SecurityError: ... requires user activation". Request the XR session
    // first, and set up the companion camera stream after.
    this.session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      // local-floor isn't implicitly granted on every runtime (ARCore-backed
      // Chrome in particular) — omitting it here made Three.js's own internal
      // reference-space request in renderer.xr.setSession() below throw
      // NotSupportedError even though this provider's own fallback logic
      // (this.session.requestReferenceSpace, further down) never got a chance
      // to run. Listing it as optional, not required, keeps runtimes that
      // truly lack floor-relative tracking working via the 'local' fallback.
      optionalFeatures: ['dom-overlay', 'local-floor'],
      // Without an explicit root the dom-overlay feature never activates and
      // the entire HTML UI is invisible inside the immersive session
      // (HelloXR on iOS, Quest browser).
      domOverlay: { root: document.body },
    })

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

    const gl = canvas.getContext('webgl2', { xrCompatible: true }) as WebGL2RenderingContext

    // renderer.xr.setSession() below creates and installs its own XRWebGLLayer
    // via session.updateRenderState() internally — no separate call needed here.
    this.renderer = new THREE.WebGLRenderer({ context: gl, canvas })
    this.renderer.autoClear = false // never blank the camera passthrough
    this.renderer.xr.enabled = true
    // Three.js's WebXRManager requests its own reference space internally as
    // part of setSession() — separately from this.refSpace below, which
    // drives the decal camera pose. Its default type is 'local', which
    // NotSupportedError's on runtimes that only granted 'local-floor' (or
    // neither) as an optional feature above. Mirror the same
    // local-floor-then-local fallback this provider already uses for
    // this.refSpace so both requests agree on what the runtime actually
    // supports.
    this.renderer.xr.setReferenceSpaceType('local-floor')
    try {
      await this.renderer.xr.setSession(this.session)
    } catch {
      this.renderer.xr.setReferenceSpaceType('local')
      await this.renderer.xr.setSession(this.session)
    }
    this.scene = new THREE.Scene()
    this.decalCamera = new THREE.PerspectiveCamera()

    const [localFloor, viewer] = await Promise.all([
      this.session.requestReferenceSpace('local-floor').catch(() =>
        this.session!.requestReferenceSpace('local'),
      ),
      this.session!.requestReferenceSpace('viewer'),
    ])
    this.refSpace = localFloor
    this.viewerSpace = viewer

    // Only the *aiming* is deferred to the first frame — the grid is pointed
    // with _fovY/_aspect, which are not real until a viewer pose has been read.
    // Availability is still reported here, so a runtime with no hit-test support
    // says so during startup rather than a frame later, interleaved with the
    // frame loop's output.
    if (typeof this.session.requestHitTestSource !== 'function') {
      console.warn('[webxr] hit-test unavailable — feature points disabled')
      this.hitTestGridState = 'failed'
    }

    // Main XR frame loop — driven by renderer.setAnimationLoop() below, not a
    // self-recursing session.requestAnimationFrame() call: Three.js's
    // WebXRManager owns re-invoking this every frame once it's registered,
    // and still passes through the real (time, XRFrame) pair untouched, so
    // everything below reads exactly as it did before the Three.js renderer
    // was introduced.
    const self = this
    function onXRFrame(time: number, frame: XRFrame) {
      // THREE.WebGLRenderer.setAnimationLoop() unconditionally restarts its
      // own plain requestAnimationFrame loop (single `time` arg, no `frame`)
      // every time it's called, even mid-session — it only stops that loop
      // via the 'sessionstart' event, which has already fired and run by the
      // time this provider calls setAnimationLoop() below (after setSession()
      // has resolved). The real XR-driven loop (session.requestAnimationFrame,
      // which does pass `frame`) runs alongside it, so every other tick here
      // calls back with frame === undefined. Skip those rather than crash.
      if (!frame) return
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
          if (Number.isFinite(fovY) && fovY > 0 && Number.isFinite(aspect) && aspect > 0) {
            self._fovY = fovY
            self._aspect = aspect
            // Only now is it safe to aim the probe grid — see the guard below.
            self._haveRealProjection = true
          }
        }
      }

      // Subscribe the probe grid once a viewer pose has given us a real FOV and
      // aspect to aim it with. Gating on viewerPose alone was not enough: the
      // projection is only read when views.length > 0 and the derived values are
      // finite and positive, so a first frame failing either check would have
      // aimed a 36-probe grid using the 60°/1.0 defaults — the exact outcome
      // deferring the build was meant to avoid — with no rebuild for the session.
      if (self.hitTestGridState === 'idle' && self.viewerSpace && self._haveRealProjection) {
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
          self.pushHitPoint(x, y, z)
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
        queue.forEach((pending) => {
          clearTimeout(pending.timeout)
          pending.resolve(frame_)
        })
      }

      // Render the calibration decal (and anything else added to self.scene)
      // on top of the passthrough. By the time Three's setAnimationLoop calls
      // this callback, its WebXRManager has already bound the right XR
      // framebuffer/viewport for this frame — camera pose/projection are set
      // directly from the same per-view data above rather than going through
      // renderer.xr.getCamera(), so this has no dependency on refSpace beyond
      // what pose tracking already needed.
      if (self.scene && self.renderer && self.decalCamera && viewerPose && viewerPose.views.length > 0) {
        const view = viewerPose.views[0]!
        self.decalCamera.matrix.fromArray(view.transform.matrix)
        self.decalCamera.matrix.decompose(self.decalCamera.position, self.decalCamera.quaternion, self.decalCamera.scale)
        self.decalCamera.projectionMatrix.fromArray(view.projectionMatrix)
        self.renderer.render(self.scene, self.decalCamera)
      }
    }

    this.renderer.setAnimationLoop(onXRFrame)
  }

  stop(): void {
    this.renderer?.setAnimationLoop(null)
    for (const source of this.hitTestSources) source.cancel()
    this.session?.end()
    this.videoStream?.getTracks().forEach((t) => t.stop())
    // start() creates a fresh WebGLRenderer against the same canvas/context
    // on every call (getContext() returns the same WebGL2RenderingContext for
    // a given canvas), so an undisposed renderer's compiled programs and
    // buffers pile up in that shared context across repeated start()/stop()
    // cycles in one page lifetime instead of being freed.
    this.renderer?.dispose()
    this.session = null
    this.hitTestSources = []
    this.hitTestGridState = 'idle'
    this._haveRealProjection = false
    this._gridAttempts = 0
    this._gridError = null
    this._hitWrite = 0
    this._hitCount = 0
    this.videoStream = null
    this.viewerSpace = null
    this.renderer = null
    this.scene = null
    this.decalCamera = null
  }

  getScene(): THREE.Scene | null {
    return this.scene
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
      this.failGrid('hit-test unavailable')
      return
    }

    const total = HIT_GRID_N * HIT_GRID_N
    const pending: Array<Promise<XRHitTestSource | null>> = []
    for (let row = 0; row < HIT_GRID_N; row++) {
      for (let col = 0; col < HIT_GRID_N; col++) {
        // Both the ray construction and request() can throw synchronously as
        // well as reject — XRRay is a runtime constructor, and the session can
        // end mid-build. An escaping sync throw would leave hitTestGridState
        // pinned at 'building', so the grid would never be retried nor reported
        // failed. The guard must therefore cover the ray too, not just request().
        try {
          const ray = this.viewportRay((col + 0.5) / HIT_GRID_N, (row + 0.5) / HIT_GRID_N)
          pending.push(
            Promise.resolve(request({ space: viewer, offsetRay: ray }))
              .then((source) => source ?? null)
              .catch((e) => {
                this._gridError ??= e
                return null
              }),
          )
        } catch (e) {
          this._gridError ??= e
          pending.push(Promise.resolve(null))
        }
      }
    }

    const sources = (await Promise.all(pending)).filter(
      (s): s is XRHitTestSource => s != null,
    )

    // The session can end, or be replaced, while subscriptions are in flight.
    if (this.session !== session) {
      for (const source of sources) source.cancel()
      return
    }

    if (sources.length === 0) {
      this.failGrid('hit-test unavailable')
      return
    }

    // A partial grid still beats the single centre ray this replaced, so keep
    // it rather than disabling feature points — but retry the missing probes
    // instead of running the whole session silently degraded. Bounded, because
    // a runtime that caps concurrent hit-test sources would otherwise loop.
    if (sources.length < total && this._gridAttempts < MAX_GRID_ATTEMPTS) {
      this._gridAttempts++
      for (const source of sources) source.cancel()
      console.warn(
        `[webxr] ${sources.length}/${total} hit-test probes subscribed — retrying ` +
          `(attempt ${this._gridAttempts} of ${MAX_GRID_ATTEMPTS})`,
        this._gridError ?? '',
      )
      this._gridError = null
      this.hitTestGridState = 'idle'
      return
    }

    this.hitTestSources = sources
    this.hitTestGridState = 'ready'
    if (sources.length < total) {
      // Out of retries: usable but degraded, and the point cloud will fill more
      // slowly than the scanner's contract assumes. Say so with a cause.
      console.warn(
        `[webxr] running with ${sources.length}/${total} hit-test probes — ` +
          'point coverage will be reduced',
        this._gridError ?? '',
      )
    }
  }

  /** Records the cause alongside the failure, so 'disabled' is actionable. */
  private failGrid(reason: string): void {
    this.hitTestGridState = 'failed'
    this.hitTestSources = []
    console.warn(`[webxr] ${reason} — feature points disabled`, this._gridError ?? '')
  }

  /** Probes actually subscribed, out of the grid's full size. */
  get probeCoverage(): { subscribed: number; total: number } {
    return { subscribed: this.hitTestSources.length, total: HIT_GRID_N * HIT_GRID_N }
  }

  /** Append one sample to the xyz ring buffer, overwriting the oldest when full. */
  private pushHitPoint(x: number, y: number, z: number): void {
    const o = this._hitWrite * 3
    this._hitBuf[o] = x
    this._hitBuf[o + 1] = y
    this._hitBuf[o + 2] = z
    this._hitWrite = (this._hitWrite + 1) % MAX_RECENT_HIT_POINTS
    if (this._hitCount < MAX_RECENT_HIT_POINTS) this._hitCount++
  }

  featurePoints(_gridSize?: number): Array<{ x: number; y: number; z: number }> {
    // WebXR exposes no SLAM feature points; drain the per-frame probe-grid
    // hit-test samples instead (collected in the XR frame loop above).
    //
    // gridSize is advisory for this provider: the probe grid is subscribed once
    // per session (HIT_GRID_N above, matched to the scanner's default) because
    // XRHitTestSource subscriptions are async and persistent, so the density
    // cannot be renegotiated per call the way 8th Wall's synchronous probe does.
    const count = this._hitCount
    if (count === 0) return []
    // Oldest first, so the caller sees them in capture order.
    const start = (this._hitWrite - count + MAX_RECENT_HIT_POINTS) % MAX_RECENT_HIT_POINTS
    const out = new Array<{ x: number; y: number; z: number }>(count)
    for (let i = 0; i < count; i++) {
      const o = ((start + i) % MAX_RECENT_HIT_POINTS) * 3
      out[i] = { x: this._hitBuf[o], y: this._hitBuf[o + 1], z: this._hitBuf[o + 2] }
    }
    this._hitCount = 0
    this._hitWrite = 0
    return out
  }

  getPose(): Pose {
    return {
      position: { ...this.latestPose.position },
      rotation: { ...this.latestPose.rotation },
    }
  }

  isTracking(): boolean {
    // session !== null only means requestSession() resolved — the device has not
    // necessarily locked onto anything yet. _haveRealProjection flips true in the
    // frame loop once frame.getViewerPose() has returned a real pose with a usable
    // projection (see onXRFrame above), and stop() resets it — so it already tracks
    // "actually locked on" for its own purpose (aiming the hit-test probe grid).
    // Reuse it here instead of a second, looser notion of "tracking".
    return this.session !== null && this._haveRealProjection
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
