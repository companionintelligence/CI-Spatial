import type * as THREE from 'three'
import type { TrackingStatus } from './tracking-quality'

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
}

/** Result of a hit-test at normalised screen coords */
export interface HitResult {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  distance: number
}

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
   *   never cleared. 8th Wall reports a live `trackingStatus`
   *   (`INITIALIZING` / `LIMITED` / `NORMAL` / `NOT_AVAILABLE`) which the
   *   provider logs and discards, so a session that degrades to `LIMITED`
   *   still reports tracking here.
   * - `WebXRProvider` returns `session !== null && _haveRealProjection`,
   *   i.e. the same "a usable pose has arrived at least once".
   *
   * Callers that need *current* tracking quality do not get it from this —
   * `QualityMonitor.tick()`'s `trackingLost: !provider.isTracking()` is
   * therefore only ever true before the first pose, and
   * `KeyframeStreamer._tick()` will keep streaming through degraded tracking.
   * Fixing that means surfacing the runtime's own status, not retitling this.
   */
  isTracking(): boolean

  /**
   * The runtime's OWN live tracking status — the thing `isTracking()` above
   * explains it cannot give you.
   *
   * 8th Wall publishes this on every reality frame; `WebXRProvider` has no
   * equivalent and reports `'UNKNOWN'`. Use `trackingIsUsable()`
   * (`src/ar/tracking-quality.ts`) to judge it rather than comparing strings at
   * call sites, so every caller agrees on what counts as degraded.
   */
  trackingStatus(): TrackingStatus

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
   * A live, world-locked Three.js scene the caller can add/remove objects to
   * (e.g. the calibration decal) — null until start() has set one up, and
   * only implemented by providers that maintain a Three.js scene graph
   * (both WebXRProvider and EighthWallProvider do; a provider without one
   * simply omits this method).
   */
  getScene?(): THREE.Scene | null
}
