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
}
