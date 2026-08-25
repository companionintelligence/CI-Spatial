/**
 * PointCloud — growing Float32Array of 3D world positions accumulated from
 * SLAM feature-point hit-tests during room scanning.
 *
 * Duplicate points are suppressed with a voxel grid (default 5 cm).
 * The underlying buffer doubles in size as needed (amortised O(1) add).
 */

const DEFAULT_VOXEL_M = 0.05 // 5 cm
const MAX_POINTS = 250_000 // hard memory cap — decimate instead of growing past this

// ── Ground-plane estimate (wave 09 ticket 0003) ─────────────────────────────
// Every threshold here is a starting value, expected to be retuned against the
// room-loop benchmark in ../../docs/testing/DEVICE_TESTING.md rather than argued about.

/** Below this many points an estimate is noise, so none is offered at all. */
const MIN_POINTS_FOR_GROUND_ESTIMATE = 50
/**
 * estimateFloorY() sorts every Y each call — O(n log n) over up to MAX_POINTS —
 * and add() runs on every scanner tick, so recomputing per call would burn the
 * cost repeatedly for an estimate that cannot meaningfully change that fast.
 */
const GROUND_RECOMPUTE_INTERVAL_MS = 500
/** Consecutive candidates that must agree before the estimate is called stable. */
const GROUND_HISTORY_SIZE = 6
/** Spread across that window below which the estimate locks. */
const GROUND_LOCK_TOLERANCE_M = 0.03
/**
 * A locked estimate is abandoned when a candidate deviates by more than this —
 * a real change of floor level (a step, a mezzanine) rather than noise, which
 * is why it unlocks immediately rather than averaging the new level in.
 */
const GROUND_UNLOCK_TOLERANCE_M = 0.15

/**
 * Height resolution of the floor-fit histogram, in metres.
 *
 * Matched to the default voxel size because the cloud is already deduplicated
 * at that resolution — a narrower band cannot resolve detail the data does not
 * contain, and a wider one blurs a floor into a low step.
 *
 * Declared separately rather than read from `_voxelSize` deliberately: a caller
 * that constructs a `PointCloud` with a coarser voxel size should not silently
 * retune the estimator as a side effect.
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 closed unrun.
 *
 * **Revisit when:** real hit-test noise is shown to exceed ~5 cm vertically, at
 * which point a genuine floor's points straddle bands and its support splits.
 */
const FLOOR_BAND_M = 0.05

/**
 * Share of the whole cloud a band must hold to count as a real surface rather
 * than scatter.
 *
 * A **fraction of the total, not of the best-supported band.** That distinction
 * is the whole fix and it is easy to get backwards: the failure being repaired
 * is an *under-sampled floor*, so measuring the floor against the best-sampled
 * surface in the room is exactly the comparison that discards it. A room swept
 * at eye level can leave the floor with a sixth of the wall's point count and
 * still have a perfectly good floor.
 *
 * Sized against the degenerate case instead: a cloud with no planar structure
 * spreads evenly, so over a ~3 m height range at {@link FLOOR_BAND_M} each band
 * holds roughly 1/60th (~1.7 %) of the points. 4 % sits clear of that while
 * staying far below any real surface's share.
 *
 * **Known limit, measured.** This test only separates structure from scatter
 * once the cloud is reasonably populated. Below ~1000 points, Poisson noise in
 * a genuinely structureless cloud produces a chance band above the share (2 of
 * 3 seeds at 400 points did); at 1000 and above it was stable across every seed
 * tried. `MIN_POINTS_FOR_GROUND_ESTIMATE` is 50, far below that — so on a
 * sparse cloud `fallback: false` does **not** mean a floor was really found.
 * Read {@link GroundEstimate.inlierCount} and
 * {@link GroundEstimate.residualM} for that; a chance band shows few inliers
 * and a residual near the band width, where a real floor shows many and a
 * residual near hit-test noise.
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 closed unrun.
 *
 * **Revisit when:** the estimate latches onto a low step, a sunken area, or
 * stray sub-floor points from a reflective surface — all of which mean the
 * lowest *qualifying* band is not the floor, and the share is too permissive.
 */
const FLOOR_MIN_BAND_SHARE = 0.04

/**
 * The session's current floor estimate.
 *
 * Note the optional diagnostic fields describe the most recent **candidate**
 * fit. Once `locked` is true, `y` is the mean of the window that earned the
 * lock, so `y` and the diagnostics are not from the same computation — the
 * diagnostics say how well the latest data supports a floor, not how the
 * locked value was derived.
 */
export interface GroundEstimate {
  /** Floor height in the AR session's local frame, metres. */
  y: number
  /** True once consecutive estimates have agreed; the readiness gate's signal. */
  locked: boolean
  /** Points accumulated at the last recompute — for diagnostics/HUD. */
  sampleCount: number
  /**
   * Points supporting the fitted floor band. Low support means a poorly-seen
   * floor — the estimate is the best available, not necessarily a good one.
   */
  inlierCount?: number
  /**
   * RMS distance of those points from `y`, in metres.
   *
   * The tilt readout. This module fits a **horizontal** band because the
   * session frame is gravity-aligned and a floor in such a frame is a plane of
   * constant y. When SLAM's gravity estimate is off, that assumption fails and
   * the floor is not level in the session frame — a 3° error across a 4 m room
   * is ~20 cm of height variation. No horizontal fit can correct that, but it
   * shows up here: a level floor sits near hit-test noise, a tilted one spreads
   * far past {@link FLOOR_BAND_M}.
   */
  residualM?: number
  /**
   * True when no band met {@link FLOOR_MIN_BAND_SHARE} and the legacy
   * percentile was used instead — a cloud with no horizontal structure to fit.
   */
  fallback?: boolean
}

/** One floor fit: the height, and how well the data actually supported it. */
interface FloorFit {
  y: number
  inlierCount: number
  residualM: number
  fallback: boolean
}

export class PointCloud {
  private _data: Float32Array = new Float32Array(3000) // 1 000 pts × 3 floats
  private _count = 0
  private _voxelSize: number
  private _occupied = new Set<string>()
  private _decimations = 0
  private _now: () => number
  private _groundHistory: number[] = []
  private _groundLocked = false
  private _lastGroundY: number | null = null
  private _lastGroundSampleAt = Number.NEGATIVE_INFINITY
  private _groundSampleCount = 0
  private _groundFit: FloorFit | null = null

  /**
   * `now` is injectable purely so the recompute throttle is testable without
   * sleeping; production callers use the default.
   */
  constructor(voxelSizeM = DEFAULT_VOXEL_M, now: () => number = () => performance.now()) {
    this._voxelSize = voxelSizeM
    this._now = now
  }

  get count(): number {
    return this._count
  }

  /** How many times the cloud has been decimated to stay under MAX_POINTS. */
  get decimations(): number {
    return this._decimations
  }

  /**
   * Add an array of world-space points.  Returns the points actually inserted
   * (i.e. not suppressed as duplicates) so callers can stream deltas.
   */
  add(points: ReadonlyArray<{ x: number; y: number; z: number }>): Array<{ x: number; y: number; z: number }> {
    const inserted: Array<{ x: number; y: number; z: number }> = []
    for (const p of points) {
      const key = voxelKey(p.x, p.y, p.z, this._voxelSize)
      if (this._occupied.has(key)) continue
      this._occupied.add(key)
      this._grow()
      const base = this._count * 3
      this._data[base]     = p.x
      this._data[base + 1] = p.y
      this._data[base + 2] = p.z
      this._count++
      inserted.push({ x: p.x, y: p.y, z: p.z })
    }
    // Only worth recomputing when the cloud actually changed — a tick that
    // inserted nothing cannot have moved the floor estimate.
    if (inserted.length > 0) this._maybeRecomputeGround()
    return inserted
  }

  /** Packed Float32Array of [x0,y0,z0, x1,y1,z1, …] for the filled region. */
  toFloat32Array(): Float32Array {
    return this._data.slice(0, this._count * 3)
  }

  /** Clear all accumulated points. */
  clear(): void {
    this._count = 0
    this._occupied.clear()
    this._groundHistory = []
    this._groundLocked = false
    this._groundFit = null
    this._lastGroundY = null
    this._lastGroundSampleAt = Number.NEGATIVE_INFINITY
    this._groundSampleCount = 0
  }

  /**
   * The session's running ground-plane estimate, or `null` while too few points
   * have accumulated to say anything useful.
   *
   * Distinct from `estimateFloorY()`, which is a stateless snapshot computed on
   * demand at export time: this one is maintained across the session and
   * carries a `locked` signal, so callers can tell "the floor is at 0.0 m
   * because nothing better is known" from "the floor is at 0.0 m and six
   * consecutive estimates agreed".
   */
  groundEstimate(): GroundEstimate | null {
    if (this._lastGroundY === null) return null
    const fit = this._groundFit
    return {
      y: this._lastGroundY,
      locked: this._groundLocked,
      sampleCount: this._groundSampleCount,
      ...(fit
        ? { inlierCount: fit.inlierCount, residualM: fit.residualM, fallback: fit.fallback }
        : {}),
    }
  }

  private _maybeRecomputeGround(): void {
    const now = this._now()
    if (now - this._lastGroundSampleAt < GROUND_RECOMPUTE_INTERVAL_MS) return
    this._lastGroundSampleAt = now
    if (this._count < MIN_POINTS_FOR_GROUND_ESTIMATE) return

    const fit = this._fitFloor()
    const candidate = fit.y
    this._groundFit = fit
    this._groundSampleCount = this._count

    if (this._groundLocked) {
      // Hold the locked value steady against noise, but abandon it outright on
      // a genuine level change rather than drifting toward it — half-following
      // a step would leave the estimate describing neither floor.
      if (Math.abs(candidate - (this._lastGroundY as number)) > GROUND_UNLOCK_TOLERANCE_M) {
        this._groundLocked = false
        this._groundHistory = [candidate]
        this._lastGroundY = candidate
      }
      return
    }

    this._groundHistory.push(candidate)
    if (this._groundHistory.length > GROUND_HISTORY_SIZE) this._groundHistory.shift()
    this._lastGroundY = candidate

    if (this._groundHistory.length === GROUND_HISTORY_SIZE) {
      const spread = Math.max(...this._groundHistory) - Math.min(...this._groundHistory)
      if (spread < GROUND_LOCK_TOLERANCE_M) {
        this._groundLocked = true
        // Settle on the window's mean rather than whichever candidate happened
        // to arrive last, so the locked value is the consensus that earned the
        // lock rather than one arbitrary member of it.
        this._lastGroundY = this._groundHistory.reduce((a, b) => a + b, 0) / this._groundHistory.length
      }
    }
  }

  /**
   * Estimate the floor Y-coordinate: the mean height of the lowest horizontal
   * band of points with real support.
   *
   * **Replaces an 8th-percentile of the sorted Y values** (wave 09 ticket
   * 0008). A percentile is a position in the *ordering*, not a property of the
   * room, and it is only correct while the floor supplies at least ~8 % of all
   * points. A user sweeping a room at eye level — which is what the capture
   * flow encourages, since the scanner wants wall and furniture features —
   * leaves the floor under-sampled, index `0.08 × n` lands above the floor
   * cluster entirely, and the estimate jumps to whatever surface is there. On a
   * real capture that returned +0.84 m while the lowest detected object sat at
   * −0.05 m, and the constructed regression in `pointcloud.test.ts` reproduces
   * it at +0.79 m. The failure is silent and self-consistent: the wrong value
   * is stable, so it locks, and `groundEstimate().locked` reports a confidently
   * wrong floor.
   *
   * Fitting the densest band instead maximises *support* rather than trusting a
   * quantile — the same robust-estimation idea as RANSAC, reduced to the one
   * degree of freedom this problem has. It is `O(n)` where the sort was
   * `O(n log n)`.
   *
   * **Why one degree of freedom and not a general plane fit.** The session
   * frame is gravity-aligned — this codebase depends on that everywhere, and
   * returning a scalar at all already assumes it — so a floor is a plane of
   * constant y. An unconstrained 3-DOF fit would add two parameters the
   * geometry does not have, and can satisfy itself on a **wall**, which is the
   * largest planar surface in most rooms and the one thing that must never be
   * returned. See `GroundEstimate.residualM` for what happens when the
   * gravity-alignment assumption fails.
   *
   * **Lowest qualifying band, not the densest.** A well-sampled tabletop can
   * out-vote a sparsely-seen floor, and "lowest well-supported horizontal
   * layer" is a description of a floor where "densest" is not.
   */
  estimateFloorY(): number {
    return this._fitFloor().y
  }

  /** {@link estimateFloorY} plus how well the data supported it. */
  private _fitFloor(): FloorFit {
    if (this._count === 0) return { y: 0, inlierCount: 0, residualM: 0, fallback: true }

    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < this._count; i++) {
      const y = this._data[i * 3 + 1]
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const bandCount = Math.max(1, Math.ceil((maxY - minY) / FLOOR_BAND_M) + 1)
    const counts = new Uint32Array(bandCount)
    for (let i = 0; i < this._count; i++) {
      const band = Math.floor((this._data[i * 3 + 1] - minY) / FLOOR_BAND_M)
      counts[band < 0 ? 0 : band >= bandCount ? bandCount - 1 : band]++
    }

    // A share of the whole cloud, never of the best band — see
    // FLOOR_MIN_BAND_SHARE for why that distinction is the fix.
    const required = this._count * FLOOR_MIN_BAND_SHARE
    let chosen = -1
    for (let b = 0; b < bandCount; b++) {
      if (counts[b] >= required) { chosen = b; break }
    }
    if (chosen === -1) {
      // No horizontal structure at all. Rather than invent a floor, fall back
      // to the old behaviour and say so: a cloud this sparse is what
      // MIN_POINTS_FOR_GROUND_ESTIMATE and `locked` already exist to report.
      return { y: this._legacyPercentileFloorY(), inlierCount: 0, residualM: 0, fallback: true }
    }

    // The band is a search grid, not the answer. Returning its centre would
    // quantise every estimate to FLOOR_BAND_M and show up as a floor of that
    // size on residualM, so refine to the mean of the points around it.
    const centre = minY + (chosen + 0.5) * FLOOR_BAND_M
    let sum = 0
    let inliers = 0
    for (let i = 0; i < this._count; i++) {
      const y = this._data[i * 3 + 1]
      if (Math.abs(y - centre) <= FLOOR_BAND_M) { sum += y; inliers++ }
    }
    if (inliers === 0) return { y: centre, inlierCount: 0, residualM: 0, fallback: false }
    const y = sum / inliers

    let squared = 0
    for (let i = 0; i < this._count; i++) {
      const py = this._data[i * 3 + 1]
      if (Math.abs(py - centre) <= FLOOR_BAND_M) squared += (py - y) * (py - y)
    }
    return { y, inlierCount: inliers, residualM: Math.sqrt(squared / inliers), fallback: false }
  }

  /**
   * The pre-0008 estimator, kept only as the no-structure fallback above.
   * Not a second opinion — it is what this ticket replaced, and it is reached
   * only where there is nothing to fit.
   */
  private _legacyPercentileFloorY(): number {
    const ys: number[] = []
    for (let i = 0; i < this._count; i++) ys.push(this._data[i * 3 + 1])
    ys.sort((a, b) => a - b)
    return ys[Math.floor(ys.length * 0.08)] ?? ys[0] ?? 0
  }

  /**
   * Axis-aligned bounding box of all accumulated points.
   * Returns ±Infinity when the cloud is empty.
   */
  boundingBox(): {
    min: { x: number; y: number; z: number }
    max: { x: number; y: number; z: number }
  } {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < this._count; i++) {
      const x = this._data[i * 3], y = this._data[i * 3 + 1], z = this._data[i * 3 + 2]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    }
  }

  private _grow(): void {
    if (this._count * 3 < this._data.length) return
    // Doubling past MAX_POINTS would blow memory — decimate in place instead:
    // keep every 2nd point, halve the live count, and keep accepting points.
    if (this._data.length * 2 > MAX_POINTS * 3) {
      this._decimate()
      return
    }
    const next = new Float32Array(this._data.length * 2)
    next.set(this._data)
    this._data = next
  }

  private _decimate(): void {
    const half = Math.floor(this._count / 2)
    for (let i = 0; i < half; i++) {
      const src = i * 2 * 3
      const dst = i * 3
      this._data[dst]     = this._data[src]
      this._data[dst + 1] = this._data[src + 1]
      this._data[dst + 2] = this._data[src + 2]
    }
    this._count = half
    this._decimations++
  }
}

function voxelKey(x: number, y: number, z: number, v: number): string {
  return `${Math.round(x / v)},${Math.round(y / v)},${Math.round(z / v)}`
}
