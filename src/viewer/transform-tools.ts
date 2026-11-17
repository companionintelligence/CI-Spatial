/**
 * The arithmetic behind the World Editor's last-resort repair path: turning a scan about a point
 * you can see, nudging it by centimetres and fractions of a degree, snapping a drag, taking it back
 * to the placement it arrived with, and keeping its size where it was.
 *
 * Why a pivot at all. A scan root sits where `localToWorld` puts the AR session's origin: the spot
 * the phone booted, often metres from the room's content. The gizmo used to attach to that root, so
 * turning it swung the scan about a point nobody could see and a 3 degree fix needed a second move
 * to bring the scan back. Turning about a point P instead is T(P) · R · T(-P): P stays where it is.
 * The editor attaches the gizmo to a proxy standing on P (the calibrated landmark when the scan has
 * one, the middle of its points otherwise) and drives the scan root from the proxy's moves.
 *
 * Plain `number[]` column-major matrices and no THREE, so Node tests load it. Matrices are the
 * layout of `scan.localToWorld`, `THREE.Matrix4.fromArray` and `transformPoint` in ../world/geo.ts.
 * tests/unit/node/transform_tools.test.ts uses THREE as the oracle for every composition here.
 *
 * Nothing in this file is a measured number. The nudge steps (1 and 5 cm, 0.5 and 2 degrees) are the
 * ones the stitching work package asked for, and {@link MAX_CENTROID_SAMPLES} is a cost bound
 * (ADR 0005 rule 5: adopted, not measured).
 */
import { composeYUpTransform, identityMatrix, transformPoint } from '../world/geo.ts'
import { invertAffine, sessionAnchorPositions } from '../world/anchor-placement.ts'
import {
  checkPlacementMatrix,
  placementTransform,
  PLACEMENT_SCALE_MAX,
  PLACEMENT_SCALE_MIN,
} from '../world/scan-placement.ts'
import type { ScanManifest, TransformPatch, Vec3 } from '../world/types.ts'

/** Column-major 4x4, the layout of `scan.localToWorld`. */
export type Matrix16 = number[]
/** x, y, z, w, as `THREE.Quaternion` holds them. */
export type Quat4 = readonly [number, number, number, number]

/** Small nudge, metres. Adopted, not measured (ADR 0005 rule 5). */
export const NUDGE_FINE_M = 0.01
/** Large nudge, metres. Adopted, not measured (ADR 0005 rule 5). */
export const NUDGE_COARSE_M = 0.05
/** Small turn, degrees. Adopted, not measured (ADR 0005 rule 5). */
export const NUDGE_FINE_DEG = 0.5
/** Large turn, degrees. Adopted, not measured (ADR 0005 rule 5). */
export const NUDGE_COARSE_DEG = 2
/** Most points the middle of a point cloud is taken from: a cost bound, not an accuracy claim. Adopted, not measured (ADR 0005 rule 5). */
export const MAX_CENTROID_SAMPLES = 50_000

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
/** (sqrt(5) - 1) / 2: stepping by it around the unit interval never lands on the same place twice. */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }

// ─── Matrix pieces ───────────────────────────────────────────────────────────

/** `a · b`: the map that applies `b` first. */
export function multiply(a: readonly number[], b: readonly number[]): Matrix16 {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

/**
 * A turn about the vertical axis through the origin. Positive degrees carry +Z toward +X, the
 * convention `composeYUpTransform` and the editor's compass already use, so a calibration's own
 * yaw and a nudge's yaw read the same way.
 */
export function yawMatrix(deg: number): Matrix16 {
  return composeYUpTransform(ORIGIN, deg, 1)
}

/**
 * `T(pivot) · linear · T(-pivot)`: `linear` applied about `pivot`, which stays where it is. Only the 3x3
 * block of `linear` is used. The translation is written as `pivot - linear · pivot` rather than multiplied
 * out, so the pivot does not move by even a rounding step.
 */
export function aboutPoint(pivot: Vec3, linear: readonly number[]): Matrix16 {
  const out = [...linear]
  const moved = {
    x: linear[0]! * pivot.x + linear[4]! * pivot.y + linear[8]! * pivot.z,
    y: linear[1]! * pivot.x + linear[5]! * pivot.y + linear[9]! * pivot.z,
    z: linear[2]! * pivot.x + linear[6]! * pivot.y + linear[10]! * pivot.z,
  }
  out[12] = pivot.x - moved.x
  out[13] = pivot.y - moved.y
  out[14] = pivot.z - moved.z
  out[3] = 0
  out[7] = 0
  out[11] = 0
  out[15] = 1
  return out
}

/** `matrix` turned by `yawDeg` about the world point `pivot` (a world-space move: it goes on the left). */
export function rotateAbout(matrix: readonly number[], pivot: Vec3, yawDeg: number): Matrix16 {
  return multiply(aboutPoint(pivot, yawMatrix(yawDeg)), matrix)
}

/** `matrix` moved by `delta` in world space. Exact: only the translation changes. */
export function translateBy(matrix: readonly number[], delta: Vec3): Matrix16 {
  const out = [...matrix]
  out[12] = out[12]! + delta.x
  out[13] = out[13]! + delta.y
  out[14] = out[14]! + delta.z
  return out
}

/** `matrix` resized by `factor` about the world point `pivot`. */
export function scaleAbout(matrix: readonly number[], pivot: Vec3, factor: number): Matrix16 {
  const linear = identityMatrix()
  linear[0] = factor
  linear[5] = factor
  linear[10] = factor
  return multiply(aboutPoint(pivot, linear), matrix)
}

/** Where a point of the scan's own (root-local) coordinates is in the Place. */
export function pivotWorld(matrix: readonly number[], pivotLocal: Vec3): Vec3 {
  return transformPoint(matrix as number[], pivotLocal)
}

/** A scan's size: the mean length of its three axes. 1 for every calibrated scan. */
export function scaleOf(matrix: readonly number[]): number {
  return (
    Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!)
    + Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!)
    + Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!)
  ) / 3
}

/**
 * The scale lock. `matrix` with each of its three axes set to exactly length `scale`, so a move
 * that should leave the size alone cannot change it, however many times it is composed, and a
 * proxy that was somehow resized cannot resize the scan.
 */
export function holdScale(matrix: readonly number[], scale: number): Matrix16 {
  const out = [...matrix]
  for (const start of [0, 4, 8]) {
    const length = Math.hypot(out[start]!, out[start + 1]!, out[start + 2]!)
    if (!(length > 0)) continue
    const k = scale / length
    out[start] = out[start]! * k
    out[start + 1] = out[start + 1]! * k
    out[start + 2] = out[start + 2]! * k
  }
  return out
}

/** Degrees folded into (-180, 180]. */
export function wrapDegrees(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}

/** Which way the scan's +Z axis points about the vertical, in degrees: `atan2(x, z)`, as the compass uses. */
export function yawOf(matrix: readonly number[]): number {
  return Math.atan2(matrix[8]!, matrix[10]!) * RAD_TO_DEG
}

// ─── Moving by numbers ───────────────────────────────────────────────────────

/** How far a scan has been moved from a reference placement: the pivot's shift in metres, and a turn in degrees. */
export interface PlacementOffset {
  dx: number
  dy: number
  dz: number
  yawDeg: number
}

/**
 * How far `current` is from `saved`, read at the pivot: the shift of the pivot point, and the
 * turn about the vertical axis. For a scan moved by shifts and turns about Y (every move the
 * editor's fields and nudges make) the two numbers say the whole move exactly; a tilt from a
 * gizmo drag is kept in the matrix but is not part of what they report.
 */
export function offsetBetween(saved: readonly number[], current: readonly number[], pivotLocal: Vec3): PlacementOffset {
  const before = pivotWorld(saved, pivotLocal)
  const after = pivotWorld(current, pivotLocal)
  const inverse = invertAffine([...saved])
  const turn = inverse ? yawOf(multiply(current, inverse)) : yawOf(current) - yawOf(saved)
  return { dx: after.x - before.x, dy: after.y - before.y, dz: after.z - before.z, yawDeg: wrapDegrees(turn) }
}

export type NudgeAxis = 'x' | 'y' | 'z' | 'yaw'

/**
 * `matrix` moved one step: `amount` metres along a world axis, or degrees of turn about the pivot.
 * The sign is the direction. The turn leaves the pivot where it is.
 */
export function nudge(matrix: readonly number[], pivotLocal: Vec3, axis: NudgeAxis, amount: number): Matrix16 {
  if (axis === 'yaw') return rotateAbout(matrix, pivotWorld(matrix, pivotLocal), amount)
  return translateBy(matrix, { x: axis === 'x' ? amount : 0, y: axis === 'y' ? amount : 0, z: axis === 'z' ? amount : 0 })
}

/**
 * The matrix whose {@link offsetBetween} from `saved` is `target`, reached from `current` by a turn
 * about the pivot and a shift, so anything else in `current` (a tilt) is kept.
 */
export function moveToOffset(
  current: readonly number[],
  saved: readonly number[],
  pivotLocal: Vec3,
  target: PlacementOffset,
): Matrix16 {
  const now = offsetBetween(saved, current, pivotLocal)
  const turned = rotateAbout(current, pivotWorld(current, pivotLocal), target.yawDeg - now.yawDeg)
  return translateBy(turned, { x: target.dx - now.dx, y: target.dy - now.dy, z: target.dz - now.dz })
}

// ─── Snapping ────────────────────────────────────────────────────────────────

export type SnapMode = 'off' | 'fine' | 'coarse'

/** The step a drag snaps to in a mode: metres and degrees, or null for no snap. */
export function snapSteps(mode: SnapMode): { translateM: number | null; yawDeg: number | null } {
  if (mode === 'fine') return { translateM: NUDGE_FINE_M, yawDeg: NUDGE_FINE_DEG }
  if (mode === 'coarse') return { translateM: NUDGE_COARSE_M, yawDeg: NUDGE_COARSE_DEG }
  return { translateM: null, yawDeg: null }
}

/**
 * `value` rounded to the nearest multiple of `step`, the same way either side of zero (so a drag
 * of -1.4 cm and one of +1.4 cm snap to mirror-image places). A step that is not a positive number
 * leaves the value alone, and the result is cleaned of 0.30000000000000004-style tails.
 */
export function snapTo(value: number, step: number | null): number {
  if (step === null || !Number.isFinite(value) || !(step > 0)) return value
  const steps = Math.round(Math.abs(value) / step)
  return steps === 0 ? 0 : Math.sign(value) * Number((steps * step).toPrecision(12))
}

// ─── Driving the scan from the pivot proxy ───────────────────────────────────

/** The pose of the pivot proxy the gizmo is attached to. */
export interface ProxyPose {
  position: Vec3
  quaternion: Quat4
}

/** `THREE.Matrix4.compose(position, quaternion, scale)` for a unit-scale pose. */
export function composePose(pose: ProxyPose): Matrix16 {
  const [x, y, z, w] = pose.quaternion
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    pose.position.x, pose.position.y, pose.position.z, 1,
  ]
}

/**
 * Where the scan root goes when the proxy has moved from `proxyStart` to `proxyNow` while the root
 * was at `rootStart`: `P1 · P0⁻¹ · R0`. The proxy stands on the pivot, so a turn of the proxy is a turn
 * of the scan about the pivot, and a drag of the proxy is the same drag of the scan.
 *
 * The scale lock: the proxy's own size is never read, and the result is held to the size `rootStart`
 * had. A gizmo mode that resizes the proxy cannot resize the scan; "Fix size" ({@link fixSize}) is
 * the one way to change it. With `snapTranslateM` the drag is first rounded to a multiple of that
 * step, measured from where the drag began, so the pivot does not jump to a grid on the first move.
 */
export function rootFromProxy(options: {
  rootStart: readonly number[]
  proxyStart: ProxyPose
  proxyNow: ProxyPose
  snapTranslateM?: number | null
}): Matrix16 {
  const { rootStart, proxyStart, proxyNow } = options
  const position = snappedPosition(proxyStart.position, proxyNow.position, options.snapTranslateM ?? null)
  const start = invertAffine(composePose(proxyStart))
  if (!start) return [...rootStart]
  const moved = multiply(multiply(composePose({ position, quaternion: proxyNow.quaternion }), start), rootStart)
  return holdScale(moved, heldScale(rootStart))
}

/**
 * Where the proxy is once its drag is rounded to whole steps measured from where the drag began, or
 * `now` as it is with no step. Rounding the drag and not the position is what keeps the first small
 * move from jumping the proxy (and the scan) to the nearest point of a grid it never stood on.
 */
export function snappedPosition(start: Vec3, now: Vec3, stepM: number | null): Vec3 {
  // Unsnapped, the proxy's own position is used as it is: start + (now - start) can be an ulp off it.
  if (stepM === null) return now
  return {
    x: start.x + snapTo(now.x - start.x, stepM),
    y: start.y + snapTo(now.y - start.y, stepM),
    z: start.z + snapTo(now.z - start.z, stepM),
  }
}

/**
 * The size a move must leave a scan at: what it has now, except that a size within a nanometre of 1 is
 * 1 exactly, so a calibrated scan comes out of any number of moves at exactly the size it went in
 * with and no rounding drifts it. The nanometre is adopted, not measured (ADR 0005 rule 5).
 */
function heldScale(matrix: readonly number[]): number {
  const scale = scaleOf(matrix)
  return Math.abs(scale - 1) <= 1e-9 ? 1 : scale
}

/**
 * The "Fix size" action: `matrix` resized to `wanted` times about the world point `pivot`, or why not.
 * The range is the one the server enforces on every saved placement, so a size accepted here is
 * one the Save button can store.
 */
export function fixSize(
  matrix: readonly number[],
  pivot: Vec3,
  wanted: number,
): { ok: true; matrix: Matrix16 } | { ok: false; message: string } {
  if (!Number.isFinite(wanted) || wanted < PLACEMENT_SCALE_MIN || wanted > PLACEMENT_SCALE_MAX) {
    return { ok: false, message: `Size must stay between ${PLACEMENT_SCALE_MIN} and ${PLACEMENT_SCALE_MAX} times.` }
  }
  const now = scaleOf(matrix)
  if (!(now > 0)) return { ok: false, message: 'This scan has no size to change.' }
  return { ok: true, matrix: holdScale(scaleAbout(matrix, pivot, wanted / now), wanted) }
}

/** A scan's size as the Edit panel prints it: three decimals, a tenth of a percent. */
export function sizeLabel(matrix: readonly number[]): string {
  return scaleOf(matrix).toFixed(3)
}

// ─── The placement a scan arrived with ───────────────────────────────────────

/**
 * An exact copy of a stored placement, for putting a scan back where it started, or null when the
 * stored value is not a valid placement (the server would refuse the patch). Every number is carried
 * unchanged, which is what "reset" promises: the patch holds the very bits that were stored.
 */
export function resetMatrix(stored: unknown): Matrix16 | null {
  return checkPlacementMatrix(stored).ok ? [...(stored as number[])] : null
}

/** The `transform` of the patch that resets a scan: the stored matrix untouched, with its readable parts. */
export function resetPatchTransform(stored: unknown): TransformPatch | null {
  const matrix = resetMatrix(stored)
  return matrix ? placementTransform(matrix) : null
}

type CalibrationFacts = Pick<
  ScanManifest,
  'calibratedLocalToWorld' | 'calibrationStatus' | 'calibrationMethod' | 'projectTransformRejected'
>

/**
 * Whether the scan was placed by a Place calibration, as the editor draws its anchor ring: a verified
 * or provisional calibration whose transform was used. A known-distance frame states a size, not a
 * landmark, and an upload whose transform was refused sits by GPS or the grid.
 */
export function isProjectCalibrated(scan: CalibrationFacts): boolean {
  return (scan.calibrationStatus === 'verified' || scan.calibrationStatus === 'provisional')
    && scan.calibrationMethod !== 'known-distance'
    && !scan.projectTransformRejected
}

/**
 * The words on the reset button, which say only what the stored placement is: "calibrated" when a
 * calibration put the scan there, "first placement" when GPS or the grid did.
 */
export function resetLabel(scan: CalibrationFacts): string {
  return isProjectCalibrated(scan) ? 'Reset to calibrated' : 'Reset to first placement'
}

// ─── The pivot ───────────────────────────────────────────────────────────────

export type PivotKind = 'landmark' | 'centroid' | 'origin'

export interface PivotChoice {
  kind: PivotKind
  /** In the scan root's own coordinates, so it moves with the scan. */
  local: Vec3
}

/**
 * Where the gizmo should stand for a scan, in the scan root's own coordinates.
 *
 * A calibrated scan turns about its landmark: the point its calibration sent to the Place's zero,
 * which is `inverse(calibrated placement) · (0, 0, 0)` (sessionAnchorPositions does that). It is read from
 * the calibrated placement and not the current one, because a move changes `localToWorld` and the
 * landmark does not change with it. A scan without one turns about the middle of its points, and
 * with no points either, about its session origin, which is where the gizmo used to stand.
 */
export function choosePivot(scan: CalibrationFacts, centroid: Vec3 | null): PivotChoice {
  const calibrated = scan.calibratedLocalToWorld
  if (isProjectCalibrated(scan) && checkPlacementMatrix(calibrated).ok) {
    const { landmark } = sessionAnchorPositions(calibrated!)
    if ([landmark.x, landmark.y, landmark.z].every(Number.isFinite)) return { kind: 'landmark', local: landmark }
  }
  if (centroid && [centroid.x, centroid.y, centroid.z].every(Number.isFinite)) return { kind: 'centroid', local: centroid }
  return { kind: 'origin', local: { ...ORIGIN } }
}

/**
 * The index of the k-th of `samples` points picked from `count`: every point when they all fit, and
 * otherwise spread by the golden ratio, which has no period, so a cloud stored in raster order (every
 * row the same length) cannot line up with the sampling and be read from one column.
 */
export function sampleIndex(k: number, samples: number, count: number): number {
  return samples >= count ? k : Math.floor((((k + 0.5) * GOLDEN_RATIO_CONJUGATE) % 1) * count)
}

/**
 * The mean of a flat `x, y, z, ...` list, or null when there are none. A list of more than
 * {@link MAX_CENTROID_SAMPLES} points is sampled with {@link sampleIndex}, not read through. Points that
 * are not finite are skipped.
 */
export function centroidOf(positions: ArrayLike<number>, maxSamples = MAX_CENTROID_SAMPLES): Vec3 | null {
  const count = Math.floor(positions.length / 3)
  if (count === 0) return null
  const samples = Math.min(count, Math.max(1, Math.floor(maxSamples)))
  let x = 0
  let y = 0
  let z = 0
  let used = 0
  for (let k = 0; k < samples; k++) {
    const i = sampleIndex(k, samples, count)
    const px = positions[i * 3]!
    const py = positions[i * 3 + 1]!
    const pz = positions[i * 3 + 2]!
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue
    x += px
    y += py
    z += pz
    used++
  }
  return used === 0 ? null : { x: x / used, y: y / used, z: z / used }
}

// ─── Unsaved moves ───────────────────────────────────────────────────────────

/** Whether two matrices are the same placement to within `eps` on every entry (a nanometre by default, adopted, not measured: ADR 0005 rule 5). */
export function matricesClose(a: readonly number[], b: readonly number[], eps = 1e-9): boolean {
  if (a.length !== 16 || b.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (!(Math.abs(a[i]! - b[i]!) <= eps)) return false
  }
  return true
}

/**
 * An offset as the Edit panel shows it: centimetres to a tenth and degrees to a hundredth, with
 * no minus sign on a zero, so a field that reads "-0" never appears.
 */
export function describeOffset(offset: PlacementOffset): { xCm: number; yCm: number; zCm: number; yawDeg: number } {
  const round = (value: number, places: number): number => {
    const k = 10 ** places
    return Math.round(value * k) / k + 0
  }
  return {
    xCm: round(offset.dx * 100, 1),
    yCm: round(offset.dy * 100, 1),
    zCm: round(offset.dz * 100, 1),
    yawDeg: round(offset.yawDeg, 2),
  }
}

/** Radians for a snap step in degrees, as `TransformControls.setRotationSnap` wants it. */
export function degreesToRadians(deg: number): number {
  return deg * DEG_TO_RAD
}

/**
 * The sentence a failed request carried, or `fallback`. The editor's httpError() turns a refused response
 * into `Error("409 {\"error\":\"...\"}")`, which is not for a person; the server's own message inside it is.
 * A network failure has no such sentence and gets the fallback.
 */
export function plainServerError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const match = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!match) return fallback
  try {
    const sentence = JSON.parse(`"${match[1]}"`) as string
    return sentence.length > 0 ? sentence : fallback
  } catch {
    return fallback
  }
}
