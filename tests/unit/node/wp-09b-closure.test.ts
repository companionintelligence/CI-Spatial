/**
 * Closure maths (WP-09b, src/ar/closure.ts): what a re-tap of the landmark (and the heading marker) says about how far
 * the session frame has moved since the Place calibration, and when that is enough to propose a re-anchor.
 *
 * The oracle is independent of the code under test. The drift is defined in the Place frame, as the rigid motion the
 * runtime is imagined to have made (a turn about a pivot and a shift), and the taps the person would make are generated
 * by carrying the drifted stored points BACK through the inverse of the scan's calibration (`invertAffine`, which the
 * closure code does not use). `measureClosure` is then given only the calibration and the taps, and must find the drift
 * that was put in: it cannot get there by sharing a line of arithmetic with how the taps were made.
 *
 * The limits are held to the work package's rule, that a closure threshold sits above three sigma of a human re-tap:
 * the constants are checked against the arithmetic, and a seeded simulation of pure tap noise (no drift at all) checks
 * that the limits are crossed by noise about once in a hundred at most, and that real drift of twice the limit is not.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-closure.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSURE_RETAP_SIGMA_M,
  CLOSURE_SIGMAS,
  CLOSURE_TRANSLATION_LIMIT_M,
  CLOSURE_YAW_FLOOR_DEG,
  closureRecord,
  closureTapSigmaM,
  closureYawLimitDeg,
  judgeClosure,
  measureClosure,
  pathLengthM,
  type ClosureMeasurement,
} from '../../../src/ar/closure.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { ACCURACY_TARGET_M, SIGMA0_M, WORKING_RADIUS_M } from '../../../src/world/frame-fit.ts'
import { transformPoint, twoPointHeadingDeg, twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const DEG = Math.PI / 180

// ── The oracle ──────────────────────────────────────────────────────────────────────────────────────

/** The turn that makes a heading larger by `deg`: +Z toward +X. The same sense as `twoPointHeadingDeg`. */
function turn(p: Vec3, deg: number, pivot: Vec3): Vec3 {
  const c = Math.cos(deg * DEG)
  const s = Math.sin(deg * DEG)
  const dx = p.x - pivot.x
  const dz = p.z - pivot.z
  return { x: pivot.x + dx * c + dz * s, y: p.y, z: pivot.z - dx * s + dz * c }
}

interface Drift {
  yawDeg: number
  pivot: Vec3
  shift: Vec3
}

/** Where the Place says a stored point is once the frame has drifted: turned about the pivot, then shifted. */
function drifted(p: Vec3, drift: Drift): Vec3 {
  const t = turn(p, drift.yawDeg, drift.pivot)
  return { x: t.x + drift.shift.x, y: t.y + drift.shift.y, z: t.z + drift.shift.z }
}

interface Scenario {
  sessionToProject: number[]
  stored: Vec3[]
  landmarkTap: Vec3
  headingTap: Vec3
}

/** A calibration made from two taps in session metres, wherever the session happened to be. */
function scenario(landmark: Vec3, headingMarker: Vec3): Scenario {
  const sessionToProject = twoPointToProjectTransform(landmark, headingMarker)
  const separation = twoPointSeparationM(landmark, headingMarker)
  return {
    sessionToProject,
    stored: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: separation }],
    landmarkTap: landmark,
    headingTap: headingMarker,
  }
}

/** The taps a person makes after the drift: the stored points, drifted in the Place frame, carried back to session metres. */
function retapsAfter(s: Scenario, drift: Drift): Vec3[] {
  const back = invertAffine(s.sessionToProject)
  assert.ok(back, 'the calibration inverts')
  return s.stored.map((p) => transformPoint(back, drifted(p, drift)))
}

const near = (actual: number | null, expected: number, tolerance: number, message: string): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${message}: ${String(actual)} is not within ${tolerance} of ${expected}`)
}

const SCENARIOS: Scenario[] = [
  scenario({ x: 0, y: -1.2, z: 0 }, { x: 0, y: -1.2, z: 3 }),
  // A session that began far from where the person stood, with the pair at an angle: nothing here is axis-aligned.
  scenario({ x: 1.5, y: -1.4, z: -0.4 }, { x: 3.1, y: -1.4, z: 2.1 }),
  scenario({ x: -4.2, y: 0.3, z: 7.7 }, { x: -6.9, y: 0.3, z: 5.2 }),
  // A short pair, as short as the commit allows.
  scenario({ x: 2, y: 0, z: 2 }, { x: 2.7, y: 0, z: 2.71 }),
]

// ── What the code recovers ──────────────────────────────────────────────────────────────────────────

test('no drift: the re-taps land on the stored points, whatever the calibration', () => {
  for (const s of SCENARIOS) {
    const result = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: [s.landmarkTap, s.headingTap] })
    assert.ok(result.ok)
    if (!result.ok) return
    near(result.closure.translationM, 0, 1e-9, 'translation')
    near(result.closure.dyM, 0, 1e-9, 'height')
    near(result.closure.yawDeg, 0, 1e-9, 'yaw')
    assert.equal(result.closure.points, 2)
  }
})

test('synthetic drift: the translation, the height and the turn that were put in come back, for every calibration', () => {
  const drifts: Drift[] = [
    { yawDeg: 0, pivot: { x: 0, y: 0, z: 0 }, shift: { x: 0.12, y: 0, z: -0.05 } },
    { yawDeg: 3, pivot: { x: 0, y: 0, z: 0 }, shift: { x: 0, y: 0.04, z: 0 } },
    { yawDeg: -7.5, pivot: { x: 1, y: 0, z: 2 }, shift: { x: -0.3, y: -0.02, z: 0.2 } },
    { yawDeg: 25, pivot: { x: -2, y: 0, z: 0.5 }, shift: { x: 0.4, y: 0.1, z: 0.4 } },
    { yawDeg: 90, pivot: { x: 0, y: 0, z: 0 }, shift: { x: 0, y: 0, z: 0 } },
    { yawDeg: -179, pivot: { x: 0.5, y: 0, z: -3 }, shift: { x: 1, y: 0, z: 1 } },
  ]
  for (const s of SCENARIOS) {
    for (const drift of drifts) {
      const result = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: retapsAfter(s, drift) })
      assert.ok(result.ok)
      if (!result.ok) return
      // The landmark is the origin, so where the drift puts it is where the Place says it is now.
      const landmark = drifted(s.stored[0]!, drift)
      const label = JSON.stringify(drift)
      near(result.closure.translationM, Math.hypot(landmark.x, landmark.z), 1e-9, `translation of ${label}`)
      near(result.closure.dyM, drift.shift.y, 1e-9, `height of ${label}`)
      near(result.closure.yawDeg, drift.yawDeg, 1e-9, `yaw of ${label}`)
    }
  }
})

test('the sign of the turn is the sign of twoPointHeadingDeg: a re-tapped marker turned toward +X is positive', () => {
  // The stored marker is at (0, 0, 2). The re-tap lands where the Place says (1, 0, sqrt 3) is: 30 degrees toward +X.
  const s = scenario({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 })
  const result = measureClosure({
    sessionToProject: s.sessionToProject,
    stored: s.stored,
    retapped: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: Math.sqrt(3) }],
  })
  assert.ok(result.ok)
  if (!result.ok) return
  near(result.closure.yawDeg, 30, 1e-9, 'turned toward +X')
  near(twoPointHeadingDeg({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: Math.sqrt(3) }), 30, 1e-9, 'twoPointHeadingDeg says the same')
  const other = measureClosure({
    sessionToProject: s.sessionToProject,
    stored: s.stored,
    retapped: [{ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: Math.sqrt(3) }],
  })
  assert.ok(other.ok)
  if (other.ok) near(other.closure.yawDeg, -30, 1e-9, 'turned toward -X')
})

test('the baseline the heading is judged over is the shorter of the stored and the re-tapped one', () => {
  const s = scenario({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 })
  const shorter = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2.2 }] })
  const longer = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3.6 }] })
  assert.ok(shorter.ok && longer.ok)
  if (shorter.ok && longer.ok) {
    near(shorter.closure.baselineM, 2.2, 1e-9, 'the re-tapped pair is shorter')
    near(longer.closure.baselineM, 3, 1e-9, 'the stored pair is shorter')
  }
})

test('a spacing that differs is not a turn: a marker re-tapped farther along the same line has no yaw and no translation', () => {
  const s = scenario({ x: 1, y: 0, z: 1 }, { x: 1, y: 0, z: 4 })
  const result = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: [s.landmarkTap, { x: 1, y: 0, z: 4.4 }] })
  assert.ok(result.ok)
  if (!result.ok) return
  near(result.closure.yawDeg, 0, 1e-9, 'yaw')
  near(result.closure.translationM, 0, 1e-9, 'translation')
})

test('the landmark alone has a translation and a height and no heading', () => {
  const s = scenario({ x: 0.4, y: -1, z: 0.2 }, { x: 2.6, y: -1, z: 1.9 })
  const drift: Drift = { yawDeg: 12, pivot: { x: 0, y: 0, z: 0 }, shift: { x: 0.06, y: -0.03, z: 0.08 } }
  const both = retapsAfter(s, drift)
  const result = measureClosure({ sessionToProject: s.sessionToProject, stored: [s.stored[0]!], retapped: [both[0]!] })
  assert.ok(result.ok)
  if (!result.ok) return
  near(result.closure.translationM, Math.hypot(0.06, 0.08), 1e-9, 'translation')
  near(result.closure.dyM, -0.03, 1e-9, 'height')
  assert.equal(result.closure.yawDeg, null, 'one point has no direction')
  assert.equal(result.closure.baselineM, null)
  assert.equal(result.closure.points, 1)
})

test('three points or more: the turn is the least-squares turn of the stored points onto the re-tapped ones', () => {
  // A triangle on the floor, turned 8 degrees about its own centre with the third point 3 cm off: the turn found is the
  // best one, within what that 3 cm can move it, and an exact rigid turn is found exactly.
  const s = scenario({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 })
  const stored: Vec3[] = [...s.stored, { x: 2.5, y: 0, z: 1.2 }]
  const back = invertAffine(s.sessionToProject)!
  const drift: Drift = { yawDeg: 8, pivot: { x: 1, y: 0, z: 1.5 }, shift: { x: 0.1, y: 0, z: -0.1 } }
  const exact = stored.map((p) => transformPoint(back, drifted(p, drift)))
  const rigid = measureClosure({ sessionToProject: s.sessionToProject, stored, retapped: exact })
  assert.ok(rigid.ok)
  if (rigid.ok) near(rigid.closure.yawDeg, 8, 1e-9, 'an exact rigid turn')
  const noisy = [...exact]
  noisy[2] = { ...noisy[2]!, x: noisy[2]!.x + 0.03 }
  const rough = measureClosure({ sessionToProject: s.sessionToProject, stored, retapped: noisy })
  assert.ok(rough.ok)
  if (rough.ok) near(rough.closure.yawDeg, 8, 1.5, 'a 3 cm slip in one point moves the best turn by at most a degree or so')
})

test('points on one spot have no direction: the turn is null rather than a number from noise', () => {
  const s = scenario({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 })
  const result = measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped: [{ x: 0.1, y: 0, z: 0.1 }, { x: 0.1, y: 0, z: 0.1 }] })
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.closure.yawDeg, null)
    near(result.closure.translationM, Math.hypot(0.1, 0.1), 1e-6, 'the landmark is still measured')
  }
})

test('a closure that cannot be made says why and does not throw', () => {
  const s = scenario({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 })
  const ok = { sessionToProject: s.sessionToProject, stored: s.stored, retapped: [s.landmarkTap, s.headingTap] }
  assert.deepEqual(measureClosure({ ...ok, stored: [], retapped: [] }), { ok: false, reason: 'points' })
  assert.deepEqual(measureClosure({ ...ok, retapped: [s.landmarkTap] }), { ok: false, reason: 'points' })
  assert.deepEqual(measureClosure({ ...ok, sessionToProject: s.sessionToProject.slice(0, 15) }), { ok: false, reason: 'not-finite' })
  assert.deepEqual(measureClosure({ ...ok, sessionToProject: s.sessionToProject.map((v, i) => (i === 3 ? NaN : v)) }), { ok: false, reason: 'not-finite' })
  assert.deepEqual(measureClosure({ ...ok, retapped: [{ x: NaN, y: 0, z: 0 }, s.headingTap] }), { ok: false, reason: 'not-finite' })
  assert.deepEqual(measureClosure({ ...ok, stored: [{ x: 0, y: 0, z: Infinity }, s.stored[1]!] }), { ok: false, reason: 'not-finite' })
})

test('the inputs are not changed', () => {
  const s = scenario({ x: 1.5, y: -1.4, z: -0.4 }, { x: 3.1, y: -1.4, z: 2.1 })
  const retapped = retapsAfter(s, { yawDeg: 5, pivot: { x: 0, y: 0, z: 0 }, shift: { x: 0.1, y: 0, z: 0 } })
  const before = JSON.stringify({ m: s.sessionToProject, st: s.stored, r: retapped })
  measureClosure({ sessionToProject: s.sessionToProject, stored: s.stored, retapped })
  assert.equal(JSON.stringify({ m: s.sessionToProject, st: s.stored, r: retapped }), before)
})

// ── The path walked ─────────────────────────────────────────────────────────────────────────────────

const at = (x: number, y: number, z: number) => ({ position: { x, y, z } })

test('the path is the sum of the straight-line steps between consecutive poses', () => {
  assert.equal(pathLengthM([]), 0)
  assert.equal(pathLengthM([at(1, 2, 3)]), 0, 'one pose has walked nowhere')
  near(pathLengthM([at(0, 0, 0), at(3, 4, 0), at(3, 4, 12)]), 17, 1e-12, 'a 3-4-5 step and then 12 straight on')
  near(pathLengthM([at(0, 0, 0), at(0, 1, 0)]), 1, 1e-12, 'height counts: the camera was carried')
})

test('the path counts from an index, and an index outside the list reads as the nearest end', () => {
  const walk = [at(0, 0, 0), at(1, 0, 0), at(2, 0, 0), at(5, 0, 0)]
  near(pathLengthM(walk, 0), 5, 1e-12, 'whole')
  near(pathLengthM(walk, 2), 3, 1e-12, 'from the third pose')
  assert.equal(pathLengthM(walk, 3), 0, 'from the last')
  near(pathLengthM(walk, -4), 5, 1e-12, 'before the start')
  assert.equal(pathLengthM(walk, 99), 0, 'after the end: the trail was emptied since the index was taken')
  near(pathLengthM(walk, Number.NaN), 5, 1e-12, 'not a number reads as the start')
})

test('a pose that is not finite is skipped and the walk goes on from the last good one, adding no jump', () => {
  const walk = [at(0, 0, 0), at(Number.NaN, 0, 0), at(3, 4, 0), at(Infinity, 0, 0), at(3, 4, 12)]
  near(pathLengthM(walk), 17, 1e-12, 'what the finite poses walked')
})

// ── The limits ──────────────────────────────────────────────────────────────────────────────────────

test('the limits are above three sigma of a human re-tap, by the arithmetic and not by luck of the rounding', () => {
  assert.equal(CLOSURE_SIGMAS, 3)
  assert.equal(CLOSURE_RETAP_SIGMA_M, 0.05, 'the top of the 3 to 5 cm the work package gives for a closure tap')
  const spread = Math.hypot(SIGMA0_M, CLOSURE_RETAP_SIGMA_M)
  assert.equal(closureTapSigmaM(), spread, 'the calibration tap and the re-tap, in quadrature')
  near(CLOSURE_TRANSLATION_LIMIT_M, 3 * spread, 1e-15, 'three of them')
  assert.ok(CLOSURE_TRANSLATION_LIMIT_M > 3 * CLOSURE_RETAP_SIGMA_M, 'above three sigma of the re-tap alone, at its 5 cm')
  assert.ok(CLOSURE_TRANSLATION_LIMIT_M > 3 * SIGMA0_M * Math.SQRT2, 'above three sigma of two taps at the calibration noise')
  // The heading limit is three sigma of the difference of two directions measured over the baseline, never below the floor.
  for (const baseline of [1, 1.5, 2, 3, 4, 5, 8]) {
    const limit = closureYawLimitDeg(baseline)
    assert.ok(limit !== null)
    const sigmaDeg = (Math.SQRT2 * spread / baseline) / DEG
    assert.ok(limit! >= CLOSURE_SIGMAS * sigmaDeg - 1e-9, `at ${baseline} m the heading limit ${limit} is below three sigma, ${CLOSURE_SIGMAS * sigmaDeg}`)
    assert.ok(limit! >= CLOSURE_YAW_FLOOR_DEG - 1e-12, `at ${baseline} m the limit is below the floor`)
  }
})

test('the heading floor is the turn that moves content at the working radius by the product target', () => {
  near(CLOSURE_YAW_FLOOR_DEG, Math.atan(ACCURACY_TARGET_M / WORKING_RADIUS_M) / DEG, 1e-12, 'floor')
  // 0.305 m at 5 m is 3.5 degrees: the work package's own figure for what the target allows.
  near(CLOSURE_YAW_FLOOR_DEG, 3.49, 0.01, 'about 3.5 degrees')
})

test('a shorter baseline gives a wider heading limit, until the floor takes over', () => {
  const at1 = closureYawLimitDeg(1)!
  const at3 = closureYawLimitDeg(3)!
  const at5 = closureYawLimitDeg(5)!
  const at9 = closureYawLimitDeg(9)!
  assert.ok(at1 > at3 && at3 > at5, `${at1} > ${at3} > ${at5}`)
  assert.equal(at5, CLOSURE_YAW_FLOOR_DEG, 'at 5 m the floor already binds')
  assert.equal(at9, CLOSURE_YAW_FLOOR_DEG)
  near(at3, 4.72, 0.01, 'about 4.7 degrees at 3 m')
  near(at1, 14.17, 0.01, 'about 14 degrees at 1 m')
})

test('a baseline that is not a positive number gets no heading limit', () => {
  for (const baseline of [0, -1, Number.NaN, Infinity, null, undefined]) {
    assert.equal(closureYawLimitDeg(baseline), null, String(baseline))
  }
})

const measured = (over: Partial<ClosureMeasurement> = {}): ClosureMeasurement => ({
  translationM: 0.05,
  dyM: 0.01,
  yawDeg: 1,
  baselineM: 3,
  points: 2,
  ...over,
})

test('a closure within the limits proposes nothing, and the comparison is strict', () => {
  const calm = judgeClosure(measured())
  assert.equal(calm.exceeded, false)
  assert.deepEqual(calm.reasons, [])
  const limit = closureYawLimitDeg(3)!
  assert.equal(judgeClosure(measured({ translationM: CLOSURE_TRANSLATION_LIMIT_M })).exceeded, false, 'exactly on the translation limit')
  assert.equal(judgeClosure(measured({ dyM: -CLOSURE_TRANSLATION_LIMIT_M })).exceeded, false, 'exactly on the height limit')
  assert.equal(judgeClosure(measured({ yawDeg: limit })).exceeded, false, 'exactly on the heading limit')
})

test('each limit proposes a re-anchor on its own, and says which', () => {
  const over = CLOSURE_TRANSLATION_LIMIT_M + 0.001
  assert.deepEqual(judgeClosure(measured({ translationM: over })).reasons, ['translation'])
  assert.deepEqual(judgeClosure(measured({ dyM: over })).reasons, ['height'])
  assert.deepEqual(judgeClosure(measured({ dyM: -over })).reasons, ['height'], 'a floor that dropped counts as much as one that rose')
  assert.deepEqual(judgeClosure(measured({ yawDeg: closureYawLimitDeg(3)! + 0.01 })).reasons, ['heading'])
  assert.deepEqual(judgeClosure(measured({ yawDeg: -(closureYawLimitDeg(3)! + 0.01) })).reasons, ['heading'], 'either way round')
  assert.deepEqual(judgeClosure(measured({ translationM: over, yawDeg: 30 })).reasons, ['translation', 'heading'])
  assert.equal(judgeClosure(measured({ translationM: over })).exceeded, true)
})

test('without a heading there is no heading to judge, and no limit is recorded for it', () => {
  const landmarkOnly = judgeClosure(measured({ yawDeg: null, baselineM: null, points: 1 }))
  assert.equal(landmarkOnly.exceeded, false)
  assert.equal(landmarkOnly.limits.yawDeg, null)
  assert.equal(landmarkOnly.limits.translationM, CLOSURE_TRANSLATION_LIMIT_M)
  assert.equal(landmarkOnly.limits.basis, 'adopted, not measured')
})

test('the heading limit follows the baseline the closure was measured over: a short one cannot propose a re-anchor on a number it cannot support', () => {
  // 20 degrees over a 3 m baseline is far past its limit (4.7). Over a 0.5 m baseline (a re-tap that landed near the
  // landmark) the limit widens to 28 degrees, and the same 20 is inside what the noise of such a pair can produce.
  assert.equal(judgeClosure(measured({ yawDeg: 20, baselineM: 3 })).exceeded, true)
  assert.equal(judgeClosure(measured({ yawDeg: 20, baselineM: 0.5 })).exceeded, false)
  near(closureYawLimitDeg(0.5), 28.35, 0.01, 'the limit at 0.5 m')
})

// ── Noise is not drift ──────────────────────────────────────────────────────────────────────────────

/** A seeded generator, so the simulation is the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/**
 * One closure of a scan whose frame did NOT move: the calibration is made from two noisy taps of the true landmark and
 * the true heading marker, and the closure from two more noisy taps of the same spots. Only tap noise is in it. The
 * `drift` is added in the Place frame on top of that when a test wants a frame that did move.
 */
function simulatedClosure(random: () => number, baselineM: number, drift?: Drift): ClosureMeasurement {
  const tap = (p: Vec3, sigma: number): Vec3 => ({ x: p.x + sigma * gaussian(random), y: p.y + sigma * gaussian(random), z: p.z + sigma * gaussian(random) })
  const landmark: Vec3 = { x: 0.7, y: -1.3, z: 2.2 }
  const marker: Vec3 = { x: landmark.x + baselineM * Math.sin(0.9), y: landmark.y, z: landmark.z + baselineM * Math.cos(0.9) }
  const calibrationLandmark = tap(landmark, SIGMA0_M)
  const calibrationMarker = tap(marker, SIGMA0_M)
  const sessionToProject = twoPointToProjectTransform(calibrationLandmark, calibrationMarker)
  const stored: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: twoPointSeparationM(calibrationLandmark, calibrationMarker) }]
  let retapped = [tap(landmark, CLOSURE_RETAP_SIGMA_M), tap(marker, CLOSURE_RETAP_SIGMA_M)]
  if (drift) {
    const back = invertAffine(sessionToProject)!
    retapped = retapped.map((p) => transformPoint(back, drifted(transformPoint(sessionToProject, p), drift)))
  }
  const result = measureClosure({ sessionToProject, stored, retapped })
  assert.ok(result.ok)
  return (result as { ok: true; closure: ClosureMeasurement }).closure
}

test('pure tap noise crosses a limit about once in a hundred checks at most, for every baseline the commit allows', () => {
  const random = mulberry32(20261116)
  const trials = 20_000
  for (const baselineM of [1, 1.5, 2, 3, 5, 8]) {
    let proposals = 0
    let translationOnly = 0
    for (let i = 0; i < trials; i++) {
      const closure = simulatedClosure(random, baselineM)
      const judged = judgeClosure(closure)
      if (judged.exceeded) proposals++
      if (judged.reasons.includes('translation')) translationOnly++
    }
    const rate = proposals / trials
    assert.ok(rate < 0.03, `at ${baselineM} m noise alone proposed a re-anchor in ${(rate * 100).toFixed(2)}% of checks`)
    // The translation limit is a 3-sigma limit on a horizontal radial error (about 1.1%) and the height limit one on a
    // single axis (0.3%), so together they are crossed by noise a little over 1% of the time.
    assert.ok(translationOnly / trials < 0.02, `at ${baselineM} m the translation limit alone was crossed ${((translationOnly / trials) * 100).toFixed(2)}% of the time`)
  }
})

test('a frame that really moved by twice the limit is found, at every baseline', () => {
  const random = mulberry32(8675309)
  const trials = 5_000
  for (const baselineM of [1, 3, 5]) {
    let found = 0
    for (let i = 0; i < trials; i++) {
      const closure = simulatedClosure(random, baselineM, {
        yawDeg: 0,
        pivot: { x: 0, y: 0, z: 0 },
        shift: { x: 2 * CLOSURE_TRANSLATION_LIMIT_M, y: 0, z: 0 },
      })
      if (judgeClosure(closure).exceeded) found++
    }
    assert.ok(found / trials > 0.99, `at ${baselineM} m a 2x shift was found in ${((found / trials) * 100).toFixed(1)}% of checks`)
  }
  // A turn of twice the heading limit over the same baseline, with the pivot at the landmark so nothing moves there.
  for (const baselineM of [2, 3, 5]) {
    let found = 0
    for (let i = 0; i < trials; i++) {
      const closure = simulatedClosure(random, baselineM, {
        yawDeg: 2 * closureYawLimitDeg(baselineM)!,
        pivot: { x: 0, y: 0, z: 0 },
        shift: { x: 0, y: 0, z: 0 },
      })
      if (judgeClosure(closure).reasons.includes('heading')) found++
    }
    assert.ok(found / trials > 0.97, `at ${baselineM} m a turn of twice the limit was found in ${((found / trials) * 100).toFixed(1)}% of checks`)
  }
})

// ── The record ──────────────────────────────────────────────────────────────────────────────────────

test('the record carries the measurement, the judgement, the limits it was judged by and the taps, and survives JSON', () => {
  const closure = measured({ translationM: 0.2, yawDeg: 6, baselineM: 3.05 })
  const record = closureRecord(closure, {
    at: '2026-11-17T09:30:00.000Z',
    epoch: 2,
    pathLengthM: 14.6,
    taps: [{ source: 'burst', spreadM: 0.012, rangeM: 2.4 }, { source: 'single-hit', spreadM: null, rangeM: 2.9 }],
  })
  assert.equal(record.at, '2026-11-17T09:30:00.000Z')
  assert.equal(record.epoch, 2)
  assert.equal(record.translationM, 0.2)
  assert.equal(record.yawDeg, 6)
  assert.equal(record.pathLengthM, 14.6)
  assert.equal(record.points, 2)
  assert.equal(record.exceeded, true)
  assert.equal(record.limits.translationM, CLOSURE_TRANSLATION_LIMIT_M)
  assert.equal(record.limits.yawDeg, closureYawLimitDeg(3.05))
  assert.equal(record.limits.basis, 'adopted, not measured')
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record, 'nothing in it is a NaN, an undefined or a function')
})

test('a record does not share its taps with the list it was made from', () => {
  const taps = [{ source: 'burst' as const, spreadM: 0.01, rangeM: 2 }]
  const record = closureRecord(measured(), { at: '2026-11-17T09:30:00.000Z', epoch: 0, pathLengthM: 0, taps })
  taps[0]!.rangeM = 99
  assert.equal(record.taps[0]!.rangeM, 2)
})
