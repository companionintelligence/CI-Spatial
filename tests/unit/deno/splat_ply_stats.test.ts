/**
 * Deno unit tests for the PLY centre reader that feeds the splat quality
 * verdict. Everything here is pure byte-in/number-out, so unlike
 * splat_train.test.ts none of it needs a GPU or an injected spawn — which is
 * the point of having the parser in its own module.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertAlmostEquals } from 'jsr:@std/assert@^1.0.0/almost-equals'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import {
  centreStats,
  fractionOutside,
  parsePlyHeader,
  readPlyCentres,
  seedCoverage,
} from '../../../server/splat/splat_ply_stats.ts'

/** Assemble a binary_little_endian PLY: `props` describes the record layout. */
function binaryPly(
  props: [type: string, name: string][],
  rows: number[][],
  opts?: { declared?: number; truncateBytes?: number },
): Uint8Array {
  const sizes: Record<string, number> = { float: 4, double: 8, uchar: 1, int: 4 }
  const header = 'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${opts?.declared ?? rows.length}\n` +
    props.map(([t, n]) => `property ${t} ${n}\n`).join('') +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)
  const stride = props.reduce((n, [t]) => n + sizes[t], 0)
  const body = new Uint8Array(rows.length * stride)
  const view = new DataView(body.buffer)
  rows.forEach((row, r) => {
    let at = r * stride
    props.forEach(([t], c) => {
      if (t === 'float') view.setFloat32(at, row[c], true)
      else if (t === 'double') view.setFloat64(at, row[c], true)
      else if (t === 'int') view.setInt32(at, row[c], true)
      else view.setUint8(at, row[c])
      at += sizes[t]
    })
  })
  const out = new Uint8Array(headerBytes.length + body.length)
  out.set(headerBytes)
  out.set(body, headerBytes.length)
  return opts?.truncateBytes ? out.subarray(0, out.length - opts.truncateBytes) : out
}

Deno.test('parsePlyHeader finds x/y/z inside a wide 3DGS record', () => {
  // A degree-2 3DGS PLY interleaves x,y,z with normals, SH coefficients,
  // opacity, scale and rotation — the reader must locate the three it wants by
  // NAME and stride past the rest, not assume they lead the record.
  const props: [string, string][] = [
    ['float', 'x'],
    ['float', 'y'],
    ['float', 'z'],
    ['float', 'nx'],
    ['float', 'f_dc_0'],
    ['float', 'opacity'],
  ]
  const header = parsePlyHeader(binaryPly(props, [[1, 2, 3, 0, 0, 0]]))!
  assert(header)
  assertEquals(header.format, 'binary_little_endian')
  assertEquals(header.vertexCount, 1)
  assertEquals(header.stride, 24)
  assertEquals(header.xyz.map((c) => c.offset), [0, 4, 8])
})

Deno.test('parsePlyHeader refuses what it cannot stride: no z, a list, big-endian', () => {
  // Each of these would otherwise be read as *something*, and a wrong extent
  // silently widens every ratio computed from it. Null is the only safe answer.
  assertEquals(parsePlyHeader(binaryPly([['float', 'x'], ['float', 'y']], [[0, 0]])), null)
  const withList = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty list uchar int vertex_indices\nproperty float x\nend_header\n',
  )
  assertEquals(parsePlyHeader(withList), null)
  const bigEndian = new TextEncoder().encode(
    'ply\nformat binary_big_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n',
  )
  assertEquals(parsePlyHeader(bigEndian), null)
})

Deno.test('readPlyCentres decodes coordinates past intervening properties', () => {
  const bytes = binaryPly(
    [['float', 'x'], ['uchar', 'red'], ['float', 'y'], ['float', 'z']],
    [[1, 255, 2, 3], [-4, 0, -5, -6]],
  )
  const read = readPlyCentres(bytes)!
  assertEquals(Array.from(read.xyz), [1, 2, 3, -4, -5, -6])
  assertEquals(read.declaredCount, 2)
})

Deno.test('readPlyCentres reports what a truncated file HOLDS, not what it claims', () => {
  // A half-written PLY declares the full count. Trusting the header would read
  // zeros past the end of the body and plant a phantom point at the origin,
  // dragging the measured extent out to include it — a corrupted file would
  // then be judged on geometry it does not contain.
  const bytes = binaryPly(
    [['float', 'x'], ['float', 'y'], ['float', 'z']],
    [[10, 10, 10], [11, 11, 11]],
    { declared: 5 },
  )
  const read = readPlyCentres(bytes)!
  assertEquals(read.xyz.length / 3, 2)
  assertEquals(read.declaredCount, 5)
  const stats = centreStats(read.xyz, read.declaredCount)
  assert(stats.count < stats.declaredCount, 'the shortfall must survive into the stats')
})

Deno.test('readPlyCentres reads an ascii PLY too', () => {
  const ascii = new TextEncoder().encode(
    'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n' +
      '1 2 3\n4 5 6\n',
  )
  const read = readPlyCentres(ascii)!
  assertEquals(Array.from(read.xyz), [1, 2, 3, 4, 5, 6])
})

Deno.test('centreStats trims the outlier tail that sets the raw extent', () => {
  // The shape of every real splat measured on this box: a compact body plus a
  // handful of enormous low-opacity gaussians. 1000 points in a unit cube and
  // two at 500 give a raw extent of ~500 and a trimmed one of ~1, which is why
  // the raw box is reported and the trimmed one is what gets gated.
  const n = 1000
  const xyz = new Float64Array((n + 2) * 3)
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = (i % 10) / 10
    xyz[i * 3 + 1] = ((i / 10 | 0) % 10) / 10
    xyz[i * 3 + 2] = ((i / 100 | 0) % 10) / 10
  }
  xyz[n * 3] = 500, xyz[n * 3 + 1] = 500, xyz[n * 3 + 2] = 500
  xyz[(n + 1) * 3] = -500, xyz[(n + 1) * 3 + 1] = -500, xyz[(n + 1) * 3 + 2] = -500

  const stats = centreStats(xyz)
  assertEquals(stats.count, n + 2)
  assertAlmostEquals(stats.size[0], 1000, 0.001)
  assert(stats.trimmedSize[0] <= 1.0, `trimmed extent should stay near the body, got ${stats.trimmedSize[0]}`)
  assert(stats.outlierSpread > 100, `outlierSpread should expose the tail, got ${stats.outlierSpread}`)
})

Deno.test('centreStats survives a non-finite coordinate instead of returning NaN', () => {
  // 3DGS optimisation does occasionally blow a gaussian up to NaN. One of them
  // must not make every number in the verdict unreadable.
  const xyz = Float64Array.from([0, 0, 0, 1, 1, 1, NaN, NaN, NaN])
  const stats = centreStats(xyz)
  assertEquals(stats.size, [1, 1, 1])
  assert(Number.isFinite(stats.diagonal))
})

Deno.test('centreStats on an empty cloud reports zeros, never NaN', () => {
  const stats = centreStats(new Float64Array(0))
  assertEquals(stats.count, 0)
  assertEquals(stats.diagonal, 0)
  assertEquals(stats.outlierSpread, 1)
})

Deno.test('fractionOutside measures against the INFLATED seed box', () => {
  // The seed cloud is sparse, so a good splat reaches past it; without the
  // inflation this measure would score healthy runs as floater-ridden.
  const bounds = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] }
  // At 1.5x the box is ±1.5: the point at 1.4 is in, the one at 2 is out.
  const xyz = Float64Array.from([0, 0, 0, 1.4, 0, 0, 2, 0, 0, 0, 0, 5])
  assertEquals(fractionOutside(xyz, bounds, 1.5), 0.5)
  // Un-inflated, the point at 1.4 falls out too — which is exactly the
  // over-strict reading the 1.5x default exists to avoid.
  assertEquals(fractionOutside(xyz, bounds, 1.0), 0.75)
})

Deno.test('fractionOutside counts a non-finite centre as outside', () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }
  assertEquals(fractionOutside(Float64Array.from([0.5, 0.5, 0.5, NaN, 0, 0]), bounds, 1.5), 0.5)
})

Deno.test('seedCoverage is exact at the radius, across cell boundaries', () => {
  // The hash grid buckets at exactly `radius`, so a seed point whose only
  // nearby gaussian sits in an adjacent cell is the case that would break a
  // same-cell-only lookup. 0.9 apart with radius 1 must still count as covered.
  const splat = Float64Array.from([0, 0, 0, 10, 10, 10])
  assertEquals(seedCoverage(splat, Float64Array.from([0.9, 0, 0]), 1), 1)
  assertEquals(seedCoverage(splat, Float64Array.from([1.1, 0, 0]), 1), 0)
  assertEquals(seedCoverage(splat, Float64Array.from([0, 0, 0, 5, 5, 5]), 1), 0.5)
})

Deno.test('seedCoverage returns 0 rather than dividing by nothing', () => {
  assertEquals(seedCoverage(new Float64Array(0), Float64Array.from([0, 0, 0]), 1), 0)
  assertEquals(seedCoverage(Float64Array.from([0, 0, 0]), new Float64Array(0), 1), 0)
  assertEquals(seedCoverage(Float64Array.from([0, 0, 0]), Float64Array.from([0, 0, 0]), 0), 0)
})
