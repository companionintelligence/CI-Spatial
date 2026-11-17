/**
 * PointCloud — growing Float32Array of 3D world positions accumulated from
 * SLAM feature-point hit-tests during room scanning.
 *
 * Duplicate points are suppressed with a voxel grid (default 5 cm).
 * The underlying buffer doubles in size as needed (amortised O(1) add).
 *
 * Every point also carries the FRAME EPOCH it was recorded in (src/ar/frame-epoch.ts), in
 * a Uint16Array that runs alongside the positions. Points of different epochs are not in
 * one coordinate frame, so the cloud never lets them vouch for each other: the voxel grid
 * does not merge them, and the ground-plane fit looks at the current epoch's points only
 * (see `groundEstimate()`). A caller that has no epoch to give passes none, and every
 * point is epoch 0, which behaves exactly as the cloud did before epochs existed.
 */

const DEFAULT_VOXEL_M = 0.05 // 5 cm
const MAX_POINTS = 250_000 // hard memory cap — decimate instead of growing past this
/**
 * The largest epoch the per-point array can hold (Uint16). An epoch past it is stored as
 * this, not wrapped round to a small one: wrapping would file a late frame's points under
 * an early frame's number, which is the mixing epochs exist to prevent. Past 65 535
 * discontinuities in one scan the scan is long since flagged, and the points of the last
 * epochs share a label.
 */
const MAX_STORED_EPOCH = 0xffff

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
 * A floor estimate: the session's current one, or the last one an earlier epoch had.
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
  /**
   * The frame epoch this floor was fitted in, and so the frame `y` is a height in. Two
   * floors with different epochs are in different frames and are not comparable.
   */
  epoch: number
  /**
   * The floor's normal, in the same frame. ASSUMED level, not fitted: this module fits a
   * horizontal band because the session frame is gravity-aligned, so the normal is
   * straight up by construction. A floor that is not level in the frame (a bad gravity
   * estimate) shows in `residualM`, and no fit here corrects it. The field is here so the
   * record the sidecar carries has the shape a fitted plane will have.
   */
  normal: { x: 0; y: 1; z: 0 }
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
  /** The epoch of each point, index for index with `_data` (one entry per point, not per float). */
  private _epochs: Uint16Array = new Uint16Array(1000)
  private _count = 0
  /** The newest epoch any point has been added in. The ground fit is of this epoch's points. */
  private _currentEpoch = 0
  /** How many points each epoch holds. Kept in step with `_data` by add() and decimation. */
  private _epochCounts = new Map<number, number>()
  /**
   * The last floor fitted in every epoch the scan has had, so an earlier frame's floor is
   * still on record after a later one has replaced it as the live estimate. The current
   * epoch's entry is refreshed on every recompute; the others are left as they were.
   */
  private _groundByEpoch = new Map<number, GroundEstimate>()
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
   *
   * `epoch` is the frame epoch the points were recorded in (src/ar/frame-epoch.ts). A
   * point is a duplicate only of one in the same epoch: two frames' coordinates landing
   * in one voxel are different places. The first point of a newer epoch than any before
   * it starts that epoch's floor fit afresh; the floor of the epoch before stays on
   * record (`groundObjects()`). A point added with an older epoch than the current one is
   * kept under its own epoch and does not touch the live floor.
   */
  add(points: ReadonlyArray<{ x: number; y: number; z: number }>, epoch = 0): Array<{ x: number; y: number; z: number }> {
    const e = storedEpoch(epoch)
    if (e > this._currentEpoch) this._beginEpoch(e)
    const inserted: Array<{ x: number; y: number; z: number }> = []
    for (const p of points) {
      const key = voxelKey(p.x, p.y, p.z, this._voxelSize, e)
      if (this._occupied.has(key)) continue
      this._occupied.add(key)
      this._grow()
      const base = this._count * 3
      this._data[base]     = p.x
      this._data[base + 1] = p.y
      this._data[base + 2] = p.z
      this._epochs[this._count] = e
      this._epochCounts.set(e, (this._epochCounts.get(e) ?? 0) + 1)
      this._count++
      inserted.push({ x: p.x, y: p.y, z: p.z })
    }
    // Only worth recomputing when the live epoch's points actually changed — a tick
    // that inserted nothing, or only points of an older epoch, cannot have moved the
    // floor estimate.
    if (inserted.length > 0 && e === this._currentEpoch) this._maybeRecomputeGround()
    return inserted
  }

  /** Packed Float32Array of [x0,y0,z0, x1,y1,z1, …] for the filled region. */
  toFloat32Array(): Float32Array {
    return this._data.slice(0, this._count * 3)
  }

  /** The epoch of each point, in the same order as `toFloat32Array()`: one entry per point. */
  toEpochArray(): Uint16Array {
    return this._epochs.slice(0, this._count)
  }

  /** The newest epoch any point has been added in; 0 for an empty cloud. */
  get currentEpoch(): number {
    return this._currentEpoch
  }

  /** How many points each epoch holds, lowest epoch first. An epoch with none is left out. */
  epochCounts(): Array<{ epoch: number; count: number }> {
    return [...this._epochCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([epoch, count]) => ({ epoch, count }))
      .sort((a, b) => a.epoch - b.epoch)
  }

  /** Clear all accumulated points. */
  clear(): void {
    this._count = 0
    this._currentEpoch = 0
    this._epochCounts.clear()
    this._groundByEpoch.clear()
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
      epoch: this._currentEpoch,
      normal: { x: 0, y: 1, z: 0 },
      locked: this._groundLocked,
      sampleCount: this._groundSampleCount,
      ...(fit
        ? { inlierCount: fit.inlierCount, residualM: fit.residualM, fallback: fit.fallback }
        : {}),
    }
  }

  /**
   * The ground object of the whole scan: the last floor fitted in every epoch the scan
   * has had, lowest epoch first. The live epoch's entry is `groundEstimate()`; the others
   * are the floors of frames that have since been left, kept so the sidecar can say where
   * each frame's floor was. An epoch that never gathered enough points to fit one has no
   * entry.
   *
   * Nothing here converts one epoch's height into another's: there is no known transform
   * between them, which is the whole reason for the epochs.
   */
  groundObjects(): GroundEstimate[] {
    // The live epoch's entry is refreshed at every recompute, the only time the live floor
    // changes, so it is the live estimate. Copies, so a caller cannot change what is kept.
    return [...this._groundByEpoch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, kept]) => ({ ...kept, normal: { x: 0 as const, y: 1 as const, z: 0 as const } }))
  }

  /**
   * A newer epoch has begun. Its points are in a different frame from every point so far,
   * so what was learned about the floor cannot carry over: the lock, the candidates that
   * earned it and the throttle are dropped, and the fit starts from this epoch's own
   * points. This is what lets a floor that appears higher after a frame shift be followed.
   * Without it the old floor stayed the lowest band, stayed locked, and a shift upward of
   * 0.10 m or 0.30 m (a shift down of 0.10 m is inside the unlock tolerance) was never
   * seen. The old epoch's last floor stays in `_groundByEpoch`.
   */
  private _beginEpoch(epoch: number): void {
    this._currentEpoch = epoch
    this._groundHistory = []
    this._groundLocked = false
    this._groundFit = null
    this._lastGroundY = null
    this._lastGroundSampleAt = Number.NEGATIVE_INFINITY
    this._groundSampleCount = 0
  }

  private _maybeRecomputeGround(): void {
    const now = this._now()
    if (now - this._lastGroundSampleAt < GROUND_RECOMPUTE_INTERVAL_MS) return
    this._lastGroundSampleAt = now
    const inEpoch = this._epochCounts.get(this._currentEpoch) ?? 0
    if (inEpoch < MIN_POINTS_FOR_GROUND_ESTIMATE) return

    this._refitGround(inEpoch)
    const estimate = this.groundEstimate()
    if (estimate) this._groundByEpoch.set(this._currentEpoch, estimate)
  }

  /** One ground recompute over the live epoch's `inEpoch` points: the lock, unlock and window logic. */
  private _refitGround(inEpoch: number): void {
    const fit = this._fitFloor(this._currentEpoch)
    const candidate = fit.y
    this._groundFit = fit
    this._groundSampleCount = inEpoch

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
   * Fitting a band by its *support* instead — how many points actually lie in
   * it — is the same robust-estimation idea as RANSAC, reduced to the one
   * degree of freedom this problem has. It is `O(n)` where the sort was
   * `O(n log n)`. Which supported band is chosen is the next paragraph but one:
   * the lowest that qualifies, not the best-supported.
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
  estimateFloorY(epoch?: number): number {
    return this._fitFloor(epoch).y
  }

  /**
   * {@link estimateFloorY} plus how well the data supported it.
   *
   * With an `epoch`, only that epoch's points are fitted: the share a band must hold is
   * a share of that epoch's points, and an epoch with none has no floor. Without one,
   * every point is fitted whatever its epoch, which is what this has always done.
   */
  private _fitFloor(epoch?: number): FloorFit {
    const all = epoch === undefined
    const data = this._data
    const epochs = this._epochs
    let eligible = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < this._count; i++) {
      if (!all && epochs[i] !== epoch) continue
      eligible++
      const y = data[i * 3 + 1]
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (eligible === 0) return { y: 0, inlierCount: 0, residualM: 0, fallback: true }

    const bandCount = Math.max(1, Math.ceil((maxY - minY) / FLOOR_BAND_M) + 1)
    const counts = new Uint32Array(bandCount)
    for (let i = 0; i < this._count; i++) {
      if (!all && epochs[i] !== epoch) continue
      const band = Math.floor((data[i * 3 + 1] - minY) / FLOOR_BAND_M)
      counts[band < 0 ? 0 : band >= bandCount ? bandCount - 1 : band]++
    }

    // A share of the whole cloud, never of the best band — see
    // FLOOR_MIN_BAND_SHARE for why that distinction is the fix.
    const required = eligible * FLOOR_MIN_BAND_SHARE
    let chosen = -1
    for (let b = 0; b < bandCount; b++) {
      if (counts[b] >= required) { chosen = b; break }
    }
    if (chosen === -1) {
      // No horizontal structure at all. Rather than invent a floor, fall back
      // to the old behaviour and say so: a cloud this sparse is what
      // MIN_POINTS_FOR_GROUND_ESTIMATE and `locked` already exist to report.
      return { y: this._legacyPercentileFloorY(epoch), inlierCount: 0, residualM: 0, fallback: true }
    }

    // The band is a search grid, not the answer. Returning its centre would
    // quantise every estimate to FLOOR_BAND_M and show up as a floor of that
    // size on residualM, so refine to the mean of the points around it.
    const centre = minY + (chosen + 0.5) * FLOOR_BAND_M
    let sum = 0
    let inliers = 0
    for (let i = 0; i < this._count; i++) {
      if (!all && epochs[i] !== epoch) continue
      const y = data[i * 3 + 1]
      if (Math.abs(y - centre) <= FLOOR_BAND_M) { sum += y; inliers++ }
    }
    if (inliers === 0) return { y: centre, inlierCount: 0, residualM: 0, fallback: false }
    const y = sum / inliers

    let squared = 0
    for (let i = 0; i < this._count; i++) {
      if (!all && epochs[i] !== epoch) continue
      const py = data[i * 3 + 1]
      if (Math.abs(py - centre) <= FLOOR_BAND_M) squared += (py - y) * (py - y)
    }
    return { y, inlierCount: inliers, residualM: Math.sqrt(squared / inliers), fallback: false }
  }

  /**
   * The pre-0008 estimator, kept only as the no-structure fallback above.
   * Not a second opinion — it is what this ticket replaced, and it is reached
   * only where there is nothing to fit.
   */
  private _legacyPercentileFloorY(epoch?: number): number {
    const ys: number[] = []
    for (let i = 0; i < this._count; i++) {
      if (epoch !== undefined && this._epochs[i] !== epoch) continue
      ys.push(this._data[i * 3 + 1])
    }
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
    const nextEpochs = new Uint16Array(next.length / 3)
    nextEpochs.set(this._epochs)
    this._epochs = nextEpochs
  }

  private _decimate(): void {
    const half = Math.floor(this._count / 2)
    for (let i = 0; i < half; i++) {
      const src = i * 2 * 3
      const dst = i * 3
      this._data[dst]     = this._data[src]
      this._data[dst + 1] = this._data[src + 1]
      this._data[dst + 2] = this._data[src + 2]
      // The epochs go through the same thinning, point for point: a surviving point keeps
      // its own epoch, never the epoch of the point that used to sit at its new index.
      this._epochs[i] = this._epochs[i * 2]
    }
    this._count = half
    this._decimations++
    this._epochCounts.clear()
    for (let i = 0; i < this._count; i++) {
      this._epochCounts.set(this._epochs[i], (this._epochCounts.get(this._epochs[i]) ?? 0) + 1)
    }
  }
}

/** An epoch as the per-point array holds it: a whole number, 0 for anything that is not one, capped. */
function storedEpoch(epoch: number): number {
  return Number.isFinite(epoch) && epoch > 0 ? Math.min(Math.floor(epoch), MAX_STORED_EPOCH) : 0
}

/**
 * The voxel a point falls in. Epoch 0 keys are the plain `x,y,z` they have always been; a
 * later epoch's are prefixed with it, so the same voxel in another frame is not a duplicate.
 */
function voxelKey(x: number, y: number, z: number, v: number, epoch: number): string {
  const cell = `${Math.round(x / v)},${Math.round(y / v)},${Math.round(z / v)}`
  return epoch === 0 ? cell : `${epoch}:${cell}`
}
