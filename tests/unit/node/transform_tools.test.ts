/**
 * The World Editor's repair arithmetic (src/viewer/transform-tools.ts): turning a scan about a point
 * you can see, nudging, snapping, resetting to the placement it arrived with, and the scale lock.
 *
 * Every composition is checked against three.js's own Matrix4, so a sign or an order that is wrong
 * in both the code and a hand-written expectation cannot pass. The calibrated matrices are the real
 * ones from src/world/geo.ts (twoPointToProjectTransform), with the landmark and heading marker the
 * alignment investigation used (scratchpad/pivot_check.mjs: a landmark 2 m right and 1 m ahead of
 * where the session started, the marker 3 m beyond it, the device turned 37 degrees).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/transform_tools.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { composeYUpTransform, twoPointToProjectTransform, transformPoint } from '../../../src/world/geo.ts'
import { sessionAnchorPositions } from '../../../src/world/anchor-placement.ts'
import { checkPlacementMatrix, normaliseZeros, placementTransform } from '../../../src/world/scan-placement.ts'
import {
  NUDGE_COARSE_DEG,
  NUDGE_COARSE_M,
  NUDGE_FINE_DEG,
  NUDGE_FINE_M,
  aboutPoint,
  centroidOf,
  choosePivot,
  composePose,
  describeOffset,
  fixSize,
  holdScale,
  isProjectCalibrated,
  matricesClose,
  moveToOffset,
  multiply,
  nudge,
  offsetBetween,
  pivotWorld,
  plainServerError,
  resetLabel,
  resetMatrix,
  resetPatchTransform,
  rootFromProxy,
  rotateAbout,
  scaleOf,
  snapSteps,
  snappedPosition,
  snapTo,
  translateBy,
  wrapDegrees,
  yawMatrix,
  yawOf,
  type Matrix16,
  type ProxyPose,
} from '../../../src/viewer/transform-tools.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const EPS = 1e-12

/** A small seeded generator, so a failure is the same failure on every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function assertMatrixNear(actual: readonly number[], expected: readonly number[], eps: number, label: string): void {
  assert.equal(actual.length, 16, `${label}: sixteen numbers`)
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(actual[i]! - expected[i]!) <= eps, `${label}: entry ${i} is ${actual[i]}, wanted ${expected[i]}`)
  }
}

const toThree = (m: readonly number[]): THREE.Matrix4 => new THREE.Matrix4().fromArray([...m])

/** The calibrated placement of the investigation's scene, and the landmark in the session's own coordinates. */
function calibratedScene(yawDeg = 37): { calibrated: Matrix16; landmark: Vec3; marker: Vec3 } {
  const turn = (yawDeg * Math.PI) / 180
  const rotate = (p: Vec3): Vec3 => ({
    x: p.x * Math.cos(turn) + p.z * Math.sin(turn),
    y: p.y,
    z: -p.x * Math.sin(turn) + p.z * Math.cos(turn),
  })
  const landmark = rotate({ x: 2, y: 0, z: 1 })
  const marker = rotate({ x: 2, y: 0, z: 4 })
  return { calibrated: twoPointToProjectTransform(landmark, marker), landmark, marker }
}

// ─── Turning about a point ───────────────────────────────────────────────────

test('rotating by theta about P is translate-rotate-translate, for any pivot, angle and starting placement', () => {
  const next = rng(16)
  for (let trial = 0; trial < 200; trial++) {
    const start = composeYUpTransform(
      { x: (next() - 0.5) * 40, y: (next() - 0.5) * 4, z: (next() - 0.5) * 40 },
      next() * 360 - 180,
    )
    const pivot = { x: (next() - 0.5) * 30, y: (next() - 0.5) * 3, z: (next() - 0.5) * 30 }
    const theta = (next() - 0.5) * 360

    const turned = rotateAbout(start, pivot, theta)

    const t = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    const r = new THREE.Matrix4().makeRotationY((theta * Math.PI) / 180)
    const back = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)
    const expected = t.multiply(r).multiply(back).multiply(toThree(start))
    assertMatrixNear(turned, expected.toArray(), EPS, `trial ${trial}`)
  }
})

test('aboutPoint keeps its pivot exactly where it is, not within a rounding step', () => {
  const pivot = { x: 3.7, y: 0.25, z: -11.3 }
  for (const deg of [0.5, 2, 3, 47, 90, 179.5, -33]) {
    const turn = aboutPoint(pivot, yawMatrix(deg))
    const moved = transformPoint(turn, pivot)
    assert.ok(distance(moved, pivot) <= 1e-14, `${deg} degrees moved the pivot by ${distance(moved, pivot)}`)
  }
})

test('turning a scan about its landmark leaves the landmark where it was, so a 3 degree fix is one action, not two', () => {
  const { calibrated, landmark } = calibratedScene()
  const landmarkWorldBefore = pivotWorld(calibrated, landmark)
  // The calibration sends the tapped landmark to the Place's zero. Everything below rests on that.
  assert.ok(distance(landmarkWorldBefore, { x: 0, y: 0, z: 0 }) < 1e-12)

  const aboutLandmark = rotateAbout(calibrated, landmarkWorldBefore, 3)
  assert.ok(distance(pivotWorld(aboutLandmark, landmark), landmarkWorldBefore) < 1e-12, 'the landmark did not move')

  // The old gizmo turned the root about its own origin: where the AR session started.
  const rootOrigin = { x: calibrated[12]!, y: calibrated[13]!, z: calibrated[14]! }
  const aboutRoot = rotateAbout(calibrated, rootOrigin, 3)
  const swing = distance(pivotWorld(aboutRoot, landmark), landmarkWorldBefore)
  // The landmark is |(2, 1)| = 2.24 m from the session origin, so 3 degrees swings it 2 * 2.24 * sin(1.5 deg) = 11.7 cm.
  assert.ok(swing > 0.11 && swing < 0.125, `turning about the session origin swung the landmark ${swing} m`)
})

test('the landmark pivot is the calibration inverse applied to the origin, and it is the same after a move', () => {
  const { calibrated, landmark } = calibratedScene()
  const scan = { calibratedLocalToWorld: calibrated, calibrationStatus: 'provisional' as const, calibrationMethod: 'two-point-ground' as const }
  const pivot = choosePivot(scan, { x: 9, y: 9, z: 9 })
  assert.equal(pivot.kind, 'landmark')
  assert.ok(distance(pivot.local, landmark) < 1e-12, 'the pivot is the point the user tapped, in session coordinates')
  assert.ok(distance(pivot.local, sessionAnchorPositions(calibrated).landmark) === 0, 'it is the existing inverse, not a second one')

  // Move and turn the scan: the pivot is a fixed point of the scan's own coordinates, so it rides along.
  const moved = rotateAbout(translateBy(calibrated, { x: 1.5, y: 0, z: -0.4 }), { x: 0.3, y: 0, z: 0.2 }, 12)
  assert.ok(distance(pivotWorld(moved, pivot.local), { x: 0, y: 0, z: 0 }) > 0.5, 'the scan has moved the landmark')
  const turnedAgain = rotateAbout(moved, pivotWorld(moved, pivot.local), -4)
  assert.ok(distance(pivotWorld(turnedAgain, pivot.local), pivotWorld(moved, pivot.local)) < 1e-12)
})

test('the pivot proxy drives the root: a proxy turned 3 degrees turns the scan 3 degrees about the proxy', () => {
  const { calibrated, landmark } = calibratedScene()
  const standing = pivotWorld(calibrated, landmark)
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (3 * Math.PI) / 180)
  const root = rootFromProxy({
    rootStart: calibrated,
    proxyStart: { position: standing, quaternion: [0, 0, 0, 1] },
    proxyNow: { position: standing, quaternion: [turn.x, turn.y, turn.z, turn.w] },
  })
  assertMatrixNear(root, rotateAbout(calibrated, standing, 3), 1e-12, 'a proxy turn is a turn about the pivot')
  assert.ok(distance(pivotWorld(root, landmark), standing) < 1e-12)
})

test('dragging the proxy moves the scan by the same vector, whatever turn the proxy already carried', () => {
  const { calibrated } = calibratedScene()
  const standing = { x: 0.4, y: 0, z: -0.2 }
  const carried = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  const start: ProxyPose = { position: standing, quaternion: [carried.x, carried.y, carried.z, carried.w] }
  const now: ProxyPose = { position: { x: 0.4 + 0.12, y: 0.03, z: -0.2 - 0.5 }, quaternion: start.quaternion }
  const root = rootFromProxy({ rootStart: calibrated, proxyStart: start, proxyNow: now })
  assertMatrixNear(root, translateBy(calibrated, { x: 0.12, y: 0.03, z: -0.5 }), 1e-12, 'drag')
})

// ─── Nudges and snapping ─────────────────────────────────────────────────────

test('the nudge steps are 1 and 5 cm and 0.5 and 2 degrees, and the snap modes use the same steps', () => {
  assert.deepEqual([NUDGE_FINE_M, NUDGE_COARSE_M, NUDGE_FINE_DEG, NUDGE_COARSE_DEG], [0.01, 0.05, 0.5, 2])
  assert.deepEqual(snapSteps('off'), { translateM: null, yawDeg: null })
  assert.deepEqual(snapSteps('fine'), { translateM: 0.01, yawDeg: 0.5 })
  assert.deepEqual(snapSteps('coarse'), { translateM: 0.05, yawDeg: 2 })
})

test('a nudge moves the pivot by exactly the step along one axis, or turns the scan about the pivot', () => {
  const { calibrated, landmark } = calibratedScene()
  const before = pivotWorld(calibrated, landmark)
  for (const [axis, step] of [['x', 0.01], ['x', -0.05], ['y', 0.01], ['z', -0.01], ['z', 0.05]] as const) {
    const after = pivotWorld(nudge(calibrated, landmark, axis, step), landmark)
    const want = { x: before.x + (axis === 'x' ? step : 0), y: before.y + (axis === 'y' ? step : 0), z: before.z + (axis === 'z' ? step : 0) }
    assert.ok(distance(after, want) < 1e-12, `${axis} ${step}`)
  }
  for (const step of [0.5, -0.5, 2, -2]) {
    const turned = nudge(calibrated, landmark, 'yaw', step)
    assert.ok(distance(pivotWorld(turned, landmark), before) < 1e-12, 'the pivot stays')
    const offset = offsetBetween(calibrated, turned, landmark)
    assert.ok(Math.abs(offset.yawDeg - step) < 1e-9, `the turn reads ${offset.yawDeg}, not ${step}`)
  }
})

test('five 1 cm nudges are one 5 cm nudge, and a +2 turn then a -2 turn is no turn at all', () => {
  const { calibrated, landmark } = calibratedScene()
  let stepped = calibrated
  for (let i = 0; i < 5; i++) stepped = nudge(stepped, landmark, 'x', NUDGE_FINE_M)
  assertMatrixNear(stepped, nudge(calibrated, landmark, 'x', NUDGE_COARSE_M), 1e-14, 'x')
  const there = nudge(calibrated, landmark, 'yaw', NUDGE_COARSE_DEG)
  assertMatrixNear(nudge(there, landmark, 'yaw', -NUDGE_COARSE_DEG), calibrated, 1e-12, 'yaw')
})

test('snapping rounds to the nearest step the same way on both sides of zero, and a bad step leaves the value alone', () => {
  const table: Array<[number, number, number]> = [
    [0.0137, 0.01, 0.01], [0.0151, 0.01, 0.02], [-0.0137, 0.01, -0.01], [-0.0151, 0.01, -0.02],
    [0.004, 0.01, 0], [-0.004, 0.01, 0], [0.12, 0.05, 0.1], [0.13, 0.05, 0.15],
    [2.3, 0.5, 2.5], [2.2, 0.5, 2], [-2.3, 0.5, -2.5], [1.25, 0.5, 1.5], [-1.25, 0.5, -1.5],
    [3.1, 2, 4], [0.9, 2, 0],
  ]
  for (const [value, step, want] of table) assert.equal(snapTo(value, step), want, `${value} to ${step}`)
  assert.equal(Object.is(snapTo(-0.004, 0.01), 0), true, 'no minus zero')
  // 3 steps of 0.1 is 0.30000000000000004 in floating point; a snapped value is the clean one.
  assert.equal(snapTo(0.31, 0.1), 0.3)
  for (const bad of [null, 0, -0.01, Number.NaN]) assert.equal(snapTo(0.0137, bad), 0.0137)
  assert.ok(Number.isNaN(snapTo(Number.NaN, 0.01)))
})

test('a snapped drag is measured from where the drag began, so the first small move does not jump to a grid', () => {
  const { calibrated } = calibratedScene()
  // The proxy starts 3 mm and 7 mm off the 1 cm grid.
  const start: ProxyPose = { position: { x: 0.003, y: 0, z: 0.007 }, quaternion: [0, 0, 0, 1] }
  const drag = (dx: number, dz: number): Matrix16 => rootFromProxy({
    rootStart: calibrated,
    proxyStart: start,
    proxyNow: { position: { x: start.position.x + dx, y: 0, z: start.position.z + dz }, quaternion: [0, 0, 0, 1] },
    snapTranslateM: NUDGE_FINE_M,
  })
  assertMatrixNear(drag(0.001, -0.002), calibrated, 0, 'a move under half a step is no move: the root has not jumped')
  assertMatrixNear(drag(0.0137, -0.0262), translateBy(calibrated, { x: 0.01, y: 0, z: -0.03 }), 1e-14, 'snapped to whole steps of the drag')
  assertMatrixNear(
    rootFromProxy({ rootStart: calibrated, proxyStart: start, proxyNow: { position: { x: 0.0171, y: 0, z: 0.0021 }, quaternion: [0, 0, 0, 1] } }),
    translateBy(calibrated, { x: 0.0141, y: 0, z: -0.0049 }),
    1e-14,
    'no snap: the drag as it is',
  )
})

test('a snapped drag rounds every axis, the height included, each on its own', () => {
  const start = { x: 0.003, y: 0.002, z: 0.007 }
  const now = { x: start.x + 0.0137, y: start.y + 0.0262, z: start.z - 0.0151 }
  const snapped = snappedPosition(start, now, NUDGE_FINE_M)
  assert.ok(Math.abs(snapped.x - (start.x + 0.01)) < 1e-15, 'x')
  assert.ok(Math.abs(snapped.y - (start.y + 0.03)) < 1e-15, 'height')
  assert.ok(Math.abs(snapped.z - (start.z - 0.02)) < 1e-15, 'z')
  assert.deepEqual(snappedPosition(start, now, null), now, 'with no step the drag is left as it is, not recomputed')
  assert.equal(snappedPosition(start, now, null), now)
})

test('a tilt is kept in the matrix but is not read as a turn, however the scan was already turned', () => {
  const { calibrated, landmark } = calibratedScene()
  const tiltedByGizmo = multiply(new THREE.Matrix4().makeRotationX(0.17).toArray(), calibrated)
  const read = offsetBetween(calibrated, tiltedByGizmo, landmark)
  assert.ok(Math.abs(read.yawDeg) < 1e-9, `a tilt about the X axis reads as a turn of ${read.yawDeg}`)
  // The turn that comes with it is read as the turn it is: 10 degrees on top of a tilt.
  const both = rotateAbout(tiltedByGizmo, pivotWorld(tiltedByGizmo, landmark), 10)
  assert.ok(Math.abs(offsetBetween(calibrated, both, landmark).yawDeg - 10) < 1e-9)
})

test('typing an offset lands exactly on it, and keeps any tilt the matrix had', () => {
  const { calibrated, landmark } = calibratedScene()
  const tilted = multiply(calibrated, toThree([...new THREE.Matrix4().makeRotationX(0.05).toArray()]).toArray())
  for (const base of [calibrated, tilted]) {
    for (const target of [
      { dx: 0.12, dy: -0.03, dz: 0.4, yawDeg: 3 },
      { dx: -2, dy: 0, dz: 0, yawDeg: -0.5 },
      { dx: 0, dy: 0, dz: 0, yawDeg: 0 },
      { dx: 0.0001, dy: 0.0002, dz: -0.0003, yawDeg: 179 },
    ]) {
      const moved = moveToOffset(base, base, landmark, target)
      const read = offsetBetween(base, moved, landmark)
      assert.ok(Math.abs(read.dx - target.dx) < 1e-9 && Math.abs(read.dy - target.dy) < 1e-9 && Math.abs(read.dz - target.dz) < 1e-9, JSON.stringify(read))
      assert.ok(Math.abs(wrapDegrees(read.yawDeg - target.yawDeg)) < 1e-9, `${read.yawDeg} vs ${target.yawDeg}`)
      // Neither a turn about the vertical nor a shift tilts the scan any more or less than it was tilted.
      const worldUp = new THREE.Vector3(0, 1, 0)
      const upBefore = worldUp.clone().transformDirection(toThree(base))
      const upAfter = worldUp.clone().transformDirection(toThree(moved))
      assert.ok(Math.abs(upBefore.angleTo(worldUp) - upAfter.angleTo(worldUp)) < 1e-12)
    }
  }
})

test('the offset readout is zero for an unmoved scan and is read at the pivot, not at the session origin', () => {
  const { calibrated, landmark } = calibratedScene()
  const none = offsetBetween(calibrated, calibrated, landmark)
  assert.deepEqual(describeOffset(none), { xCm: 0, yCm: 0, zCm: 0, yawDeg: 0 })
  // Turned 10 degrees about the landmark, the landmark has not moved: the readout says "turned 10, shifted 0".
  const turned = rotateAbout(calibrated, pivotWorld(calibrated, landmark), 10)
  const read = describeOffset(offsetBetween(calibrated, turned, landmark))
  assert.deepEqual(read, { xCm: 0, yCm: 0, zCm: 0, yawDeg: 10 })
  // Read at the session origin instead, the same move looks like a shift of metres.
  assert.ok(distance(pivotWorld(turned, { x: 0, y: 0, z: 0 }), pivotWorld(calibrated, { x: 0, y: 0, z: 0 })) > 0.3)
})

// ─── Reset to the placement it arrived with ──────────────────────────────────

test('reset hands back the stored matrix bit for bit, as a copy, even for awkward numbers', () => {
  const { calibrated } = calibratedScene()
  const awkward = [...calibrated]
  awkward[12] = 1 / 3
  awkward[13] = 1e-17
  awkward[14] = -123456.78901234567
  for (const stored of [calibrated, awkward]) {
    const copy = resetMatrix(stored)
    assert.ok(copy, 'a valid placement resets')
    assert.notEqual(copy, stored, 'a copy, so editing it cannot edit the stored one')
    for (let i = 0; i < 16; i++) assert.equal(Object.is(copy![i], stored[i]), true, `entry ${i} is the same bits`)
  }
})

test('the reset patch carries the stored matrix untouched, and the JSON the server stores reads back to the same bits', () => {
  const { calibrated } = calibratedScene()
  const stored = normaliseZeros(calibrated)
  const transform = resetPatchTransform(stored)!
  for (let i = 0; i < 16; i++) assert.equal(Object.is(transform.matrix![i], stored[i]), true, `entry ${i}`)
  const wire = JSON.parse(JSON.stringify({ transform })) as { transform: { matrix: number[] } }
  for (let i = 0; i < 16; i++) assert.equal(Object.is(wire.transform.matrix[i], stored[i]), true, `entry ${i} after JSON`)
  assert.equal(JSON.stringify(wire.transform.matrix), JSON.stringify(stored))
})

test('a stored placement that is not valid does not reset: there is nothing safe to put back', () => {
  const { calibrated } = calibratedScene()
  const short = calibrated.slice(0, 15)
  const nan = [...calibrated]
  nan[3] = Number.NaN
  const skewed = [...calibrated]
  skewed[4] += 0.01
  const huge = holdScale(calibrated, 3)
  for (const bad of [undefined, null, 'x', short, nan, skewed, huge]) assert.equal(resetMatrix(bad), null)
  assert.equal(resetPatchTransform(short), null)
})

test('the readable parts of a patch (position, rotation, scale) are what three.js decomposes the matrix into', () => {
  const next = rng(7)
  const spins = [0, 90, 180, 270, 359, 45, 135, 225]
  for (let i = 0; i < 120; i++) {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize(),
      i < spins.length ? (spins[i]! * Math.PI) / 180 : next() * Math.PI * 2,
    )
    const scale = 0.5 + next() * 1.5
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(next() * 10, next() * 3, next() * -10),
      q,
      new THREE.Vector3(scale, scale, scale),
    )
    const mine = placementTransform(matrix.toArray())
    const position = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const size = new THREE.Vector3()
    matrix.decompose(position, rotation, size)
    assert.ok(distance(mine.position!, position) < 1e-12)
    assert.ok(Math.abs(mine.scale!.x - size.x) < 1e-12 && Math.abs(mine.scale!.y - size.y) < 1e-12 && Math.abs(mine.scale!.z - size.z) < 1e-12)
    const mineQuaternion = new THREE.Quaternion(mine.rotation!.x, mine.rotation!.y, mine.rotation!.z, mine.rotation!.w)
    assert.ok(Math.abs(Math.abs(mineQuaternion.dot(rotation)) - 1) < 1e-12, `rotation ${i}`)
  }
})

test('composePose is three.js compose for a unit pose', () => {
  const next = rng(3)
  for (let i = 0; i < 50; i++) {
    const q = new THREE.Quaternion(next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5).normalize()
    const p = { x: next() * 9, y: next() * 9, z: next() * 9 }
    const expected = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1))
    assertMatrixNear(composePose({ position: p, quaternion: [q.x, q.y, q.z, q.w] }), expected.toArray(), 1e-15, `pose ${i}`)
  }
})

// ─── The scale lock and Fix size ─────────────────────────────────────────────

test('the scale lock: a proxy pose that is not a pure turn cannot change the scan size', () => {
  const { calibrated, landmark } = calibratedScene()
  const standing = pivotWorld(calibrated, landmark)
  // (0, 0.5, 0, 0.5) is not a unit quaternion, so composing it as a rotation scales the axes by 0.7071.
  const stretched: ProxyPose = { position: standing, quaternion: [0, 0.5, 0, 0.5] }
  assert.ok(Math.abs(scaleOf(composePose(stretched)) - 1) > 0.1, 'the stand-in really does carry a size change')
  const root = rootFromProxy({ rootStart: calibrated, proxyStart: { position: standing, quaternion: [0, 0, 0, 1] }, proxyNow: stretched })
  assert.equal(Math.abs(scaleOf(root) - 1) <= 1e-15, true, `the scan size is ${scaleOf(root)}`)
  assert.equal(checkPlacementMatrix(root).ok, true)
})

test('the scale lock holds a scan at the size it had, whether that is 1 or something Fix size gave it earlier', () => {
  const { calibrated, landmark } = calibratedScene()
  const next = rng(11)
  for (const size of [1, 0.8, 1.35]) {
    let matrix = size === 1 ? calibrated : holdScale(calibrated, size)
    for (let i = 0; i < 300; i++) {
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (next() - 0.5) * 0.2)
      const here = pivotWorld(matrix, landmark)
      matrix = rootFromProxy({
        rootStart: matrix,
        proxyStart: { position: here, quaternion: [0, 0, 0, 1] },
        proxyNow: { position: { x: here.x + (next() - 0.5) * 0.1, y: here.y, z: here.z + (next() - 0.5) * 0.1 }, quaternion: [turn.x, turn.y, turn.z, turn.w] },
      })
      matrix = nudge(matrix, landmark, 'yaw', (next() - 0.5) * 4)
    }
    assert.ok(Math.abs(scaleOf(matrix) - size) <= 1e-12, `size ${size} drifted to ${scaleOf(matrix)}`)
  }
})

test('a size a nanometre from 1 is held at exactly 1, and a size that is really different is held as it is', () => {
  const { calibrated, landmark } = calibratedScene()
  const standing = pivotWorld(calibrated, landmark)
  const move = (rootStart: Matrix16): Matrix16 => rootFromProxy({
    rootStart,
    proxyStart: { position: standing, quaternion: [0, 0, 0, 1] },
    proxyNow: { position: { x: standing.x + 0.2, y: standing.y, z: standing.z }, quaternion: [0, 0, 0, 1] },
  })
  const nearly = holdScale(calibrated, 1 + 1e-10)
  assert.equal(scaleOf(move(nearly)), 1, 'rounding left on a calibrated scan does not carry from move to move')
  for (const size of [1.0005, 0.9995, 1.001]) {
    const sized = holdScale(calibrated, size)
    assert.ok(Math.abs(scaleOf(move(sized)) - size) <= 1e-12, `a size of ${size} is a size, not a rounding error: ${scaleOf(move(sized))}`)
  }
})

test('a scan\'s size is the mean of its three axes, each of them', () => {
  assert.equal(scaleOf([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 5, 6, 7, 1]), 2)
  assert.equal(scaleOf([1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 2)
  assert.equal(scaleOf([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 7, 0, 0, 0, 0, 1]), 3)
  assert.equal(scaleOf([0.6, 0.8, 0, 0, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 0, 1]), 2, 'an axis is its length, not its first entry')
})

test('what the Edit panel shows never has a minus sign on a zero', () => {
  const read = describeOffset({ dx: -1e-9, dy: -0, dz: -0.00001, yawDeg: -1e-7 })
  for (const key of ['xCm', 'yCm', 'zCm', 'yawDeg'] as const) assert.ok(Object.is(read[key], 0), `${key} is ${Object.is(read[key], -0) ? '-0' : read[key]}`)
  assert.deepEqual(describeOffset({ dx: -0.0123, dy: 0.0456, dz: 0.00004, yawDeg: -2.3456 }), { xCm: -1.2, yCm: 4.6, zCm: 0, yawDeg: -2.35 })
})

test('Fix size resizes about the pivot, inside the range the server enforces, and says why when it will not', () => {
  const { calibrated, landmark } = calibratedScene()
  const standing = pivotWorld(calibrated, landmark)
  const bigger = fixSize(calibrated, standing, 1.2)
  assert.equal(bigger.ok, true)
  if (bigger.ok) {
    assert.ok(Math.abs(scaleOf(bigger.matrix) - 1.2) <= 1e-15)
    assert.ok(distance(pivotWorld(bigger.matrix, landmark), standing) < 1e-12, 'the pivot stays')
    assert.equal(checkPlacementMatrix(bigger.matrix).ok, true, 'the server would accept it')
  }
  const smaller = fixSize(calibrated, standing, 0.5)
  assert.equal(smaller.ok, true)
  assert.equal(fixSize(calibrated, standing, 2).ok, true)
  for (const wanted of [0.49, 2.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const refused = fixSize(calibrated, standing, wanted)
    assert.equal(refused.ok, false, String(wanted))
    if (!refused.ok) assert.match(refused.message, /between 0\.5 and 2 times/)
  }
  const there = fixSize(calibrated, standing, 1.2)
  if (there.ok) {
    const back = fixSize(there.matrix, standing, 1)
    assert.ok(back.ok && matricesClose(back.matrix, calibrated, 1e-12), 'one size back to the other')
  }
})

test('round-off stays far inside the placement tolerance after thousands of gizmo moves and saves', () => {
  // The measurement behind PLACEMENT_TOLERANCE: what the editor does to a matrix, many times over.
  const next = rng(2026)
  const { calibrated, landmark } = calibratedScene()
  let matrix: Matrix16 = calibrated
  let worst = 0
  for (let i = 0; i < 5000; i++) {
    const here = pivotWorld(matrix, landmark)
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (next() - 0.5) * 0.3)
    matrix = rootFromProxy({
      rootStart: matrix,
      proxyStart: { position: here, quaternion: [0, 0, 0, 1] },
      proxyNow: { position: { x: here.x + (next() - 0.5) * 0.2, y: here.y, z: here.z + (next() - 0.5) * 0.2 }, quaternion: [turn.x, turn.y, turn.z, turn.w] },
    })
    // What saving and reloading does: the viewer decomposes the matrix onto the root and recomposes it for the patch.
    const position = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const size = new THREE.Vector3()
    toThree(matrix).decompose(position, rotation, size)
    matrix = new THREE.Matrix4().compose(position, rotation, size).toArray()
    const rows = [matrix.slice(0, 3), matrix.slice(4, 7), matrix.slice(8, 11)]
    for (let a = 0; a < 3; a++) {
      worst = Math.max(worst, Math.abs(Math.hypot(...(rows[a] as [number, number, number])) - 1))
      for (let b = a + 1; b < 3; b++) {
        const [ra, rb] = [rows[a]!, rows[b]!]
        worst = Math.max(worst, Math.abs(ra[0]! * rb[0]! + ra[1]! * rb[1]! + ra[2]! * rb[2]!))
      }
    }
  }
  assert.ok(worst < 1e-12, `worst round-off ${worst}`)
  assert.equal(checkPlacementMatrix(matrix).ok, true, 'and the matrix still saves')
})

// ─── The pivot a scan gets ───────────────────────────────────────────────────

test('the pivot is the landmark for a calibrated scan, the middle of its points for others, and the old origin as a last resort', () => {
  const { calibrated, landmark } = calibratedScene()
  const centroid = { x: 4, y: 1, z: -2 }
  const calibratedScan = { calibratedLocalToWorld: calibrated, calibrationStatus: 'verified' as const, calibrationMethod: 'two-point-ground' as const }
  assert.equal(isProjectCalibrated(calibratedScan), true)
  assert.deepEqual(choosePivot(calibratedScan, centroid).kind, 'landmark')
  assert.equal(resetLabel(calibratedScan), 'Reset to calibrated')

  const oneTap = { ...calibratedScan, calibrationMethod: 'ground-tap-compass' as const, calibrationStatus: 'provisional' as const }
  assert.equal(choosePivot(oneTap, centroid).kind, 'landmark')

  const gps = { calibratedLocalToWorld: calibrated, calibrationStatus: 'uncalibrated' as const }
  assert.equal(isProjectCalibrated(gps), false)
  assert.deepEqual(choosePivot(gps, centroid), { kind: 'centroid', local: centroid })
  assert.equal(resetLabel(gps), 'Reset to first placement')
  assert.deepEqual(choosePivot(gps, null), { kind: 'origin', local: { x: 0, y: 0, z: 0 } })
  assert.deepEqual(choosePivot({}, centroid), { kind: 'centroid', local: centroid })

  // A size is not a landmark, and an upload whose transform was refused sits by GPS, whatever its record claims.
  const knownDistance = { ...calibratedScan, calibrationMethod: 'known-distance' as const }
  assert.equal(choosePivot(knownDistance, centroid).kind, 'centroid')
  const refused = { ...calibratedScan, projectTransformRejected: 'The scan would be skewed.' }
  assert.equal(choosePivot(refused, centroid).kind, 'centroid')
  assert.equal(resetLabel(refused), 'Reset to first placement')
  // A calibrated placement that is not a valid matrix gives no landmark to stand on.
  assert.equal(choosePivot({ ...calibratedScan, calibratedLocalToWorld: calibrated.slice(0, 12) }, centroid).kind, 'centroid')
  assert.ok(distance(choosePivot(calibratedScan, centroid).local, landmark) < 1e-12)
})

test('the middle of a point cloud is its mean, from a bounded number of points, skipping any that are not numbers', () => {
  assert.equal(centroidOf([]), null)
  assert.equal(centroidOf([Number.NaN, 1, 2]), null)
  assert.deepEqual(centroidOf([0, 0, 0, 2, 4, 6]), { x: 1, y: 2, z: 3 })
  assert.deepEqual(centroidOf([0, 0, 0, Number.NaN, 1, 1, 4, 4, 4]), { x: 2, y: 2, z: 2 })

  // A million points on a plane, asked for at most 1000: it reads about 1000 of them and is still on the plane's mean.
  const count = 1_000_000
  const cloud = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    cloud[i * 3] = (i % 1000) / 100
    cloud[i * 3 + 1] = 1.5
    cloud[i * 3 + 2] = Math.floor(i / 1000) / 100
  }
  const mean = centroidOf(cloud, 1000)!
  assert.ok(Math.abs(mean.y - 1.5) < 1e-6)
  assert.ok(Math.abs(mean.x - 5) < 0.2 && Math.abs(mean.z - 5) < 0.2, `${mean.x}, ${mean.z}`)
})

test('matricesClose says whether two placements are the same to a nanometre, and rejects anything not 16 long', () => {
  const { calibrated } = calibratedScene()
  assert.equal(matricesClose(calibrated, [...calibrated]), true)
  assert.equal(matricesClose(calibrated, translateBy(calibrated, { x: 1e-10, y: 0, z: 0 })), true)
  assert.equal(matricesClose(calibrated, translateBy(calibrated, { x: 1e-6, y: 0, z: 0 })), false)
  assert.equal(matricesClose(calibrated, calibrated.slice(0, 15)), false)
  const withNaN = [...calibrated]
  withNaN[12] = Number.NaN
  assert.equal(matricesClose(calibrated, withNaN), false)
  assert.ok(Math.abs(yawOf(yawMatrix(37)) - 37) < 1e-12)
  assert.equal(wrapDegrees(190), -170)
  assert.equal(wrapDegrees(-180), 180)
})

test('a failed request is read back as the server\'s own sentence, and anything without one gets the fallback', () => {
  const refused = new Error('409 ' + JSON.stringify({ error: 'This scan was changed after you opened it. Reload the Place and try again.' }))
  assert.equal(plainServerError(refused, 'fallback'), 'This scan was changed after you opened it. Reload the Place and try again.')
  assert.equal(plainServerError(new Error('400 ' + JSON.stringify({ error: 'The scan would be "skewed".' })), 'fallback'), 'The scan would be "skewed".', 'escapes are read')
  assert.equal(plainServerError(new TypeError('Failed to fetch'), 'Could not undo.'), 'Could not undo.')
  assert.equal(plainServerError(new Error('503: no Scan server answered'), 'x'), 'x')
  assert.equal(plainServerError(new Error('400 ' + JSON.stringify({ error: '' })), 'x'), 'x')
  assert.equal(plainServerError('boom', 'x'), 'x')
  assert.equal(plainServerError(undefined, 'x'), 'x')
})
