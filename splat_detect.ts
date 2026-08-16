/**
 * Splat-detect worker driver.
 *
 * Mirrors splat_train.ts: the TS side stays thin — it locates a trained
 * Gaussian-splat PLY, spawns the already-built splat_analyzer pipeline
 * (run_local.py: render → OWLv2 open-vocab detection → 3D boxes) as a
 * subprocess, then copies the resulting `interactions.json` next to the scan
 * and writes a `splat-detect.manifest.json` the world-job coordinator persists.
 *
 * The driver never hard-crashes the server:
 *   - a missing python venv or analyzer dir yields a `skipped` result with a
 *     remediation hint (exactly like splat_train handles a missing Brush binary),
 *   - a crash or a run that produced no interactions.json yields an `error`.
 *
 * splat_analyzer facts baked in (confirmed via run_local.py --help on this box):
 *   run_local.py --ply <x> --prompt <p> --quality low --renderer point
 *     --job_dir <tmp>
 *   Writes <job_dir>/interactions.json (+ frames/ transforms.json we discard).
 *   GPU is pinned via env HIP_VISIBLE_DEVICES=1 (ROCm torch) — WMD_DEVICE=cuda
 *   selects the torch cuda/HIP path; POINT_SPLAT_SIZE=6 sizes the point renderer.
 *   run_local.py does not emit a manifest — this driver writes it.
 *
 * Input selection:
 *   - prefer the scan's <base>.splat.ply (Brush-trained 3DGS),
 *   - else convert the session's lingbot-map.point-cloud.ply into a 3DGS-attribute
 *     PLY via $SPLAT_DETECT_DIR/pointcloud_to_gs.py first, then detect on that.
 */

// The manifest type lives in src/world/manifests.ts, not here — see that
// file's header (it's the canonical, Deno-API-free home so the browser
// viewer can type-import it without dragging this file's `Deno.*` calls into
// its DOM-lib type-check program). Re-exported below so
// `import type { SplatDetectManifest } from './splat_detect.ts'` still works.
import type { SplatDetectManifest } from './src/world/types.ts'
export type { SplatDetectManifest }

const DEFAULT_DETECT_PYTHON = `${Deno.env.get('HOME') ?? '~'}/.venvs/splat-analyzer/bin/python`
const DEFAULT_DETECT_DIR = `${Deno.env.get('HOME') ?? '~'}/splat_analyzer`
const DEFAULT_DETECT_PROMPT = 'sofa, chair, table, tv, lamp, plant, bed, desk, shelf, door, window'
const SESSION_ID_RE = /^(sess|session)-[a-z0-9-]+$/

export interface SplatDetectRunOptions {
  /** Absolute path to the scan's trained splat, when present (<base>.splat.ply). */
  splatPlyPath?: string
  /** Absolute path to the session dir (holds lingbot-map.point-cloud.ply fallback). */
  sessionDir?: string
  /** Where interactions.json should land (e.g. <SCANS>/<base>.interactions.json). */
  outputInteractionsPath: string
  /** Path where the splat-detect manifest is written (defaults next to outputInteractionsPath). */
  manifestPath?: string
  /** Open-vocab prompt. Falls back to env SPLAT_DETECT_PROMPT, then a house default. */
  prompt?: string
  /** Python interpreter. Falls back to env SPLAT_DETECT_PYTHON, then the venv default. */
  python?: string
  /** splat_analyzer checkout dir. Falls back to env SPLAT_DETECT_DIR, then ~/splat_analyzer. */
  detectDir?: string
  /** GPU pin for torch/HIP. Falls back to env HIP_VISIBLE_DEVICES, then "1". */
  hipVisibleDevices?: string
  /** Point-renderer splat size. Falls back to env POINT_SPLAT_SIZE, then "6". */
  pointSplatSize?: string
  /** Camera coverage preset: low (24 views) | medium (90) | high (192). Env SPLAT_DETECT_QUALITY, then "medium". */
  quality?: string
  /** Per-frame OWLv2 confidence cutoff. Env SPLAT_DETECT_SCORE_THRESHOLD; unset = run_local.py default (0.12). */
  scoreThreshold?: string
  /** Frames an object must appear in to be kept. Env SPLAT_DETECT_MIN_VOTES; unset = run_local.py default (8). */
  minVotes?: string
  /** Best single-frame confidence required. Env SPLAT_DETECT_MIN_PEAK_SCORE; unset = run_local.py default (0.40). */
  minPeakScore?: string
  /** For testing: skip the real spawn and treat these results as the analyzer run. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
}

export type SplatDetectStatus = 'ok' | 'skipped' | 'error'

export interface SplatDetectResult {
  status: SplatDetectStatus
  manifest: SplatDetectManifest
  /** Absolute path of the landed interactions.json when status is 'ok'. */
  interactionsPath?: string
  objectCount?: number
  /** stderr tail from the analyzer — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

export function resolveParams(opts: SplatDetectRunOptions) {
  const python = opts.python ?? Deno.env.get('SPLAT_DETECT_PYTHON') ?? DEFAULT_DETECT_PYTHON
  const detectDir = opts.detectDir ?? Deno.env.get('SPLAT_DETECT_DIR') ?? DEFAULT_DETECT_DIR
  const prompt = opts.prompt ?? Deno.env.get('SPLAT_DETECT_PROMPT') ?? DEFAULT_DETECT_PROMPT
  const hipVisibleDevices = opts.hipVisibleDevices ?? Deno.env.get('HIP_VISIBLE_DEVICES') ?? '1'
  const pointSplatSize = opts.pointSplatSize ?? Deno.env.get('POINT_SPLAT_SIZE') ?? '6'
  const quality = opts.quality ?? Deno.env.get('SPLAT_DETECT_QUALITY') ?? 'medium'
  // Clustering knobs: undefined means "let run_local.py use its own default"
  // (score 0.12 / votes 8 / peak 0.40) so we never fight the analyzer when
  // untuned — override only once calibrated on a real room splat.
  const scoreThreshold = opts.scoreThreshold ?? Deno.env.get('SPLAT_DETECT_SCORE_THRESHOLD') ?? undefined
  const minVotes = opts.minVotes ?? Deno.env.get('SPLAT_DETECT_MIN_VOTES') ?? undefined
  const minPeakScore = opts.minPeakScore ?? Deno.env.get('SPLAT_DETECT_MIN_PEAK_SCORE') ?? undefined
  return {
    python,
    detectDir,
    prompt,
    hipVisibleDevices,
    pointSplatSize,
    quality,
    scoreThreshold,
    minVotes,
    minPeakScore,
    renderer: 'point',
  }
}

/**
 * Assemble the run_local.py CLI arguments. `--renderer point` + `--quality low`
 * keep the render cheap (24 preview views) and avoid the gsplat rasterizer that
 * has no ROCm build on this box.
 */
export function buildDetectArgs(
  runLocalPath: string,
  plyPath: string,
  jobDir: string,
  params: ReturnType<typeof resolveParams>,
): string[] {
  const args = [
    runLocalPath,
    '--ply', plyPath,
    '--prompt', params.prompt,
    '--quality', params.quality,
    '--renderer', params.renderer,
    '--job_dir', jobDir,
  ]
  // Only pass clustering knobs when explicitly set — otherwise run_local.py
  // applies its own tuned defaults.
  if (params.scoreThreshold != null) args.push('--score_threshold', params.scoreThreshold)
  if (params.minVotes != null) args.push('--min_votes', params.minVotes)
  if (params.minPeakScore != null) args.push('--min_peak_score', params.minPeakScore)
  return args
}

export async function runSplatDetect(opts: SplatDetectRunOptions): Promise<SplatDetectResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath
    ?? opts.outputInteractionsPath.replace(/\.interactions\.json$/, '') + '.splat-detect.manifest.json'
  const started = Date.now()

  const baseManifest: SplatDetectManifest = {
    schemaVersion: 1,
    tool: 'splat-analyzer',
    status: 'error',
    createdAt: new Date().toISOString(),
    prompt: params.prompt,
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  const runLocalPath = `${params.detectDir}/run_local.py`
  const converterPath = `${params.detectDir}/pointcloud_to_gs.py`

  // 1. Guard: python + the analyzer checkout must exist before we do any work.
  //    A missing venv/dir is a *skip*, not an error — the server keeps running
  //    and the UI shows a remediation.
  if (!(await isRunnable(params.python))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `splat-analyzer python not found or not executable: ${params.python}`,
      remediation: 'Create the venv and set SPLAT_DETECT_PYTHON (see docs/splat-detect.md — Setup).',
    }, 0, `splat-detect python missing: ${params.python}`)
  }
  if (!(await exists(runLocalPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `splat-analyzer run_local.py not found: ${runLocalPath}`,
      remediation: 'Clone splat_analyzer and set SPLAT_DETECT_DIR (see docs/splat-detect.md — Setup).',
    }, 0, `splat-detect dir missing: ${params.detectDir}`)
  }

  // 2. Resolve the input PLY: the trained splat wins; else convert the session's
  //    plain point cloud into a 3DGS-attribute PLY the analyzer loader ingests.
  let detectPly: string
  let convertedPly: string | undefined
  const jobDir = await Deno.makeTempDir({ prefix: 'splat-detect-' })
  try {
    if (opts.splatPlyPath && (await exists(opts.splatPlyPath))) {
      detectPly = opts.splatPlyPath
    } else {
      const srcCloud = opts.sessionDir ? `${opts.sessionDir}/lingbot-map.point-cloud.ply` : undefined
      if (!srcCloud || !(await exists(srcCloud))) {
        await removeQuietly(jobDir)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'skipped',
          skippedReason: 'no splat: scan has no <base>.splat.ply and the session has no lingbot-map.point-cloud.ply',
          remediation: 'Run a splat-train (or lingbot-map-reconstruct) job on this scan first.',
        }, 0, 'splat-detect has no input ply')
      }
      // Convert the plain xyz+rgb cloud into a 3DGS-attribute PLY.
      convertedPly = `${jobDir}/from-pointcloud.gs.ply`
      const convEnv: Record<string, string> = {
        HIP_VISIBLE_DEVICES: params.hipVisibleDevices,
      }
      let convResult: { code: number; stderr: string }
      try {
        convResult = opts._spawn
          ? await opts._spawn(params.python, [converterPath, srcCloud, convertedPly], convEnv)
          : await defaultSpawn(params.python, [converterPath, srcCloud, convertedPly], convEnv)
      } catch (e) {
        await removeQuietly(jobDir)
        const msg = e instanceof Error ? e.message : String(e)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'error',
          error: `pointcloud_to_gs spawn failed: ${msg}`,
        }, 3, msg)
      }
      if (convResult.code !== 0 || !(await exists(convertedPly))) {
        await removeQuietly(jobDir)
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'error',
          error: `pointcloud_to_gs exited ${convResult.code}`,
          timing: { elapsedMs: Date.now() - started },
        }, convResult.code || 3, convResult.stderr)
      }
      detectPly = convertedPly
    }

    // 3. Spawn the analyzer headless with the GPU pin + point renderer.
    const args = buildDetectArgs(runLocalPath, detectPly, jobDir, params)
    const env: Record<string, string> = {
      HIP_VISIBLE_DEVICES: params.hipVisibleDevices,
      WMD_DEVICE: 'cuda',
      POINT_SPLAT_SIZE: params.pointSplatSize,
    }

    let spawnResult: { code: number; stderr: string }
    try {
      spawnResult = opts._spawn
        ? await opts._spawn(params.python, args, env)
        : await defaultSpawn(params.python, args, env)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `splat-analyzer spawn failed: ${msg}`,
      }, 3, msg)
    }

    if (spawnResult.code !== 0) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `splat-analyzer exited ${spawnResult.code}`,
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }

    // 4. Locate + read interactions.json.
    const producedInteractions = `${jobDir}/interactions.json`
    let interactionsText: string
    try {
      interactionsText = await Deno.readTextFile(producedInteractions)
    } catch {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'splat-analyzer finished but produced no interactions.json',
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }
    const objectCount = countInteractions(interactionsText) ?? 0

    // 5. Land interactions.json next to the scan.
    await Deno.writeTextFile(opts.outputInteractionsPath, interactionsText)

    const manifest: SplatDetectManifest = {
      ...baseManifest,
      status: 'ok',
      interactionsPath: opts.outputInteractionsPath.split('/').pop(),
      objectCount,
      timing: { elapsedMs: Date.now() - started },
    }
    await writeManifest(manifestPath, manifest)

    return {
      status: 'ok',
      manifest,
      interactionsPath: opts.outputInteractionsPath,
      objectCount,
      log: spawnResult.stderr,
      exitCode: spawnResult.code,
    }
  } finally {
    await removeQuietly(jobDir)
  }
}

/** Count detected objects from an interactions.json payload. */
export function countInteractions(text: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed.length
  if (parsed && typeof parsed === 'object') {
    const objs = (parsed as Record<string, unknown>)['objects']
    if (Array.isArray(objs)) return objs.length
    const interactions = (parsed as Record<string, unknown>)['interactions']
    if (Array.isArray(interactions)) return interactions.length
  }
  return null
}

export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return SESSION_ID_RE.test(base)
}

async function isRunnable(bin: string): Promise<boolean> {
  try {
    const info = await Deno.stat(bin)
    if (!info.isFile) return false
    if (typeof info.mode === 'number') {
      return (info.mode & 0o111) !== 0
    }
    return true
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true })
  } catch {
    // already gone
  }
}

async function defaultSpawn(
  bin: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command(bin, {
    args,
    env: extraEnv,
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  const stderr = new TextDecoder().decode(output.stderr).trim()
  return { code: output.code, stderr }
}

async function writeManifest(path: string, manifest: SplatDetectManifest): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[splat-detect] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: SplatDetectManifest,
  exitCode: number,
  log: string,
): Promise<SplatDetectResult> {
  await writeManifest(manifestPath, manifest)
  return { status: manifest.status, manifest, log, exitCode }
}
