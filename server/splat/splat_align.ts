/**
 * Umeyama similarity fit — the stage that puts real metres into a splat.
 *
 * Monocular structure-from-motion is scale-blind. COLMAP (and LingBot-Map
 * before it) reconstructs a room perfectly well *up to an unknown scale
 * factor*, at an arbitrary origin and an arbitrary heading: nothing in a set
 * of images fixes how big the room actually is. So a trained splat could be
 * rendered, but not measured, not placed beside its own mesh, and not fused
 * with a second visit to the same Place.
 *
 * The missing metre stick was already in the session. The *same* keyframes
 * that COLMAP solved also carry capture-time AR poses in the session's own
 * units, and a calibrated scan carries `ScanCalibration.sessionToProject`,
 * whose two-point-ground tier is backed by a physically measured
 * `separationM` (ADR 0005) — that measurement is the evidence the AR
 * session's units really are metres. Two descriptions of one physical camera
 * path: one in SfM units, one in metres. Umeyama (1991) recovers the 7-DoF
 * similarity between them in closed form — rotation (3), translation (3),
 * uniform scale (1).
 *
 * Per ADR 0001 this reuses rather than reinvents:
 *   - the SfM side comes from `readSolvedPoses()` in splat_train_dataset.ts,
 *     the one reader that already serves both COLMAP and LingBot-Map;
 *   - the metric side comes from `readKeyframes()` + `poseToMatrix()`, the
 *     same functions the Brush dataset builder uses;
 *   - the metric frame comes from `ScanCalibration`, not a new calibration
 *     shape;
 *   - the output is a `SplatAlignManifest` extending `PipelineManifestBase`,
 *     written as a sidecar exactly like every other pipeline stage.
 *
 * Per ADR 0005 rule 3 — a status that claims verification must be backed by a
 * measurement — this refuses rather than guesses. Too few correspondences, a
 * camera path too close to a straight line to constrain a rotation, a scale
 * that came out non-positive (the calibrated centres had no extent to scale
 * against), or an RMS residual above `maxResidualM` all yield
 * `status: 'skipped'` with a remediation. A wrong scale is worse than no
 * scale: it silently makes every downstream distance, fusion and measurement
 * wrong while looking fine.
 *
 * Two coordinate conventions meet here and they are NOT the same, so both are
 * named at every boundary below:
 *   - `ScanCalibration.sessionToProject` is **column-major** (built by
 *     `composeYUpTransform`/`anchorToProjectTransform` for THREE.Matrix4,
 *     translation at indices 12/13/14).
 *   - `SplatAlignManifest.projectTransform` is **row-major** (translation at
 *     indices 3/7/11), pinned by that field's doc comment and asserted in
 *     tests/unit/deno/splat_align.test.ts. `THREE.Matrix4.fromArray` reads
 *     column-major, so a consumer must use `Matrix4.set(...)` (which takes
 *     row-major arguments) or transpose — feeding it to `fromArray` transposes
 *     it silently, which is why the convention is tested rather than assumed.
 */

import type { ScanCalibration, SplatAlignManifest } from '../../src/world/types.ts'
import { isServerSessionId } from '../../src/shared/session-id.ts'
import {
  type KeyframeRecord,
  poseToMatrix,
  readKeyframes,
  readSolvedPoses,
  recordHasPose,
} from './splat_train_dataset.ts'

export type Vec3Tuple = [number, number, number]

/**
 * Minimum pairs before a fit is allowed to claim anything. Three points fix a
 * similarity exactly, so four is the first count with any redundancy at all —
 * i.e. the first count where `residualM` is a measurement rather than
 * arithmetic that is zero by construction.
 */
export const DEFAULT_MIN_CORRESPONDENCES = 4

/**
 * RMS residual, in metres, above which the fit is refused.
 *
 * 0.25 m is deliberately loose: it is not a quality bar, it is the line
 * between "the two point sets describe the same camera path" and "these
 * correspondences disagree, so something upstream is wrong" (a mis-paired
 * frame set, a session whose AR tracking drifted, a partial COLMAP model
 * registering a different subset). Tightening it into a quality threshold
 * would need the measurement procedure ADR 0005 rule 5 demands, which nothing
 * here has run.
 */
export const DEFAULT_MAX_RESIDUAL_M = 0.25

/**
 * Rank guard, not a spatial tolerance.
 *
 * `SimilarityFit.spreadRatio` is the second-largest over the largest standard
 * deviation of the source points. It goes to zero exactly when the camera
 * centres become collinear — a capture walked in a straight line — and a
 * collinear correspondence leaves the roll about that line completely
 * unconstrained. That failure is invisible in `residualM`: an arbitrary roll
 * still maps the line onto the line with zero error. So it needs its own
 * check. 1e-3 is a numerical rank test (is the second axis present at all),
 * NOT a measured repeatability threshold in the sense of ADR 0005 rule 5 —
 * a real "is this camera path well-conditioned enough" number would have to
 * be measured on device, and is not claimed here.
 */
export const COLLINEAR_SPREAD_RATIO = 1e-3

/** The 7-DoF similarity that carries `source` onto `target`. */
export interface SimilarityFit {
  /**
   * Proper rotation, row-major 3x3.
   *
   * `det(rotation)` is +1 by construction — U and V are orthonormal and S
   * flips a sign exactly when their determinants disagree — but "by
   * construction" means in exact arithmetic: what is actually asserted is
   * |det − 1| ≤ 1e-9, including for the rank-deficient covariances a collinear
   * capture produces (see {@link svd3}, and the test that pins it). The
   * degenerate paths below return the identity, whose det is exactly 1.
   */
  rotation: number[][]
  translation: Vec3Tuple
  /**
   * Uniform scale: multiply a source-space length by this to get a
   * target-space one.
   *
   * Never negative — tr(D·S)/σx² with `d` sorted descending is d₀+d₁−d₂ ≥ d₀ ≥
   * 0 — but it is exactly **0** when the cross-covariance vanishes, which is
   * what a *target* cloud with no extent gives (every metric centre
   * coincident). `degenerate` does not cover that case: it inspects the source
   * cloud only, and the source is fine. A 0 here is not a small scale, it is a
   * rank-0 transform that collapses the scene to a point, and it fits with a
   * residual of 0 — so {@link runSplatAlign} refuses it explicitly.
   */
  scale: number
  /**
   * RMS of `target_i - (scale * R * source_i + t)` over the correspondence, in
   * whatever units `target` was in. The driver's target is metres, hence the
   * name it carries into the manifest.
   */
  residualM: number
  /**
   * Second-largest ÷ largest standard deviation of the *source* points. ~1 is
   * an isotropic cloud; ~0 means the points are collinear (or coincident) and
   * the rotation about that line is undetermined — see
   * {@link COLLINEAR_SPREAD_RATIO} for why `residualM` cannot catch that.
   */
  spreadRatio: number
  /**
   * True when the fit could not be determined at all: no points, or a source
   * cloud with zero extent (every camera centre identical), which leaves scale
   * with a 0/0. The returned transform is then the identity-rotation,
   * unit-scale, centroid-offset fallback — finite, never NaN, and refused by
   * the driver.
   */
  degenerate: boolean
}

export interface SplatAlignRunOptions {
  /** Absolute path to the session directory (scans/sessions/<id>). */
  sessionDir: string
  /**
   * The scan's calibration. Its `sessionToProject` (column-major) is what
   * moves the capture-time AR poses into the Place's metric frame, and its
   * `method` is recorded so a consumer can judge how much to trust `scale`
   * (ADR 0005 rule 4: the tiers are explicit, not blended). Absent or
   * `'uncalibrated'` means there is no metric side to fit against, which is a
   * skip, not an error.
   */
  calibration?: ScanCalibration | null
  /** Absolute path of the splat this transform describes, when one exists. */
  plyPath?: string
  /** Where the manifest sidecar lands. Defaults next to `plyPath`, else in the session dir. */
  manifestPath?: string
  /** Refuse below this many paired camera centres. Default {@link DEFAULT_MIN_CORRESPONDENCES}. */
  minCorrespondences?: number
  /** Refuse above this RMS residual, in metres. Default {@link DEFAULT_MAX_RESIDUAL_M}. */
  maxResidualM?: number
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
}

export type SplatAlignStatus = 'ok' | 'skipped' | 'error'

export interface SplatAlignResult {
  status: SplatAlignStatus
  manifest: SplatAlignManifest
  /** Absolute path of the manifest sidecar this run wrote (or tried to). */
  manifestPath: string
  /** Row-major 4x4 SfM → project, when status is 'ok'. */
  projectTransform?: number[]
  scale?: number
  residualM?: number
  correspondenceCount?: number
}

// ─── The fit ─────────────────────────────────────────────────────────────────

/**
 * Umeyama's closed-form least-squares similarity between two ordered point
 * sets (Umeyama 1991, "Least-Squares Estimation of Transformation Parameters
 * Between Two Point Patterns", IEEE PAMI 13(4)).
 *
 * Minimises Σ‖yᵢ − (c·R·xᵢ + t)‖² over a proper rotation R, a translation t
 * and a single positive scale c:
 *
 *   μx, μy  = centroids
 *   σx²     = (1/n)·Σ‖xᵢ − μx‖²                  (source variance)
 *   Σxy     = (1/n)·Σ(yᵢ − μy)(xᵢ − μx)ᵀ         (cross-covariance, 3x3)
 *   Σxy     = U·D·Vᵀ                             (SVD)
 *   S       = I, except S₂₂ = −1 when det(U)·det(V) < 0
 *   R       = U·S·Vᵀ,  c = tr(D·S)/σx²,  t = μy − c·R·μx
 *
 * **The S correction is the whole reason this is not just "SVD the
 * covariance".** Without it the minimiser is free to return a *reflection*
 * (det = −1) whenever the data is noisy or nearly degenerate, and a reflected
 * transform mirrors the scene: it still fits the correspondence about as well,
 * renders without complaint, and is wrong in a way no residual reports.
 * Flipping the sign of the smallest singular direction is the cheapest change
 * that restores det(R) = +1, which is exactly what Umeyama's theorem proves is
 * optimal among proper rotations.
 *
 * Pure and dependency-free — the 3x3 SVD below is local, so this runs in a
 * unit test with no external linear-algebra package.
 */
export function umeyamaSimilarity(source: number[][], target: number[][]): SimilarityFit {
  const n = Math.min(source.length, target.length)
  if (n === 0) {
    return {
      rotation: identity3(),
      translation: [0, 0, 0],
      scale: 1,
      residualM: 0,
      spreadRatio: 0,
      degenerate: true,
    }
  }

  const src = source.slice(0, n).map(toVec3)
  const dst = target.slice(0, n).map(toVec3)

  const muX = centroid(src)
  const muY = centroid(dst)

  // Source variance and cross-covariance in one pass.
  let varX = 0
  const sigma = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let k = 0; k < n; k++) {
    const dx: Vec3Tuple = [src[k][0] - muX[0], src[k][1] - muX[1], src[k][2] - muX[2]]
    const dy: Vec3Tuple = [dst[k][0] - muY[0], dst[k][1] - muY[1], dst[k][2] - muY[2]]
    varX += dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) sigma[i][j] += dy[i] * dx[j]
    }
  }
  varX /= n
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) sigma[i][j] /= n
  }

  const spreadRatio = sourceSpreadRatio(src, muX)

  // A source cloud with no extent gives scale a 0/0. Nothing can be recovered
  // from it, so return the finite centroid-offset fallback and say so — the
  // caller refuses on `degenerate` rather than propagating a NaN matrix into a
  // manifest, where it would serialise as `null` and be even harder to trace.
  if (!(varX > 0)) {
    const translation: Vec3Tuple = [muY[0] - muX[0], muY[1] - muX[1], muY[2] - muX[2]]
    return {
      rotation: identity3(),
      translation,
      scale: 1,
      residualM: rmsResidual(src, dst, identity3(), translation, 1),
      spreadRatio,
      degenerate: true,
    }
  }

  const { u, d, v } = svd3(sigma)

  // Reflection correction. det(U)·det(V) < 0 means the raw U·Vᵀ is a mirror,
  // so flip the direction with the least energy in it (the last singular
  // value, which is why `svd3` returns them sorted descending).
  const s3 = det3(u) * det3(v) < 0 ? -1 : 1
  const S = [[1, 0, 0], [0, 1, 0], [0, 0, s3]]
  const rotation = matMul3(matMul3(u, S), transpose3(v))

  // tr(D·S) with D = diag(d): the flipped axis contributes with its sign.
  const scale = (d[0] + d[1] + s3 * d[2]) / varX

  const rMu = matVec3(rotation, muX)
  const translation: Vec3Tuple = [
    muY[0] - scale * rMu[0],
    muY[1] - scale * rMu[1],
    muY[2] - scale * rMu[2],
  ]

  return {
    rotation,
    translation,
    scale,
    residualM: rmsResidual(src, dst, rotation, translation, scale),
    spreadRatio,
    degenerate: false,
  }
}

/**
 * Fold the fit into the **row-major** 4x4 the manifest's `projectTransform`
 * field is specified as — scale multiplied into the rotation block, so a
 * consumer applies one matrix and gets metres:
 *
 *   [ s·r00 s·r01 s·r02 tx ]
 *   [ s·r10 s·r11 s·r12 ty ]
 *   [ s·r20 s·r21 s·r22 tz ]
 *   [   0     0     0    1 ]
 *
 * Row-major means the translation lands at indices 3/7/11, NOT 12/13/14.
 * `THREE.Matrix4.fromArray` expects column-major and would transpose this
 * silently; `THREE.Matrix4.set(...)` takes row-major arguments and is the
 * correct consumer. Asserted in splat_align.test.ts.
 */
export function similarityToRowMajor(fit: SimilarityFit): number[] {
  const { rotation: r, translation: t, scale: s } = fit
  return [
    s * r[0][0], s * r[0][1], s * r[0][2], t[0],
    s * r[1][0], s * r[1][1], s * r[1][2], t[1],
    s * r[2][0], s * r[2][1], s * r[2][2], t[2],
    0, 0, 0, 1,
  ]
}

// ─── Correspondence extraction ───────────────────────────────────────────────

/**
 * Camera centres in the Place's metric project frame, keyed by keyframe
 * filename.
 *
 * `poseToMatrix` gives a row-major camera-to-world whose 4th column is the
 * camera centre in the AR session's own local frame; `sessionToProject` then
 * carries that into project space. That matrix is **column-major** (THREE
 * convention — see `composeYUpTransform` in src/world/geo.ts, which writes the
 * translation at 12/13/14), and reading it row-major would produce a plausible
 * wrong answer rather than an error, so the indexing is spelled out in
 * {@link applyColumnMajor} rather than inlined.
 *
 * Records with no capture-time pose are skipped: those are the photo/video
 * ingest sessions, which have no metric side at all.
 */
export function metricCentresFromKeyframes(
  records: KeyframeRecord[],
  sessionToProject: number[],
): Map<string, Vec3Tuple> {
  const out = new Map<string, Vec3Tuple>()
  for (const rec of records) {
    const file = rec.file
    if (typeof file !== 'string' || !file) continue
    if (!recordHasPose(rec)) continue
    const m = poseToMatrix(rec.pose ?? {})
    const local: Vec3Tuple = [m[0][3], m[1][3], m[2][3]]
    const projected = applyColumnMajor(sessionToProject, local)
    if (!projected.every(Number.isFinite)) continue
    out.set(file, projected)
  }
  return out
}

/**
 * Camera centres from a solved pose file, keyed by keyframe filename.
 *
 * `readSolvedPoses` has already done the OpenCV world-to-camera → OpenGL
 * camera-to-world conversion (`openCvW2cToC2w`), so the centre is just the
 * translation column — the same quantity `buildBrushDataset` feeds Brush. Not
 * re-deriving it here is the point: one conversion, two consumers (ADR 0001).
 */
export function sfmCentresFromPoses(poses: Map<string, number[][]>): Map<string, Vec3Tuple> {
  const out = new Map<string, Vec3Tuple>()
  for (const [file, m] of poses) {
    const centre: Vec3Tuple = [m[0][3], m[1][3], m[2][3]]
    if (!centre.every(Number.isFinite)) continue
    out.set(file, centre)
  }
  return out
}

/**
 * Pair two centre maps **by keyframe filename**.
 *
 * Not by index, and not by sort order: COLMAP registers a subset of the
 * offered images and emits them in its own order, so the k-th solved pose is
 * routinely not the k-th keyframe. Pairing positionally would fit a
 * correspondence between different physical viewpoints — which produces a
 * confident, completely wrong scale rather than an error. The returned arrays
 * are ordered by filename so a re-run over the same session yields a
 * bit-identical transform.
 */
export function pairByFilename(
  sfm: Map<string, Vec3Tuple>,
  metric: Map<string, Vec3Tuple>,
): { files: string[]; source: Vec3Tuple[]; target: Vec3Tuple[] } {
  const files = [...sfm.keys()].filter((f) => metric.has(f)).sort()
  return {
    files,
    source: files.map((f) => sfm.get(f)!),
    target: files.map((f) => metric.get(f)!),
  }
}

// ─── Driver ──────────────────────────────────────────────────────────────────

/**
 * Fit a session's solved SfM poses to its calibrated metric poses and write a
 * `SplatAlignManifest` sidecar.
 *
 * Every refusal path is a `skipped` with a remediation, never a thrown error:
 * this stage is optional in exactly the way splat-train's missing binary is —
 * the scan is still usable, it just has no metric scale yet, and the operator
 * needs to be told which input was missing.
 */
export async function runSplatAlign(opts: SplatAlignRunOptions): Promise<SplatAlignResult> {
  const started = Date.now()
  const params = {
    minCorrespondences: opts.minCorrespondences ?? DEFAULT_MIN_CORRESPONDENCES,
    maxResidualM: opts.maxResidualM ?? DEFAULT_MAX_RESIDUAL_M,
  }
  const manifestPath = opts.manifestPath ?? defaultManifestPath(opts)

  const base: SplatAlignManifest = {
    schemaVersion: 1,
    tool: 'umeyama',
    status: 'error',
    createdAt: new Date().toISOString(),
    sessionId: opts.provenance?.sessionId ?? opts.sessionDir.split('/').filter(Boolean).pop(),
    scanId: opts.provenance?.scanId,
    plyPath: opts.plyPath?.split('/').pop(),
    calibrationMethod: opts.calibration?.method,
    params,
  }

  if (!isValidSessionDir(opts.sessionDir)) {
    return await finish(manifestPath, { ...base, status: 'error', error: 'invalid session directory' }, started)
  }

  // 1. The metric frame. No calibration means the only "metres" available
  //    would be the AR runtime's own unverified units — claiming a metric
  //    scale from those is precisely the unbacked claim ADR 0005 rule 3
  //    forbids, so refuse and say what to do about it.
  const sessionToProject = opts.calibration?.sessionToProject
  if (!opts.calibration || opts.calibration.status === 'uncalibrated' || !isMatrix16(sessionToProject)) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      skippedReason: 'scan has no calibrated metric frame — nothing establishes what a metre is in this session',
      remediation:
        'Run the two-point ground calibration on this scan (it carries a physically measured separation), then re-run splat-align.',
    }, started)
  }

  // 2. The SfM side. Prefers colmap.poses.json, falls back to
  //    lingbot-map.poses.json — both are scale-free reconstructions and both
  //    need this fit, so one reader serves both (ADR 0001).
  const solved = await readSolvedPoses(opts.sessionDir)
  if (!solved) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      skippedReason: 'no solved camera poses in the session (neither colmap.poses.json nor lingbot-map.poses.json)',
      remediation: 'Queue a colmap-poses job on this session first — it runs on CPU and needs no GPU.',
    }, started)
  }

  // 3. The metric side: capture-time AR poses, carried into project space.
  const metric = metricCentresFromKeyframes(await readKeyframes(opts.sessionDir), sessionToProject)
  if (metric.size === 0) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      skippedReason: 'no keyframe carries a capture-time pose — this session has no metric camera path to fit against',
      remediation:
        'Re-capture with AR tracking active. Photo- and video-ingest sessions have no metric reference and cannot be scaled this way.',
    }, started)
  }

  const { source, target } = pairByFilename(sfmCentresFromPoses(solved), metric)
  const correspondenceCount = source.length

  if (correspondenceCount < params.minCorrespondences) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      correspondenceCount,
      skippedReason:
        `only ${correspondenceCount} keyframe(s) have both a solved and a calibrated pose — ` +
        `${params.minCorrespondences} are needed before the fit has any redundancy to measure`,
      remediation:
        'Re-run the pose solve so it registers more of the capture, or capture more keyframes while AR tracking is held.',
    }, started)
  }

  const fit = umeyamaSimilarity(source, target)

  // 4. Conditioning. A collinear camera path fits with a near-zero residual
  //    and a meaningless roll, so this has to be checked separately from the
  //    residual — see COLLINEAR_SPREAD_RATIO.
  if (fit.degenerate || fit.spreadRatio < COLLINEAR_SPREAD_RATIO) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      correspondenceCount,
      skippedReason:
        `the solved camera centres are collinear (spread ratio ${fit.spreadRatio.toExponential(2)}) — ` +
        'a straight-line path leaves the rotation about that line undetermined, and the residual cannot detect it',
      remediation: 'Re-capture walking a path with turns in it, so the camera centres span more than one direction.',
    }, started)
  }

  // 5. Scale. Checked BEFORE the residual, because a zero scale sails through
  //    the residual gate: the rank-0 transform maps every source point onto
  //    the single target point, so `residualM` is 0 and the fit looks perfect.
  //    It happens when the *calibrated* centres have no extent — every
  //    keyframe carrying a present-but-all-zero pose block maps to the same
  //    project-space point, and `recordHasPose` accepts such a block — which
  //    zeroes the cross-covariance. `fit.degenerate` does not catch it either:
  //    that flag inspects the source cloud, which here is perfectly spread.
  //    Publishing this would hand the viewer a matrix that collapses the splat
  //    to a point under a manifest that says `ok`, which is exactly the
  //    unbacked claim ADR 0005 rule 3 forbids.
  if (!(fit.scale > 0) || !Number.isFinite(fit.scale)) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      correspondenceCount,
      residualM: fit.residualM,
      // No `scale` field on purpose: 0 is not a scale, and a consumer reading
      // `manifest.scale` should find nothing rather than a number that would
      // silently collapse whatever it multiplies. The value is in the reason.
      skippedReason:
        `the fit resolved to a scale of ${fit.scale}, which cannot size anything — the transform ` +
        'would collapse (or blow up) the splat rather than scale it. A scale of exactly 0 is what a ' +
        'calibrated camera path with no extent produces, every keyframe landing on one point; its ' +
        `${fit.residualM.toFixed(3)}m residual is arithmetic, not agreement.`,
      remediation:
        'Check that the capture-time poses actually differ between keyframes — a session whose pose blocks are present but all zero never tracked. Re-capture with AR tracking held, then re-run splat-align.',
    }, started)
  }

  // 6. The measurement that backs the claim. Above this, the two point sets
  //    are not describing the same camera path and the scale would be a
  //    confident fiction.
  if (!(fit.residualM <= params.maxResidualM)) {
    return await finish(manifestPath, {
      ...base,
      status: 'skipped',
      correspondenceCount,
      residualM: fit.residualM,
      scale: fit.scale,
      skippedReason:
        `fit residual ${fit.residualM.toFixed(3)}m exceeds the ${params.maxResidualM}m limit — ` +
        'the solved and calibrated camera paths disagree, so this scale is not trustworthy',
      remediation:
        'Check that the pose solve covers this capture (a partial COLMAP model registers a different subset) and that AR tracking did not drift mid-scan.',
    }, started)
  }

  const projectTransform = similarityToRowMajor(fit)
  const manifest: SplatAlignManifest = {
    ...base,
    status: 'ok',
    projectTransform,
    scale: fit.scale,
    residualM: fit.residualM,
    correspondenceCount,
  }
  return await finish(manifestPath, manifest, started, {
    projectTransform,
    scale: fit.scale,
    residualM: fit.residualM,
    correspondenceCount,
  })
}

/** Shares `SESSION_ID_RE` with the other drivers rather than re-deriving it. */
export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return isServerSessionId(base)
}

/**
 * `<base>.splat-align.manifest.json` beside the splat when there is one (the
 * convention splat_train/detect/finish already use), else in the session dir,
 * where the inputs live.
 */
function defaultManifestPath(opts: SplatAlignRunOptions): string {
  if (opts.plyPath) return `${opts.plyPath.replace(/\.splat\.ply$/, '')}.splat-align.manifest.json`
  return `${opts.sessionDir}/splat-align.manifest.json`
}

async function finish(
  manifestPath: string,
  manifest: SplatAlignManifest,
  started: number,
  extra: Partial<SplatAlignResult> = {},
): Promise<SplatAlignResult> {
  const withTiming: SplatAlignManifest = { ...manifest, timing: { elapsedMs: Date.now() - started } }
  try {
    await Deno.writeTextFile(manifestPath, JSON.stringify(withTiming, null, 2))
  } catch (e) {
    // A session dir that vanished mid-run must not mask the real result — the
    // caller still gets the status it asked for.
    console.warn('[splat-align] failed to write manifest:', e)
  }
  return { status: withTiming.status, manifest: withTiming, manifestPath, ...extra }
}

// ─── Linear algebra (local: no external SVD dependency) ──────────────────────

/**
 * Apply a **column-major** 4x4 (the `ScanCalibration.sessionToProject` /
 * THREE.Matrix4 layout) to a point. Column c of the basis lives at indices
 * 4c..4c+2 and the translation at 12/13/14 — the same indexing
 * `anchorToProjectTransform` writes in src/world/geo.ts.
 */
export function applyColumnMajor(m: number[], p: Vec3Tuple): Vec3Tuple {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
}

/**
 * Singular value decomposition of a 3x3, M = U·diag(d)·Vᵀ, with `d` sorted
 * descending. No external dependency: at this size the symmetric eigenproblem
 * of MᵀM is solved by a handful of Jacobi rotations, and U follows from
 * uᵢ = M·vᵢ/dᵢ.
 *
 * The care here is all in the rank-deficient cases, which are the ones this
 * module actually hits (a collinear camera path makes the cross-covariance
 * rank 1). Two distinct things go wrong there, and both are detected rather
 * than assumed away:
 *
 *   - an *exactly* zero singular value leaves its left vector undefined by the
 *     uᵢ = M·vᵢ/dᵢ route — 0/0;
 *   - a *numerically* zero one is worse, because it looks fine: MᵀM hands back
 *     the exact zeros as ~1e-17, whose square roots (~3e-9) clear any sane
 *     relative rank threshold, and dividing rounding noise by them yields a
 *     unit-length direction made entirely of last bits — which for a rank-1 M
 *     lands back inside the span already taken.
 *
 * Both show up the same way (the Gram-Schmidt residual collapses instead of
 * staying near 1), and both are filled from {@link completeBasis}, which is
 * perpendicular to *everything* accepted so far — not just the first vector.
 * That distinction is the whole fix: two columns filled independently from
 * `anyPerpendicular(basis[0])` are the same vector, which made U singular and
 * dropped det(U·S·Vᵀ) to 0 for every rank-1 cross-covariance.
 *
 * U is therefore orthonormal and finite, which is what keeps det(U)·det(V)
 * meaningful and the caller free of NaN. "Orthonormal" here means to
 * floating-point rounding, not exactly: max|UᵀU − I| is asserted below 1e-9
 * over full-rank, rank-2, rank-1 and zero matrices in
 * tests/unit/deno/splat_align.test.ts.
 */
export function svd3(m: number[][]): { u: number[][]; d: number[]; v: number[][] } {
  const ata = matMul3(transpose3(m), m)
  const { values, vectors } = jacobiEigenSym3(ata)

  // Sort descending — Umeyama's reflection correction flips the *smallest*
  // singular direction, so which one is last is load-bearing, not cosmetic.
  const order = [0, 1, 2].sort((a, b) => values[b] - values[a])
  const d = order.map((i) => Math.sqrt(Math.max(values[i], 0)))
  const v = [0, 1, 2].map((row) => order.map((i) => vectors[row][i]))

  const uCols: Array<Vec3Tuple | null> = [null, null, null]
  // Relative rank threshold: anything this far below the largest singular
  // value carries no direction information worth dividing by.
  const tol = d[0] * 1e-9
  const basis: Vec3Tuple[] = []
  for (let i = 0; i < 3; i++) {
    if (!(d[i] > tol) || d[i] === 0) continue
    const vi: Vec3Tuple = [v[0][i], v[1][i], v[2][i]]
    const mv = matVec3(m, vi)
    // Gram-Schmidt against everything accepted so far. In exact arithmetic the
    // left singular vectors are already orthogonal, so the surviving length is
    // 1; a length far below 1 says this direction is numerically inside the
    // span we already hold, i.e. it is rounding noise amplified by a division
    // by a near-zero singular value. Drop it and let `completeBasis` fill the
    // column — that direction is scaled by (near) zero, so the choice is free,
    // but orthogonality is not.
    //
    // The SIGN of an accepted vector is never touched: u_i must stay the true
    // left singular vector, because det(U) is what tells the caller a
    // reflection is present. Forcing U right-handed here would make every
    // mirrored fit look proper and silently flip the scene.
    const o = orthogonalise([mv[0] / d[i], mv[1] / d[i], mv[2] / d[i]], basis)
    const len = Math.hypot(o[0], o[1], o[2])
    // 1e-6 is NOT a clean separator between "real direction" and "noise" —
    // measured over the fixture set the test pins, the two populations abut it
    // (largest rejected length 9.98e-7, smallest accepted 1.00e-6). It does not
    // need to be one. Both branches produce an orthonormal column, so the
    // choice is only ever between two arbitrary fills of a direction that
    // carries nothing: over that same set the largest singular value attached
    // to a *rejected* direction was 1.6e-8 of d[0]. What the threshold buys is
    // the guarantee that a direction which is numerically inside the span
    // already held never gets normalised into the basis twice.
    if (!(len > 1e-6)) continue
    const unit: Vec3Tuple = [o[0] / len, o[1] / len, o[2] / len]
    uCols[i] = unit
    basis.push(unit)
  }

  // M is (numerically) the zero matrix: every direction is as good as any.
  if (basis.length === 0) return { u: identity3(), d: [0, 0, 0], v }

  // Complete the basis for every column left unfilled. Those directions are
  // scaled by (numerically) zero, so M = U·diag(d)·Vᵀ holds for either sign of
  // the filled column — and R = U·S·Vᵀ is invariant to the choice too, since
  // flipping the column also flips the S entry the det-correction assigns it.
  for (let i = 0; i < 3; i++) {
    if (uCols[i]) continue
    const filled = completeBasis(basis)
    uCols[i] = filled
    basis.push(filled)
  }

  const u = [0, 1, 2].map((row) => [uCols[0]![row], uCols[1]![row], uCols[2]![row]])
  return { u, d, v }
}

/**
 * Cyclic Jacobi eigendecomposition of a symmetric 3x3, returning eigenvalues
 * and the matching eigenvectors as the **columns** of `vectors`.
 *
 * Jacobi is the right tool at this size: it is a dozen lines, it is backward
 * stable, and it handles repeated eigenvalues (which a collinear or planar
 * point set produces) without the special-casing a closed-form cubic needs.
 * The sweep count is bounded so a pathological input terminates rather than
 * spinning.
 */
export function jacobiEigenSym3(matrix: number[][]): { values: number[]; vectors: number[][] } {
  const a = matrix.map((row) => [...row])
  const v = identity3()

  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2])
    const diag = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2])
    if (off <= 1e-18 * Math.max(diag, Number.MIN_VALUE)) break

    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p][q]
      if (apq === 0) continue
      // Annihilate a[p][q]: tan of the rotation solves t² + 2θt − 1 = 0.
      const theta = (a[q][q] - a[p][p]) / (2 * apq)
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c

      const app = a[p][p]
      const aqq = a[q][q]
      a[p][p] = app - t * apq
      a[q][q] = aqq + t * apq
      a[p][q] = 0
      a[q][p] = 0

      const r = 3 - p - q // the untouched index
      const arp = a[r][p]
      const arq = a[r][q]
      a[r][p] = c * arp - s * arq
      a[p][r] = a[r][p]
      a[r][q] = s * arp + c * arq
      a[q][r] = a[r][q]

      for (let row = 0; row < 3; row++) {
        const vrp = v[row][p]
        const vrq = v[row][q]
        v[row][p] = c * vrp - s * vrq
        v[row][q] = s * vrp + c * vrq
      }
    }
  }

  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v }
}

/** Second-largest ÷ largest standard deviation of a point set. See COLLINEAR_SPREAD_RATIO. */
function sourceSpreadRatio(points: Vec3Tuple[], mu: Vec3Tuple): number {
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of points) {
    const d: Vec3Tuple = [p[0] - mu[0], p[1] - mu[1], p[2] - mu[2]]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) c[i][j] += d[i] * d[j]
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) c[i][j] /= points.length
  }
  const eig = jacobiEigenSym3(c).values.map((x) => Math.max(x, 0)).sort((a, b) => b - a)
  if (!(eig[0] > 0)) return 0
  return Math.sqrt(eig[1] / eig[0])
}

function rmsResidual(
  src: Vec3Tuple[],
  dst: Vec3Tuple[],
  rotation: number[][],
  translation: Vec3Tuple,
  scale: number,
): number {
  let sum = 0
  for (let k = 0; k < src.length; k++) {
    const r = matVec3(rotation, src[k])
    for (let i = 0; i < 3; i++) {
      const e = dst[k][i] - (scale * r[i] + translation[i])
      sum += e * e
    }
  }
  return Math.sqrt(sum / src.length)
}

function centroid(points: Vec3Tuple[]): Vec3Tuple {
  const c: Vec3Tuple = [0, 0, 0]
  for (const p of points) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length]
}

function toVec3(p: number[]): Vec3Tuple {
  return [num(p?.[0]), num(p?.[1]), num(p?.[2])]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function identity3(): number[][] {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
}

function matMul3(a: number[][], b: number[][]): number[][] {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return out
}

function transpose3(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ]
}

function matVec3(m: number[][], p: Vec3Tuple): Vec3Tuple {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
  ]
}

export function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function normalise(v: Vec3Tuple): Vec3Tuple {
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [1, 0, 0]
}

/**
 * Gram-Schmidt: strip the components of `v` lying along `basis`. Returns the
 * raw residual, unnormalised — its *length* is the caller's rank signal (see
 * {@link svd3}), so normalising here would throw away the only evidence that
 * the direction was noise.
 */
function orthogonalise(v: Vec3Tuple, basis: Vec3Tuple[]): Vec3Tuple {
  const out: Vec3Tuple = [v[0], v[1], v[2]]
  for (const b of basis) {
    const d = out[0] * b[0] + out[1] * b[1] + out[2] * b[2]
    out[0] -= d * b[0]
    out[1] -= d * b[1]
    out[2] -= d * b[2]
  }
  return out
}

/**
 * A unit vector perpendicular to **every** vector in `basis` — which holds at
 * most two, since the third completes the frame.
 *
 * Perpendicular to *every* one, not just `basis[0]`, is the entire point: a
 * rank-1 M leaves two columns of U to fill, and filling both from
 * `anyPerpendicular(basis[0])` yields the same vector twice, a singular U, and
 * a det(U·S·Vᵀ) of 0 where the caller's doc comment promises +1.
 */
function completeBasis(basis: Vec3Tuple[]): Vec3Tuple {
  if (basis.length === 0) return [1, 0, 0]
  if (basis.length === 1) return anyPerpendicular(basis[0])
  return normalise(cross(basis[0], basis[1]))
}

/** Some unit vector perpendicular to `v`, chosen off the least-aligned axis. */
function anyPerpendicular(v: Vec3Tuple): Vec3Tuple {
  const axis: Vec3Tuple = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return normalise(cross(v, axis))
}

function isMatrix16(m: unknown): m is number[] {
  return Array.isArray(m) && m.length === 16 && m.every((v) => typeof v === 'number' && Number.isFinite(v))
}
