/**
 * ScanQualityMonitor — real-time quality feedback during room scanning.
 *
 * Tracks four signals:
 *   coverage         — point‑cloud density vs. estimated room floor area
 *   driftRisk        — camera movement speed; exceeding 0.8 m/s risks SLAM drift
 *   lowLight         — mean frame luminance below threshold
 *   reflectiveSurface— high luminance variance suggests reflective material
 *
 * Usage:
 *   const monitor = new ScanQualityMonitor()
 *   // On each SLAM tick:
 *   const snap = monitor.tick(provider, pointCloud)
 *   // After each capture:
 *   const { lowLight, reflective } = await monitor.analyseFrame(blob)
 */

import type { ARProvider } from '../ar/provider'
import type { PointCloud } from '../scene/pointcloud'
import type { ScanQualitySummary } from '../world/types'

export type DriftRisk = 'low' | 'medium' | 'high'

export interface QualitySnapshot {
  /** 0–1; 1.0 means excellent surface coverage */
  coverageScore: number
  /** Human-readable label for coverageScore */
  coverageText: string
  /** Whether the current (or most-recent) frame was too dark */
  lowLight: boolean
  /** Whether the camera is moving fast enough to risk SLAM drift */
  driftRisk: DriftRisk
  /** Whether last frame contained likely-reflective surface (high luminance variance) */
  reflectiveSurface: boolean
  /** Number of floor-plane cells with near-zero point density */
  missingAreas: number
  /** Points added per second over the last tick interval */
  pointsPerSecond: number
  /** True when SLAM tracking is lost */
  trackingLost: boolean
}

export interface FrameQuality {
  lowLight: boolean
  reflective: boolean
  /** True when the decoded image is effectively a single flat colour. */
  uniformFrame: boolean
  meanLuminance: number
  luminanceStddev: number
}

/**
 * Is this frame bad enough that holding on to it would buy nothing?
 *
 * The capture path keeps a frame whose inference failed so it can be re-run
 * later — but only when the frame is the good half of the capture. A frame the
 * monitor already warned the user about, too dark to read or a reflective
 * surface that defeats the detector, will not read any better on a second pass.
 *
 * Fail-safe by construction: analyseFrame() returns benign values when it cannot
 * decode the blob at all, so a frame that could not be analysed counts as usable
 * and is kept. Doubt favours keeping the photograph.
 */
export function isFrameUnusable(q: FrameQuality): boolean {
  return q.lowLight || q.reflective || q.uniformFrame
}

export interface QualityCounts {
  lowLightFrames: number
  driftEvents: number
  reflectiveWarnings: number
  totalFrames: number
}

// Tunable thresholds
const LUMI_LOW   = 0.22   // mean luminance below this = too dark
const LUMI_REFL  = 0.17   // luminance stddev above this (with mean > 0.30) = reflective
const LUMI_UNIFORM = 0.012 // solid canvas/camera placeholder, not a usable room view
const DRIFT_MED  = 0.8    // m/s — triggers 'medium' drift warning
const DRIFT_HIGH = 2.0    // m/s — triggers 'high' drift warning
const TARGET_PTS_M2 = 600 // SLAM points per m² for a "full" scan
const GRID       = 4      // 4×4 cell grid for missing-area detection

export class ScanQualityMonitor {
  private _prevCount   = 0
  private _prevTickMs  = 0
  private _ptsPerSec   = 0
  private _poseWindow: Array<{ x: number; y: number; z: number; t: number }> = []
  private _coverageScore = 0
  private _lastLowLight = false
  private _lastReflective = false
  private _lastSnapshot: QualitySnapshot | null = null

  // Cumulative quality counters (for session summary)
  private _counts: QualityCounts = {
    lowLightFrames: 0,
    driftEvents: 0,
    reflectiveWarnings: 0,
    totalFrames: 0,
  }

  get counts(): Readonly<QualityCounts> {
    return this._counts
  }

  /**
   * Call on every SLAM scanner tick.
   * Returns a snapshot of all quality signals based on provider + point cloud state.
   */
  tick(provider: ARProvider, pointCloud: PointCloud): QualitySnapshot {
    const now = performance.now()
    const count = pointCloud.count

    // Points per second over the last tick
    if (this._prevTickMs > 0) {
      const dt = Math.max(0.001, (now - this._prevTickMs) / 1_000)
      const added = Math.max(0, count - this._prevCount)
      this._ptsPerSec = Math.round(added / dt)
    }
    this._prevTickMs = now
    this._prevCount  = count

    // Coverage: point density scaled by floor area
    const bb = count > 0 ? pointCloud.boundingBox() : null
    if (bb && count > 0) {
      const floorArea = Math.max(0.1,
        (bb.max.x - bb.min.x) * (bb.max.z - bb.min.z))
      this._coverageScore = Math.min(1, count / (floorArea * TARGET_PTS_M2))
    }

    // Missing areas: 4×4 floor grid cells with less than 10% of average density
    let missingAreas = 0
    if (bb && count > 0) {
      missingAreas = this._countEmptyCells(pointCloud, bb)
    }

    // Drift risk based on camera speed
    let driftRisk: DriftRisk = 'low'
    if (provider.isTracking()) {
      const pose = provider.getPose()
      const cur = { ...pose.position, t: now }
      this._poseWindow.push(cur)
      if (this._poseWindow.length > 12) this._poseWindow.shift()

      if (this._poseWindow.length >= 2) {
        const prev = this._poseWindow[this._poseWindow.length - 2]
        const dt = Math.max(0.001, (cur.t - prev.t) / 1_000)
        const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z
        const speed = Math.sqrt(dx*dx + dy*dy + dz*dz) / dt
        if (speed >= DRIFT_HIGH) {
          driftRisk = 'high'
          this._counts.driftEvents++
        } else if (speed >= DRIFT_MED) {
          driftRisk = 'medium'
        }
      }
    }

    const snapshot = {
      coverageScore:    this._coverageScore,
      coverageText:     coverageLabel(this._coverageScore),
      lowLight:         this._lastLowLight,
      driftRisk,
      reflectiveSurface: this._lastReflective,
      missingAreas,
      pointsPerSecond:  this._ptsPerSec,
      trackingLost:     !provider.isTracking(),
    }
    this._lastSnapshot = snapshot
    return snapshot
  }

  /**
   * Serialisable quality gate saved alongside GLB uploads. The thresholds are
   * deliberately conservative: they should guide review/rescan decisions, not
   * reject a user's work with false precision.
   */
  summary(input: {
    pointCount: number
    detectionCount: number
    poseCount: number
    keyframeCount?: number
  }): ScanQualitySummary {
    const snap = this._lastSnapshot
    const coverageScore = snap?.coverageScore ?? this._coverageScore
    const missingAreas = snap?.missingAreas ?? 0
    const trackingLost = snap?.trackingLost ?? false
    const recommendations: string[] = []

    if (input.pointCount < 150) recommendations.push('Collect more tracking points before export.')
    if (coverageScore < 0.55) recommendations.push('Sweep the room more slowly to improve surface coverage.')
    if (missingAreas >= 4) recommendations.push('Rescan sparse floor-grid areas from another angle.')
    if (this._counts.lowLightFrames > 0) recommendations.push('Add light or revisit dark surfaces.')
    if (this._counts.driftEvents > 0) recommendations.push('Move slower to reduce SLAM drift.')
    if (this._counts.reflectiveWarnings > 0) recommendations.push('Review reflective surfaces for false geometry.')
    if (input.keyframeCount === 0) recommendations.push('Stream RGB keyframes for reconstruction and splat processing.')

    let status: ScanQualitySummary['status'] = 'ready'
    if (input.pointCount < 75 || coverageScore < 0.25 || trackingLost) {
      status = 'needs-rescan'
    } else if (recommendations.length > 0 || coverageScore < 0.8) {
      status = 'needs-review'
    }

    return {
      coverageScore,
      coverageText: coverageLabel(coverageScore),
      pointCount: input.pointCount,
      detectionCount: input.detectionCount,
      poseCount: input.poseCount,
      keyframeCount: input.keyframeCount ?? 0,
      lowLightFrames: this._counts.lowLightFrames,
      driftEvents: this._counts.driftEvents,
      reflectiveWarnings: this._counts.reflectiveWarnings,
      missingAreas,
      trackingLost,
      status,
      recommendations,
      capturedAt: new Date().toISOString(),
    }
  }

  /**
   * Analyse a captured image Blob for lighting and surface quality.
   * Cheap: downsamples to 64×64 before computing luminance statistics.
   */
  async analyseFrame(blob: Blob): Promise<FrameQuality> {
    this._counts.totalFrames++
    try {
      const bitmap = await createImageBitmap(blob)
      const oc  = new OffscreenCanvas(64, 64)
      const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 64, 64)
      bitmap.close()

      const data = ctx.getImageData(0, 0, 64, 64).data
      const n = data.length / 4
      let sum = 0, sumSq = 0
      for (let i = 0; i < data.length; i += 4) {
        // Rec. 601 luminance coefficient
        const lum = (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]) / 255
        sum   += lum
        sumSq += lum * lum
      }
      const mean = sum / n
      const variance = sumSq / n - mean * mean
      const stddev = Math.sqrt(Math.max(0, variance))

      // A camera permission/startup failure can still produce a decodable JPEG,
      // but its pixels are nearly identical. Do not send that placeholder to
      // inference as if it were a photograph of the room.
      const uniformFrame = stddev < LUMI_UNIFORM
      const lowLight  = mean < LUMI_LOW
      const reflective = stddev > LUMI_REFL && mean > 0.30

      if (lowLight)   this._counts.lowLightFrames++
      if (reflective) this._counts.reflectiveWarnings++

      this._lastLowLight   = lowLight
      this._lastReflective = reflective
      return { lowLight, reflective, uniformFrame, meanLuminance: mean, luminanceStddev: stddev }
    } catch {
      return { lowLight: false, reflective: false, uniformFrame: false, meanLuminance: 0.5, luminanceStddev: 0 }
    }
  }

  private _countEmptyCells(
    pointCloud: PointCloud,
    bb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  ): number {
    const positions  = pointCloud.toFloat32Array()
    const counts     = new Int32Array(GRID * GRID)
    const xRange     = bb.max.x - bb.min.x || 1
    const zRange     = bb.max.z - bb.min.z || 1
    const total      = pointCloud.count

    for (let i = 0; i < positions.length; i += 3) {
      const cx = Math.min(GRID - 1, Math.floor(((positions[i]   - bb.min.x) / xRange) * GRID))
      const cz = Math.min(GRID - 1, Math.floor(((positions[i+2] - bb.min.z) / zRange) * GRID))
      counts[cz * GRID + cx]++
    }

    const threshold = Math.max(1, Math.floor(total / (GRID * GRID) * 0.1))
    return Array.from(counts).filter(c => c < threshold).length
  }
}

function coverageLabel(score: number): string {
  if (score < 0.25) return 'Low — keep scanning'
  if (score < 0.55) return 'Partial — scan more surfaces'
  if (score < 0.80) return 'Good'
  return 'Excellent'
}
