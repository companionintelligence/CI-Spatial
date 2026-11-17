/**
 * The calibration modal's commit paths, pinned to what they did before the commit logic moved out of
 * src/ar/project-calibration.ts into src/ar/calibration-commit.ts (WP-04b step 0, a refactor that changed nothing), and, since
 * the constellation flow (WP-04b steps 1 to 6), to what they do now: the goldens were re-recorded then, and the header of
 * ./support/calibration-flow-goldens.ts lists what moved and why.
 *
 * `runProjectCalibration` is driven end to end, as a person drives it, against a stand-in for the part of the DOM it
 * touches (./support/calibration-flow-driver.ts), through the scenarios in ./support/calibration-flow-scenarios.ts:
 * a first two-point calibration, a return visit inside and outside the stored tolerance and at its exact edge,
 * "Use anyway", the one-point tier with and without a compass reading, a pair at, under and far under the minimum
 * baseline, a tap the runtime finds nothing for or fails on, a commit pressed twice while its photos are pending, and
 * a compass, a clock and a label that change while they are.
 *
 * Two kinds of claim are made about each, and they are kept apart on purpose:
 *
 *  - The GOLDENS (./support/calibration-flow-goldens.ts) say what it did: every record, number and sentence. A golden is a
 *    statement about the past, so it can be re-recorded into something wrong; it is never the only check.
 *  - The CONTRACT below says what it means, from the geometry and the Place's stored frame, without looking at a
 *    golden. For a pair: the landmark is the origin, the marker is on +Z at the separation, the residual is this visit's
 *    separation minus the stored one, a distance check is never "verified", and the tolerance in force is the spacing
 *    tolerance at the tap noise in use. For three points: each marker lands on its stored point by exactly the residual the
 *    fit records, "verified" only inside the gates, and a first calibration's check point is the tap carried into the new frame.
 *    For both: a frame is returned only when the Place's frame changed. Re-recording a golden does not move any of it.
 *
 * The third tier, `'known-distance'`, is not a scenario: only the server's tripod path writes it
 * (server/capture/known_distance.ts), and neither the modal nor the commit module has a way to produce one. A test
 * below says so.
 *
 * What it cannot see: how the card looks, or whether a thumb can reach a button (tests/mock-two-point-calibration.spec.ts
 * does), and the compass and pose of a real phone. The pure functions the modal now calls are held to the code they
 * replaced in wp-calibration-commit.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-characterisation.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 * To hold another build of the modal to the goldens: set CALIBRATION_MODAL_URL to a file URL for a copy whose imports resolve
 * from where it sits.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyColumnMajor, rotationDeterminant } from '../deno/physical_oracle.ts'
import { MIN_POINT_SEPARATION_M, sessionFrameBearingDeg, transformPoint } from '../../../src/world/geo.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { RMS_GATE_SIGMAS, SIGMA0_M, MAX_GATE_FACTOR, HEIGHT_GATE_SIGMAS, twoPointToleranceM } from '../../../src/world/frame-fit.ts'
import type { Vec3 } from '../../../src/world/types.ts'
import { FLOOR_Y, SCENARIO_CAMERA, SCENARIO_NOW, loadModal, runScenario, type Outcome, type Scenario } from './support/calibration-flow-driver.ts'
import { SCENARIOS } from './support/calibration-flow-scenarios.ts'
import { GOLDEN } from './support/calibration-flow-goldens.ts'

/** The modal under test: this build's, or the build at `CALIBRATION_MODAL_URL` (a file URL), to hold another to the goldens. */
const runModal = await loadModal(process.env['CALIBRATION_MODAL_URL'])

/** A rejection nobody handled while the scenarios ran: the modal must leave none behind, whatever the host does. */
const unhandled: unknown[] = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

const outcomes = new Map<string, Outcome>()
/** A scenario the driver refused to finish (the host's hit test was called detached from its options): reported by each test that reads it. */
const failures = new Map<string, unknown>()
for (const scenario of SCENARIOS) {
  try {
    outcomes.set(scenario.name, await runScenario(runModal, scenario))
  } catch (error) {
    failures.set(scenario.name, error)
  }
}
const outcome = (name: string): Outcome => {
  if (failures.has(name)) throw failures.get(name)
  const found = outcomes.get(name)
  assert.ok(found, `no scenario named "${name}"`)
  return found
}

interface Returned {
  calibration: Record<string, unknown>
  spatialFrame?: Record<string, unknown>
  referencePhotos?: Array<{ role: string; label: string | null }>
}

const returned = (name: string): Returned => {
  const result = outcome(name).result as Returned | null | undefined
  assert.ok(result, `"${name}" should have ended in a calibration`)
  return result
}

// ── Behaviour preserved: the goldens ────────────────────────────────────────────────────────────────────

test('every scenario has a golden and every golden a scenario', () => {
  const names = SCENARIOS.map((scenario) => scenario.name)
  assert.equal(new Set(names).size, names.length, 'scenario names are unique')
  assert.deepEqual([...names].sort(), Object.keys(GOLDEN).sort())
})

/** Every key of a value, in order, and nothing else: the layout deep equality cannot see and a stored record is made of. */
function layout(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(layout)
  if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, child]) => [key, layout(child)])
  return null
}

for (const scenario of SCENARIOS) {
  test(`golden: ${scenario.name}`, () => {
    const found = outcome(scenario.name)
    assert.deepStrictEqual(found, GOLDEN[scenario.name], scenario.about)
    assert.deepStrictEqual(layout(found), layout(GOLDEN[scenario.name]), 'the same keys in the same order: it is the layout a stored record has')
  })
}

// ── What each outcome means: the contract, from the geometry and the stored frame ───────────────────────────

/** The first two taps, in the order they were made: the landmark, then the heading marker. */
const tapsOf = (scenario: Scenario): Vec3[] => scenario.steps.flatMap((step) => ('tap' in step ? [step.tap] : []))

const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`)

/**
 * The heading point has no marker of its own: the origin decal's arrow ends on it, and the arrow's geometry is single precision
 * (Float32BufferAttribute), so its tip is the heading point to about 1e-7 m. Checks that read the heading point from the arrow hold it to this.
 */
const ARROW_TIP_TOLERANCE_M = 1e-6
const nearTip = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < ARROW_TIP_TOLERANCE_M, `${message}: ${actual} is not ${expected}`)

/** The spacing tolerance a verdict applies at the adopted tap noise: what every two-point record carries, whatever the stored frame says. */
const TOLERANCE_M = twoPointToleranceM(SIGMA0_M)

function checkTwoPoint(scenario: Scenario, result: Returned): void {
  const [landmark, marker] = tapsOf(scenario) as [Vec3, Vec3]
  const calibration = result.calibration as {
    method: string; sessionToProject: number[]; separationM: number; residualM: number; toleranceM: number
    status: string; anchorBearingDeg: number | null; projectBearingDeg: number | null; bearingConvention: number; calibratedAt: string
    checkedBy?: string; fit?: unknown
  }
  const stored = scenario.stored as { method?: string; separationM: number; toleranceM?: number | null } | undefined
  const storedTwoPoint = stored?.method === 'two-point-ground' ? stored : null
  const override = scenario.steps.some((step) => 'press' in step && step.press === 'override')
  const separation = Math.hypot(marker.x - landmark.x, marker.z - landmark.z)

  // The transform: the landmark is the origin, the marker is on +Z at the separation, and it is a rotation and a shift.
  const m = calibration.sessionToProject
  const origin = applyColumnMajor(m, landmark)
  near(origin.x, 0, 'landmark x')
  near(origin.y, 0, 'landmark y')
  near(origin.z, 0, 'landmark z')
  const ahead = applyColumnMajor(m, marker)
  near(ahead.x, 0, 'marker x')
  near(ahead.y, 0, 'marker y')
  near(ahead.z, separation, 'marker z')
  near(rotationDeterminant(m), 1, 'determinant')
  near(calibration.separationM, separation, 'separationM')

  // The verdict: what the stored pair says about it.
  assert.equal(calibration.toleranceM, TOLERANCE_M, 'the tolerance in force is the spacing tolerance at the tap noise in use, whatever the stored frame says')
  if (storedTwoPoint) {
    const expected = separation - storedTwoPoint.separationM
    assert.ok(Object.is(calibration.residualM, expected) || Math.abs(calibration.residualM - expected) < 1e-12, `residualM ${calibration.residualM} is not ${expected}`)
    // It got this far, so it was inside the tolerance or was kept anyway: nothing outside it is returned as checked.
    assert.ok(!(Math.abs(calibration.residualM) > TOLERANCE_M) || override, 'a pair outside the tolerance is only returned when kept anyway')
  } else {
    assert.equal(calibration.residualM, 0, 'nothing stored, nothing compared')
  }
  assert.equal(calibration.status, 'provisional', 'a distance check is never verified, and nothing else was compared')
  assert.equal(calibration.checkedBy, storedTwoPoint ? 'separation' : undefined, 'a comparison names the check it made, and a first calibration made none')
  assert.ok(!('fit' in calibration), 'two points have no fit')
  const waited = scenario.steps.reduce((sum, step) => ('advance' in step ? sum + step.advance : sum), 0)
  assert.equal(calibration.calibratedAt, new Date(SCENARIO_NOW + waited).toISOString(), 'the time the commit completed')

  // The bearings: the compass read at the moment the commit completed, turned into the frame's, under the current rule.
  assert.equal(calibration.bearingConvention, scenario.search === '?bearing=1' ? 1 : 2)

  // The Place frame: returned when it changed, never when a stored pair was merely matched.
  const changed = !storedTwoPoint || override
  assert.ok('spatialFrame' in result, 'the key is always there')
  assert.equal(result.spatialFrame !== undefined, changed)
  assert.equal('referencePhotos' in result, changed, 'photos come with a changed frame and with nothing else')
  if (result.spatialFrame) {
    const frame = result.spatialFrame as {
      version: number; createdAt: string; method: string; landmark: Vec3; headingMarker: Vec3; separationM: number; toleranceM: number
      anchorBearingDeg: number | null; projectBearingDeg: number | null; bearingConvention: number; pointLabels?: [string, string]
    }
    assert.deepEqual([frame.version, frame.method, frame.createdAt], [1, 'two-point-ground', calibration.calibratedAt])
    assert.deepEqual(frame.landmark, { x: 0, y: 0, z: 0 }, 'project space by construction')
    assert.deepEqual(frame.headingMarker, { x: 0, y: 0, z: calibration.separationM })
    assert.equal(frame.separationM, calibration.separationM)
    assert.equal(frame.toleranceM, calibration.toleranceM, 'the tolerance a later visit is judged by')
    assert.equal(frame.anchorBearingDeg, calibration.anchorBearingDeg)
    assert.equal(frame.projectBearingDeg, calibration.projectBearingDeg)
    assert.equal(frame.bearingConvention, calibration.bearingConvention)
  }
  assert.equal(result.referencePhotos?.length ?? 0, changed && scenario.capture ? 2 : 0, 'a photo of each marker, when the host can take them')

  // The scene: the origin decal on the landmark, with its arrow ending on the heading point, both at the landmark's height, and the
  // stored pair drawn only against a matched visit.
  const named = (name: string) => outcome(scenario.name).scene.filter((entry) => entry.name === name)
  const decal = named('calibration origin')
  assert.deepEqual(decal.map((entry) => entry.position), [[landmark.x, landmark.y, landmark.z]])
  const tip = decal[0]!.arrowTip
  assert.ok(tip, 'the origin decal has its arrow')
  nearTip(tip[0], marker.x, 'the arrow ends on the heading point: x')
  nearTip(tip[1], landmark.y, "the arrow ends on the heading point: y, the landmark's height")
  nearTip(tip[2], marker.z, 'the arrow ends on the heading point: z')
  assert.equal(named('calibration anchor landmark').length + named('calibration anchor heading').length, 0, 'neither point has a marker of its own')
  const drawn = named('calibration stored reference').map((entry) => entry.position)
  if (storedTwoPoint && !override) {
    assert.equal(drawn.length, 2, 'the stored pair is drawn beside what was tapped')
    assert.deepEqual(drawn[0], [landmark.x, landmark.y, landmark.z])
    if (Number.isFinite(storedTwoPoint.separationM)) {
      const along = storedTwoPoint.separationM / separation
      near(drawn[1]![0]!, landmark.x + (marker.x - landmark.x) * along, 'stored marker x')
      near(drawn[1]![2]!, landmark.z + (marker.z - landmark.z) * along, 'stored marker z')
    }
  } else {
    assert.deepEqual(drawn, [])
  }
}

/**
 * Three points, from the geometry and the Place's stored frame, without looking at a golden. A visit fitted to the stored points
 * leaves each marker off its stored point by exactly the residual the fit records, and is verified only inside the gates; a frame
 * kept over a mismatch, or a first calibration, stores the check point as the tap carried into the frame the new pair defines.
 */
function checkThreePoint(scenario: Scenario, result: Returned): void {
  const calibration = result.calibration as {
    method: string; sessionToProject: number[]; separationM: number; toleranceM: number; status: string; checkedBy?: string
    fit?: { pointsUsed: number; rmsResidualM: number; maxResidualM: number; perPoint: Array<{ residualM: number; dx: number; dy: number; dz: number }> }
  }
  const stored = scenario.stored as { landmark: Vec3; headingMarker: Vec3; checkPoints?: Vec3[] } | undefined
  const override = scenario.steps.some((step) => 'press' in step && step.press === 'override')
  const scene = outcome(scenario.name).scene
  const named = (name: string) => scene.filter((entry) => entry.name === name)
  const at = (name: string): Vec3 => {
    const [entry] = named(name)
    assert.ok(entry, `${name} is in the scene`)
    return { x: entry.position[0], y: entry.position[1], z: entry.position[2] }
  }
  // The heading point is where the origin decal's arrow ends (to the single precision of its geometry); the check point has a marker.
  const decal = named('calibration origin')[0]
  assert.ok(decal?.arrowTip, 'the origin decal is in the scene, with its arrow')
  const taps = [at('calibration origin'), { x: decal.arrowTip[0], y: decal.arrowTip[1], z: decal.arrowTip[2] }, at('calibration anchor check')]
  const M = calibration.sessionToProject
  near(rotationDeterminant(M), 1, 'determinant')
  assert.equal(calibration.toleranceM, TOLERANCE_M)

  const fitted = !!stored?.checkPoints?.length && !override
  if (fitted) {
    const fit = calibration.fit
    assert.ok(fit && calibration.checkedBy === 'constellation', 'a fit, and the check it rests on')
    const points = [stored!.landmark, stored!.headingMarker, stored!.checkPoints![0]!]
    taps.forEach((tap, index) => {
      const placed = transformPoint(M, tap)
      const holds = index === 1 ? nearTip : near
      holds(Math.hypot(placed.x - points[index]!.x, placed.z - points[index]!.z), fit.perPoint[index]!.residualM, `the residual of point ${index}: where it lands minus where it is stored`)
    })
    const residuals = fit.perPoint.map((point) => point.residualM)
    near(fit.rmsResidualM, Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length), 'rms')
    near(fit.maxResidualM, Math.max(...residuals), 'max')
    assert.equal(fit.pointsUsed, 3)
    if (calibration.status === 'verified') {
      const gate = RMS_GATE_SIGMAS * SIGMA0_M
      assert.ok(fit.rmsResidualM <= gate && fit.maxResidualM <= MAX_GATE_FACTOR * gate, 'verified only inside the gates')
      const heights = Math.sqrt(fit.perPoint.reduce((sum, point) => sum + point.dy * point.dy, 0) / fit.perPoint.length)
      assert.ok(heights <= HEIGHT_GATE_SIGMAS * SIGMA0_M, 'and the heights agree')
    }
    assert.equal(result.spatialFrame, undefined, 'the stored frame is the reference and is not rewritten')
    // The stored points drawn where this visit puts them: through the inverse of the fit.
    const inverse = invertAffine(M)!
    const rings = named('calibration stored reference').map((entry) => entry.position)
    assert.equal(rings.length, 3)
    rings.forEach((ring, index) => {
      const landed = transformPoint(inverse, points[index]!)
      near(ring[0]!, landed.x, `ghost ${index} x`)
      near(ring[2]!, landed.z, `ghost ${index} z`)
      near(ring[1]!, taps[index]!.y, `ghost ${index} is drawn at the height of its marker`)
    })
  } else {
    // A frame this visit wrote: the new pair is the frame (the landmark is the origin, the heading marker on +Z), and the check point is the tap carried into it.
    const origin = transformPoint(M, taps[0]!)
    near(Math.hypot(origin.x, origin.y, origin.z), 0, 'the landmark is the origin')
    nearTip(transformPoint(M, taps[1]!).z, calibration.separationM, 'the heading marker is on +Z at the separation')
    const frame = result.spatialFrame as { checkPoints?: Array<Vec3 & { label?: string }> } | undefined
    assert.ok(frame?.checkPoints?.length === 1, 'the frame stores the check point')
    const placed = transformPoint(M, taps[2]!)
    near(frame!.checkPoints![0]!.x, placed.x, 'check point x')
    near(frame!.checkPoints![0]!.y, placed.y, 'check point y')
    near(frame!.checkPoints![0]!.z, placed.z, 'check point z')
    assert.equal(calibration.status, 'provisional')
    if (!stored) assert.ok(!('fit' in calibration) && !('checkedBy' in calibration), 'a first calibration compared nothing')
    else assert.equal(calibration.checkedBy, 'constellation', 'kept over a mismatch, the record says which check failed')
  }
}

function checkOnePoint(scenario: Scenario, result: Returned): void {
  const [landmark] = tapsOf(scenario) as [Vec3]
  const calibration = result.calibration as { method: string; sessionToProject: number[]; status: string; bearingConvention: number; calibratedAt: string }
  const origin = applyColumnMajor(calibration.sessionToProject, landmark)
  near(Math.hypot(origin.x, origin.y, origin.z), 0, 'the tapped point is the origin')
  assert.equal(calibration.status, 'provisional', 'a single anchor agrees with itself: nothing to verify')
  assert.ok(!('residualM' in calibration) && !('separationM' in calibration), 'and it carries no verification fields')
  assert.equal(calibration.bearingConvention, scenario.search === '?bearing=1' ? 1 : 2)
  assert.ok('spatialFrame' in result)
  assert.equal(result.spatialFrame !== undefined, scenario.stored === undefined, 'a Place that holds a frame is never given another by this tier')
  assert.ok(!('referencePhotos' in result), 'no photos on this tier')
  assert.deepEqual(outcome(scenario.name).scene.map((entry) => entry.name), ['calibration origin'], 'only the origin is drawn')
  assert.equal(outcome(scenario.name).scene[0]!.arrowTip, undefined, 'and it has no arrow: this tier has no heading point')
}

for (const scenario of SCENARIOS) {
  test(`contract: ${scenario.name}`, () => {
    const found = outcome(scenario.name)
    const touches = scenario.steps.filter((step) => 'tap' in step || 'miss' in step).length
    assert.equal(found.counts.hitTests, touches, 'a single hit: the runtime is asked once per touch, whatever it answers')
    if (!found.closed) {
      assert.equal(found.result, undefined)
      assert.deepEqual(found.scene, [], 'a commit that did not happen dropped nothing in the scene')
      return
    }
    const result = returned(scenario.name)
    assert.ok(['two-point-ground', 'ground-tap-compass'].includes(result.calibration['method'] as string), 'the modal writes the two AR tiers only')
    const frame = result.spatialFrame as { checkPoints?: unknown[] } | undefined
    if (result.calibration['method'] === 'ground-tap-compass') checkOnePoint(scenario, result)
    else if (result.calibration['fit'] !== undefined || (frame?.checkPoints?.length ?? 0) > 0) checkThreePoint(scenario, result)
    else checkTwoPoint(scenario, result)
  })
}

test('the host\'s hit test is called through its options object, as a method keeps its this, and nothing is left unhandled', () => {
  assert.deepEqual([...failures].map(([name, error]) => `${name}: ${String(error)}`), [])
  assert.deepEqual(unhandled, [])
})

test('the modal cannot write a known-distance calibration: that tier is the server\'s, for captures with no AR runtime', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  for (const file of ['src/ar/project-calibration.ts', 'src/ar/calibration-commit.ts']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /known-distance/, `${file} names the tier`)
  }
})

// ── The sentences and the edges, written out by hand ────────────────────────────────────────────────────────

const MISMATCH_TITLE = 'These markers do not match the stored pair'
const MISMATCH_TAIL = 'than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.'

for (const [name, sentence] of [
  ['return visit, 40 cm further apart', `Measured 40 cm further apart ${MISMATCH_TAIL}`],
  ['return visit, 30 cm closer together', `Measured 30 cm closer together ${MISMATCH_TAIL}`],
  ['return visit, stored tolerance 0.4, 30 cm off', `Measured 30 cm further apart ${MISMATCH_TAIL}`],
  ['return visit, exactly at the tolerance', `Measured 25 cm further apart ${MISMATCH_TAIL}`],
  ['return visit, just over the tolerance', `Measured 25 cm further apart ${MISMATCH_TAIL}`],
  ['return visit, a hair past the spacing tolerance', `Measured 17 cm further apart ${MISMATCH_TAIL}`],
] as const) {
  test(`mismatch screen: ${name}`, () => {
    const found = outcome(name)
    assert.equal(found.closed, false, 'nothing is committed')
    const card = found.looks['mismatch']!
    assert.equal(card.title, MISMATCH_TITLE)
    assert.equal(card.copy, sentence)
    assert.equal(card.status, 'Not committed yet.')
    assert.deepEqual(card.shown, ['replace', 'adjust', 'override', 'skip'], 'the ways out: re-place, adjust a point, "Use anyway", continue uncalibrated')
    assert.ok(!card.shown.includes('wrong-place'), '"Wrong Place? Choose another" is the host\'s to supply (WP-07, WP-08)')
    assert.equal(card.fit, undefined, 'a pair has one sentence and no readout')
    assert.equal(found.counts.captures, 1, 'only the landmark photo was asked for: a pair sent back for re-placement costs no frame')
  })
}

test('the spacing tolerance comparison is strict: a gap a little inside it commits, one a little past it is the mismatch screen', () => {
  assert.equal(TOLERANCE_M, 2 * RMS_GATE_SIGMAS * SIGMA0_M, 'twice the rms gate at the adopted tap noise: 16.8 cm')
  assert.equal(returned('return visit, a hair inside the spacing tolerance').calibration['status'], 'provisional')
  assert.ok(Math.abs((returned('return visit, a hair inside the spacing tolerance').calibration['residualM'] as number) - 0.165) < 1e-9)
  assert.equal(outcome('return visit, a hair past the spacing tolerance').closed, false)
})

test('the minimum baseline is inclusive: 1.0 m commits, a hair under it is refused and costs nothing', () => {
  assert.equal(MIN_POINT_SEPARATION_M, 1)
  assert.equal(returned('first calibration, pair exactly the minimum apart').calibration['separationM'], 1)
  for (const name of ['first calibration, pair just under the minimum', 'first calibration, pair 0.6 m apart']) {
    const found = outcome(name)
    assert.equal(found.closed, false)
    assert.equal(found.counts.captures, 1, 'the landmark photo only: no frame is taken for a refused pair')
    assert.equal(found.counts.compass, 0, 'and the compass is not read for one')
    const card = Object.values(found.looks).at(-1)!
    assert.equal(card.status, 'The markers are too close together to fix a reliable heading.')
    assert.ok(card.disabled.includes('commit'), 'the button a person meets is disabled; a script\'s click is what the modal refuses')
  }
})

test('the stored frame\'s own tolerance is no longer read: the spacing tolerance is the tap noise\'s, and the record says so', () => {
  // A stored 0.05 would have turned 6 cm away, and a stored 0.4 would have let 30 cm in. Neither is read.
  assert.equal(returned('return visit, stored tolerance 0.05, 6 cm off').calibration['toleranceM'], TOLERANCE_M)
  assert.equal(outcome('return visit, stored tolerance 0.4, 30 cm off').closed, false)
  assert.equal(outcome('return visit, exactly at the tolerance').closed, false, 'a stored 0.25 does not excuse 25 cm either')
  for (const name of ['return visit, stored frame without a tolerance, 14 cm off', 'return visit, stored tolerance null, 16 cm off']) {
    assert.equal(returned(name).calibration['toleranceM'], TOLERANCE_M, name)
  }
  assert.ok(Math.abs((returned('return visit, stored tolerance null, 16 cm off').calibration['residualM'] as number) - 0.16) < 1e-9, '16 cm is inside 16.8 cm, which it was not inside 15')
})

test('"Use anyway" replaces the Place frame, provisionally, and carries the residual that failed and the spacing tolerance', () => {
  const result = returned('return visit, mismatch, then Use anyway')
  assert.equal(result.calibration['status'], 'provisional', 'a check that ran and failed never reports verified')
  assert.ok(Math.abs((result.calibration['residualM'] as number) - 0.4) < 1e-9)
  assert.equal(result.calibration['toleranceM'], TOLERANCE_M)
  assert.equal(result.calibration['checkedBy'], 'separation', 'the check that failed')
  assert.ok(result.spatialFrame, 'the Place\'s frame is replaced')
  assert.equal(result.referencePhotos?.length, 2, 'with fresh photos of both markers')
})

test('a stored separation that is not a number compares nothing: provisional, with a residual that is not a figure (it was called verified)', () => {
  const calibration = returned('return visit, stored frame with no usable separation').calibration
  assert.equal(calibration['status'], 'provisional')
  assert.ok(Number.isNaN(calibration['residualM']))
  // Its stored heading marker is still a point, so the ghost is drawn where that point lands.
  const ghosts = outcome('return visit, stored frame with no usable separation').scene.filter((entry) => entry.name === 'calibration stored reference')
  assert.equal(ghosts.length, 2)
  assert.ok(ghosts.every((entry) => entry.position.every(Number.isFinite)))
})

const NO_SURFACE = 'No stable surface there. Aim at a textured floor and tap again.'

for (const [name, how] of [
  ['a tap with no surface under it, then good ones', 'finds nothing'],
  ['a tap the runtime fails on, then good ones', 'fails'],
] as const) {
  test(`a tap the runtime ${how} places nothing, says so for as long as the card is left alone, and the next tap is read as any other`, () => {
    const found = outcome(name)
    for (const look of ['no surface', 'after the poll']) {
      const card = found.looks[look]!
      assert.equal(card.status, NO_SURFACE, `${look}: the message survives the 200 ms render poll`)
      assert.ok(!card.shown.includes('confirm'), `${look}: nothing was placed, so there is nothing to confirm`)
    }
    assert.match(found.looks['landmark placed']!.status, /^Landmark placed\./, 'the next tap places the landmark: the failed read did not wedge the modal')
    assert.equal(found.closed, true, 'and the calibration goes on to commit')
    assert.equal(found.counts.hitTests, 3, 'asked for the touch that found nothing, and for each of the two taps')
    assert.deepEqual(found.scene.map((entry) => entry.name), ['calibration origin'], 'only the two real taps were placed: one decal')
    assert.ok(found.scene[0]!.arrowTip, 'with its arrow ending on the second tap')
    assert.deepEqual(unhandled, [], 'a failing hit test is a tap with no surface, not an error nobody caught')
  })
}

test('one point: no compass reading is refused with its reason, and nothing is committed or dropped', () => {
  const found = outcome('one point, no compass reading')
  assert.equal(found.closed, false)
  assert.equal(found.looks['refused']!.status, 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.')
  assert.equal(found.looks['heading step']!.title, 'Place the heading marker', 'two points are still on offer')
  assert.deepEqual(found.scene, [])
})

test('one point on a Place with a two-point frame is not offered, and a click that reaches it is refused', () => {
  const found = outcome('one point on a Place with a two-point frame')
  assert.ok(!found.looks['landmark placed']!.shown.includes('fallback'))
  assert.equal(found.closed, false)
})

test('a second commit press while the photos are pending is ignored: one result, one pair of markers', () => {
  const found = outcome('commit pressed twice while the photos are pending')
  assert.equal(found.looks['waiting']!.status, 'Saving reference photos…')
  assert.equal(found.closed, true)
  assert.equal(found.counts.captures, 2)
  assert.equal(found.scene.filter((entry) => entry.name === 'calibration origin').length, 1, 'one origin decal, not one for each press')
  assert.equal(found.scene.filter((entry) => entry.name.startsWith('calibration anchor')).length, 0, 'and no marker of its own for either point')
})

test('what a commit records is read when it completes, not when the button was pressed: compass, clock and labels', () => {
  const result = returned('compass, clock and labels settle after the photo wait')
  const calibration = result.calibration
  assert.equal(calibration['anchorBearingDeg'], sessionFrameBearingDeg(200, SCENARIO_CAMERA), 'the compass changed to 200 during the wait')
  assert.notEqual(calibration['anchorBearingDeg'], sessionFrameBearingDeg(100, SCENARIO_CAMERA))
  assert.equal(calibration['calibratedAt'], '2026-11-16T09:30:05.000Z', 'the clock moved on 5 s during the wait')
  assert.equal(result.spatialFrame?.['createdAt'], '2026-11-16T09:30:05.000Z')
  assert.deepEqual(result.spatialFrame?.['pointLabels'], ['', 'typed during the wait'], 'a label typed during the wait is the one stored')
  assert.deepEqual(result.referencePhotos?.map((photo) => photo.label), [null, 'typed during the wait'], 'and the one on its photo')
})

test('the first two-point calibration names the points and photographs both markers, with the labels as typed at commit', () => {
  const result = returned('first two-point calibration, labels, photos')
  assert.deepEqual(result.spatialFrame?.['pointLabels'], ['north door frame', 'radiator corner'])
  assert.deepEqual(result.referencePhotos?.map((photo) => [photo.role, photo.label]), [['landmark', 'north door frame'], ['headingMarker', 'radiator corner']])
  assert.equal(FLOOR_Y, -1.2)
})

// ── The check point (WP-04b), by what a person sees and what is recorded ────────────────────────────────

const photoRoles = (name: string) => returned(name).referencePhotos?.map((photo) => [photo.role, photo.label])
const ringsOf = (name: string) => outcome(name).scene.filter((entry) => entry.name === 'calibration stored reference')
const gapsOf = (name: string) => outcome(name).scene.filter((entry) => entry.name === 'calibration stored reference gap')

test('after the heading marker the card is the check-point step: what it asks, who the label field names, and the ways on', () => {
  const card = outcome('first calibration with a check point, named and photographed').looks['check step']!
  assert.equal(card.title, 'Add a check point (recommended)')
  assert.match(card.copy, /^Step 3 of 3 \(optional\) — tap a third ground feature at least 3 m from point A and 2 m off the line from A to B\. Later visits can then compare the shape the three points make/)
  assert.equal(card.status, 'Tap the ground to place the check point.')
  assert.equal(card.label.hidden, true, 'a field here would name a point that is not there yet')
  assert.deepEqual(card.shown, ['check', 'fallback', 'skip'], 'skip the step, the one-point tier, or continue uncalibrated: the commit is not offered until the step is answered')
  assert.match(card.separation.text, /^3\.50 m apart\. Estimate: /, 'the pair\'s line is still there')
})

test('a first calibration with a check point stores it in the Place frame with its name, and takes a third photo under the role the schema names', () => {
  const result = returned('first calibration with a check point, named and photographed')
  const frame = result.spatialFrame as { checkPoints: Array<Record<string, unknown>>; pointLabels: string[] }
  assert.equal(frame.checkPoints.length, 1)
  assert.equal(frame.checkPoints[0]!['label'], 'by the radiator')
  assert.deepEqual(frame.pointLabels, ['north door frame', ''], 'the label typed once the check point is down names the check point, not point B')
  assert.deepEqual(photoRoles('first calibration with a check point, named and photographed'), [['landmark', 'north door frame'], ['headingMarker', null], ['check1', 'by the radiator']])
  assert.ok(!('fit' in result.calibration) && !('checkedBy' in result.calibration), 'a first calibration compared nothing')
  assert.deepEqual(outcome('first calibration with a check point, named and photographed').scene.map((entry) => entry.name), ['calibration origin', 'calibration anchor check'])
  const review = outcome('first calibration with a check point, named and photographed').looks['review with the check point']!
  assert.match(review.separation.text, /^Point C: 2\.8 m from A, 2\.6 m off the A–B line\. Estimate: .* At least 3 m from A and 2 m off the line is better\.$/)
  assert.match(review.copy, /all three sit on features/)
})

test('a check point taken and then removed leaves the frame the pair it always was, with no photo for it', () => {
  const result = returned('first calibration, check point taken and then removed')
  assert.ok(!('checkPoints' in (result.spatialFrame ?? {})))
  assert.deepEqual(photoRoles('first calibration, check point taken and then removed'), [['landmark', null], ['headingMarker', null]])
  assert.match(outcome('first calibration, check point taken and then removed').looks['after removing']!.separation.text, /^3\.50 m apart\. Estimate: /)
})

test('skipping the step is not final: review offers the check point again, and it commits like any other', () => {
  const skipped = outcome('first calibration, check point skipped and added back from review')
  assert.ok(skipped.looks['skipped']!.shown.includes('check'), 'the one button is there, now to add')
  assert.equal(skipped.looks['asked again']!.title, 'Add a check point (recommended)')
  assert.equal((returned('first calibration, check point skipped and added back from review').spatialFrame as { checkPoints: unknown[] }).checkPoints.length, 1)
})

test('a check point the fit cannot use is red, cannot be committed, and a script\'s press is turned away with the same sentence', () => {
  const found = outcome('first calibration, check point almost on the line')
  const sentence = 'Point C: 1.8 m from A, 5 cm off the A–B line. The three points are almost on one line (3 cm off it): they need at least 20 cm. Move point C to the side.'
  assert.equal(found.looks['on the line']!.separation.state, 'short')
  assert.equal(found.looks['on the line']!.separation.text, sentence)
  assert.equal(found.looks['on the line']!.status, 'The check point cannot be used where it is. Move it or remove it.')
  assert.ok(found.looks['on the line']!.disabled.includes('commit'))
  assert.equal(found.looks['refused']!.status, sentence)
  assert.equal(found.closed, false)
  assert.equal(found.counts.compass, 0, 'and nothing was read for it')
})

test('a return visit asks for last time\'s check point with its name and distance, and offers only the way to skip it', () => {
  const card = outcome('return visit with a check point, all three re-tapped').looks['check step']!
  assert.equal(card.title, 'Tap the check point from last time')
  assert.equal(card.copy, 'Step 3 of 3 — tap point C, the check point from last time, about 2.8 m from the landmark. It lets this visit compare the shape the three points make, not only the distance between two.')
  assert.equal(card.label.hidden, true, 'the check step has no label field until its marker is down')
  assert.equal(outcome('return visit with a check point, all three re-tapped').looks['review']!.label.value, 'by the radiator', 'the stored name is prefilled once it is, as for the other two')
  assert.deepEqual(card.shown, ['check', 'skip'], 'no one-point tier on a Place that has a frame, and no commit until the step is answered')
  assert.match(card.separation.text, /^3\.50 m apart\. Stored pair: 3\.50 m\. Estimate: /)
})

test('three points re-tapped are fitted: the readout, the points one by one, the fit and the check it rests on, and a ghost with its gap for each point', () => {
  const name = 'return visit with a check point, all three re-tapped'
  const result = returned(name)
  assert.equal(result.calibration['status'], 'verified')
  assert.equal(result.calibration['checkedBy'], 'constellation')
  const fit = result.calibration['fit'] as { pointsUsed: number; perPoint: unknown[]; fitMethod: string }
  assert.deepEqual([fit.pointsUsed, fit.perPoint.length, fit.fitMethod], [3, 3, 'rigid'])
  const readout = outcome(name).looks['review']!.fit!
  assert.equal(readout.state, 'ok')
  assert.deepEqual(readout.text.split('\n'), [
    '3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).',
    'A 0.0 cm · B 0.0 cm · C 0.0 cm',
    'Not checked: that these are the same physical spots. Compare with the photos.',
  ])
  assert.equal(ringsOf(name).length, 3, 'the stored points, where this visit puts them')
  assert.equal(gapsOf(name).length, 0, 'points that agree to the millimetre have no line to draw')
})

test('a check point a metre off is a mismatch the distance check could not see: the screen, what it lists, and the way back to the markers', () => {
  const name = 'return visit with a check point, one metre off, then adjusted'
  const found = outcome(name)
  const live = found.looks['review, off']!
  assert.equal(live.fit?.state, 'mismatch', 'the readout is live before the commit is pressed')
  const screen = found.looks['mismatch']!
  assert.equal(screen.title, 'These points do not match the stored ones')
  assert.equal(screen.copy, 'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.')
  assert.deepEqual(screen.shown, ['replace', 'adjust', 'override', 'skip'])
  const lines = screen.fit!.text.split('\n')
  assert.match(lines[0]!, /^3 points are \d\d\.\d cm off the stored ones on average \(limit 8\.4 cm\)\.$/)
  assert.match(lines.at(-1)!, /^A \d\d\.\d cm · B \d\d\.\d cm · C \d\d\.\d cm$/, 'the points one by one, last')
  assert.equal(screen.fit!.state, 'mismatch')
  // Back to the markers, nothing committed, the readout still the one the markers give.
  assert.equal(found.looks['adjusting']!.title, 'Check the alignment')
  assert.equal(found.looks['adjusting']!.fit?.state, 'mismatch')
  // Moving the point redoes the comparison, and it is then verified.
  assert.equal(found.looks['after the re-tap']!.fit?.state, 'ok')
  assert.equal(returned(name).calibration['status'], 'verified')
  assert.equal(ringsOf(name).length, 3)
})

test('a swapped pair is a mismatch that says the first two points may be swapped', () => {
  const screen = outcome('return visit with a check point, pair swapped').looks['mismatch']!
  assert.equal(screen.title, 'These points do not match the stored ones')
  assert.equal(screen.fit!.text, 'The first two points may be swapped.')
})

test('skipping the check point on a return visit says what is then checked, and the visit is provisional by distance', () => {
  const name = 'return visit with a check point, check point skipped'
  assert.equal(outcome(name).looks['skipped']!.status, 'Skipped. Only the distance between the two points will be checked.')
  const calibration = returned(name).calibration
  assert.deepEqual([calibration['status'], calibration['checkedBy']], ['provisional', 'separation'])
  assert.ok(!('fit' in calibration))
  assert.equal(ringsOf(name).length, 2, 'the pair is drawn as it always was')
})

test('"Use anyway" over a failed fit replaces the frame with this visit\'s points, check point included, and keeps the fit that failed', () => {
  const name = 'return visit with a check point, mismatch, then Use anyway'
  const result = returned(name)
  assert.equal(result.calibration['status'], 'provisional')
  assert.equal(result.calibration['checkedBy'], 'constellation')
  assert.ok((result.calibration['fit'] as { rmsResidualM: number }).rmsResidualM > 0.3, 'what it measured, which is why it was a mismatch')
  const frame = result.spatialFrame as { checkPoints: Array<{ label?: string }> }
  assert.equal(frame.checkPoints.length, 1)
  assert.equal(frame.checkPoints[0]!.label, 'by the radiator', 'the name carried over from the stored point, as the other two are')
  assert.deepEqual(photoRoles(name)!.map(([role]) => role), ['landmark', 'headingMarker', 'check1'])
  assert.equal(ringsOf(name).length, 0, 'no stored points are drawn against a frame that replaces them')
})

test('a check point tapped on a table agrees in position and not in height: provisional, never a mismatch, and the readout says which', () => {
  const name = 'return visit with a check point, check point tapped on a table'
  const readout = outcome(name).looks['review']!.fit!
  assert.equal(readout.state, 'warn')
  assert.match(readout.text, /\nNot verified: Heights are \d+\.\d cm off on average \(limit 8\.4 cm\)\.\n/)
  assert.equal(returned(name).calibration['status'], 'provisional')
  assert.equal(returned(name).calibration['checkedBy'], 'constellation')
  assert.match(outcome(name).looks['review']!.status, /^That point measured 30 cm above the landmark/, 'the floor warning every marker gets')
})

test('a stored check point that cannot serve as a reference is not compared, and the readout says why and what is compared instead', () => {
  const name = 'return visit, stored check point on the line'
  const readout = outcome(name).looks['review']!.fit!
  assert.equal(readout.text, 'The stored points lie almost on one line, so which side of it the points are on cannot be checked.\nOnly the distance between the two points is compared.')
  const calibration = returned(name).calibration
  assert.deepEqual([calibration['status'], calibration['checkedBy']], ['provisional', 'separation'])
})
