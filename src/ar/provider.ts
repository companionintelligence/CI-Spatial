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
   * Calling this multiple times before a frame arrives queues all callers —
   * each caller gets their own copy once the next frame lands.
   */
  captureFrame(): Promise<RawFrame>
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
   * Returns true once the AR runtime has locked on and tracking is stable.
   * Hit-tests and captures before this point may return unreliable results.
   */
  isTracking(): boolean

  /**
   * Vertical field-of-view in degrees for the AR camera.
   * Used to reconstruct a Three.js PerspectiveCamera from the SLAM pose
   * when the Threejs pipeline module is not loaded.
   */
  getCameraFovY(): number

  /**
   * Viewport aspect ratio (width / height) at the time XR was started.
   */
  getCameraAspect(): number
}
