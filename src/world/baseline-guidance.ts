/**
 * Placement guidance: where the calibration points should be, and what their placement is worth.
 *
 * Pure, and Deno-free because the browser imports it (ADR 0002). The copy lives here, beside the
 * numbers it quotes, so it can be tested without a DOM and each claim sits next to the reason it
 * is true. `src/ar/project-calibration.ts` calls it from its separation line and its heading step.
 *
 * ## Why the walk matters
 *
 * A visit builds its frame from the points it taps: the landmark L, which becomes the origin, the heading
 * marker H, whose direction from L becomes the frame's +Z, and, when there is one, a check point C. Each tap
 * lands within some distance of the feature along each floor axis, and what that does to the frame is the
 * prediction `frameUncertaintyAt` makes (src/world/frame-fit.ts): how far apart two visits' scans of a spot
 * 5 m away may land, for the shape these points make. It falls as the points spread out. Doubling the baseline
 * roughly halves the part that grows with distance, which is nearly all of it at room scale, and a point off the
 * line between L and H adds the width that a line has none of. The line on screen says "estimate" because the
 * tap noise behind it is adopted, not measured (`TAP_SIGMA0_M`), and it counts tap noise only: a tap on the wrong
 * feature, a unit error or a tracking shift are not in it.
 *
 * It replaced `sessionDisagreementM` (WP-04b), which gave the same quantity for two points alone, as a root-mean-
 * square from a closed form fitted to the investigation's simulation. `frameUncertaintyAt` is that prediction for
 * any number of points, with the 95th percentile the product target is set against, and it is held to simulated
 * visit pairs in tests/unit/deno/frame_fit.test.ts.
 *
 * ## A return visit does not choose its walk
 *
 * The walk is the person's to choose only while a pair is being made. On a return visit to a Place that
 * stores a two-point frame, the pair has to be the stored one again: `commitTwoPoint` in
 * `src/ar/project-calibration.ts` sends a pair whose length is more than the spacing tolerance from the stored
 * `separationM` to the mismatch screen, and its way out ("Use anyway") replaces the Place's frame. So there
 * the copy names the stored pair and its length, and never says to walk farther: a person who did what a
 * first visit is told would land on that screen. The estimate on a return visit is for the stored pair's shape,
 * which is the one the visit has to reproduce.
 *
 * ## The check point
 *
 * A third point is what lets a later visit compare the shape the points make, and not only how far apart two of
 * them are (it still cannot say they are the same physical spots: that is named beside every comparison). The
 * guidance for it says how far it is from L and from the line through L and H, and what the three points together
 * are worth. Where it should be is `RECOMMENDED_CHECK_DISTANCE_M` and `RECOMMENDED_CHECK_OFFSET_M`; the floor under
 * that, below which the fit cannot use it, is the fit's own (`referenceProblem`). It also says when the shape is one a
 * later visit could not check the order of: three points whose distances are nearly equal fit in another order as
 * well (frame-fit.ts, "At the first calibration"), and a visit to such a Place is never better than provisional.
 *
 * A return visit does not choose its check point either. It re-taps the one the Place stores, so the advice to move it
 * (farther from A, farther off the line, to make the three distances differ) is advice to tap the wrong feature, and
 * the commit would turn the result away as a mismatch. Given the Place's stored points the guidance keeps where the
 * tapped point is, quotes the estimate for the stored shape (that is the shape the fit compares with), and says no more.
 */
import {
  DUPLICATE_POINT_GAP_M,
  MAX_SIGMA_HAT_M,
  RMS_GATE_SIGMAS,
  SIGMA0_M,
  WORKING_RADIUS_M,
  estimateSentence,
  fitRigid2D,
  frameUncertaintyAt,
  referenceProblem,
} from './frame-fit.ts'
import { MIN_POINT_SEPARATION_M } from './geo.ts'
import type { Vec3 } from './types.ts'

/**
 * The tap noise the estimate assumes, in metres, along each floor axis: 3 cm.
 *
 * **This is adopted, not measured (ADR 0005 rule 5).** It is the figure `MIN_POINT_SEPARATION_M` in
 * `src/world/geo.ts` is already reasoned from, and nobody has measured a tap on a device: the benchmark
 * that would (wave 09 ticket 0006) was closed without being run. Every number this file prints scales
 * with it, which is why the line on screen says "estimate" and not "expected".
 *
 * **Revisit when:** the tape test (DX1) or the repeat-tap benchmark (DX2) gives a spread. Then replace this
 * with the measured sigma.
 */
export const TAP_SIGMA0_M = SIGMA0_M

/**
 * The baseline the copy recommends, in metres. Owner decision D2: keep the 1.0 m hard minimum
 * (`MIN_POINT_SEPARATION_M`, which still blocks the commit) and tell the person to walk 3 m or more.
 *
 * **This is adopted, not measured (ADR 0005 rule 5).** At `TAP_SIGMA0_M` the simulation puts two scans of a
 * point 5 m out at 7 / 20 cm (median / 95th percentile) with a 3 m baseline, against 20 / 56 cm with 1 m,
 * and the product target is 0.305 m (docs/product/PLACE_SCAN_DESIGN.md). The 3 is a recommendation read off
 * that table, not a threshold anybody measured; a small room may not have 3 m of floor to walk.
 */
export const RECOMMENDED_BASELINE_M = 3

/**
 * How far from the landmark the copy recommends the check point be, in metres.
 *
 * **Adopted from the design brief (WP-04b), not measured (ADR 0005 rule 5).** The simulations behind the
 * constellation fit put the check point about 4 m from L and 2.8 m off the line, and the brief asks for at least
 * 3 m from L. The hard floor under it is not this number but the fit's (`referenceProblem`): a point closer to
 * another than `DUPLICATE_POINT_GAP_M`, or on the line, cannot be used at all.
 *
 * **Revisit when:** DX2 probes a point D with the constellation A, B, C and the p95 error at D is known for
 * more than one shape.
 */
export const RECOMMENDED_CHECK_DISTANCE_M = 3

/**
 * How far to the side of the line through L and H the copy recommends the check point be, in metres.
 *
 * **Adopted from the design brief (WP-04b), not measured (ADR 0005 rule 5):** at least 2 m off the line. A point on
 * the line adds nothing the pair did not have, and the further to the side it is, the better the three
 * constrain the turn of the frame.
 */
export const RECOMMENDED_CHECK_OFFSET_M = 2

const usable = (metres: number | null | undefined): metres is number =>
  typeof metres === 'number' && Number.isFinite(metres) && metres > 0

/** A distance in whole centimetres, or in metres to one place from 1 m up. */
function describeOffset(metres: number): string {
  return metres >= 1 ? `${metres.toFixed(1)} m` : `${Math.round(metres * 100)} cm`
}

/**
 * The estimate sentence for these points, or null when the points have no shape to predict from (one spot, or a
 * value that is not a number). It is the sentence a verdict uses when it withholds "verified" for a weak shape,
 * so the figure shown while placing is the figure that decides it.
 */
function estimateFor(points: readonly Vec3[], sigmaM: number): string | null {
  const prediction = frameUncertaintyAt(points, sigmaM, WORKING_RADIUS_M)
  return prediction ? estimateSentence(prediction.position95M) : null
}

export interface BaselineGuidance {
  /** `'short'` is under the hard minimum (or a check point the fit cannot use) and cannot be committed; `'ok'` can. The modal colours by it. */
  state: 'ok' | 'short'
  text: string
}

/**
 * The line under the two markers while they are placed: how far apart they are, and, once they are
 * far enough apart to commit, what that is worth.
 *
 * `storedSeparationM` is the Place's saved pair on a return visit. It does three things. The estimate is for the
 * stored pair's shape, which is the one the visit has to reproduce; the line says how long the stored pair is,
 * which is the length to match; and the line does not advise a longer walk, because on a return visit a
 * longer walk is a pair the commit turns away (see "A return visit does not choose its walk" above). The
 * short line is the one the modal has always shown, and it is the same on a return visit: the hard
 * minimum stops the commit whatever is stored.
 *
 * `storedShape` is the Place's stored points when the visit is about to re-tap a stored check point (the landmark, the
 * heading marker and the check point, in the Place frame): the estimate is then for that shape, which is the one the
 * fit compares with, and not for the pair alone. Only used on a return visit.
 */
export function baselineGuidance(
  separationM: number,
  storedSeparationM?: number | null,
  sigmaM: number = TAP_SIGMA0_M,
  storedShape?: readonly Vec3[] | null,
): BaselineGuidance {
  const apart = `${separationM.toFixed(2)} m apart`
  if (!(separationM >= MIN_POINT_SEPARATION_M)) {
    return {
      state: 'short',
      text: `${apart} — need at least ${MIN_POINT_SEPARATION_M.toFixed(1)} m. Walk further and tap again.`,
    }
  }
  const shapeM = usable(storedSeparationM) ? storedSeparationM : separationM
  const shape = usable(storedSeparationM) && storedShape && storedShape.length >= 2
    ? storedShape
    : [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: shapeM }]
  const estimate = estimateFor(shape, sigmaM)
  const sentence = estimate === null ? '' : ` ${estimate}.`
  if (usable(storedSeparationM)) return { state: 'ok', text: `${apart}. Stored pair: ${storedSeparationM.toFixed(2)} m.${sentence}` }
  const advice = separationM < RECOMMENDED_BASELINE_M ? ` ${RECOMMENDED_BASELINE_M} m or more is better.` : ''
  return { state: 'ok', text: `${apart}.${sentence}${advice}` }
}

/** Where a check point sits relative to the pair, on the floor, in metres. */
export interface CheckGeometry {
  /** From the landmark to the check point. */
  distanceM: number
  /** From the check point to the straight line through the landmark and the heading marker. */
  offLineM: number
}

/**
 * Where a check point is relative to the pair, or null when that is not defined: a value that is not a number, or a
 * heading marker on the landmark (no line to measure from). Heights are not used.
 */
export function checkGeometry(landmark: Vec3, headingMarker: Vec3, check: Vec3): CheckGeometry | null {
  const baseX = headingMarker.x - landmark.x
  const baseZ = headingMarker.z - landmark.z
  const toX = check.x - landmark.x
  const toZ = check.z - landmark.z
  const length = Math.hypot(baseX, baseZ)
  if (![baseX, baseZ, toX, toZ].every(Number.isFinite) || !(length > 0)) return null
  return { distanceM: Math.hypot(toX, toZ), offLineM: Math.abs(baseX * toZ - baseZ * toX) / length }
}

/**
 * The line under the markers once there is a check point: where it is, whether the fit can use it, and what the three
 * points are worth. `'short'` when the fit cannot use it (it is closer to another point than
 * `DUPLICATE_POINT_GAP_M`, or the three are almost on one line), and the commit is then not offered; below the
 * recommended distance or width it is `'ok'` and says what is better.
 *
 * `stored` is the Place's stored landmark, heading marker and check point when this visit is re-tapping them (a return
 * visit to a Place that has a check point). The point is then not the person's to place: the estimate is the stored
 * shape's, and neither the advice to move it nor the remark about the order of the points is given (see "A return visit
 * does not choose its walk"). Where the tapped point is, and when the fit cannot use it, are still said.
 */
export function checkPointGuidance(
  landmark: Vec3,
  headingMarker: Vec3,
  check: Vec3,
  sigmaM: number = TAP_SIGMA0_M,
  stored?: readonly Vec3[] | null,
): BaselineGuidance {
  const geometry = checkGeometry(landmark, headingMarker, check)
  const where = geometry === null
    ? 'Point C is placed.'
    : `Point C: ${describeOffset(geometry.distanceM)} from A, ${describeOffset(geometry.offLineM)} off the A–B line.`
  const problem = referenceProblem([landmark, headingMarker, check])
  if (problem?.reason === 'duplicate-points') {
    // The points are [A, B, C], so index 2 is the check point and the other index names what it is too close to.
    const closeTo = problem.indices.includes(2) ? problem.indices.find((index) => index !== 2) : undefined
    const name = closeTo === 0 ? 'point A' : closeTo === 1 ? 'point B' : 'another point'
    return {
      state: 'short',
      text: `Point C is only ${describeOffset(problem.gapM)} from ${name}. ` +
        `Choose a feature at least ${describeOffset(DUPLICATE_POINT_GAP_M)} away.`,
    }
  }
  if (problem?.reason === 'collinear') {
    return {
      state: 'short',
      text: `${where} The three points are almost on one line (${describeOffset(problem.offsetM)} off it): ` +
        `they need at least ${describeOffset(problem.requiredOffsetM)}. Move point C to the side.`,
    }
  }
  if (problem) return { state: 'short', text: `${where} The fit cannot use these points.` }
  // A return visit re-taps the Place's stored point: the estimate is for the stored shape, and there is nothing to advise.
  const returning = !!stored && stored.length >= 3
  const farEnough = geometry !== null && geometry.distanceM >= RECOMMENDED_CHECK_DISTANCE_M &&
    geometry.offLineM >= RECOMMENDED_CHECK_OFFSET_M
  const advice = farEnough || returning
    ? ''
    : ` At least ${RECOMMENDED_CHECK_DISTANCE_M} m from A and ${RECOMMENDED_CHECK_OFFSET_M} m off the line is better.`
  const shape = returning ? stored.slice(0, 3) : [landmark, headingMarker, check]
  const estimate = estimateFor(shape, sigmaM)
  const lopsided = returning || orderCanBeChecked(shape, sigmaM)
    ? ''
    : ' These points also fit in another order, so a later visit could not check the order they are tapped in. ' +
      'Move point C so the three distances differ.'
  return { state: 'ok', text: `${where}${estimate === null ? '' : ` ${estimate}.`}${advice}${lopsided}` }
}

/**
 * Whether a visit could tell these points from the same points taken in another order: false for a shape such as an
 * equilateral triangle, which fits itself turned (the best other order leaves no more than the gate a visit is judged
 * by). Judged by the fit of the points to themselves, as frame-fit.ts's header asks the first calibration to do.
 */
function orderCanBeChecked(points: readonly Vec3[], sigmaM: number): boolean {
  const outcome = fitRigid2D(points, points)
  // A shape that is its own mirror image (an isosceles triangle) comes back as "mirrored", with the order search attached.
  const other = outcome.ok
    ? outcome.fit.alternativeOrder
    : outcome.failure.reason === 'mirrored'
      ? outcome.failure.alternativeOrder
      : null
  if (!other || !Number.isFinite(other.rmsM)) return true
  return other.rmsM > RMS_GATE_SIGMAS * Math.min(sigmaM, MAX_SIGMA_HAT_M)
}

/**
 * "Step 2 of 3 — ": where the person is in the taps this visit asks for. `total` is 3 when the check point follows the
 * heading marker by itself (a first calibration, or a return visit to a Place that stores one) and 2 for a visit that
 * takes the two markers and no more, so the count is the one the progress dots show. `note` goes in brackets after the
 * count ("Step 3 of 3 (optional) — ").
 */
export function stepPrefix(step: number, total: number, note?: string): string {
  return `Step ${step} of ${total}${note ? ` (${note})` : ''} — `
}

/** The landmark step's instruction. `totalSteps` is what {@link stepPrefix} counts to. */
export function landmarkStepCopy(totalSteps: number = 2): string {
  return `${stepPrefix(1, totalSteps)}tap the ground at a permanent feature you will recognise next visit, such as a door frame ` +
    "or a wall corner. This becomes the project's origin."
}

/**
 * The heading step's instruction.
 *
 * While a pair is being made it says to walk `RECOMMENDED_BASELINE_M` or more, because the hard minimum is
 * what the commit enforces, not what the person should aim for. On a return visit (`storedSeparationM` is the
 * Place's stored pair) it says to tap last time's heading marker, and how far that is from the landmark, because
 * that is the pair the commit compares with. `totalSteps` is what {@link stepPrefix} counts to.
 */
export function headingStepCopy(storedSeparationM?: number | null, totalSteps: number = 2): string {
  if (usable(storedSeparationM)) {
    return `${stepPrefix(2, totalSteps)}tap the heading marker from last time, about ${storedSeparationM.toFixed(1)} m from the landmark. `
      + 'Their direction sets the heading.'
  }
  return `${stepPrefix(2, totalSteps)}walk ${RECOMMENDED_BASELINE_M} m or more from the landmark, then tap a second ground feature. `
    + 'Longer is more accurate; their direction sets the heading.'
}
