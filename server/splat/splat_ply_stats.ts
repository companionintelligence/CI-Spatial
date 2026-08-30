/**
 * Where a point cloud's points actually are — the measurement half of the
 * splat quality verdict.
 *
 * Both splat backends write a standard INRIA 3DGS PLY, and both seed clouds
 * (`colmap.point-cloud.ply`, `lingbot-map.point-cloud.ply`) are plain xyz(+rgb)
 * PLYs, so ONE reader covers every file this stage handles. That is deliberate
 * per ADR 0001: the alternative — a gaussian reader beside a point reader —
 * is two parsers that must agree about the same header grammar, and this repo
 * already has the scar from two of those (see CLAUDE.md on `ScanManifest`).
 *
 * Only x/y/z are decoded. A degree-2 3DGS PLY carries 41 float properties per
 * gaussian and a degree-3 one 62; decoding all of them for a 1M-gaussian file
 * would allocate ~250 MB to answer a question about three of them. The reader
 * therefore takes the header's stride and strides through the body, touching
 * 12 bytes per record.
 *
 * Split out of splat_quality.ts so the parser can be exercised on a
 * hand-written 3-vertex header in a unit test without dragging the threshold
 * policy in with it.
 */

/** A PLY scalar type name → its width in bytes. Big-endian is not supported. */
const TYPE_SIZES: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

export interface PlyHeader {
  format: 'binary_little_endian' | 'ascii'
  vertexCount: number
  /** Byte offset of the first vertex record (binary) or first data line (ascii). */
  dataOffset: number
  /** Bytes per vertex record. Zero for ascii. */
  stride: number
  /** Byte offset of x/y/z within a record, and their scalar types. */
  xyz: { offset: number; type: string }[]
  /** Property names in declared order — the ascii path indexes columns by these. */
  propertyNames: string[]
}

/**
 * Parse a PLY header.
 *
 * Returns null rather than throwing on anything it cannot read (not a PLY, a
 * `list` property before x/y/z so the stride is not constant, big-endian, a
 * missing coordinate). The callers turn that into a manifest field that is
 * absent, and an absent measurement must never be mistaken for a passing one —
 * see `assessSplatQuality`, which refuses to return a verdict without one.
 */
export function parsePlyHeader(bytes: Uint8Array): PlyHeader | null {
  // The header is ASCII and short; 64 KiB is far more than any producer here
  // writes (the widest is a degree-3 3DGS header at ~2 KiB) and bounds the
  // decode so a 160 MB body is never turned into a string.
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
  const endMatch = probe.match(/end_header\r?\n/)
  if (!probe.startsWith('ply') || !endMatch || endMatch.index === undefined) return null
  const dataOffset = endMatch.index + endMatch[0].length
  const lines = probe.slice(0, endMatch.index).split('\n').map((l) => l.trim())

  let format: PlyHeader['format'] | null = null
  let vertexCount = -1
  let inVertexElement = false
  let stride = 0
  const xyzByName = new Map<string, { offset: number; type: string }>()
  const propertyNames: string[] = []

  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts[0] === 'format') {
      if (parts[1] === 'binary_little_endian') format = 'binary_little_endian'
      else if (parts[1] === 'ascii') format = 'ascii'
      else return null // binary_big_endian: no producer here emits it
    } else if (parts[0] === 'element') {
      inVertexElement = parts[1] === 'vertex'
      if (inVertexElement) vertexCount = Number(parts[2])
    } else if (parts[0] === 'property' && inVertexElement) {
      // A `list` property makes the record length data-dependent, so the
      // stride arithmetic below stops being valid from that point on. No
      // vertex element written by COLMAP, Brush or Spirula has one; bail
      // rather than silently mis-striding if some other producer does.
      if (parts[1] === 'list') return null
      const size = TYPE_SIZES[parts[1]]
      if (size === undefined) return null
      const name = parts[2]
      propertyNames.push(name)
      if (name === 'x' || name === 'y' || name === 'z') {
        xyzByName.set(name, { offset: stride, type: parts[1] })
      }
      stride += size
    }
  }

  if (!format || vertexCount < 0) return null
  const xyz = ['x', 'y', 'z'].map((n) => xyzByName.get(n))
  if (xyz.some((c) => c === undefined)) return null
  return {
    format,
    vertexCount,
    dataOffset,
    stride: format === 'binary_little_endian' ? stride : 0,
    xyz: xyz as { offset: number; type: string }[],
    propertyNames,
  }
}

export interface CentreStats {
  /** Vertices actually decoded — NOT the header's claim. See `readPlyCentres`. */
  count: number
  /** Vertices the header promised. A mismatch means a truncated file. */
  declaredCount: number
  min: [number, number, number]
  max: [number, number, number]
  /** `max - min` per axis. */
  size: [number, number, number]
  /**
   * `size` recomputed after discarding the outermost `TRIM_QUANTILE` of points
   * at each end of each axis, independently.
   *
   * The untrimmed extent of a splat is set by its single worst floater, so it
   * measures the outlier, not the room. The trimmed one measures where the
   * body of the reconstruction is, and the gap between the two is itself the
   * useful signal — see `outlierSpread`.
   */
  trimmedSize: [number, number, number]
  /** Diagonal of `size` / of `trimmedSize`. One number per cloud, for ratios. */
  diagonal: number
  trimmedDiagonal: number
  /**
   * `diagonal / trimmedDiagonal`. 1.0 means no outliers at all; large means a
   * few points are far outside the body of the cloud.
   */
  outlierSpread: number
}

/**
 * How much of each axis is discarded at EACH end before measuring the trimmed
 * extent — 0.5%, so 1% of the points per axis.
 *
 * Not tuned: 3DGS densification routinely leaves a handful of huge low-opacity
 * gaussians far behind the cameras, and on the measured 253k-gaussian Brush run
 * they are a four-figure count at most. A trim small enough to leave real room
 * geometry alone (a 253k splat keeps 251k points) and large enough to clear
 * that tail is the whole requirement; there is no boundary here to discover.
 */
export const TRIM_QUANTILE = 0.005

/**
 * Decode x/y/z for every vertex. Returns interleaved xyz, or null.
 *
 * The returned array is sized by what the file actually CONTAINS, not by the
 * header's `element vertex N`: a truncated PLY (an interrupted write, a partial
 * copy) declares the full count and holds less, and taking the header at its
 * word would read zeros past the end and put a phantom point at the origin —
 * dragging the extent to include (0,0,0) and quietly widening every ratio
 * computed from it. `CentreStats.count` vs `declaredCount` exposes the gap.
 */
export function readPlyCentres(bytes: Uint8Array): { xyz: Float64Array; declaredCount: number } | null {
  const header = parsePlyHeader(bytes)
  if (!header) return null

  if (header.format === 'ascii') {
    const text = new TextDecoder().decode(bytes.subarray(header.dataOffset))
    const ix = header.propertyNames.indexOf('x')
    const iy = header.propertyNames.indexOf('y')
    const iz = header.propertyNames.indexOf('z')
    const out: number[] = []
    for (const line of text.split('\n')) {
      if (out.length >= header.vertexCount * 3) break
      const cols = line.trim().split(/\s+/)
      if (cols.length < header.propertyNames.length) continue
      const x = Number(cols[ix]), y = Number(cols[iy]), z = Number(cols[iz])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      out.push(x, y, z)
    }
    return { xyz: Float64Array.from(out), declaredCount: header.vertexCount }
  }

  const body = bytes.byteLength - header.dataOffset
  const available = header.stride > 0 ? Math.floor(body / header.stride) : 0
  const count = Math.min(header.vertexCount, available)
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataOffset, count * header.stride)
  const xyz = new Float64Array(count * 3)
  for (let i = 0; i < count; i++) {
    const base = i * header.stride
    for (let a = 0; a < 3; a++) {
      const { offset, type } = header.xyz[a]
      xyz[i * 3 + a] = readScalar(view, base + offset, type)
    }
  }
  return { xyz, declaredCount: header.vertexCount }
}

function readScalar(view: DataView, at: number, type: string): number {
  switch (type) {
    case 'float':
    case 'float32':
      return view.getFloat32(at, true)
    case 'double':
    case 'float64':
      return view.getFloat64(at, true)
    case 'int':
    case 'int32':
      return view.getInt32(at, true)
    case 'uint':
    case 'uint32':
      return view.getUint32(at, true)
    case 'short':
    case 'int16':
      return view.getInt16(at, true)
    case 'ushort':
    case 'uint16':
      return view.getUint16(at, true)
    case 'char':
    case 'int8':
      return view.getInt8(at)
    default:
      return view.getUint8(at)
  }
}

/** Extent statistics for interleaved xyz. Pure, so the trim can be tested directly. */
export function centreStats(xyz: Float64Array, declaredCount = xyz.length / 3): CentreStats {
  const count = Math.floor(xyz.length / 3)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  if (count === 0) {
    return {
      count: 0,
      declaredCount,
      min: [0, 0, 0],
      max: [0, 0, 0],
      size: [0, 0, 0],
      trimmedSize: [0, 0, 0],
      diagonal: 0,
      trimmedDiagonal: 0,
      outlierSpread: 1,
    }
  }

  // A non-finite coordinate (NaN/Inf opacity blowups do occur in 3DGS) would
  // poison every comparison below, so skip those components rather than let one
  // gaussian make the whole extent NaN and the verdict unreadable.
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = xyz[i * 3 + a]
      if (!Number.isFinite(v)) continue
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }

  const trimmed: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const axis = new Float64Array(count)
    let n = 0
    for (let i = 0; i < count; i++) {
      const v = xyz[i * 3 + a]
      if (Number.isFinite(v)) axis[n++] = v
    }
    const sorted = axis.subarray(0, n).slice().sort()
    if (n === 0) continue
    const lo = sorted[Math.min(n - 1, Math.floor(n * TRIM_QUANTILE))]
    const hi = sorted[Math.max(0, Math.ceil(n * (1 - TRIM_QUANTILE)) - 1)]
    trimmed[a] = Math.max(0, hi - lo)
  }

  const size: [number, number, number] = [0, 1, 2].map((a) =>
    Number.isFinite(max[a]) && Number.isFinite(min[a]) ? max[a] - min[a] : 0
  ) as [number, number, number]
  const diagonal = Math.hypot(size[0], size[1], size[2])
  const trimmedDiagonal = Math.hypot(trimmed[0], trimmed[1], trimmed[2])
  return {
    count,
    declaredCount,
    min: [0, 1, 2].map((a) => (Number.isFinite(min[a]) ? min[a] : 0)) as [number, number, number],
    max: [0, 1, 2].map((a) => (Number.isFinite(max[a]) ? max[a] : 0)) as [number, number, number],
    size,
    trimmedSize: trimmed,
    diagonal,
    trimmedDiagonal,
    outlierSpread: trimmedDiagonal > 0 ? diagonal / trimmedDiagonal : 1,
  }
}

/** Read a PLY from disk and measure it. Null when the file is absent or unparseable. */
export async function plyCentreStats(path: string): Promise<CentreStats | null> {
  let bytes: Uint8Array
  try {
    bytes = await Deno.readFile(path)
  } catch {
    return null
  }
  const read = readPlyCentres(bytes)
  if (!read) return null
  return centreStats(read.xyz, read.declaredCount)
}

/**
 * Fraction of `xyz` lying outside `bounds` grown by `inflate` about its centre.
 *
 * The seed cloud is SPARSE — COLMAP triangulates corners and texture, not bare
 * wall — so a good splat legitimately reaches somewhat past it, and testing
 * against the raw box would score a healthy result as full of floaters. The
 * inflation is what makes the measure answer "is the splat mass roughly where
 * the reconstruction is" rather than "is it strictly inside a hull it was never
 * going to fit".
 */
/**
 * Fraction of `seed` points with at least one `splat` centre within `radius`.
 *
 * This is the closest thing to a fidelity measure that can be computed without
 * a rasterizer, and it is worth being exact about what it is NOT: it says
 * nothing about colour, sharpness or view-dependent appearance, and it cannot
 * be compared to a PSNR. Neither backend gives us a comparable photometric
 * number — Spirula prints a per-step train-set PSNR (no held-out split), and
 * Brush headless prints nothing at all on either stream — so inventing a
 * "fidelity score" out of what they do print would be a number with no
 * measurement behind it.
 *
 * What it does say is whether the splat has geometry where the reconstruction
 * found geometry. A splat that drifted, collapsed, or trained from mismatched
 * poses can still land the right bounding box while covering none of the actual
 * surfaces — which is exactly the failure that `extentRatio` alone would wave
 * through.
 *
 * Implemented as a hash grid at cell size `radius`, so it is O(splats + seeds)
 * rather than the 12,430 x 1,000,000 pairwise distance the same question asks
 * naively. Checking the 27 neighbouring cells makes the test exact for the
 * Euclidean radius, not an approximation.
 */
export function seedCoverage(
  splatXyz: Float64Array,
  seedXyz: Float64Array,
  radius: number,
): number {
  const seedCount = Math.floor(seedXyz.length / 3)
  const splatCount = Math.floor(splatXyz.length / 3)
  if (seedCount === 0 || splatCount === 0 || !(radius > 0)) return 0

  const grid = new Map<string, number[]>()
  for (let i = 0; i < splatCount; i++) {
    const x = splatXyz[i * 3], y = splatXyz[i * 3 + 1], z = splatXyz[i * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const key = `${Math.floor(x / radius)},${Math.floor(y / radius)},${Math.floor(z / radius)}`
    const cell = grid.get(key)
    if (cell) cell.push(i)
    else grid.set(key, [i])
  }

  const r2 = radius * radius
  let covered = 0
  for (let s = 0; s < seedCount; s++) {
    const sx = seedXyz[s * 3], sy = seedXyz[s * 3 + 1], sz = seedXyz[s * 3 + 2]
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) continue
    const cx = Math.floor(sx / radius), cy = Math.floor(sy / radius), cz = Math.floor(sz / radius)
    let hit = false
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dz = -1; dz <= 1 && !hit; dz++) {
          const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!cell) continue
          for (const i of cell) {
            const ex = splatXyz[i * 3] - sx
            const ey = splatXyz[i * 3 + 1] - sy
            const ez = splatXyz[i * 3 + 2] - sz
            if (ex * ex + ey * ey + ez * ez <= r2) {
              hit = true
              break
            }
          }
        }
      }
    }
    if (hit) covered++
  }
  return covered / seedCount
}

export function fractionOutside(
  xyz: Float64Array,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  inflate: number,
): number {
  const count = Math.floor(xyz.length / 3)
  if (count === 0) return 0
  const lo: number[] = []
  const hi: number[] = []
  for (let a = 0; a < 3; a++) {
    const centre = (bounds.max[a] + bounds.min[a]) / 2
    const half = ((bounds.max[a] - bounds.min[a]) / 2) * inflate
    lo.push(centre - half)
    hi.push(centre + half)
  }
  let outside = 0
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = xyz[i * 3 + a]
      // A non-finite centre is outside any box — counting it as inside would
      // hide the exact blowup this measure exists to catch.
      if (!Number.isFinite(v) || v < lo[a] || v > hi[a]) {
        outside++
        break
      }
    }
  }
  return outside / count
}
