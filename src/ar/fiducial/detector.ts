/**
 * Printed-tag detector: a camera frame in, decoded tags with sub-pixel corners out.
 *
 * Pure TypeScript, no dependency, no allocation per pixel. Clean-room: the stages are the ones
 * every square-fiducial detector shares (they are described in the ArUco paper, Garrido-Jurado
 * et al. 2014, and the AprilTag papers, Olson 2011 and Wang & Olson 2016), implemented here from
 * those descriptions and from first principles. No code from any other project was read or
 * copied. What was consulted is listed in the WP-14a report.
 *
 * ## Pipeline
 *
 * 1. **Luma.** RGBA or one-channel frames become one luma plane: ITU-R BT.601 weights (0.299, 0.587,
 *    0.114) rounded to 77/150/29 over 256, a standard and not a measurement. Any positive weighting would
 *    do for a black and white print; this is the one a grey photograph of it uses.
 * 2. **Pyramid.** Large frames are detected at a reduced size (`maxDetectPixels`) and a few
 *    halvings below it, so a near, big tag and a far, small one are both found at a size the later
 *    stages like. Everything after candidate finding runs on the FULL-resolution plane.
 * 3. **Adaptive threshold.** A pixel is dark when it is more than `thresholdOffset` levels below the
 *    mean of the `(2r+1)^2` window around it (integral image, so the cost does not depend on r). A
 *    tag's border is dark against its white quiet zone whatever the lighting is.
 * 4. **Components.** Dark pixels are labelled into 8-connected blobs by a run-length union-find.
 * 5. **Quads.** A blob that is big enough and does not touch the frame edge has its OUTER boundary
 *    taken (leftmost/rightmost pixel per row, topmost/bottommost per column), reduced to its convex
 *    hull, and given four corners: the four hull vertices that carry the most area (`prominentVertices`;
 *    it assumes nothing about which pairs are diagonals, so a tag seen so obliquely that a side is longer
 *    than a diagonal keeps its corners). A noise speck or a rounded corner can pull those points off the
 *    true corner, so each side is then refitted to the boundary points along its middle (`fitLineRobust`)
 *    and the corners become the intersections of the four lines. The quad is accepted only when at most 8 %
 *    of the boundary points lie beyond it and at most 14 % inside it by more than a small tolerance, which
 *    discards circles, triangles and ragged blobs but lets a tag with a stretch of an edge hidden through.
 * 6. **Edge refinement.** Each of the four edges is re-located on the grey image: sample points along
 *    it, find the steepest white-to-black step across it with a parabolic peak (only where that is a
 *    peak inside the window), fit a line through the steps by the majority of them (`fitLineRobust`),
 *    and take the corners as the intersections of neighbouring lines. This is what gives the corners their
 *    sub-pixel accuracy and removes the threshold's bias. An edge counts as located only if most of its
 *    samples agree, they cover a good part of its length, almost none lie beyond the line, and it is not bowed;
 *    corners are reported as `refined` only when all four edges do.
 * 7. **Unwarp and sample.** The unit square is mapped onto the quad by the closed-form
 *    square-to-quad homography; each of the `(bits+2)^2` cells is sampled on a 3x3 pattern. Black and
 *    white are two planes across the tag (`fitPlane`), fitted to the border cells and to a ring of
 *    samples in the QUIET ZONE just outside the border, and a cell is judged against the level halfway
 *    between them where it lies, so a lamp's gradient across the sheet does not read as part of the code.
 * 8. **Validate and match.** The border must be black (at most `maxBorderErrors` cells wrong), the
 *    quiet zone white (at most `maxQuietErrors` samples wrong), the contrast, taken as the least anywhere on
 *    the tag, at least `minContrast`, and the data cells must name an id within `maxHamming` bits. The
 *    rotation that matched fixes which corner is the printed top-left, so the corners come out in a fixed order.
 *
 * Quads at the same place and size (the same tag at two pyramid levels, a tag and the dark halo that a bright
 * quiet zone leaves round it on a mid-grey wall) are one group, tried finest level first and stopped at the
 * first that reads. Decoding is the costly stage, so there is a budget (`maxCandidates`): when a frame has more
 * quads than that, each is first given a cheap look on its polygon and the ones that pass are decoded first.
 * `stats.capped` says when the budget ran out with quads unread.
 *
 * Things tried and taken out, because mutating each of them left every test green and a measurement said why:
 * a threshold offset raised to three estimated noise sigmas (it was meant to keep noise specks off a tag's
 * border; once each side of the quad is refitted to its boundary points it bought nothing, and it cost recall
 * once noise passed about ten levels: 745 of 800 reads against 777 on the same frames without it); a filter that
 * ignored one- and two-pixel runs when taking a blob's outline (no measurable difference after the refit); a
 * filter that kept only edge steps at least half as strong as the median; and a check that a refined edge's
 * direction agrees with the polygon's to within about 14 degrees (the last two: removing them left every
 * detection and corner on 260 frames of tags, textures and noise bit-for-bit the same). Also tried and not
 * adopted: a check that a refined corner is within a pixel of the polygon's (measured on 720 synthetic frames of
 * undamaged tags, the refined corner moves from the polygon's by up to 1.2 px on a clean frame and up to 1.9 px
 * at 12 levels of noise, one frame 3.9 px, because the polygon is a staircase of whole pixels); and an edge
 * location by the centre of mass of the step instead of its steepest point (it was meant to remove the pixel
 * locking of near-axis-aligned edges, worst corner 0.1 to 0.3 px, and made every case worse).
 *
 * ## What is seen of something lying over an edge
 *
 * A tag's black border can be hidden by tape, a card, a finger, but the print cannot grow, so the true edge is
 * the outermost line with real support. Measured on synthetic frames (a white strip over the top border edge of a
 * 72 px tag, 108 combinations of length, position and depth): a strip over up to about 40 % of an edge leaves the
 * corners where they were (worst corner within 0.07 px); over about 40 to 55 % the read is made but the corners
 * are not called refined; beyond that, in 6 of the 108 cases the edge that is left is taken for the edge and the corners
 * are called refined and are as far out as the strip is deep (1 to 5 px). A card or a finger over a whole edge
 * does the same, and nothing in one frame can tell it from a smaller tag: the next wave's evidence for a
 * calibration is a fusion over frames that move, and the fusion refuses frames that are not `refined`. On random
 * occluders (white cards, fingers, shadow edges, glare, 1750 frames) the share of `refined` reads with a corner
 * more than 0.75 px out fell from 14 % to 2 %.
 *
 * ## What a detection is not
 *
 * It is not a verification of anything. `quality` ranks detections; it is not a probability. The
 * false-positive rate is a measurement on synthetic frames (see the tests), not a guarantee, and a
 * caller that knows which ids it expects should say so with `ids`, which removes every other id
 * from play.
 *
 * ## Constants
 *
 * Every constant below that was chosen and not measured is named as adopted, with the reason
 * (ADR 0005 rule 5). The detection-rate and false-positive tests are what bound them.
 */
import type { Dictionary, FiducialDetection, FiducialImage, Point2, Quad } from './types.ts'

export interface DetectorOptions {
  /**
   * Most bit errors accepted between the sampled grid and a code. Clamped to the dictionary's
   * `maxCorrectableBits`.
   */
  maxHamming?: number
  /** Smallest tag, as the mean side of its quad in full-resolution pixels. */
  minSidePx?: number
  /**
   * Frames with more pixels than this are searched from a halved copy, repeatedly, until they fit.
   * Decoding and corner refinement still use the full-size frame, but a tag is only FOUND at the
   * sizes the search reaches: a quad must be at least 10 pixels across at the level it is found at
   * (`MIN_LEVEL_SIDE_PX`), so from a copy halved k times the smallest findable tag is about
   * `max(10 * 2^k, minSidePx)` full-size pixels. A 1280x960 frame with the default is searched from
   * 640x480 (k = 1), which still finds a tag of about 22 px (measured at 1280x720: 22 px 8 reads in 10,
   * 25 px 9 in 10); a 4K frame is halved three times (to 480x270, the first size under half a megapixel) and
   * misses tags under about 100 px (measured: 80 px 1 in 10, 100 px 8 in 10). Set this above the frame's pixel
   * count to search it at full size (a 1280x960 frame then costs about four times as much).
   */
  maxDetectPixels?: number
  /** Pyramid levels examined, starting at the first one that fits `maxDetectPixels`. */
  levels?: number
  /** Adaptive-threshold window radius, in pixels of the level being thresholded. */
  thresholdRadius?: number
  /** Levels below the local mean at which a pixel counts as dark. */
  thresholdOffset?: number
  /** Smallest white-minus-black level difference (0..255) a tag may have. */
  minContrast?: number
  /** Border cells allowed to read light. */
  maxBorderErrors?: number
  /** Quiet-zone samples allowed to read dark. */
  maxQuietErrors?: number
  /** Re-locate the corners on the grey image. Off only to measure what it buys. */
  refineCorners?: boolean
  /**
   * The decode budget: most quads decoded in one frame. When a frame has more quads than this, the ones that
   * pass a cheap look are decoded first (largest first), then the rest while the budget lasts, and
   * `DetectorStats.capped` says if it ran out.
   */
  maxCandidates?: number
  /** Report only these ids. */
  ids?: readonly number[]
}

/**
 * Default `maxHamming`. Adopted, not measured (ADR 0005 rule 5): the family corrects up to four bit
 * errors, but each bit of tolerance multiplies the chance that a random grid is taken for a code. A
 * Hamming ball of radius 0, 1 and 2 holds 1, 26 and 326 of the 2^25 grids, so with 128 words (32 ids,
 * four turns) one bit of tolerance puts that chance near 1 in 10 000 per candidate that already
 * passed every geometric and colour test, and two bits near 1 in 800. The tests report both, and
 * the detection grid shows what the second bit buys on blurred small tags.
 */
export const DEFAULT_MAX_HAMMING = 1

/** Adopted, not measured: 2.9 px per cell is about the coarsest grid that still decodes after a blur of one pixel. */
export const DEFAULT_MIN_SIDE_PX = 20
/** Adopted, not measured: keeps detection work at or under half a megapixel. A 640x480 frame is searched at full size, a 1280x960 frame from a 640x480 copy. */
export const DEFAULT_MAX_DETECT_PIXELS = 500_000
/** Adopted, not measured: three halvings cover tags from 20 px to far past the frame at the finest level. */
export const DEFAULT_LEVELS = 3
/** Adopted, not measured: a 15-pixel window is wider than the border band of any tag up to about 100 px across. */
export const DEFAULT_THRESHOLD_RADIUS = 7
/** Adopted, not measured: above the noise floor of a good camera frame (a few levels) and below any tag worth reading. */
export const DEFAULT_THRESHOLD_OFFSET = 7
/** Adopted, not measured: a tag printed and lit so that black and white differ by less than this is below what a phone reads. */
export const DEFAULT_MIN_CONTRAST = 30
/** Adopted, not measured. */
export const DEFAULT_MAX_BORDER_ERRORS = 1
/** Adopted, not measured. */
export const DEFAULT_MAX_QUIET_ERRORS = 4
/**
 * Adopted, not measured: bounds the worst case in a cluttered room. A decode costs about 0.2 ms on a laptop
 * (measured), so 64 of them are about 13 ms there and several times that on a phone; the tests bound it to
 * 32..128, below which a real tag in a busy room can be starved and above which the worst case is a visible stall.
 */
export const DEFAULT_MAX_CANDIDATES = 64

/** Smallest quad side a pyramid level reports, in that level's pixels. Adopted, not measured. */
const MIN_LEVEL_SIDE_PX = 10
/** A ring-shaped blob must have at least this much area per unit of its bounding box's perimeter (a band at least this thick). Adopted, not measured. */
const MIN_BAND_PX = 1.2
/**
 * A quad is accepted when at most `FIT_OUTLIER_FRACTION` of the blob's outer-boundary points lie beyond,
 * and at most `FIT_BITE_FRACTION` inside, by more than `max(FIT_ABS_PX, FIT_REL * side)` from its four edges, and every hull vertex is within
 * `FIT_HULL_FACTOR` times that. The slack is for noise specks that touch the border; the edge refinement
 * that follows does not use the polygon's edges, only its corners as a starting point. Adopted, not measured.
 */
const FIT_ABS_PX = 1.5
const FIT_REL = 0.025
const FIT_OUTLIER_FRACTION = 0.08
/**
 * The same, for outline points inside the quad rather than beyond it. A side bitten away over half its length
 * leaves 12.5 % of the outline inside the quad; a disc at a coarse pyramid level, whose inscribed square the quad
 * stage would otherwise take for a tag, leaves up to 16 % (measured on 400 random discs, ellipses, pentagons,
 * hexagons and octagons). Adopted between the two (ADR 0005 rule 5).
 */
const FIT_BITE_FRACTION = 0.14
/**
 * More than this share of the outline beyond the quad (by the same distance) means the quad's edge is not
 * the outermost line the outline supports: something lies over most of one edge and the edge settled on what is
 * left of it, which is a little further in. Such a quad is not refined, because the grey image would only
 * confirm the wrong line. Measured on synthetic frames: a clean tag shows at most 0.7 % of its outline beyond
 * its quad (at 12 levels of noise and 1.4 px of blur), a tag with half of an edge covered 2.1 % or more.
 * Adopted between the two (ADR 0005 rule 5).
 */
const FIT_DISPUTE_FRACTION = 0.015
const FIT_HULL_FACTOR = 3
/** Longest side over shortest side beyond which a quad is not a perspective view of a square. Adopted, not measured. */
const MAX_SIDE_RATIO = 6
/** Cell sub-sampling offset, as a fraction of a cell. Adopted, not measured. */
const SUB_SAMPLE = 0.22
/** Scale of the contrast term of `quality`, in levels. Adopted, not measured. */
const QUALITY_CONTRAST_SCALE = 100
/** Scale of the edge-residual term of `quality`, in pixels. Adopted, not measured. */
const QUALITY_EDGE_SCALE_PX = 1.5
/** A blob whose bounding box is more than this many times longer than wide is not a tag. Adopted, not measured. */
const MAX_BBOX_RATIO = 6

/**
 * Edge refinement. Every number here is adopted, not measured (ADR 0005 rule 5); the corner-accuracy
 * and detection-rate tests are what bound them.
 *
 * Profile samples across an edge are `PROFILE_STEP` pixels apart. About one edge sample is taken per
 * `EDGE_SAMPLE_SPACING_PX` pixels of side (between `EDGE_SAMPLES_MIN` and `EDGE_SAMPLES_MAX`), spread
 * over the middle `EDGE_SPAN` of the side starting `EDGE_START` in, because corners round and spike.
 * An edge is fitted only if at least `EDGE_MIN_INLIER_FRACTION` of its samples lie on one line, and no more than
 * `EDGE_MAX_OUTWARD_FRACTION` of the samples found their step beyond the line, and the edge does not bow by more than
 * `max(EDGE_MIN_SAG_PX, EDGE_MAX_SAG_FRACTION x its length, EDGE_SAG_SIGMAS standard errors of the sag)` (`fitLineRobust`; its scatter is
 * never counted as below `LINE_MIN_SIGMA_PX`). Steps beyond the line are the signature of an edge that is
 * mostly covered: what covers it can only hide black, so the true edge is the outermost one with real support. A refined corner may sit at most
 * `max(CORNER_MOVE_MIN_PX, CORNER_MOVE_WINDOWS x halfWidth)` from the polygon's corner.
 *
 * The search window either side of an edge is `REFINE_CELL_FRACTION` of a cell at most (so the next
 * cell boundary is never in view), and otherwise `REFINE_WINDOW_BASE_PX` or `REFINE_WINDOW_PER_LEVEL`
 * per pyramid halving plus `REFINE_WINDOW_EXTRA_PX`, whichever is larger; the second pass, centred on
 * the first pass's edges, looks `REFINE_NARROW_WINDOW_PX` either side.
 */
const PROFILE_STEP = 0.5
const EDGE_SAMPLE_SPACING_PX = 2
const EDGE_SAMPLES_MIN = 8
const EDGE_SAMPLES_MAX = 48
const EDGE_START = 0.1
const EDGE_SPAN = 0.8
const EDGE_MIN_INLIER_FRACTION = 0.6
const EDGE_MAX_OUTWARD_FRACTION = 0.1
const EDGE_MAX_SAG_FRACTION = 0.015
const EDGE_MIN_SAG_PX = 0.5
const EDGE_SAG_SIGMAS = 3
const SAG_ERROR_PER_SIGMA = 5.2
const CORNER_MOVE_MIN_PX = 3
const CORNER_MOVE_WINDOWS = 2.5
const LINE_MIN_SIGMA_PX = 0.1
const REFINE_CELL_FRACTION = 0.9
const REFINE_WINDOW_BASE_PX = 2
const REFINE_WINDOW_PER_LEVEL = 1.25
const REFINE_WINDOW_EXTRA_PX = 1
const REFINE_NARROW_WINDOW_PX = 2

/**
 * How far either side of a polygon edge the first refinement pass looks, in full-resolution pixels.
 *
 * A polygon found at pyramid level k is accurate to about a pixel of THAT level, which is 2^k pixels
 * here, so the window grows with the level; and it never reaches a whole cell, so the next cell
 * boundary inside the tag is never in view. Synthetic frames do not exercise the growth (their
 * polygons are accurate to a fraction of a pixel, and a fixed 2 px window reads them just as well):
 * it is a margin for coarse-level polygons on real frames, adopted, not measured (ADR 0005 rule 5),
 * for DX8 to confirm or remove. `tests/unit/node/fiducial_detector.test.ts` pins the formula.
 */
export function refinementWindowPx(cellPx: number, level: number): number {
  return Math.min(REFINE_CELL_FRACTION * cellPx, Math.max(REFINE_WINDOW_BASE_PX, REFINE_WINDOW_PER_LEVEL * 2 ** level + REFINE_WINDOW_EXTRA_PX))
}

/** What the last `detect()` did, for tests and for tuning. */
export interface DetectorStats {
  /** Quads that came out of the geometry stage. */
  candidates: number
  /** Places those quads sit at: one tag found at two pyramid levels, or a tag and the halo around it, is one. */
  groups: number
  /** Quads given the cheap look (see `precheckLimits`) because there were more of them than the budget could decode. */
  prechecked: number
  /** Quads that were sampled and compared with the dictionary. */
  decodeAttempts: number
  /** True when the decode budget ran out with quads left unread: the frame is too busy to be sure there is no tag in it. */
  capped: boolean
  detections: number
  /** Why decode attempts failed, by first failing test. */
  rejected: { offFrame: number; contrast: number; border: number; quiet: number; match: number; ids: number }
}

/** The options a detector actually runs with: every default filled in, `maxHamming` clamped to what the family can correct. */
export interface ResolvedDetectorOptions {
  maxHamming: number
  minSidePx: number
  maxDetectPixels: number
  levels: number
  thresholdRadius: number
  thresholdOffset: number
  minContrast: number
  maxBorderErrors: number
  maxQuietErrors: number
  refineCorners: boolean
  maxCandidates: number
  ids: ReadonlySet<number> | null
}

function emptyStats(): DetectorStats {
  return { candidates: 0, groups: 0, prechecked: 0, decodeAttempts: 0, capped: false, detections: 0, rejected: { offFrame: 0, contrast: 0, border: 0, quiet: 0, match: 0, ids: 0 } }
}

/**
 * The limits of the cheap look at a quad, from the caller's: half the contrast, a few more border cells and
 * quiet-zone samples allowed to be wrong, and any code within the family's correctable distance (not just
 * the caller's `maxHamming`), because the polygon the look is made on is a pixel or two out where the
 * edge refinement that follows would have put it right. Adopted, not measured (ADR 0005 rule 5).
 */
function precheckLimits(o: ResolvedDetectorOptions, dict: Dictionary): ReadLimits {
  const cells = dict.bits + 2
  return {
    minContrast: o.minContrast / 2,
    maxBorderErrors: Math.min(o.maxBorderErrors + 4, 4 * (cells - 1)),
    maxQuietErrors: Math.min(o.maxQuietErrors + 8, 4 * cells),
    maxHamming: dict.maxCorrectableBits,
  }
}

/** A quad the geometry stage found, in full-resolution pixels. Exported for tests of the grouping. */
export interface Candidate {
  corners: Point2[]
  area: number
  level: number
  /** Some of the outline lies beyond the quad's edges (see `FIT_DISPUTE_FRACTION`): the quad is not trusted to be where the tag's edges are, so its corners are not refined. */
  disputed: boolean
}

interface Level {
  luma: Uint8Array
  width: number
  height: number
  /** Level-0 pixels per pixel of this level. */
  scale: number
}

/**
 * A number the caller supplied, or `fallback`, which must be finite and within `min..max` (and a whole number when
 * `whole`): `RangeError` otherwise. A comparison with NaN is false, so a NaN that slipped past would turn a
 * check that rejects into one that accepts: `maxHamming: NaN` made every bordered square a tag. Options built
 * from configuration (`Number(undefined)`) are exactly where such a value comes from, so it is refused loudly.
 */
function option(name: string, value: number | undefined, fallback: number, min: number, max: number, whole: boolean): number {
  const v = value ?? fallback
  if (!Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) {
    throw new RangeError(`detector option ${name}: ${v} is not ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`)
  }
  return v
}

function resolveOptions(dictionary: Dictionary, o: DetectorOptions): ResolvedDetectorOptions {
  const cells = dictionary.bits + 2
  // maxHamming above what the family can correct is clamped, not refused: it is a ceiling the caller may overshoot.
  const maxHamming = Math.min(option('maxHamming', o.maxHamming, DEFAULT_MAX_HAMMING, 0, Number.MAX_SAFE_INTEGER, true), dictionary.maxCorrectableBits)
  let ids: ReadonlySet<number> | null = null
  if (o.ids) {
    for (const id of o.ids) option('ids entry', id, 0, 0, dictionary.size - 1, true)
    ids = new Set(o.ids)
  }
  return {
    maxHamming,
    minSidePx: option('minSidePx', o.minSidePx, DEFAULT_MIN_SIDE_PX, 1, 100_000, false),
    maxDetectPixels: option('maxDetectPixels', o.maxDetectPixels, DEFAULT_MAX_DETECT_PIXELS, 1024, 1e9, false),
    levels: option('levels', o.levels, DEFAULT_LEVELS, 1, 8, true),
    thresholdRadius: option('thresholdRadius', o.thresholdRadius, DEFAULT_THRESHOLD_RADIUS, 1, 256, true),
    thresholdOffset: option('thresholdOffset', o.thresholdOffset, DEFAULT_THRESHOLD_OFFSET, 0, 255, false),
    minContrast: option('minContrast', o.minContrast, DEFAULT_MIN_CONTRAST, 0, 255, false),
    maxBorderErrors: option('maxBorderErrors', o.maxBorderErrors, DEFAULT_MAX_BORDER_ERRORS, 0, 4 * (cells - 1), true),
    maxQuietErrors: option('maxQuietErrors', o.maxQuietErrors, DEFAULT_MAX_QUIET_ERRORS, 0, 4 * cells, true),
    refineCorners: o.refineCorners ?? true,
    maxCandidates: option('maxCandidates', o.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 1e6, true),
    ids,
  }
}

// -------------------------------------------------------------------------------------------
// Adapters for the two shapes the providers hand over
// -------------------------------------------------------------------------------------------

/**
 * A `RawFrame` (`src/ar/provider.ts`): RGBA, tightly packed. Both providers deliver this shape from
 * `captureFrame()`.
 */
export function imageFromRawFrame(frame: { pixels: Uint8ClampedArray | Uint8Array; width: number; height: number }): FiducialImage {
  return { data: frame.pixels, width: frame.width, height: frame.height, channels: 4 }
}

/**
 * An 8th Wall `camerapixelarray` result, `{ pixels, rows, cols, rowBytes }`. `rowBytes` says how
 * wide a row is in bytes, which also says which of the two formats it is: `4 * cols` is RGBA (what
 * `XR8.CameraPixelArray.pipelineModule({ luminance: false })` returns), `cols` is one luma byte per
 * pixel (`luminance: true`). A row padded past either is read as that format with its padding (a
 * row of at least `4 * cols` bytes can only be RGBA, and the padding of a luma row is always less than
 * three times its width), and a row narrower than the format needs is rejected rather than guessed at.
 */
export function imageFromCameraPixelArray(pa: { pixels: Uint8Array | Uint8ClampedArray; rows: number; cols: number; rowBytes?: number }): FiducialImage {
  const rowBytes = pa.rowBytes ?? (pa.cols > 0 && pa.pixels.length >= pa.rows * pa.cols * 4 ? pa.cols * 4 : pa.cols)
  if (rowBytes >= pa.cols * 4) return { data: pa.pixels, width: pa.cols, height: pa.rows, channels: 4, rowBytes }
  if (rowBytes >= pa.cols && pa.cols > 0) return { data: pa.pixels, width: pa.cols, height: pa.rows, channels: 1, rowBytes }
  throw new RangeError(`camera pixel array: rowBytes ${rowBytes} is narrower than ${pa.cols} (luma) or ${pa.cols * 4} (RGBA)`)
}

// -------------------------------------------------------------------------------------------
// Scratch memory, reused between frames of the same size
// -------------------------------------------------------------------------------------------

function growU8(a: Uint8Array, n: number): Uint8Array {
  return a.length >= n ? a : new Uint8Array(Math.max(n, a.length * 2))
}
function growI32(a: Int32Array, n: number): Int32Array {
  return a.length >= n ? a : new Int32Array(Math.max(n, a.length * 2))
}
function growU32(a: Uint32Array, n: number): Uint32Array {
  return a.length >= n ? a : new Uint32Array(Math.max(n, a.length * 2))
}

class Scratch {
  full: Uint8Array = new Uint8Array(0)
  pyramid: Uint8Array[] = []
  integral: Uint32Array = new Uint32Array(0)
  dark: Uint8Array = new Uint8Array(0)
  colX0: Int32Array = new Int32Array(0)
  colX1: Int32Array = new Int32Array(0)
  runX0: Int32Array = new Int32Array(0)
  runX1: Int32Array = new Int32Array(0)
  runY: Int32Array = new Int32Array(0)
  parent: Int32Array = new Int32Array(0)
  area: Int32Array = new Int32Array(0)
  bx0: Int32Array = new Int32Array(0)
  bx1: Int32Array = new Int32Array(0)
  by0: Int32Array = new Int32Array(0)
  by1: Int32Array = new Int32Array(0)
  head: Int32Array = new Int32Array(0)
  next: Int32Array = new Int32Array(0)
  rowMin: Int32Array = new Int32Array(0)
  rowMax: Int32Array = new Int32Array(0)
  colMin: Int32Array = new Int32Array(0)
  colMax: Int32Array = new Int32Array(0)
  keys: Float64Array = new Float64Array(0)
  cells: Float64Array = new Float64Array(0)
  quiet: Float64Array = new Float64Array(0)
  /** Positions and levels of the border cells and quiet-zone samples the level planes are fitted to. */
  refX: Float64Array = new Float64Array(0)
  refY: Float64Array = new Float64Array(0)
  refV: Float64Array = new Float64Array(0)
  /** Grid sampled in the quad's own orientation, 1 = black. */
  grid: Uint8Array = new Uint8Array(0)
}

// -------------------------------------------------------------------------------------------
// The detector
// -------------------------------------------------------------------------------------------

export class FiducialDetector {
  readonly dictionary: Dictionary
  readonly options: Readonly<ResolvedDetectorOptions>
  /** Counters for the last `detect()`. */
  stats: DetectorStats = emptyStats()
  private readonly scratch = new Scratch()

  constructor(dictionary: Dictionary, options: DetectorOptions = {}) {
    this.dictionary = dictionary
    this.options = resolveOptions(dictionary, options)
  }

  /** Find and decode every tag in a frame. Best quality first. */
  detect(image: FiducialImage): FiducialDetection[] {
    const stats = emptyStats()
    this.stats = stats
    const o = this.options
    const s = this.scratch
    const { width, height } = image
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError(`fiducial image: ${width}x${height} is not a whole number of pixels`)
    if (width < 16 || height < 16) return []

    const full = toLuma(image, s)
    const levels = buildLevels(full, width, height, o, s)

    const candidates: Candidate[] = []
    for (const level of levels) findCandidates(level, o, s, candidates)
    stats.candidates = candidates.length

    // Candidates at the same place and size (the same tag found at two pyramid levels, a tag and the dark halo
    // that a bright quiet zone leaves round it on a mid-grey wall) are one group, tried finest level first
    // and stopped at the first that reads.
    const groups = groupCandidates(candidates)
    stats.groups = groups.length

    // Decoding costs about as much as everything else together, and a busy wall (tiles, shelves, a window
    // with panes) can give hundreds of quads. When there are more than the budget can decode, look at each
    // one cheaply first, on the polygon the geometry stage made, with limits loose enough that a tag
    // whose polygon is a pixel out still passes, and decode the ones that pass before the rest. Nothing
    // is thrown away by it: the rest are decoded in their turn while the budget lasts.
    let order = groups
    if (candidates.length > o.maxCandidates) {
      const limits = precheckLimits(o, this.dictionary)
      const unused = emptyStats().rejected
      const passes = (cand: Candidate) => {
        stats.prechecked++
        return sampleAndMatch(full, width, height, cand.corners, this.dictionary, limits, s, unused) !== null
      }
      const likely: Candidate[][] = []
      const rest: Candidate[][] = []
      for (const group of groups) {
        const good: Candidate[] = []
        const other: Candidate[] = []
        for (const cand of group) (passes(cand) ? good : other).push(cand)
        if (good.length > 0) likely.push([...good, ...other])
        else rest.push(other)
      }
      order = [...likely, ...rest]
    }

    const found: FiducialDetection[] = []
    let attempts = 0
    for (const group of order) {
      for (const cand of group) {
        if (attempts >= o.maxCandidates) {
          stats.capped = true
          break
        }
        attempts++
        stats.decodeAttempts++
        const det = this.readCandidate(full, width, height, cand, stats)
        if (!det) continue
        if (o.ids && !o.ids.has(det.id)) stats.rejected.ids++
        else found.push(det)
        break
      }
      if (stats.capped) break
    }
    stats.detections = found.length
    found.sort((a, b) => b.quality - a.quality)
    return found
  }

  private readCandidate(full: Uint8Array, w: number, h: number, cand: Candidate, stats: DetectorStats): FiducialDetection | null {
    const o = this.options
    const s = this.scratch
    const dict = this.dictionary
    const cells = dict.bits + 2
    let corners = cand.corners
    let refined = false
    let edgeRms: number | null = null
    let inlierFraction: number | null = null

    if (o.refineCorners && !cand.disputed) {
      const side0 = meanSide(corners)
      const cellPx = side0 / cells
      const wide = refinementWindowPx(cellPx, cand.level)
      const first = refineQuad(full, w, h, corners, wide, o.minContrast)
      if (first) {
        const narrow = Math.min(REFINE_CELL_FRACTION * (meanSide(first.corners) / cells), REFINE_NARROW_WINDOW_PX)
        const second = refineQuad(full, w, h, first.corners, narrow, o.minContrast)
        const use = second ?? first
        // A quad with some edges fitted and the rest left as the polygon had them is a mixture that is
        // wrong in a way neither is; the polygon is the honest answer when the grey image did not settle all four.
        if (use.allEdges) {
          corners = use.corners
          refined = true
          edgeRms = use.rms
          inlierFraction = use.inlierFraction
        }
      }
    }

    const read = sampleAndMatch(full, w, h, corners, dict, o, s, stats.rejected)
    if (!read) return null

    const k = read.rotation
    const ordered: Quad = [corners[k % 4]!, corners[(k + 1) % 4]!, corners[(k + 2) % 4]!, corners[(k + 3) % 4]!]
    const sidePx = meanSide(corners)
    return {
      id: read.id,
      family: dict.name,
      corners: ordered,
      hamming: read.hamming,
      quality: scoreQuality(read.contrast, o.minContrast, read.hamming, o.maxHamming, edgeRms, refined ? inlierFraction : null, refined, read.bitMargin),
      sidePx,
      contrast: read.contrast,
      edgeRmsPx: refined ? edgeRms : null,
      edgeInlierFraction: refined ? inlierFraction : null,
      refined,
      level: cand.level,
    }
  }
}

/**
 * Time `detector.detect(image)`: `warmup` untimed runs, then `runs` timed ones, in milliseconds.
 * It exists so that the same measurement can be taken in Node and on a phone (DX8) without each
 * caller writing its own loop, and so that nobody reports a first-call time that includes the JIT.
 */
export function measureDetectorCost(detector: FiducialDetector, image: FiducialImage, options: { warmup?: number; runs?: number } = {}): { medianMs: number; p95Ms: number; minMs: number; runs: number } {
  const warmup = options.warmup ?? 10
  const runs = Math.max(1, options.runs ?? 40)
  for (let i = 0; i < warmup; i++) detector.detect(image)
  const ms: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    detector.detect(image)
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  return { medianMs: ms[Math.floor(ms.length / 2)]!, p95Ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]!, minMs: ms[0]!, runs }
}

/** One-shot convenience. Build a `FiducialDetector` once and reuse it when frames repeat: it keeps its buffers. */
export function detectFiducials(image: FiducialImage, dictionary: Dictionary, options: DetectorOptions = {}): FiducialDetection[] {
  return new FiducialDetector(dictionary, options).detect(image)
}

/**
 * A 0..1 ranking score: five terms, each in (0, 1], multiplied. Contrast above the minimum
 * (saturating at `QUALITY_CONTRAST_SCALE` levels over it), Hamming errors against the ceiling, the
 * edge-fit residual (0.5 when the corners were not refined, so refinement is rewarded but its
 * absence is not fatal), the share of edge samples that lay on their fitted line, and the narrowest
 * margin of any data cell from the threshold. A ranking, not a probability: nothing calibrates it
 * against a false-positive rate.
 */
function scoreQuality(contrast: number, minContrast: number, hamming: number, maxHamming: number, edgeRms: number | null, inlierFraction: number | null, refined: boolean, bitMargin: number): number {
  const c = clamp01(0.25 + 0.75 * clamp01((contrast - minContrast) / QUALITY_CONTRAST_SCALE))
  const hm = 1 - hamming / (maxHamming + 1)
  const e = refined && edgeRms !== null ? clamp01(1 - edgeRms / QUALITY_EDGE_SCALE_PX) : 0.5
  // 1 when every edge sample lies on its line, falling to 0.25 at the least share that still counts as a fit.
  const f = inlierFraction !== null ? clamp01(0.25 + (0.75 * (inlierFraction - EDGE_MIN_INLIER_FRACTION)) / (1 - EDGE_MIN_INLIER_FRACTION)) : 1
  const m = clamp01(0.25 + 0.75 * bitMargin)
  return c * hm * Math.max(e, 0.05) * f * m
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function meanSide(c: readonly Point2[]): number {
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const a = c[i]!
    const b = c[(i + 1) % 4]!
    sum += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return sum / 4
}

function quadCentre(c: readonly Point2[]): Point2 {
  return { x: (c[0]!.x + c[1]!.x + c[2]!.x + c[3]!.x) / 4, y: (c[0]!.y + c[1]!.y + c[2]!.y + c[3]!.y) / 4 }
}

/** Two candidates are at the same place when their centres are close for their size and the sizes are similar. */
function sameQuad(a: Candidate, b: Candidate): boolean {
  const ca = quadCentre(a.corners)
  const cb = quadCentre(b.corners)
  const sa = meanSide(a.corners)
  const sb = meanSide(b.corners)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < 0.3 * Math.min(sa, sb) && sa / sb > 0.7 && sa / sb < 1.43
}

/** Edge of the grid cells groups are filed in, pixels. Any size gives the same groups; this one keeps a cell to a few groups on a frame of tiles. Adopted, not measured. */
const GROUP_CELL_PX = 16

/**
 * Candidates in groups of `sameQuad`, each group finest pyramid level first (then largest), the groups
 * largest first. A group is matched on its first member, the largest, as it is found, and filed in a grid by
 * that member's centre, so a candidate is compared only with the groups near it: the cost grows with the
 * number of candidates, not with its square (a wall of tiles gives over a thousand, and the comparison of
 * every pair cost more than finding them).
 */
export function groupCandidates(candidates: Candidate[]): Candidate[][] {
  const sorted = candidates.slice().sort((a, b) => b.area - a.area)
  const groups: Candidate[][] = []
  const grid = new Map<number, number[]>()
  const cellKey = (cx: number, cy: number) => cx * 1_048_576 + cy
  for (const cand of sorted) {
    const c = quadCentre(cand.corners)
    // The centres of two candidates of one group are closer than 0.3 of the smaller side, which is no more than this one's own side.
    const reach = Math.ceil((0.3 * meanSide(cand.corners)) / GROUP_CELL_PX)
    const cx = Math.floor(c.x / GROUP_CELL_PX)
    const cy = Math.floor(c.y / GROUP_CELL_PX)
    // The earliest group it matches, the largest first, as an all-pairs comparison would find.
    let home = -1
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iy = cy - reach; iy <= cy + reach; iy++) {
        const here = grid.get(cellKey(ix, iy))
        if (!here) continue
        for (const gi of here) {
          if ((home < 0 || gi < home) && sameQuad(groups[gi]![0]!, cand)) home = gi
        }
      }
    }
    if (home >= 0) {
      groups[home]!.push(cand)
    } else {
      groups.push([cand])
      const key = cellKey(cx, cy)
      const here = grid.get(key)
      if (here) here.push(groups.length - 1)
      else grid.set(key, [groups.length - 1])
    }
  }
  for (const g of groups) g.sort((a, b) => a.level - b.level || b.area - a.area)
  return groups
}

// -------------------------------------------------------------------------------------------
// 1-2. Luma and pyramid
// -------------------------------------------------------------------------------------------

function toLuma(image: FiducialImage, s: Scratch): Uint8Array {
  const { width, height, channels } = image
  const rowBytes = image.rowBytes ?? width * channels
  const data = image.data
  if (rowBytes < width * channels || data.length < rowBytes * (height - 1) + width * channels) {
    throw new RangeError(`fiducial image: ${data.length} bytes cannot hold ${width}x${height}x${channels} at ${rowBytes} bytes per row`)
  }
  if (channels === 1) {
    if (rowBytes === width) {
      return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    s.full = growU8(s.full, width * height)
    for (let y = 0; y < height; y++) s.full.set(data.subarray(y * rowBytes, y * rowBytes + width), y * width)
    return s.full
  }
  s.full = growU8(s.full, width * height)
  const out = s.full
  for (let y = 0; y < height; y++) {
    let p = y * rowBytes
    let o = y * width
    for (let x = 0; x < width; x++, p += 4, o++) {
      out[o] = (77 * data[p]! + 150 * data[p + 1]! + 29 * data[p + 2]!) >> 8
    }
  }
  return out
}

function buildLevels(full: Uint8Array, w0: number, h0: number, o: ResolvedDetectorOptions, s: Scratch): Level[] {
  let start = 0
  while ((w0 >> start) * (h0 >> start) > o.maxDetectPixels && (w0 >> (start + 1)) >= 32 && (h0 >> (start + 1)) >= 32) start++

  const levels: Level[] = []
  let src = full
  let sw = w0
  let sh = h0
  for (let k = 0; k < start + o.levels; k++) {
    if (k > 0) {
      const nw = sw >> 1
      const nh = sh >> 1
      if (nw < 32 || nh < 32) break
      s.pyramid[k] = growU8(s.pyramid[k] ?? new Uint8Array(0), nw * nh)
      halve(src, sw, sh, s.pyramid[k]!, nw, nh)
      src = s.pyramid[k]!
      sw = nw
      sh = nh
    }
    if (k >= start) levels.push({ luma: src, width: sw, height: sh, scale: 2 ** k })
  }
  return levels
}

/** 2x2 box average. */
function halve(src: Uint8Array, sw: number, _sh: number, dst: Uint8Array, dw: number, dh: number): void {
  for (let y = 0; y < dh; y++) {
    let a = 2 * y * sw
    let b = a + sw
    let o = y * dw
    for (let x = 0; x < dw; x++, a += 2, b += 2, o++) {
      dst[o] = (src[a]! + src[a + 1]! + src[b]! + src[b + 1]! + 2) >> 2
    }
  }
}

// -------------------------------------------------------------------------------------------
// 3-5. Threshold, components, quads
// -------------------------------------------------------------------------------------------

function threshold(level: Level, radius: number, offset: number, s: Scratch): Uint8Array {
  const { luma, width: w, height: h } = level
  const W1 = w + 1
  s.integral = growU32(s.integral, W1 * (h + 1))
  const I = s.integral
  for (let x = 0; x <= w; x++) I[x] = 0
  for (let y = 0; y < h; y++) {
    let row = 0
    const above = y * W1
    const cur = (y + 1) * W1
    I[cur] = 0
    const base = y * w
    for (let x = 0; x < w; x++) {
      row += luma[base + x]!
      I[cur + x + 1] = I[above + x + 1]! + row
    }
  }

  s.dark = growU8(s.dark, w * h)
  s.colX0 = growI32(s.colX0, w)
  s.colX1 = growI32(s.colX1, w)
  const x0s = s.colX0
  const x1s = s.colX1
  for (let x = 0; x < w; x++) {
    x0s[x] = x - radius < 0 ? 0 : x - radius
    x1s[x] = x + radius >= w ? w : x + radius + 1
  }
  const dark = s.dark
  for (let y = 0; y < h; y++) {
    const ya = y - radius < 0 ? 0 : y - radius
    const yb = y + radius >= h ? h : y + radius + 1
    const top = ya * W1
    const bottom = yb * W1
    const rows = yb - ya
    const base = y * w
    for (let x = 0; x < w; x++) {
      const xa = x0s[x]!
      const xb = x1s[x]!
      const sum = I[bottom + xb]! - I[top + xb]! - I[bottom + xa]! + I[top + xa]!
      dark[base + x] = (luma[base + x]! + offset) * (rows * (xb - xa)) < sum ? 1 : 0
    }
  }
  return dark
}

function findRoot(parent: Int32Array, i: number): number {
  let r = i
  while (parent[r] !== r) {
    parent[r] = parent[parent[r]!]!
    r = parent[r]!
  }
  return r
}

function findCandidates(level: Level, o: ResolvedDetectorOptions, s: Scratch, out: Candidate[]): void {
  const dark = threshold(level, o.thresholdRadius, o.thresholdOffset, s)
  const { width: w, height: h, scale } = level

  const maxRuns = ((w + 1) >> 1) * h + 1
  s.runX0 = growI32(s.runX0, maxRuns)
  s.runX1 = growI32(s.runX1, maxRuns)
  s.runY = growI32(s.runY, maxRuns)
  s.parent = growI32(s.parent, maxRuns)
  const { runX0, runX1, runY, parent } = s

  // Runs and unions with the row above (8-connected).
  let nRuns = 0
  let prevStart = 0
  let prevEnd = 0
  for (let y = 0; y < h; y++) {
    const rowStart = nRuns
    const base = y * w
    let x = 0
    while (x < w) {
      if (dark[base + x]) {
        const x0 = x
        while (x < w && dark[base + x]) x++
        runX0[nRuns] = x0
        runX1[nRuns] = x - 1
        runY[nRuns] = y
        parent[nRuns] = nRuns
        nRuns++
      } else {
        x++
      }
    }
    let p = prevStart
    for (let j = rowStart; j < nRuns; j++) {
      const a = runX0[j]!
      const b = runX1[j]!
      while (p < prevEnd && runX1[p]! < a - 1) p++
      let q = p
      while (q < prevEnd && runX0[q]! <= b + 1) {
        const ra = findRoot(parent, j)
        const rb = findRoot(parent, q)
        if (ra !== rb) {
          if (ra < rb) parent[rb] = ra
          else parent[ra] = rb
        }
        q++
      }
      if (q - 1 > p) p = q - 1
    }
    prevStart = rowStart
    prevEnd = nRuns
  }
  if (nRuns === 0) return

  // Per-component statistics and per-component run lists.
  s.area = growI32(s.area, nRuns)
  s.bx0 = growI32(s.bx0, nRuns)
  s.bx1 = growI32(s.bx1, nRuns)
  s.by0 = growI32(s.by0, nRuns)
  s.by1 = growI32(s.by1, nRuns)
  s.head = growI32(s.head, nRuns)
  s.next = growI32(s.next, nRuns)
  const { area, bx0, bx1, by0, by1, head, next } = s
  for (let i = 0; i < nRuns; i++) {
    area[i] = 0
    bx0[i] = 1 << 30
    bx1[i] = -1
    by0[i] = 1 << 30
    by1[i] = -1
    head[i] = -1
  }
  for (let i = 0; i < nRuns; i++) {
    const r = findRoot(parent, i)
    parent[i] = r
    area[r] = area[r]! + (runX1[i]! - runX0[i]! + 1)
    if (runX0[i]! < bx0[r]!) bx0[r] = runX0[i]!
    if (runX1[i]! > bx1[r]!) bx1[r] = runX1[i]!
    if (runY[i]! < by0[r]!) by0[r] = runY[i]!
    if (runY[i]! > by1[r]!) by1[r] = runY[i]!
    next[i] = head[r]!
    head[r] = i
  }

  const minSide = Math.max(MIN_LEVEL_SIDE_PX, o.minSidePx / scale)
  for (let r = 0; r < nRuns; r++) {
    if (parent[r] !== r) continue
    const bw = bx1[r]! - bx0[r]! + 1
    const bh = by1[r]! - by0[r]! + 1
    if (bw < minSide || bh < minSide) continue
    // The quiet zone and the border must both be inside the frame.
    if (bx0[r]! <= 0 || by0[r]! <= 0 || bx1[r]! >= w - 1 || by1[r]! >= h - 1) continue
    if (area[r]! < MIN_BAND_PX * 2 * (bw + bh)) continue
    if (bw > MAX_BBOX_RATIO * bh || bh > MAX_BBOX_RATIO * bw) continue

    const shape = quadFromComponent(r, head, next, runX0, runX1, runY, bx0[r]!, bx1[r]!, by0[r]!, by1[r]!, s)
    if (!shape) continue
    const corners = shape.corners
    let sx = 0
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!
      const b = corners[(i + 1) % 4]!
      sx += Math.hypot(b.x - a.x, b.y - a.y)
    }
    if (sx / 4 < minSide) continue
    const scaled = corners.map((c) => ({ x: c.x * scale, y: c.y * scale }))
    out.push({ corners: scaled, area: polygonArea(scaled), level: Math.round(Math.log2(scale)), disputed: shape.disputed })
  }
}

function polygonArea(p: readonly Point2[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const b = p[(i + 1) % p.length]!
    a += p[i]!.x * b.y - b.x * p[i]!.y
  }
  return a / 2
}

/**
 * The four corners of a component's outer boundary, clockwise on screen, or null when its outline
 * is not a quadrilateral. `disputed` says that more of the outline than a clean tag ever shows lies beyond the
 * quad's edges: the quad has settled on a line that is not the outermost one the outline supports.
 */
function quadFromComponent(
  root: number,
  head: Int32Array,
  next: Int32Array,
  runX0: Int32Array,
  runX1: Int32Array,
  runY: Int32Array,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  s: Scratch,
): { corners: Point2[]; disputed: boolean } | null {
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  s.rowMin = growI32(s.rowMin, bh)
  s.rowMax = growI32(s.rowMax, bh)
  s.colMin = growI32(s.colMin, bw)
  s.colMax = growI32(s.colMax, bw)
  const { rowMin, rowMax, colMin, colMax } = s
  for (let i = 0; i < bh; i++) {
    rowMin[i] = 1 << 30
    rowMax[i] = -1
  }
  for (let i = 0; i < bw; i++) {
    colMin[i] = 1 << 30
    colMax[i] = -1
  }
  for (let i = head[root]!; i >= 0; i = next[i]!) {
    const ry = runY[i]! - y0
    const a = runX0[i]!
    const b = runX1[i]!
    if (a < rowMin[ry]!) rowMin[ry] = a
    if (b > rowMax[ry]!) rowMax[ry] = b
    for (let x = a - x0; x <= b - x0; x++) {
      if (ry < colMin[x]!) colMin[x] = ry
      if (ry > colMax[x]!) colMax[x] = ry
    }
  }

  // Outer-boundary points, in doubled integer coordinates so that sorting and the hull are exact.
  s.keys = s.keys.length >= 2 * (bw + bh) ? s.keys : new Float64Array(Math.max(2 * (bw + bh), s.keys.length * 2))
  const keys = s.keys
  let n = 0
  const K = 16384
  for (let i = 0; i < bh; i++) {
    if (rowMax[i]! < 0) continue
    const y2 = 2 * (y0 + i) + 1
    keys[n++] = 2 * rowMin[i]! * K + y2
    keys[n++] = 2 * (rowMax[i]! + 1) * K + y2
  }
  for (let i = 0; i < bw; i++) {
    if (colMax[i]! < 0) continue
    const x2 = 2 * (x0 + i) + 1
    keys[n++] = x2 * K + 2 * (y0 + colMin[i]!)
    keys[n++] = x2 * K + 2 * (y0 + colMax[i]! + 1)
  }
  const sorted = keys.subarray(0, n).sort()

  // Andrew's monotone chain over the unique points.
  const px: number[] = []
  const py: number[] = []
  let last = -1
  for (let i = 0; i < n; i++) {
    const key = sorted[i]!
    if (key === last) continue
    last = key
    const xx = Math.floor(key / K)
    px.push(xx)
    py.push(key - xx * K)
  }
  const m = px.length
  if (m < 4) return null
  const hx: number[] = []
  const hy: number[] = []
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  for (let pass = 0; pass < 2; pass++) {
    const startLen = hx.length
    for (let ii = 0; ii < m; ii++) {
      const i = pass === 0 ? ii : m - 1 - ii
      while (hx.length >= startLen + 2 && cross(hx[hx.length - 2]!, hy[hy.length - 2]!, hx[hx.length - 1]!, hy[hy.length - 1]!, px[i]!, py[i]!) <= 0) {
        hx.pop()
        hy.pop()
      }
      hx.push(px[i]!)
      hy.push(py[i]!)
    }
    hx.pop()
    hy.pop()
  }
  const hn = hx.length
  if (hn < 4) return null

  const quad: Point2[] = prominentVertices(hx, hy, 4).map((i) => ({ x: hx[i]! / 2, y: hy[i]! / 2 }))
  if (polygonArea(quad) < 0) quad.reverse()
  // Clockwise on screen (y down) is positive signed area.
  if (polygonArea(quad) <= 0) return null
  // The extreme hull points are corners only if nothing sticks out; a noise speck or a rounded
  // corner moves them. Fit each side to the boundary points along it and take the intersections.
  const fitted = refitToBoundary(quad, px, py, m)
  for (let i = 0; i < 4; i++) quad[i] = fitted[i]!

  // Shape tests: convex, sides not absurdly unequal, every hull vertex near an edge.
  let longest = 0
  let shortest = Infinity
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!
    const b = quad[(i + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    longest = Math.max(longest, len)
    shortest = Math.min(shortest, len)
    const c = quad[(i + 2) % 4]!
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return null
  }
  if (shortest <= 0 || longest / shortest > MAX_SIDE_RATIO) return null
  const tol = Math.max(FIT_ABS_PX, FIT_REL * ((longest + shortest) / 2))
  for (let i = 0; i < hn; i++) {
    if (nearestEdge(hx[i]! / 2, hy[i]! / 2, quad) > FIT_HULL_FACTOR * tol) return null
  }
  // Outline points beyond the quad are bulges (a speck, a second object touching the tag) and points inside it
  // are bites (something laid over the edge): a tag can lose black to an occluder but cannot gain it, so bites
  // are forgiven for much longer a stretch than bulges.
  let bulges = 0
  let bites = 0
  for (let i = 0; i < m; i++) {
    const depth = insideDepth(px[i]! / 2, py[i]! / 2, quad)
    if (depth < -tol) bulges++
    else if (depth > tol) bites++
  }
  if (bulges > FIT_OUTLIER_FRACTION * m || bites > FIT_BITE_FRACTION * m) return null
  return { corners: quad, disputed: bulges > FIT_DISPUTE_FRACTION * m }
}

/**
 * The indices (in hull order) of the `k` vertices of a convex polygon that carry the most area. The
 * vertex whose removal shrinks the polygon least goes first, repeatedly, until `k` are left: the line
 * simplification of Visvalingam and Whyatt, which on a convex polygon is a greedy approximation of the
 * largest inscribed k-gon. Unlike picking the two farthest points as a diagonal it assumes nothing about
 * the shape, so a tag seen so obliquely that one of its sides is longer than either diagonal still
 * keeps its four corners. A heap with lazy updates keeps it O(n log n), because a ragged blob (a disc,
 * a hand) has hundreds of hull vertices.
 */
function prominentVertices(hx: readonly number[], hy: readonly number[], k: number): number[] {
  const n = hx.length
  const prev = new Int32Array(n)
  const next = new Int32Array(n)
  const stamp = new Int32Array(n)
  const alive = new Uint8Array(n).fill(1)
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n
    next[i] = (i + 1) % n
  }
  // Twice the area of the triangle a vertex forms with its current neighbours.
  const loss = (i: number): number => {
    const a = prev[i]!
    const b = next[i]!
    return Math.abs((hx[i]! - hx[a]!) * (hy[b]! - hy[a]!) - (hy[i]! - hy[a]!) * (hx[b]! - hx[a]!))
  }
  const heapLoss: number[] = []
  const heapVertex: number[] = []
  const heapStamp: number[] = []
  const less = (a: number, b: number) => heapLoss[a]! < heapLoss[b]! || (heapLoss[a]! === heapLoss[b]! && heapVertex[a]! < heapVertex[b]!)
  const swap = (a: number, b: number) => {
    const l = heapLoss[a]!
    const v = heapVertex[a]!
    const s = heapStamp[a]!
    heapLoss[a] = heapLoss[b]!
    heapVertex[a] = heapVertex[b]!
    heapStamp[a] = heapStamp[b]!
    heapLoss[b] = l
    heapVertex[b] = v
    heapStamp[b] = s
  }
  const push = (i: number) => {
    heapLoss.push(loss(i))
    heapVertex.push(i)
    heapStamp.push(stamp[i]!)
    let c = heapLoss.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (!less(c, p)) break
      swap(c, p)
      c = p
    }
  }
  const pop = () => {
    const last = heapLoss.length - 1
    swap(0, last)
    heapLoss.pop()
    heapVertex.pop()
    heapStamp.pop()
    let p = 0
    for (;;) {
      const l = 2 * p + 1
      const r = l + 1
      let m = p
      if (l < last && less(l, m)) m = l
      if (r < last && less(r, m)) m = r
      if (m === p) break
      swap(p, m)
      p = m
    }
  }
  for (let i = 0; i < n; i++) push(i)
  let left = n
  while (left > k) {
    const v = heapVertex[0]!
    const fresh = heapStamp[0]! === stamp[v]! && alive[v]! === 1
    pop()
    if (!fresh) continue
    alive[v] = 0
    left--
    const a = prev[v]!
    const b = next[v]!
    next[a] = b
    prev[b] = a
    stamp[a] = stamp[a]! + 1
    stamp[b] = stamp[b]! + 1
    push(a)
    push(b)
  }
  const out: number[] = []
  let start = 0
  while (alive[start] !== 1) start++
  let i = start
  do {
    out.push(i)
    i = next[i]!
  } while (i !== start)
  return out
}

/** Share of a side, at each end, left out of its line fit: corners round and spikes live there. Adopted, not measured. */
const REFIT_END_FRACTION = 0.12
/** A boundary point belongs to a side when it is within this many pixels of it, or this fraction of the side length, whichever is larger. Adopted, not measured. */
const REFIT_ASSIGN_PX = 3
const REFIT_ASSIGN_REL = 0.08
/**
 * The scatter of a boundary point about its edge never counts as less than this, in pixels: a blob's outline
 * is a staircase of whole pixels, which is 0.3 px of scatter by itself (a uniform step of one pixel), and a
 * little more with noise. Adopted, not measured (ADR 0005 rule 5).
 */
const REFIT_MIN_SIGMA_PX = 0.3
/** A side's line is the majority's, or it keeps the polygon's own: the share of the assigned points that must lie on it. */
const REFIT_MIN_INLIER_FRACTION = 0.5
/** A line further out than the majority's wins when this share of the assigned points lie on it. Adopted, not measured (ADR 0005 rule 5): a fifth of a side's middle is a run no speck makes. */
const REFIT_MIN_OUTER_FRACTION = 0.2

/**
 * Replace a quad's corners by the intersections of lines fitted to the boundary points along each
 * side (middle of each side only). Points are in doubled coordinates, as `quadFromComponent` holds
 * them. The fit is robust: a bite out of a side (tape, a finger, a shadow that cuts the blob) leaves
 * the boundary points of that stretch a few pixels inside the true edge, and a plain fit would follow
 * them. A side with too few points, or with no majority on one line, keeps its original line, and
 * a corner that would move far keeps its original position, so this can only correct what it can see.
 */
function refitToBoundary(quad: readonly Point2[], px: readonly number[], py: readonly number[], m: number): Point2[] {
  let side = 0
  for (let i = 0; i < 4; i++) side += Math.hypot(quad[(i + 1) % 4]!.x - quad[i]!.x, quad[(i + 1) % 4]!.y - quad[i]!.y)
  side /= 4
  const assign = Math.max(REFIT_ASSIGN_PX, REFIT_ASSIGN_REL * side)
  const lines: Line[] = []
  for (let e = 0; e < 4; e++) {
    const a = quad[e]!
    const b = quad[(e + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const dx = (b.x - a.x) / len
    const dy = (b.y - a.y) / len
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < m; i++) {
      const x = px[i]! / 2
      const y = py[i]! / 2
      const t = ((x - a.x) * dx + (y - a.y) * dy) / len
      if (t < REFIT_END_FRACTION || t > 1 - REFIT_END_FRACTION) continue
      if (Math.abs((x - a.x) * -dy + (y - a.y) * dx) > assign) continue
      xs.push(x)
      ys.push(y)
    }
    const nominal: Line = { px: a.x, py: a.y, dx, dy }
    let fit = xs.length >= 6 ? fitLineRobust(xs, ys, nominal, REFIT_MIN_SIGMA_PX) : null
    if (fit && xs.length >= 6) {
      // A bite out of the side puts a stretch of the outline inside the true edge, and when the bite is
      // the longer stretch the majority's line is the bite's. The outline can lose black but cannot gain
      // it, so a line that is further out and still carries a real share of the points is the edge.
      const outer = outerSupport(xs, ys, nominal, fit.line)
      if (outer) fit = outer
    }
    const agrees = fit !== null && fit.inliers > REFIT_MIN_INLIER_FRACTION * xs.length && Math.abs(fit.line.dx * dx + fit.line.dy * dy) > 0.98
    lines.push(fit !== null && agrees ? fit.line : nominal)
  }
  const out: Point2[] = []
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4]!, lines[i]!)
    const q = quad[i]!
    out.push(p && Math.hypot(p.x - q.x, p.y - q.y) <= 0.25 * side ? p : q)
  }
  return out
}

/**
 * The fit through the points that lie on `nominal` (the chord between two hull vertices, the outermost
 * line the outline allows) when that line is further out than `chosen` by more than the scatter and
 * carries at least `REFIT_MIN_OUTER_FRACTION` of the points; otherwise null. "Out" is away from the
 * quad's inside, which is the side of the inward normal `(-dy, dx)`.
 */
function outerSupport(xs: readonly number[], ys: readonly number[], nominal: Line, chosen: Line): RobustLine | null {
  const cut = FIT_CUT_SIGMAS * REFIT_MIN_SIGMA_PX
  const nx = -nominal.dy
  const ny = nominal.dx
  // Where the chosen line crosses the middle of the nominal one, measured inward.
  const mx = xs.reduce((sum, x) => sum + x, 0) / xs.length
  const my = ys.reduce((sum, y) => sum + y, 0) / ys.length
  const t = (mx - chosen.px) * chosen.dx + (my - chosen.py) * chosen.dy
  const inward = (chosen.px + chosen.dx * t - nominal.px) * nx + (chosen.py + chosen.dy * t - nominal.py) * ny
  if (!(inward > cut)) return null
  const onx: number[] = []
  const ony: number[] = []
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs((xs[i]! - nominal.px) * nx + (ys[i]! - nominal.py) * ny) <= cut) {
      onx.push(xs[i]!)
      ony.push(ys[i]!)
    }
  }
  if (onx.length < REFIT_MIN_OUTER_FRACTION * xs.length) return null
  const fit = fitLineRobust(onx, ony, nominal, REFIT_MIN_SIGMA_PX)
  return fit && fit.inliers >= REFIT_MIN_OUTER_FRACTION * xs.length ? fit : null
}

/** How far inside a convex quad (clockwise on screen) a point is, to its nearest side line; negative when it is outside. */
function insideDepth(x: number, y: number, quad: readonly Point2[]): number {
  let depth = Infinity
  for (let e = 0; e < 4; e++) {
    const a = quad[e]!
    const b = quad[(e + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const d = ((x - a.x) * -(b.y - a.y) + (y - a.y) * (b.x - a.x)) / len
    if (d < depth) depth = d
  }
  return depth
}

function nearestEdge(x: number, y: number, quad: readonly Point2[]): number {
  const p = { x, y }
  let best = Infinity
  for (let e = 0; e < 4; e++) {
    const d = distToSegment(p, quad[e]!, quad[(e + 1) % 4]!)
    if (d < best) best = d
  }
  return best
}

function distToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// -------------------------------------------------------------------------------------------
// 6. Edge refinement on the grey image
// -------------------------------------------------------------------------------------------

function sampleBilinear(luma: Uint8Array, w: number, h: number, u: number, v: number): number {
  let x = u - 0.5
  let y = v - 0.5
  if (x < 0) x = 0
  else if (x > w - 1) x = w - 1
  if (y < 0) y = 0
  else if (y > h - 1) y = h - 1
  const x0 = x | 0
  const y0 = y | 0
  const x1 = x0 + 1 < w ? x0 + 1 : x0
  const y1 = y0 + 1 < h ? y0 + 1 : y0
  const fx = x - x0
  const fy = y - y0
  const r0 = y0 * w
  const r1 = y1 * w
  const top = luma[r0 + x0]! + (luma[r0 + x1]! - luma[r0 + x0]!) * fx
  const bottom = luma[r1 + x0]! + (luma[r1 + x1]! - luma[r1 + x0]!) * fx
  return top + (bottom - top) * fy
}

interface Line {
  px: number
  py: number
  dx: number
  dy: number
}

interface RefineResult {
  corners: Point2[]
  /** RMS residual of the kept edge points over all four edges, pixels. */
  rms: number
  /** False when at least one edge could not be fitted and kept its polygon line. */
  allEdges: boolean
  /** The smallest share of an edge's samples that lay on the line fitted to it, over the edges that were fitted. */
  inlierFraction: number
}

/**
 * Re-locate the four edges of `quad` (clockwise on screen) on the grey image and return the
 * intersections of the fitted lines. `halfWidth` is how far either side of the current edge to
 * look, pixels. Null when no edge could be fitted at all.
 */
function refineQuad(luma: Uint8Array, w: number, h: number, quad: readonly Point2[], halfWidth: number, minContrast: number): RefineResult | null {
  const lines: Line[] = []
  let okEdges = 0
  let sumSq = 0
  let nKept = 0
  let inlierFraction = 1
  const nProf = Math.floor((2 * halfWidth) / PROFILE_STEP) + 1
  if (nProf < 7) return null
  const prof = new Float64Array(nProf)
  const smooth = new Float64Array(nProf)
  const grad = new Float64Array(nProf)

  for (let e = 0; e < 4; e++) {
    const a = quad[e]!
    const b = quad[(e + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const dx = (b.x - a.x) / len
    const dy = (b.y - a.y) / len
    // Inward normal for a clockwise-on-screen quad.
    const nx = -dy
    const ny = dx
    const fallback: Line = { px: a.x, py: a.y, dx, dy }
    const ns = Math.max(EDGE_SAMPLES_MIN, Math.min(EDGE_SAMPLES_MAX, Math.round(len / EDGE_SAMPLE_SPACING_PX)))
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < ns; k++) {
      const t = len * (EDGE_START + (EDGE_SPAN * (k + 0.5)) / ns)
      const bx = a.x + dx * t
      const by = a.y + dy * t
      let lo = 255
      let hi = 0
      for (let j = 0; j < nProf; j++) {
        const sOff = -halfWidth + j * PROFILE_STEP
        const v = sampleBilinear(luma, w, h, bx + nx * sOff, by + ny * sOff)
        prof[j] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (hi - lo < minContrast) continue
      for (let j = 0; j < nProf; j++) {
        const l = prof[j > 0 ? j - 1 : 0]!
        const r = prof[j < nProf - 1 ? j + 1 : nProf - 1]!
        smooth[j] = (l + 2 * prof[j]! + r) * 0.25
      }
      let jm = -1
      let gm = 0
      for (let j = 1; j < nProf - 1; j++) {
        const g = (smooth[j + 1]! - smooth[j - 1]!) / (2 * PROFILE_STEP)
        grad[j] = g
        if (j >= 2 && j <= nProf - 3 && g < gm) {
          gm = g
          jm = j
        }
      }
      if (jm < 0) continue
      const g0 = grad[jm]!
      const gl = grad[jm - 1]!
      const gr = grad[jm + 1]!
      // A step whose steepest point is at the edge of the window is not located by it: the window is cutting the
      // transition (the real edge lies beyond it, or this is the foot of another one), and a "position" there is
      // wherever the window happens to end.
      if (g0 > gl || g0 > gr) continue
      const denom = gl - 2 * g0 + gr
      const frac = denom > 1e-9 ? (0.5 * (gl - gr)) / denom : 0
      const sPeak = -halfWidth + (jm + Math.max(-0.5, Math.min(0.5, frac))) * PROFILE_STEP
      xs.push(bx + nx * sPeak)
      ys.push(by + ny * sPeak)
    }
    // An edge counts as located only when all of these hold:
    //  - most of ALL the samples lie on one line (samples that found no step, because something hid the edge there,
    //    count against it: a line through what is left of a half-covered edge is a guess);
    //  - almost none found their step beyond the line (what covers an edge can only hide black, so a stretch of steps
    //    further out means the line is what is left of a covered edge);
    //  - the edge is straight: the sag of its middle from the chord between its ends is small. A bowed edge (a curled
    //    sheet, lens distortion near the frame edge) puts the corners wherever a straight line through it crosses its
    //    neighbours, by about the sag or more.
    const fit = xs.length >= EDGE_MIN_INLIER_FRACTION * ns ? fitLineRobust(xs, ys, fallback, LINE_MIN_SIGMA_PX) : null
    const sag = fit ? Math.abs(fit.curvature) * (len / 2) * (len / 2) : 0
    // A sag is only seen if it exceeds what the scatter of the samples could make of a straight edge: the standard error of
    // the sag of a parabola fitted to `n` points spread along the edge is about 5.2 sigma / sqrt(n) (the fit's quadratic
    // coefficient has a standard error of 13.4 sigma / (sqrt(n) L^2) over a stretch L = 0.8 of the edge, and the sag is
    // that times (edge / 2)^2), which is 0.13 px on a clean frame and 0.6 px at 12 levels of noise on a small tag.
    const sagLimit = fit ? Math.max(EDGE_MIN_SAG_PX, EDGE_MAX_SAG_FRACTION * len, (EDGE_SAG_SIGMAS * SAG_ERROR_PER_SIGMA * fit.rms) / Math.sqrt(fit.inliers)) : 0
    const located =
      fit !== null &&
      fit.inliers >= EDGE_MIN_INLIER_FRACTION * ns &&
      fit.outward <= EDGE_MAX_OUTWARD_FRACTION * ns &&
      sag <= sagLimit
    if (!fit || !located) {
      lines.push(fallback)
      continue
    }
    lines.push(fit.line)
    okEdges++
    sumSq += fit.rms * fit.rms * fit.inliers
    nKept += fit.inliers
    inlierFraction = Math.min(inlierFraction, fit.inliers / ns)
  }
  if (okEdges === 0) return null

  const corners: Point2[] = []
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4]!, lines[i]!)
    const q = quad[i]!
    // A corner that moves far from the polygon's own estimate means the fits disagree with it.
    if (!p || Math.hypot(p.x - q.x, p.y - q.y) > Math.max(CORNER_MOVE_MIN_PX, halfWidth * CORNER_MOVE_WINDOWS)) return null
    corners.push(p)
  }
  return { corners, rms: nKept > 0 ? Math.sqrt(sumSq / nKept) : 0, allEdges: okEdges === 4, inlierFraction }
}

/** A line fitted through points that mostly lie on one, and how many of them did. */
interface RobustLine {
  line: Line
  /** RMS distance of the inliers from the line, pixels. */
  rms: number
  inliers: number
  /** Points that are not inliers and lie on the outward side of the line (away from `ref`'s inward normal): outline or edge steps beyond it. */
  outward: number
  /** The quadratic coefficient of the inliers about the line, pixels per pixel squared: how much the edge bows. Zero for fewer than five inliers. */
  curvature: number
}

/**
 * Candidate lines tried by `fitLineRobust`: lines through pairs of points taken from a fixed
 * low-discrepancy sequence. When 60 % of the points are inliers a pair is made of two of them with
 * probability 0.36, so 40 pairs miss every inlier pair with probability 1e-6 (and the fit then still has
 * the plain least-squares line and the nominal one as candidates); the sequence is fixed, so a frame
 * gives the same answer every time. Adopted, not measured (ADR 0005 rule 5).
 */
const FIT_HYPOTHESES = 40
const FIT_GOLDEN = 0.6180339887498949
const FIT_PLASTIC = 0.7548776662466927
/** The two points of a candidate line lie at least this far apart, as a share of the points' extent along it: a short chord has a wild slope. Adopted, not measured. */
const FIT_MIN_CHORD = 0.25
/** Points a candidate is scored on: a long run of boundary points is thinned to about this many. Adopted, not measured. */
const FIT_SCORED_POINTS = 64
/** Inliers lie within this many robust sigmas of the line: 2.5 keeps 98.8 % of Gaussian scatter. */
const FIT_CUT_SIGMAS = 2.5
/**
 * The scatter measured about the fitted line may exceed the one measured from neighbouring points by this factor and no more.
 * Neighbouring steps of a blurred edge share noise, so their differences understate the scatter. Adopted, not measured (ADR 0005
 * rule 5), but its effect was: on 120 frames of a 40 px tag at 12 levels of noise the corners were refined on 117 of 120 with 2 and 113
 * of 120 with 1, and a growth of 4 changes nothing there while letting two more of the strip table's majority-covered cells through.
 */
const FIT_SCALE_GROWTH = 2
/** A point counts as lying outward of the line only when it is at least this far beyond it, pixels: a hidden stretch of an edge leaves its remaining steps whole pixels away, while noise does not. Adopted, not measured. */
const FIT_OUTWARD_MIN_PX = 1

function ols(t: Float64Array, d: Float64Array, use: Uint8Array | null): { a: number; b: number } | null {
  let m = 0
  let st = 0
  let sd = 0
  let stt = 0
  let std = 0
  for (let i = 0; i < t.length; i++) {
    if (use && !use[i]) continue
    m++
    st += t[i]!
    sd += d[i]!
    stt += t[i]! * t[i]!
    std += t[i]! * d[i]!
  }
  if (m < 2) return null
  const det = m * stt - st * st
  if (!(det > 1e-9)) return null
  const b = (m * std - st * sd) / det
  return { a: (sd - b * st) / m, b }
}

function medianOfSorted(a: Float64Array): number {
  const n = a.length
  return n === 0 ? 0 : n % 2 ? a[(n - 1) >> 1]! : 0.5 * (a[n / 2 - 1]! + a[n / 2]!)
}

/**
 * A line through the majority of a set of points, ignoring the rest. `ref` is a rough position and
 * direction of the line; the points are expressed along it (`t`) and across it (`d`), the line is
 * `d = a + b t`, and the fit is made in those coordinates, where an edge's error is all in `d`.
 *
 * A least-squares line, with or without trimming at a few robust sigmas of ITS OWN residuals, is pulled
 * toward a minority of points that lie together, and the sigma it measures is inflated by them, so it
 * does not see them: a strip of tape over a third of a border edge moved the corners by whole pixels
 * that way. Here the scatter is measured first, from differences between neighbouring points along the
 * edge, where a stretch of outliers shows in only the two differences at its ends (median absolute
 * deviation of the differences, 1.4826 / sqrt 2 for Gaussian scatter), and floored at `minSigma`. The
 * line is then the candidate that costs least when a point costs its squared distance from the line
 * or the squared band `FIT_CUT_SIGMAS` sigmas wide if it lies outside it (RANSAC with the MSAC cost,
 * Fischler and Bolles 1981, Torr and Zisserman 2000), refitted by least squares to its inliers twice. The band widens with sensor noise
 * instead of throwing noisy points away: a frame with 12 levels of noise has an edge scatter of half a
 * pixel and keeps nearly every sample. Two stretches of equal length on different lines tie, and the
 * caller's inlier share then fails, which is the right answer. A set whose every point is within the least
 * inlier band of the plain least-squares line takes that fit unchanged, and costs nothing more.
 */
function fitLineRobust(xs: readonly number[], ys: readonly number[], ref: Line, minSigma: number): RobustLine | null {
  const n = xs.length
  if (n < 4) return null
  const nx = -ref.dy
  const ny = ref.dx
  const t = new Float64Array(n)
  const d = new Float64Array(n)
  let tMin = Infinity
  let tMax = -Infinity
  let tSum = 0
  let ordered = true
  for (let i = 0; i < n; i++) {
    const ex = xs[i]! - ref.px
    const ey = ys[i]! - ref.py
    t[i] = ex * ref.dx + ey * ref.dy
    d[i] = ex * nx + ey * ny
    if (t[i]! < tMin) tMin = t[i]!
    if (t[i]! > tMax) tMax = t[i]!
    if (i > 0 && t[i]! < t[i - 1]!) ordered = false
    tSum += t[i]!
  }
  const span = tMax - tMin
  if (!(span > 0)) return null
  const tMean = tSum / n
  for (let i = 0; i < n; i++) t[i] = t[i]! - tMean

  const resid = new Float64Array(n)
  const residualsOf = (a: number, b: number) => {
    for (let i = 0; i < n; i++) resid[i] = d[i]! - a - b * t[i]!
  }
  const all = ols(t, d, null)
  if (!all) return null
  residualsOf(all.a, all.b)
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(resid[i]!))

  let line = all
  let use = new Uint8Array(n).fill(1)
  let inliers = n
  let cutPx = FIT_CUT_SIGMAS * minSigma
  if (worst > FIT_CUT_SIGMAS * minSigma) {
    // The scatter of the points about a line, from neighbours along the edge.
    const order = Array.from({ length: n }, (_, i) => i)
    if (!ordered) order.sort((p, q) => t[p]! - t[q]!)
    const diff = new Float64Array(n - 1)
    for (let k = 0; k < n - 1; k++) diff[k] = d[order[k + 1]!]! - d[order[k]!]!
    diff.sort()
    const medDiff = medianOfSorted(diff)
    for (let k = 0; k < n - 1; k++) diff[k] = Math.abs(diff[k]! - medDiff)
    diff.sort()
    const sigmaNeighbours = Math.max(minSigma, (1.4826 * medianOfSorted(diff)) / Math.SQRT2)
    let cut = FIT_CUT_SIGMAS * sigmaNeighbours
    cutPx = cut

    // The candidate that explains the most points best, scored on a thinned copy of the points: each point
    // costs its squared distance from the line, or the squared band if it is outside it (Torr and
    // Zisserman 2000). Counting inliers alone lets a tilted line that clips two parallel runs of points
    // beat the line through one of them.
    const step = Math.max(1, Math.floor(n / FIT_SCORED_POINTS))
    const scored: number[] = []
    for (let i = 0; i < n; i += step) scored.push(i)
    const capSq = cut * cut
    let bestCost = Infinity
    let bestA = 0
    let bestB = 0
    const consider = (a: number, b: number) => {
      let cost = 0
      for (let k = 0; k < scored.length; k++) {
        const r = d[scored[k]!]! - a - b * t[scored[k]!]!
        cost += Math.min(r * r, capSq)
      }
      if (cost < bestCost) {
        bestCost = cost
        bestA = a
        bestB = b
      }
    }
    consider(all.a, all.b)
    consider(0, 0)
    for (let h = 0; h < FIT_HYPOTHESES; h++) {
      const i = Math.floor(((0.5 + h * FIT_GOLDEN) % 1) * n)
      const j = Math.floor(((0.2 + h * FIT_PLASTIC) % 1) * n)
      const dt = t[j]! - t[i]!
      if (i === j || Math.abs(dt) < FIT_MIN_CHORD * span) continue
      const b = (d[j]! - d[i]!) / dt
      consider(d[i]! - b * t[i]!, b)
    }

    let a = bestA
    let b = bestB
    const abs = new Float64Array(n)
    for (let pass = 0; pass < 4; pass++) {
      residualsOf(a, b)
      // Neighbouring samples share noise (the profile is blurred and the steps are located a few pixels apart),
      // so their differences understate the scatter about a line somewhat: take the larger of that and the
      // median residual about the line itself, but by no more than `FIT_SCALE_GROWTH` times the first, because
      // with half the points on another line the median residual is the gap between the two and says nothing about scatter.
      for (let i = 0; i < n; i++) abs[i] = Math.abs(resid[i]!)
      cut = FIT_CUT_SIGMAS * Math.min(FIT_SCALE_GROWTH * sigmaNeighbours, Math.max(sigmaNeighbours, 1.4826 * medianOfSorted(abs.sort())))
      cutPx = cut
      use = new Uint8Array(n)
      inliers = 0
      for (let i = 0; i < n; i++) {
        if (Math.abs(resid[i]!) <= cut) {
          use[i] = 1
          inliers++
        }
      }
      if (inliers < 3) return null
      if (pass === 3) break
      const fit = ols(t, d, use)
      if (!fit) return null
      a = fit.a
      b = fit.b
    }
    line = { a, b }
  }

  let sq = 0
  let outward = 0
  const outwardPx = Math.max(cutPx, FIT_OUTWARD_MIN_PX)
  for (let i = 0; i < n; i++) {
    if (!use[i]) {
      if (resid[i]! < -outwardPx) outward++
      continue
    }
    sq += resid[i]! * resid[i]!
  }
  const ux = ref.dx + nx * line.b
  const uy = ref.dy + ny * line.b
  const un = Math.hypot(ux, uy)
  const bow = inliers >= 5 ? quadraticCoefficient(t, d, use) : 0
  return {
    line: { px: ref.px + ref.dx * tMean + nx * line.a, py: ref.py + ref.dy * tMean + ny * line.a, dx: ux / un, dy: uy / un },
    rms: Math.sqrt(sq / inliers),
    inliers,
    outward,
    curvature: bow,
  }
}

/**
 * The coefficient `c` of the least-squares parabola `d = a + b t + c t^2` through the marked points, `t`
 * centred. Null-safe: 0 when the points are too few or too bunched to say.
 */
function quadraticCoefficient(t: Float64Array, d: Float64Array, use: Uint8Array): number {
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  let y0 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < t.length; i++) {
    if (!use[i]) continue
    const x = t[i]!
    const x2 = x * x
    s0++
    s1 += x
    s2 += x2
    s3 += x2 * x
    s4 += x2 * x2
    y0 += d[i]!
    y1 += x * d[i]!
    y2 += x2 * d[i]!
  }
  // [s0 s1 s2; s1 s2 s3; s2 s3 s4] [a b c]' = [y0 y1 y2]', c by Cramer's rule.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2)
  if (!(Math.abs(det) > 1e-9)) return 0
  const c = (s0 * (s2 * y2 - y1 * s3) - s1 * (s1 * y2 - y1 * s2) + y0 * (s1 * s3 - s2 * s2)) / det
  return Number.isFinite(c) ? c : 0
}

function intersect(a: Line, b: Line): Point2 | null {
  const det = a.dx * b.dy - a.dy * b.dx
  if (Math.abs(det) < 1e-6) return null
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det
  return { x: a.px + t * a.dx, y: a.py + t * a.dy }
}

// -------------------------------------------------------------------------------------------
// 7-8. Unwarp, sample, validate, match
// -------------------------------------------------------------------------------------------

/**
 * Square-to-quad homography: unit square corners (0,0) (1,0) (1,1) (0,1) onto `q`. Returns [a..h]. This is the
 * closed form for the projective map of a unit square onto a quadrilateral, as derived in P. Heckbert,
 * "Fundamentals of Texture Mapping and Image Warping", MS thesis, UC Berkeley, 1989 (section 2.2.1).
 */
function squareToQuad(q: readonly Point2[]): number[] {
  const [p0, p1, p2, p3] = q as [Point2, Point2, Point2, Point2]
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  let g = 0
  let hh = 0
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    hh = (dx1 * dy3 - dx3 * dy1) / den
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y, g, hh]
}

interface Read {
  id: number
  rotation: number
  hamming: number
  contrast: number
  /** Smallest distance of a data cell from the threshold, as a fraction of half the contrast, 0..1. */
  bitMargin: number
}

/** What a read must satisfy to count: the part of `ResolvedDetectorOptions` that `sampleAndMatch` judges by. */
interface ReadLimits {
  minContrast: number
  maxBorderErrors: number
  maxQuietErrors: number
  maxHamming: number
}

function sampleAndMatch(luma: Uint8Array, w: number, h: number, quad: readonly Point2[], dict: Dictionary, o: ReadLimits, s: Scratch, why: DetectorStats['rejected']): Read | null {
  const bits = dict.bits
  const cells = bits + 2
  const H = squareToQuad(quad)
  const [a, b, c, d, e, f, g, hh] = H as [number, number, number, number, number, number, number, number]
  const delta = SUB_SAMPLE / cells

  s.cells = s.cells.length >= cells * cells ? s.cells : new Float64Array(cells * cells)
  s.quiet = s.quiet.length >= 4 * cells ? s.quiet : new Float64Array(4 * cells)
  s.grid = growU8(s.grid, bits * bits)
  const cellMeans = s.cells
  const quietMeans = s.quiet

  // Mean of a 3x3 pattern around (u, v) in tag units [0, 1]; NaN if any sample is off the frame.
  const sampleAt = (u: number, v: number): number => {
    let sum = 0
    for (let j = -1; j <= 1; j++) {
      const vv = v + j * delta
      for (let i = -1; i <= 1; i++) {
        const uu = u + i * delta
        const den = g * uu + hh * vv + 1
        const x = (a * uu + b * vv + c) / den
        const y = (d * uu + e * vv + f) / den
        if (!(x >= 0 && x <= w && y >= 0 && y <= h)) return NaN
        sum += sampleBilinear(luma, w, h, x, y)
      }
    }
    return sum / 9
  }

  for (let r = 0; r < cells; r++) {
    for (let cc = 0; cc < cells; cc++) {
      const v = sampleAt((cc + 0.5) / cells, (r + 0.5) / cells)
      if (v !== v) {
        why.offFrame++
        return null
      }
      cellMeans[r * cells + cc] = v
    }
  }
  // The quiet ring: half a cell outside the border, all the way round.
  let qi = 0
  for (let i = 0; i < cells; i++) {
    const t = (i + 0.5) / cells
    const half = 0.5 / cells
    const samples = [sampleAt(t, -half), sampleAt(t, 1 + half), sampleAt(-half, t), sampleAt(1 + half, t)]
    for (const v of samples) {
      if (v !== v) {
        why.offFrame++
        return null
      }
      quietMeans[qi++] = v
    }
  }

  // Levels of black and white across the tag. The border is black and the quiet ring white wherever the light
  // falls on them, so each is a measurement of the light: two planes, fitted to the border cells and to the
  // quiet-zone samples, say what black and what white are at every point of the tag (a lamp's gradient across
  // a sheet, a soft shadow), and a cell is judged against the level halfway between them where it is. A
  // single threshold for the whole tag cannot do that: the paper at the dim end of a 3:1 gradient is darker
  // than the halfway level of the tag as a whole.
  const n = Math.max(4 * (cells - 1), 4 * cells)
  if (s.refX.length < n) {
    s.refX = new Float64Array(n)
    s.refY = new Float64Array(n)
    s.refV = new Float64Array(n)
  }
  let nb = 0
  for (let r = 0; r < cells; r++) {
    for (let cc = 0; cc < cells; cc++) {
      if (r === 0 || cc === 0 || r === cells - 1 || cc === cells - 1) {
        s.refX[nb] = cc + 0.5
        s.refY[nb] = r + 0.5
        s.refV[nb] = cellMeans[r * cells + cc]!
        nb++
      }
    }
  }
  const blackPlane = fitPlane(s.refX, s.refY, s.refV, nb)
  for (let i = 0; i < cells; i++) {
    const at = i + 0.5
    s.refX[4 * i] = at
    s.refY[4 * i] = -0.5
    s.refX[4 * i + 1] = at
    s.refY[4 * i + 1] = cells + 0.5
    s.refX[4 * i + 2] = -0.5
    s.refY[4 * i + 2] = at
    s.refX[4 * i + 3] = cells + 0.5
    s.refY[4 * i + 3] = at
  }
  for (let i = 0; i < qi; i++) s.refV[i] = quietMeans[i]!
  const whitePlane = fitPlane(s.refX, s.refY, s.refV, qi)
  const blackAt = (x: number, y: number) => blackPlane.a + blackPlane.b * x + blackPlane.c * y
  const whiteAt = (x: number, y: number) => whitePlane.a + whitePlane.b * x + whitePlane.c * y
  // The contrast is that of the middle of the tag. Taking the least anywhere on it (the dim end of a gradient) was tried and refuses
  // tags that read: with 3 levels of noise it read 7 of 60 tags under an 8:1 gradient, where the middle's contrast reads 60 of 60 with
  // no wrong id in 360 tags up to 30:1. A cell that is too dim to be told from its neighbours shows as a bit error, and the Hamming
  // ceiling is what refuses those.
  const contrast = whiteAt(cells / 2, cells / 2) - blackAt(cells / 2, cells / 2)
  if (!(contrast >= o.minContrast)) {
    why.contrast++
    return null
  }
  const thresholdAt = (x: number, y: number) => 0.5 * (blackAt(x, y) + whiteAt(x, y))

  let borderErrors = 0
  for (let r = 0; r < cells; r++) {
    for (let cc = 0; cc < cells; cc++) {
      if ((r === 0 || cc === 0 || r === cells - 1 || cc === cells - 1) && cellMeans[r * cells + cc]! > thresholdAt(cc + 0.5, r + 0.5)) borderErrors++
    }
  }
  if (borderErrors > o.maxBorderErrors) {
    why.border++
    return null
  }
  let quietErrors = 0
  for (let i = 0; i < qi; i++) if (quietMeans[i]! < thresholdAt(s.refX[i]!, s.refY[i]!)) quietErrors++
  if (quietErrors > o.maxQuietErrors) {
    why.quiet++
    return null
  }

  let margin = Infinity
  for (let r = 0; r < bits; r++) {
    for (let cc = 0; cc < bits; cc++) {
      const v = cellMeans[(r + 1) * cells + cc + 1]!
      const x = cc + 1.5
      const y = r + 1.5
      const thr = thresholdAt(x, y)
      s.grid[r * bits + cc] = v < thr ? 1 : 0
      // How far from the threshold, in halves of the contrast that cell sees.
      const m = Math.abs(v - thr) / Math.max(1e-9, 0.5 * (whiteAt(x, y) - blackAt(x, y)))
      if (m < margin) margin = m
    }
  }
  const match = dict.match(s.grid.subarray(0, bits * bits), o.maxHamming)
  if (!match) {
    why.match++
    return null
  }
  return { id: match.id, rotation: match.rotation, hamming: match.hamming, contrast, bitMargin: clamp01(margin) }
}

/** A plane `a + b x + c y`. */
interface Plane {
  a: number
  b: number
  c: number
}

/**
 * A plane `a + b x + c y` through `n` levels at positions, by least squares. A border cell that is white, or a
 * quiet-zone sample that is dark, pulls its plane by its share of the points (a twenty-fourth for one border cell);
 * the checks that count such cells compare them with the plane, and a gap of a hundred levels or more survives
 * a pull of a few.
 */
function fitPlane(xs: Float64Array, ys: Float64Array, vs: Float64Array, n: number): Plane {
  let s0 = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  let sv = 0
  let sxv = 0
  let syv = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!
    const y = ys[i]!
    const v = vs[i]!
    s0++
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
    syy += y * y
    sv += v
    sxv += x * v
    syv += y * v
  }
  // Normal equations [s0 sx sy; sx sxx sxy; sy sxy syy] [a b c]' = [sv sxv syv]', by Cramer's rule.
  const det = s0 * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy)
  if (!(Math.abs(det) > 1e-9)) return { a: sv / Math.max(1, s0), b: 0, c: 0 }
  return {
    a: (sv * (sxx * syy - sxy * sxy) - sx * (sxv * syy - sxy * syv) + sy * (sxv * sxy - sxx * syv)) / det,
    b: (s0 * (sxv * syy - sxy * syv) - sv * (sx * syy - sxy * sy) + sy * (sx * syv - sxv * sy)) / det,
    c: (s0 * (sxx * syv - sxv * sxy) - sx * (sx * syv - sxv * sy) + sv * (sx * sxy - sxx * sy)) / det,
  }
}
