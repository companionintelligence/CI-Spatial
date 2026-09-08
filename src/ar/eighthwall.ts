/**
 * 8th Wall / Niantic Spatial XR Engine provider.
 *
 * **Not open source**, despite what this comment said until 2026-08-25. The
 * binary is free and needs no API key, but the licence header at the top of
 * `public/xr.js` is the "XR ENGINE LICENSE AGREEMENT" — a limited,
 * revocable, non-sublicensable grant that forbids modifying or redistributing
 * the Software other than in its original form, and (§1.2) forbids use "in
 * connection with any product or service: (1) which is offered for a fee or
 * other consideration, and (2) whose value derives, entirely or
 * substantially, from the functionality of the Software". Read that clause
 * before assuming this file may ship in a paid product.
 *
 * Prerequisites:
 *   1. Download the engine binary from https://8th.io/xrjs
 *   2. Unzip and place xr.js (and any chunks) into public/
 *   3. index.html must load it:
 *        <script async src="/xr.js" data-preload-chunks="slam"></script>
 *
 * The XR8 global is populated by the script above.  We listen for the
 * 'xrloaded' event before calling start().
 *
 * Also loads XR8.Threejs.pipelineModule() alongside the SLAM/camera-feed
 * modules — not for scene rendering (GlTextureRenderer already draws the
 * camera feed directly to canvas), but to get a live, world-locked
 * THREE.Scene (via getScene()) that the calibration decal can be added to.
 * This exact combination (GlTextureRenderer + Threejs together) is proven
 * working in ar-hittest-sphere.html, the diagnostic this provider's
 * hit-test path was originally cross-checked against — including that
 * diagnostic's `window.THREE = THREE` assignment, which XR8.Threejs requires
 * and which start() therefore makes before adding the modules. #141 ported
 * the modules without it, and the omission stopped the 8th Wall scanner
 * starting a session at all until 2026-08-23.
 */
import * as THREE from 'three'
import type { ARProvider, HitResult, Pose, RawFrame } from './provider'
import type { TrackingStatus } from './tracking-quality'
import { FIRST_POSE_TIMEOUT_MS, firstFrameVerdict, type PreflightVerdict } from './preflight'

type Point3 = { x: number; y: number; z: number }

const MIN_POINT_DISTANCE_M = 0.08

/**
 * Farthest a SLAM feature may be from the camera and still be recorded.
 *
 * Was 50m, which is an outdoor number and is what set every indoor scan's
 * bounding box. SLAM depth comes from triangulating a feature across frames, so
 * its error grows with range against the baseline the camera actually travelled
 * — and this app's main rig is a gimbal that ROTATES IN PLACE, giving a baseline
 * near zero. Far-field depth is then guesswork, and the guesses pile up against
 * whatever ceiling this constant sets.
 *
 * Measured on a real 21-position gimbal dome of one room (2026-08-27), by
 * distance from each point to the nearest recorded camera pose:
 *
 *     cap    kept          extent (w x h x d)
 *      50m   6377 (100%)   61.0 x 49.6 x 54.3 m      <- outdoor cap, absurd for a room
 *      20m   5898 (92.5%)  23.8 x 12.0 x 25.0 m
 *      12m   5531 (86.7%)  15.9 x 11.0 x 15.0 m      <- here
 *      10m   5362 (84.1%)  12.8 x 11.0 x 12.8 m
 *       8m   5041 (79.0%)  10.9 x  8.4 x 10.4 m
 *
 * 12m keeps the large majority of points while bringing the cloud back to room
 * scale. That matters beyond tidiness: the bounding box is what splat-align and
 * COLMAP key their metric fit off, so a 61m box makes the whole reconstruction's
 * scale wrong by an order of magnitude while still looking plausible in the
 * viewer. Headroom above a typical room is deliberate — a view down a hallway or
 * through a doorway is real geometry worth keeping.
 *
 * This does NOT manufacture parallax; it only stops unreliable far-field points
 * from setting the scale. A capture that needs true far geometry needs the rig
 * to translate between stations.
 */
const MAX_POINT_DISTANCE_M = 12

/**
 * Camera translation between consecutive frames above which the pose is read
 * as a **frame shift**, not as motion, in metres.
 *
 * SLAM refines its map as it goes and can redefine its own origin — on
 * recovery from lost tracking, or when a loop closes. Every world-locked
 * object then appears to jump together, and any points already harvested are
 * expressed in a frame that no longer exists. That is invisible from inside
 * the app: the pose keeps updating and tracking still reports NORMAL.
 *
 * 0.30 m at roughly 30 fps is ~9 m/s. Nobody walks a survey at that speed
 * while holding a tablet, so anything over it is the map moving rather than
 * the operator.
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 closed unrun.
 *
 * **Revisit when:** a genuinely fast pan is counted as a shift (lower the
 * frame rate assumption, or gate on tracking status too), or a shift small
 * enough to matter slips under it.
 */
const POSE_JUMP_THRESHOLD_M = 0.30

/** How long start() waits for /xr.js before giving up with a real error. */
const XR_LOAD_TIMEOUT_MS = 10_000

/**
 * How the camera frame is mapped onto the canvas.
 *
 * `contain` sizes the canvas to the CAMERA's aspect and centres it, so the
 * whole sensor frame is on screen with bars on two sides. `cover` sizes the
 * canvas to the viewport and lets the engine crop the frame to fill it — the
 * full-bleed look, and what this file did unconditionally before 2026-08-25.
 *
 * `contain` is the default because it collapses two camera models into one.
 * The projection matrix the engine publishes is built for the CANVAS rect (see
 * `_fitCanvas` for the chain), so with canvas aspect == camera aspect nothing
 * is cropped and that projection describes exactly the frame `captureFrame()`
 * uploads. Under `cover` the two diverge as soon as the viewport is WIDER than
 * the camera — a phone lying in a landscape gimbal cradle, which is this app's
 * main scanning rig. The display then crops top and bottom, `_fovY` measures
 * that cropped frustum, and `KeyframeStreamer` stamps it into every keyframe as
 * the lens of an image that was never cropped. `deriveIntrinsics()` in
 * `server/splat/splat_train_dataset.ts` turns it into fl_x/fl_y and the
 * reconstruction bends geometry to fit a lens the camera does not have.
 */
type CameraFit = 'contain' | 'cover'

/**
 * `?camerafit=cover` restores the pre-2026-08-25 full-bleed mapping.
 *
 * It exists so the letterbox can be compared against full-bleed on the actual
 * phone without a rebuild — the whole of this fit change is reasoned from
 * public/xr.js and three.js sources, not from a device. Prefer `contain`: see
 * the `CameraFit` note for what `cover` costs the keyframe intrinsics.
 */
function resolveCameraFit(): CameraFit {
  return new URLSearchParams(window.location.search).get('camerafit') === 'cover'
    ? 'cover'
    : 'contain'
}

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
    xrScene(): { scene: THREE.Scene; camera: THREE.Camera; renderer: THREE.WebGLRenderer }
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
  private _scene: THREE.Scene | null = null
  private _latestWorldPoints: Array<{ x: number; y: number; z: number }> = []
  private _lastTrackingStatus = ''
  private _poseJumps = 0
  private _lastJumpM = 0
  private _diagLogged = false
  /**
   * Preflight subscriber and the state its verdict is made from.
   *
   * `_cameraStreamMs` is when getUserMedia actually handed us a stream, and it
   * — not `start()` — is what the pose grace window is measured from;
   * `_preflightRuled` records that the timer has already fired, so the only
   * thing that can speak after it is a late pose taking a warning back (see
   * `_emitPreflight`).
   *
   * The anchor moved because the old one measured the wrong thing. Timed on an
   * XREAL Beam Pro (2026-08-29 20:23, scans/client-logs.jsonl): `requesting` at
   * +0.0 s and `hasStream` 713 s later, because Chrome's camera permission
   * prompt was sitting on screen the whole time. The 5 s timer fired at +5 s
   * against a session that had no camera yet, `firstFrameVerdict()` saw
   * `sawCameraFrame: false` past the window and returned `'unavailable'` —
   * "This device cannot run the live scanner" — and then, 474 ms after the
   * stream finally arrived, the same device reported `trackingStatus: NORMAL`
   * and a first pose. The device was never the problem; the clock was.
   */
  private _onPreflight: ((verdict: PreflightVerdict) => void) | null = null
  private _cameraStreamMs: number | null = null
  private _preflightRuled = false
  private _poseRulingTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Camera vertical field-of-view in degrees, read from the projection matrix
   * the SLAM engine publishes each frame (`_syncReality()` below). 60 is only
   * the value before the first frame lands.
   *
   * It matters downstream: `KeyframeStreamer` stamps this into every keyframe's
   * `intrinsics.fovYDeg`, and `deriveIntrinsics()` in
   * `server/splat/splat_train_dataset.ts` turns it into the `fl_x`/`fl_y` of
   * the Brush training dataset. The engine builds that projection for the
   * CANVAS rect, so this describes the uploaded keyframe only while the canvas
   * crops nothing — which is what the `contain` fit guarantees.
   */
  private _fovY = 60
  /**
   * Aspect (width/height) implied by the engine's projection matrix, or null
   * until a frame supplies one.
   *
   * This tracks the CANVAS, not the sensor: the engine derives the projection
   * from `cam.pixelRect*`, which is the canvas size (see `_fitCanvas`). Kept as
   * a cross-check that `_aspect` and the engine agree — if these two ever drift
   * apart, the render and the pose intrinsics are describing different lenses.
   */
  private _cameraAspect: number | null = null
  /** Canvas (drawing-buffer) aspect ratio — what `getCameraAspect()` returns. */
  private _aspect = 9 / 16
  /** How the frame is mapped onto the canvas; see `CameraFit`. */
  private _fit: CameraFit = resolveCameraFit()
  /**
   * Camera frame size as the ENGINE sees it, from its own `videoWidth`/
   * `videoHeight` hook arguments. 0 until the first frame.
   *
   * Deliberately the engine's numbers and not `track.getSettings()`: xr.js fits
   * the camera texture to the canvas with exactly this pair (`yg()` in
   * public/xr.js), so sizing the canvas from the same pair cannot disagree with
   * the engine about which way round the frame is. Browsers differ on whether a
   * portrait device reports rotated or sensor-native track dimensions; this
   * sidesteps the question entirely.
   */
  private _videoW = 0
  private _videoH = 0
  /** CSS box we last claimed on the canvas, as `style.width`/`style.height`. */
  private _cssWidth = ''
  private _cssHeight = ''
  /** Viewport-change listener, held so `stop()` can remove it. */
  private _onViewportChange: (() => void) | null = null
  /** The canvas `start()` was given, so `stop()` can release its inline size. */
  private _canvas: HTMLCanvasElement | null = null

  private _syncReality(source: unknown, label: string, canvas: HTMLCanvasElement): void {
    const reality = findRealityObject(source)
    if (!reality) return

    if (!this._diagLogged) {
      this._diagLogged = true
      console.log(`[8thwall] ${label} reality keys:`, JSON.stringify(Object.keys(reality)))
    }

    const pose = poseFromReality(reality)
    if (!pose) return

    // Frame-shift detection, before latestPose is overwritten. A discontinuity
    // here is the map redefining its origin, not the operator moving — see
    // POSE_JUMP_THRESHOLD_M. Counted rather than logged so the number can be
    // put on screen, which is the only way it reaches anyone holding the
    // device.
    if (this._slamReady) {
      const moved = poseDistance(pose.position, this.latestPose.position)
      if (Number.isFinite(moved) && moved > POSE_JUMP_THRESHOLD_M) {
        this._poseJumps++
        this._lastJumpM = moved
        console.warn(`[8thwall] pose jumped ${moved.toFixed(2)} m in one frame — world frame shifted`)
      }
    }

    this.latestPose = pose

    const status = (reality['trackingStatus'] as string | undefined) ?? 'UNKNOWN'
    if (status !== this._lastTrackingStatus) {
      console.log('[8thwall] trackingStatus:', status)
      this._lastTrackingStatus = status
    }

    if (!this._slamReady) {
      console.log(`[8thwall] SLAM ready — first pose received via ${label}`)
      this._slamReady = true
      // Only worth saying if the 5 s timer already ruled against this device:
      // that is the "recovered late" case, and the HUD is currently showing a
      // warning it should stop showing. Before the timer fires, silence — a
      // session that starts normally has nothing to report.
      if (this._preflightRuled) this._emitPreflight()
    }

    // Camera intrinsics → vertical FOV.
    //
    // Read the FLAT 16-element projection matrix this build actually publishes
    // (`DA = camera.getIntrinsic().getMatrix44f().toArray()` in
    // public/xr-slam.js).
    // The formula is not inferred — it is xr.js's own PlayCanvas binding, which
    // does exactly this with the same array:
    //     camera.fov = 2*Math.atan(1/o[5])*180/Math.PI
    //     camera.aspectRatio = o[5]/o[0]
    // (element 5 is the projection matrix's [1][1], i.e. 1/tan(fovY/2); element
    // 0 is [0][0] = 1/(aspect*tan(fovY/2)) — so their ratio is the aspect.)
    //
    // The object-shaped read this replaced (`intr.fy` / `intr.focalLength.y` /
    // `intr.height`) could never fire against an array, so `_fovY` sat at its
    // 60-degree placeholder and that placeholder was written into every
    // keyframe's intrinsics and on into the Brush dataset's fl_x/fl_y. A
    // reconstruction told the wrong lens bends geometry to fit it.
    const intr = reality['intrinsics']
    const proj = Array.isArray(intr)
      ? (intr as number[])
      : ArrayBuffer.isView(intr)
        ? Array.from(intr as unknown as Float32Array)
        : null
    if (proj && proj.length >= 6 && Number.isFinite(proj[5]) && proj[5] !== 0) {
      this._fovY = 2 * Math.atan(1 / proj[5]) * (180 / Math.PI)
      if (Number.isFinite(proj[0]) && proj[0] !== 0) {
        this._cameraAspect = proj[5] / proj[0]
      }
    } else if (intr && typeof intr === 'object' && !Array.isArray(intr)) {
      // Object-shaped intrinsics: kept because 8th Wall has published this shape
      // on other builds, and falling back is cheaper than guessing which one a
      // future engine drop ships.
      const rec = intr as Record<string, unknown>
      const fy = (rec['fy'] as number | undefined)
        ?? (rec['focalLength'] as Record<string, number> | undefined)?.y
      const imgH = (rec['height'] as number | undefined) ?? canvas.height
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

  /**
   * Size the canvas — both of its sizes — for the current viewport and camera
   * frame. Safe to call every time either one might have changed.
   *
   * A canvas has two independent sizes and this method is the only place that
   * sets either of them:
   *
   *   • `canvas.width`/`.height` is the GL drawing buffer. XR8 never assigns
   *     it, it READS it, once per frame in its pre-render step: `Z()` in
   *     public/xr.js compares the canvas against the size it last saw and
   *     dispatches `onCanvasSizeChange` when they differ. That dispatch is what
   *     re-fits the camera texture (`GlTextureRenderer`), resizes the three.js
   *     renderer, and — this is the part that matters here — reconfigures the
   *     SLAM engine's graphics intrinsics: `XrController`'s handler writes
   *     canvasWidth/Height into `cam.pixelRectWidth/Height`, which becomes
   *     `GraphicsIntrinsics.textureWidth/Height` in the WASM configure call
   *     (public/xr-slam.js), which is what produces the projection matrix
   *     `_syncReality()` reads back as `_fovY`/`_cameraAspect`.
   *
   *     So the render and the pose intrinsics are both derived from THIS
   *     number and cannot desync from each other by resizing. What a resize
   *     does change is whether that shared projection still matches the frame
   *     `captureFrame()` uploads — which is the whole argument for `contain`;
   *     see `CameraFit`.
   *
   *   • `canvas.style.width`/`.height` is the CSS box, in CSS pixels. It must
   *     be the drawing buffer divided by dpr, or the browser rescales the
   *     rendered image on its way to the screen. See `_claimCanvasBox()` —
   *     three.js fights us for these two properties.
   *
   * `margin: auto` against index.html's `position: fixed; inset: 0` centres the
   * letterbox: with all four insets 0 and a definite width/height, auto margins
   * absorb the slack on both axes (CSS 2.1 §10.3.7), so the bars split evenly.
   */
  private _fitCanvas(canvas: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1
    const viewW = window.innerWidth
    const viewH = window.innerHeight
    const frameAspect = this._videoW > 0 && this._videoH > 0 ? this._videoW / this._videoH : 0

    let cssW = viewW
    let cssH = viewH
    if (this._fit === 'contain' && frameAspect > 0) {
      // Fit inside: the axis that would overflow is the one we shrink.
      //
      // `frameAspect` is taken as the frame's aspect AS DISPLAYED, because that
      // is how xr.js's own fit treats the same pair. If a device turns out to
      // report it unrotated — a landscape `frame` in the `[8thwall][aspect]`
      // log while the phone is upright — this letterboxes to a small sideways
      // box. That is the signal to fall back to `?camerafit=cover` and fix the
      // orientation handling, not to nudge the numbers here.
      if (viewW / viewH > frameAspect) cssW = viewH * frameAspect
      else cssH = viewW / frameAspect
    }

    // Round the DRAWING BUFFER first and derive the CSS box back from it, so
    // the two aspects are identical to the pixel. Rounding the CSS box first
    // and multiplying would leave a sub-percent aspect mismatch, which shows up
    // as a slightly stretched preview — small, permanent, and hard to diagnose.
    const bufW = Math.max(1, Math.round(cssW * dpr))
    const bufH = Math.max(1, Math.round(cssH * dpr))

    // Assigning canvas.width/height reallocates and clears the drawing buffer
    // even when the value is unchanged, so only touch it on a real change.
    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW
      canvas.height = bufH
    }
    this._aspect = bufW / bufH

    this._cssWidth = `${bufW / dpr}px`
    this._cssHeight = `${bufH / dpr}px`
    this._claimCanvasBox(canvas)
  }

  /**
   * (Re-)assert our CSS box on the canvas.
   *
   * Called repeatedly because we do not own these properties uncontested.
   * XR8.Threejs's pipeline module calls `renderer.setSize(canvasWidth,
   * canvasHeight)` — once when it builds the renderer, and again on every
   * `onCanvasSizeChange` — passing the DRAWING-BUFFER size and leaving
   * three.js's `updateStyle` at its default `true`, so three.js writes
   * `canvas.style.width = "<device pixels>px"` (three r0.184,
   * `WebGLRenderer.setSize`). On a dpr-3 phone that inline style makes the
   * element three times the viewport, and because index.html pins the canvas
   * with `position: fixed; inset: 0`, a definite width/height wins over
   * `right`/`bottom`: the element is anchored top-left and the user sees a 3x
   * magnification of the top-left corner of the feed.
   *
   * That magnification is display-only — the tracker stages the full camera
   * texture (`_c8EmAsm_stageFrame` takes `frameStartResult.textureWidth/
   * Height`) and `captureFrame()` reads the full `camerapixelarray` — but it is
   * the large half of "the preview is far more zoomed in than the native
   * camera app".
   *
   * Measured, not assumed — but measured in headless Chromium, not on the
   * phone. Driving the real three.js r184 build against a canvas carrying
   * index.html's exact `#camerafeed` rules, in a 360x800 viewport at dpr 3:
   * the element's bounding rect is 360x800 before the renderer exists and
   * 1080x2400 at (0,0) immediately after `setSize(1080, 2400)`, with inline
   * `style="width: 1080px; height: 2400px"`. Re-asserting the CSS box restores
   * it, and a second `setSize` breaks it again — hence "repeatedly". What is
   * NOT verified is the phone: no camera, no XR8, no SLAM was in that test.
   */
  private _claimCanvasBox(canvas: HTMLCanvasElement): void {
    if (!this._cssWidth) return
    if (canvas.style.width !== this._cssWidth) canvas.style.width = this._cssWidth
    if (canvas.style.height !== this._cssHeight) canvas.style.height = this._cssHeight
    if (canvas.style.margin !== 'auto') canvas.style.margin = 'auto'
  }

  /**
   * Record the engine's camera frame size and re-fit if it changed. Fed by
   * every hook that carries `videoWidth`/`videoHeight` (onStart,
   * onVideoSizeChange, onDeviceOrientationChange) — they overlap, and the
   * cheapest way to be right is to accept all of them and ignore repeats.
   */
  private _noteFrameSize(canvas: HTMLCanvasElement, w?: number, h?: number): void {
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return
    if (w === this._videoW && h === this._videoH) return
    this._videoW = w
    this._videoH = h
    this._fitCanvas(canvas)
  }

  async start(canvas: HTMLCanvasElement): Promise<void> {
    // Wait for xr.js to finish loading if it hasn't yet.
    //
    // Bounded deliberately: an unconditional await here never settles if
    // /xr.js fails to load, so start() would hang forever with no error and
    // no camera — indistinguishable from "still initialising". main.ts's
    // waitForXR8() already times out for the same reason; this is the same
    // guarantee one layer down.
    if (typeof XR8 === 'undefined') {
      const loaded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), XR_LOAD_TIMEOUT_MS)
        window.addEventListener('xrloaded', () => { clearTimeout(timer); resolve(true) }, { once: true })
      })
      if (!loaded) {
        throw new Error(
          `8th Wall engine (/xr.js) did not load within ${XR_LOAD_TIMEOUT_MS} ms — the AR camera cannot start`,
        )
      }
    }

    // SLAM chunk may already be preloaded via data-preload-chunks="slam";
    // calling loadChunk again is a no-op if already loaded.
    await XR8.loadChunk('slam')

    const self = this

    // XR8.Threejs reads Three off the *global* and throws
    // "window.THREE does not exist but is required by the ThreeJS pipeline
    // module" without it — which rejects start() and makes the 8th Wall
    // scanner unable to begin a session at all.
    //
    // We import Three as an ES module, which never populates the global. The
    // diagnostic this pipeline combination was ported from
    // (ar-hittest-sphere.html) sets it explicitly; #141 brought the modules
    // across and left that line behind. Assign before the modules are
    // constructed below — XR8.Threejs.pipelineModule() reads it eagerly.
    ;(window as unknown as { THREE: typeof THREE }).THREE = THREE

    XR8.addCameraPipelineModules([
      // Diagnostics first, so it is installed before anything can fail.
      //
      // XR8.run() is fire-and-forget: it returns void and reports camera
      // acquisition and pipeline errors only through these hooks. With
      // neither wired up, a device that cannot open the camera showed a
      // black canvas and nothing else — the only signal was the generic
      // 5 s "pose not received" warning below, and the calibration overlay
      // told the user to check the camera "isn't covered" when the real
      // failure was that the camera was never successfully requested.
      // Observed on a Galaxy Tab S8 Ultra, where Chrome never even raised
      // its camera permission prompt. These log through console.error /
      // console.warn so src/debug/remote-log.ts relays them off-device.
      {
        name: 'ci-scan-diagnostics',
        onCameraStatusChange: ({ status }: { status: string }) => {
          if (status === 'failed') {
            console.error('[8thwall] Camera failed to start — no video feed will render')
          } else {
            console.log(`[8thwall] Camera status: ${status}`)
          }
          // The stream arriving is what starts every clock in this file: until
          // it does, "no camera frame" only means the browser has not answered
          // getUserMedia yet, which is a permission prompt or a cold camera and
          // never a fact about the device. `hasVideo` is accepted alongside
          // `hasStream` because it is the stronger signal and we should not
          // depend on seeing both.
          if (this._cameraStreamMs === null && (status === 'hasStream' || status === 'hasVideo')) {
            this._cameraStreamMs = performance.now()
            this._armPoseRuling()
            this._armAspectDiagnostic()
          }
        },
        onException(error: unknown) {
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          console.error('[8thwall] Pipeline exception —', detail, error)
        },
      },
      XR8.GlTextureRenderer.pipelineModule(), // draws camera feed to canvas
      XR8.Threejs.pipelineModule(), // world-locked scene for the calibration decal
      XR8.XrController.pipelineModule(), // enables SLAM 6-DoF tracking + pose
      XR8.CameraPixelArray.pipelineModule({ luminance: false }), // RGBA pixel array
      {
        name: 'ci-scan-capture',

        // xrScene() is only available once the Threejs pipeline module's own
        // onStart has run (it creates the scene/camera/renderer) — module
        // onStart hooks fire in array order above, so Threejs's has already
        // run by the time this one does. That ordering is also why the canvas
        // sizing lands here: Threejs's onStart is where three.js first stamps
        // its device-pixel CSS box on the canvas (see `_claimCanvasBox`), and
        // this hook runs immediately after it, in the same frame.
        onStart(args: { videoWidth?: number; videoHeight?: number }) {
          self._scene = XR8.Threejs.xrScene().scene
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
          self._claimCanvasBox(canvas)
        },

        // The engine dispatches these to every pipeline module when the camera
        // frame size changes or the device rotates. They are the only
        // authoritative source for the frame's aspect — see `_videoW`.
        onVideoSizeChange(args: { videoWidth?: number; videoHeight?: number }) {
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
        },
        onDeviceOrientationChange(args: { videoWidth?: number; videoHeight?: number }) {
          // The engine fires this from the window's orientationchange with the
          // dimensions it has *now*, which may still be the pre-rotation pair;
          // re-fit against the new viewport regardless, and let the
          // onVideoSizeChange that follows correct the frame size.
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
          self._fitCanvas(canvas)
        },
        // Fires after we resize the canvas — and after three.js has reacted to
        // that resize by overwriting our CSS box.
        onCanvasSizeChange() {
          self._claimCanvasBox(canvas)
        },

        // onUpdate runs AFTER all module onProcessCpu hooks, so processCpuResult
        // is fully populated (XrController has written its reality pose into it).
        // This is the correct place to read SLAM pose in this xr.js build.
        onUpdate(args: { processCpuResult?: Record<string, unknown>; processGpuResult?: Record<string, unknown>; frameStartResult?: Record<string, unknown> }) {
          self._syncReality(args.processCpuResult ?? args.processGpuResult ?? args.frameStartResult, 'onUpdate', canvas)
          // Backstop for the CSS box. onCanvasSizeChange above should already
          // have restored it, but that relies on this module's hooks running
          // after XR8.Threejs's; two string comparisons a frame buy
          // independence from that assumption, and a wrong CSS box is a
          // silently mis-scaled preview rather than an error.
          self._claimCanvasBox(canvas)
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

    this._canvas = canvas

    // Initial sizing. The camera frame size is not known until the engine
    // reports it, so this first pass just fills the viewport at device
    // resolution (otherwise the canvas would run at its 300×150 default); the
    // onStart / onVideoSizeChange hooks above re-fit it as soon as the frame
    // size arrives, and XR8 picks the new size up on the next pre-render.
    this._fitCanvas(canvas)

    // A viewport change (rotation, URL bar, split screen) changes the box we
    // are fitting into, so re-fit — the engine's own orientation hook cannot do
    // this for us because it does not know we size to the camera's aspect.
    this._onViewportChange = () => this._fitCanvas(canvas)
    window.addEventListener('resize', this._onViewportChange)
    window.addEventListener('orientationchange', this._onViewportChange)

    XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })

  }

  /**
   * Aspect diagnostic — read it from the phone's remote console on the next
   * AR start (`?debug=remote`). This is the only way any of the fit reasoning
   * in this file gets checked against real hardware.
   *
   * `crop` is the number to look at: how much of the camera frame the display
   * throws away along its tighter axis. Under `contain` it must read 1.00 —
   * if it does not, `frame` and `canvas` disagree and the fit is wrong.
   * `projectionAspect` must track `canvas.aspect`, since the engine builds
   * that projection from the canvas rect; a drift there means the render and
   * the keyframe intrinsics have come apart.
   *
   * `trackSettings` is the raw getUserMedia track resolution, logged only to
   * show which constraint xr.js settled on (its list is 4:3 — 1600x1200,
   * 1440x1080, 1280x960, 960x720, 640x480). It can legitimately disagree with
   * `frame` in orientation: browsers differ on whether they report rotated or
   * sensor-native dimensions on a portrait device. `frame` is what the engine
   * fits with, so `frame` is what we fit with.
   *
   * Armed when the camera stream arrives, not from `start()`: fired from there
   * it routinely sampled a session that had no stream yet and printed
   * `frame: "unreported"`, `trackSettings: "unavailable"`,
   * `projectionAspect: null` — which reads as a dead engine and is actually a
   * pending getUserMedia. Measured on the Beam Pro, 2026-08-30 08:17:07:
   * `hasStream` at +0.66 s, diagnostic at +4.00 s. Anchored to the stream, the
   * same print means what it says.
   */
  private _armAspectDiagnostic(): void {
    const canvas = this._canvas
    if (!canvas) return
    setTimeout(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null
      const track = video?.srcObject instanceof MediaStream
        ? video.srcObject.getVideoTracks()[0]
        : undefined
      const settings = track?.getSettings?.()
      const canvasAspect = canvas.width / canvas.height
      const frameAspect = this._videoW > 0 && this._videoH > 0 ? this._videoW / this._videoH : null
      console.log('[8thwall][aspect]', JSON.stringify({
        fit: this._fit,
        canvas: { w: canvas.width, h: canvas.height, aspect: +canvasAspect.toFixed(3) },
        cssBox: { w: this._cssWidth, h: this._cssHeight, dpr: window.devicePixelRatio || 1 },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        frame: frameAspect
          ? { w: this._videoW, h: this._videoH, aspect: +frameAspect.toFixed(3) }
          : 'unreported',
        trackSettings: settings?.width && settings?.height
          ? { w: settings.width, h: settings.height }
          : 'unavailable',
        fovYDeg: +this._fovY.toFixed(2),
        projectionAspect: this._cameraAspect ? +this._cameraAspect.toFixed(3) : null,
        crop: frameAspect
          ? +Math.max(frameAspect / canvasAspect, canvasAspect / frameAspect).toFixed(2)
          : null,
      }))
    }, 4000)
  }

  /**
   * Arm the preflight verdict, measured from the camera stream.
   *
   * This is the same 5 s pose timer that has always been here — it used to end
   * at a console.warn, which is invisible to someone holding a phone in their
   * kitchen, and on the Beam Pro that warning was the ONLY report that the
   * engine had accepted XR8.run(), acquired a 960x720 camera track, and then
   * never emitted a single frame.
   *
   * `_videoW` is what separates that dead pipeline from a room SLAM simply
   * cannot lock onto: it is set from the engine's own videoWidth hook, so a
   * zero here is exactly the `frame: "unreported"` the aspect diagnostic prints.
   * The judgement itself lives in firstFrameVerdict() so it is testable without
   * an AR session.
   */
  private _armPoseRuling(): void {
    if (this._poseRulingTimer !== null) clearTimeout(this._poseRulingTimer)
    this._poseRulingTimer = setTimeout(() => {
      this._poseRulingTimer = null
      this._preflightRuled = true
      if (!this._slamReady) {
        console.warn('[8thwall] Pose not received in 5 s — capture can continue, but scan geometry will be sparse')
      }
      this._emitPreflight()
    }, FIRST_POSE_TIMEOUT_MS)
  }

  /**
   * Register the preflight subscriber. Call before `start()`: the timer that
   * produces the verdict is armed inside it.
   */
  onPreflightVerdict(cb: (verdict: PreflightVerdict) => void): void {
    this._onPreflight = cb
  }

  private _emitPreflight(): void {
    if (!this._onPreflight) return
    this._onPreflight(firstFrameVerdict({
      sawCameraFrame: this._videoW > 0 && this._videoH > 0,
      sawPose: this._slamReady,
      // Zero while no stream has arrived, which keeps the verdict inside
      // firstFrameVerdict()'s grace window and therefore `'warming-up'`. That
      // is the honest answer to "is this device capable" when the browser has
      // not yet said whether we may have a camera at all — the alternative,
      // elapsed-since-start, is what told a working Beam Pro it could not scan.
      elapsedMs: this._cameraStreamMs === null ? 0 : performance.now() - this._cameraStreamMs,
    }))
  }

  stop(): void {
    XR8.stop()
    this._scene = null
    // A pending ruling outlives the session it was judging otherwise, and would
    // warn about a pose that stopped being expected the moment we stopped.
    if (this._poseRulingTimer !== null) {
      clearTimeout(this._poseRulingTimer)
      this._poseRulingTimer = null
    }
    this._cameraStreamMs = null
    this._preflightRuled = false
    if (this._onViewportChange) {
      window.removeEventListener('resize', this._onViewportChange)
      window.removeEventListener('orientationchange', this._onViewportChange)
      this._onViewportChange = null
    }
    // Hand the CSS box back to index.html's stylesheet. Leaving our inline
    // width/height behind would pin a stopped session's letterbox onto whatever
    // renders into this canvas next.
    this._cssWidth = ''
    this._cssHeight = ''
    if (this._canvas) {
      this._canvas.style.removeProperty('width')
      this._canvas.style.removeProperty('height')
      this._canvas.style.removeProperty('margin')
      this._canvas = null
    }
  }

  getScene(): THREE.Scene | null {
    return this._scene
  }

  getTrackingDiagnostics(): { status: string; poseJumps: number; lastJumpM: number } {
    return { status: this._lastTrackingStatus || 'UNKNOWN', poseJumps: this._poseJumps, lastJumpM: this._lastJumpM }
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
   * `x`/`y` are normalised against the CANVAS, not the window.
   *
   * XR8 interprets them against the canvas rect, and `provider.ts` calls them
   * "normalised screen coords" — a distinction with no difference while the
   * canvas fills the viewport. Under the `contain` fit it stops filling the
   * viewport, so the two disagree by the letterbox. Callers that divide by the
   * canvas's own `getBoundingClientRect()` (project-calibration.ts) stay
   * correct; callers that divide by `window.innerWidth/innerHeight`
   * (spatial/resolver.ts) do not. Not corrected here: converting inside this
   * method would double-correct the callers that already got it right.
   */
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

  /**
   * The live status 8th Wall publishes on each reality frame.
   *
   * `_lastTrackingStatus` was already being maintained here purely to log
   * transitions; returning it is what lets callers act on a session that has
   * degraded to `LIMITED` instead of trusting `isTracking()`'s first-pose latch.
   */
  trackingStatus(): TrackingStatus {
    return (this._lastTrackingStatus || 'UNKNOWN') as TrackingStatus
  }

  getCameraFovY(): number {
    return this._fovY
  }

  /**
   * Canvas aspect — which under the `contain` fit is also the camera frame's
   * aspect, because the canvas is sized to it. That equality is what lets one
   * accessor serve both consumers honestly: the three.js cameras built for
   * screen-space raycasting (main.ts, ui/overlay.ts), and the
   * `intrinsics.aspect` stamped alongside each uploaded keyframe. Under
   * `cover` they are two different lenses and this returns the display one.
   */
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
