/**
 * WP-07, the pure part: where a marker lands in a reference photo, and the rings that mark the stored points on a
 * return visit.
 *
 * Covers `projectMarkerIntoPhoto()` and `ringRadiiFromStoredPoints()` in src/ar/reference-photo.ts. Nothing here
 * touches an AR runtime or the calibration flow: they are the arithmetic the flow will call once it is wired.
 *
 * The projection is checked three ways, none of which shares code with it:
 *
 *   1. Numbers worked out by hand from the pinhole: a pixel is `focal * tan(angle)` from the centre, with
 *      `focal = (height / 2) / tan(fovY / 2)`, and the cases are built so the answer is a turn of the phone or a
 *      step to the side.
 *   2. three.js's own `Vector3.project()` on a PerspectiveCamera built the way src/main.ts builds a capture camera,
 *      over four hundred random poses and markers, nulls included.
 *   3. `floorRayPoint()` (src/ar/ground-gate.ts), which maps a pixel the other way, to the floor: the marker a tap
 *      places, projected back through the pose the tap was read at, is the tap.
 *
 * What a null means is pinned against the frame's own pinhole: a marker in the margin a cover-cropped canvas never
 * showed is null here, though the stored photo has it, and the numbers for that come from the photo's focal length
 * and not from the code under test.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/reference_photo_projection.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  projectMarkerIntoPhoto,
  ringRadiiFromStoredPoints,
  tapPointWithinPhoto,
} from '../../../src/ar/reference-photo.ts'
import { floorRayPoint } from '../../../src/ar/ground-gate.ts'
import { twoPointSeparationM } from '../../../src/world/geo.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A phone held upright: 360 x 640 CSS pixels, so `aspect` is exactly 0.5625. */
const VIEW = { width: 360, height: 640 }
const ASPECT = VIEW.width / VIEW.height
const FOV_Y = 60
const DEG = Math.PI / 180
/** The pinhole's focal length in pixels: half the view's height over the tangent of half the vertical field of view. */
const FOCAL_PX = VIEW.height / 2 / Math.tan((FOV_Y / 2) * DEG)

const EYE = { x: 0, y: 1.4, z: 0 }

/** mulberry32: a seeded generator, so every number below is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pitch (negative looks down) and yaw (positive turns left, as a rotation about +Y does), degrees. */
function poseFrom(position: Vec3, pitchDeg: number, yawDeg: number, rollDeg = 0): Pose {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ'))
  return { position, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

function near(actual: number, expected: number, tolerance = 1e-9, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not ${expected} (within ${tolerance})`)
}

function project(marker: Vec3, pose: Pose, fovY = FOV_Y, aspect = ASPECT) {
  return projectMarkerIntoPhoto(marker, pose, fovY, aspect)
}

/** The camera src/main.ts builds for a capture, and three.js's own answer for where a marker falls in it. */
function threeView(marker: Vec3, pose: Pose, fovY: number, aspect: number): { u: number; v: number } | null {
  const camera = new THREE.PerspectiveCamera(fovY, aspect, 0.01, 1000)
  camera.position.set(pose.position.x, pose.position.y, pose.position.z)
  camera.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
  camera.updateMatrixWorld(true)
  const world = new THREE.Vector3(marker.x, marker.y, marker.z)
  // three.js divides by a negative w behind the camera and returns a mirrored point: ask where it is first.
  if (!(world.clone().applyMatrix4(camera.matrixWorldInverse).z < 0)) return null
  const ndc = world.project(camera)
  const u = (ndc.x + 1) / 2
  const v = (1 - ndc.y) / 2
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null
}

// ─── The crosshair at the pose it was placed at ───────────────────────────

test('a marker straight ahead at the camera height is the centre of the view', () => {
  const p = project({ x: 0, y: 1.4, z: -3 }, poseFrom(EYE, 0, 0))
  assert.ok(p)
  near(p.u, 0.5, 1e-12)
  near(p.v, 0.5, 1e-12)
})

test('a marker on the pitched optical axis is the centre: the floor 2.598 m ahead of a camera pitched 30 degrees down at 1.5 m', () => {
  // The axis descends 30 degrees, so it meets the floor at 1.5 / tan(30 degrees) = 2.598076 m.
  const p = project({ x: 0, y: 0, z: -1.5 / Math.tan(30 * DEG) }, poseFrom({ x: 0, y: 1.5, z: 0 }, -30, 0))
  assert.ok(p)
  near(p.u, 0.5, 1e-12)
  near(p.v, 0.5, 1e-12)
})

test('half-way to each edge of the view is a quarter in from it', () => {
  // At depth 2 the view's half-extents are tan(30) * 2 = 1.1547 m up and 0.5625 times that across. Half of each, up and to
  // the left, is the point a quarter of the way in from the top and the left.
  const half = Math.tan(30 * DEG) * 2 * 0.5
  const p = project({ x: -half * ASPECT, y: 1.4 + half, z: -2 }, poseFrom(EYE, 0, 0))
  assert.ok(p)
  near(p.u, 0.25, 1e-12)
  near(p.v, 0.25, 1e-12)
  const q = project({ x: half * ASPECT, y: 1.4 - half, z: -2 }, poseFrom(EYE, 0, 0))
  assert.ok(q)
  near(q.u, 0.75, 1e-12)
  near(q.v, 0.75, 1e-12)
})

test('a yawed, pitched camera: the hand-worked floor points of the floor-ray tests land on the pixels they were worked from', () => {
  // The same pose and lens as tap_sampling.test.ts "a yawed, pitched camera matches the hand-worked points": there the
  // pixel (0.5, 0.5) was worked by hand to the floor point (-1.9097974457218738, 0, 0.2) and (0.3, 0.65) to
  // (-1.1963156271725315, 0, 0.58859004915548). Back the other way they are those pixels.
  const pose: Pose = {
    position: { x: 0.4, y: 1.5, z: 0.2 },
    rotation: { x: -0.20082917620117852, y: 0.6779879364607868, z: 0.2008291762011785, w: 0.6779879364607869 },
  }
  const centre = project({ x: -1.9097974457218738, y: 0, z: 0.2 }, pose, 62, 0.75)
  assert.ok(centre)
  near(centre.u, 0.5, 1e-9)
  near(centre.v, 0.5, 1e-9)
  const off = project({ x: -1.1963156271725315, y: 0, z: 0.58859004915548 }, pose, 62, 0.75)
  assert.ok(off)
  near(off.u, 0.3, 1e-9)
  near(off.v, 0.65, 1e-9)
})

test('at the pose a tap was read at, a marker that tap placed on the floor is the tap again (two hundred random poses and pixels)', () => {
  const rand = rng(7)
  let checked = 0
  for (let i = 0; i < 200; i++) {
    const pose = poseFrom(
      { x: (rand() - 0.5) * 4, y: 0.8 + rand() * 1.2, z: (rand() - 0.5) * 4 },
      -15 - rand() * 65,
      rand() * 360,
      (rand() - 0.5) * 20,
    )
    const fovY = 45 + rand() * 40
    const aspect = 0.45 + rand() * 1.2
    const x = rand()
    const y = rand()
    const hit = floorRayPoint({ ...pose, fovYDeg: fovY, aspect }, x, y, 0)
    if (!hit) continue
    const back = project(hit.position, pose, fovY, aspect)
    assert.ok(back, `the floor point of pixel (${x}, ${y}) is in its own view`)
    near(back.u, x, 1e-9, 'u')
    near(back.v, y, 1e-9, 'v')
    checked++
  }
  assert.ok(checked > 120, `only ${checked} of 200 taps met the floor`)
})

test('agrees with three.js on four hundred random poses and markers, nulls included', () => {
  // Three markers in four sit ahead of the camera, within a tenth of the view's edge either side of it, so most of them are
  // in view and the rest are just out of it; the fourth is anywhere at all, which is mostly behind or far to the side.
  const rand = rng(31)
  let inView = 0
  let out = 0
  for (let i = 0; i < 400; i++) {
    const pose = poseFrom(
      { x: (rand() - 0.5) * 6, y: (rand() - 0.5) * 3, z: (rand() - 0.5) * 6 },
      (rand() - 0.5) * 160,
      rand() * 360,
      (rand() - 0.5) * 40,
    )
    const fovY = 35 + rand() * 60
    const aspect = 0.45 + rand() * 1.4
    let marker: Vec3
    if (rand() < 0.75) {
      const depth = 0.5 + rand() * 19.5
      const tanY = Math.tan((fovY / 2) * DEG)
      const camera = new THREE.Vector3(
        (rand() * 2.2 - 1.1) * aspect * tanY * depth,
        (rand() * 2.2 - 1.1) * tanY * depth,
        -depth,
      ).applyQuaternion(new THREE.Quaternion(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w))
      marker = { x: pose.position.x + camera.x, y: pose.position.y + camera.y, z: pose.position.z + camera.z }
    } else {
      marker = { x: (rand() - 0.5) * 20, y: (rand() - 0.5) * 6, z: (rand() - 0.5) * 20 }
    }
    const expected = threeView(marker, pose, fovY, aspect)
    const actual = project(marker, pose, fovY, aspect)
    if (!expected) {
      assert.equal(actual, null, `three.js has the marker out of view, so must we (case ${i})`)
      out++
      continue
    }
    assert.ok(actual, `three.js has the marker in view (case ${i})`)
    near(actual.u, expected.u, 1e-9, `u (case ${i})`)
    near(actual.v, expected.v, 1e-9, `v (case ${i})`)
    inView++
  }
  assert.ok(inView > 150 && out > 60, `the random cases must exercise both answers: ${inView} in view, ${out} out`)
})

// ─── The camera moved between the tap and the photo ───────────────────────

test('the phone turned 5 degrees to the right before the photo: the crosshair is 48.5 px to the left of the tap, not on it', () => {
  // The user taps the middle of the view at a marker straight ahead at eye height, then turns right by 5 degrees before
  // the photo is grabbed. The tap is still (0.5, 0.5), and the photo now shows the marker left of centre by
  // focal * tan(5 degrees) = 554.256 * 0.087489 = 48.49 px. Turning right lowers the session yaw, so the rotation is Ry(-5).
  const marker = { x: 0, y: 1.4, z: -3 }
  const tapped = project(marker, poseFrom(EYE, 0, 0))
  assert.ok(tapped)
  near(tapped.u, 0.5, 1e-12)
  const photo = project(marker, poseFrom(EYE, 0, -5))
  assert.ok(photo)
  const shiftPx = (tapped.u - photo.u) * VIEW.width
  near(shiftPx, FOCAL_PX * Math.tan(5 * DEG), 1e-9, 'horizontal shift in px')
  assert.ok(Math.abs(shiftPx - 48.49) < 0.01, `${shiftPx} px`)
  near(photo.v, 0.5, 1e-12)
})

test('the phone tilted 3 degrees up before the photo: the crosshair is 29.0 px below the tap', () => {
  // Tilting up by t puts what was on the axis below the centre by focal * tan(t) = 554.256 * 0.052408 = 29.05 px.
  const marker = { x: 0, y: 1.4, z: -3 }
  const photo = project(marker, poseFrom(EYE, 3, 0))
  assert.ok(photo)
  near(photo.u, 0.5, 1e-12)
  near((photo.v - 0.5) * VIEW.height, FOCAL_PX * Math.tan(3 * DEG), 1e-9, 'vertical shift in px')
})

test('the phone stepped 0.5 m to the right before the photo: a marker 3 m ahead has moved 92.4 px left', () => {
  // The marker's offset across the view is 0.5 / 3 of its depth, which is focal * 0.5 / 3 = 92.38 px.
  const marker = { x: 0, y: 1.4, z: -3 }
  const photo = project(marker, poseFrom({ x: 0.5, y: 1.4, z: 0 }, 0, 0))
  assert.ok(photo)
  near((0.5 - photo.u) * VIEW.width, (FOCAL_PX * 0.5) / 3, 1e-9, 'shift in px')
  near(photo.v, 0.5, 1e-12)
})

test('a step in both axes at once: the crosshair is off the raw tap by focal * step / depth in each, and the move alone explains it', () => {
  // A floor marker the user tapped at pixel (0.4, 0.7) of a pitched, turned view. The phone is then carried 0.3 m along its
  // own right axis and 0.2 m along its own up axis with its orientation unchanged. The marker's depth along the optical
  // axis does not change, so the picture slides by focal * step / depth pixels: left by the first, down by the second.
  const before = poseFrom({ x: 0, y: 1.5, z: 0 }, -35, 20)
  const tap = { x: 0.4, y: 0.7 }
  const hit = floorRayPoint({ ...before, fovYDeg: FOV_Y, aspect: ASPECT }, tap.x, tap.y, 0)
  assert.ok(hit)

  const q = new THREE.Quaternion(before.rotation.x, before.rotation.y, before.rotation.z, before.rotation.w)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  const offset = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z).sub(
    new THREE.Vector3(before.position.x, before.position.y, before.position.z),
  )
  const depth = offset.dot(forward)

  const moved = new THREE.Vector3(before.position.x, before.position.y, before.position.z)
    .addScaledVector(right, 0.3)
    .addScaledVector(up, 0.2)
  const after: Pose = { position: { x: moved.x, y: moved.y, z: moved.z }, rotation: before.rotation }

  const photo = project(hit.position, after)
  assert.ok(photo)
  const expectedDxPx = (-FOCAL_PX * 0.3) / depth
  const expectedDyPx = (FOCAL_PX * 0.2) / depth
  near((photo.u - tap.x) * VIEW.width, expectedDxPx, 1e-9, 'dx px')
  near((photo.v - tap.y) * VIEW.height, expectedDyPx, 1e-9, 'dy px')
  assert.ok(Math.hypot(expectedDxPx, expectedDyPx) > 30, `the raw tap would be ${Math.hypot(expectedDxPx, expectedDyPx)} px off: more than a finger`)

  // Seen from the pose the tap was read at, the marker is the tap exactly: the difference is the move and nothing else.
  const still = project(hit.position, before)
  assert.ok(still)
  near(still.u, tap.x, 1e-9)
  near(still.v, tap.y, 1e-9)
})

// ─── The landmark moved after its photo was taken ─────────────────────────

test('a landmark moved 0.4 m sideways stays in the old photo: its crosshair moves 73.9 px, and no new photo is needed', () => {
  // Photo taken with the landmark 3 m ahead at eye height; then the user moves the landmark 0.4 m to the right. Through
  // the same pose it is focal * 0.4 / 3 = 73.90 px right of where it was.
  const pose = poseFrom(EYE, 0, 0)
  const was = project({ x: 0, y: 1.4, z: -3 }, pose)
  const now = project({ x: 0.4, y: 1.4, z: -3 }, pose)
  assert.ok(was && now)
  near((now.u - was.u) * VIEW.width, (FOCAL_PX * 0.4) / 3, 1e-9, 'shift in px')
  near(now.v, was.v, 1e-12)
})

test('a landmark moved out of the old photo has no crosshair there: the case that needs a new photo, which then shows it', () => {
  const old = poseFrom(EYE, 0, 0)
  const moved = { x: 3, y: 1.4, z: -3 }
  // 3 m across at 3 m depth is a tangent of 1; the view's half-extent is 0.5625 * tan(30) = 0.325.
  assert.equal(project(moved, old), null)
  // The user turns to face it: the point is 45 degrees to the right, a rotation of -45 about +Y.
  const fresh = project(moved, poseFrom(EYE, 0, -45))
  assert.ok(fresh)
  near(fresh.u, 0.5, 1e-12)
  near(fresh.v, 0.5, 1e-12)
})

// ─── Nothing to show ──────────────────────────────────────────────────────

test('behind the camera is null, even where a mirrored projection would land in the view', () => {
  const pose = poseFrom(EYE, 0, 0)
  // Without the depth check this lands exactly on the centre, mirrored through the lens.
  assert.equal(project({ x: 0, y: 1.4, z: 3 }, pose), null)
  assert.equal(project({ x: 0.2, y: 1.5, z: 5 }, pose), null)
  // In the camera's own plane there is no depth to divide by.
  assert.equal(project({ x: 2, y: 1.4, z: 0 }, pose), null)
  assert.equal(project({ x: 0, y: 1.4, z: 0 }, pose), null)
  // The same behind-ness after the camera has turned right round.
  assert.equal(project({ x: 0, y: 1.4, z: -3 }, poseFrom(EYE, 0, 180)), null)
})

test('outside the view is null on every side, and just inside every side is a point', () => {
  const pose = poseFrom(EYE, 0, 0)
  const depth = 4
  const at = (u: number, v: number): Vec3 => ({
    x: (2 * u - 1) * ASPECT * Math.tan(30 * DEG) * depth,
    y: 1.4 + (1 - 2 * v) * Math.tan(30 * DEG) * depth,
    z: -depth,
  })
  for (const [u, v] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.01], [0.5, 1.01], [-0.5, -0.5], [2, 2]] as const) {
    assert.equal(project(at(u, v), pose), null, `(${u}, ${v}) is outside`)
  }
  for (const [u, v] of [[0.01, 0.5], [0.99, 0.5], [0.5, 0.01], [0.5, 0.99], [0.02, 0.98]] as const) {
    const p = project(at(u, v), pose)
    assert.ok(p, `(${u}, ${v}) is inside`)
    near(p.u, u, 1e-12)
    near(p.v, v, 1e-12)
  }
})

test('edges count as in view: a marker exactly on the left, right, top or bottom edge is a point, and one a hair outside is null', () => {
  // With no rotation and the camera at the origin the arithmetic is exact: a marker at depth * aspect * tan(fovY / 2) across is exactly
  // 1 on u, and at depth * tan(fovY / 2) up exactly 0 on v. The same products the projection divides by.
  const tanHalf = Math.tan((FOV_Y * Math.PI) / 360)
  const depth = 4
  const across = depth * ASPECT * tanHalf
  const up = depth * tanHalf
  const origin: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  assert.deepEqual(project({ x: -across, y: 0, z: -depth }, origin), { u: 0, v: 0.5 }, 'left edge')
  assert.deepEqual(project({ x: across, y: 0, z: -depth }, origin), { u: 1, v: 0.5 }, 'right edge')
  assert.deepEqual(project({ x: 0, y: up, z: -depth }, origin), { u: 0.5, v: 0 }, 'top edge')
  assert.deepEqual(project({ x: 0, y: -up, z: -depth }, origin), { u: 0.5, v: 1 }, 'bottom edge')
  const hair = 1 + 1e-12
  assert.equal(project({ x: -across * hair, y: 0, z: -depth }, origin), null, 'a hair left of the left edge')
  assert.equal(project({ x: across * hair, y: 0, z: -depth }, origin), null, 'a hair right of the right edge')
  assert.equal(project({ x: 0, y: up * hair, z: -depth }, origin), null, 'a hair above the top edge')
  assert.equal(project({ x: 0, y: -up * hair, z: -depth }, origin), null, 'a hair below the bottom edge')
})

test('a marker in the margin a cover-cropped canvas never showed is null here, though the stored photo has it: null answers for the canvas', () => {
  // A 1080 x 1440 frame under the 360 x 640 canvas: the canvas shows the middle 75 % of the frame's width, and the 12.5 % each side is part of
  // the photo the person never saw. The frame's own pinhole is the canvas's scaled up by the crop: a focal length of 554.256 / (640 / 1440) px.
  const frame = { width: 1080, height: 1440 }
  const scale = Math.max(VIEW.width / frame.width, VIEW.height / frame.height)
  const frameFocalPx = FOCAL_PX / scale
  near(frameFocalPx, 1247.0766, 1e-3)
  const depth = 3
  // A marker the photo shows 5 % in from its left edge, half way down: 486 px left of the frame's centre, by the frame's own pinhole.
  const marker = { x: ((0.05 * frame.width - frame.width / 2) / frameFocalPx) * depth, y: 1.4, z: -depth }
  assert.equal(project(marker, poseFrom(EYE, 0, 0)), null, 'outside the view the canvas showed')
  // The canvas's pinhole, not clipped to its edge, puts it 0.1 of the canvas's width beyond the left edge, which is inside the photo.
  const u = 0.5 + (marker.x / depth) * (FOCAL_PX / VIEW.width)
  near(u, -0.1, 1e-9)
  const inPhoto = tapPointWithinPhoto({ x: u, y: 0.5 }, frame, VIEW)
  assert.ok(inPhoto, 'the photo shows it')
  near(inPhoto.x, 0.05, 1e-9)
  near(inPhoto.y, 0.5, 1e-9)
  // The same distance in from the other side of the margin, still outside the canvas, is the same kind of answer: null here, a point in the photo.
  const right = { x: -marker.x, y: 1.4, z: -depth }
  assert.equal(project(right, poseFrom(EYE, 0, 0)), null)
  const rightInPhoto = tapPointWithinPhoto({ x: 0.5 + (right.x / depth) * (FOCAL_PX / VIEW.width), y: 0.5 }, frame, VIEW)
  assert.ok(rightInPhoto)
  near(rightInPhoto.x, 0.95, 1e-9)
})

test('a lens as narrow as half a degree is a lens, and a rotation scaled down to a millionth is still the rotation it points along', () => {
  const straight = project({ x: 0, y: 1.4, z: -3 }, poseFrom(EYE, 0, 0), 0.5)
  assert.ok(straight)
  near(straight.u, 0.5, 1e-12)
  near(straight.v, 0.5, 1e-12)
  // 0.5 degrees at 3 m is a view 2.6 cm across: a marker 1 cm left of the axis is 12 % in from the left edge, and one 5 cm left is out.
  const narrow = project({ x: -0.01, y: 1.4, z: -3 }, poseFrom(EYE, 0, 0), 0.5, 1)
  assert.ok(narrow)
  near(narrow.u, 0.5 - 0.01 / (2 * 3 * Math.tan(0.25 * DEG)), 1e-9)
  assert.equal(project({ x: -0.05, y: 1.4, z: -3 }, poseFrom(EYE, 0, 0), 0.5, 1), null)
  const pose = poseFrom({ x: 0.3, y: 1.4, z: 0.1 }, -20, 25)
  const marker = { x: -0.5, y: 0.6, z: -3 }
  const unit = project(marker, pose)
  assert.ok(unit)
  for (const k of [1e-6, 1e-4]) {
    const r = pose.rotation
    const tiny = project(marker, { position: pose.position, rotation: { x: r.x * k, y: r.y * k, z: r.z * k, w: r.w * k } })
    assert.ok(tiny, `scale ${k}`)
    near(tiny.u, unit.u, 1e-9, `u at scale ${k}`)
    near(tiny.v, unit.v, 1e-9, `v at scale ${k}`)
  }
})

test('a rotation that is not unit length gives the answer the unit one does; one with no length gives none', () => {
  const pose = poseFrom({ x: 0.3, y: 1.4, z: 0.1 }, -20, 25)
  const marker = { x: -0.5, y: 0.6, z: -3 }
  const unit = project(marker, pose)
  assert.ok(unit)
  const scaled = project(marker, {
    position: pose.position,
    rotation: { x: pose.rotation.x * 7, y: pose.rotation.y * 7, z: pose.rotation.z * 7, w: pose.rotation.w * 7 },
  })
  assert.ok(scaled)
  near(scaled.u, unit.u, 1e-12)
  near(scaled.v, unit.v, 1e-12)
  assert.equal(project(marker, { position: pose.position, rotation: { x: 0, y: 0, z: 0, w: 0 } }), null)
  // Not a rotation to a billionth: normalising it would give the identity and a confident wrong answer.
  assert.equal(project(marker, { position: pose.position, rotation: { x: 0, y: 0, z: 0, w: 1e-12 } }), null)
  // A rotation exactly a billionth long has no length to a billionth, and one twice that has.
  assert.equal(project(marker, { position: pose.position, rotation: { x: 0, y: 0, z: 0, w: 1e-9 } }), null)
  const twice = project(marker, { position: pose.position, rotation: { x: pose.rotation.x * 2e-9, y: pose.rotation.y * 2e-9, z: pose.rotation.z * 2e-9, w: pose.rotation.w * 2e-9 } })
  assert.ok(twice)
  near(twice.u, unit.u, 1e-9)
  near(twice.v, unit.v, 1e-9)
})

test('an input that is not a number, and a lens that is not one, give null and not NaN', () => {
  const pose = poseFrom(EYE, 0, 0)
  const marker = { x: 0, y: 1.4, z: -3 }
  assert.ok(project(marker, pose), 'the control case is in view')
  assert.equal(project({ ...marker, x: Number.NaN }, pose), null)
  assert.equal(project({ ...marker, y: Number.POSITIVE_INFINITY }, pose), null)
  assert.equal(project(marker, { ...pose, position: { ...EYE, z: Number.NaN } }), null)
  assert.equal(project(marker, { ...pose, rotation: { ...pose.rotation, w: Number.NaN } }), null)
  assert.equal(project(marker, pose, Number.NaN), null)
  assert.equal(project(marker, pose, 0), null)
  assert.equal(project(marker, pose, -60), null)
  assert.equal(project(marker, pose, 180), null)
  assert.equal(project(marker, pose, FOV_Y, 0), null)
  assert.equal(project(marker, pose, FOV_Y, -1), null)
  assert.equal(project(marker, pose, FOV_Y, Number.NaN), null)
  assert.equal(project(marker, pose, FOV_Y, Number.POSITIVE_INFINITY), null)
})

// ─── From the view to the photo ───────────────────────────────────────────

test('a point in the view is mapped into a cover-cropped photo by tapPointWithinPhoto, which owns the crop', () => {
  // The camera frame is 1080 x 1440 (3:4) and the view 360 x 640: the view shows the middle 360/480 of the frame's width
  // and all of its height (scale 640/1440, the frame displayed 480 x 640 with 60 px off each side). A point a quarter of the
  // way across the view is (0.25 * 360 + 60) / 480 = 0.3125 of the way across the photo; the height is unchanged.
  const marker = (u: number, v: number): Vec3 => ({
    x: (2 * u - 1) * ASPECT * Math.tan(30 * DEG) * 2,
    y: 1.4 + (1 - 2 * v) * Math.tan(30 * DEG) * 2,
    z: -2,
  })
  const inView = project(marker(0.25, 0.25), poseFrom(EYE, 0, 0))
  assert.ok(inView)
  const inPhoto = tapPointWithinPhoto({ x: inView.u, y: inView.v }, { width: 1080, height: 1440 }, VIEW)
  assert.ok(inPhoto)
  near(inPhoto.x, 0.3125, 1e-9)
  near(inPhoto.y, 0.25, 1e-9)
  const centre = project(marker(0.5, 0.5), poseFrom(EYE, 0, 0))
  assert.ok(centre)
  const mid = tapPointWithinPhoto({ x: centre.u, y: centre.v }, { width: 1080, height: 1440 }, VIEW)
  assert.ok(mid)
  near(mid.x, 0.5, 1e-9)
  near(mid.y, 0.5, 1e-9)
})

// ─── The distance rings ───────────────────────────────────────────────────

const ORIGIN = { x: 0, y: 0, z: 0 }

test('a stored two-point frame has one ring, as far out as its separation', () => {
  const heading = { x: 0, y: 0, z: 3.2 }
  assert.deepEqual(ringRadiiFromStoredPoints([heading], ORIGIN), [3.2])
  assert.equal(ringRadiiFromStoredPoints([heading], ORIGIN)[0], twoPointSeparationM(ORIGIN, heading))
})

test('a ring is a floor distance: a point a few centimetres off the floor is as far out as its footprint', () => {
  // (1.2, 1.6) on the floor is 2.0 m out; 3-D with the 0.04 m height it would be 2.0004 m.
  const radii = ringRadiiFromStoredPoints([{ x: 1.2, y: 0.04, z: 1.6 }], ORIGIN)
  assert.equal(radii.length, 1)
  near(radii[0]!, 2.0, 1e-12)
})

test('a recaptured landmark anywhere in the session, however the pair is turned, has the same rings', () => {
  // On a return visit the landmark is tapped again somewhere else and the pair is turned by however the user stood.
  // The radii are properties of the stored pair, so shifting both points and turning them by 37 degrees changes none.
  const stored = [{ x: 0, y: 0, z: 3.2 }, { x: 2.5, y: 0.02, z: -1.0 }, { x: -1.1, y: 0, z: 4.4 }]
  const base = ringRadiiFromStoredPoints(stored, ORIGIN)
  assert.equal(base.length, 3)
  const t = 37 * DEG
  const move = (p: Vec3): Vec3 => ({
    x: 5.2 + p.x * Math.cos(t) + p.z * Math.sin(t),
    y: 0.1 + p.y,
    z: -3.3 - p.x * Math.sin(t) + p.z * Math.cos(t),
  })
  const moved = ringRadiiFromStoredPoints(stored.map(move), move(ORIGIN))
  assert.equal(moved.length, base.length)
  base.forEach((r, i) => near(moved[i]!, r, 1e-12, `ring ${i}`))
})

test('a ring is made at any distance above nothing, a point 30 cm out and 40 cm along included', () => {
  const radii = ringRadiiFromStoredPoints([{ x: 0.3, y: 0, z: 0.4 }, { x: 0.001, y: 0, z: 0 }], ORIGIN)
  assert.equal(radii.length, 2)
  near(radii[0]!, 0.5, 1e-12)
  near(radii[1]!, 0.001, 1e-12)
})

test('a stored landmark that is not at the origin is the centre the distances are taken from', () => {
  // 3 across and 4 along from (1, -1) is 5.
  assert.deepEqual(ringRadiiFromStoredPoints([{ x: 4, y: 0, z: 3 }], { x: 1, y: 0, z: -1 }), [5])
})

test('radii come in the order the points were given, and a point that makes no ring is left out', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  const radii = ringRadiiFromStoredPoints(
    [
      { x: 0, y: 0, z: 3 },
      { x: Number.NaN, y: 0, z: 1 },
      { x: 0, y: 0.5, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 0, y: 0, z: Number.POSITIVE_INFINITY },
      { x: 0, y: 0, z: -2 },
    ],
    landmark,
  )
  assert.deepEqual(radii, [3, 4, 2])
  assert.deepEqual(ringRadiiFromStoredPoints([], landmark), [])
})
