/**
 * The similarity algebra that carries a session from its own AR frame into the Place frame through one joint
 * structure-from-motion solve: `T_new->Place = T_ref x Sim_ref^-1 x Sim_new`.
 *
 * ## The idea
 *
 * One COLMAP model holds the frames of several sessions, in COLMAP's own world frame W: arbitrary origin, arbitrary
 * heading, arbitrary scale. Each session also recorded its cameras in its own AR frame A_s (its runtime's origin, its
 * runtime's units, gravity along +Y). The same physical cameras, described twice, give a seven-degree-of-freedom
 * similarity per session by Umeyama's closed form (the fit `splat_align.ts` already makes for one session):
 *
 *   Sim_s : A_s -> W        x_W = scale_s * R_s * x_A + t_s
 *
 * The reference session is the one whose calibration defines the Place frame: `T_ref = sessionToProject`, the
 * scan's own matrix, A_ref -> Place. A new session's frame reaches the Place frame by going to W through its own
 * fit and back to the reference's frame through the inverse of the reference's:
 *
 *   T_new->Place = T_ref . Sim_ref^-1 . Sim_new        (apply Sim_new first)
 *
 * The new session's own calibration is not in that product. That is the point: it is what the product replaces, and
 * the difference between the two is the correction a person may choose to apply.
 *
 * ## Star, not chain
 *
 * Every session is registered to the reference and to nothing else. Chaining B to A and then C to B adds the error
 * of each hop and would let a bad middle session carry the rest with it; here each registration is `T_ref` and two
 * fits, and no function in this file takes two non-reference sessions. {@link registerSessionsToReference} is the
 * only place sessions meet.
 *
 * ## Units
 *
 * `scale_s` is solver units per unit of A_s. Two sessions on runtimes with different units (a metric WebXR session
 * and an 8th Wall session in whatever units its scale mode gives) have different `scale_s` for the same room, and
 * the ratio `scale_new / scale_ref` is how many units of the reference's frame one unit of the new session is. It is
 * carried on every registration as `scaleRatioToReference`, because it is the one place the unit mismatch between
 * runtimes is measured. The calibration of an AR session is rigid by the app's convention (scale 1), so then
 * `T_new->Place` has exactly that scale, in Place metres. Only the `'known-distance'` tier writes a scale into
 * `sessionToProject`, for a capture with no AR poses, which cannot be a reference here; a reference that has one is still
 * read, and `T_new->Place` then has `T_ref`'s scale times the ratio, which is what `SessionRegistration.sessionToPlace`
 * says and `scaleRatioToReference` does not.
 *
 * ## Two matrix conventions, both explicit
 *
 *  - `ScanCalibration.sessionToProject` is **column-major** (`THREE.Matrix4.fromArray`): the image of the x axis is
 *    elements 0 to 2, the translation is elements 12 to 14. See {@link sim3FromColumnMajor}.
 *  - `SplatAlignManifest.projectTransform` is **row-major**: the translation is elements 3, 7 and 11. See
 *    {@link sim3ToRowMajor}, which is `similarityToRowMajor` from splat_align.ts, the writer that field already has.
 *
 * A similarity's scale is folded into the rotation block in both, so one matrix is one transform. Reading a
 * row-major matrix as column-major transposes it, which for a rotation inverts it: plausible-looking and wrong, so
 * the conventions are tested with random transforms rather than assumed.
 *
 * ## What the fit refuses, and why
 *
 * The refusals of a fit are the ones `runSplatAlign` makes, with the same constants (ADR 0001): too few paired frames
 * for the residual to mean anything; camera centres in a straight line, which leave the rotation about the line
 * undetermined and show no residual; a scale that is not positive; and a residual above `DEFAULT_MAX_RESIDUAL_M`, which
 * says the AR path and the solved path are not the same path.
 *
 * A registration refuses one more thing, which only two fits can say: that the two sessions' up axes disagree. Every
 * AR session is gravity-aligned, so a correct registration keeps them parallel; the fits are free to tip them, because
 * the solve has no gravity of its own. A garbage fit (frames COLMAP registered wrongly, a session it could not tie to
 * the others) tips them by an arbitrary angle, and the residual gate alone lets a few frames' garbage through (see
 * {@link MAX_UP_AXIS_TILT_DEG}). It is also what stands against a camera path too straight to fix the turn about
 * its own length, which a roll of the up axis shows.
 *
 * What it cannot see. A solve that is the mirror image of the AR poses (every session's keyframes mirrored by a capture
 * bug) fits a nearly flat camera path almost as well as the real one: the proper rotation the fit is held to turns the
 * path over, and the height wobble is all that tells the two apart. Simulated (24-frame loops, 100 trials per spread, a
 * solve that is the Place frame mirrored in x): registered in 99 to 100 of 100 trials at a 5 cm spread of camera height,
 * the cameras' own placement off by a median 7 to 8 cm; in 85 at 10 cm; in 5 at 15 cm; in none from 30 cm (the test
 * "a mirror image of a nearly flat camera path" draws it again). Camera centres alone cannot separate them, so a
 * mirrored capture is a capture bug to be found where it is made. The toy COLMAP test (colmap_toy_sfm.test.ts) is what
 * shows the conventions here, AR pose against solved pose, are not mirrored.
 *
 * A camera path that is nearly a line (a corridor walked once) leaves the turn about its own length poorly fixed, and
 * the residual does not show it. Simulated (300 trials a shape, 30 frames, 2 cm of noise, a point placed 3 m off the walk
 * and 1 m up): for a walk 12 m by 0.5 m the up-axis check refused 3% and the rest placed the point within a median 8.5 cm
 * and at worst 27 cm; for 20 m by 0.3 m it refused 16% and the rest a median 12 cm, worst 27 cm, where without the check the
 * worst was 45 to 56 cm. The check bounds that error and does not remove it; `spreadRatio` is reported beside it.
 *
 * Nothing here says a session is aligned. It computes a transform and the numbers that say how well the two
 * descriptions of the cameras agree.
 *
 * Pure: no Deno API, no file access.
 */
import { type BoundedCorrection, isMatrix16 } from '../../src/world/register-proposal.ts'
import {
  COLLINEAR_SPREAD_RATIO,
  DEFAULT_MAX_RESIDUAL_M,
  DEFAULT_MIN_CORRESPONDENCES,
  det3,
  identity3,
  matMul3,
  matVec3,
  pairByFilename,
  similarityToRowMajor,
  transpose3,
  transpose4,
  umeyamaSimilarity,
  type SimilarityFit,
  type Vec3Tuple,
} from '../splat/splat_align.ts'
import { MAX_CORRECTION_DY_M, MAX_CORRECTION_TRANSLATION_M, MAX_CORRECTION_YAW_DEG } from './scan_match.ts'

// ─── The similarity ──────────────────────────────────────────────────────────

/**
 * `x' = scale * R * x + t`: the three fields of `SimilarityFit` (splat_align.ts) that make up the transform, with its
 * convention. `rotation` is a proper rotation, row-major 3x3; `scale` is positive and uniform. A `SimilarityFit` is
 * one, and so is anything `similarityToRowMajor` accepts.
 */
export type Sim3 = Pick<SimilarityFit, 'rotation' | 'translation' | 'scale'>

export function identitySim3(): Sim3 {
  return { rotation: identity3(), translation: [0, 0, 0], scale: 1 }
}

/** The point `p` carried through `s`. */
export function applySim3(s: Sim3, p: Vec3Tuple): Vec3Tuple {
  const r = matVec3(s.rotation, p)
  return [s.scale * r[0] + s.translation[0], s.scale * r[1] + s.translation[1], s.scale * r[2] + s.translation[2]]
}

/** `outer . inner`: the similarity that applies `inner` first and `outer` second. */
export function composeSim3(outer: Sim3, inner: Sim3): Sim3 {
  const turned = matVec3(outer.rotation, inner.translation)
  return {
    rotation: matMul3(outer.rotation, inner.rotation),
    translation: [
      outer.scale * turned[0] + outer.translation[0],
      outer.scale * turned[1] + outer.translation[1],
      outer.scale * turned[2] + outer.translation[2],
    ],
    scale: outer.scale * inner.scale,
  }
}

/** The similarity that undoes `s`. */
export function invertSim3(s: Sim3): Sim3 {
  const rotation = transpose3(s.rotation)
  const back = matVec3(rotation, s.translation)
  const scale = 1 / s.scale
  return { rotation, translation: [-scale * back[0], -scale * back[1], -scale * back[2]], scale }
}

/**
 * How far a matrix may be from an exact similarity and still be read as one: column lengths equal, columns at right
 * angles, bottom row (0, 0, 0, 1), all to this relative or absolute tolerance. A numerical tolerance for matrices
 * that went through JSON and a few products.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** It is far above float rounding (about 1e-15) and far below any
 * stretch or shear a real matrix could carry. **Revisit when** a stored `sessionToProject` is refused that should read.
 */
export const SIM3_TOLERANCE = 1e-6

/**
 * The similarity a **column-major** 4x4 holds (`THREE.Matrix4.fromArray`, `ScanCalibration.sessionToProject`): the
 * image of the x axis in elements 0 to 2, of y in 4 to 6, of z in 8 to 10, the translation in 12 to 14. Null for
 * anything that is not a proper similarity: not 16 numbers, a projective row, columns of different lengths, columns
 * not at right angles, or a mirror (negative determinant).
 */
export function sim3FromColumnMajor(m: readonly number[]): Sim3 | null {
  if (!isMatrix16(m)) return null
  if (Math.abs(m[3]!) > SIM3_TOLERANCE || Math.abs(m[7]!) > SIM3_TOLERANCE || Math.abs(m[11]!) > SIM3_TOLERANCE) return null
  if (Math.abs(m[15]! - 1) > SIM3_TOLERANCE) return null
  const cols: Vec3Tuple[] = [[m[0]!, m[1]!, m[2]!], [m[4]!, m[5]!, m[6]!], [m[8]!, m[9]!, m[10]!]]
  const lengths = cols.map((c) => Math.hypot(c[0], c[1], c[2]))
  const scale = lengths[0]!
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  for (const length of lengths) if (Math.abs(length - scale) / scale > SIM3_TOLERANCE) return null
  const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
    if (Math.abs(dot(cols[i]!, cols[j]!)) / (scale * scale) > SIM3_TOLERANCE) return null
  }
  const rotation = [0, 1, 2].map((r) => [0, 1, 2].map((c) => cols[c]![r]! / scale))
  if (!(det3(rotation) > 0)) return null
  return { rotation, translation: [m[12]!, m[13]!, m[14]!], scale }
}

/** The **column-major** 4x4 for `s`, scale folded into the rotation block: translation at elements 12 to 14. */
export function sim3ToColumnMajor(s: Sim3): number[] {
  const r = s.rotation
  const k = s.scale
  return [
    k * r[0]![0]!, k * r[1]![0]!, k * r[2]![0]!, 0,
    k * r[0]![1]!, k * r[1]![1]!, k * r[2]![1]!, 0,
    k * r[0]![2]!, k * r[1]![2]!, k * r[2]![2]!, 0,
    s.translation[0], s.translation[1], s.translation[2], 1,
  ]
}

/**
 * The similarity a **row-major** 4x4 holds (`SplatAlignManifest.projectTransform`): the translation in elements
 * 3, 7 and 11. Null for anything that is not a proper similarity, as {@link sim3FromColumnMajor}.
 */
export function sim3FromRowMajor(m: readonly number[]): Sim3 | null {
  return isMatrix16(m) ? sim3FromColumnMajor(transpose4([...m])) : null
}

/** The **row-major** 4x4 for `s`: the layout of `SplatAlignManifest.projectTransform`, written by `similarityToRowMajor`. */
export function sim3ToRowMajor(s: Sim3): number[] {
  return similarityToRowMajor(s)
}

/**
 * `T_new->Place = T_ref . Sim_ref^-1 . Sim_new`.
 *
 * `placeFromReference` is the reference session's own calibration (A_ref -> Place), and `referenceToSolver` and
 * `newToSolver` are the two sessions' fits (A_s -> W). The result takes the new session's AR frame into the Place
 * frame: first into W, then back into the reference's AR frame, then through the reference's calibration.
 */
export function chainToPlace(placeFromReference: Sim3, referenceToSolver: Sim3, newToSolver: Sim3): Sim3 {
  return composeSim3(placeFromReference, composeSim3(invertSim3(referenceToSolver), newToSolver))
}

// ─── One session against the solve ───────────────────────────────────────────

export type SessionFitRefusal = 'too-few-correspondences' | 'collinear' | 'degenerate-scale' | 'high-residual'

export interface SessionFitInput {
  sessionId: string
  /**
   * The session's recorded camera centres in its own frame, by frame key (`sessionCentres` in ./session_priors.ts).
   * Named, with the solver's beside it, and not two positional maps of one type: swapped, a fit comes out as the inverse
   * of the right one with a perfect residual, and nothing in the numbers says so.
   */
  sessionCentres: ReadonlyMap<string, Vec3Tuple>
  /** The same frames' camera centres in the solver's frame, by the same keys (`sfmCentresFromPoses` over the joint poses). */
  solverCentres: ReadonlyMap<string, Vec3Tuple>
  /** Refuse below this many paired frames. Default `DEFAULT_MIN_CORRESPONDENCES`. */
  minCorrespondences?: number
  /** Refuse above this RMS residual, in the session's own units. Default `DEFAULT_MAX_RESIDUAL_M`. */
  maxResidualM?: number
}

/** `Sim_s` and what it was measured on. */
export interface SessionSim3Fit {
  ok: true
  sessionId: string
  /** `Sim_s`: the session's AR frame to the solver's frame, `x_W = scale * R * x_A + t`. */
  sessionToSolver: Sim3
  /**
   * RMS gap between the session's recorded camera centres and the solve's, after the fit, in the session's own
   * units. In metres only if the session's runtime reports metres, which is what `scaleRatioToReference` measures.
   */
  residualSessionUnits: number
  /** Frames both the solve and the session placed. */
  correspondenceCount: number
  /** Second-largest over largest spread of the solved centres: near 0 is a straight line. See `COLLINEAR_SPREAD_RATIO`. */
  spreadRatio: number
  /**
   * The session's +Y, which is gravity-up for an AR runtime, in the solver's frame. The solve has no gravity of its
   * own; this is where the AR poses put it (the fit's rotation), not a guess from the tilt of the cameras
   * (`estimateUpAxis`). A unit vector.
   */
  upAxisInSolver: Vec3Tuple
  /** The frame keys the fit used, sorted. */
  files: string[]
}

export interface SessionFitRefused {
  ok: false
  sessionId: string
  reason: SessionFitRefusal
  message: string
  correspondenceCount: number
  /** What was measured before the refusal, when it was. */
  spreadRatio?: number
  /** Solver units per session unit, as `SessionRegistration.umeyamaScale`. Only for a refusal made on the residual. */
  umeyamaScale?: number
  residualSessionUnits?: number
}

export type SessionFitResult = SessionSim3Fit | SessionFitRefused

/**
 * Fit one session's recorded AR camera centres to its camera centres in the solve.
 *
 * Both sets are keyed by the frame key, which `pairByFilename` pairs by. The fit is made from the solver to the
 * session, so the residual is in the session's units, and then inverted into `Sim_s`.
 */
export function fitSessionToSolver(input: SessionFitInput): SessionFitResult {
  const { sessionId, sessionCentres, solverCentres } = input
  const minCorrespondences = input.minCorrespondences ?? DEFAULT_MIN_CORRESPONDENCES
  const maxResidualM = input.maxResidualM ?? DEFAULT_MAX_RESIDUAL_M
  const { files, source, target } = pairByFilename(new Map(solverCentres), new Map(sessionCentres))
  const correspondenceCount = files.length

  if (correspondenceCount < minCorrespondences) {
    return {
      ok: false,
      sessionId,
      reason: 'too-few-correspondences',
      correspondenceCount,
      message: `Only ${correspondenceCount} frame(s) of ${sessionId} are both placed by the solve and carry a recorded camera ` +
        `position; ${minCorrespondences} are needed before the fit has anything to check itself against.`,
    }
  }

  const fit = umeyamaSimilarity(source, target)
  if (fit.degenerate || fit.spreadRatio < COLLINEAR_SPREAD_RATIO) {
    return {
      ok: false,
      sessionId,
      reason: 'collinear',
      correspondenceCount,
      spreadRatio: fit.spreadRatio,
      message: fit.degenerate
        ? `The solved camera positions of ${sessionId} are all in one place, so there is nothing to fit a turn or a size to.`
        : `The solved camera positions of ${sessionId} lie on a line (spread ratio ${fit.spreadRatio.toExponential(2)}), ` +
          'which leaves the turn about that line undetermined and shows no residual.',
    }
  }
  if (!(fit.scale > 0) || !Number.isFinite(fit.scale)) {
    return {
      ok: false,
      sessionId,
      reason: 'degenerate-scale',
      correspondenceCount,
      spreadRatio: fit.spreadRatio,
      residualSessionUnits: fit.residualM,
      message: `The fit for ${sessionId} came out with a scale of ${fit.scale}, which cannot size anything.`,
    }
  }
  if (!(fit.residualM <= maxResidualM)) {
    return {
      ok: false,
      sessionId,
      reason: 'high-residual',
      correspondenceCount,
      spreadRatio: fit.spreadRatio,
      umeyamaScale: 1 / fit.scale,
      residualSessionUnits: fit.residualM,
      message: `The solved and recorded camera paths of ${sessionId} disagree by ${fit.residualM.toFixed(3)} ` +
        `(RMS, in the session's own units), past the ${maxResidualM} limit, so this fit is not trustworthy.`,
    }
  }

  const sessionToSolver = invertSim3({ rotation: fit.rotation, translation: fit.translation, scale: fit.scale })
  const r = sessionToSolver.rotation
  return {
    ok: true,
    sessionId,
    sessionToSolver,
    residualSessionUnits: fit.residualM,
    correspondenceCount,
    spreadRatio: fit.spreadRatio,
    upAxisInSolver: [r[0]![1]!, r[1]![1]!, r[2]![1]!],
    files,
  }
}

// ─── Registering sessions to the reference ───────────────────────────────────

/** The session whose calibration defines the Place frame. */
export interface ReferenceSession {
  sessionId: string
  /** Its scan's `sessionToProject`, column-major. Rigid by the app's convention; any similarity is read. */
  sessionToProject: readonly number[]
  fit: SessionFitResult
}

export interface SessionRegistration {
  ok: true
  sessionId: string
  /** `T_new->Place`: the session's AR frame into the Place frame, through the solve. */
  sessionToPlace: Sim3
  /**
   * `sessionToPlace` as THREE reads it, the convention of `sessionToProject`. Its scale is `sessionToPlace.scale`: the
   * reference calibration's own scale (1 for an AR session) times `scaleRatioToReference`.
   */
  sessionToPlaceColumnMajor: number[]
  /** `sessionToPlace` in the layout of `SplatAlignManifest.projectTransform`. */
  sessionToPlaceRowMajor: number[]
  /** `scale_s`: solver units per unit of this session's AR frame. */
  umeyamaScale: number
  /**
   * `scale_s / scale_ref`: how many units of the reference's frame one unit of this session is, the unit mismatch
   * between the two runtimes. 1 for the reference. Away from 1, the two sessions' runtimes do not agree on what a unit
   * is, and a rigid placement would size the scan wrongly. It does not include the scale of the reference's own
   * calibration (1 for an AR session), which `sessionToPlace.scale` does.
   */
  scaleRatioToReference: number
  residualSessionUnits: number
  /** The same residual in Place metres: `residualSessionUnits * sessionToPlace.scale`. */
  residualPlaceM: number
  correspondenceCount: number
  spreadRatio: number
  upAxisInSolver: Vec3Tuple
  /**
   * The angle between this session's up axis and the reference's, degrees, as the solve places them: 0 when the two
   * gravity-aligned frames stay parallel, which a correct registration keeps to the noise of the fits. At most
   * `maxTiltDeg` here, or the registration is refused ({@link MAX_UP_AXIS_TILT_DEG}).
   */
  tiltDeg: number
}

export type RegistrationRefusal = SessionFitRefusal | 'reference-unusable' | 'up-axis-disagrees'

export interface SessionRegistrationRefused {
  ok: false
  sessionId: string
  reason: RegistrationRefusal
  message: string
  correspondenceCount: number
  /** The fit's own refusal, when the fit is what failed. */
  fit?: SessionFitRefused
  /** The two up axes' disagreement, degrees, when that is what refused it. */
  tiltDeg?: number
}

export interface RegistrationOptions {
  /** Refuse a session whose up axis tips more than this against the reference's, degrees. Default {@link MAX_UP_AXIS_TILT_DEG}. */
  maxTiltDeg?: number
}

/**
 * The most the up axes of a session and the reference may disagree through the solve, degrees, before the session is
 * refused. Every AR frame is gravity-aligned, so two correct registrations agree to the noise of the two fits.
 *
 * **Adopted, not measured on a device (ADR 0005 rule 5); simulated.** Correct registrations, 4,000 per cell, per-axis AR
 * noise 1 to 8 cm, loops of radius 0.6 to 2.5 m, 4 to 14 frames: the median disagreement was 0.2 to 9 degrees, and the
 * 95th percentile was within 5 degrees at 1 cm of noise for every loop, at 3 cm for loops of 1.2 m or more, and at 5 cm
 * for loops of 2.5 m (and of 1.2 m with 8 frames or more). Garbage (frames placed at random in the room, or 0.5 m off
 * their true places) passed the residual gate alone in 0.5% and 7% of fits of 4 frames, 0.01% and 1.1% of 5, 0 and 0.2%
 * of 6, and none of 8 or more; with this gate as well, 0.01% and 0.35% of 4, and fewer beyond. So it costs a correct
 * registration of a small, noisy path (which tips its fit by more than this for want of a lever arm, and would misplace
 * what is far from it) and takes the false accepts of a handful of wrong frames down by 95% or more. **Revisit when** DX2
 * gives the real noise of the AR poses and DX9 the registrations a person would have accepted.
 */
export const MAX_UP_AXIS_TILT_DEG = 5

export type SessionRegistrationResult = SessionRegistration | SessionRegistrationRefused

/**
 * Register each session to the reference: `T_ref . Sim_ref^-1 . Sim_s` for every session `s`, and nothing else.
 *
 * Results come back in the order the sessions came in. A session whose own fit was refused is refused with that
 * refusal. A session whose up axis the solve tips more than `maxTiltDeg` against the reference's is refused with
 * `'up-axis-disagrees'` and the angle. A reference that is unusable (its fit was refused, or its `sessionToProject` is
 * not a similarity) refuses every session with `'reference-unusable'` and says why, because without it there is no
 * Place frame to register to. The reference registered to itself is `T_ref` exactly and is not returned here: it is not
 * a registration.
 */
export function registerSessionsToReference(
  reference: ReferenceSession,
  sessions: ReadonlyArray<{ sessionId: string; fit: SessionFitResult }>,
  options: RegistrationOptions = {},
): SessionRegistrationResult[] {
  const maxTiltDeg = options.maxTiltDeg ?? MAX_UP_AXIS_TILT_DEG
  const placeFromReference = sim3FromColumnMajor(reference.sessionToProject)
  let unusable: string | null = null
  if (!reference.fit.ok) unusable = `The reference ${reference.sessionId} could not be fitted to the solve: ${reference.fit.message}`
  else if (!placeFromReference) {
    unusable = `The calibration of the reference ${reference.sessionId} is not a similarity (a rotation, a uniform scale and a translation).`
  }

  return sessions.map((session): SessionRegistrationResult => {
    if (unusable || !reference.fit.ok || !placeFromReference) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'reference-unusable',
        message: unusable ?? 'The reference is unusable.',
        correspondenceCount: session.fit.correspondenceCount,
      }
    }
    if (!session.fit.ok) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: session.fit.reason,
        message: session.fit.message,
        correspondenceCount: session.fit.correspondenceCount,
        fit: session.fit,
      }
    }
    const tiltDeg = angleBetweenDeg(reference.fit.upAxisInSolver, session.fit.upAxisInSolver)
    if (!(tiltDeg <= maxTiltDeg)) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'up-axis-disagrees',
        message: `Through the solve, ${session.sessionId} tips ${tiltDeg.toFixed(1)} degrees against the reference ` +
          `${reference.sessionId}, past the ${maxTiltDeg} degree limit. Both sessions have up as +Y, so they should stay ` +
          "parallel; the solve says they do not, so the solve or this session's poses are wrong, and placing the scan " +
          'this way would tip it.',
        correspondenceCount: session.fit.correspondenceCount,
        tiltDeg,
      }
    }
    const sessionToPlace = chainToPlace(placeFromReference, reference.fit.sessionToSolver, session.fit.sessionToSolver)
    const umeyamaScale = session.fit.sessionToSolver.scale
    const scaleRatioToReference = umeyamaScale / reference.fit.sessionToSolver.scale
    return {
      ok: true,
      sessionId: session.sessionId,
      sessionToPlace,
      sessionToPlaceColumnMajor: sim3ToColumnMajor(sessionToPlace),
      sessionToPlaceRowMajor: sim3ToRowMajor(sessionToPlace),
      umeyamaScale,
      scaleRatioToReference,
      residualSessionUnits: session.fit.residualSessionUnits,
      residualPlaceM: session.fit.residualSessionUnits * sessionToPlace.scale,
      correspondenceCount: session.fit.correspondenceCount,
      spreadRatio: session.fit.spreadRatio,
      upAxisInSolver: session.fit.upAxisInSolver,
      tiltDeg,
    }
  })
}

/** The angle between two directions, degrees, from the cross product's length and the dot product: exact near 0 and near 180, where an arccosine is not. */
function angleBetweenDeg(a: Vec3Tuple, b: Vec3Tuple): number {
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return (Math.atan2(cross, dot) * 180) / Math.PI
}

// ─── What the registration would change ──────────────────────────────────────

/** The registration of one scan, set against the placement the scan already has. */
export interface SolverCorrection {
  /**
   * The correction in the Place frame, column-major: where the scan sits now to where the solve puts it, so the new
   * placement is `transform . current`, as for `RegistrationProposal.transform` in src/world/register-proposal.ts.
   * It carries a scale when the sessions' units differ.
   */
  transform: number[]
  /**
   * How far the scan's centre moves across the floor, the turn about up, the height change, and whether those three
   * are inside the limits the scan matcher holds its own corrections to (`MAX_CORRECTION_*` in ./scan_match.ts). The
   * limits do not cover `scale` or `tiltDeg`; they are reported beside it for whoever decides.
   */
  bounded: BoundedCorrection
  /** The correction's uniform scale. 1 when the two sessions agree on units. */
  scale: number
  /**
   * How far the correction tips the up axis, degrees. Both sessions are gravity-aligned AR frames, so a correction
   * between them is a turn about up and a shift; a tilt means the solve and the AR gravity disagree.
   */
  tiltDeg: number
}

/**
 * What registering a scan through the solve would change about where it sits.
 *
 * `sessionToPlace` is the registration ({@link SessionRegistration.sessionToPlace}); `current` is the scan's own
 * calibration, column-major, which is where the scan sits now; `centres` are the scan's recorded camera centres in
 * its session frame, whose centroid is the pivot the move is measured at and whose spread gives the largest shift.
 * Null when `current` is not a similarity or there are no centres.
 *
 * Yaw is the twist of the correction's rotation about +Y by the right-hand rule, the sense `composeYUpTransform` in
 * src/world/geo.ts uses; tilt is the angle that rotation takes +Y to.
 */
export function describeCorrection(
  sessionToPlace: Sim3,
  current: readonly number[],
  centres: readonly Vec3Tuple[],
): SolverCorrection | null {
  const now = sim3FromColumnMajor(current)
  if (!now || centres.length === 0) return null
  const correction = composeSim3(sessionToPlace, invertSim3(now))

  let sum: Vec3Tuple = [0, 0, 0]
  let maxShiftM = 0
  for (const c of centres) {
    const from = applySim3(now, c)
    const to = applySim3(correction, from)
    maxShiftM = Math.max(maxShiftM, Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]))
    sum = [sum[0] + from[0], sum[1] + from[1], sum[2] + from[2]]
  }
  const mean: Vec3Tuple = [sum[0] / centres.length, sum[1] / centres.length, sum[2] / centres.length]
  const moved = applySim3(correction, mean)

  const r = correction.rotation
  const yawDeg = (Math.atan2(r[0]![2]! - r[2]![0]!, r[0]![0]! + r[2]![2]!) * 180) / Math.PI
  // The angle R takes +Y through, from the part of R(+Y) that leaves +Y and the part that stays: an arccosine of r11
  // would lose everything under 1e-6 degrees to rounding, and a correction with no tilt would report one.
  const tiltDeg = (Math.atan2(Math.hypot(r[0]![1]!, r[2]![1]!), r[1]![1]!) * 180) / Math.PI
  const translationM = Math.hypot(moved[0] - mean[0], moved[2] - mean[2])
  const dyM = moved[1] - mean[1]
  const bound = { translationM: MAX_CORRECTION_TRANSLATION_M, yawDeg: MAX_CORRECTION_YAW_DEG, dyM: MAX_CORRECTION_DY_M }
  return {
    transform: sim3ToColumnMajor(correction),
    bounded: {
      translationM,
      yawDeg,
      dyM,
      maxShiftM,
      withinBound: translationM <= bound.translationM && Math.abs(yawDeg) <= bound.yawDeg && Math.abs(dyM) <= bound.dyM,
      bound,
    },
    scale: correction.scale,
    tiltDeg,
  }
}
