/**
 * Constellation frame fit: the maths behind a "verified" that measures where the
 * points are and which way they face, not just how far apart two of them are.
 *
 * Pure, with no DOM and no runtime-specific API (ADR 0002), so the scanner, the
 * World Editor and the server can all import it. The calibration flow calls it
 * through `src/ar/constellation-flow.ts` (the return-visit fit, the check point,
 * the ghosts), and the scanner's status line and the editor's chip word its
 * results. Sibling modules it reuses: `./geo.ts` (matrix layout, `Vec3`),
 * `wrapDeg` in `../capture/pose-delta.ts`. It does not repeat `invertAffine`
 * (`./anchor-placement.ts`); use that one.
 *
 * ## Why this exists
 *
 * A return visit builds `sessionToProject` from two single taps and compares one
 * number, their distance, with the stored one. Distance does not change when the
 * pair is shifted, turned, reversed or swapped for a different pair at the same
 * spacing, so "verified" says nothing about position or direction. Three or more
 * points leave redundant measurements that do.
 *
 * ## Conventions (all pinned by tests/unit/deno/frame_fit.test.ts)
 *
 * - Points are `Vec3` in metres, y up. The fit uses x and z for the turn and shift;
 *   y sets the height offset and is checked (below). Order is load-bearing: index 0
 *   is the landmark, index 1 the heading marker, 2 and up are check points, as in
 *   `ProjectSpatialFrame`. At most `MAX_FIT_POINTS`.
 * - The Place frame is the one `twoPointToProjectTransform` builds: landmark at the
 *   origin, heading marker on +Z. Stored points are in that frame.
 * - Matrices are column-major `number[16]`, applied with `transformPoint`, built
 *   with `composeYUpTransform`. `fit.headingDeg` has the sign and meaning of
 *   `twoPointHeadingDeg`: for consistent points it equals
 *   `twoPointHeadingDeg(visit landmark, visit marker)`, and the matrix is
 *   `composeYUpTransform(translation, -headingDeg, scale)`.
 * - `fitRigid2D(from, to)` maps `from` onto `to`. Heights: translation y is
 *   `mean(to.y) - scale * mean(from.y)`, so the floor is the average of all taps
 *   instead of whichever single tap happened to be the landmark. What is left over
 *   (`fit.heightRmsResidualM`) is gated like the horizontal residual: a check point
 *   tapped on a table moves the floor by a third of its height, and that must not pass.
 * - A residual is where the mapped point lands minus its target.
 *
 * ## Building sessionToProject from the fit
 *
 *   const outcome = fitRigid2D(visitPoints, storedPoints)  // visit = session frame, stored = Place frame
 *   if (outcome.ok) calibration.sessionToProject = outcome.fit.matrix
 *
 * `visitPoints` are this visit's taps in session coordinates and `storedPoints` the
 * Place's reference points, in the same order, so `fit.matrix` IS `sessionToProject`
 * and replaces `twoPointToProjectTransform` for a return visit with 3 or more points.
 * The first visit defines the frame the stored points live in, so it keeps the
 * two-point transform and has nothing to fit.
 * The second argument is the reference. It is the one checked for being usable (three
 * to `MAX_FIT_POINTS` distinct points, not on a line); a visit whose taps collapse onto
 * one spot or one line is wrong, not unusable, and comes out as a mismatch through its
 * residuals.
 *
 * Fitting the other way (`fitRigid2D(stored, visit)`) gives the inverse for a rigid
 * fit: `invertAffine(fit.matrix)` is the same `sessionToProject`, and
 * `transformPoint(thatInverse, storedPoint)` is where to draw a stored point's ghost.
 * (The usability checks then fall on the visit's points, so judge a visit the first way.)
 *
 * Use `fitRigid2D` unless the units policy (WP-06) says otherwise. `fitSimilarity2D`
 * also estimates a size ratio, which absorbs a unit difference between visits, and pays
 * for it: the size takes a degree of freedom, so a check point tapped on the wrong
 * feature can be absorbed as a size change. `verifyFit` therefore never calls a
 * similarity fit of fewer than 4 points verified, and with `unitsMode: 'metric'`, where
 * no size change is expected, it judges the points as a rigid fit would.
 *
 * ## At the first calibration
 *
 * `referenceProblem(points)` says whether the points can serve as a reference: the
 * same checks a fit makes of its second argument. `frameUncertaintyAt(points, sigma,
 * WORKING_RADIUS_M)` is the accuracy to show beside the check-point step; `verifyFit`
 * will not call a visit verified when that estimate is beyond `ACCURACY_TARGET_M`.
 * `fitRigid2D(points, points).fit.alternativeOrder.rmsM` is how different the points
 * look when taken in another order. Near the gate (`RMS_GATE_SIGMAS * SIGMA0_M`) the
 * order cannot be checked, which is the case for an equilateral triangle or a rectangle:
 * ask for a check point that makes the shape lopsided.
 *
 * ## What to store
 *
 * - On the Place, at first calibration: each reference point's x, y, z in the Place
 *   frame, i.e. `transformPoint(twoPointToProjectTransform(L, H), tap)` for every tap
 *   (the landmark and marker land on (0,0,0) and (0,0,separation)). Do not rewrite
 *   them on later visits.
 * - On the scan: `sessionToProject = fit.matrix`, `fit: summariseFit(fit)`, and
 *   `checkedBy` from the verdict, unless its `compared` is `'nothing'`: that is not a
 *   result, so fall back to the two-point check and store that one. `status` is
 *   `'verified'` for a verified verdict and `'provisional'` otherwise: `'mismatch'` is
 *   the state of the mismatch dialog, and "Use anyway" records `'provisional'`.
 * - A two-point visit has no fit (`too-few-points`). It keeps today's transform and
 *   asks `verifyTwoPoint` for the verdict. Write `twoPointToleranceM(sigmaHat)` as the
 *   scan's `toleranceM`, so the number on the scan is the one the verdict applied.
 *   (`verifyFit` of a two-point outcome compares nothing and says so.)
 *
 * ## What the UI may say
 *
 *   verified    / constellation  "N points are X cm off the stored ones." Their positions
 *                                (and so which way they face) and heights were compared,
 *                                and no other order of the points fits as well.
 *   provisional / constellation  The points agreed within the limits but the check cannot
 *                                be relied on: `reasons` says which (heights beyond their
 *                                gate, a size change fitted to too few points, another
 *                                order fits as well, the shape too weak for the accuracy
 *                                aimed for, taps too unsteady).
 *   provisional / separation     Two points: "Frame set. Distance checked, direction not
 *                                checked". Or `compared: 'nothing'`: `reasons` says why.
 *   mismatch    / either         Show `reasons`; per-point residuals are in `fit.perPoint`.
 *
 * It must not say the Place, the frame, the alignment or "the same spot" is verified.
 * A consistent shift of every point is invisible to any check made from the taps
 * alone: only photos, a printed tag or scan-geometry registration can see it, which
 * is why a verified verdict, and a provisional one that compared something, ends by
 * naming that limit.
 *
 * ## Constants
 *
 * Every number below that decides a verdict is adopted from a design brief or a
 * simulation, not measured on a phone (ADR 0005 rule 5). Each says so where it is
 * declared. Device experiment DX2 (tap noise, probe point) is what replaces them.
 */
import { composeYUpTransform, transformPoint, twoPointHeadingDeg } from './geo.ts'
import { MAX_FIT_POINTS, MIN_FIT_POINTS, type CheckedBy, type FitMethod, type FitSummary, type PointResidual } from './calibration-evidence.ts'
import type { Vec3 } from './types.ts'
import { wrapDeg } from '../capture/pose-delta.ts'

const RAD_TO_DEG = 180 / Math.PI

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Per-axis standard deviation of one tap, in metres, assumed when no spread was
 * measured: the floor of {@link sigmaHat}.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** It is the "~3 cm hit-test noise"
 * that `geo.ts` assumes and says was never verified. If real noise is larger the
 * gate below passes fewer correct re-taps (a simulation with true noise of 5 cm
 * and this value verifies about two in three), so DX2 must set it.
 */
export const SIGMA0_M = 0.03

/**
 * The root-mean-square residual gate, in multiples of {@link sigmaHat}.
 *
 * For correct re-taps with per-axis noise sigma on each visit, the 99th percentile
 * of the rms residual of a 3-point rigid fit is about 2.75 sigma (chi-square, 3
 * degrees of freedom), so 2.8 passes about 99% when sigma-hat equals the true noise
 * and rejects offsets of a few sigma. **Adopted from the design brief; the 99% is a
 * simulation, not a device measurement (ADR 0005 rule 5).** It holds only while
 * sigma-hat is at least the true noise.
 */
export const RMS_GATE_SIGMAS = 2.8

/**
 * The single-point gate as a multiple of the rms gate.
 *
 * No residual of `n` points can exceed `sqrt(n)` times their rms, so this only
 * binds from 7 points up (`sqrt(7) > 2.5`); with 3 to 6 points it never fires.
 * **Adopted from the design brief, not measured (ADR 0005 rule 5).**
 */
export const MAX_GATE_FACTOR = 2.5

/**
 * The height gate, in multiples of {@link sigmaHat}, on the root-mean-square vertical
 * residual left after the height offset is fitted. Beyond it a visit is not verified; it
 * is provisional, never a mismatch.
 *
 * It is the horizontal gate's multiple, so vertical tap noise is assumed to equal
 * horizontal tap noise (`geo.ts` states one per-axis figure). After a one-parameter
 * height fit the 99th percentile of that rms is under 2.5 sigma for 3 or more points,
 * so 2.8 passes at least 99.7% of correct re-taps. **Adopted, not measured (ADR 0005
 * rule 5):** nothing has measured vertical noise on a phone, and a feature-point hit
 * on a steeply downward ray may be worse in height than in the ground plane (a
 * simulation with vertical noise 1.5 times the horizontal gives 7% of correct re-taps
 * over this gate, and 2 times gives 23%). A gate that is too tight for the real noise
 * would turn away correct visits, which ADR 0005 rule 5 calls worse than no check, so
 * a height excess withholds "verified" instead of raising a mismatch. A tap on a table
 * moves the floor by a third of its height, so it still cannot pass. DX2 records every
 * axis; raise this if the vertical spread is larger.
 */
export const HEIGHT_GATE_SIGMAS = 2.8

/**
 * Largest tap spread, in metres, at which a verdict can still be verified.
 *
 * Above it the rms gate (2.8 x sigma-hat = 28 cm here) would approach the product's
 * 0.305 m accuracy target, and a check that wide cannot support "verified". Beyond it
 * the gates are still applied, at this spread: a residual over the gate is a mismatch
 * however unsteady the taps, and one inside it is provisional.
 * **Adopted, derived from that target, not measured (ADR 0005 rule 5).**
 */
export const MAX_SIGMA_HAT_M = 0.1

// MIN_FIT_POINTS and MAX_FIT_POINTS are declared in ./calibration-evidence.ts, beside the shape of a fit, so the
// server can read them without importing this file (which reaches ../capture/pose-delta.ts, a directory the
// Docker image does not carry: tests/unit/node/wp-docker-server-imports.test.ts). They are exported from here too.
export { MAX_FIT_POINTS, MIN_FIT_POINTS }

/**
 * Fewest residual degrees of freedom at which `'verified'` is honest.
 *
 * The rms gate is the 99th percentile of a chi-square with 3 degrees of freedom: the
 * 3-point rigid fit, which has `2n - 3` of them. A similarity fit spends one more on the
 * size (`2n - 4`), so with 3 points only 2 are left, and a far point's displacement can
 * be absorbed by the size and the turn: a simulation of a check point on the wrong
 * feature 1 m away passed the position gates in 39% (3 cm taps) to 89% (5 cm taps) of
 * visits at a 1 m baseline, where the rigid fit passed none. With 4 points a similarity
 * fit has 4 degrees of freedom, and the same simulation rejected at least 99.5% of them.
 * **Adopted from the design's 3-point rigid fit, not measured (ADR 0005 rule 5).**
 */
export const MIN_RESIDUAL_DOF = 3

/**
 * Smallest perpendicular offset, in metres, the points must have from their best-fit
 * straight line (see {@link perpendicularOffsetM}); below it the fit is refused as
 * `collinear`.
 *
 * Why: a 2D fit of collinear points still has a well-defined rotation, so this is not
 * about solvability. It is the least sideways spread at which a point tapped on the
 * wrong side of the line is told apart from tap noise. Random 3-point geometries at the
 * design's pessimistic 5 cm noise (40 geometries of 300 visits each in the test)
 * rejected a mirrored check point in every visit when the offset was 0.20 to 0.25 m,
 * but at 0.10 to 0.15 m the worst geometry rejected well under 95% (the test's seed
 * finds 60%). That is 4 x 5 cm. Both halves are reproduced by
 * tests/unit/deno/frame_fit.test.ts. **Adopted from a simulation, not measured
 * (ADR 0005 rule 5).**
 *
 * It does not scale with sigma-hat, so a noisier visit tells the wrong side apart less
 * well. A thin shape also gives a poor frame, and that is caught where it matters:
 * `verifyFit` will not call a visit verified when the shape's predicted accuracy is
 * beyond {@link ACCURACY_TARGET_M}, which a thin shape fails well before a noisy one
 * can mistake a mirror image for a pass. The design asks the user for a check point at
 * least 2 m off the baseline; this is only the floor under that.
 */
export const MIN_PERPENDICULAR_OFFSET_M = 0.2

/**
 * Two points closer than this, in the ground plane, count as one spot.
 *
 * It is `ANCHOR_RADIUS_M` in `./anchor-marker.ts`: the radius within which the
 * calibration flow already treats a tap as selecting an existing marker instead of
 * placing a new one. That file imports three.js, so the value is repeated here and a
 * test pins the two together. **Adopted from the existing flow, not measured.**
 */
export const DUPLICATE_POINT_GAP_M = 0.35

/**
 * Size ratios outside this range are not the same points at a different unit: the
 * verdict is a mismatch whatever the residuals say, so a similarity fit cannot make an
 * absurd scale look like agreement. It is deliberately a factor of two each way, not a
 * units policy. The size estimate of a small constellation is noisy (about 7% at 5 cm
 * taps for points a metre apart), and a fixed narrow limit such as 0.9 to 1.1 turned
 * away 15% of correct re-taps of such a constellation in simulation while the rms gate
 * turned away 1%. A narrower limit needs one that follows the spread of the points,
 * which is the units policy's (WP-06) job. **Adopted, not measured (ADR 0005 rule 5).**
 */
export const SCALE_RATIO_SANITY = { min: 0.5, max: 2 } as const

/**
 * How far from the centre of the points, in metres, the predicted accuracy is judged.
 * It is the distance of the probe the design's simulations use ("a spot 5 m away").
 * **Adopted from the design, not measured (ADR 0005 rule 5).**
 */
export const WORKING_RADIUS_M = 5

/**
 * The product's acceptance target for repeat captures, in metres: under one foot of
 * relative error inside a calibrated Area (docs/product/PLACE_SCAN_DESIGN.md, which also
 * says the UI never implies it when the residual does not support it). A visit whose
 * points agree is still not verified when the stored shape predicts more than this at
 * {@link WORKING_RADIUS_M}: a compact shape agrees with itself and places far spots badly
 * (in the tests' compact shape, 99% of correct re-taps pass the gates and 13% of those put
 * the probe over this target). **It is a target, not a measurement of any phone.**
 */
export const ACCURACY_TARGET_M = 0.305

/**
 * How much better than the best rotation a reflection must fit before the points are
 * called mirrored: its rms must be at most this fraction of the rotation's. It only
 * decides whether to say "mirrored" instead of reporting a poor fit, never a
 * tolerance on position. **Adopted, not measured.**
 */
const MIRROR_FIT_RATIO = 0.5

/** Numerical rank guard: normalised correlation below this means no rotation relates the shapes. */
const MIN_SHAPE_CORRELATION = 1e-6

/**
 * Relative slack when checking that the largest residual is not below the rms. The two
 * are equal in exact arithmetic when every residual is equal, and rounding can put the
 * maximum one unit in the last place under.
 */
const ROUNDING_SLACK = 1e-9

/**
 * Midpoint steps per unit of elongation in the integral behind {@link radialQuantile95}: at
 * this density it agrees with a 16,384-step integral to 1e-12 for every elongation from 1 to
 * 256 (checked when it was chosen), and the most elongated Gaussian it resolves is
 * {@link MAX_ELONGATION}.
 */
const QUANTILE_STEPS_PER_ELONGATION = 16
const MAX_ELONGATION = 256

// ── Types ───────────────────────────────────────────────────────────────────

// What `ScanCalibration` stores of a fit is declared in ./calibration-evidence.ts, below this file and
// ./types.ts both (see its header); they keep the names they have always had here.
export type { CheckedBy, FitMethod, FitSummary, PointResidual }

/**
 * The best way to line the visit's points up with the stored ones other than in the
 * order they were tapped.
 */
export interface AlternativeOrder {
  /** Root mean square horizontal residual, in metres, that order leaves. */
  rmsM: number
  /** `order[i]` is the index of the visit point lined up with stored point `i`. Never the identity. */
  order: number[]
  /** True when that order is only the first two points exchanged. */
  swapsFirstTwo: boolean
}

export interface FrameFit {
  fitMethod: FitMethod
  pointsUsed: number
  /** Column-major 4x4 taking `from` coordinates to `to` coordinates; `sessionToProject` when `from` is the visit. */
  matrix: number[]
  /** Rotation about +Y in degrees, (-180, 180], with the sign of `twoPointHeadingDeg`. */
  headingDeg: number
  /** The size scale `matrix` applies: 1 for a rigid fit. */
  scale: number
  /**
   * Size of `from` relative to `to` (1 means the same size; 1.1 means the visit
   * reads lengths 10% longer). Measured by both methods; applied only by the
   * similarity fit, where `scale * scaleRatio` is 1.
   */
  scaleRatio: number
  /** Index-aligned with the input points. */
  perPoint: PointResidual[]
  /** Root mean square of the horizontal residuals, the quantity the gate compares. */
  rmsResidualM: number
  /** Largest horizontal residual. */
  maxResidualM: number
  /**
   * The same two numbers with no size change allowed: what the points leave when only
   * turned and shifted. They equal `rmsResidualM` and `maxResidualM` for a rigid fit.
   */
  unscaledRmsResidualM: number
  unscaledMaxResidualM: number
  /** Root mean square of the vertical residuals left after the mean height offset (`perPoint[].dy`). */
  heightRmsResidualM: number
  /**
   * How far the first-to-second point baseline, carried through the fit, points from
   * the stored baseline, in degrees in (-180, 180]; positive when it points more
   * toward +X. `null` when either baseline has no length (two taps on one spot): there
   * is no direction to measure. See {@link headingResidualDeg}.
   */
  headingResidualDeg: number | null
  /** Root of the summed squared distances of the stored points from their centroid: the spread the frame is held by. */
  referenceSpreadM: number
  /** The best other order of the points, and how well it fits: see {@link AlternativeOrder}. */
  alternativeOrder: AlternativeOrder
}

/** Why no fit was made. Every case is a result, never a NaN or a throw. */
export type FitFailure =
  | { reason: 'too-few-points'; message: string; pointsGiven: number; pointsRequired: number }
  | { reason: 'too-many-points'; message: string; pointsGiven: number; pointsAllowed: number }
  | { reason: 'length-mismatch'; message: string; fromCount: number; toCount: number }
  | { reason: 'non-finite'; message: string; set: 'from' | 'to'; index: number }
  | { reason: 'duplicate-points'; message: string; indices: [number, number]; gapM: number }
  | { reason: 'collinear'; message: string; offsetM: number; requiredOffsetM: number }
  /** `turnedRmsM`: rms after the best turn and shift; `mirroredRmsM`: rms after the best flip and shift. */
  | {
    reason: 'mirrored'
    message: string
    turnedRmsM: number
    mirroredRmsM: number
    alternativeOrder: AlternativeOrder
  }
  | { reason: 'unmatched'; message: string }

export type FitOutcome = { ok: true; fit: FrameFit } | { ok: false; failure: FitFailure }

export interface FrameUncertainty {
  /** One standard deviation of the fitted heading, in degrees. */
  headingSigmaDeg: number
  /** Root mean square of the radial disagreement between two visits at the radius, in metres. */
  positionRmsM: number
  /** 95th percentile of that radial disagreement, in metres. */
  position95M: number
}

/**
 * What the phone's session units are. The same three names the units policy (WP-06)
 * will give `ARProvider.scaleKind()`: metres from the runtime, metres estimated by
 * the engine once ready, or the engine's own arbitrary unit.
 */
export type UnitsMode = 'metric' | 'estimated-metric' | 'arbitrary'
export type VerdictStatus = 'verified' | 'provisional' | 'mismatch'
/** What a verdict actually compared: the stored points with the visit's, only the distance between two, or nothing. */
export type Compared = 'points' | 'distance' | 'nothing'

export interface ConstellationVerdictInput {
  /** Points the check used: 3 or more for a fit, 2 for the distance between a pair. */
  pointsUsed: number
  /** For a fit, `fit.rmsResidualM`. For `pointsUsed: 2`, `twoPointResidualM(...)`. */
  rmsResidualM: number
  /** For a fit, `fit.maxResidualM`. For `pointsUsed: 2`, the same value as the rms. */
  maxResidualM: number
  /** Tap noise per axis in metres; raised to {@link SIGMA0_M} if lower or unusable. See {@link sigmaHat}. */
  sigmaHatM: number
  /**
   * `fit.scaleRatio`. Reported; only a ratio beyond {@link SCALE_RATIO_SANITY} changes the
   * status, to a mismatch. Not given, nothing is said; `null` or a bad number says it could not be measured.
   */
  scaleRatio?: number | null
  /**
   * `fit.headingResidualDeg`. Reported for 3 or more points; for two it is zero by construction and is
   * ignored. Not given, nothing is said; `null` (two taps on one spot) or a bad number says it could not be measured.
   */
  headingResidualDeg?: number | null
  /** Says what a size comparison does and does not mean for metres. */
  unitsMode?: UnitsMode
  /**
   * How the residuals were fitted; `'rigid'` when not given. A similarity fit has two
   * fewer residual degrees of freedom than a rigid one and is not verified below 4 points.
   */
  fitMethod?: FitMethod
  /**
   * `fit.heightRmsResidualM`. A number is compared with the height gate; `null` or a bad number says the
   * heights could not be measured; not given, the verdict says nothing about heights.
   */
  heightRmsResidualM?: number | null
  /**
   * `fit.alternativeOrder`. A failing visit whose other order fits the gate is told so;
   * a passing visit that another order fits as well is not verified.
   */
  alternativeOrder?: Pick<AlternativeOrder, 'rmsM' | 'swapsFirstTwo'> | null
  /**
   * The predicted 95th-percentile position error at {@link WORKING_RADIUS_M}, in metres.
   * Beyond {@link ACCURACY_TARGET_M} a pass is provisional.
   */
  expectedErrorM?: number | null
}

/**
 * The verdict. A two-point check can never be `'verified'`, and a verified verdict is
 * always by constellation: that is in the type, so a forged `{ status: 'verified',
 * checkedBy: 'separation' }` does not compile (ADR 0005 rule 3).
 */
export type ConstellationVerdict =
  | {
    status: 'verified'
    checkedBy: 'constellation'
    compared: 'points'
    /** Short plain sentences, each a measured fact or a named limit. Safe to show. */
    reasons: string[]
  }
  | {
    status: 'provisional' | 'mismatch'
    /**
     * `'constellation'` when three or more points were compared; `'separation'` for the
     * distance between two points, and for a verdict that compared nothing, in which case
     * `compared` is `'nothing'` and `reasons` says so.
     */
    checkedBy: CheckedBy
    compared: Compared
    reasons: string[]
    /**
     * For a provisional verdict whose check passed but could not be relied on: why it was not verified, a subset
     * of `reasons` (heights beyond their gate, a size change fitted to too few points, another order that fits as
     * well, a shape too weak for the accuracy aimed for, taps too unsteady). A line that must say what stands in the
     * way of "verified" reads it here instead of sorting `reasons` by their wording. Absent on a mismatch, and on a
     * verdict that compared nothing, where `reasons` is the whole story.
     */
    withheld?: string[]
  }

// ── Small helpers ───────────────────────────────────────────────────────────

function isFinitePoint(p: Vec3 | null | undefined): p is Vec3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

/**
 * Centimetres for a sentence: one decimal below a metre, so 17.0 against 16.8 does not read as 17 against 17.
 * Exported so that every line that quotes a figure from a check (the capture flow's readout, the scanner's status
 * line, the editor's chip) writes it as the verdict does.
 */
export function formatCm(metres: number): string {
  const cm = metres * 100
  return Math.abs(cm) < 100 ? cm.toFixed(1) : cm.toFixed(0)
}

function centroid(points: readonly Vec3[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    x += p.x
    y += p.y
    z += p.z
  }
  const n = points.length
  return { x: x / n, y: y / n, z: z / n }
}

/**
 * The largest perpendicular distance, in metres in the ground plane, of any point from
 * the straight line that best fits all of them (least squares on perpendicular
 * distances, through the centroid along the principal axis). Zero for points on a line.
 */
export function perpendicularOffsetM(points: readonly Vec3[]): number {
  const mean = centroid(points)
  let sxx = 0
  let szz = 0
  let sxz = 0
  for (const p of points) {
    const dx = p.x - mean.x
    const dz = p.z - mean.z
    sxx += dx * dx
    szz += dz * dz
    sxz += dx * dz
  }
  // Principal axis direction (cos a, sin a) in (x, z); its normal is (-sin a, cos a).
  const axis = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  const nx = -Math.sin(axis)
  const nz = Math.cos(axis)
  let largest = 0
  for (const p of points) {
    largest = Math.max(largest, Math.abs((p.x - mean.x) * nx + (p.z - mean.z) * nz))
  }
  return largest
}

/**
 * The tap noise the gate is built on: the measured spread of repeated taps, never
 * less than {@link SIGMA0_M}. A missing, negative or non-finite measurement is no
 * measurement, so it gives the floor rather than NaN.
 */
export function sigmaHat(measuredSpreadM?: number | null): number {
  return typeof measuredSpreadM === 'number' && Number.isFinite(measuredSpreadM) && measuredSpreadM > SIGMA0_M
    ? measuredSpreadM
    : SIGMA0_M
}

// ── Residuals and heading ───────────────────────────────────────────────────

/**
 * Where each `from` point lands under `matrix` relative to its `to` point, or `null`
 * when the matrix is not 16 finite numbers, the lengths differ or a coordinate is not
 * finite. Use it to see how a matrix other than a fit, such as today's two-point
 * transform, treats a check point.
 */
export function pointResiduals(
  matrix: readonly number[],
  from: readonly Vec3[],
  to: readonly Vec3[],
): PointResidual[] | null {
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every((v) => Number.isFinite(v))) return null
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) return null
  const out: PointResidual[] = []
  for (let i = 0; i < from.length; i++) {
    const source = from[i]
    const target = to[i]
    if (!isFinitePoint(source) || !isFinitePoint(target)) return null
    const mapped = transformPoint(matrix as number[], source)
    const dx = mapped.x - target.x
    const dy = mapped.y - target.y
    const dz = mapped.z - target.z
    out.push({ residualM: Math.hypot(dx, dz), dx, dy, dz })
  }
  return out
}

/**
 * How far the baseline from `from[0]` to `from[1]`, once turned by a fit whose
 * rotation is `headingDeg` (the matrix turns a bearing by `-headingDeg`), points from
 * the stored baseline `to[0]` to `to[1]`, in degrees in (-180, 180], positive toward
 * +X. Wrap-safe, so a reversed pair reads near 180 whichever side of the wrap it falls
 * on. `null` for a non-finite input or a zero-length baseline.
 */
export function headingResidualDeg(
  headingDeg: number,
  from: readonly [Vec3, Vec3],
  to: readonly [Vec3, Vec3],
): number | null {
  if (!Number.isFinite(headingDeg) || !Array.isArray(from) || !Array.isArray(to)) return null
  for (const p of [from[0], from[1], to[0], to[1]]) {
    if (!isFinitePoint(p)) return null
  }
  if (Math.hypot(from[1].x - from[0].x, from[1].z - from[0].z) === 0) return null
  if (Math.hypot(to[1].x - to[0].x, to[1].z - to[0].z) === 0) return null
  return wrapDeg(twoPointHeadingDeg(from[0], from[1]) - headingDeg - twoPointHeadingDeg(to[0], to[1]))
}

// ── The fits ────────────────────────────────────────────────────────────────

/** The first reason these points cannot be fitted, in a fixed order, or null. */
function inspect(fromPoints: readonly Vec3[], toPoints: readonly Vec3[]): FitFailure | null {
  // A frame stored before its points were kept, or a damaged one, has no list of points: that is no points, not a throw.
  const from = Array.isArray(fromPoints) ? fromPoints : []
  const to = Array.isArray(toPoints) ? toPoints : []
  if (from.length !== to.length) {
    return {
      reason: 'length-mismatch',
      message: `${from.length} points this visit but ${to.length} stored: nothing was compared.`,
      fromCount: from.length,
      toCount: to.length,
    }
  }
  const n = from.length
  if (n < MIN_FIT_POINTS) {
    return {
      reason: 'too-few-points',
      message: `Only ${n} point${n === 1 ? '' : 's'}: at least ${MIN_FIT_POINTS} are needed to check direction.`,
      pointsGiven: n,
      pointsRequired: MIN_FIT_POINTS,
    }
  }
  if (n > MAX_FIT_POINTS) {
    return {
      reason: 'too-many-points',
      message: `${n} points: at most ${MAX_FIT_POINTS} can be compared.`,
      pointsGiven: n,
      pointsAllowed: MAX_FIT_POINTS,
    }
  }
  for (const [set, points] of [['from', from], ['to', to]] as const) {
    for (let i = 0; i < n; i++) {
      if (!isFinitePoint(points[i])) {
        return {
          reason: 'non-finite',
          message: 'A point has no usable position: nothing was compared.',
          set,
          index: i,
        }
      }
    }
  }
  // What follows describes the reference, the second set. A visit whose taps collapse onto
  // one spot or one line is not "unable to be checked": it is wrong, and the fit shows it
  // through its residuals instead of hiding it behind a refusal.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gapM = Math.hypot(to[i]!.x - to[j]!.x, to[i]!.z - to[j]!.z)
      if (gapM < DUPLICATE_POINT_GAP_M) {
        return {
          reason: 'duplicate-points',
          message: `Two stored points are only ${formatCm(gapM)} cm apart: they count as one spot.`,
          indices: [i, j],
          gapM,
        }
      }
    }
  }
  const offsetM = perpendicularOffsetM(to)
  if (offsetM < MIN_PERPENDICULAR_OFFSET_M) {
    return {
      reason: 'collinear',
      message: 'The stored points lie almost on one line, so which side of it the points are on cannot be checked.',
      offsetM,
      requiredOffsetM: MIN_PERPENDICULAR_OFFSET_M,
    }
  }
  return null
}

/**
 * The first reason these points cannot serve as a reference (fewer than three, more than
 * `MAX_FIT_POINTS`, a position that is not a number, two that count as one spot, all on
 * one line), or `null`: the checks a fit makes of its second argument, for use at the
 * first calibration, before there is a visit to compare.
 */
export function referenceProblem(points: readonly Vec3[]): FitFailure | null {
  return inspect(points, points)
}

/** A failure built per call, so nobody's edit of one result shows up in another. */
function unmatched(): FitOutcome {
  return {
    ok: false,
    failure: {
      reason: 'unmatched',
      message: 'The points cannot be lined up with the stored ones by turning and shifting.',
    },
  }
}

/** Residual rms after the best turn and shift, from the correlation of two centred sets. */
function unexplainedRmsM(
  fitMethod: FitMethod,
  correlation: number,
  fromSpread: number,
  toSpread: number,
  n: number,
): number {
  const sumSquares = fitMethod === 'rigid'
    ? fromSpread + toSpread - 2 * correlation
    : toSpread - (correlation * correlation) / fromSpread
  return Math.sqrt(Math.max(0, sumSquares) / n)
}

/**
 * Every way of lining the visit's points up with the stored ones other than in the
 * order they were tapped, each fitted by the best turn and shift, and the best of them.
 * Heap's algorithm visits each of the other n! - 1 orders once. Centring and spread do
 * not depend on the order, so each order costs one pass over the points.
 */
function bestOtherOrder(
  ax: Float64Array,
  az: Float64Array,
  bx: Float64Array,
  bz: Float64Array,
  fromSpread: number,
  toSpread: number,
  fitMethod: FitMethod,
): AlternativeOrder {
  const n = ax.length
  const order = Array.from({ length: n }, (_, i) => i)
  const counters = new Array<number>(n).fill(0)
  const best = { rmsM: Number.POSITIVE_INFINITY, order: order.slice(), seen: false }

  const consider = (): void => {
    let dot = 0
    let cross = 0
    for (let i = 0; i < n; i++) {
      const j = order[i]!
      dot += ax[j]! * bx[i]! + az[j]! * bz[i]!
      cross += ax[j]! * bz[i]! - az[j]! * bx[i]!
    }
    const rms = unexplainedRmsM(fitMethod, Math.hypot(dot, cross), fromSpread, toSpread, n)
    if (!best.seen || rms < best.rmsM) {
      best.rmsM = rms
      best.order = order.slice()
      best.seen = true
    }
  }

  let i = 1
  while (i < n) {
    if (counters[i]! < i) {
      const k = i % 2 === 0 ? 0 : counters[i]!
      const held = order[k]!
      order[k] = order[i]!
      order[i] = held
      consider()
      counters[i] = counters[i]! + 1
      i = 1
    } else {
      counters[i] = 0
      i++
    }
  }

  return {
    rmsM: best.rmsM,
    order: best.order,
    swapsFirstTwo: best.order[0] === 1 && best.order[1] === 0 && best.order.every((v, k) => k < 2 || v === k),
  }
}

/**
 * Closed-form least squares in the ground plane (Procrustes, Umeyama 1991 without
 * the SVD that three dimensions need): with both sets centred, the proper rotation is
 * `atan2(cross, dot)`, its correlation `hypot(dot, cross)`, and the size scale that
 * minimises the squared error is that correlation over the spread of `from`.
 *
 * The same sums with the second term negated give the best reflection. A rotation can
 * never be a reflection, so when the reflection explains the points far better the
 * observation is reported as mirrored instead of being fitted badly.
 */
function fitFrame(from: readonly Vec3[], to: readonly Vec3[], fitMethod: FitMethod): FitOutcome {
  const failure = inspect(from, to)
  if (failure) return { ok: false, failure }

  const n = from.length
  const fromMean = centroid(from)
  const toMean = centroid(to)

  const ax = new Float64Array(n)
  const az = new Float64Array(n)
  const bx = new Float64Array(n)
  const bz = new Float64Array(n)
  let dot = 0
  let cross = 0
  let dotFlipped = 0
  let crossFlipped = 0
  let fromSpread = 0
  let toSpread = 0
  for (let i = 0; i < n; i++) {
    ax[i] = from[i]!.x - fromMean.x
    az[i] = from[i]!.z - fromMean.z
    bx[i] = to[i]!.x - toMean.x
    bz[i] = to[i]!.z - toMean.z
    dot += ax[i]! * bx[i]! + az[i]! * bz[i]!
    cross += ax[i]! * bz[i]! - az[i]! * bx[i]!
    dotFlipped += ax[i]! * bx[i]! - az[i]! * bz[i]!
    crossFlipped += ax[i]! * bz[i]! + az[i]! * bx[i]!
    fromSpread += ax[i]! * ax[i]! + az[i]! * az[i]!
    toSpread += bx[i]! * bx[i]! + bz[i]! * bz[i]!
  }

  // A visit with no spread at all would divide by zero below. It has no correlation either, so the
  // later guard would give the same answer; this one keeps the 0/0 out of the arithmetic.
  if (!(fromSpread > 0)) return unmatched()

  const turned = Math.hypot(dot, cross)
  const flipped = Math.hypot(dotFlipped, crossFlipped)
  const turnedRmsM = unexplainedRmsM(fitMethod, turned, fromSpread, toSpread, n)
  const mirroredRmsM = unexplainedRmsM(fitMethod, flipped, fromSpread, toSpread, n)
  const alternativeOrder = bestOtherOrder(ax, az, bx, bz, fromSpread, toSpread, fitMethod)
  if (mirroredRmsM <= MIRROR_FIT_RATIO * turnedRmsM) {
    return {
      ok: false,
      failure: {
        reason: 'mirrored',
        message: 'The points only match the stored ones when flipped over: one may be on the wrong side.',
        turnedRmsM,
        mirroredRmsM,
        alternativeOrder,
      },
    }
  }
  if (!(turned > MIN_SHAPE_CORRELATION * Math.sqrt(fromSpread * toSpread))) return unmatched()

  const headingDeg = wrapDeg(Math.atan2(cross, dot) * RAD_TO_DEG)
  const fitted = turned / fromSpread
  const scale = fitMethod === 'similarity' ? fitted : 1

  // Rotation and scale from geo.ts; the translation then sends the centroid of `from`
  // exactly onto the centroid of `to`, which is where least squares puts it.
  const buildMatrix = (withScale: number): number[] => {
    const matrix = composeYUpTransform({ x: 0, y: 0, z: 0 }, -headingDeg, withScale)
    const carried = transformPoint(matrix, fromMean)
    matrix[12] = toMean.x - carried.x
    matrix[13] = toMean.y - carried.y
    matrix[14] = toMean.z - carried.z
    return matrix
  }
  const summarise = (perPoint: PointResidual[]) => {
    let squares = 0
    let heightSquares = 0
    let largest = 0
    for (const r of perPoint) {
      squares += r.residualM * r.residualM
      heightSquares += r.dy * r.dy
      largest = Math.max(largest, r.residualM)
    }
    const rms = Math.sqrt(squares / n)
    // The largest of n numbers is never under their rms; rounding can say otherwise by one unit in the last place.
    return { rms, max: Math.max(largest, rms), heightRms: Math.sqrt(heightSquares / n) }
  }

  const matrix = buildMatrix(scale)
  const perPoint = pointResiduals(matrix, from, to)
  if (!perPoint) return unmatched()
  const applied = summarise(perPoint)
  let unscaled = applied
  if (fitMethod === 'similarity') {
    const unscaledPerPoint = pointResiduals(buildMatrix(1), from, to)
    if (!unscaledPerPoint) return unmatched()
    unscaled = summarise(unscaledPerPoint)
  }

  const fit: FrameFit = {
    fitMethod,
    pointsUsed: n,
    matrix,
    headingDeg,
    scale,
    scaleRatio: 1 / fitted,
    perPoint,
    rmsResidualM: applied.rms,
    maxResidualM: applied.max,
    unscaledRmsResidualM: unscaled.rms,
    unscaledMaxResidualM: unscaled.max,
    heightRmsResidualM: applied.heightRms,
    headingResidualDeg: headingResidualDeg(headingDeg, [from[0]!, from[1]!], [to[0]!, to[1]!]),
    referenceSpreadM: Math.sqrt(toSpread),
    alternativeOrder,
  }

  // Coordinates near the limit of the floating-point range overflow somewhere in the sums; whatever
  // does not come out as a number is reported as a failed match, never handed on as a result.
  const numbers = [
    ...matrix,
    headingDeg,
    scale,
    fit.scaleRatio,
    fit.rmsResidualM,
    fit.maxResidualM,
    fit.unscaledRmsResidualM,
    fit.unscaledMaxResidualM,
    fit.heightRmsResidualM,
    fit.referenceSpreadM,
    alternativeOrder.rmsM,
    ...perPoint.flatMap((r) => [r.residualM, r.dx, r.dy, r.dz]),
  ]
  if (!numbers.every((v) => Number.isFinite(v))) return unmatched()
  return { ok: true, fit }
}

/**
 * The rotation and shift (no scaling) that best carry `from` onto `to`, with the
 * height offset from the mean of the points. Fewer than 3 points, more than
 * `MAX_FIT_POINTS`, collinear or duplicate points, non-finite values, mismatched lengths
 * and mirrored points return `{ ok: false }` with the reason; a successful fit is always a
 * proper rotation.
 */
export function fitRigid2D(from: readonly Vec3[], to: readonly Vec3[]): FitOutcome {
  return fitFrame(from, to, 'rigid')
}

/**
 * As {@link fitRigid2D} but with one uniform size scale as well, applied to all three
 * axes, for when the units of two visits differ. The scale is `1 / fit.scaleRatio`.
 *
 * The size costs a degree of freedom, which is why `verifyFit` withholds `'verified'`
 * from a similarity fit of fewer than 4 points. The gates were calibrated on the rigid
 * fit; see {@link MIN_RESIDUAL_DOF}.
 */
export function fitSimilarity2D(from: readonly Vec3[], to: readonly Vec3[]): FitOutcome {
  return fitFrame(from, to, 'similarity')
}

export function summariseFit(fit: FrameFit): FitSummary {
  return {
    fitMethod: fit.fitMethod,
    pointsUsed: fit.pointsUsed,
    rmsResidualM: fit.rmsResidualM,
    maxResidualM: fit.maxResidualM,
    perPoint: fit.perPoint.map((r) => ({ ...r })),
    headingResidualDeg: fit.headingResidualDeg,
    scaleRatio: fit.scaleRatio,
  }
}

// ── Predicted accuracy ──────────────────────────────────────────────────────

/**
 * The 95th percentile of the distance of a zero-mean 2D Gaussian whose independent
 * coordinates have standard deviations `sa` and `sb`. With `a(t) = cos(t)^2 / sa^2 +
 * sin(t)^2 / sb^2` the chance of lying within `q` is
 * `(2 / (pi sa sb)) * integral over [0, pi/2] of (1 - exp(-q^2 a(t) / 2)) / a(t) dt`
 * (integrate the density in polar form). The integrand is smooth and periodic, so a
 * midpoint rule evaluates it to many digits, with steps in proportion to how elongated
 * the Gaussian is; a safeguarded Newton iteration, whose slope shares the same
 * exponentials, then finds `q`. For `sa = sb` it is `sa * sqrt(-2 ln 0.05)`. An
 * elongation beyond 256 is treated as 256, which overstates the answer by under 0.001%.
 */
function radialQuantile95(sa: number, sb: number): number {
  if (!(sa > 0) || !(sb > 0)) return 0
  // Work in units of the larger deviation so that neither tiny nor huge inputs overflow the squares.
  const unit = Math.max(sa, sb)
  const ua = Math.max(sa / unit, 1 / MAX_ELONGATION)
  const ub = Math.max(sb / unit, 1 / MAX_ELONGATION)
  const steps = Math.ceil(QUANTILE_STEPS_PER_ELONGATION / Math.min(ua, ub))
  const weights = new Float64Array(steps)
  for (let k = 0; k < steps; k++) {
    const t = ((k + 0.5) * Math.PI) / (2 * steps)
    weights[k] = Math.cos(t) ** 2 / (ua * ua) + Math.sin(t) ** 2 / (ub * ub)
  }
  const scale = 1 / (ua * ub * steps)
  // The answer lies between the one-dimensional 1.96 and the isotropic 2.45 deviations of the larger axis.
  let low = 1.9
  let high = 2.5
  let q = Math.min(high, Math.max(low, 2.4477 * Math.sqrt((ua * ua + ub * ub) / 2)))
  for (let i = 0; i < 50; i++) {
    let within = 0
    let slope = 0
    for (let k = 0; k < steps; k++) {
      const e = Math.exp((-q * q * weights[k]!) / 2)
      within += (1 - e) / weights[k]!
      slope += e
    }
    const miss = within * scale - 0.95
    if (miss < 0) low = q
    else high = q
    let next = q - miss / (slope * scale * q)
    if (!(next > low && next < high)) next = (low + high) / 2
    if (Math.abs(next - q) < 1e-12 * q) {
      q = next
      break
    }
    q = next
  }
  return q * unit
}

/**
 * The prediction for `n` points whose summed squared distances from their centroid are
 * `spread`. With `s = sigma * sqrt(2)` the noise of one visit against another, the
 * heading has standard deviation `s / sqrt(spread)`. A spot `radius` from the centroid is
 * off by the shift of the centroid (`s / sqrt(n)` along each axis) plus the turn times the
 * radius, sideways (`s * radius / sqrt(spread)`); a similarity fit adds the same again
 * along the radius, from the size. The 95th percentile is that of the resulting
 * elliptical Gaussian, not an isotropic one, which would run up to 11% short at 12 m.
 */
function predictUncertainty(
  n: number,
  spread: number,
  sigmaM: number,
  radiusM: number,
  fitMethod: FitMethod,
): FrameUncertainty | null {
  if (!(spread > 0)) return null
  const visitToVisit = sigmaM * Math.SQRT2
  const shiftVariance = (visitToVisit * visitToVisit) / n
  const leverVariance = (visitToVisit * radiusM) ** 2 / spread
  const alongRadius = shiftVariance + (fitMethod === 'similarity' ? leverVariance : 0)
  const sideways = shiftVariance + leverVariance
  const prediction = {
    headingSigmaDeg: (visitToVisit / Math.sqrt(spread)) * RAD_TO_DEG,
    positionRmsM: Math.sqrt(alongRadius + sideways),
    position95M: radialQuantile95(Math.sqrt(alongRadius), Math.sqrt(sideways)),
  }
  return Object.values(prediction).every((v) => Number.isFinite(v)) ? prediction : null
}

/**
 * How closely two visits that each tapped `points` with per-axis noise `sigmaM` will
 * agree about a spot `radiusM` metres from the centroid of the points, for a
 * least-squares fit (a rigid one unless `fitMethod` says similarity, which is a little
 * less certain). It describes the least-squares frame; today's landmark-anchored frame
 * has one more error term, along the baseline, which is small at a distance (94.5
 * against 94.1 cm at 5 m in the tests). See {@link predictUncertainty} for the model.
 * Simulated visit pairs (two to six points, 2 to 12 m) cover the 95th percentile to
 * within a few tenths of a percent of 95% in the tests.
 *
 * `null` when fewer than two points, any non-finite value, a negative sigma or radius,
 * or all points at one spot.
 */
export function frameUncertaintyAt(
  points: readonly Vec3[],
  sigmaM: number,
  radiusM: number,
  fitMethod: FitMethod = 'rigid',
): FrameUncertainty | null {
  if (!Array.isArray(points) || points.length < 2) return null
  const n = points.length
  if (!Number.isFinite(sigmaM) || sigmaM < 0 || !Number.isFinite(radiusM) || radiusM < 0) return null
  if (!points.every((p) => isFinitePoint(p))) return null
  const mean = centroid(points)
  let spread = 0
  for (const p of points) spread += (p.x - mean.x) ** 2 + (p.z - mean.z) ** 2
  return predictUncertainty(n, spread, sigmaM, radiusM, fitMethod)
}

// ── The verdict ─────────────────────────────────────────────────────────────

/** The limit every verdict that compared something ends by naming. Exported so a status line can name it in the same words. */
export const NOT_CHECKED_SPOTS = 'Not checked: that these are the same physical spots. Compare with the photos.'
/**
 * The limit a verdict adds on a phone whose units are not known to be metres, by what `unitsMode` says. Exported so the
 * capture flow's readout can name it in the verdict's words: the centimetres it quotes mean nothing as centimetres without it.
 */
export const NOT_CHECKED_METRES: Record<'arbitrary' | 'estimated-metric', string> = {
  arbitrary: "Not checked: sizes in metres. This phone's units are not metres.",
  'estimated-metric': 'Not checked: sizes in metres. The phone estimates them.',
}

/**
 * The units limit for a phone's `scaleKind` (what a scan record carries), or null where there is none to name: metres from the
 * runtime, or a record that does not say. For the lines that quote centimetres after the card has closed, which must not read
 * as centimetres on a phone whose units are not metres when the card beside them said so.
 */
export function unitsLimit(kind: string | null | undefined): string | null {
  return kind === 'arbitrary' || kind === 'estimated-metric' ? NOT_CHECKED_METRES[kind] : null
}
const SWAPPED_SENTENCE = 'The first two points may be swapped.'
const OTHER_ORDER_SENTENCE = 'The points match the stored ones if taken in another order.'
const AMBIGUOUS_ORDER_SENTENCE =
  'The points also fit in another order, so the order they were tapped in is not checked.'

/**
 * The residual a two-point visit hands to {@link verifyConstellation}. Two points fit
 * a rotation and shift exactly except for their spacing, so the best fit leaves each
 * point off by half the spacing difference, in metres. Half, not the spacing error
 * itself: pass this and not the full difference, or the gate is twice as strict.
 * {@link verifyTwoPoint} does it for you.
 */
export function twoPointResidualM(separationM: number, storedSeparationM: number): number {
  return Math.abs(separationM - storedSeparationM) / 2
}

/**
 * The spacing difference, in metres, that a two-point check accepts: twice the rms gate
 * at the tap noise in use (each point is off by half of it). It is the number
 * `verifyTwoPoint` applies, so write it as the scan's `toleranceM` and what the scan says
 * is what was checked. At the adopted 3 cm it is 16.8 cm; `DEFAULT_SEPARATION_TOLERANCE_M`
 * in `./geo.ts` is 15 cm, and the two are not the same number.
 */
export function twoPointToleranceM(sigmaHatM?: number | null): number {
  return 2 * RMS_GATE_SIGMAS * Math.min(sigmaHat(sigmaHatM), MAX_SIGMA_HAT_M)
}

/**
 * Whether the residuals of a fit are past the gates of the tolerance written beside them. A scan keeps the
 * fit's `rmsResidualM` and `maxResidualM` and, in `toleranceM`, `twoPointToleranceM` of the tap noise its verdict
 * used: twice the rms gate. So the gates are recovered from that one number (`toleranceM / 2`, and
 * `MAX_GATE_FACTOR` times that for the worst point) and need not be stored again. It is how a line about a scan can
 * tell a fit that passed but was not verified from a fit whose failure the person kept over ("Use anyway").
 * Anything that is not a finite figure is not a failure.
 */
export function residualsPastGates(rmsM: number, maxM: number, toleranceM: number): boolean {
  if (![rmsM, maxM, toleranceM].every((value) => typeof value === 'number' && Number.isFinite(value))) return false
  const rmsGateM = toleranceM / 2
  return rmsM > rmsGateM || maxM > MAX_GATE_FACTOR * rmsGateM
}

/**
 * Whether a record is a comparison of three or more points that did not fit at all, and was kept ("Use anyway"). A fit backs
 * every `checkedBy: 'constellation'` the capture client writes (`summariseFit`), except the visit whose points could not be
 * fitted: a check point on the wrong side, or the pair tapped in the other order, which `fitRigid2D` refuses with a reason
 * and no figures. That visit is a mismatch, and the only way a mismatch is committed is kept, which is always provisional. So a
 * record that was checked by a constellation, is provisional and holds no fit is exactly that: there is nothing to quote, and the
 * line about it says the points did not match, in the words of any other kept mismatch. `hasFit` is whether the record holds the
 * fit's figures.
 */
export function keptUnfittedPoints(
  checkedBy: string | null | undefined,
  status: string | null | undefined,
  hasFit: boolean,
): boolean {
  return checkedBy === 'constellation' && status === 'provisional' && !hasFit
}

/**
 * The sentence that says how far apart two scans of the same spot may land, from {@link FrameUncertainty.position95M}.
 * One writer for it, so the verdict that withholds "verified" for a weak shape and the guidance shown while the points
 * are placed give the same figure in the same words.
 */
export function estimateSentence(position95M: number): string {
  return `Estimate: two scans would place a spot ${WORKING_RADIUS_M} m away up to about ${formatCm(position95M)} cm ` +
    `apart (95 of 100 times)`
}

function verdictOf(
  status: 'provisional' | 'mismatch',
  checkedBy: CheckedBy,
  compared: Compared,
  reasons: string[],
  withheld?: string[],
): ConstellationVerdict {
  if (withheld && withheld.length > 0) return { status, checkedBy, compared, reasons, withheld }
  return { status, checkedBy, compared, reasons }
}

/** A verdict that compared nothing: provisional, and the reasons say so. */
function noComparison(...reasons: string[]): ConstellationVerdict {
  return verdictOf('provisional', 'separation', 'nothing', reasons)
}

/** How far a size ratio is from 1, in words: "12%", or "less than 1%". */
function sizeDifference(ratio: number): string {
  const percent = Math.round(Math.abs(ratio - 1) * 100)
  return percent < 1 ? 'less than 1%' : `${percent}%`
}

/**
 * The verdict for a check of `pointsUsed` points.
 *
 * `'verified'` needs 3 or more points, an rms residual of at most
 * `RMS_GATE_SIGMAS * sigmaHat`, no point beyond `MAX_GATE_FACTOR` times that, and, when
 * `heightRmsResidualM` is given, a height residual within `HEIGHT_GATE_SIGMAS * sigmaHat`.
 * A two-point check is `'provisional'` at best, however good: it compared a distance and
 * nothing else. Beyond the position gates it is `'mismatch'`. When there is nothing
 * usable to compare it is `'provisional'`, `compared: 'nothing'`, and says so.
 *
 * Sigma-hat above `MAX_SIGMA_HAT_M` is not a way to hide a mismatch: the gates are then
 * applied at that limit, so a residual over them is still a mismatch, and one inside
 * them is `'provisional'` for taps too unsteady to rely on.
 *
 * A pass is still `'provisional'` (checked by constellation) when it cannot be relied
 * on, and `reasons` says which: heights beyond their gate, a similarity fit of too few
 * points (`fitMethod`), another order of the points that fits as well
 * (`alternativeOrder`), or a stored shape whose predicted accuracy (`expectedErrorM`) is
 * beyond {@link ACCURACY_TARGET_M}.
 *
 * `scaleRatio`, `headingResidualDeg` and `unitsMode` add what was measured to
 * `reasons`, and `unitsMode` names what sizes do not prove about metres. Only a size
 * ratio beyond {@link SCALE_RATIO_SANITY} can fail a check. Inside that range the size
 * never decides here, because a narrow limit on it turns away many correct re-taps of a
 * small constellation (see {@link SCALE_RATIO_SANITY}); with a similarity fit and metric
 * units, `verifyFit` judges the points without the size change instead.
 */
export function verifyConstellation(input: ConstellationVerdictInput): ConstellationVerdict {
  const { pointsUsed, rmsResidualM, maxResidualM } = input

  if (!Number.isInteger(pointsUsed) || pointsUsed < 0) {
    return noComparison('No usable measurement: nothing was compared.')
  }
  if (pointsUsed < 2) {
    return noComparison(`Only ${pointsUsed} point${pointsUsed === 1 ? '' : 's'}: nothing was compared.`)
  }
  if (
    !Number.isFinite(rmsResidualM) || !Number.isFinite(maxResidualM) ||
    rmsResidualM < 0 || maxResidualM < rmsResidualM * (1 - ROUNDING_SLACK)
  ) {
    return noComparison('No usable measurement: nothing was compared.')
  }

  const sigmaM = sigmaHat(input.sigmaHatM)
  const unsteady = sigmaM > MAX_SIGMA_HAT_M
  const gateSigmaM = Math.min(sigmaM, MAX_SIGMA_HAT_M)
  const rmsGateM = RMS_GATE_SIGMAS * gateSigmaM
  const maxGateM = MAX_GATE_FACTOR * rmsGateM
  const heightGateM = HEIGHT_GATE_SIGMAS * gateSigmaM
  const ofPoints = pointsUsed >= MIN_FIT_POINTS
  const checkedBy: CheckedBy = ofPoints ? 'constellation' : 'separation'
  const compared: Compared = ofPoints ? 'points' : 'distance'

  // Two points each sit half the spacing error off, so the spacing is twice the residual.
  const spacingSentence =
    `The two points are ${formatCm(2 * rmsResidualM)} cm off the stored distance (limit ${formatCm(2 * rmsGateM)} cm).`

  const gates: Array<{ text: string; failed: boolean }> = []
  const measured: string[] = []
  if (!ofPoints) {
    gates.push({ text: spacingSentence, failed: rmsResidualM > rmsGateM })
  } else {
    gates.push({
      text: `${pointsUsed} points are ${formatCm(rmsResidualM)} cm off the stored ones on average ` +
        `(limit ${formatCm(rmsGateM)} cm).`,
      failed: rmsResidualM > rmsGateM,
    })
    gates.push({
      text: `The worst point is ${formatCm(maxResidualM)} cm off (limit ${formatCm(maxGateM)} cm).`,
      failed: maxResidualM > maxGateM,
    })
  }
  // Heights do not make a mismatch: see HEIGHT_GATE_SIGMAS. A height beyond the gate only withholds "verified".
  let heightSentence: string | null = null
  let heightOver = false
  if (ofPoints && input.heightRmsResidualM !== undefined) {
    const heightM = input.heightRmsResidualM
    if (heightM !== null && Number.isFinite(heightM) && heightM >= 0) {
      heightSentence = `Heights are ${formatCm(heightM)} cm off on average (limit ${formatCm(heightGateM)} cm).`
      heightOver = heightM > heightGateM
    } else {
      measured.push('The heights could not be measured.')
    }
  }
  const failed = gates.filter((gate) => gate.failed).map((gate) => gate.text)

  if (input.scaleRatio !== undefined) {
    const ratio = input.scaleRatio
    if (ratio === null || !(Number.isFinite(ratio) && ratio > 0)) {
      measured.push('The size of the points could not be measured.')
    } else if (ratio < SCALE_RATIO_SANITY.min || ratio > SCALE_RATIO_SANITY.max) {
      failed.push(`Sizes differ by ${sizeDifference(ratio)}: too much to be the same points.`)
    } else {
      measured.push(`Sizes differ by ${sizeDifference(ratio)}.`)
    }
  }
  // Two points fit a direction exactly, so a direction "measured" from them is zero by construction.
  if (ofPoints && input.headingResidualDeg !== undefined) {
    const degrees = input.headingResidualDeg
    if (degrees !== null && Number.isFinite(degrees)) {
      measured.push(
        `The direction of the first two points is ${Math.abs(degrees).toFixed(1)}° off the stored direction.`,
      )
    } else {
      measured.push('The direction of the first two points could not be measured.')
    }
  }

  const other = ofPoints ? input.alternativeOrder : null
  const otherFits = !!other && Number.isFinite(other.rmsM) && other.rmsM <= rmsGateM

  if (failed.length > 0) {
    const hints = otherFits ? [other.swapsFirstTwo ? SWAPPED_SENTENCE : OTHER_ORDER_SENTENCE] : []
    return verdictOf('mismatch', checkedBy, compared, [...failed, ...measured, ...hints])
  }

  const withheld: string[] = []
  if (unsteady) {
    withheld.push(`Taps vary by ${formatCm(sigmaM)} cm between tries: too much to check the points.`)
  }
  if (heightOver && heightSentence) withheld.push(heightSentence)
  if (ofPoints) {
    // Each point gives two numbers; the turn and shift use three, a size change a fourth.
    const fitted = input.fitMethod === 'similarity' ? 4 : 3
    if (2 * pointsUsed - fitted < MIN_RESIDUAL_DOF) {
      const needed = Math.ceil((MIN_RESIDUAL_DOF + fitted) / 2)
      withheld.push(
        `${fitted === 4 ? 'Fitting a size change to' : 'Fitting'} ${pointsUsed} points leaves too little to check ` +
          `them: at least ${needed} are needed.`,
      )
    }
    if (otherFits) withheld.push(AMBIGUOUS_ORDER_SENTENCE)
    const expected = input.expectedErrorM
    if (typeof expected === 'number' && Number.isFinite(expected) && expected > ACCURACY_TARGET_M) {
      withheld.push(`${estimateSentence(expected)}, more than the ${formatCm(ACCURACY_TARGET_M)} cm aimed for.`)
    }
  }

  const limits = [NOT_CHECKED_SPOTS]
  if (input.unitsMode === 'arbitrary' || input.unitsMode === 'estimated-metric') {
    limits.push(NOT_CHECKED_METRES[input.unitsMode])
  }

  if (!ofPoints) {
    return verdictOf('provisional', 'separation', 'distance', [
      spacingSentence,
      'Direction was not checked: a third point is needed.',
      ...withheld,
      ...measured,
      ...limits,
    ], withheld)
  }

  const checked = gates.map((gate) => gate.text)
  if (heightSentence && !heightOver) checked.push(heightSentence)
  if (withheld.length > 0) {
    return verdictOf('provisional', 'constellation', 'points', [...checked, ...withheld, ...measured, ...limits], withheld)
  }
  return {
    status: 'verified',
    checkedBy: 'constellation',
    compared: 'points',
    reasons: [...checked, ...measured, ...limits],
  }
}

/**
 * The verdict for a two-point visit: the distance between this visit's two taps against
 * the stored one. Never `'verified'`; `'provisional'` while the distance is within
 * {@link twoPointToleranceM} and `'mismatch'` beyond it. A distance that is not a number
 * compares nothing, and says so. This is the door for two points: `verifyFit` of a
 * two-point outcome compares nothing, because a fit needs three.
 */
export function verifyTwoPoint(input: {
  separationM: number
  storedSeparationM: number
  sigmaHatM?: number | null
  unitsMode?: UnitsMode
}): ConstellationVerdict {
  const residualM = twoPointResidualM(input.separationM, input.storedSeparationM)
  return verifyConstellation({
    pointsUsed: 2,
    rmsResidualM: residualM,
    maxResidualM: residualM,
    sigmaHatM: sigmaHat(input.sigmaHatM),
    unitsMode: input.unitsMode,
  })
}

/**
 * The verdict for a fit's outcome, successful or not: the one call the flow needs for
 * three or more points.
 *
 * A fit is judged on its residuals, its heights and its order, and a similarity fit is
 * held to the same standard as a rigid one: with metric units the points are judged
 * without the size change (a size difference is then a different set of points), and
 * with other units a similarity fit needs 4 points to be verified. A shape whose
 * predicted accuracy at {@link WORKING_RADIUS_M} is beyond {@link ACCURACY_TARGET_M}
 * is not verified either.
 *
 * A failed fit is never `'verified'`. Mirrored or unmatched points are a `'mismatch'`:
 * the check ran and they do not agree (a mirrored visit that fits in another order says
 * so instead). Every other failure means too little to compare, so `'provisional'` with
 * `compared: 'nothing'` and the failure's own sentence.
 *
 * A two-point visit has no fit, so this reports it as provisional without comparing the
 * distance. Its distance check is {@link verifyTwoPoint}.
 */
export function verifyFit(
  outcome: FitOutcome,
  options: { sigmaHatM?: number | null; unitsMode?: UnitsMode } = {},
): ConstellationVerdict {
  const sigmaM = sigmaHat(options.sigmaHatM)
  const gateSigmaM = Math.min(sigmaM, MAX_SIGMA_HAT_M)

  if (!outcome.ok) {
    const { failure } = outcome
    if (failure.reason === 'mirrored') {
      const other = failure.alternativeOrder
      if (Number.isFinite(other.rmsM) && other.rmsM <= RMS_GATE_SIGMAS * gateSigmaM) {
        const sentence = other.swapsFirstTwo ? SWAPPED_SENTENCE : OTHER_ORDER_SENTENCE
        return verdictOf('mismatch', 'constellation', 'points', [sentence])
      }
      return verdictOf('mismatch', 'constellation', 'points', [failure.message])
    }
    if (failure.reason === 'unmatched') {
      return verdictOf('mismatch', 'constellation', 'points', [failure.message])
    }
    const detail = failure.reason === 'too-few-points' && failure.pointsGiven === 2
      ? `${failure.message} The distance between the two was not compared here.`
      : failure.message
    return noComparison(detail, NOT_CHECKED_SPOTS)
  }

  const { fit } = outcome
  // Metric units mean no size change is expected, so a similarity fit's size is not a unit difference to
  // absorb: it is a different set of points, and the residuals it left are the residuals with no size change.
  const unscaled = fit.fitMethod === 'similarity' && options.unitsMode === 'metric'
  // The estimate is of real accuracy, so it takes the tap spread as it is, above the cap too.
  const expected = predictUncertainty(
    fit.pointsUsed,
    fit.referenceSpreadM ** 2,
    sigmaM,
    WORKING_RADIUS_M,
    fit.fitMethod,
  )
  return verifyConstellation({
    pointsUsed: fit.pointsUsed,
    rmsResidualM: unscaled ? fit.unscaledRmsResidualM : fit.rmsResidualM,
    maxResidualM: unscaled ? fit.unscaledMaxResidualM : fit.maxResidualM,
    sigmaHatM: sigmaM,
    scaleRatio: fit.scaleRatio,
    headingResidualDeg: fit.headingResidualDeg,
    unitsMode: options.unitsMode,
    fitMethod: unscaled ? 'rigid' : fit.fitMethod,
    heightRmsResidualM: fit.heightRmsResidualM,
    alternativeOrder: fit.alternativeOrder,
    expectedErrorM: expected ? expected.position95M : null,
  })
}
