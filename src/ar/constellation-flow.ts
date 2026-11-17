/**
 * The constellation flow (WP-04b): what a third point adds to the calibration, as pure functions.
 *
 * A Place's frame is its landmark L and heading marker H, and, when the first calibration took one, a check point C
 * (`ProjectSpatialFrame.checkPoints`). A return visit that taps all three is compared with the stored ones by a least-
 * squares fit (`fitRigid2D` in src/world/frame-fit.ts), and `fit.matrix` IS that visit's `sessionToProject`. A visit
 * that taps two is compared by the distance between them, as before, and is never better than provisional. This module
 * decides which of the two a visit gets, builds what the card draws for it, and says what the stage list and the one
 * check-point button should show; the DOM, the scene and the commit's records stay where they were
 * (./project-calibration.ts, ./calibration-commit.ts, ./constellation-ghosts.ts).
 *
 * Pure: no DOM, no Deno, no three.js, no clock (ADR 0002, and the purity scan in
 * tests/unit/node/wp-constellation-flow.test.ts).
 *
 * ## A check point is never added to an existing frame
 *
 * It would be expressed through that visit's own two-point frame, which disagrees with another visit's by about 20 cm
 * (median) and 56 cm (95th percentile) at 5 m with a 1 m baseline, and that error would be frozen into the reference
 * every later visit is measured against. So `planCheckPoint` offers the step on a first calibration (and where a one-
 * point frame is being replaced), and on a return visit only to a Place that already stores one, to re-tap it. A Place
 * with a two-point frame and no check point stays that way until its reference is re-established in one session (WP-08's
 * generation flow).
 *
 * ## Heights
 *
 * The fit compares heights as it compares positions (`FrameFit.heightRmsResidualM`), so it is given the heights the
 * points were tapped at. The card draws the heading marker and the check point at the landmark's height, so that the
 * baseline is level (`applyTap` in the modal); those drawn heights are not what was measured, and the fit would find
 * every height in agreement for no reason but that. The caller passes the tapped points to {@link compareVisit} and the
 * drawn ones to {@link ghostPlan}.
 *
 * ## The switch
 *
 * {@link CHECK_POINT_DEFAULT_ON} is the owner decision "check point on by default at first calibration" (recommended:
 * on, skippable). Off, the step is not entered by itself after the heading marker; the review step still offers it.
 */
import { invertAffine } from '../world/anchor-placement.ts'
import { checkGeometry, type CheckGeometry } from '../world/baseline-guidance.ts'
import { transformPoint, twoPointSeparationM, twoPointToProjectTransform } from '../world/geo.ts'
import {
  fitRigid2D,
  referenceProblem,
  twoPointToleranceM,
  verifyFit,
  verifyTwoPoint,
  type ConstellationVerdict,
  type FitFailure,
  type FrameFit,
  type UnitsMode,
} from '../world/frame-fit.ts'
import type { CheckedBy } from '../world/calibration-evidence.ts'
import type { FrameCheckPoint, Vec3 } from '../world/types.ts'
import type { TwoPointFrame } from './calibration-commit.ts'
import type { CalibrationStage } from './one-point-offer.ts'
import { ADD_CHECK_LABEL, CHECK_RETURN_TITLE, REMOVE_CHECK_LABEL, SKIP_CHECK_LABEL } from './constellation-copy.ts'

/**
 * Whether the check-point step opens by itself after the heading marker on a first calibration.
 *
 * **Owner decision, not yet made (WP-04b, "check point default-on at first calibration"): this is the brief's
 * recommended option.** It costs the person a third tap, a photo and a name, and the step says it can be skipped. Set
 * it to `false` and the step is left to the review step's "Add a check point" button.
 */
export const CHECK_POINT_DEFAULT_ON = true

// ── The check point's place in the flow ──────────────────────────────────────────────────────────────

export interface CheckPlan {
  /** Whether this visit can take a check point at all. */
  offered: boolean
  /** Whether the step opens by itself after the heading marker. */
  automatic: boolean
  /** The Place's stored check point this visit re-taps, or null on a first calibration. */
  stored: FrameCheckPoint | null
}

/**
 * How many taps this visit asks for, as the steps' counters count them: 3 when the check point follows the heading marker by
 * itself, 2 otherwise. It is what the progress dots show (the check dot is hidden for a visit that is not offered one), and a
 * check point that is only offered from review is not a step the counters promise.
 */
export function stepsInVisit(plan: CheckPlan): 2 | 3 {
  return plan.offered && plan.automatic ? 3 : 2
}

const isFinitePoint = (point: unknown): point is Vec3 => {
  const p = point as Partial<Vec3> | null | undefined
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

/**
 * The stored check points a fit can use: the leading run of points that are numbers, in the order the frame holds them.
 * A point that is not (a damaged record) ends the run, because the fit matches points by their position in the list.
 */
function usableCheckPoints(frame: TwoPointFrame): FrameCheckPoint[] {
  const points = Array.isArray(frame.checkPoints) ? frame.checkPoints : []
  const run: FrameCheckPoint[] = []
  for (const point of points) {
    if (!isFinitePoint(point)) break
    run.push(point)
  }
  return run
}

/**
 * What a visit does about the check point. `stored` is the Place's two-point frame, or null for a first calibration (and
 * for a Place whose frame is a one-point one, which this visit replaces).
 */
export function planCheckPoint(stored: TwoPointFrame | null, defaultOn: boolean = CHECK_POINT_DEFAULT_ON): CheckPlan {
  if (!stored) return { offered: true, automatic: defaultOn, stored: null }
  const first = usableCheckPoints(stored)[0] ?? null
  // The Place has one: this visit re-taps it, whatever the default says, because that re-tap is the check. A Place without one
  // is not offered one: see "A check point is never added to an existing frame".
  return first ? { offered: true, automatic: true, stored: first } : { offered: false, automatic: false, stored: null }
}

/**
 * The points a visit's taps are matched to, in the Place frame and in the order the fit takes them: the landmark, the
 * heading marker, then the check points. Null when the landmark or the heading marker is not a point (a record that
 * is damaged); nothing is then compared but the distance.
 */
export function storedPoints(frame: TwoPointFrame): Vec3[] | null {
  const points: unknown[] = [frame.landmark, frame.headingMarker, ...usableCheckPoints(frame)]
  if (!points.every(isFinitePoint)) return null
  return (points as Vec3[]).map((point) => ({ x: point.x, y: point.y, z: point.z }))
}

/**
 * The points a visit that re-taps the Place's check point is compared with: the landmark, the heading marker and the first check
 * point, in the Place frame. Null when the Place stores no check point (or its record is damaged), which is a visit compared by distance.
 */
export function comparedPoints(frame: TwoPointFrame | null): Vec3[] | null {
  if (!frame || !planCheckPoint(frame).stored) return null
  const points = storedPoints(frame)
  return points && points.length >= 3 ? points.slice(0, 3) : null
}

// ── Comparing a visit with the stored points ─────────────────────────────────────────────────────────

/** The points one visit placed, in the session frame. `checkPoint` is null when it took none. */
export interface VisitPoints {
  landmark: Vec3
  headingMarker: Vec3
  checkPoint: Vec3 | null
}

export interface CompareInput {
  /** The points as they were tapped, with the heights they were tapped at (see "Heights"). */
  tapped: VisitPoints
  /** The Place's two-point frame. */
  stored: TwoPointFrame
  /** Tap noise per floor axis, metres. `TAP_SIGMA0_M` until DX2 measures it. */
  sigmaHatM: number
  /** What the phone's session units are, when the provider says: the verdict then names what sizes do not prove. */
  unitsMode?: UnitsMode
}

export interface VisitComparison {
  /** What the comparison came to: the verdict `verifyFit` or `verifyTwoPoint` gave. */
  verdict: ConstellationVerdict
  /** The check the verdict rests on: `'constellation'` for a fit of three or more points, `'separation'` for the distance. */
  checkedBy: CheckedBy
  /** The fit, when three or more points were fitted and the fit could be made. Null for a comparison of distance, and for a visit whose points did not fit at all. */
  fit: FrameFit | null
  /** This visit's `sessionToProject`: the fit's matrix when there is one, else the two-point transform. */
  sessionToProject: number[]
  /** This visit's landmark-to-marker distance, metres. */
  separationM: number
  /** This visit's distance minus the stored one, metres. */
  residualM: number
  /** The spacing tolerance the distance check applies, metres: `twoPointToleranceM`. */
  toleranceM: number
  /** Why the check point was tapped and not compared, when the stored points could not serve as a reference. Absent otherwise. */
  uncompared?: string
}

/**
 * Compares a visit's taps with the Place's stored points.
 *
 * Three points tapped against a stored frame with a check point are fitted (`fitRigid2D`) and judged by `verifyFit`:
 * `'verified'` only when the positions and heights agree within the gates and nothing in the way. Two points, or a
 * Place with no check point, are judged by the distance between them (`verifyTwoPoint`), which is never `'verified'`.
 * A fit that could not be made because the stored points cannot serve as a reference (two of them on one spot, all on
 * one line) compared nothing, and the visit falls back to the distance, saying so in `uncompared`: that is not a result
 * (frame-fit.ts, "What to store"). A fit of points that do not agree (a mirrored visit, one no turn and shift lines up)
 * is a result, a mismatch.
 */
export function compareVisit(input: CompareInput): VisitComparison {
  const { tapped, stored, sigmaHatM, unitsMode } = input
  const separationM = twoPointSeparationM(tapped.landmark, tapped.headingMarker)
  const residualM = separationM - stored.separationM
  const toleranceM = twoPointToleranceM(sigmaHatM)
  const twoPoint = twoPointToProjectTransform(tapped.landmark, tapped.headingMarker)

  const reference = storedPoints(stored)
  let uncompared: string | undefined
  if (tapped.checkPoint && reference && reference.length >= 3) {
    const outcome = fitRigid2D([tapped.landmark, tapped.headingMarker, tapped.checkPoint], reference.slice(0, 3))
    const verdict = verifyFit(outcome, { sigmaHatM, unitsMode })
    if (verdict.compared !== 'nothing') {
      return {
        verdict,
        checkedBy: verdict.checkedBy,
        fit: outcome.ok ? outcome.fit : null,
        sessionToProject: outcome.ok ? outcome.fit.matrix : twoPoint,
        separationM,
        residualM,
        toleranceM,
      }
    }
    uncompared = verdict.reasons[0]
  }
  return {
    verdict: verifyTwoPoint({ separationM, storedSeparationM: stored.separationM, sigmaHatM, unitsMode }),
    checkedBy: 'separation',
    fit: null,
    sessionToProject: twoPoint,
    separationM,
    residualM,
    toleranceM,
    ...(uncompared ? { uncompared } : {}),
  }
}

// ── A check point for a new frame ────────────────────────────────────────────────────────────────────

export interface NewReference {
  /** The check point in the Place frame the new frame stores, or null when none was taken or it cannot be used. */
  checkPoint: Vec3 | null
  /** Why the points cannot serve as a reference, when a check point was taken and cannot. Null otherwise. */
  problem: FitFailure | null
}

/**
 * The check point a new frame stores (a first calibration, a one-point frame replaced, or a mismatch kept over): the
 * tap carried into the frame this visit's landmark and heading marker define, with its own height above the landmark's.
 * Refused, with the fit's reason, when the three points could not be used as a reference.
 */
export function newReference(landmark: Vec3, headingMarker: Vec3, checkPoint: Vec3 | null): NewReference {
  if (!checkPoint) return { checkPoint: null, problem: null }
  const problem = referenceProblem([landmark, headingMarker, checkPoint])
  if (problem) return { checkPoint: null, problem }
  const placed = transformPoint(twoPointToProjectTransform(landmark, headingMarker), checkPoint)
  return { checkPoint: { x: placed.x, y: placed.y, z: placed.z }, problem: null }
}

/** Where the check point is relative to the pair, and whether the fit can use it: what the guidance line quotes. */
export function checkPointState(
  landmark: Vec3,
  headingMarker: Vec3,
  checkPoint: Vec3,
): { geometry: CheckGeometry | null; problem: FitFailure | null } {
  return {
    geometry: checkGeometry(landmark, headingMarker, checkPoint),
    problem: referenceProblem([landmark, headingMarker, checkPoint]),
  }
}

// ── Ghosts: the stored points, drawn where this visit puts them ──────────────────────────────────────

export interface GhostPoint {
  role: 'landmark' | 'heading' | 'check'
  /** Where this visit's marker is drawn, session frame. */
  tap: Vec3
  /** Where the stored point lands in this session's frame: `transformPoint(invertAffine(sessionToProject), stored)`, at the marker's drawn height. */
  ghost: Vec3
  /**
   * The distance between the two on the floor, metres: the fit's residual for this point. Null when the visit was
   * compared by distance, which has no residual for a single point. For a visit whose three points could not be fitted at
   * all (a check point on the wrong side, the pair in the other order) the check point's is its gap from where the frame the
   * pair itself defines puts it, and the pair's are null.
   */
  residualM: number | null
}

const ROLES = ['landmark', 'heading', 'check'] as const

/**
 * The ghosts to draw for a visit: one per point compared, at the stored point carried into this session through the
 * inverse of the visit's own `sessionToProject`. For a fit that is `invertAffine(fit.matrix)`, and for a pair the stored
 * landmark lands on the landmark tapped and the stored heading marker at the stored distance along the baseline,
 * which is what the card drew before there was a fit. Three points that could not be fitted at all (a check point on the
 * wrong side, the pair tapped the other way round) have no fit to invert, and are drawn through the frame the pair makes, as
 * a pair is: the check point's ghost then shows where the pair says it should be, across the line from where it was tapped.
 * Empty when the matrix cannot be inverted or the frame has no points to draw.
 */
export function ghostPlan(input: { drawn: VisitPoints; stored: TwoPointFrame; comparison: VisitComparison }): GhostPoint[] {
  const { drawn, stored, comparison } = input
  const reference = storedPoints(stored)
  const inverse = invertAffine(comparison.sessionToProject)
  if (!reference || !inverse) return []
  const unfitted = !comparison.fit && comparison.checkedBy === 'constellation'
  const count = comparison.fit ? comparison.fit.pointsUsed : unfitted ? 3 : 2
  const taps = [drawn.landmark, drawn.headingMarker, drawn.checkPoint]
  const ghosts: GhostPoint[] = []
  for (let index = 0; index < count && index < reference.length; index++) {
    const tap = taps[index]
    if (!tap) break
    const placed = transformPoint(inverse, reference[index]!)
    const gapM = comparison.fit
      ? comparison.fit.perPoint[index]?.residualM
      : unfitted && index === 2
        ? Math.hypot(tap.x - placed.x, tap.z - placed.z)
        : undefined
    ghosts.push({
      role: ROLES[index]!,
      tap,
      ghost: { x: placed.x, y: tap.y, z: placed.z },
      residualM: gapM ?? null,
    })
  }
  return ghosts
}

export interface VisitPreview {
  comparison: VisitComparison
  ghosts: GhostPoint[]
}

/**
 * The live comparison while the markers are adjusted: the verdict, the fit and the ghosts for the points placed so far,
 * or null when there is nothing to compare by position (no stored check point, or no check marker yet). Recomputed from the
 * markers on every redraw, so a point moved is a comparison redone.
 */
export function previewVisit(input: {
  tapped: VisitPoints
  drawn: VisitPoints
  stored: TwoPointFrame | null
  sigmaHatM: number
  unitsMode?: UnitsMode
}): VisitPreview | null {
  const { tapped, drawn, stored, sigmaHatM, unitsMode } = input
  if (!stored || !tapped.checkPoint || !drawn.checkPoint || !planCheckPoint(stored).stored) return null
  const comparison = compareVisit({ tapped, stored, sigmaHatM, unitsMode })
  return { comparison, ghosts: ghostPlan({ drawn, stored, comparison }) }
}

// ── The stage list and the check-point button ────────────────────────────────────────────────────────

export type StepState = 'active' | 'done' | 'todo' | 'skipped' | 'hidden'
export type StepName = 'ground' | 'landmark' | 'heading' | 'check'

const STEP_ORDER: readonly StepName[] = ['ground', 'landmark', 'heading', 'check']

/**
 * How each dot of the progress row reads. The step the person is on is the last marker placed: review and the mismatch
 * screen are the end of the placing, so they are on the heading marker's step until there is a check marker, and on
 * the check step once there is.
 *
 * The check dot is `'hidden'` for a visit that is not offered a check point, and for one that is offered it only from review
 * (`plan.automatic` false) until it is taken. For a visit that opens the step by itself it is `'todo'` until then, and
 * `'skipped'` once the placing is over without one: skipped, or taken away again. It is never left `'todo'` beside a card that
 * has moved on, which would promise a step that is not coming.
 */
export function stepStates(stage: CalibrationStage, plan: CheckPlan, hasCheck: boolean): Record<StepName, StepState> {
  const placed = stage === 'review' || stage === 'mismatch'
  const active: StepName = stage === 'ground'
    ? 'ground'
    : stage === 'landmark'
      ? 'landmark'
      : stage === 'check'
        ? 'check'
        : stage === 'heading'
          ? 'heading'
          : hasCheck
            ? 'check'
            : 'heading'
  const activeIndex = STEP_ORDER.indexOf(active)
  const states = {} as Record<StepName, StepState>
  STEP_ORDER.forEach((step, index) => {
    if (step === 'check' && !hasCheck && stage !== 'check') {
      states[step] = !plan.offered || !plan.automatic ? 'hidden' : placed ? 'skipped' : 'todo'
      return
    }
    states[step] = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo'
  })
  return states
}

export interface CheckAction {
  kind: 'skip' | 'add' | 'remove'
  label: string
}

/**
 * What the one check-point button does now, or null when it is not shown: skips the step while it is open, adds the
 * check point back from review when there is none, and takes a placed one away. It is never offered to a visit that
 * cannot take a check point, or on the mismatch screen, whose way back to the markers is its own button, and adding one is
 * not offered while the pair is under the minimum (`pairUsable` false): the pair has to be fixed first, and a third point
 * placed against it would be placed against nothing.
 */
export function checkAction(input: {
  stage: CalibrationStage
  plan: CheckPlan
  hasCheck: boolean
  pairUsable: boolean
}): CheckAction | null {
  const { stage, plan, hasCheck, pairUsable } = input
  if (!plan.offered) return null
  if (stage === 'check') return { kind: 'skip', label: SKIP_CHECK_LABEL }
  if (stage !== 'review') return null
  if (hasCheck) return { kind: 'remove', label: REMOVE_CHECK_LABEL }
  if (!pairUsable) return null
  return { kind: 'add', label: plan.stored ? CHECK_RETURN_TITLE : ADD_CHECK_LABEL }
}
