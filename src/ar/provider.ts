import type * as THREE from 'three'
import type { TrackingStatus } from './tracking-quality'
import type { PreflightVerdict } from './preflight'
import type { AnchorCapability } from './anchors'
import type { FrameDiscontinuity, TrackingDiagnostics } from './frame-epoch'
import type { ScaleKind, ScaleMode } from '../world/scale-mode'

/** 6-DoF camera pose from the AR runtime */
export interface Pose {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
}

/**
 * A single raw camera frame snapshot.
 * Pixels are RGBA, row-major, same dimensions as the camera feed.
 */
export interface RawFrame {
  pixels: Uint8ClampedArray
  width: number
  height: number
  pose: Pose
  timestamp: number
  /**
   * The frame epoch the pose was read in (see src/ar/frame-epoch.ts), stamped by the
   * provider in the same step as the pose so the two cannot disagree. Absent from a
   * provider with no epoch signal, which reads as epoch 0.
   */
  epoch?: number
}

/** Result of a hit-test at normalised screen coords */
export interface HitResult {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  distance: number
}

/**
 * One runtime frame inside a hit-test burst: what the hit test answered, and what the runtime said about
 * itself in that same frame. The provider reports the facts and `sampleTap()` (./tap-sampling.ts) judges them.
 */
export interface HitBurstFrame {
  /** The hit for this frame, or null when the runtime had none or no pose to measure it from. */
  hit: HitResult | null
  /** The camera pose of this frame, when the runtime gave one. The floor ray is cast from it. */
  pose?: Pose
  /**
   * The runtime's own tracking status for this frame, verbatim. `'UNKNOWN'` when it publishes none, and
   * `'NOT_AVAILABLE'` when the runtime gave no camera pose at all for the frame, which is the one thing a
   * runtime with no status of its own can say about tracking being lost.
   */
  status: string
  /** The runtime's reason beside the status (8th Wall documents INITIALIZING and UNSPECIFIED; see tracking-quality.ts), verbatim. */
  reason?: string
  /** The provider's running count of frame shifts, when it keeps one. A change inside a burst straddles a shift. */
  poseJumps?: number
}

/** The frames a hit-test burst saw, in order, with or without a hit. */
export interface HitBurst {
  frames: HitBurstFrame[]
}

/**
 * Told about each frame of a hit-test burst as it is recorded, with the milliseconds since the burst's first
 * frame (0 for the first). It is how a screen shows a tap still being read; it cannot change the burst, and a
 * listener that throws is ignored.
 */
export type BurstFrameListener = (frame: HitBurstFrame, elapsedMs: number) => void

/**
 * Thin abstraction over 8th Wall and WebXR so the rest of the app
 * doesn't care which AR runtime is active.
 */
export interface ARProvider {
  /** Boot the AR session and attach it to the given canvas */
  start(canvas: HTMLCanvasElement): Promise<void>
  /** Tear down the AR session */
  stop(): void
  /**
   * Returns a promise that resolves with the very next camera frame.
   * Rejects if another capture is already pending or if no frame arrives before
   * `timeoutMs`, so the UI can recover instead of waiting forever.
   */
  captureFrame(timeoutMs?: number): Promise<RawFrame>
  /**
   * Synchronous hit-test at normalised screen coords (0–1, 0–1).
   * Returns null when no SLAM feature point is found beneath the coordinate.
   * Must not be called before `start()` resolves.
   */
  hitTest(x: number, y: number): HitResult | null

  /**
   * Hit-test the same screen point once per new runtime frame for `windowMs`, and report every frame it saw, so
   * a tap can be a median of many hits instead of one snapped sample.
   *
   * Optional. A provider without it is read with one hit by `sampleTap()`. Resolves with whatever frames it got,
   * and never later than `windowMs` plus a bounded grace; resolves with no frames when the session cannot run
   * a burst, or when the runtime delivers none. Whatever it holds open (a hit-test source, a pipeline module) is
   * released before it resolves: when the window closes, when the runtime stops delivering frames (every
   * provider has a watchdog for that), and, where the runtime says so, when the session ends (WebXR's `end`
   * event; 8th Wall has no such hook and relies on the watchdog).
   */
  hitTestBurstAsync?(x: number, y: number, windowMs: number, onFrame?: BurstFrameListener): Promise<HitBurst>

  /**
   * Sample SLAM feature-point world positions at a `gridSize×gridSize` grid
   * of normalised screen coordinates.  Returns all positions that resolve
   * against the live SLAM map.  Empty array on platforms without feature-
   * point access or before SLAM initialises.
   */
  featurePoints(gridSize?: number): Array<{ x: number; y: number; z: number }>

  /** Return the current camera pose without blocking. */
  getPose(): Pose

  /**
   * Returns true once the AR runtime has produced a real pose.
   *
   * **This is "tracking has started", not "tracking is currently good."** The
   * doc here used to claim the latter ("locked on and tracking is stable") and
   * no implementation delivers it:
   * - `EighthWallProvider` returns `_slamReady`, set on the *first* pose and
   *   never cleared. 8th Wall reports a live `trackingStatus` (documented:
   *   `LIMITED` or `NORMAL`, https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule)
   *   which this method ignores, so a session that degrades to `LIMITED`
   *   still reports tracking here.
   * - `WebXRProvider` returns `session !== null && _haveRealProjection`,
   *   i.e. the same "a usable pose has arrived at least once".
   *
   * Callers that need *current* tracking quality do not get it from this; they
   * read `trackingStatus()` below, which is the runtime's own live status.
   * `QualityMonitor.tick()` and `KeyframeStreamer._tick()` both do.
   */
  isTracking(): boolean

  /**
   * The runtime's OWN live tracking status — the thing `isTracking()` above
   * explains it cannot give you.
   *
   * 8th Wall publishes this on every reality frame. `WebXRProvider` has no status
   * of its own, so it derives one from what WebXR does report: a frame with no
   * viewer pose reads `'NOT_AVAILABLE'`, a pose whose position is emulated
   * (`XRPose.emulatedPosition`) reads `'LIMITED'`, any other pose `'NORMAL'`, and it
   * is `'UNKNOWN'` before its first frame. Use `trackingIsUsable()`
   * (`src/ar/tracking-quality.ts`) to judge it rather than comparing strings at
   * call sites, so every caller agrees on what counts as degraded.
   */
  trackingStatus(): TrackingStatus

  /**
   * What one unit of this session's coordinates is worth: `'metric'` (WebXR, and the native plugin),
   * `'arbitrary'` (8th Wall in its default responsive scale, or in absolute scale the engine did not
   * take) or `'estimated-metric'` (8th Wall in absolute scale, once tracking is NORMAL; before that it
   * is `'arbitrary'`). See `src/world/scale-mode.ts` for what each of them claims and does not claim.
   * `since`: see `scaleMode()`.
   *
   * Everything in the app that says "metres" (the separation check, the 0.15 m tolerance, a distance on
   * screen) is only as true as this. Optional so a provider that cannot say simply omits it, and a
   * caller then has nothing to stamp. The measurement probe planned for device experiment DX1 reads
   * this by duck typing, so keep the name.
   */
  scaleKind?(since?: number): ScaleKind

  /**
   * Whether a metric unit is in force: true for a runtime that is metric by contract, and for 8th Wall
   * in absolute scale once tracking is NORMAL. False for 8th Wall in responsive scale (its unit never
   * becomes metric, so there is nothing to wait for), before an absolute start is NORMAL, and when
   * absolute scale was asked for and the engine did not take it.
   *
   * The engine documents no separate "scale is ready" signal. The nearest one it documents is the
   * tracking status that the Coaching Overlay follows
   * (https://info.nianticspatial.com/blog/introducing-absolute-scale), so NORMAL is used, and that it
   * means the estimate has settled is adopted, not measured (ADR 0005 rule 5).
   */
  scaleReady?(): boolean

  /**
   * Which configuration produced this session's unit, as the string stored beside a calibration. The
   * provenance behind `scaleKind()`: the kind is always `scaleKindOfMode()` of this.
   *
   * `since` is a `performance.now()` reading taken before a calibration flow began. The 8th Wall
   * provider notes the tracking status at every position its `hitTest()` measures, so when `since` is
   * given it reports `'absolute-notready'` for a flow that measured a point before the scale was ready,
   * even when the status is NORMAL by the time the flow ends. Without it the answer is the unit at this
   * instant. Runtimes whose unit does not depend on tracking ignore it.
   */
  scaleMode?(since?: number): ScaleMode

  /**
   * Vertical field-of-view in degrees for the AR camera.
   *
   * Used to reconstruct a Three.js PerspectiveCamera from the SLAM pose when
   * the Threejs pipeline module is not loaded — and, the consumer this doc
   * omitted, written into every keyframe's `intrinsics.fovYDeg` by
   * `KeyframeStreamer` and by `pose-track.ts`. `deriveIntrinsics()` in
   * `server/splat/splat_train_dataset.ts` turns that into the `fl_x`/`fl_y`
   * of the Brush training dataset, so an implementation's fallback constant
   * does not stay local to the viewer: it reaches reconstruction looking like
   * a measured focal length. `EighthWallProvider` currently always returns its
   * 60° fallback — see the note there.
   */
  getCameraFovY(): number

  /**
   * Viewport aspect ratio (width / height) at the time XR was started.
   */
  getCameraAspect(): number

  /**
   * Runtime anchors, where this runtime can hold them (`WebXRProvider` when the browser granted the 'anchors' feature).
   * Undefined everywhere else, and a caller must work without it: an optional accelerator, never the foundation of the
   * Place frame. See src/ar/anchors.ts, and `tryCreateAnchor` there for the call that cannot stall or throw.
   */
  readonly anchors?: AnchorCapability

  /**
   * Subscribe to this runtime's own preflight verdict — "did AR actually start
   * working", answered on a timer rather than by a return value.
   *
   * Optional, and only implemented by a runtime that has the signal.
   * `EighthWallProvider` does: it already ran a 5 s "pose not received" timer
   * for a console warning, and that timer is now what produces the verdict, so
   * this is a second reader of one existing signal rather than a competing
   * notion of readiness (see `src/ar/preflight.ts`). `WebXRProvider` omits it —
   * its equivalent failure is a `requestSession()` rejection, which the caller
   * already has in hand and classifies with `startFailureVerdict()`.
   *
   * The callback may fire more than once: a late pose re-reports `'ready'`, so
   * a UI that warned at 5 s can take the warning back at 8 s.
   */
  onPreflightVerdict?(cb: (verdict: PreflightVerdict) => void): void

  /**
   * A live, world-locked Three.js scene the caller can add/remove objects to
   * (e.g. the calibration decal) — null until start() has set one up, and
   * only implemented by providers that maintain a Three.js scene graph
   * (both WebXRProvider and EighthWallProvider do; a provider without one
   * simply omits this method).
   */
  getScene?(): THREE.Scene | null
  /**
   * Live tracking health, for on-screen diagnostics.
   *
   * `poseJumps` counts steps where the camera moved or turned by more than smooth
   * motion explains, the runtime's own reports that its origin moved, and, where
   * the runtime holds anchors (`anchors`, below), a step of one by at least the
   * epoch rule's threshold — the signature of SLAM redefining its own origin.
   * When that happens every world-locked object shifts together and any
   * previously harvested points are left in a frame that no longer exists, which
   * is otherwise undetectable from inside the app: the pose keeps updating and
   * the status can stay NORMAL throughout. `epoch` is the broader count: it also
   * includes tracking that came back after a relocalization, resumes, and an
   * anchor the runtime gave up on, which are suspect rather than measured
   * (see src/ar/frame-epoch.ts).
   *
   * `reason` is the runtime's own account of why `status` is what it is, when the
   * runtime gives one: 8th Wall publishes `trackingReason` beside `trackingStatus`, and the
   * provider passes it through as the engine spelled it. The documentation lists `INITIALIZING`
   * and `UNSPECIFIED` (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule); the
   * other names this app treats as unstable (`RELOCALIZING`, `TOO_MUCH_MOTION`,
   * `NOT_ENOUGH_TEXTURE`, see tracking-quality.ts) are handled in case the engine reports them, and
   * DX4 logs which ones a phone does. Absent where the runtime has none.
   * Nothing branches on it yet: the `?debug=probe` line (src/capture/probe-log.ts) records
   * it, so that a run which saw a frame shift can say what tracking reported at the time.
   *
   * Optional so a provider without the notion simply omits it.
   */
  getTrackingDiagnostics?(): TrackingDiagnostics

  /**
   * The frame epoch the runtime is in: a number that goes up by one at each
   * discontinuity, where the runtime may have redefined its coordinate frame
   * (src/ar/frame-epoch.ts). Points, poses and keyframes recorded in different
   * epochs are not in one frame.
   *
   * Optional: a provider with no signal omits it and reads as epoch 0 for the
   * whole session. Read it with `epochOf()`, not by calling this directly.
   */
  getFrameEpoch?(): number

  /**
   * Call `cb` at each discontinuity, with the event that began the new epoch.
   * Returns the function that stops the callbacks. Any number of subscribers; one
   * that throws is logged and does not stop the others.
   *
   * Optional, like `getFrameEpoch()`: a provider with no signal never fires.
   */
  onFrameDiscontinuity?(cb: (event: FrameDiscontinuity) => void): () => void
}
