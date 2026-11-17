/**
 * The calibration commit as pure functions (src/ar/calibration-commit.ts), held to the code it replaced and to what the
 * constellation flow (WP-04b) changed.
 *
 * WP-04b step 0 moved `commitTwoPoint`'s arithmetic and verdict, `commitSinglePoint`, the mismatch sentence and the
 * tap read out of the modal in src/ar/project-calibration.ts, and that move changed nothing. Step 2 then replaced the
 * distance verdict with a fit of three points where the Place stores a check point, and with `verifyTwoPoint` where it
 * does not: a distance check is never `'verified'`, its tolerance is `twoPointToleranceM` at the tap noise in use and not
 * the stored frame's own, and the records carry `checkedBy` and `fit`. So:
 *
 *  1. DIFFERENTIAL. The statements the modal ran, copied verbatim into ./support/legacy-calibration-commit.ts, are run
 *     beside the new module on seeded random inputs: 20,000 two-point commits and 10,000 one-point commits, drawn
 *     to land on every edge (a pair at the 1.0 m minimum to the last bit, a residual exactly at a tolerance, a
 *     tolerance that is missing, null, zero, negative or NaN, a stored separation that is not a number, taps with no
 *     usable position, swapped and coincident points, huge and tiny coordinates, every override and compass case).
 *     The one-point tier, the mismatch sentence and the tap read are unchanged and must be identical. A two-point
 *     record must be the old one in every field and in key order EXCEPT the three things this change is for (`status`,
 *     `toleranceM`, `checkedBy`), which are asserted separately and exactly. A tally at the end fails the test if the
 *     draw ever stops reaching a branch, so the comparison cannot go vacuous.
 *  2. HAND-DERIVED. The verdicts and the shape of each record written out from the contract and not from the old code,
 *     so the differential cannot agree with a mistake both copies share: a first calibration with and without a check
 *     point, a return visit by distance, a return visit by a fit of three points, "Use anyway", the refusals.
 *  3. THE SEAMS. `sampleTap`, `isDisturbed` and `sigmaHatM` default to what the modal always did and are honoured when
 *     given; a reader may refuse a tap with a sentence or say how high it measured, and the evidence of a tap is stamped
 *     on the calibration as given (WP-05b); `sigmaHatM` now sets the spacing tolerance and the gates of a fit.
 *  4. PURITY. The module reads no DOM, no Deno API, no clock and imports only the world modules and the constellation
 *     flow (ADR 0002).
 *
 * The modal around it is held to goldens in wp-calibration-characterisation.test.ts, and the flow's own claims (the
 * comparison, the ghosts, the stage list) are in wp-constellation-flow.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-commit.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SEPARATION_TOLERANCE_M,
  MIN_POINT_SEPARATION_M,
  normaliseBearingDeg,
  transformPoint,
  twoPointBearingFields,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { TAP_SIGMA0_M } from '../../../src/world/baseline-guidance.ts'
import { fitRigid2D, summariseFit, twoPointToleranceM } from '../../../src/world/frame-fit.ts'
import {
  ONE_POINT_NEEDS_COMPASS,
  assessTwoPoint,
  buildOnePointCommit,
  buildTwoPointCommit,
  mismatchCopy,
  readTap,
  resolveCommitOptions,
  type AcceptedTwoPoint,
  type CommitOptions,
  type TwoPointFrame,
} from '../../../src/ar/calibration-commit.ts'
import { alignmentStatusText } from '../../../src/ar/alignment-status.ts'
import { scanCalibrationChip } from '../../../src/viewer/scan-calibration-chip.ts'
import type { BearingConvention, ProjectSpatialFrame, Vec3 } from '../../../src/world/types.ts'
import {
  legacyCommitSinglePoint,
  legacyCommitTwoPoint,
  legacyMismatchCopy,
  legacyReadTap,
  ONE_POINT_NEEDS_COMPASS as LEGACY_ONE_POINT_NEEDS_COMPASS,
} from './support/legacy-calibration-commit.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** What the modal runs with: it passes no options of its own. */
const DEFAULTS = resolveCommitOptions({ hitTest: async () => null })

// ── A seeded draw ────────────────────────────────────────────────────────────────────────────────────

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

type Random = () => number
const between = (random: Random, low: number, high: number) => low + random() * (high - low)
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!

/** Numbers a tap, a stored record or a sensor could carry and the arithmetic must not mind. */
const ODD_NUMBERS = [0, -0, 1, -1, 1e-300, 1e300, -1e300, 1e6, -1e6, 123456789.123, Number.MIN_VALUE, Number.MAX_VALUE, Number.NaN, Infinity, -Infinity, 0.1, 0.30000000000000004]

const coordinate = (random: Random) => (random() < 0.9 ? between(random, -8, 8) : pick(random, ODD_NUMBERS))

const bits = new DataView(new ArrayBuffer(8))

/** The next double above `value` (for a finite one), so a boundary can be tried one bit to either side. */
function above(value: number): number {
  if (value === 0) return Number.MIN_VALUE
  bits.setFloat64(0, value)
  bits.setBigInt64(0, bits.getBigInt64(0) + (value > 0 ? 1n : -1n))
  return bits.getFloat64(0)
}

/** The next double below `value`. */
const below = (value: number): number => -above(-value)

interface Pair {
  landmark: Vec3
  headingMarker: Vec3
}

/** Two floor taps, drawn so that all the cases a pair can be in come up often. */
function drawPair(random: Random): Pair {
  const mode = random()
  const y = between(random, -2, 2)
  if (mode < 0.5) {
    // An ordinary pair: anywhere, any bearing, mostly at least a metre apart and sometimes not.
    const x = between(random, -8, 8)
    const z = between(random, -8, 8)
    const length = random() < 0.12 ? between(random, 0, 1.2) : between(random, 1, 12)
    const angle = between(random, 0, 2 * Math.PI)
    return {
      landmark: { x, y, z },
      headingMarker: { x: x + Math.sin(angle) * length, y: between(random, -2, 2), z: z + Math.cos(angle) * length },
    }
  }
  if (mode < 0.72) {
    // Along an axis, by lengths that are exact in binary, so a boundary can be hit exactly.
    const length = pick(random, [0.5, 0.75, 1, 1.25, 1.5, 2, 2.25, 3, 3.5, 4.5, 8])
    const x = pick(random, [0, 1, -1, 2.5, -3.25])
    const z = pick(random, [0, 2, -2, 0.5])
    const along = pick(random, [{ x: length, z: 0 }, { x: -length, z: 0 }, { x: 0, z: length }, { x: 0, z: -length }])
    return { landmark: { x, y, z }, headingMarker: { x: x + along.x, y, z: z + along.z } }
  }
  if (mode < 0.84) {
    // At the hard minimum, to the last bit on either side.
    const length = pick(random, [below(MIN_POINT_SEPARATION_M), MIN_POINT_SEPARATION_M, above(MIN_POINT_SEPARATION_M), 0.9999999, 1.0000001, 0.5])
    const x = pick(random, [0, 1, -2.5])
    return { landmark: { x, y, z: 0 }, headingMarker: { x: x + length, y, z: 0 } }
  }
  if (mode < 0.9) {
    // The same spot, or nearly.
    const x = between(random, -3, 3)
    return { landmark: { x, y, z: 1 }, headingMarker: { x: x + (random() < 0.5 ? 0 : 1e-9), y, z: 1 } }
  }
  // Taps with no usable position, huge coordinates, signs and zeros of every kind.
  return {
    landmark: { x: coordinate(random), y: coordinate(random), z: coordinate(random) },
    headingMarker: { x: coordinate(random), y: coordinate(random), z: coordinate(random) },
  }
}

const NOT_A_TOLERANCE = [undefined, null, Number.NaN, Infinity, 0, -0.1, 1e-9, 100] as const

/** A stored two-point frame, or none, drawn against the separation this visit measured. */
function drawStored(random: Random, measuredM: number): TwoPointFrame | null {
  if (random() < 0.3) return null
  const toleranceM = random() < 0.55
    ? pick(random, [DEFAULT_SEPARATION_TOLERANCE_M, 0.25, 0.05, 0.4, 1, 25])
    : pick(random, NOT_A_TOLERANCE)
  const tolerance = typeof toleranceM === 'number' ? toleranceM : DEFAULT_SEPARATION_TOLERANCE_M
  const how = random()
  let separationM: number | undefined
  if (how < 0.3) {
    separationM = measuredM - pick(random, [0, 0.01, -0.01, 0.1, -0.1, 0.14999999999999, 0.15, -0.15, 0.1500001, -0.1500001, 0.4, -0.3, 3])
  } else if (how < 0.6) {
    // The stored length that puts the residual at the tolerance, one way or the other.
    separationM = measuredM - (random() < 0.5 ? 1 : -1) * tolerance
  } else if (how < 0.9) {
    separationM = between(random, 0.5, 12)
  } else {
    separationM = pick(random, [Number.NaN, undefined, Infinity, -1, 0, 1e300])
  }
  const frame = {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 3 },
    separationM,
    toleranceM,
    anchorBearingDeg: random() < 0.5 ? null : 77,
  } as Record<string, unknown>
  if (random() < 0.2) delete frame['toleranceM']
  return frame as unknown as TwoPointFrame
}

const BEARINGS = [null, null, 0, 90, 180, 359.9999, -45, 720.5, Number.NaN, Infinity] as const
const LABELS: Array<[string, string] | undefined> = [undefined, undefined, ['north door frame', 'radiator corner'], ['a', ''], ['', 'b'], ['  ', 'x']]
const STAMPS = ['2026-11-16T09:30:00.000Z', '2026-01-02T03:04:05.678Z', '1970-01-01T00:00:00.000Z']

const bearingOf = (random: Random): number | null =>
  random() < 0.5 ? between(random, 0, 360) : (pick(random, BEARINGS) as number | null)
const conventionOf = (random: Random): BearingConvention => (random() < 0.8 ? 2 : 1)

/** `JSON.stringify` that shows what JSON would hide: numbers that are not numbers and values that are not there. */
const show = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (item === undefined) return '«undefined»'
  if (typeof item === 'number' && !Number.isFinite(item)) return `«${item}»`
  return item
})

// ── Differential: two points ─────────────────────────────────────────────────────────────────────────

test('two points: the old code\'s records, in every field and in key order, but for status, toleranceM and checkedBy, on 20,000 seeded inputs', () => {
  const random = seeded(20261116)
  const seen = {
    tooClose: 0, bothMismatch: 0, newOnlyMismatch: 0, oldOnlyMismatch: 0, compared: 0, provisionalFirst: 0, overridden: 0,
    notAFigure: 0, withLabels: 0, noCompass: 0, legacyRule: 0, atMinimum: 0, frameKept: 0, wasVerified: 0,
  }
  const tolerance = twoPointToleranceM(TAP_SIGMA0_M)
  for (let i = 0; i < 20_000; i++) {
    const { landmark, headingMarker } = drawPair(random)
    const separationM = twoPointSeparationM(landmark, headingMarker)
    const stored = drawStored(random, separationM)
    const override = random() < 0.25
    const bearingDeg = bearingOf(random)
    const bearingConvention = conventionOf(random)
    const labels = pick(random, LABELS)
    const calibratedAt = pick(random, STAMPS)
    const where = `input ${i}: ${show({ landmark, headingMarker, stored, override, bearingDeg, bearingConvention, labels })}`

    const old = legacyCommitTwoPoint({
      landmark, headingMarker, storedTwoPoint: stored, override, bearingDeg, bearingConvention, calibratedAt,
      committedLabels: () => (labels ? [labels[0], labels[1]] : undefined),
    })
    const verdict = assessTwoPoint({ landmark, headingMarker, stored, override }, DEFAULTS)

    if (old.kind === 'too-close') {
      assert.deepStrictEqual(verdict, { kind: 'refused', reason: 'too-close' }, where)
      seen.tooClose += 1
      continue
    }
    if (verdict.kind === 'mismatch') {
      // The verdict, not the sentence, is what changed: the pair is now judged against the spacing tolerance at the tap noise
      // in use, and not the stored frame's own. The sentence is the old one for the figure.
      assert.ok(stored && !override, where)
      assert.ok(Object.is(verdict.toleranceM, tolerance), where)
      assert.ok(Object.is(verdict.separationM, separationM), where)
      assert.equal(mismatchCopy(verdict.residualM), legacyMismatchCopy(verdict.residualM), where)
      assert.ok(Math.abs(verdict.residualM) > tolerance, `${where}: a mismatch is beyond the spacing tolerance`)
      if (old.kind === 'mismatch') seen.bothMismatch += 1
      else seen.newOnlyMismatch += 1
      continue
    }
    if (old.kind === 'mismatch') {
      // Judged inside the new tolerance, though not inside the stored one; or, when the gap is not a number (a stored
      // separation or a tap at infinity, which the old code called a mismatch), compared with nothing at all and kept as provisional.
      assert.equal(verdict.kind, 'accepted', where)
      assert.ok(Math.abs(old.residualM) <= tolerance || !Number.isFinite(old.residualM), where)
      seen.oldOnlyMismatch += 1
      continue
    }
    assert.equal(verdict.kind, 'accepted', where)
    if (verdict.kind !== 'accepted') continue
    assert.equal(verdict.frameChanged, old.frameChanged, where)
    const built = buildTwoPointCommit(verdict, { landmark, headingMarker, frameBearingDeg: bearingDeg, bearingConvention, pointLabels: labels, calibratedAt })

    // What changed, exactly: the tolerance is the one the verdict applies; nothing a distance check passes is verified; a
    // comparison names its check.
    assert.ok(Object.is(built.calibration.toleranceM, tolerance), where)
    assert.equal(built.calibration.status, 'provisional', `${where}: a distance check is never verified`)
    if (stored) {
      assert.equal(built.calibration.method === 'two-point-ground' && built.calibration.checkedBy, 'separation', where)
      assert.ok(!('fit' in built.calibration), `${where}: two points have no fit`)
    } else {
      assert.ok(!('checkedBy' in built.calibration) && !('fit' in built.calibration), `${where}: nothing was compared`)
    }
    if (built.spatialFrame) assert.ok(Object.is(built.spatialFrame.toleranceM, tolerance), where)

    // What did not: every other field, to the last digit, and the layout a stored record has.
    const { toleranceM: _t, status: _s, checkedBy: _c, ...newCalibration } = built.calibration as Record<string, unknown>
    const { toleranceM: _ot, status: _os, ...oldCalibration } = old.calibration as unknown as Record<string, unknown>
    assert.deepStrictEqual(newCalibration, oldCalibration, where)
    assert.deepEqual(Object.keys(newCalibration), Object.keys(oldCalibration), where)
    assert.deepEqual(Object.keys(built.calibration).slice(0, 8), Object.keys(old.calibration).slice(0, 8), where)
    const { toleranceM: _ft, ...newFrame } = (built.spatialFrame ?? {}) as Record<string, unknown>
    const { toleranceM: _oft, ...oldFrame } = (old.spatialFrame ?? {}) as unknown as Record<string, unknown>
    assert.deepStrictEqual(newFrame, oldFrame, where)
    assert.deepEqual(Object.keys(built.spatialFrame ?? {}), Object.keys(old.spatialFrame ?? {}), where)

    if (old.calibration.status === 'verified') seen.wasVerified += 1
    else if (!stored) seen.provisionalFirst += 1
    if (stored) seen.compared += 1
    if (stored && override) seen.overridden += 1
    if (stored && !override) seen.frameKept += 1
    if (Number.isNaN(verdict.residualM)) seen.notAFigure += 1
    if (labels && built.spatialFrame) seen.withLabels += 1
    if (bearingDeg === null) seen.noCompass += 1
    if (bearingConvention === 1) seen.legacyRule += 1
    if (separationM === MIN_POINT_SEPARATION_M) seen.atMinimum += 1
  }
  // The draw reached every branch it is meant to compare. Seeded, so these are exact on every machine.
  const thin = Object.entries(seen).filter(([, count]) => count < 40)
  assert.deepEqual(thin, [], `a branch the comparison is meant to cover is rarely or never reached: ${show(seen)}`)
})

test('one point: refusal, records and sentence are the old code\'s, on 10,000 seeded inputs', () => {
  const random = seeded(141)
  const seen = { refused: 0, firstFrame: 0, existingTwoPoint: 0, existingOnePoint: 0, nullFrame: 0, legacyRule: 0 }
  const existing = (random: Random): ProjectSpatialFrame | null | undefined => pick(random, [
    undefined,
    null,
    { version: 1, createdAt: '2026-11-01T00:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 } as ProjectSpatialFrame,
    { version: 1, createdAt: '2026-11-01T00:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 0, y: 0, z: 2 }, separationM: 2, toleranceM: 0.15, anchorBearingDeg: null } as ProjectSpatialFrame,
    {} as ProjectSpatialFrame,
  ])
  for (let i = 0; i < 10_000; i++) {
    const landmark = { x: coordinate(random), y: coordinate(random), z: coordinate(random) }
    const bearingDeg = bearingOf(random)
    const bearingConvention = conventionOf(random)
    const existingFrame = existing(random)
    const calibratedAt = pick(random, STAMPS)
    const where = `input ${i}: ${show({ landmark, bearingDeg, bearingConvention, existingFrame })}`

    const old = legacyCommitSinglePoint({ landmark, bearingDeg, bearingConvention, existingFrame, calibratedAt })
    const outcome = buildOnePointCommit({ landmark, frameBearingDeg: bearingDeg, bearingConvention, existingFrame, calibratedAt }, DEFAULTS)
    if (old.kind === 'refused') {
      assert.deepStrictEqual(outcome, { kind: 'refused', reason: 'no-compass', text: old.transientStatus }, where)
      seen.refused += 1
      continue
    }
    assert.equal(outcome.kind, 'committed', where)
    if (outcome.kind !== 'committed') continue
    assert.deepStrictEqual(outcome.calibration, old.calibration, where)
    assert.deepStrictEqual(outcome.spatialFrame, old.spatialFrame, where)
    assert.equal(JSON.stringify(outcome), JSON.stringify({ kind: 'committed', calibration: old.calibration, spatialFrame: old.spatialFrame }), where)
    assert.deepEqual(Object.keys(outcome.spatialFrame ?? {}), Object.keys(old.spatialFrame ?? {}), where)
    if (outcome.spatialFrame) {
      if (existingFrame === null) seen.nullFrame += 1
      else seen.firstFrame += 1
    } else if (existingFrame && existingFrame.method === 'two-point-ground') seen.existingTwoPoint += 1
    else seen.existingOnePoint += 1
    if (bearingConvention === 1) seen.legacyRule += 1
  }
  assert.equal(ONE_POINT_NEEDS_COMPASS, LEGACY_ONE_POINT_NEEDS_COMPASS, 'the refusal sentence is the old one')
  const thin = Object.entries(seen).filter(([, count]) => count < 40)
  assert.deepEqual(thin, [], `a branch the comparison is meant to cover is rarely or never reached: ${show(seen)}`)
})

test('the mismatch sentence is the old one for every residual, whole centimetres and either direction', () => {
  const random = seeded(7)
  const residuals = [0, -0, 0.004, 0.005, 0.0049999, 0.15, -0.15, 0.4, -0.3, 2.5, -2.5, 1e-9, 1e21, -1e21, Number.NaN, Infinity, -Infinity]
  for (let i = 0; i < 5_000; i++) residuals.push(between(random, -5, 5))
  for (const residual of residuals) assert.equal(mismatchCopy(residual), legacyMismatchCopy(residual), `residual ${residual}`)
})

test('a tap is read as the old code read it: one call through the host\'s hit test, a rejection is no hit', async () => {
  const hit = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2 }
  const readers: Array<[string, () => Promise<unknown>]> = [
    ['a hit', async () => hit],
    ['nothing there', async () => null],
    ['an error', async () => { throw new Error('no surface') }],
    ['a rejection with no reason', () => Promise.reject(undefined)],
  ]
  for (const [name, reader] of readers) {
    for (const [x, y] of [[0.5, 0.5], [0, 1], [0.123, 0.987]]) {
      const callsNew: unknown[][] = []
      const callsOld: unknown[][] = []
      const record = (calls: unknown[][]) => async (px: number, py: number) => {
        calls.push([px, py])
        return reader() as Promise<{ position: Vec3 } | null>
      }
      const now = await readTap(resolveCommitOptions({ hitTest: record(callsNew) }), x, y)
      const before = await legacyReadTap({ hitTest: record(callsOld) }, x, y)
      assert.deepStrictEqual(now, before, name)
      assert.deepEqual(callsNew, [[x, y]], `${name}: asked once, for this tap`)
      assert.deepEqual(callsNew, callsOld, name)
    }
  }
})

// ── Hand-derived: the verdict ────────────────────────────────────────────────────────────────────────

/** The spacing tolerance at the adopted tap noise: what a verdict applies and a record carries. */
const TOLERANCE_M = twoPointToleranceM(TAP_SIGMA0_M)

const storedFrame = (separationM: number, toleranceM?: number | null, checkPoints?: TwoPointFrame['checkPoints']): TwoPointFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  toleranceM: toleranceM as number,
  anchorBearingDeg: null,
  ...(checkPoints ? { checkPoints } : {}),
})

/** A pair on the x axis, so the separation is exactly `apart`. */
const pairAt = (apart: number): Pair => ({ landmark: { x: 0, y: -1.2, z: 0 }, headingMarker: { x: apart, y: -1.2, z: 0 } })

const assess = (apart: number, frame: TwoPointFrame | null = null, override = false) =>
  assessTwoPoint({ ...pairAt(apart), stored: frame, override }, DEFAULTS)

test('a first calibration is accepted as provisional, with the spacing tolerance at the tap noise in use, and writes a frame', () => {
  assert.deepEqual(assess(3), {
    kind: 'accepted',
    separationM: 3,
    residualM: 0,
    toleranceM: TOLERANCE_M,
    frameChanged: true,
    status: 'provisional',
    sessionToProject: twoPointToProjectTransform(pairAt(3).landmark, pairAt(3).headingMarker),
  })
  assert.equal(TOLERANCE_M, 2 * 2.8 * 0.03, 'twice the rms gate at 3 cm: 16.8 cm, which is not the 15 cm of DEFAULT_SEPARATION_TOLERANCE_M')
  assert.equal(DEFAULT_SEPARATION_TOLERANCE_M, 0.15)
})

test('the hard minimum: exactly 1.0 m is accepted, the double below it and a pair on one spot are refused', () => {
  assert.equal(assess(MIN_POINT_SEPARATION_M).kind, 'accepted')
  assert.deepEqual(assess(0.9999999999999999), { kind: 'refused', reason: 'too-close' })
  assert.deepEqual(assess(0), { kind: 'refused', reason: 'too-close' })
  assert.deepEqual(assess(0.6, storedFrame(0.6)), { kind: 'refused', reason: 'too-close' }, 'a stored pair of the same short length does not excuse it')
})

test('a stored pair matched inside the spacing tolerance is provisional, checked by distance, and the Place\'s frame is kept', () => {
  for (const [apart, residualM] of [[3, 0], [3.125, 0.125], [2.875, -0.125]] as const) {
    const verdict = assess(apart, storedFrame(3))
    assert.ok(verdict.kind === 'accepted', `${apart}`)
    assert.deepEqual([verdict.separationM, verdict.residualM, verdict.toleranceM, verdict.frameChanged, verdict.status], [apart, residualM, TOLERANCE_M, false, 'provisional'])
    assert.equal(verdict.comparison?.checkedBy, 'separation')
    assert.equal(verdict.comparison?.fit, null)
    assert.deepEqual(verdict.sessionToProject, twoPointToProjectTransform(pairAt(apart).landmark, pairAt(apart).headingMarker), 'the two-point transform, as ever')
  }
})

test('the spacing tolerance comparison is strict: a gap at it is inside, one past it is a mismatch', () => {
  const edge = 2 + TOLERANCE_M
  const gaps = [below(edge), edge, above(edge)].map((apart) => [apart, apart - 2] as const)
  assert.ok(gaps.some(([, gap]) => gap <= TOLERANCE_M) && gaps.some(([, gap]) => gap > TOLERANCE_M), 'the three straddle the tolerance')
  for (const [apart, gap] of gaps) {
    assert.equal(assess(apart, storedFrame(2)).kind, gap <= TOLERANCE_M ? 'accepted' : 'mismatch', `${apart}, a gap of ${gap}`)
  }
  for (const [apart, gap] of [below(2 - TOLERANCE_M), 2 - TOLERANCE_M, above(2 - TOLERANCE_M)].map((a) => [a, 2 - a] as const)) {
    assert.equal(assess(apart, storedFrame(2)).kind, gap <= TOLERANCE_M ? 'accepted' : 'mismatch', `${apart}, a gap of ${gap} the other way`)
  }
})

test('the stored frame\'s own tolerance is no longer read: the spacing tolerance is the tap noise\'s, whatever was stored', () => {
  for (const toleranceM of [0.05, 0.15, 0.4, 25, null, undefined]) {
    const frame = storedFrame(3, toleranceM)
    assert.equal(assess(3.06, frame).kind, 'accepted', `6 cm off, stored ${String(toleranceM)}`)
    assert.equal(assess(3.3, frame).kind, 'mismatch', `30 cm off, stored ${String(toleranceM)}`)
    const verdict = assess(3.06, frame)
    assert.ok(verdict.kind === 'accepted' && verdict.toleranceM === TOLERANCE_M)
  }
  const missing = storedFrame(3) as Record<string, unknown>
  delete missing['toleranceM']
  assert.equal(assess(3.14, missing as unknown as TwoPointFrame).kind, 'accepted', 'a key that is not there is not read either')
})

test('"Use anyway" keeps a pair that did not match, provisionally, with the residual that failed and the spacing tolerance', () => {
  const kept = assess(3.4, storedFrame(3, 0.15), true)
  assert.equal(kept.kind, 'accepted')
  if (kept.kind !== 'accepted') return
  assert.equal(kept.status, 'provisional', 'a check that ran and failed never reports verified')
  assert.equal(kept.frameChanged, true)
  assert.ok(Math.abs(kept.residualM - 0.4) < 1e-12)
  assert.equal(kept.toleranceM, TOLERANCE_M)
  assert.equal(kept.comparison?.checkedBy, 'separation')
  assert.equal(kept.comparison?.verdict.status, 'mismatch', 'what failed is kept with the record')
  // Nothing stored: pressing it changes nothing about a first calibration.
  assert.deepEqual(assess(3, null, true), assess(3, null, false))
  // A pair that matched is also kept as a new frame, provisionally, when the person insists.
  const insisted = assess(3, storedFrame(3), true)
  assert.ok(insisted.kind === 'accepted' && insisted.status === 'provisional' && insisted.frameChanged)
})

test('numbers that are not numbers compare nothing: provisional, never verified (the old code called them verified)', () => {
  // A stored separation that is NaN, or a tap with no position: there is no gap to judge. It says so (`compared: 'nothing'`)
  // and is provisional, as `verifyTwoPoint` reports it. The frame is kept and the figure on the record is not a figure.
  const noSeparation = assess(3, storedFrame(Number.NaN))
  assert.ok(noSeparation.kind === 'accepted' && noSeparation.status === 'provisional' && Number.isNaN(noSeparation.residualM))
  assert.equal(noSeparation.kind === 'accepted' && noSeparation.comparison?.verdict.compared, 'nothing')
  const noTap = assess(Number.NaN)
  assert.ok(noTap.kind === 'accepted' && Number.isNaN(noTap.separationM))
  // A stored tolerance that is NaN is not read at all now: a gap of 6 m is a mismatch whatever the frame says.
  assert.equal(assess(9, storedFrame(3, Number.NaN)).kind, 'mismatch')
})

test('the mismatch sentence names whole centimetres and which way, and says nothing it did not measure', () => {
  const tail = 'than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.'
  assert.equal(mismatchCopy(0.4), `Measured 40 cm further apart ${tail}`)
  assert.equal(mismatchCopy(-0.3), `Measured 30 cm closer together ${tail}`)
  assert.equal(mismatchCopy(0.06000000000000005), `Measured 6 cm further apart ${tail}`)
  assert.equal(mismatchCopy(0), `Measured 0 cm closer together ${tail}`, 'not positive is "closer together"')
})

// ── Hand-derived: three points ───────────────────────────────────────────────────────────────────────

/**
 * The Place frame's three points, and a session that is that frame turned 90 degrees about Y and shifted: a visit's taps for them.
 * 3.5 m along the baseline and a check point 2.6 m to one side and a metre along it: three sides of 3.5, 2.8 and 3.6 m, so no
 * other order of the points fits as well, and the predicted accuracy is inside the product's target.
 */
const STORED_CHECK = { x: -2.6, y: 0.02, z: 1 }
const withCheck = (): TwoPointFrame => ({ ...storedFrame(3.5, undefined, [{ ...STORED_CHECK, label: 'radiator' }]), toleranceM: TOLERANCE_M })
const session = (p: Vec3): Vec3 => ({ x: p.z + 4, y: -1.2 + p.y, z: -p.x + 1 })
const visitTaps = (check: Vec3 | null = STORED_CHECK) => ({
  landmark: session({ x: 0, y: 0, z: 0 }),
  headingMarker: session({ x: 0, y: 0, z: 3.5 }),
  checkPoint: check ? session(check) : null,
})

const assessVisit = (over: Partial<Parameters<typeof assessTwoPoint>[0]> = {}, options = DEFAULTS) =>
  assessTwoPoint({ ...visitTaps(), stored: withCheck(), override: false, ...over }, options)

test('a visit that re-taps the stored check point is fitted: verified, the fit\'s matrix is its sessionToProject, and the frame is kept', () => {
  const verdict = assessVisit()
  assert.ok(verdict.kind === 'accepted')
  assert.equal(verdict.status, 'verified')
  assert.equal(verdict.frameChanged, false)
  assert.equal(verdict.comparison?.checkedBy, 'constellation')
  const taps = visitTaps()
  const fit = fitRigid2D([taps.landmark, taps.headingMarker, taps.checkPoint!], [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3.5 }, STORED_CHECK])
  assert.ok(fit.ok)
  assert.deepEqual(verdict.sessionToProject, fit.fit.matrix, 'IS the fit, not the two-point transform')
  assert.notDeepEqual(verdict.sessionToProject, twoPointToProjectTransform(taps.landmark, taps.headingMarker))
  assert.equal(verdict.toleranceM, TOLERANCE_M)
  assert.ok(Math.abs(verdict.residualM) < 1e-12, 'the spacing of the pair, as before')
})

test('a fitted visit writes the fit and the check it rests on, after the fields a two-point record has, in the order the type declares them', () => {
  const verdict = assessVisit()
  assert.ok(verdict.kind === 'accepted')
  const { calibration, spatialFrame } = buildTwoPointCommit(verdict, { ...BUILD, ...visitTaps(), frameBearingDeg: 100 })
  assert.deepEqual(Object.keys(calibration), ['method', 'sessionToProject', 'separationM', 'residualM', 'toleranceM', 'anchorBearingDeg', 'projectBearingDeg', 'bearingConvention', 'calibratedAt', 'status', 'fit', 'checkedBy'])
  assert.equal(calibration.status, 'verified')
  assert.equal(calibration.method === 'two-point-ground' && calibration.checkedBy, 'constellation')
  const taps = visitTaps()
  const fit = fitRigid2D([taps.landmark, taps.headingMarker, taps.checkPoint!], [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3.5 }, STORED_CHECK])
  assert.ok(fit.ok)
  assert.deepEqual(calibration.method === 'two-point-ground' && calibration.fit, summariseFit(fit.fit))
  assert.equal(spatialFrame, undefined, 'a stored frame that was matched is the reference: it is not rewritten')
  assert.equal(JSON.stringify(calibration), JSON.stringify({ ...calibration }), 'JSON-safe')
})

/** The yaw in the session, in degrees, of the Place's +Z axis under a `sessionToProject`: where the matrix says the Place's baseline points. */
function placeAheadYawDeg(matrix: number[]): number {
  const back = invertAffine(matrix)!
  const origin = transformPoint(back, { x: 0, y: 0, z: 0 })
  const ahead = transformPoint(back, { x: 0, y: 0, z: 1 })
  return (Math.atan2(ahead.x - origin.x, ahead.z - origin.z) * 180) / Math.PI
}

test('the bearing recorded for the Place\'s +Z is the matrix\'s own axis: a fitted visit\'s fit heading, not the tapped baseline\'s', () => {
  // The heading marker tapped 8 cm to the side of where it was: the fit spreads that over three points, so the matrix's +Z is not the
  // direction of the baseline that was tapped, by the heading residual the record keeps. The bearing beside the matrix must be the matrix's.
  const noisy = { ...visitTaps(), headingMarker: { ...visitTaps().headingMarker, x: visitTaps().headingMarker.x + 0.08 } }
  const verdict = assessVisit(noisy)
  assert.ok(verdict.kind === 'accepted' && verdict.comparison?.fit)
  const frameBearingDeg = 100
  const { calibration } = buildTwoPointCommit(verdict, { ...BUILD, ...noisy, frameBearingDeg })
  assert.ok(calibration.method === 'two-point-ground')
  const aheadYaw = placeAheadYawDeg(calibration.sessionToProject)
  assert.ok(Math.abs(aheadYaw - verdict.comparison.fit.headingDeg) < 1e-9, 'the fit\'s heading is the matrix\'s axis')
  const expected = normaliseBearingDeg(frameBearingDeg - aheadYaw)
  assert.ok(Math.abs(calibration.projectBearingDeg! - expected) < 1e-9, `${calibration.projectBearingDeg} against ${expected}`)
  const baseline = twoPointBearingFields(frameBearingDeg, noisy.landmark, noisy.headingMarker, BUILD.bearingConvention).projectBearingDeg!
  const apart = Math.abs(((calibration.projectBearingDeg! - baseline + 540) % 360) - 180)
  assert.ok(apart > 0.2 && apart < 3, `the tapped baseline would have said ${baseline}: ${apart.toFixed(2)} degrees away, the record\'s heading residual`)
  assert.ok(Math.abs(apart - Math.abs(calibration.fit!.headingResidualDeg!)) < 1e-6, 'by exactly the heading residual the record keeps')
  // The convention beside it is unchanged, and a frame is still written from the baseline it was tapped as.
  assert.equal(calibration.bearingConvention, BUILD.bearingConvention)
})

test('a pair, a first calibration and a frame kept over a mismatch have the baseline\'s bearing: their matrix IS the tapped baseline', () => {
  const frameBearingDeg = 100
  const taps = visitTaps()
  const expected = twoPointBearingFields(frameBearingDeg, taps.landmark, taps.headingMarker, BUILD.bearingConvention)
  const records = [
    assessVisit({ checkPoint: null }),                                                    // a pair against a stored pair-and-check frame: by distance
    assessVisit({ stored: null }),                                                        // a first calibration
    assessVisit({ checkPoint: session({ ...STORED_CHECK, x: -STORED_CHECK.x }), override: true }), // points that did not fit, kept
    assessVisit({ checkPoint: session({ ...STORED_CHECK, z: STORED_CHECK.z + 1 }), override: true }), // points a metre off, kept
  ]
  for (const verdict of records) {
    assert.ok(verdict.kind === 'accepted')
    assert.equal(verdict.frameYawDeg, undefined, 'not a fit\'s matrix, so no yaw of its own')
    const { calibration } = buildTwoPointCommit(verdict, { ...BUILD, ...taps, frameBearingDeg })
    assert.ok(calibration.method === 'two-point-ground')
    assert.deepEqual([calibration.projectBearingDeg, calibration.bearingConvention], [expected.projectBearingDeg, expected.bearingConvention])
    assert.ok(Math.abs(normaliseBearingDeg(frameBearingDeg - placeAheadYawDeg(calibration.sessionToProject)) - calibration.projectBearingDeg!) < 1e-9)
  }
})

test('a visit that skipped the check point against a Place that stores one is provisional, checked by distance', () => {
  const verdict = assessVisit({ checkPoint: null })
  assert.ok(verdict.kind === 'accepted')
  assert.equal(verdict.status, 'provisional')
  assert.equal(verdict.comparison?.checkedBy, 'separation')
  const taps = visitTaps()
  assert.deepEqual(verdict.sessionToProject, twoPointToProjectTransform(taps.landmark, taps.headingMarker))
})

test('a check point tapped against a frame that stores none is ignored: nothing is added to an existing frame', () => {
  const verdict = assessVisit({ stored: storedFrame(3.5) })
  assert.ok(verdict.kind === 'accepted')
  assert.equal(verdict.frameChanged, false)
  assert.equal(verdict.checkPoint, undefined)
  assert.equal(verdict.comparison?.checkedBy, 'separation')
  assert.equal(buildTwoPointCommit(verdict, { ...BUILD, ...visitTaps(), frameBearingDeg: null }).spatialFrame, undefined)
})

test('points that do not match the stored ones are a mismatch with the fit and the verdict\'s sentences, and nothing is kept', () => {
  // The check point a metre along the baseline from where it was stored, with the pair exactly as it was.
  const verdict = assessVisit({ checkPoint: session({ ...STORED_CHECK, z: STORED_CHECK.z + 1 }) })
  assert.equal(verdict.kind, 'mismatch')
  if (verdict.kind !== 'mismatch') return
  assert.equal(verdict.comparison.checkedBy, 'constellation')
  assert.equal(verdict.comparison.fit?.perPoint.length, 3)
  assert.ok(verdict.comparison.verdict.reasons.some((reason) => /^3 points are \d+\.\d cm off the stored ones on average \(limit 8\.4 cm\)\.$/.test(reason)), verdict.comparison.verdict.reasons.join(' | '))
  assert.ok(Math.abs(verdict.residualM) < 1e-12, 'the pair itself was right: the distance check could not have seen this')
})

test('"Use anyway" over a failed fit replaces the Place\'s frame with this visit\'s points, check point included, and keeps what failed', () => {
  const off = session({ ...STORED_CHECK, z: STORED_CHECK.z + 1 })
  const verdict = assessVisit({ checkPoint: off, override: true })
  assert.ok(verdict.kind === 'accepted')
  assert.equal(verdict.status, 'provisional')
  assert.equal(verdict.frameChanged, true)
  const taps = { ...visitTaps(), checkPoint: off }
  assert.deepEqual(verdict.sessionToProject, twoPointToProjectTransform(taps.landmark, taps.headingMarker), 'the new frame is this visit\'s own pair')
  const placed = transformPoint(twoPointToProjectTransform(taps.landmark, taps.headingMarker), off)
  assert.deepEqual(verdict.checkPoint, placed)
  const { calibration, spatialFrame } = buildTwoPointCommit(verdict, { ...BUILD, ...taps, frameBearingDeg: null, checkPointLabel: '  by the radiator  ' })
  assert.equal(calibration.method === 'two-point-ground' && calibration.checkedBy, 'constellation', 'the check that failed')
  assert.ok(calibration.method === 'two-point-ground' && calibration.fit && calibration.fit.rmsResidualM > 0.2, 'and what it measured')
  assert.deepEqual(spatialFrame?.checkPoints, [{ ...placed, label: 'by the radiator' }])
})

test('"Use anyway" over points that could not be fitted at all (a mirrored check point, the pair swapped) keeps a record the scanner\'s line and the editor\'s chip read as a kept mismatch', () => {
  const swapped = { landmark: visitTaps().headingMarker, headingMarker: visitTaps().landmark, checkPoint: visitTaps().checkPoint }
  const mirrored = { checkPoint: session({ x: -STORED_CHECK.x, y: STORED_CHECK.y, z: STORED_CHECK.z }) }
  for (const [name, taps] of [['a check point on the wrong side', mirrored], ['the pair tapped the other way round', swapped]] as const) {
    const sent = assessVisit(taps)
    assert.equal(sent.kind, 'mismatch', `${name}: turned back to the person first`)
    if (sent.kind !== 'mismatch') return
    assert.equal(sent.comparison.fit, null, `${name}: nothing can fit these points`)
    const kept = assessVisit({ ...taps, override: true })
    assert.ok(kept.kind === 'accepted')
    const all = { ...visitTaps(), ...taps }
    const { calibration } = buildTwoPointCommit(kept, { ...BUILD, ...all, frameBearingDeg: null })
    assert.ok(calibration.method === 'two-point-ground')
    // What is recorded: the check that failed, provisional, and no figure because none exists.
    assert.equal(calibration.status, 'provisional')
    assert.equal(calibration.checkedBy, 'constellation')
    assert.equal(calibration.fit, undefined)
    // And what is said of it is the warning, in the scanner and in the editor, not "frame set".
    assert.equal(alignmentStatusText(calibration), '⚠ Points did not match the stored ones\n• Kept as you chose; earlier scans may not line up', name)
    const chip = scanCalibrationChip({
      calibrationMethod: calibration.method,
      calibrationStatus: calibration.status,
      calibrationResidualM: calibration.residualM,
      calibrationToleranceM: calibration.toleranceM,
      calibratedAt: calibration.calibratedAt,
      calibrationCheckedBy: calibration.checkedBy,
    }, 'two-point-ground')
    assert.equal(chip?.tone, 'warn', name)
    assert.equal(chip?.note, 'Kept after a mismatch; earlier scans may not line up', name)
  }
})

test('"Use anyway" over points that would have been verified still replaces the frame, and is provisional: the new frame is checked against nothing', () => {
  const control = assessVisit()
  assert.ok(control.kind === 'accepted' && control.status === 'verified' && control.frameChanged === false)
  const insisted = assessVisit({ override: true })
  assert.ok(insisted.kind === 'accepted')
  assert.equal(insisted.status, 'provisional')
  assert.equal(insisted.frameChanged, true)
  const taps = visitTaps()
  assert.deepEqual(insisted.sessionToProject, twoPointToProjectTransform(taps.landmark, taps.headingMarker), 'the frame the person insisted on is this visit\'s own pair')
  assert.deepEqual(insisted.checkPoint, transformPoint(twoPointToProjectTransform(taps.landmark, taps.headingMarker), taps.checkPoint!))
})

test('a first calibration with a check point stores it in the Place frame, after the point labels, with its label when it was named', () => {
  const taps = { landmark: { x: 1, y: -1.2, z: 2 }, headingMarker: { x: 4, y: -1.19, z: 2 }, checkPoint: { x: 1.4, y: -1.13, z: 5.1 } }
  const verdict = assessTwoPoint({ ...taps, stored: null, override: false }, DEFAULTS)
  assert.ok(verdict.kind === 'accepted' && verdict.frameChanged && verdict.comparison === undefined)
  const placed = transformPoint(twoPointToProjectTransform(taps.landmark, taps.headingMarker), taps.checkPoint)
  assert.deepEqual(verdict.checkPoint, placed)
  const named = buildTwoPointCommit(verdict, { ...BUILD, ...taps, frameBearingDeg: 100, pointLabels: ['door', ''], checkPointLabel: 'radiator' })
  assert.deepEqual(Object.keys(named.spatialFrame!), ['version', 'createdAt', 'method', 'landmark', 'headingMarker', 'separationM', 'toleranceM', 'anchorBearingDeg', 'projectBearingDeg', 'bearingConvention', 'pointLabels', 'checkPoints'])
  assert.deepEqual(named.spatialFrame!.checkPoints, [{ x: placed.x, y: placed.y, z: placed.z, label: 'radiator' }])
  assert.ok(Math.abs(placed.y - 0.07) < 1e-9, 'its own height above the landmark, not forced flat')
  const unnamed = buildTwoPointCommit(verdict, { ...BUILD, ...taps, frameBearingDeg: 100 })
  assert.deepEqual(unnamed.spatialFrame!.checkPoints, [{ x: placed.x, y: placed.y, z: placed.z }])
  assert.ok(!('fit' in named.calibration) && !('checkedBy' in named.calibration), 'nothing was compared on a first calibration')
  const spaced = buildTwoPointCommit(verdict, { ...BUILD, ...taps, frameBearingDeg: 100, checkPointLabel: '   ' })
  assert.deepEqual(Object.keys(spaced.spatialFrame!.checkPoints![0]!), ['x', 'y', 'z'], 'a name of spaces is no name')
})

test('a first calibration with a check point the fit cannot use is turned away with the guidance\'s sentence, and writes nothing', () => {
  const landmark = { x: 0, y: -1.2, z: 0 }
  const headingMarker = { x: 3, y: -1.2, z: 0 }
  const onTheLine = assessTwoPoint({ landmark, headingMarker, checkPoint: { x: 1.5, y: -1.2, z: 0.05 }, stored: null, override: false }, DEFAULTS)
  assert.equal(onTheLine.kind, 'refused')
  assert.ok(onTheLine.kind === 'refused' && onTheLine.reason === 'check-point')
  assert.equal(onTheLine.kind === 'refused' && 'text' in onTheLine && onTheLine.text, 'Point C: 1.5 m from A, 5 cm off the A–B line. The three points are almost on one line (3 cm off it): they need at least 20 cm. Move point C to the side.')
  const onTop = assessTwoPoint({ landmark, headingMarker, checkPoint: { x: 0.1, y: -1.2, z: 0.2 }, stored: null, override: false }, DEFAULTS)
  assert.ok(onTop.kind === 'refused' && onTop.reason === 'check-point' && 'text' in onTop && /^Point C is only 22 cm from point A\./.test(onTop.text))
  // Over a mismatch kept anyway the new frame is written the same way, so the same points are refused.
  const kept = assessTwoPoint({ landmark, headingMarker, checkPoint: { x: 1.5, y: -1.2, z: 0.05 }, stored: storedFrame(2), override: true }, DEFAULTS)
  assert.ok(kept.kind === 'refused' && kept.reason === 'check-point')
})

test('the phone\'s units reach the verdict, and the verdict says what sizes in metres were not checked', () => {
  const sizes = "Not checked: sizes in metres. This phone's units are not metres."
  const arbitrary = assessVisit({ unitsMode: 'arbitrary' })
  assert.ok(arbitrary.kind === 'accepted' && arbitrary.comparison?.verdict.reasons.includes(sizes))
  const metric = assessVisit({ unitsMode: 'metric' })
  assert.ok(metric.kind === 'accepted' && !metric.comparison?.verdict.reasons.includes(sizes))
})

// ── Hand-derived: the records ────────────────────────────────────────────────────────────────────────

const accepted = (apart: number, frame: TwoPointFrame | null = null, override = false): AcceptedTwoPoint => {
  const verdict = assess(apart, frame, override)
  if (verdict.kind !== 'accepted') throw new Error('the pair was not accepted')
  return verdict
}

const BUILD = { bearingConvention: 2 as BearingConvention, pointLabels: undefined, calibratedAt: '2026-11-16T09:30:00.000Z' }

test('a first two-point commit writes the calibration and the Place frame, in the order they are stored in', () => {
  const landmark = { x: 1, y: -1.2, z: 2 }
  const headingMarker = { x: 1, y: -1.2, z: 5 }
  const verdict = assessTwoPoint({ landmark, headingMarker, stored: null, override: false }, DEFAULTS)
  assert.ok(verdict.kind === 'accepted')
  const { calibration, spatialFrame } = buildTwoPointCommit(verdict, { ...BUILD, landmark, headingMarker, frameBearingDeg: 100 })
  assert.deepEqual(Object.keys(calibration), ['method', 'sessionToProject', 'separationM', 'residualM', 'toleranceM', 'anchorBearingDeg', 'projectBearingDeg', 'bearingConvention', 'calibratedAt', 'status'])
  assert.deepEqual(Object.keys(spatialFrame!), ['version', 'createdAt', 'method', 'landmark', 'headingMarker', 'separationM', 'toleranceM', 'anchorBearingDeg', 'projectBearingDeg', 'bearingConvention'])
  assert.equal(calibration.method, 'two-point-ground')
  assert.equal(calibration.status, 'provisional')
  assert.equal(calibration.calibratedAt, '2026-11-16T09:30:00.000Z')
  assert.equal(calibration.anchorBearingDeg, 100)
  assert.equal(calibration.projectBearingDeg, 100, 'the baseline runs along +Z, so the frame\'s +Z is where session +Z points')
  // The baseline lies along session +Z, so the frame is a shift: the landmark goes to the origin, nothing turns.
  const m = calibration.sessionToProject
  assert.deepEqual([m[0], m[5], m[10], m[15]], [1, 1, 1, 1])
  assert.deepEqual([m[12], m[13], m[14]], [-1, 1.2, -2])
  assert.deepEqual(spatialFrame, {
    version: 1,
    createdAt: '2026-11-16T09:30:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 3 },
    separationM: 3,
    toleranceM: TOLERANCE_M,
    anchorBearingDeg: 100,
    projectBearingDeg: 100,
    bearingConvention: 2,
  })
})

test('tap evidence is stamped on the calibration as it was given and nowhere else, and changes nothing else about the records', () => {
  const landmark = { x: 1, y: -1.2, z: 2 }
  const headingMarker = { x: 1, y: -1.2, z: 5 }
  const evidence = { tapSpreadM: 0.012, tapRangeM: 2.3, tapSource: 'burst' as const, landmarkAboveFloorM: -0.02 }
  const without = buildTwoPointCommit(accepted(3), { ...BUILD, landmark, headingMarker, frameBearingDeg: 100 })
  const withTap = buildTwoPointCommit(accepted(3), { ...BUILD, landmark, headingMarker, frameBearingDeg: 100, tap: evidence })
  assert.equal(withTap.calibration.tap, evidence, 'the same record, not a copy of some of it')
  assert.ok(!('tap' in without.calibration), 'no evidence given, none claimed')
  const { tap: _tap, ...rest } = withTap.calibration
  assert.deepEqual(rest, without.calibration, 'every other field is what it was')
  assert.deepEqual(withTap.spatialFrame, without.spatialFrame, 'the Place frame carries no tap evidence')
  assert.deepEqual(Object.keys(withTap.calibration).slice(-3), ['tap', 'calibratedAt', 'status'], 'stored before the time and the status, as the other evidence is')
  // A matched stored pair keeps its frame and still carries the evidence of the visit.
  const matched = buildTwoPointCommit(accepted(3.125, storedFrame(3)), {
    ...BUILD, landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 3.125, y: 0, z: 0 }, frameBearingDeg: null, tap: evidence,
  })
  assert.equal(matched.calibration.status, 'provisional', 'checked by distance only: a distance check is never verified (owner decision D1)')
  assert.equal(matched.calibration.tap, evidence)
  assert.equal(matched.spatialFrame, undefined)
})

test('the Place frame carries the point labels when either was named, and no photos: the host attaches them', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  const headingMarker = { x: 3, y: 0, z: 0 }
  const named = buildTwoPointCommit(accepted(3), { ...BUILD, landmark, headingMarker, frameBearingDeg: null, pointLabels: ['north door frame', ''] })
  assert.deepEqual(named.spatialFrame!.pointLabels, ['north door frame', ''])
  assert.deepEqual(Object.keys(named.spatialFrame!).slice(-1), ['pointLabels'])
  assert.ok(!('referencePhotos' in named.spatialFrame!))
  const unnamed = buildTwoPointCommit(accepted(3), { ...BUILD, landmark, headingMarker, frameBearingDeg: null })
  assert.ok(!('pointLabels' in unnamed.spatialFrame!))
})

test('a matched stored pair returns a provisional calibration checked by distance and no frame: the stored one is the reference and is not rewritten', () => {
  const { calibration, spatialFrame } = buildTwoPointCommit(accepted(3.125, storedFrame(3)), {
    ...BUILD, landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 3.125, y: 0, z: 0 }, frameBearingDeg: null,
  })
  assert.equal(calibration.status, 'provisional', 'a distance check is never verified')
  assert.equal(calibration.method === 'two-point-ground' && calibration.checkedBy, 'separation')
  assert.ok(!('fit' in calibration))
  assert.equal(calibration.residualM, 0.125)
  assert.equal(calibration.toleranceM, TOLERANCE_M)
  assert.equal(calibration.anchorBearingDeg, null)
  assert.equal(calibration.projectBearingDeg, null)
  assert.deepEqual(Object.keys(calibration).slice(-2), ['status', 'checkedBy'])
  assert.equal(spatialFrame, undefined)
})

test('the bearing rule is stamped on both records, and the frame\'s bearings are the calibration\'s', () => {
  for (const bearingConvention of [1, 2] as const) {
    const { calibration, spatialFrame } = buildTwoPointCommit(accepted(3), {
      ...BUILD, bearingConvention, landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: 3, y: 0, z: 0 }, frameBearingDeg: 250,
    })
    assert.equal(calibration.bearingConvention, bearingConvention)
    assert.equal(spatialFrame!.bearingConvention, bearingConvention)
    assert.equal(spatialFrame!.projectBearingDeg, calibration.projectBearingDeg)
    assert.equal(spatialFrame!.anchorBearingDeg, 250)
  }
})

test('a record from before check points existed is read as a two-point frame: the stored pair of the build before is still compared, never verified', () => {
  // What the build before wrote (tests/fixtures/place-frame/records-before-s0.json is the frozen copy) has no `checkPoints`.
  const legacy: TwoPointFrame = { ...storedFrame(2.4), toleranceM: 0.15, anchorBearingDeg: 317, projectBearingDeg: 123, bearingConvention: 2 }
  assert.ok(!('checkPoints' in legacy))
  const verdict = assessTwoPoint({ ...pairAt(2.43), stored: legacy, override: false }, DEFAULTS)
  assert.ok(verdict.kind === 'accepted')
  assert.equal(verdict.status, 'provisional')
  assert.equal(verdict.comparison?.checkedBy, 'separation')
  assert.equal(verdict.frameChanged, false)
  assert.equal(assessTwoPoint({ ...pairAt(2.7), stored: legacy, override: false }, DEFAULTS).kind, 'mismatch', '30 cm off is outside the spacing tolerance, as it was outside 15 cm')
})

test('one point: a compass reading makes a provisional calibration with no verification fields, and a frame for a Place with none', () => {
  const input = { landmark: { x: 1, y: -1.2, z: 2 }, frameBearingDeg: 90, bearingConvention: 2 as BearingConvention, calibratedAt: '2026-11-16T09:30:00.000Z' }
  const first = buildOnePointCommit({ ...input, existingFrame: undefined }, DEFAULTS)
  assert.equal(first.kind, 'committed')
  if (first.kind !== 'committed') return
  assert.deepEqual(Object.keys(first.calibration), ['method', 'sessionToProject', 'anchorBearingDeg', 'bearingConvention', 'calibratedAt', 'status'])
  assert.equal(first.calibration.status, 'provisional')
  assert.deepEqual(first.spatialFrame, { version: 1, createdAt: '2026-11-16T09:30:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 90, bearingConvention: 2 })
  assert.deepEqual(Object.keys(first.spatialFrame!), ['version', 'createdAt', 'method', 'anchorBearingDeg', 'bearingConvention'])
  const m = first.calibration.sessionToProject
  const tapped = { x: m[0]! * 1 + m[4]! * -1.2 + m[8]! * 2 + m[12]!, y: m[1]! * 1 + m[5]! * -1.2 + m[9]! * 2 + m[13]!, z: m[2]! * 1 + m[6]! * -1.2 + m[10]! * 2 + m[14]! }
  assert.ok(Math.hypot(tapped.x, tapped.y, tapped.z) < 1e-12, 'the tapped point is the project origin')
})

test('one point: a Place that already holds a frame, of any method, is not given another', () => {
  const input = { landmark: { x: 0, y: 0, z: 0 }, frameBearingDeg: 10, bearingConvention: 2 as BearingConvention, calibratedAt: '2026-11-16T09:30:00.000Z' }
  for (const existingFrame of [
    { version: 1, createdAt: 'x', method: 'ground-tap-compass', anchorBearingDeg: null },
    storedFrame(3),
  ] as ProjectSpatialFrame[]) {
    const outcome = buildOnePointCommit({ ...input, existingFrame }, DEFAULTS)
    assert.ok(outcome.kind === 'committed' && outcome.spatialFrame === undefined && outcome.calibration.status === 'provisional')
  }
})

test('one point with no compass reading is refused with its reason, and builds nothing', () => {
  const outcome = buildOnePointCommit(
    { landmark: { x: 0, y: 0, z: 0 }, frameBearingDeg: null, bearingConvention: 2, existingFrame: undefined, calibratedAt: '2026-11-16T09:30:00.000Z' },
    DEFAULTS,
  )
  assert.deepEqual(outcome, { kind: 'refused', reason: 'no-compass', text: 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.' })
})

// ── The seams ────────────────────────────────────────────────────────────────────────────────────────

test('defaults: one hit from the host\'s hit test, never disturbed, the adopted sigma', async () => {
  const calls: Array<[number, number]> = []
  const hit = { position: { x: 1, y: 0, z: 2 } }
  const resolved = resolveCommitOptions({ hitTest: async (x, y) => { calls.push([x, y]); return hit } })
  assert.equal(await resolved.sampleTap(0.25, 0.75), hit)
  assert.deepEqual(calls, [[0.25, 0.75]], 'one hit test per tap')
  assert.equal(resolved.isDisturbed(), false)
  assert.equal(resolved.sigmaHatM, TAP_SIGMA0_M)
  assert.equal(TAP_SIGMA0_M, 0.03)
})

test('sampleTap, when given, reads the tap instead of the host\'s hit test, and is the one a later swap replaces', async () => {
  const asked: string[] = []
  const options: CommitOptions = {
    hitTest: async () => { asked.push('hitTest'); return { position: { x: 0, y: 0, z: 0 } } },
    sampleTap: async (x: number, y: number) => { asked.push(`sampleTap ${x} ${y}`); return { position: { x: 5, y: 0, z: 5 } } },
  }
  const resolved = resolveCommitOptions(options)
  assert.deepEqual(await readTap(resolved, 0.1, 0.2), { position: { x: 5, y: 0, z: 5 } })
  assert.deepEqual(asked, ['sampleTap 0.1 0.2'], 'the hit test was not asked')
  // The reader is looked up at each tap, as the modal looked up its hit test.
  options.sampleTap = async () => { asked.push('swapped'); return null }
  assert.equal(await readTap(resolved, 0.3, 0.4), null)
  assert.deepEqual(asked.slice(1), ['swapped'])
  // A sampleTap that rejects found nothing, like a hit test that does.
  const failing = resolveCommitOptions({ hitTest: async () => null, sampleTap: () => Promise.reject(new Error('unsteady')) })
  assert.equal(await readTap(failing, 0.5, 0.5), null)
})

test('a reader may refuse a tap with the sentence to show, or say how high it measured: both pass through as they are given', async () => {
  const refusal = { refused: 'That spot is 3.4 m away. Move closer and tap again.' }
  const refusing = resolveCommitOptions({ hitTest: async () => null, sampleTap: async () => refusal })
  assert.equal(await readTap(refusing, 0.5, 0.5), refusal, 'the same object, untouched')
  const tapped = { position: { x: 1, y: 0, z: 2 }, surfaceY: 0.4 }
  assert.equal(await readTap(resolveCommitOptions({ hitTest: async () => null, sampleTap: async () => tapped }), 0.5, 0.5), tapped)
  // A hit test the host gives is read the same way, so a refusal from it is shown as one.
  assert.equal(await readTap(resolveCommitOptions({ hitTest: async () => refusal }), 0.5, 0.5), refusal)
})

test('a host\'s hit test is called through its options, so a method keeps its this', async () => {
  const options = {
    tag: 'the options object',
    async hitTest(this: { tag: string }) { return { position: { x: this.tag.length, y: 0, z: 0 } } },
  }
  assert.deepEqual(await readTap(resolveCommitOptions(options), 0.5, 0.5), { position: { x: 'the options object'.length, y: 0, z: 0 } })
})

test('isDisturbed turns a commit away when it says so, for a good pair as for a short one, and is not asked otherwise', () => {
  let asked = 0
  const disturbed = resolveCommitOptions({ hitTest: async () => null, isDisturbed: () => { asked += 1; return true } })
  const pair = pairAt(3)
  assert.deepEqual(assessTwoPoint({ ...pair, stored: null, override: false }, disturbed), { kind: 'refused', reason: 'disturbed' })
  assert.deepEqual(assessTwoPoint({ ...pair, stored: storedFrame(3), override: true }, disturbed), { kind: 'refused', reason: 'disturbed' }, '"Use anyway" does not get past it')
  assert.deepEqual(assessTwoPoint({ ...pairAt(0.5), stored: null, override: false }, disturbed), { kind: 'refused', reason: 'disturbed' })
  const onePoint = buildOnePointCommit({ landmark: pair.landmark, frameBearingDeg: 10, bearingConvention: 2, existingFrame: undefined, calibratedAt: 'x' }, disturbed)
  assert.deepEqual(onePoint, { kind: 'refused', reason: 'disturbed', text: null })
  assert.equal(asked, 4, 'once per commit')

  // Not disturbed, or no opinion: the same verdicts as with no option at all.
  for (const isDisturbed of [() => false, undefined]) {
    const calm = resolveCommitOptions({ hitTest: async () => null, ...(isDisturbed ? { isDisturbed } : {}) })
    assert.deepEqual(assessTwoPoint({ ...pair, stored: storedFrame(3), override: false }, calm), assessTwoPoint({ ...pair, stored: storedFrame(3), override: false }, DEFAULTS))
  }
})

test('sigmaHatM is honoured when it is a positive number, and is the adopted default when it is anything else', () => {
  assert.equal(resolveCommitOptions({ hitTest: async () => null, sigmaHatM: 0.05 }).sigmaHatM, 0.05)
  assert.equal(resolveCommitOptions({ hitTest: async () => null, sigmaHatM: 1e-6 }).sigmaHatM, 1e-6)
  for (const bad of [0, -0.03, Number.NaN, Infinity, -Infinity, undefined, '0.05' as unknown as number, null as unknown as number]) {
    assert.equal(resolveCommitOptions({ hitTest: async () => null, sigmaHatM: bad }).sigmaHatM, TAP_SIGMA0_M, `${String(bad)}`)
  }
})

test('sigmaHatM sets the spacing tolerance and the gates of a fit: twice the rms gate at the tap noise, capped where a visit is too unsteady to judge', () => {
  const noisy = resolveCommitOptions({ hitTest: async () => null, sigmaHatM: 0.05 })
  assert.equal(noisy.sigmaHatM, 0.05)
  // 20 cm off the stored distance: outside 16.8 cm (3 cm of tap noise), inside 28 cm (5 cm).
  const frame = storedFrame(3)
  assert.equal(assessTwoPoint({ ...pairAt(3.2), stored: frame, override: false }, DEFAULTS).kind, 'mismatch')
  const accepted = assessTwoPoint({ ...pairAt(3.2), stored: frame, override: false }, noisy)
  assert.ok(accepted.kind === 'accepted' && accepted.toleranceM === twoPointToleranceM(0.05) && twoPointToleranceM(0.05) === 2 * 2.8 * 0.05)
  assert.equal(twoPointToleranceM(0.5), twoPointToleranceM(0.1), 'beyond 10 cm the gates stop growing: a check that wide cannot support "verified"')
  // A first calibration records the tolerance of the noise in use, so a later visit and the editor read what was applied.
  const first = assessTwoPoint({ ...pairAt(3), stored: null, override: false }, noisy)
  assert.ok(first.kind === 'accepted' && first.toleranceM === twoPointToleranceM(0.05))
  // The tap noise is not read from the burst of one tap: it is the option, and nothing in a hit's scatter reaches it.
  assert.equal(readFileSync(join(ROOT, 'src/ar/calibration-commit.ts'), 'utf8').includes('spreadM'), false)
})

test('a tap noise below the adopted floor is raised to it, for a fit as for a pair: the gates cannot be made tighter than 3 cm', () => {
  const taps = visitTaps()
  const scattered = { ...taps, checkPoint: { ...taps.checkPoint!, x: taps.checkPoint!.x + 0.05, z: taps.checkPoint!.z + 0.04 } }
  const lenient = assessTwoPoint({ ...scattered, stored: withCheck(), override: false }, DEFAULTS)
  assert.ok(lenient.kind === 'accepted')
  const strict = assessTwoPoint({ ...scattered, stored: withCheck(), override: false }, resolveCommitOptions({ hitTest: async () => null, sigmaHatM: 0.015 }))
  // sigma-hat is raised to the adopted floor (3 cm) whatever is asked (`sigmaHat` in frame-fit.ts), so the verdict is the same.
  assert.deepStrictEqual(strict, lenient)
  assert.equal(twoPointToleranceM(0.015), TOLERANCE_M)
})

// ── Purity ───────────────────────────────────────────────────────────────────────────────────────────

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('the module reads no DOM, no Deno API, no clock and no randomness, and imports only the world modules and the constellation flow (ADR 0002)', () => {
  const source = stripComments(readFileSync(join(ROOT, 'src/ar/calibration-commit.ts'), 'utf8'))
  for (const [what, pattern] of [
    ['a Deno API', /\bDeno\b/],
    ['the document or window', /\b(document|window|navigator|location|localStorage|sessionStorage|indexedDB)\b/],
    ['a DOM type', /\b(HTML\w*Element|TouchEvent|PointerEvent|Element|Node)\b/],
    ['the clock', /\b(Date\.now|new Date|performance\.now|setTimeout|setInterval|requestAnimationFrame)\b/],
    ['randomness', /\bMath\.random\b/],
    ['the scene', /\bTHREE\b|from 'three'/],
  ] as const) {
    assert.doesNotMatch(source, pattern, `calibration-commit.ts reaches for ${what}`)
  }
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
  // calibration-evidence.ts is the leaf that declares `ScanCalibration.tap` (`TapEvidence`): the commit hands the evidence
  // a tap reader gathered to the calibration it builds and reads none of it.
  assert.deepEqual(imports.sort(), ['../world/baseline-guidance.ts', '../world/calibration-evidence.ts', '../world/frame-fit.ts', '../world/geo.ts', '../world/types.ts', './constellation-flow.ts'])
})
