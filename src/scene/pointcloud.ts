/**
 * PointCloud — growing Float32Array of 3D world positions accumulated from
 * SLAM feature-point hit-tests during room scanning.
 *
 * Duplicate points are suppressed with a voxel grid (default 5 cm).
 * The underlying buffer doubles in size as needed (amortised O(1) add).
 */

const DEFAULT_VOXEL_M = 0.05 // 5 cm

export class PointCloud {
  private _data: Float32Array = new Float32Array(3000) // 1 000 pts × 3 floats
  private _count = 0
  private _voxelSize: number
  private _occupied = new Set<string>()

  constructor(voxelSizeM = DEFAULT_VOXEL_M) {
    this._voxelSize = voxelSizeM
  }

  get count(): number {
    return this._count
  }

  /**
   * Add an array of world-space points.  Returns number actually inserted
   * (i.e. not suppressed as duplicates).
   */
  add(points: ReadonlyArray<{ x: number; y: number; z: number }>): number {
    let added = 0
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
      added++
    }
    return added
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
    const next = new Float32Array(this._data.length * 2)
    next.set(this._data)
    this._data = next
  }
}

function voxelKey(x: number, y: number, z: number, v: number): string {
  return `${Math.round(x / v)},${Math.round(y / v)},${Math.round(z / v)}`
}
