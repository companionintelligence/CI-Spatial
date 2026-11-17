/**
 * The constellation flow (src/ar/constellation-flow.ts, WP-04b): what a third point does to a calibration, held to the
 * claims the design makes of it.
 *
 *  1. THE CHECK POINT'S PLACE. A first calibration is offered one; a return visit is offered it only where the Place already
 *     stores one, to re-tap; a Place with a two-point frame and none is never offered one (it would freeze that visit's own
 *     two-point error into the reference).
 *  2. THE COMPARISON. Three points tapped against a stored check point are fitted, and the fit's matrix is the visit's
 *     `sessionToProject`. A pair at the right spacing but turned, a check point on the wrong side, a swapped pair and a point a
 *     metre off are rejected (over 99% of 2,000 seeded visits each), where the distance check passes them; correct re-taps with
 *     3 cm of noise are not rejected (over 99%). Two points are only ever provisional, by distance.
 *  3. THE GHOSTS. A ghost sits where the stored point lands in this session, and the line from the marker to it is exactly the
 *     point's residual, which is the figure the card prints.
 *  4. THE STAGE LIST AND THE BUTTON. What each progress dot and the one check-point button show, for every stage.
 *  5. PURITY. The module reads no DOM, no Deno API, no clock, no randomness and no scene, and imports only the world modules
 *     and the flow's own copy (ADR 0002).
 *
 * The sentences themselves are held in tests/unit/node/wp-constellation-copy.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-constellation-flow.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHECK_POINT_DEFAULT_ON,
  checkAction,
  checkPointState,
  compareVisit,
  comparedPoints,
  ghostPlan,
  newReference,
  planCheckPoint,
  previewVisit,
  stepStates,
  stepsInVisit,
  storedPoints,
  type CheckPlan,
  type VisitPoints,
} from '../../../src/ar/constellation-flow.ts'
import type { TwoPointFrame } from '../../../src/ar/calibration-commit.ts'
import {
  RMS_GATE_SIGMAS,
  fitRigid2D,
  frameUncertaintyAt,
  twoPointToleranceM,
  ACCURACY_TARGET_M,
} from '../../../src/world/frame-fit.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { transformPoint, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SIGMA = 0.03

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A stored constellation in the Place frame: the landmark at the origin, the heading marker 3.5 m along +Z and a check point
 * 2.6 m to one side of the line, a metre along it. Its three sides are 3.5, 2.8 and 3.6 m, so no other order of the points fits
 * as well (an equilateral triangle would), and it is spread enough to predict an accuracy inside the product's target.
 */
const L: Vec3 = { x: 0, y: 0, z: 0 }
const H: Vec3 = { x: 0, y: 0, z: 3.5 }
const C: Vec3 = { x: -2.6, y: 0, z: 1 }

const frame = (over: Partial<TwoPointFrame> = {}): TwoPointFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: L,
  headingMarker: H,
  separationM: 3.5,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  checkPoints: [{ ...C, label: 'radiator' }],
  ...over,
})

const without = (key: 'checkPoints'): TwoPointFrame => {
  const copy = frame() as Record<string, unknown>
  delete copy[key]
  return copy as unknown as TwoPointFrame
}

test('the fixture is a shape the design can verify: another order does not fit, and the predicted accuracy is inside the target', () => {
  const own = fitRigid2D([L, H, C], [L, H, C])
  // A shape that is its own mirror image comes back as "mirrored" from a fit to itself, with the order search attached.
  const other = own.ok ? own.fit.alternativeOrder : own.failure.reason === 'mirrored' ? own.failure.alternativeOrder : null
  assert.ok(other && other.rmsM > 4 * RMS_GATE_SIGMAS * SIGMA, `another order leaves ${other?.rmsM} m`)
  const predicted = frameUncertaintyAt([L, H, C], SIGMA, 5)
  assert.ok(predicted && predicted.position95M < ACCURACY_TARGET_M)
})

/** mulberry32: a seeded generator, so a failure here is a failure on every machine. */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(random: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = random()
  while (v === 0) v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Where a Place-frame point is in a session that is the Place frame turned by `turnDeg` about Y and then shifted. */
function inSession(point: Vec3, turnDeg: number, shift: { x: number; z: number }, floorY: number): Vec3 {
  const t = (turnDeg * Math.PI) / 180
  return {
    x: point.x * Math.cos(t) + point.z * Math.sin(t) + shift.x,
    y: floorY + point.y,
    z: -point.x * Math.sin(t) + point.z * Math.cos(t) + shift.z,
  }
}

interface Draw {
  random: () => number
  turnDeg: number
  shift: { x: number; z: number }
  floorY: number
}

const draw = (random: () => number): Draw => ({
  random,
  turnDeg: random() * 360,
  shift: { x: (random() - 0.5) * 8, z: (random() - 0.5) * 8 },
  floorY: -1.2 + (random() - 0.5) * 0.2,
})

/** A tap on the point, with `sigma` of noise on every axis. */
const tap = (d: Draw, point: Vec3, sigma = SIGMA): Vec3 => {
  const at = inSession(point, d.turnDeg, d.shift, d.floorY)
  return { x: at.x + sigma * gaussian(d.random), y: at.y + sigma * gaussian(d.random), z: at.z + sigma * gaussian(d.random) }
}

const visitOf = (landmark: Vec3, headingMarker: Vec3, checkPoint: Vec3 | null): VisitPoints => ({ landmark, headingMarker, checkPoint })

const compare = (tapped: VisitPoints, stored: TwoPointFrame = frame(), extra: { unitsMode?: 'metric' | 'estimated-metric' | 'arbitrary' } = {}) =>
  compareVisit({ tapped, stored, sigmaHatM: SIGMA, ...extra })

// ── 1. The check point's place ───────────────────────────────────────────────────────────────────────

test('a first calibration is offered a check point, by default and skippable; the switch turns the default off but not the offer', () => {
  assert.equal(CHECK_POINT_DEFAULT_ON, true, 'the brief\'s recommended option: on, skippable')
  assert.deepEqual(planCheckPoint(null), { offered: true, automatic: true, stored: null })
  assert.deepEqual(planCheckPoint(null, false), { offered: true, automatic: false, stored: null }, 'off: not entered by itself, still on offer from review')
})

test('a Place that stores a check point has it re-tapped, whatever the default says', () => {
  const plan = planCheckPoint(frame(), false)
  assert.deepEqual(plan, { offered: true, automatic: true, stored: { ...C, label: 'radiator' } })
})

test('a Place with a two-point frame and no check point is never offered one: it would freeze this visit\'s own error into the reference', () => {
  assert.deepEqual(planCheckPoint(without('checkPoints')), { offered: false, automatic: false, stored: null })
  assert.deepEqual(planCheckPoint(frame({ checkPoints: [] })), { offered: false, automatic: false, stored: null })
})

test('a damaged stored check point is not a check point: the run of usable ones ends at the first that is not a point', () => {
  const broken = frame({ checkPoints: [{ x: Number.NaN, y: 0, z: 1 }, C] })
  assert.equal(planCheckPoint(broken).offered, false)
  const second = frame({ checkPoints: [C, { x: 1, y: 0, z: Number.POSITIVE_INFINITY }] })
  assert.deepEqual(storedPoints(second), [L, H, C], 'only the usable run is matched, in order')
})

test('the stored points are the landmark, the heading marker and the check points, in that order, without their labels and photos', () => {
  const points = storedPoints(frame())
  assert.deepEqual(points, [L, H, C])
  assert.ok(points && !('label' in points[2]!), 'a copy of the coordinates only')
  assert.equal(storedPoints(frame({ landmark: undefined as unknown as Vec3 })), null, 'a damaged landmark leaves nothing to fit')
})

// ── 2. The comparison ────────────────────────────────────────────────────────────────────────────────

test('three points re-tapped exactly are fitted: the fit\'s matrix is the visit\'s sessionToProject and carries each tap onto its stored point', () => {
  const d = { random: seeded(1), turnDeg: 37, shift: { x: 2, z: -3 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, C, 0))
  const comparison = compare(tapped)
  assert.equal(comparison.checkedBy, 'constellation')
  assert.ok(comparison.fit && comparison.fit.pointsUsed === 3)
  assert.equal(comparison.sessionToProject, comparison.fit.matrix, 'IS the fit, not a copy of the two-point transform')
  for (const [from, to] of [[tapped.landmark, L], [tapped.headingMarker, H], [tapped.checkPoint!, C]] as const) {
    const placed = transformPoint(comparison.sessionToProject, from)
    assert.ok(Math.hypot(placed.x - to.x, placed.z - to.z) < 1e-9)
  }
  assert.equal(comparison.verdict.status, 'verified')
  assert.ok(comparison.fit.rmsResidualM < 1e-9)
})

test('the same three points are not what the two-point transform would give: the constellation moves the origin off the landmark by the noise', () => {
  const d = { random: seeded(2), turnDeg: 80, shift: { x: 1, z: 1 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L), tap(d, H), tap(d, C))
  const comparison = compare(tapped)
  const twoPoint = twoPointToProjectTransform(tapped.landmark, tapped.headingMarker)
  assert.notDeepEqual(comparison.sessionToProject, twoPoint)
  const landmarkAt = transformPoint(comparison.sessionToProject, tapped.landmark)
  assert.ok(Math.hypot(landmarkAt.x, landmarkAt.z) > 0, 'the least-squares frame does not pin the landmark to the origin')
  assert.ok(Math.hypot(landmarkAt.x, landmarkAt.z) < 0.2)
})

const RUNS = 2_000

function tally(make: (d: Draw) => VisitPoints, stored: TwoPointFrame = frame()) {
  const random = seeded(20261117)
  const counts = { verified: 0, provisional: 0, mismatch: 0 }
  for (let i = 0; i < RUNS; i++) counts[compare(make(draw(random)), stored).verdict.status] += 1
  return counts
}

test('correct re-taps with 3 cm of noise are not rejected (over 99%) and are verified (over 96%)', () => {
  const counts = tally((d) => visitOf(tap(d, L), tap(d, H), tap(d, C)))
  assert.ok(counts.mismatch / RUNS < 0.01, JSON.stringify(counts))
  assert.ok(counts.verified / RUNS > 0.96, JSON.stringify(counts))
})

test('a pair turned 20 degrees about the landmark at the same spacing is rejected by the fit, and passes the distance check', () => {
  const turned = (d: Draw): VisitPoints => {
    const t = (20 * Math.PI) / 180
    const moved: Vec3 = { x: H.z * Math.sin(t), y: 0, z: H.z * Math.cos(t) }
    return visitOf(tap(d, L), tap(d, moved), tap(d, C))
  }
  assert.ok(tally(turned).mismatch / RUNS > 0.99)
  // The distance between the two is exactly what was stored, so the check made before the fit cannot see it.
  const random = seeded(5)
  let passed = 0
  for (let i = 0; i < RUNS; i++) {
    const d = draw(random)
    const t = turned(d)
    if (compare(visitOf(t.landmark, t.headingMarker, null)).verdict.status !== 'mismatch') passed += 1
  }
  assert.ok(passed / RUNS > 0.9, `the two-point comparison passed ${passed} of ${RUNS}`)
})

test('a check point on the wrong side of the line is rejected (over 99%): the pair alone cannot say which side it is on', () => {
  const counts = tally((d) => visitOf(tap(d, L), tap(d, H), tap(d, { x: -C.x, y: 0, z: C.z })))
  assert.ok(counts.mismatch / RUNS > 0.99, JSON.stringify(counts))
})

test('a swapped pair is rejected (over 99%), and the verdict says the first two points may be swapped', () => {
  const counts = tally((d) => visitOf(tap(d, H), tap(d, L), tap(d, C)))
  assert.ok(counts.mismatch / RUNS > 0.99, JSON.stringify(counts))
  const d = { random: seeded(9), turnDeg: 10, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const swapped = compare(visitOf(tap(d, H, 0), tap(d, L, 0), tap(d, C, 0)))
  assert.equal(swapped.verdict.status, 'mismatch')
  assert.ok(swapped.verdict.reasons.some((reason) => /swapped|another order/.test(reason)), swapped.verdict.reasons.join(' | '))
})

test('a check point a metre off is rejected (over 99%), with the points one by one in the fit', () => {
  const counts = tally((d) => visitOf(tap(d, L), tap(d, H), tap(d, { ...C, x: C.x, z: C.z + 1 })))
  assert.ok(counts.mismatch / RUNS > 0.99, JSON.stringify(counts))
  const d = { random: seeded(11), turnDeg: 200, shift: { x: 3, z: 3 }, floorY: -1.2 }
  const off = compare(visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, { ...C, z: C.z + 1 }, 0)))
  assert.equal(off.fit?.perPoint.length, 3)
  assert.ok((off.fit?.rmsResidualM ?? 0) > 0.2)
})

test('a rigid shift of all three points is not seen by any check made from the taps alone (the known limit the card names)', () => {
  const d = { random: seeded(12), turnDeg: 15, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const shifted = (point: Vec3): Vec3 => tap(d, { x: point.x + 0.5, y: point.y, z: point.z + 0.5 }, 0)
  const comparison = compare(visitOf(shifted(L), shifted(H), shifted(C)))
  assert.equal(comparison.verdict.status, 'verified')
  assert.ok(comparison.verdict.reasons.some((reason) => /Not checked: that these are the same physical spots/.test(reason)), 'and it says what it cannot see')
})

test('two points are only ever compared by distance, and a distance check is never verified', () => {
  const random = seeded(3)
  for (let i = 0; i < 500; i++) {
    const d = draw(random)
    const comparison = compare(visitOf(tap(d, L), tap(d, H), null))
    assert.equal(comparison.checkedBy, 'separation')
    assert.equal(comparison.fit, null)
    assert.notEqual(comparison.verdict.status, 'verified')
  }
})

test('a visit that skipped the check point is built on the two-point transform, exactly as before there was a fit', () => {
  const d = { random: seeded(4), turnDeg: 61, shift: { x: 1, z: 2 }, floorY: -1.2 }
  const landmark = tap(d, L)
  const headingMarker = tap(d, H)
  const comparison = compare(visitOf(landmark, headingMarker, null))
  assert.deepEqual(comparison.sessionToProject, twoPointToProjectTransform(landmark, headingMarker))
  assert.equal(comparison.separationM, Math.hypot(headingMarker.x - landmark.x, headingMarker.z - landmark.z))
  assert.equal(comparison.residualM, comparison.separationM - 3.5)
  assert.equal(comparison.toleranceM, twoPointToleranceM(SIGMA))
})

test('a visit to a frame with no check point ignores a check point it tapped: nothing is added to an existing frame', () => {
  const d = { random: seeded(6), turnDeg: 5, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const comparison = compare(visitOf(tap(d, L), tap(d, H), tap(d, C)), without('checkPoints'))
  assert.equal(comparison.checkedBy, 'separation')
  assert.equal(comparison.fit, null)
})

test('stored points that cannot serve as a reference compare nothing, and the visit falls back to distance and says why', () => {
  const online = frame({ checkPoints: [{ x: 0, y: 0, z: 1.8 }] })
  const d = { random: seeded(7), turnDeg: 90, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const comparison = compare(visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, { x: 0, y: 0, z: 1.8 }, 0)), online)
  assert.equal(comparison.checkedBy, 'separation')
  assert.equal(comparison.fit, null)
  assert.match(comparison.uncompared ?? '', /lie almost on one line/)
  assert.notEqual(comparison.verdict.status, 'verified')
})

test('a stored separation that is not a number compares nothing: provisional, never verified (it used to be called verified)', () => {
  const d = { random: seeded(8), turnDeg: 0, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const comparison = compare(visitOf(tap(d, L, 0), tap(d, H, 0), null), frame({ separationM: Number.NaN }))
  assert.equal(comparison.verdict.status, 'provisional')
  assert.equal(comparison.verdict.compared, 'nothing')
})

test('a check point tapped on a table holds back "verified" and is not a mismatch: heights are compared, and only withhold', () => {
  const d = { random: seeded(10), turnDeg: 140, shift: { x: -2, z: 1 }, floorY: -1.2 }
  const high = tap(d, { ...C, y: 0.3 }, 0)
  const comparison = compare(visitOf(tap(d, L, 0), tap(d, H, 0), high))
  assert.equal(comparison.verdict.status, 'provisional')
  assert.ok(comparison.verdict.status === 'provisional' && (comparison.verdict.withheld ?? []).some((reason) => /^Heights are/.test(reason)))
  assert.ok(comparison.verdict.reasons.some((reason) => /^Heights are/.test(reason)))
})

test('the phone\'s units reach the verdict: a phone whose unit is not the metre says sizes in metres were not checked', () => {
  const d = { random: seeded(13), turnDeg: 30, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, C, 0))
  const sizes = "Not checked: sizes in metres. This phone's units are not metres."
  assert.ok(compare(tapped, frame(), { unitsMode: 'arbitrary' }).verdict.reasons.includes(sizes))
  assert.ok(!compare(tapped, frame(), { unitsMode: 'metric' }).verdict.reasons.includes(sizes))
  assert.ok(!compare(tapped).verdict.reasons.includes(sizes), 'nothing said when the provider says nothing')
})

// ── A check point for a new frame ────────────────────────────────────────────────────────────────────

test('a new frame stores the check point carried into the frame the new pair defines, at its own height above the landmark', () => {
  const landmark = { x: 1, y: -1.2, z: 2 }
  const headingMarker = { x: 4, y: -1.19, z: 2 }
  const checkPoint = { x: 2.5, y: -1.13, z: 4.6 }
  const made = newReference(landmark, headingMarker, checkPoint)
  assert.equal(made.problem, null)
  const expected = transformPoint(twoPointToProjectTransform(landmark, headingMarker), checkPoint)
  assert.deepEqual(made.checkPoint, expected)
  assert.ok(Math.abs(made.checkPoint!.y - 0.07) < 1e-9, 'a few centimetres above the landmark: its own height, not forced flat')
  assert.deepEqual(newReference(landmark, headingMarker, null), { checkPoint: null, problem: null })
})

test('a check point the fit cannot use is refused with the fit\'s reason: on the line, or on top of another point', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  const headingMarker = { x: 3, y: 0, z: 0 }
  const onLine = newReference(landmark, headingMarker, { x: 1.5, y: 0, z: 0.05 })
  assert.equal(onLine.checkPoint, null)
  assert.equal(onLine.problem?.reason, 'collinear')
  const onTop = newReference(landmark, headingMarker, { x: 0.1, y: 0, z: 0.2 })
  assert.equal(onTop.checkPoint, null)
  assert.equal(onTop.problem?.reason, 'duplicate-points')
  const state = checkPointState(landmark, headingMarker, { x: 1.5, y: 0, z: 2.5 })
  assert.equal(state.problem, null)
  assert.ok(state.geometry && Math.abs(state.geometry.offLineM - 2.5) < 1e-12 && Math.abs(state.geometry.distanceM - Math.hypot(1.5, 2.5)) < 1e-12)
})

// ── 3. Ghosts ────────────────────────────────────────────────────────────────────────────────────────

test('a ghost is where the stored point lands in this session, and the gap drawn to it is the point\'s residual', () => {
  const random = seeded(14)
  for (let i = 0; i < 200; i++) {
    const d = draw(random)
    const tapped = visitOf(tap(d, L), tap(d, H), tap(d, C))
    const comparison = compare(tapped)
    const ghosts = ghostPlan({ drawn: tapped, stored: frame(), comparison })
    assert.equal(ghosts.length, 3)
    assert.deepEqual(ghosts.map((g) => g.role), ['landmark', 'heading', 'check'])
    const inverse = invertAffine(comparison.sessionToProject)!
    ;[L, H, C].forEach((stored, index) => {
      const ghost = ghosts[index]!
      const landed = transformPoint(inverse, stored)
      assert.ok(Math.hypot(ghost.ghost.x - landed.x, ghost.ghost.z - landed.z) < 1e-9, 'at the inverse-mapped stored point')
      assert.equal(ghost.ghost.y, ghost.tap.y, 'drawn at the height of the marker beside it')
      const gap = Math.hypot(ghost.ghost.x - ghost.tap.x, ghost.ghost.z - ghost.tap.z)
      assert.ok(Math.abs(gap - comparison.fit!.perPoint[index]!.residualM) < 1e-9, `the line is the residual (${gap})`)
      assert.equal(ghost.residualM, comparison.fit!.perPoint[index]!.residualM)
    })
  }
})

test('ghosts are drawn at the heights the markers are drawn at, not the heights they were tapped at', () => {
  const d = { random: seeded(15), turnDeg: 0, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, { ...C, y: 0.1 }, 0))
  const drawn = visitOf(tapped.landmark, { ...tapped.headingMarker, y: tapped.landmark.y }, { ...tapped.checkPoint!, y: tapped.landmark.y })
  const ghosts = ghostPlan({ drawn, stored: frame(), comparison: compare(tapped) })
  assert.deepEqual(ghosts.map((g) => g.ghost.y), [drawn.landmark.y, drawn.headingMarker.y, drawn.checkPoint!.y])
})

test('a pair has two ghosts and no residuals: the stored landmark on the landmark tapped, the stored marker at the stored distance along the baseline', () => {
  const landmark = { x: 1, y: -1.2, z: 2 }
  const headingMarker = { x: 3.4, y: -1.2, z: 4.1 }
  const stored = without('checkPoints')
  const comparison = compare(visitOf(landmark, headingMarker, null), stored)
  const ghosts = ghostPlan({ drawn: visitOf(landmark, headingMarker, null), stored, comparison })
  assert.equal(ghosts.length, 2)
  assert.deepEqual(ghosts.map((g) => g.residualM), [null, null])
  const measured = Math.hypot(headingMarker.x - landmark.x, headingMarker.z - landmark.z)
  const along = 3.5 / measured
  assert.ok(Math.hypot(ghosts[0]!.ghost.x - landmark.x, ghosts[0]!.ghost.z - landmark.z) < 1e-9)
  assert.ok(Math.abs(ghosts[1]!.ghost.x - (landmark.x + (headingMarker.x - landmark.x) * along)) < 1e-9)
  assert.ok(Math.abs(ghosts[1]!.ghost.z - (landmark.z + (headingMarker.z - landmark.z) * along)) < 1e-9)
})

test('points that could not be fitted at all still show where the check point should be: through the frame the pair makes, across the line from the tap', () => {
  // A check point tapped on the wrong side of the line: nothing turns and shifts the three onto the stored ones, so there is no fit
  // to invert. The pair still makes a frame, and the stored check point lands in it where the pair says it should be.
  const d = { random: seeded(19), turnDeg: 40, shift: { x: 2, z: -1 }, floorY: -1.2 }
  const wrong = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, { x: -C.x, y: 0, z: C.z }, 0))
  const comparison = compare(wrong)
  assert.equal(comparison.fit, null)
  assert.equal(comparison.verdict.status, 'mismatch')
  assert.equal(comparison.checkedBy, 'constellation')
  const ghosts = ghostPlan({ drawn: wrong, stored: frame(), comparison })
  assert.deepEqual(ghosts.map((g) => g.role), ['landmark', 'heading', 'check'])
  // The check point's ghost is where the stored check point lands through the inverse of the pair's own transform, which is the
  // physical spot the person should have tapped (the check point on its own side), up to the tap noise (none here).
  const right = tap(d, C, 0)
  assert.ok(Math.hypot(ghosts[2]!.ghost.x - right.x, ghosts[2]!.ghost.z - right.z) < 1e-9, 'on the right side, where the stored point is')
  const gap = Math.hypot(ghosts[2]!.ghost.x - wrong.checkPoint!.x, ghosts[2]!.ghost.z - wrong.checkPoint!.z)
  assert.ok(gap > 2, `across the line from where it was tapped (${gap} m)`)
  assert.ok(Math.abs(ghosts[2]!.residualM! - gap) < 1e-9, 'and the line drawn to it is that gap')
  // The pair has no residuals: what was compared was their positions against each other, which agree by construction.
  assert.deepEqual([ghosts[0]!.residualM, ghosts[1]!.residualM], [null, null])
  // A visit that never tapped a check point has the pair's two ghosts, as before.
  assert.equal(ghostPlan({ drawn: visitOf(wrong.landmark, wrong.headingMarker, null), stored: frame(), comparison: compare(visitOf(wrong.landmark, wrong.headingMarker, null)) }).length, 2)
})

test('nothing is drawn when the visit\'s matrix cannot be inverted or the frame has no points', () => {
  const d = { random: seeded(16), turnDeg: 0, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, C, 0))
  const comparison = compare(tapped)
  assert.deepEqual(ghostPlan({ drawn: tapped, stored: frame(), comparison: { ...comparison, sessionToProject: new Array(16).fill(0) } }), [])
  assert.deepEqual(ghostPlan({ drawn: tapped, stored: frame({ landmark: undefined as unknown as Vec3 }), comparison }), [])
})

test('the live preview follows a re-tap: moving one marker redoes the comparison, its ghosts and its residuals', () => {
  const d = { random: seeded(17), turnDeg: 25, shift: { x: 1, z: 1 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, { ...C, z: C.z + 0.8 }, 0))
  const before = previewVisit({ tapped, drawn: tapped, stored: frame(), sigmaHatM: SIGMA })!
  assert.equal(before.comparison.verdict.status, 'mismatch')
  const moved = visitOf(tapped.landmark, tapped.headingMarker, tap(d, C, 0))
  const after = previewVisit({ tapped: moved, drawn: moved, stored: frame(), sigmaHatM: SIGMA })!
  assert.equal(after.comparison.verdict.status, 'verified')
  assert.ok(after.ghosts[2]!.residualM! < before.ghosts[2]!.residualM!)
  assert.notDeepEqual(after.ghosts, before.ghosts)
})

test('there is no live preview without a stored check point to compare with or a check marker placed', () => {
  const d = { random: seeded(18), turnDeg: 0, shift: { x: 0, z: 0 }, floorY: -1.2 }
  const tapped = visitOf(tap(d, L, 0), tap(d, H, 0), tap(d, C, 0))
  assert.equal(previewVisit({ tapped, drawn: tapped, stored: null, sigmaHatM: SIGMA }), null)
  assert.equal(previewVisit({ tapped, drawn: tapped, stored: without('checkPoints'), sigmaHatM: SIGMA }), null)
  const noCheck = visitOf(tapped.landmark, tapped.headingMarker, null)
  assert.equal(previewVisit({ tapped: noCheck, drawn: noCheck, stored: frame(), sigmaHatM: SIGMA }), null)
})

// ── 4. The stage list and the button ─────────────────────────────────────────────────────────────────

/** What the visit's plan for a check point comes to, as `planCheckPoint` makes it: offered by itself (a first calibration, or a Place that stores one). */
const AUTOMATIC: CheckPlan = { offered: true, automatic: true, stored: null }
/** Offered only from review (the default switched off). */
const FROM_REVIEW: CheckPlan = { offered: true, automatic: false, stored: null }
/** Not offered: a Place with a pair and no check point. */
const NOT_OFFERED: CheckPlan = { offered: false, automatic: false, stored: null }

test('the progress dots: each stage lights the step it is on, review is on the last marker placed, and the check dot is hidden when the visit takes none', () => {
  assert.deepEqual(stepStates('ground', AUTOMATIC, false), { ground: 'active', landmark: 'todo', heading: 'todo', check: 'todo' })
  assert.deepEqual(stepStates('landmark', AUTOMATIC, false), { ground: 'done', landmark: 'active', heading: 'todo', check: 'todo' })
  assert.deepEqual(stepStates('heading', AUTOMATIC, false), { ground: 'done', landmark: 'done', heading: 'active', check: 'todo' })
  assert.deepEqual(stepStates('check', AUTOMATIC, false), { ground: 'done', landmark: 'done', heading: 'done', check: 'active' })
  assert.deepEqual(stepStates('review', AUTOMATIC, true), { ground: 'done', landmark: 'done', heading: 'done', check: 'active' })
  assert.deepEqual(stepStates('mismatch', AUTOMATIC, true), stepStates('review', AUTOMATIC, true))
  assert.deepEqual(stepStates('review', NOT_OFFERED, false), { ground: 'done', landmark: 'done', heading: 'active', check: 'hidden' }, 'what it always showed')
  assert.deepEqual(stepStates('heading', NOT_OFFERED, false), { ground: 'done', landmark: 'done', heading: 'active', check: 'hidden' })
})

test('a check step that was skipped, or taken away again, is not "to do": the dot says skipped once the placing is over without it', () => {
  // The card has moved on to "Check the alignment": a dot still saying "to do" would promise a step that is not coming.
  for (const stage of ['review', 'mismatch'] as const) {
    assert.deepEqual(stepStates(stage, AUTOMATIC, false), { ground: 'done', landmark: 'done', heading: 'active', check: 'skipped' }, stage)
  }
  // Before then it is to do, and in the step itself it is the step.
  for (const stage of ['ground', 'landmark', 'heading'] as const) assert.equal(stepStates(stage, AUTOMATIC, false).check, 'todo', stage)
  assert.equal(stepStates('check', AUTOMATIC, false).check, 'active')
  // Added back from review it is the step again.
  assert.equal(stepStates('review', AUTOMATIC, true).check, 'active')
})

test('a check point offered only from review has no dot until it is taken: the steps do not promise it', () => {
  for (const stage of ['ground', 'landmark', 'heading', 'review', 'mismatch'] as const) {
    assert.equal(stepStates(stage, FROM_REVIEW, false).check, 'hidden', stage)
  }
  assert.equal(stepStates('check', FROM_REVIEW, false).check, 'active', 'taken from review: the step is open')
  assert.equal(stepStates('review', FROM_REVIEW, true).check, 'active', 'and placed')
})

test('the counters count the taps the visit asks for: three when the check point follows the heading marker by itself, otherwise two', () => {
  assert.equal(stepsInVisit(AUTOMATIC), 3)
  assert.equal(stepsInVisit(planCheckPoint(frame())), 3, 'a return visit to a Place that stores one re-taps it')
  assert.equal(stepsInVisit(FROM_REVIEW), 2, 'offered from review is not a step the counters promise')
  assert.equal(stepsInVisit(NOT_OFFERED), 2)
  assert.equal(stepsInVisit(planCheckPoint(without('checkPoints'))), 2)
  assert.equal(stepsInVisit(planCheckPoint(null, false)), 2)
})

test('the points a return visit is compared with are the stored landmark, heading marker and first check point, or none', () => {
  assert.deepEqual(comparedPoints(frame()), [L, H, C])
  assert.deepEqual(comparedPoints(frame({ checkPoints: [C, { x: 1, y: 0, z: 1 }] })), [L, H, C], 'the first check point only: the one the UI re-taps')
  assert.equal(comparedPoints(without('checkPoints')), null, 'a pair is compared by distance')
  assert.equal(comparedPoints(null), null, 'a first calibration compares nothing')
  assert.equal(comparedPoints(frame({ headingMarker: undefined as unknown as Vec3 })), null, 'a damaged record leaves nothing to compare')
})

test('the check-point button skips the step, adds the point back from review, takes a placed one away, and is never there otherwise', () => {
  const first = planCheckPoint(null)
  const returning = planCheckPoint(frame())
  const none = planCheckPoint(without('checkPoints'))
  const usable = { pairUsable: true }
  assert.deepEqual(checkAction({ stage: 'check', plan: first, hasCheck: false, ...usable }), { kind: 'skip', label: 'Skip the check point' })
  assert.deepEqual(checkAction({ stage: 'review', plan: first, hasCheck: false, ...usable }), { kind: 'add', label: 'Add a check point (recommended)' })
  assert.deepEqual(checkAction({ stage: 'review', plan: first, hasCheck: true, ...usable }), { kind: 'remove', label: 'Remove the check point' })
  assert.deepEqual(checkAction({ stage: 'review', plan: returning, hasCheck: false, ...usable }), { kind: 'add', label: 'Tap the check point from last time' })
  for (const stage of ['ground', 'landmark', 'heading', 'mismatch'] as const) {
    assert.equal(checkAction({ stage, plan: first, hasCheck: false, ...usable }), null, stage)
  }
  for (const stage of ['ground', 'landmark', 'heading', 'check', 'review', 'mismatch'] as const) {
    assert.equal(checkAction({ stage, plan: none, hasCheck: false, ...usable }), null, `a Place with no check point is never offered one (${stage})`)
  }
})

test('adding a check point is not offered while the pair is under the minimum, though a placed one can still be taken away', () => {
  const first = planCheckPoint(null)
  assert.equal(checkAction({ stage: 'review', plan: first, hasCheck: false, pairUsable: false }), null)
  assert.deepEqual(checkAction({ stage: 'review', plan: first, hasCheck: true, pairUsable: false }), { kind: 'remove', label: 'Remove the check point' })
  assert.deepEqual(checkAction({ stage: 'check', plan: first, hasCheck: false, pairUsable: false }), { kind: 'skip', label: 'Skip the check point' })
})

// ── 5. Purity ────────────────────────────────────────────────────────────────────────────────────────

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('the flow and its copy read no DOM, no Deno API, no clock, no randomness and no scene, and import only the world modules and each other (ADR 0002)', () => {
  for (const file of ['src/ar/constellation-flow.ts', 'src/ar/constellation-copy.ts']) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'))
    for (const [what, pattern] of [
      ['a Deno API', /\bDeno\b/],
      ['the document or window', /\b(document|window|navigator|location|localStorage|sessionStorage|indexedDB)\b/],
      ['a DOM type', /\b(HTML\w*Element|TouchEvent|PointerEvent)\b/],
      ['the clock', /\b(Date\.now|new Date|performance\.now|setTimeout|setInterval|requestAnimationFrame)\b/],
      ['randomness', /\bMath\.random\b/],
      ['the scene', /\bTHREE\b|from 'three'/],
    ] as const) {
      assert.doesNotMatch(source, pattern, `${file} reaches for ${what}`)
    }
  }
  const flow = stripComments(readFileSync(join(ROOT, 'src/ar/constellation-flow.ts'), 'utf8'))
  assert.deepEqual(
    [...flow.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort(),
    [
      '../world/anchor-placement.ts',
      '../world/baseline-guidance.ts',
      '../world/calibration-evidence.ts',
      '../world/frame-fit.ts',
      '../world/geo.ts',
      '../world/types.ts',
      './calibration-commit.ts',
      './constellation-copy.ts',
      './one-point-offer.ts',
    ],
  )
})

test('the tap noise behind every gate is the adopted one: nothing in the flow, its copy, its scene or the modal reads a tap\'s own spread', () => {
  // `TapSample.spreadM` is how scattered one tap's burst of hits was, which is not how far apart two visits' taps of the same
  // feature land. Feeding it to the gates would make a steady hand look more reliable than it is (ADR 0005 rule 5), so
  // sigma-hat stays the adopted `TAP_SIGMA0_M` until a measurement (DX2) replaces it.
  for (const file of [
    'src/ar/constellation-flow.ts',
    'src/ar/constellation-copy.ts',
    'src/ar/constellation-ghosts.ts',
    'src/ar/project-calibration.ts',
    'src/ar/calibration-commit.ts',
    'src/world/baseline-guidance.ts',
  ]) {
    assert.doesNotMatch(stripComments(readFileSync(join(ROOT, file), 'utf8')), /spreadM/, `${file} reads a tap's spread`)
  }
})
