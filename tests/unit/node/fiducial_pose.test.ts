/**
 * The tag's pose: intrinsics from the projection matrices the providers publish, the planar solver
 * and its mirror solution, the camera-to-session conversion, and fusion over frames with the
 * measured fields a calibration would record.
 *
 * Where truth comes from. Every check against a known answer builds that answer without the module
 * under test: intrinsics are checked against three.js's own projection of a point; the session
 * conversion against a THREE.Object3D's `localToWorld`; frames are drawn by the pinhole renderer in
 * `tests/support/fiducial-render.ts` from a tag fixed in the session and a camera that moves, with
 * the camera model written out from three.js's convention (a camera looks down -z, +y up) rather than
 * through the module's OpenCV-to-three.js conversion. A flipped axis in the module therefore shows up
 * as an error here instead of cancelling out.
 *
 * What the numbers do and do not mean. Corner noise in the Monte Carlo tests is injected Gaussian
 * noise; in the end-to-end tests it is whatever the detector makes of rendered frames (noise 3 levels,
 * blur 0.8 px). Neither includes lens distortion, rolling shutter or motion blur, and the camera poses
 * the fusion is given are exact unless a test says otherwise (a real runtime's are not). The figures
 * are the best this method can do in that world; DX8 measures the real one.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_pose.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CSCAN5_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import {
  DEFAULT_MAX_EDGE_RMS_PX,
  DEFAULT_MAX_RANGE_M,
  DEFAULT_MIN_EDGE_INLIER_FRACTION,
  estimateSessionScale,
  fuseTagObservations,
  intrinsicsFromFovY,
  intrinsicsFromProjection,
  intrinsicsFromXRView,
  intrinsicsProblem,
  matrixToQuat,
  observationFromDetection,
  poseToSession,
  projectTagCorners,
  quatToMatrix,
  rotationAngleBetweenDeg,
  sessionToTagMatrix,
  solveTagPose,
  tagCornersInSession,
  viewRectForFit,
} from '../../../src/ar/fiducial/tag-pose.ts'
import type { CameraIntrinsics, Quad, TagObservation } from '../../../src/ar/fiducial/types.ts'
import {
  INTRINSICS_1280,
  INTRINSICS_640,
  dictionaryTagArtwork,
  lookAtPose,
  mat3Apply,
  mat3Mul,
  mat3Transpose,
  matrixFromQuat,
  patchArtwork,
  projectSessionTag,
  quatFromMatrix,
  renderFrame,
  renderTag,
  rotX,
  rotY,
  rotZ,
  tagPose,
  type SessionPoseLike,
} from '../../support/fiducial-render.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const K = INTRINSICS_640
const SIZE_M = 0.2
/** Measured with the consensus: 4.7 deg median spread, 3.5 deg p90 error; without it 8.3 and 7.1. The bounds sit between. */
const SPREAD_BOUND_DEG = 6.5
const ERROR_BOUND_DEG = 5.3

function gaussian(rand: () => number): () => number {
  return () => {
    let u = 0
    while (u === 0) u = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
  }
}

function mean(v: number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length
}

function percentile(values: number[], p: number): number {
  const a = values.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]!
}

function norm3(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z)
}

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** OpenCV camera axes to three.js camera axes: a half turn about x. Written out here, not imported. */
const FLIP_YZ = [1, 0, 0, 0, -1, 0, 0, 0, -1]

/** The tag's pose in the OpenCV camera frame, from a tag fixed in the session and a three.js camera. */
function cvPoseOf(tag: SessionPoseLike, cam: SessionPoseLike) {
  const rt = matrixFromQuat(tag.rotation)
  const rcT = mat3Transpose(matrixFromQuat(cam.rotation))
  const d = { x: tag.position.x - cam.position.x, y: tag.position.y - cam.position.y, z: tag.position.z - cam.position.z }
  return { rotation: mat3Mul(FLIP_YZ, mat3Mul(rcT, rt)), translation: mat3Apply(mat3Mul(FLIP_YZ, rcT), d) }
}

/** A projection matrix for a camera with these intrinsics seeing the image rectangle `view` (image pixels), built from first principles. */
function projectionFor(k: CameraIntrinsics, view: { x: number; y: number; width: number; height: number }): Float32Array {
  const p = new Float32Array(16)
  p[0] = (2 * k.fx) / view.width
  p[5] = (2 * k.fy) / view.height
  p[8] = 1 - (2 * (k.cx - view.x)) / view.width
  p[9] = (2 * (k.cy - view.y)) / view.height - 1
  p[10] = -1.002
  p[11] = -1
  p[14] = -0.2002
  return p
}

/** A tag fixed in the session, tilted `yawDeg` about the vertical and `pitchDeg` about its horizontal. */
function fixedTag(yawDeg = 20, pitchDeg = 10, position = { x: 0.3, y: 1.3, z: -3 }): SessionPoseLike {
  return { position, rotation: quatFromMatrix(mat3Mul(rotY((yawDeg * Math.PI) / 180), rotX((pitchDeg * Math.PI) / 180))) }
}

interface WalkOptions {
  tag?: SessionPoseLike
  range: number
  frames: number
  arcDeg: number
  intrinsics?: CameraIntrinsics
  /** Corner noise in pixels (added to exact projections). Ignored when `render` is set. */
  cornerNoise?: number
  seed?: number
  /** Session units per metre: the camera positions and the tag's size are expressed in session units. */
  scale?: number
  cameraJitterM?: number
  cameraRotationJitterDeg?: number
}

/** Observations of a fixed tag from a camera walking an arc around it, with exact projected corners (plus noise if asked). */
function walk(o: WalkOptions): { tag: SessionPoseLike; observations: TagObservation[]; cameras: SessionPoseLike[] } {
  const tag = o.tag ?? fixedTag()
  const k = o.intrinsics ?? K
  const rand = mulberry32(o.seed ?? 1)
  const g = gaussian(rand)
  const scale = o.scale ?? 1
  const observations: TagObservation[] = []
  const cameras: SessionPoseLike[] = []
  for (let i = 0; i < o.frames; i++) {
    const a = ((i / Math.max(1, o.frames - 1)) - 0.5) * ((o.arcDeg * Math.PI) / 180)
    const radius = o.range * scale
    const position = { x: tag.position.x + Math.sin(a) * radius, y: tag.position.y - 0.1, z: tag.position.z + Math.cos(a) * radius }
    let cam = lookAtPose(position, tag.position)
    const exact = projectSessionTag(tag, cam, k, SIZE_M * scale)
    const corners = exact.map((c) => ({ x: c.x + (o.cornerNoise ?? 0) * g(), y: c.y + (o.cornerNoise ?? 0) * g() })) as unknown as Quad
    // The pose the runtime REPORTS may differ from the true one by jitter; the corners were drawn from the true one.
    if (o.cameraJitterM || o.cameraRotationJitterDeg) {
      const j = o.cameraJitterM ?? 0
      const jr = ((o.cameraRotationJitterDeg ?? 0) * Math.PI) / 180
      const dq = quatFromMatrix(mat3Mul(rotX(jr * g()), mat3Mul(rotY(jr * g()), rotZ(jr * g()))))
      const m = mat3Mul(matrixFromQuat(cam.rotation), matrixFromQuat(dq))
      cam = { position: { x: cam.position.x + j * g(), y: cam.position.y + j * g(), z: cam.position.z + j * g() }, rotation: quatFromMatrix(m) }
    }
    cameras.push(cam)
    observations.push({ corners, intrinsics: k, cameraPose: cam, timestampMs: i * 66 })
  }
  return { tag, observations, cameras }
}

function poseError(fusedPose: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }, tag: SessionPoseLike, scale = 1) {
  return {
    posM: dist3(fusedPose.position, tag.position) / scale,
    rotDeg: rotationAngleBetweenDeg(quatToMatrix(fusedPose.rotation), matrixFromQuat(tag.rotation)),
  }
}

// ===============================================================================================
// Intrinsics
// ===============================================================================================

test('a projection matrix gives the camera it describes: checked against three.js, off-centre frustum included', () => {
  for (const [l, r, t, b] of [[-0.07, 0.05, 0.04, -0.06], [-0.05, 0.05, 0.0375, -0.0375], [-0.03, 0.08, 0.02, -0.07]] as const) {
    const m = new THREE.Matrix4().makePerspective(l, r, t, b, 0.1, 100)
    const W = 800
    const H = 600
    const k = intrinsicsFromProjection(m.elements, { width: W, height: H })
    for (const x of [new THREE.Vector3(0.3, -0.2, -2.5), new THREE.Vector3(-0.8, 0.5, -4), new THREE.Vector3(0, 0, -1)]) {
      const ndc = x.clone().applyMatrix4(m)
      const u = ((ndc.x + 1) / 2) * W
      const v = ((1 - ndc.y) / 2) * H
      // three.js camera coordinates (x, y, z) are OpenCV's (x, -y, -z).
      const [cx, cy, cz] = [x.x, -x.y, -x.z] as const
      assert.ok(Math.abs(k.fx * (cx / cz) + k.cx - u) < 1e-6, `u ${u} vs ${k.fx * (cx / cz) + k.cx}`)
      assert.ok(Math.abs(k.fy * (cy / cz) + k.cy - v) < 1e-6, `v ${v} vs ${k.fy * (cy / cz) + k.cy}`)
    }
  }
})

test('intrinsics from an XRView-style Float32Array and from a plain array agree with the camera that built them', () => {
  const truth: CameraIntrinsics = { fx: 912.4, fy: 913.1, cx: 612.5, cy: 351.2, width: 1280, height: 720 }
  const p = projectionFor(truth, { x: 0, y: 0, width: 1280, height: 720 })
  const fromView = intrinsicsFromXRView({ projectionMatrix: p }, { width: 1280, height: 720 })
  for (const key of ['fx', 'fy', 'cx', 'cy'] as const) assert.ok(Math.abs(fromView[key] - truth[key]) < 1e-2, `${key}: ${fromView[key]} vs ${truth[key]}`)
  const fromArray = intrinsicsFromProjection(Array.from(p), { width: 1280, height: 720 })
  assert.deepEqual(fromArray, fromView)
})

test('the field of view the provider already exposes gives the same camera as the projection it came from, when the principal point is central', () => {
  // EighthWallProvider reads fovY = 2 atan(1 / proj[5]) and the aspect proj[5] / proj[0] from the engine's matrix.
  const camera: CameraIntrinsics = { fx: 733.3, fy: 733.3, cx: 360, cy: 480, width: 720, height: 960 }
  const p = projectionFor(camera, { x: 0, y: 0, width: 720, height: 960 })
  const fovY = (2 * Math.atan(1 / p[5]!) * 180) / Math.PI
  const viaFov = intrinsicsFromFovY(fovY, { width: 720, height: 960 })
  const viaMatrix = intrinsicsFromProjection(p, { width: 720, height: 960 })
  for (const key of ['fx', 'fy', 'cx', 'cy'] as const) assert.ok(Math.abs(viaFov[key] - viaMatrix[key]) < 1e-2, `${key}: ${viaFov[key]} vs ${viaMatrix[key]}`)
  assert.equal(intrinsicsProblem(viaFov), null)
  assert.throws(() => intrinsicsFromFovY(0, { width: 10, height: 10 }), /not between 1 and 179/)
  assert.throws(() => intrinsicsFromFovY(180, { width: 10, height: 10 }), /not between 1 and 179/)
  assert.throws(() => intrinsicsFromFovY(Number.NaN, { width: 10, height: 10 }), /not between 1 and 179/)
  // The 60 degree placeholder the provider returns before the first frame is a legal input, which is why a caller must not use it as a measurement.
  assert.ok(Math.abs(intrinsicsFromFovY(60, { width: 640, height: 480 }).fy - 240 / Math.tan(Math.PI / 6)) < 1e-9)
})

test('with a crop or bars, the intrinsics of the VISIBLE rectangle are the camera\'s, not the display\'s', () => {
  const camera: CameraIntrinsics = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 }
  const image = { width: 640, height: 480 }
  // `cover`: a portrait display crops the sides of a landscape frame. The engine builds its
  // projection for what is shown, so the clip square is the cropped rectangle.
  const cover = viewRectForFit({ width: 300, height: 600 }, image, 'cover')
  assert.deepEqual({ x: cover.x, y: cover.y, width: cover.width, height: cover.height }, { x: 200, y: 0, width: 240, height: 480 })
  const got = intrinsicsFromProjection(projectionFor(camera, cover), image, cover)
  for (const key of ['fx', 'fy', 'cx', 'cy'] as const) assert.ok(Math.abs(got[key] - camera[key]) < 1e-3, `cover ${key}: ${got[key]}`)
  // Ignoring the rectangle gives a camera that is not the camera (the aspect gives it away).
  const naive = intrinsicsFromProjection(projectionFor(camera, cover), image)
  assert.equal(intrinsicsProblem(naive), 'aspect-mismatch')

  // `contain`: a wide display adds bars to a 4:3 frame; the clip square is larger than the image.
  const contain = viewRectForFit({ width: 800, height: 400 }, image, 'contain')
  assert.ok(contain.x < 0 && contain.width > 640, `contain rectangle ${JSON.stringify(contain)}`)
  const got2 = intrinsicsFromProjection(projectionFor(camera, contain), image, contain)
  for (const key of ['fx', 'fy', 'cx', 'cy'] as const) assert.ok(Math.abs(got2[key] - camera[key]) < 1e-3, `contain ${key}: ${got2[key]}`)

  // The fit EighthWallProvider uses (`contain` with a canvas of the camera's own aspect) is the whole image.
  assert.deepEqual(viewRectForFit({ width: 1080, height: 810 }, image, 'contain'), { x: 0, y: 0, width: 640, height: 480 })
})

test('a rotated or differently cropped frame is named, not silently used', () => {
  const portraitCanvas: CameraIntrinsics = { fx: 500, fy: 500, cx: 240, cy: 320, width: 480, height: 640 }
  // The projection says portrait; the pixel array handed over is landscape.
  const p = projectionFor(portraitCanvas, { x: 0, y: 0, width: 480, height: 640 })
  assert.equal(intrinsicsProblem(intrinsicsFromProjection(p, { width: 640, height: 480 })), 'aspect-mismatch')
  assert.equal(intrinsicsProblem(intrinsicsFromProjection(p, { width: 480, height: 640 })), null)
  assert.equal(intrinsicsProblem({ ...K, fx: NaN }), 'not-finite')
  assert.equal(intrinsicsProblem({ ...K, fx: 0 }), 'not-finite')
  assert.equal(intrinsicsProblem({ ...K, cx: 900 }), 'principal-point')
  assert.equal(intrinsicsProblem({ ...K, fx: 505, fy: 500 }), null, 'a 1 % gap is rounding, not a different frame')
  assert.equal(solveTagPose([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { ...K, fx: 900 }, SIZE_M), null)
})

test('something that is not a perspective projection is refused', () => {
  assert.throws(() => intrinsicsFromProjection([1, 0, 0], { width: 10, height: 10 }), /expected 16/)
  assert.throws(() => intrinsicsFromProjection(new Array(16).fill(0), { width: 10, height: 10 }), /not a perspective projection/)
  const bad = projectionFor(K, { x: 0, y: 0, width: 640, height: 480 })
  bad[5] = NaN
  assert.throws(() => intrinsicsFromProjection(bad, { width: 640, height: 480 }), /not a perspective projection/)
})

// ===============================================================================================
// The planar solver
// ===============================================================================================

test('exact corners give the exact pose, a different second solution, and a perfect residual', () => {
  const rand = mulberry32(5)
  let withAlternate = 0
  for (let i = 0; i < 300; i++) {
    const range = 0.8 + rand() * 4
    // Anywhere in the frame: out to 29 degrees off the optical axis sideways and 22 degrees up or down.
    const pose = tagPose({ x: (rand() - 0.5) * range * 1.1, y: (rand() - 0.5) * range * 0.8, z: range }, rand() * 360, (rand() - 0.5) * 120, (rand() - 0.5) * 100)
    const corners = projectTagCorners(pose, K, SIZE_M) as unknown as Quad
    const sol = solveTagPose(corners, K, SIZE_M)
    assert.ok(sol, `pose ${i} was not solved`)
    assert.ok(dist3(sol.best.translation, pose.translation) < 1e-9, `translation ${dist3(sol.best.translation, pose.translation)}`)
    assert.ok(rotationAngleBetweenDeg(sol.best.rotation, pose.rotation) < 1e-4)
    assert.ok(sol.best.reprojectionRmsPx < 1e-9)
    assert.ok(Math.abs(sol.best.rangeM - norm3(pose.translation)) < 1e-9)
    if (sol.alternate) {
      withAlternate++
      assert.ok(sol.alternate.reprojectionRmsPx > sol.best.reprojectionRmsPx, 'the mirror solution cannot fit exact corners as well')
      assert.ok(rotationAngleBetweenDeg(sol.alternate.rotation, sol.best.rotation) > 0.05)
    }
  }
  assert.ok(withAlternate > 250, `only ${withAlternate} of 300 had a second solution`)
})

test('range and view angle of a solution are the geometry\'s', () => {
  const facing = tagPose({ x: 0, y: 0, z: 2 }, 0, 0, 0)
  const s0 = solveTagPose(projectTagCorners(facing, K, SIZE_M) as unknown as Quad, K, SIZE_M)!
  assert.ok(Math.abs(s0.best.rangeM - 2) < 1e-9)
  assert.ok(s0.best.viewAngleDeg < 1e-6, `face-on is ${s0.best.viewAngleDeg} degrees`)
  const turned = tagPose({ x: 0, y: 0, z: 2 }, 0, 40, 0)
  const s1 = solveTagPose(projectTagCorners(turned, K, SIZE_M) as unknown as Quad, K, SIZE_M)!
  assert.ok(Math.abs(s1.best.viewAngleDeg - 40) < 1e-6, `${s1.best.viewAngleDeg}`)
})

test('corners that are not a square seen from in front give nothing', () => {
  const sq = projectTagCorners(tagPose({ x: 0, y: 0, z: 2 }, 0, 10, 5), K, SIZE_M) as unknown as Quad
  assert.ok(solveTagPose(sq, K, SIZE_M))
  assert.equal(solveTagPose(sq, K, 0), null)
  assert.equal(solveTagPose(sq, K, -0.2), null)
  assert.equal(solveTagPose([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }, { x: 400, y: 100 }], K, SIZE_M), null, 'collinear')
  assert.equal(solveTagPose([sq[0], sq[1], sq[2], { x: NaN, y: 1 }] as unknown as Quad, K, SIZE_M), null)
  assert.equal(solveTagPose([sq[0], sq[0], sq[0], sq[0]] as unknown as Quad, K, SIZE_M), null, 'all four corners the same point')
})

test('the residual is what injected corner noise predicts, and the conditioning figures predict the pose error', () => {
  const rand = mulberry32(77)
  const g = gaussian(rand)
  const sigma = 0.1
  // A well-conditioned view: tilted, close enough that the two solutions are never confused.
  const pose = tagPose({ x: 0.05, y: -0.02, z: 1.5 }, 20, 35, 5)
  const clean = projectTagCorners(pose, K, SIZE_M)
  const trueSol = solveTagPose(clean as unknown as Quad, K, SIZE_M)!
  const N = 500
  const rmsSq: number[] = []
  const posErrSq: number[] = []
  const tiltSq: number[] = []
  for (let i = 0; i < N; i++) {
    const noisy = clean.map((c) => ({ x: c.x + sigma * g(), y: c.y + sigma * g() })) as unknown as Quad
    const sol = solveTagPose(noisy, K, SIZE_M)!
    rmsSq.push(sol.best.reprojectionRmsPx ** 2)
    posErrSq.push(dist3(sol.best.translation, pose.translation) ** 2)
    // Rotation error about the tag's own in-plane axes: the rotation difference expressed in the tag frame.
    const rel = mat3Mul(mat3Transpose(pose.rotation), sol.best.rotation)
    const tilt = Math.hypot(rel[7]! - rel[5]!, rel[2]! - rel[6]!) / 2
    tiltSq.push((tilt * 180) / Math.PI) // small-angle: the rotation vector's in-plane part, in degrees
  }
  // Eight residuals, six unknowns: the expected mean square of the four corner distances is sigma^2 / 2.
  const rmsOfRms = Math.sqrt(mean(rmsSq))
  assert.ok(Math.abs(rmsOfRms / sigma - Math.SQRT1_2) < 0.06, `RMS residual ${rmsOfRms.toFixed(4)} px for noise ${sigma}`)
  const c = trueSol.conditioning
  const empiricalPos = Math.sqrt(mean(posErrSq))
  assert.ok(Math.abs(empiricalPos / (sigma * c.positionM) - 1) < 0.15, `position error ${empiricalPos.toFixed(5)} m vs predicted ${(sigma * c.positionM).toFixed(5)} m`)
  const empiricalTilt = Math.sqrt(mean(tiltSq.map((t) => t * t)))
  assert.ok(Math.abs(empiricalTilt / (sigma * c.tiltDeg) - 1) < 0.2, `tilt error ${empiricalTilt.toFixed(3)} deg vs predicted ${(sigma * c.tiltDeg).toFixed(3)} deg`)
  assert.ok(c.tiltDeg > c.spinDeg, 'out-of-plane rotation is the weakly determined one')
})

test('one frame cannot always tell the two solutions apart, and says so: the ratio is near 1 for a small, nearly face-on tag', () => {
  const rand = mulberry32(3)
  const g = gaussian(rand)
  const ratios = (yaw: number, range: number, sigma: number) => {
    const out: number[] = []
    for (let i = 0; i < 80; i++) {
      const clean = projectTagCorners(tagPose({ x: 0, y: 0, z: range }, i * 13, yaw, 0), K, SIZE_M)
      const noisy = clean.map((c) => ({ x: c.x + sigma * g(), y: c.y + sigma * g() })) as unknown as Quad
      const sol = solveTagPose(noisy, K, SIZE_M)!
      out.push(Math.min(sol.ambiguityRatio, 10))
    }
    return out
  }
  const tilted = percentile(ratios(40, 1.5, 0.1), 0.5)
  const nearlyFaceOn = percentile(ratios(8, 3.5, 0.3), 0.5)
  assert.ok(tilted > 3, `a tag tilted 40 degrees at 1.5 m: median ratio ${tilted}`)
  assert.ok(nearlyFaceOn < 2.5, `a tag tilted 8 degrees at 3.5 m: median ratio ${nearlyFaceOn}`)
  assert.ok(tilted > 2 * nearlyFaceOn)
})

// ===============================================================================================
// Camera frame to session frame
// ===============================================================================================

test('a tag pose carried into the session agrees with three.js\'s own camera transform', () => {
  const rand = mulberry32(19)
  for (let i = 0; i < 40; i++) {
    const cam = lookAtPose({ x: (rand() - 0.5) * 6, y: 0.5 + rand() * 2, z: (rand() - 0.5) * 6 }, { x: (rand() - 0.5) * 2, y: 1 + rand(), z: -2 - rand() * 3 })
    const pose = tagPose({ x: (rand() - 0.5) * 0.6, y: (rand() - 0.5) * 0.4, z: 1.5 + rand() * 2 }, rand() * 360, (rand() - 0.5) * 70, (rand() - 0.5) * 50)
    const session = poseToSession({ rotation: pose.rotation, translation: pose.translation }, cam)

    // three.js: a camera Object3D; a point in OpenCV camera axes is (x, -y, -z) in its local axes.
    const camera = new THREE.Object3D()
    camera.position.set(cam.position.x, cam.position.y, cam.position.z)
    camera.quaternion.set(cam.rotation.x, cam.rotation.y, cam.rotation.z, cam.rotation.w)
    camera.updateMatrixWorld(true)
    const expected = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => {
      const tagPoint = { x: sx! * (SIZE_M / 2), y: sy! * (SIZE_M / 2), z: 0 }
      const p = mat3Apply(pose.rotation, tagPoint)
      const cv = { x: p.x + pose.translation.x, y: p.y + pose.translation.y, z: p.z + pose.translation.z }
      return camera.localToWorld(new THREE.Vector3(cv.x, -cv.y, -cv.z))
    })
    const corners = tagCornersInSession(session, SIZE_M)
    for (let c = 0; c < 4; c++) assert.ok(dist3(corners[c]!, expected[c]!) < 1e-9, `corner ${c}: ${dist3(corners[c]!, expected[c]!)} m apart`)
  }
})

test('the module\'s quaternion helpers agree with three.js and round-trip', () => {
  const rand = mulberry32(8)
  for (let i = 0; i < 200; i++) {
    const q = new THREE.Quaternion(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
    const mine = quatToMatrix({ x: q.x, y: q.y, z: q.z, w: q.w })
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q).elements
    // three.js stores column-major; the module's matrices are row-major.
    const rowMajor = [m4[0]!, m4[4]!, m4[8]!, m4[1]!, m4[5]!, m4[9]!, m4[2]!, m4[6]!, m4[10]!]
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(mine[k]! - rowMajor[k]!) < 1e-12)
    const back = matrixToQuat(mine)
    const dot = Math.abs(back.x * q.x + back.y * q.y + back.z * q.z + back.w * q.w)
    assert.ok(Math.abs(dot - 1) < 1e-12, `round trip dot ${dot}`)
  }
})

test('sessionToTagMatrix sends the tag centre to the origin and its corners to (+-h, +-h, 0) in metres, at any session scale', () => {
  const tag = fixedTag(25, 10, { x: 1, y: 1.4, z: -2.5 })
  for (const scale of [1, 1.7]) {
    const m = sessionToTagMatrix({ position: tag.position, rotation: tag.rotation }, scale)
    const apply = (p: { x: number; y: number; z: number }) => ({
      x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
      y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
      z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
    })
    const centre = apply(tag.position)
    assert.ok(norm3(centre) < 1e-12)
    const corners = tagCornersInSession({ position: tag.position, rotation: tag.rotation }, SIZE_M * scale)
    const h = SIZE_M / 2
    const expected = [[-h, h], [h, h], [h, -h], [-h, -h]]
    for (let i = 0; i < 4; i++) {
      const p = apply(corners[i]!)
      assert.ok(Math.abs(p.x - expected[i]![0]!) < 1e-9 && Math.abs(p.y - expected[i]![1]!) < 1e-9 && Math.abs(p.z) < 1e-9, `corner ${i} at (${p.x}, ${p.y}, ${p.z}) scale ${scale}`)
    }
  }
})

// ===============================================================================================
// From rendered frames to a fused pose
// ===============================================================================================

test('a tag at 1, 2 and 3 m, drawn, detected and fused over 12 frames, is recovered to under 1 cm and 0.5 degrees', (t) => {
  const det = new FiducialDetector(CSCAN5_V1)
  const lines: string[] = []
  for (const range of [1, 2, 3]) {
    const tag = fixedTag(20, 10, { x: 0.3, y: 1.3, z: -3 })
    const rand = mulberry32(range * 7 + 3)
    const observations: TagObservation[] = []
    const singlePos: number[] = []
    const singleRot: number[] = []
    for (let i = 0; i < 12; i++) {
      const a = ((i / 11) - 0.5) * ((30 * Math.PI) / 180)
      const cam = lookAtPose(
        { x: tag.position.x + Math.sin(a) * range, y: 1.2 + (rand() - 0.5) * 0.1, z: tag.position.z + Math.cos(a) * range },
        { x: tag.position.x + (rand() - 0.5) * 0.1, y: tag.position.y + (rand() - 0.5) * 0.1, z: tag.position.z },
      )
      const img = renderTag({ dictionary: CSCAN5_V1, id: 17, sizeM: SIZE_M, pose: cvPoseOf(tag, cam), intrinsics: K, noiseSigma: 3, blurSigma: 0.8, seed: 40 + i, supersample: 4 })
      const found = det.detect(img).find((d) => d.id === 17)
      assert.ok(found, `range ${range}, frame ${i}: not detected`)
      observations.push({ corners: found.corners, intrinsics: K, cameraPose: cam, timestampMs: i * 66 })
      const single = poseToSession(solveTagPose(found.corners, K, SIZE_M)!.best, cam)
      const e = poseError(single, tag)
      singlePos.push(e.posM * 100)
      singleRot.push(e.rotDeg)
    }
    const fused = fuseTagObservations(observations, { tagSizeM: SIZE_M })
    assert.equal(fused.status, 'ok', `range ${range}: ${fused.reason}`)
    const e = poseError(fused.pose!, tag)
    lines.push(
      `${range} m: single frames median ${percentile(singlePos, 0.5).toFixed(2)} cm / ${percentile(singleRot, 0.5).toFixed(2)} deg, worst ${Math.max(...singlePos).toFixed(2)} cm / ${Math.max(...singleRot).toFixed(2)} deg; ` +
        `fused ${(e.posM * 100).toFixed(2)} cm / ${e.rotDeg.toFixed(2)} deg, spread ${(fused.poseSpreadM * 100).toFixed(2)} cm / ${fused.rotationSpreadDeg.toFixed(2)} deg, rms ${fused.reprojectionRmsPx.toFixed(3)} px`,
    )
    assert.ok(e.posM < 0.01, `range ${range}: fused position error ${e.posM} m`)
    assert.ok(e.rotDeg < 0.5, `range ${range}: fused rotation error ${e.rotDeg} deg`)
    assert.ok(fused.nFrames >= 10)
    assert.equal(fused.nFramesOffered, 12)
    assert.ok(Math.abs(fused.rangeM - range) < 0.02 * range, `range ${fused.rangeM}`)
    assert.ok(fused.reprojectionRmsPx < 0.15, `reprojection ${fused.reprojectionRmsPx} px`)
    assert.ok(!fused.ambiguous)
    // One frame on its own: the median meets the bar at every range; the worst frame is reported, not hidden.
    assert.ok(percentile(singlePos, 0.5) < 1, `range ${range}: single-frame median ${percentile(singlePos, 0.5)} cm`)
    assert.ok(percentile(singleRot, 0.5) < 0.7, `range ${range}: single-frame median ${percentile(singleRot, 0.5)} deg`)
    assert.ok(Math.max(...singlePos) < 2 && Math.max(...singleRot) < 2.5)
  }
  t.diagnostic(lines.join(' | '))
})

test('on a 1280x960 frame searched at full resolution the same tag is recovered farther out: 3.5 and 4.5 m', () => {
  // The default searches a frame of this size from a halved copy (maxDetectPixels), which finds tags down to about 40 full-size
  // pixels; a 20 cm tag at 4.5 m is 44 px here, so ask for the full-size search.
  const det = new FiducialDetector(CSCAN5_V1, { maxDetectPixels: 1_500_000 })
  for (const range of [3.5, 4.5]) {
    const tag = fixedTag(20, 10, { x: 0.3, y: 1.3, z: -5 })
    const observations: TagObservation[] = []
    for (let i = 0; i < 12; i++) {
      const a = ((i / 11) - 0.5) * ((30 * Math.PI) / 180)
      const cam = lookAtPose({ x: tag.position.x + Math.sin(a) * range, y: 1.2, z: tag.position.z + Math.cos(a) * range }, tag.position)
      const img = renderTag({ dictionary: CSCAN5_V1, id: 5, sizeM: SIZE_M, pose: cvPoseOf(tag, cam), intrinsics: INTRINSICS_1280, noiseSigma: 3, blurSigma: 0.8, seed: 60 + i, supersample: 4 })
      const found = det.detect(img).find((d) => d.id === 5)
      assert.ok(found, `range ${range}, frame ${i}`)
      assert.equal(found.level, 0)
      observations.push({ corners: found.corners, intrinsics: INTRINSICS_1280, cameraPose: cam })
    }
    // The default range gate is in metres, tuned for the 640-wide frame: widen it for this one.
    const fused = fuseTagObservations(observations, { tagSizeM: SIZE_M, maxRangeM: 6 })
    assert.equal(fused.status, 'ok', `${range} m: ${fused.reason}`)
    const e = poseError(fused.pose!, tag)
    // Error grows with range (the tag is fewer pixels across): under 1 cm at 3.5 m, about 1 cm at 4.5 m.
    const bound = range < 4 ? 0.01 : 0.015
    assert.ok(e.posM < bound && e.rotDeg < 0.5, `${range} m: ${(e.posM * 100).toFixed(2)} cm, ${e.rotDeg.toFixed(2)} deg`)
  }
})

// ===============================================================================================
// Fusion
// ===============================================================================================

test('a session whose units are not metres is fused in its own units, with the metric range kept', () => {
  const scale = 1.7
  const { tag, observations } = walk({ range: 2, frames: 14, arcDeg: 40, cornerNoise: 0.08, seed: 4, scale, tag: { ...fixedTag(20, 10), position: { x: 0.3 * scale, y: 1.3 * scale, z: -3 * scale } } })
  const right = fuseTagObservations(observations, { tagSizeM: SIZE_M, sessionUnitsPerMetre: scale })
  assert.equal(right.status, 'ok', right.reason ?? '')
  const e = poseError(right.pose!, tag, scale)
  assert.ok(e.posM < 0.01 && e.rotDeg < 0.5, `${(e.posM * 100).toFixed(2)} cm, ${e.rotDeg.toFixed(2)} deg`)
  assert.ok(Math.abs(right.rangeM - 2) < 0.03, `range ${right.rangeM} m is metric whatever the session counts in`)
  assert.equal(right.sessionUnitsPerMetre, scale)
  // Not telling the fusion about the scale puts the tag where a metre-counting session would have it: far off.
  const wrong = fuseTagObservations(observations, { tagSizeM: SIZE_M })
  assert.ok(wrong.pose === null || dist3(wrong.pose.position, tag.position) / scale > 0.3, 'the scale must matter')
})

test('range gate: frames beyond the maximum are dropped, a result built only from them is refused, the limit can be moved', () => {
  const near = walk({ range: 2, frames: 8, arcDeg: 30, cornerNoise: 0.05, seed: 1 })
  const far = walk({ range: 5, frames: 8, arcDeg: 30, cornerNoise: 0.05, seed: 2 })
  const tooFar = fuseTagObservations(far.observations, { tagSizeM: SIZE_M })
  assert.equal(tooFar.status, 'rejected')
  assert.equal(tooFar.reason, 'range')
  assert.equal(tooFar.nFrames, 0)
  assert.equal(tooFar.pose, null)
  assert.equal(DEFAULT_MAX_RANGE_M, 4)

  const mixed = fuseTagObservations([...near.observations, ...far.observations], { tagSizeM: SIZE_M })
  assert.equal(mixed.status, 'ok', mixed.reason ?? '')
  assert.equal(mixed.nFrames, 8, 'only the near frames count')
  assert.equal(mixed.nFramesOffered, 16)
  assert.equal(mixed.dropped.range, 8)
  assert.ok(Math.abs(mixed.rangeM - 2) < 0.03)

  const widened = fuseTagObservations(far.observations, { tagSizeM: SIZE_M, maxRangeM: 6 })
  assert.equal(widened.status, 'ok', widened.reason ?? '')
  assert.ok(Math.abs(widened.rangeM - 5) < 0.1)

  // Too close: the border of the tag is cut off by the frame in practice, and the gate says so first.
  const close = walk({ range: 0.25, frames: 8, arcDeg: 20, seed: 3, cornerNoise: 0.05 })
  assert.equal(fuseTagObservations(close.observations, { tagSizeM: SIZE_M }).reason, 'range')
})

test('the other per-frame gates name themselves: reprojection, view angle, intrinsics, too few, nothing', () => {
  const good = walk({ range: 2, frames: 10, arcDeg: 30, cornerNoise: 0.05, seed: 5 })
  assert.equal(fuseTagObservations(good.observations, { tagSizeM: SIZE_M }).status, 'ok')

  // Corners that are not even a consistent square: the residual gate.
  // One corner of every frame is 20 px from where a square seen through this lens could put it.
  const garbage = walk({ range: 2, frames: 10, arcDeg: 30, cornerNoise: 0.05, seed: 6 })
  garbage.observations = garbage.observations.map((o) => ({ ...o, corners: [o.corners[0], o.corners[1], { x: o.corners[2].x + 20, y: o.corners[2].y - 15 }, o.corners[3]] as unknown as Quad }))
  const g = fuseTagObservations(garbage.observations, { tagSizeM: SIZE_M })
  assert.equal(g.status, 'rejected')
  assert.equal(g.reason, 'reprojection')
  // Noisy enough that most frames fail it and a few slip through: refused for want of frames, not accepted on those few.
  const noisy = fuseTagObservations(walk({ range: 2, frames: 10, arcDeg: 30, cornerNoise: 4, seed: 6 }).observations, { tagSizeM: SIZE_M })
  assert.equal(noisy.status, 'rejected')
  assert.ok(noisy.reason === 'reprojection' || noisy.reason === 'too-few-frames', String(noisy.reason))
  // Raising the gate is the caller's choice and is honoured.
  assert.notEqual(fuseTagObservations(garbage.observations, { tagSizeM: SIZE_M, maxReprojectionRmsPx: 50 }).reason, 'reprojection')

  // A tag seen almost edge-on.
  const edgeOn = walk({ range: 2, frames: 10, arcDeg: 10, cornerNoise: 0.02, seed: 7, tag: fixedTag(82, 0) })
  assert.equal(fuseTagObservations(edgeOn.observations, { tagSizeM: SIZE_M }).reason, 'view-angle')
  assert.equal(fuseTagObservations(edgeOn.observations, { tagSizeM: SIZE_M, maxViewAngleDeg: 89 }).reason === 'view-angle', false)

  // Corners handed over counter-clockwise (a mirrored image, or another detector's order) describe a tag facing away from the camera.
  const reversed = good.observations.map((o) => ({ ...o, corners: [o.corners[0], o.corners[3], o.corners[2], o.corners[1]] as unknown as Quad }))
  assert.equal(fuseTagObservations(reversed, { tagSizeM: SIZE_M }).reason, 'view-angle')
  const facingAway = solveTagPose(reversed[0]!.corners, K, SIZE_M)!
  assert.ok(facingAway.best.viewAngleDeg > 90, `a reversed quad is seen from ${facingAway.best.viewAngleDeg} degrees`)

  // Intrinsics that disagree with their own frame.
  const badK = good.observations.map((o) => ({ ...o, intrinsics: { ...o.intrinsics, fx: o.intrinsics.fx * 1.5 } }))
  assert.equal(fuseTagObservations(badK, { tagSizeM: SIZE_M }).reason, 'intrinsics')

  const few = fuseTagObservations(good.observations.slice(0, 3), { tagSizeM: SIZE_M })
  assert.equal(few.status, 'rejected')
  assert.equal(few.reason, 'too-few-frames')
  assert.equal(few.nFrames, 3)
  assert.ok(few.pose, 'a rejected result still carries what was computed')
  assert.equal(fuseTagObservations(good.observations.slice(0, 3), { tagSizeM: SIZE_M, minFrames: 3 }).status, 'ok')

  const none = fuseTagObservations([], { tagSizeM: SIZE_M })
  assert.equal(none.reason, 'no-observations')
  assert.equal(none.status, 'rejected')
})

test('frames whose camera pose glitched are rejected by consensus, and the fused pose does not move', () => {
  const clean = walk({ range: 2, frames: 20, arcDeg: 40, cornerNoise: 0.05, seed: 8 })
  const tag = clean.tag
  const observations = clean.observations.map((o, i) =>
    i % 5 === 2 ? { ...o, cameraPose: { ...o.cameraPose, position: { x: o.cameraPose.position.x + 0.15, y: o.cameraPose.position.y, z: o.cameraPose.position.z - 0.1 } } } : o,
  )
  const fused = fuseTagObservations(observations, { tagSizeM: SIZE_M })
  assert.equal(fused.status, 'ok', fused.reason ?? '')
  assert.equal(fused.nFrames, 16, 'the four glitched frames are out')
  const e = poseError(fused.pose!, tag)
  assert.ok(e.posM < 0.005 && e.rotDeg < 0.5, `${(e.posM * 100).toFixed(2)} cm, ${e.rotDeg.toFixed(2)} deg`)
  // The same glitches would have dragged a mean; the median is not moved.
  assert.ok(fused.poseSpreadM < 0.01, `spread ${fused.poseSpreadM} m`)
})

test('the spread fields are the scatter the frames really had: camera position noise and camera rotation noise', () => {
  // Position: isotropic Gaussian noise of 1 cm per axis on the camera, exact corners, 1500 frames so the median is steady.
  const pos = walk({ range: 2, frames: 1500, arcDeg: 40, seed: 9, cameraJitterM: 0.01 })
  const fp = fuseTagObservations(pos.observations, { tagSizeM: SIZE_M, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 })
  // The RMS 3-D distance of Gaussian scatter with sigma 1 cm per axis is sqrt(3) cm = 1.73 cm.
  assert.ok(fp.poseSpreadM > 0.0163 && fp.poseSpreadM < 0.0183, `position spread ${fp.poseSpreadM} m for 1 cm per axis (expected 0.0173)`)
  // Rotation: 0.5 degrees per axis on the camera's orientation is the same scatter on the tag's: sqrt(3) x 0.5 = 0.87 degrees.
  const rot = walk({ range: 2, frames: 1500, arcDeg: 40, seed: 10, cameraRotationJitterDeg: 0.5 })
  const fr = fuseTagObservations(rot.observations, { tagSizeM: SIZE_M, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 })
  assert.ok(fr.rotationSpreadDeg > 0.81 && fr.rotationSpreadDeg < 0.92, `rotation spread ${fr.rotationSpreadDeg} deg for 0.5 deg per axis (expected 0.866)`)
  // Exact data has no scatter at all.
  const exact = fuseTagObservations(walk({ range: 2, frames: 12, arcDeg: 40, seed: 11 }).observations, { tagSizeM: SIZE_M })
  assert.ok(exact.poseSpreadM < 1e-6 && exact.rotationSpreadDeg < 1e-3 && exact.reprojectionRmsPx < 1e-6)
  // And the gate that uses it: 1.7 cm of scatter passes the default 3 cm, 5 cm does not.
  const few = walk({ range: 2, frames: 40, arcDeg: 40, seed: 12, cameraJitterM: 0.01 })
  assert.equal(fuseTagObservations(few.observations, { tagSizeM: SIZE_M, maxRotationSpreadDeg: 90 }).status, 'ok')
  const loud = walk({ range: 2, frames: 40, arcDeg: 40, seed: 12, cameraJitterM: 0.03 })
  assert.equal(fuseTagObservations(loud.observations, { tagSizeM: SIZE_M, maxRotationSpreadDeg: 90 }).reason, 'spread')
})

test('the mirror solution: a static camera is never silently wrong, and a moving one resolves it', (t) => {
  // A tag turned only 8 degrees from face-on, 3 m away, with corner noise of 0.2 px: single frames flip between the two solutions.
  const tag = fixedTag(8, 0, { x: 0, y: 1.3, z: -3 })
  const staticOutcomes: string[] = []
  const movingOutcomes: string[] = []
  let silentlyWrong = 0
  let refused = 0
  let resolved = 0
  const seeds = [1, 2, 3, 4, 5, 6]
  for (const seed of seeds) {
    const still = fuseTagObservations(walk({ tag, range: 3, frames: 20, arcDeg: 0, cornerNoise: 0.2, seed }).observations, { tagSizeM: SIZE_M })
    staticOutcomes.push(`${still.status}${still.reason ? `:${still.reason}` : ''}`)
    if (still.status === 'rejected') refused++
    if (still.status === 'ok' && poseError(still.pose!, tag).rotDeg > 2) silentlyWrong++

    const moving = fuseTagObservations(walk({ tag, range: 3, frames: 20, arcDeg: 80, cornerNoise: 0.2, seed }).observations, { tagSizeM: SIZE_M })
    movingOutcomes.push(`${moving.status}${moving.reason ? `:${moving.reason}` : ''}`)
    if (moving.status === 'ok' && poseError(moving.pose!, tag).rotDeg < 1) resolved++
    assert.ok(!moving.ambiguous, `seed ${seed}: moving camera still ambiguous`)
  }
  t.diagnostic(`static: ${staticOutcomes.join(', ')} | moving: ${movingOutcomes.join(', ')}`)
  assert.equal(silentlyWrong, 0, 'a static view of a nearly face-on tag was accepted with a rotation error over 2 degrees')
  assert.ok(refused >= 5, `only ${refused} of ${seeds.length} static runs were refused`)
  assert.ok(resolved >= 4, `camera motion resolved ${resolved} of ${seeds.length}`)

  // Noisier and farther (3.8 m, 0.35 px): the two hypotheses stay equally good, and that is named.
  let named = 0
  for (const seed of [1, 2, 3, 4]) {
    const f = fuseTagObservations(walk({ tag, range: 3.8, frames: 20, arcDeg: 0, cornerNoise: 0.35, seed }).observations, { tagSizeM: SIZE_M })
    assert.equal(f.status, 'rejected', `seed ${seed}: a static, noisy, far view was accepted`)
    if (f.reason === 'ambiguous') {
      named++
      assert.equal(f.ambiguous, true)
    }
  }
  assert.ok(named >= 2, `the ambiguity was named in ${named} of 4 runs`)
})

test('consensus between the two solutions keeps the frames whose own best fit was the mirror one: scatter and tail error over 30 noisy static runs', (t) => {
  // A tag turned 15 degrees, 3.8 m away, corner noise 0.35 px, a camera that does not move: in many frames the mirror solution fits
  // as well as the true one, and picking the lower residual alone scatters the result. Letting each frame take the candidate nearer
  // what the others agree on pulls the scatter in. The gates are opened so that what is measured is the scatter, not a refusal.
  const tag = fixedTag(15, 0, { x: 0, y: 1.3, z: -3 })
  const spread: number[] = []
  const error: number[] = []
  for (let seed = 1; seed <= 30; seed++) {
    const f = fuseTagObservations(walk({ tag, range: 3.8, frames: 20, arcDeg: 0, cornerNoise: 0.35, seed }).observations, { tagSizeM: SIZE_M, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 })
    assert.ok(f.pose, `seed ${seed}: ${f.reason}`)
    spread.push(f.rotationSpreadDeg)
    error.push(poseError(f.pose, tag).rotDeg)
  }
  t.diagnostic(`rotation spread median ${percentile(spread, 0.5).toFixed(2)} deg, error median ${percentile(error, 0.5).toFixed(2)} p90 ${percentile(error, 0.9).toFixed(2)} deg`)
  assert.ok(percentile(spread, 0.5) < SPREAD_BOUND_DEG, `median rotation spread ${percentile(spread, 0.5)} deg`)
  assert.ok(percentile(error, 0.9) < ERROR_BOUND_DEG, `p90 rotation error ${percentile(error, 0.9)} deg`)
})

test('intrinsics sensitivity: the scale of the pose is the focal length and the printed size speaking', () => {
  const pose = tagPose({ x: 0.1, y: 0.05, z: 2 }, 15, 20, 5)
  const corners = projectTagCorners(pose, K, SIZE_M) as unknown as Quad
  const truth = solveTagPose(corners, K, SIZE_M)!.best
  const withK = (k: CameraIntrinsics) => solveTagPose(corners, k, SIZE_M)!.best

  // A focal length that is off by f is a range that is off by f.
  for (const factor of [0.95, 0.99, 1.01, 1.05]) {
    const s = withK({ ...K, fx: K.fx * factor, fy: K.fy * factor })
    assert.ok(Math.abs(s.rangeM / truth.rangeM / factor - 1) < 0.004, `focal x${factor}: range ratio ${s.rangeM / truth.rangeM}`)
    assert.ok(rotationAngleBetweenDeg(s.rotation, truth.rotation) < 3, 'the rotation barely moves')
  }
  // A principal point that is off by 10 px moves the tag sideways by 10 px x range / focal = 4 cm at 2 m.
  const shifted = withK({ ...K, cx: K.cx + 10 })
  const lateral = truth.translation.x - shifted.translation.x
  assert.ok(Math.abs(lateral - (10 * 2) / 500) < 0.004, `a 10 px principal-point error moved the tag ${lateral} m, expected 0.04 m`)
  assert.ok(Math.abs(shifted.translation.z - truth.translation.z) < 0.01)

  // The printed size is exactly a scale on the translation, and changes nothing else.
  const bigger = solveTagPose(corners, K, SIZE_M * 1.01)!.best
  assert.ok(dist3({ x: bigger.translation.x / 1.01, y: bigger.translation.y / 1.01, z: bigger.translation.z / 1.01 }, truth.translation) < 1e-9)
  assert.ok(rotationAngleBetweenDeg(bigger.rotation, truth.rotation) < 1e-6)
  assert.ok(Math.abs(bigger.reprojectionRmsPx - truth.reprojectionRmsPx) < 1e-9)

  // The same effects arrive in a fused pose, in session units.
  const w = walk({ range: 2, frames: 12, arcDeg: 30, seed: 3, cornerNoise: 0.03 })
  const ok = fuseTagObservations(w.observations, { tagSizeM: SIZE_M })
  const off = fuseTagObservations(w.observations.map((o) => ({ ...o, intrinsics: { ...K, fx: K.fx * 1.03, fy: K.fy * 1.03 } })), { tagSizeM: SIZE_M })
  const dRange = Math.abs(off.rangeM / ok.rangeM - 1.03)
  assert.ok(dRange < 0.006, `a 3 % focal error is a ${(off.rangeM / ok.rangeM - 1) * 100} % range error`)
})

test('the tag as a ruler: the session scale is recovered from a walk, refused for a static camera, and robust to a bad frame', () => {
  const k = 1.37
  const tag = { ...fixedTag(20, 10), position: { x: 0.3 * k, y: 1.3 * k, z: -3 * k } }
  const walkOpts = { tag, range: 2, frames: 25, arcDeg: 60, cornerNoise: 0.08, seed: 13, scale: k } as const
  const { observations } = walk(walkOpts)
  const est = estimateSessionScale(observations, SIZE_M)
  assert.ok(est, 'no estimate')
  assert.ok(Math.abs(est.sessionUnitsPerMetre / k - 1) < 0.01, `recovered ${est.sessionUnitsPerMetre} for ${k}`)
  assert.ok(est.baselineM > 1.5, `baseline ${est.baselineM} m`)
  assert.ok(est.nFrames >= 22 && est.nFrames <= 25, `${est.nFrames} frames used`)

  // A frame whose camera pose is far wrong does not move it.
  const spoiled = observations.map((o, i) => (i === 7 ? { ...o, cameraPose: { ...o.cameraPose, position: { x: o.cameraPose.position.x + 1, y: o.cameraPose.position.y, z: o.cameraPose.position.z } } } : o))
  const est2 = estimateSessionScale(spoiled, SIZE_M)!
  assert.ok(Math.abs(est2.sessionUnitsPerMetre / k - 1) < 0.015, `with a bad frame: ${est2.sessionUnitsPerMetre}`)

  // Frames beyond the range gate are not used, as in the fusion: a walk made only of them has no estimate.
  assert.equal(estimateSessionScale(walk({ ...walkOpts, range: 6 }).observations, SIZE_M), null)

  // A camera that did not move cannot tell a near small thing from a far big one.
  assert.equal(estimateSessionScale(walk({ ...walkOpts, arcDeg: 0 }).observations, SIZE_M), null)
  // One that moved only a little cannot either, and the answer says so by being absent.
  assert.equal(estimateSessionScale(walk({ ...walkOpts, arcDeg: 8 }).observations, SIZE_M), null)
  assert.equal(estimateSessionScale(observations.slice(0, 2), SIZE_M), null)
})

test('the fused pose does not depend on the order the frames arrive in', () => {
  const w = walk({ range: 2, frames: 12, arcDeg: 30, cornerNoise: 0.05, seed: 14 })
  const forward = fuseTagObservations(w.observations, { tagSizeM: SIZE_M })
  const shuffled = fuseTagObservations([...w.observations].reverse(), { tagSizeM: SIZE_M })
  // The medians and the medoid do not care about order; the quaternion sum may differ in the last bits.
  assert.ok(dist3(shuffled.pose!.position, forward.pose!.position) < 1e-12)
  assert.ok(rotationAngleBetweenDeg(quatToMatrix(shuffled.pose!.rotation), quatToMatrix(forward.pose!.rotation)) < 1e-6)
  assert.equal(shuffled.nFrames, forward.nFrames)
  assert.ok(Math.abs(shuffled.poseSpreadM - forward.poseSpreadM) < 1e-12)
  assert.ok(Math.abs(shuffled.rotationSpreadDeg - forward.rotationSpreadDeg) < 1e-9)
})

// ===============================================================================================
// Corners that were not fitted well
// ===============================================================================================

const GOOD_FIT = { refined: true, edgeRmsPx: 0.1, edgeInlierFraction: 0.98 }
const NOT_FITTED = { refined: false, edgeRmsPx: null, edgeInlierFraction: null }

test('observationFromDetection carries the fit fields with the corners, and the fusion keeps frames whose corners were fitted and drops those whose were not', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const pose = tagPose({ x: 0.04, y: -0.02, z: 1.6 }, 20, 15, 5)
  const detection = det.detect(renderTag({ dictionary: CSCAN5_V1, id: 12, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 1, blurSigma: 0.6, seed: 3 }))[0]!
  const cam = lookAtPose({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.2, z: -2 })
  const o = observationFromDetection(detection, K, cam, 120)
  assert.deepEqual(o.corners, detection.corners)
  assert.deepEqual(o.cornerFit, { refined: true, edgeRmsPx: detection.edgeRmsPx, edgeInlierFraction: detection.edgeInlierFraction })
  assert.equal(o.timestampMs, 120)
  assert.equal(o.intrinsics, K)
  assert.equal('timestampMs' in observationFromDetection(detection, K, cam), false, 'a time that was not given is not invented')
  assert.ok(o.cornerFit!.refined && o.cornerFit!.edgeRmsPx! < DEFAULT_MAX_EDGE_RMS_PX && o.cornerFit!.edgeInlierFraction! >= DEFAULT_MIN_EDGE_INLIER_FRACTION)

  // Every frame unfitted: nothing is fused, and the reason says why, not "reprojection".
  const w = walk({ range: 2, frames: 12, arcDeg: 30, cornerNoise: 0.05, seed: 31 })
  const allUnfitted = fuseTagObservations(w.observations.map((x) => ({ ...x, cornerFit: NOT_FITTED })), { tagSizeM: SIZE_M })
  assert.equal(allUnfitted.status, 'rejected')
  assert.equal(allUnfitted.reason, 'corner-fit')
  assert.equal(allUnfitted.nFrames, 0)
  assert.equal(allUnfitted.pose, null)
  assert.deepEqual(allUnfitted.dropped, { intrinsics: 0, cornerFit: 12, range: 0, viewAngle: 0, reprojection: 0, unsolved: 0 })
  // The same frames with a good fit, and the same frames with no fit stated at all (corners from elsewhere), are fused.
  assert.equal(fuseTagObservations(w.observations.map((x) => ({ ...x, cornerFit: GOOD_FIT })), { tagSizeM: SIZE_M }).status, 'ok')
  assert.equal(fuseTagObservations(w.observations, { tagSizeM: SIZE_M }).status, 'ok')
})

test('frames with displaced corners that say so are dropped and cannot move the pose; the same frames without the flag move it', () => {
  // 24 frames of a walk with exact corners, and in every second one a corner 2.4 px out (2 across, 1.4 down): what a covered edge does. It
  // is a tilt of the tag to a planar solve, so it passes the reprojection gate, and it is the same in every frame it appears in, so the
  // consensus between frames does not throw it out: half of the frames agree with each other on a pose that is wrong.
  const { tag, observations } = walk({ range: 2, frames: 24, arcDeg: 40, cornerNoise: 0.03, seed: 32 })
  const displaced = observations.map((o, i) => (i % 2 === 0 ? { ...o, corners: [{ x: o.corners[0].x + 2, y: o.corners[0].y + 1.4 }, o.corners[1], o.corners[2], o.corners[3]] as unknown as Quad } : o))
  const flagged = displaced.map((o, i) => ({ ...o, cornerFit: i % 2 === 0 ? NOT_FITTED : GOOD_FIT }))
  const open = { tagSizeM: SIZE_M, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 }
  const fusedFlagged = fuseTagObservations(flagged, open)
  assert.equal(fusedFlagged.status, 'ok', fusedFlagged.reason ?? '')
  assert.equal(fusedFlagged.nFrames, 12, 'exactly the displaced frames are out')
  assert.equal(fusedFlagged.dropped.cornerFit, 12, 'and they are counted as left out for their corner fit')
  assert.equal(fusedFlagged.nFramesOffered - fusedFlagged.nFrames, Object.values(fusedFlagged.dropped).reduce((a, b) => a + b, 0), 'every frame that was offered and not kept is accounted for')
  const e = poseError(fusedFlagged.pose!, tag)
  assert.ok(e.posM < 0.003 && e.rotDeg < 0.3, `${(e.posM * 100).toFixed(2)} cm, ${e.rotDeg.toFixed(2)} deg`)

  // Without the flag the displaced frames are fused: they pass every geometric gate, and the pose is wrong by degrees.
  const unflagged = fuseTagObservations(displaced, open)
  assert.ok(unflagged.pose, 'the displaced frames pass the reprojection gate on their own')
  assert.ok(unflagged.nFrames >= 22, `${unflagged.nFrames} frames fused without the flag`)
  const eu = poseError(unflagged.pose!, tag)
  assert.ok(eu.rotDeg > 1 && eu.rotDeg > 4 * e.rotDeg, `unflagged ${(eu.posM * 100).toFixed(2)} cm ${eu.rotDeg.toFixed(2)} deg against flagged ${(e.posM * 100).toFixed(2)} cm ${e.rotDeg.toFixed(2)} deg`)
  assert.ok(fusedFlagged.rotationSpreadDeg < unflagged.rotationSpreadDeg / 2, 'the displaced frames widen the spread')
})

test('the edge-scatter and edge-share gates: a frame outside either is dropped, and each limit is the caller\'s to move', () => {
  assert.equal(DEFAULT_MAX_EDGE_RMS_PX, 1)
  assert.equal(DEFAULT_MIN_EDGE_INLIER_FRACTION, 0.6)
  const w = walk({ range: 2, frames: 14, arcDeg: 30, cornerNoise: 0.05, seed: 33 })
  const fit = (f: TagObservation['cornerFit']) => w.observations.map((o, i) => ({ ...o, cornerFit: i < 5 ? f : GOOD_FIT }))
  // Five of fourteen frames scatter by 1.4 px about their edges: out, with the others fused.
  const noisy = fuseTagObservations(fit({ refined: true, edgeRmsPx: 1.4, edgeInlierFraction: 0.95 }), { tagSizeM: SIZE_M })
  assert.equal(noisy.status, 'ok')
  assert.equal(noisy.nFrames, 9)
  assert.equal(fuseTagObservations(fit({ refined: true, edgeRmsPx: 1.4, edgeInlierFraction: 0.95 }), { tagSizeM: SIZE_M, maxEdgeRmsPx: 2 }).nFrames, 14)
  // Five frames on which less than 60 % of an edge's samples lay on its line: out.
  const thin = fuseTagObservations(fit({ refined: true, edgeRmsPx: 0.1, edgeInlierFraction: 0.55 }), { tagSizeM: SIZE_M })
  assert.equal(thin.nFrames, 9)
  assert.equal(fuseTagObservations(fit({ refined: true, edgeRmsPx: 0.1, edgeInlierFraction: 0.55 }), { tagSizeM: SIZE_M, minEdgeInlierFraction: 0.5 }).nFrames, 14)
  // A frame that says it is refined but gives no numbers cannot be trusted either, and numbers do not make a frame refined that says it is not.
  assert.equal(fuseTagObservations(fit({ refined: true, edgeRmsPx: null, edgeInlierFraction: null }), { tagSizeM: SIZE_M }).nFrames, 9)
  assert.equal(fuseTagObservations(fit({ refined: false, edgeRmsPx: 0.1, edgeInlierFraction: 0.98 }), { tagSizeM: SIZE_M }).nFrames, 9)
})

test('the tag as a ruler leaves out frames whose corners were not fitted: bad corners in half the frames do not change the scale', () => {
  const k = 1.37
  const tag = { ...fixedTag(20, 10), position: { x: 0.3 * k, y: 1.3 * k, z: -3 * k } }
  const { observations } = walk({ tag, range: 2, frames: 26, arcDeg: 60, cornerNoise: 0.05, seed: 34, scale: k })
  // Every other frame has one corner 6 px out (the reprojection gate would let some through) and says it was not fitted.
  const marked = observations.map((o, i) => (i % 2 === 0 ? { ...o, cornerFit: NOT_FITTED, corners: [{ x: o.corners[0].x + 6, y: o.corners[0].y - 5 }, o.corners[1], o.corners[2], o.corners[3]] as unknown as Quad } : { ...o, cornerFit: GOOD_FIT }))
  const est = estimateSessionScale(marked, SIZE_M)
  assert.ok(est, 'no estimate')
  assert.ok(Math.abs(est.sessionUnitsPerMetre / k - 1) < 0.015, `recovered ${est.sessionUnitsPerMetre} for ${k}`)
  assert.equal(est.nFrames, 13)
})

test('end to end: tape over half of an edge makes a frame unusable for the pose, the others carry it', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const tag = fixedTag(20, 10, { x: 0.3, y: 1.3, z: -3 })
  const half = SIZE_M / 2
  const tape = patchArtwork({ x0: -half + 0.25 * SIZE_M, x1: -half + 0.75 * SIZE_M, y0: half - 0.4 * (SIZE_M / 7), y1: half + 0.9 * (SIZE_M / 7) }, 225)
  const observations: TagObservation[] = []
  let covered = 0
  for (let i = 0; i < 12; i++) {
    const a = ((i / 11) - 0.5) * ((30 * Math.PI) / 180)
    const cam = lookAtPose({ x: tag.position.x + Math.sin(a) * 1.6, y: 1.2, z: tag.position.z + Math.cos(a) * 1.6 }, tag.position)
    const pose = cvPoseOf(tag, cam)
    const items = [{ artwork: dictionaryTagArtwork(CSCAN5_V1, 17, SIZE_M), pose }, ...(i % 4 === 1 ? [{ artwork: tape, pose }] : [])]
    const found = det.detect(renderFrame({ width: 640, height: 480, intrinsics: K, items, noiseSigma: 3, blurSigma: 0.8, seed: 80 + i, supersample: 3 })).find((d) => d.id === 17)
    assert.ok(found, `frame ${i}: not read`)
    if (i % 4 === 1) {
      covered++
      assert.equal(found.refined, false, `frame ${i}: half an edge covered and the corners were called refined`)
    } else {
      assert.equal(found.refined, true, `frame ${i}: a clean frame was not refined`)
    }
    observations.push(observationFromDetection(found, K, cam, i * 66))
  }
  assert.equal(covered, 3)
  const fused = fuseTagObservations(observations, { tagSizeM: SIZE_M })
  assert.equal(fused.status, 'ok', fused.reason ?? '')
  assert.equal(fused.nFrames, 9, 'the three covered frames are out and the nine clean ones are in')
  assert.equal(fused.nFramesOffered, 12)
  const e = poseError(fused.pose!, tag)
  assert.ok(e.posM < 0.01 && e.rotDeg < 0.5, `${(e.posM * 100).toFixed(2)} cm, ${e.rotDeg.toFixed(2)} deg`)
})
