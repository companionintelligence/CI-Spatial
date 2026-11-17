/**
 * What a calibration keeps about how it was measured: the shapes `ScanCalibration` (./types.ts) stores
 * as `tap`, `fit` and `checkedBy`.
 *
 * Declared here and nowhere else. `src/ar/tap-sampling.ts` and `./frame-fit.ts` build these records and
 * re-export the types under the names they have always had, so their callers are unchanged. They cannot be
 * declared in those two files: `ScanCalibration` is read by the browser, by the Deno server and by the Node
 * tests, and a type the server reads must not sit in a module that imports the AR provider (three.js and
 * the DOM, ADR 0002). `frame-fit.ts` declaring them would be no better the other way round: it imports
 * `Vec3` from ./types.ts, so ./types.ts importing it back would make the hub part of an import cycle. A
 * leaf with no imports is below both, as ./scale-mode.ts and ./manifests.ts are. The evidence a fiducial
 * calibration keeps (WP-14b) belongs here for the same reason: the detector that builds it imports the AR
 * provider.
 *
 * Pure data and no values: no Deno, no DOM, nothing to import (ADR 0002).
 */

/** Where a tap's position came from. */
export type TapSource =
  /** The per-axis median of a burst of hits. */
  | 'burst'
  /** One hit: the provider has no burst, or its burst saw no frame. Its scatter is unknown. */
  | 'single-hit'
  /** The camera ray through the pixel met the fitted floor. No feature hit set this position. */
  | 'floor-ray'

/**
 * What a scan keeps about the tap that set its frame (the PF-12 minimum). The
 * landmark's, with the datum `tapLandmarkDatum()` gave it, for `landmarkAboveFloorM`;
 * build the heading marker's with no datum. `ScanCalibration.tap` holds it; the flow
 * that wires `sampleTap()` in is what writes it.
 */
export interface TapEvidence {
  /** Scatter of the hits behind the tap, metres. Null when the tap was one hit or the floor ray alone. */
  tapSpreadM: number | null
  /** Camera to tap, metres. */
  tapRangeM: number
  tapSource: TapSource
  /** The landmark's signed height above the reliable fitted floor, metres. Null when no reliable fit existed. */
  landmarkAboveFloorM: number | null
}

export type FitMethod = 'rigid' | 'similarity'

/** One point's disagreement after a fit, in metres: where it lands minus its target. */
export interface PointResidual {
  /** Horizontal distance, `hypot(dx, dz)`. */
  residualM: number
  dx: number
  /** Vertical, left over after the mean height offset. Gated through `FrameFit.heightRmsResidualM`. */
  dy: number
  dz: number
}

/** The part of a fit worth keeping on a scan; the matrix is already `sessionToProject`. JSON-safe. */
export interface FitSummary {
  fitMethod: FitMethod
  pointsUsed: number
  rmsResidualM: number
  maxResidualM: number
  perPoint: PointResidual[]
  headingResidualDeg: number | null
  scaleRatio: number
}

/**
 * Which check a verdict rests on: the positions of three or more points (`'constellation'`), or only the
 * distance between two (`'separation'`, which is also what a verdict that compared nothing reports).
 */
export type CheckedBy = 'constellation' | 'separation'

/** Fewest points a fit accepts: two points fix the frame exactly and leave nothing to check. */
export const MIN_FIT_POINTS = 3

/**
 * Most points a fit accepts. The schema holds five (landmark, heading marker and up to
 * three check points); this leaves room. It bounds the quadratic duplicate scan and the
 * search over every order of the points (n! of them), so that a corrupt record with
 * thousands of points cannot freeze a client: more is refused as `too-many-points`.
 * **Adopted, not measured.**
 */
export const MAX_FIT_POINTS = 8
