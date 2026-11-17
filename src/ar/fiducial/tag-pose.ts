/**
 * Pose of a printed square tag from its four detected corners: intrinsics, a planar pose solver
 * with its two-fold ambiguity handled, per-frame residuals, and fusion over frames.
 *
 * Pure maths, no dependency. Clean-room: the planar solver follows the published method of Collins &
 * Bartoli, "Infinitesimal Plane-Based Pose Estimation" (IJCV 2014), re-derived below from the
 * pinhole model rather than transcribed, and refined with Levenberg-Marquardt (Levenberg 1944,
 * Marquardt 1963). No code from any other project was read or copied.
 *
 * ## What the solver does
 *
 * A planar target seen through a pinhole has an exact homography H from plane to image. Choosing
 * the plane point that lies on the optical axis (after a virtual rotation that puts the tag centre
 * there) makes the 2x2 Jacobian J of H at that point equal to `R[0:2, 0:2] / depth`. The largest
 * singular value of J therefore fixes the depth, and orthonormality of R fixes the rest of the
 * rotation up to the sign of its third row's first two entries. Those two signs are the two
 * solutions: the tag tilted one way or the mirror way about the line of sight. Both are refined on
 * the corners' reprojection error.
 *
 * ## The two-solution ambiguity, and how it is resolved
 *
 * With noisy corners the mirror solution can fit almost as well as the true one, especially for a
 * small, nearly face-on tag. The solver keeps both (`TagPoseSolution.best` and `.alternate`) and
 * reports `ambiguityRatio = alternate RMS / best RMS` so a caller can see how decisive one frame is.
 * `fuseTagObservations` then resolves it with the evidence a single frame does not have: the tag
 * does not move in the session, so across frames the true solution lands at one place and the
 * mirror solution does not (it swings with the camera). Per frame it picks the candidate nearer
 * the consensus of the others, iterates, and reports `ambiguous` when camera motion did not separate
 * the two hypotheses and the reprojection error did not either. A rejected `'ambiguous'` result is
 * the honest answer for a tag filmed face-on from a standing start.
 *
 * ## Scale, honestly
 *
 * The camera-frame pose is metric because the corners' real separation, `tagSizeM`, is an input: a
 * 0.2 m tag 3 m away is 3 m away whatever unit the AR runtime counts in (8th Wall's default
 * "responsive" scale is not metres). That scale is only as good as the printed size (printers set to
 * "fit to page" shrink a tag by percents; the sheet carries a scale bar to measure) and the
 * intrinsics (a 1 % focal-length error is a 1 % range error). `estimateSessionScale` turns the tag
 * into a ruler for the session's own units, which needs the camera to have moved.
 *
 * ## Conventions
 *
 * See `./types.ts`. Camera frame here is OpenCV-style (+y down, +z forward); `cameraPose` inputs
 * are three.js poses and are converted in `poseToSession`, the one place that needs the flip.
 */
import type { Pose } from '../provider.ts'
import type { Quat, Vec3 } from '../../world/types.ts'
import type {
  CameraIntrinsics,
  CornerFit,
  FiducialDetection,
  FusedTagPose,
  FusionRejection,
  IntrinsicsProblem,
  Mat3,
  Quad,
  TagObservation,
  TagPoseCandidate,
  TagPoseSolution,
  ViewRect,
} from './types.ts'

// -------------------------------------------------------------------------------------------
// Adopted constants (ADR 0005 rule 5): every one is a starting point for DX8 to confirm or move.
// -------------------------------------------------------------------------------------------

/** fx and fy of a real camera agree to well under this; a larger gap means the image and the projection disagree about the frame. Adopted, not measured (ADR 0005 rule 5). */
export const MAX_ASPECT_MISMATCH = 0.02
/**
 * A frame whose corners scatter about their fitted edge lines by more than this, in pixels, is dropped. The
 * scatter of a good fit is sensor noise, about 0.1 px on a clean frame and 0.45 px at 12 levels of noise
 * (measured on synthetic frames, see `detector.ts`), so this is a bound on a fit that is not an edge at all, not a
 * tolerance on noise. Adopted, not measured (ADR 0005 rule 5).
 */
export const DEFAULT_MAX_EDGE_RMS_PX = 1
/** A frame in which fewer than this share of an edge's samples lay on its fitted line is dropped. The detector's own acceptance is the same number. Adopted, not measured. */
export const DEFAULT_MIN_EDGE_INLIER_FRACTION = 0.6
/** Frames nearer than this are dropped: the tag then fills the frame and its border is cut off. Adopted, not measured. */
export const DEFAULT_MIN_RANGE_M = 0.3
/**
 * Frames farther than this are dropped. A tag's pose error grows with the square of the range (its
 * pixel size falls linearly and depth sensitivity falls with it again). 4 m keeps a 0.2 m tag above
 * 25 px on a 640-wide frame. Adopted, not measured.
 */
export const DEFAULT_MAX_RANGE_M = 4
/** A solution whose own corners disagree with it by more than this is not a square seen through this lens. Adopted, not measured. */
export const DEFAULT_MAX_REPROJECTION_RMS_PX = 2
/** Beyond this the tag is seen nearly edge-on and its corners say little. Adopted, not measured. */
export const DEFAULT_MAX_VIEW_ANGLE_DEG = 70
/** Frames needed before a fused pose is offered. Adopted, not measured. */
export const DEFAULT_MIN_FRAMES = 5
/** Largest robust scatter of the tag centre across frames, metres. Adopted, not measured. */
export const DEFAULT_MAX_POSE_SPREAD_M = 0.03
/** Largest robust scatter of the tag orientation across frames, degrees. Adopted, not measured. */
export const DEFAULT_MAX_ROTATION_SPREAD_DEG = 3
/** Median `ambiguityRatio` at or above which a frame already tells the mirror solutions apart. Adopted, not measured. */
export const AMBIGUITY_DECISIVE_RATIO = 2
/** The mirror hypothesis counts as still standing when its spread is within this factor of the chosen one's, plus `MIRROR_SPREAD_SLACK_M`. Adopted, not measured. */
const MIRROR_SPREAD_FACTOR = 1.5
const MIRROR_SPREAD_SLACK_M = 0.002
/** The mirror question is asked only when at least this fraction of frames had a second solution. Adopted, not measured. */
const AMBIGUITY_MIN_ALT_FRACTION = 0.8
/** One frame's ambiguity ratio is capped here before the median is taken: a frame whose solutions merged is decisive, not infinite. Adopted, not measured. */
const AMBIGUITY_RATIO_CAP = 10
/** Passes of consensus selection between the two solutions of each frame. Adopted, not measured: it settles in two or three. */
const CONSENSUS_PASSES = 4
/** An outlier frame is never called one for being closer than this to the consensus, metres. Adopted, not measured. */
const OUTLIER_FLOOR_M = 0.01
/** A frame's rotation counts toward the averaged orientation when within this of the medoid, degrees. Adopted, not measured. */
const ROTATION_INLIER_DEG = 5
/** Levenberg-Marquardt settings: iterations, the starting damping, how it moves after a good and a bad step, its limits, and the step size at which the solve stops. Adopted, not measured; they are solver settings, not tolerances on the world. */
const LM_MAX_ITERATIONS = 40
const LM_INITIAL_DAMPING = 1e-3
const LM_DAMPING_DOWN = 3
const LM_DAMPING_UP = 4
const LM_DAMPING_MIN = 1e-12
const LM_DAMPING_MAX = 1e12
const LM_STEP_TOLERANCE = 1e-12
const LM_COST_TOLERANCE = 1e-18

// -------------------------------------------------------------------------------------------
// Small linear algebra. Row-major 3x3 as number[9]; vectors as plain objects where they cross the API.
// -------------------------------------------------------------------------------------------

type V3 = [number, number, number]

function mmul(a: Mat3, b: Mat3): number[] {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out
}

function mtranspose(m: Mat3): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]
}

function mapply(m: Mat3, v: V3): V3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ]
}

function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** exp([w]x): the rotation by |w| radians about w. */
function rodrigues(w: V3): number[] {
  const theta = Math.hypot(w[0], w[1], w[2])
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const x = w[0] / theta
  const y = w[1] / theta
  const z = w[2] / theta
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const t = 1 - c
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]
}

/** The angle of the rotation taking `a` to `b`, degrees. */
export function rotationAngleBetweenDeg(a: Mat3, b: Mat3): number {
  const rel = mmul(mtranspose(a), b)
  const c = (rel[0]! + rel[4]! + rel[8]! - 1) / 2
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI
}

export function quatToMatrix(q: Quat): number[] {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1
  const x = q.x / n
  const y = q.y / n
  const z = q.z / n
  const w = q.w / n
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]
}

export function matrixToQuat(m: Mat3): Quat {
  const tr = m[0]! + m[4]! + m[8]!
  let x: number
  let y: number
  let z: number
  let w: number
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s
    x = (m[7]! - m[5]!) / s
    y = (m[2]! - m[6]!) / s
    z = (m[3]! - m[1]!) / s
  } else if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2
    w = (m[7]! - m[5]!) / s
    x = 0.25 * s
    y = (m[1]! + m[3]!) / s
    z = (m[2]! + m[6]!) / s
  } else if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2
    w = (m[2]! - m[6]!) / s
    x = (m[1]! + m[3]!) / s
    y = 0.25 * s
    z = (m[5]! + m[7]!) / s
  } else {
    const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2
    w = (m[3]! - m[1]!) / s
    x = (m[2]! + m[6]!) / s
    y = (m[5]! + m[7]!) / s
    z = 0.25 * s
  }
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

/** Solve A x = b by Gaussian elimination with partial pivoting. `a` is row-major n x n and is consumed. Null if singular. */
function solveLinear(a: number[], b: number[], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let piv = col
    let best = Math.abs(a[col * n + col]!)
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col]!)
      if (v > best) {
        best = v
        piv = r
      }
    }
    if (best < 1e-300) return null
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c]!
        a[col * n + c] = a[piv * n + c]!
        a[piv * n + c] = t
      }
      const t = b[col]!
      b[col] = b[piv]!
      b[piv] = t
    }
    const d = a[col * n + col]!
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / d
      if (f === 0) continue
      for (let c = col; c < n; c++) a[r * n + c] = a[r * n + c]! - f * a[col * n + c]!
      b[r] = b[r]! - f * b[col]!
    }
  }
  const x = new Array<number>(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!
    for (let c = r + 1; c < n; c++) s -= a[r * n + c]! * x[c]!
    x[r] = s / a[r * n + r]!
  }
  return x
}

/** Inverse of a symmetric positive-definite n x n matrix, or null. */
function invert(a: number[], n: number): number[] | null {
  const out = new Array<number>(n * n)
  for (let c = 0; c < n; c++) {
    const e = new Array<number>(n).fill(0)
    e[c] = 1
    const col = solveLinear(a.slice(), e, n)
    if (!col) return null
    for (let r = 0; r < n; r++) out[r * n + c] = col[r]!
  }
  return out
}

// -------------------------------------------------------------------------------------------
// Intrinsics
// -------------------------------------------------------------------------------------------

/**
 * Intrinsics from a projection matrix: a flat 16-element column-major array, the layout of three.js
 * `Matrix4.elements`, of an XR `XRView.projectionMatrix`, and of the matrix 8th Wall publishes as
 * `reality.intrinsics` (`src/ar/eighthwall.ts` reads elements 0 and 5 of it).
 *
 * The matrix describes the clip square [-1, 1]^2; `view` says where that square lies on the image
 * (default: all of it). With the `contain` fit `EighthWallProvider` uses, the canvas has the camera
 * frame's aspect, so the clip square IS the frame and the default is right. For a render that crops
 * or has bars, pass `viewRectForFit(...)`.
 *
 * Throws on a matrix that is not a perspective projection (fewer than 16 numbers, or non-positive
 * focal terms): a caller must not get an answer from nonsense.
 */
export function intrinsicsFromProjection(projection: ArrayLike<number>, image: { width: number; height: number }, view?: ViewRect): CameraIntrinsics {
  if (projection.length < 16) throw new RangeError(`projection matrix has ${projection.length} elements, expected 16`)
  const p0 = projection[0]!
  const p5 = projection[5]!
  const p8 = projection[8]!
  const p9 = projection[9]!
  if (!(Number.isFinite(p0) && Number.isFinite(p5) && p0 > 0 && p5 > 0)) {
    throw new RangeError(`projection matrix is not a perspective projection (elements 0 and 5 are ${p0} and ${p5})`)
  }
  const v = view ?? { x: 0, y: 0, width: image.width, height: image.height }
  return {
    fx: (p0 * v.width) / 2,
    fy: (p5 * v.height) / 2,
    cx: v.x + ((1 - (Number.isFinite(p8) ? p8 : 0)) * v.width) / 2,
    cy: v.y + ((1 + (Number.isFinite(p9) ? p9 : 0)) * v.height) / 2,
    width: image.width,
    height: image.height,
  }
}

/**
 * The intrinsics a vertical field of view implies, for a camera with square pixels and its principal
 * point at the image centre. `ARProvider.getCameraFovY()` already exposes exactly that number, so a
 * caller that has only it (and the frame size) can still solve a pose without a new provider member.
 * It is right under the `contain` fit `EighthWallProvider` uses, where the canvas has the camera's own
 * aspect; with a crop or bars use {@link intrinsicsFromProjection} and a {@link viewRectForFit} rectangle,
 * which also carry any principal-point offset. Throws for a field of view that is not between 1 and 179 degrees.
 */
export function intrinsicsFromFovY(fovYDeg: number, image: { width: number; height: number }): CameraIntrinsics {
  if (!(fovYDeg > 1 && fovYDeg < 179)) throw new RangeError(`vertical field of view ${fovYDeg} is not between 1 and 179 degrees`)
  const f = image.height / 2 / Math.tan((fovYDeg * Math.PI) / 360)
  return { fx: f, fy: f, cx: image.width / 2, cy: image.height / 2, width: image.width, height: image.height }
}

/** Intrinsics from an XR view (anything with a `projectionMatrix`): see {@link intrinsicsFromProjection}. */
export function intrinsicsFromXRView(view: { projectionMatrix: ArrayLike<number> }, image: { width: number; height: number }, rect?: ViewRect): CameraIntrinsics {
  return intrinsicsFromProjection(view.projectionMatrix, image, rect)
}

/**
 * Where a display of `display` pixels lies on an `image` of `image` pixels when the image is fitted
 * into it: `'contain'` scales the whole image to fit (bars on one axis), `'cover'` scales it to
 * fill (crops one axis). The result is in IMAGE pixels, ready for {@link intrinsicsFromProjection}.
 */
export function viewRectForFit(display: { width: number; height: number }, image: { width: number; height: number }, fit: 'contain' | 'cover'): ViewRect {
  const sx = display.width / image.width
  const sy = display.height / image.height
  const s = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy)
  const w = display.width / s
  const h = display.height / s
  return { x: (image.width - w) / 2, y: (image.height - h) / 2, width: w, height: h }
}

/**
 * Whether a set of intrinsics can be trusted for a pose, and if not why. Square pixels mean fx and fy
 * agree; when they do not, the projection and the pixel array disagree about the frame (rotated, or
 * cropped differently), and a pose from them would be wrong without looking wrong.
 */
export function intrinsicsProblem(k: CameraIntrinsics): IntrinsicsProblem | null {
  if (![k.fx, k.fy, k.cx, k.cy, k.width, k.height].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0 || k.width <= 0 || k.height <= 0) return 'not-finite'
  if (Math.abs(k.fx / k.fy - 1) > MAX_ASPECT_MISMATCH) return 'aspect-mismatch'
  if (k.cx < 0 || k.cx > k.width || k.cy < 0 || k.cy > k.height) return 'principal-point'
  return null
}

// -------------------------------------------------------------------------------------------
// Planar pose from four corners
// -------------------------------------------------------------------------------------------

/** The tag's corners in its own frame: printed top-left, top-right, bottom-right, bottom-left. */
export function tagObjectPoints(sizeM: number): [V3, V3, V3, V3] {
  const h = sizeM / 2
  return [[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]]
}

function project(k: CameraIntrinsics, p: V3): [number, number] {
  return [(k.fx * p[0]) / p[2] + k.cx, (k.fy * p[1]) / p[2] + k.cy]
}

function reprojectionErrors(rot: Mat3, t: V3, obj: readonly V3[], quad: Quad, k: CameraIntrinsics): { rms: number; sumSq: number } {
  let sumSq = 0
  for (let i = 0; i < 4; i++) {
    const r = mapply(rot, obj[i]!)
    const [u, v] = project(k, [r[0] + t[0], r[1] + t[1], r[2] + t[2]])
    sumSq += (u - quad[i]!.x) ** 2 + (v - quad[i]!.y) ** 2
  }
  return { rms: Math.sqrt(sumSq / 4), sumSq }
}

/**
 * Homography from the plane's metric coordinates to NORMALISED image coordinates (pixels with the
 * intrinsics removed), solved exactly from the four correspondences. Null for a degenerate quad.
 */
function planeHomography(obj: readonly V3[], q: readonly [number, number][]): number[] | null {
  // Work in plane units of the tag's half-size so the system is well scaled, then undo it.
  const half = Math.abs(obj[0]![0])
  const a = new Array<number>(64).fill(0)
  const b = new Array<number>(8)
  for (let i = 0; i < 4; i++) {
    const X = obj[i]![0] / half
    const Y = obj[i]![1] / half
    const [x, y] = q[i]!
    const r1 = 2 * i * 8
    const r2 = (2 * i + 1) * 8
    a[r1] = X
    a[r1 + 1] = Y
    a[r1 + 2] = 1
    a[r1 + 6] = -x * X
    a[r1 + 7] = -x * Y
    b[2 * i] = x
    a[r2 + 3] = X
    a[r2 + 4] = Y
    a[r2 + 5] = 1
    a[r2 + 6] = -y * X
    a[r2 + 7] = -y * Y
    b[2 * i + 1] = y
  }
  const h = solveLinear(a, b, 8)
  if (!h || !h.every(Number.isFinite)) return null
  // Metric plane coordinates are half times the normalised ones: columns 0 and 1 scale by 1 / half.
  return [h[0]! / half, h[1]! / half, h[2]!, h[3]! / half, h[4]! / half, h[5]!, h[6]! / half, h[7]! / half, 1]
}

/** Rotation taking +z to the direction `v` (unit), by the shortest arc. */
function rotationFromZ(v: V3): number[] {
  const axis: V3 = [-v[1], v[0], 0]
  const s = Math.hypot(axis[0], axis[1])
  if (s < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const angle = Math.atan2(s, v[2])
  return rodrigues([(axis[0] / s) * angle, (axis[1] / s) * angle, 0])
}

interface RawPose {
  rotation: number[]
  translation: V3
}

/**
 * Both analytic solutions of the planar problem, before refinement. Returns [] when the corners do
 * not describe a square seen from in front.
 */
function ippeSolutions(quad: Quad, k: CameraIntrinsics, obj: readonly V3[]): RawPose[] {
  const q: [number, number][] = quad.map((c) => [(c.x - k.cx) / k.fx, (c.y - k.cy) / k.fy] as [number, number])
  const H = planeHomography(obj, q)
  if (!H) return []

  // Virtual rotation putting the tag centre on the optical axis: the centre maps to (h13, h23).
  const norm = Math.hypot(H[2]!, H[5]!, 1)
  const rv = rotationFromZ([H[2]! / norm, H[5]! / norm, 1 / norm])
  // H' = Rv^T H sends the centre to (0, 0, s), exactly.
  const Hp = mmul(mtranspose(rv), H)
  const s = Hp[8]!
  if (!(Math.abs(s) > 1e-12) || !(s > 0)) return []
  const J = [Hp[0]! / s, Hp[1]! / s, Hp[3]! / s, Hp[4]! / s]

  // 2x2 SVD of J, closed form: J = U diag(s1, s2) V^T, s1 >= s2 >= 0.
  const e = (J[0]! + J[3]!) / 2
  const f = (J[0]! - J[3]!) / 2
  const g = (J[2]! + J[1]!) / 2
  const hh = (J[2]! - J[1]!) / 2
  const qq = Math.hypot(e, hh)
  const rr = Math.hypot(f, g)
  const s1 = qq + rr
  const s2 = Math.abs(qq - rr)
  if (!(s1 > 1e-12)) return []
  const a1 = Math.atan2(g, f)
  const a2 = Math.atan2(hh, e)
  const theta = (a2 - a1) / 2
  // Right singular vector of the smaller singular value.
  const v2: [number, number] = qq >= rr ? [Math.sin(theta), Math.cos(theta)] : [-Math.sin(theta), -Math.cos(theta)]

  const depth = 1 / s1
  const wMag = Math.sqrt(Math.max(0, 1 - (s2 / s1) ** 2))
  const out: RawPose[] = []
  for (const sign of [1, -1]) {
    const w0 = sign * wMag * v2[0]
    const w1 = sign * wMag * v2[1]
    const r1: V3 = [J[0]! / s1, J[2]! / s1, w0]
    const r2: V3 = [J[1]! / s1, J[3]! / s1, w1]
    const r3 = cross3(r1, r2)
    const rp = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]
    const rot = mmul(rv, rp)
    const t = mapply(rv, [0, 0, depth])
    out.push({ rotation: rot, translation: t })
  }
  return out
}

interface Refined extends RawPose {
  rms: number
  /** 6x6 (JtJ) at the solution, for the conditioning figures. */
  normal: number[]
}

/**
 * Levenberg-Marquardt on the four corners' reprojection error. The unknowns are a rotation vector
 * applied on the left (R <- exp([dw]x) R) and a translation. Eight residuals, six unknowns.
 */
function refine(start: RawPose, obj: readonly V3[], quad: Quad, k: CameraIntrinsics): Refined | null {
  let R = start.rotation
  let t: V3 = [...start.translation]
  let cost = reprojectionErrors(R, t, obj, quad, k).sumSq
  let lambda = LM_INITIAL_DAMPING

  const jacobian = (rot: Mat3, tt: V3): { jtj: number[]; jtr: number[] } => {
    const jtj = new Array<number>(36).fill(0)
    const jtr = new Array<number>(6).fill(0)
    for (let i = 0; i < 4; i++) {
      const a = mapply(rot, obj[i]!)
      const X = a[0] + tt[0]
      const Y = a[1] + tt[1]
      const Z = a[2] + tt[2]
      const iz = 1 / Z
      const u = k.fx * X * iz + k.cx
      const v = k.fy * Y * iz + k.cy
      // d(P)/d(dw) = -[a]x, rows of it:
      const dPdw = [[0, a[2], -a[1]], [-a[2], 0, a[0]], [a[1], -a[0], 0]]
      const ju = new Array<number>(6)
      const jv = new Array<number>(6)
      for (let c = 0; c < 3; c++) {
        ju[c] = k.fx * iz * dPdw[0]![c]! - k.fx * X * iz * iz * dPdw[2]![c]!
        jv[c] = k.fy * iz * dPdw[1]![c]! - k.fy * Y * iz * iz * dPdw[2]![c]!
      }
      ju[3] = k.fx * iz
      ju[4] = 0
      ju[5] = -k.fx * X * iz * iz
      jv[3] = 0
      jv[4] = k.fy * iz
      jv[5] = -k.fy * Y * iz * iz
      const ru = u - quad[i]!.x
      const rv = v - quad[i]!.y
      for (let r = 0; r < 6; r++) {
        jtr[r] = jtr[r]! + ju[r]! * ru + jv[r]! * rv
        for (let c = 0; c < 6; c++) jtj[r * 6 + c] = jtj[r * 6 + c]! + ju[r]! * ju[c]! + jv[r]! * jv[c]!
      }
    }
    return { jtj, jtr }
  }

  for (let iter = 0; iter < LM_MAX_ITERATIONS; iter++) {
    const { jtj, jtr } = jacobian(R, t)
    const damped = jtj.slice()
    for (let d = 0; d < 6; d++) damped[d * 7] = damped[d * 7]! + lambda * Math.max(jtj[d * 7]!, 1e-9)
    const step = solveLinear(damped, jtr.map((v) => -v), 6)
    if (!step || !step.every(Number.isFinite)) return null
    const nR = mmul(rodrigues([step[0]!, step[1]!, step[2]!]), R)
    const nt: V3 = [t[0] + step[3]!, t[1] + step[4]!, t[2] + step[5]!]
    // A step that puts the tag behind the camera is never an improvement worth taking.
    const nCost = nt[2] > 0 ? reprojectionErrors(nR, nt, obj, quad, k).sumSq : Infinity
    if (nCost < cost) {
      const change = cost - nCost
      R = nR
      t = nt
      cost = nCost
      lambda = Math.max(lambda / LM_DAMPING_DOWN, LM_DAMPING_MIN)
      if (change < LM_COST_TOLERANCE || Math.hypot(step[0]!, step[1]!, step[2]!, step[3]!, step[4]!, step[5]!) < LM_STEP_TOLERANCE) break
    } else {
      lambda *= LM_DAMPING_UP
      if (lambda > LM_DAMPING_MAX) break
    }
  }
  if (!(t[2] > 0)) return null
  const final = reprojectionErrors(R, t, obj, quad, k)
  return { rotation: R, translation: t, rms: final.rms, normal: jacobian(R, t).jtj }
}

function candidateFrom(r: Refined): TagPoseCandidate {
  const t: Vec3 = { x: r.translation[0], y: r.translation[1], z: r.translation[2] }
  const range = Math.hypot(t.x, t.y, t.z)
  // Tag normal (its +z) in the camera frame, and the direction from the tag to the camera.
  const n: V3 = [r.rotation[2]!, r.rotation[5]!, r.rotation[8]!]
  const cosView = -(n[0] * t.x + n[1] * t.y + n[2] * t.z) / range
  return {
    rotation: r.rotation,
    translation: t,
    reprojectionRmsPx: r.rms,
    rangeM: range,
    viewAngleDeg: (Math.acos(Math.max(-1, Math.min(1, cosView))) * 180) / Math.PI,
  }
}

/**
 * What one pixel of independent corner noise does to the pose, from the normal matrix at the
 * solution. Position in metres (total), rotation about the tag's in-plane axes and about its normal
 * in degrees.
 */
function conditioning(r: Refined): TagPoseSolution['conditioning'] {
  const inv = invert(r.normal, 6)
  if (!inv) return { positionM: Infinity, tiltDeg: Infinity, spinDeg: Infinity }
  // Covariance of the rotation vector is the top-left block, in CAMERA axes; express it in the tag's.
  const Rt = mtranspose(r.rotation)
  const cw = [inv[0]!, inv[1]!, inv[2]!, inv[6]!, inv[7]!, inv[8]!, inv[12]!, inv[13]!, inv[14]!]
  const tag = mmul(Rt, mmul(cw, r.rotation))
  const deg = 180 / Math.PI
  return {
    positionM: Math.sqrt(Math.max(0, inv[21]! + inv[28]! + inv[35]!)),
    tiltDeg: Math.sqrt(Math.max(0, tag[0]! + tag[4]!)) * deg,
    spinDeg: Math.sqrt(Math.max(0, tag[8]!)) * deg,
  }
}

/** How close two refined solutions must be to count as one (they merged into the same minimum). Numerical tolerances, adopted, not measured (ADR 0005 rule 5). */
const SAME_SOLUTION_ROTATION_DEG = 0.05
const SAME_SOLUTION_TRANSLATION_M = 1e-4

/**
 * The pose of a tag of edge `tagSizeM` from its four detected corners (printed top-left, top-right,
 * bottom-right, bottom-left), in the CAMERA frame. Null when the corners are not a square seen from
 * in front of the camera, or the intrinsics cannot be used.
 */
export function solveTagPose(corners: Quad, intrinsics: CameraIntrinsics, tagSizeM: number): TagPoseSolution | null {
  if (!(tagSizeM > 0) || intrinsicsProblem(intrinsics) !== null) return null
  if (corners.some((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y))) return null
  const obj = tagObjectPoints(tagSizeM)
  const starts = ippeSolutions(corners, intrinsics, obj)
  if (starts.length === 0) return null

  const refined: Refined[] = []
  for (const start of starts) {
    const r = refine(start, obj, corners, intrinsics)
    if (r) refined.push(r)
  }
  if (refined.length === 0) return null
  refined.sort((a, b) => a.rms - b.rms)
  const best = refined[0]!
  let alt: Refined | null = refined[1] ?? null
  if (alt) {
    const dRot = rotationAngleBetweenDeg(best.rotation, alt.rotation)
    const dT = Math.hypot(best.translation[0] - alt.translation[0], best.translation[1] - alt.translation[1], best.translation[2] - alt.translation[2])
    if (dRot < SAME_SOLUTION_ROTATION_DEG && dT < SAME_SOLUTION_TRANSLATION_M) alt = null
  }
  const bestCandidate = candidateFrom(best)
  const alternate = alt ? candidateFrom(alt) : null
  return {
    best: bestCandidate,
    alternate,
    ambiguityRatio: alternate ? alternate.reprojectionRmsPx / Math.max(bestCandidate.reprojectionRmsPx, 1e-9) : Infinity,
    conditioning: conditioning(best),
  }
}

/** Reproject the tag's corners through a camera-frame pose: the same four points a detector reports. */
export function projectTagCorners(pose: Pick<TagPoseCandidate, 'rotation' | 'translation'>, intrinsics: CameraIntrinsics, tagSizeM: number): Array<{ x: number; y: number }> {
  const t: V3 = [pose.translation.x, pose.translation.y, pose.translation.z]
  return tagObjectPoints(tagSizeM).map((p) => {
    const r = mapply(pose.rotation, p)
    const [u, v] = project(intrinsics, [r[0] + t[0], r[1] + t[1], r[2] + t[2]])
    return { x: u, y: v }
  })
}

// -------------------------------------------------------------------------------------------
// Camera frame to session frame
// -------------------------------------------------------------------------------------------

/** A tag pose in the session frame, as matrices (the fusion works on these). */
interface SessionPose {
  rotation: number[]
  position: V3
}

/** Camera-frame axes (OpenCV) to three.js camera axes: a half turn about x. */
const CV_TO_THREE = [1, 0, 0, 0, -1, 0, 0, 0, -1]

/**
 * A tag's camera-frame pose carried into session coordinates by the camera's own pose. This is the
 * one place the OpenCV and three.js camera conventions meet: a three.js camera looks down -z with +y
 * up, so camera-frame vectors are flipped about x before the camera's rotation is applied.
 */
export function poseToSession(candidate: Pick<TagPoseCandidate, 'rotation' | 'translation'>, cameraPose: Pose): Pose {
  const s = toSession(candidate, cameraPose)
  return { position: { x: s.position[0], y: s.position[1], z: s.position[2] }, rotation: matrixToQuat(s.rotation) }
}

function toSession(candidate: Pick<TagPoseCandidate, 'rotation' | 'translation'>, cameraPose: Pose): SessionPose {
  const rc = mmul(quatToMatrix(cameraPose.rotation), CV_TO_THREE)
  const t: V3 = [candidate.translation.x, candidate.translation.y, candidate.translation.z]
  const p = mapply(rc, t)
  return {
    rotation: mmul(rc, candidate.rotation),
    position: [p[0] + cameraPose.position.x, p[1] + cameraPose.position.y, p[2] + cameraPose.position.z],
  }
}

/** The tag's four corners in session coordinates (printed top-left, top-right, bottom-right, bottom-left), in session units. */
export function tagCornersInSession(pose: Pose, tagSizeInSessionUnits: number): Vec3[] {
  const rot = quatToMatrix(pose.rotation)
  return tagObjectPoints(tagSizeInSessionUnits).map((p) => {
    const r = mapply(rot, p)
    return { x: r[0] + pose.position.x, y: r[1] + pose.position.y, z: r[2] + pose.position.z }
  })
}

/**
 * The column-major 4x4 that carries session coordinates into the tag's own frame (origin at the
 * tag centre, +x right, +y up, +z out of the paper), with lengths converted to METRES:
 * `sessionUnitsPerMetre` is how many session units make a metre. It is the inverse of the fused pose
 * with that scale applied, in the layout of `transformPoint` in `src/world/geo.ts`.
 */
export function sessionToTagMatrix(pose: Pose, sessionUnitsPerMetre = 1): number[] {
  const r = quatToMatrix(pose.rotation)
  const rt = mtranspose(r)
  const k = 1 / sessionUnitsPerMetre
  const p = mapply(rt, [pose.position.x, pose.position.y, pose.position.z])
  // Rotation block scaled to metres; translation = -(R^T p) in metres.
  return [
    rt[0]! * k, rt[3]! * k, rt[6]! * k, 0,
    rt[1]! * k, rt[4]! * k, rt[7]! * k, 0,
    rt[2]! * k, rt[5]! * k, rt[8]! * k, 0,
    -p[0] * k, -p[1] * k, -p[2] * k, 1,
  ]
}

// -------------------------------------------------------------------------------------------
// Fusion over frames
// -------------------------------------------------------------------------------------------

/**
 * An observation from a detection: its corners, and the fit fields that say whether they are
 * pose-grade, with the intrinsics and the camera pose that go with the frame.
 */
export function observationFromDetection(detection: Pick<FiducialDetection, 'corners' | 'refined' | 'edgeRmsPx' | 'edgeInlierFraction'>, intrinsics: CameraIntrinsics, cameraPose: Pose, timestampMs?: number): TagObservation {
  const cornerFit: CornerFit = { refined: detection.refined, edgeRmsPx: detection.edgeRmsPx, edgeInlierFraction: detection.edgeInlierFraction }
  return timestampMs === undefined ? { corners: detection.corners, intrinsics, cameraPose, cornerFit } : { corners: detection.corners, intrinsics, cameraPose, timestampMs, cornerFit }
}

/** Whether an observation's corners were fitted well enough to be used for a pose. Observations that carry no fit (corners from elsewhere) pass. */
function cornersUsable(o: TagObservation, maxEdgeRmsPx: number, minInlierFraction: number): boolean {
  const q = o.cornerFit
  if (!q) return true
  return q.refined && q.edgeRmsPx !== null && q.edgeRmsPx <= maxEdgeRmsPx && q.edgeInlierFraction !== null && q.edgeInlierFraction >= minInlierFraction
}

export interface FusionOptions {
  /** Printed edge length of the black square, metres. */
  tagSizeM: number
  /** Session units per metre. 1 when the runtime is metric (WebXR); estimate it with {@link estimateSessionScale} otherwise. Default 1. */
  sessionUnitsPerMetre?: number
  minRangeM?: number
  maxRangeM?: number
  maxReprojectionRmsPx?: number
  maxViewAngleDeg?: number
  /** See {@link DEFAULT_MAX_EDGE_RMS_PX}. */
  maxEdgeRmsPx?: number
  /** See {@link DEFAULT_MIN_EDGE_INLIER_FRACTION}. */
  minEdgeInlierFraction?: number
  minFrames?: number
  maxPoseSpreadM?: number
  maxRotationSpreadDeg?: number
}

interface FrameCandidate {
  pose: SessionPose
  rms: number
  isBest: boolean
}

interface FrameRecord {
  candidates: FrameCandidate[]
  ratio: number
  rangeM: number
  rms: number
  chosen: number
}

function median(values: readonly number[]): number {
  const a = Array.from(values).sort((x, y) => x - y)
  const n = a.length
  return n === 0 ? 0 : n % 2 ? a[(n - 1) / 2]! : 0.5 * (a[n / 2 - 1]! + a[n / 2]!)
}

/**
 * For an isotropic Gaussian scatter in three dimensions the distance from the centre has a Maxwell
 * distribution, whose RMS is sqrt(3) a and whose median is 1.53817 a. So `1.1260 x median` of the
 * distances IS the RMS distance for Gaussian scatter, and unlike the RMS it is not dragged by a
 * frame that went wrong. Used for both the position and the rotation spread.
 */
const MAXWELL_RMS_PER_MEDIAN = Math.sqrt(3) / 1.53817

/** The RMS distance, estimated robustly: see {@link MAXWELL_RMS_PER_MEDIAN}. */
function robustRms(distances: readonly number[]): number {
  return MAXWELL_RMS_PER_MEDIAN * median(distances)
}

/** A frame is an outlier when it is this many median distances from the consensus (about 6 sigma for Gaussian scatter). Adopted, not measured. */
const OUTLIER_MEDIANS = 4

/** RMS distance between the four corners of two poses, in session units: one number that mixes position and tilt at the tag's own extent. */
function cornerDistance(a: SessionPose, b: SessionPose, halfSize: number): number {
  const pts: V3[] = [[-halfSize, halfSize, 0], [halfSize, halfSize, 0], [halfSize, -halfSize, 0], [-halfSize, -halfSize, 0]]
  let sum = 0
  for (const p of pts) {
    const pa = mapply(a.rotation, p)
    const pb = mapply(b.rotation, p)
    sum += (pa[0] + a.position[0] - pb[0] - b.position[0]) ** 2 + (pa[1] + a.position[1] - pb[1] - b.position[1]) ** 2 + (pa[2] + a.position[2] - pb[2] - b.position[2]) ** 2
  }
  return Math.sqrt(sum / 4)
}

/** The sample that minimises the summed angle to all the others, then the average of those within 5 degrees of it. */
function fuseRotations(rotations: readonly number[][]): number[] {
  let bestIdx = 0
  let bestSum = Infinity
  for (let i = 0; i < rotations.length; i++) {
    let sum = 0
    for (let j = 0; j < rotations.length; j++) sum += rotationAngleBetweenDeg(rotations[i]!, rotations[j]!)
    if (sum < bestSum) {
      bestSum = sum
      bestIdx = i
    }
  }
  const medoid = rotations[bestIdx]!
  const qm = matrixToQuat(medoid)
  let ax = 0
  let ay = 0
  let az = 0
  let aw = 0
  for (const r of rotations) {
    if (rotationAngleBetweenDeg(medoid, r) > ROTATION_INLIER_DEG) continue
    const q = matrixToQuat(r)
    const sign = q.x * qm.x + q.y * qm.y + q.z * qm.z + q.w * qm.w < 0 ? -1 : 1
    ax += sign * q.x
    ay += sign * q.y
    az += sign * q.z
    aw += sign * q.w
  }
  return quatToMatrix({ x: ax, y: ay, z: az, w: aw })
}

function medianPosition(poses: readonly SessionPose[]): V3 {
  return [median(poses.map((p) => p.position[0])), median(poses.map((p) => p.position[1])), median(poses.map((p) => p.position[2]))]
}

const NO_DROPS: FusedTagPose['dropped'] = { intrinsics: 0, cornerFit: 0, range: 0, viewAngle: 0, reprojection: 0, unsolved: 0 }

function rejected(reason: FusionRejection, offered: number, partial: Partial<FusedTagPose> = {}): FusedTagPose {
  return {
    status: 'rejected',
    reason,
    pose: null,
    poseSpreadM: NaN,
    rotationSpreadDeg: NaN,
    reprojectionRmsPx: NaN,
    rangeM: NaN,
    nFrames: 0,
    nFramesOffered: offered,
    dropped: { ...NO_DROPS },
    sessionUnitsPerMetre: 1,
    ambiguous: false,
    ...partial,
  }
}

/**
 * Fuse a tag's detections over several frames into one pose in session coordinates, with the
 * measured scatter and residuals that say how far to trust it.
 *
 * Steps: solve each frame; drop frames whose corners were not fitted well (`TagObservation.cornerFit`) and
 * frames outside the range, reprojection and view-angle gates; carry
 * both candidates of each frame into session coordinates through its camera pose; pick, per frame,
 * the candidate nearer the consensus (starting from the lower-residual one) so the mirror solution
 * cannot win a frame the others disagree with; drop outlier frames; fuse by median position and
 * medoid-then-average rotation; report robust spread, median residual and range.
 *
 * The result is `'ok'` only when every gate holds. A `'rejected'` result still carries the numbers
 * that could be computed, and `reason` names the gate that failed.
 */
export function fuseTagObservations(observations: readonly TagObservation[], options: FusionOptions): FusedTagPose {
  const offered = observations.length
  const unitsPerMetre = options.sessionUnitsPerMetre ?? 1
  if (offered === 0) return rejected('no-observations', 0, { sessionUnitsPerMetre: unitsPerMetre })
  const minRange = options.minRangeM ?? DEFAULT_MIN_RANGE_M
  const maxRange = options.maxRangeM ?? DEFAULT_MAX_RANGE_M
  const maxRms = options.maxReprojectionRmsPx ?? DEFAULT_MAX_REPROJECTION_RMS_PX
  const maxView = options.maxViewAngleDeg ?? DEFAULT_MAX_VIEW_ANGLE_DEG
  const maxEdgeRms = options.maxEdgeRmsPx ?? DEFAULT_MAX_EDGE_RMS_PX
  const minInlier = options.minEdgeInlierFraction ?? DEFAULT_MIN_EDGE_INLIER_FRACTION
  const minFrames = options.minFrames ?? DEFAULT_MIN_FRAMES
  const maxSpreadM = options.maxPoseSpreadM ?? DEFAULT_MAX_POSE_SPREAD_M
  const maxRotSpread = options.maxRotationSpreadDeg ?? DEFAULT_MAX_ROTATION_SPREAD_DEG
  const halfSession = (options.tagSizeM * unitsPerMetre) / 2

  const dropped = { intrinsics: 0, cornerFit: 0, range: 0, viewAngle: 0, reprojection: 0, unsolved: 0 }
  const frames: FrameRecord[] = []
  for (const o of observations) {
    if (intrinsicsProblem(o.intrinsics) !== null) {
      dropped.intrinsics++
      continue
    }
    if (!cornersUsable(o, maxEdgeRms, minInlier)) {
      dropped.cornerFit++
      continue
    }
    const sol = solveTagPose(o.corners, o.intrinsics, options.tagSizeM)
    if (!sol) {
      dropped.unsolved++
      continue
    }
    const b = sol.best
    if (b.rangeM < minRange || b.rangeM > maxRange) {
      dropped.range++
      continue
    }
    if (b.viewAngleDeg > maxView) {
      dropped.viewAngle++
      continue
    }
    if (b.reprojectionRmsPx > maxRms) {
      dropped.reprojection++
      continue
    }
    const candidates: FrameCandidate[] = [{ pose: toSession(b, o.cameraPose), rms: b.reprojectionRmsPx, isBest: true }]
    if (sol.alternate) candidates.push({ pose: toSession(sol.alternate, o.cameraPose), rms: sol.alternate.reprojectionRmsPx, isBest: false })
    // Session units: the camera pose is in them, the tag's metric translation is scaled into them.
    for (const c of candidates) {
      const cam = o.cameraPose.position
      c.pose.position = [
        cam.x + (c.pose.position[0] - cam.x) * unitsPerMetre,
        cam.y + (c.pose.position[1] - cam.y) * unitsPerMetre,
        cam.z + (c.pose.position[2] - cam.z) * unitsPerMetre,
      ]
    }
    frames.push({ candidates, ratio: sol.ambiguityRatio, rangeM: b.rangeM, rms: b.reprojectionRmsPx, chosen: 0 })
  }

  if (frames.length === 0) {
    const counts: Array<[FusionRejection, number]> = [
      ['intrinsics', dropped.intrinsics],
      ['corner-fit', dropped.cornerFit],
      ['range', dropped.range],
      ['view-angle', dropped.viewAngle],
      ['reprojection', dropped.reprojection],
      ['reprojection', dropped.unsolved],
    ]
    counts.sort((a, b) => b[1] - a[1])
    return rejected(counts[0]![1] > 0 ? counts[0]![0] : 'reprojection', offered, { sessionUnitsPerMetre: unitsPerMetre, dropped })
  }

  // Consensus selection: start from the lower-residual candidate of every frame, then let each
  // frame take whichever of its candidates sits nearer what the other frames agree on.
  const consensusOf = (): SessionPose => ({
    position: medianPosition(frames.map((f) => f.candidates[f.chosen]!.pose)),
    rotation: fuseRotations(frames.map((f) => f.candidates[f.chosen]!.pose.rotation)),
  })
  let consensus = consensusOf()
  for (let pass = 0; pass < CONSENSUS_PASSES; pass++) {
    let changed = false
    for (const f of frames) {
      if (f.candidates.length < 2) continue
      let pick = 0
      let bestD = Infinity
      for (let c = 0; c < f.candidates.length; c++) {
        const d = cornerDistance(f.candidates[c]!.pose, consensus, halfSession)
        if (d < bestD) {
          bestD = d
          pick = c
        }
      }
      if (pick !== f.chosen) {
        f.chosen = pick
        changed = true
      }
    }
    consensus = consensusOf()
    if (!changed) break
  }

  // Outlier frames: far from the consensus compared with how far frames usually are.
  const dist = frames.map((f) => cornerDistance(f.candidates[f.chosen]!.pose, consensus, halfSession))
  const cut = Math.max(OUTLIER_MEDIANS * median(dist), OUTLIER_FLOOR_M * unitsPerMetre)
  const kept = frames.filter((_, i) => dist[i]! <= cut)
  if (kept.length < 1) return rejected('too-few-frames', offered, { sessionUnitsPerMetre: unitsPerMetre, dropped })

  const chosenPoses = kept.map((f) => f.candidates[f.chosen]!.pose)
  const fused: SessionPose = { position: medianPosition(chosenPoses), rotation: fuseRotations(chosenPoses.map((p) => p.rotation)) }
  const poseSpreadM = robustRms(chosenPoses.map((p) => Math.hypot(p.position[0] - fused.position[0], p.position[1] - fused.position[1], p.position[2] - fused.position[2]))) / unitsPerMetre
  const rotationSpreadDeg = robustRms(chosenPoses.map((p) => rotationAngleBetweenDeg(fused.rotation, p.rotation)))
  // A frame whose two solutions merged into one has no mirror to confuse it; cap its ratio so it counts as decisive, not as infinite.
  const medianRatio = median(kept.map((f) => Math.min(f.ratio, AMBIGUITY_RATIO_CAP)))

  // Is the mirror hypothesis still standing? Build it from the candidates each frame did not choose.
  let ambiguous = false
  const withAlt = kept.filter((f) => f.candidates.length > 1)
  if (withAlt.length >= AMBIGUITY_MIN_ALT_FRACTION * kept.length && medianRatio < AMBIGUITY_DECISIVE_RATIO) {
    const mirror = kept.map((f) => (f.candidates.length > 1 ? f.candidates[1 - f.chosen]!.pose : f.candidates[0]!.pose))
    const mirrorCentre: SessionPose = { position: medianPosition(mirror), rotation: fuseRotations(mirror.map((p) => p.rotation)) }
    const mirrorSpread = robustRms(mirror.map((p) => cornerDistance(p, mirrorCentre, halfSession)))
    const chosenSpread = robustRms(chosenPoses.map((p) => cornerDistance(p, fused, halfSession)))
    ambiguous = mirrorSpread <= MIRROR_SPREAD_FACTOR * chosenSpread + MIRROR_SPREAD_SLACK_M * unitsPerMetre
  }

  const pose: Pose = { position: { x: fused.position[0], y: fused.position[1], z: fused.position[2] }, rotation: matrixToQuat(fused.rotation) }
  const result: FusedTagPose = {
    status: 'ok',
    reason: null,
    pose,
    poseSpreadM,
    rotationSpreadDeg,
    reprojectionRmsPx: median(kept.map((f) => f.rms)),
    rangeM: median(kept.map((f) => f.rangeM)),
    nFrames: kept.length,
    nFramesOffered: offered,
    dropped,
    sessionUnitsPerMetre: unitsPerMetre,
    ambiguous,
  }
  if (kept.length < minFrames) return { ...result, status: 'rejected', reason: 'too-few-frames' }
  if (ambiguous) return { ...result, status: 'rejected', reason: 'ambiguous' }
  if (poseSpreadM > maxSpreadM || rotationSpreadDeg > maxRotSpread) return { ...result, status: 'rejected', reason: 'spread' }
  return result
}

// -------------------------------------------------------------------------------------------
// The tag as a ruler for the session's own units
// -------------------------------------------------------------------------------------------

export interface SessionScaleEstimate {
  /** Session units per metre. */
  sessionUnitsPerMetre: number
  /** RMS disagreement of the fit, in session units. */
  residualRms: number
  /** How far the camera travelled across the frames used, in metres (session extent over the scale). 0 means a static camera, which cannot give a scale. */
  baselineM: number
  nFrames: number
}

/** Least extent of camera travel, metres, below which no scale is offered. Adopted, not measured. */
export const MIN_SCALE_BASELINE_M = 0.3

/**
 * How many session units make a metre, using the tag as the ruler.
 *
 * Each frame gives the tag's position relative to the camera in METRES (through the printed size)
 * and the AR runtime gives the camera's position in SESSION UNITS. A tag that does not move in the
 * session means `P - k v_i = p_i` for every frame, with P the tag's session position, v_i the
 * metric tag-to-camera vector rotated into session axes and p_i the camera position. That is linear
 * in (P, k), solved in least squares with one round of outlier trimming. It needs the camera to have
 * moved, because a static camera cannot tell a near small thing from a far big one; the result is
 * null for a camera path shorter than `MIN_SCALE_BASELINE_M`. Frames outside the default range and
 * reprojection gates are left out, as they are in `fuseTagObservations`.
 *
 * Labelled as it is: the scale is the printed size and the focal length speaking, so it is as good
 * as the print and the intrinsics, and as good as the runtime's relative camera positions.
 */
export function estimateSessionScale(observations: readonly TagObservation[], tagSizeM: number): SessionScaleEstimate | null {
  const rows: Array<{ v: V3; p: V3 }> = []
  for (const o of observations) {
    if (intrinsicsProblem(o.intrinsics) !== null) continue
    if (!cornersUsable(o, DEFAULT_MAX_EDGE_RMS_PX, DEFAULT_MIN_EDGE_INLIER_FRACTION)) continue
    const sol = solveTagPose(o.corners, o.intrinsics, tagSizeM)
    if (!sol || sol.best.reprojectionRmsPx > DEFAULT_MAX_REPROJECTION_RMS_PX) continue
    if (sol.best.rangeM < DEFAULT_MIN_RANGE_M || sol.best.rangeM > DEFAULT_MAX_RANGE_M) continue
    const rc = mmul(quatToMatrix(o.cameraPose.rotation), CV_TO_THREE)
    const t = sol.best.translation
    rows.push({ v: mapply(rc, [t.x, t.y, t.z]), p: [o.cameraPose.position.x, o.cameraPose.position.y, o.cameraPose.position.z] })
  }
  if (rows.length < 3) return null

  const fit = (use: readonly { v: V3; p: V3 }[]): { P: V3; k: number } | null => {
    // Normal equations for unknowns [Px, Py, Pz, k]: rows [I3 | -v] x = p.
    const a = new Array<number>(16).fill(0)
    const b = new Array<number>(4).fill(0)
    for (const { v, p } of use) {
      for (let axis = 0; axis < 3; axis++) {
        const row = [0, 0, 0, -v[axis]]
        row[axis] = 1
        for (let r = 0; r < 4; r++) {
          b[r] = b[r]! + row[r]! * p[axis]
          for (let c = 0; c < 4; c++) a[r * 4 + c] = a[r * 4 + c]! + row[r]! * row[c]!
        }
      }
    }
    const x = solveLinear(a, b, 4)
    return x && x.every(Number.isFinite) ? { P: [x[0]!, x[1]!, x[2]!], k: x[3]! } : null
  }
  const residuals = (use: readonly { v: V3; p: V3 }[], f: { P: V3; k: number }) =>
    use.map(({ v, p }) => Math.hypot(f.P[0] - f.k * v[0] - p[0], f.P[1] - f.k * v[1] - p[1], f.P[2] - f.k * v[2] - p[2]))

  let use = rows
  let f = fit(use)
  if (!f) return null
  const res = residuals(use, f)
  const cut = Math.max(OUTLIER_MEDIANS * median(res), 1e-6)
  const trimmed = use.filter((_, i) => res[i]! <= cut)
  if (trimmed.length >= 3 && trimmed.length < use.length) {
    const f2 = fit(trimmed)
    if (f2) {
      use = trimmed
      f = f2
    }
  }
  if (!(f.k > 0)) return null

  // Camera travel, in metres: the largest distance between any two camera positions over the scale.
  let extent = 0
  for (let i = 0; i < use.length; i++) {
    for (let j = i + 1; j < use.length; j++) {
      extent = Math.max(extent, Math.hypot(use[i]!.p[0] - use[j]!.p[0], use[i]!.p[1] - use[j]!.p[1], use[i]!.p[2] - use[j]!.p[2]))
    }
  }
  const baselineM = extent / f.k
  if (baselineM < MIN_SCALE_BASELINE_M) return null
  const res2 = residuals(use, f)
  return {
    sessionUnitsPerMetre: f.k,
    residualRms: Math.sqrt(res2.reduce((s, r) => s + r * r, 0) / res2.length),
    baselineM,
    nFrames: use.length,
  }
}
