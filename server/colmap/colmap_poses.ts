/**
 * COLMAP pose-solver driver — the CPU pose source for pose-less sessions.
 *
 * Why this exists: `buildBrushDataset` needs a camera pose per keyframe, and
 * until now the only fallback for sessions whose keyframes carry none (every
 * `photo-ingest` session, and video ingest generally) was
 * `lingbot-map.poses.json`. That file is produced by a GPU-bound Python
 * worker, so on any host without it the whole splat chain died at
 * "no camera poses" before Brush was ever reached — the trainer was never the
 * blocker. COLMAP solves the same problem with structure-from-motion on CPU,
 * which means a scan can reconstruct end-to-end on a laptop.
 *
 * Per ADR 0001 this deliberately does **not** invent a new pose format: it
 * writes `colmap.poses.json` in the exact shape `lingbot-map.poses.json`
 * already uses (OpenCV world-to-camera 3×4 under the key `cameraToWorld`),
 * and a `colmap.point-cloud.ply` seed cloud mirroring
 * `lingbot-map.point-cloud.ply`. One reader and one conversion in
 * splat_train_dataset.ts serve both producers.
 *
 * The two-pass mapper is not incidental. A single `colmap mapper` run over a
 * handheld indoor capture routinely registers a fraction of the frames and
 * then discards the model as "insufficient size"; re-running it seeded with
 * `--input_path <first model>` grows the reconstruction substantially (on the
 * capture this was built against: 11 → 20 of 22 images, 0.69px → 0.52px mean
 * reprojection error). The first pass's largest model is chosen by registered
 * image count, because COLMAP emits models in arbitrary order and `0` is not
 * reliably the best one.
 *
 * A run that finishes is not the same as a run that worked, and this driver used
 * to conflate them — see `ColmapReconstructionQuality` and
 * `DEFAULT_MIN_REGISTRATION_RATIO` for the measurement that now separates them.
 */
import { isServerSessionId } from '../../src/shared/session-id.ts'
import { isRunnable } from '../exec_probe.ts'
import type { ColmapCamera } from './colmap_model.ts'
import {
  parseCamerasBin,
  parseImagesBin,
  parsePoints3DBin,
  pointsToPly,
  buildPosesJson,
  estimateUpAxis,
  rotationBetween,
  rotatePoint,
  rotateImagePose,
} from './colmap_model.ts'
import type { ColmapPosesManifest } from '../../src/world/manifests.ts'
import type { ScanReviewStatus } from '../../src/world/types.ts'

export interface ColmapPosesRunOptions {
  /** Absolute path to the session directory (scans/sessions/<id>). */
  sessionDir: string
  /** COLMAP binary. Falls back to env COLMAP_BIN, then `colmap` on PATH. */
  colmapBin?: string
  /**
   * Feature type. SIFT is the default because it needs no model download and
   * proved more reliable than ALIKED on wide-baseline indoor captures — the
   * deep features matched more pairs but produced structure-less
   * registrations that yield no triangulated points.
   */
  featureType?: string
  /** Matcher type, paired with featureType. */
  matcherType?: string
  /** Longest image edge fed to feature extraction. */
  maxImageSize?: number
  /** Injection seam for tests: replaces the subprocess spawn. */
  _spawn?: (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>
}

export type ColmapPosesStatus = 'ok' | 'skipped' | 'error'

/** Why a solve was judged degenerate. Codes, so a caller can branch without parsing prose. */
export type ColmapQualityReason = 'low-registration-ratio' | 'too-few-points'

/**
 * How good the solve that just succeeded actually is.
 *
 * Why this is a field and not a fourth `status` value: on 2026-08-30 a run over
 * a 17-keyframe phone capture registered 3 images and triangulated 1 point, and
 * reported `status: 'ok'` — indistinguishable from the same night's video
 * session, which registered 32 of 32 with 9362 points. COLMAP did not fail
 * there; it ran every step, exited 0, and wrote a real `colmap.poses.json`. So
 * `'error'` would be a lie (the tool worked) and `'skipped'` would be a bigger
 * one (it ran). What was missing was never a status value — it was the
 * measurement. That is ADR 0005 rule 3 read the other way round: rather than
 * widen the vocabulary to cover a claim nothing backs, attach the measurement
 * that lets the existing `'ok'` be true and the caller decide.
 *
 * `status` reuses `ScanReviewStatus` ('ready' | 'needs-review' | 'needs-rescan')
 * rather than inventing a private good/bad enum: that type is already this
 * repo's word for "how usable is this capture, and does the operator need to go
 * back", ADR 0005 names it as a member of the same verdict family, and ADR 0001
 * says reuse it. Only two of its three values are reachable today — see
 * `assessColmapQuality` for why 'needs-review' has no measurement behind it yet.
 */
export interface ColmapReconstructionQuality {
  /** `registeredImages / frameCount`, 0..1, rounded to 3 dp for the manifest. */
  registrationRatio: number
  /**
   * The one flag a caller must check before treating the poses as real.
   * Kept alongside `status` deliberately: a boolean cannot be got wrong by
   * comparing against the wrong string literal, and `status === 'needs-rescan'`
   * is exactly this. It is derived, never set independently.
   */
  degenerate: boolean
  status: ScanReviewStatus
  reasons: ColmapQualityReason[]
  /** What the verdict was measured against, so a manifest explains its own verdict. */
  thresholds: ColmapQualityThresholds
}

export interface ColmapQualityThresholds {
  minRegistrationRatio: number
  minPoints3D: number
}

/**
 * `ColmapPosesManifest` plus the quality verdict.
 *
 * The verdict belongs in `src/world/manifests.ts` beside the rest of the
 * manifest shape; it is declared here only because that file is owned by
 * another change in flight. Moving `ColmapReconstructionQuality` /
 * `ColmapQualityReason` / `ColmapQualityThresholds` there and adding a
 * `quality?: ColmapReconstructionQuality` field to `ColmapPosesManifest` makes
 * this alias collapse to nothing, with no call-site edits.
 */
export type ColmapPosesManifestWithQuality = ColmapPosesManifest & {
  quality?: ColmapReconstructionQuality
}

export interface ColmapPosesResult {
  status: ColmapPosesStatus
  manifest: ColmapPosesManifestWithQuality
  /** Absolute path of the written poses.json, when status is 'ok'. */
  posesPath?: string
  /** Absolute path of the written seed cloud, when points were triangulated. */
  pointCloudPath?: string
  registeredImages?: number
  pointCount?: number
  /**
   * Present whenever the solver actually produced a model, i.e. whenever
   * `status === 'ok'`. Callers that gate on `status !== 'ok'` alone are the
   * reason the 3-of-17 run reached the trainer.
   */
  quality?: ColmapReconstructionQuality
  log: string
  exitCode: number
}

/** GPU feature extraction needs a display on most hosts; CPU is the portable default. */
const USE_GPU = '0'

/**
 * Where to look for COLMAP when nobody named a binary and PATH has none.
 *
 * COLMAP's documented install on a box without sudo is the user-local
 * micromamba env in docs/pipelines/splat-train.md § Setup, and that env is NOT
 * on PATH unless you activate it — so on the machine that followed our own
 * instructions, `which colmap` fails while COLMAP 3.13.0 (with CUDA) sits at
 * the path below. Reporting "not found" there is a false negative that reads
 * like a missing tool. This mirrors splat_train.ts's DEFAULT_BRUSH_BIN, which
 * points at `~/brush/target/release/brush-cli` for exactly the same reason —
 * one convention, not a new one (ADR 0001): the documented install path is a
 * fallback, never an override. COLMAP_BIN still wins over everything.
 */
const FALLBACK_COLMAP_BINS = [
  `${Deno.env.get('HOME') ?? '~'}/.local/micromamba/envs/colmap/bin/colmap`,
]

/**
 * Resolve `colmapBin` to something runnable, or null.
 *
 * An explicit binary (opts.colmapBin / COLMAP_BIN) is taken at its word and
 * only probed; the bare default `colmap` means "find one", so it tries PATH
 * and then the documented install paths above.
 */
export async function resolveColmapBin(colmapBin: string): Promise<string | null> {
  if (colmapBin !== 'colmap') return (await isRunnable(colmapBin)) ? colmapBin : null
  if (await which('colmap')) return 'colmap'
  for (const candidate of FALLBACK_COLMAP_BINS) {
    if (await isRunnable(candidate)) return candidate
  }
  return null
}

export function resolveParams(opts: ColmapPosesRunOptions) {
  return {
    colmapBin: opts.colmapBin ?? Deno.env.get('COLMAP_BIN') ?? 'colmap',
    featureType: opts.featureType ?? Deno.env.get('COLMAP_FEATURE_TYPE') ?? 'SIFT',
    // `SIFT`, not `SIFT_BRUTEFORCE`: FeatureMatcherType is an enum, and COLMAP
    // rejects an unknown member outright (`Failed to parse options - Unknown
    // string value: SIFT_BRUTEFORCE for enum: FeatureMatcherType.` → exit 1,
    // measured on the conda-forge COLMAP 3.13.0 our setup docs install). Probed
    // the whole plausible set against that build — SIFT is the only accepted
    // value; SIFT_BRUTEFORCE / BRUTE_FORCE / ALIKED / LIGHTGLUE /
    // ALIKED_LIGHTGLUE are all rejected. Brute force is what SIFT matching does
    // by default anyway (SiftMatching.cpu_brute_force_matcher), so the old name
    // asked for the behaviour we still get, in a spelling nothing accepts.
    matcherType: opts.matcherType ?? Deno.env.get('COLMAP_MATCHER_TYPE') ?? 'SIFT',
    maxImageSize: intFromEnv('COLMAP_MAX_IMAGE_SIZE', opts.maxImageSize ?? 1600),
  }
}

/**
 * Fraction of the offered keyframes that must end up posed.
 *
 * The runs this was measured against, all on 2026-08-30, all `status: 'ok'`:
 *
 *   sess-video-20260830-033839   32/32 registered (1.000), 9362 points  — trained fine
 *   sess-video-…    (re-run)     32/32 registered (1.000), 9366 points  — stable
 *   sess-a7e2f642-…              3/17  registered (0.176), 1 point      — useless
 *   sess-a7e2f642-… (re-run)     2/17  registered (0.118), 159 points   — useless
 *
 * The re-runs matter more than the count suggests. The good capture reproduced
 * to within four points; the bad one did not reproduce at all — same 17 images,
 * same binary, and the mapper landed on a different model, because its RANSAC
 * initialisation is stochastic and a capture this weak has no dominant solution
 * to converge on. So the *ratio* is the stable signal on a bad capture and the
 * point count is not: 159 points would have cleared the floor below, and only
 * the ratio caught that run. Keep both gates; do not collapse them.
 *
 * Points an order of magnitude apart do not locate a boundary: every value
 * in (0.18, 1.00) separates them equally well, so this number is chosen on what
 * it *means*, not on where the data splits. Below 0.6, more than a third of the
 * walked path has no pose at all, so the splat can only ever cover a fragment of
 * the room the operator believes they scanned — and the poses that remain come
 * from one small cluster of views, which is the failure mode above rather than a
 * milder version of it. Picking 0.6 also leaves headroom for the ordinary loss
 * of a few motion-blurred frames at turns (the good run lost none, so the real
 * headroom is unmeasured and 0.6 is the conservative read of that).
 *
 * ADR 0005 rule 5 wants tolerances measured rather than chosen. Two datapoints
 * is not a measurement of a boundary, and pretending otherwise would be the
 * same dishonesty this gate exists to fix — so the number is overridable
 * (COLMAP_MIN_REGISTRATION_RATIO) and should be re-derived once there are
 * enough runs to plot registration ratio against whether the splat was usable.
 */
export const DEFAULT_MIN_REGISTRATION_RATIO = 0.6

/**
 * Triangulated points below which the model has no structure, whatever the ratio.
 *
 * The 3-of-17 run triangulated exactly 1 point. A reconstruction can register a
 * high *fraction* of a short session and still be that empty, which the ratio
 * gate above would wave through — hence a second, independent floor. Downstream,
 * this cloud seeds Brush and is one half of the Umeyama correspondence in
 * `SplatAlignManifest`; neither can do anything with single digits.
 *
 * 100 is deliberately low, and this floor is the weaker of the two: the good run
 * clears it by ~2 orders of magnitude (9362), but the bad capture's re-run
 * produced 159 and cleared it as well. Setting it high enough to have caught
 * that would be fitting a threshold to one stochastic sample, so it stays where
 * it only ever catches the unambiguous case — a model with no structure at all —
 * and the ratio does the real work. Override with COLMAP_MIN_POINTS3D; 0
 * disables the check.
 */
export const DEFAULT_MIN_POINTS_3D = 100

export function resolveQualityThresholds(): ColmapQualityThresholds {
  return {
    minRegistrationRatio: numFromEnv('COLMAP_MIN_REGISTRATION_RATIO', DEFAULT_MIN_REGISTRATION_RATIO),
    minPoints3D: numFromEnv('COLMAP_MIN_POINTS3D', DEFAULT_MIN_POINTS_3D),
  }
}

/**
 * Judge a completed solve. Pure, so the thresholds can be exercised directly.
 *
 * Only 'ready' and 'needs-rescan' come out of this today. A 'needs-review' band
 * — "posed enough to look at, not enough to trust" — is plausible and is left
 * unreachable on purpose: there is no run on record that landed between the two
 * measured cases, so any boundary for it would be invented, and ADR 0005 rule 5
 * is explicit that a tolerance set on intuition is worse than no check. The
 * value stays in the union so adding that band later needs evidence, not a type
 * change.
 */
export function assessColmapQuality(
  input: { registeredImages: number; frameCount: number; pointCount: number },
  thresholds: ColmapQualityThresholds = resolveQualityThresholds(),
): ColmapReconstructionQuality {
  const ratio = input.frameCount > 0 ? input.registeredImages / input.frameCount : 0
  const reasons: ColmapQualityReason[] = []
  if (ratio < thresholds.minRegistrationRatio) reasons.push('low-registration-ratio')
  if (input.pointCount < thresholds.minPoints3D) reasons.push('too-few-points')

  const degenerate = reasons.length > 0
  return {
    registrationRatio: Math.round(ratio * 1000) / 1000,
    degenerate,
    status: degenerate ? 'needs-rescan' : 'ready',
    reasons,
    thresholds,
  }
}

/**
 * Say what went wrong in the words of someone holding a phone in a room.
 *
 * The real cause on 2026-08-30 was a dim, low-texture room — SIFT found 50–330
 * features per frame where a well-lit textured one gives thousands — so the fix
 * is light, texture and parallax, in that order. "Structure-from-motion failed
 * to converge" is true and useless; nobody can act on it, and the operator who
 * needs it is the one standing in the room that produced it.
 */
export function degenerateRemediation(
  quality: ColmapReconstructionQuality,
  input: { registeredImages: number; frameCount: number; pointCount: number },
): string {
  const facts: string[] = []
  if (quality.reasons.includes('low-registration-ratio')) {
    facts.push(
      `only ${input.registeredImages} of ${input.frameCount} photos could be placed in 3D ` +
      `(${Math.round(quality.registrationRatio * 100)}%, and at least ` +
      `${Math.round(quality.thresholds.minRegistrationRatio * 100)}% is needed)`,
    )
  }
  if (quality.reasons.includes('too-few-points')) {
    facts.push(
      `the scan found ${input.pointCount} point(s) of shared detail between photos ` +
      `(at least ${quality.thresholds.minPoints3D} is needed)`,
    )
  }
  return (
    `This scan came out too thin to use: ${facts.join(', and ')}. ` +
    'That almost always means the room was too dark or too plain for the camera to ' +
    'recognise the same spot in two photos. To re-scan: turn on every light and open the ' +
    'blinds; aim at things with visible pattern and detail — bookshelves, pictures, ' +
    'furniture, a patterned rug — rather than bare walls, plain floors or anything ' +
    'shiny; and walk sideways through the room as you scan instead of turning on the ' +
    'spot, because the camera needs to see the same object from two different places to ' +
    'work out how far away it is. Move slowly enough that nothing blurs.'
  )
}

/** Shares `SESSION_ID_RE` with the other drivers rather than re-deriving it. */
export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return isServerSessionId(base)
}

async function defaultSpawn(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command(bin, { args, stdout: 'piped', stderr: 'piped' })
  const { code, stderr } = await cmd.output()
  return { code, stderr: new TextDecoder().decode(stderr).slice(-4000) }
}

export async function runColmapPoses(opts: ColmapPosesRunOptions): Promise<ColmapPosesResult> {
  const params = resolveParams(opts)
  const { sessionDir } = opts
  const started = Date.now()
  const manifestPath = `${sessionDir}/colmap-poses.manifest.json`

  const base: ColmapPosesManifest = {
    schemaVersion: 1,
    tool: 'colmap',
    status: 'error',
    createdAt: new Date().toISOString(),
    sessionDir,
    sessionId: sessionDir.split('/').filter(Boolean).pop(),
    params,
  }

  if (!isValidSessionDir(sessionDir)) {
    return finish(manifestPath, { ...base, status: 'error', error: 'invalid session directory' }, 2, '', started)
  }

  // A missing COLMAP is a *skip*, not an error: the server keeps running and
  // the UI shows a remediation, matching how splat_train treats a missing Brush.
  const resolvedBin = await resolveColmapBin(params.colmapBin)
  if (!resolvedBin) {
    return finish(manifestPath, {
      ...base,
      status: 'skipped',
      skippedReason: params.colmapBin === 'colmap'
        ? `COLMAP binary not found on PATH or at ${FALLBACK_COLMAP_BINS.join(', ')}`
        : `COLMAP binary not found: ${params.colmapBin}`,
      remediation: 'Install COLMAP (`brew install colmap` / `apt install colmap`) or set COLMAP_BIN.',
    }, 0, '', started)
  }
  // Record what we actually ran, not what we were asked for — `base.params` is
  // this same object, so a manifest from a fallback-resolved run names the
  // binary a reader can re-run by hand.
  params.colmapBin = resolvedBin

  // COLMAP wants an image root it owns. Keyframes are hardlinked (falling back
  // to a copy across devices) into a workspace so the session dir keeps its
  // flat kf-*.jpg layout and COLMAP's own outputs stay quarantined.
  const work = `${sessionDir}/colmap-work`
  const imagesDir = `${work}/images`
  await Deno.mkdir(imagesDir, { recursive: true })

  let linked = 0
  for await (const entry of Deno.readDir(sessionDir)) {
    if (!entry.isFile || !/^kf-\d+\.jpg$/.test(entry.name)) continue
    const dest = `${imagesDir}/${entry.name}`
    try {
      await Deno.remove(dest)
    } catch {
      // not present — fine
    }
    try {
      await Deno.link(`${sessionDir}/${entry.name}`, dest)
    } catch {
      await Deno.copyFile(`${sessionDir}/${entry.name}`, dest)
    }
    linked++
  }
  if (linked < 3) {
    return finish(manifestPath, {
      ...base,
      status: 'skipped',
      skippedReason: `only ${linked} keyframe(s) in session — structure-from-motion needs at least 3`,
      remediation: 'Capture more frames, walking between them so the views have parallax.',
    }, 0, '', started)
  }
  base.frameCount = linked

  const spawn = opts._spawn ?? defaultSpawn
  const db = `${work}/db.db`
  const logs: string[] = []

  const step = async (label: string, args: string[]): Promise<string | null> => {
    const { code, stderr } = await spawn(params.colmapBin, args)
    logs.push(`[${label}] exit=${code}\n${stderr}`)
    if (code === 0) return null
    // Carry COLMAP's own last words into the message that reaches the manifest.
    // `logs` is only returned to the caller and then dropped, so a manifest
    // reading `feature_extractor failed (exit 1)` is a dead end — that is
    // exactly how the two option-name bugs fixed in this file (see the
    // `--SiftExtraction.max_image_size` and matcher-type comments) stayed
    // invisible for as long as they did. The last
    // lines, not the first: COLMAP logs progress before it complains.
    // (splat_train.ts has the same-shaped `stderrTail`; it is not imported here
    // because splat_train.ts already imports THIS module — sharing it would
    // make the two files circular for two lines of string handling.)
    const tail = stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' | ')
    return tail ? `${label} failed (exit ${code}): ${tail.slice(-400)}` : `${label} failed (exit ${code})`
  }

  let err = await step('feature_extractor', [
    'feature_extractor',
    '--database_path', db,
    '--image_path', imagesDir,
    '--ImageReader.single_camera', '1',
    '--ImageReader.camera_model', 'SIMPLE_RADIAL',
    '--FeatureExtraction.type', params.featureType,
    '--FeatureExtraction.use_gpu', USE_GPU,
    // `max_image_size` lives under SiftExtraction, NOT FeatureExtraction —
    // COLMAP 3.12 moved the extractor-generic options (type, use_gpu,
    // num_threads, gpu_index) to the `FeatureExtraction.*` prefix and left the
    // SIFT-specific ones behind. Getting this wrong is not a warning: COLMAP
    // aborts the whole step. Measured against the build this repo's own setup
    // instructions produce (COLMAP 3.13.0 from conda-forge):
    //   E … option_manager.cc:976] Failed to parse options - unrecognised
    //   option '--FeatureExtraction.max_image_size'.  → exit 1, 40ms,
    // i.e. every colmap-poses run failed before extracting a single feature.
    // `--SiftExtraction.max_image_size` is also the spelling every pre-3.12
    // release accepts, so it is the compatible choice, not just the working one.
    '--SiftExtraction.max_image_size', String(params.maxImageSize),
  ])
  if (err) return finish(manifestPath, { ...base, status: 'error', error: err }, 2, logs.join('\n'), started)

  err = await step('exhaustive_matcher', [
    'exhaustive_matcher',
    '--database_path', db,
    '--FeatureMatching.type', params.matcherType,
    '--FeatureMatching.use_gpu', USE_GPU,
  ])
  if (err) return finish(manifestPath, { ...base, status: 'error', error: err }, 2, logs.join('\n'), started)

  const sparse = `${work}/sparse`
  await Deno.mkdir(sparse, { recursive: true })
  err = await step('mapper', [
    'mapper',
    '--database_path', db,
    '--image_path', imagesDir,
    '--output_path', sparse,
    // Stock thresholds assume a large, densely-overlapping capture. A handheld
    // room sweep is neither, and the default init routinely registers a
    // handful of frames before discarding the model as "insufficient size".
    '--Mapper.init_min_num_inliers', '25',
    '--Mapper.abs_pose_min_num_inliers', '12',
    '--Mapper.min_num_matches', '12',
    '--Mapper.init_min_tri_angle', '2',
    '--Mapper.tri_min_angle', '0.5',
  ])
  if (err) return finish(manifestPath, { ...base, status: 'error', error: err }, 2, logs.join('\n'), started)

  const first = await largestModel(sparse)
  if (!first) {
    return finish(manifestPath, {
      ...base,
      status: 'error',
      error:
        'COLMAP registered no images — the views share no triangulatable baseline. ' +
        'This is the signature of a rotation-only capture (a camera panning in place); ' +
        'walking between viewpoints is what produces the parallax SfM needs.',
      remediation: 'Re-capture while walking through the space rather than rotating in place.',
    }, 2, logs.join('\n'), started)
  }

  // Second pass, seeded from the best first-pass model — see the file header.
  const grown = `${work}/sparse_grown`
  await Deno.mkdir(grown, { recursive: true })
  const growErr = await step('mapper(grow)', [
    'mapper',
    '--database_path', db,
    '--image_path', imagesDir,
    '--input_path', first.dir,
    '--output_path', grown,
    '--Mapper.abs_pose_min_num_inliers', '12',
    '--Mapper.min_num_matches', '12',
  ])
  // A failed grow pass is not fatal: the first-pass model is still valid, so
  // fall back to it rather than discarding a usable reconstruction.
  const modelDir = growErr ? first.dir : await bestOf(grown, first.dir)

  let images = parseImagesBin(await Deno.readFile(`${modelDir}/images.bin`))
  if (images.length === 0) {
    return finish(manifestPath, { ...base, status: 'error', error: 'model contains no registered images' }, 2, logs.join('\n'), started)
  }

  let pts: ReturnType<typeof parsePoints3DBin> = []
  try {
    pts = parsePoints3DBin(await Deno.readFile(`${modelDir}/points3D.bin`))
  } catch {
    // No cloud is survivable — Brush random-inits inside the camera frustums.
  }

  // Gravity-align the whole reconstruction before anything consumes it.
  // SfM has no gravity reference, so COLMAP's world frame is tilted at an
  // arbitrary angle and a Y-up viewer renders the room on its side. Rotating
  // once here — poses and points together, so they stay in the same frame —
  // means every downstream consumer (transforms.json, the seed cloud, the
  // trained splat, the viewer) inherits an upright world for free. Doing it in
  // the viewer instead would fix only the viewer and leave the exported splat
  // wrong for everyone else.
  const up = estimateUpAxis(images)
  let upAxis: [number, number, number] | undefined
  if (up) {
    upAxis = up
    const Q = rotationBetween(up, [0, 1, 0])
    images = images.map((img) => rotateImagePose(Q, img))
    pts = pts.map((pt) => ({ ...pt, xyz: rotatePoint(Q, pt.xyz) }))
  }

  // Carry COLMAP's SOLVED intrinsics alongside the poses.
  //
  // Feature extraction ran with `--single_camera 1 --camera_model SIMPLE_RADIAL`
  // (see the args above), so COLMAP fit f, cx, cy and k1 to these actual images.
  // Until now that fit was written to cameras.bin and thrown away, and every
  // consumer fell back to `deriveIntrinsics`, which only has the capture-time
  // vertical FOV and therefore assumes a perfectly centred principal point — and
  // on 8th Wall's `?camerafit=cover` path that FOV describes a different frustum
  // than the uploaded pixels. Reading the solved values is strictly better.
  //
  // Absent or unparseable cameras.bin is not fatal: omitting the block puts
  // consumers back on the old fallback rather than failing a good reconstruction.
  let camera: ColmapCamera | undefined
  try {
    camera = parseCamerasBin(await Deno.readFile(`${modelDir}/cameras.bin`))[0]
  } catch {
    camera = undefined
  }

  const posesPath = `${sessionDir}/colmap.poses.json`
  await Deno.writeTextFile(posesPath, JSON.stringify(buildPosesJson(images, 'colmap', camera), null, 2))

  let pointCloudPath: string | undefined
  let pointCount = 0
  if (pts.length > 0) {
    pointCloudPath = `${sessionDir}/colmap.point-cloud.ply`
    await Deno.writeFile(pointCloudPath, pointsToPly(pts))
    pointCount = pts.length
  }

  // Judge the solve before reporting it. The outputs above are written either
  // way — a degenerate model is still the most useful thing to look at when
  // diagnosing why a capture failed, and deleting it would leave the operator
  // with a verdict and nothing to check it against.
  const counts = { registeredImages: images.length, frameCount: linked, pointCount }
  const quality = assessColmapQuality(counts)

  return finish(manifestPath, {
    ...base,
    status: 'ok',
    posesPath: 'colmap.poses.json',
    pointCloudPath: pointCloudPath ? 'colmap.point-cloud.ply' : undefined,
    registeredImages: images.length,
    pointCount,
    upAxis,
    gravityAligned: Boolean(upAxis),
    quality,
    // `remediation` is the envelope's existing "how do I fix this" slot, and it
    // is what splat_train already forwards and the UI already renders — so a
    // degenerate solve reaches a human through a path that exists rather than a
    // new one (ADR 0001). Left unset on a good solve: nothing to remedy.
    ...(quality.degenerate ? { remediation: degenerateRemediation(quality, counts) } : {}),
  }, 0, logs.join('\n'), started, { posesPath, pointCloudPath, registeredImages: images.length, pointCount, quality })
}

/**
 * Pick the model with the most registered images under `root`.
 *
 * Handles both layouts COLMAP emits, which differ in a way that is easy to
 * miss: a fresh `mapper` run writes numbered sub-models (`0/`, `1/`, …) and
 * `0` is *not* reliably the largest, but a `mapper` run given `--input_path`
 * writes its single output model **directly into `--output_path`** with no
 * subdirectory. Scanning only for subdirectories therefore finds nothing
 * after a seeded pass and silently throws that reconstruction away — which
 * is exactly the bug that made the grow pass a no-op.
 */
async function largestModel(root: string): Promise<{ dir: string; count: number } | null> {
  let best: { dir: string; count: number } | null = null

  const consider = async (dir: string) => {
    try {
      const imgs = parseImagesBin(await Deno.readFile(`${dir}/images.bin`))
      if (imgs.length > 0 && (!best || imgs.length > best.count)) best = { dir, count: imgs.length }
    } catch {
      // absent or unreadable — not a model
    }
  }

  await consider(root)
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) await consider(`${root}/${entry.name}`)
    }
  } catch {
    // root missing entirely
  }
  return best
}

/** The grown model when it beats the seed, else the seed. */
async function bestOf(grownRoot: string, fallbackDir: string): Promise<string> {
  const grown = await largestModel(grownRoot)
  if (!grown) return fallbackDir
  try {
    const seedCount = parseImagesBin(await Deno.readFile(`${fallbackDir}/images.bin`)).length
    return grown.count >= seedCount ? grown.dir : fallbackDir
  } catch {
    return grown.dir
  }
}

/** `colmap` resolved via PATH rather than an absolute path. */
async function which(bin: string): Promise<boolean> {
  try {
    const { code } = await new Deno.Command(bin, { args: ['-h'], stdout: 'null', stderr: 'null' }).output()
    return code === 0
  } catch {
    return false
  }
}

async function finish(
  manifestPath: string,
  manifest: ColmapPosesManifestWithQuality,
  exitCode: number,
  log: string,
  started: number,
  extra: Partial<ColmapPosesResult> = {},
): Promise<ColmapPosesResult> {
  const withTiming: ColmapPosesManifestWithQuality = { ...manifest, timing: { elapsedMs: Date.now() - started } }
  try {
    await Deno.writeTextFile(manifestPath, JSON.stringify(withTiming, null, 2))
  } catch {
    // A session dir that vanished mid-run shouldn't mask the real result.
  }
  return { status: withTiming.status, manifest: withTiming, log, exitCode, ...extra }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Like `intFromEnv`, but fractional and admitting zero — the thresholds need
 * 0.6, and `COLMAP_MIN_POINTS3D=0` is the documented way to disable that gate.
 * `intFromEnv`'s `n > 0` would silently turn both of those into the default.
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
