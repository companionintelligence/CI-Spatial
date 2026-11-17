/**
 * WebXR immersive-ar fallback provider.
 *
 * Used on Quest browser and devices where the 8th Wall binary is unavailable.
 * Camera images are captured via a companion getUserMedia() video stream since
 * raw XR camera access (camera-access feature) isn't widely supported yet.
 * Hit-testing uses the WebXR hit-test API.
 *
 * The companion stream is watched for staleness, not just presence: on some
 * devices (observed on a Lume Pad 2 / ARCore / Chrome 151) the getUserMedia
 * track and the XR session's own camera use can contend for the physical
 * camera, and the video element keeps reporting HAVE_CURRENT_DATA while
 * silently frozen on the last decoded frame. A capture is refused rather
 * than re-encoding that frame — see docs/factory/04-capture-path-truthfulness/
 * 0005-webxr-stale-camera-frame.md.
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
import type { ARProvider, BurstFrameListener, HitBurst, HitResult, Pose, RawFrame } from './provider'
import { collectBurst } from './hit-burst.ts'
import type { TrackingStatus } from './tracking-quality'
import {
  FrameEpochTracker,
  MAX_CAPTURE_POSE_AGE_MS,
  TRACKING_LOST_MESSAGE,
  type FrameDiscontinuity,
  type FrameDiscontinuityListener,
  type TrackingDiagnostics,
} from './frame-epoch.ts'
import type { ScaleKind, ScaleMode } from '../world/scale-mode'
import { DEFAULT_GRID_SIZE, DEFAULT_INTERVAL_MS as SCAN_INTERVAL_MS } from './scanner.ts'
import { imagePointToViewportPoint, type ImageHitTestContract, type ViewSize } from '../spatial/resolver.ts'
import { ANCHORS_FEATURE, createWebXRAnchors, type AnchorCapability, type WebXRAnchors } from './anchors.ts'
import { forwardAnchorEvents } from './anchor-epochs.ts'

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
 * How long one hitTestAsync() may wait for its XR frame. Once the session has ended
 * no frame callback runs, and the resolver awaits that promise, so it must not wait
 * forever.
 */
const HIT_TEST_TIMEOUT_MS = 1_000

/**
 * How long the companion camera stream's `currentTime` must stay frozen
 * before a capture is refused as stale. A live `getUserMedia` stream
 * perturbs `currentTime` every tick; a single stagnant sample could just be
 * two rAF ticks landing on the same decoded frame before the next one
 * arrives, so this requires stagnation across a margin of frames rather
 * than one — several hundred ms is unambiguous. See
 * docs/factory/04-capture-path-truthfulness/0005-webxr-stale-camera-frame.md.
 */
const VIDEO_STALL_THRESHOLD_MS = 500

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

export class WebXRProvider implements ARProvider, ImageHitTestContract {
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
  /** `videoEl.currentTime` as of the last frame it was observed to change. */
  private _videoLastCurrentTime = -1
  /** rAF timestamp (ms) `currentTime` was first seen frozen at, or null while it's advancing. */
  private _videoStalledSinceMs: number | null = null
  /** Guards against overlapping re-acquire attempts while one is already in flight. */
  private _recoveringStream = false
  /** The session's runtime anchors; null until a session opens, when the browser did not grant them, and after stop(). */
  private anchorTracker: WebXRAnchors | null = null
  /**
   * Decides what counts as a frame shift and numbers the stretches of tracking between
   * them (src/ar/frame-epoch.ts). WebXR says outright when the origin moves (the reference
   * space's `reset` event) and when it cannot place the viewer (no viewer pose); this is
   * where those become epochs.
   */
  private _epochs = new FrameEpochTracker({}, { deferNotify: true })
  /** Derived each frame from the viewer pose; see `trackingStatus()`. */
  private _xrStatus: TrackingStatus = 'UNKNOWN'
  /**
   * The frame time (ms) of the last viewer pose whose position was really tracked (not
   * emulated). Null before the first. `latestPose` is as old as this once the runtime stops
   * giving tracked poses, because it goes on giving the last one it had.
   */
  private _poseAtMs: number | null = null
  /** The frame time (ms) of the last XR frame seen, whatever it carried. Null before the first. */
  private _frameMs: number | null = null
  /** Whether the session was last seen `hidden`, so a return to view can be told from a first look. */
  private _sessionHidden = false
  /** When the session was last seen `hidden`, on the page clock (ms), so a return can say how long it was away. */
  private _hiddenAtMs: number | null = null
  /** Removes the listeners `_watchOrigin` added. */
  private _unwatch: Array<() => void> = []

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available')

    // requestSession() must run while the user gesture that triggered start()
    // is still active. Awaiting getUserMedia()'s permission prompt first burns
    // through that window, so requestSession() then rejects with
    // "SecurityError: ... requires user activation". Request the XR session
    // first, and set up the companion camera stream after.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      // local-floor isn't implicitly granted on every runtime (ARCore-backed
      // Chrome in particular) — omitting it here made Three.js's own internal
      // reference-space request in renderer.xr.setSession() below throw
      // NotSupportedError even though this provider's own fallback logic
      // (session.requestReferenceSpace in setUpSession) never got a chance
      // to run. Listing it as optional, not required, keeps runtimes that
      // truly lack floor-relative tracking working via the 'local' fallback.
      optionalFeatures: ['dom-overlay', 'local-floor', ANCHORS_FEATURE],
      // 'anchors' is optional on purpose: a browser that does not know it ignores it (WebXR Device API), so a session
      // without anchors starts exactly as before. Whether it was granted is read back in createWebXRAnchors().
      // Without an explicit root the dom-overlay feature never activates and
      // the entire HTML UI is invisible inside the immersive session
      // (HelloXR on iOS, Quest browser).
      domOverlay: { root: document.body },
    })
    this.session = session
    this.anchorTracker = createWebXRAnchors(session)
    // What an anchor reports (a step, a handle given up) is a frame discontinuity, and the tracker numbers it like any other, or
    // adds it to the one it belongs to. The capability drops these listeners itself when the session ends.
    if (this.anchorTracker) {
      forwardAnchorEvents(this.anchorTracker, this._epochs, {
        onShift: (shift) => this._noteFrameShift(shift),
        log: (...args) => console.log('[webxr]', ...args),
      })
    }
    // The browser can end an immersive session without asking us: the user leaves AR,
    // or the runtime takes the display back. Nothing else here hears that.
    session.addEventListener('end', () => this.onSessionEnd(session))

    try {
      await this.setUpSession(canvas)
    } catch (e) {
      // A failed setup must not leave an immersive view and a live camera behind the error.
      this.stop()
      throw e
    }
  }

  /** Everything after the XR session exists: the companion camera, the renderer and the frame loop. */
  private async setUpSession(canvas: HTMLCanvasElement): Promise<void> {
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
    // The session can end while the camera prompt is open. See liveSession().
    this.liveSession()

    const gl = canvas.getContext('webgl2', { xrCompatible: true }) as WebGL2RenderingContext

    // renderer.xr.setSession() below creates and installs its own XRWebGLLayer
    // via session.updateRenderState() internally — no separate call needed here.
    const renderer = new THREE.WebGLRenderer({ context: gl, canvas })
    this.renderer = renderer
    renderer.autoClear = false // never blank the camera passthrough
    renderer.xr.enabled = true
    // Three.js's WebXRManager requests its own reference space internally as
    // part of setSession() — separately from this.refSpace below, which
    // drives the decal camera pose. Its default type is 'local', which
    // NotSupportedError's on runtimes that only granted 'local-floor' (or
    // neither) as an optional feature above. Mirror the same
    // local-floor-then-local fallback this provider already uses for
    // this.refSpace so both requests agree on what the runtime actually
    // supports.
    renderer.xr.setReferenceSpaceType('local-floor')
    try {
      await renderer.xr.setSession(this.liveSession())
    } catch {
      renderer.xr.setReferenceSpaceType('local')
      await renderer.xr.setSession(this.liveSession())
    }
    const session = this.liveSession()
    this.scene = new THREE.Scene()
    this.decalCamera = new THREE.PerspectiveCamera()

    const [localFloor, viewer] = await Promise.all([
      session.requestReferenceSpace('local-floor').catch(() =>
        session.requestReferenceSpace('local'),
      ),
      session.requestReferenceSpace('viewer'),
    ])
    this.liveSession()
    this.refSpace = localFloor
    this.viewerSpace = viewer
    this._watchOrigin(session, [localFloor, viewer])

    // Only the *aiming* is deferred to the first frame — the grid is pointed
    // with _fovY/_aspect, which are not real until a viewer pose has been read.
    // Availability is still reported here, so a runtime with no hit-test support
    // says so during startup rather than a frame later, interleaved with the
    // frame loop's output.
    if (typeof session.requestHitTestSource !== 'function') {
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

      // Companion camera-stream liveness. readyState alone cannot tell a live
      // frame from a corpse: it stays at HAVE_CURRENT_DATA (2) or above for a
      // stream that has stopped advancing, which is exactly what let
      // drawImage() below keep re-encoding the same frozen frame forever (see
      // docs/factory/04-capture-path-truthfulness/0005). currentTime on a
      // MediaStream-backed <video> only moves while the source is actually
      // delivering samples, so tracking whether it has moved since the last
      // tick is a direct, cheap signal of whether the feed is still alive.
      if (self.videoEl && self.videoEl.readyState >= 2) {
        if (self.videoEl.currentTime !== self._videoLastCurrentTime) {
          self._videoLastCurrentTime = self.videoEl.currentTime
          self._videoStalledSinceMs = null
        } else if (self._videoStalledSinceMs === null) {
          self._videoStalledSinceMs = time
        }
      }

      // Update pose. Until the reference space exists there is no pose to read.
      const refSpace = self.refSpace
      const viewerPose = refSpace ? frame.getViewerPose(refSpace) : undefined
      // Before anything below reads this frame's points: a discontinuity here drops the
      // probe hits not yet handed over, which belong to the epoch before it.
      if (refSpace) self._observeViewerPose(viewerPose, time)
      // Anchors make and read themselves inside this frame (the runtime refuses to create one in any other). What they report is
      // a discontinuity too, so it comes before this frame's probe hits and its capture are stamped with an epoch.
      self.anchorTracker?.onFrame(frame, refSpace, time)
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

      // The frame's pose and its probe hits are all in; whoever listens for a discontinuity
      // finds the epoch, the pose and the hits of one frame.
      self._epochs.flush()

      // A tracked viewer pose that has not existed for a while leaves latestPose old, and a
      // capture stamped with it is placed where the camera no longer is. Refuse it, plainly.
      if (self.captureQueue.length > 0 && self._poseTooOldForCapture(time)) {
        for (const pending of self.captureQueue.splice(0)) {
          clearTimeout(pending.timeout)
          pending.reject(new Error(TRACKING_LOST_MESSAGE))
        }
      }

      // Resolve pending captureFrame() calls
      if (self.captureQueue.length > 0 && self.videoEl && self.videoEl.readyState >= 2) {
        const stalled = self._videoStalledSinceMs !== null &&
          time - self._videoStalledSinceMs >= VIDEO_STALL_THRESHOLD_MS
        if (stalled) {
          // readyState still says HAVE_CURRENT_DATA, but currentTime has been
          // frozen past the margin above — the frame drawImage() would produce
          // is the same corpse every caller has already been handed. Refuse
          // it rather than re-encode it again: a rejected capture never
          // reaches the store (main.ts only persists after capture.capture()
          // resolves), so nothing downstream can mistake it for a real one.
          const queue = self.captureQueue.splice(0)
          queue.forEach((pending) => {
            clearTimeout(pending.timeout)
            pending.reject(new Error('Camera stream stalled — restart the scan'))
          })
          // Best-effort recovery in the background — see attemptStreamRecovery().
          // If it succeeds, the next capture attempt just works; if it fails
          // or the platform can't safely re-acquire, the rejection above
          // already told the user the truth.
          void self.attemptStreamRecovery()
        } else {
          const w = self.videoEl.videoWidth
          const h = self.videoEl.videoHeight
          if (!self.offscreen || self.offscreen.width !== w || self.offscreen.height !== h) {
            self.offscreen = new OffscreenCanvas(w, h)
            self.offCtx = self.offscreen.getContext('2d')
          }
          const offCtx = self.offCtx
          if (offCtx) {
            offCtx.drawImage(self.videoEl, 0, 0)
            const imageData = offCtx.getImageData(0, 0, w, h)
            const frame_: RawFrame = {
              pixels: imageData.data,
              width: w,
              height: h,
              pose: { ...self.latestPose, position: { ...self.latestPose.position } },
              timestamp: time,
              epoch: self._epochs.epoch,
            }
            const queue = self.captureQueue.splice(0)
            queue.forEach((pending) => {
              clearTimeout(pending.timeout)
              pending.resolve(frame_)
            })
          } else {
            // No 2-D context to draw into. Fail the waiting captures now, rather than
            // throw out of the frame loop.
            const queue = self.captureQueue.splice(0)
            queue.forEach((pending) => {
              clearTimeout(pending.timeout)
              pending.reject(new Error('Camera frame unavailable — restart the scan'))
            })
          }
        }
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

    renderer.setAnimationLoop(onXRFrame)
  }

  /**
   * The live XR session, or a throw once it has ended. stop() nulls `this.session`,
   * and the session can end while any await in setUpSession() is pending, so setup
   * checks after each await. A camera stream that arrived after the teardown is
   * released here, because stop() never saw it.
   */
  private liveSession(): XRSession {
    if (!this.session) {
      this.videoStream?.getTracks().forEach((t) => t.stop())
      this.videoStream = null
      throw new Error('AR session ended during setup — try again')
    }
    return this.session
  }

  stop(): void {
    this.renderer?.setAnimationLoop(null)
    // No frame loop runs after teardown, so a capture still waiting would only
    // sit until its timer fired. Fail it now.
    for (const pending of this.captureQueue.splice(0)) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('AR session ended — restart the scan'))
    }
    for (const source of this.hitTestSources) source.cancel()
    this.anchorTracker?.dispose()
    this.anchorTracker = null
    const renderer = this.renderer
    // start() creates a fresh WebGLRenderer against the same canvas/context
    // on every call (getContext() returns the same WebGL2RenderingContext for
    // a given canvas), so an undisposed renderer's compiled programs and
    // buffers pile up in that shared context across repeated start()/stop()
    // cycles in one page lifetime instead of being freed. Disposed once
    // end() settles (not synchronously here) so the compositor has actually
    // released the session before its GPU resources are torn down — end()'s
    // rejection (e.g. a session already ending elsewhere) is swallowed since
    // teardown should proceed regardless of how it settles.
    const endPromise = this.session?.end().catch(() => {})
    if (endPromise) void endPromise.then(() => renderer?.dispose())
    else renderer?.dispose()
    this.videoStream?.getTracks().forEach((t) => t.stop())
    this.session = null
    this.hitTestSources = []
    this.hitTestGridState = 'idle'
    this._haveRealProjection = false
    this._gridAttempts = 0
    this._gridError = null
    this._hitWrite = 0
    this._hitCount = 0
    this._videoLastCurrentTime = -1
    this._videoStalledSinceMs = null
    this._recoveringStream = false
    for (const unwatch of this._unwatch.splice(0)) unwatch()
    // A later start() is a new session and a new map: the next pose starts a new epoch.
    this._epochs.noteSessionEnd()
    this._xrStatus = 'UNKNOWN'
    this._poseAtMs = null
    this._frameMs = null
    this._sessionHidden = false
    this._hiddenAtMs = null
    this.videoStream = null
    this.viewerSpace = null
    this.renderer = null
    this.scene = null
    this.decalCamera = null
  }

  /**
   * The browser ended this session. Captures waiting on a frame that will not come
   * are failed with a plain reason, and the provider is torn down. A session that
   * stop() has already replaced is ignored: its late 'end' is not news.
   */
  private onSessionEnd(session: XRSession): void {
    if (this.session !== session) return
    // stop() fails the captures still waiting, so tearing down is all that is left.
    this.stop()
  }

  getScene(): THREE.Scene | null {
    return this.scene
  }

  /**
   * Runtime anchors: there when the browser granted the 'anchors' feature, or cannot say (no enabledFeatures before
   * Chrome 111), in which case it turns itself off at the first frame that shows the API is missing. Undefined otherwise.
   */
  get anchors(): AnchorCapability | undefined {
    return this.anchorTracker?.usable ? this.anchorTracker : undefined
  }

  /**
   * Best-effort re-acquire of the companion camera stream after a detected
   * stall, without ending the immersive-ar session. Whether this can
   * succeed while ARCore (or another XR runtime) holds the camera exclusively
   * is unconfirmed — see the ticket's second open question — so failure here
   * is expected on some devices and is not itself an error: the caller has
   * already rejected the in-flight capture with an honest message, so a
   * failed recovery just means the *next* capture attempt fails the same way
   * until the user restarts the scan, rather than the app silently hanging.
   */
  private async attemptStreamRecovery(): Promise<void> {
    if (this._recoveringStream || !this.session) return
    this._recoveringStream = true
    try {
      // Stop the stalled tracks before requesting a new stream — the same
      // teardown stop() uses below, reused here so the old, no-longer-
      // delivering tracks aren't still open (and possibly still holding the
      // device) while a fresh request goes out.
      this.videoStream?.getTracks().forEach((t) => t.stop())
      this.videoStream = null

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })

      // stop() may have run (session ended) while getUserMedia() was pending.
      if (!this.session) {
        newStream.getTracks().forEach((t) => t.stop())
        return
      }

      this.videoStream = newStream
      if (!this.videoEl) this.videoEl = document.createElement('video')
      this.videoEl.srcObject = newStream
      this.videoEl.playsInline = true
      this.videoEl.muted = true
      await this.videoEl.play()

      // Give the fresh stream a clean liveness baseline rather than judging
      // it against currentTime readings from the stream it replaced.
      this._videoLastCurrentTime = -1
      this._videoStalledSinceMs = null
      console.info('[webxr] camera stream re-acquired after a detected stall')
    } catch (e) {
      console.warn(
        '[webxr] camera stream recovery failed — captures will keep failing until the scan is restarted:',
        e,
      )
    } finally {
      this._recoveringStream = false
    }
  }

  captureFrame(timeoutMs = 4000): Promise<RawFrame> {
    if (this.captureQueue.length > 0) {
      return Promise.reject(new Error('Capture already pending'))
    }
    // With no session there is no frame loop, so no frame can arrive. Fail now
    // rather than after the timeout, which main.ts sets to 8 s.
    if (!this.session) {
      return Promise.reject(new Error('No AR session. Start the scan first.'))
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

  /**
   * WebXR has no per-frame status like 8th Wall's `trackingStatus`, so this is derived from
   * the two things it does say about the viewer, one frame at a time:
   *
   *  - no viewer pose (`getViewerPose()` answered null) is `'NOT_AVAILABLE'`. The spec has
   *    it answer null only while no pose has ever been determined (the session is still
   *    establishing tracking): once one has, it answers the last known pose with
   *    `emulatedPosition` true (section 5.1 calls "populate the pose" with force emulation
   *    on), so a null is "nothing to record against yet", not "tracking was lost";
   *  - a pose whose position is emulated (`XRPose.emulatedPosition`: estimated rather than
   *    read from sensors, and drifting) is `'LIMITED'`. This is how the spec reports a
   *    tracking loss after the first pose, and the same frame's pose is the last known one;
   *  - any other pose is `'NORMAL'`.
   *
   * `'UNKNOWN'` until the first frame has been read. That `emulatedPosition` is true
   * during a real tracking loss on Chrome with ARCore, or on a Quest, is not confirmed
   * (spec: it is what the flag means; whether a given runtime sets it, or ends the frames
   * instead, is for a device run, DX6). `trackingIsUsable()` stops recording geometry on
   * `'LIMITED'` and `'NOT_AVAILABLE'`.
   */
  trackingStatus(): TrackingStatus {
    return this._xrStatus
  }

  getTrackingDiagnostics(): TrackingDiagnostics {
    // How old the tracked pose a capture would carry is, as of the last frame: 0 while the
    // runtime tracks, growing while it answers with emulated poses or none.
    const poseAgeMs = this._poseAtMs !== null && this._frameMs !== null
      ? Math.max(0, this._frameMs - this._poseAtMs)
      : undefined
    return { ...this._epochs.diagnostics(), ...(poseAgeMs !== undefined ? { poseAgeMs } : {}) }
  }

  getFrameEpoch(): number {
    return this._epochs.epoch
  }

  onFrameDiscontinuity(cb: FrameDiscontinuityListener): () => void {
    return this._epochs.subscribe(cb)
  }

  /**
   * Read this frame's viewer pose into the tracker. Called once per XR frame, before the
   * frame's hit-test samples are taken.
   */
  private _observeViewerPose(viewerPose: XRViewerPose | null | undefined, tMs: number): void {
    const status: TrackingStatus = !viewerPose ? 'NOT_AVAILABLE' : viewerPose.emulatedPosition ? 'LIMITED' : 'NORMAL'
    // Logged on every change, so a device run (?debug=remote relays the console) can count how
    // often a runtime answers with no pose, or with an emulated one, and how long for.
    if (status !== this._xrStatus) console.log('[webxr] trackingStatus:', status)
    this._xrStatus = status
    const transform = viewerPose?.transform
    const pose: Pose | null = transform
      ? {
          position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
          rotation: { x: transform.orientation.x, y: transform.orientation.y, z: transform.orientation.z, w: transform.orientation.w },
        }
      : null
    const shift = this._epochs.observe({ tMs, pose, status })
    if (shift) this._noteFrameShift(shift)
    this._frameMs = tMs
    // Only a tracked pose is a fresh one. An emulated pose is the last known position again
    // (the spec's way of answering after a loss), so counting it would keep `latestPose`
    // looking current for as long as the runtime keeps answering.
    if (viewerPose && !viewerPose.emulatedPosition) this._poseAtMs = tMs
  }

  /**
   * Whether the viewer pose in `latestPose` is too old to stamp onto a capture: no tracked
   * pose (none at all, or only emulated ones) for longer than the bound.
   */
  private _poseTooOldForCapture(tMs: number): boolean {
    return this._poseAtMs !== null && tMs - this._poseAtMs > MAX_CAPTURE_POSE_AGE_MS
  }

  /**
   * A discontinuity began a new epoch. The probe hits sampled since the last drain were taken
   * in the epoch before it, and the drain stamps whatever epoch is current, so they are
   * dropped rather than stamped with the wrong one. The anchors that can be located are
   * rebased: an epoch starts their drift count again, whoever began it.
   */
  private _noteFrameShift(shift: FrameDiscontinuity): void {
    this._hitCount = 0
    this._hitWrite = 0
    this.anchorTracker?.rebaseLocated()
    console.warn(`[webxr] frame discontinuity ${shift.epoch}: ${shift.cause}`, JSON.stringify(shift))
  }

  /**
   * Listen for the two things WebXR says about the origin. A reference space fires `reset`
   * when its origin moves, with the move in `transform` when the runtime can say what it
   * was (null when it cannot); the spec has it dispatched before the first frame that uses
   * the new origin. The session fires `visibilitychange`, and a return from `hidden` is a
   * resume. The spec does not let a hidden session report poses, so nothing was read while
   * it was away; that the origin moves in that time is not something the spec says, and is
   * not confirmed on a device (DX6), so a resume is suspect and not measured.
   */
  private _watchOrigin(session: XRSession, spaces: XRReferenceSpace[]): void {
    const onReset = (event: Event): void => {
      if (this.session !== session) return
      const t = (event as XRReferenceSpaceEvent).transform
      const shift = this._epochs.noteReset(
        performance.now(),
        t
          ? {
              position: { x: t.position.x, y: t.position.y, z: t.position.z },
              orientation: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w },
            }
          : null,
      )
      if (shift) this._noteFrameShift(shift)
      this._epochs.flush()
    }
    for (const space of spaces) {
      // A space is an EventTarget. The guard is for a runtime stand-in that is not one,
      // which has no reset to hear.
      space.addEventListener?.('reset', onReset)
      this._unwatch.push(() => space.removeEventListener?.('reset', onReset))
    }

    const onVisibility = (): void => {
      if (this.session !== session) return
      if (session.visibilityState === 'hidden') {
        if (!this._sessionHidden) this._hiddenAtMs = performance.now()
        this._sessionHidden = true
      } else if (this._sessionHidden) {
        this._sessionHidden = false
        const away = this._hiddenAtMs === null ? undefined : performance.now() - this._hiddenAtMs
        this._hiddenAtMs = null
        // No frame came while it was hidden, so an anchor that was away before it was is not given up for that time.
        this.anchorTracker?.noteResumed()
        const shift = this._epochs.noteResume(performance.now(), away)
        if (shift) this._noteFrameShift(shift)
        this._epochs.flush()
      }
    }
    this._sessionHidden = session.visibilityState === 'hidden'
    this._hiddenAtMs = this._sessionHidden ? performance.now() : null
    session.addEventListener('visibilitychange', onVisibility)
    this._unwatch.push(() => session.removeEventListener('visibilitychange', onVisibility))
  }

  getCameraFovY(): number {
    return this._fovY
  }

  getCameraAspect(): number {
    return this._aspect
  }

  /**
   * `'metric'`: WebXR defines positions in metres (https://immersive-web.github.io/webxr/, the
   * XRRigidTransform section), so this unit is one by contract from the first frame. That is the
   * runtime's claim, not a measurement made here: device experiment DX1 puts it beside the 8th Wall
   * modes on one phone with a tape.
   */
  scaleKind(): ScaleKind {
    return 'metric'
  }

  /** True: there is no estimate to wait for. */
  scaleReady(): boolean {
    return true
  }

  scaleMode(): ScaleMode {
    return 'webxr-metric'
  }

  /**
   * WebXR's projection describes the whole viewport (see `getCameraAspect()`), so a
   * point on the captured frame is placed by the window cover-crop. That is the
   * mapping the resolver uses for a provider with no contract, kept here as this
   * provider's own.
   */
  imagePointToHitTestPoint(
    x: number,
    y: number,
    imageSize: ViewSize | undefined,
    viewportSize: ViewSize | undefined,
  ): { x: number; y: number } {
    return imagePointToViewportPoint(x, y, imageSize, viewportSize)
  }

  hitTest(x: number, y: number): HitResult | null {
    // WebXR hit-test results can only be read inside an XR frame callback
    // (frame.getHitTestResults), so the synchronous half of the ARProvider
    // contract cannot be satisfied here: this ALWAYS returns null, for every
    // coordinate. It does not fall back to the last frame or to the screen
    // centre — nothing is cached for that.
    //
    // Callers that need a real result use hitTestAsync() below. src/main.ts
    // wires it up as `asyncHitTest` for both consumers that matter: the
    // spatial resolver (src/spatial/resolver.ts) and the two-point
    // calibration flow (src/ar/project-calibration.ts).
    void x; void y
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
      let settled = false
      const finish = (result: HitResult | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish(null), HIT_TEST_TIMEOUT_MS)
      const ray = this.viewportRay(x, y)
      const sessionAny = session as any
      if (typeof sessionAny.requestHitTestSource === 'function') {
        sessionAny.requestHitTestSource({ space: this.viewerSpace!, offsetRay: ray })
          .then((source: any) => {
            session.requestAnimationFrame((_time, frame) => {
              const results = frame.getHitTestResults(source)
              source.cancel()
              if (!results.length) { finish(null); return }
              const pose = results[0].getPose(this.refSpace!)
              if (!pose) { finish(null); return }
              const { position: p, orientation: q } = pose.transform
              const cp = this.latestPose.position
              finish({
                position: { x: p.x, y: p.y, z: p.z },
                rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
                distance: Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z),
              })
            })
          })
          .catch(() => finish(null))
      } else {
        finish(null)
      }
    })
  }

  /**
   * ONE hit-test source, read on every XR frame for `windowMs`, so a tap can be read as a median
   * (./tap-sampling.ts). `hitTestAsync()` above opens a source, reads one frame and cancels it, which is a
   * subscription round trip per sample and cannot be repeated inside a short window.
   *
   * The source is cancelled when the window closes, when the session ends (the 'end' event), and by a watchdog
   * if frames stop coming, and a source that arrives after the burst was closed is cancelled on arrival
   * (./hit-burst.ts runs the release once, whichever way out is taken).
   *
   * WebXR publishes no tracking status, so a frame with a viewer pose says `'UNKNOWN'`. A frame with none is the
   * one signal it gives that the device could not be located, so it says `'NOT_AVAILABLE'`, which `sampleTap()`
   * refuses; it has no hit either, because there is nothing to measure its range from. How the viewer pose
   * steps from frame to frame is read there too, so a map that shifts inside the window is refused.
   */
  hitTestBurstAsync(x: number, y: number, windowMs: number, onFrame?: BurstFrameListener): Promise<HitBurst> {
    const session = this.session
    const viewer = this.viewerSpace
    const space = this.refSpace
    if (!session || !viewer || !space || typeof session.requestHitTestSource !== 'function') {
      return Promise.resolve({ frames: [] })
    }
    return collectBurst(windowMs, HIT_TEST_TIMEOUT_MS, (run) => {
      // Nothing is open until this has returned a request: a throw before then leaves nothing behind.
      const request = session.requestHitTestSource!({ space: viewer, offsetRay: this.viewportRay(x, y) })
      if (!request) throw new Error('hit-test source unavailable')
      let source: XRHitTestSource | null = null
      const next = (): void => {
        try {
          session.requestAnimationFrame(onXrFrame)
        } catch {
          run.finish() // the session ended before its 'end' event reached us
        }
      }
      const onXrFrame = (time: number, frame: XRFrame): void => {
        if (run.done || !source) return
        const camera = frame.getViewerPose(space)?.transform
        const at = frame.getHitTestResults(source)[0]?.getPose(space)?.transform
        run.frame({
          hit: camera && at
            ? {
              position: { x: at.position.x, y: at.position.y, z: at.position.z },
              rotation: { x: at.orientation.x, y: at.orientation.y, z: at.orientation.z, w: at.orientation.w },
              distance: Math.hypot(at.position.x - camera.position.x, at.position.y - camera.position.y, at.position.z - camera.position.z),
            }
            : null,
          pose: camera
            ? {
              position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
              rotation: { x: camera.orientation.x, y: camera.orientation.y, z: camera.orientation.z, w: camera.orientation.w },
            }
            : undefined,
          status: camera ? 'UNKNOWN' : 'NOT_AVAILABLE',
        }, time)
        if (!run.done) next()
      }
      session.addEventListener('end', run.finish)
      void request.then((s) => {
        if (run.done) s.cancel()
        else {
          source = s
          next()
        }
      }, run.finish)
      return () => {
        session.removeEventListener('end', run.finish)
        source?.cancel()
      }
    }, { onFrame })
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
