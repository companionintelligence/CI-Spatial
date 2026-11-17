/**
 * Characterisation tests for the calibration math PR #141 shipped with none —
 * `anchorToProjectTransform()` (src/world/geo.ts) and `buildAnchorMarker()`
 * (src/world/anchor-marker.ts). Wave 09 ticket 0005.
 *
 * Every assertion here is written against a **stated contract** — a claim one
 * of those files' own doc comments makes — not against observed output. So a
 * failure means the implementation contradicts its documentation, which is a
 * finding to escalate, not a test to adjust to match.
 *
 * Ticket 0004 extends this file with `twoPointToProjectTransform()`'s cases.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import * as THREE from 'three'
import {
  anchorToProjectTransform,
  cameraYawInSessionDeg,
  composeYUpTransform,
  identityMatrix,
  normaliseBearingDeg,
  sessionFrameBearingDeg,
  twoPointToProjectTransform,
  twoPointHeadingDeg,
  twoPointSeparationM,
  DEFAULT_SEPARATION_TOLERANCE_M,
  MIN_POINT_SEPARATION_M,
} from '../../../src/world/geo.ts'
import { buildAnchorMarker, ANCHOR_RADIUS_M } from '../../../src/world/anchor-marker.ts'
import type { ProjectSpatialFrame, ScanCalibration, Vec3 } from '../../../src/world/types.ts'
import { angDiff, bearingOfSessionYaw, norm360, perfectCompassBearing, trueSessionZBearing } from './physical_oracle.ts'
import {
  assessTwoPoint,
  buildTwoPointCommit,
  resolveCommitOptions,
  type TwoPointFrame,
} from '../../../src/ar/calibration-commit.ts'
import { fitRigid2D, twoPointToleranceM } from '../../../src/world/frame-fit.ts'

/**
 * Apply a column-major 4x4 (the layout `composeYUpTransform` returns and
 * `THREE.Matrix4.fromArray()` expects) to a point.
 *
 * Column-major means column 0 is indices [0,1,2], column 1 is [4,5,6],
 * column 2 is [8,9,10], and the translation is [12,13,14]. Stated explicitly
 * so a future reader can tell a convention change from a math bug.
 */
function applyMatrix(m: number[], p: Vec3): Vec3 {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * Tolerance for values read back out of a THREE.Float32BufferAttribute.
 *
 * Geometry vertices are stored as float32, so a coordinate written as 0.35
 * reads back as 0.3499999940395355 — about 6e-9 low, which is the storage
 * type's own precision, not an error in the geometry. Anything tighter than
 * this fails for reasons that have nothing to do with the code under test.
 * Still four orders of magnitude tighter than any real geometry mistake.
 */
const F32_EPSILON = 1e-6

const TAPS: Vec3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 1.5, y: -0.9, z: 2.25 },
  { x: -3.4, y: 0.12, z: -0.75 },
]
const BEARINGS: Array<number | null> = [null, 0, 45, 90, 180, 359]

// ── anchorToProjectTransform ────────────────────────────────────────────────

Deno.test('anchorToProjectTransform: the tapped point maps to project-space origin', () => {
  // The function's headline documented invariant: "`tapPos` ... must map to
  // project-space origin (0,0,0)". Convention-independent — it restates the
  // contract rather than re-deriving the arithmetic, so it cannot reproduce an
  // indexing bug the way a hand-recomputed expected matrix would.
  for (const tap of TAPS) {
    for (const bearing of BEARINGS) {
      const out = applyMatrix(anchorToProjectTransform(tap, bearing), tap)
      const label = `tap ${JSON.stringify(tap)} bearing ${bearing}`
      assertAlmostEquals(out.x, 0, 1e-9, label)
      assertAlmostEquals(out.y, 0, 1e-9, label)
      assertAlmostEquals(out.z, 0, 1e-9, label)
    }
  }
})

Deno.test('anchorToProjectTransform: a tap at non-zero height still zeroes fully', () => {
  // Guards the y row of the hand-indexed translation specifically — a tap on a
  // table rather than the floor must still land on the origin, even though the
  // frame it produces is then wrong in a way this function cannot detect
  // (that is ticket 0003's ground gate, not this one's).
  const tap = { x: 0.4, y: 0.75, z: -1.2 }
  const out = applyMatrix(anchorToProjectTransform(tap, 30), tap)
  assertAlmostEquals(out.y, 0, 1e-9)
})

Deno.test('anchorToProjectTransform: the transform is rigid — no scale or skew', () => {
  // The doc comment calls this a rotation plus a translation. If a transposed
  // index crept into the hand-written arithmetic the result could still zero
  // the tap point while distorting everything else, so check that distances
  // between arbitrary points survive.
  const tap = { x: 1.1, y: 0.2, z: -0.6 }
  const m = anchorToProjectTransform(tap, 37)
  const probes: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 1.7, z: 0 },
    { x: -1, y: 0.5, z: 3 },
  ]
  for (let i = 0; i < probes.length; i++) {
    for (let j = i + 1; j < probes.length; j++) {
      const before = distance(probes[i]!, probes[j]!)
      const after = distance(applyMatrix(m, probes[i]!), applyMatrix(m, probes[j]!))
      assertAlmostEquals(after, before, 1e-9, `pair ${i},${j}`)
    }
  }
})

Deno.test('anchorToProjectTransform: reuses composeYUpTransform’s rotation, not a second convention', () => {
  // Its doc comment claims it "Reuses composeYUpTransform's own rotation
  // construction so the yaw convention can't drift between the GPS-fallback
  // placement path and this one". Pin that: the 3x3 rotation block must equal
  // composeYUpTransform's for the same bearing. If someone later inlines a
  // different sign convention here, this fails — which is the whole point,
  // since a drifted yaw produces a plausible-looking but wrong frame.
  for (const bearing of [0, 45, 90, 180, 359]) {
    const anchor = anchorToProjectTransform({ x: 2, y: 1, z: -3 }, bearing)
    const reference = composeYUpTransform({ x: 0, y: 0, z: 0 }, bearing, 1)
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      assertAlmostEquals(anchor[i]!, reference[i]!, 1e-12, `bearing ${bearing} index ${i}`)
    }
  }
})

Deno.test('anchorToProjectTransform: distinct bearings give distinct rotations', () => {
  const tap = { x: 0, y: 0, z: 0 }
  const at0 = anchorToProjectTransform(tap, 0)
  const at90 = anchorToProjectTransform(tap, 90)
  // A point one metre "ahead" lands somewhere different under each.
  const p = { x: 0, y: 0, z: 1 }
  const a = applyMatrix(at0, p)
  const b = applyMatrix(at90, p)
  assert(distance(a, b) > 0.5, `expected a real rotation difference, got ${distance(a, b)}`)
})

Deno.test('anchorToProjectTransform: a null bearing yields an unrotated frame', () => {
  // CHARACTERISATION, NOT ENDORSEMENT. composeYUpTransform does
  // `yaw = ((bearingDeg ?? 0) * DEG_TO_RAD)`, so no compass fix silently means
  // yaw 0 — the frame inherits whatever heading the AR session booted with,
  // and two such sessions of one room are rotationally misaligned by an
  // unknown amount with nothing recording it. This test pins the behaviour so
  // the wave can point at it; ADR 0005 and ticket 0004 are what fix it.
  const m = anchorToProjectTransform({ x: 1, y: 0, z: 1 }, null)
  const identityRotation = composeYUpTransform({ x: 0, y: 0, z: 0 }, 0, 1)
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
    assertAlmostEquals(m[i]!, identityRotation[i]!, 1e-12, `index ${i}`)
  }
  // ...and is indistinguishable from an explicit bearing of 0.
  const atZero = anchorToProjectTransform({ x: 1, y: 0, z: 1 }, 0)
  for (let i = 0; i < 16; i++) assertAlmostEquals(m[i]!, atZero[i]!, 1e-12, `index ${i}`)
})

Deno.test('anchorToProjectTransform: returns a well-formed affine 4x4', () => {
  const m = anchorToProjectTransform({ x: 0.5, y: 0.5, z: 0.5 }, 12)
  assertEquals(m.length, 16)
  // Bottom row of a column-major affine matrix: [0, 0, 0, 1].
  assertAlmostEquals(m[3]!, 0, 1e-12)
  assertAlmostEquals(m[7]!, 0, 1e-12)
  assertAlmostEquals(m[11]!, 0, 1e-12)
  assertAlmostEquals(m[15]!, 1, 1e-12)
  assert(m.every(Number.isFinite), 'every element must be finite')
})

Deno.test('anchorToProjectTransform: agrees with THREE.Matrix4’s reading of the same array', () => {
  // The array is consumed downstream via Matrix4.fromArray() (the layout its
  // own comment names). If our applyMatrix helper and Three.js disagreed, one
  // of the two would be reading the matrix transposed — and every other
  // assertion in this file would be measuring the wrong thing.
  const tap = { x: -0.8, y: 0.3, z: 2.2 }
  const m = anchorToProjectTransform(tap, 63)
  const probe = new THREE.Vector3(1.3, -0.4, 0.9)
  const viaThree = probe.clone().applyMatrix4(new THREE.Matrix4().fromArray(m))
  const viaHelper = applyMatrix(m, { x: 1.3, y: -0.4, z: 0.9 })
  assertAlmostEquals(viaThree.x, viaHelper.x, 1e-9)
  assertAlmostEquals(viaThree.y, viaHelper.y, 1e-9)
  assertAlmostEquals(viaThree.z, viaHelper.z, 1e-9)
})

// ── buildAnchorMarker ───────────────────────────────────────────────────────

function childNames(group: THREE.Group): string[] {
  return group.children.map((c) => c.name)
}

function materialOpacity(group: THREE.Group, name: string): number {
  const child = group.children.find((c) => c.name === name) as THREE.LineSegments | undefined
  assert(child, `expected a child named ${name}`)
  return (child.material as THREE.LineBasicMaterial).opacity
}

Deno.test('buildAnchorMarker: with a bearing, renders ring, crosshair and north tick', () => {
  const group = buildAnchorMarker(45)
  assertEquals(group.name, 'calibration anchor')
  const names = childNames(group)
  assert(names.includes('anchor ring'), names.join(','))
  assert(names.includes('anchor crosshair'), names.join(','))
  assert(names.includes('anchor north tick'), names.join(','))
})

Deno.test('buildAnchorMarker: without a bearing, omits the tick and dims the rest', () => {
  // The documented "no compass fix" state — it must not guess an orientation.
  const group = buildAnchorMarker(null)
  assert(!childNames(group).includes('anchor north tick'), 'must not render a north tick')
  assertAlmostEquals(materialOpacity(group, 'anchor ring'), 0.32, 1e-9)
  assertAlmostEquals(materialOpacity(group, 'anchor crosshair'), 0.35, 1e-9)
})

Deno.test('buildAnchorMarker: the default argument is the no-compass state', () => {
  // viewer.ts calls buildAnchorMarker() with no argument for the World Editor,
  // deliberately, because a scan root's rotation may come from a gizmo drag
  // rather than a calibration — so there is no true-north axis to derive.
  assert(!childNames(buildAnchorMarker()).includes('anchor north tick'))
})

Deno.test('buildAnchorMarker: with a bearing, the undimmed opacities are used', () => {
  const group = buildAnchorMarker(0)
  assertAlmostEquals(materialOpacity(group, 'anchor ring'), 0.85, 1e-9)
  assertAlmostEquals(materialOpacity(group, 'anchor crosshair'), 0.9, 1e-9)
})

Deno.test('buildAnchorMarker: group yaw equals the bearing in radians', () => {
  for (const deg of [0, 45, 90, 180, 270]) {
    assertAlmostEquals(buildAnchorMarker(deg).rotation.y, (deg * Math.PI) / 180, 1e-9, `${deg}deg`)
  }
  // No bearing means no rotation applied at all, not a rotation of zero
  // arrived at by accident — both read 0, but only one is a deliberate state.
  assertAlmostEquals(buildAnchorMarker(null).rotation.y, 0, 1e-12)
})

Deno.test('buildAnchorMarker: the north tick points +Z before rotation, per the 0deg=north claim', () => {
  // anchor-marker.ts claims "Three.js's Y-axis rotation maps local +Z to
  // (sin θ, 0, cos θ), which is exactly compass bearing's own
  // 0°=north/90°=east convention". That only holds if the tick is built along
  // +Z, and it lines up with LocalFrame's declared axes (x: east, z: north).
  const group = buildAnchorMarker(0)
  const tick = group.children.find((c) => c.name === 'anchor north tick') as THREE.LineSegments
  const pos = tick.geometry.getAttribute('position')
  // Two vertices, both on the +Z axis, beyond the ring radius.
  assertEquals(pos.count, 2)
  for (let i = 0; i < pos.count; i++) {
    assertAlmostEquals(pos.getX(i), 0, 1e-9, `vertex ${i} x`)
    assertAlmostEquals(pos.getY(i), 0, 1e-9, `vertex ${i} y`)
    assert(pos.getZ(i) >= ANCHOR_RADIUS_M - F32_EPSILON, `vertex ${i} z should be at or past the ring`)
  }
})

Deno.test('buildAnchorMarker: rotating by 90deg sends the tick toward +X (east)', () => {
  // The other half of the same claim, checked through Three.js's own matrix
  // rather than by re-deriving it: at bearing 90 the tick's world direction
  // should be +X, matching LocalFrame's x: 'east'.
  const group = buildAnchorMarker(90)
  group.updateMatrixWorld(true)
  const tip = new THREE.Vector3(0, 0, ANCHOR_RADIUS_M).applyMatrix4(group.matrixWorld)
  assertAlmostEquals(tip.x, ANCHOR_RADIUS_M, 1e-9)
  assertAlmostEquals(tip.z, 0, 1e-9)
})

Deno.test('buildAnchorMarker: the ring lies flat in the XZ plane', () => {
  // Built flat by construction (its comment says "no separate lie-flat
  // rotation is needed"), which is what lets it sit on a floor without the
  // caller knowing to rotate it.
  const group = buildAnchorMarker(null)
  const ring = group.children.find((c) => c.name === 'anchor ring') as THREE.LineSegments
  const pos = ring.geometry.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    assertAlmostEquals(pos.getY(i), 0, 1e-9, `ring vertex ${i} must have y=0`)
    assertAlmostEquals(Math.hypot(pos.getX(i), pos.getZ(i)), ANCHOR_RADIUS_M, F32_EPSILON, `vertex ${i} radius`)
  }
})

Deno.test('buildAnchorMarker: each call gets its own materials', () => {
  // The module holds shared material singletons and .clone()s them per marker.
  // If a future edit drops the clone, mutating one marker's opacity (which the
  // null-bearing path does) would silently dim every other marker on screen.
  const a = buildAnchorMarker(null)
  const b = buildAnchorMarker(45)
  assertAlmostEquals(materialOpacity(a, 'anchor crosshair'), 0.35, 1e-9)
  assertAlmostEquals(materialOpacity(b, 'anchor crosshair'), 0.9, 1e-9)
})

// ─── Ticket 0002: the two-tier frame schema ─────────────────────────────────
// Type-level assertions. They carry no runtime assertion on purpose — the
// verification is that this file type-checks, which `deno task test` enforces
// (it checks every test file before running it).
//
// Note on ticket 0002's stated test "tsc --noEmit fails before the existing
// producer is narrowed": it does not, and cannot. The producer in
// src/ar/project-calibration.ts *constructs* a complete 'ground-tap-compass'
// literal, and a discriminated-union write with the discriminant present needs
// no narrowing — only a read of a member-specific field does. The property the
// ticket wanted proven is the read side, asserted below.

Deno.test('two-point frames carry the verification fields; one-point frames cannot', () => {
  const twoPoint: ProjectSpatialFrame = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 1.4, y: 0, z: 0 },
    separationM: 1.4,
    toleranceM: DEFAULT_SEPARATION_TOLERANCE_M,
    anchorBearingDeg: 41,
  }
  // `landmark` is (0,0,0) by construction — ticket 0002's stated invariant.
  assertEquals(twoPoint.method === 'two-point-ground' && twoPoint.landmark, { x: 0, y: 0, z: 0 })
  assert(twoPoint.method === 'two-point-ground' && twoPoint.separationM >= MIN_POINT_SEPARATION_M)

  // A #141-era frame still type-checks unchanged, and deserializes as the
  // fallback member with no migration.
  const onePoint: ProjectSpatialFrame = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    method: 'ground-tap-compass',
    anchorBearingDeg: null,
  }
  assertEquals(onePoint.method, 'ground-tap-compass')

  // @ts-expect-error — separationM is unreachable without narrowing on `method`.
  const _unnarrowed: number = (twoPoint as ProjectSpatialFrame).separationM
  // @ts-expect-error — the one-point tier has no verification field at all.
  const _noVerify: number = onePoint.separationM
})

Deno.test('a two-point frame missing a required field is a type error', () => {
  // @ts-expect-error — separationM is required on the 'two-point-ground' member.
  const _incomplete: ProjectSpatialFrame = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 1.2, y: 0, z: 0 },
    toleranceM: DEFAULT_SEPARATION_TOLERANCE_M,
    anchorBearingDeg: null,
  }
})

Deno.test('ScanCalibration mirrors the same two tiers', () => {
  const verified: ScanCalibration = {
    sessionToProject: identityMatrix(),
    calibratedAt: new Date(0).toISOString(),
    status: 'verified',
    method: 'two-point-ground',
    separationM: 1.4,
    residualM: 0.02,
    toleranceM: DEFAULT_SEPARATION_TOLERANCE_M,
    anchorBearingDeg: 41,
  }
  assert(verified.method === 'two-point-ground' && verified.residualM < verified.toleranceM)

  const provisional: ScanCalibration = {
    sessionToProject: identityMatrix(),
    calibratedAt: new Date(0).toISOString(),
    status: 'provisional',
    method: 'ground-tap-compass',
    anchorBearingDeg: null,
  }
  // @ts-expect-error — nothing on the one-point tier can be verified.
  const _r: number = provisional.residualM
  assertEquals(provisional.status, 'provisional')
})

// ── twoPointToProjectTransform (wave 09 ticket 0004) ──────────────────────
//
// The defining property of this tier is that the frame comes from the
// landmark→marker pair and from nothing else. Several of the tests below are
// really one claim stated from different angles: the AR session's arbitrary
// startup yaw must not reach the result.

/** Rotate about the vertical axis, the transform a differently-oriented session applies. */
function yawPoint(p: Vec3, degrees: number): Vec3 {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return { x: c * p.x + s * p.z, y: p.y, z: -s * p.x + c * p.z }
}

const LANDMARK: Vec3 = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER: Vec3 = { x: 3.1, y: -1.2, z: 1.9 }

Deno.test('twoPointToProjectTransform: the landmark maps to project-space origin', () => {
  const m = twoPointToProjectTransform(LANDMARK, HEADING_MARKER)
  const origin = applyMatrix(m, LANDMARK)
  assertAlmostEquals(origin.x, 0, F32_EPSILON)
  assertAlmostEquals(origin.y, 0, F32_EPSILON)
  assertAlmostEquals(origin.z, 0, F32_EPSILON)
})

Deno.test('twoPointToProjectTransform: the heading marker lands on +Z at the recorded separation', () => {
  const m = twoPointToProjectTransform(LANDMARK, HEADING_MARKER)
  const mapped = applyMatrix(m, HEADING_MARKER)
  const separation = twoPointSeparationM(LANDMARK, HEADING_MARKER)
  // Forward axis: no lateral or vertical component, and the full distance on +Z.
  assertAlmostEquals(mapped.x, 0, F32_EPSILON)
  assertAlmostEquals(mapped.y, 0, F32_EPSILON)
  assertAlmostEquals(mapped.z, separation, F32_EPSILON)
  assert(separation > 0)
})

Deno.test('twoPointToProjectTransform: yawing the whole pair changes nothing in project space', () => {
  // This is the regression the tier exists for: two sessions of the same room
  // started facing different directions must produce the same frame. #141's
  // compass-derived heading cannot pass this when the bearing is null.
  const base = twoPointToProjectTransform(LANDMARK, HEADING_MARKER)
  for (const yaw of [17, 90, 180, 270, 359]) {
    const a = yawPoint(LANDMARK, yaw)
    const b = yawPoint(HEADING_MARKER, yaw)
    const rotated = twoPointToProjectTransform(a, b)
    for (const [p, q] of [[LANDMARK, a], [HEADING_MARKER, b]] as const) {
      const expected = applyMatrix(base, p)
      const actual = applyMatrix(rotated, q)
      assertAlmostEquals(actual.x, expected.x, 1e-5, `x at yaw ${yaw}`)
      assertAlmostEquals(actual.y, expected.y, 1e-5, `y at yaw ${yaw}`)
      assertAlmostEquals(actual.z, expected.z, 1e-5, `z at yaw ${yaw}`)
    }
  }
})

Deno.test('twoPointToProjectTransform: the transform is rigid — no scale or skew', () => {
  const m = twoPointToProjectTransform(LANDMARK, HEADING_MARKER)
  const probes: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 2.4, y: 0.8, z: -3.1 },
    { x: -1.1, y: -2.2, z: 0.6 },
  ]
  for (let i = 0; i < probes.length; i++) {
    for (let j = i + 1; j < probes.length; j++) {
      const before = distance(probes[i]!, probes[j]!)
      const after = distance(applyMatrix(m, probes[i]!), applyMatrix(m, probes[j]!))
      assertAlmostEquals(after, before, 1e-5)
    }
  }
})

Deno.test('twoPointToProjectTransform: only x and z steer the heading, so y noise cannot tilt the frame', () => {
  // The flow projects both hits onto the established ground plane before
  // calling this. Even if that projection were skipped, a stray y must not
  // reach the heading — otherwise the room's floor stops being level.
  const noisy: Vec3 = { ...HEADING_MARKER, y: HEADING_MARKER.y + 0.07 }
  assertAlmostEquals(
    twoPointHeadingDeg(LANDMARK, noisy),
    twoPointHeadingDeg(LANDMARK, HEADING_MARKER),
    F32_EPSILON,
  )
  assertAlmostEquals(
    twoPointSeparationM(LANDMARK, noisy),
    twoPointSeparationM(LANDMARK, HEADING_MARKER),
    F32_EPSILON,
  )
})

Deno.test('twoPointToProjectTransform: coplanar markers give a horizontal baseline and a floor at y = 0', () => {
  const groundY = -1.2
  const landmark: Vec3 = { x: 1.5, y: groundY, z: -0.4 }
  const marker: Vec3 = { x: 3.1, y: groundY, z: 1.9 }
  const m = twoPointToProjectTransform(landmark, marker)

  // Baseline horizontal: both ends at the same project-space height.
  assertAlmostEquals(applyMatrix(m, landmark).y, applyMatrix(m, marker).y, F32_EPSILON)

  // A third point anywhere on the same floor also maps to y = 0 — project-space
  // y = 0 IS the ground plane, not an arbitrary offset through one tap.
  const elsewhereOnFloor: Vec3 = { x: -4.2, y: groundY, z: 6.7 }
  assertAlmostEquals(applyMatrix(m, elsewhereOnFloor).y, 0, F32_EPSILON)
})

Deno.test('twoPointSeparationM: measured in the ground plane, ignoring any vertical component', () => {
  const a: Vec3 = { x: 0, y: 0, z: 0 }
  const b: Vec3 = { x: 3, y: 99, z: 4 }
  // 3-4-5 in the plane; the y is deliberately absurd to prove it is discarded.
  assertAlmostEquals(twoPointSeparationM(a, b), 5, F32_EPSILON)
})

Deno.test('twoPointHeadingDeg: follows the 0deg = +Z north convention buildAnchorMarker uses', () => {
  const origin: Vec3 = { x: 0, y: 0, z: 0 }
  assertAlmostEquals(twoPointHeadingDeg(origin, { x: 0, y: 0, z: 1 }), 0, F32_EPSILON)
  assertAlmostEquals(twoPointHeadingDeg(origin, { x: 1, y: 0, z: 0 }), 90, F32_EPSILON)
  assertAlmostEquals(twoPointHeadingDeg(origin, { x: 0, y: 0, z: -1 }), 180, F32_EPSILON)
  assertAlmostEquals(twoPointHeadingDeg(origin, { x: -1, y: 0, z: 0 }), -90, F32_EPSILON)
})

Deno.test('MIN_POINT_SEPARATION_M: the commit gate rejects a baseline shorter than the minimum', () => {
  const origin: Vec3 = { x: 0, y: 0, z: 0 }
  const tooClose: Vec3 = { x: 0.2, y: 0, z: 0.2 }
  const farEnough: Vec3 = { x: 0, y: 0, z: MIN_POINT_SEPARATION_M + 0.01 }
  assert(twoPointSeparationM(origin, tooClose) < MIN_POINT_SEPARATION_M)
  assert(twoPointSeparationM(origin, farEnough) >= MIN_POINT_SEPARATION_M)
})

Deno.test('residual: a re-measured pair is within tolerance; a different pair is not', () => {
  const stored = twoPointSeparationM(LANDMARK, HEADING_MARKER)

  // Same two features, re-tapped with a couple of centimetres of hit-test noise.
  const remeasured = twoPointSeparationM(
    { ...LANDMARK, x: LANDMARK.x + 0.01 },
    { ...HEADING_MARKER, z: HEADING_MARKER.z + 0.01 },
  )
  assert(Math.abs(remeasured - stored) <= DEFAULT_SEPARATION_TOLERANCE_M)

  // A deliberately different second feature, half a metre off.
  const wrongPair = twoPointSeparationM(LANDMARK, { ...HEADING_MARKER, z: HEADING_MARKER.z + 0.5 })
  assert(Math.abs(wrongPair - stored) > DEFAULT_SEPARATION_TOLERANCE_M)
})

// ── Session-frame bearing (wave 09 ticket 0009) ─────────────────────────────
//
// `composeYUpTransform` maps session +Z to the ENU direction at the bearing it
// is given. Everything below establishes what bearing that has to be, because
// the raw compass heading — which is what every call site used to pass — is
// the heading of the *device*, not of the frame.
//
// "Truth" comes from ./physical_oracle.ts: a right-handed session, a camera that
// looks down its own -Z, a perfect compass, and no code shared with the app.
// These tests used to read the expected bearing back out of `composeYUpTransform`,
// which assumes the same direction of yaw as the function under test, so
// `sessionFrameBearingDeg` could subtract the camera's yaw where it has to add it
// and every one of them still passed (audit F53). The full grids over start
// headings, turns and tilts are in world_registration.test.ts; these are the
// cases a reader can check by hand.

/** Quaternion for a rotation of `deg` about the Y axis. */
function yawQuat(deg: number) {
  const half = (deg * Math.PI) / 360
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
}

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 }

Deno.test('cameraYawInSessionDeg: an identity camera faces session -Z, i.e. yaw 180', () => {
  // Not a quirk to correct for — this is the measurement that makes the
  // frame-bearing correction work without assuming how a provider sets up its
  // world frame.
  assertAlmostEquals(Math.abs(cameraYawInSessionDeg(IDENTITY_ROT)), 180, 1e-9)
})

Deno.test('cameraYawInSessionDeg: tracks the camera turning within the session', () => {
  // Rotating +90° about Y takes the camera's forward from session -Z to -X,
  // which is session yaw -90 in the atan2(x, z) convention.
  assertAlmostEquals(cameraYawInSessionDeg(yawQuat(90)), -90, 1e-6)
  assertAlmostEquals(cameraYawInSessionDeg(yawQuat(-90)), 90, 1e-6)
  assertAlmostEquals(Math.abs(cameraYawInSessionDeg(yawQuat(180))), 0, 1e-6)
})

Deno.test('sessionFrameBearingDeg: the camera direction agrees in both frames', () => {
  // The defining property. The camera's forward is one physical direction
  // described twice — as a session yaw and as a compass bearing — so a correct
  // frame bearing makes the two descriptions agree.
  //
  // A session that started facing `deviceBearing + turn` and has since turned
  // LEFT by `turn` reads `deviceBearing` on a perfect compass: a left turn
  // lowers a compass bearing. The oracle says so, not `composeYUpTransform`.
  for (const deviceBearing of [0, 37, 90, 180, 275, 359]) {
    for (const cameraTurn of [0, 45, 90, 180, -120]) {
      const startHeading = deviceBearing + cameraTurn
      const rotation = yawQuat(cameraTurn)
      assertAlmostEquals(
        angDiff(perfectCompassBearing(startHeading, rotation), deviceBearing),
        0,
        1e-6,
        `oracle: device ${deviceBearing}°, camera turned ${cameraTurn}°`,
      )
      const frameBearing = sessionFrameBearingDeg(deviceBearing, rotation)!
      const cameraSessionYaw = cameraYawInSessionDeg(rotation)
      // The frame bearing is the true bearing of session +Z...
      assertAlmostEquals(
        angDiff(frameBearing, trueSessionZBearing(startHeading)),
        0,
        1e-6,
        `device ${deviceBearing}°, camera turned ${cameraTurn}°`,
      )
      // ...and the session direction the camera faces really is at the bearing the compass read.
      assertAlmostEquals(
        angDiff(bearingOfSessionYaw(startHeading, cameraSessionYaw), deviceBearing),
        0,
        1e-6,
        `device ${deviceBearing}°, camera turned ${cameraTurn}°: session yaw ${cameraSessionYaw}`,
      )
    }
  }
})

Deno.test('sessionFrameBearingDeg: the raw compass heading is 180 degrees wrong at session start', () => {
  // The bug ticket 0009 exists for, stated as a test. With the camera at the
  // session's starting orientation, passing the device heading straight to
  // composeYUpTransform — which is what every call site did — points the scan
  // exactly backwards.
  const startHeading = 90 // the session started facing east
  const deviceBearing = perfectCompassBearing(startHeading, IDENTITY_ROT)
  assertAlmostEquals(deviceBearing, 90, 1e-9)
  const corrected = sessionFrameBearingDeg(deviceBearing, IDENTITY_ROT)!

  assertAlmostEquals(corrected, 270, 1e-6, 'session +Z is behind the initial view')
  assertAlmostEquals(corrected, trueSessionZBearing(startHeading), 1e-6)
  assertAlmostEquals(
    Math.abs(angDiff(corrected, deviceBearing)),
    180,
    1e-6,
    'the uncorrected value is exactly reversed',
  )

  // And the reversal is real, not a bookkeeping artefact: the camera is looking
  // east, so the direction it faces had better read as east.
  const cameraYaw = cameraYawInSessionDeg(IDENTITY_ROT)
  assertAlmostEquals(angDiff(bearingOfSessionYaw(startHeading, cameraYaw), 90), 0, 1e-6)
  // A session direction at yaw `y` has bearing `frameBearing - y`. Taking the raw
  // heading as the frame's bearing, the camera would read as facing west.
  assertAlmostEquals(norm360(deviceBearing - cameraYaw), 270, 1e-6, 'uncorrected, the camera would be reported facing west while looking east')
})

Deno.test('sessionFrameBearingDeg: mid-session turning does not leak into the frame', () => {
  // The second, larger error behind the flip. The frame is fixed at session
  // start; the heading is sampled whenever the user taps. Turning LEFT 60° between
  // those two moments lowers the device heading by 60° (10° -> 310°) and moves the
  // frame by nothing, so the corrected value must be identical.
  const atStart = sessionFrameBearingDeg(perfectCompassBearing(10, yawQuat(0)), yawQuat(0))!
  const afterTurning = sessionFrameBearingDeg(perfectCompassBearing(10, yawQuat(60)), yawQuat(60))!
  assertAlmostEquals(perfectCompassBearing(10, yawQuat(60)), 310, 1e-6)
  assertAlmostEquals(afterTurning, atStart, 1e-6)
  assertAlmostEquals(atStart, trueSessionZBearing(10), 1e-6)

  // This test used to pair a +60° rotation about Y with a compass that rose from
  // 10° to 70°. A +Y rotation is a LEFT turn, and a left turn lowers a compass, so
  // that pair is not a turn anyone can make; it passed only because the old rule
  // made the same mistake about which way the yaw runs.
  assert(Math.abs(angDiff(sessionFrameBearingDeg(70, yawQuat(60))!, atStart)) > 1)
})

Deno.test('sessionFrameBearingDeg: no compass fix stays null rather than becoming 0', () => {
  assertEquals(sessionFrameBearingDeg(null, IDENTITY_ROT), null)
  assertEquals(sessionFrameBearingDeg(undefined, IDENTITY_ROT), null)
  assertEquals(sessionFrameBearingDeg(Number.NaN, IDENTITY_ROT), null)
})

Deno.test('normaliseBearingDeg: folds into [0, 360)', () => {
  assertEquals(normaliseBearingDeg(0), 0)
  assertEquals(normaliseBearingDeg(360), 0)
  assertEquals(normaliseBearingDeg(-90), 270)
  assertEquals(normaliseBearingDeg(450), 90)
  assertEquals(normaliseBearingDeg(-450), 270)
})


// ── Three points: the constellation fit, through the commit (WP-04b) ───────────────────────────────
//
// A return visit that taps the landmark, the heading marker and the stored check point is fitted to the stored points by least
// squares, and the fit's matrix is its sessionToProject. The claims below are made against the geometry, not against another run of
// the same arithmetic: a visit is a rigid motion of the Place frame (a turn about Y and a shift, which is what two sessions of one
// room differ by), and the fit has to carry each tap back onto its stored point.

const COMMIT_OPTIONS = resolveCommitOptions({ hitTest: () => Promise.resolve(null) })

/** The Place's three points in its own frame: the landmark at the origin, the marker 3.5 m along +Z, a check point 2.6 m aside and 1 m along. */
const PLACE_POINTS: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3.5 }, { x: -2.6, y: 0.02, z: 1 }]

const STORED_WITH_CHECK: TwoPointFrame = {
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: PLACE_POINTS[0]!,
  headingMarker: PLACE_POINTS[1]!,
  separationM: 3.5,
  toleranceM: twoPointToleranceM(0.03),
  anchorBearingDeg: null,
  checkPoints: [PLACE_POINTS[2]!],
}

/** A later session: the Place frame turned `degrees` about Y, then shifted, with the floor at `floorY`. */
const sessionOf = (point: Vec3, degrees: number, shift: { x: number; z: number }, floorY: number): Vec3 => {
  const turned = yawPoint(point, degrees)
  return { x: turned.x + shift.x, y: floorY + point.y, z: turned.z + shift.z }
}

const visit = (points: Vec3[], degrees = 37, shift = { x: 2, z: -3 }, floorY = -1.2) =>
  points.map((p) => sessionOf(p, degrees, shift, floorY))

const assessThree = (taps: Vec3[], stored: TwoPointFrame | null = STORED_WITH_CHECK, override = false) =>
  assessTwoPoint({ landmark: taps[0]!, headingMarker: taps[1]!, checkPoint: taps[2] ?? null, stored, override }, COMMIT_OPTIONS)

Deno.test('three points: the fit carries every tap back onto its stored point, and its matrix is the visit\'s sessionToProject', () => {
  for (const degrees of [0, 37, 90, 180, 271]) {
    const taps = visit(PLACE_POINTS, degrees)
    const verdict = assessThree(taps)
    assert(verdict.kind === 'accepted', `turn ${degrees}`)
    assertEquals(verdict.status, 'verified')
    const m = verdict.sessionToProject
    taps.forEach((tap, i) => {
      const placed = applyMatrix(m, tap)
      assertAlmostEquals(placed.x, PLACE_POINTS[i]!.x, 1e-9, `turn ${degrees}, point ${i} x`)
      assertAlmostEquals(placed.y, PLACE_POINTS[i]!.y, 1e-9, `turn ${degrees}, point ${i} y`)
      assertAlmostEquals(placed.z, PLACE_POINTS[i]!.z, 1e-9, `turn ${degrees}, point ${i} z`)
    })
    // Rigid: the same lengths between any two points, and a proper rotation.
    assertAlmostEquals(distance(applyMatrix(m, taps[0]!), applyMatrix(m, taps[2]!)), distance(taps[0]!, taps[2]!), 1e-9)
    const fit = fitRigid2D(taps, PLACE_POINTS)
    assert(fit.ok)
    assertEquals(verdict.sessionToProject, fit.fit.matrix)
  }
})

Deno.test('three points: noise leaves each tap off its stored point by exactly the residual the record keeps', () => {
  const taps = visit(PLACE_POINTS, 123).map((p, i) => ({ x: p.x + [0.02, -0.015, 0.01][i]!, y: p.y, z: p.z + [-0.01, 0.02, 0.025][i]! }))
  const verdict = assessThree(taps)
  assert(verdict.kind === 'accepted')
  const { calibration } = buildTwoPointCommit(verdict, {
    landmark: taps[0]!, headingMarker: taps[1]!, frameBearingDeg: null, bearingConvention: 2, pointLabels: undefined, calibratedAt: '2026-11-17T00:00:00.000Z',
  })
  assert(calibration.method === 'two-point-ground' && calibration.fit && calibration.checkedBy === 'constellation')
  taps.forEach((tap, i) => {
    const placed = applyMatrix(calibration.sessionToProject, tap)
    assertAlmostEquals(Math.hypot(placed.x - PLACE_POINTS[i]!.x, placed.z - PLACE_POINTS[i]!.z), calibration.fit!.perPoint[i]!.residualM, 1e-9)
  })
})

Deno.test('mirrored: a check point on the wrong side of the line is a mismatch, and the pair alone could not say which side it is on', () => {
  const taps = visit([PLACE_POINTS[0]!, PLACE_POINTS[1]!, { ...PLACE_POINTS[2]!, x: -PLACE_POINTS[2]!.x }])
  const verdict = assessThree(taps)
  assertEquals(verdict.kind, 'mismatch')
  // The two-point comparison of the same visit passes: the distance between the pair is exactly what was stored.
  const pairOnly = assessThree(taps.slice(0, 2))
  assert(pairOnly.kind === 'accepted' && pairOnly.status === 'provisional')
})

Deno.test('swapped: the first two points tapped the wrong way round are a mismatch that says so, and the distance check passes them', () => {
  const taps = visit([PLACE_POINTS[1]!, PLACE_POINTS[0]!, PLACE_POINTS[2]!])
  const verdict = assessThree(taps)
  assert(verdict.kind === 'mismatch')
  assert(verdict.comparison.verdict.reasons.some((reason) => /swapped|another order/.test(reason)), verdict.comparison.verdict.reasons.join(' | '))
  const pairOnly = assessThree(taps.slice(0, 2))
  assert(pairOnly.kind === 'accepted', 'the distance is the same either way round, which is what reversed-pair meant')
})

Deno.test('a pair turned about the landmark at the same spacing passes the distance check and fails the fit', () => {
  const turned = [PLACE_POINTS[0]!, { x: 3.5 * Math.sin(0.35), y: 0, z: 3.5 * Math.cos(0.35) }, PLACE_POINTS[2]!]
  const taps = visit(turned)
  assert(assessThree(taps.slice(0, 2)).kind === 'accepted', 'same spacing')
  assertEquals(assessThree(taps).kind, 'mismatch')
})

Deno.test('a rigid shift of all three points is not seen by the fit: the known limit, which the verdict says in words', () => {
  const taps = visit(PLACE_POINTS.map((p) => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })))
  const verdict = assessThree(taps)
  assert(verdict.kind === 'accepted' && verdict.status === 'verified')
  assert(verdict.comparison?.verdict.reasons.includes('Not checked: that these are the same physical spots. Compare with the photos.'))
})

Deno.test('a first calibration with a check point stores it in the Place frame, and a later visit to that frame is fitted to it', () => {
  const taps = visit(PLACE_POINTS, 211, { x: -4, z: 1 })
  const first = assessThree(taps, null)
  assert(first.kind === 'accepted' && first.frameChanged && first.checkPoint)
  const { spatialFrame } = buildTwoPointCommit(first, {
    landmark: taps[0]!, headingMarker: taps[1]!, frameBearingDeg: null, bearingConvention: 2, pointLabels: undefined, calibratedAt: '2026-11-17T00:00:00.000Z',
  })
  assert(spatialFrame?.checkPoints?.length === 1)
  // The frame the first visit defines is the Place frame (landmark at the origin, marker on +Z), so the check point is where the Place
  // fixture has it, to the digit the arithmetic allows: a second visit in another session is verified against it.
  assertAlmostEquals(spatialFrame!.checkPoints![0]!.x, PLACE_POINTS[2]!.x, 1e-9)
  assertAlmostEquals(spatialFrame!.checkPoints![0]!.z, PLACE_POINTS[2]!.z, 1e-9)
  const second = assessThree(visit(PLACE_POINTS, 15, { x: 1, z: 9 }), spatialFrame)
  assert(second.kind === 'accepted' && second.status === 'verified')
})

Deno.test('golden: a Place frame written before check points existed is still a two-point frame: compared by distance, provisional, the frame kept', () => {
  // The frozen records of the build before the schema step (tests/fixtures/place-frame/records-before-s0.json, never regenerated).
  const fixture = JSON.parse(Deno.readTextFileSync(new URL('../../fixtures/place-frame/records-before-s0.json', import.meta.url))) as Record<string, {
    storedFrame?: TwoPointFrame
    calibration?: { separationM?: number; status?: string; toleranceM?: number }
    visitBaselineM?: number
  }>
  let compared = 0
  for (const [name, record] of Object.entries(fixture)) {
    const stored = record.storedFrame
    if (!stored || stored.method !== 'two-point-ground') continue
    assert(!('checkPoints' in stored), `${name}: written before check points existed`)
    // The visit re-taps the pair at the distance the old record measured: inside the spacing tolerance, or the gap that was kept anyway.
    const apart = record.visitBaselineM ?? record.calibration!.separationM!
    const taps = visit([PLACE_POINTS[0]!, { x: 0, y: 0, z: apart }])
    const verdict = assessThree(taps, stored)
    if (Math.abs(apart - stored.separationM) > twoPointToleranceM(0.03)) {
      assertEquals(verdict.kind, 'mismatch', `${name}: ${apart} against ${stored.separationM}`)
    } else {
      assert(verdict.kind === 'accepted', name)
      assertEquals(verdict.status, 'provisional', `${name}: a distance check is never verified`)
      assertEquals(verdict.frameChanged, false, name)
      assertEquals(verdict.comparison?.checkedBy, 'separation', name)
    }
    compared += 1
  }
  assert(compared >= 3, `the fixture holds ${compared} stored frames`)
})
