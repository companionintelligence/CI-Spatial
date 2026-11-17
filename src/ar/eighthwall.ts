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
import { FIRST_POSE_TIMEOUT_MS, firstFrameVerdict, startFailureVerdict, type PreflightVerdict } from './preflight.ts'
import { imagePointToViewportPoint, type ImageHitTestContract, type ViewSize } from '../spatial/resolver.ts'
import { EngineScaleSession } from './engine-config.ts'
import type { ScaleKind, ScaleMode } from '../world/scale-mode.ts'

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

/** How long start() waits for /xr.js before giving up with a real error. */
const XR_LOAD_TIMEOUT_MS = 10_000

/**
 * How long the camera may sit at `requesting` before the page says it is still
 * waiting. A permission prompt that nobody answers never reaches `failed` or
 * `hasStream`, and with no bound the page had no verdict at all: it kept saying
 * the lens was covered. The wait is not a refusal, so it gets neutral copy; only
 * a `failed` event with reason DENY_CAMERA is called a permission problem.
 */
const CAMERA_PROMPT_TIMEOUT_MS = 10_000

/**
 * The verdict while the camera is still being asked for. A prompt may be open,
 * so this says what is happening and never that access is blocked. It is
 * `'warming-up'`, the outcome that means "not yet, do not route away", and it
 * offers no upload route.
 */
function cameraPendingVerdict(): PreflightVerdict {
  return {
    outcome: 'warming-up',
    headline: 'Waiting for camera permission',
    detail: 'Allow camera access when the browser asks. The scan starts once the camera is on.',
    canScan: true,
    routeToUpload: false,
    caveat: true,
  }
}

/**
 * The verdict for a camera the engine could not start. The documentation of
 * `onCameraStatusChange` gives the statuses (`requesting`, `hasStream`, `hasVideo`,
 * `failed`) and names no reason
 * (https://8thwall.org/docs/api/engine/camerapipelinemodule/oncamerastatuschange), so a
 * `reason` on a `failed` status is used only if the engine supplies one, and the verdict
 * follows it. Only DENY_CAMERA is taken as a permission problem, so only it gets the
 * permission copy and the upload route. NO_CAMERA and UNSPECIFIED make no claim about
 * permissions. An absent or unrecognised reason is treated as UNSPECIFIED.
 */
function cameraFailureVerdict(reason: string | undefined): PreflightVerdict {
  if (reason === 'DENY_CAMERA') {
    // A refused camera is a NotAllowedError in the browser's own getUserMedia
    // vocabulary, which is the evidence startFailureVerdict() classifies on, so the
    // refusal is expressed in that form here.
    const denied = new Error('Camera access was not granted')
    denied.name = 'NotAllowedError'
    return startFailureVerdict(denied)
  }
  if (reason === 'NO_CAMERA') {
    return {
      outcome: 'unavailable',
      headline: 'No camera found',
      detail: 'No camera was found on this device, so a live scan cannot run. If a camera should be here, try again.',
      canScan: false,
      routeToUpload: false,
      caveat: true,
    }
  }
  return {
    outcome: 'unavailable',
    headline: 'Camera did not start',
    detail: 'The camera did not start. Close any other app that uses the camera, then try again.',
    canScan: false,
    routeToUpload: false,
    caveat: true,
  }
}

/**
 * How the camera frame is mapped onto the canvas.
 *
 * `contain` sizes the canvas to the CAMERA's aspect and centres it, so the
 * whole sensor frame is on screen with bars on two sides. `cover` sizes the
 * canvas to the viewport and lets the engine crop the frame to fill it — the
 * full-bleed look, and what this file did unconditionally before 2026-08-25.
 *
 * `contain` is the default because it collapses two camera models into one.
 * The projection matrix the engine publishes is documented as matching the
 * rendered camera feed, which is what the CANVAS shows (see `_fitCanvas`), so
 * with canvas aspect == camera aspect nothing is cropped and that projection
 * describes exactly the frame `captureFrame()` uploads. Under `cover` the two
 * diverge as soon as the viewport is WIDER than
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
 * phone without a rebuild — the whole of this fit change is reasoned from the
 * documentation (the projection matrix is documented as matching the rendered camera
 * feed, https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule) and from
 * three.js, not from a device. Prefer `contain`: see the `CameraFit` note for what
 * `cover` costs the keyframe intrinsics.
 */
function resolveCameraFit(): CameraFit {
  return new URLSearchParams(window.location.search).get('camerafit') === 'cover'
    ? 'cover'
    : 'contain'
}

/**
 * The hit types a result can have, as `XrController.hitTest` documents them: FEATURE_POINT and the two surface types
 * below (the page also lists UNSPECIFIED, which a result can have and a caller does not ask for). The same page says
 * `includedTypes` should contain FEATURE_POINT and describes no other value for it, so asking for a surface type is an
 * experiment for DX5, not documented use (https://8thwall.org/docs/api/engine/xrcontroller/hittest).
 */
const ENGINE_HIT_TYPES: readonly string[] = ['FEATURE_POINT', 'ESTIMATED_SURFACE', 'DETECTED_SURFACE']

/**
 * The hit types a tap asks the engine for: `['FEATURE_POINT']`, as it always has, unless the page was opened
 * with `?hittypes=ESTIMATED_SURFACE,DETECTED_SURFACE,FEATURE_POINT` (any of the three, in the order they
 * should be asked for). Names that are not one of the three are dropped, and a list with none left is the default.
 *
 * It exists so DX5 can try the surface types on the phone without a rebuild, like `?camerafit=cover` above:
 * whether they return anything on 8th Wall, and whether they beat a snapped feature point, is what that
 * experiment decides, and nothing in this file has seen either answer.
 */
export function hitTypesFromSearch(search: string): string[] {
  const asked = new URLSearchParams(search).get('hittypes')
  const wanted = (asked ?? '')
    .split(',')
    .map((name) => name.trim().toUpperCase())
    .filter((name, i, all) => ENGINE_HIT_TYPES.includes(name) && all.indexOf(name) === i)
  return wanted.length > 0 ? wanted : ['FEATURE_POINT']
}

// XR8 is a global injected by xr.js — we declare it to satisfy TypeScript
declare const XR8: {
  addCameraPipelineModule(mod: object): void
  addCameraPipelineModules(mods: object[]): void
  removeCameraPipelineModule(name: string): void
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
    // Both are in the engine's documented API (xrcontroller/configure and
    // xrcontroller/updatecameraprojectionmatrix) and are called only through
    // engine-config.ts, which guards them: an older engine build may omit them.
    configure?(config: { scale?: 'responsive' | 'absolute' }): void
    updateCameraProjectionMatrix?(args: {
      origin?: { x: number; y: number; z: number }
      facing?: { w: number; x: number; y: number; z: number }
    }): void
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

/**
 * The frame time of the frame a hook was given, in milliseconds, or the page clock for a hook that
 * carries none (the mock engine's). `frameStartResult.frameTime` is not in the documented field list
 * (the documented timestamp is `videoTime`,
 * https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu), so it is read only when it is a
 * finite number, taken to be seconds, and otherwise `performance.now()` is used. That a `frameTime` is
 * seconds on the same clock as `performance.now()` is assumed, not documented, and has not been compared
 * on a device. It is preferred to reading the clock in the hook because the hook can run late: two frames
 * delivered together after a stall would otherwise look as if no time had passed between them.
 */
function frameTimeMs(frameStartResult: Record<string, unknown> | undefined): number {
  const seconds = frameStartResult?.['frameTime']
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : performance.now()
}

export class EighthWallProvider implements ARProvider, ImageHitTestContract {
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
  /** The engine's `trackingReason` beside that status, as it spelled it. Empty until a frame carries one. */
  private _lastTrackingReason = ''
  /**
   * Decides what counts as a frame shift, and numbers the stretches of tracking between
   * them (src/ar/frame-epoch.ts). SLAM refines its map as it goes and can redefine its own
   * origin, on recovery from lost tracking or when a loop closes; every world-locked
   * object then jumps together, and points already harvested are in a frame that no
   * longer exists. Nothing else in the app can see that: the pose keeps updating and the
   * status can read NORMAL throughout.
   */
  private _epochs = new FrameEpochTracker({}, { deferNotify: true })
  /** When the pose in `latestPose` was read, on the engine's frame clock (ms). Null before the first. */
  private _poseAtMs: number | null = null
  /** The frame clock (ms) of the last reality frame seen, whatever it carried. Null before the first. */
  private _frameMs: number | null = null
  /**
   * True while `latestPose` is being held over because the engine has no pose to give
   * (NOT_AVAILABLE), and so is older than the frame it is read in. False whenever the pose is
   * taken fresh, which is every frame that has one.
   */
  private _poseHeld = false
  /** Whether the page was last seen hidden, so a return to it can be told from a first look. */
  private _pageHidden = false
  /** When the page was last hidden, on the page clock (ms), so a return can say how long it was away. */
  private _hiddenAtMs: number | null = null
  /** The page-visibility listener, held so `stop()` can remove it. */
  private _onVisibility: (() => void) | null = null
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
  /** Bounds a camera prompt that is never answered. See CAMERA_PROMPT_TIMEOUT_MS. */
  private _cameraPromptTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Camera vertical field-of-view in degrees, read from the projection matrix
   * the SLAM engine publishes each frame (`_syncReality()` below). 60 is only
   * the value before the first frame lands.
   *
   * It matters downstream: `KeyframeStreamer` stamps this into every keyframe's
   * `intrinsics.fovYDeg`, and `deriveIntrinsics()` in
   * `server/splat/splat_train_dataset.ts` turns it into the `fl_x`/`fl_y` of
   * the Brush training dataset. The documentation says the projection gives the
   * scene camera the same field of view as the rendered camera feed
   * (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule), and the
   * rendered feed is what the CANVAS shows, so this describes the uploaded
   * keyframe only while the canvas crops nothing — which is what the `contain` fit
   * guarantees. The `[8thwall][aspect]` log is where a phone shows whether it holds.
   */
  private _fovY = 60
  /**
   * Aspect (width/height) implied by the engine's projection matrix, or null
   * until a frame supplies one.
   *
   * This is expected to track the CANVAS, not the sensor: `updateCameraProjectionMatrix`
   * documents its `cam.pixelRectWidth` and `pixelRectHeight` as the size of the canvas that
   * displays the camera feed
   * (https://8thwall.org/docs/api/engine/xrcontroller/updatecameraprojectionmatrix; see
   * `_fitCanvas`). Kept as a cross-check that `_aspect` and the projection agree — if these
   * two ever drift apart, the render and the pose intrinsics are describing different lenses.
   */
  private _cameraAspect: number | null = null
  /** Canvas (drawing-buffer) aspect ratio — what `getCameraAspect()` returns. */
  private _aspect = 9 / 16
  /** How the frame is mapped onto the canvas; see `CameraFit`. */
  private _fit: CameraFit = resolveCameraFit()
  /**
   * Camera frame size as the ENGINE reports it, from the `videoWidth`/
   * `videoHeight` hook arguments (documented as the size of the camera feed:
   * https://8thwall.org/docs/api/engine/camerapipelinemodule/ondeviceorientationchange).
   * 0 until the first frame.
   *
   * Deliberately the engine's numbers and not `track.getSettings()`: they are the
   * pair the engine itself reports for the camera feed, so sizing the canvas from
   * them is the least likely to disagree with the engine about which way round the
   * frame is. Browsers differ on whether a portrait device reports rotated or
   * sensor-native track dimensions; this sidesteps the question. That the engine
   * fits the camera texture to the canvas with this same pair is assumed, not
   * documented: the `[8thwall][aspect]` log shows it on a phone.
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
  /** The unit of this session: what `start()` set on the engine, and the `?originY=` arm. See engine-config.ts. */
  private _engineScale = new EngineScaleSession()

  /**
   * Read one reality frame. `tMs` is the engine's frame clock; `repeatFrame` is documented as
   * the camera feed not having updated since the last call
   * (https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu), and the reality
   * such a tick carries is taken to be the last one's again, with a later frame time (assumed,
   * not documented, and not yet checked on a device). The listeners of a discontinuity are told
   * once the frame has been read to the end, so one that looks at the provider finds its
   * epoch, its pose and its points all of the same frame.
   */
  private _syncReality(
    source: unknown,
    label: string,
    canvas: HTMLCanvasElement,
    tMs: number = performance.now(),
    repeatFrame = false,
  ): void {
    try {
      this._readReality(source, label, canvas, tMs, repeatFrame)
    } finally {
      this._epochs.flush()
    }
  }

  private _readReality(
    source: unknown,
    label: string,
    canvas: HTMLCanvasElement,
    tMs: number,
    repeatFrame: boolean,
  ): void {
    const reality = findRealityObject(source)
    if (!reality) return

    if (!this._diagLogged) {
      this._diagLogged = true
      console.log(`[8thwall] ${label} reality keys:`, JSON.stringify(Object.keys(reality)))
    }

    const pose = poseFromReality(reality)
    if (!pose) return

    // The status and the reason are logged on every change, which is what lets a device
    // run size the thresholds in ./frame-epoch.ts (?debug=remote relays the console).
    const status = (reality['trackingStatus'] as string | undefined) ?? 'UNKNOWN'
    const reason = typeof reality['trackingReason'] === 'string' ? reality['trackingReason'] : ''
    if (status !== this._lastTrackingStatus || reason !== this._lastTrackingReason) {
      console.log('[8thwall] trackingStatus:', reason ? `${status} (${reason})` : status)
      this._lastTrackingStatus = status
      this._lastTrackingReason = reason
    }

    // Frame-shift detection, before latestPose is overwritten. A discontinuity here is the
    // map redefining its origin, not the operator moving. A repeat frame is not a frame: the
    // pose is the last one's, and feeding it would give the tracker a step of nothing over a
    // rendering interval and then a whole camera frame's turn over the next one, which at a
    // camera slower than the page reads a plain turn of 120 degrees a second as a shift.
    this._frameMs = tMs
    if (!repeatFrame) {
      const shift = this._epochs.observe({ tMs, pose, status, reason })
      if (shift) this._noteFrameShift(shift)
    }

    // NOT_AVAILABLE is this app's word for a frame with no pose (the documentation lists only
    // LIMITED and NORMAL, so this is handled in case the engine reports it). Whatever such a
    // frame carries is not taken as a pose: a default one would put a point of the camera
    // path at the origin and read as a jump back. Keep the last real pose; a capture asked
    // for meanwhile is refused once that pose is too old (onProcessCpu). Before the first
    // pose there is nothing to keep, so it is taken as it always was.
    if (status === 'NOT_AVAILABLE' && this._slamReady) {
      this._poseHeld = true
      return
    }

    this.latestPose = pose
    this._poseAtMs = tMs
    this._poseHeld = false

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
    // Read the FLAT 16-element projection matrix. The documentation calls `reality.intrinsics` a 16
    // dimensional column-major 4x4 projection matrix that gives the scene camera the same field of view
    // as the rendered camera feed
    // (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule). For a standard
    // perspective projection in that layout, element 5 is [1][1] = 1/tan(fovY/2) and element 0 is
    // [0][0] = 1/(aspect*tan(fovY/2)), so
    //     fovY = 2*atan(1/m[5])    and    aspect = m[5]/m[0].
    // That this matrix is a plain perspective projection (no skew, no off-centre terms in elements
    // 8 and 9) is assumed, not documented: DX8 asks for elements 0, 5, 8 and 9 on a phone.
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

    // Harvest world points. `worldPoints` is the documented field, and it is only filled if XrController is
    // configured to return world points and the reason is not INITIALIZING
    // (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule); `points` is read too, in case a
    // build names it that way.
    const newPts = [
      ...extractPointBatch(reality['worldPoints'], this.latestPose),
      ...extractPointBatch(reality['points'], this.latestPose),
    ]
    if (newPts.length > 0) this._latestWorldPoints = newPts
  }

  /**
   * A discontinuity began a new epoch. The points harvested from the last reality frame and
   * not yet drained were recorded in the epoch before it, and the drain stamps whatever
   * epoch is current, so they are dropped rather than stamped with the wrong one. The
   * frame that carried the discontinuity is harvested after this, in the new epoch.
   */
  private _noteFrameShift(shift: FrameDiscontinuity): void {
    this._latestWorldPoints = []
    console.warn(`[8thwall] frame discontinuity ${shift.epoch}: ${shift.cause}`, JSON.stringify(shift))
  }

  /**
   * The engine was resumed, or the page came back after being hidden. Either way the
   * camera may have been carried somewhere the map did not follow. The two can report the
   * same return, and the tracker counts it once.
   */
  private _noteResumed(hiddenMs?: number): void {
    const shift = this._epochs.noteResume(performance.now(), hiddenMs)
    if (shift) this._noteFrameShift(shift)
    this._epochs.flush()
  }

  /**
   * Whether the pose in `latestPose` is too old to stamp onto a capture. Only a pose that is
   * being held over, because the engine has none to give, gets old. A pose that is read every
   * frame is current however long it was since the last frame: a main-thread stall of 250 ms
   * makes the gap between two engine ticks that long and does not make the pose stale, and
   * the tick that ends it brings a fresh one.
   */
  private _poseTooOldForCapture(nowMs: number): boolean {
    return this._poseHeld && this._poseAtMs !== null && nowMs - this._poseAtMs > MAX_CAPTURE_POSE_AGE_MS
  }

  /**
   * Size the canvas — both of its sizes — for the current viewport and camera
   * frame. Safe to call every time either one might have changed.
   *
   * A canvas has two independent sizes and this method is the only place that
   * sets either of them:
   *
   *   • `canvas.width`/`.height` is the GL drawing buffer. This method sets it,
   *     and the engine reports a change of it to every pipeline module through
   *     `onCanvasSizeChange`, with the video and canvas sizes
   *     (https://8thwall.org/docs/api/engine/camerapipelinemodule/oncanvassizechange).
   *     The display geometry the engine overlays the scene with is documented in
   *     terms of "the canvas that displays the camera feed" (the
   *     `cam.pixelRectWidth`/`pixelRectHeight` of `updateCameraProjectionMatrix`,
   *     https://8thwall.org/docs/api/engine/xrcontroller/updatecameraprojectionmatrix),
   *     and the projection `_syncReality()` reads back as `_fovY`/`_cameraAspect` is
   *     documented as matching the rendered camera feed.
   *
   *     So the render and the pose intrinsics are expected to follow THIS number
   *     and not to desync from each other by resizing. That is the documented
   *     intent: how the engine applies a resize is not documented, and the
   *     `[8thwall][aspect]` log shows on a phone whether the projection kept up.
   *     What a resize does change is whether that shared projection still matches
   *     the frame `captureFrame()` uploads — which is the whole argument for
   *     `contain`; see `CameraFit`.
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
      // `frameAspect` is taken as the frame's aspect AS DISPLAYED: the documented
      // `videoWidth`/`videoHeight` are the size of the camera feed, and the
      // documentation does not say whether a portrait phone reports them rotated.
      // If a device turns out to report it unrotated — a landscape `frame` in the
      // `[8thwall][aspect]` log while the phone is upright — this letterboxes to a
      // small sideways box. That is the signal to fall back to `?camerafit=cover`
      // and fix the orientation handling, not to nudge the numbers here.
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
   * three.js's `WebGLRenderer.setSize(width, height, updateStyle = true)` writes
   * `canvas.style.width` and `.height` in the units it is given (three r0.184),
   * and the documented `XR8.Threejs.pipelineModule()` creates and configures a
   * three.js renderer in its `onStart`
   * (https://8thwall.org/docs/api/engine/threejs/pipelinemodule; the page does not
   * say whether it resizes that renderer when the canvas changes size). A renderer
   * sized with the DRAWING-BUFFER size gets `canvas.style.width = "<device
   * pixels>px"`. On a dpr-3 phone that inline style makes the element three times
   * the viewport, and because index.html pins the canvas with `position: fixed;
   * inset: 0`, a definite width/height wins over `right`/`bottom`: the element is
   * anchored top-left and the user sees a 3x magnification of the top-left corner
   * of the feed. This method does not depend on which call writes the style, or
   * when: it puts the box back after `onCanvasSizeChange` and again every frame.
   *
   * That magnification is display-only — the camera texture the pipeline hands its
   * modules has its own documented size (`frameStartResult.textureWidth`/
   * `textureHeight`,
   * https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu) and
   * `captureFrame()` reads the full `camerapixelarray` — but it is the large half
   * of "the preview is far more zoomed in than the native camera app".
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

    // The unit of every coordinate this session produces is fixed here: after the chunk loads, and before
    // XrController.pipelineModule() is called below and before XR8.run(). It is applied again on every
    // start, and a page that names no scale leaves the engine alone (see engine-config.ts). A start has no
    // tracking status until its first frame, so one left over from the last session is cleared: a stale
    // NORMAL must not read as an absolute scale that is ready.
    this._lastTrackingStatus = ''
    this._engineScale.configure(XR8, window.location.search)

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
        // A `failed` status may carry a `reason`: the documentation names none, so
        // DENY_CAMERA and NO_CAMERA are acted on in case the engine supplies them.
        // The verdict depends on it; see cameraFailureVerdict().
        onCameraStatusChange: ({ status, reason }: { status: string; reason?: string }) => {
          if (status === 'failed') {
            console.error(`[8thwall] Camera failed to start (${reason ?? 'no reason'}) — no video feed will render`)
          } else {
            console.log(`[8thwall] Camera status: ${status}`)
          }
          // A prompt that is answered, or a camera that fails, settles the wait.
          if (status === 'hasStream' || status === 'hasVideo') this._disarmCameraPromptRuling()
          if (status === 'failed') this._emitCameraFailure(reason)
          if (status === 'requesting') this._armCameraPromptRuling()
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
          const xrScene = XR8.Threejs.xrScene()
          self._scene = xrScene.scene
          // `?originY=` experiment arm only; does nothing otherwise. See engine-config.ts.
          self._engineScale.applyOrigin(XR8, xrScene.camera)
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
          self._claimCanvasBox(canvas)
        },

        // Documented hooks that carry the camera feed's size: onVideoSizeChange
        // (called when the canvas changes size, with the video and canvas sizes) and
        // onDeviceOrientationChange (called when the device changes landscape/portrait
        // orientation). They are the source this file uses for the frame's aspect —
        // see `_videoW`.
        onVideoSizeChange(args: { videoWidth?: number; videoHeight?: number }) {
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
        },
        onDeviceOrientationChange(args: { videoWidth?: number; videoHeight?: number }) {
          // The documentation does not say whether the size passed here is the one from
          // before or after the rotation
          // (https://8thwall.org/docs/api/engine/camerapipelinemodule/ondeviceorientationchange),
          // so re-fit against the new viewport regardless, and accept a corrected frame
          // size from onVideoSizeChange whenever one arrives.
          self._noteFrameSize(canvas, args.videoWidth, args.videoHeight)
          self._fitCanvas(canvas)
        },
        // Called when the canvas changes size, which can be after something else
        // (three.js, through the renderer the Threejs module configured) has
        // overwritten our CSS box: put it back.
        onCanvasSizeChange() {
          self._claimCanvasBox(canvas)
        },

        // The documented order within a frame is onProcessGpu, onProcessCpu, onUpdate,
        // onRender (https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule),
        // and onUpdate is given `processCpuResult`, "data returned by all installed
        // modules during onProcessCpu"
        // (https://8thwall.org/docs/api/engine/camerapipelinemodule/onupdate). So the
        // data the XrController module returns is there by now (`findRealityObject`
        // looks for the reality in it), and this is where the SLAM pose is read
        // (onProcessCpu below reads it too, for a capture that is waiting).
        onUpdate(args: { processCpuResult?: Record<string, unknown>; processGpuResult?: Record<string, unknown>; frameStartResult?: Record<string, unknown> }) {
          self._syncReality(
            args.processCpuResult ?? args.processGpuResult ?? args.frameStartResult,
            'onUpdate',
            canvas,
            frameTimeMs(args.frameStartResult),
            args.frameStartResult?.['repeatFrame'] === true,
          )
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
          const frameMs = frameTimeMs(frameStartResult)
          self._syncReality(
            processCpuResult ?? processGpuResult ?? frameStartResult,
            'onProcessCpu',
            canvas,
            frameMs,
            frameStartResult?.['repeatFrame'] === true,
          )

          // Only do the expensive pixel copy when a capture is pending
          if (self.captureQueue.length === 0) return

          // A pose that has been held through NOT_AVAILABLE is not current. Stamping it onto
          // a photograph places everything detected in it where the camera no longer is, so
          // the capture is refused with a reason the person can act on instead.
          if (self._poseTooOldForCapture(frameMs)) {
            for (const pending of self.captureQueue.splice(0)) {
              clearTimeout(pending.timeout)
              pending.reject(new Error(TRACKING_LOST_MESSAGE))
            }
            return
          }

          console.log('[capture] onProcessCpu triggered, processGpuResult keys:', Object.keys(processGpuResult))
          const pa = (processGpuResult as { camerapixelarray?: { pixels: Uint8Array; rows: number; cols: number } })
            .camerapixelarray
          console.log('[capture] camerapixelarray:', pa ? `${pa.cols}×${pa.rows} px${pa.pixels?.length}` : 'undefined')
          if (!pa?.pixels) {
            console.warn('[capture] No pixel data in processGpuResult — capture will retry next frame')
            return
          }

          const { pixels, rows: height, cols: width } = pa
          // Copy immediately: the documentation does not say whether the engine reuses this
          // buffer between frames (https://8thwall.org/docs/api/engine/camerapixelarray/pipelinemodule),
          // so it is not kept.
          const pixelsCopy = new Uint8ClampedArray(pixels)
          const frame: RawFrame = {
            pixels: pixelsCopy,
            width,
            height,
            pose: { ...self.latestPose, position: { ...self.latestPose.position } },
            timestamp: performance.now(),
            epoch: self._epochs.epoch,
          }

          // Drain the queue — normally one waiting captureFrame() call.
          const queue = self.captureQueue.splice(0)
          queue.forEach((pending) => {
            clearTimeout(pending.timeout)
            pending.resolve(frame)
          })
        },

        // Called when XR8.resume() is called
        // (https://8thwall.org/docs/api/engine/camerapipelinemodule/onresume). The
        // documentation says nothing about whether the engine keeps its origin across a
        // pause, and the next pose does not say either, so this starts an epoch (see
        // _noteResumed).
        onResume() {
          self._noteResumed()
        },
      },
    ])

    this._canvas = canvas

    // Initial sizing. The camera frame size is not known until the engine
    // reports it, so this first pass just fills the viewport at device
    // resolution (otherwise the canvas would run at its 300×150 default); the
    // onStart / onVideoSizeChange hooks above re-fit it as soon as the frame
    // size arrives, and the engine reports the new canvas size through
    // onCanvasSizeChange.
    this._fitCanvas(canvas)

    // A viewport change (rotation, URL bar, split screen) changes the box we
    // are fitting into, so re-fit — the engine's own orientation hook cannot do
    // this for us because it does not know we size to the camera's aspect.
    this._onViewportChange = () => this._fitCanvas(canvas)
    window.addEventListener('resize', this._onViewportChange)
    window.addEventListener('orientationchange', this._onViewportChange)

    // When the page is hidden the browser pauses the camera's <video>. A pipeline module's
    // onResume is documented to follow XR8.resume() and nothing else
    // (https://8thwall.org/docs/api/engine/camerapipelinemodule/onresume), and nothing says a
    // return to a hidden page calls it, so the page's own visibility is the signal relied on
    // here. A return that both report is one resume: see _noteResumed.
    this._pageHidden = document.visibilityState === 'hidden'
    this._hiddenAtMs = this._pageHidden ? performance.now() : null
    this._onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!this._pageHidden) this._hiddenAtMs = performance.now()
        this._pageHidden = true
      } else if (this._pageHidden) {
        this._pageHidden = false
        const away = this._hiddenAtMs === null ? undefined : performance.now() - this._hiddenAtMs
        this._hiddenAtMs = null
        this._noteResumed(away)
      }
    }
    document.addEventListener('visibilitychange', this._onVisibility)

    XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })

  }

  /**
   * Aspect diagnostic — read it from the phone's remote console on the next
   * AR start (`?debug=remote,verbose`: it is a console.log). This is the only
   * way any of the fit reasoning in this file gets checked against real
   * hardware, and DX8 in docs/testing/DEVICE_TESTING.md reads it.
   *
   * `crop` is the number to look at: how much of the camera frame the display
   * throws away along its tighter axis. Under `contain` it must read 1.00 —
   * if it does not, `frame` and `canvas` disagree and the fit is wrong.
   * `projectionAspect` is expected to track `canvas.aspect`, since the projection
   * is documented as matching the rendered camera feed; a drift there means the
   * render and the keyframe intrinsics have come apart.
   *
   * `trackSettings` is the raw getUserMedia track resolution, logged only to
   * show which constraint the engine settled on. It can legitimately disagree
   * with `frame` in orientation: browsers differ on whether they report rotated
   * or sensor-native dimensions on a portrait device. `frame` is the camera feed
   * size the engine reports, so `frame` is what we fit with.
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

  /**
   * Arm the waiting verdict for a camera prompt nobody answers. Measured from the
   * first `requesting`, and not re-armed by repeats of it. The bound only says
   * "still waiting": it does not decide that access was refused.
   */
  private _armCameraPromptRuling(): void {
    if (this._cameraPromptTimer !== null || this._cameraStreamMs !== null) return
    this._cameraPromptTimer = setTimeout(() => {
      this._cameraPromptTimer = null
      console.warn(`[8thwall] No camera stream ${CAMERA_PROMPT_TIMEOUT_MS / 1000} s after the request — the permission prompt may still be open`)
      this._emitCameraPromptPending()
    }, CAMERA_PROMPT_TIMEOUT_MS)
  }

  private _disarmCameraPromptRuling(): void {
    if (this._cameraPromptTimer === null) return
    clearTimeout(this._cameraPromptTimer)
    this._cameraPromptTimer = null
  }

  /** The camera was requested and has not answered within the bound. See cameraPendingVerdict(). */
  private _emitCameraPromptPending(): void {
    if (!this._onPreflight) return
    this._onPreflight(cameraPendingVerdict())
  }

  /**
   * The engine reported that the camera failed. The verdict follows its reason:
   * a permission verdict only for DENY_CAMERA, and neutral wording otherwise.
   * The lens is not what is wrong, and blaming it sent people to uncover a
   * camera that was never on.
   */
  private _emitCameraFailure(reason: string | undefined): void {
    this._disarmCameraPromptRuling()
    if (!this._onPreflight) return
    this._onPreflight(cameraFailureVerdict(reason))
  }

  stop(): void {
    XR8.stop()
    this._scene = null
    this._engineScale.reset()
    this._disarmCameraPromptRuling()
    // A pending ruling outlives the session it was judging otherwise, and would
    // warn about a pose that stopped being expected the moment we stopped.
    if (this._poseRulingTimer !== null) {
      clearTimeout(this._poseRulingTimer)
      this._poseRulingTimer = null
    }
    this._cameraStreamMs = null
    this._preflightRuled = false
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility)
      this._onVisibility = null
    }
    // A later start() is a new map, so the next trustworthy frame begins a new epoch
    // instead of being compared with a pose from this session.
    this._epochs.noteSessionEnd()
    this._poseAtMs = null
    this._frameMs = null
    this._poseHeld = false
    this._hiddenAtMs = null
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

  getTrackingDiagnostics(): TrackingDiagnostics {
    // How old the pose a capture would carry is, as of the last frame the engine delivered:
    // 0 while a pose arrives every frame, growing while one is being held over.
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
   * XR8 documents them as numbers from 0 to 1 across the camera feed, from its upper left corner
   * (https://8thwall.org/docs/api/engine/xrcontroller/hittest). The canvas is what displays the feed
   * (`updateCameraProjectionMatrix` calls it "the canvas that displays the camera feed",
   * https://8thwall.org/docs/api/engine/xrcontroller/updatecameraprojectionmatrix), so it is the box
   * they are taken against, and `provider.ts` calls them "normalised screen coords" — a distinction
   * with no difference while the canvas fills the viewport. Under the `contain` fit it stops filling the
   * viewport, so the two disagree by the letterbox. Callers that divide by the
   * canvas's own `getBoundingClientRect()` (project-calibration.ts) stay
   * correct. The resolver gets the right point from `imagePointToHitTestPoint()`
   * below, not by dividing by the window. Not corrected here: converting inside
   * this method would double-correct the callers that already got it right.
   */
  hitTest(x: number, y: number): HitResult | null {
    const results = XR8.XrController.hitTest(x, y, this.hitTypes())
    console.log('[8thwall-hitTest] input:', x, y, 'raw results:', JSON.stringify(results))
    return this.usableHit(results)
  }

  /**
   * What `hitTest()` takes from the engine's answer: the first result, with a distance from the engine or else
   * measured from the latest pose, if it is a point worth trusting. Apart from `hitTest()` so that a tap's burst
   * can do the same every frame without writing a log line every frame.
   */
  private usableHit(results: ReturnType<typeof XR8.XrController.hitTest> | undefined): HitResult | null {
    if (!results?.length) return null
    const { position, rotation } = results[0]
    const reportedDistance = results[0].distance
    const computedDistance = position ? poseDistance(position, this.latestPose.position) : NaN
    const distance = Number.isFinite(reportedDistance) && reportedDistance > 0
      ? reportedDistance
      : computedDistance
    if (!position || !usefulWorldPoint(position, this.latestPose)) return null
    // A position was measured: what the unit was worth at that moment is part of what a calibration made
    // from it is worth (see engine-config.ts).
    this._engineScale.noteMeasurement(this.trackingStatus())
    return { position, rotation, distance }
  }

  /** `hitTypesFromSearch()` of this page, read the first time a hit is asked for. */
  private _hitTypes: string[] | null = null
  private hitTypes(): string[] {
    this._hitTypes ??= hitTypesFromSearch(window.location.search)
    return this._hitTypes
  }

  /** Numbers the burst's pipeline modules, so two bursts at once never share a name (a module's name must be unique within the application, https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule). */
  private static _burstSeq = 0

  /**
   * How long past its window a burst waits for a frame before it settles with the frames it has. A bound, so a
   * stopped or paused engine cannot hold a tap open.
   *
   * **Adopted, not measured (ADR 0005 rule 5).**
   */
  private static readonly BURST_GRACE_MS = 1_000

  /**
   * How long after the call a burst waits for its first frame before concluding that the pipeline module it
   * added is not being called, and settling empty so the tap is read with one hit while the camera is still
   * where it was tapped. A running engine delivers a frame within a display refresh or two; this is about ten
   * of them at 30 frames a second.
   *
   * **Adopted, not measured (ADR 0005 rule 5).** A device shows how long the first frame takes.
   */
  private static readonly BURST_FIRST_FRAME_MS = 300

  /**
   * One hit test per new camera frame for `windowMs`, so a tap can be read as a median (./tap-sampling.ts).
   *
   * The documentation states no rate limit for `XrController.hitTest` and says nothing about the tracking status
   * (https://8thwall.org/docs/api/engine/xrcontroller/hittest), so it is asked once per frame here, and a hit is
   * taken to say nothing about the frame it came from. That is why the status and reason published for each
   * frame are recorded beside its hit and left for `sampleTap()` to judge. A frame with no reality at all (the
   * engine paused, or not yet answering) is reported `NOT_AVAILABLE`, which that judgement refuses.
   *
   * The frames come from a pipeline module that exists only for the window (./hit-burst.ts removes it on every
   * way out, including a watchdog if the engine stops delivering frames, and an early close if it never
   * delivers one). The page's display can refresh faster than the camera delivers: `onUpdate` is then called
   * again with `frameStartResult.repeatFrame` true, documented as the camera feed not having updated since the
   * last call (https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu), which is no new
   * observation, so those calls are not frames of the burst.
   *
   * The documentation says a module may be added while the pipeline is running (`onAttach` is called on modules
   * added before or after, https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule). It does not say from
   * which frame such a module is called, and that has not been seen on a device. If it were not called, the burst
   * would see no frame, close empty after BURST_FIRST_FRAME_MS, and `sampleTap()` would read the tap with one hit:
   * a tap whose source reads `single-hit` where `burst` was expected shows it.
   */
  hitTestBurstAsync(x: number, y: number, windowMs: number, onFrame?: BurstFrameListener): Promise<HitBurst> {
    if (typeof XR8 === 'undefined') return Promise.resolve({ frames: [] })
    const name = `ci-tap-burst-${++EighthWallProvider._burstSeq}`
    return collectBurst(windowMs, EighthWallProvider.BURST_GRACE_MS, (run) => {
      XR8.addCameraPipelineModule({
        name,
        // Added after the capture module, so its onUpdate has already put this frame's reality into latestPose.
        onUpdate: (args: { processCpuResult?: Record<string, unknown>; processGpuResult?: Record<string, unknown>; frameStartResult?: Record<string, unknown> }) => {
          if (run.done || args.frameStartResult?.['repeatFrame'] === true) return
          const reality = findRealityObject(args.processCpuResult ?? args.processGpuResult ?? args.frameStartResult)
          let hit: HitResult | null = null
          if (this._slamReady) {
            try {
              hit = this.usableHit(XR8.XrController.hitTest(x, y, this.hitTypes()))
            } catch {
              // Intermittent WASM map miss, as in featurePoints(): this frame has no hit.
            }
          }
          const reason = reality?.['trackingReason']
          run.frame({
            hit,
            pose: (reality && poseFromReality(reality)) || undefined,
            status: reality ? String(reality['trackingStatus'] ?? 'UNKNOWN') : 'NOT_AVAILABLE',
            reason: typeof reason === 'string' ? reason : undefined,
            poseJumps: this._epochs.diagnostics().poseJumps,
          }, performance.now())
        },
      })
      return () => XR8.removeCameraPipelineModule(name)
    }, { firstFrameMs: EighthWallProvider.BURST_FIRST_FRAME_MS, onFrame })
  }

  /**
   * The point `hitTest()` takes for a point on the captured camera frame.
   *
   * `hitTest()` takes canvas coordinates. Under `contain` the canvas is the whole
   * camera frame, so an image-normalised point already is one, and nothing is
   * cropped. Under `cover` the canvas is the viewport and the engine crops the
   * frame to fill it, so the window cover-crop applies.
   */
  imagePointToHitTestPoint(
    x: number,
    y: number,
    imageSize: ViewSize | undefined,
    viewportSize: ViewSize | undefined,
  ): { x: number; y: number } {
    if (this._fit === 'contain') return { x, y }
    return imagePointToViewportPoint(x, y, imageSize, viewportSize)
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

    // Fall back to grid hit-tests when no world points came with the frame (the documentation says
    // `worldPoints` is only filled when XrController is configured to return them)
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

  /**
   * What one unit of this session is worth: `'arbitrary'` in the default responsive scale, and in
   * absolute scale until the tracking status is NORMAL (or when the engine did not take absolute scale),
   * then `'estimated-metric'`. Never `'metric'`: this runtime estimates metres and the estimate has not
   * been measured. `since`: see `ARProvider.scaleMode`. See engine-config.ts.
   */
  scaleKind(since?: number): ScaleKind {
    return this._engineScale.kind(this.trackingStatus(), since)
  }

  /** True only in absolute scale the engine took, with tracking NORMAL. The engine documents no stronger signal. */
  scaleReady(): boolean {
    return this._engineScale.ready(this.trackingStatus())
  }

  /** Which configuration produced the unit; `scaleKind()` is derived from it. */
  scaleMode(since?: number): ScaleMode {
    return this._engineScale.mode(this.trackingStatus(), since)
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
