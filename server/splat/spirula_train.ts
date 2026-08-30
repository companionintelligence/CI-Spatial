/**
 * Spirula Studio splat-train driver — the alternative backend to Brush.
 *
 * Same contract as splat_train.ts, deliberately: same options shape, same
 * `ok`/`skipped`/`error` semantics, same manifest fields, the same stderr tail
 * preserved on failure, and the same `SplatTrainResult`-compatible return value
 * so `_runSplatTrainJob` can pick a backend with one ternary and touch nothing
 * else. Read splat_train.ts first — every comment there about WHY the driver is
 * shaped this way applies here too and is not repeated.
 *
 * *** LICENSING — do not undo this ***
 * Spirula Studio is GPL-3.0; this repo is not. The ONLY permitted coupling is
 * process invocation: argv in, files out, exactly as this repo already invokes
 * Brush and COLMAP. No Spirula source is vendored, translated, or adapted here,
 * and the binary is not committed — it is resolved at runtime from SPIRULA_BIN
 * or a small fallback list, and its absence is a `skipped`, never a crash.
 * Everything below was learned from `spirula --help` / `spirula train --help`
 * and from running the binary, never from reading its source.
 *
 * Spirula facts measured on this box (v2026.8.28, ubuntu-vulkan-x86_64):
 *   spirula train <preset> --data <dir> --data-format nerfstudio
 *     --num-iterations N --sh-degree D --quality {low|medium|high|ultra}
 *     --device <index|name substring>
 *     --output-dir-prefix <dir> --output-dir-name <name>
 *     --disable-viewer 1 --keep-viewer-alive 0
 *   - It reads the SAME Nerfstudio layout buildBrushDataset already writes,
 *     with one exception: its parser rejects `"camera_model": "PERSPECTIVE"`
 *     ("error: NerfstudioParser: unsupported camera model PERSPECTIVE", exit 1)
 *     and wants OPENCV / PINHOLE / SIMPLE_PINHOLE. Hence the `cameraModel`
 *     option added to splat_train_dataset.ts rather than a second converter.
 *   - There is no export flag. It writes checkpoints as
 *     <out>/<name>/step-<9 digits>.ckpt/{state.tar,splat.ply}, and splat.ply is
 *     a standard INRIA 3DGS PLY (`element vertex N`, f_dc_N and f_rest_N), so
 *     countPlyVertices reads it unchanged.
 *   - `--keep-viewer-alive` defaults to 1, which would leave a finished job
 *     hanging on a web viewer forever. Both viewer flags are therefore always
 *     passed, not exposed as options.
 *   - There is no image max-resolution flag anywhere in its 194-flag
 *     `--help-all`; it trains at the dataset's native size. That is why
 *     `params` here has no `maxResolution` counterpart to Brush's.
 */

import { resolve } from '@std/path'
import { buildBrushDataset } from './splat_train_dataset.ts'
import { isRunnable } from '../exec_probe.ts'
import { runColmapPoses } from '../colmap/colmap_poses.ts'
// ADR 0001 — these three are the splat-train driver's, not Brush's: the
// session-dir predicate, the manifest-sized stderr condenser, and the PLY
// header vertex count are all backend-independent, and a second copy of any of
// them is exactly the drift `exec_probe.ts` was extracted to stop.
import { countPlyVertices, isValidSessionDir, stderrTail } from './splat_train.ts'
import type { SplatTrainResult, SplatTrainStatus } from './splat_train.ts'
import type { SplatTrainManifest } from '../../src/world/types.ts'

/**
 * The Brush manifest with the two backend-specific fields swapped.
 *
 * Derived from `SplatTrainManifest` rather than written out again so that
 * every shared field (status, timing, provenance, remediation, …) stays
 * defined in exactly one place — src/world/manifests.ts — and a change there
 * reaches this backend automatically.
 */
export type SpirulaTrainManifest = Omit<SplatTrainManifest, 'tool' | 'params'> & {
  tool: 'spirula'
  params: {
    spirulaBin: string
    device: string
    trainIters: number
    shDegree: number
    preset: string
    quality: string
  }
}

export interface SpirulaTrainRunOptions {
  /** Session directory (scans/sessions/<id>). Resolved to absolute on the way in. */
  sessionDir: string
  /** Absolute path where the final .ply should land (e.g. <SCANS>/<base>.splat.ply). */
  outputPlyPath: string
  /** Accepted for signature parity with runSplatTrain; Spirula emits no compressed variant. */
  outputCompressedPlyPath?: string
  /** Path where the splat-train manifest is written (defaults next to outputPlyPath). */
  manifestPath?: string
  /** Spirula binary. Falls back to env SPIRULA_BIN, then FALLBACK_SPIRULA_BINS. */
  spirulaBin?: string
  /**
   * `--device`, an index or a name substring (its device list prints at
   * startup). Falls back to env SPIRULA_DEVICE, then empty — meaning no pin, so
   * Spirula picks its own default, which on this box is the discrete RTX 4080
   * over the integrated Intel and the llvmpipe CPU adapter. Same reasoning as
   * BRUSH_DEVICE: a hardcoded index matches one machine.
   */
  device?: string
  /** Run a COLMAP pose solve when the session has no poses (env SPLAT_TRAIN_AUTO_POSES=0 disables). */
  autoSolvePoses?: boolean
  /** Training iterations. Falls back to env SPIRULA_TRAIN_ITERS, then 15000 (Brush's default, so A/B is like-for-like). */
  trainIters?: number
  /** SH degree. Falls back to env SPIRULA_SH_DEGREE, then 2 (Brush's default; Spirula's own is 3). */
  shDegree?: number
  /** Training preset, the first positional argument. Falls back to env SPIRULA_PRESET, then '3dgs'. */
  preset?: string
  /** `--quality`, the splat budget. Falls back to env SPIRULA_QUALITY, then 'medium'. */
  quality?: string
  /** For testing: skip the real spawn and treat these results as the Spirula run. */
  _spawn?: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; stderr: string; stdout?: string }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId: string; scanId?: string }
}

export interface SpirulaTrainResult extends Omit<SplatTrainResult, 'manifest'> {
  manifest: SpirulaTrainManifest
}

/**
 * Where an unconfigured install is looked for, in order.
 *
 * Modelled on colmap_poses.ts's FALLBACK_COLMAP_BINS, and for the same reason:
 * the release is a single self-contained binary a developer unzips somewhere
 * user-local, and requiring an env var for the one layout everyone actually
 * uses turns a working box into a `skipped`. The absolute path that was
 * actually run is recorded in the manifest, so a fallback hit is never
 * ambiguous after the fact.
 */
export const FALLBACK_SPIRULA_BINS = [
  `${Deno.env.get('HOME') ?? '~'}/opt/spirula/spirula`,
  `${Deno.env.get('HOME') ?? '~'}/.local/bin/spirula`,
  '/usr/local/bin/spirula',
]

/** Spirula's Nerfstudio parser rejects 'PERSPECTIVE'; see this file's header. */
export const SPIRULA_CAMERA_MODEL = 'OPENCV' as const

/** Its own dataset dir, so the two backends never race on one transforms.json. */
const DATASET_SUBDIR = 'spirula-dataset'
const OUTPUT_SUBDIR = 'spirula-out'
const RUN_NAME = 'run'

export async function resolveSpirulaBin(opts: SpirulaTrainRunOptions): Promise<string> {
  const explicit = opts.spirulaBin ?? Deno.env.get('SPIRULA_BIN')
  if (explicit) return explicit
  for (const candidate of FALLBACK_SPIRULA_BINS) {
    if (await isRunnable(candidate)) return candidate
  }
  return FALLBACK_SPIRULA_BINS[0]
}

export function resolveSpirulaParams(
  opts: SpirulaTrainRunOptions,
  spirulaBin: string,
): SpirulaTrainManifest['params'] {
  return {
    spirulaBin,
    device: opts.device ?? Deno.env.get('SPIRULA_DEVICE') ?? '',
    trainIters: opts.trainIters ?? intFromEnv('SPIRULA_TRAIN_ITERS', 15000),
    shDegree: opts.shDegree ?? intFromEnv('SPIRULA_SH_DEGREE', 2),
    preset: opts.preset ?? Deno.env.get('SPIRULA_PRESET') ?? '3dgs',
    quality: opts.quality ?? Deno.env.get('SPIRULA_QUALITY') ?? 'medium',
  }
}

/**
 * Assemble the Spirula CLI arguments.
 *
 * The preset is positional and must come first. `--output-dir-prefix` is given
 * absolute for the same reason Brush's `--export-path` is: a relative one is
 * resolved against a working directory this driver does not control, and the
 * cost of getting it wrong is a completed multi-minute train whose output the
 * finder cannot see.
 */
export function buildSpirulaArgs(
  datasetDir: string,
  outputPrefix: string,
  params: SpirulaTrainManifest['params'],
): string[] {
  const args = [
    'train',
    params.preset,
    '--data', datasetDir,
    '--data-format', 'nerfstudio',
    '--num-iterations', String(params.trainIters),
    '--sh-degree', String(params.shDegree),
    '--quality', params.quality,
    '--output-dir-prefix', outputPrefix,
    '--output-dir-name', RUN_NAME,
    // Not options: a background job must never open a port or wait on a human.
    // --keep-viewer-alive defaults to 1, i.e. "stay running after training so
    // the result stays open in the viewer" — a WorldJob that never returns.
    '--disable-viewer', '1',
    '--keep-viewer-alive', '0',
  ]
  if (params.device) args.push('--device', params.device)
  return args
}

export async function runSpirulaTrain(opts: SpirulaTrainRunOptions): Promise<SpirulaTrainResult> {
  const spirulaBin = await resolveSpirulaBin(opts)
  const params = resolveSpirulaParams(opts, spirulaBin)
  const manifestPath = opts.manifestPath ??
    opts.outputPlyPath.replace(/\.splat\.ply$/, '') + '.splat-train.manifest.json'
  const started = Date.now()
  const sessionDir = resolve(opts.sessionDir)

  const baseManifest: SpirulaTrainManifest = {
    schemaVersion: 1,
    tool: 'spirula',
    status: 'error',
    createdAt: new Date().toISOString(),
    sessionDir,
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  if (!isValidSessionDir(sessionDir)) {
    return _finish(manifestPath, { ...baseManifest, status: 'error', error: 'invalid session directory' }, 2, 'invalid session directory')
  }

  // 1. Guard the binary before the dataset conversion — missing is a skip.
  if (!(await isRunnable(params.spirulaBin))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `Spirula binary not found or not executable: ${params.spirulaBin}`,
      // Name the download, not the repo: Spirula must NOT be built from source
      // here (it needs the Vulkan SDK), and more importantly this project may
      // only ever invoke a prebuilt binary as a separate process — see this
      // file's licensing header.
      remediation:
        'Download a prebuilt Spirula Studio release (https://github.com/harry7557558/spirula-studio/releases — ' +
        'the ubuntu-vulkan-x86_64 zip), unzip it to ~/opt/spirula/spirula, and `chmod +x` it; ' +
        'or set SPIRULA_BIN to an existing binary. Needs a Vulkan-capable GPU. ' +
        'SPLAT_BACKEND=brush switches back to Brush; see docs/pipelines/splat-train.md — Backends.',
    }, 0, `spirula binary missing: ${params.spirulaBin}`)
  }

  // 2. Session → Nerfstudio dataset, with COLMAP auto-solve for a pose-less
  //    session. Identical policy to splat_train.ts (read its step 2 for why);
  //    the only difference is the camera-model spelling and the dataset dir.
  let dataset
  const autoSolve = opts.autoSolvePoses ?? Deno.env.get('SPLAT_TRAIN_AUTO_POSES') !== '0'
  const datasetOpts = {
    sessionDir,
    datasetDir: `${sessionDir}/${DATASET_SUBDIR}`,
    cameraModel: SPIRULA_CAMERA_MODEL,
  }
  try {
    dataset = await buildBrushDataset(datasetOpts)
  } catch (e0) {
    const msg0 = e0 instanceof Error ? e0.message : String(e0)
    if (autoSolve && /no camera poses/.test(msg0)) {
      const solved = await runColmapPoses({ sessionDir })
      if (solved.status !== 'ok') {
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
      dataset = await buildBrushDataset(datasetOpts)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/no keyframes|no usable keyframes/.test(msg)) {
        return _finish(manifestPath, {
          ...baseManifest,
          status: 'skipped',
          skippedReason: msg,
          remediation: 'Stream keyframes for this scan before training a splat.',
        }, 0, msg)
      }
      return _finish(manifestPath, { ...baseManifest, status: 'error', error: `dataset build failed: ${msg}` }, 2, msg)
    }
  }
  baseManifest.frameCount = dataset.frameCount

  // 3. Spawn Spirula headless.
  const outputPrefix = `${dataset.datasetDir}/${OUTPUT_SUBDIR}`
  const args = buildSpirulaArgs(dataset.datasetDir, outputPrefix, params)

  let spawnResult: { code: number; stderr: string; stdout?: string }
  try {
    spawnResult = opts._spawn
      ? await opts._spawn(params.spirulaBin, args, {})
      : await defaultSpawn(params.spirulaBin, args)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return _finish(manifestPath, { ...baseManifest, status: 'error', error: `spirula spawn failed: ${msg}` }, 3, msg)
  }

  // Spirula splits its streams: the device list and the per-step progress go to
  // stdout, and only the diagnosis goes to stderr (measured — feeding it a
  // PERSPECTIVE dataset prints exactly one stderr line, "error: NerfstudioParser:
  // unsupported camera model PERSPECTIVE", and exits 1). So stderr is the right
  // thing to condense, exactly as for Brush; stdout is the fallback for the case
  // where a run dies with an empty stderr, which would otherwise put "spirula
  // exited N" and nothing else in the one durable record of the run.
  const diagnosis = spawnResult.stderr.trim() || (spawnResult.stdout ?? '')

  if (spawnResult.code !== 0) {
    const tail = stderrTail(diagnosis)
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: tail ? `spirula exited ${spawnResult.code}: ${tail}` : `spirula exited ${spawnResult.code}`,
      remediation:
        'Read the message above — it is Spirula\'s own. Re-run the same command by hand to see the full log: ' +
        `${params.spirulaBin} ${args.join(' ')} (see docs/pipelines/splat-train.md — Backends).`,
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, diagnosis)
  }

  // 4. Locate the newest checkpoint's splat.ply.
  const exported = await findSpirulaPly(`${outputPrefix}/${RUN_NAME}`)
  if (!exported) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'error',
      error: `spirula exited 0 but produced no splat.ply under ${outputPrefix}/${RUN_NAME}`,
      remediation:
        'Spirula trained but nothing landed. Its checkpoints are directories named ' +
        `step-<9 digits>.ckpt holding splat.ply — check for one elsewhere (\`find ${sessionDir} -name splat.ply\`); ` +
        'a stray one means --output-dir-prefix was resolved against a different working directory.',
      timing: { elapsedMs: Date.now() - started },
    }, spawnResult.code, diagnosis)
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
    }, spawnResult.code, diagnosis)
  }
  const gaussianCount = countPlyVertices(plyBytes) ?? 0
  await Deno.writeFile(opts.outputPlyPath, plyBytes)

  const manifest: SpirulaTrainManifest = {
    ...baseManifest,
    status: 'ok',
    plyPath: opts.outputPlyPath.split('/').pop(),
    gaussianCount,
    timing: { elapsedMs: Date.now() - started },
  }
  await writeManifest(manifestPath, manifest)

  return {
    status: 'ok',
    manifest,
    plyPath: opts.outputPlyPath,
    gaussianCount,
    log: diagnosis,
    exitCode: spawnResult.code,
  }
}

/**
 * Highest-numbered `step-<n>.ckpt/splat.ply` under a run directory.
 *
 * Spirula defaults `--save-only-latest-checkpoint 1`, so in practice one
 * checkpoint survives — but the flag is settable and a resumed run leaves
 * several, so pick by step number rather than trusting there to be one.
 */
export async function findSpirulaPly(runDir: string): Promise<{ path: string; step: number } | null> {
  let best: { path: string; step: number } | null = null
  try {
    for await (const entry of Deno.readDir(runDir)) {
      if (!entry.isDirectory) continue
      const m = entry.name.match(/^step-(\d+)\.ckpt$/)
      if (!m) continue
      const path = `${runDir}/${entry.name}/splat.ply`
      try {
        if (!(await Deno.stat(path)).isFile) continue
      } catch {
        continue
      }
      const step = Number(m[1])
      if (!best || step >= best.step) best = { path, step }
    }
  } catch {
    return null
  }
  return best
}

async function defaultSpawn(
  bin: string,
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  const output = await new Deno.Command(bin, { args, stdout: 'piped', stderr: 'piped' }).output()
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr).trim(),
    stdout: new TextDecoder().decode(output.stdout).trim(),
  }
}

async function writeManifest(path: string, manifest: SpirulaTrainManifest): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[spirula-train] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: SpirulaTrainManifest,
  exitCode: number,
  log: string,
): Promise<SpirulaTrainResult> {
  await writeManifest(manifestPath, manifest)
  return { status: manifest.status as SplatTrainStatus, manifest, log, exitCode }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
