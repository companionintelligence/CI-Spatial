/**
 * PointCloud — growing Float32Array of 3D world positions accumulated from
 * SLAM feature-point hit-tests during room scanning.
 *
 * Duplicate points are suppressed with a voxel grid (default 5 cm).
 * The underlying buffer doubles in size as needed (amortised O(1) add).
 */

const DEFAULT_VOXEL_M = 0.05 // 5 cm
const MAX_POINTS = 250_000 // hard memory cap — decimate instead of growing past this

export class PointCloud {
  private _data: Float32Array = new Float32Array(3000) // 1 000 pts × 3 floats
  private _count = 0
  private _voxelSize: number
  private _occupied = new Set<string>()
  private _decimations = 0

  constructor(voxelSizeM = DEFAULT_VOXEL_M) {
    this._voxelSize = voxelSizeM
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
