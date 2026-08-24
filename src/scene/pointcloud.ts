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
// room-loop benchmark in docs/DEVICE_TESTING.md rather than argued about.

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

export interface GroundEstimate {
  /** Floor height in the AR session's local frame, metres. */
  y: number
  /** True once consecutive estimates have agreed; the readiness gate's signal. */
  locked: boolean
  /** Points accumulated at the last recompute — for diagnostics/HUD. */
  sampleCount: number
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
    return { y: this._lastGroundY, locked: this._groundLocked, sampleCount: this._groundSampleCount }
  }

  private _maybeRecomputeGround(): void {
    const now = this._now()
    if (now - this._lastGroundSampleAt < GROUND_RECOMPUTE_INTERVAL_MS) return
    this._lastGroundSampleAt = now
    if (this._count < MIN_POINTS_FOR_GROUND_ESTIMATE) return

    const candidate = this.estimateFloorY()
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
   * Estimate the floor Y-coordinate as the 8th-percentile Y value.
   * Feature points near the floor cluster at the bottom of the Y range.
   */
  estimateFloorY(): number {
    if (this._count === 0) return 0
    const ys: number[] = []
    for (let i = 0; i < this._count; i++) ys.push(this._data[i * 3 + 1])
    ys.sort((a, b) => a - b)
    return ys[Math.floor(ys.length * 0.08)] ?? ys[0]
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
