/**
 * RoomScanner — drives the continuous SLAM point-cloud accumulation loop.
 *
 * Every `intervalMs` milliseconds it asks the AR provider for a batch of
 * feature points sampled on a grid of screen-space hit-tests, records the
 * current pose, and fires `onFrame`.
 *
 * Usage:
 *   const scanner = new RoomScanner()
 *   scanner.start(provider, (frame) => {
 *     pointCloud.add(frame.points)
 *     poseHistory.push(frame.pose)
 *   })
 *   // …later…
 *   scanner.stop()
 */
import type { ARProvider, Pose } from './provider'

export interface ScanFrame {
  /** 3D world positions returned from hit-tests at this interval tick */
  points: ReadonlyArray<{ x: number; y: number; z: number }>
  /** Camera pose at the time of the scan */
  pose: Pose
  /** performance.now() timestamp */
  timestampMs: number
}

export type ScanFrameCallback = (frame: ScanFrame) => void

const DEFAULT_INTERVAL_MS = 750
const DEFAULT_GRID_SIZE   = 6   // 6×6 = 36 hit-tests per tick

export class RoomScanner {
  private _handle: ReturnType<typeof setInterval> | null = null
  private _scanning = false

  get isScanning(): boolean {
    return this._scanning
  }

  start(
    provider: ARProvider,
    onFrame: ScanFrameCallback,
    intervalMs = DEFAULT_INTERVAL_MS,
    gridSize = DEFAULT_GRID_SIZE,
  ): void {
    if (this._scanning) return
    this._scanning = true
    this._handle = setInterval(() => {
      try {
        const points = provider.featurePoints(gridSize)
        const pose   = provider.getPose()
        onFrame({ points, pose, timestampMs: performance.now() })
      } catch (e) {
        console.warn('[scanner] tick error (SLAM not ready?):', e)
      }
    }, intervalMs)
  }

  stop(): void {
    if (this._handle !== null) {
      clearInterval(this._handle)
      this._handle = null
    }
    this._scanning = false
  }
}
