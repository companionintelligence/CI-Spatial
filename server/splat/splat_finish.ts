/**
 * Splat-finish worker driver — Stage 4 of the splat pipeline.
 *
 * Mirrors splat_train.ts / splat_detect.ts: the TS side stays thin — it takes a
 * scan's trained `<base>.splat.ply` and spawns the @playcanvas/splat-transform
 * CLI (a devDependency, run via node) twice to produce the two web-delivery
 * artifacts, then writes a `<base>.splat-finish.manifest.json` the world-job
 * coordinator persists:
 *
 *   <base>.sog             super-compressed SOG bundle (single ZIP file:
 *                          meta.json + WebP attribute textures) — ~8x smaller
 *                          than the raw PLY, loads directly in SparkJS.
 *   <base>.compressed.ply  SuperSplat compressed PLY — ~4x smaller, loads
 *                          through Spark's standard PLY path.
 *
 * The driver never hard-crashes the server:
 *   - a missing input splat or a missing splat-transform CLI yields a `skipped`
 *     result with a remediation hint (exactly like splat_train handles a
 *     missing Brush binary),
 *   - a CLI crash or a run that produced no output yields an `error` result.
 *
 * splat-transform facts baked in (confirmed via the real CLI v2.7.1 on this box):
 *   node <cli.mjs> -w [-g cpu|<adapter>] [-i N] input.ply output.sog
 *   node <cli.mjs> -w input.ply output.compressed.ply
 *   The output format is picked from the output filename. `.sog` is written as
 *   ONE bundled ZIP file (not a directory). Exit code is non-zero on failure.
 *   SOG SH compression can use a GPU adapter; `-g cpu` forces the always-available
 *   CPU path (fast enough: <1s for ~19k gaussians) and avoids contending with
 *   the Ollama/torch GPUs on this box. Writing .compressed.ply needs no GPU.
 */

import { fromFileUrl } from '@std/path'
import { countPlyVertices } from './splat_train.ts'
// The manifest types live in src/world/manifests.ts, not here — see that
// file's header (it's the canonical, Deno-API-free home so the browser
// viewer can type-import it without dragging this file's `Deno.*` calls into
// its DOM-lib type-check program). Re-exported below so
// `import type { SplatFinishManifest } from './splat_finish.ts'` still works.
import type { SplatFinishManifest, SplatFinishSizes } from '../../src/world/types.ts'
export type { SplatFinishManifest, SplatFinishSizes }

// fromFileUrl, not `.pathname`: the latter yields "/C:/…" on Windows, which
// Deno.Command resolves against the drive root and fails to find.
const DEFAULT_CLI_PATH = fromFileUrl(
  new URL('./node_modules/@playcanvas/splat-transform/bin/cli.mjs', import.meta.url),
)

export interface SplatFinishRunOptions {
  /** Absolute path to the scan's trained splat (<SCANS>/<base>.splat.ply). */
  splatPlyPath: string
  /** Absolute path where the SOG bundle should land (<SCANS>/<base>.sog). */
  outputSogPath: string
  /** Absolute path where the compressed PLY should land (<SCANS>/<base>.compressed.ply). */
  outputCompressedPlyPath: string
  /** Path where the splat-finish manifest is written (defaults next to outputSogPath). */
  manifestPath?: string
  /** node binary used to run the CLI. Falls back to env SPLAT_FINISH_NODE, then "node". */
  nodeBin?: string
  /** splat-transform cli.mjs path. Falls back to env SPLAT_TRANSFORM_CLI, then the local node_modules copy. */
  cliPath?: string
  /** GPU selector for SOG compression: "cpu" or an adapter index. Env SPLAT_FINISH_GPU, then "cpu". */
  gpu?: string
  /** SH-compression k-means iterations. Env SPLAT_FINISH_SH_ITERS, then 10. */
  iterations?: number
  /** For testing: skip the real spawn and treat these results as the CLI run. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
}

export type SplatFinishStatus = 'ok' | 'skipped' | 'error'

export interface SplatFinishResult {
  status: SplatFinishStatus
  manifest: SplatFinishManifest
  /** Absolute path of the landed .sog when status is 'ok'. */
  sogPath?: string
  /** Absolute path of the landed .compressed.ply when status is 'ok'. */
  compressedPlyPath?: string
  sizes?: SplatFinishSizes
  /** stderr tail from the CLI — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

export function resolveParams(opts: SplatFinishRunOptions) {
  const nodeBin = opts.nodeBin ?? Deno.env.get('SPLAT_FINISH_NODE') ?? 'node'
  const cliPath = opts.cliPath ?? Deno.env.get('SPLAT_TRANSFORM_CLI') ?? DEFAULT_CLI_PATH
  const gpu = opts.gpu ?? Deno.env.get('SPLAT_FINISH_GPU') ?? 'cpu'
  const iterations = opts.iterations ?? intFromEnv('SPLAT_FINISH_SH_ITERS', 10)
  return { nodeBin, cliPath, gpu, iterations }
}

/** CLI args for the PLY → SOG leg (SH compression honours -g/-i). */
export function buildSogArgs(
  cliPath: string,
  inputPly: string,
  outputSog: string,
  params: ReturnType<typeof resolveParams>,
): string[] {
  return [
    cliPath,
    '-w',
    '-g', params.gpu,
    '-i', String(params.iterations),
    inputPly,
    outputSog,
  ]
}

/** CLI args for the PLY → compressed PLY leg (no GPU involved). */
export function buildCompressedArgs(
  cliPath: string,
  inputPly: string,
  outputCompressedPly: string,
): string[] {
  return [cliPath, '-w', inputPly, outputCompressedPly]
}

export async function runSplatFinish(opts: SplatFinishRunOptions): Promise<SplatFinishResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath
    ?? opts.outputSogPath.replace(/\.sog$/, '') + '.splat-finish.manifest.json'
  const started = Date.now()

  const baseManifest: SplatFinishManifest = {
    schemaVersion: 1,
    tool: 'splat-transform',
    status: 'error',
    createdAt: new Date().toISOString(),
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  // 1. Guard: the trained splat must exist. Missing input is a *skip*, not an
  //    error — the server keeps running and the UI shows a remediation.
  const inputInfo = await statQuietly(opts.splatPlyPath)
  if (!inputInfo || !inputInfo.isFile) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `no trained splat: ${opts.splatPlyPath} does not exist`,
      remediation: 'Run a splat-train job on this scan first.',
    }, 0, `splat-finish has no input ply: ${opts.splatPlyPath}`)
  }

  // 2. Guard: the splat-transform CLI must exist (it is an npm devDependency).
  if (!(await exists(params.cliPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `splat-transform CLI not found: ${params.cliPath}`,
      remediation: 'npm install (or set SPLAT_TRANSFORM_CLI to a @playcanvas/splat-transform bin/cli.mjs).',
    }, 0, `splat-transform cli missing: ${params.cliPath}`)
  }

  // Input stats for the manifest ratios.
  const inputBytes = inputInfo.size
  let gaussianCount: number | undefined
  try {
    const head = await readPrefix(opts.splatPlyPath, 4096)
    gaussianCount = countPlyVertices(head) ?? undefined
  } catch {
    // header stays unknown — non-fatal
  }
  baseManifest.gaussianCount = gaussianCount

  // 3. Leg 1: PLY → SOG bundle.
  const sogArgs = buildSogArgs(params.cliPath, opts.splatPlyPath, opts.outputSogPath, params)
  let sogRun: { code: number; stderr: string }
  try {
    sogRun = opts._spawn
      ? await opts._spawn(params.nodeBin, sogArgs, {})
      : await defaultSpawn(params.nodeBin, sogArgs, {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `splat-transform spawn failed: ${msg}`,
    }, 3, msg)
  }
  if (sogRun.code !== 0) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `splat-transform (sog) exited ${sogRun.code}`,
      timing: { elapsedMs: Date.now() - started },
    }, sogRun.code, sogRun.stderr)
  }

  // 4. Leg 2: PLY → compressed PLY.
  const compressedArgs = buildCompressedArgs(params.cliPath, opts.splatPlyPath, opts.outputCompressedPlyPath)
  let compressedRun: { code: number; stderr: string }
  try {
    compressedRun = opts._spawn
      ? await opts._spawn(params.nodeBin, compressedArgs, {})
      : await defaultSpawn(params.nodeBin, compressedArgs, {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `splat-transform spawn failed: ${msg}`,
    }, 3, msg)
  }
  if (compressedRun.code !== 0) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `splat-transform (compressed.ply) exited ${compressedRun.code}`,
      timing: { elapsedMs: Date.now() - started },
    }, compressedRun.code, compressedRun.stderr)
  }

  // 5. Verify + size the outputs. A zero-exit run with no artifact is an error.
  const sogInfo = await statQuietly(opts.outputSogPath)
  const compressedInfo = await statQuietly(opts.outputCompressedPlyPath)
  if (!sogInfo?.isFile || !compressedInfo?.isFile) {
    const missing = !sogInfo?.isFile ? opts.outputSogPath : opts.outputCompressedPlyPath
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `splat-transform finished but produced no output: ${missing}`,
      timing: { elapsedMs: Date.now() - started },
    }, 0, `${sogRun.stderr}\n${compressedRun.stderr}`.trim())
  }

  const sizes: SplatFinishSizes = {
    inputBytes,
    sogBytes: sogInfo.size,
    compressedBytes: compressedInfo.size,
  }
  const manifest: SplatFinishManifest = {
    ...baseManifest,
    status: 'ok',
    sogPath: opts.outputSogPath.split('/').pop(),
    compressedPlyPath: opts.outputCompressedPlyPath.split('/').pop(),
    sizes,
    timing: { elapsedMs: Date.now() - started },
  }
  await writeManifest(manifestPath, manifest)

  return {
    status: 'ok',
    manifest,
    sogPath: opts.outputSogPath,
    compressedPlyPath: opts.outputCompressedPlyPath,
    sizes,
    log: `${sogRun.stderr}\n${compressedRun.stderr}`.trim(),
    exitCode: 0,
  }
}

async function statQuietly(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path)
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return (await statQuietly(path)) !== null
}

/** Read at most `n` bytes from the start of a file (enough for a PLY header). */
async function readPrefix(path: string, n: number): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true })
  try {
    const buf = new Uint8Array(n)
    let read = 0
    while (read < n) {
      const got = await file.read(buf.subarray(read))
      if (got === null) break
      read += got
    }
    return buf.subarray(0, read)
  } finally {
    file.close()
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

async function writeManifest(path: string, manifest: SplatFinishManifest): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[splat-finish] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: SplatFinishManifest,
  exitCode: number,
  log: string,
): Promise<SplatFinishResult> {
  await writeManifest(manifestPath, manifest)
  return { status: manifest.status, manifest, log, exitCode }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
