/**
 * LingBot-Map worker driver.
 *
 * Spawns scripts/lingbot_map_worker.py as a subprocess to run streaming 3D
 * reconstruction over a keyframe session. The Python script always writes
 * `lingbot-map.manifest.json` into the session directory — even on skip or
 * failure — so callers can rely on the manifest existing after this resolves.
 *
 * The TS side stays intentionally thin: it validates inputs, spawns the child
 * under a deadline, and judges the cloud the child wrote (see the quality
 * verdict below) before surfacing a structured result for the world-job
 * coordinator to persist. All model-specific logic lives in the Python worker.
 */
import { COMPUTE_DEVICES, type ComputeDevice, isComputeDevice } from '../../src/world/manifests.ts'
import type { ScanReviewStatus } from '../../src/world/types.ts'
import { isServerSessionId } from '../../src/shared/session-id.ts'
import { parseLingBotMapPLY } from '../../src/shared/lingbot_map_ply.ts'
import { openCvW2cToC2w } from '../splat/splat_train_dataset.ts'
import { sfmCentresFromPoses } from '../splat/splat_align.ts'
import { budgetFromEnv, type DeadlineOutput, runWithDeadline } from '../run_with_deadline.ts'

// Lazy-imported inside runLingBotMapReconstruction so the Deno-only unit
// test (lingbot_map.test.ts) doesn't pull in @gltf-transform/functions,
// which eagerly loads `sharp` and breaks under Deno without npm scripts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _glbModule: any | null = null
async function _getGlbBuilder() {
  if (!_glbModule) _glbModule = await import('./lingbot_map_glb.ts')
  return _glbModule.buildLingBotMapGlb as typeof import('./lingbot_map_glb.ts').buildLingBotMapGlb
}

export interface LingBotMapRunOptions {
  /** Absolute path to the session directory (scans/sessions/<id>). */
  sessionDir: string
  /** Optional override; falls back to env LINGBOT_MAP_MODEL_PATH. */
  modelPath?: string
  /** Python executable (defaults to LINGBOT_MAP_PYTHON or `python3`). */
  python?: string
  /** Absolute path to scripts/lingbot_map_worker.py. */
  scriptPath: string
  /** Keep every Nth keyframe (default 1). */
  keyframeInterval?: number
  /** Cap the number of frames fed to the model (default 512). */
  maxFrames?: number
  /**
   * Torch backend to ask the worker for; falls back to env LINGBOT_MAP_DEVICE,
   * then 'auto'. Shares `ComputeDevice` with panoptic_scan.ts rather than
   * re-declaring the union here — this used to be a local
   * `'auto' | 'cpu' | 'cuda'`, which is now wrong twice over: the worker is
   * gaining Apple 'mps', and a ROCm torch already asks for 'cuda' (it reports
   * torch.cuda.is_available() === true), so 'cuda' never meant NVIDIA.
   *
   * 'auto' is a request, not an answer — see `resolvedDevice` on the result.
   */
  device?: ComputeDevice
  /**
   * Optional GLB sidecar destination. When provided AND the run produces a
   * point cloud, the PLY is converted to a GLB POINTS primitive and written
   * to this path. Failures here do NOT fail the job — the PLY is still
   * the canonical artifact.
   */
  glbSidecarPath?: string
  /** Forwarded into the GLB's asset.extras so the viewer can show provenance. */
  glbExtras?: { sessionId: string; scanId?: string }
}

export type LingBotMapStatus = 'ok' | 'skipped' | 'error'

export interface LingBotMapResult {
  status: LingBotMapStatus
  /** Present when status is 'skipped'. */
  skippedReason?: string
  /** Present when status is 'error'. */
  error?: string
  /** Path (relative to sessionDir) of the PLY when status is 'ok'. */
  pointCloudFile?: string
  /** Path (relative to sessionDir) of the poses JSON when status is 'ok'. */
  posesFile?: string
  /** Always set after a non-fatal run — the manifest the worker wrote. */
  manifestFile: string
  /** Absolute path of the GLB sidecar written from the PLY, if requested. */
  glbSidecarPath?: string
  /** Number of points in the GLB sidecar (may differ from PLY after quantisation). */
  glbPointCount?: number
  /**
   * The backend the worker reported actually using, read back from the
   * manifest's `params.resolvedDevice` — which scripts/lingbot_map_worker.py
   * already writes, so this is a read of an existing contract, not a new one.
   *
   * Distinct from the requested device: `_torch_device.resolve_torch_device`
   * downgrades an unreachable backend to CPU rather than raising, so a run that
   * asked for the GPU and silently got the CPU is otherwise indistinguishable
   * from one that got it — and that is minutes per frame versus 0.7 s.
   */
  resolvedDevice?: string
  /**
   * Vendor behind that backend — 'NVIDIA CUDA', 'AMD ROCm', 'Apple MPS', 'CPU'
   * — from the manifest's `params.deviceVendor`. `resolvedDevice` cannot carry
   * it: a ROCm torch runs on the device string "cuda".
   */
  deviceVendor?: string
  /**
   * The verdict on the cloud, present when a run finished and could be judged.
   * A `status: 'ok'` run whose cloud is degenerate comes back as `'error'`, and
   * this still says why.
   */
  quality?: LingBotReconstructionQuality
  /** Why no verdict was reached, when one was attempted and could not be. */
  qualityError?: string
  /**
   * The plain-language fix, present when the run was judged degenerate. It is
   * kept out of `error`, which states the problem only, so the fix is held once.
   * The manifest carries it in its own `remediation` field.
   */
  remediation?: string
  /** Stderr text from the worker — useful for surfacing in the UI. */
  log: string
  /** Subprocess exit code (0/2/3 per the Python contract). */
  exitCode: number
}

// ── Quality verdict (F33) ────────────────────────────────────────────────────
//
// The Python worker reports `status: ok` whenever it finishes, and nothing else
// judged what it made. A reconstruction that collapsed into a few centimetres
// of space read as success and went on to be the scan's point cloud and a
// splat seed. COLMAP and splat training already judge their own output; this
// is the same step for LingBot.

/** Why a LingBot run was judged degenerate. Codes, so a caller can branch without parsing prose. */
export type LingBotQualityReason = 'too-few-points' | 'collapsed-extent'

export interface LingBotQualityThresholds {
  /**
   * Points per sampled frame below which the cloud is too sparse to use.
   * UNTUNED. A healthy run measured about 150,000 points per frame, so this
   * only catches a cloud that is close to empty.
   */
  minPointsPerFrame: number
  /**
   * Cloud extent over camera baseline below which the cloud is judged collapsed.
   * UNTUNED. A cloud of a room is at least as wide as the walk through it, so
   * this flags only a cloud a tenth the size of the walk, with a wide margin.
   */
  minExtentRatio: number
}

export const DEFAULT_LINGBOT_QUALITY_THRESHOLDS: LingBotQualityThresholds = {
  minPointsPerFrame: 100,
  minExtentRatio: 0.1,
}

export interface LingBotReconstructionQuality {
  /** Points in the PLY the worker wrote. */
  pointCount: number
  /** Keyframes the worker sampled, from its manifest. */
  frameCount: number
  /** `pointCount / frameCount`, 1 dp. */
  pointsPerFrame: number
  /** Diagonal of the cloud's bounding box, in the worker's own units. */
  cloudExtent: number
  /**
   * Diagonal of the box around the camera centres, in the same units. Null
   * when fewer than two cameras were solved: absent means not measurable,
   * never measured and fine.
   */
  cameraBaseline: number | null
  /** `cloudExtent / cameraBaseline`, 4 dp. Null when there is no baseline. */
  extentRatio: number | null
  degenerate: boolean
  status: ScanReviewStatus
  reasons: LingBotQualityReason[]
  thresholds: LingBotQualityThresholds
}

/**
 * Judge a finished run. Pure, so the thresholds can be exercised directly.
 *
 * The count check cannot catch a collapse on its own. The run that collapsed
 * into a 3.7 cm cube made 2,436,672 points, which passes any count. The extent
 * check is the one that sees it, and it is scale-free (a ratio of two lengths
 * in the same units), so it needs no metre stick.
 */
export function assessLingBotQuality(
  input: {
    pointCount: number
    frameCount: number
    cloudExtent: number
    cameraBaseline: number | null
  },
  thresholds: LingBotQualityThresholds = DEFAULT_LINGBOT_QUALITY_THRESHOLDS,
): LingBotReconstructionQuality {
  const pointsPerFrame = input.pointCount / Math.max(input.frameCount, 1)
  const baseline = input.cameraBaseline !== null && input.cameraBaseline > 0 ? input.cameraBaseline : null
  const extentRatio = baseline === null ? null : input.cloudExtent / baseline
  const reasons: LingBotQualityReason[] = []
  if (pointsPerFrame < thresholds.minPointsPerFrame) reasons.push('too-few-points')
  if (extentRatio !== null && extentRatio < thresholds.minExtentRatio) reasons.push('collapsed-extent')
  const degenerate = reasons.length > 0
  return {
    pointCount: input.pointCount,
    frameCount: input.frameCount,
    pointsPerFrame: round(pointsPerFrame, 1),
    cloudExtent: round(input.cloudExtent, 6),
    cameraBaseline: baseline === null ? null : round(baseline, 6),
    extentRatio: extentRatio === null ? null : round(extentRatio, 4),
    degenerate,
    status: degenerate ? 'needs-rescan' : 'ready',
    reasons,
    thresholds,
  }
}

/**
 * What went wrong, and what to do about it, in the words of someone holding
 * the phone in the room. Pure, like the verdict it explains.
 */
export function lingBotDegenerateReport(
  quality: LingBotReconstructionQuality,
): { error: string; remediation: string } {
  const problems: string[] = []
  if (quality.reasons.includes('collapsed-extent') && quality.extentRatio !== null) {
    problems.push(
      'The 3D reconstruction collapsed: its points span only ' +
        `${percent(quality.extentRatio)} of the distance the camera covered ` +
        `(at least ${percent(quality.thresholds.minExtentRatio)} is needed).`,
    )
  }
  if (quality.reasons.includes('too-few-points')) {
    problems.push(
      `The 3D reconstruction is too sparse: about ${Math.round(quality.pointsPerFrame)} point(s) per photo ` +
        `(at least ${quality.thresholds.minPointsPerFrame} is needed).`,
    )
  }
  return {
    error: problems.join(' '),
    remediation:
      'Re-scan with the lights on, and aim at detailed surfaces such as shelves, pictures and furniture. ' +
      'Walk through the room rather than turning on the spot, and move slowly enough that nothing blurs.',
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function round(n: number, places: number): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** Diagonal of the box that holds every finite point of a flat x,y,z array. */
function boxDiagonal(xyz: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let seen = 0
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    if (!Number.isFinite(xyz[i]) || !Number.isFinite(xyz[i + 1]) || !Number.isFinite(xyz[i + 2])) continue
    seen++
    for (let k = 0; k < 3; k++) {
      if (xyz[i + k] < lo[k]) lo[k] = xyz[i + k]
      if (xyz[i + k] > hi[k]) hi[k] = xyz[i + k]
    }
  }
  return seen === 0 ? 0 : Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
}

/** Point count and extent of the worker's cloud, or null when the PLY cannot be read. */
async function readCloudSummary(path: string): Promise<{ count: number; extent: number } | null> {
  try {
    const cloud = parseLingBotMapPLY(await Deno.readFile(path))
    return { count: cloud.count, extent: boxDiagonal(cloud.xyz) }
  } catch {
    return null
  }
}

/**
 * Diagonal of the box around the camera centres the worker solved, in the same
 * units as its cloud. Null when fewer than two cameras were solved, which leaves
 * the walk unmeasured and gives no extent verdict.
 *
 * The matrices are OpenCV world-to-camera (see openCvW2cToC2w), so the centres
 * come from inverting them, the way splat_train_dataset.ts reads this file.
 */
async function measureCameraBaseline(sessionDir: string): Promise<number | null> {
  let frames: unknown
  try {
    const parsed = JSON.parse(await Deno.readTextFile(`${sessionDir}/lingbot-map.poses.json`)) as { frames?: unknown }
    frames = parsed.frames
  } catch {
    return null
  }
  if (!Array.isArray(frames)) return null
  const poses = new Map<string, number[][]>()
  for (const frame of frames as Array<{ file?: unknown; cameraToWorld?: unknown } | null>) {
    if (typeof frame?.file !== 'string') continue
    const c2w = openCvW2cToC2w(frame.cameraToWorld)
    if (c2w) poses.set(frame.file, c2w)
  }
  const centres = [...sfmCentresFromPoses(poses).values()]
  return centres.length >= 2 ? boxDiagonal(centres.flat()) : null
}

/** Judge the cloud a finished worker run left behind. Never throws. */
async function judgeLingBotRun(
  sessionDir: string,
  frameCount: number,
): Promise<{ quality: LingBotReconstructionQuality } | { qualityError: string }> {
  const cloud = await readCloudSummary(`${sessionDir}/lingbot-map.point-cloud.ply`)
  if (!cloud) return { qualityError: 'could not measure lingbot-map.point-cloud.ply: unreadable PLY' }
  const cameraBaseline = await measureCameraBaseline(sessionDir)
  return {
    quality: assessLingBotQuality({
      pointCount: cloud.count,
      frameCount,
      cloudExtent: cloud.extent,
      cameraBaseline,
    }),
  }
}

/**
 * Write the verdict into the manifest the worker left, where the server reads
 * it. A degenerate run also flips the manifest's status, so anything that reads
 * the file alone cannot mistake it for a finished reconstruction.
 */
async function recordLingBotVerdict(
  manifestFile: string,
  manifest: Record<string, unknown>,
  verdict: { quality: LingBotReconstructionQuality } | { qualityError: string },
  report: { error: string; remediation: string } | null,
): Promise<void> {
  const next: Record<string, unknown> = { ...manifest }
  if ('quality' in verdict) next.quality = verdict.quality
  else next.qualityError = verdict.qualityError
  if (report) {
    next.status = 'error'
    next.error = report.error
    next.remediation = report.remediation
  }
  try {
    await Deno.writeTextFile(manifestFile, JSON.stringify(next, null, 2))
  } catch (e) {
    // The in-memory result still carries the verdict, and the job reports it.
    console.warn('[lingbot-map] could not record the quality verdict in the manifest:', e)
  }
}

/**
 * The verdict an earlier run left in the manifest, when that run judged its cloud
 * degenerate: its `quality` and `remediation`. Null when there is none, or when the
 * manifest cannot be read.
 */
async function readDegenerateVerdict(
  manifestFile: string,
): Promise<{ quality: unknown; remediation: unknown } | null> {
  try {
    const manifest = JSON.parse(await Deno.readTextFile(manifestFile)) as {
      quality?: { degenerate?: unknown } | null
      remediation?: unknown
    }
    if (manifest.quality?.degenerate !== true) return null
    return { quality: manifest.quality, remediation: manifest.remediation }
  } catch {
    return null
  }
}

/**
 * Replace the manifest a killed worker left behind. Once this run has failed,
 * the file on disk must not still say `ok` from an earlier run. Written in the
 * worker's own envelope, with the reason as a code. Best-effort: the returned
 * result already carries the error.
 *
 * A degenerate verdict from an earlier run is carried into the envelope. Its cloud
 * is still on disk, and the seed, detect and artifact guards act on that verdict.
 */
async function recordLingBotTimeout(manifestFile: string, error: string): Promise<void> {
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    tool: 'lingbot-map',
    createdAt: new Date().toISOString(),
    status: 'error',
    error,
    reason: 'timeout',
  }
  const verdict = await readDegenerateVerdict(manifestFile)
  if (verdict) {
    manifest.quality = verdict.quality
    if (verdict.remediation !== undefined) manifest.remediation = verdict.remediation
  }
  try {
    await Deno.writeTextFile(manifestFile, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[lingbot-map] could not record the timeout in the manifest:', e)
  }
}

/**
 * Two hours. A capped run takes seconds on a GPU and can take far longer on a
 * CPU, so this is a ceiling for a stall, not a target for a slow run. Untuned.
 */
const DEFAULT_LINGBOT_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * Validate that a path looks like a Companion-Scan session directory.
 * Pulled out so the unit test can hit it without spawning anything.
 *
 * Delegates to the shared `SESSION_ID_RE` (`src/shared/session-id.ts`) rather
 * than a local copy — this file used to carry its own, wider
 * `/^(sess|session)-[a-z0-9-]+$/`, which kept accepting the retired
 * client-minted `session-*` shape after 07-scan-identity/0002 cut over to
 * `sess-*` only everywhere else. It was never reachable in practice (every
 * caller resolves `sessionDir` through main.ts's tightened gate first), but a
 * second copy of a validator this repo already retired one rival of is
 * exactly what ADR 0001 exists to prevent.
 */
export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return isServerSessionId(base)
}

export function buildWorkerArgs(opts: LingBotMapRunOptions): string[] {
  const args = [opts.scriptPath, '--session-dir', opts.sessionDir]
  if (opts.modelPath) args.push('--model-path', opts.modelPath)
  if (opts.keyframeInterval && opts.keyframeInterval > 1) {
    args.push('--keyframe-interval', String(Math.floor(opts.keyframeInterval)))
  }
  if (opts.maxFrames && opts.maxFrames > 0) {
    args.push('--max-frames', String(Math.floor(opts.maxFrames)))
  }
  if (opts.device && opts.device !== 'auto') {
    args.push('--device', opts.device)
  }
  return args
}

export async function runLingBotMapReconstruction(
  opts: LingBotMapRunOptions,
): Promise<LingBotMapResult> {
  if (!isValidSessionDir(opts.sessionDir)) {
    return _failure(opts.sessionDir, 'invalid session directory', 2)
  }

  const python = opts.python ?? Deno.env.get('LINGBOT_MAP_PYTHON') ?? 'python3'
  const modelPath = opts.modelPath ?? Deno.env.get('LINGBOT_MAP_MODEL_PATH') ?? ''
  // Named for the LINGBOT_MAP_* family it joins, and matching BRUSH_DEVICE's
  // <tool>_DEVICE shape rather than inventing a new one (ADR 0001).
  const device = opts.device ?? Deno.env.get('LINGBOT_MAP_DEVICE') ?? 'auto'
  if (!isComputeDevice(device)) {
    // Gated before the spawn, like isValidSessionDir above: the worker's
    // argparse would reject it too, but as an exit-2 with no manifest, which
    // surfaces as "worker exited 2 without writing a manifest" — a shape that
    // reads like a broken install rather than a typo in one env var.
    return _failure(
      opts.sessionDir,
      `unrecognised device "${device}" — set LINGBOT_MAP_DEVICE to one of ${COMPUTE_DEVICES.join(', ')}, or unset it for auto`,
      2,
    )
  }

  // A frame cap the GPU can actually hold. Measured on a 12 GB 4080: 16 frames
  // reconstruct in ~17 s and produce 2.4M points; 24 frames OOM. The job used to
  // pass no cap at all, so it handed the worker every frame in the session (48
  // here) and failed where the same worker succeeds from the CLI. Raise it via
  // LINGBOT_MAP_MAX_FRAMES on a card with more memory — the model's cost is set
  // by the scale phase and the window, not by session length.
  const frameCap = opts.maxFrames && opts.maxFrames > 0
    ? opts.maxFrames
    : Number(Deno.env.get('LINGBOT_MAP_MAX_FRAMES') ?? '16')

  let output: DeadlineOutput
  try {
    output = await runWithDeadline(python, {
      args: buildWorkerArgs({ ...opts, modelPath, device, maxFrames: frameCap }),
      // Inherit, then add: replacing the environment wholesale would strip PATH
      // and the venv resolution with it.
      //
      // expandable_segments is torch's own suggestion in the OOM it raises here,
      // and upstream's limited-VRAM section uses it too. Measured: without it the
      // allocator fragments and a run that fits still fails.
      env: {
        ...Deno.env.toObject(),
        PYTORCH_CUDA_ALLOC_CONF: Deno.env.get('PYTORCH_CUDA_ALLOC_CONF') ??
          'expandable_segments:True',
      },
      stdout: 'piped',
      stderr: 'piped',
    }, budgetFromEnv('LINGBOT_MAP_TIMEOUT_MS', DEFAULT_LINGBOT_TIMEOUT_MS))
  } catch (e) {
    return _failure(opts.sessionDir, `failed to run ${python}: ${e instanceof Error ? e.message : e}`, 3)
  }
  const manifestFile = `${opts.sessionDir}/lingbot-map.manifest.json`
  // A killed worker may have left a manifest from an earlier run, so a timed-out
  // run is an error on its own terms and its manifest is not read for a result. The
  // error is written over that file, so it cannot still say `ok` from the earlier
  // run. A degenerate verdict in that file is carried over (recordLingBotTimeout).
  if (output.timeoutReason && !output.success) {
    const error = `worker ${output.timeoutReason} and was stopped`
    await recordLingBotTimeout(manifestFile, error)
    return _failure(opts.sessionDir, error, 3)
  }

  const log = new TextDecoder().decode(output.stderr).trim()

  let manifestStatus: LingBotMapStatus = 'error'
  let skippedReason: string | undefined
  let errorMsg: string | undefined
  let resolvedDevice: string | undefined
  let deviceVendor: string | undefined
  let manifestBody: Record<string, unknown> | null = null
  try {
    const manifest = JSON.parse(await Deno.readTextFile(manifestFile)) as Record<string, unknown>
    manifestBody = manifest
    const status = manifest.status
    if (status === 'ok' || status === 'skipped' || status === 'error') {
      manifestStatus = status
    }
    if (typeof manifest.skippedReason === 'string') skippedReason = manifest.skippedReason
    if (typeof manifest.error === 'string') errorMsg = manifest.error
    const manifestParams = manifest.params
    if (manifestParams && typeof manifestParams === 'object') {
      const rd = (manifestParams as Record<string, unknown>).resolvedDevice
      if (typeof rd === 'string' && rd) resolvedDevice = rd
      const dv = (manifestParams as Record<string, unknown>).deviceVendor
      if (typeof dv === 'string' && dv) deviceVendor = dv
    }
  } catch {
    // Manifest missing => unrecoverable; preserve exit code + log
    errorMsg = errorMsg ?? `worker exited ${output.code} without writing a manifest`
  }

  // `ok` from the worker means it finished, not that the cloud is any good. Judge
  // the cloud before anything downstream reads it as a result (F33).
  let quality: LingBotReconstructionQuality | undefined
  let qualityError: string | undefined
  let remediation: string | undefined
  if (manifestStatus === 'ok' && manifestBody) {
    const frameCount = typeof manifestBody.frameCount === 'number' ? manifestBody.frameCount : 0
    const verdict = await judgeLingBotRun(opts.sessionDir, frameCount)
    const report = 'quality' in verdict && verdict.quality.degenerate
      ? lingBotDegenerateReport(verdict.quality)
      : null
    await recordLingBotVerdict(manifestFile, manifestBody, verdict, report)
    if ('quality' in verdict) quality = verdict.quality
    else qualityError = verdict.qualityError
    if (report) {
      manifestStatus = 'error'
      errorMsg = report.error
      remediation = report.remediation
    }
  }

  let glbSidecarPath: string | undefined
  let glbPointCount: number | undefined
  if (manifestStatus === 'ok' && opts.glbSidecarPath) {
    try {
      const buildLingBotMapGlb = await _getGlbBuilder()
      const ply = await Deno.readFile(`${opts.sessionDir}/lingbot-map.point-cloud.ply`)
      const glb = await buildLingBotMapGlb(ply, {
        source: 'lingbot-map',
        pointCount: 0,
        poseCount: 0,
        sessionId: opts.glbExtras?.sessionId ?? '',
        manifestPath: `${opts.sessionDir}/lingbot-map.manifest.json`,
      })
      await Deno.writeFile(opts.glbSidecarPath, glb.bytes)
      glbSidecarPath = opts.glbSidecarPath
      glbPointCount = glb.pointCount
    } catch (e) {
      console.warn('[lingbot-map] GLB sidecar build failed:', e)
    }
  }

  return {
    status: manifestStatus,
    skippedReason,
    error: errorMsg,
    pointCloudFile: manifestStatus === 'ok' ? 'lingbot-map.point-cloud.ply' : undefined,
    posesFile: manifestStatus === 'ok' ? 'lingbot-map.poses.json' : undefined,
    manifestFile: 'lingbot-map.manifest.json',
    resolvedDevice,
    deviceVendor,
    glbSidecarPath,
    glbPointCount,
    quality,
    qualityError,
    remediation,
    log,
    exitCode: output.code,
  }
}

function _failure(_sessionDir: string, reason: string, exitCode: number): LingBotMapResult {
  return {
    status: 'error',
    error: reason,
    manifestFile: 'lingbot-map.manifest.json',
    log: reason,
    exitCode,
  }
}
