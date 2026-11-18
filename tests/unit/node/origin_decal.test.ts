/**
 * The committed origin decal (wave 12, ticket 0001): the origin math and the
 * geometry it produces.
 *
 * The assertions that matter are about *world* positions, read through
 * `matrixWorld`, not about rotation numbers. A decal can have every yaw right
 * and still draw its arrow on the wrong side if a parent group is mis-nested,
 * and the scene only ever shows the world result. So the arrow tip and the north
 * tick are checked where they actually land.
 *
 * Run: npm run test:origin
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import {
  LEGACY_BEARING_CONVENTION,
  originDecalPlan,
  originHeadingBearingDeg,
  readCalibrationGroundY,
  twoPointHeadingDeg,
  twoPointSeparationM,
  type OriginDecalPlan,
} from '../../../src/world/geo.ts'
import {
  buildOriginDecal,
  COMMITTED_ORIGIN_NAME,
  STORED_ORIGIN_NAME,
} from '../../../src/world/origin-decal.ts'
import { ANCHOR_RADIUS_M, buildAnchorMarker } from '../../../src/world/anchor-marker.ts'
import { clockwiseFromTickToArrow } from './origin_picture.ts'

const EPS = 1e-9

/**
 * World-space point of a local point under a group, after every ancestor's transform.
 *
 * `updateWorldMatrix(true, false)` walks up to the root first. `updateMatrixWorld`
 * on the child alone would multiply by a parent matrix that has not been
 * recomputed, and drop the rotation of every group above it.
 */
function toWorld(object: THREE.Object3D, local: THREE.Vector3): THREE.Vector3 {
  object.updateWorldMatrix(true, false)
  return local.clone().applyMatrix4(object.matrixWorld)
}

function requireChild(parent: THREE.Object3D, name: string): THREE.Object3D {
  const child = parent.getObjectByName(name)
  assert.ok(child, `expected a child named "${name}"`)
  return child
}

function opacitiesOf(object: THREE.Object3D): number[] {
  const out: number[] = []
  object.traverse((node) => {
    const material = (node as THREE.LineSegments).material
    if (material && !Array.isArray(material)) out.push((material as THREE.LineBasicMaterial).opacity)
  })
  return out
}

// ── originDecalPlan ────────────────────────────────────────────────────────

test('originDecalPlan: the arrow points along the landmark-to-heading baseline and runs its length', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  const heading = { x: 3, y: 0, z: 4 }
  const plan = originDecalPlan(landmark, heading, null)

  assert.equal(plan.arrowLengthM, 5, 'a 3-4-5 baseline is 5 m long')
  assert.ok(plan.headingDeg !== null)
  assert.ok(Math.abs(plan.headingDeg - twoPointHeadingDeg(landmark, heading)) < EPS)
  assert.ok(Math.abs(plan.headingDeg - Math.atan2(3, 4) * (180 / Math.PI)) < EPS)
})

test('originDecalPlan: no heading point means no arrow, and origin and north are kept', () => {
  const plan = originDecalPlan({ x: 1, y: 0.2, z: -2 }, null, 45)
  assert.equal(plan.headingDeg, null)
  assert.equal(plan.arrowLengthM, 0)
  assert.deepEqual(plan.origin, { x: 1, y: 0.2, z: -2 })
  assert.equal(plan.northYawDeg, 45)
})

test('originDecalPlan: a heading point on the origin gives no arrow rather than an undefined one', () => {
  const plan = originDecalPlan({ x: 2, y: 0, z: 2 }, { x: 2, y: 0, z: 2 }, 0)
  assert.equal(plan.headingDeg, null)
  assert.equal(plan.arrowLengthM, 0)
})

test('originDecalPlan: the origin is copied, so editing the plan cannot move the caller\'s point', () => {
  const origin = { x: 1, y: 0.2, z: -2 }
  const plan = originDecalPlan(origin, null, null)
  plan.origin.x = 99
  assert.equal(origin.x, 1)
})

test('originDecalPlan: the origin keeps its measured ground height', () => {
  // The committed landmark is snapped onto the floor, so its y is the floor's height in session metres.
  const plan = originDecalPlan({ x: 0, y: -0.35, z: 0 }, { x: 0, y: -0.35, z: 1.5 }, 90)
  assert.equal(plan.origin.y, -0.35)
  assert.equal(plan.arrowLengthM, twoPointSeparationM({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.5 }))
})

// ── readCalibrationGroundY ─────────────────────────────────────────────────

test('readCalibrationGroundY: returns a finite groundY and null for everything else', () => {
  assert.equal(readCalibrationGroundY({ groundY: 0.12 }), 0.12)
  assert.equal(readCalibrationGroundY({ groundY: -0.4 }), -0.4)
  assert.equal(readCalibrationGroundY({ groundY: 0 }), 0)

  // Pre-ticket records have no field: not an error, just not knowing the floor.
  assert.equal(readCalibrationGroundY({ separationM: 2 }), null)
  assert.equal(readCalibrationGroundY(null), null)
  assert.equal(readCalibrationGroundY(undefined), null)
  assert.equal(readCalibrationGroundY('0.1'), null)
  assert.equal(readCalibrationGroundY({ groundY: null }), null)
  assert.equal(readCalibrationGroundY({ groundY: NaN }), null)
  assert.equal(readCalibrationGroundY({ groundY: Infinity }), null)
  assert.equal(readCalibrationGroundY({ groundY: '0.1' }), null)
})

// ── buildOriginDecal geometry ──────────────────────────────────────────────

test('buildOriginDecal: the committed group is named and sits on the ground at the origin', () => {
  const plan = originDecalPlan({ x: 1, y: 0.2, z: -2 }, { x: 4, y: 0.2, z: 2 }, 30)
  const decal = buildOriginDecal(plan, 'committed')

  assert.equal(decal.name, COMMITTED_ORIGIN_NAME)
  assert.equal(decal.name, 'calibration origin')
  assert.deepEqual(
    { x: decal.position.x, y: decal.position.y, z: decal.position.z },
    { x: 1, y: 0.2, z: -2 },
  )
})

test('buildOriginDecal: the arrow tip lands on the heading point in world space', () => {
  const landmark = { x: 1, y: 0.2, z: -2 }
  const heading = { x: 4, y: 0.2, z: 2 }
  const decal = buildOriginDecal(originDecalPlan(landmark, heading, null), 'committed')
  const arrow = requireChild(decal, 'origin heading')

  // The arrow's own length runs along local +Z; its tip is the far end of the shaft.
  const tipLocal = new THREE.Vector3(0, 0, twoPointSeparationM(landmark, heading))
  const tip = toWorld(arrow, tipLocal)

  assert.ok(Math.abs(tip.x - heading.x) < 1e-9, `tip.x ${tip.x} vs heading ${heading.x}`)
  assert.ok(Math.abs(tip.y - heading.y) < 1e-9, `tip.y ${tip.y} vs heading ${heading.y}`)
  assert.ok(Math.abs(tip.z - heading.z) < 1e-9, `tip.z ${tip.z} vs heading ${heading.z}`)
})

test('buildOriginDecal: the arrow points the way the heading does, for several headings', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  for (const deg of [0, 37, 90, -90, 180, 271]) {
    const rad = (deg * Math.PI) / 180
    const length = 2
    const heading = { x: length * Math.sin(rad), y: 0, z: length * Math.cos(rad) }
    const decal = buildOriginDecal(originDecalPlan(landmark, heading, null), 'committed')
    const tip = toWorld(requireChild(decal, 'origin heading'), new THREE.Vector3(0, 0, length))
    assert.ok(
      Math.abs(tip.x - heading.x) < 1e-9 && Math.abs(tip.z - heading.z) < 1e-9,
      `heading ${deg}deg: tip (${tip.x}, ${tip.z}) vs (${heading.x}, ${heading.z})`,
    )
  }
})

test('buildOriginDecal: the north tick points at the north yaw, and uses the anchor marker convention', () => {
  // The same convention as buildAnchorMarker, so the two decals agree on which way is north.
  for (const yaw of [0, 90, -45]) {
    const decal = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, null, yaw), 'committed')
    const tick = toWorld(requireChild(decal, 'origin north'), new THREE.Vector3(0, 0, ANCHOR_RADIUS_M * 1.35))

    const reference = buildAnchorMarker(yaw)
    const referenceTick = toWorld(
      requireChild(reference, 'anchor north tick'),
      new THREE.Vector3(0, 0, ANCHOR_RADIUS_M * 1.35),
    )
    assert.ok(Math.abs(tick.x - referenceTick.x) < 1e-9, `yaw ${yaw}: tick.x ${tick.x} vs ${referenceTick.x}`)
    assert.ok(Math.abs(tick.z - referenceTick.z) < 1e-9, `yaw ${yaw}: tick.z ${tick.z} vs ${referenceTick.z}`)
  }

  // 0 degrees is north = +Z; 90 is east = +X.
  const north0 = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, null, 0), 'committed')
  const tickAt0 = toWorld(requireChild(north0, 'origin north'), new THREE.Vector3(0, 0, 1))
  assert.ok(tickAt0.z > 0 && Math.abs(tickAt0.x) < 1e-9)
  const north90 = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, null, 90), 'committed')
  const tickAt90 = toWorld(requireChild(north90, 'origin north'), new THREE.Vector3(0, 0, 1))
  assert.ok(tickAt90.x > 0 && Math.abs(tickAt90.z) < 1e-9)
})

test('buildOriginDecal: no compass fix means no north tick and a dimmed ring and crosshair', () => {
  const decal = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, null), 'committed')
  assert.equal(decal.getObjectByName('origin north'), undefined)
  assert.ok(decal.getObjectByName('origin heading'), 'the arrow is user-set, so it stays without a compass')
  assert.equal(requireChild(decal, 'origin ring') instanceof THREE.LineSegments, true)
  const ringOpacity = ((requireChild(decal, 'origin ring') as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity
  const armOpacity = ((requireChild(decal, 'origin heading arrow') as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity
  assert.ok(ringOpacity < 1, 'ring is dimmed without a compass')
  assert.equal(armOpacity, 1, 'the arrow is not dimmed')
})

test('buildOriginDecal: a compass fix leaves the ring at full opacity', () => {
  const decal = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, null, 0), 'committed')
  assert.ok(opacitiesOf(requireChild(decal, 'origin ring')).every((o) => o === 1))
  assert.ok(requireChild(decal, 'origin north') !== undefined)
})

test('buildOriginDecal: no heading point means no heading group at all', () => {
  const decal = buildOriginDecal(originDecalPlan({ x: 0, y: 0, z: 0 }, null, 10), 'committed')
  assert.equal(decal.getObjectByName('origin heading'), undefined)
})

test('buildOriginDecal: the stored origin takes its own name and recedes behind the committed one', () => {
  const plan: OriginDecalPlan = originDecalPlan({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.2 }, null)
  const stored = buildOriginDecal(plan, 'stored')
  const committed = buildOriginDecal(plan, 'committed')

  assert.equal(stored.name, STORED_ORIGIN_NAME)
  assert.equal(stored.name, 'calibration stored origin')
  assert.notEqual(stored.name, committed.name, 'a stored origin must never replace the committed one by name')
  assert.ok(opacitiesOf(stored).every((o) => o <= 0.5), 'stored geometry is at or below half opacity')
  assert.ok(opacitiesOf(committed).some((o) => o === 1), 'the committed arrow is at full opacity')
})

test('buildOriginDecal: each call gets its own materials, so dimming one cannot change another', () => {
  const plan = originDecalPlan({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0)
  const a = buildOriginDecal(plan, 'committed')
  const b = buildOriginDecal(plan, 'committed')
  const materialOf = (group: THREE.Object3D) =>
    (requireChild(group, 'origin ring') as THREE.LineSegments).material as THREE.LineBasicMaterial
  materialOf(a).opacity = 0.01
  assert.equal(materialOf(b).opacity, 1)
  assert.notEqual(materialOf(a), materialOf(b))
})

test('buildOriginDecal: a bare plan draws only the ring and crosshair', () => {
  const plan: OriginDecalPlan = { origin: { x: 0, y: 0, z: 0 }, headingDeg: null, arrowLengthM: 0, northYawDeg: null }
  assert.equal(buildOriginDecal(plan, 'committed').children.length, 2)
})

// ── originHeadingBearingDeg ────────────────────────────────────────────────

/** The smaller angle between two bearings in degrees, so 359 and 1 are 2 apart. */
function circularGapDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

// This test used to read "clockwise from the north tick" off `yawOf(arrowTip) - yawOf(northTip)`, with `yawOf` the
// `atan2(x, z)` of a tip's world position. That is the COUNTER-clockwise angle seen from above (a session yaw grows
// counter-clockwise), so it pinned the mirror image of the bearing and passed for as long as the formula had the mirror's
// sign: the HUD's frame heading read 360 minus the arrow's bearing. The angle is now read from a real camera above the
// floor (./origin_picture.ts), which knows nothing about yaws. The full set of checks, against the physical model and the
// record, is tests/unit/node/origin_heading_bearing.test.ts.
test('originHeadingBearingDeg: the arrow bearing is its clockwise angle from the north tick, as seen from above', () => {
  const origin = { x: 1, y: 0, z: -2 }
  const heading = { x: 4, y: 0, z: 2 }
  for (const northYawDeg of [0, 37, 180, 290]) {
    const plan = originDecalPlan(origin, heading, northYawDeg)
    const decal = buildOriginDecal(plan, 'committed')
    const clockwiseFromNorth = clockwiseFromTickToArrow(decal)
    const bearing = originHeadingBearingDeg(plan)
    assert.ok(bearing !== null, `north ${northYawDeg}: a compass fix gives a bearing`)
    // The comparison below is circular, so it cannot tell 323 from -37: the range is asserted beside it. (North at yaw 0
    // and the arrow at yaw 37 is a raw angle of -37, which is the case that needs the fold.)
    assert.ok(bearing >= 0 && bearing < 360, `north ${northYawDeg}: ${bearing} is a bearing, in [0, 360)`)
    assert.ok(
      circularGapDeg(bearing, clockwiseFromNorth) < 1e-6,
      `north ${northYawDeg}: bearing ${bearing} vs angle on the floor ${clockwiseFromNorth}`,
    )
  }
})

test('originHeadingBearingDeg: null without an arrow or a compass fix, and folded into [0, 360)', () => {
  const origin = { x: 0, y: 0, z: 0 }
  const ahead = { x: 0, y: 0, z: 2 }
  const east = { x: 2, y: 0, z: 0 }
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, null, 30)), null, 'no heading point, so no arrow')
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, null)), null, 'no compass fix, so no bearing')
  // North at yaw 90 (the tick toward +X) and the arrow along +Z. Seen from above with +X to the right, +Z points at the
  // viewer's bottom edge: the tick is at 3 o'clock and the arrow at 6, a quarter turn clockwise, so the bearing is 90. (It
  // was pinned at 270 here, the mirror image, "heading 0 minus north 90 folds to 270".)
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 90)), 90, 'north 90, arrow 0: a quarter turn clockwise of north')
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 270)), 270, 'north 270 (9 o\'clock), arrow 0 (6 o\'clock): three quarters of a turn clockwise')

  // THE FOLD. The two cases above have the arrow's yaw at or below north's, so the bearing `northYaw - heading` is not
  // negative in either and they never need it. These do, and their answers are read off the clock face, not out of the
  // formula. North at yaw 0 is the tick toward +Z, at 6 o'clock; the arrow along +X is at 3 o'clock. From 6 clockwise round to
  // 3 is nine hours, 270 degrees, though the difference of the two yaws is -90.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, east, 0)), 270, 'north 0, arrow 90: -90 folds to 270')
  // Not a quarter turn: the tick at yaw 10 and the arrow at yaw 47, which is 37 degrees further the counter-clockwise way, so
  // it is 323 clockwise. A plan written out, so that the numbers are exactly these.
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 47, arrowLengthM: 1, northYawDeg: 10 }), 323, 'north 10, arrow 47: -37 folds to 323')
  // An arrow on north reads 0, not 360 (the other seam).
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 40, arrowLengthM: 1, northYawDeg: 40 }), 0, 'on north')

  // The old rule (`?bearing=1`) reads the arrow's yaw from north's, so its negative case is the other way round. This is the
  // assertion this test held before the rule was corrected, and then the only pin there was on the fold: heading 0 minus
  // north 90 folds to 270.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 90), LEGACY_BEARING_CONVENTION), 270, 'old rule: heading 0 minus north 90 folds to 270')
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 10, arrowLengthM: 1, northYawDeg: 350 }, LEGACY_BEARING_CONVENTION), 20, 'old rule: heading 10 minus north 350 folds to 20')
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 40, arrowLengthM: 1, northYawDeg: 40 }, LEGACY_BEARING_CONVENTION), 0, 'old rule, on north')
})
