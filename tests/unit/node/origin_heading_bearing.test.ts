/**
 * The HUD's frame-heading needle must show the arrow's compass bearing, and must agree with the two other places
 * the same commit says it: the north tick on the decal, and the record's `projectBearingDeg`. The record agrees on a
 * first calibration and on a return visit compared by distance. On a return visit that fitted three points it follows
 * the fit's heading and not the arrow's, so there, under the current rule, the two differ by the fit's heading
 * residual (the last test). Under `?bearing=1` a fitted record is not held to the needle at all: see below.
 *
 * It did not. `originHeadingBearingDeg` returned the arrow's yaw minus north's yaw, which is the arrow's bearing
 * under the OLD sign rule (a session direction at yaw `y` has bearing `B_Z + y`). The rule was corrected to
 * `B_Z - y` (src/world/geo.ts, `sessionFrameBearingDeg`), the north tick moved to `+B_Z` with it, and the HUD formula
 * was left behind: the needle showed the MIRROR of the arrow's bearing, 360 minus the right number, and was right
 * only for an arrow that lay due north or due south. The test that should have caught it
 * (origin_decal.test.ts, "the arrow bearing is its clockwise angle from the north tick") measured "clockwise" with
 * `atan2(x, z)` yaws, which grow COUNTER-clockwise seen from above, so it pinned the mirror.
 *
 * So nothing here asks `geo.ts` what a bearing is. Three independent measures are used instead:
 *
 *  1. THE PICTURE. The real decal is built, a real three.js camera is put above it looking straight down, and the
 *     clockwise angle on the screen from the north tick to the arrow is read off the projected points. A compass
 *     bearing is the angle clockwise from north seen from above, and the tick is what marks north on the floor, so
 *     the needle must show exactly that angle. No yaw convention enters.
 *  2. THE WORLD. tests/unit/deno/physical_oracle.ts (it imports nothing from src/) says where north lies in a
 *     session that started facing some bearing, and which session direction a given true bearing is. The arrow is
 *     set at a true bearing the test chose, so the right answer is the input.
 *  3. THE RECORD. The real modal is driven end to end. Its HUD value, the `projectBearingDeg` on the record it
 *     returns, the true bearing of the baseline the person walked, and the picture must all be the same number.
 *
 * The record's own formula (`projectBearingDeg`, which this change also edited) is held to the same physical model, in the
 * section after the world's.
 *
 * A bearing is in [0, 360). Every comparison with a measure above is circular (359 and -1 are 2 apart, as they should
 * be for two bearings), so none of them can tell -37 from 323, and a formula that lost its `normaliseBearingDeg` would
 * pass them all. The range is asserted beside each, and the fold is pinned directly, under each rule, by cases whose raw
 * difference is below zero and whose answers are read off a clock face and not out of the formula.
 *
 * `?bearing=1` keeps the old rule as a whole, so under it the needle reads the old rule's number: the arrow's yaw
 * measured from the old rule's north, which is the record's `projectBearingDeg` under that rule too (a record
 * made under the switch follows the rule it is stamped with, as its tick does). That rule is physically wrong (the
 * picture it draws is the mirror of its own number), which is why it was replaced and is only reachable on purpose;
 * what is pinned here is that its needle and its record agree with each other. That holds for a two-point frame.
 * A fitted record under the switch is built in src/ar/calibration-commit.ts, which does not yet pass the rule on to
 * `projectBearingDeg`, so it is not held to it here.
 *
 * On a return visit that FITTED three points the needle is the arrow as drawn (the baseline that was tapped), and
 * the record's bearing belongs to the matrix beside it, the fit's: the last test pins that, under the current rule, the
 * two differ by exactly the heading residual the record keeps, and by nothing else.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/origin_heading_bearing.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_BEARING_CONVENTION,
  originDecalPlan,
  originHeadingBearingDeg,
  projectBearingDeg,
  type OriginDecalPlan,
} from '../../../src/world/geo.ts'
import { buildOriginDecal } from '../../../src/world/origin-decal.ts'
import type { BearingConvention } from '../../../src/world/types.ts'
import {
  bearingOfSessionVector,
  bearingOfSessionYaw,
  enuToSession,
  rotateByQuat,
  trueSessionZBearing,
} from '../deno/physical_oracle.ts'
import { clockwiseFromTickToArrow } from './origin_picture.ts'
import { bearingsAgree, constellation, nudge, norm360, startFlow, walk, type Enu } from './origin_rig.ts'

const DEG = Math.PI / 180

/** The session yaw `atan2(x, z)` of a session vector, in degrees: how the app (and only the app) names a direction. */
const yawOfVector = (v: { x: number; z: number }): number => Math.atan2(v.x, v.z) / DEG

// ── 1. The picture ───────────────────────────────────────────────────────────

test('the needle reads the clockwise angle from the north tick to the arrow, as a camera above the floor sees it', () => {
  let cases = 0
  let needingTheFold = 0
  for (const northYawDeg of [0, 37, 90, 180, 290, 359]) {
    for (const headingDeg of [0, 15, 90, 123, 180, 250, 271, 345]) {
      const h = headingDeg * DEG
      const plan = originDecalPlan({ x: 1, y: -0.4, z: -2 }, { x: 1 + 2.5 * Math.sin(h), y: -0.4, z: -2 + 2.5 * Math.cos(h) }, northYawDeg)
      const decal = buildOriginDecal(plan, 'committed')
      const shown = originHeadingBearingDeg(plan)
      assert.ok(shown !== null, 'a compass fix and an arrow give a bearing')
      // `bearingsAgree` is circular, so it cannot tell 323 from -37: a bearing is in [0, 360), and that is asserted apart.
      assert.ok(shown >= 0 && shown < 360, `north tick at yaw ${northYawDeg}, arrow at yaw ${headingDeg}: ${shown} is not a bearing, in [0, 360)`)
      // The arrow's yaw is past north's (the raw `northYaw - heading` is below zero): the cases that need the fold.
      if (northYawDeg - plan.headingDeg! < -1e-9) needingTheFold++
      for (const roll of [0, 70, 200]) {
        const seen = clockwiseFromTickToArrow(decal, roll)
        assert.ok(
          bearingsAgree(shown, seen, 1e-6),
          `north tick at yaw ${northYawDeg}, arrow at yaw ${headingDeg}, camera rolled ${roll}: the needle says ${shown}, the floor says ${seen}`,
        )
        cases++
      }
    }
  }
  assert.equal(cases, 6 * 8 * 3)
  assert.ok(needingTheFold > 0, 'the sweep holds arrows that need the fold, which is what the range assertion above is for')
})

// ── 2. The world ─────────────────────────────────────────────────────────────

test('the needle reads the true bearing of the arrow, for every start heading and every arrow', () => {
  let wrongWhenOld = 0
  let rightWhenOld = 0
  let needingTheFold = 0
  for (const psi of [0, 37, 137, 250, 300]) {
    // Where north lies in this session, as a yaw: the physical model says which session direction points at bearing 0.
    const northYaw = norm360(yawOfVector(enuToSession(psi, { east: 0, north: 1, up: 0 })))
    for (let bearing = 0; bearing < 360; bearing += 15) {
      // An arrow along the session direction that really points at this bearing.
      const along = enuToSession(psi, { east: Math.sin(bearing * DEG), north: Math.cos(bearing * DEG), up: 0 })
      const plan = originDecalPlan({ x: 0, y: 0, z: 0 }, { x: 2 * along.x, y: 0, z: 2 * along.z }, northYaw)
      const shown = originHeadingBearingDeg(plan)
      assert.ok(shown !== null)
      assert.ok(bearingsAgree(shown, bearing, 1e-6), `start ${psi}, arrow at bearing ${bearing}: the needle says ${shown}`)
      // `bearingsAgree` is circular: the needle is a bearing, so it is in [0, 360), and -37 is not 323.
      assert.ok(shown >= 0 && shown < 360, `start ${psi}, arrow at bearing ${bearing}: ${shown} is not a bearing, in [0, 360)`)
      if (northYaw - plan.headingDeg! < -1e-9) needingTheFold++

      // The guard that gives this test teeth: the formula this replaced (the arrow's yaw minus north's) is the mirror
      // image, right only for an arrow due north or due south, whatever way the session started.
      const old = norm360(plan.headingDeg! - plan.northYawDeg!)
      if (bearingsAgree(old, bearing, 1e-6)) rightWhenOld++
      else wrongWhenOld++
      assert.equal(bearingsAgree(old, bearing, 1e-6), bearing === 0 || bearing === 180, `the old formula at start ${psi}, bearing ${bearing}`)
    }
  }
  assert.equal(rightWhenOld, 5 * 2, 'the old formula is right only at bearings 0 and 180')
  assert.equal(wrongWhenOld, 5 * 22)
  assert.ok(needingTheFold > 0, 'the sweep holds arrows that need the fold, which is what the range assertion in it is for')
})

test('the needle is null without an arrow or a compass fix, and folded into [0, 360)', () => {
  const origin = { x: 0, y: 0, z: 0 }
  const ahead = { x: 0, y: 0, z: 2 }
  const east = { x: 2, y: 0, z: 0 }
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, null, 30)), null, 'no heading point, so no arrow')
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, null)), null, 'no compass fix, so no bearing')
  // North at yaw 90 (toward +X), the arrow along +Z: the arrow is a quarter turn clockwise of north. Seen from above
  // with +X to the right, +Z points toward the viewer's bottom edge, and the way from 3 o'clock to 6 o'clock is clockwise.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 90)), 90)
  // The same arrow with north at yaw 270 (toward -X, 9 o'clock): from 9 o'clock round to 6 o'clock is 270 degrees clockwise.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 270)), 270)
  const plan: OriginDecalPlan = { origin, headingDeg: 10, arrowLengthM: 1, northYawDeg: 350 }
  const shown = originHeadingBearingDeg(plan)!
  assert.ok(shown >= 0 && shown < 360 && bearingsAgree(shown, 340, 1e-9), `${shown}`)

  // THE FOLD. Every case above has the arrow's yaw at or below north's, so `northYaw - heading` is not negative in any of
  // them and none needs the wrap: a needle that lost it would pass them all. These do need it, and are read off the clock
  // face and not out of the formula. North at yaw 0 is the tick toward +Z, at 6 o'clock; the arrow along +X is at
  // 3 o'clock; from 6 clockwise round to 3 is nine hours, 270 degrees, though the difference of the two yaws is -90.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, east, 0)), 270, 'north 0, arrow 90: -90 folds to 270')
  // Not a quarter turn: the tick at yaw 10 and the arrow at yaw 47, 37 degrees further the counter-clockwise way, which is
  // 323 clockwise. A plan written out, so the numbers are exactly these.
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 47, arrowLengthM: 1, northYawDeg: 10 }), 323, 'north 10, arrow 47: -37 folds to 323')
  // An arrow on north reads 0, not 360 (the other seam).
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 40, arrowLengthM: 1, northYawDeg: 40 }), 0, 'on north')

  // The old rule (`?bearing=1`) reads the arrow's yaw from north's, so its negative case is the other way round: heading 0
  // minus north 90 is -90, which is 270, and heading 10 minus north 350 is -340, which is 20.
  assert.equal(originHeadingBearingDeg(originDecalPlan(origin, ahead, 90), LEGACY_BEARING_CONVENTION), 270, 'old rule: heading 0, north 90')
  assert.equal(originHeadingBearingDeg(plan, LEGACY_BEARING_CONVENTION), 20, 'old rule: heading 10, north 350')
  assert.equal(originHeadingBearingDeg({ origin, headingDeg: 40, arrowLengthM: 1, northYawDeg: 40 }, LEGACY_BEARING_CONVENTION), 0, 'old rule, on north')
})

// ── 2b. The record's own formula ─────────────────────────────────────────────

test('projectBearingDeg: the true bearing of the baseline, for every start heading and every baseline, folded into [0, 360)', () => {
  let needingTheFold = 0
  let cases = 0
  for (const psi of [0, 37, 137, 250, 300]) {
    // The bearing of the session's +Z, and the true bearing of the baseline at a session yaw, from the physical model.
    const frameBearing = trueSessionZBearing(psi)
    for (let yaw = -180; yaw < 180; yaw += 15) {
      const recorded = projectBearingDeg(frameBearing, yaw)
      assert.ok(typeof recorded === 'number')
      const truth = bearingOfSessionYaw(psi, yaw)
      assert.ok(bearingsAgree(recorded, truth, 1e-6), `start ${psi}, baseline at yaw ${yaw}: the record says ${recorded}, the baseline points at ${truth}`)
      // `bearingsAgree` is circular, and a record's bearing is a bearing: it is in [0, 360).
      assert.ok(recorded >= 0 && recorded < 360, `start ${psi}, baseline at yaw ${yaw}: ${recorded} is not a bearing, in [0, 360)`)
      if (frameBearing - yaw < 0 || frameBearing - yaw >= 360) needingTheFold++
      cases++
    }
  }
  assert.equal(cases, 5 * 24)
  assert.ok(needingTheFold > 0, 'the sweep holds baselines that need the fold, in both directions')
})

test('projectBearingDeg: no compass fix, no record; the old rule adds the yaw; both fold', () => {
  assert.equal(projectBearingDeg(null, 40), null, 'no compass fix')
  assert.equal(projectBearingDeg(40, Number.NaN), null, 'no baseline')
  // Read off the circle. The current rule: the frame's bearing less the baseline's yaw.
  assert.equal(projectBearingDeg(10, 47), 323, '10 - 47 = -37 folds to 323')
  assert.equal(projectBearingDeg(350, -20), 10, '350 + 20 = 370 folds to 10')
  assert.equal(projectBearingDeg(90, 90), 0, 'a baseline due north reads 0, not 360')
  // The old rule (`?bearing=1`): the frame's bearing plus the yaw.
  assert.equal(projectBearingDeg(350, 20, LEGACY_BEARING_CONVENTION), 10, 'old rule: 350 + 20 = 370 folds to 10')
  assert.equal(projectBearingDeg(10, -47, LEGACY_BEARING_CONVENTION), 323, 'old rule: 10 - 47 = -37 folds to 323')
  assert.equal(projectBearingDeg(40, 320, LEGACY_BEARING_CONVENTION), 0, 'old rule: a baseline due north reads 0, not 360')
})

// ── 3. The record ────────────────────────────────────────────────────────────

/** The camera's yaw in the session, `atan2(x, z)` of its forward `q * (0, 0, -1)`, from the oracle's own rotation. */
function cameraYaw(q: { x: number; y: number; z: number; w: number }): number {
  return yawOfVector(rotateByQuat(q, { x: 0, y: 0, z: -1 }))
}

interface Setup {
  /** Bearing the session started facing. */
  psi: number
  /** Degrees turned LEFT since the session started. */
  turn: number
  down: number
  /** True bearing of the landmark-to-marker baseline the person walks. */
  baselineBearing: number
}

/** A handful of sessions: a plain one, a turned-and-tilted one, a right turn, an about-face, and baselines on every side. */
const SETUPS: Setup[] = [
  { psi: 0, turn: 0, down: 0, baselineBearing: 40 },
  { psi: 137, turn: 75, down: 60, baselineBearing: 123 },
  { psi: 300, turn: -120, down: 25, baselineBearing: 250 },
  { psi: 45, turn: 180, down: 60, baselineBearing: 5 },
  { psi: 211, turn: 30, down: 10, baselineBearing: 90 },
  { psi: 90, turn: -45, down: 40, baselineBearing: 300 },
]
const label = (s: Setup) => `start ${s.psi}, turned ${s.turn}, baseline at ${s.baselineBearing}`

const LANDMARK_AT: Enu = { east: 1.5, north: -2, up: -1.2 }

for (const setup of SETUPS) {
  test(`two points (${label(setup)}): the needle, the record, the baseline and the picture are one bearing`, async (t) => {
    const flow = await startFlow(t, setup)
    const baseline = constellation(LANDMARK_AT, setup.baselineBearing, 2.4)
    await flow.placeLandmark(flow.physical(baseline.landmark))
    await flow.tap(flow.physical(baseline.marker))
    flow.skipCheckPoint()
    flow.press('project-calibration-commit')
    const result = await flow.finish()
    assert.ok(result, 'the two points committed')
    assert.equal(result.calibration.method, 'two-point-ground')

    const shown = result.originBearingDeg
    assert.ok(typeof shown === 'number', 'a compass fix and an arrow give the HUD a number')
    const recorded = (result.calibration as { projectBearingDeg: number | null }).projectBearingDeg
    assert.ok(typeof recorded === 'number')
    const decal = flow.scene.getObjectByName('calibration origin')!
    assert.ok(decal, 'the origin decal is in the scene')

    assert.ok(bearingsAgree(shown, setup.baselineBearing, 1e-6), `the needle says ${shown}, the baseline was walked at ${setup.baselineBearing}`)
    assert.ok(bearingsAgree(recorded, setup.baselineBearing, 1e-6), `the record says ${recorded}`)
    // Both are bearings, so both are in [0, 360), which a circular comparison does not ask: the HUD prints `shown` as it is.
    assert.ok(shown >= 0 && shown < 360, `the needle says ${shown}, which is not a bearing`)
    assert.ok(recorded >= 0 && recorded < 360, `the record says ${recorded}, which is not a bearing`)
    assert.ok(bearingsAgree(shown, recorded, 1e-9), `needle ${shown} and record ${recorded} describe one arrow`)
    const seen = clockwiseFromTickToArrow(decal)
    assert.ok(bearingsAgree(shown, seen, 1e-4), `the needle says ${shown}, the north tick and the arrow on the floor are ${seen} apart`)
  })
}

test('two points with no compass fix: no tick, no bearing, and the HUD is told nothing', async (t) => {
  const flow = await startFlow(t, { ...SETUPS[1]!, compass: () => null })
  const baseline = constellation(LANDMARK_AT, 123, 2.4)
  await flow.placeLandmark(flow.physical(baseline.landmark))
  await flow.tap(flow.physical(baseline.marker))
  flow.skipCheckPoint()
  flow.press('project-calibration-commit')
  const result = await flow.finish()
  assert.ok(result)
  assert.equal('originBearingDeg' in result, false)
  assert.equal(flow.scene.getObjectByName('calibration origin')!.getObjectByName('origin north'), undefined)
})

test('one point: there is no arrow, so the HUD has no frame heading to show', async (t) => {
  const flow = await startFlow(t, SETUPS[0]!)
  await flow.tap(flow.physical(LANDMARK_AT))
  flow.press('project-calibration-fallback')
  const result = await flow.finish()
  assert.ok(result)
  assert.equal(result.calibration.method, 'ground-tap-compass')
  assert.equal('originBearingDeg' in result, false)
})

// ── ?bearing=1: the old rule, as a whole ──────────────────────────────────────

for (const setup of SETUPS) {
  test(`?bearing=1 (${label(setup)}): the needle follows the old rule, and so does the record beside it`, async (t) => {
    const flow = await startFlow(t, { ...setup, search: '?bearing=1' })
    const baseline = constellation(LANDMARK_AT, setup.baselineBearing, 2.4)
    const landmark = flow.physical(baseline.landmark)
    const marker = flow.physical(baseline.marker)
    await flow.placeLandmark(landmark)
    await flow.tap(marker)
    flow.skipCheckPoint()
    flow.press('project-calibration-commit')
    const result = await flow.finish()
    assert.ok(result)
    assert.equal((result.calibration as { bearingConvention?: BearingConvention }).bearingConvention, LEGACY_BEARING_CONVENTION)

    // The old rule, written out from its own definition ("the rule the app used before it was corrected":
    // `deviceBearing - cameraYaw` for the session's +Z, and a direction at session yaw `y` read as bearing `B_Z + y`).
    // It is not the physical truth, which is why it was replaced; it is what that rule says, from the oracle's own numbers.
    const compass = flow.perfect()
    const frameBearing = norm360(compass - cameraYaw(flow.rotation))
    const arrowYaw = yawOfVector({ x: marker.x - landmark.x, z: marker.z - landmark.z })
    const oldRuleBearing = norm360(frameBearing + arrowYaw)

    const shown = result.originBearingDeg
    assert.ok(typeof shown === 'number')
    assert.ok(bearingsAgree(shown, oldRuleBearing, 1e-6), `the needle says ${shown}, the old rule says ${oldRuleBearing}`)
    const recorded = (result.calibration as { projectBearingDeg: number | null }).projectBearingDeg
    assert.ok(typeof recorded === 'number')
    assert.ok(bearingsAgree(recorded, oldRuleBearing, 1e-6), `the record says ${recorded}, the old rule says ${oldRuleBearing}`)
    assert.ok(shown >= 0 && shown < 360, `the needle says ${shown}, which is not a bearing`)
    assert.ok(recorded >= 0 && recorded < 360, `the record says ${recorded}, which is not a bearing`)

    // The old rule's tick sits at yaw -B_Z, so the picture reads the old rule's number counter-clockwise.
    const decal = flow.scene.getObjectByName('calibration origin')!
    const seen = clockwiseFromTickToArrow(decal)
    assert.ok(bearingsAgree(shown + seen, 0, 1e-4), `under the old rule the needle ${shown} is the picture ${seen} read the other way round`)
  })
}

// ── A fit: the arrow drawn is the one the person tapped, the record follows the fit ──

test('three points fitted to the stored ones: the needle is the arrow on the floor, and the record differs by the fit\'s own heading residual', async (t) => {
  // The Place's first calibration, with a check point, in one session.
  const first = await startFlow(t, { psi: 20, turn: 10, down: 30 })
  const physical = constellation(LANDMARK_AT, 70, 2.4)
  await first.placeLandmark(first.physical(physical.landmark))
  await first.tap(first.physical(physical.marker))
  await first.tap(first.physical(physical.check))
  first.press('project-calibration-commit')
  const stored = await first.finish()
  assert.ok(stored?.spatialFrame, 'the first calibration wrote the Place frame')

  // A return visit in a session that started facing somewhere else, and taps that miss their spots by a few centimetres.
  const visit = await startFlow(t, { psi: 215, turn: -35, down: 20, project: { spatialFrame: stored.spatialFrame } })
  const tapped = {
    landmark: nudge(physical.landmark, 0.03, -0.02),
    marker: nudge(physical.marker, -0.04, 0.05),
    check: nudge(physical.check, 0.02, 0.04),
  }
  await visit.placeLandmark(visit.physical(tapped.landmark))
  await visit.tap(visit.physical(tapped.marker))
  await visit.tap(visit.physical(tapped.check))
  visit.press('project-calibration-commit')
  const result = await visit.finish()
  assert.ok(result, 'the visit committed')
  const calibration = result.calibration as { fit?: { headingResidualDeg: number | null }; projectBearingDeg: number | null }
  assert.ok(calibration.fit, 'three points were fitted')
  const residual = calibration.fit.headingResidualDeg
  assert.ok(typeof residual === 'number' && Math.abs(residual) > 0.1, `the taps leave a heading residual to tell the two numbers apart (${residual})`)

  // The arrow is drawn along the baseline the person tapped: its true bearing, from the oracle.
  const a = visit.physical(tapped.landmark)
  const b = visit.physical(tapped.marker)
  const tappedBearing = bearingOfSessionVector(215, { x: b.x - a.x, y: 0, z: b.z - a.z })
  assert.ok(typeof result.originBearingDeg === 'number')
  assert.ok(bearingsAgree(result.originBearingDeg, tappedBearing, 1e-6), `the needle says ${result.originBearingDeg}, the arrow was tapped along ${tappedBearing}`)
  assert.ok(result.originBearingDeg >= 0 && result.originBearingDeg < 360, `the needle says ${result.originBearingDeg}, which is not a bearing`)
  const seen = clockwiseFromTickToArrow(visit.scene.getObjectByName('calibration origin')!)
  assert.ok(bearingsAgree(result.originBearingDeg, seen, 1e-4))

  // The record's bearing belongs to the matrix beside it, which is the fit's: the tapped baseline's, turned by the heading residual.
  assert.ok(typeof calibration.projectBearingDeg === 'number')
  assert.ok(
    bearingsAgree(calibration.projectBearingDeg, tappedBearing + residual, 1e-6),
    `the record says ${calibration.projectBearingDeg}; the tapped baseline is ${tappedBearing} and the fit turns it by ${residual}`,
  )
  assert.ok(calibration.projectBearingDeg >= 0 && calibration.projectBearingDeg < 360, `the record says ${calibration.projectBearingDeg}, which is not a bearing`)
})

// The rig's own geometry feeds every scene above, so it is checked here once, against bearings anyone can read off a map.
test('the rig walks on true bearings: north is +north, east is +east, left of north is west', () => {
  const from: Enu = { east: 0, north: 0, up: 0 }
  const near = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual}`)
  const north = walk(from, 0, 2)
  near(north.east, 0, 'north: east')
  near(north.north, 2, 'north: north')
  const east = walk(from, 90, 2)
  near(east.east, 2, 'east: east')
  near(east.north, 0, 'east: north')
  const west = walk(from, 0, 0, 1)
  near(west.east, -1, 'a metre to the left of a line due north: east')
  near(west.north, 0, 'a metre to the left of a line due north: north')
})
