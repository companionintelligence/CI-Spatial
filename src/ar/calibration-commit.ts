/**
 * The calibration commit as pure functions: what a pair of floor taps (or one) becomes when the person commits
 * them, and what the Place's stored pair says about it.
 *
 * This was two closures inside the modal (`commitTwoPoint` and `commitSinglePoint` in ./project-calibration.ts),
 * runnable only by driving the modal's DOM. It is here so the shell and the arithmetic test separately, and so the
 * packages that change the flow (tap sampling, the constellation fit, scale policy, frame drift) change this module
 * and hang a few lines on the modal, instead of every one of them editing the same 1,400-line file (WP-04b step 0).
 *
 * Moving it changed nothing that is shown, stored or asked of the host. tests/unit/node/wp-calibration-commit.test.ts
 * runs the code it replaced beside it on 20,000 seeded inputs and requires the same records, numbers and sentences,
 * and tests/unit/node/wp-calibration-characterisation.test.ts holds the modal itself to what it did before.
 *
 * Pure: no DOM, no Deno, no clock, no provider (ADR 0002: the browser imports this file). The modal reads the
 * compass and the time at the moment it commits and passes them in, so what is recorded is what was read then.
 *
 * ## What the verdict checks, and what it does not
 *
 * A return visit to a Place with a stored two-point frame is compared with it (WP-04b), by what it tapped.
 *
 *  - Three points, against a stored frame that has a check point: a least-squares fit of the visit's points to the stored
 *    ones (`compareVisit` in ./constellation-flow.ts, `fitRigid2D`), so positions, which way the points face and heights
 *    are compared. `'verified'` only when the verdict (`verifyFit`, src/world/frame-fit.ts) says so, and that fit's matrix
 *    is the scan's `sessionToProject`. The scan records `fit` and `checkedBy: 'constellation'`.
 *  - Two points, or a Place with no check point: ONE number, the distance between the pair tapped now and the stored
 *    `separationM`, inside `twoPointToleranceM` (twice the rms gate at the tap noise in use). That compares nothing about
 *    direction or position, so the right pair tapped in the other order, or a different pair at the same spacing, passes as
 *    well, and the result is never better than `'provisional'` (`checkedBy: 'separation'`, ADR 0005 rule 3).
 *    src/ar/alignment-status.ts words the result for the person that way.
 *
 * Either way `toleranceM` on the scan is the spacing tolerance the distance check applies, so the number written is the
 * one a verdict used and the stored frame's own `toleranceM` (the 0.15 m of the build before) is no longer read. A check
 * point is never added to an existing frame: only a first calibration, or a frame the person replaced ("Use anyway"),
 * stores one (see ./constellation-flow.ts).
 *
 * ## The seams
 *
 * {@link CommitOptions} carries three things the later packages fill. Each defaults to what the modal always did.
 * The modal fills the first two when the host gives it a `sampleTap` (./calibration-taps.ts), and nothing outside the
 * modal can set the third yet: it is not on the modal's own options (`CalibrationOptions`), and the package that
 * wires it adds it there and calls it from the few lines that need it.
 *
 *  - `sampleTap(x, y)`: how a floor tap is read. Default: one hit from the host's `hitTest`, one call per tap. It
 *    answers a point, a refusal or null, and one that rejects has found nothing. A point may say how high the tap
 *    was (`TappedPoint.surfaceY`, for the floor gate); a refusal carries the sentence the person is told
 *    (`RefusedTap`); null is a tap that found nothing at all. What else a reader measured about a tap (its scatter,
 *    its range, the floor height it implies) stays with the reader, which hands it back at commit through
 *    `TwoPointBuildInput.tap`: nothing here depends on what else a tap carries.
 *  - `isDisturbed()`: whether the AR session's frame has moved since the points were placed, so that they can no
 *    longer be committed. Default: never. It is asked once per commit, when the verdict is made (the person has
 *    pressed Commit), before a reference photo is requested. It is not asked again after the photo wait, which can
 *    last `CAPTURE_FRAME_TIMEOUT_MS` (8 s, src/main.ts): a shift in that time is not seen by this check, and the
 *    modal looks again after the wait, where the wait is, for a shift of the map and not for the clock: the press
 *    was in time. The one-point tier, which has no walk to a second point, is given a check with no clock at all. A
 *    commit it turns away is not an error: the verdict says `'refused'`, and the modal sends the person back to the
 *    landmark with the sentence `placementDisturbedText()` (./tracking-quality.ts) gives.
 *  - `sigmaHatM`: the per-axis tap noise, in metres, every verdict is judged by: the gates of a fit and the spacing
 *    tolerance of a pair are multiples of it. Default: `TAP_SIGMA0_M` (../world/baseline-guidance.ts), which is adopted,
 *    not measured (ADR 0005 rule 5). The spread of one burst of hits is not between-visit noise and is not fed into it
 *    (device experiment DX2 sets this number).
 */
import {
  MIN_POINT_SEPARATION_M,
  oneTapToProjectTransform,
  projectBearingDeg,
  twoPointBearingFields,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../world/geo.ts'
import { TAP_SIGMA0_M, checkPointGuidance } from '../world/baseline-guidance.ts'
import type { TapEvidence } from '../world/calibration-evidence.ts'
import { summariseFit, twoPointToleranceM, type UnitsMode } from '../world/frame-fit.ts'
import type { BearingConvention, ProjectSpatialFrame, ScanCalibration, Vec3 } from '../world/types.ts'
import { compareVisit, newReference, type VisitComparison } from './constellation-flow.ts'
import { committedStatus, leavesScanOutsidePlaceFrame, mayWritePlaceFrame } from './ground-gate.ts'

export type TwoPointFrame = Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
export type OnePointFrame = Extract<ProjectSpatialFrame, { method: 'ground-tap-compass' }>
export type TwoPointCalibration = Extract<ScanCalibration, { method: 'two-point-ground' }>
export type OnePointCalibration = Extract<ScanCalibration, { method: 'ground-tap-compass' }>

/**
 * What the one-point tier says when it has no compass bearing to build a heading from: no reading at all, or one
 * that cannot be paired with where the camera points now (a camera that looks nearly at the floor has no bearing:
 * see `pairCompassWithPose` in src/geo/compass-heading.ts). It used to commit anyway, with the frame left at
 * whatever yaw the AR session happened to boot with, and store that as a valid frame.
 */
export const ONE_POINT_NEEDS_COMPASS = 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.'

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────

/** Where a tap landed, in session metres. A runtime's hit result is one, and so is the median of several. */
export interface TappedPoint {
  position: Vec3
  /**
   * How high the person tapped, when that is not `position.y`: a tap the floor ray placed has the fitted floor's
   * height by construction, and the floor gate must judge what the hits measured. Absent, `position.y` is it.
   */
  surfaceY?: number
}

/** A tap a reader turned away, and the sentence the person is told. The person taps again; it is not an error. */
export interface RefusedTap {
  refused: string
}

/** Reads one tap at normalised canvas coordinates; null when nothing stable was there. */
export type TapReader = (x: number, y: number) => Promise<TappedPoint | RefusedTap | null>

export interface CommitOptions {
  /** The host's hit test: one hit per call. Read when no `sampleTap` is given, which is what the modal always did. */
  hitTest: TapReader
  /** A better reader than one hit (a burst, a median). Default: `hitTest`. */
  sampleTap?: TapReader
  /**
   * Whether the session's frame moved since the points were placed. Default: never. Asked once per commit, when the
   * verdict is made, and not again after the reference-photo wait (see the header).
   */
  isDisturbed?: () => boolean
  /** Tap noise per floor axis, metres. Default `TAP_SIGMA0_M`; a value that is not a positive number is the default. */
  sigmaHatM?: number
}

export interface ResolvedCommitOptions {
  readonly sampleTap: TapReader
  readonly isDisturbed: () => boolean
  readonly sigmaHatM: number
}

const usableSigmaM = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The options with their defaults filled in. The readers are called through `options`, as the modal always called
 * its hit test, so a host method keeps its `this` and one swapped in later is the one used.
 */
export function resolveCommitOptions(options: CommitOptions): ResolvedCommitOptions {
  return {
    sampleTap: (x, y) => (options.sampleTap ? options.sampleTap(x, y) : options.hitTest(x, y)),
    isDisturbed: () => (options.isDisturbed ? options.isDisturbed() : false),
    sigmaHatM: usableSigmaM(options.sigmaHatM) ? options.sigmaHatM : TAP_SIGMA0_M,
  }
}

/** Reads one tap. A reader that rejects found nothing, which is what a failed hit test always meant. */
export function readTap(options: ResolvedCommitOptions, x: number, y: number): Promise<TappedPoint | RefusedTap | null> {
  return options.sampleTap(x, y).catch(() => null)
}

// ── Two points ───────────────────────────────────────────────────────────────────────────────────────

export interface TwoPointInput {
  /** The points as they were tapped, in session metres. Only x and z steer the frame; a fit also compares the heights. */
  landmark: Vec3
  headingMarker: Vec3
  /**
   * The check point tapped this visit, as it was tapped, or null/absent when the visit took none. Compared with the Place's
   * stored check point when it has one; stored as the new frame's check point when this visit writes the frame. Ignored
   * against a stored frame with no check point: a check point is never added to an existing frame.
   */
  checkPoint?: Vec3 | null
  /** The Place's stored two-point frame, when this visit is measured against one. */
  stored: TwoPointFrame | null
  /** "Use anyway": record this visit's points despite a mismatch, which costs the `'verified'` status by definition. */
  override: boolean
  /** What the phone's session units are, when the provider says: a verdict then names what sizes do not prove about metres. */
  unitsMode?: UnitsMode
  /**
   * This visit bypassed a floor check ("Place anchor without floor check", or an off-floor tap accepted by a same-height
   * retry) and the points it holds still do. Such a commit is always `'provisional'` and never writes the Place's frame, first
   * creation included (`mayWritePlaceFrame`, ./ground-gate.ts: the Place frame's floor is authored by a floor-checked calibration
   * only). Its scan is in the frame the Place holds only if it was compared with it and matched (`outsidePlaceFrame` on the verdict).
   */
  floorCheckBypassed?: boolean
}

/** A visit that may be committed, and what committing it means. */
export interface AcceptedTwoPoint {
  kind: 'accepted'
  separationM: number
  /** This visit's separation minus the stored one, in metres. 0 when nothing is stored. */
  residualM: number
  /** The spacing tolerance the distance check applies (`twoPointToleranceM` at the tap noise in use). */
  toleranceM: number
  /** Whether the Place's durable frame changes: a first calibration, or points kept over a mismatch. */
  frameChanged: boolean
  /**
   * `true`, and only when it is true, if this commit leaves the scan in no Place frame (`leavesScanOutsidePlaceFrame`,
   * ./ground-gate.ts): it wrote no frame, and was not compared with the held one, or was and was kept over a mismatch. A bypassed
   * floor check is the only way there is to that. The scan's `sessionToProject` is then this visit's own pair and nothing ties it
   * to the Place's, so it names no generation (`planFrameGeneration`, ../world/frame-replacement.ts) and every reader counts it
   * with the scans that are not in a frame (`isInPlaceFrame`, ../world/frame-generations.ts). Absent for every other commit.
   */
  outsidePlaceFrame?: true
  /**
   * `'verified'` is a measurement here, not a label: a visit whose points a fit of three or more compared with the
   * stored ones and found in agreement with nothing in the way. A distance check is never verified.
   */
  status: 'verified' | 'provisional'
  /**
   * This scan's `sessionToProject`: the fit's matrix for a visit that was fitted, and for every other the two-point
   * transform (a first calibration and a frame kept over a mismatch define the frame, so the transform IS the frame).
   */
  sessionToProject: number[]
  /**
   * The yaw in the session, in degrees, of the Place's +Z axis under `sessionToProject` (the sign of `twoPointHeadingDeg`), when
   * the matrix is a fit's: the fit's own heading, which is not the tapped baseline's by the heading residual the record keeps.
   * Absent when the matrix is the two-point transform, whose +Z IS the tapped baseline. The compass bearing recorded for the
   * Place's +Z is read from it, so that the bearing and the matrix on one record describe the same axis.
   */
  frameYawDeg?: number
  /** How the visit's points compared with the stored ones. Absent on a first calibration, which has nothing to compare with. */
  comparison?: VisitComparison
  /** The check point the new frame stores, in the Place frame. Present only when this visit writes the frame and took one. */
  checkPoint?: Vec3
}

export type TwoPointVerdict =
  /**
   * Not now: the session moved under the points (`isDisturbed`), they are under `MIN_POINT_SEPARATION_M` apart, or the
   * check point cannot serve as a reference (`'check-point'`: too close to another point or almost on the line), in which
   * case `text` says why.
   */
  | { kind: 'refused'; reason: 'disturbed' | 'too-close' }
  | { kind: 'refused'; reason: 'check-point'; text: string }
  /** The comparison failed, and the points were not kept anyway. `comparison.verdict` says how, in sentences. */
  | { kind: 'mismatch'; separationM: number; residualM: number; toleranceM: number; comparison: VisitComparison }
  | AcceptedTwoPoint

/**
 * What a visit's points come to, measured against the Place's stored ones.
 *
 * A first calibration has nothing to compare with and is accepted as provisional, with the check point it took (if it
 * took one and the three points can serve as a reference) as part of the frame it writes. A visit to a stored frame is
 * compared by `compareVisit` (./constellation-flow.ts): a fit when it tapped a check point the Place stores, the distance
 * otherwise. A mismatch is sent back for the person to adjust, re-place or keep; kept ("Use anyway"), it replaces the
 * Place's frame with this visit's points, provisionally.
 *
 * A comparison that is not a number (a tap with no usable position, a stored separation that is not one) compares
 * nothing, and says so: it is provisional, as `verifyTwoPoint` and `verifyFit` report it, never verified.
 */
export function assessTwoPoint(input: TwoPointInput, options: ResolvedCommitOptions): TwoPointVerdict {
  if (options.isDisturbed()) return { kind: 'refused', reason: 'disturbed' }
  const { landmark, headingMarker, stored, override } = input
  const checkPoint = input.checkPoint ?? null
  const separationM = twoPointSeparationM(landmark, headingMarker)
  if (separationM < MIN_POINT_SEPARATION_M) return { kind: 'refused', reason: 'too-close' }

  const toleranceM = twoPointToleranceM(options.sigmaHatM)
  const comparison = stored
    ? compareVisit({
      tapped: { landmark, headingMarker, checkPoint },
      stored,
      sigmaHatM: options.sigmaHatM,
      unitsMode: input.unitsMode,
    })
    : null
  if (comparison && comparison.verdict.status === 'mismatch' && !override) {
    return { kind: 'mismatch', separationM, residualM: comparison.residualM, toleranceM, comparison }
  }

  const bypassed = input.floorCheckBypassed === true
  const frameChanged = mayWritePlaceFrame({ floorCheckBypassed: bypassed, hasStoredFrame: !!stored, override })
  const outsidePlaceFrame = leavesScanOutsidePlaceFrame({ frameWritten: frameChanged, comparedWithStored: comparison !== null, override })
  let reference: ReturnType<typeof newReference> | null = null
  if (frameChanged) {
    reference = newReference(landmark, headingMarker, checkPoint)
    if (reference.problem) {
      return { kind: 'refused', reason: 'check-point', text: checkPointGuidance(landmark, headingMarker, checkPoint!, options.sigmaHatM).text }
    }
  }
  return {
    kind: 'accepted',
    separationM,
    residualM: comparison ? comparison.residualM : 0,
    toleranceM,
    frameChanged,
    ...(outsidePlaceFrame ? { outsidePlaceFrame: true as const } : {}),
    // 'verified' takes two things. The commit may be called verified at all (it was compared with a stored frame, was not kept over a
    // mismatch and did not bypass the floor check: `committedStatus`, ./ground-gate.ts), and the match was measured, which is the fit's
    // verdict and never a distance (ADR 0005 rule 3).
    status: committedStatus({ hasStoredFrame: !!stored, override, floorCheckBypassed: bypassed }) === 'verified'
      && comparison?.verdict.status === 'verified' ? 'verified' : 'provisional',
    sessionToProject: comparison && !override
      ? comparison.sessionToProject
      : twoPointToProjectTransform(landmark, headingMarker),
    ...(comparison?.fit && !override ? { frameYawDeg: comparison.fit.headingDeg } : {}),
    ...(comparison ? { comparison } : {}),
    ...(reference?.checkPoint ? { checkPoint: reference.checkPoint } : {}),
  }
}

/**
 * What the mismatch screen says about a pair that did not match: how far off it was, and which way. The number is
 * a whole count of centimetres; the direction is "closer together" for anything not positive.
 */
export function mismatchCopy(residualM: number): string {
  const off = Math.abs(residualM * 100).toFixed(0)
  const direction = residualM > 0 ? 'further apart' : 'closer together'
  return `Measured ${off} cm ${direction} than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.`
}

export interface TwoPointBuildInput {
  landmark: Vec3
  headingMarker: Vec3
  /**
   * The bearing of the session frame's +Z (`sessionFrameBearingDeg`), sampled together with the pose at the
   * moment of commit, or null with no compass reading. Metadata only on this tier: recorded so absolute
   * orientation is available for GPS placement, never read to build the frame (ADR 0005).
   */
  frameBearingDeg: number | null
  /** The sign rule that bearing was computed under; written beside it. */
  bearingConvention: BearingConvention
  /** `pointLabels` for the Place frame: the two typed descriptions, or undefined when neither was named. */
  pointLabels: [string, string] | undefined
  /** What the person called the check point, when this commit writes one and they named it. */
  checkPointLabel?: string
  /** `new Date().toISOString()` at the moment of commit. */
  calibratedAt: string
  /**
   * What the tap behind the landmark measured (`ScanCalibration.tap`), when the reader that took it measured taps.
   * Kept on the calibration as given and read by nothing here: it is evidence, not an input to the frame.
   */
  tap?: TapEvidence
  /** The same flag the verdict was assessed with: written on the calibration, so the record says the floor was not checked. */
  floorCheckBypassed?: boolean
}

export interface TwoPointCommit {
  calibration: TwoPointCalibration
  /** The Place's new durable frame; undefined when a stored frame was merely matched and is kept as it is. */
  spatialFrame: TwoPointFrame | undefined
}

/**
 * The records for a visit the verdict accepted.
 *
 * Key order is the layout a stored record has: the fields the first two-point records carried, in the order they were
 * written, and then what later builds added (`fit`, `checkedBy` on the calibration; `pointLabels`, then `checkPoints`
 * on the frame), so a record written now begins as the ones before it did.
 */
export function buildTwoPointCommit(verdict: AcceptedTwoPoint, input: TwoPointBuildInput): TwoPointCommit {
  const { landmark, headingMarker, frameBearingDeg, bearingConvention, calibratedAt } = input
  const { separationM, residualM, toleranceM, comparison } = verdict
  const calibration: TwoPointCalibration = {
    method: 'two-point-ground',
    sessionToProject: verdict.sessionToProject,
    separationM,
    residualM,
    toleranceM,
    anchorBearingDeg: frameBearingDeg,
    // The bearing of the Place's +Z belongs to the matrix beside it: the tapped baseline's for the two-point transform, and
    // the fit's own heading for a fit, which is not the baseline's by the heading residual the record keeps (`fit.headingResidualDeg`).
    ...(verdict.frameYawDeg === undefined
      ? twoPointBearingFields(frameBearingDeg, landmark, headingMarker, bearingConvention)
      : { projectBearingDeg: projectBearingDeg(frameBearingDeg, verdict.frameYawDeg, bearingConvention), bearingConvention }),
    // The floor the origin sits on, in session metres: the landmark's own measured height, already snapped onto the
    // established plane (wave 12). Recorded with the scan so it can be read back without decomposing the matrix. It is the landmark's
    // datum: for the two-point transform that is the matrix's own floor, and for a fit it is not, because a fit's matrix is aligned on
    // the mean height of its points, so its floor is off by the vertical residual the record keeps (`fit.perPoint[0].dy`).
    groundY: landmark.y,
    floorCheckBypassed: input.floorCheckBypassed === true,
    // The record's own statement that its scan is in no Place frame, written only when it is true: a record in the frame it wrote or
    // matched has no such key, as every record an earlier build wrote has none. It is declared on `ScanCalibration`
    // (../world/types.ts), and the readers are `outsidePlaceFrameOf` (../world/frame-generations.ts) and `calibrationFromMeta`.
    ...(verdict.outsidePlaceFrame ? { outsidePlaceFrame: true as const } : {}),
    ...(input.tap ? { tap: input.tap } : {}),
    calibratedAt,
    status: verdict.status,
    // What this visit's points measured against the stored ones, and the check that rests on: absent on a first calibration,
    // which compared nothing. Kept on a visit whose points were kept over a mismatch, where it records what failed.
    ...(comparison?.fit ? { fit: summariseFit(comparison.fit) } : {}),
    ...(comparison ? { checkedBy: comparison.checkedBy } : {}),
  }

  const checkPointLabel = input.checkPointLabel?.trim()
  const spatialFrame: TwoPointFrame | undefined = verdict.frameChanged
    ? {
        version: 1,
        createdAt: calibratedAt,
        method: 'two-point-ground',
        // Project-space by construction: the transform above sends the landmark to the origin and the heading
        // marker onto +Z at `separationM`. Stored explicitly so the record is self-describing.
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: separationM },
        separationM,
        toleranceM,
        anchorBearingDeg: frameBearingDeg,
        ...twoPointBearingFields(frameBearingDeg, landmark, headingMarker, bearingConvention),
        ...(input.pointLabels ? { pointLabels: input.pointLabels } : {}),
        // The check point is in the Place frame like the other two, with its own height above the landmark's: the fit compares it.
        ...(verdict.checkPoint
          ? {
              checkPoints: [{
                x: verdict.checkPoint.x,
                y: verdict.checkPoint.y,
                z: verdict.checkPoint.z,
                ...(checkPointLabel ? { label: checkPointLabel } : {}),
              }],
            }
          : {}),
        // `referencePhotos` (and a check point's `photo`) are intentionally absent here. The URLs and local keys do not
        // exist until the host has stored and uploaded the bytes, so the host attaches them to this frame before it is
        // persisted: see `referencePhotos` on `CalibrationResult` in ./project-calibration.ts.
      }
    : undefined

  return { calibration, spatialFrame }
}

// ── One point ────────────────────────────────────────────────────────────────────────────────────────

export interface OnePointInput {
  /** The one floor tap, in session metres. It becomes the project origin. */
  landmark: Vec3
  /** The session frame's compass bearing at the moment of commit, or null. Load-bearing on this tier: it is the frame's heading. */
  frameBearingDeg: number | null
  bearingConvention: BearingConvention
  /** The Place's stored frame, of whatever method, or none. */
  existingFrame: ProjectSpatialFrame | null | undefined
  calibratedAt: string
  /** This visit bypassed a floor check: the record says so, and it writes no Place frame (`mayWritePlaceFrame`). */
  floorCheckBypassed?: boolean
}

export type OnePointOutcome =
  /**
   * Not committed, and not recorded as something weaker instead. `'no-compass'`: the compass is this tier's whole
   * heading, so with no reading there is none to build and the frame is not left at the session's arbitrary yaw;
   * `text` says so. `'disturbed'` (`isDisturbed`): `text` is null, because what to say is the wiring package's.
   */
  | { kind: 'refused'; reason: 'disturbed' | 'no-compass'; text: string | null }
  | { kind: 'committed'; calibration: OnePointCalibration; spatialFrame: OnePointFrame | undefined }

/** #141's single-tap tier, kept for rooms where a second point is impractical. */
export function buildOnePointCommit(input: OnePointInput, options: ResolvedCommitOptions): OnePointOutcome {
  if (options.isDisturbed()) return { kind: 'refused', reason: 'disturbed', text: null }
  const { landmark, frameBearingDeg, bearingConvention, existingFrame, calibratedAt } = input
  const sessionToProject = oneTapToProjectTransform(landmark, frameBearingDeg, bearingConvention)
  if (!sessionToProject) return { kind: 'refused', reason: 'no-compass', text: ONE_POINT_NEEDS_COMPASS }

  const calibration: OnePointCalibration = {
    method: 'ground-tap-compass',
    sessionToProject,
    anchorBearingDeg: frameBearingDeg,
    bearingConvention,
    calibratedAt,
    // A single anchor is project-space (0,0,0) by construction, so it always agrees with itself: there is
    // nothing here to verify against.
    status: 'provisional',
    groundY: landmark.y,
    floorCheckBypassed: input.floorCheckBypassed === true,
  }
  // Never downgrade a stored frame to this tier: a Place that already has a reference keeps it, and this
  // session simply aligns provisionally.
  // A bypassed floor check never writes the Place frame either.
  const spatialFrame: OnePointFrame | undefined = existingFrame || input.floorCheckBypassed === true
    ? undefined
    : {
        version: 1,
        createdAt: calibratedAt,
        method: 'ground-tap-compass',
        anchorBearingDeg: frameBearingDeg,
        bearingConvention,
      }
  return { kind: 'committed', calibration, spatialFrame }
}
