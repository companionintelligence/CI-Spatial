/**
 * ScanQualityMonitor — real-time quality feedback during room scanning.
 *
 * Tracks four signals:
 *   coverage         — point‑cloud density vs. estimated room floor area
 *   driftRisk        — camera movement speed; exceeding 0.8 m/s risks SLAM drift. This is
 *                      a RISK, from speed alone: no accumulated error is measured, and the
 *                      count of fast moves is `fastMotionEvents`. What the runtime itself
 *                      says about tracking (a loss, a shift of its origin) comes from the
 *                      provider, as `trackingLost` and as the `frameShifts` the caller
 *                      passes to `summary()`
 *   lighting         — mean frame luminance, in two tiers: 'dim' (advisory) and
 *                      'too-dark' (SLAM has nothing to track at all)
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
import { trackingIsUsable } from '../ar/tracking-quality.ts'
import type { PointCloud } from '../scene/pointcloud'
import type { ScanQualitySummary } from '../world/types'

export type DriftRisk = 'low' | 'medium' | 'high'

/**
 * How much light the camera is actually getting, in the two tiers that call for
 * different advice.
 *
 * `'dim'` is the advisory tier this file has always had (`LUMI_LOW`): usable,
 * but detections and reconstruction will suffer. `'too-dark'` is new and is a
 * different claim — below it there is no gradient in the image for SLAM to
 * track, so the scan is not merely worse, it is not happening.
 *
 * The distinction exists because of a measured evening session: at 19:40 the
 * room was dark, the camera view was black, tracking never acquired, and the
 * only thing on screen was "Tracking lost — move slowly". Moving slowly was
 * never going to help. Nothing in the app looked at luminance on that path,
 * because `analyseFrame()` only runs when a frame is CAPTURED and no capture
 * ever happened.
 */
export type LightingLevel = 'ok' | 'dim' | 'too-dark'

export interface QualitySnapshot {
  /** 0–1; 1.0 means excellent surface coverage */
  coverageScore: number
  /** Human-readable label for coverageScore */
  coverageText: string
  /** Whether the current (or most-recent) frame was too dark */
  lowLight: boolean
  /** The tier of `lowLight` — 'too-dark' means tracking cannot work at all */
  lighting: LightingLevel
  /** Whether the camera is moving fast enough to risk SLAM drift */
  driftRisk: DriftRisk
  /** Whether last frame contained likely-reflective surface (high luminance variance) */
  reflectiveSurface: boolean
  /** Number of floor-plane cells with near-zero point density */
  missingAreas: number
  /** Points added per second over the last tick interval */
  pointsPerSecond: number
  /**
   * True while tracking is not usable right now: no pose yet, or the runtime's own live
   * status says it is degraded (LIMITED, INITIALIZING, NOT_AVAILABLE). This used to be
   * `!provider.isTracking()`, which latches on the first pose and so was true only before it.
   * It follows the status tick by tick, for the on-screen hint; the verdict that is saved
   * with a scan waits for it to last (`trackingLostSustained`).
   */
  trackingLost: boolean
  /** How long tracking has not been usable, up to this tick, in milliseconds. 0 while it is. */
  trackingLostForMs: number
  /**
   * Whether the loss is the kind a saved verdict should say: no pose has arrived yet, or
   * tracking has been unusable for TRACKING_LOST_HOLD_MS. One LIMITED tick, which a quick
   * turn or a blank wall causes, is a blink; the cloud is not recorded while it lasts and
   * nothing already in it is changed.
   */
  trackingLostSustained: boolean
  /** True when the loss is that no pose has ever arrived, rather than one that began after. */
  trackingNotStarted: boolean
}

export interface FrameQuality {
  lowLight: boolean
  /** `lowLight` split into its two tiers; 'dim' and 'too-dark' both set lowLight. */
  lighting: LightingLevel
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

/**
 * Which lighting tier a measured mean luminance falls in.
 *
 * Pure and exported so the thresholds can be tested without a camera — the
 * decision they drive (telling someone their scan cannot work) is not one to
 * verify by holding a phone in a dark room.
 */
export function lightingLevel(meanLuminance: number): LightingLevel {
  if (!Number.isFinite(meanLuminance)) return 'ok'   // unmeasurable → say nothing
  if (meanLuminance < LUMI_DARK) return 'too-dark'
  if (meanLuminance < LUMI_LOW) return 'dim'
  return 'ok'
}

/**
 * The single guidance line shown under the quality overlay (`#quality-motion-hint`).
 *
 * One function decides the whole line, rather than each signal writing its own,
 * because these compete for one element and the wrong one used to win: a dark
 * room produced "Tracking lost — move slowly", which is not merely unhelpful,
 * it is wrong advice that keeps someone walking a room that cannot be scanned.
 *
 * Priority is by what the person can act on, most-blocking first:
 *   1. too dark          — nothing else matters until there is light
 *   2. tracking lost     — and if it is also dim, say light first, motion second
 *   3. moving too fast   — only worth saying while tracking still works
 *
 * Returns '' when there is nothing to say, so the caller hides the line rather
 * than leaving stale advice on screen.
 */
export function motionHintText(input: {
  lighting: LightingLevel
  trackingLost: boolean
  driftRisk: DriftRisk
}): string {
  if (input.lighting === 'too-dark') return 'Too dark to scan — turn on a light'
  if (input.trackingLost) {
    return input.lighting === 'dim'
      ? 'Tracking lost — add light, or move slowly'
      : 'Tracking lost — move slowly'
  }
  if (input.driftRisk === 'high') return '⚠ Moving too fast — slow down'
  return ''
}

export interface QualityCounts {
  lowLightFrames: number
  /**
   * How many scanner ticks the camera moved at 2 m/s or more. A count of fast moves, which
   * is a risk to tracking and not a measure of drift; named for what it counts. The summary
   * still writes it under its old name too (`driftEvents`), because stored summaries and the
   * server read that.
   */
  fastMotionEvents: number
  reflectiveWarnings: number
  totalFrames: number
}

// Tunable thresholds
const LUMI_LOW   = 0.22   // mean luminance below this = too dark
/**
 * Below this, do not tell someone to move slowly — tell them to turn a light on.
 *
 * Set at roughly half of `LUMI_LOW` on purpose, and the gap is the whole point:
 * `LUMI_LOW` is an advisory about detection quality on a frame the camera can
 * still see, while this tier claims the stronger thing — that there is not
 * enough signal in the image for SLAM to find features at all. Making that
 * claim too readily is the expensive mistake: a dim but perfectly trackable
 * room would be told to stop scanning.
 *
 * It is a bound, not a measurement. The evening session that motivated it
 * (19:40, black camera view, tracking never acquired) was diagnosed from the
 * black preview and the absence of any pose, not from a logged mean luminance —
 * nothing sampled luminance on that path, which is the bug. A 64x64 Rec.601
 * mean of 0.10 is about 26/255, i.e. an image with no usable contrast left; if
 * a real capture is ever logged with a mean between these two tiers while
 * tracking works, this is the number to move.
 */
const LUMI_DARK  = 0.10
const LUMI_REFL  = 0.17   // luminance stddev above this (with mean > 0.30) = reflective
const LUMI_UNIFORM = 0.012 // solid canvas/camera placeholder, not a usable room view
/**
 * How long tracking has to be unusable, in milliseconds, before the verdict saved with a
 * scan says it is lost. Autosave and export read the verdict at one instant, and a blink
 * (one 750 ms tick of LIMITED) at that instant would stamp 'needs-rescan' on a scan that
 * is fine, permanently, with no advice attached. A loss that has lasted this long is one
 * the person is standing in, and the advice is to wait for it to end. The on-screen hint is
 * not held: it clears itself on the next tick.
 *
 * Adopted, not measured (ADR 0005 rule 5): about four scanner ticks.
 */
export const TRACKING_LOST_HOLD_MS = 3_000

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
  private _lastLighting: LightingLevel = 'ok'
  private _lastLowLight = false
  /**
   * Frames measured at the `'too-dark'` tier, from captures AND from live
   * samples. Kept separate from `_counts.lowLightFrames`, which counts only
   * CAPTURED frames and feeds the serialised summary — a live sample must not
   * inflate a per-capture statistic that downstream review reads as "how many
   * of the photographs were bad".
   */
  private _tooDarkSeen = 0
  private _lastReflective = false
  private _lastSnapshot: QualitySnapshot | null = null
  /** When tracking last became unusable and has stayed so, on the tick clock. Null while it is usable. */
  private _unusableSinceMs: number | null = null

  // Cumulative quality counters (for session summary)
  private _counts: QualityCounts = {
    lowLightFrames: 0,
    fastMotionEvents: 0,
    reflectiveWarnings: 0,
    totalFrames: 0,
  }

  get counts(): Readonly<QualityCounts> {
    return this._counts
  }

  /**
   * Forget everything measured for the scan in progress. Called when the live
   * point cloud is emptied, so the next summary does not carry the previous
   * scan's counts, and a pose from before the reset cannot read as motion.
   */
  reset(): void {
    this._prevCount = 0
    this._prevTickMs = 0
    this._ptsPerSec = 0
    this._poseWindow = []
    this._coverageScore = 0
    this._lastLighting = 'ok'
    this._lastLowLight = false
    this._tooDarkSeen = 0
    this._lastReflective = false
    this._lastSnapshot = null
    this._unusableSinceMs = null
    this._counts = { lowLightFrames: 0, fastMotionEvents: 0, reflectiveWarnings: 0, totalFrames: 0 }
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
          this._counts.fastMotionEvents++
        } else if (speed >= DRIFT_MED) {
          driftRisk = 'medium'
        }
      }
    }

    // The runtime's live status, not the first-pose latch: a session that has fallen to
    // LIMITED or lost its pose is lost now, and says so on the HUD. A saved verdict waits
    // for the loss to last (TRACKING_LOST_HOLD_MS), except before the first pose, which is
    // not a blink.
    const notStarted = !provider.isTracking()
    const unusable = notStarted || !trackingIsUsable(provider.trackingStatus())
    if (!unusable) this._unusableSinceMs = null
    else if (this._unusableSinceMs === null) this._unusableSinceMs = now
    const lostForMs = this._unusableSinceMs === null ? 0 : now - this._unusableSinceMs

    const snapshot: QualitySnapshot = {
      coverageScore:    this._coverageScore,
      coverageText:     coverageLabel(this._coverageScore),
      lowLight:         this._lastLowLight,
      lighting:         this._lastLighting,
      driftRisk,
      reflectiveSurface: this._lastReflective,
      missingAreas,
      pointsPerSecond:  this._ptsPerSec,
      trackingLost:     unusable,
      trackingLostForMs: lostForMs,
      trackingLostSustained: notStarted || lostForMs >= TRACKING_LOST_HOLD_MS,
      trackingNotStarted: notStarted,
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
    /**
     * Whether camera frames are being sent right now. The advice about a stream that has sent nothing is given only then: a
     * scan with no frames is the ordinary case for a person who has not agreed to send them, and it is not a poor scan. Sending
     * frames is the person's choice, and nothing here counts against a scan for not making it (docs/operations/PRIVACY.md).
     * Absent counts as not sending.
     */
    keyframesOn?: boolean
    /**
     * How many times the runtime's frame was interrupted or reported moved since this scan
     * began (`ScanFrameEpochLog.frameShifts`, src/ar/frame-epoch.ts). Any at all means
     * the scan may hold geometry from more than one frame, so the verdict cannot be 'ready'.
     * Absent counts as none: a caller that does not track them has nothing to report.
     */
    frameShifts?: number
    /** Time spent with degraded tracking since this scan began, in milliseconds. */
    limitedMs?: number
    /**
     * Whether a drift check of this scan (src/ar/closure.ts, `ScanFrameEpochLog.closureExceeded`) found a gap past its
     * limits. The check measured where a re-tap landed against where the calibration put the spot: whether the frame
     * moved depends on the person having tapped the same spot, so the line says "may", as the frame-shift one does.
     * Like a frame shift it keeps the scan from 'ready'.
     */
    closureExceeded?: boolean
  }): ScanQualitySummary {
    const snap = this._lastSnapshot
    const coverageScore = snap?.coverageScore ?? this._coverageScore
    const missingAreas = snap?.missingAreas ?? 0
    const trackingLost = snap?.trackingLostSustained ?? false
    const frameShifts = Number.isFinite(input.frameShifts) ? Math.max(0, Math.floor(input.frameShifts as number)) : 0
    const limitedMs = Number.isFinite(input.limitedMs) ? Math.max(0, Math.round(input.limitedMs as number)) : undefined
    const recommendations: string[] = []

    // Each line says what to do. Wave 1 shortened these; the two that had lost
    // their action (before export, review) are restored here.
    //
    // First, because it is the one that says the rest of the numbers may not be about one
    // frame. What the code knows is that the runtime lost tracking and got it back, or
    // reported or showed a shift of its origin; whether anything actually moved it does not
    // know (see the top of src/ar/frame-epoch.ts), so the line says "may".
    if (frameShifts > 0) recommendations.push('Tracking was interrupted: parts may be shifted')
    if (input.closureExceeded === true) recommendations.push('A drift check found a gap: parts may be shifted')
    // The verdict below is 'needs-rescan' for this, so it says what to do about it.
    if (trackingLost) {
      recommendations.push(snap?.trackingNotStarted
        ? 'Tracking has not started: wait for it, then scan'
        : 'Tracking is lost: hold still until it returns')
    }
    if (input.pointCount < 150) recommendations.push('Collect more tracking points before export')
    if (coverageScore < 0.55) recommendations.push('Sweep the room more slowly')
    if (missingAreas >= 4) recommendations.push('Rescan sparse floor areas from another angle')
    if (this._tooDarkSeen > 0) {
      // A different sentence, because it is a different problem: at this tier
      // the frames carried no trackable signal, so "revisit dark surfaces"
      // would understate it.
      recommendations.push('Too dark to track: turn on a light and rescan')
    } else if (this._counts.lowLightFrames > 0) {
      recommendations.push('Add light, or check the dark surfaces')
    }
    if (this._counts.fastMotionEvents > 0) recommendations.push('Move slower to reduce drift')
    if (this._counts.reflectiveWarnings > 0) recommendations.push('Review reflective surfaces for false geometry')
    // Said only while frames are being sent and none has reached the server: that is something the code has seen and the
    // person can act on. Not sending at all is not a defect of the scan, so it says nothing and does not move the verdict.
    if (input.keyframesOn === true && input.keyframeCount === 0) recommendations.push('No camera frame has reached your server yet')

    let status: ScanQualitySummary['status'] = 'ready'
    if (input.pointCount < 75 || coverageScore < 0.25 || trackingLost) {
      status = 'needs-rescan'
    } else if (recommendations.length > 0 || coverageScore < 0.8) {
      // Any frame shift pushed its line above, so it lands here: a scan is not 'ready' while
      // parts of it may be in another frame.
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
      // The same number twice: `fastMotionEvents` is its honest name, `driftEvents` the one
      // stored summaries, the upload sidecar and the server already use.
      driftEvents: this._counts.fastMotionEvents,
      fastMotionEvents: this._counts.fastMotionEvents,
      frameShifts,
      ...(limitedMs !== undefined ? { limitedMs } : {}),
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
      const { mean, stddev } = this._measure(bitmap)
      bitmap.close()

      // A camera permission/startup failure can still produce a decodable JPEG,
      // but its pixels are nearly identical. Do not send that placeholder to
      // inference as if it were a photograph of the room.
      const uniformFrame = stddev < LUMI_UNIFORM
      const lighting  = lightingLevel(mean)
      const lowLight  = lighting !== 'ok'
      const reflective = stddev > LUMI_REFL && mean > 0.30

      if (lowLight)   this._counts.lowLightFrames++
      if (lighting === 'too-dark') this._tooDarkSeen++
      if (reflective) this._counts.reflectiveWarnings++

      this._lastLighting   = lighting
      this._lastLowLight   = lowLight
      this._lastReflective = reflective
      return { lowLight, lighting, reflective, uniformFrame, meanLuminance: mean, luminanceStddev: stddev }
    } catch {
      return { lowLight: false, lighting: 'ok', reflective: false, uniformFrame: false, meanLuminance: 0.5, luminanceStddev: 0 }
    }
  }

  /**
   * Measure lighting from the LIVE camera, without waiting for a capture.
   *
   * This is the path the dark-room failure needed and did not have.
   * `analyseFrame()` above only runs on a frame the user (or auto-capture)
   * actually captured — and in a room too dark to track, tracking never
   * acquires, so nothing is ever captured and nothing is ever measured. The
   * one signal that would have explained the black screen was never computed.
   *
   * Deliberately the same 64x64 Rec.601 measurement as `analyseFrame()`, via
   * the same `_measure()`, rather than a second analyser with its own idea of
   * "dark": the thresholds in this file must mean one thing.
   *
   * `source` is the camera's own `<video>` element — the element the 8th Wall
   * engine renders the stream into, which is readable because a getUserMedia
   * stream does not taint a canvas. The caller passes null when there is no
   * such element (a native WebXR session has no accessible passthrough video)
   * or when it has no decoded frame yet, and this returns 'ok' — silence, not a
   * false alarm, is the right answer when nothing was measured.
   *
   * Counters: this does NOT touch `_counts`, which describes captured frames
   * and is serialised into the scan summary. It does feed `_tooDarkSeen`, which
   * exists to carry exactly this observation into the summary's advice.
   */
  async sampleLighting(source: CanvasImageSource | null): Promise<LightingLevel> {
    if (!source) return 'ok'
    try {
      const { mean } = this._measure(source)
      const lighting = lightingLevel(mean)
      if (lighting === 'too-dark') this._tooDarkSeen++
      this._lastLighting = lighting
      this._lastLowLight = lighting !== 'ok'
      return lighting
    } catch {
      // A canvas that will not read (tainted, zero-sized, context lost) is not
      // evidence of darkness. Fail open, exactly as analyseFrame() does.
      return 'ok'
    }
  }

  /**
   * Mean and standard deviation of Rec. 601 luminance over a 64x64 downsample.
   * Shared by the capture path and the live sampler so both use one definition.
   */
  private _measure(source: CanvasImageSource): { mean: number; stddev: number } {
    const oc  = new OffscreenCanvas(64, 64)
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(source, 0, 0, 64, 64)

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
    return { mean, stddev: Math.sqrt(Math.max(0, variance)) }
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
