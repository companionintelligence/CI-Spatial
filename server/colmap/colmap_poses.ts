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

export interface ColmapPosesResult {
  status: ColmapPosesStatus
  manifest: ColmapPosesManifest
  /** Absolute path of the written poses.json, when status is 'ok'. */
  posesPath?: string
  /** Absolute path of the written seed cloud, when points were triangulated. */
  pointCloudPath?: string
  registeredImages?: number
  pointCount?: number
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

  return finish(manifestPath, {
    ...base,
    status: 'ok',
    posesPath: 'colmap.poses.json',
    pointCloudPath: pointCloudPath ? 'colmap.point-cloud.ply' : undefined,
    registeredImages: images.length,
    pointCount,
    upAxis,
    gravityAligned: Boolean(upAxis),
  }, 0, logs.join('\n'), started, { posesPath, pointCloudPath, registeredImages: images.length, pointCount })
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
  manifest: ColmapPosesManifest,
  exitCode: number,
  log: string,
  started: number,
  extra: Partial<ColmapPosesResult> = {},
): Promise<ColmapPosesResult> {
  const withTiming: ColmapPosesManifest = { ...manifest, timing: { elapsedMs: Date.now() - started } }
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
