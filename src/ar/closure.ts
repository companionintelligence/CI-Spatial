/**
 * Closure: how far the session frame has moved since the Place calibration was made, measured by tapping the same
 * spots again.
 *
 * Pure, with no DOM and no AR runtime (ADR 0002), so the arithmetic is tested against synthetic drift and the
 * scanner, the sidecar and the editor can all read the same record. The flow that asks for the taps is
 * ./reanchor-flow.ts; this file only turns taps into numbers and judges them.
 *
 * ## What is measured
 *
 * The scan's calibration (`sessionToProject`, column-major) carries session coordinates into the Place frame, where
 * the landmark is the origin and the heading marker sits on +Z at the stored separation. Tap the landmark again, in
 * the same session, and carry the tap through the same matrix: if the session frame has not moved since the
 * calibration it lands on the origin again, and if the runtime has shifted or drifted since, it lands somewhere else.
 * How far is the closure, in the sense of a loop closure (the walk has returned to where it began) and not of a map
 * correction: nothing here corrects anything.
 *
 *  - `translationM`: how far the landmark's re-tap lands from the stored landmark, on the floor. This is the closure
 *    error at the landmark, which is what the device protocol's table of error against distance walked wants
 *    (docs/testing/DEVICE_TESTING.md, the room-loop benchmark).
 *  - `dyM`: the re-tap's height above the stored landmark's, signed.
 *  - `yawDeg`: with the heading marker tapped as well, how far the re-tapped baseline is turned from the stored one,
 *    in degrees, positive when it is turned toward +X (the sense of `twoPointHeadingDeg`, ../world/geo.ts, so a heading
 *    printed here means what a heading printed anywhere else in the app means). Null with the landmark alone: one
 *    point has no direction.
 *  - `pathLengthM`: how far the camera walked between the calibration and the closure taps, integrated from the
 *    scan's pose history. The poses are sampled by the scanner's tick, not every frame, so a corner is cut and the
 *    figure is a lower bound of the walk; it is a regressor for the error, not an odometer.
 *
 * ## What it is not
 *
 * It does not say the frame moved. A tap on a different spot than the one calibrated gives the same numbers as a
 * frame that moved, and a consistent shift of every tap by the same amount cannot be told from no shift by anything
 * made of taps. So a closure is stated as a measurement ("the re-tap landed 12 cm from the stored landmark") and the
 * proposal that follows it is conditional on the person having tapped the same spot (./reanchor-copy.ts).
 *
 * ## The limits, and why they sit where they do
 *
 * A re-tap is not exact. Taking the tap noise per floor axis as `SIGMA0_M` for the calibration's own tap (the
 * figure the whole frame is judged by, ../world/frame-fit.ts) and `CLOSURE_RETAP_SIGMA_M` for the re-tap, the
 * difference between the two taps of one spot has a per-axis spread of their root-sum-square, `closureTapSigmaM()`.
 * A limit set at three of those (`CLOSURE_SIGMAS`) is exceeded by pure re-tapping noise about once in a hundred:
 * a limit below it would propose a re-anchor for the noise of the check itself.
 *
 *  - Translation and height: `CLOSURE_SIGMAS` times that spread.
 *  - Heading: the same, carried through the baseline. A baseline of length `b` turns by `spread * sqrt(2) / b` radians
 *    when each of its two ends is off by `spread` sideways, and the stored and the re-tapped baselines are two
 *    independent measurements, so the difference of their directions is `sqrt(2)` times wider again. The baseline
 *    used is the shorter of the two: a short one gives a direction that means little, and the limit then widens
 *    with it instead of proposing a re-anchor on a number that cannot support it. It is never below
 *    `CLOSURE_YAW_FLOOR_DEG`, the turn that moves content at the working radius by the product's own accuracy target
 *    (../world/frame-fit.ts), because a turn smaller than the product promises is not worth a re-anchor, which
 *    inherits the stored frame's own error (./reanchor-copy.ts says how much).
 *
 * Every number here is adopted, not measured (ADR 0005 rule 5): the 3 cm is the assumption the frame is built on and
 * the 5 cm is the top of the 3 to 5 cm the work package gives for a human re-tap. Device experiment DX4 records the
 * closure at 5, 10, 20 and 40 m of walking, and DX2 measures what a tap really scatters by; the limits move to what
 * they say. Each record keeps the limits it was judged by, so an old record can be read again later.
 */
import { ACCURACY_TARGET_M, SIGMA0_M, WORKING_RADIUS_M } from '../world/frame-fit.ts'
import { transformPoint } from '../world/geo.ts'
import { wrapDeg } from '../capture/pose-delta.ts'
import type { Vec3 } from '../world/types.ts'
import type { TapSource } from './tap-sampling.ts'

const RAD_TO_DEG = 180 / Math.PI

// ── Adopted constants ───────────────────────────────────────────────────────

/**
 * The spread of one human re-tap, per floor axis, in metres: the top of the 3 to 5 cm the work package gives for a
 * closure tap. Taken at the top so that the limits err toward fewer proposals, not more.
 *
 * Adopted, not measured (ADR 0005 rule 5). DX2 measures how far apart two taps of one spot land; replace it with the
 * figure it gives.
 */
export const CLOSURE_RETAP_SIGMA_M = 0.05

/**
 * How many spreads above the noise of the check a closure has to be before it proposes a re-anchor. Three: about one
 * pure-noise check in a hundred crosses it.
 *
 * Adopted, not measured (ADR 0005 rule 5): a convention, not a device figure.
 */
export const CLOSURE_SIGMAS = 3

/** The per-axis spread of the difference between a re-tap and the calibration's own tap of one spot, in metres. */
export function closureTapSigmaM(): number {
  return Math.hypot(SIGMA0_M, CLOSURE_RETAP_SIGMA_M)
}

/**
 * The most a re-tap of the landmark may land from the stored landmark, on the floor, before the closure proposes a
 * re-anchor, in metres: `CLOSURE_SIGMAS` spreads of the difference of two taps. 17.5 cm with the adopted figures.
 * The same limit applies to the re-tap's height.
 *
 * Adopted, not measured (ADR 0005 rule 5). Above `CLOSURE_SIGMAS` times the noise of the check by construction.
 */
export const CLOSURE_TRANSLATION_LIMIT_M = CLOSURE_SIGMAS * closureTapSigmaM()

/**
 * The least turn the closure ever proposes a re-anchor for, in degrees: the turn that moves content at
 * `WORKING_RADIUS_M` by `ACCURACY_TARGET_M` (3.5 degrees with 0.305 m at 5 m).
 *
 * Adopted, not measured (ADR 0005 rule 5): both figures are the product's own, not a device's.
 */
export const CLOSURE_YAW_FLOOR_DEG = Math.atan(ACCURACY_TARGET_M / WORKING_RADIUS_M) * RAD_TO_DEG

/**
 * The turn of the baseline that proposes a re-anchor, in degrees, for a baseline `baselineM` long: `CLOSURE_SIGMAS`
 * spreads of the difference of two directions measured over that baseline, and never below
 * `CLOSURE_YAW_FLOOR_DEG`. About 4.7 degrees at 3 m, 14 at 1 m. A baseline that is not a positive number has no
 * direction to judge, and gets no limit (null).
 */
export function closureYawLimitDeg(baselineM: number | null | undefined): number | null {
  if (typeof baselineM !== 'number' || !Number.isFinite(baselineM) || !(baselineM > 0)) return null
  const noiseLimit = (CLOSURE_SIGMAS * Math.SQRT2 * closureTapSigmaM() / baselineM) * RAD_TO_DEG
  return Math.max(CLOSURE_YAW_FLOOR_DEG, noiseLimit)
}

// ── Measuring a closure ─────────────────────────────────────────────────────

export interface ClosureInput {
  /** The scan's calibration: session coordinates to the Place frame, column-major 4x4. */
  sessionToProject: readonly number[]
  /** The Place's reference points in the Place frame, landmark first and the heading marker second, as stored. */
  stored: readonly Vec3[]
  /** The same spots, tapped now, in session metres and in the same order. */
  retapped: readonly Vec3[]
}

export interface ClosureMeasurement {
  /** How far the landmark's re-tap lands from the stored landmark, on the floor, in metres. */
  translationM: number
  /** The re-tap's height above the stored landmark's, in metres. Signed. */
  dyM: number
  /** How far the re-tapped baseline is turned from the stored one, in degrees in (-180, 180]. Null with one point. */
  yawDeg: number | null
  /**
   * The baseline the heading was measured over, in metres: the shorter of the stored and the re-tapped one. Null with
   * one point. It is what the heading limit is worked out from.
   */
  baselineM: number | null
  points: number
}

/** Why no closure could be made. A result, never a throw. */
export type ClosureRefusal =
  /** No point at all, or the two lists are not the same length. */
  | 'points'
  /** The calibration is not 16 finite numbers, or a point has a coordinate that is not a finite number. */
  | 'not-finite'

export type ClosureResult =
  | { ok: true; closure: ClosureMeasurement }
  | { ok: false; reason: ClosureRefusal }

function finitePoint(p: Vec3 | null | undefined): p is Vec3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

/**
 * Where the closure taps land in the Place frame, set against where the Place says those spots are.
 *
 * The first point is the landmark: its horizontal distance from the stored one is `translationM` and its height
 * difference `dyM`. With two or more, `yawDeg` is the best turn of the stored points onto the re-tapped ones (the
 * least-squares rotation about the vertical of the points taken about their centres, which for two points is
 * exactly the turn between their baselines). Heights do not enter the turn: the baseline is read on the floor.
 */
export function measureClosure(input: ClosureInput): ClosureResult {
  const { sessionToProject, stored, retapped } = input
  if (stored.length < 1 || stored.length !== retapped.length) return { ok: false, reason: 'points' }
  if (sessionToProject.length !== 16 || !sessionToProject.every((v) => Number.isFinite(v))) return { ok: false, reason: 'not-finite' }
  if (!stored.every(finitePoint) || !retapped.every(finitePoint)) return { ok: false, reason: 'not-finite' }

  const matrix = [...sessionToProject]
  const placed = retapped.map((p) => transformPoint(matrix, p))
  const landmarkDx = placed[0]!.x - stored[0]!.x
  const landmarkDz = placed[0]!.z - stored[0]!.z
  const closure: ClosureMeasurement = {
    translationM: Math.hypot(landmarkDx, landmarkDz),
    dyM: placed[0]!.y - stored[0]!.y,
    yawDeg: null,
    baselineM: null,
    points: stored.length,
  }
  if (stored.length >= 2) {
    const turn = bestTurnDeg(stored, placed)
    if (turn !== null) {
      closure.yawDeg = turn
      const storedBaseline = Math.hypot(stored[1]!.x - stored[0]!.x, stored[1]!.z - stored[0]!.z)
      const placedBaseline = Math.hypot(placed[1]!.x - placed[0]!.x, placed[1]!.z - placed[0]!.z)
      closure.baselineM = Math.min(storedBaseline, placedBaseline)
    }
  }
  return { ok: true, closure }
}

/**
 * The turn about the vertical, in degrees, that carries `from` onto `to` best in the least-squares sense, both taken
 * about their centres, with the sign of `twoPointHeadingDeg` (positive turns +Z toward +X). Null when either set has
 * no extent on the floor (every point on one spot), which leaves no direction to turn.
 */
function bestTurnDeg(from: readonly Vec3[], to: readonly Vec3[]): number | null {
  const n = from.length
  const centre = (points: readonly Vec3[]) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / n,
    z: points.reduce((sum, p) => sum + p.z, 0) / n,
  })
  const a = centre(from)
  const b = centre(to)
  let cross = 0
  let dot = 0
  let spreadFrom = 0
  let spreadTo = 0
  for (let i = 0; i < n; i++) {
    const ax = from[i]!.x - a.x
    const az = from[i]!.z - a.z
    const bx = to[i]!.x - b.x
    const bz = to[i]!.z - b.z
    cross += az * bx - ax * bz
    dot += ax * bx + az * bz
    spreadFrom += ax * ax + az * az
    spreadTo += bx * bx + bz * bz
  }
  if (!(spreadFrom > 0) || !(spreadTo > 0)) return null
  return wrapDeg(Math.atan2(cross, dot) * RAD_TO_DEG)
}

// ── Judging it ──────────────────────────────────────────────────────────────

/** The limits a closure was judged by, as they were when it was. */
export interface ClosureLimits {
  translationM: number
  /** Null when the closure had no heading to judge. */
  yawDeg: number | null
  basis: 'adopted, not measured'
}

export type ClosureExcess = 'translation' | 'height' | 'heading'

export interface ClosureJudgement {
  /** True when any of the three is over its limit: the closure proposes a re-anchor. */
  exceeded: boolean
  reasons: ClosureExcess[]
  limits: ClosureLimits
}

/**
 * Whether a closure is over its limits. Comparisons are strict, as the separation check's is: a re-tap exactly on the
 * limit is not over it. A number that is not finite is not over anything, and cannot reach here from `measureClosure`.
 */
export function judgeClosure(closure: ClosureMeasurement): ClosureJudgement {
  const yawLimit = closure.yawDeg === null ? null : closureYawLimitDeg(closure.baselineM)
  const reasons: ClosureExcess[] = []
  if (closure.translationM > CLOSURE_TRANSLATION_LIMIT_M) reasons.push('translation')
  if (Math.abs(closure.dyM) > CLOSURE_TRANSLATION_LIMIT_M) reasons.push('height')
  if (closure.yawDeg !== null && yawLimit !== null && Math.abs(closure.yawDeg) > yawLimit) reasons.push('heading')
  return {
    exceeded: reasons.length > 0,
    reasons,
    limits: { translationM: CLOSURE_TRANSLATION_LIMIT_M, yawDeg: yawLimit, basis: 'adopted, not measured' },
  }
}

// ── The path walked ─────────────────────────────────────────────────────────

/**
 * How far the camera walked through `poses`, in metres, from index `fromIndex` on: the sum of the straight-line
 * distances between consecutive positions. A pose whose position is not a finite number is skipped and the walk goes
 * on from the last good one, so one bad sample neither adds nothing nor adds a jump. An index outside the list reads
 * as the nearest end, so a trail that was emptied after the index was taken measures what it holds now.
 */
export function pathLengthM(poses: ReadonlyArray<{ position: Vec3 }>, fromIndex = 0): number {
  const start = Math.min(Math.max(Number.isFinite(fromIndex) ? Math.floor(fromIndex) : 0, 0), poses.length)
  let length = 0
  let last: Vec3 | null = null
  for (let i = start; i < poses.length; i++) {
    const position = poses[i]!.position
    if (!finitePoint(position)) continue
    if (last) length += Math.hypot(position.x - last.x, position.y - last.y, position.z - last.z)
    last = position
  }
  return length
}

// ── The record ──────────────────────────────────────────────────────────────

/** What a tap behind the closure was, for reading its number: how it was read and how steadily. */
export interface ClosureTap {
  source: TapSource
  spreadM: number | null
  rangeM: number
}

/**
 * One closure as the sidecar keeps it (`frameEpochs.closures`, src/ar/frame-epoch.ts). Every number is a
 * measurement of this one check; none says the frame moved (see the top of this file).
 */
export interface FrameClosureRecord {
  /** Wall-clock time of the check, ISO 8601. */
  at: string
  /** The frame epoch the provider was in when it was made. */
  epoch: number
  translationM: number
  dyM: number
  yawDeg: number | null
  baselineM: number | null
  /** Points tapped: 1 for the landmark alone, 2 with the heading marker. */
  points: number
  /** The camera path since the calibration, from the scan's pose history. See the top of this file. */
  pathLengthM: number
  /** Whether it was over its limits, and so proposed a re-anchor. */
  exceeded: boolean
  limits: ClosureLimits
  taps: ClosureTap[]
}

export interface ClosureContext {
  at: string
  epoch: number
  pathLengthM: number
  taps: ClosureTap[]
}

/** The record for a measurement, judged now. */
export function closureRecord(closure: ClosureMeasurement, context: ClosureContext): FrameClosureRecord {
  const judgement = judgeClosure(closure)
  return {
    at: context.at,
    epoch: context.epoch,
    translationM: closure.translationM,
    dyM: closure.dyM,
    yawDeg: closure.yawDeg,
    baselineM: closure.baselineM,
    points: closure.points,
    pathLengthM: context.pathLengthM,
    exceeded: judgement.exceeded,
    limits: judgement.limits,
    taps: context.taps.map((tap) => ({ ...tap })),
  }
}
