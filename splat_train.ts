/**
 * Splat-train worker driver.
 *
 * Mirrors lingbot_map.ts: the TS side stays thin — it converts a keyframe
 * session into a Nerfstudio dataset (splat_train_dataset.ts), spawns the
 * already-built Brush CLI as a subprocess, then locates the exported INRIA
 * 3DGS `.ply`, counts its gaussians, and returns a structured result the
 * world-job coordinator persists as a `splat-train.manifest.json`.
 *
 * The driver never hard-crashes the server:
 *   - a missing / unrunnable Brush binary yields a `skipped` result with a
 *     remediation hint (exactly like lingbot handles a missing model),
 *   - a crash or a run that produced no PLY yields an `error` result.
 *
 * Brush facts baked in (confirmed via `brush-cli --help` on this box):
 *   brush-cli <dataset_dir> --total-train-iters N --sh-degree D
 *     --max-resolution R --export-every N --export-path <out>/
 *     --export-name splat_{iter}.ply --eval-every K
 *   A positional dataset source auto-disables the GUI (headless).
 *   GPU is pinned via env CUBECL_WGPU_DEFAULT_DEVICE (wgpu-native, not HIP).
 *   Brush does not emit a manifest — this driver writes it.
 */

import { buildBrushDataset } from './splat_train_dataset.ts'
import { isRunnable } from './exec_probe.ts'
import { isServerSessionId } from './src/shared/session-id.ts'
// The manifest type lives in src/world/manifests.ts, not here — see that
// file's header (it's the canonical, Deno-API-free home so the browser
// viewer can type-import it without dragging this file's `Deno.*` calls into
// its DOM-lib type-check program). Re-exported below so
// `import type { SplatTrainManifest } from './splat_train.ts'` still works.
import type { SplatTrainManifest } from './src/world/types.ts'
export type { SplatTrainManifest }

export interface SplatTrainRunOptions {
  /** Absolute path to the session directory (scans/sessions/<id>). */
  sessionDir: string
  /** Absolute path where the final .ply should land (e.g. <SCANS>/<base>.splat.ply). */
  outputPlyPath: string
  /** Optional: land a compressed variant here if Brush produced one. */
  outputCompressedPlyPath?: string
  /** Path where the splat-train manifest is written (defaults next to outputPlyPath). */
  manifestPath?: string
  /** Brush binary. Falls back to env BRUSH_BIN, then ~/brush/src/target/release/brush-cli. */
  brushBin?: string
  /** wgpu device pin. Falls back to env BRUSH_DEVICE, then "DiscreteGpu(1)". */
  device?: string
  /** Training iterations. Falls back to env BRUSH_TRAIN_ITERS, then 15000. */
  trainIters?: number
  /** SH degree. Falls back to env BRUSH_SH_DEGREE, then 2. */
  shDegree?: number
  /** Max image resolution. Falls back to env BRUSH_MAX_RES, then 1280. */
  maxResolution?: number
  /** Eval cadence in steps (default = trainIters, i.e. eval once at the end). */
  evalEvery?: number
  /** For testing: skip the real spawn and treat these results as the Brush run. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId: string; scanId?: string }
}

export type SplatTrainStatus = 'ok' | 'skipped' | 'error'

export interface SplatTrainResult {
  status: SplatTrainStatus
  manifest: SplatTrainManifest
  /** Absolute path of the landed .ply when status is 'ok'. */
  plyPath?: string
  /** Absolute path of the compressed .ply when produced. */
  compressedPlyPath?: string
  gaussianCount?: number
  /** stderr tail from Brush — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

const DEFAULT_BRUSH_BIN = `${Deno.env.get('HOME') ?? '~'}/brush/src/target/release/brush-cli`

/**
 * Delegates to the shared `SESSION_ID_RE` (`src/shared/session-id.ts`) rather
 * than a local copy — see lingbot_map.ts's `isValidSessionDir` doc comment
 * for why this file used to carry its own, stale one.
 */
export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return isServerSessionId(base)
}

export function resolveParams(opts: SplatTrainRunOptions) {
  const brushBin = opts.brushBin ?? Deno.env.get('BRUSH_BIN') ?? DEFAULT_BRUSH_BIN
  const device = opts.device ?? Deno.env.get('BRUSH_DEVICE') ?? 'DiscreteGpu(1)'
  const trainIters = opts.trainIters ?? intFromEnv('BRUSH_TRAIN_ITERS', 15000)
  const shDegree = opts.shDegree ?? intFromEnv('BRUSH_SH_DEGREE', 2)
  const maxResolution = opts.maxResolution ?? intFromEnv('BRUSH_MAX_RES', 1280)
  const evalEvery = opts.evalEvery ?? trainIters
  return { brushBin, device, trainIters, shDegree, maxResolution, evalEvery }
}

/**
 * Assemble the Brush CLI arguments. The export directory is a dedicated
 * `exports/` folder under the dataset so the final PLY is easy to locate.
 * `--export-name splat_{iter}.ply` yields `splat_<finalIter>.ply`.
 */
export function buildBrushArgs(
  datasetDir: string,
  exportDir: string,
  params: ReturnType<typeof resolveParams>,
): string[] {
  return [
    datasetDir,
    '--total-train-iters', String(params.trainIters),
    '--sh-degree', String(params.shDegree),
    '--max-resolution', String(params.maxResolution),
    '--export-every', String(params.trainIters),
    '--export-path', exportDir,
    '--export-name', 'splat_{iter}.ply',
    '--eval-every', String(params.evalEvery),
  ]
}

export async function runSplatTrain(opts: SplatTrainRunOptions): Promise<SplatTrainResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath ?? opts.outputPlyPath.replace(/\.splat\.ply$/, '') + '.splat-train.manifest.json'
  const started = Date.now()

  const baseManifest: SplatTrainManifest = {
    schemaVersion: 1,
    tool: 'brush',
    status: 'error',
    createdAt: new Date().toISOString(),
    sessionDir: opts.sessionDir,
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  if (!isValidSessionDir(opts.sessionDir)) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: 'invalid session directory',
    }, 2, 'invalid session directory')
  }

  // 1. Guard: the Brush binary must exist and be executable before we do the
  //    (potentially large) dataset conversion. A missing binary is a *skip*,
  //    not an error — the server keeps running and the UI shows a remediation.
  const brushOk = await isRunnable(params.brushBin)
  if (!brushOk) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `Brush binary not found or not executable: ${params.brushBin}`,
      remediation: 'Build Brush and set BRUSH_BIN (see docs/pipelines/splat-train.md — Setup).',
    }, 0, `brush binary missing: ${params.brushBin}`)
  }

  // 2. Convert the session → Nerfstudio dataset.
  let dataset
  try {
    dataset = await buildBrushDataset({ sessionDir: opts.sessionDir })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // "no keyframes" is a graceful skip; any other conversion failure is an error.
    if (/no keyframes|no usable keyframes/.test(msg)) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'skipped',
        skippedReason: msg,
        remediation: 'Stream keyframes for this scan before training a splat.',
      }, 0, msg)
    }
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `dataset build failed: ${msg}`,
    }, 2, msg)
  }
  baseManifest.frameCount = dataset.frameCount

  // 3. Spawn Brush headless with the GPU pin.
  const exportDir = `${dataset.datasetDir}/exports`
  try {
    await Deno.mkdir(exportDir, { recursive: true })
  } catch {
    // already exists
  }
  const args = buildBrushArgs(dataset.datasetDir, exportDir, params)
  const env: Record<string, string> = { CUBECL_WGPU_DEFAULT_DEVICE: params.device }

  let spawnResult: { code: number; stderr: string }
  try {
    spawnResult = opts._spawn
      ? await opts._spawn(params.brushBin, args, env)
      : await defaultSpawn(params.brushBin, args, env)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `brush spawn failed: ${msg}`,
    }, 3, msg)
  }

  if (spawnResult.code !== 0) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `brush exited ${spawnResult.code}`,
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, spawnResult.stderr)
  }

  // 4. Locate the exported PLY. Prefer the highest-iteration splat_*.ply.
  const exported = await findExportedPly(exportDir)
  if (!exported) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: 'brush finished but produced no .ply in the export directory',
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, spawnResult.stderr)
  }

  // 5. Land the .ply into SCANS_DIR and count gaussians.
  let plyBytes: Uint8Array
  try {
    plyBytes = await Deno.readFile(exported.path)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `could not read exported ply: ${msg}`,
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, spawnResult.stderr)
  }
  const gaussianCount = countPlyVertices(plyBytes) ?? 0
  await Deno.writeFile(opts.outputPlyPath, plyBytes)

  // Best-effort compressed variant: Brush does not emit one by default, but if
  // a *.compressed.ply landed in the export dir, carry it alongside.
  let compressedPlyPath: string | undefined
  if (opts.outputCompressedPlyPath) {
    const compressed = await findExportedPly(exportDir, /\.compressed\.ply$/)
    if (compressed) {
      try {
        await Deno.writeFile(opts.outputCompressedPlyPath, await Deno.readFile(compressed.path))
        compressedPlyPath = opts.outputCompressedPlyPath
      } catch {
        // non-fatal
      }
    }
  }

  const manifest: SplatTrainManifest = {
    ...baseManifest,
    status: 'ok',
    plyPath: opts.outputPlyPath.split('/').pop(),
    compressedPlyPath: compressedPlyPath?.split('/').pop(),
    gaussianCount,
    timing: { elapsedMs: Date.now() - started },
  }
  await writeManifest(manifestPath, manifest)

  return {
    status: 'ok',
    manifest,
    plyPath: opts.outputPlyPath,
    compressedPlyPath,
    gaussianCount,
    log: spawnResult.stderr,
    exitCode: spawnResult.code,
  }
}

/** Count `element vertex N` from a PLY header without decoding the body. */
export function countPlyVertices(bytes: Uint8Array): number | null {
  // The header is ASCII; scan a bounded prefix for the vertex element line.
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
  const m = prefix.match(/element vertex (\d+)/)
  return m ? Number(m[1]) : null
}

async function findExportedPly(
  exportDir: string,
  pattern: RegExp = /\.ply$/,
): Promise<{ path: string; iter: number } | null> {
  let best: { path: string; iter: number } | null = null
  try {
    for await (const entry of Deno.readDir(exportDir)) {
      if (!entry.isFile || !pattern.test(entry.name)) continue
      // For the primary lookup, ignore compressed variants.
      if (pattern.source === /\.ply$/.source && /\.compressed\.ply$/.test(entry.name)) continue
      const iterMatch = entry.name.match(/(\d+)/)
      const iter = iterMatch ? Number(iterMatch[1]) : 0
      if (!best || iter >= best.iter) {
        best = { path: `${exportDir}/${entry.name}`, iter }
      }
    }
  } catch {
    return null
  }
  return best
}

// isRunnable now lives in ./exec_probe.ts — it was duplicated here and in
// splat_detect.ts, and both copies mis-detected every binary as non-runnable
// on Windows (see that file's header for the mode-bit reason).

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

async function writeManifest(path: string, manifest: SplatTrainManifest): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[splat-train] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: SplatTrainManifest,
  exitCode: number,
  log: string,
): Promise<SplatTrainResult> {
  await writeManifest(manifestPath, manifest)
  return { status: manifest.status, manifest, log, exitCode }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
