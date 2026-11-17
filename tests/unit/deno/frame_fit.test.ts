/**
 * Tests for src/world/frame-fit.ts: the constellation fit and the verdict built on it.
 *
 * Three kinds of test, so a failure says which kind of thing broke:
 *
 *  1. Contract tests. The maths against its own stated conventions and against
 *     independent oracles: geo.ts (matrix layout, `twoPointToProjectTransform`),
 *     `invertAffine`, the repo's 3D `umeyamaSimilarity`, the normal equations of
 *     least squares, a numerical search over the rotation, a brute-force search over
 *     every order of the points, and a numerical integral of the error distribution.
 *     No random numbers decide a pass.
 *  2. Degenerate-input tests. Every unusable input is an explicit result, never a NaN
 *     and never a throw.
 *  3. Property tests. Seeded simulations that re-derive the design's acceptance
 *     numbers from first principles, and the numbers the review of the first build
 *     added: what a similarity fit does to fault detection, what heights, order and
 *     shape do to a pass. A session is a random rigid motion built with geo.ts; a tap
 *     is the true point plus Gaussian noise; "today's" frame is the real
 *     `twoPointToProjectTransform`, not a re-implementation. The thresholds are the
 *     design's. The measured values are printed when FRAME_FIT_REPORT=1.
 *
 * Tap noise is a model, not a measurement: nothing here says what a phone does.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import {
  composeYUpTransform,
  DEFAULT_SEPARATION_TOLERANCE_M,
  transformPoint,
  twoPointHeadingDeg,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { ANCHOR_RADIUS_M } from '../../../src/world/anchor-marker.ts'
import { umeyamaSimilarity } from '../../../server/splat/splat_align.ts'
import {
  ACCURACY_TARGET_M,
  DUPLICATE_POINT_GAP_M,
  estimateSentence,
  fitRigid2D,
  fitSimilarity2D,
  formatCm,
  frameUncertaintyAt,
  HEIGHT_GATE_SIGMAS,
  headingResidualDeg,
  MAX_FIT_POINTS,
  MAX_GATE_FACTOR,
  MAX_SIGMA_HAT_M,
  MIN_FIT_POINTS,
  MIN_PERPENDICULAR_OFFSET_M,
  MIN_RESIDUAL_DOF,
  NOT_CHECKED_SPOTS,
  perpendicularOffsetM,
  pointResiduals,
  referenceProblem,
  residualsPastGates,
  RMS_GATE_SIGMAS,
  SCALE_RATIO_SANITY,
  SIGMA0_M,
  sigmaHat,
  summariseFit,
  twoPointResidualM,
  twoPointToleranceM,
  verifyConstellation,
  verifyFit,
  verifyTwoPoint,
  WORKING_RADIUS_M,
} from '../../../src/world/frame-fit.ts'
import type {
  ConstellationVerdict,
  FitFailure,
  FitMethod,
  FitOutcome,
  FrameFit,
  UnitsMode,
} from '../../../src/world/frame-fit.ts'
import type { ProjectSpatialFrame, Vec3 } from '../../../src/world/types.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

const REPORT = (() => {
  try {
    return Deno.env.get('FRAME_FIT_REPORT') === '1'
  } catch {
    return false
  }
})()

function report(label: string, value: string): void {
  if (REPORT) console.log(`  [frame-fit] ${label}: ${value}`)
}

/** Metres as whole centimetres, and a fraction as a percentage with `digits` decimals, for report lines. */
const cm = (metres: number): string => (100 * metres).toFixed(0)
const pct = (fraction: number, digits = 1): string => `${(100 * fraction).toFixed(digits)}%`

/** mulberry32, the generator the investigation's scripts use, with Box-Muller on top. */
function makeRng(seed: number): { uniform: () => number; gauss: () => number } {
  let a = seed | 0
  const uniform = (): number => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = (): number => {
    let u = 0
    let v = 0
    while (u === 0) u = uniform()
    while (v === 0) v = uniform()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  return { uniform, gauss }
}
type Rng = ReturnType<typeof makeRng>

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

function ground(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function assertMatrixClose(actual: readonly number[], expected: readonly number[], tolerance: number, label: string): void {
  assertEquals(actual.length, 16, `${label}: 16 entries`)
  for (let i = 0; i < 16; i++) {
    assertAlmostEquals(actual[i]!, expected[i]!, tolerance, `${label}: entry ${i} ${actual[i]} vs ${expected[i]}`)
  }
}

function assertOk(outcome: FitOutcome): FrameFit {
  if (!outcome.ok) throw new Error(`expected a fit, got ${outcome.failure.reason}: ${outcome.failure.message}`)
  return outcome.fit
}

function assertFailure(outcome: FitOutcome, reason: FitFailure['reason']): FitFailure {
  if (outcome.ok) throw new Error(`expected ${reason}, got a fit`)
  assertEquals(outcome.failure.reason, reason, outcome.failure.message)
  return outcome.failure
}

/** A fit's heading residual, which is null only when a baseline has no length. */
function headingOf(fit: FrameFit): number {
  if (fit.headingResidualDeg === null) throw new Error('the first two points have no direction')
  return fit.headingResidualDeg
}

/** Determinant of the 3x3 block of a column-major matrix. */
function blockDeterminant(m: readonly number[]): number {
  const [a, b, c] = [m[0]!, m[4]!, m[8]!]
  const [d, e, f] = [m[1]!, m[5]!, m[9]!]
  const [g, h, i] = [m[2]!, m[6]!, m[10]!]
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}

/** The design's constellation: landmark, heading marker `d` along +Z, and a check point 3.0 m to the side and 2.8 m along. */
function constellation(d: number): Vec3[] {
  return [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: d },
    { x: 3.0, y: 0, z: 2.8 },
  ]
}

/** A fourth point on the far side, as in the investigation's four-point case. */
function constellationOfFour(d: number): Vec3[] {
  return [...constellation(d), { x: -2.5, y: 0, z: 3.5 }]
}

/** The probe the investigation uses: 5 m from the landmark at 60 degrees from +Z. */
const PROBE: Vec3 = { x: 5 * Math.sin((60 * Math.PI) / 180), y: 0, z: 5 * Math.cos((60 * Math.PI) / 180) }

// ── A phone session, as geo.ts would build one ──────────────────────────────

interface SimVisit {
  /** Where each tap landed, in this session's own coordinates. */
  taps: Vec3[]
  /** Where a true Place-frame point is in this session's coordinates. */
  toSession: (p: Vec3) => Vec3
}

interface VisitOptions {
  /** Session units per metre: 1.10 means every length reads 10% long. */
  unitRatio?: number
  /** Where the user really tapped for point `i`, in the Place frame, before tap noise. */
  fault?: (i: number, truth: Vec3) => Vec3
  /** Vertical tap noise when it differs from `sigma`, in metres. */
  sigmaY?: number
}

/**
 * One visit: a random session pose (yaw, origin and floor height all differ from the
 * Place's), each point tapped with isotropic Gaussian noise of `sigma` per axis.
 */
function simulateVisit(r: Rng, truth: readonly Vec3[], sigma: number, options: VisitOptions = {}): SimVisit {
  const unit = options.unitRatio ?? 1
  const pose = composeYUpTransform(
    { x: (r.uniform() - 0.5) * 10, y: (r.uniform() - 0.5) * 2, z: (r.uniform() - 0.5) * 10 },
    r.uniform() * 360,
  )
  const toSession = (p: Vec3): Vec3 => {
    const s = transformPoint(pose, p)
    return { x: s.x * unit, y: s.y * unit, z: s.z * unit }
  }
  const taps = truth.map((point, i) => {
    const aimed = options.fault ? options.fault(i, point) : point
    return toSession({
      x: aimed.x + r.gauss() * sigma,
      y: aimed.y + r.gauss() * (options.sigmaY ?? sigma),
      z: aimed.z + r.gauss() * sigma,
    })
  })
  return { taps, toSession }
}

interface SimReference {
  /** The Place's stored points: every tap of the first visit seen through that visit's own two-point frame. */
  stored: Vec3[]
  /** Where the first visit's frame puts a true Place-frame point: the position later visits are judged against. */
  positionOf: (p: Vec3) => Vec3
}

/** The first visit, which defines the Place frame exactly as the calibration flow does today. */
function simulateReference(r: Rng, truth: readonly Vec3[], sigma: number, options: VisitOptions = {}): SimReference {
  const visit = simulateVisit(r, truth, sigma, { sigmaY: options.sigmaY })
  const frame = twoPointToProjectTransform(visit.taps[0]!, visit.taps[1]!)
  return {
    stored: visit.taps.map((tap) => transformPoint(frame, tap)),
    positionOf: (p) => transformPoint(frame, visit.toSession(p)),
  }
}

// ── 1. Contract tests ───────────────────────────────────────────────────────

Deno.test('convention: fitting the visit onto the stored points IS sessionToProject, in geo.ts layout', () => {
  const stored = constellation(2)
  // A session whose axes, origin and floor height all differ from the Place frame.
  const projectToSession = composeYUpTransform({ x: 2.3, y: 0.12, z: -1.7 }, 37)
  const visit = stored.map((p) => transformPoint(projectToSession, p))

  const fit = assertOk(fitRigid2D(visit, stored))
  const truth = invertAffine(projectToSession)!

  assertMatrixClose(fit.matrix, truth, 1e-9, 'against the inverse of the session pose')
  // For a consistent visit the fit and today's two-point construction are the same matrix.
  assertMatrixClose(fit.matrix, twoPointToProjectTransform(visit[0]!, visit[1]!), 1e-9, 'against twoPointToProjectTransform')
  assertAlmostEquals(fit.headingDeg, twoPointHeadingDeg(visit[0]!, visit[1]!), 1e-9, 'headingDeg has the sign of twoPointHeadingDeg')
  // And it is geo.ts's own builder with the documented argument.
  const rebuilt = composeYUpTransform({ x: fit.matrix[12]!, y: fit.matrix[13]!, z: fit.matrix[14]! }, -fit.headingDeg, fit.scale)
  assertMatrixClose(fit.matrix, rebuilt, 1e-12, 'composeYUpTransform(translation, -headingDeg, scale)')
  // The landmark lands on the origin and the heading marker on +Z, which is what the Place frame is.
  const landmark = transformPoint(fit.matrix, visit[0]!)
  const marker = transformPoint(fit.matrix, visit[1]!)
  assertAlmostEquals(landmark.x, 0, 1e-9)
  assertAlmostEquals(landmark.z, 0, 1e-9)
  assertAlmostEquals(marker.x, 0, 1e-9)
  assertAlmostEquals(marker.z, 2, 1e-9)
  assertEquals(fit.fitMethod, 'rigid')
  assertEquals(fit.scale, 1)
})

Deno.test('convention: a fit from the stored points to the visit, inverted with invertAffine, is the same sessionToProject', () => {
  const stored = constellation(3)
  const projectToSession = composeYUpTransform({ x: -4.1, y: 0.4, z: 0.9 }, 211)
  const visit = stored.map((p) => transformPoint(projectToSession, p))

  const projectToVisit = assertOk(fitRigid2D(stored, visit))
  const sessionToProject = invertAffine(projectToVisit.matrix)!
  assertMatrixClose(sessionToProject, assertOk(fitRigid2D(visit, stored)).matrix, 1e-9, 'both directions agree')

  // That is how a stored point is placed in the session, to draw its ghost.
  const ghost = transformPoint(projectToVisit.matrix, stored[2]!)
  const tapped = visit[2]!
  assertAlmostEquals(ground(ghost, tapped), 0, 1e-9)
})

Deno.test('convention: with noisy taps the fit is a small correction on top of the two-point transform', () => {
  const r = makeRng(41)
  const stored = constellation(2)
  const visit = simulateVisit(r, stored, 0.03)
  const today = twoPointToProjectTransform(visit.taps[0]!, visit.taps[1]!)
  const direct = assertOk(fitRigid2D(visit.taps, stored))

  // The correction lives in the Place frame: it carries today's mapping of the taps onto the stored points.
  const seenByToday = visit.taps.map((t) => transformPoint(today, t))
  const correction = assertOk(fitRigid2D(seenByToday, stored))
  for (const p of [PROBE, { x: -1, y: 0, z: 4 }, { x: 2, y: 0.3, z: -3 }]) {
    const inSession = visit.toSession(p)
    const viaCorrection = transformPoint(correction.matrix, transformPoint(today, inSession))
    const viaFit = transformPoint(direct.matrix, inSession)
    assertAlmostEquals(viaCorrection.x, viaFit.x, 1e-9)
    assertAlmostEquals(viaCorrection.y, viaFit.y, 1e-9)
    assertAlmostEquals(viaCorrection.z, viaFit.z, 1e-9)
  }
  assert(Math.abs(correction.headingDeg) < 10, `a 3 cm visit corrects by ${correction.headingDeg} degrees`)
})

Deno.test('fit recovers random rigid motions exactly and is a proper rotation', () => {
  const r = makeRng(7)
  for (let k = 0; k < 300; k++) {
    const stored = constellationOfFour(1 + r.uniform() * 3).map((p) => ({ x: p.x, y: r.uniform() * 0.2, z: p.z }))
    const pose = composeYUpTransform(
      { x: (r.uniform() - 0.5) * 20, y: (r.uniform() - 0.5) * 4, z: (r.uniform() - 0.5) * 20 },
      r.uniform() * 360,
    )
    const visit = stored.map((p) => transformPoint(pose, p))
    const fit = assertOk(fitRigid2D(visit, stored))
    assertMatrixClose(fit.matrix, invertAffine(pose)!, 1e-8, `motion ${k}`)
    assert(fit.rmsResidualM < 1e-9 && fit.maxResidualM < 1e-9, 'an exact correspondence leaves no residual')
    assertAlmostEquals(blockDeterminant(fit.matrix), 1, 1e-9, 'a rigid fit is a rotation, never a reflection')
    assertAlmostEquals(headingOf(fit), 0, 1e-6)
  }
})

Deno.test('heights: the vertical offset is the mean over all points, not the landmark alone', () => {
  const stored: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
    { x: 3, y: 0.06, z: 2.8 },
  ]
  // The same visit with an unrelated floor height and a different error on every tap's height.
  const visit: Vec3[] = [
    { x: 5, y: 1.2 + 0.04, z: 1 },
    { x: 5, y: 1.2 - 0.02, z: 3 },
    { x: 8, y: 1.2 + 0.07, z: 3.8 },
  ]
  const fit = assertOk(fitRigid2D(visit, stored))
  const meanStored = (0 + 0 + 0.06) / 3
  const meanVisit = (1.24 + 1.18 + 1.27) / 3
  assertAlmostEquals(fit.matrix[13]!, meanStored - meanVisit, 1e-12)
  // The old rule would have used the landmark's own height: it differs from the mean offset here.
  assert(Math.abs(fit.matrix[13]! - (0 - 1.24)) > 0.01)
  // Residual heights sum to zero: the offset is the least-squares one.
  assertAlmostEquals(fit.perPoint.reduce((s, p) => s + p.dy, 0), 0, 1e-12)
})

Deno.test('heights: averaging the points cuts floor-height noise against a single tap', () => {
  const r = makeRng(11)
  const sigma = 0.03
  const truth = constellation(2)
  let single = 0
  let averaged = 0
  const trials = 4000
  for (let k = 0; k < trials; k++) {
    const reference = simulateReference(r, truth, sigma)
    const visit = simulateVisit(r, truth, sigma)
    const fit = assertOk(fitRigid2D(visit.taps, reference.stored))
    const today = twoPointToProjectTransform(visit.taps[0]!, visit.taps[1]!)
    const probe = visit.toSession({ x: 1, y: 0, z: 1 })
    const expected = reference.positionOf({ x: 1, y: 0, z: 1 })
    averaged += (transformPoint(fit.matrix, probe).y - expected.y) ** 2
    single += (transformPoint(today, probe).y - expected.y) ** 2
  }
  const ratio = Math.sqrt(single / trials) / Math.sqrt(averaged / trials)
  report('floor-height rms, one tap over three-point mean', ratio.toFixed(2))
  assert(ratio > 1.2, `the mean of three taps should beat one tap, got a ratio of ${ratio}`)
})

Deno.test('least squares: the residuals satisfy the normal equations and no nearby motion beats the fit', () => {
  const r = makeRng(19)
  const stored = constellationOfFour(1.5)
  const visit = simulateVisit(r, stored, 0.05)
  const fit = assertOk(fitRigid2D(visit.taps, stored))

  // Zero net residual (translation is optimal) and zero net moment about the centroid (rotation is optimal).
  let sx = 0
  let sz = 0
  let moment = 0
  const mapped = visit.taps.map((t) => transformPoint(fit.matrix, t))
  const cx = mapped.reduce((s, p) => s + p.x, 0) / mapped.length
  const cz = mapped.reduce((s, p) => s + p.z, 0) / mapped.length
  mapped.forEach((p, i) => {
    const { dx, dz } = fit.perPoint[i]!
    sx += dx
    sz += dz
    moment += (p.x - cx) * dz - (p.z - cz) * dx
  })
  assertAlmostEquals(sx, 0, 1e-12)
  assertAlmostEquals(sz, 0, 1e-12)
  assertAlmostEquals(moment, 0, 1e-12)

  // Independent of the closed form: perturb the optimum in every direction and the error only grows.
  const squares = (m: number[]) => pointResiduals(m, visit.taps, stored)!.reduce((s, p) => s + p.residualM ** 2, 0)
  const best = squares(fit.matrix)
  for (let k = 0; k < 400; k++) {
    const turn = (r.gauss() * 2 * Math.PI) / 180
    const nudge = composeYUpTransform({ x: r.gauss() * 0.05, y: 0, z: r.gauss() * 0.05 }, (turn * 180) / Math.PI)
    const perturbed = [...fit.matrix]
    const rotated = composeYUpTransform({ x: 0, y: 0, z: 0 }, -fit.headingDeg + (turn * 180) / Math.PI)
    for (let i = 0; i < 12; i++) perturbed[i] = rotated[i]!
    perturbed[12] = fit.matrix[12]! + nudge[12]!
    perturbed[14] = fit.matrix[14]! + nudge[14]!
    assert(squares(perturbed) >= best - 1e-12, 'a perturbed motion fits better than the least-squares fit')
  }
})

Deno.test('the fit does not depend on the order of the points or on where the visit started', () => {
  const r = makeRng(23)
  const stored = constellationOfFour(2)
  const visit = simulateVisit(r, stored, 0.04)
  const fit = assertOk(fitRigid2D(visit.taps, stored))

  const order = [2, 0, 3, 1]
  const permuted = assertOk(fitRigid2D(order.map((i) => visit.taps[i]!), order.map((i) => stored[i]!)))
  assertMatrixClose(permuted.matrix, fit.matrix, 1e-12, 'permuted points')

  // Moving the whole visit by a rigid motion M changes the fit to fit . M^-1 and nothing else.
  const shift = composeYUpTransform({ x: 3, y: -0.5, z: 7 }, 118)
  const moved = assertOk(fitRigid2D(visit.taps.map((t) => transformPoint(shift, t)), stored))
  for (const p of visit.taps) {
    const a = transformPoint(moved.matrix, transformPoint(shift, p))
    const b = transformPoint(fit.matrix, p)
    assertAlmostEquals(a.x, b.x, 1e-9)
    assertAlmostEquals(a.y, b.y, 1e-9)
    assertAlmostEquals(a.z, b.z, 1e-9)
  }
  assertAlmostEquals(moved.rmsResidualM, fit.rmsResidualM, 1e-12)
})

Deno.test('similarity: recovers rotation, translation and one scale exactly, and applies the scale to all three axes', () => {
  const stored = constellationOfFour(2).map((p, i) => ({ ...p, y: i * 0.1 }))
  const ratio = 1.12
  const pose = composeYUpTransform({ x: 1.5, y: -0.3, z: 4 }, 73)
  const visit = stored.map((p) => {
    const s = transformPoint(pose, p)
    return { x: s.x * ratio, y: s.y * ratio, z: s.z * ratio }
  })

  const fit = assertOk(fitSimilarity2D(visit, stored))
  assertEquals(fit.fitMethod, 'similarity')
  assertAlmostEquals(fit.scale, 1 / ratio, 1e-12)
  assertAlmostEquals(fit.scaleRatio, ratio, 1e-12)
  assertAlmostEquals(fit.scale * fit.scaleRatio, 1, 1e-12)
  assert(fit.rmsResidualM < 1e-9 && fit.maxResidualM < 1e-9)
  // Every column of the 3x3 block has length `scale`, the vertical one included.
  for (const column of [[0, 1, 2], [4, 5, 6], [8, 9, 10]]) {
    assertAlmostEquals(Math.hypot(...column.map((i) => fit.matrix[i]!)), fit.scale, 1e-12)
  }
  assertAlmostEquals(blockDeterminant(fit.matrix), fit.scale ** 3, 1e-12)
  stored.forEach((p, i) => {
    const mapped = transformPoint(fit.matrix, visit[i]!)
    assertAlmostEquals(mapped.x, p.x, 1e-9)
    assertAlmostEquals(mapped.y, p.y, 1e-9)
    assertAlmostEquals(mapped.z, p.z, 1e-9)
  })

  // The rigid fit measures the same ratio and does not apply it.
  const rigid = assertOk(fitRigid2D(visit, stored))
  assertAlmostEquals(rigid.scaleRatio, ratio, 1e-12)
  assertEquals(rigid.scale, 1)
  assert(rigid.rmsResidualM > 0.1, 'a 12% size difference is not absorbed by a rigid fit')
})

Deno.test('oracle: on planar points the 2D fits agree with the repo\'s 3D Umeyama similarity', () => {
  const r = makeRng(29)
  for (let k = 0; k < 40; k++) {
    const stored = constellationOfFour(1 + r.uniform() * 3)
    const visit = simulateVisit(r, stored, 0.02, { unitRatio: 0.85 + r.uniform() * 0.4 })
    const fit = assertOk(fitSimilarity2D(visit.taps, stored))

    // Umeyama's rotation is about y only when both sets are planar, so flatten the heights.
    const flat = visit.taps.map((t) => [t.x, 0, t.z])
    const reference = umeyamaSimilarity(flat, stored.map((p) => [p.x, 0, p.z]))
    assertAlmostEquals(fit.scale, reference.scale, 1e-9, 'scale')
    // Row-major rotation of the oracle against the column-major block of the fit, divided by the scale.
    const block = [
      [fit.matrix[0]!, fit.matrix[4]!, fit.matrix[8]!],
      [fit.matrix[1]!, fit.matrix[5]!, fit.matrix[9]!],
      [fit.matrix[2]!, fit.matrix[6]!, fit.matrix[10]!],
    ]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assertAlmostEquals(block[i]![j]! / fit.scale, reference.rotation[i]![j]!, 1e-9, `R[${i}][${j}]`)
      }
    }
    assertAlmostEquals(fit.matrix[12]!, reference.translation[0], 1e-9, 'tx')
    assertAlmostEquals(fit.matrix[14]!, reference.translation[2], 1e-9, 'tz')
    // The oracle reports an rms that includes height, which is flat here, so it equals ours.
    assertAlmostEquals(fit.rmsResidualM, reference.residualM, 1e-9, 'rms')
  }
})

Deno.test('perPoint residuals are where the point lands minus its target, index-aligned, and rms and max summarise them', () => {
  const stored = constellation(2)
  const pose = composeYUpTransform({ x: 1, y: 0.2, z: -2 }, 15)
  const visit = stored.map((p) => transformPoint(pose, p))
  // Move the check point 12 cm east, 5 cm north and 6 cm up in the Place frame.
  const tapped = [...visit]
  const toSession = invertAffine(assertOk(fitRigid2D(visit, stored)).matrix)!
  tapped[2] = transformPoint(toSession, { x: 3.12, y: 0.06, z: 2.85 })

  const fit = assertOk(fitRigid2D(tapped, stored))
  assertEquals(fit.perPoint.length, 3)
  const direct = pointResiduals(fit.matrix, tapped, stored)!
  assertEquals(fit.perPoint, direct)
  fit.perPoint.forEach((p) => assertAlmostEquals(p.residualM, Math.hypot(p.dx, p.dz), 1e-15))
  assertAlmostEquals(fit.maxResidualM, Math.max(...fit.perPoint.map((p) => p.residualM)), 1e-15)
  assertAlmostEquals(
    fit.rmsResidualM,
    Math.sqrt(fit.perPoint.reduce((s, p) => s + p.residualM ** 2, 0) / 3),
    1e-15,
  )
  // The displaced point is the one the fit leaves furthest off, in the direction it was displaced.
  assertEquals(fit.perPoint.indexOf(fit.perPoint.reduce((a, b) => (b.residualM > a.residualM ? b : a))), 2)
  assert(fit.perPoint[2]!.dx > 0 && fit.perPoint[2]!.dz > 0, 'the residual points the way the tap landed')
  // Heights are fitted by their mean: the raised tap lands two thirds of its 6 cm above target and the others a third below.
  assertAlmostEquals(fit.perPoint[2]!.dy, 0.04, 1e-9)
  assertAlmostEquals(fit.perPoint[0]!.dy, -0.02, 1e-9)
  assertAlmostEquals(fit.perPoint[1]!.dy, -0.02, 1e-9)

  // Residuals under a matrix that is not a fit: today's two-point transform leaves the check point off by the same.
  const today = pointResiduals(twoPointToProjectTransform(tapped[0]!, tapped[1]!), tapped, stored)!
  assertAlmostEquals(today[2]!.dx, 0.12, 1e-9)
  assertAlmostEquals(today[2]!.dz, 0.05, 1e-9)
  assertAlmostEquals(today[0]!.residualM, 0, 1e-9)
})

Deno.test('pointResiduals: no answer, not a NaN, for a matrix that is not 16 finite numbers, unequal lengths or a bad coordinate', () => {
  const stored = constellation(2)
  const identity = composeYUpTransform({ x: 0, y: 0, z: 0 }, 0)
  assertEquals(pointResiduals(identity, stored, stored)!.map((r) => r.residualM), [0, 0, 0])
  assertEquals(pointResiduals(identity.slice(0, 15), stored, stored), null)
  assertEquals(pointResiduals([...identity, 1], stored, stored), null)
  assertEquals(pointResiduals(identity.map((v, i) => (i === 12 ? Number.NaN : v)), stored, stored), null)
  assertEquals(pointResiduals(identity.map((v, i) => (i === 5 ? Number.POSITIVE_INFINITY : v)), stored, stored), null)
  assertEquals(pointResiduals(identity, stored, stored.slice(0, 2)), null)
  assertEquals(pointResiduals(identity, [{ ...stored[0]!, y: Number.NaN }, stored[1]!, stored[2]!], stored), null)
  assertEquals(pointResiduals(identity, stored, [stored[0]!, undefined as unknown as Vec3, stored[2]!]), null)
  assertEquals(pointResiduals(identity, [], []), [])
})

Deno.test('summariseFit keeps what belongs on a scan, is JSON-safe and does not alias the fit', () => {
  const stored = constellation(2)
  const visit = stored.map((p) => transformPoint(composeYUpTransform({ x: 1, y: 0, z: 2 }, 30), p))
  visit[2] = { ...visit[2]!, x: visit[2]!.x + 0.04 }
  const fit = assertOk(fitRigid2D(visit, stored))
  const summary = summariseFit(fit)
  assertEquals(Object.keys(summary).sort(), [
    'fitMethod',
    'headingResidualDeg',
    'maxResidualM',
    'perPoint',
    'pointsUsed',
    'rmsResidualM',
    'scaleRatio',
  ])
  assertEquals(JSON.parse(JSON.stringify(summary)), summary)
  summary.perPoint[0]!.dx = 99
  assert(fit.perPoint[0]!.dx !== 99)
})

// ── 2. Degenerate inputs ────────────────────────────────────────────────────

const TRIANGLE = constellation(2)

Deno.test('degenerate: fewer than three points is a result that says so', () => {
  assertEquals(MIN_FIT_POINTS, 3)
  for (const n of [0, 1, 2]) {
    const failure = assertFailure(fitRigid2D(TRIANGLE.slice(0, n), TRIANGLE.slice(0, n)), 'too-few-points')
    if (failure.reason !== 'too-few-points') throw new Error('unreachable')
    assertEquals(failure.pointsGiven, n)
    assertEquals(failure.pointsRequired, 3)
    assertEquals(failure.message, `Only ${n} point${n === 1 ? '' : 's'}: at least 3 are needed to check direction.`)
    assertFailure(fitSimilarity2D(TRIANGLE.slice(0, n), TRIANGLE.slice(0, n)), 'too-few-points')
  }
})

Deno.test('degenerate: different numbers of points are reported before anything else', () => {
  const failure = assertFailure(fitRigid2D(TRIANGLE, TRIANGLE.slice(0, 2)), 'length-mismatch')
  if (failure.reason !== 'length-mismatch') throw new Error('unreachable')
  assertEquals([failure.fromCount, failure.toCount], [3, 2])
  assertFailure(fitSimilarity2D(TRIANGLE.slice(0, 2), TRIANGLE), 'length-mismatch')
})

Deno.test('degenerate: a value that is not a finite number is named by set and index, in x, y or z', () => {
  const bad: Array<[string, (p: Vec3) => Vec3]> = [
    ['NaN x', (p) => ({ ...p, x: Number.NaN })],
    ['Infinity y', (p) => ({ ...p, y: Number.POSITIVE_INFINITY })],
    ['-Infinity z', (p) => ({ ...p, z: Number.NEGATIVE_INFINITY })],
    ['string', (p) => ({ ...p, x: '1' as unknown as number })],
    ['missing y', (p) => ({ x: p.x, z: p.z } as unknown as Vec3)],
  ]
  for (const [label, corrupt] of bad) {
    const broken = TRIANGLE.map((p, i) => (i === 1 ? corrupt(p) : p))
    for (const [from, to, set] of [[broken, TRIANGLE, 'from'], [TRIANGLE, broken, 'to']] as const) {
      const failure = assertFailure(fitRigid2D(from, to), 'non-finite')
      if (failure.reason !== 'non-finite') throw new Error('unreachable')
      assertEquals([failure.set, failure.index], [set, 1], label)
    }
  }
  const holes = [TRIANGLE[0]!, undefined as unknown as Vec3, TRIANGLE[2]!]
  assertFailure(fitRigid2D(holes, TRIANGLE), 'non-finite')
  assertFailure(fitRigid2D([TRIANGLE[0]!, null as unknown as Vec3, TRIANGLE[2]!], TRIANGLE), 'non-finite')
})

Deno.test('degenerate: duplicate stored points name the pair and the gap', () => {
  assertEquals(DUPLICATE_POINT_GAP_M, ANCHOR_RADIUS_M, 'the gap is the calibration flow\'s own "same spot" radius')
  const same = [TRIANGLE[0]!, { ...TRIANGLE[0]! }, TRIANGLE[2]!]
  const failure = assertFailure(fitRigid2D(TRIANGLE, same), 'duplicate-points')
  if (failure.reason !== 'duplicate-points') throw new Error('unreachable')
  assertEquals([failure.indices, failure.gapM], [[0, 1], 0])
  // Just inside the gap is a duplicate, just outside is not; height does not separate two spots.
  const near = (gap: number): Vec3[] => [TRIANGLE[0]!, { x: gap, y: 0.5, z: 0 }, TRIANGLE[2]!, { x: -2, y: 0, z: 4 }]
  const far = [...TRIANGLE, { x: -2, y: 0, z: 4 }]
  assertFailure(fitRigid2D(far, near(DUPLICATE_POINT_GAP_M - 1e-6)), 'duplicate-points')
  assertOk(fitRigid2D(far, near(DUPLICATE_POINT_GAP_M + 1e-6)))
})

Deno.test('degenerate: a visit whose taps collapse onto one spot is judged on its residuals, not refused', () => {
  // The reference is fine; the visit tapped the same place twice. That is a wrong visit, which the
  // fit must be able to say, not an input it cannot check: "provisional" here would let a mistap through.
  const stacked = [TRIANGLE[0]!, { ...TRIANGLE[0]! }, TRIANGLE[2]!]
  for (const fit of [fitRigid2D, fitSimilarity2D]) {
    const outcome = fit(stacked, TRIANGLE)
    assert(outcome.ok || outcome.failure.reason === 'unmatched' || outcome.failure.reason === 'mirrored')
    assertEquals(verifyFit(outcome).status, 'mismatch')
  }
  // Every tap on the same spot: nothing to fit, said plainly, and still a mismatch.
  const pile = [TRIANGLE[0]!, { ...TRIANGLE[0]!, y: 1 }, { ...TRIANGLE[0]!, y: 2 }]
  assertFailure(fitRigid2D(pile, TRIANGLE), 'unmatched')
  assertFailure(fitSimilarity2D(pile, TRIANGLE), 'unmatched')
  assertEquals(verifyFit(fitRigid2D(pile, TRIANGLE)).status, 'mismatch')
})

Deno.test('degenerate: collinear stored points are refused below the perpendicular offset floor and accepted above it', () => {
  assertEquals(MIN_PERPENDICULAR_OFFSET_M, 0.2)
  // Exactly on a line.
  const line: Vec3[] = [0, 1, 2.5, 4].map((z) => ({ x: 0.3 * z, y: 0, z }))
  const failure = assertFailure(fitRigid2D(constellationOfFour(2), line), 'collinear')
  if (failure.reason !== 'collinear') throw new Error('unreachable')
  assertAlmostEquals(failure.offsetM, 0, 1e-12)
  assertEquals(failure.requiredOffsetM, MIN_PERPENDICULAR_OFFSET_M)
  // A visit whose taps fall on a line is a wrong visit, not a reason to refuse.
  const collapsed = assertOk(fitRigid2D(line, constellationOfFour(2)))
  assert(collapsed.rmsResidualM > 0.5)
  assertEquals(verifyFit(fitRigid2D(line, constellationOfFour(2))).status, 'mismatch')
  // L(0,0), H(0,2), C(w,1) has a best-fit line along z and a largest offset of 2w/3.
  const triangle = (offset: number): Vec3[] => [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
    { x: 1.5 * offset, y: 0, z: 1 },
  ]
  assertAlmostEquals(perpendicularOffsetM(triangle(0.37)), 0.37, 1e-12)
  const below = triangle(MIN_PERPENDICULAR_OFFSET_M - 1e-6)
  const above = triangle(MIN_PERPENDICULAR_OFFSET_M + 1e-6)
  assertFailure(fitRigid2D(below, below), 'collinear')
  assertOk(fitRigid2D(above, above))
  // A crooked line is still a line: the floor is measured from the best-fit line, not from the x axis.
  const slanted: Vec3[] = [0, 1, 2, 3].map((t) => ({ x: 2 * t, y: 0, z: -t + 0.01 * (t % 2) }))
  assert(perpendicularOffsetM(slanted) < 0.01)
  assertFailure(fitRigid2D(slanted, slanted), 'collinear')
})

Deno.test('degenerate: a mirrored observation is reported, never fitted, and a rotated one never is', () => {
  const stored = constellation(2)
  // Mirror across the baseline: x becomes -x.
  const flipped = stored.map((p) => ({ ...p, x: -p.x }))
  const failure = assertFailure(fitRigid2D(flipped, stored), 'mirrored')
  if (failure.reason !== 'mirrored') throw new Error('unreachable')
  assertEquals(failure.mirroredRmsM < failure.turnedRmsM * 0.5, true)
  assertAlmostEquals(failure.mirroredRmsM, 0, 1e-9)
  assertFailure(fitSimilarity2D(flipped, stored), 'mirrored')

  // A mirror about some other line, then moved by an arbitrary session pose, is just as mirrored.
  const pose = composeYUpTransform({ x: 8, y: 1, z: -3 }, 140)
  const reflected = stored.map((p) => transformPoint(pose, { x: p.z, y: p.y, z: p.x }))
  assertFailure(fitRigid2D(reflected, stored), 'mirrored')
  // The verdict says what that means: the check ran and the points do not agree.
  assertEquals(verifyFit(fitRigid2D(flipped, stored)).status, 'mismatch')
})

Deno.test('degenerate: shapes that no rotation relates are reported as unmatched, not given a zero or infinite scale', () => {
  // b is orthogonal to a under the complex inner product, so the correlation is exactly zero,
  // and it is not the mirror image of a, so that check does not catch it first.
  const a = [{ x: 0, z: 0 }, { x: 0, z: 2 }, { x: 3, z: 2.8 }]
  const centre = { x: 1, z: 4.8 / 3 }
  type Complex = { re: number; im: number }
  const [a1, a2, a3] = a.map((p): Complex => ({ re: p.x - centre.x, im: p.z - centre.z })) as [Complex, Complex, Complex]
  // v = -conj((a1 - a3) / (a2 - a3)), w = -1 - v, u = 1: then u + v + w = 0 and conj(a) . (u, v, w) = 0.
  const divide = (n: Complex, d: Complex): Complex => {
    const m = d.re * d.re + d.im * d.im
    return { re: (n.re * d.re + n.im * d.im) / m, im: (n.im * d.re - n.re * d.im) / m }
  }
  const q = divide({ re: a1.re - a3.re, im: a1.im - a3.im }, { re: a2.re - a3.re, im: a2.im - a3.im })
  const v = { re: -q.re, im: q.im }
  const orthogonal = [{ re: 1, im: 0 }, v, { re: -1 - v.re, im: -v.im }]
  const from = a.map((p, i) => ({ x: p.x, y: 0, z: p.z, i }))
  const to: Vec3[] = orthogonal.map((c) => ({ x: c.re, y: 0, z: c.im }))
  const inner = [a1, a2, a3].reduce((s, p, i) => ({
    re: s.re + p.re * orthogonal[i]!.re + p.im * orthogonal[i]!.im,
    im: s.im + p.re * orthogonal[i]!.im - p.im * orthogonal[i]!.re,
  }), { re: 0, im: 0 })
  assertAlmostEquals(Math.hypot(inner.re, inner.im), 0, 1e-12, 'constructed to have no correlation')

  const flat = from.map(({ x, y, z }) => ({ x, y, z }))
  for (const fit of [fitRigid2D, fitSimilarity2D]) {
    const outcome = fit(flat, to)
    assertEquals(assertFailure(outcome, 'unmatched').message, 'The points cannot be lined up with the stored ones by turning and shifting.')
    assertEquals(verifyFit(outcome).status, 'mismatch')
    assertEquals(verifyFit(outcome).reasons, ['The points cannot be lined up with the stored ones by turning and shifting.'])
  }
})

Deno.test('degenerate: checks run in a fixed order', () => {
  const nan: Vec3 = { x: Number.NaN, y: 0, z: 0 }
  // length before count, count before finiteness, finiteness before duplicates, duplicates before collinearity.
  assertFailure(fitRigid2D([nan, nan, nan], [TRIANGLE[0]!, TRIANGLE[1]!]), 'length-mismatch')
  assertFailure(fitRigid2D([nan, nan], [TRIANGLE[0]!, TRIANGLE[1]!]), 'too-few-points')
  // The reference is both doubled and on a line: the doubling is reported, not the line.
  const doubledOnLine = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }]
  assertFailure(fitRigid2D(TRIANGLE, doubledOnLine), 'duplicate-points')
  // A value that is not a number in the visit is reported before the reference is looked at.
  assertFailure(fitRigid2D([TRIANGLE[0]!, TRIANGLE[1]!, nan], doubledOnLine), 'non-finite')
})

Deno.test('fuzz: whatever goes in, a result comes out: finite numbers and a proper rotation, or a named failure', () => {
  const r = makeRng(31337)
  const junk = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, 1e300, -1e300, 0]
  const reasons = new Set<string>()
  let fits = 0
  for (let k = 0; k < 4000; k++) {
    const n = Math.floor(r.uniform() * 7)
    const make = (): Vec3[] => Array.from({ length: n }, () => {
      const coord = (): number => (r.uniform() < 0.03 ? junk[Math.floor(r.uniform() * junk.length)] as number : (r.uniform() - 0.5) * 12)
      return { x: coord(), y: coord(), z: coord() }
    })
    const from = make()
    const to = r.uniform() < 0.9 ? make() : make().slice(0, Math.max(0, n - 1))
    for (const fit of [fitRigid2D, fitSimilarity2D]) {
      const outcome = fit(from, to)
      if (!outcome.ok) {
        reasons.add(outcome.failure.reason)
        assert(outcome.failure.message.length > 0)
        assert(!/verified/i.test(outcome.failure.message))
        continue
      }
      fits++
      const { matrix, rmsResidualM, maxResidualM, scale, scaleRatio, headingDeg, headingResidualDeg: hr } = outcome.fit
      assert(matrix.length === 16 && matrix.every(Number.isFinite), 'matrix finite')
      for (const v of [rmsResidualM, maxResidualM, scale, scaleRatio, headingDeg]) assert(Number.isFinite(v))
      assert(hr === null || Number.isFinite(hr))
      assert(scale > 0 && scaleRatio > 0)
      assertAlmostEquals(blockDeterminant(matrix) / scale ** 3, 1, 1e-9, 'never a reflection')
      assert(headingDeg > -180 && headingDeg <= 180)
      assert(hr !== null && hr > -180 && hr <= 180)
    }
  }
  assert(fits > 100, `fuzz should reach the fit often enough to mean something, got ${fits}`)
  for (const reason of ['too-few-points', 'length-mismatch', 'non-finite', 'duplicate-points', 'collinear']) {
    assert(reasons.has(reason), `fuzz never produced ${reason}`)
  }
})

Deno.test('a mirrored observation is never reported for a proper one, over many geometries and noise levels', () => {
  const r = makeRng(77)
  let proper = 0
  for (let k = 0; k < 3000; k++) {
    const d = 1 + r.uniform() * 3
    const truth: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: d },
      { x: (r.uniform() * 2 - 1) * 4, y: 0, z: -1 + r.uniform() * 7 },
    ]
    if (perpendicularOffsetM(truth) < MIN_PERPENDICULAR_OFFSET_M) continue
    if (Math.min(ground(truth[2]!, truth[0]!), ground(truth[2]!, truth[1]!)) < DUPLICATE_POINT_GAP_M) continue
    proper++
    const sigma = [0.03, 0.05][k % 2]!
    const stored = simulateReference(r, truth, sigma).stored
    const visit = simulateVisit(r, truth, sigma)
    const outcome = fitRigid2D(visit.taps, stored)
    if (!outcome.ok) assert(outcome.failure.reason !== 'mirrored', 'a correct re-tap was called mirrored')
  }
  assert(proper > 1500, 'enough usable geometries')
})

// ── Heading residual ────────────────────────────────────────────────────────

Deno.test('headingResidualDeg: zero for a consistent pair, signed, and wrap-safe across +-180', () => {
  const stored: [Vec3, Vec3] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }]
  const at = (bearingDeg: number): [Vec3, Vec3] => {
    const b = (bearingDeg * Math.PI) / 180
    return [{ x: 1, y: 0, z: 1 }, { x: 1 + 2 * Math.sin(b), y: 0, z: 1 + 2 * Math.cos(b) }]
  }
  // A fit that turns by the pair's own bearing sends it onto the stored baseline.
  assertAlmostEquals(headingResidualDeg(55, at(55), stored)!, 0, 1e-9)
  // Turning 4 degrees too little leaves the carried baseline 4 degrees toward +X; too much, toward -X.
  assertAlmostEquals(headingResidualDeg(51, at(55), stored)!, 4, 1e-9)
  assertAlmostEquals(headingResidualDeg(59, at(55), stored)!, -4, 1e-9)
  // Across the wrap: a pair at 179 degrees against a fit at -179 is 2 degrees apart, not 358.
  assertAlmostEquals(headingResidualDeg(-179, at(179), stored)!, -2, 1e-9)
  assertAlmostEquals(headingResidualDeg(179, at(-179), stored)!, 2, 1e-9)
  // A stored baseline that is not along +Z is respected.
  const sideways: [Vec3, Vec3] = [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]
  assertAlmostEquals(headingResidualDeg(55 - 90, at(55), sideways)!, 0, 1e-9)
  // A reversed pair is 180 away whichever way the noise tips it, and always reads in (-180, 180].
  for (const noise of [-3, -0.5, 0, 0.5, 3]) {
    const value = headingResidualDeg(55 + 180 + noise, at(55), stored)!
    assert(value > -180 && value <= 180)
    assertAlmostEquals(Math.abs(value), 180 - Math.abs(noise) * (noise === 0 ? 0 : 1), 1e-9)
  }
  assertAlmostEquals(Math.abs(headingResidualDeg(55 + 180, at(55), stored)!), 180, 1e-9)
})

Deno.test('headingResidualDeg: null for a baseline of no length or a non-finite number, never NaN', () => {
  const ok: [Vec3, Vec3] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }]
  const zero: [Vec3, Vec3] = [{ x: 1, y: 0, z: 1 }, { x: 1, y: 5, z: 1 }]
  assertEquals(headingResidualDeg(0, zero, ok), null)
  assertEquals(headingResidualDeg(0, ok, zero), null)
  assertEquals(headingResidualDeg(Number.NaN, ok, ok), null)
  assertEquals(headingResidualDeg(0, [{ x: Number.NaN, y: 0, z: 0 }, ok[1]], ok), null)
  assertEquals(headingResidualDeg(0, ok, [ok[0], { x: 0, y: Number.POSITIVE_INFINITY, z: 2 }]), null)
})

Deno.test('a fit reports its heading residual: near zero for a good visit, near 180 for a reversed pair, with the sign of the error', () => {
  const stored = constellation(3)
  const pose = composeYUpTransform({ x: -2, y: 0.1, z: 5 }, 250)
  const visit = stored.map((p) => transformPoint(pose, p))
  assertAlmostEquals(headingOf(assertOk(fitRigid2D(visit, stored))), 0, 1e-6)

  // Tap the heading marker 15 cm to the side: the baseline tips, the check point pulls the fit back.
  const toVisit = (p: Vec3) => transformPoint(pose, p)
  const aside = [visit[0]!, toVisit({ x: 0.15, y: 0, z: 3 }), visit[2]!]
  const tipped = headingOf(assertOk(fitRigid2D(aside, stored)))
  assert(tipped > 0.5 && tipped < 4, `${tipped}`)
  // The other side tips it the other way by about as much. Not exactly: the check point sits on one side.
  const otherSide = [visit[0]!, toVisit({ x: -0.15, y: 0, z: 3 }), visit[2]!]
  const opposite = headingOf(assertOk(fitRigid2D(otherSide, stored)))
  assert(opposite < 0 && Math.abs(opposite / tipped + 1) < 0.1, `${opposite} against ${tipped}`)

  // Reversed pair: not a fit at all if it reads as a mirror, otherwise a baseline pointing the wrong way.
  const reversed = [visit[1]!, visit[0]!, visit[2]!]
  const outcome = fitRigid2D(reversed, stored)
  if (outcome.ok) assert(Math.abs(headingOf(outcome.fit)) > 150)
  else assertEquals(outcome.failure.reason, 'mirrored')
})

// ── Predicted accuracy ──────────────────────────────────────────────────────

Deno.test('frameUncertaintyAt: the heading of two points is 2 sigma / d, and more spread means less uncertainty', () => {
  const two = frameUncertaintyAt([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }], 0.05, 5)!
  assertAlmostEquals(two.headingSigmaDeg, ((2 * 0.05) / 1) * (180 / Math.PI), 1e-9)
  const long = frameUncertaintyAt([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }], 0.05, 5)!
  assertAlmostEquals(long.headingSigmaDeg, two.headingSigmaDeg / 3, 1e-9)
  assert(long.positionRmsM < two.positionRmsM)

  const three = frameUncertaintyAt(constellation(1), 0.05, 5)!
  const twoOnly = frameUncertaintyAt(constellation(1).slice(0, 2), 0.05, 5)!
  assert(three.positionRmsM < twoOnly.positionRmsM / 2, 'a far check point more than halves the error at 5 m')
  assert(three.headingSigmaDeg < twoOnly.headingSigmaDeg / 2)

  // Scales linearly with the noise (rms, heading and 95th percentile), and grows with the radius.
  const doubled = frameUncertaintyAt(constellation(1), 0.1, 5)!
  assertAlmostEquals(doubled.positionRmsM, 2 * three.positionRmsM, 1e-12)
  assertAlmostEquals(doubled.headingSigmaDeg, 2 * three.headingSigmaDeg, 1e-12)
  assertAlmostEquals(doubled.position95M, 2 * three.position95M, 1e-9)
  assert(frameUncertaintyAt(constellation(1), 0.05, 8)!.positionRmsM > three.positionRmsM)
  assert(frameUncertaintyAt(constellation(1), 0.05, 8)!.position95M > three.position95M)
  // At the centroid only the averaging of the shift remains: s * sqrt(2 / n), and it is the same on every axis.
  const centre = frameUncertaintyAt(constellation(1), 0.05, 0)!
  assertAlmostEquals(centre.positionRmsM, 0.05 * Math.SQRT2 * Math.sqrt(2 / 3), 1e-12)
  assertAlmostEquals(centre.position95M / centre.positionRmsM, Math.sqrt(-Math.log(0.05)), 1e-9)
})

/** The mass of a zero-mean Gaussian with deviations `sa` and `sb` inside a disc of radius `q`, by brute force on a fine grid. */
function massWithin(sa: number, sb: number, q: number): number {
  const cells = 1600
  const reach = 8 * Math.max(sa, sb)
  const step = (2 * reach) / cells
  let mass = 0
  for (let i = 0; i < cells; i++) {
    const x = -reach + (i + 0.5) * step
    if (Math.abs(x) >= q) continue
    // Exact in y: the share of the column inside the disc, from the error function of the normal.
    const half = Math.sqrt(q * q - x * x)
    mass += Math.exp(-(x * x) / (2 * sa * sa)) / (sa * Math.sqrt(2 * Math.PI)) * step * (2 * normalCdf(half / sb) - 1)
  }
  return mass
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26 on erf; absolute error under 1.5e-7). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592
  const erf = 1 - poly * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/**
 * The 95th percentile of the distance of a zero-mean Gaussian with independent deviations `sa` and `sb`, by the polar integral
 * on 8,000 midpoint steps and a plain bisection: far finer than the module's own, and no Newton step to share a mistake with it.
 */
function quantileByPolarIntegral(sa: number, sb: number): number {
  const steps = 8000
  const within = (q: number): number => {
    let sum = 0
    for (let k = 0; k < steps; k++) {
      const t = ((k + 0.5) * Math.PI) / (2 * steps)
      const a = Math.cos(t) ** 2 / (sa * sa) + Math.sin(t) ** 2 / (sb * sb)
      sum += (1 - Math.exp((-q * q * a) / 2)) / a
    }
    return ((2 / (Math.PI * sa * sb)) * sum * Math.PI) / (2 * steps)
  }
  let low = 0
  let high = 10 * Math.max(sa, sb)
  for (let i = 0; i < 60; i++) {
    const middle = (low + high) / 2
    if (within(middle) < 0.95) low = middle
    else high = middle
  }
  return (low + high) / 2
}

Deno.test('frameUncertaintyAt: position95M is the 95th percentile of the elongated error, by an independent integral', () => {
  const triangle = constellation(1)
  for (const [points, method] of [[triangle, 'rigid'], [triangle, 'similarity'], [constellationOfFour(1), 'rigid'], [triangle.slice(0, 2), 'rigid']] as Array<[Vec3[], FitMethod]>) {
    for (const [sigma, radius] of [[0.03, 2], [0.05, 5], [0.05, 12], [0.1, 5]]) {
      const u = frameUncertaintyAt(points, sigma, radius, method)!
      const n = points.length
      const mean = { x: points.reduce((s, p) => s + p.x, 0) / n, z: points.reduce((s, p) => s + p.z, 0) / n }
      const S = points.reduce((a, p) => a + (p.x - mean.x) ** 2 + (p.z - mean.z) ** 2, 0)
      const s2 = 2 * sigma * sigma
      const shift = s2 / n
      const lever = (s2 * radius * radius) / S
      const along = Math.sqrt(shift + (method === 'similarity' ? lever : 0))
      const sideways = Math.sqrt(shift + lever)
      assertAlmostEquals(massWithin(along, sideways, u.position95M), 0.95, 2e-4, `${n} points, ${method}, sigma ${sigma}, radius ${radius}`)
      // And to a part in a billion against the fine polar integral, which is how many digits the module's step density buys.
      const fine = quantileByPolarIntegral(along, sideways)
      assert(Math.abs(u.position95M - fine) <= 1e-9 * fine, `${n} points, ${method}, sigma ${sigma}, radius ${radius}: ${u.position95M} against ${fine}`)
      assertAlmostEquals(u.positionRmsM, Math.hypot(along, sideways), 1e-12)
    }
  }
})

Deno.test('frameUncertaintyAt: the elongated percentile sits between the one-dimensional 1.96 and the isotropic 2.45 deviations, and a similarity fit is the isotropic end', () => {
  const triangle = constellation(1)
  const rigid = frameUncertaintyAt(triangle, 0.05, 5, 'rigid')!
  const similarity = frameUncertaintyAt(triangle, 0.05, 5, 'similarity')!
  // Similarity errors along and across the radius are equal, so its percentile is the isotropic multiple of its rms.
  assertAlmostEquals(similarity.position95M / similarity.positionRmsM, Math.sqrt(-Math.log(0.05)), 1e-9)
  assert(similarity.positionRmsM > rigid.positionRmsM, 'the size is one more thing to get wrong')
  // Rigid: elongated across the radius, so the multiple of the rms is bigger than isotropic and bounded by 1.96 x the larger deviation.
  const ratio = rigid.position95M / rigid.positionRmsM
  assert(ratio > Math.sqrt(-Math.log(0.05)) + 0.1 && ratio < 1.96 * 1.0, `ratio ${ratio}`)
  // Far from the points the sideways error dominates and the multiple tends to the one-dimensional 1.96.
  const far = frameUncertaintyAt(triangle, 0.05, 400, 'rigid')!
  assertAlmostEquals(far.position95M / far.positionRmsM, 1.959964, 2e-3)
  // An extreme elongation (a radius a million times the spread) is clamped, not a NaN, and stays on the one-dimensional limit.
  const extreme = frameUncertaintyAt(triangle, 0.05, 1e6, 'rigid')!
  assert(Number.isFinite(extreme.position95M))
  assertAlmostEquals(extreme.position95M / extreme.positionRmsM, 1.959964, 1e-4)
  // An isotropic percentile would run short of this one by what the review measured: 2% at 2 m, 8% at 5 m, up to 11% at 12 m.
  const isotropicShortfall = (radius: number) => {
    const u = frameUncertaintyAt(triangle, 0.05, radius, 'rigid')!
    return 1 - (Math.sqrt(-Math.log(0.05)) * u.positionRmsM) / u.position95M
  }
  assert(isotropicShortfall(2) > 0.01 && isotropicShortfall(2) < 0.03, `${isotropicShortfall(2)}`)
  assert(isotropicShortfall(5) > 0.07 && isotropicShortfall(5) < 0.09, `${isotropicShortfall(5)}`)
  assert(isotropicShortfall(12) > 0.10 && isotropicShortfall(12) < 0.12, `${isotropicShortfall(12)}`)
  // Nothing in, nothing out: huge or tiny noise is a number or null, never NaN.
  for (const sigma of [1e-300, 1e-200, 1e200, 1e300]) {
    const u = frameUncertaintyAt(triangle, sigma, 5)
    assert(u === null || Object.values(u).every(Number.isFinite), `sigma ${sigma}`)
  }
})

Deno.test('property: the predicted 95th percentile covers 95% of simulated visit pairs, at 2, 5, 8 and 12 m, for two to six points', () => {
  // Two visits each tap the same points with noise sigma; the least-squares motion between them, applied at a spot `radius`
  // from the centroid, is how far their frames disagree there. The review simulated 600,000 pairs per cell and found an
  // isotropic prediction covering only 92 to 94.5%. The fit here is plain complex-number Procrustes, written for this test
  // and sharing nothing with the module.
  const sigma = 0.05
  const cases: Array<[string, Vec3[]]> = [
    ['two points', constellation(2).slice(0, 2)],
    ['design, 1 m baseline', constellation(1)],
    ['design, 3 m baseline', constellation(3)],
    ['four points', constellationOfFour(1)],
    ['six points', [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 4, y: 0, z: 1 }, { x: -3, y: 0, z: 2 }, { x: 1, y: 0, z: 6 }, { x: -2, y: 0, z: -3 }]],
  ]
  const r = makeRng(31415)
  const trials = 50000
  let worst = 0
  for (const [name, truth] of cases) {
    const n = truth.length
    const mean = { x: truth.reduce((s, p) => s + p.x, 0) / n, z: truth.reduce((s, p) => s + p.z, 0) / n }
    for (const radius of [2, 5, 8, 12]) {
      const predicted = frameUncertaintyAt(truth, sigma, radius)!.position95M
      let inside = 0
      for (let k = 0; k < trials; k++) {
        const noisy = () => truth.map((p) => ({ re: p.x + r.gauss() * sigma, im: p.z + r.gauss() * sigma }))
        const a = noisy()
        const b = noisy()
        const centre = (set: Array<{ re: number; im: number }>) => ({
          re: set.reduce((s, p) => s + p.re, 0) / n,
          im: set.reduce((s, p) => s + p.im, 0) / n,
        })
        const [ca, cb] = [centre(a), centre(b)]
        // Rotation u = conj(sum conj(a_i) b_i) normalised, the shift putting centre(a) on centre(b).
        let zr = 0
        let zi = 0
        for (let i = 0; i < n; i++) {
          const [pr, pi, qr, qi] = [a[i]!.re - ca.re, a[i]!.im - ca.im, b[i]!.re - cb.re, b[i]!.im - cb.im]
          zr += pr * qr + pi * qi
          zi += pr * qi - pi * qr
        }
        const norm = Math.hypot(zr, zi)
        const [ur, ui] = [zr / norm, zi / norm]
        const bearing = r.uniform() * 2 * Math.PI
        const probe = { re: mean.x + radius * Math.sin(bearing), im: mean.z + radius * Math.cos(bearing) }
        const landed = {
          re: ur * (probe.re - ca.re) - ui * (probe.im - ca.im) + cb.re,
          im: ui * (probe.re - ca.re) + ur * (probe.im - ca.im) + cb.im,
        }
        if (Math.hypot(landed.re - probe.re, landed.im - probe.im) <= predicted) inside++
      }
      const coverage = inside / trials
      worst = Math.max(worst, Math.abs(coverage - 0.95))
      report(`${name}, radius ${radius} m: coverage of the predicted 95th percentile`, pct(coverage, 2))
      assert(Math.abs(coverage - 0.95) < 0.008, `${name}, radius ${radius}: ${coverage}`)
    }
  }
  report('worst departure of the coverage from 95%', pct(worst, 2))
})

Deno.test('frameUncertaintyAt: no answer, not a NaN, when the points cannot give one', () => {
  const p = constellation(1)
  assertEquals(frameUncertaintyAt([], 0.03, 5), null)
  assertEquals(frameUncertaintyAt([p[0]!], 0.03, 5), null)
  assertEquals(frameUncertaintyAt([p[0]!, { ...p[0]! }], 0.03, 5), null)
  assertEquals(frameUncertaintyAt(p, Number.NaN, 5), null)
  assertEquals(frameUncertaintyAt(p, -0.03, 5), null)
  assertEquals(frameUncertaintyAt(p, 0.03, Number.POSITIVE_INFINITY), null)
  assertEquals(frameUncertaintyAt(p, 0.03, -1), null)
  assertEquals(frameUncertaintyAt([p[0]!, { x: 1, y: Number.NaN, z: 1 }], 0.03, 5), null)
  // Collinear points still fix a heading in 2D, so they do have an uncertainty.
  assert(frameUncertaintyAt([p[0]!, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 4 }], 0.03, 5) !== null)
})

Deno.test('frameUncertaintyAt: noise-free taps give a zero uncertainty, which is an answer', () => {
  const zero = frameUncertaintyAt(constellation(1), 0, 5)!
  assertEquals([zero.headingSigmaDeg, zero.positionRmsM, zero.position95M], [0, 0, 0])
})

// ── The verdict ─────────────────────────────────────────────────────────────

const GATE = RMS_GATE_SIGMAS * SIGMA0_M

function verdict(
  overrides: Partial<Parameters<typeof verifyConstellation>[0]> = {},
): ReturnType<typeof verifyConstellation> {
  return verifyConstellation({
    pointsUsed: 3,
    rmsResidualM: 0.04,
    maxResidualM: 0.06,
    sigmaHatM: SIGMA0_M,
    ...overrides,
  })
}

Deno.test('verdict: three points inside the gate verify, by constellation, with the limit named', () => {
  const v = verdict()
  assertEquals([v.status, v.checkedBy], ['verified', 'constellation'])
  assertEquals(v.reasons, [
    '3 points are 4.0 cm off the stored ones on average (limit 8.4 cm).',
    'The worst point is 6.0 cm off (limit 21.0 cm).',
    'Not checked: that these are the same physical spots. Compare with the photos.',
  ])
})

Deno.test('verdict: the constants are the design\'s', () => {
  assertEquals([SIGMA0_M, RMS_GATE_SIGMAS, MAX_GATE_FACTOR], [0.03, 2.8, 2.5])
  assertEquals(MAX_SIGMA_HAT_M, 0.1)
})

Deno.test('verdict: the rms gate is 2.8 sigma-hat, inclusive, and a point beyond it is a mismatch', () => {
  assertEquals(verdict({ rmsResidualM: GATE, maxResidualM: GATE }).status, 'verified')
  const over = verdict({ rmsResidualM: GATE * (1 + 1e-9), maxResidualM: GATE * (1 + 1e-9) })
  assertEquals([over.status, over.checkedBy], ['mismatch', 'constellation'])
  assertEquals(over.reasons, ['3 points are 8.4 cm off the stored ones on average (limit 8.4 cm).'])
  // The limit moves with the noise estimate and with nothing else: no baseline term anywhere.
  for (const sigma of [0.03, 0.05, 0.08]) {
    const gate = RMS_GATE_SIGMAS * sigma
    assertEquals(verdict({ sigmaHatM: sigma, rmsResidualM: gate, maxResidualM: gate }).status, 'verified')
    assertEquals(verdict({ sigmaHatM: sigma, rmsResidualM: gate * 1.001, maxResidualM: gate * 1.001 }).status, 'mismatch')
  }
})

Deno.test('verdict: sigma-hat is never below the adopted 3 cm, and a missing or bad one is 3 cm, not NaN', () => {
  assertEquals(sigmaHat(undefined), SIGMA0_M)
  assertEquals(sigmaHat(null), SIGMA0_M)
  assertEquals(sigmaHat(Number.NaN), SIGMA0_M)
  assertEquals(sigmaHat(-1), SIGMA0_M)
  assertEquals(sigmaHat(0.004), SIGMA0_M)
  assertEquals(sigmaHat(0.05), 0.05)
  assertEquals(sigmaHat(Number.POSITIVE_INFINITY), SIGMA0_M)
  // A very steady tap must not tighten the gate below what the design allows.
  assertEquals(verdict({ sigmaHatM: 0.004, rmsResidualM: 0.08, maxResidualM: 0.08 }).status, 'verified')
  assertEquals(verdict({ sigmaHatM: Number.NaN, rmsResidualM: 0.08, maxResidualM: 0.08 }).status, 'verified')
  assertEquals(verdict({ sigmaHatM: Number.NaN, rmsResidualM: 0.09, maxResidualM: 0.09 }).status, 'mismatch')
})

Deno.test('verdict: taps too unsteady to verify are provisional, but never hide a mismatch', () => {
  const unsteady = (sigmaHatM: number, residual: number, overrides: Partial<Parameters<typeof verifyConstellation>[0]> = {}) =>
    verdict({ sigmaHatM, rmsResidualM: residual, maxResidualM: residual, ...overrides })
  assertEquals(unsteady(MAX_SIGMA_HAT_M, 0).status, 'verified')
  // Inside the gate at the cap, a spread above it is provisional by constellation: the points were compared.
  for (const residual of [0, 0.05, 0.27]) {
    const v = unsteady(MAX_SIGMA_HAT_M * 1.01, residual)
    assertEquals([v.status, v.checkedBy, v.compared], ['provisional', 'constellation', 'points'], `residual ${residual}`)
    assert(v.reasons.includes('Taps vary by 10.1 cm between tries: too much to check the points.'), v.reasons.join(' | '))
    assert(v.reasons[0]!.endsWith('(limit 28.0 cm).'), `the limit shown is the one at the cap: ${v.reasons[0]}`)
  }
  // Beyond the gate at the cap it is a mismatch however unsteady the taps: the review found 0.100 giving a mismatch
  // and 0.101 hiding the same 91 cm error behind "provisional".
  for (const sigmaHatM of [0.099, 0.1, 0.101, 0.15, 1, 1e9]) {
    const v = unsteady(sigmaHatM, 0.91)
    assertEquals([v.status, v.checkedBy, v.compared], ['mismatch', 'constellation', 'points'], `sigma-hat ${sigmaHatM}`)
    assert(v.reasons.some((s) => /limit 28\.0 cm|limit 27\.7 cm/.test(s)), v.reasons.join(' | '))
    assert(!v.reasons.some((s) => /Taps vary/.test(s)), 'a mismatch is not blamed on the taps')
  }
  // The edge: a residual one hair over the gate at the cap is a mismatch at 0.101 and at 0.5; one at the gate is provisional.
  const capGate = RMS_GATE_SIGMAS * MAX_SIGMA_HAT_M
  assertEquals(unsteady(0.5, capGate * (1 + 1e-9), { maxResidualM: capGate * (1 + 1e-9) }).status, 'mismatch')
  assertEquals(unsteady(0.5, capGate).status, 'provisional')
  // Two points are the same: a spacing error beyond twice the gate at the cap is a mismatch, not a quiet "could not check".
  const pair = (sigmaHatM: number, residual: number) => verdict({ pointsUsed: 2, sigmaHatM, rmsResidualM: residual, maxResidualM: residual })
  assertEquals([pair(0.5, 0.3).status, pair(0.5, 0.3).checkedBy, pair(0.5, 0.3).compared], ['mismatch', 'separation', 'distance'])
  assertEquals(pair(0.5, 0.2).status, 'provisional')
  assert(pair(0.5, 0.2).reasons.includes('Taps vary by 50.0 cm between tries: too much to check the points.'))
  // The tolerance a two-point scan records is the one the verdict applies, cap included.
  assertAlmostEquals(twoPointToleranceM(0.5), 2 * capGate, 1e-12)
  // The height gate is held at the cap as well: the limit printed is 28.0 cm, not 2.8 times a 20 cm spread.
  const tall = unsteady(0.2, 0.05, { heightRmsResidualM: 0.05 })
  assertEquals(tall.status, 'provisional')
  assert(tall.reasons.includes('Heights are 5.0 cm off on average (limit 28.0 cm).'), tall.reasons.join(' | '))
  assert(unsteady(0.2, 0.05, { heightRmsResidualM: 0.3 }).reasons.includes('Heights are 30.0 cm off on average (limit 28.0 cm).'))
})

Deno.test('verdict: the single-point gate is 2.5 times the rms gate and only matters from seven points up', () => {
  const maxGate = MAX_GATE_FACTOR * GATE
  // One residual just over the gate on its own, the rest perfect: n points give rms = max / sqrt(n).
  const lone = (n: number, max: number) => verdict({ pointsUsed: n, rmsResidualM: max / Math.sqrt(n), maxResidualM: max })
  const seven = lone(7, maxGate * 1.001)
  assertEquals(seven.status, 'mismatch')
  assertEquals(seven.reasons.length, 1)
  assert(/worst point/.test(seven.reasons[0]!) && !/on average/.test(seven.reasons[0]!), seven.reasons[0])
  assertEquals(lone(7, maxGate).status, 'verified')
  // With six points the same single outlier has already broken the rms gate: the max gate never decides alone.
  const six = lone(6, maxGate * 1.001)
  assertEquals(six.status, 'mismatch')
  assert(/on average/.test(six.reasons[0]!))
  const r = makeRng(5)
  for (let k = 0; k < 4000; k++) {
    const n = 3 + Math.floor(r.uniform() * 4)
    const residuals = Array.from({ length: n }, () => Math.abs(r.gauss()) * 0.08 * (r.uniform() < 0.3 ? 4 : 1))
    const rms = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / n)
    const max = Math.max(...residuals)
    const v = verdict({ pointsUsed: n, rmsResidualM: rms, maxResidualM: max })
    if (max > maxGate) assert(rms > GATE, 'with at most six points the rms gate always fires first')
    assertEquals(v.status === 'verified', rms <= GATE && max <= maxGate)
  }
})

Deno.test('verdict: two points are never verified, whatever the residual or the noise estimate', () => {
  for (const residual of [0, 0.001, GATE, GATE * 2, 1]) {
    for (const sigma of [0, 0.004, 0.03, 0.05, 0.1, 1, Number.NaN]) {
      for (const units of [undefined, 'metric', 'arbitrary'] as Array<UnitsMode | undefined>) {
        const v = verdict({
          pointsUsed: 2,
          rmsResidualM: residual,
          maxResidualM: residual,
          sigmaHatM: sigma,
          unitsMode: units,
          scaleRatio: 1,
          headingResidualDeg: 0,
        })
        assert(v.status !== 'verified', `two points verified at residual ${residual}, sigma ${sigma}`)
        assertEquals(v.checkedBy, 'separation')
      }
    }
  }
  for (const n of [0, 1, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = verdict({ pointsUsed: n, rmsResidualM: 0, maxResidualM: 0 })
    assertEquals([v.status, v.checkedBy], ['provisional', 'separation'], `pointsUsed ${n}`)
  }
})

Deno.test('verdict: two points are provisional while the distance agrees and a mismatch when it does not', () => {
  const half = twoPointResidualM(3.04, 3)
  assertAlmostEquals(half, 0.02, 1e-12)
  assertEquals(twoPointResidualM(3, 3.04), half)
  const ok = verdict({ pointsUsed: 2, rmsResidualM: half, maxResidualM: half })
  assertEquals([ok.status, ok.checkedBy], ['provisional', 'separation'])
  assertEquals(ok.reasons, [
    'The two points are 4.0 cm off the stored distance (limit 16.8 cm).',
    'Direction was not checked: a third point is needed.',
    'Not checked: that these are the same physical spots. Compare with the photos.',
  ])
  // A spacing 20 cm out is beyond the 16.8 cm that 2.8 sigma-hat allows for a pair.
  const far = twoPointResidualM(3.2, 3)
  const bad = verdict({ pointsUsed: 2, rmsResidualM: far, maxResidualM: far })
  assertEquals([bad.status, bad.checkedBy], ['mismatch', 'separation'])
  assertEquals(bad.reasons, ['The two points are 20.0 cm off the stored distance (limit 16.8 cm).'])
})

Deno.test('verdict: nothing usable to compare is provisional by separation and says so', () => {
  const nothing = 'No usable measurement: nothing was compared.'
  for (const bad of [
    { rmsResidualM: Number.NaN },
    { maxResidualM: Number.NaN },
    { rmsResidualM: Number.POSITIVE_INFINITY, maxResidualM: Number.POSITIVE_INFINITY },
    { rmsResidualM: -0.01 },
    { rmsResidualM: 0.05, maxResidualM: 0.04 },
  ]) {
    const v = verdict(bad)
    assertEquals([v.status, v.checkedBy, v.reasons], ['provisional', 'separation', [nothing]])
  }
  assertEquals(verdict({ pointsUsed: 1 }).reasons, ['Only 1 point: nothing was compared.'])
  assertEquals(verdict({ pointsUsed: 0 }).reasons, ['Only 0 points: nothing was compared.'])
})

Deno.test('verdict: inside a factor of two the size, the direction and the units are reported and never decide', () => {
  const plain = verdict()
  for (const scaleRatio of [0.5, 0.6, 0.89, 1, 1.1, 1.4, 1.99, 2]) {
    for (const unitsMode of [undefined, 'metric', 'estimated-metric', 'arbitrary'] as Array<UnitsMode | undefined>) {
      for (const heading of [undefined, 0, 12, 179]) {
        assertEquals(verdict({ scaleRatio, unitsMode, headingResidualDeg: heading }).status, plain.status, `ratio ${scaleRatio}`)
        assertEquals(verdict({ scaleRatio, unitsMode, headingResidualDeg: heading, rmsResidualM: 0.2, maxResidualM: 0.2 }).status, 'mismatch')
      }
    }
  }
  assert(verdict({ scaleRatio: 1.123 }).reasons.includes('Sizes differ by 12%.'))
  assert(verdict({ scaleRatio: 0.877 }).reasons.includes('Sizes differ by 12%.'))
  assert(verdict({ scaleRatio: 1.004 }).reasons.includes('Sizes differ by less than 1%.'))
  // Rounded to the nearest percent, not cut off: 12.6% is 13%, and 0.6% is 1%.
  assert(verdict({ scaleRatio: 1.126 }).reasons.includes('Sizes differ by 13%.'))
  assert(verdict({ scaleRatio: 0.874 }).reasons.includes('Sizes differ by 13%.'))
  assert(verdict({ scaleRatio: 1.006 }).reasons.includes('Sizes differ by 1%.'))
  assert(verdict({ headingResidualDeg: -3.44 }).reasons.includes('The direction of the first two points is 3.4° off the stored direction.'))
})

Deno.test('verdict: a size more than a factor of two off fails the check, whatever a similarity fit absorbed', () => {
  assertEquals([SCALE_RATIO_SANITY.min, SCALE_RATIO_SANITY.max], [0.5, 2])
  for (const scaleRatio of [0.499, 0.2, 0.001, 2.001, 3, 40]) {
    const v = verdict({ scaleRatio })
    assertEquals([v.status, v.checkedBy], ['mismatch', 'constellation'], `ratio ${scaleRatio}`)
    assertEquals(v.reasons.length, 1)
    assert(/^Sizes differ by \d+%: too much to be the same points\.$/.test(v.reasons[0]!), v.reasons[0])
  }
  assertEquals(verdict({ scaleRatio: 3 }).reasons, ['Sizes differ by 200%: too much to be the same points.'])
  assertEquals(verdict({ scaleRatio: 0.4 }).reasons, ['Sizes differ by 60%: too much to be the same points.'])
  // Alongside a failing gate the size is one more reason, after the gate's own.
  const both = verdict({ scaleRatio: 3, rmsResidualM: 0.2, maxResidualM: 0.2 })
  assertEquals(both.reasons.length, 2)
  assert(/on average/.test(both.reasons[0]!) && /Sizes differ by 200%/.test(both.reasons[1]!))
  // A real similarity fit of absurdly small taps is caught the same way end to end.
  const stored = constellation(2)
  const tiny = stored.map((p) => ({ x: p.x * 0.01 + 5, y: p.y, z: p.z * 0.01 - 2 }))
  const fit = assertOk(fitSimilarity2D(tiny, stored))
  assert(fit.rmsResidualM < 1e-9, 'the fit itself is perfect, which is the danger')
  assertEquals(verifyFit(fitSimilarity2D(tiny, stored)).status, 'mismatch')
})

Deno.test('verdict: units say what a size comparison does not prove about metres', () => {
  const metres = (unitsMode: UnitsMode | undefined) => verdict({ unitsMode }).reasons.filter((s) => /metres/.test(s))
  assertEquals(metres('metric'), [])
  assertEquals(metres(undefined), [])
  assertEquals(metres('arbitrary'), ["Not checked: sizes in metres. This phone's units are not metres."])
  assertEquals(metres('estimated-metric'), ['Not checked: sizes in metres. The phone estimates them.'])
  // A mismatch is not a verified claim, so it carries no list of limits.
  assertEquals(verdict({ unitsMode: 'arbitrary', rmsResidualM: 0.3, maxResidualM: 0.3 }).reasons.filter((s) => /Not checked/.test(s)), [])
})

Deno.test('verdict: an unusable size or direction is named, not hidden, and does not block a pass the gates earned', () => {
  const size = verdict({ scaleRatio: Number.NaN })
  assertEquals(size.status, 'verified')
  assert(size.reasons.includes('The size of the points could not be measured.'))
  for (const bad of [0, -1, Number.POSITIVE_INFINITY]) {
    assert(verdict({ scaleRatio: bad }).reasons.includes('The size of the points could not be measured.'))
  }
  const direction = verdict({ headingResidualDeg: Number.POSITIVE_INFINITY })
  assertEquals(direction.status, 'verified')
  assert(direction.reasons.includes('The direction of the first two points could not be measured.'))
  // Not given adds nothing. null is "given, and there is no number": the verdict says it could not be measured, and a
  // pass the position earned stands. (A fit's heading residual is null when its first two taps are on one spot.)
  assertEquals(verdict({ scaleRatio: undefined, headingResidualDeg: undefined }), verdict())
  const unmeasured = verdict({ scaleRatio: null, headingResidualDeg: null, heightRmsResidualM: null })
  assertEquals(unmeasured.status, 'verified')
  for (const sentence of [
    'The size of the points could not be measured.',
    'The direction of the first two points could not be measured.',
    'The heights could not be measured.',
  ]) assert(unmeasured.reasons.includes(sentence), sentence)
})

Deno.test('verdict: a failing gate that another order of the points would pass says so, and a pass that another order also fits is not verified', () => {
  const swap = { rmsM: 0.03, swapsFirstTwo: true }
  const other = { rmsM: 0.03, swapsFirstTwo: false }
  const fail = { rmsResidualM: 0.3, maxResidualM: 0.4 }
  // The first two exchanged: named, as the last reason, after what failed.
  const swapped = verdict({ ...fail, alternativeOrder: swap })
  assertEquals([swapped.status, swapped.checkedBy], ['mismatch', 'constellation'])
  assertEquals(swapped.reasons, [
    '3 points are 30.0 cm off the stored ones on average (limit 8.4 cm).',
    'The worst point is 40.0 cm off (limit 21.0 cm).',
    'The first two points may be swapped.',
  ])
  assertEquals(verdict({ ...fail, alternativeOrder: other }).reasons.at(-1), 'The points match the stored ones if taken in another order.')
  // The other order must fit the same gate: 8.4 cm passes, a hair over does not, and nothing is said for a better order that still fails.
  assertEquals(verdict({ ...fail, alternativeOrder: { rmsM: RMS_GATE_SIGMAS * SIGMA0_M, swapsFirstTwo: true } }).reasons.at(-1), 'The first two points may be swapped.')
  assert(!verdict({ ...fail, alternativeOrder: { rmsM: RMS_GATE_SIGMAS * SIGMA0_M * 1.001, swapsFirstTwo: true } }).reasons.some((s) => /swapped|another order/.test(s)))
  assert(!verdict({ ...fail, alternativeOrder: { rmsM: Number.NaN, swapsFirstTwo: true } }).reasons.some((s) => /swapped|another order/.test(s)))
  assert(!verdict({ ...fail, alternativeOrder: null }).reasons.some((s) => /swapped|another order/.test(s)))
  // The gate moves with the noise estimate: at 5 cm the 12 cm order passes.
  assert(verdict({ ...fail, sigmaHatM: 0.05, alternativeOrder: { rmsM: 0.12, swapsFirstTwo: true } }).reasons.includes('The first two points may be swapped.'))

  // A pass that another order fits as well cannot say which order was tapped: provisional, and it says why.
  for (const alternative of [swap, other]) {
    const v = verdict({ alternativeOrder: alternative })
    assertEquals([v.status, v.checkedBy, v.compared], ['provisional', 'constellation', 'points'])
    assert(v.reasons.includes('The points also fit in another order, so the order they were tapped in is not checked.'), v.reasons.join(' | '))
    assert(v.reasons.includes('Not checked: that these are the same physical spots. Compare with the photos.'))
  }
  // A pass whose other orders all fit worse than the gate is verified, whatever those orders are.
  assertEquals(verdict({ alternativeOrder: { rmsM: 0.5, swapsFirstTwo: false } }).status, 'verified')
  assertEquals(verdict({ alternativeOrder: null }).status, 'verified')
  // Two points have no other order to check, passing or failing, and a heading from two points is zero by construction
  // and is not reported.
  const naming = /swapped|another order|direction of the first two/
  assertEquals(verdict({ pointsUsed: 2, alternativeOrder: swap, headingResidualDeg: 0 }).reasons.some((s) => naming.test(s)), false)
  assertEquals(verdict({ pointsUsed: 2, ...fail, alternativeOrder: swap, headingResidualDeg: 0 }).reasons.some((s) => naming.test(s)), false)
})

Deno.test('verdict: nothing it says claims more than was measured, and the three fields agree with each other', () => {
  const r = makeRng(3)
  const seen = new Set<string>()
  for (let k = 0; k < 4000; k++) {
    const v = verifyConstellation({
      pointsUsed: Math.floor(r.uniform() * 9) - 1,
      rmsResidualM: r.uniform() < 0.05 ? Number.NaN : r.uniform() * 0.3,
      maxResidualM: r.uniform() * 0.5,
      sigmaHatM: r.uniform() < 0.1 ? Number.NaN : r.uniform() * 0.15,
      scaleRatio: r.uniform() < 0.5 ? undefined : 0.6 + r.uniform(),
      headingResidualDeg: r.uniform() < 0.5 ? undefined : (r.uniform() - 0.5) * 360,
      unitsMode: (['metric', 'estimated-metric', 'arbitrary', undefined] as const)[Math.floor(r.uniform() * 4)],
      fitMethod: (['rigid', 'similarity', undefined] as const)[Math.floor(r.uniform() * 3)],
      heightRmsResidualM: r.uniform() < 0.4 ? undefined : r.uniform() < 0.1 ? Number.NaN : r.uniform() * 0.2,
      alternativeOrder: r.uniform() < 0.4 ? null : { rmsM: r.uniform() * 0.4, swapsFirstTwo: r.uniform() < 0.5 },
      expectedErrorM: r.uniform() < 0.4 ? undefined : r.uniform() * 0.6,
    })
    assert(v.reasons.length > 0 && v.reasons.every((s) => s.length > 0), 'every verdict explains itself')
    for (const sentence of v.reasons) {
      assert(!/verified|aligned|same spot\b/i.test(sentence), `a reason claims too much: ${sentence}`)
      assert(!/NaN|undefined|Infinity|null/.test(sentence), `a reason leaks a bad number: ${sentence}`)
    }
    seen.add(`${v.status}/${v.checkedBy}/${v.compared}`)
    // What "verified" is: three or more points compared by constellation, with the limit named.
    if (v.status === 'verified') {
      assertEquals([v.checkedBy, v.compared], ['constellation', 'points'])
      assert(v.reasons.some((s) => /Not checked: that these are the same physical spots/.test(s)), 'a pass names its limit')
    }
    // Which tier checked, and what it compared, cannot disagree.
    assertEquals(v.checkedBy === 'constellation', v.compared === 'points', `${v.status}/${v.checkedBy}/${v.compared}`)
    if (v.compared === 'nothing') {
      assertEquals([v.status, v.checkedBy], ['provisional', 'separation'])
      assert(/nothing was compared/.test(v.reasons[0]!))
    }
    if (v.compared === 'distance') assertEquals(v.checkedBy, 'separation')
    // A mismatch carries no list of limits, and a pass that was not verified names what withheld it.
    if (v.status === 'mismatch') assert(!v.reasons.some((s) => /^Not checked/.test(s)))
    if (v.status === 'provisional' && v.compared === 'points') {
      assert(v.reasons.some((s) => /Taps vary|too little to check|also fit in another order|Estimate:|Heights are/.test(s)), v.reasons.join(' | '))
    }
  }
  // The random inputs reach every kind of verdict.
  for (const kind of [
    'verified/constellation/points',
    'provisional/constellation/points',
    'mismatch/constellation/points',
    'provisional/separation/distance',
    'mismatch/separation/distance',
    'provisional/separation/nothing',
  ]) assert(seen.has(kind), `never produced ${kind}`)
})

Deno.test('verdict types: a verified verdict can only be by constellation, so a forged one does not compile (ADR 0005 rule 3)', () => {
  // @ts-expect-error a two-point check cannot be verified: the type says so
  const forged: ConstellationVerdict = { status: 'verified', checkedBy: 'separation', compared: 'distance', reasons: [] }
  // @ts-expect-error a verified verdict compared points, not a distance
  const alsoForged: ConstellationVerdict = { status: 'verified', checkedBy: 'constellation', compared: 'distance', reasons: [] }
  // @ts-expect-error nor can a verified verdict be credited to separation when it says it compared points
  const stillForged: ConstellationVerdict = { status: 'verified', checkedBy: 'separation', compared: 'points', reasons: [] }
  assertEquals([forged.status, alsoForged.status, stillForged.status], ['verified', 'verified', 'verified'])
  const fine: ConstellationVerdict = { status: 'provisional', checkedBy: 'separation', compared: 'distance', reasons: ['x'] }
  assertEquals(fine.status, 'provisional')
})

Deno.test('verifyFit: a fit is judged on its own residuals; every failure is a verdict, and none is verified', () => {
  const stored = constellation(2)
  const pose = composeYUpTransform({ x: 4, y: 0.3, z: -2 }, 99)
  const visit = stored.map((p) => transformPoint(pose, p))
  const exact = verifyFit(fitRigid2D(visit, stored))
  assertEquals([exact.status, exact.checkedBy, exact.compared], ['verified', 'constellation', 'points'])
  assert(exact.reasons.includes('Sizes differ by less than 1%.'))
  assert(exact.reasons.some((s) => /first two points is 0\.0°/.test(s)))
  assert(exact.reasons.includes('Heights are 0.0 cm off on average (limit 8.4 cm).'))

  // The same fit with a noise estimate that is too small for the visit is a mismatch.
  const off = visit.map((t, i) => (i === 2 ? transformPoint(pose, { x: 3.25, y: 0, z: 2.8 }) : t))
  assertEquals(verifyFit(fitRigid2D(off, stored)).status, 'mismatch')
  assertEquals(verifyFit(fitRigid2D(off, stored), { sigmaHatM: 0.05 }).status, 'verified')
  assertEquals(verifyFit(fitRigid2D(visit, stored), { unitsMode: 'arbitrary' }).reasons.filter((s) => /metres/.test(s)).length, 1)

  const swappedFirstTwo = fitRigid2D([visit[1]!, visit[0]!, visit[2]!], stored)
  const cases: Array<[string, FitOutcome, 'provisional' | 'mismatch']> = [
    ['too-few-points', fitRigid2D(visit.slice(0, 2), stored.slice(0, 2)), 'provisional'],
    ['too-many-points', fitRigid2D(Array.from({ length: MAX_FIT_POINTS + 1 }, (_, i) => ({ x: i, y: 0, z: i * i })), Array.from({ length: MAX_FIT_POINTS + 1 }, (_, i) => ({ x: i, y: 0, z: i * i }))), 'provisional'],
    ['length-mismatch', fitRigid2D(visit, stored.slice(0, 2)), 'provisional'],
    ['non-finite', fitRigid2D([{ x: Number.NaN, y: 0, z: 0 }, visit[1]!, visit[2]!], stored), 'provisional'],
    ['duplicate-points', fitRigid2D(visit, [stored[0]!, stored[0]!, stored[2]!]), 'provisional'],
    ['collinear', fitRigid2D([0, 1, 2].map((z) => ({ x: 0, y: 0, z })), [0, 1, 2].map((z) => ({ x: 0, y: 0, z }))), 'provisional'],
    ['mirrored', fitRigid2D(stored.map((p) => ({ ...p, x: -p.x })), stored), 'mismatch'],
  ]
  // What the person is shown for each refusal, word for word.
  const sentences: Record<string, string> = {
    'too-few-points': 'Only 2 points: at least 3 are needed to check direction. The distance between the two was not compared here.',
    'too-many-points': '9 points: at most 8 can be compared.',
    'length-mismatch': '3 points this visit but 2 stored: nothing was compared.',
    'non-finite': 'A point has no usable position: nothing was compared.',
    'duplicate-points': 'Two stored points are only 0.0 cm apart: they count as one spot.',
    collinear: 'The stored points lie almost on one line, so which side of it the points are on cannot be checked.',
    mirrored: 'The points only match the stored ones when flipped over: one may be on the wrong side.',
  }
  for (const [reason, outcome, status] of cases) {
    assertFailure(outcome, reason as FitFailure['reason'])
    const v = verifyFit(outcome)
    assertEquals(v.reasons[0], sentences[reason], reason)
    assertEquals(v.status, status, reason)
    assertEquals(v.checkedBy, status === 'mismatch' ? 'constellation' : 'separation', reason)
    // A refusal compared nothing, and says so; a mismatch is a comparison that ran.
    assertEquals(v.compared, status === 'mismatch' ? 'points' : 'nothing', reason)
    assert(v.reasons.length > 0 && v.reasons[0]!.length > 0)
    if (status === 'provisional') assert(v.reasons.includes('Not checked: that these are the same physical spots. Compare with the photos.'))
  }
  // Two points are not a fit, and this door says that they were not compared: the distance has its own.
  const pair = verifyFit(fitRigid2D(visit.slice(0, 2), stored.slice(0, 2)))
  assert(pair.reasons[0]!.endsWith('The distance between the two was not compared here.'), pair.reasons[0])
  assert(!verifyFit(fitRigid2D(visit.slice(0, 1), stored.slice(0, 1))).reasons[0]!.includes('The distance between the two'))
  // A mirrored visit that another order of the points explains says so in place of the vague "wrong side".
  assertFailure(swappedFirstTwo, 'mirrored')
  assertEquals(verifyFit(swappedFirstTwo).reasons, ['The first two points may be swapped.'])
  assertEquals(verifyFit(fitRigid2D(stored.map((p) => ({ ...p, x: -p.x })), stored)).reasons, [
    'The points only match the stored ones when flipped over: one may be on the wrong side.',
  ])
})

// ── 3. Property tests: the design's acceptance numbers ──────────────────────

const SIGMAS = [0.03, 0.05]
const BASELINES = [1, 2, 3]

/** The product's accuracy target for relative error inside an Area (docs/product/PLACE_SCAN_DESIGN.md): under 0.305 m. */
const TARGET_M = 0.305

interface Disagreement {
  today: number[]
  fit: number[]
  verdicts: ReturnType<typeof verifyFit>[]
  failures: number
  /** Visits the fit called verified although they misplaced the probe by more than the target. */
  consequentialAccepts: number
  /** Visits today's check (separation within DEFAULT_SEPARATION_TOLERANCE_M) would have passed. */
  separationPasses: number
  /** Visits whose fit passes every gate (position, worst point, heights) at sigma-hat, whatever else withholds "verified". */
  gatesPass: number
  /** Visits whose fit has its rms residual within the horizontal gate alone. */
  horizontalPass: number
}

/** Every gate a fit is held to, at sigma-hat: what a verdict compares before it looks at anything else. */
function gatesPass(fit: FrameFit, sigmaHatM: number): boolean {
  const gate = RMS_GATE_SIGMAS * sigmaHatM
  return fit.rmsResidualM <= gate && fit.maxResidualM <= MAX_GATE_FACTOR * gate && fit.heightRmsResidualM <= HEIGHT_GATE_SIGMAS * sigmaHatM
}

/**
 * Two visits of one Place: how far apart do they put a spot 5 m away, and what does the
 * verdict say. `today` uses the real two-point frame; `fit` the least-squares fit.
 */
function compareVisits(
  seed: number,
  trials: number,
  truth: readonly Vec3[],
  sigma: number,
  options: VisitOptions & { similarity?: boolean; sigmaHat?: number; unitsMode?: UnitsMode } = {},
): Disagreement {
  const r = makeRng(seed)
  const out: Disagreement = {
    today: [],
    fit: [],
    verdicts: [],
    failures: 0,
    consequentialAccepts: 0,
    separationPasses: 0,
    gatesPass: 0,
    horizontalPass: 0,
  }
  for (let k = 0; k < trials; k++) {
    const reference = simulateReference(r, truth, sigma, options)
    const visit = simulateVisit(r, truth, sigma, options)
    const wanted = reference.positionOf(PROBE)
    const probe = visit.toSession(PROBE)
    out.today.push(ground(transformPoint(twoPointToProjectTransform(visit.taps[0]!, visit.taps[1]!), probe), wanted))
    const storedSeparation = twoPointSeparationM(reference.stored[0]!, reference.stored[1]!)
    if (Math.abs(twoPointSeparationM(visit.taps[0]!, visit.taps[1]!) - storedSeparation) <= DEFAULT_SEPARATION_TOLERANCE_M) {
      out.separationPasses++
    }
    const outcome = options.similarity ? fitSimilarity2D(visit.taps, reference.stored) : fitRigid2D(visit.taps, reference.stored)
    const verdict = verifyFit(outcome, { sigmaHatM: options.sigmaHat ?? sigma, unitsMode: options.unitsMode })
    out.verdicts.push(verdict)
    if (outcome.ok) {
      const error = ground(transformPoint(outcome.fit.matrix, probe), wanted)
      const gateSigma = options.sigmaHat ?? sigma
      if (gatesPass(outcome.fit, gateSigma)) out.gatesPass++
      if (outcome.fit.rmsResidualM <= RMS_GATE_SIGMAS * gateSigma) out.horizontalPass++
      out.fit.push(error)
      if (verdict.status === 'verified' && error > TARGET_M) out.consequentialAccepts++
    } else {
      out.failures++
    }
  }
  return out
}

function rate(verdicts: Disagreement['verdicts'], status: 'verified' | 'provisional' | 'mismatch'): number {
  return verdicts.filter((v) => v.status === status).length / verdicts.length
}

Deno.test('property: three points hold the 5 m disagreement to 20 cm at 5 cm noise, 1 m baseline (two points: ~94 cm)', () => {
  const o = compareVisits(20261116, 20000, constellation(1), 0.05)
  assertEquals(o.failures, 0)
  const today = percentile(o.today, 0.95)
  const fit = percentile(o.fit, 0.95)
  report('sigma 5 cm, 1 m baseline, p95 at 5 m: two points (today) / three points', `${(100 * today).toFixed(0)} / ${(100 * fit).toFixed(0)} cm`)
  assert(fit <= 0.2, `three-point p95 ${fit}`)
  assert(today > 0.8 && today < 1.1, `two-point p95 should be about 94 cm, got ${today}`)
})

Deno.test('property: three points stay within 20 cm at every noise and baseline, 4-5x better than two at 1 m, 2x at 3 m', () => {
  let seed = 100
  for (const sigma of SIGMAS) {
    const ratios: number[] = []
    for (const d of BASELINES) {
      const o = compareVisits(seed++, 10000, constellation(d), sigma)
      const today = percentile(o.today, 0.95)
      const fit = percentile(o.fit, 0.95)
      report(`sigma ${sigma}, baseline ${d} m, median/p95 at 5 m, today`, `${cm(percentile(o.today, 0.5))} / ${cm(today)} cm`)
      report(`sigma ${sigma}, baseline ${d} m, median/p95 at 5 m, three points`, `${cm(percentile(o.fit, 0.5))} / ${cm(fit)} cm`)
      assert(fit <= 0.2, `sigma ${sigma} d ${d}: p95 ${fit}`)
      ratios.push(today / fit)
    }
    assert(ratios[0]! >= 4, `sigma ${sigma}: at 1 m the gain is ${ratios[0]}`)
    assert(ratios[2]! >= 1.8 && ratios[2]! <= 3, `sigma ${sigma}: at 3 m the gain is ${ratios[2]}`)
  }
})

Deno.test('property: a fourth point helps further', () => {
  const three = compareVisits(301, 10000, constellation(1), 0.05)
  const four = compareVisits(301, 10000, constellationOfFour(1), 0.05)
  const [p3, p4] = [percentile(three.fit, 0.95), percentile(four.fit, 0.95)]
  report('sigma 5 cm, 1 m baseline, p95 at 5 m: three / four points', `${(100 * p3).toFixed(0)} / ${(100 * p4).toFixed(0)} cm`)
  assert(p4 < p3, `four points ${p4} should beat three ${p3}`)
})

Deno.test('property: frameUncertaintyAt predicts the simulated disagreement', () => {
  const sigma = 0.05
  const truth = constellation(1)
  const o = compareVisits(777, 20000, truth, sigma)
  const centroid = { x: (0 + 0 + 3) / 3, y: 0, z: (0 + 1 + 2.8) / 3 }
  const radius = ground(PROBE, centroid)
  const predicted = frameUncertaintyAt(truth, sigma, radius)!
  const simulated = percentile(o.fit, 0.95)
  report('three points at 5 cm: predicted p95 / simulated p95', `${(100 * predicted.position95M).toFixed(1)} / ${(100 * simulated).toFixed(1)} cm`)
  assert(Math.abs(predicted.position95M / simulated - 1) < 0.04, `predicted ${predicted.position95M} vs simulated ${simulated}`)
  // Two points: today's landmark-anchored frame has one more error term, along the baseline, which is small at 5 m.
  const two = frameUncertaintyAt(truth.slice(0, 2), sigma, ground(PROBE, { x: 0, y: 0, z: 0.5 }))!
  const today = percentile(o.today, 0.95)
  report('two points at 5 cm: predicted p95 / simulated (today) p95', `${(100 * two.position95M).toFixed(1)} / ${(100 * today).toFixed(1)} cm`)
  assert(Math.abs(two.position95M / today - 1) < 0.04, `predicted ${two.position95M} vs today ${today}`)
})

Deno.test('property: correct re-taps of the design shapes verify at least 98% of the time at the 2.8 sigma gate', () => {
  let seed = 400
  for (const sigma of SIGMAS) {
    for (const d of BASELINES) {
      for (const truth of [constellation(d), constellationOfFour(d)]) {
        const o = compareVisits(seed++, 6000, truth, sigma)
        const verified = rate(o.verdicts, 'verified')
        report(`correct re-taps verified, sigma ${sigma}, baseline ${d} m, ${truth.length} points`, `${(100 * verified).toFixed(1)}%`)
        assert(verified >= 0.98, `sigma ${sigma} d ${d} n ${truth.length}: ${verified}`)
      }
    }
  }
})

Deno.test('property: whatever the shape, correct re-taps pass the gates 98%+; the shape decides only whether the pass can be called verified', () => {
  // The statistic is chi-square, not geometry, so the gates pass a correct re-tap about 99% of the time for any shape. What a
  // shape changes is the accuracy it predicts at the working radius: below the product target a pass is verified, beyond it
  // the pass is provisional, which is the review's finding that a compact shape verified while placing far spots badly.
  // Geometries sit a margin (two taps' noise) clear of the floors: right at a floor, noise alone decides whether the stored
  // points count as one spot or one line, which is the floor doing its job.
  const r = makeRng(555)
  const sigma = 0.05
  const roomy = { visits: 0, verified: 0 }
  const cramped = { visits: 0, verified: 0, provisional: 0 }
  for (let k = 0; k < 600; k++) {
    const truth: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 + r.uniform() * 3 },
      { x: (r.uniform() * 2 - 1) * 4, y: 0, z: -1 + r.uniform() * 7 },
    ]
    if (perpendicularOffsetM(truth) < MIN_PERPENDICULAR_OFFSET_M + 0.1) continue
    if (Math.min(ground(truth[2]!, truth[0]!), ground(truth[2]!, truth[1]!)) < DUPLICATE_POINT_GAP_M + 0.15) continue
    const predicted = frameUncertaintyAt(truth, sigma, WORKING_RADIUS_M)!.position95M
    const o = compareVisits(600 + k, 300, truth, sigma)
    // The gates alone are shape-free: a visit is never a mismatch more than a few percent of the time.
    assert(rate(o.verdicts, 'mismatch') < 0.05, `geometry ${k}: ${rate(o.verdicts, 'mismatch')} mismatches`)
    if (predicted <= 0.9 * ACCURACY_TARGET_M) {
      roomy.visits += o.verdicts.length
      roomy.verified += o.verdicts.filter((v) => v.status === 'verified').length
    } else if (predicted >= 1.15 * ACCURACY_TARGET_M) {
      cramped.visits += o.verdicts.length
      cramped.verified += o.verdicts.filter((v) => v.status === 'verified').length
      cramped.provisional += o.verdicts.filter((v) => v.status === 'provisional').length
    }
  }
  report('roomy shapes (predicted p95 within 90% of the target), correct re-taps verified', `${pct(roomy.verified / roomy.visits)} of ${roomy.visits}`)
  report('cramped shapes (predicted p95 beyond 115% of the target): verified / provisional', `${pct(cramped.verified / cramped.visits)} / ${pct(cramped.provisional / cramped.visits)} of ${cramped.visits}`)
  assert(roomy.visits > 5000 && cramped.visits > 5000, 'enough of both kinds of shape')
  // About 98.3% over 20 seeds (97.9 to 98.7): 99% pass the position gates, and the height gate and the order check take a
  // few tenths of a percent each from shapes whose other orders nearly fit.
  assert(roomy.verified / roomy.visits >= 0.975, `${roomy.verified / roomy.visits}`)
  assertEquals(cramped.verified, 0, 'a shape that predicts more than the target error is never verified')
  assert(cramped.provisional / cramped.visits >= 0.98, `the pass is provisional: ${cramped.provisional / cramped.visits}`)
})

Deno.test('property: the rms of correct re-taps has its 99th percentile at about 2.75 sigma, which is why the gate is 2.8', () => {
  for (const sigma of SIGMAS) {
    const r = makeRng(900 + Math.round(sigma * 100))
    const rms: number[] = []
    for (let k = 0; k < 40000; k++) {
      const reference = simulateReference(r, constellation(2), sigma)
      rms.push(assertOk(fitRigid2D(simulateVisit(r, constellation(2), sigma).taps, reference.stored)).rmsResidualM)
    }
    const p99 = percentile(rms, 0.99) / sigma
    report(`p99 of rms residual, sigma ${sigma}`, `${p99.toFixed(2)} sigma`)
    assert(p99 > 2.6 && p99 < 2.8, `p99 is ${p99} sigma`)
  }
})

Deno.test('KNOWN LIMIT: with sigma-hat below the true noise (3 cm against 5 cm) a third of correct re-taps fail', () => {
  const o = compareVisits(1001, 10000, constellation(2), 0.05, { sigmaHat: SIGMA0_M })
  const verified = rate(o.verdicts, 'verified')
  report('correct re-taps verified with sigma-hat 3 cm and true noise 5 cm', `${(100 * verified).toFixed(1)}%`)
  // The position gate alone passes 76% (chi-square: 2.8 x 3 cm against taps 5 cm off); the height gate, held to the same 3 cm,
  // takes a further 12% of those, which is why the first build's "three in four" is now two in three.
  assert(verified < 0.75 && verified > 0.6, `${verified}`)
  assert(o.horizontalPass / o.verdicts.length > 0.74 && o.horizontalPass / o.verdicts.length < 0.78, `${o.horizontalPass / o.verdicts.length}`)
  const matched = compareVisits(1001, 10000, constellation(2), 0.05, { sigmaHat: 0.05 })
  assert(rate(matched.verdicts, 'verified') >= 0.98)
})

interface Fault {
  id: string
  name: string
  /** Where the user really taps for point `i`, given the true point and the baseline length. */
  aim: (d: number) => (i: number, truth: Vec3) => Vec3
}

const FAULTS: Fault[] = [
  { id: 'sideways', name: 'heading marker tapped 0.5 m sideways', aim: () => (i, p) => (i === 1 ? { ...p, x: p.x + 0.5 } : p) },
  {
    id: 'turn',
    name: 'pair turned 20 degrees about the landmark',
    aim: (d) => (i, p) => (i === 1 ? { x: d * Math.sin((20 * Math.PI) / 180), y: p.y, z: d * Math.cos((20 * Math.PI) / 180) } : p),
  },
  {
    id: 'reversed',
    name: 'reversed pair',
    aim: (d) => (i, p) => (i === 0 ? { x: 0, y: 0, z: d } : i === 1 ? { x: 0, y: 0, z: 0 } : p),
  },
  { id: 'wrong-feature', name: 'check point on the wrong feature, 1 m off', aim: () => (i, p) => (i === 2 ? { ...p, x: p.x + 1 } : p) },
]

interface FaultCell {
  key: string
  fault: Fault
  sigma: number
  d: number
  /** Share of visits the verdict called a mismatch. */
  rejected: number
  /** Share of visits the verdict called verified: the false accepts. */
  verified: number
  /** Share of visits the verdict withheld "verified" from without a mismatch (heights, order or shape): well under 1%. */
  withheld: number
  /** Share of visits the fit verified that misplaced the probe by more than the target. */
  consequential: number
  /** Share of visits today's separation check would have passed. */
  todayPasses: number
}

let faultCells: FaultCell[] | null = null

/** Every fault at every noise and baseline, simulated once and shared by the tests below. */
function faultTable(): FaultCell[] {
  if (faultCells) return faultCells
  const cells: FaultCell[] = []
  let seed = 2000
  for (const sigma of SIGMAS) {
    for (const d of BASELINES) {
      for (const fault of FAULTS) {
        const trials = 4000
        const o = compareVisits(seed++, trials, constellation(d), sigma, { fault: fault.aim(d) })
        const cell = {
          key: `${fault.id}|${sigma}|${d}`,
          fault,
          sigma,
          d,
          rejected: rate(o.verdicts, 'mismatch'),
          verified: rate(o.verdicts, 'verified'),
          withheld: rate(o.verdicts, 'provisional'),
          consequential: o.consequentialAccepts / trials,
          todayPasses: o.separationPasses / trials,
        }
        report(
          `${fault.name}, sigma ${sigma}, baseline ${d} m: rejected / accepted but over 30.5 cm at 5 m / passes today's separation check`,
          `${(100 * cell.rejected).toFixed(1)}% / ${(100 * cell.consequential).toFixed(2)}% / ${(100 * cell.todayPasses).toFixed(0)}%`,
        )
        cells.push(cell)
        // A fault is a mismatch the person sees. A visit that passes the position gates by luck is withheld from
        // "verified" now and then (an odd height, an order that fits as well), never a quiet "could not check" in bulk.
        assert(cell.withheld < 0.002, `${cell.key}: ${cell.withheld} of the visits were withheld`)
        assertAlmostEquals(cell.verified + cell.rejected + cell.withheld, 1, 1e-9, cell.key)
      }
    }
  }
  faultCells = cells
  return cells
}

/**
 * The two cells of the design's "rejected at least 99%" claim that do not reproduce, both
 * at 5 cm noise. Everything else in the table does, and the same cells at 3 cm noise do.
 */
const FAULT_LIMITS = new Set(['turn|0.05|1', 'sideways|0.05|3'])

Deno.test('property: sideways, turned, reversed and wrong-feature taps are rejected 99%+ where the design claims it', () => {
  const table = faultTable()
  assertEquals(table.length, 24)
  for (const cell of table) {
    if (FAULT_LIMITS.has(cell.key)) continue
    assert(cell.rejected >= 0.99, `${cell.fault.name}, sigma ${cell.sigma}, baseline ${cell.d} m: rejected ${cell.rejected}`)
  }
  // The design's own simulation geometry, 2 m, holds for every fault at both noise levels.
  for (const cell of table.filter((c) => c.d === 2)) assert(cell.rejected >= 0.99, cell.key)
})

Deno.test('KNOWN LIMIT: at 5 cm noise a 20 degree turn of a 1 m pair is rejected 4 times in 5, a 0.5 m sideways marker on 3 m 98%', () => {
  const byKey = new Map(faultTable().map((c) => [c.key, c]))
  const turned = byKey.get('turn|0.05|1')!
  report('20 degree turn, 1 m baseline, 5 cm noise: rejected (design says at least 99%)', `${(100 * turned.rejected).toFixed(1)}%`)
  assert(turned.rejected > 0.6 && turned.rejected < 0.9, `${turned.rejected}`)
  const sideways = byKey.get('sideways|0.05|3')!
  report('0.5 m sideways, 3 m baseline, 5 cm noise: rejected (design says at least 99%)', `${(100 * sideways.rejected).toFixed(1)}%`)
  assert(sideways.rejected > 0.95 && sideways.rejected < 0.99, `${sideways.rejected}`)
  // The same two faults at 3 cm noise are caught every time: what is missing is signal against noise.
  assert(byKey.get('turn|0.03|1')!.rejected >= 0.99 && byKey.get('sideways|0.03|3')!.rejected >= 0.99)
})

Deno.test('KNOWN LIMIT: with the check point fixed, a longer baseline weakens the check on a sideways marker (5 cm noise)', () => {
  // The same 0.5 m sideways heading marker as above, on baselines past the table's 3 m. The check point
  // stays 3.0 m to the side and 2.8 m along, so it no longer sits beyond the heading marker.
  const sideways = FAULTS.find((f) => f.id === 'sideways')!
  const rejected: number[] = []
  const consequential: number[] = []
  for (const d of [3, 4, 5]) {
    const o = compareVisits(9000 + d, 8000, constellation(d), 0.05, { fault: sideways.aim(d) })
    rejected.push(rate(o.verdicts, 'mismatch'))
    consequential.push(o.consequentialAccepts / o.verdicts.length)
    report(`0.5 m sideways, 5 cm noise, baseline ${d} m: rejected / accepted but over 30.5 cm at 5 m`, `${pct(rejected.at(-1)!)} / ${pct(consequential.at(-1)!, 2)}`)
  }
  assert(rejected[0]! > rejected[1]! && rejected[1]! > rejected[2]!, `detection should fall with baseline: ${rejected}`)
  assert(rejected[1]! > 0.9 && rejected[1]! < 0.98, `4 m: ${rejected[1]}`)
  assert(rejected[2]! > 0.78 && rejected[2]! < 0.9, `5 m: ${rejected[2]}`)
  assert(consequential[2]! > 0.01, 'at 5 m a consequential fault is accepted more than 1% of the time')
})

Deno.test('property: a fault that would put a spot 5 m away off by over the 0.305 m target is accepted under 1% of the time', () => {
  let worst = 0
  for (const cell of faultTable()) {
    worst = Math.max(worst, cell.consequential)
    assert(cell.consequential < 0.01, `${cell.key}: ${cell.consequential}`)
  }
  report('worst share of visits accepted although the probe is off by more than the target', `${(100 * worst).toFixed(2)}%`)
})

Deno.test('property: a 0.5 m sideways marker passes today\'s distance check mostly; the fit accepts it under 1% up to 2 m', () => {
  for (const cell of faultTable().filter((c) => c.fault.id === 'sideways')) {
    // Distance cannot see a marker moved across the baseline: today's check passes most of them.
    if (cell.d === 2) assert(cell.todayPasses > 0.75 && cell.todayPasses < 0.97, `${cell.key}: today passes ${cell.todayPasses}`)
    if (cell.d <= 2) assert(cell.verified < 0.01, `${cell.key}: accepted ${cell.verified}`)
  }
  // At 5 cm and 3 m the design's "under 1% false-accept" is 1.7% here.
  const far = faultTable().find((c) => c.key === 'sideways|0.05|3')!
  report('0.5 m sideways, 3 m baseline, 5 cm noise: accepted as verified (design says under 1%)', `${(100 * far.verified).toFixed(1)}%`)
  assert(far.verified > 0.01)
})

Deno.test('KNOWN LIMIT: a rigid shift of all the points is not detected, and misplaces a spot 5 m away by about the shift', () => {
  const sigma = 0.03
  const shift = (_d: number) => (_i: number, p: Vec3): Vec3 => ({ x: p.x + 0.4, y: p.y, z: p.z + 0.3 })
  const o = compareVisits(3001, 10000, constellation(2), sigma, { fault: shift(2) })
  const verified = rate(o.verdicts, 'verified')
  const error = percentile(o.fit, 0.5)
  report('all taps shifted 0.5 m: verified / median error at 5 m', `${(100 * verified).toFixed(1)}% / ${(100 * error).toFixed(0)} cm`)
  assert(verified >= 0.98, `a shift of every tap should look like a correct visit, verified ${verified}`)
  assert(error > 0.4 && error < 0.6, `and it misplaces the probe by about the shift, got ${error}`)
  // Today's two-point check is blind to it as well; neither can see it, only photos or a tag can.
  const separation = compareVisits(3001, 10000, constellation(2), sigma, { fault: shift(2) }).today
  assert(percentile(separation, 0.5) > 0.4)
})

Deno.test('property: a two-point visit is never verified, and its sigma-scaled distance gate does not depend on the baseline', () => {
  let seed = 4000
  for (const sigma of SIGMAS) {
    const p95s: number[] = []
    for (const d of [1, 2, 3, 5]) {
      const r = makeRng(seed++)
      const truth = constellation(d).slice(0, 2)
      const half: number[] = []
      let mismatches = 0
      let baselineRule = 0
      const trials = 20000
      for (let k = 0; k < trials; k++) {
        const reference = simulateReference(r, truth, sigma)
        const visit = simulateVisit(r, truth, sigma)
        const stored = ground(reference.stored[0]!, reference.stored[1]!)
        const separation = ground(visit.taps[0]!, visit.taps[1]!)
        const residual = twoPointResidualM(separation, stored)
        half.push(2 * residual)
        const v = verifyConstellation({ pointsUsed: 2, rmsResidualM: residual, maxResidualM: residual, sigmaHatM: sigma })
        assert(v.status !== 'verified' && v.checkedBy === 'separation')
        if (v.status === 'mismatch') mismatches++
        // What the design rules out: a tolerance that grows with the baseline.
        if (Math.abs(separation - stored) > Math.max(0.1, 0.03 * d)) baselineRule++
      }
      p95s.push(percentile(half, 0.95))
      report(
        `sigma ${sigma}, baseline ${d} m: separation p95 / false mismatch (sigma-scaled) / (max(0.10, 0.03 d))`,
        `${(100 * p95s.at(-1)!).toFixed(1)} cm / ${pct(mismatches / trials, 2)} / ${pct(baselineRule / trials)}`,
      )
      assert(mismatches / trials <= 0.01, `sigma ${sigma} d ${d}: ${mismatches / trials} of correct re-taps rejected`)
      if (sigma === 0.05 && d <= 3) {
        assert(baselineRule / trials > 0.25, 'the baseline-scaled rule would reject a quarter or more of correct re-taps')
      }
    }
    // Separation noise is set by the taps, not by how far apart they are.
    assert(Math.max(...p95s) / Math.min(...p95s) < 1.06, `separation p95 varies with the baseline: ${p95s}`)
  }
})

Deno.test('property: unit ratios of 1.0 to 1.15 are absorbed to 15 cm or less at 5 m by the similarity fit, which a rigid fit cannot do', () => {
  let seed = 5000
  for (const d of BASELINES) {
    const costs: number[] = []
    for (const unitRatio of [1.0, 1.05, 1.1, 1.15]) {
      const sim = compareVisits(seed, 6000, constellation(d), 0.03, { unitRatio, similarity: true })
      const rigid = compareVisits(seed++, 6000, constellation(d), 0.03, { unitRatio })
      const simulated = percentile(sim.fit, 0.95)
      const rigidP95 = percentile(rigid.fit, 0.95)
      report(
        `baseline ${d} m, unit ratio ${unitRatio}: p95 at 5 m, similarity / rigid / two points today`,
        `${cm(simulated)} / ${cm(rigidP95)} / ${cm(percentile(sim.today, 0.95))} cm`,
      )
      assert(simulated <= 0.15, `unit ratio ${unitRatio} d ${d}: ${simulated}`)
      if (unitRatio >= 1.1) assert(rigidP95 > 2 * simulated, 'a rigid fit leaves a 10% unit difference in place')
      costs.push(simulated - rigidP95)
      // The size the fit reads is the size that was injected.
      const r = makeRng(seed + 99)
      const errors: number[] = []
      for (let k = 0; k < 3000; k++) {
        const reference = simulateReference(r, constellation(d), 0.03)
        const visit = simulateVisit(r, constellation(d), 0.03, { unitRatio })
        errors.push(Math.abs(assertOk(fitSimilarity2D(visit.taps, reference.stored)).scaleRatio / unitRatio - 1))
      }
      assert(percentile(errors, 0.95) < 0.035, `the scale estimate p95 error is ${percentile(errors, 0.95)}`)
    }
    // With the units already equal, the extra freedom costs only a few centimetres.
    assert(costs[0]! < 0.04, `similarity costs ${costs[0]} against rigid when the units agree`)
  }
})

Deno.test('property: a fixed limit on the size ratio is no safe veto: it rejects correct re-taps the rms gate accepts', () => {
  // A valid but small constellation: all three points within about a metre of each other.
  const small: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0.9, y: 0, z: 0.5 }]
  assert(perpendicularOffsetM(small) >= MIN_PERPENDICULAR_OFFSET_M)
  const r = makeRng(6001)
  let rmsPass = 0
  let bandPass = 0
  const trials = 10000
  for (let k = 0; k < trials; k++) {
    const reference = simulateReference(r, small, 0.05)
    const fit = assertOk(fitRigid2D(simulateVisit(r, small, 0.05).taps, reference.stored))
    if (fit.rmsResidualM <= RMS_GATE_SIGMAS * 0.05) rmsPass++
    if (fit.scaleRatio >= 0.9 && fit.scaleRatio <= 1.1) bandPass++
  }
  report('small constellation at 5 cm: pass the rms gate / a 0.9-1.1 size band', `${pct(rmsPass / trials)} / ${pct(bandPass / trials)}`)
  assert(rmsPass / trials >= 0.98)
  assert(bandPass / trials < 0.9, 'a fixed band would turn away more than a tenth of correct re-taps')
})

Deno.test('property: a mirrored check point is rejected in every visit once the offset reaches the floor, at 5 cm noise', () => {
  const r = makeRng(7001)
  let geometries = 0
  let worst = 1
  while (geometries < 60) {
    const d = 1 + r.uniform() * 3
    const truth: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: d },
      { x: (r.uniform() * 2 - 1) * 4, y: 0, z: -1 + r.uniform() * 7 },
    ]
    const offset = perpendicularOffsetM(truth)
    if (offset < MIN_PERPENDICULAR_OFFSET_M || offset > MIN_PERPENDICULAR_OFFSET_M + 0.05) continue
    if (Math.min(ground(truth[2]!, truth[0]!), ground(truth[2]!, truth[1]!)) < DUPLICATE_POINT_GAP_M) continue
    geometries++
    const o = compareVisits(7100 + geometries, 300, truth, 0.05, { fault: (i, p) => (i === 2 ? { ...p, x: -p.x } : p) })
    worst = Math.min(worst, 1 - rate(o.verdicts, 'verified'))
  }
  report('mirrored check point at the offset floor, 5 cm: worst rejection over 60 geometries', `${(100 * worst).toFixed(1)}%`)
  assert(worst >= 0.99, `worst geometry rejected only ${worst}`)
})

/**
 * A second, independent least-squares fit that applies none of the module's guards, so it
 * can explore geometries the module refuses. It does not use the closed form: it searches the
 * rotation numerically (a coarse grid, then golden-section refinement) and takes the shift
 * from the centroids. The sum of squares is unimodal in the angle, so the search is exact.
 */
function searchedRigidFit(from: readonly Vec3[], to: readonly Vec3[]): { rms: number; max: number } {
  const n = from.length
  const mean = (pts: readonly Vec3[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / n, z: pts.reduce((s, p) => s + p.z, 0) / n })
  const [cf, ct] = [mean(from), mean(to)]
  const a = from.map((p) => ({ x: p.x - cf.x, z: p.z - cf.z }))
  const b = to.map((p) => ({ x: p.x - ct.x, z: p.z - ct.z }))
  const residuals = (theta: number): number[] => {
    const [c, s] = [Math.cos(theta), Math.sin(theta)]
    return a.map((p, i) => Math.hypot(b[i]!.x - (p.x * c - p.z * s), b[i]!.z - (p.x * s + p.z * c)))
  }
  const squares = (theta: number): number => residuals(theta).reduce((sum, v) => sum + v * v, 0)
  // A sinusoid in the angle: a 10 degree grid puts the best node within one node of the true minimum.
  const steps = 36
  let best = 0
  let bestValue = Infinity
  for (let k = 0; k < steps; k++) {
    const theta = -Math.PI + (2 * Math.PI * k) / steps
    const value = squares(theta)
    if (value < bestValue) [best, bestValue] = [theta, value]
  }
  let [lo, hi] = [best - (2 * Math.PI) / steps, best + (2 * Math.PI) / steps]
  const golden = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 50; i++) {
    const [m1, m2] = [hi - golden * (hi - lo), lo + golden * (hi - lo)]
    if (squares(m1) < squares(m2)) hi = m2
    else lo = m1
  }
  const final = residuals((lo + hi) / 2)
  return { rms: Math.sqrt(final.reduce((sum, v) => sum + v * v, 0) / n), max: Math.max(...final) }
}

Deno.test('oracle: a numerical search over the rotation finds the same minimum as the closed form', () => {
  const r = makeRng(8101)
  for (let k = 0; k < 200; k++) {
    const truth = k % 2 === 0 ? constellation(1 + r.uniform() * 3) : constellationOfFour(1 + r.uniform() * 3)
    const reference = simulateReference(r, truth, 0.05)
    const visit = simulateVisit(r, truth, 0.05)
    const fit = assertOk(fitRigid2D(visit.taps, reference.stored))
    const searched = searchedRigidFit(visit.taps, reference.stored)
    assertAlmostEquals(fit.rmsResidualM, searched.rms, 1e-9, `rms, case ${k}`)
    assertAlmostEquals(fit.maxResidualM, searched.max, 1e-8, `max, case ${k}`)
  }
})

Deno.test('the offset floor: a mirrored check point is caught in every visit at the floor and not reliably below it', () => {
  const r = makeRng(8201)
  // Worst rejection, over random geometries whose best-fit-line offset lies in [lo, hi), of a check point
  // tapped on the wrong side of the baseline, at the design's pessimistic 5 cm noise.
  const worstRejection = (lo: number, hi: number): number => {
    let worst = 1
    for (let geometries = 0; geometries < 40;) {
      const d = 1 + r.uniform() * 3
      const truth: Vec3[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: d },
        { x: (r.uniform() * 2 - 1) * 4, y: 0, z: -1 + r.uniform() * 7 },
      ]
      const offset = perpendicularOffsetM(truth)
      if (offset < lo || offset >= hi) continue
      if (Math.min(ground(truth[2]!, truth[0]!), ground(truth[2]!, truth[1]!)) < DUPLICATE_POINT_GAP_M) continue
      geometries++
      let rejected = 0
      const visits = 300
      for (let k = 0; k < visits; k++) {
        const reference = simulateReference(r, truth, 0.05)
        const visit = simulateVisit(r, truth, 0.05, { fault: (i, p) => (i === 2 ? { ...p, x: -p.x } : p) })
        const fit = searchedRigidFit(visit.taps, reference.stored)
        const v = verifyConstellation({ pointsUsed: 3, rmsResidualM: fit.rms, maxResidualM: fit.max, sigmaHatM: 0.05 })
        if (v.status !== 'verified') rejected++
      }
      worst = Math.min(worst, rejected / visits)
    }
    return worst
  }
  const atFloor = worstRejection(MIN_PERPENDICULAR_OFFSET_M, MIN_PERPENDICULAR_OFFSET_M + 0.05)
  const below = worstRejection(0.1, 0.15)
  report('mirrored check point, 5 cm: worst geometry at the floor / at 0.10 to 0.15 m', `${pct(atFloor)} / ${pct(below)}`)
  assert(atFloor >= 0.99, `at the floor the worst geometry rejected only ${atFloor}`)
  assert(below < 0.95, `a lower floor would have been fine: the worst geometry still rejected ${below}`)
})

// ── 4. What the review of the first build added ─────────────────────────────

/** The check point tapped on the wrong feature, 1 m to the side of where it belongs. */
const wrongFeatureAt = (i: number, p: Vec3): Vec3 => (i === 2 ? { ...p, x: p.x + 1 } : p)

Deno.test('KNOWN LIMIT: a similarity fit of three points absorbs a check point on the wrong feature, so the gates alone pass it', () => {
  // The review's finding. A size change spends a degree of freedom, and a far point's displacement is absorbed by the size
  // and the turn: at a 1 m baseline the position gates pass 39% (3 cm taps) and 89% (5 cm taps) of these visits, where a rigid
  // fit passes none. The size it reads, about 1.2, sits comfortably inside the factor-of-two sanity bound.
  for (const [sigma, atLeast] of [[0.03, 0.3], [0.05, 0.8]] as const) {
    const similarity = compareVisits(10001, 6000, constellation(1), sigma, { fault: wrongFeatureAt, similarity: true, unitsMode: 'arbitrary' })
    const rigid = compareVisits(10001, 6000, constellation(1), sigma, { fault: wrongFeatureAt })
    report(`wrong feature, 1 m baseline, sigma ${sigma}: gates alone pass, similarity / rigid`, `${pct(similarity.gatesPass / 6000)} / ${pct(rigid.gatesPass / 6000)}`)
    assert(similarity.gatesPass / 6000 >= atLeast, `similarity gates pass ${similarity.gatesPass / 6000}`)
    assertEquals(rigid.gatesPass, 0, 'a rigid fit cannot absorb it')
    // Why it matters: nearly every such pass leaves a spot 5 m away more than the product target out of place.
    const consequential = similarity.fit.filter((e) => e > ACCURACY_TARGET_M).length / similarity.fit.length
    assert(consequential > 0.95, `${consequential} of the visits misplace the probe`)
  }
})

Deno.test('similarity: a fit of three points is never verified, and four points reject the same wrong feature', () => {
  let seed = 10100
  for (const sigma of SIGMAS) {
    for (const d of BASELINES) {
      // Three points: whatever the gates say, the pass is provisional (or a mismatch), never verified.
      const three = compareVisits(seed++, 4000, constellation(d), sigma, { fault: wrongFeatureAt, similarity: true, unitsMode: 'arbitrary' })
      assertEquals(rate(three.verdicts, 'verified'), 0, `sigma ${sigma} d ${d}: three points verified a wrong feature`)
      assertEquals(three.consequentialAccepts, 0)
      assertEquals(three.failures, 0)
      // The same three points tapped correctly are not a mismatch: the gates pass them, and the verdict says why it is not more.
      const correct = compareVisits(seed++, 4000, constellation(d), sigma, { similarity: true, unitsMode: 'arbitrary' })
      assertEquals(rate(correct.verdicts, 'verified'), 0)
      assert(rate(correct.verdicts, 'provisional') >= 0.98, `${rate(correct.verdicts, 'provisional')}`)
      assert(correct.verdicts.filter((v) => v.status === 'provisional').every((v) => v.reasons.includes('Fitting a size change to 3 points leaves too little to check them: at least 4 are needed.')))
      // Four points have the degrees of freedom the gates were calibrated on: the wrong feature is a mismatch, nearly every time.
      const four = compareVisits(seed++, 4000, constellationOfFour(d), sigma, { fault: wrongFeatureAt, similarity: true, unitsMode: 'arbitrary' })
      const rejected = rate(four.verdicts, 'mismatch')
      report(`wrong feature under a four-point similarity fit, sigma ${sigma}, baseline ${d} m: rejected / consequential accept`, `${pct(rejected, 2)} / ${pct(four.consequentialAccepts / 4000, 2)}`)
      assert(rejected >= 0.995, `sigma ${sigma} d ${d}: ${rejected}`)
      assert(four.consequentialAccepts / 4000 < 0.002)
      // And correct re-taps of four points in other units are still verified, as with a rigid fit.
      const absorbed = compareVisits(seed++, 4000, constellationOfFour(d), sigma, { similarity: true, unitRatio: 1.1, unitsMode: 'arbitrary' })
      assert(rate(absorbed.verdicts, 'verified') >= 0.98, `${rate(absorbed.verdicts, 'verified')}`)
    }
  }
})

Deno.test('similarity: the degrees of freedom are 2n - 4, and the verdict needs the 3 the gate was calibrated on', () => {
  assertEquals(MIN_RESIDUAL_DOF, 3)
  const withMethod = (pointsUsed: number, fitMethod?: FitMethod, extra: Partial<Parameters<typeof verifyConstellation>[0]> = {}) =>
    verdict({ pointsUsed, fitMethod, ...extra })
  // A rigid fit of 3 points has 3, a similarity fit of 3 has 2 and of 4 has 4.
  assertEquals(withMethod(3, 'rigid').status, 'verified')
  assertEquals(withMethod(3).status, 'verified')
  const three = withMethod(3, 'similarity')
  assertEquals([three.status, three.checkedBy, three.compared], ['provisional', 'constellation', 'points'])
  assertEquals(three.reasons, [
    '3 points are 4.0 cm off the stored ones on average (limit 8.4 cm).',
    'The worst point is 6.0 cm off (limit 21.0 cm).',
    'Fitting a size change to 3 points leaves too little to check them: at least 4 are needed.',
    'Not checked: that these are the same physical spots. Compare with the photos.',
  ])
  for (const n of [4, 5, 6]) assertEquals(withMethod(n, 'similarity').status, 'verified', `${n} points`)
  // Beyond the gate it is a mismatch, not a provisional: the dof rule withholds a pass, it never turns a failure into one.
  assertEquals(withMethod(3, 'similarity', { rmsResidualM: 0.2, maxResidualM: 0.2 }).status, 'mismatch')
  // verifyFit passes the method through.
  const stored = constellation(2)
  const pose = composeYUpTransform({ x: 1, y: 0.2, z: -3 }, 25)
  const exact = stored.map((p) => transformPoint(pose, p))
  assertEquals(verifyFit(fitSimilarity2D(exact, stored)).status, 'provisional')
  assertEquals(verifyFit(fitRigid2D(exact, stored)).status, 'verified')
})

Deno.test('similarity: with metric units the size change is not absorbed: the points are judged as a rigid fit would', () => {
  // A 1.8 times larger copy of the triangle, which a similarity fit takes for a perfect fit at another scale.
  const stored = constellationOfFour(2)
  const bigger = stored.map((p) => ({ x: p.x * 1.8, y: p.y, z: p.z * 1.8 }))
  const pose = composeYUpTransform({ x: 3, y: 0.1, z: -1 }, 40)
  const visit = bigger.map((p) => transformPoint(pose, p))
  const similarity = assertOk(fitSimilarity2D(visit, stored))
  assert(similarity.rmsResidualM < 1e-9, 'the similarity fit itself is exact, which is the danger')
  assertAlmostEquals(similarity.scaleRatio, 1.8, 1e-9)
  const metric = verifyFit(fitSimilarity2D(visit, stored), { unitsMode: 'metric' })
  assertEquals([metric.status, metric.checkedBy], ['mismatch', 'constellation'])
  assert(metric.reasons[0]!.startsWith('4 points are '), metric.reasons[0])
  assert(metric.reasons.includes('Sizes differ by 80%.'))
  // The same fit in units that are free to differ is verified (four points), and says that sizes in metres were not checked.
  const arbitrary = verifyFit(fitSimilarity2D(visit, stored), { unitsMode: 'arbitrary' })
  assertEquals(arbitrary.status, 'verified')
  assert(arbitrary.reasons.includes('Sizes differ by 80%.'))
  assert(arbitrary.reasons.includes("Not checked: sizes in metres. This phone's units are not metres."))
  assertEquals(verifyFit(fitSimilarity2D(visit, stored), { unitsMode: 'estimated-metric' }).status, 'verified')
  assertEquals(verifyFit(fitSimilarity2D(visit, stored)).status, 'verified')
  // With the units equal there is nothing to absorb, and a metric similarity fit passes like a rigid one.
  const same = stored.map((p) => transformPoint(pose, p))
  assertEquals(verifyFit(fitSimilarity2D(same, stored), { unitsMode: 'metric' }).status, 'verified')
  // A metric judgement is of the points, not of the dof rule: three points judged without the size are a rigid check.
  const three = constellation(2)
  const threeSame = three.map((p) => transformPoint(pose, p))
  assertEquals(verifyFit(fitSimilarity2D(threeSame, three), { unitsMode: 'metric' }).status, 'verified')
  const threeBigger = three.map((p) => transformPoint(pose, { x: p.x * 1.3, y: p.y, z: p.z * 1.3 }))
  assertEquals(verifyFit(fitSimilarity2D(threeBigger, three), { unitsMode: 'metric' }).status, 'mismatch')
  assertEquals(verifyFit(fitSimilarity2D(threeBigger, three), { unitsMode: 'arbitrary' }).status, 'provisional')
})

Deno.test('fit: the unscaled residuals are what a rigid fit of the same points leaves, and equal the fitted ones for a rigid fit', () => {
  const r = makeRng(10200)
  for (let k = 0; k < 300; k++) {
    const truth = k % 2 === 0 ? constellation(1 + r.uniform() * 3) : constellationOfFour(1 + r.uniform() * 3)
    const reference = simulateReference(r, truth, 0.04)
    const visit = simulateVisit(r, truth, 0.04, { unitRatio: 0.85 + r.uniform() * 0.4 })
    const rigid = assertOk(fitRigid2D(visit.taps, reference.stored))
    const similarity = assertOk(fitSimilarity2D(visit.taps, reference.stored))
    assertEquals([rigid.unscaledRmsResidualM, rigid.unscaledMaxResidualM], [rigid.rmsResidualM, rigid.maxResidualM])
    assertAlmostEquals(similarity.unscaledRmsResidualM, rigid.rmsResidualM, 1e-9)
    assertAlmostEquals(similarity.unscaledMaxResidualM, rigid.maxResidualM, 1e-9)
    assert(similarity.rmsResidualM <= similarity.unscaledRmsResidualM + 1e-12, 'a size to fit never leaves more')
    assertAlmostEquals(similarity.heightRmsResidualM, Math.sqrt(similarity.perPoint.reduce((a, q) => a + q.dy * q.dy, 0) / similarity.perPoint.length), 1e-12)
  }
})

Deno.test('heights: a check point tapped on a table moves the floor, and the verdict says so instead of verifying', () => {
  const stored = constellation(3)
  const pose = composeYUpTransform({ x: 5, y: 0.2, z: -1 }, 40)
  const floor = (taps: Vec3[]) => assertOk(fitRigid2D(taps, stored)).matrix[13]!
  const flat = stored.map((p) => transformPoint(pose, p))
  assertAlmostEquals(floor(flat), -0.2, 1e-9, 'the floor offset of a correct visit is exactly the session height')
  // The same visit with the check point on a table 0.9 m up, x and z exactly right: the review's table-top case.
  const table = flat.map((t, i) => (i === 2 ? { ...t, y: t.y + 0.9 } : t))
  const fit = assertOk(fitRigid2D(table, stored))
  assertAlmostEquals(fit.rmsResidualM, 0, 1e-9, 'horizontally it is a perfect visit')
  assertAlmostEquals(fit.heightRmsResidualM, Math.sqrt(0.18), 1e-9)
  assertAlmostEquals(fit.matrix[13]! - -0.2, -0.3, 1e-9, 'and the floor lands a third of the height off')
  assertEquals(fit.perPoint.map((q) => Number(q.dy.toFixed(6))), [-0.3, -0.3, 0.6])
  const v = verifyFit(fitRigid2D(table, stored))
  assertEquals([v.status, v.checkedBy, v.compared], ['provisional', 'constellation', 'points'])
  assert(v.reasons.includes('Heights are 42.4 cm off on average (limit 8.4 cm).'), v.reasons.join(' | '))
  assert(v.reasons.includes('3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).'), 'the position that was compared is still reported')
  // A tap a few centimetres high is inside what the gate cannot tell from noise, and passes: heights are fitted, not exact.
  const slightly = flat.map((t, i) => (i === 2 ? { ...t, y: t.y + 0.1 } : t))
  assertEquals(verifyFit(fitRigid2D(slightly, stored)).status, 'verified')
  assertAlmostEquals(floor(slightly) - -0.2, -0.1 / 3, 1e-9)
})

Deno.test('heights: the gate is 2.8 sigma-hat on the rms, inclusive; no height, an unusable one and a bad one are told apart', () => {
  assertEquals(HEIGHT_GATE_SIGMAS, 2.8)
  const height = (heightRmsResidualM: number | null | undefined, sigmaHatM = SIGMA0_M) => verdict({ heightRmsResidualM, sigmaHatM })
  const gate = HEIGHT_GATE_SIGMAS * SIGMA0_M
  const at = height(gate)
  assertEquals(at.status, 'verified')
  assert(at.reasons.includes('Heights are 8.4 cm off on average (limit 8.4 cm).'))
  const over = height(gate * (1 + 1e-9))
  assertEquals([over.status, over.checkedBy], ['provisional', 'constellation'])
  assert(over.reasons.includes('Heights are 8.4 cm off on average (limit 8.4 cm).'))
  assertEquals(over.reasons.filter((s) => /^Heights/.test(s)).length, 1, 'said once')
  // A height is never a mismatch, however far off (see HEIGHT_GATE_SIGMAS): only the position gates make one.
  for (const h of [0.5, 5, 1e6]) assertEquals(height(h).status, 'provisional')
  assertEquals(height(0.5, 0.05).status, 'provisional')
  const gateAt5Cm = HEIGHT_GATE_SIGMAS * 0.05
  assertEquals(height(gateAt5Cm, 0.05).status, 'verified')
  assert(height(gateAt5Cm, 0.05).reasons.includes('Heights are 14.0 cm off on average (limit 14.0 cm).'))
  assertEquals(height(0.2, 0.05).status, 'provisional')
  // Absent says nothing about heights, as the numbers-only door always did.
  assert(!height(undefined).reasons.some((s) => /eights/.test(s)))
  assertEquals(height(undefined).status, 'verified')
  // Present but not a number: the verdict says it could not measure them and does not block a pass the position earned.
  for (const bad of [null, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const v = height(bad)
    assertEquals(v.status, 'verified', `${bad}`)
    assert(v.reasons.includes('The heights could not be measured.'), `${bad}`)
  }
  // Two points have no heights to compare.
  assert(!verdict({ pointsUsed: 2, heightRmsResidualM: 5 }).reasons.some((s) => /eights/.test(s)))
  // A position mismatch lists what failed and not the heights.
  assert(!verdict({ rmsResidualM: 0.3, maxResidualM: 0.3, heightRmsResidualM: 5 }).reasons.some((s) => /eights/.test(s)))
})

Deno.test('property: equal vertical noise rarely trips the height gate; a noisier height than that trips it often (why it only withholds)', () => {
  const sigma = 0.03
  const over = (heightMultiple: number): number => {
    const r = makeRng(10300 + Math.round(heightMultiple * 10))
    let count = 0
    const trials = 20000
    for (let k = 0; k < trials; k++) {
      const reference = simulateReference(r, constellation(3), sigma, { sigmaY: sigma * heightMultiple })
      const visit = simulateVisit(r, constellation(3), sigma, { sigmaY: sigma * heightMultiple })
      const fit = assertOk(fitRigid2D(visit.taps, reference.stored))
      if (fit.heightRmsResidualM > HEIGHT_GATE_SIGMAS * sigma) {
        count++
        // Heights alone never make a mismatch: with the position inside its gate the verdict is provisional.
        const v = verifyFit(fitRigid2D(visit.taps, reference.stored), { sigmaHatM: sigma })
        if (gatesPass({ ...fit, heightRmsResidualM: 0 }, sigma)) assertEquals(v.status, 'provisional')
      }
    }
    return count / trials
  }
  const [equal, half, double] = [over(1), over(1.5), over(2)]
  report('height rms over the gate, vertical noise 1x / 1.5x / 2x horizontal', `${pct(equal, 2)} / ${pct(half)} / ${pct(double)}`)
  assert(equal < 0.006, `${equal}`)
  assert(half > 0.05 && half < 0.09, `${half}`)
  assert(double > 0.2 && double < 0.27, `${double}`)
})

/** Every ordering of 0..n-1. */
function permutations(n: number): number[][] {
  if (n === 0) return [[]]
  return permutations(n - 1).flatMap((tail) => Array.from({ length: n }, (_, at) => [...tail.slice(0, at), n - 1, ...tail.slice(at)]))
}

/**
 * The rms horizontal residual of the best turn and shift (and size, for a similarity fit) when visit point `order[i]` is
 * lined up with stored point `i`. Plain complex arithmetic and the residuals themselves: it shares no formula with the module.
 */
function orderRmsM(visit: readonly Vec3[], stored: readonly Vec3[], order: readonly number[], method: FitMethod = 'rigid'): number {
  const n = stored.length
  const a = order.map((j) => ({ re: visit[j]!.x, im: visit[j]!.z }))
  const b = stored.map((p) => ({ re: p.x, im: p.z }))
  const mean = (set: Array<{ re: number; im: number }>) => ({ re: set.reduce((t, c) => t + c.re, 0) / n, im: set.reduce((t, c) => t + c.im, 0) / n })
  const [ma, mb] = [mean(a), mean(b)]
  let zr = 0
  let zi = 0
  let spread = 0
  for (let i = 0; i < n; i++) {
    const [pr, pi, qr, qi] = [a[i]!.re - ma.re, a[i]!.im - ma.im, b[i]!.re - mb.re, b[i]!.im - mb.im]
    zr += pr * qr + pi * qi
    zi += pr * qi - pi * qr
    spread += pr * pr + pi * pi
  }
  const norm = Math.hypot(zr, zi)
  const scale = method === 'similarity' ? norm / spread : 1
  const [ur, ui] = [(zr / norm) * scale, (zi / norm) * scale]
  let squares = 0
  for (let i = 0; i < n; i++) {
    const [pr, pi] = [a[i]!.re - ma.re, a[i]!.im - ma.im]
    const [er, ei] = [b[i]!.re - mb.re - (ur * pr - ui * pi), b[i]!.im - mb.im - (ui * pr + ur * pi)]
    squares += er * er + ei * ei
  }
  return Math.sqrt(squares / n)
}

function otherOrderOf(outcome: FitOutcome) {
  if (outcome.ok) return outcome.fit.alternativeOrder
  if (outcome.failure.reason === 'mirrored') return outcome.failure.alternativeOrder
  throw new Error(`no order search for ${outcome.failure.reason}`)
}

Deno.test('order: the best other order is found among every order of the points, as an independent brute-force search finds it', () => {
  const r = makeRng(10400)
  const identity = (n: number) => Array.from({ length: n }, (_, i) => i)
  let mirrored = 0
  for (const [n, cases] of [[3, 120], [4, 80], [5, 40], [6, 12], [7, 2], [8, 1]] as const) {
    const orders = permutations(n).filter((o) => o.some((v, i) => v !== i))
    assertEquals(orders.length, [0, 0, 0, 5, 23, 119, 719, 5039, 40319][n])
    for (let k = 0; k < cases; k++) {
      // A spread of points that passes the usability checks, then a noisy visit of them under a random session pose.
      const stored: Vec3[] = []
      while (stored.length < n) {
        const candidate = { x: (r.uniform() - 0.5) * 9, y: 0, z: (r.uniform() - 0.5) * 9 }
        if (stored.every((q) => ground(q, candidate) > 0.6)) stored.push(candidate)
      }
      if (referenceProblem(stored)) continue
      const visit = simulateVisit(r, stored, 0.05)
      for (const method of ['rigid', 'similarity'] as const) {
        const outcome = method === 'rigid' ? fitRigid2D(visit.taps, stored) : fitSimilarity2D(visit.taps, stored)
        if (!outcome.ok) assertEquals(outcome.failure.reason, 'mirrored')
        if (!outcome.ok) mirrored++
        const found = otherOrderOf(outcome)
        let best = Infinity
        for (const order of orders) best = Math.min(best, orderRmsM(visit.taps, stored, order, method))
        assertAlmostEquals(found.rmsM, best, 1e-9, `${n} points, ${method}, case ${k}`)
        // What it reports is itself an order, not the identity, that leaves exactly that residual.
        assertEquals([...found.order].sort((x, y) => x - y), identity(n))
        assert(found.order.some((v, i) => v !== i))
        assertAlmostEquals(orderRmsM(visit.taps, stored, found.order, method), found.rmsM, 1e-9)
        assertEquals(found.swapsFirstTwo, found.order[0] === 1 && found.order[1] === 0 && found.order.slice(2).every((v, i) => v === i + 2))
      }
    }
  }
  assert(mirrored >= 0)
})

Deno.test('order: a correct visit of a lopsided shape fits its own order exactly and every other order far worse than the gate', () => {
  const stored = constellation(3)
  const pose = composeYUpTransform({ x: 2, y: 0.1, z: 4 }, 300)
  const visit = stored.map((p) => transformPoint(pose, p))
  const fit = assertOk(fitRigid2D(visit, stored))
  assert(fit.rmsResidualM < 1e-9)
  assert(fit.alternativeOrder.rmsM > 5 * RMS_GATE_SIGMAS * SIGMA0_M, `another order of this triangle leaves ${fit.alternativeOrder.rmsM} m`)
  assertEquals(fit.alternativeOrder.order.length, 3)
})

Deno.test('order: swapped first two taps are named in at least 98% of visits at every baseline, and never verified', () => {
  // The review's finding: the "swapped" hint was shown in 0% of these visits at 3 m, because they read as mirrored first.
  const sigmaOf = [0.03, 0.05]
  let seed = 10500
  for (const sigma of sigmaOf) {
    for (const d of [1, 2, 3, 5]) {
      const r = makeRng(seed++)
      let named = 0
      let mirrored = 0
      const trials = 3000
      for (let k = 0; k < trials; k++) {
        const reference = simulateReference(r, constellation(d), sigma)
        const visit = simulateVisit(r, constellation(d), sigma)
        const outcome = fitRigid2D([visit.taps[1]!, visit.taps[0]!, visit.taps[2]!], reference.stored)
        if (!outcome.ok && outcome.failure.reason === 'mirrored') mirrored++
        const v = verifyFit(outcome, { sigmaHatM: sigma })
        assertEquals(v.status, 'mismatch')
        if (v.reasons.includes('The first two points may be swapped.')) named++
      }
      report(`swapped first two, sigma ${sigma}, baseline ${d} m: named (read as mirrored first)`, `${pct(named / trials)} (${pct(mirrored / trials)})`)
      assert(named / trials >= 0.98, `sigma ${sigma} d ${d}: ${named / trials}`)
    }
  }
  assert(mirrored3m() > 0.9, 'at 3 m nearly all of them read as mirrored first, which is where the old hint was lost')
  function mirrored3m(): number {
    const r = makeRng(10599)
    let count = 0
    for (let k = 0; k < 500; k++) {
      const reference = simulateReference(r, constellation(3), 0.03)
      const visit = simulateVisit(r, constellation(3), 0.03)
      const outcome = fitRigid2D([visit.taps[1]!, visit.taps[0]!, visit.taps[2]!], reference.stored)
      if (!outcome.ok && outcome.failure.reason === 'mirrored') count++
    }
    return count / 500
  }
})

Deno.test('order: another pair swapped is a mismatch that says another order fits, not that the first two were swapped', () => {
  let seed = 10600
  for (const swap of [[1, 2], [0, 2]] as const) {
    const r = makeRng(seed++)
    let named = 0
    const trials = 2000
    for (let k = 0; k < trials; k++) {
      const reference = simulateReference(r, constellation(3), 0.03)
      const visit = simulateVisit(r, constellation(3), 0.03)
      const taps = [...visit.taps]
      ;[taps[swap[0]], taps[swap[1]]] = [taps[swap[1]]!, taps[swap[0]]!]
      const v = verifyFit(fitRigid2D(taps, reference.stored), { sigmaHatM: 0.03 })
      assertEquals(v.status, 'mismatch')
      assert(!v.reasons.includes('The first two points may be swapped.'))
      if (v.reasons.includes('The points match the stored ones if taken in another order.')) named++
    }
    assert(named / trials >= 0.97, `swap ${swap}: ${named / trials}`)
  }
})

/** A shape tapped in an order the shape cannot tell from the right one: its other order fits within the gate. */
function relabelled(truth: Vec3[], order: number[], sigma: number, seed: number, trials: number) {
  const r = makeRng(seed)
  const tally = { verified: 0, provisional: 0, mismatch: 0, ambiguousSentence: 0, otherReason: 0 }
  for (let k = 0; k < trials; k++) {
    const reference = simulateReference(r, truth, sigma)
    const visit = simulateVisit(r, truth, sigma)
    const v = verifyFit(fitRigid2D(order.map((i) => visit.taps[i]!), reference.stored), { sigmaHatM: sigma })
    tally[v.status]++
    if (v.reasons.includes('The points also fit in another order, so the order they were tapped in is not checked.')) tally.ambiguousSentence++
    else if (v.status === 'provisional') tally.otherReason++
  }
  return tally
}

Deno.test('order: a symmetric shape cannot tell its own order, so a relabelled visit is not verified (KNOWN LIMIT: under 1% still are)', () => {
  const equilateral: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 3 * Math.sin(Math.PI / 3), y: 0, z: 1.5 }]
  const rectangle: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 4, y: 0, z: 3 }, { x: 4, y: 0, z: 0 }]
  const trials = 4000
  for (const [name, truth, wrong, right] of [
    ['equilateral triangle', equilateral, [1, 2, 0], [0, 1, 2]],
    ['4 by 3 rectangle', rectangle, [2, 3, 0, 1], [0, 1, 2, 3]],
  ] as Array<[string, Vec3[], number[], number[]]>) {
    for (const sigma of SIGMAS) {
      for (const [label, order] of [['relabelled', wrong], ['in order', right]] as const) {
        const t = relabelled(truth, order, sigma, 10700 + Math.round(sigma * 100), trials)
        report(`${name}, ${label}, sigma ${sigma}: verified / provisional / mismatch`, `${pct(t.verified / trials, 2)} / ${pct(t.provisional / trials, 2)} / ${pct(t.mismatch / trials, 2)}`)
        // About 99% of the time the other order fits within the gate, which is how often the gate passes any visit: the rest slip,
        // fewer than 1% in all, because a visit whose own order fails the gate is a mismatch.
        assert(t.verified / trials <= 0.02, `${name} ${label} sigma ${sigma}: verified ${t.verified / trials}`)
        assert(t.provisional / trials >= 0.97, `${name} ${label} sigma ${sigma}: provisional ${t.provisional / trials}`)
        // Each provisional says why: the order, or (rarely) one of the other reasons a pass can be withheld.
        assertEquals(t.ambiguousSentence + t.otherReason, t.provisional)
        assert(t.otherReason / t.provisional < 0.01, `${t.otherReason} of ${t.provisional} were withheld for another reason`)
      }
    }
  }
})

Deno.test('order: a lopsided shape is not made ambiguous by correct re-taps: guidance-following triangles are provisional well under 1% of visits', () => {
  for (const sigma of SIGMAS) {
    const r = makeRng(10800 + Math.round(sigma * 100))
    let total = 0
    let ambiguous = 0
    for (let k = 0; k < 30000; k++) {
      const d = 3 + r.uniform() * 2
      const cx = (r.uniform() * 2 - 1) * 6
      const cz = (r.uniform() * 2 - 1) * 6 + d / 2
      // The design's guidance: baseline 3 to 5 m, the check point 3 to 6 m from the landmark and at least 2 m off the line.
      if (Math.hypot(cx, cz) < 3 || Math.hypot(cx, cz) > 6 || Math.abs(cx) < 2) continue
      const truth: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: d }, { x: cx, y: 0, z: cz }]
      total++
      const reference = simulateReference(r, truth, sigma)
      const visit = simulateVisit(r, truth, sigma)
      const v = verifyFit(fitRigid2D(visit.taps, reference.stored), { sigmaHatM: sigma })
      if (v.reasons.some((x) => /another order/.test(x)) && v.status === 'provisional') ambiguous++
    }
    report(`correct re-taps of guidance-following triangles, sigma ${sigma}: ambiguous`, `${pct(ambiguous / total, 2)} of ${total}`)
    assert(total > 5000)
    assert(ambiguous / total < 0.01, `${ambiguous / total}`)
  }
})

Deno.test('order: at the first calibration the same numbers tell whether a shape can be used', () => {
  const lopsided = constellation(3)
  assertEquals(referenceProblem(lopsided), null)
  const equilateral: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 3 * Math.sin(Math.PI / 3), y: 0, z: 1.5 }]
  assertEquals(referenceProblem(equilateral), null, 'an equilateral triangle is usable, it just cannot tell its own order')
  const gate = RMS_GATE_SIGMAS * SIGMA0_M
  // Fitting the points to themselves leaves nothing in the right order, and shows how different the other orders look.
  const selfLopsided = assertOk(fitRigid2D(lopsided, lopsided))
  const selfEquilateral = assertOk(fitRigid2D(equilateral, equilateral))
  assertAlmostEquals(selfEquilateral.rmsResidualM, 0, 1e-12)
  assert(selfLopsided.alternativeOrder.rmsM > 5 * gate, `lopsided: ${selfLopsided.alternativeOrder.rmsM}`)
  assert(selfEquilateral.alternativeOrder.rmsM < 1e-9, `equilateral: ${selfEquilateral.alternativeOrder.rmsM}`)
  // A near-equilateral one is judged by the same gate the visits are.
  const nearly: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 3 * Math.sin(Math.PI / 3) + 0.05, y: 0, z: 1.5 }]
  assert(assertOk(fitRigid2D(nearly, nearly)).alternativeOrder.rmsM < gate)
  // And the other reasons a set of points cannot serve, in the order a fit checks them.
  assertEquals(referenceProblem(lopsided.slice(0, 2))?.reason, 'too-few-points')
  assertEquals(referenceProblem([lopsided[0]!, { ...lopsided[0]! }, lopsided[2]!])?.reason, 'duplicate-points')
  assertEquals(referenceProblem([0, 1, 2].map((z) => ({ x: 0, y: 0, z })))?.reason, 'collinear')
  assertEquals(referenceProblem([lopsided[0]!, { x: Number.NaN, y: 0, z: 1 }, lopsided[2]!])?.reason, 'non-finite')
  assertEquals(referenceProblem(Array.from({ length: MAX_FIT_POINTS + 1 }, (_, i) => ({ x: i * 2, y: 0, z: (i % 3) * 2 })))?.reason, 'too-many-points')
})

/** Centimetres as the module prints them: one decimal below a metre, whole above. */
function formatCmForTest(metres: number): string {
  return Math.abs(metres * 100) < 100 ? (metres * 100).toFixed(1) : (metres * 100).toFixed(0)
}

const COMPACT: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0.8, y: 0, z: 0.6 }]

Deno.test('accuracy: the working radius is the design probe and the target is the product acceptance figure', () => {
  assertEquals([WORKING_RADIUS_M, ACCURACY_TARGET_M], [5, 0.305])
})

Deno.test('KNOWN LIMIT: a compact shape agrees with itself and still places a far spot badly, which the gates cannot see', () => {
  // The review's finding: all points within a metre pass every floor and 99% of correct re-taps pass the gates, yet 13% of those
  // passing visits put a spot 5 m away more than the product target out, because a short lever arm makes the heading poor.
  const sigma = 0.03
  const probeOff = (truth: Vec3[]) => {
    const r = makeRng(10900)
    let passing = 0
    let off = 0
    const trials = 20000
    for (let k = 0; k < trials; k++) {
      const reference = simulateReference(r, truth, sigma)
      const visit = simulateVisit(r, truth, sigma)
      const fit = assertOk(fitRigid2D(visit.taps, reference.stored))
      if (!gatesPass(fit, sigma)) continue
      passing++
      if (ground(transformPoint(fit.matrix, visit.toSession(PROBE)), reference.positionOf(PROBE)) > ACCURACY_TARGET_M) off++
    }
    return { passing: passing / trials, off: off / passing }
  }
  const compact = probeOff(COMPACT)
  const design = probeOff(constellation(2))
  report('compact shape: gates pass / of those, probe over the target', `${pct(compact.passing)} / ${pct(compact.off)}`)
  report('design shape: gates pass / of those, probe over the target', `${pct(design.passing)} / ${pct(design.off, 2)}`)
  assert(compact.passing >= 0.98 && compact.off > 0.1, `${compact.passing} ${compact.off}`)
  assert(design.passing >= 0.98 && design.off < 0.005, `${design.passing} ${design.off}`)
})

Deno.test('accuracy: a compact shape whose points agree is provisional, and the words give the estimate', () => {
  const pose = composeYUpTransform({ x: 2, y: 0.1, z: -4 }, 70)
  const visit = COMPACT.map((p) => transformPoint(pose, p))
  const v = verifyFit(fitRigid2D(visit, COMPACT))
  assertEquals([v.status, v.checkedBy, v.compared], ['provisional', 'constellation', 'points'])
  const expected = frameUncertaintyAt(COMPACT, SIGMA0_M, WORKING_RADIUS_M)!.position95M
  assert(expected > ACCURACY_TARGET_M)
  assertEquals(v.reasons.filter((x) => /^Estimate/.test(x)), [
    `Estimate: two scans would place a spot 5 m away up to about ${(100 * expected).toFixed(1)} cm apart (95 of 100 times), more than the 30.5 cm aimed for.`,
  ])
  assert(v.reasons.includes('3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).'), 'what agreed is still reported')
  assert(v.reasons.includes('Not checked: that these are the same physical spots. Compare with the photos.'))
  // The design shape at the same noise is verified, and says nothing of the estimate.
  const design = verifyFit(fitRigid2D(constellation(2).map((p) => transformPoint(pose, p)), constellation(2)))
  assertEquals(design.status, 'verified')
  assert(!design.reasons.some((x) => /Estimate/.test(x)))
})

Deno.test('accuracy: the estimate describes the real tap spread, above the cap too, where the gates are held at the cap', () => {
  const stored = constellation(2)
  const pose = composeYUpTransform({ x: 1, y: 0, z: 2 }, 15)
  const visit = stored.map((p) => transformPoint(pose, p))
  for (const sigma of [0.05, 0.1, 0.2, 0.5]) {
    const v = verifyFit(fitRigid2D(visit, stored), { sigmaHatM: sigma })
    const expected = frameUncertaintyAt(stored, sigma, WORKING_RADIUS_M)!.position95M
    assertEquals(v.status, sigma > 0.07 ? 'provisional' : 'verified', `sigma ${sigma}`)
    assertEquals(
      v.reasons.filter((x) => /^Estimate/.test(x)),
      sigma > 0.07
        ? [`Estimate: two scans would place a spot 5 m away up to about ${formatCmForTest(expected)} cm apart (95 of 100 times), more than the 30.5 cm aimed for.`]
        : [],
      `sigma ${sigma}`,
    )
  }
})

Deno.test('accuracy: the target is the boundary, inclusive, at the numbers door, and a missing estimate withholds nothing', () => {
  assertEquals(verdict({ expectedErrorM: ACCURACY_TARGET_M }).status, 'verified')
  const over = verdict({ expectedErrorM: ACCURACY_TARGET_M * (1 + 1e-9) })
  assertEquals([over.status, over.checkedBy], ['provisional', 'constellation'])
  assert(over.reasons.includes('Estimate: two scans would place a spot 5 m away up to about 30.5 cm apart (95 of 100 times), more than the 30.5 cm aimed for.'))
  for (const missing of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) assertEquals(verdict({ expectedErrorM: missing }).status, 'verified', `${missing}`)
  // A mismatch is a mismatch whatever the shape; two points have no shape to predict from.
  assertEquals(verdict({ rmsResidualM: 0.3, maxResidualM: 0.3, expectedErrorM: 9 }).reasons.some((x) => /Estimate/.test(x)), false)
  assertEquals(verdict({ pointsUsed: 2, expectedErrorM: 9 }).reasons.some((x) => /Estimate/.test(x)), false)
})

Deno.test('property: a verified verdict always comes with a shape whose predicted accuracy is within the target', () => {
  const r = makeRng(11000)
  let verified = 0
  let withheld = 0
  for (let k = 0; k < 20000; k++) {
    const truth: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 + r.uniform() * 3 },
      { x: (r.uniform() * 2 - 1) * 4, y: 0, z: -1 + r.uniform() * 7 },
    ]
    const sigma = [0.03, 0.05, 0.08][k % 3]!
    const reference = simulateReference(r, truth, sigma)
    const visit = simulateVisit(r, truth, sigma)
    const v = verifyFit(fitRigid2D(visit.taps, reference.stored), { sigmaHatM: sigma })
    if (v.status === 'verified') {
      verified++
      assert(frameUncertaintyAt(reference.stored, sigma, WORKING_RADIUS_M)!.position95M <= ACCURACY_TARGET_M, `verified at sigma ${sigma} for a shape that predicts ${frameUncertaintyAt(reference.stored, sigma, WORKING_RADIUS_M)!.position95M}`)
    } else if (v.reasons.some((x) => /^Estimate/.test(x))) withheld++
  }
  assert(verified > 5000 && withheld > 1000, `${verified} verified, ${withheld} withheld for the estimate`)
})

Deno.test('accuracy: at 8 cm tap noise three points cannot promise the target and four can', () => {
  // frameUncertaintyAt of the design shape at sigma-hat 8 cm is 36 to 38 cm; a fourth point spread the other way brings it to 26 cm.
  const three = compareVisits(11100, 4000, constellation(2), 0.08)
  const four = compareVisits(11101, 4000, constellationOfFour(2), 0.08)
  report('sigma 8 cm correct re-taps verified, three / four points', `${pct(rate(three.verdicts, 'verified'))} / ${pct(rate(four.verdicts, 'verified'))}`)
  assertEquals(rate(three.verdicts, 'verified'), 0)
  assert(rate(three.verdicts, 'provisional') >= 0.98)
  assert(rate(four.verdicts, 'verified') >= 0.97, `${rate(four.verdicts, 'verified')}`)
})

Deno.test('accuracy: a thin shape with the check point on the wrong side is never verified, at any noise up to the cap', () => {
  // The review's finding: at an offset just over the collinear floor the mirror image was verified in up to 3.7% of visits at
  // 10 cm noise, because the floor is not scaled with sigma-hat. A thin shape predicts a poor frame, so it cannot be verified.
  let passedGatesAlone = 0
  for (const offset of [0.21, 0.3]) {
    for (const sigma of [0.05, 0.08, 0.1]) {
      const width = 1.5 * offset
      const truth: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, { x: width, y: 0, z: 1 }]
      const r = makeRng(11200 + Math.round(offset * 100) + Math.round(sigma * 1000))
      const trials = 8000
      for (let k = 0; k < trials; k++) {
        const reference = simulateReference(r, truth, sigma)
        const visit = simulateVisit(r, truth, sigma, { fault: (i, p) => (i === 2 ? { ...p, x: -p.x } : p) })
        const outcome = fitRigid2D(visit.taps, reference.stored)
        if (outcome.ok && gatesPass(outcome.fit, sigma)) passedGatesAlone++
        assertNotEquals(verifyFit(outcome, { sigmaHatM: sigma }).status, 'verified', `offset ${offset} sigma ${sigma}`)
      }
    }
  }
  report('wrong-side check point on a thin shape: visits the gates alone would have passed', `${passedGatesAlone} of 48000`)
  assert(passedGatesAlone > 200, `the property has teeth only if the gates alone pass some: ${passedGatesAlone}`)
})

Deno.test('hardening: two taps on one spot have no direction, and the fit says so instead of inventing one', () => {
  const stored = constellation(2)
  // The review's case: the first two taps land on the same spot. A bearing of atan2(0, 0) is 0 and would read as a made-up -59 degrees.
  const visit: Vec3[] = [{ x: 5, y: 0, z: 1 }, { x: 5, y: 0, z: 1 }, { x: 8, y: 0, z: 3.8 }]
  for (const fitter of [fitRigid2D, fitSimilarity2D]) {
    const fit = assertOk(fitter(visit, stored))
    assertEquals(fit.headingResidualDeg, null)
    const v = verifyFit(fitter(visit, stored))
    assertEquals(v.status, 'mismatch')
    assert(v.reasons.includes('The direction of the first two points could not be measured.'), v.reasons.join(' | '))
    assert(!v.reasons.some((x) => /° off the stored direction/.test(x)), 'no invented bearing')
    assertEquals(summariseFit(fit).headingResidualDeg, null)
    assertEquals(JSON.parse(JSON.stringify(summariseFit(fit))).headingResidualDeg, null)
  }
  // The standalone function already said so; the fit now agrees with it.
  assertEquals(headingResidualDeg(0, [visit[0]!, visit[1]!], [stored[0]!, stored[1]!]), null)
  // A visit with a baseline has one, and a clean pass still reports it.
  const pose = composeYUpTransform({ x: 1, y: 0, z: 1 }, 20)
  const good = assertOk(fitRigid2D(stored.map((p) => transformPoint(pose, p)), stored))
  assertAlmostEquals(headingOf(good), 0, 1e-9)
  assert(verifyFit(fitRigid2D(stored.map((p) => transformPoint(pose, p)), stored)).reasons.some((x) => /first two points is 0\.0°/.test(x)))
})

Deno.test('hardening: coordinates at the edge of floating point give a named failure, never a throw and never a non-finite fit', () => {
  // The smallest input the review found that threw: finite numbers whose squares overflow somewhere inside the fit.
  const from: Vec3[] = [
    { x: 1, y: -4.266922501847148e+199, z: 0.1011530589312315 },
    { x: 1.575622058007866e-13, y: -4.4683068443555385, z: 5.35329706268385e-13 },
    { x: -1000, y: 0, z: -1 },
  ]
  const to: Vec3[] = [
    { x: -70711209904.4025, y: -1000000000000, z: 5.6649785884656015e+149 },
    { x: 8.315843634773046e-201, y: -7.253017867915332e+99, z: -1 },
    { x: 1e-12, y: -1e-12, z: -2.3498642654158173e+99 },
  ]
  const outcome = fitSimilarity2D(from, to)
  assert(!outcome.ok || Object.values(outcome.fit).flat(2).every((v) => typeof v !== 'number' || Number.isFinite(v)))
  assertEquals(verifyFit(outcome).status === 'verified', false)
  // One height at the top of the range: a similarity fit used to return ok with a non-finite height residual.
  const tall = constellation(2).map((p, i) => (i === 2 ? { ...p, y: 1e308 } : p))
  for (const fitter of [fitRigid2D, fitSimilarity2D]) {
    const o = fitter(tall, constellation(2))
    if (o.ok) {
      assert(o.fit.matrix.every(Number.isFinite) && o.fit.perPoint.every((q) => [q.residualM, q.dx, q.dy, q.dz].every(Number.isFinite)))
      assert(Number.isFinite(o.fit.heightRmsResidualM) && Number.isFinite(o.fit.rmsResidualM))
    }
  }
  // And a fuzz over the magnitudes the format has: well-spread clouds, scaled from 1e-150 to 1e150 (the squares of the large ones
  // overflow somewhere inside the fit), with now and then a coordinate of 1e300. Whatever happens is a result with numbers in it,
  // or a named failure.
  const r = makeRng(11300)
  let refused = 0
  let fitted = 0
  const reasons = new Set<string>()
  for (let k = 0; k < 4000; k++) {
    const cloud = (scaleExponent: number): Vec3[] => Array.from({ length: 3 + (k % 4) }, () => {
      const scale = 10 ** scaleExponent
      const wild = (v: number) => (r.uniform() < 0.02 ? 1e300 * (r.uniform() < 0.5 ? 1 : -1) : v * scale)
      return { x: wild((r.uniform() - 0.5) * 12), y: wild((r.uniform() - 0.5) * 12), z: wild((r.uniform() - 0.5) * 12) }
    })
    for (const fitter of [fitRigid2D, fitSimilarity2D]) {
      const o = fitter(cloud(-150 + r.uniform() * 300), cloud(r.uniform() * 154))
      if (!o.ok) {
        refused++
        reasons.add(o.failure.reason)
        assertEquals(verifyFit(o).status === 'verified', false)
        continue
      }
      fitted++
      const numbers = [...o.fit.matrix, o.fit.headingDeg, o.fit.scale, o.fit.scaleRatio, o.fit.rmsResidualM, o.fit.maxResidualM, o.fit.unscaledRmsResidualM, o.fit.unscaledMaxResidualM, o.fit.heightRmsResidualM, o.fit.referenceSpreadM, o.fit.alternativeOrder.rmsM]
      assert(numbers.every(Number.isFinite), `a non-finite number in a successful fit at case ${k}`)
    }
  }
  assert(refused > 500 && fitted > 500, `${refused} refused, ${fitted} fitted`)
  assert(reasons.has('unmatched') && reasons.has('mirrored'), `reached ${[...reasons].join(', ')}`)
})

Deno.test('hardening: more than MAX_FIT_POINTS is refused at once, so a corrupt record cannot freeze a client', () => {
  assertEquals(MAX_FIT_POINTS, 8)
  const ring = (n: number): Vec3[] => Array.from({ length: n }, (_, i) => ({ x: 3 * Math.cos(i * 2.399963), y: 0, z: 3 * Math.sin(i * 2.399963) * (1 + (i % 3) * 0.2) }))
  assertEquals(referenceProblem(ring(MAX_FIT_POINTS)), null)
  const refused = fitRigid2D(ring(MAX_FIT_POINTS + 1), ring(MAX_FIT_POINTS + 1))
  const failure = assertFailure(refused, 'too-many-points')
  if (failure.reason !== 'too-many-points') throw new Error('unreachable')
  assertEquals([failure.pointsGiven, failure.pointsAllowed], [MAX_FIT_POINTS + 1, MAX_FIT_POINTS])
  assertEquals(failure.message, '9 points: at most 8 can be compared.')
  assertEquals(verifyFit(refused).status, 'provisional')
  // The quadratic scan of 50,000 points took 26 seconds; refusing by count is immediate.
  const many = ring(50000)
  const started = performance.now()
  assertFailure(fitSimilarity2D(many, many), 'too-many-points')
  assertEquals(referenceProblem(many)?.reason, 'too-many-points')
  assert(performance.now() - started < 500, `refusing 50,000 points took ${performance.now() - started} ms`)
  // Eight points, the most there is, fit and search every order (40,319 of them) in well under a second.
  const eight = ring(MAX_FIT_POINTS)
  const timed = performance.now()
  const fit = assertOk(fitRigid2D(eight, eight))
  assert(performance.now() - timed < 1000, `eight points took ${performance.now() - timed} ms`)
  assertEquals(fit.alternativeOrder.order.length, MAX_FIT_POINTS)
})

Deno.test('hardening: a failure is a new object on every call, so one caller\'s edit is never another\'s result', () => {
  const stored = constellation(2)
  // All three taps on the one spot: nothing to line up, the shared "unmatched" failure of the first build.
  const pile: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }]
  for (const fitter of [fitRigid2D, fitSimilarity2D]) {
    const first = fitter(pile, stored)
    const second = fitter(pile, stored)
    assertFailure(first, 'unmatched')
    assert(first !== second && !first.ok && !second.ok && first.failure !== second.failure, 'two calls, two objects')
    const message = first.ok ? '' : first.failure.message
    if (!first.ok) first.failure.message = 'EDITED BY A CALLER'
    const third = fitter(pile, stored)
    assertEquals(third.ok ? '' : third.failure.message, message)
    assertEquals(verifyFit(third).reasons, [message])
  }
})

Deno.test('float rounding: the largest residual is never reported under the rms, so a real fit is never "nothing was compared"', () => {
  // The review's cases: an equilateral triangle read at a uniform size error leaves every residual equal, and the maximum came out
  // one unit in the last place below the rms, which the verdict took for a measurement that does not exist.
  const equilateral = (side: number): Vec3[] => [0, 1, 2].map((k) => ({
    x: (side / Math.sqrt(3)) * Math.cos((2 * Math.PI * k) / 3),
    y: 0,
    z: (side / Math.sqrt(3)) * Math.sin((2 * Math.PI * k) / 3),
  }))
  let checked = 0
  for (let side = 1; side <= 6; side += 0.01) {
    for (const scale of [1.05, 1.1, 1.2, 1.5, 0.8, 0.9]) {
      const tri = equilateral(side)
      const outcome = fitRigid2D(tri.map((p) => ({ x: p.x * scale, y: 0, z: p.z * scale })), tri)
      if (!outcome.ok) continue
      checked++
      assert(outcome.fit.maxResidualM >= outcome.fit.rmsResidualM, `side ${side} scale ${scale}`)
      assertNotEquals(verifyFit(outcome).compared, 'nothing', `side ${side} scale ${scale}`)
    }
  }
  assert(checked > 2900, `${checked}`)
  const tri = equilateral(2.67)
  const exact = verifyFit(fitRigid2D(tri.map((p) => ({ x: p.x * 1.1, y: 0, z: p.z * 1.1 })), tri))
  assertEquals([exact.status, exact.compared], ['mismatch', 'points'])
  // The numbers door allows the same one unit in the last place, and no more.
  const x = 0.1541525218736295
  assertEquals(verdict({ rmsResidualM: x, maxResidualM: x * (1 - 1e-12) }).compared, 'points')
  assertEquals(verdict({ rmsResidualM: x, maxResidualM: x * (1 - 1e-3) }).compared, 'nothing')
})

Deno.test('two points: verifyTwoPoint is the door for a pair, and the half-spacing convention cannot be got wrong', () => {
  const door = (separationM: number, storedSeparationM = 3, sigmaHatM?: number, unitsMode?: UnitsMode) =>
    verifyTwoPoint({ separationM, storedSeparationM, sigmaHatM, unitsMode })
  // Exactly the numbers door fed with the documented half.
  for (const [separation, stored] of [[3.04, 3], [2.9, 3], [3.2, 3], [5, 3]] as const) {
    const half = twoPointResidualM(separation, stored)
    assertEquals(door(separation, stored), verifyConstellation({ pointsUsed: 2, rmsResidualM: half, maxResidualM: half, sigmaHatM: SIGMA0_M }))
  }
  const ok = door(3.04)
  assertEquals([ok.status, ok.checkedBy, ok.compared], ['provisional', 'separation', 'distance'])
  assertEquals(ok.reasons, [
    'The two points are 4.0 cm off the stored distance (limit 16.8 cm).',
    'Direction was not checked: a third point is needed.',
    'Not checked: that these are the same physical spots. Compare with the photos.',
  ])
  // The trap the review found: a spacing error handed over whole, as commitTwoPoint's residualM is, makes the gate twice as strict.
  const wholeSpacingError = 0.1
  assertEquals(door(3.1).status, 'provisional')
  assertEquals(verifyConstellation({ pointsUsed: 2, rmsResidualM: wholeSpacingError, maxResidualM: wholeSpacingError, sigmaHatM: SIGMA0_M }).status, 'mismatch')
  // The limit is the tolerance a scan records: 2 x 2.8 x sigma-hat, with the cap and the floor of sigma-hat applied.
  assertAlmostEquals(twoPointToleranceM(), 0.168, 1e-12)
  assertAlmostEquals(twoPointToleranceM(0.03), 0.168, 1e-12)
  assertAlmostEquals(twoPointToleranceM(0.05), 0.28, 1e-12)
  assertAlmostEquals(twoPointToleranceM(0.004), 0.168, 1e-12)
  assertAlmostEquals(twoPointToleranceM(Number.NaN), 0.168, 1e-12)
  assertAlmostEquals(twoPointToleranceM(0.1), 0.56, 1e-12)
  assertAlmostEquals(twoPointToleranceM(7), 0.56, 1e-12)
  // That is not today's 15 cm: the design's sigma-hat-scaled limit is 12% wider at the adopted noise floor.
  assertEquals(DEFAULT_SEPARATION_TOLERANCE_M, 0.15)
  assert(twoPointToleranceM() > DEFAULT_SEPARATION_TOLERANCE_M)
  // A scan that records that number says what was checked: the gate and the recorded tolerance agree at every error.
  for (const sigma of [undefined, 0.03, 0.05, 0.2]) {
    const tolerance = twoPointToleranceM(sigma)
    for (let error = 0; error <= 0.8; error += 0.005) {
      if (Math.abs(error - tolerance) < 1e-9) continue
      const v = door(3 + error, 3, sigma)
      assertEquals(v.status === 'mismatch', error > tolerance, `sigma ${sigma} error ${error}`)
    }
    assertEquals(door(3 + tolerance - 1e-9, 3, sigma).status, 'provisional')
    assertEquals(door(3 + tolerance + 1e-6, 3, sigma).status, 'mismatch')
  }
  // Units are named, never decide; a distance that is not a number compares nothing.
  assert(door(3.04, 3, undefined, 'arbitrary').reasons.includes("Not checked: sizes in metres. This phone's units are not metres."))
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const call of [door(bad), door(3, bad)]) {
      assertEquals([call.status, call.checkedBy, call.compared], ['provisional', 'separation', 'nothing'])
    }
  }
})

Deno.test('heights: stored points need their height, because the floor is the mean of all of them', () => {
  // The brief stores {x, z} for a reference point. A check point tapped 12 cm above the floor at the first visit is 12 cm high in the
  // Place frame; dropping that, a perfect second visit puts the landmark 4 cm under the floor the first visit gave it.
  const truth: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, { x: 3, y: 0.12, z: 2.8 }]
  const first = truth.map((p) => transformPoint(composeYUpTransform({ x: 1, y: 0.7, z: 2 }, 33), p))
  const frame = twoPointToProjectTransform(first[0]!, first[1]!)
  const withHeights = first.map((t) => transformPoint(frame, t))
  const withoutHeights = withHeights.map((p) => ({ x: p.x, y: 0, z: p.z }))
  const second = truth.map((p) => transformPoint(composeYUpTransform({ x: -3, y: 0.8, z: 1 }, 200), p))
  const landmarkHeight = (stored: Vec3[]) => transformPoint(assertOk(fitRigid2D(second, stored)).matrix, second[0]!).y
  assertAlmostEquals(landmarkHeight(withHeights), 0, 1e-9)
  assertAlmostEquals(landmarkHeight(withoutHeights), -0.04, 1e-9)
})

Deno.test('hostile inputs: points that are missing, not a list, or not points are a result and never a throw', () => {
  // A frame stored before its points were kept has no list of them, and the server stores whatever it is sent.
  const good = constellation(2)
  const hostile: unknown[] = [
    undefined, null, 'banana', 42, {}, [null], [undefined, undefined, undefined], [1, 2, 3], ['a', 'b', 'c'], [{}, {}, {}], [[], [], []],
    { length: 3 }, good,
  ]
  const identity = composeYUpTransform({ x: 0, y: 0, z: 0 }, 0)
  for (const a of hostile) {
    for (const b of hostile) {
      if (a === good && b === good) continue
      for (const fitter of [fitRigid2D, fitSimilarity2D]) {
        const outcome = fitter(a as Vec3[], b as Vec3[])
        assertEquals(outcome.ok, false, `${JSON.stringify(a)} against ${JSON.stringify(b)}`)
        if (outcome.ok) continue
        assert(outcome.failure.message.length > 0)
        const verdict = verifyFit(outcome)
        assertNotEquals(verdict.status, 'verified')
        assertEquals(verdict.compared, 'nothing')
      }
      assertEquals(pointResiduals(identity, a as Vec3[], b as Vec3[]), null)
      assertEquals(headingResidualDeg(0, a as [Vec3, Vec3], b as [Vec3, Vec3]), null)
    }
    if (a !== good) {
      assert(referenceProblem(a as Vec3[]) !== null, `${JSON.stringify(a)}`)
      assertEquals(frameUncertaintyAt(a as Vec3[], 0.03, 5), null)
    }
  }
  assertEquals(assertFailure(fitRigid2D(undefined as unknown as Vec3[], good), 'length-mismatch').message, '0 points this visit but 3 stored: nothing was compared.')
  assertEquals(assertFailure(fitRigid2D(good, null as unknown as Vec3[]), 'length-mismatch').message, '3 points this visit but 0 stored: nothing was compared.')
  assertEquals(assertFailure(fitRigid2D(undefined as unknown as Vec3[], undefined as unknown as Vec3[]), 'too-few-points').message, 'Only 0 points: at least 3 are needed to check direction.')
})

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

Deno.test('purity: frozen inputs are never modified, and the same inputs always give the same answer', () => {
  const stored = deepFreeze(constellationOfFour(2).map((p) => ({ ...p })))
  const pose = composeYUpTransform({ x: 5, y: 0.1, z: 1 }, 70)
  const visit = deepFreeze(stored.map((p) => transformPoint(pose, p)).map((p, i) => ({ ...p, x: p.x + (i === 3 ? 0.04 : 0) })))
  for (const fitter of [fitRigid2D, fitSimilarity2D]) {
    const first = fitter(visit, stored)
    const second = fitter(visit, stored)
    assertEquals(JSON.stringify(first), JSON.stringify(second))
    assert(first.ok)
    const verdictA = verifyFit(first, { sigmaHatM: 0.04, unitsMode: 'arbitrary' })
    assertEquals(verdictA, verifyFit(second, { sigmaHatM: 0.04, unitsMode: 'arbitrary' }))
    assertEquals(summariseFit(first.fit), summariseFit(second.ok ? second.fit : first.fit))
  }
  assertEquals(frameUncertaintyAt(stored, 0.03, 5), frameUncertaintyAt(stored, 0.03, 5))
  assertEquals(perpendicularOffsetM(stored), perpendicularOffsetM(stored))
  assertEquals(referenceProblem(stored), null)
  assertEquals(pointResiduals(deepFreeze(composeYUpTransform({ x: 0, y: 0, z: 0 }, 0)), visit, stored)!.length, 4)
  const input = deepFreeze({ pointsUsed: 3, rmsResidualM: 0.04, maxResidualM: 0.06, sigmaHatM: 0.03, alternativeOrder: { rmsM: 1, swapsFirstTwo: false } })
  assertEquals(verifyConstellation(input), verifyConstellation(input))
  assertEquals(verifyTwoPoint(deepFreeze({ separationM: 3.04, storedSeparationM: 3 })), verifyTwoPoint({ separationM: 3.04, storedSeparationM: 3 }))
})

Deno.test('ADR 0002: the module uses no runtime-specific API and imports only browser-safe siblings', async () => {
  const read = (relative: string) => Deno.readTextFile(new URL(relative, import.meta.url))
  const source = await read('../../../src/world/frame-fit.ts')
  assert(!/\bDeno\b/.test(source), 'no Deno reference of any kind')
  assert(!/\b(window|document|navigator|localStorage|sessionStorage|indexedDB|HTMLCanvasElement)\b/.test(source), 'no DOM')
  const imports = [...source.matchAll(/^import\s[^\n]*?from\s+'([^']+)'/gm)].map((m) => m[1]!).sort()
  assertEquals(imports, ['../capture/pose-delta.ts', './calibration-evidence.ts', './geo.ts', './types.ts'])
  // The siblings it pulls in must be clean as well, or the browser build inherits the problem.
  for (const sibling of ['../../../src/world/geo.ts', '../../../src/world/calibration-evidence.ts', '../../../src/capture/pose-delta.ts']) {
    assert(!/\bDeno\./.test(await read(sibling)), `${sibling} calls a Deno API`)
  }
})

// ── Existing records and the documented flow ────────────────────────────────

Deno.test('records written by the previous build still work: a two-point Place has two reference points and stays provisional', () => {
  // A Place frame exactly as the previous build stored it: no referencePoints, no fit.
  const legacy: ProjectSpatialFrame = {
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 3.2 },
    separationM: 3.2,
    toleranceM: 0.15,
    anchorBearingDeg: 212.5,
    pointLabels: ['north door frame', 'radiator'],
  }
  if (legacy.method !== 'two-point-ground') throw new Error('unreachable')
  const stored = [legacy.landmark, legacy.headingMarker]
  const pose = composeYUpTransform({ x: 1, y: 0.2, z: 3 }, 64)
  const visit = stored.map((p) => transformPoint(pose, p))

  // No check point is stored, so there is nothing to fit: an explicit result, and the flow keeps today's transform.
  const outcome = fitRigid2D(visit, stored)
  assertFailure(outcome, 'too-few-points')
  const viaFit = verifyFit(outcome)
  assertEquals([viaFit.status, viaFit.checkedBy], ['provisional', 'separation'])

  // The two-point path: the distance between this visit's taps against the stored separation.
  const separation = ground(visit[0]!, visit[1]!)
  const half = twoPointResidualM(separation, legacy.separationM)
  const v = verifyConstellation({ pointsUsed: 2, rmsResidualM: half, maxResidualM: half, sigmaHatM: sigmaHat(undefined) })
  assertEquals([v.status, v.checkedBy], ['provisional', 'separation'])
  assertAlmostEquals(half, 0, 1e-12)

  // Nothing in the new module reads or rewrites a stored record: the frame is untouched.
  assertEquals(legacy.landmark, { x: 0, y: 0, z: 0 })
  assertEquals(legacy.separationM, 3.2)
})

Deno.test('the flow in the API note works as written', () => {
  // First visit: the frame is today's two-point transform and every tap is stored in it.
  const truth = constellation(3)
  const r = makeRng(8001)
  const first = simulateVisit(r, truth, 0.03)
  const frame = twoPointToProjectTransform(first.taps[0]!, first.taps[1]!)
  const storedPoints = first.taps.map((tap) => transformPoint(frame, tap))
  assertAlmostEquals(storedPoints[0]!.x, 0, 1e-12)
  assertAlmostEquals(storedPoints[1]!.z, ground(first.taps[0]!, first.taps[1]!), 1e-12)
  // At the first calibration: the points can serve, and the accuracy to show beside the step is the one the verdict will use.
  assertEquals(referenceProblem(storedPoints), null)
  const predicted = frameUncertaintyAt(storedPoints, sigmaHat(undefined), WORKING_RADIUS_M)!
  assert(predicted.position95M < 0.2 && predicted.position95M < ACCURACY_TARGET_M)

  // Return visit: fit, take the matrix, keep the summary, ask for the verdict.
  const visit = simulateVisit(r, truth, 0.03)
  const outcome = fitRigid2D(visit.taps, storedPoints)
  assert(outcome.ok)
  const sessionToProject = outcome.fit.matrix
  const summary = summariseFit(outcome.fit)
  // A measured spread of 5 cm, against the 3 cm these simulated taps really have: the gates are generous, so this visit passes.
  const v = verifyFit(outcome, { sigmaHatM: sigmaHat(0.05), unitsMode: 'metric' })
  assertEquals(sessionToProject.length, 16)
  assertEquals(summary.pointsUsed, 3)
  assertEquals([v.status, v.checkedBy, v.compared], ['verified', 'constellation', 'points'])
  // A ghost: where the stored check point is in this session, from the inverse of the same matrix.
  const ghost = transformPoint(invertAffine(sessionToProject)!, storedPoints[2]!)
  assert(ground(ghost, visit.taps[2]!) < 0.2, 'the ghost sits near the tap')

  // A two-point visit of the same Place has no fit: it keeps today's transform, asks the two-point door for the verdict, and
  // writes the tolerance that door applied as the scan's toleranceM.
  const pairVisit = simulateVisit(r, truth.slice(0, 2), 0.03)
  const pair = verifyTwoPoint({
    separationM: ground(pairVisit.taps[0]!, pairVisit.taps[1]!),
    storedSeparationM: ground(storedPoints[0]!, storedPoints[1]!),
    sigmaHatM: sigmaHat(0.05),
  })
  assertEquals([pair.status, pair.checkedBy, pair.compared], ['provisional', 'separation', 'distance'])
  assertAlmostEquals(twoPointToleranceM(sigmaHat(undefined)), 0.168, 1e-12)
  assertEquals(verifyFit(fitRigid2D(pairVisit.taps, storedPoints.slice(0, 2))).compared, 'nothing')
})


// ── What the capture flow, the status line and the chip read from a check (WP-04b) ──────────────────

Deno.test('formatCm: one decimal below a metre, whole centimetres above it, so 17.0 against 16.8 never reads as 17 against 17', () => {
  assertEquals([formatCm(0.168), formatCm(0.17), formatCm(0.0004), formatCm(2.5), formatCm(-0.03), formatCm(0)], ['16.8', '17.0', '0.0', '250', '-3.0', '0.0'])
  for (const metres of [0.0123, 0.305, 0.5, 0.99, 1, 1.234, 5.5, -1.5]) assertEquals(formatCm(metres), formatCmForTest(metres), `${metres}`)
})

Deno.test('NOT_CHECKED_SPOTS: the limit every verified verdict states, as one exported sentence', () => {
  assertEquals(NOT_CHECKED_SPOTS, 'Not checked: that these are the same physical spots. Compare with the photos.')
  assert(verdict().reasons.includes(NOT_CHECKED_SPOTS))
  assert(verifyTwoPoint({ separationM: 3, storedSeparationM: 3 }).reasons.includes(NOT_CHECKED_SPOTS))
})

Deno.test('residualsPastGates: the gates of a verdict, recovered from the tolerance a scan keeps beside its fit', () => {
  // The tolerance written beside a fit is twice the rms gate at the tap noise the verdict used, so the verdict's two gates follow from it
  // alone, and the answer is the verdict's own: past a gate exactly when the verdict was a mismatch.
  for (const sigma of [0.005, 0.03, 0.05, 0.1, 0.3]) {
    const tolerance = twoPointToleranceM(sigma)
    const gate = RMS_GATE_SIGMAS * Math.min(sigma, MAX_SIGMA_HAT_M)
    for (const rms of [0, 0.01, gate * 0.5, gate, gate * (1 + 1e-9), gate * 1.5, 0.3]) {
      for (const max of [rms, rms * 1.5, rms * MAX_GATE_FACTOR, rms * MAX_GATE_FACTOR * (1 + 1e-9), rms + 0.1]) {
        const v = verifyConstellation({ pointsUsed: 3, rmsResidualM: rms, maxResidualM: max, sigmaHatM: sigma })
        assertEquals(residualsPastGates(rms, max, tolerance), v.status === 'mismatch', `sigma ${sigma}, rms ${rms}, max ${max}`)
      }
    }
  }
  // Both gates are inclusive: exactly at the gate is not past it.
  const tolerance = twoPointToleranceM(SIGMA0_M)
  const gate = tolerance / 2
  assertEquals(gate, GATE)
  assertEquals(residualsPastGates(gate, gate, tolerance), false)
  assertEquals(residualsPastGates(gate, MAX_GATE_FACTOR * gate, tolerance), false)
  assertEquals(residualsPastGates(gate * (1 + 1e-9), gate * (1 + 1e-9), tolerance), true, 'the rms gate')
  assertEquals(residualsPastGates(gate, MAX_GATE_FACTOR * gate * (1 + 1e-9), tolerance), true, 'the worst-point gate')
})

Deno.test('residualsPastGates: a figure that is not a number is not a failure', () => {
  const tolerance = twoPointToleranceM(SIGMA0_M)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number, null as unknown as number, '0.1' as unknown as number]) {
    assertEquals(residualsPastGates(bad, 0.01, tolerance), false, `rms ${bad}`)
    assertEquals(residualsPastGates(0.01, bad, tolerance), false, `max ${bad}`)
    assertEquals(residualsPastGates(0.5, 0.5, bad), false, `tolerance ${bad}`)
  }
})

Deno.test('estimateSentence: one sentence for the accuracy estimate, in the verdict that withholds on it and in the guidance beside the points', () => {
  assertEquals(estimateSentence(0.305), 'Estimate: two scans would place a spot 5 m away up to about 30.5 cm apart (95 of 100 times)')
  assertEquals(estimateSentence(1.234), 'Estimate: two scans would place a spot 5 m away up to about 123 cm apart (95 of 100 times)')
  const v = verdict({ expectedErrorM: 0.4 })
  assert(v.reasons.includes(`${estimateSentence(0.4)}, more than the ${formatCm(ACCURACY_TARGET_M)} cm aimed for.`), v.reasons.join(' | '))
})

Deno.test('withheld: only a provisional verdict that passed has it, and it is the part of its reasons that stands in the way of "verified"', () => {
  // No verdict that is verified, a mismatch, or without a comparison carries the field at all: absent, not an empty list.
  const verified = verdict()
  const mismatch = verdict({ rmsResidualM: 0.3, maxResidualM: 0.3 })
  const nothing = verifyConstellation({ pointsUsed: 1, rmsResidualM: 0, maxResidualM: 0, sigmaHatM: SIGMA0_M })
  assertEquals([verified.status, mismatch.status, nothing.status], ['verified', 'mismatch', 'provisional'])
  for (const v of [verified, mismatch, nothing]) assertEquals('withheld' in v, false, v.status)
  const steadyPair = verifyTwoPoint({ separationM: 3, storedSeparationM: 3.01 })
  assertEquals(['provisional', 'separation', 'distance', false], [steadyPair.status, steadyPair.checkedBy, steadyPair.compared, 'withheld' in steadyPair])

  // Each cause alone: the verdict is provisional, and withheld is that cause's sentence and only it.
  const causes: Array<[string, Parameters<typeof verdict>[0], string[]]> = [
    ['taps too unsteady', { sigmaHatM: 0.12 }, ['Taps vary by 12.0 cm between tries: too much to check the points.']],
    ['heights beyond their gate', { heightRmsResidualM: 0.2 }, ['Heights are 20.0 cm off on average (limit 8.4 cm).']],
    ['a size change fitted to too few points', { fitMethod: 'similarity' }, ['Fitting a size change to 3 points leaves too little to check them: at least 4 are needed.']],
    [
      'another order that fits as well',
      { alternativeOrder: { rmsM: 0.01, swapsFirstTwo: false } },
      ['The points also fit in another order, so the order they were tapped in is not checked.'],
    ],
    ['a shape too weak for the accuracy aimed for', { expectedErrorM: 0.4 }, [`${estimateSentence(0.4)}, more than the 30.5 cm aimed for.`]],
  ]
  for (const [name, overrides, expected] of causes) {
    const v = verdict(overrides)
    assertEquals([v.status, v.checkedBy, v.compared], ['provisional', 'constellation', 'points'], name)
    assert(v.status === 'provisional' && v.withheld !== undefined, name)
    assertEquals(v.withheld, expected, name)
    for (const line of v.withheld) assert(v.reasons.includes(line), `${name}: ${line} is also in reasons`)
    // What agreed is still reported ahead of what stands in the way. The gates are held at the cap for taps beyond it: 28.0 cm, not 8.4.
    assertEquals(v.reasons[0], `3 points are 4.0 cm off the stored ones on average (limit ${name === 'taps too unsteady' ? '28.0' : '8.4'} cm).`, name)
  }

  // Several at once: all of them, in one order, straight after the lines that say what was checked.
  const several = verdict({
    sigmaHatM: 0.12,
    heightRmsResidualM: 0.5,
    fitMethod: 'similarity',
    alternativeOrder: { rmsM: 0.01, swapsFirstTwo: false },
    expectedErrorM: 0.4,
  })
  assert(several.status === 'provisional' && several.withheld !== undefined)
  assertEquals(several.withheld.length, 5)
  assert(/^Taps vary/.test(several.withheld[0]!) && /^Heights are/.test(several.withheld[1]!) && /^Fitting a size change/.test(several.withheld[2]!))
  assert(/^The points also fit in another order/.test(several.withheld[3]!) && /^Estimate/.test(several.withheld[4]!))
  const start = several.reasons.indexOf(several.withheld[0]!)
  assertEquals(several.reasons.slice(start, start + 5), several.withheld)
  assertEquals(several.reasons.slice(0, start).length, 2, 'the two gate lines come first')

  // A pair that was steady has nothing withheld; one whose taps were not has that, and only that: the missing third point is the
  // nature of a pair and is not a reason it was held back.
  const unsteadyPair = verifyTwoPoint({ separationM: 3, storedSeparationM: 3.01, sigmaHatM: 0.2 })
  assert(unsteadyPair.status === 'provisional' && unsteadyPair.withheld !== undefined)
  assertEquals(unsteadyPair.withheld, ['Taps vary by 20.0 cm between tries: too much to check the points.'])
  assert(unsteadyPair.reasons.includes('Direction was not checked: a third point is needed.'))
  assert(!unsteadyPair.withheld.includes('Direction was not checked: a third point is needed.'))
})
