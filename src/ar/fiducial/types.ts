/**
 * Types for the printed fiducial anchor (WP-14a): detector, pose and print sheet.
 *
 * Browser-safe (ADR 0002): no Deno reference anywhere under `src/ar/fiducial/`, so the
 * scanner, the editor and Node tests can all import from here, type-only or not.
 *
 * ## Conventions, stated once because every file in this folder depends on them
 *
 * **Image pixels.** `x` to the right, `y` DOWN, origin at the top-left CORNER of the image:
 * pixel (i, j) covers [i, i + 1] x [j, j + 1] and its centre is (i + 0.5, j + 0.5). This is the
 * convention a projection matrix implies (NDC -1 is the image's left edge, not the centre of
 * its first pixel), which is why the intrinsics code in `tag-pose.ts` needs no half-pixel
 * correction.
 *
 * **Tag frame.** Origin at the centre of the black square, +x along the printed top edge to
 * the right, +y up the printed face, +z out of the paper toward the viewer (right-handed).
 * The four corners are always reported in the order printed top-left, top-right,
 * bottom-right, bottom-left, which is clockwise on screen when the tag is seen face-on. That
 * order is what pins the tag's in-plane rotation: it comes from which of the four rotations
 * of the code matched the dictionary, so the detector reports it and nothing else has to
 * guess.
 *
 * **Camera frame (inside `tag-pose.ts`).** OpenCV-style: +x right, +y down, +z forward. This
 * is NOT the three.js camera (which looks down -z with +y up) that `ARProvider.getPose()`
 * reports. `tag-pose.ts` converts at the one place it takes a session pose in.
 *
 * **Session frame.** The AR runtime's own world coordinates (three.js, +y up). Under 8th
 * Wall's default "responsive" scale one session unit is not a metre; see
 * `FusedTagPose.sessionUnitsPerMetre`.
 */
import type { Pose } from '../provider.ts'
import type { Vec3 } from '../../world/types.ts'

/** A point in image pixels (see the convention above). */
export interface Point2 {
  x: number
  y: number
}

/** Four corners, clockwise on screen, starting at the printed top-left. */
export type Quad = readonly [Point2, Point2, Point2, Point2]

/** A 3x3 matrix, row-major, nine numbers. */
export type Mat3 = readonly number[]

/**
 * One camera frame, as the AR providers hand it over.
 *
 * - 8th Wall: `XR8.CameraPixelArray` delivers `{ pixels: Uint8Array, rows, cols, rowBytes }`. With
 *   `luminance: false` (what `eighthwall.ts` configures) `pixels` is RGBA and `rowBytes` is
 *   `4 * cols`; with `luminance: true` it is one byte per pixel and `rowBytes` is `cols`. Both map
 *   straight onto this type (`channels` 4 or 1, `rowBytes` as given); `imageFromCameraPixelArray`
 *   in `detector.ts` does it.
 * - WebXR companion stream: `RawFrame.pixels` is the RGBA `ImageData` of the `getUserMedia` video,
 *   tightly packed (`rowBytes` omitted). `imageFromRawFrame` does it.
 *
 * Rows are top-down. RGBA alpha is ignored.
 */
export interface FiducialImage {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  /** 1 = a luma plane, 4 = RGBA. */
  channels: 1 | 4
  /** Bytes from the start of one row to the start of the next. Defaults to `width * channels`. */
  rowBytes?: number
}

/** Which quarter turn of a code matched: the observed grid equals the printed grid turned this many times clockwise. */
export type QuarterTurns = 0 | 1 | 2 | 3

export interface DictionaryMatch {
  id: number
  /**
   * See {@link QuarterTurns}. The grid was sampled from a quad whose corners are numbered clockwise
   * from an arbitrary first one; the printed top-left corner is the one with this index.
   */
  rotation: QuarterTurns
  /** Bits that differed between the observed grid and the matched pattern. */
  hamming: number
}

/**
 * A tag family: how many cells carry data, and how an observed grid of them maps onto an id.
 *
 * The detector assumes the layout every ArUco and AprilTag family shares: a square of
 * `bits + 2` cells per side whose outer ring is black, with the `bits x bits` data cells inside.
 * It samples the data cells as 0 (white) / 1 (black), row-major from the quad's first corner,
 * and asks the dictionary to name them. Anything that can answer {@link Dictionary.match} for
 * such a grid can be swapped in without touching the detector.
 */
export interface Dictionary {
  readonly name: string
  /** Data cells per side (the grid is `bits x bits`). */
  readonly bits: number
  /** Number of ids. Ids are 0 .. size - 1. */
  readonly size: number
  /**
   * Smallest Hamming distance between any two distinct (id, rotation) pairs, and between an id and
   * its own other rotations. COMPUTED when the dictionary is built, not declared.
   */
  readonly minDistance: number
  /** floor((minDistance - 1) / 2): the most bit errors that still name a single id. */
  readonly maxCorrectableBits: number
  /**
   * Smallest Hamming distance between the mirror image of any code (in any turn) and any code as printed,
   * itself included. COMPUTED. A tag read in a mirror, through glass or from the back of thin paper is
   * the printed pattern flipped, and is refused only when this is more than the bit errors the detector
   * accepts (`maxHamming`); a family at 0 has a code that reads as itself in a mirror.
   */
  readonly minMirrorDistance: number
  /** The printed pattern for an id: `bits * bits` cells, row-major from the printed top-left, 1 = black. */
  pattern(id: number): Uint8Array
  /**
   * The id whose pattern, turned `rotation` quarter turns clockwise, is within `maxHamming` of
   * `observed` (`bits * bits` values, 1 = black). Null when nothing is that close, or when two ids are.
   */
  match(observed: ArrayLike<number>, maxHamming: number): DictionaryMatch | null
}

/** One decoded tag in one image. */
export interface FiducialDetection {
  id: number
  /** `Dictionary.name` of the family that decoded it. */
  family: string
  /** Printed top-left, top-right, bottom-right, bottom-left, in image pixels. */
  corners: Quad
  /** Bit errors between the sampled grid and the dictionary pattern. 0 is an exact read. */
  hamming: number
  /**
   * A 0..1 ranking score for choosing between detections in one frame or between frames. It is
   * NOT a probability and not a verification: it multiplies the contrast, the Hamming errors,
   * the edge-fit residual and the bit margin (see `scoreQuality` in `detector.ts`).
   */
  quality: number
  /** Mean side length of the corner quad: the apparent tag size in pixels. */
  sidePx: number
  /**
   * White level minus black level, 0..255, at the middle of the tag. The two levels are fitted as planes
   * across the tag (the border cells for black, the quiet-zone samples for white) and a cell is judged
   * against them where it lies, so this is the contrast the middle of the code was read with; under a gradient
   * the ends have more and less. Equal to the plain difference under even light.
   */
  contrast: number
  /**
   * RMS distance of the edge samples that lay on their fitted lines from those lines, in pixels. It is
   * scatter, mostly sensor noise (about 0.1 px on a clean frame, about 0.45 px at 12 levels of noise), so
   * it says how far to trust the corners' noise, not whether an edge was hidden: that is
   * {@link FiducialDetection.edgeInlierFraction}. Null when the corners were not refined.
   */
  edgeRmsPx: number | null
  /**
   * The smallest, over the four edges, of the share of an edge's samples that lay on the line fitted to
   * it, 0..1. 1 means every sample agreed; a tape strip over a third of an edge gives about 0.7 and the
   * fit still holds, below 0.6 the edge is not trusted and the corners are not reported as refined.
   * Null when the corners were not refined.
   */
  edgeInlierFraction: number | null
  /**
   * True when the corners come from sub-pixel edge fits rather than the polygon approximation: every
   * one of the four edges was located on the grey image with most of its samples on one line, almost none
   * beyond it, and no more than a slight bow. A detection with `refined: false` still names the tag, but its
   * corners are those of the polygon the geometry stage made, good to about a pixel of the pyramid level
   * it was found at (`level`: 2^level pixels), and must not be used for a pose (`fuseTagObservations` drops
   * them).
   */
  refined: boolean
  /** Pyramid level the candidate was found at (0 = full resolution). */
  level: number
}

/** Pinhole intrinsics in the image-pixel convention above. No lens distortion is modelled. */
export interface CameraIntrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
  /** Size of the image these are for, in pixels. */
  width: number
  height: number
}

/**
 * A rectangle in IMAGE pixels: where the projection's clip square [-1, 1] x [-1, 1] lies on the
 * image. Defaults to the whole image. It is larger than the image when the render has bars (a
 * letterbox) and smaller when the render crops (a `cover` fit).
 */
export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

/** Why a set of intrinsics is not trusted for a pose. */
export type IntrinsicsProblem = 'not-finite' | 'aspect-mismatch' | 'principal-point'

/** One pose of the tag in the CAMERA frame (OpenCV-style), metric through the printed size. */
export interface TagPoseCandidate {
  /** Tag frame to camera frame, row-major 3x3. */
  rotation: Mat3
  /** Tag origin in the camera frame, metres (+z forward). */
  translation: Vec3
  /** RMS distance between the four detected corners and the pose's projection of them, in pixels. */
  reprojectionRmsPx: number
  /** Distance from the camera to the tag centre, metres. */
  rangeM: number
  /** Angle between the tag's outward normal and the direction to the camera, degrees. 0 is face-on. */
  viewAngleDeg: number
}

/**
 * The two-fold ambiguity of a planar pose, resolved as far as one frame can.
 * `best` has the lower reprojection RMS; `alternate` is the mirror solution.
 */
export interface TagPoseSolution {
  best: TagPoseCandidate
  alternate: TagPoseCandidate | null
  /** alternate RMS / best RMS. 1 means the corners cannot tell them apart; large means one fits clearly better. */
  ambiguityRatio: number
  /**
   * What one pixel of independent corner noise costs, from the Jacobian of the best solution (pure
   * geometry, no assumed noise): RMS position error in metres, and rotation error about the tag's
   * in-plane axes (`tiltDeg`) and about its normal (`spinDeg`) in degrees. Multiply by the real
   * corner scatter to get an expected error.
   */
  conditioning: { positionM: number; tiltDeg: number; spinDeg: number }
}

/**
 * How a detection's corners were located, carried to the fusion with them: the three
 * {@link FiducialDetection} fields that say whether the corners are pose-grade.
 */
export interface CornerFit {
  refined: boolean
  edgeRmsPx: number | null
  edgeInlierFraction: number | null
}

/** One frame's worth of evidence for the fusion: where the corners were, with what lens, from where. */
export interface TagObservation {
  corners: Quad
  intrinsics: CameraIntrinsics
  /** Camera pose in session coordinates when the image was exposed (three.js convention). */
  cameraPose: Pose
  /** Milliseconds, any monotonic clock: the caller's bookkeeping (it is what a `PoseHistory` is asked for). Fusion does not read it, and does not depend on the order frames arrive in. */
  timestampMs?: number
  /**
   * How the corners were found. A frame whose corners were not located on the grey image, or whose
   * edge samples scatter by a pixel, or whose edges mostly disagreed with the lines fitted to them, is
   * dropped by `fuseTagObservations` (`'corner-fit'`): a corner that is a pixel or two out is a few
   * degrees of tilt in the pose, and the reprojection residual cannot see it (a planar solve absorbs one
   * displaced corner as a tilt). Build observations from detections with `observationFromDetection`,
   * which fills it in. Omit it only for corners that come from somewhere else (a test, another detector),
   * which are then taken as given.
   */
  cornerFit?: CornerFit
}

export type FusionRejection =
  | 'no-observations'
  | 'intrinsics'
  | 'corner-fit'
  | 'range'
  | 'view-angle'
  | 'reprojection'
  | 'too-few-frames'
  | 'spread'
  | 'ambiguous'

/**
 * The tag's pose in session coordinates, fused over frames, with the measured numbers a
 * calibration may call evidence. Every number here is computed from the frames; nothing is a
 * default. Whether it is good enough is a gate (`FusionOptions`), and the gate that failed is
 * `reason`.
 *
 * **Scale, labelled honestly.** The tag's size in metres comes from the PRINTED size the caller
 * passes in, so the camera-to-tag distance (`rangeM`) is metric regardless of how the AR runtime
 * scales its own world. It is only as good as two things: the print (a printer set to "fit to
 * page" shrinks a tag by a few percent; measure the scale bar on the sheet) and the intrinsics
 * (a 1 % focal-length error is a 1 % range error, 3 cm at 3 m). `poseSpreadM` and the position in
 * `pose` are in SESSION units; `sessionUnitsPerMetre` says how many of those make a metre, and is
 * 1 only when the caller said the runtime is metric.
 */
export interface FusedTagPose {
  /**
   * `'ok'` when every gate passed. A rejected result still carries whatever was computable; the
   * numeric fields are NaN (and `pose` null) when no frame survived the per-frame gates, so a caller
   * checks `status` first and never reads a number off a rejected result as though it were measured.
   */
  status: 'ok' | 'rejected'
  reason: FusionRejection | null
  /** The tag frame in session coordinates. Null when no frame survived the per-frame gates. */
  pose: Pose | null
  /**
   * RMS distance of the per-frame tag centres from the fused one, in metres, estimated robustly
   * (1.126 x the median distance, which is the RMS for isotropic Gaussian scatter and is not moved by
   * a frame that went wrong). It includes the camera-pose noise the runtime puts into every frame,
   * because that is part of what one calibration's pose can be trusted to.
   */
  poseSpreadM: number
  /** The same robust RMS for the per-frame tag orientations about the fused one, in degrees. */
  rotationSpreadDeg: number
  /** Median per-frame reprojection RMS of the chosen solutions, in pixels. */
  reprojectionRmsPx: number
  /** Median camera-to-tag distance over the frames kept, in metres (metric through the printed size). */
  rangeM: number
  /** Frames the fused pose is built from (after the per-frame gates and outlier rejection). */
  nFrames: number
  /** Frames offered. */
  nFramesOffered: number
  /**
   * Why the frames that were offered and not kept were left out, by the first gate each failed: the numbers a
   * caller turns into guidance ("keep the marker uncovered" for `cornerFit`, "move closer" for `range`). Outlier
   * frames dropped by consensus after the gates are `nFramesOffered` minus these minus `nFrames`.
   */
  dropped: { intrinsics: number; cornerFit: number; range: number; viewAngle: number; reprojection: number; unsolved: number }
  /** Session units per metre the spread and position were converted with (1 = the runtime is metric). */
  sessionUnitsPerMetre: number
  /** True when the two mirror solutions could not be told apart over these frames. */
  ambiguous: boolean
}

/**
 * The measured fields a `'fiducial'` calibration records, so that `status: 'verified'` can be
 * derived from them and from nothing else (ADR 0005 rule 3). See the "what the next wave must add"
 * note in the WP-14a report for how this lands in `src/world/types.ts`.
 */
export interface FiducialEvidence {
  tagId: number
  family: string
  printedSizeMm: number
  poseSpreadM: number
  rotationSpreadDeg: number
  reprojectionRmsPx: number
  rangeM: number
  nFrames: number
}

/**
 * What a printed sheet's QR code says. The tag itself only carries its id; the Place, room and
 * printed size are what turn that id into a place in the world, and a person scanning the sheet
 * with another app can read them.
 */
export interface TagPayload {
  /** Payload format version. */
  v: 1
  /** `Dictionary.name` the printed tag belongs to. */
  family: string
  tagId: number
  placeId: string
  /** Null for a tag that belongs to the Place as a whole. */
  roomId: string | null
  /** Edge length of the printed black square, in millimetres, as the sheet was generated. */
  printedSizeMm: number
}
