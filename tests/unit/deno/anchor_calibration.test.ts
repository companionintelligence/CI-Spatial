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
  composeYUpTransform,
  identityMatrix,
  DEFAULT_SEPARATION_TOLERANCE_M,
  MIN_POINT_SEPARATION_M,
} from '../../../src/world/geo.ts'
import { buildAnchorMarker, ANCHOR_RADIUS_M } from '../../../src/world/anchor-marker.ts'
import type { ProjectSpatialFrame, ScanCalibration, Vec3 } from '../../../src/world/types.ts'

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
