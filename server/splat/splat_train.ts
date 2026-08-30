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

import { resolve } from '@std/path'
import { buildBrushDataset } from './splat_train_dataset.ts'
import { isRunnable } from '../exec_probe.ts'
import { runColmapPoses } from '../colmap/colmap_poses.ts'
import { isServerSessionId } from '../../src/shared/session-id.ts'
// The manifest type lives in src/world/manifests.ts, not here — see that
// file's header (it's the canonical, Deno-API-free home so the browser
// viewer can type-import it without dragging this file's `Deno.*` calls into
// its DOM-lib type-check program). Re-exported below so
// `import type { SplatTrainManifest } from './splat_train.ts'` still works.
import type { SplatTrainManifest } from '../../src/world/types.ts'
export type { SplatTrainManifest }
import { degenerateSplatRemediation, measureSplatQuality, scaleFrameOf } from './splat_quality.ts'
import type { SplatQuality } from './splat_quality.ts'

/**
 * `SplatTrainManifest` plus the two fields this stage learned to write after
 * that type was frozen: the splat's own quality verdict, and the gaussian
 * budget it was trained under.
 *
 * Declared here for exactly the reason `ColmapPosesManifestWithQuality` is
 * declared in colmap_poses.ts: the fields belong in src/world/manifests.ts
 * beside the rest of the manifest shape, and that file is owned by another
 * change in flight. Moving `SplatQuality` there and adding `quality?` /
 * `params.maxSplats` to `SplatTrainManifest` collapses this alias to nothing,
 * with no call-site edits.
 */
export type SplatTrainManifestWithQuality = Omit<SplatTrainManifest, 'params'> & {
  params: SplatTrainManifest['params'] & { maxSplats: number }
  quality?: SplatQuality
  /**
   * Why no verdict was reached, when one was attempted and could not be.
   *
   * Present INSTEAD of `quality`, never alongside it. A manifest with neither
   * field would say `status: 'ok'` about a run nothing checked, which reads
   * exactly like a run that passed — the failure mode this whole verdict exists
   * to remove, so an unmeasurable splat has to say so out loud.
   */
  qualityError?: string
}

/**
 * Gaussian budget both backends are given, so an A/B differs by the trainer.
 *
 * 1,000,000 is Spirula's `--cap-max` default rather than Brush's 10,000,000:
 * Spirula treats the number as a target and reaches it, Brush treats it as a
 * ceiling it does not approach, so the lower of the two is the only value that
 * constrains anything at all. Measured on sess-video-20260830-054518 at this
 * budget: Brush 258,710 gaussians, Spirula 997,922.
 */
export const DEFAULT_MAX_SPLATS = 1_000_000

export interface SplatTrainRunOptions {
  /**
   * Path to the session directory (scans/sessions/<id>). May be relative — the
   * world-job runner passes SCANS_DIR through verbatim and that defaults to
   * './scans'. It is resolved against the process cwd on the way in, before it
   * reaches a symlink target, Brush's CLI, or the manifest.
   */
  sessionDir: string
  /** Absolute path where the final .ply should land (e.g. <SCANS>/<base>.splat.ply). */
  outputPlyPath: string
  /** Optional: land a compressed variant here if Brush produced one. */
  outputCompressedPlyPath?: string
  /** Path where the splat-train manifest is written (defaults next to outputPlyPath). */
  manifestPath?: string
  /** Brush binary. Falls back to env BRUSH_BIN, then ~/brush/target/release/brush-cli. */
  brushBin?: string
  /**
   * wgpu adapter pin, forwarded as CUBECL_WGPU_DEFAULT_DEVICE. Falls back to
   * env BRUSH_DEVICE, then empty — meaning *no* pin, so wgpu picks the default
   * adapter (Metal on Apple Silicon, the sole dGPU on a single-GPU box). Only
   * set it on a multi-GPU host that needs a specific one; a hardcoded default
   * like `DiscreteGpu(1)` matches exactly one machine and selects nothing
   * everywhere else.
   */
  device?: string
  /**
   * Run a COLMAP pose solve when the session has no poses (default true,
   * or env SPLAT_TRAIN_AUTO_POSES=0 to disable).
   */
  autoSolvePoses?: boolean
  /** Training iterations. Falls back to env BRUSH_TRAIN_ITERS, then 15000. */
  trainIters?: number
  /** SH degree. Falls back to env BRUSH_SH_DEGREE, then 2. */
  shDegree?: number
  /** Max image resolution. Falls back to env BRUSH_MAX_RES, then 1280. */
  maxResolution?: number
  /**
   * Upper bound on gaussians, forwarded as `--max-splats`. Falls back to env
   * BRUSH_MAX_SPLATS, then 1,000,000 — Spirula's `--cap-max` default, so the
   * two backends are given the SAME budget and an A/B between them differs by
   * the trainer rather than by its allowance.
   *
   * Brush's own default is 10,000,000, and lowering it to 1,000,000 changes
   * nothing about what it produces: brush-cli --help calls it "only an upper
   * bound, the actual final number of splats is NOT determined by this", and
   * the measured run under this budget finished at 258,710 — a quarter of the
   * way to it. That asymmetry is the honest finding of the A/B and is why the
   * budget can be equalised as an INPUT but not as an output: Spirula
   * saturates the same cap (997,922 of 1,000,000), Brush stops where its
   * densification stops.
   */
  maxSplats?: number
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
  manifest: SplatTrainManifestWithQuality
  /** Absolute path of the landed .ply when status is 'ok'. */
  plyPath?: string
  /** Absolute path of the compressed .ply when produced. */
  compressedPlyPath?: string
  gaussianCount?: number
  /**
   * The splat's own verdict. Present whenever a PLY landed and could be read —
   * callers that gate on `status !== 'ok'` alone are the reason a splat trained
   * from a 3-of-17 solve reaches the viewer looking like any other.
   */
  quality?: SplatQuality
  /** stderr tail from Brush — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

const DEFAULT_BRUSH_BIN = `${Deno.env.get('HOME') ?? '~'}/brush/target/release/brush-cli`

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
  const device = opts.device ?? Deno.env.get('BRUSH_DEVICE') ?? ''
  const trainIters = opts.trainIters ?? intFromEnv('BRUSH_TRAIN_ITERS', 15000)
  const shDegree = opts.shDegree ?? intFromEnv('BRUSH_SH_DEGREE', 2)
  const maxResolution = opts.maxResolution ?? intFromEnv('BRUSH_MAX_RES', 1280)
  const maxSplats = opts.maxSplats ?? intFromEnv('BRUSH_MAX_SPLATS', DEFAULT_MAX_SPLATS)
  const evalEvery = opts.evalEvery ?? trainIters
  return { brushBin, device, trainIters, shDegree, maxResolution, maxSplats, evalEvery }
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
    '--max-splats', String(params.maxSplats),
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

  // Resolve the caller's session dir once, before anything records or consumes
  // it. The world-job runner hands us SCANS_DIR verbatim ('./scans' by
  // default), and a manifest that says `sessionDir: "./scans/sessions/sess-…"`
  // is only meaningful to a reader who also knows the server's cwd — while
  // every downstream consumer (the dataset builder's symlink targets, Brush's
  // dataset-relative --export-path) needs an absolute one to be correct at all.
  const sessionDir = resolve(opts.sessionDir)

  const baseManifest: SplatTrainManifestWithQuality = {
    schemaVersion: 1,
    tool: 'brush',
    status: 'error',
    createdAt: new Date().toISOString(),
    sessionDir,
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  if (!isValidSessionDir(sessionDir)) {
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
      // Name the command, the way colmap_poses.ts's skip does — "build Brush"
      // alone sends the reader to a repo they then have to guess the build
      // invocation for, and `--bin brush-cli` (the obvious guess) fails on this
      // workspace: it needs `-p`, see docs/pipelines/splat-train.md — Setup.
      remediation:
        'Build Brush (`git clone https://github.com/ArthurBrussee/brush ~/brush && ' +
        'cd ~/brush && cargo build --release -p brush-cli`) or set BRUSH_BIN to an existing brush-cli. ' +
        'Needs a Vulkan/Metal-capable GPU; see docs/pipelines/splat-train.md — Setup.',
    }, 0, `brush binary missing: ${params.brushBin}`)
  }

  // 2. Convert the session → Nerfstudio dataset.
  //
  // A pose-less session is recoverable, not terminal: COLMAP can solve the
  // poses on CPU. Auto-chaining it here is what makes `splat-train` a
  // pipeline rather than a stage that requires a human to notice the
  // dependency and queue it by hand — which is exactly how every
  // photo-ingest session ended up stuck at "no camera poses". Opt out with
  // SPLAT_TRAIN_AUTO_POSES=0 (or `autoSolvePoses: false`) when a caller
  // wants the failure surfaced instead of repaired.
  let dataset
  const autoSolve = opts.autoSolvePoses ?? Deno.env.get('SPLAT_TRAIN_AUTO_POSES') !== '0'
  try {
    dataset = await buildBrushDataset({ sessionDir })
  } catch (e0) {
    const msg0 = e0 instanceof Error ? e0.message : String(e0)
    if (autoSolve && /no camera poses/.test(msg0)) {
      const solved = await runColmapPoses({ sessionDir })
      if (solved.status !== 'ok') {
        // Surface COLMAP's own diagnosis — it distinguishes "not installed"
        // from "this capture has no parallax", and those need different fixes.
        const reason = solved.manifest.skippedReason ?? solved.manifest.error ?? 'pose solve failed'
        return _finish(manifestPath, {
          ...baseManifest,
          status: solved.status === 'skipped' ? 'skipped' : 'error',
          ...(solved.status === 'skipped' ? { skippedReason: reason } : { error: reason }),
          remediation: solved.manifest.remediation,
        }, solved.status === 'skipped' ? 0 : 2, solved.log)
      }
    }
    try {
      dataset = await buildBrushDataset({ sessionDir })
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
  }
  baseManifest.frameCount = dataset.frameCount

  // 3. Spawn Brush headless with the GPU pin.
  //
  // `--export-path` MUST be absolute. brush-cli --help: "Path is relative to
  // the dataset's parent directory (or CWD if unavailable)" — not to our cwd,
  // and not to the dataset dir itself. A relative one therefore lands the .ply
  // under <sessionDir>/<the-relative-path>, `findExportedPly` sees an empty
  // exports/, and the run reports "produced no .ply" on a zero exit code —
  // i.e. it throws away a completed multi-minute train. `buildBrushDataset`
  // returns an absolute `datasetDir` (it resolves its inputs), so this is
  // absolute by construction; do not reintroduce a relative one.
  const exportDir = `${dataset.datasetDir}/exports`
  try {
    await Deno.mkdir(exportDir, { recursive: true })
  } catch {
    // already exists
  }
  const args = buildBrushArgs(dataset.datasetDir, exportDir, params)
  const env: Record<string, string> = params.device
    ? { CUBECL_WGPU_DEFAULT_DEVICE: params.device }
    : {}

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
    // Carry Brush's own diagnosis onto the manifest, not just the exit code.
    // The manifest is the only durable record of a run — `log` is returned to
    // the caller and then dropped — so a bare "brush exited 1" is the end of
    // the trail for anyone reading scans/*.splat-train.manifest.json after the
    // fact. That is exactly what happened to the first splat-train ever
    // enqueued here: the on-disk manifest said "brush exited 1" and nothing
    // else, while the stderr it discarded said "dataset contains no usable
    // training views (all images missing or filtered out)" — which names the
    // real cause. Same reasoning as colmap_poses.ts keeping a stderr slice.
    const tail = stderrTail(spawnResult.stderr)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: tail ? `brush exited ${spawnResult.code}: ${tail}` : `brush exited ${spawnResult.code}`,
      remediation:
        'Read the message above — it is Brush\'s own. Re-run the same command by hand to see the full log: ' +
        `${params.brushBin} ${args.join(' ')} (see docs/pipelines/splat-train.md — Troubleshooting).`,
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, spawnResult.stderr)
  }

  // 4. Locate the exported PLY. Prefer the highest-iteration splat_*.ply.
  const exported = await findExportedPly(exportDir)
  if (!exported) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `brush exited 0 but produced no .ply in ${exportDir}`,
      // This branch costs a whole training run before it fires, so it names the
      // one thing that has actually caused it: a non-absolute --export-path,
      // which Brush resolves against the dataset's PARENT dir (see step 3).
      remediation:
        'Brush trained but nothing landed. Check for a stray splat_*.ply elsewhere under the session ' +
        `dir (\`find ${sessionDir} -name 'splat_*.ply'\`): Brush resolves a relative --export-path ` +
        'against the dataset\'s parent directory, so a misplaced export means a relative dataset path got through.',
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
  // An unreadable header or a zero-gaussian export is a FAILED run, not an
  // `ok` one with a small number in it. `countPlyVertices(...) ?? 0` used to
  // flow straight into a `status: 'ok'` manifest, so a Brush run that exported
  // an empty PLY was indistinguishable from one that reconstructed the room —
  // the same shape of unearned success as a 3-of-17 COLMAP solve reporting ok.
  // Nothing downstream can use zero gaussians, so nothing downstream should be
  // told the stage succeeded.
  const countedGaussians = countPlyVertices(plyBytes)
  if (countedGaussians === null || countedGaussians === 0) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      gaussianCount: countedGaussians ?? undefined,
      error: countedGaussians === null
        ? `brush exported ${exported.path} but it has no readable PLY header`
        : 'brush exported a PLY with 0 gaussians',
      remediation:
        'The trainer ran to completion and produced nothing usable. Check that the dataset actually ' +
        `had posed images (\`${dataset.transformsPath}\`, ${dataset.frameCount} frame(s)), then re-run ` +
        `by hand to see the full log: ${params.brushBin} ${args.join(' ')}.`,
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, spawnResult.stderr)
  }
  const gaussianCount = countedGaussians
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

  // Judge the splat that just landed. A large, well-formed PLY is not evidence
  // of a good reconstruction — see splat_quality.ts's header for the two
  // healthy runs whose raw extents are 2.9x and 6.9x their own seed cloud.
  const quality = await measureSplatQuality({
    plyPath: opts.outputPlyPath,
    seedPlyPath: dataset.seedPlyPath,
    sessionDir,
    scaleFrame: scaleFrameOf(dataset.posedFrames),
  })

  const manifest: SplatTrainManifestWithQuality = {
    ...baseManifest,
    status: 'ok',
    plyPath: opts.outputPlyPath.split('/').pop(),
    compressedPlyPath: compressedPlyPath?.split('/').pop(),
    gaussianCount,
    ...(quality
      ? {
        quality,
        // The stage still succeeded — Brush ran, and the .ply is the most
        // useful thing to look at even when the verdict is bad, exactly as
        // colmap_poses.ts keeps a degenerate model rather than deleting it.
        // What changes is that the manifest now says so, and carries the fix.
        ...(quality.degenerate ? { remediation: degenerateSplatRemediation(quality) } : {}),
      }
      : { qualityError: `could not measure ${opts.outputPlyPath}: unreadable PLY` }),
    timing: { elapsedMs: Date.now() - started },
  }
  await writeManifest(manifestPath, manifest)

  return {
    status: 'ok',
    manifest,
    plyPath: opts.outputPlyPath,
    compressedPlyPath,
    gaussianCount,
    ...(quality ? { quality } : {}),
    log: spawnResult.stderr,
    exitCode: spawnResult.code,
  }
}

/**
 * Condense a Brush stderr dump into something that fits a manifest's `error`.
 *
 * The last non-empty lines, not the first: Brush logs wgpu adapter selection
 * and per-step training noise before it fails, so the head of the stream is
 * never the diagnosis. Three lines is enough for the messages seen so far
 * (`Error: Error when decoding format: dataset contains no usable training
 * views (all images missing or filtered out)` is one), and the cap keeps a
 * panic backtrace from turning the manifest into a log file — the full stream
 * still reaches the caller as `result.log`.
 */
export function stderrTail(stderr: string, maxChars = 600, maxLines = 3): string {
  const lines = stderr.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return ''
  const tail = lines.slice(-maxLines).join(' | ')
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail
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

async function writeManifest(path: string, manifest: SplatTrainManifestWithQuality): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[splat-train] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: SplatTrainManifestWithQuality,
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
