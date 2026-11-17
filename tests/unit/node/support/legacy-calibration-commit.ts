/**
 * The calibration commit as it was before it moved to src/ar/calibration-commit.ts (WP-04b step 0). The reference
 * the pure module is held to, in tests/unit/node/wp-calibration-commit.test.ts, over thousands of inputs.
 *
 * These are the statements of `commitTwoPoint` and `commitSinglePoint` in src/ar/project-calibration.ts as it stood at
 * the combined tree's index before the move (git blob fb391fbc996fcbb1deb41a22f2701357e2fb03bb, lines 1077-1165 and
 * 1168-1207), of the mismatch sentence in its `renderStage` (lines 935-937), and of the tap read in `placeAt` (line
 * 1300), copied as they were. Two things differ, and only these two: the variables the closure read are parameters, and
 * each call that touched the DOM (`renderStage()`, `close()`, the photo capture, the scene) is a returned value saying
 * which one it was. Every statement that computes a number, a string or a record is the old one, in the old order, with
 * the old operators. A comment from the original is kept where it says why a line is the way it is.
 *
 * Do not edit it to match the new module: if the two disagree, the new module has changed behaviour. Do not import
 * it from anywhere else. Retire it, with the differential that uses it, when WP-04b step 2 replaces the separation
 * verdict with the fit: from then on the two are meant to differ.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import {
  twoPointBearingFields,
  twoPointToProjectTransform,
  twoPointSeparationM,
  MIN_POINT_SEPARATION_M,
  DEFAULT_SEPARATION_TOLERANCE_M,
  oneTapToProjectTransform,
} from '../../../../src/world/geo.ts'
import type { BearingConvention, ProjectSpatialFrame, ScanCalibration, Vec3 } from '../../../../src/world/types.ts'

export const ONE_POINT_NEEDS_COMPASS = 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.'

export interface LegacyTwoPointContext {
  landmark: Vec3
  headingMarker: Vec3
  /** `storedTwoPoint`: the Place's frame when its method is two-point, else null. */
  storedTwoPoint: Extract<ProjectSpatialFrame, { method: 'two-point-ground' }> | null
  override: boolean
  /** What `frameBearing()` returned when the commit completed. */
  bearingDeg: number | null
  bearingConvention: BearingConvention
  /** `committedLabels`: called afresh each time, as the closure was. */
  committedLabels: () => [string, string] | undefined
  /** What `new Date().toISOString()` returned when the commit completed. */
  calibratedAt: string
}

export type LegacyTwoPoint =
  /** `renderStage(); return` under the minimum. */
  | { kind: 'too-close' }
  /** `mismatchResidualM = residualM; stage = 'mismatch'`. */
  | { kind: 'mismatch'; residualM: number }
  /** The `close({ calibration, spatialFrame, ...(frameChanged ? { referencePhotos } : {}) })` that follows the photos. */
  | { kind: 'commit'; calibration: ScanCalibration; spatialFrame: ProjectSpatialFrame | undefined; frameChanged: boolean }

export function legacyCommitTwoPoint(context: LegacyTwoPointContext): LegacyTwoPoint {
  const { landmark, headingMarker, storedTwoPoint, override, bearingDeg, bearingConvention, committedLabels, calibratedAt } = context
  const separationM = twoPointSeparationM(landmark, headingMarker)
  if (separationM < MIN_POINT_SEPARATION_M) {
    return { kind: 'too-close' }
  }

  const toleranceM = storedTwoPoint?.toleranceM ?? DEFAULT_SEPARATION_TOLERANCE_M
  const residualM = storedTwoPoint ? separationM - storedTwoPoint.separationM : 0
  if (storedTwoPoint && !override && Math.abs(residualM) > toleranceM) {
    return { kind: 'mismatch', residualM }
  }

  const frameChanged = !storedTwoPoint || override
  const calibration: ScanCalibration = {
    method: 'two-point-ground',
    sessionToProject: twoPointToProjectTransform(landmark, headingMarker),
    separationM,
    residualM,
    toleranceM,
    anchorBearingDeg: bearingDeg,
    ...twoPointBearingFields(bearingDeg, landmark, headingMarker, bearingConvention),
    calibratedAt,
    // 'verified' is a measurement here, not a label: it requires a stored
    // reference that this session's re-measured separation actually matched.
    status: storedTwoPoint && !override ? 'verified' : 'provisional',
  }

  const spatialFrame: ProjectSpatialFrame | undefined = frameChanged
    ? {
        version: 1,
        createdAt: calibratedAt,
        method: 'two-point-ground',
        // Project-space by construction: the transform above sends the
        // landmark to the origin and the heading marker onto +Z at
        // `separationM`. Stored explicitly so the record is self-describing.
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: separationM },
        separationM,
        toleranceM,
        anchorBearingDeg: bearingDeg,
        ...twoPointBearingFields(bearingDeg, landmark, headingMarker, bearingConvention),
        ...(committedLabels() ? { pointLabels: committedLabels() } : {}),
      }
    : undefined

  return { kind: 'commit', calibration, spatialFrame, frameChanged }
}

export interface LegacyOnePointContext {
  landmark: Vec3
  bearingDeg: number | null
  bearingConvention: BearingConvention
  /** `existingFrame`: the Place's stored frame of any method. */
  existingFrame: ProjectSpatialFrame | null | undefined
  calibratedAt: string
}

export type LegacyOnePoint =
  /** `transientStatus = ONE_POINT_NEEDS_COMPASS; renderStage(); return`. */
  | { kind: 'refused'; transientStatus: string }
  /** The `close({ calibration, spatialFrame })`. */
  | { kind: 'commit'; calibration: ScanCalibration; spatialFrame: ProjectSpatialFrame | undefined }

export function legacyCommitSinglePoint(context: LegacyOnePointContext): LegacyOnePoint {
  const { landmark, bearingDeg, bearingConvention, existingFrame, calibratedAt } = context
  const sessionToProject = oneTapToProjectTransform(landmark, bearingDeg, bearingConvention)
  if (!sessionToProject) {
    return { kind: 'refused', transientStatus: ONE_POINT_NEEDS_COMPASS }
  }
  const calibration: ScanCalibration = {
    method: 'ground-tap-compass',
    sessionToProject,
    anchorBearingDeg: bearingDeg,
    bearingConvention,
    calibratedAt,
    // A single anchor is project-space (0,0,0) by construction, so it always
    // agrees with itself — there is nothing here to verify against.
    status: 'provisional',
  }
  // Never downgrade a stored frame to this tier: a Place that already has a
  // reference keeps it, and this session simply aligns provisionally.
  const spatialFrame: ProjectSpatialFrame | undefined = existingFrame
    ? undefined
    : {
        version: 1,
        createdAt: calibratedAt,
        method: 'ground-tap-compass',
        anchorBearingDeg: bearingDeg,
        bearingConvention,
      }
  return { kind: 'commit', calibration, spatialFrame }
}

/** What `renderStage()` wrote into the card's copy for the mismatch stage. */
export function legacyMismatchCopy(mismatchResidualM: number): string {
  const off = Math.abs(mismatchResidualM * 100).toFixed(0)
  const direction = mismatchResidualM > 0 ? 'further apart' : 'closer together'
  return `Measured ${off} cm ${direction} than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.`
}

/** `placeAt`'s read of a tap: `options.hitTest` is the host's, called through the options object. */
export function legacyReadTap(
  options: { hitTest: (x: number, y: number) => Promise<{ position: Vec3 } | null> },
  x: number,
  y: number,
): Promise<{ position: Vec3 } | null> {
  return options.hitTest(x, y).catch(() => null)
}
