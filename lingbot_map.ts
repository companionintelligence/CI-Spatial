/**
 * LingBot-Map worker driver.
 *
 * Spawns scripts/lingbot_map_worker.py as a subprocess to run streaming 3D
 * reconstruction over a keyframe session. The Python script always writes
 * `lingbot-map.manifest.json` into the session directory — even on skip or
 * failure — so callers can rely on the manifest existing after this resolves.
 *
 * The TS side stays intentionally thin: it only validates inputs, spawns the
 * child, and surfaces a structured result for the world-job coordinator to
 * persist. All model-specific logic lives in the Python worker.
 */
import { isServerSessionId } from './src/shared/session-id.ts'

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
  /** Auto/cpu/cuda — auto chooses cuda when available. */
  device?: 'auto' | 'cpu' | 'cuda'
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
  /** Stderr text from the worker — useful for surfacing in the UI. */
  log: string
  /** Subprocess exit code (0/2/3 per the Python contract). */
  exitCode: number
}

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

  let cmd: Deno.Command
  try {
    cmd = new Deno.Command(python, {
      args: buildWorkerArgs({ ...opts, modelPath }),
      stdout: 'piped',
      stderr: 'piped',
    })
  } catch (e) {
    return _failure(opts.sessionDir, `failed to spawn ${python}: ${e instanceof Error ? e.message : e}`, 3)
  }

  let output: Deno.CommandOutput
  try {
    output = await cmd.output()
  } catch (e) {
    return _failure(opts.sessionDir, `worker crashed: ${e instanceof Error ? e.message : e}`, 3)
  }

  const log = new TextDecoder().decode(output.stderr).trim()
  const manifestFile = `${opts.sessionDir}/lingbot-map.manifest.json`

  let manifestStatus: LingBotMapStatus = 'error'
  let skippedReason: string | undefined
  let errorMsg: string | undefined
  try {
    const manifest = JSON.parse(await Deno.readTextFile(manifestFile)) as Record<string, unknown>
    const status = manifest.status
    if (status === 'ok' || status === 'skipped' || status === 'error') {
      manifestStatus = status
    }
    if (typeof manifest.skippedReason === 'string') skippedReason = manifest.skippedReason
    if (typeof manifest.error === 'string') errorMsg = manifest.error
  } catch {
    // Manifest missing => unrecoverable; preserve exit code + log
    errorMsg = errorMsg ?? `worker exited ${output.code} without writing a manifest`
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
    glbSidecarPath,
    glbPointCount,
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
