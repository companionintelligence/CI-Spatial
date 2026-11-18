/**
 * What each thing the origin shows is drawn from, so that they cannot contradict each other.
 *
 * A return visit draws, beside the committed origin, the Place's STORED origin: "the gap between the two decals is the
 * residual". And, since the constellation fit (WP-04b), the rings where each stored point lands. Both are the Place's
 * stored points carried into this session through the inverse of the visit's `sessionToProject`. For a visit compared
 * by distance that matrix is the two-point transform of the tapped pair, so the stored landmark is the landmark the
 * person tapped and the stored heading point is the stored distance along the baseline they tapped, and the stored
 * decal was drawn that way, straight from the pair. For a visit that FITTED three points the matrix is the fit's:
 * aligned on the mean position and mean height of all three taps, not on the landmark. The rings followed it and the
 * stored decal did not, so on every verified return visit (the default one, since a check point is stored by default)
 * the scene showed the stored landmark in two places and the "residual" between the two decals was not the residual
 * the rings and the status line reported.
 *
 * The oracle for "where the stored points land" is the rings the same commit draws (src/ar/constellation-ghosts.ts, which
 * `checkThreePoint` in wp-calibration-characterisation.test.ts holds to the inverse of the visit's own matrix) and the
 * per-point residuals the record keeps (`calibration.fit.perPoint`). Those are computed by the fit, by carrying each tap
 * FORWARD onto its stored point, and not by anything the scene draws. The stored decal is drawn the other way, by carrying
 * the stored points BACK through the inverse, so its gap from the committed decal equals a residual only if it was carried
 * through the right matrix: the two meet only by the transform being rigid.
 *
 * Heights. Three numbers read like "the floor" and are not one number: the height the grid was drawn at while the
 * points were placed (the landmark's own tap), the height the frame takes as its floor (the landmark DATUM,
 * `landmarkDatum()` in src/ar/ground-gate.ts: the mean of that tap and the fitted floor when they agree to 5 cm), and,
 * for a fit, the floor the matrix sends to project y = 0 (the mean of three heights). The record's `groundY`, the origin
 * decal and the stored decal are the datum; the kept grid was left at the tap, up to 2.5 cm away. The kept grid is the
 * datum too now, and the test below pins that all four agree.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/origin_decal_truth.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { GHOST_NAME } from '../../../src/ar/constellation-ghosts.ts'
import {
  calibrateFirst,
  constellation,
  nudge,
  revisit,
  startFlow,
  type Enu,
  type Spots,
} from './origin_rig.ts'

const LANDMARK_AT: Enu = { east: 1.5, north: -2, up: -1.2 }
const SPOTS: Spots = constellation(LANDMARK_AT, 70, 2.4)
const FIRST = { psi: 20, turn: 10, down: 30 }
const SECOND = { psi: 215, turn: -35, down: 20 }

const ORIGIN = 'calibration origin'
const STORED_ORIGIN = 'calibration stored origin'
const FLOOR = 'calibration floor plane'

/** A decal's arrow tip in world space, horizontal part. The arrow's geometry is single precision, so it is read to 1e-5. */
function arrowTip(decal: THREE.Object3D): { x: number; z: number } {
  decal.updateMatrixWorld(true)
  const arrow = decal.getObjectByName('origin heading arrow') as THREE.LineSegments
  assert.ok(arrow, `${decal.name} has its arrow`)
  const positions = arrow.geometry.getAttribute('position')
  const tip = new THREE.Vector3(positions.getX(1), positions.getY(1), positions.getZ(1)).applyMatrix4(arrow.matrixWorld)
  return { x: tip.x, z: tip.z }
}

const ring = (scene: THREE.Scene, role: string): THREE.Object3D => {
  const found = scene.children.find((child) => child.name === GHOST_NAME && child.userData['role'] === role)
  assert.ok(found, `a ring for the ${role}`)
  return found
}

const near = (actual: number, expected: number, tolerance: number, message: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not ${expected} (within ${tolerance})`)

interface FitRecord { perPoint: Array<{ residualM: number }> }

test('on a fitted return visit the stored origin is where the rings say the stored landmark and heading point are', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  // A return visit whose three taps miss their spots by a few centimetres each: a fit, with residuals the person can see.
  const tapped: Spots = {
    landmark: nudge(SPOTS.landmark, 0.05, -0.03),
    marker: nudge(SPOTS.marker, -0.06, 0.04),
    check: nudge(SPOTS.check, 0.03, 0.06),
  }
  const { result } = await revisit(t, { ...SECOND, scene }, frame, tapped)
  const fit = (result.calibration as { fit?: FitRecord }).fit
  assert.ok(fit, 'three points were fitted')
  const residuals = fit.perPoint.map((point) => point.residualM)
  assert.ok(residuals[0]! > 0.02 && residuals[1]! > 0.02, `the taps leave residuals worth seeing (${residuals.map((r) => (r * 100).toFixed(1)).join(', ')} cm)`)

  const stored = scene.getObjectByName(STORED_ORIGIN)
  const committed = scene.getObjectByName(ORIGIN)
  assert.ok(stored && committed)

  // The stored landmark is where the landmark ring is, and the arrowhead is where the heading ring is.
  const landmarkRing = ring(scene, 'landmark')
  const headingRing = ring(scene, 'heading')
  near(stored.position.x, landmarkRing.position.x, 1e-9, 'stored origin x against the landmark ring')
  near(stored.position.z, landmarkRing.position.z, 1e-9, 'stored origin z against the landmark ring')
  const storedTip = arrowTip(stored)
  near(storedTip.x, headingRing.position.x, 1e-5, 'stored arrowhead x against the heading ring')
  near(storedTip.z, headingRing.position.z, 1e-5, 'stored arrowhead z against the heading ring')

  // So the gap between the two decals is the residual the fit records, point by point: at the origin and at the arrowhead.
  const committedTip = arrowTip(committed)
  near(Math.hypot(stored.position.x - committed.position.x, stored.position.z - committed.position.z), residuals[0]!, 1e-9, 'the gap at the origin is the landmark\'s residual')
  near(Math.hypot(storedTip.x - committedTip.x, storedTip.z - committedTip.z), residuals[1]!, 1e-5, 'the gap at the arrowhead is the heading marker\'s residual')
})

test('on a visit compared by distance the stored origin is still the stored pair along the baseline that was tapped', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  // Two taps only (the check point skipped): the pair is compared by its spacing, and is its own frame.
  const tapped: Spots = { ...SPOTS, landmark: nudge(SPOTS.landmark, 0.02, 0.01), marker: nudge(SPOTS.marker, -0.02, 0.015) }
  const { flow } = await revisit(t, { ...SECOND, scene }, frame, tapped, { skipCheck: true })

  const stored = scene.getObjectByName(STORED_ORIGIN)!
  const committed = scene.getObjectByName(ORIGIN)!
  const landmark = flow.physical(tapped.landmark)
  const marker = flow.physical(tapped.marker)
  near(stored.position.x, landmark.x, 1e-12, 'the stored landmark is the landmark that was tapped: x')
  near(stored.position.z, landmark.z, 1e-12, 'the stored landmark is the landmark that was tapped: z')
  // The stored heading point: the stored separation (2.4 m, from the first calibration) along the tapped baseline.
  const length = Math.hypot(marker.x - landmark.x, marker.z - landmark.z)
  const along = 2.4 / length
  const storedTip = arrowTip(stored)
  near(storedTip.x, landmark.x + (marker.x - landmark.x) * along, 1e-5, 'the stored heading point: x')
  near(storedTip.z, landmark.z + (marker.z - landmark.z) * along, 1e-5, 'the stored heading point: z')
  // And the committed arrow ends on the heading marker that was tapped.
  const committedTip = arrowTip(committed)
  near(committedTip.x, marker.x, 1e-5, 'the committed arrowhead is on the heading marker: x')
  near(committedTip.z, marker.z, 1e-5, 'the committed arrowhead is on the heading marker: z')
})

test('the origin decal, the stored origin, the kept grid and the recorded ground height are one number, the landmark datum', async (t) => {
  // The fitted floor is at -1.2 and well supported; the person's tap measures 4 cm above it. The two agree to 5 cm, so the
  // frame's floor is their mean, -1.18, and not the tap's -1.16 that the grid was drawn at while the points were placed.
  const reliableFloor = () => ({ y: -1.2, locked: true, residualM: 0.005, inlierCount: 200 })
  const scene = new THREE.Scene()
  const { frame, result } = await calibrateFirst(t, { ...FIRST, scene, ground: reliableFloor, sampledTaps: { aboveM: 0.04 } }, SPOTS)
  const datum = -1.18
  near((result.calibration as { groundY: number }).groundY, datum, 1e-9, 'the record\'s groundY is the datum')
  near(scene.getObjectByName(ORIGIN)!.position.y, datum, 1e-9, 'the committed origin sits on the datum')
  near(scene.getObjectByName(FLOOR)!.position.y, datum, 1e-9, 'the kept grid sits on the datum, not on the tap')

  // A return visit draws the stored origin on the same plane.
  await revisit(t, { ...SECOND, scene, ground: reliableFloor, sampledTaps: { aboveM: 0.04 } }, frame, SPOTS)
  const second = scene.getObjectByName(STORED_ORIGIN)!
  near(second.position.y, datum, 1e-9, 'the stored origin sits on the datum')
  near(scene.getObjectByName(ORIGIN)!.position.y, datum, 1e-9, 'the committed origin of the second visit')
  near(scene.getObjectByName(FLOOR)!.position.y, datum, 1e-9, 'the kept grid of the second visit')
})

test('with no fitted floor to back it the datum is the tap itself, and the grid, the decal and the record all say so', async (t) => {
  const scene = new THREE.Scene()
  const flow = await startFlow(t, { ...FIRST, scene, sampledTaps: { aboveM: 0.04 } })
  await flow.placeLandmark(flow.physical(SPOTS.landmark))
  await flow.tap(flow.physical(SPOTS.marker))
  flow.skipCheckPoint()
  flow.press('project-calibration-commit')
  const result = await flow.finish()
  assert.ok(result)
  const tapY = -1.2 + 0.04
  near((result.calibration as { groundY: number }).groundY, tapY, 1e-9, 'groundY')
  near(scene.getObjectByName(ORIGIN)!.position.y, tapY, 1e-9, 'origin')
  near(scene.getObjectByName(FLOOR)!.position.y, tapY, 1e-9, 'grid')
})

test('on a fitted visit the floor the matrix keeps is the datum less the landmark\'s height residual, which the record carries', async (t) => {
  // The Place's first calibration: a well supported floor at -1.2 and taps 4 cm above it. The landmark's datum is -1.18,
  // and the heading marker and check point were tapped at -1.16, so the check point is stored 2 cm above the landmark.
  const reliableFloor = () => ({ y: -1.2, locked: true, residualM: 0.005, inlierCount: 200 })
  const { frame } = await calibrateFirst(t, { ...FIRST, ground: reliableFloor, sampledTaps: { aboveM: 0.04 } }, SPOTS)
  // A return visit that reads its taps at the floor, -1.2, with no sampler: its landmark datum is its own tap, and its three
  // points are level, so the check point sits 2 cm lower than the one stored. The fit finds the floor in the mean of the three.
  const { result } = await revisit(t, SECOND, frame, SPOTS)
  const calibration = result.calibration as { groundY: number; sessionToProject: number[]; fit?: { perPoint: Array<{ dy: number }> } }
  assert.ok(calibration.fit, 'three points were fitted')
  // A rigid fit leaves heights alone (the matrix's y scale is 1), so project y = 0 is the session height minus nothing but the
  // translation: the floor it sends to y = 0 is -m[13].
  assert.equal(calibration.sessionToProject[5], 1)
  const matrixFloor = -calibration.sessionToProject[13]!
  near(matrixFloor, calibration.groundY - calibration.fit.perPoint[0]!.dy, 1e-9, 'the matrix\'s floor is the datum less the landmark\'s own height residual')
  assert.ok(Math.abs(matrixFloor - calibration.groundY) > 0.005, `the two are different numbers (${((matrixFloor - calibration.groundY) * 1000).toFixed(1)} mm apart), which is why groundY is called a datum`)
})
