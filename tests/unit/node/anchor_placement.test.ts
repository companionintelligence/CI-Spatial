/**
 * Where the World Editor draws a scan's calibration anchors.
 *
 * A scan root is placed by `scan.localToWorld`. For a calibrated scan that matrix
 * is the capture's session-to-project transform M, so the root's own (local)
 * coordinates are the AR SESSION frame, and M carries them into project space. M
 * also pins the calibration's reference down: it sends the tapped landmark L to
 * project zero and, on the two-point tier, the heading marker H to (0, 0, d).
 *
 * The decal and the red pins are children of the root, so a project-space point P
 * has to be drawn at inverse(M)·P. The editor used to draw them at root-local
 * (0,0,0) and (0,0,d) on the reasoning that "the calibrated reference always maps
 * to project-space zero". Root-local (0,0,0) is the session origin, which M sends
 * to M's own translation, so the decal and the pins were drawn away from the
 * landmark and a perfect calibration showed as a gap against the white pins.
 *
 * Everything here uses the repo's own calibration builders from src/world/geo.ts
 * with the pair from tests/unit/deno/anchor_calibration.test.ts, so the matrices
 * are the real ones, not hand-made stand-ins.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/anchor_placement.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import {
  anchorToProjectTransform,
  composeYUpTransform,
  identityMatrix,
  transformPoint,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import { invertAffine, sessionAnchorPositions } from '../../../src/world/anchor-placement.ts'
import type { Vec3 } from '../../../src/world/types.ts'

/**
 * Double-precision round trips through a rigid matrix land within ~1e-15 of the
 * target. 1e-9 is loose enough never to flake and still nine orders of magnitude
 * tighter than the metre-scale placement mistakes these tests are about.
 */
const EPS = 1e-9

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

/** The pair tests/unit/deno/anchor_calibration.test.ts uses. */
const LANDMARK: Vec3 = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER: Vec3 = { x: 3.1, y: -1.2, z: 1.9 }

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`
}

function assertNear(actual: Vec3, expected: Vec3, label: string, eps = EPS): void {
  const gap = distance(actual, expected)
  assert.ok(gap <= eps, `${label}: expected ${fmt(expected)}, got ${fmt(actual)} (${gap} m apart)`)
}

function assertFinitePoint(p: Vec3, label: string): void {
  assert.ok([p.x, p.y, p.z].every(Number.isFinite), `${label} must be finite, got ${fmt(p)}`)
}

function assertMatrixNear(actual: number[], expected: number[], label: string, eps = EPS): void {
  assert.equal(actual.length, 16, `${label}: not a 4x4`)
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Math.abs(actual[i]! - expected[i]!) <= eps,
      `${label}: element ${i} is ${actual[i]}, expected ${expected[i]}`,
    )
  }
}

/** Rotate about the vertical axis: what a session that started facing another way sees. */
function yawPoint(p: Vec3, degrees: number): Vec3 {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return { x: c * p.x + s * p.z, y: p.y, z: -s * p.x + c * p.z }
}

function shift(p: Vec3, by: Vec3): Vec3 {
  return { x: p.x + by.x, y: p.y + by.y, z: p.z + by.z }
}

type Pair = { name: string; landmark: Vec3; heading: Vec3 }

/**
 * The same physical pair as one AR session, or another that started facing a
 * different way or from a different spot, would measure it. The calibration is
 * built from each session's own coordinates.
 */
const PAIRS: Pair[] = [
  { name: 'the repo pair', landmark: LANDMARK, heading: HEADING_MARKER },
  ...[17, 90, 180, 270, 359].map((deg) => ({
    name: `the pair yawed ${deg} deg`,
    landmark: yawPoint(LANDMARK, deg),
    heading: yawPoint(HEADING_MARKER, deg),
  })),
  {
    name: 'the pair seen from a session that started 7 m away',
    landmark: shift(LANDMARK, { x: 7, y: 0.3, z: -4 }),
    heading: shift(HEADING_MARKER, { x: 7, y: 0.3, z: -4 }),
  },
]

function calibrate(pair: Pair): { m: number[]; d: number } {
  return {
    m: twoPointToProjectTransform(pair.landmark, pair.heading),
    d: twoPointSeparationM(pair.landmark, pair.heading),
  }
}

// ── invertAffine ────────────────────────────────────────────────────────────

test('invertAffine: the identity inverts to itself', () => {
  assertMatrixNear(invertAffine(identityMatrix())!, identityMatrix(), 'identity')
})

test('invertAffine: a pure translation inverts to the opposite translation', () => {
  const m = identityMatrix()
  m[12] = 3
  m[13] = -2
  m[14] = 0.5
  const inv = invertAffine(m)
  assert.ok(inv)
  const expected = identityMatrix()
  expected[12] = -3
  expected[13] = 2
  expected[14] = -0.5
  assertMatrixNear(inv, expected, 'translation')
})

test('invertAffine: matches a hand-derived inverse, so the column-major layout is right', () => {
  // x' = z + 5, y' = y + 6, z' = 7 - x: a quarter turn about Y plus a translation.
  // Solving for the source point gives x = 7 - z', y = y' - 6, z = x' - 5, which
  // written out column-major is the second array. A row-major reading of either
  // array gives a different matrix, so this fails on a transposed implementation.
  const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 6, 7, 1]
  const expected = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 7, -6, -5, 1]
  assertMatrixNear(invertAffine(m)!, expected, 'quarter turn plus translation')
})

test('invertAffine: undoes the repo’s own calibration transforms, in both directions', () => {
  const transforms: Array<[string, number[]]> = [
    ['two-point', twoPointToProjectTransform(LANDMARK, HEADING_MARKER)],
    ['one-point, bearing 0', anchorToProjectTransform(LANDMARK, 0)],
    ['one-point, bearing 137', anchorToProjectTransform(LANDMARK, 137)],
    ['one-point, no compass fix', anchorToProjectTransform(LANDMARK, null)],
    ['GPS placement', composeYUpTransform({ x: 41, y: 0, z: -230 }, 63, 1)],
    // The known-distance tier carries a real scale: 0.4798 m per solve unit.
    ['scaled placement', composeYUpTransform({ x: -2, y: 0.5, z: 9 }, 211, 0.4798)],
  ]
  const probes: Vec3[] = [ZERO, LANDMARK, HEADING_MARKER, { x: -8.25, y: 2.5, z: 14.75 }]
  for (const [name, m] of transforms) {
    const inv = invertAffine(m)
    assert.ok(inv, `${name} must be invertible`)
    for (const p of probes) {
      assertNear(transformPoint(inv, transformPoint(m, p)), p, `${name}: M⁻¹·M·p at ${fmt(p)}`)
      assertNear(transformPoint(m, transformPoint(inv, p)), p, `${name}: M·M⁻¹·p at ${fmt(p)}`)
    }
  }
})

test('invertAffine: agrees with THREE.Matrix4.invert() on a general affine matrix', () => {
  // THREE is the oracle for the layout the viewer actually applies to the root
  // (Matrix4.fromArray). The first two have a shear or a non-uniform scale, which
  // no calibration produces but a hand-edited manifest could.
  const matrices = [
    [1.3, 0.2, -0.1, 0, 0.4, 0.9, 0.3, 0, -0.2, 0.5, 1.7, 0, 4, -2, 0.5, 1],
    [0.5, 0, 0, 0, 0, 2.5, 0, 0, 0, 0, 1.1, 0, -3, 8, 1, 1],
    [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0.25, 0.5, 0.75, 1],
    twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
  ]
  for (const [i, m] of matrices.entries()) {
    const expected = new THREE.Matrix4().fromArray(m).invert().elements
    assertMatrixNear(invertAffine(m)!, expected, `matrix ${i}`)
  }
})

test('invertAffine: a tiny but valid scale still inverts — singularity is relative, not an absolute epsilon', () => {
  const m = composeYUpTransform({ x: 1e-6, y: 0, z: 2e-6 }, 30, 1e-6)
  const inv = invertAffine(m)
  assert.ok(inv, 'a similarity transform with scale 1e-6 is invertible')
  const p = { x: 1e-6, y: 2e-6, z: -3e-6 }
  // p itself is ~1e-6, so 1e-12 still checks the round trip to a millionth of its size.
  assertNear(transformPoint(inv, transformPoint(m, p)), p, 'round trip', 1e-12)
})

test('invertAffine: returns null for anything that is not an invertible 4x4 of finite numbers', () => {
  const withEntry = (i: number, v: unknown): number[] => {
    const m: unknown[] = identityMatrix()
    m[i] = v
    return m as number[]
  }
  const cases: Array<[string, unknown]> = [
    ['an empty array', []],
    ['fifteen numbers', identityMatrix().slice(0, 15)],
    ['seventeen numbers', [...identityMatrix(), 1]],
    ['a non-array', null],
    ['undefined', undefined],
    ['a NaN translation', withEntry(12, Number.NaN)],
    ['an infinite rotation entry', withEntry(5, Number.POSITIVE_INFINITY)],
    ['a numeric string entry', withEntry(0, '1')],
    ['a null entry', withEntry(14, null)],
    ['an all-zero matrix', new Array<number>(16).fill(0)],
    ['a zero rotation block with a translation', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 1]],
    ['a zero column (flattened along X)', [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    ['two equal columns (rank 2)', [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    ['a rank-2 shear', [1, 2, 3, 0, 2, 4, 6, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    // Not exactly singular, so its inverse is finite: entries around 1e12, which
    // is numerical noise rather than a placement. Only the relative-determinant
    // guard turns this away; the finiteness check on the result cannot.
    ['a nearly singular matrix (two columns 1e-12 apart)', [1, 0, 0, 0, 1, 1e-12, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    ['entries too large to invert', [1e200, 0, 0, 0, 0, 1e200, 0, 0, 0, 0, 1e200, 0, 0, 0, 0, 1]],
  ]
  for (const [name, m] of cases) {
    assert.equal(invertAffine(m as number[]), null, name)
  }
})

test('invertAffine: leaves its input alone', () => {
  const m = Object.freeze(twoPointToProjectTransform(LANDMARK, HEADING_MARKER)) as number[]
  const before = [...m]
  const inv = invertAffine(m)
  assert.ok(inv)
  assert.notEqual(inv, m)
  assert.deepEqual([...m], before)
})

// ── sessionAnchorPositions ──────────────────────────────────────────────────

test('the landmark is drawn where it was tapped, in session coordinates — not at the session origin', () => {
  for (const pair of PAIRS) {
    const { m, d } = calibrate(pair)
    const placed = sessionAnchorPositions(m, d)
    assertNear(placed.landmark, pair.landmark, `${pair.name}: landmark`)
    assert.ok(placed.headingMarker, `${pair.name}: heading marker`)
    assertNear(placed.headingMarker, pair.heading, `${pair.name}: heading marker`)
    // The session origin is not where any of these landmarks is.
    assert.ok(distance(placed.landmark, ZERO) > 1, `${pair.name}: landmark must not sit at the session origin`)
  }
})

test('mapped through the scan matrix, the landmark is project zero and the heading marker is (0, 0, d)', () => {
  for (const pair of PAIRS) {
    const { m, d } = calibrate(pair)
    const placed = sessionAnchorPositions(m, d)
    assertNear(transformPoint(m, placed.landmark), ZERO, `${pair.name}: M · landmark`)
    assertNear(transformPoint(m, placed.headingMarker!), { x: 0, y: 0, z: d }, `${pair.name}: M · heading`)
  }
})

test('a perfect calibration puts the red pins exactly on the white ones, once both are in world space', () => {
  // The editor draws the Place's stored frame straight into world space (landmark
  // at the origin, heading marker on +Z at the stored separation) and draws a scan's
  // own pins as children of a root placed by M, so a pin's world position is
  // M · its root-local position. A scan whose measured separation equals the stored
  // one must leave nothing between them.
  for (const pair of PAIRS) {
    const { m, d } = calibrate(pair)
    const placed = sessionAnchorPositions(m, d)
    const redLandmark = transformPoint(m, placed.landmark)
    const redHeading = transformPoint(m, placed.headingMarker!)
    const whiteLandmark = { x: 0, y: 0, z: 0 }
    const whiteHeading = { x: 0, y: 0, z: d }
    assert.ok(distance(redLandmark, whiteLandmark) <= EPS, `${pair.name}: landmark gap ${distance(redLandmark, whiteLandmark)} m`)
    assert.ok(distance(redHeading, whiteHeading) <= EPS, `${pair.name}: heading gap ${distance(redHeading, whiteHeading)} m`)
  }
})

test('a residual shows as a gap on the heading marker alone, along the frame’s +Z axis', () => {
  const { m, d: measured } = calibrate(PAIRS[0]!)
  const placed = sessionAnchorPositions(m, measured)
  const redLandmark = transformPoint(m, placed.landmark)
  const redHeading = transformPoint(m, placed.headingMarker!)
  // `commitTwoPoint` records residualM = measured - stored.
  for (const residual of [0.04, -0.09, 0.2]) {
    const stored = measured - residual
    const whiteHeading = { x: 0, y: 0, z: stored }
    assertNear(redLandmark, ZERO, `residual ${residual}: the landmark pins still coincide`)
    assert.ok(
      Math.abs(distance(redHeading, whiteHeading) - Math.abs(residual)) <= EPS,
      `residual ${residual}: the gap must be the residual, got ${distance(redHeading, whiteHeading)} m`,
    )
    assert.ok(Math.abs(redHeading.z - whiteHeading.z - residual) <= EPS, `residual ${residual}: signed along +Z`)
    assert.ok(Math.abs(redHeading.x) <= EPS && Math.abs(redHeading.y) <= EPS, `residual ${residual}: nothing off-axis`)
  }
})

test('a stray height on the second tap does not lift the red heading pin off the ground plane', () => {
  // The flow projects both taps onto the ground plane first, and the stored white
  // pin sits at (0, 0, d). The red pin is drawn at that same project-space point.
  const noisy = { ...HEADING_MARKER, y: HEADING_MARKER.y + 0.07 }
  const m = twoPointToProjectTransform(LANDMARK, noisy)
  const d = twoPointSeparationM(LANDMARK, noisy)
  const placed = sessionAnchorPositions(m, d)
  assertNear(transformPoint(m, placed.headingMarker!), { x: 0, y: 0, z: d }, 'M · heading')
  assert.ok(Math.abs(placed.headingMarker!.y - LANDMARK.y) <= EPS, 'the pin stands on the landmark’s floor level')
})

test('the old placement — root-local (0, 0, 0) and (0, 0, d) — is nowhere near the landmark for this pair', () => {
  // Pins the bug as wrong, independent of the new module. M maps the session origin to its
  // own translation, -R·L, which is |L| away from project zero.
  const { m, d } = calibrate(PAIRS[0]!)
  const whiteLandmark = { x: 0, y: 0, z: 0 }
  const whiteHeading = { x: 0, y: 0, z: d }

  const oldDecal = transformPoint(m, { x: 0, y: 0, z: 0 })
  const oldHeadingPin = transformPoint(m, { x: 0, y: 0, z: d })
  const lengthOfLandmark = Math.hypot(LANDMARK.x, LANDMARK.y, LANDMARK.z)

  assert.ok(Math.abs(distance(oldDecal, whiteLandmark) - lengthOfLandmark) <= EPS, 'old decal misses by |L|')
  assert.ok(
    distance(oldDecal, whiteLandmark) > 1.9,
    `a perfect calibration used to draw its decal ${distance(oldDecal, whiteLandmark)} m from the landmark`,
  )
  assert.ok(
    distance(oldHeadingPin, whiteHeading) > 3,
    `...and its red heading pin ${distance(oldHeadingPin, whiteHeading)} m from the white one`,
  )

  // The corrected placement closes both gaps.
  const placed = sessionAnchorPositions(m, d)
  assert.ok(distance(transformPoint(m, placed.landmark), whiteLandmark) <= EPS)
  assert.ok(distance(transformPoint(m, placed.headingMarker!), whiteHeading) <= EPS)
  // And it is a different place from the old one in the root's own coordinates.
  assert.ok(distance(placed.landmark, ZERO) > 1.9)
})

test('the one-point tier draws its decal on the tapped point and has no heading marker', () => {
  const taps: Vec3[] = [ZERO, { x: 1.5, y: -0.9, z: 2.25 }, { x: -3.4, y: 0.12, z: -0.75 }]
  const bearings: Array<number | null> = [null, 0, 45, 90, 180, 359]
  for (const tap of taps) {
    for (const bearing of bearings) {
      const m = anchorToProjectTransform(tap, bearing)
      const label = `tap ${fmt(tap)} bearing ${bearing}`
      const placed = sessionAnchorPositions(m)
      assertNear(placed.landmark, tap, `${label}: landmark`)
      assertNear(transformPoint(m, placed.landmark), ZERO, `${label}: M · landmark`)
      assert.equal(placed.headingMarker, null, `${label}: no heading marker on this tier`)
    }
  }
})

test('a scaled placement still puts the decal on the point the frame calls project zero', () => {
  // The known-distance tier is a uniform scale about the first spot, whose matrix
  // sends that spot to zero: scale·(p - anchor).
  const anchor: Vec3 = { x: 2, y: -1.1, z: 3 }
  const s = 0.4798
  const m = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -s * anchor.x, -s * anchor.y, -s * anchor.z, 1]
  const placed = sessionAnchorPositions(m)
  assertNear(placed.landmark, anchor, 'landmark')
  assertNear(transformPoint(m, placed.landmark), ZERO, 'M · landmark')
})

test('an identity root draws the project-space points unchanged', () => {
  const placed = sessionAnchorPositions(identityMatrix(), 2.5)
  assertNear(placed.landmark, ZERO, 'landmark')
  assertNear(placed.headingMarker!, { x: 0, y: 0, z: 2.5 }, 'heading marker')
})

test('a matrix the viewer would ignore or choke on falls back to the project points, never NaN', () => {
  const nan = identityMatrix()
  nan[13] = Number.NaN
  const infinite = identityMatrix()
  infinite[0] = Number.POSITIVE_INFINITY
  const malformed: Array<[string, unknown]> = [
    // applyMatrix() ignores anything that is not 16 long, leaving the root at identity.
    ['an empty array', []],
    ['fifteen numbers', identityMatrix().slice(0, 15)],
    ['seventeen numbers', [...identityMatrix(), 1]],
    ['undefined', undefined],
    ['null', null],
    // A degenerate or poisoned matrix has no inverse to place anything with.
    ['a NaN entry', nan],
    ['an infinite entry', infinite],
    ['an all-zero matrix', new Array<number>(16).fill(0)],
    ['two equal columns', [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]],
  ]
  for (const [name, m] of malformed) {
    const placed = sessionAnchorPositions(m as number[], 2.8)
    assertNear(placed.landmark, ZERO, `${name}: landmark`, 0)
    assertNear(placed.headingMarker!, { x: 0, y: 0, z: 2.8 }, `${name}: heading marker`, 0)
    assertFinitePoint(placed.landmark, `${name}: landmark`)
    assertFinitePoint(placed.headingMarker!, `${name}: heading marker`)
  }
})

test('the fallback hands out fresh points each call', () => {
  const a = sessionAnchorPositions([], 2)
  const b = sessionAnchorPositions([], 2)
  assert.notEqual(a.landmark, b.landmark)
  a.landmark.x = 99
  assert.equal(b.landmark.x, 0)
})

test('no usable separation means no heading marker, and the landmark is still placed', () => {
  const { m } = calibrate(PAIRS[0]!)
  const unusable: Array<[string, number | null | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -2.8],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ]
  for (const [name, separation] of unusable) {
    const placed = sessionAnchorPositions(m, separation)
    assert.equal(placed.headingMarker, null, `${name}: heading marker`)
    assertNear(placed.landmark, LANDMARK, `${name}: landmark`)
  }
})

// ── the module's own contract ───────────────────────────────────────────────

test('the placement module is loadable without THREE', () => {
  // It exists so the maths can be tested in Node, away from the viewer's DOM and
  // WebGL. Importing THREE would not break Node, but it would let the module grow
  // a dependency on the scene graph; keep it to plain number arrays.
  const source = readFileSync(new URL('../../../src/world/anchor-placement.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from\s+['"]three['"]/)
  assert.doesNotMatch(source, /require\(\s*['"]three['"]\s*\)/)
})
