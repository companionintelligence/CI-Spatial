/**
 * Panoptic-scan worker driver.
 *
 * Mirrors splat_detect.ts: the TS side stays thin — it locates a session's
 * streamed keyframes, spawns a Python worker that runs a panoptic segmentation
 * model over them, then splits the result into discrete objects and room
 * surfaces and writes a `panoptic.manifest.json` the world-job coordinator
 * persists.
 *
 * The driver never hard-crashes the server, and every unmet precondition is a
 * `skipped` with a remediation rather than an `error` — the same contract
 * splat_train uses for a missing Brush binary and splat_detect for a missing
 * venv. That is what lets this land and be tested before any model is
 * downloaded: with nothing installed, every path here is reachable and
 * asserted, and the only untested code is the model call itself.
 *
 * ── Why a Python venv rather than the ONNX runtime already in the tree ───────
 *
 * Measured, not preferred. `server/inference.ts` hardcodes
 * `executionProviders: ['cpu']`, and the installed onnxruntime-node native tree
 * ships `libonnxruntime.so`, `libonnxruntime_providers_shared.so` and the napi
 * binding — with NO `libonnxruntime_providers_cuda.so`. The GPU is simply not
 * reachable from that path as it stands, so "onnxruntime is already a
 * dependency" buys a CPU-only single-image request path, not a batched GPU
 * segmenter. `public/ort/` is the browser WASM runtime, a different thing again.
 *
 * On top of that, Mask2Former and OneFormer have no Optimum exporter config,
 * their deformable-attention kernel needs swapping for a pure-PyTorch fallback
 * to trace, and `post_process_panoptic_segmentation` — the step that actually
 * MAKES the output panoptic — is post-graph Python that would have to be
 * reimplemented by hand. Revisit ONNX only if this ever needs to run in-browser.
 */
import type { PanopticScanManifest } from '../../src/world/types.ts'
import { isRunnable } from '../exec_probe.ts'
import { splitPanopticSegments, MIN_SEGMENT_PIXELS, type RawPanopticFrame } from './panoptic_segments.ts'
export type { PanopticScanManifest }

const DEFAULT_PANOPTIC_PYTHON = `${Deno.env.get('HOME') ?? '~'}/.venvs/panoptic/bin/python`
const DEFAULT_PANOPTIC_DIR = `${Deno.env.get('HOME') ?? '~'}/panoptic`

/**
 * Default checkpoint.
 *
 * ADE20K rather than COCO because ADE20K-150 IS an indoor-room ontology — wall,
 * floor, ceiling, windowpane, door, bed, cabinet, sofa, table, chair, lamp,
 * curtain, shelf, desk, refrigerator, sink — which is the vocabulary this app's
 * whole domain model is about. Swin-L rather than a smaller backbone because
 * there is no ADE20K *panoptic* checkpoint below it (the tiny/small/base ADE
 * variants are semantic-only), so downgrading means switching dataset, not
 * shrinking the model. Override with PANOPTIC_MODEL.
 */
const DEFAULT_PANOPTIC_MODEL = 'facebook/mask2former-swin-large-ade-panoptic'

/** Keyframes to segment per run, unless overridden. */
const DEFAULT_MAX_FRAMES = 64

/** Manifest schema version — bump when a consumer-visible field changes. */
const SCHEMA_VERSION = 1

export interface PanopticScanRunOptions {
  /** Absolute path to the session dir holding streamed keyframes. */
  sessionDir: string
  /** Where the per-frame segment JSON lands. Defaults inside sessionDir. */
  segmentsPath?: string
  /** Where the manifest is written. Defaults next to segmentsPath. */
  manifestPath?: string
  /** Python interpreter. Falls back to env PANOPTIC_PYTHON, then the venv default. */
  python?: string
  /** Worker checkout dir. Falls back to env PANOPTIC_DIR, then ~/panoptic. */
  panopticDir?: string
  /** HF model id. Falls back to env PANOPTIC_MODEL, then the ADE20K default. */
  model?: string
  /** Cap on keyframes segmented. Falls back to env PANOPTIC_MAX_FRAMES. */
  maxFrames?: number
  /** Smallest mask kept, in source pixels. */
  minSegmentPixels?: number
  /**
   * JSON list of labels that are discrete objects. Defaults to the generated
   * `server/panoptic/ade20k-things.json`; pass '' to force the safe
   * everything-is-stuff mode.
   */
  thingLabelsPath?: string
  sessionId?: string
  scanId?: string
  /** Test seam — same shape as splat_detect's, so the tests read alike. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/** Keyframe images the streamer wrote, in capture order. */
async function sessionKeyframes(sessionDir: string, limit: number): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(sessionDir)) {
      if (entry.isFile && /\.(jpe?g|png)$/i.test(entry.name)) names.push(entry.name)
    }
  } catch {
    return []
  }
  // Lexicographic order is capture order: the streamer names them kf-00000.jpg.
  names.sort((a, b) => a.localeCompare(b))
  return names.slice(0, limit)
}

async function defaultSpawn(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const out = await new Deno.Command(bin, { args, env, stdout: 'piped', stderr: 'piped' }).output()
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) }
}

async function finish(
  manifestPath: string,
  manifest: PanopticScanManifest,
  elapsedMs: number,
): Promise<PanopticScanManifest> {
  const full = { ...manifest, timing: { elapsedMs } }
  try {
    await Deno.writeTextFile(manifestPath, JSON.stringify(full, null, 2))
  } catch {
    // A manifest we cannot persist must not turn a completed run into a crash;
    // the returned value is still the job's result.
  }
  return full
}

export function resolveParams(opts: PanopticScanRunOptions): PanopticScanManifest['params'] {
  return {
    python: opts.python ?? Deno.env.get('PANOPTIC_PYTHON') ?? DEFAULT_PANOPTIC_PYTHON,
    panopticDir: opts.panopticDir ?? Deno.env.get('PANOPTIC_DIR') ?? DEFAULT_PANOPTIC_DIR,
    model: opts.model ?? Deno.env.get('PANOPTIC_MODEL') ?? DEFAULT_PANOPTIC_MODEL,
    maxFrames: opts.maxFrames ?? Number(Deno.env.get('PANOPTIC_MAX_FRAMES') ?? DEFAULT_MAX_FRAMES),
    minSegmentPixels: opts.minSegmentPixels ?? MIN_SEGMENT_PIXELS,
  }
}

export async function runPanopticScan(opts: PanopticScanRunOptions): Promise<PanopticScanManifest> {
  const started = Date.now()
  const params = resolveParams(opts)
  const segmentsPath = opts.segmentsPath ?? `${opts.sessionDir}/panoptic.segments.json`
  const manifestPath = opts.manifestPath ?? `${opts.sessionDir}/panoptic.manifest.json`
  const workerPath = `${params.panopticDir}/panoptic_worker.py`
  // Which labels are discrete objects. The checkpoint does not say (verified:
  // no `thing_ids`, and `was_fused` is False for every segment), so without this
  // the worker reports isThing=null and NOTHING reaches thing_match. The list is
  // generated from the Mask2Former repo that trained the default checkpoint —
  // see scripts/fetch-ade20k-things.mjs — so labels and weights agree.
  // Resolved next to THIS module, not from the repo root: an earlier
  // repo-relative guess pointed at a path that does not exist, and because a
  // missing list falls back to the safe everything-is-stuff mode it failed
  // silently — a run reported "0 things" that looked like an empty room.
  // Hence `thingLabelsUsed` in the manifest below.
  const thingLabelsPath = opts.thingLabelsPath ??
    Deno.env.get('PANOPTIC_THING_LABELS') ??
    new URL('./ade20k-things.json', import.meta.url).pathname
  const haveThingLabels = thingLabelsPath !== '' && await exists(thingLabelsPath)

  const base: PanopticScanManifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'panoptic',
    status: 'skipped',
    createdAt: new Date().toISOString(),
    sessionDir: opts.sessionDir,
    model: params.model,
    params,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.scanId ? { scanId: opts.scanId } : {}),
  }

  // 1. Runtime guards. Missing tooling is a skip, never an error.
  if (!(await isRunnable(params.python))) {
    return finish(manifestPath, {
      ...base,
      skippedReason: `panoptic python not found or not executable: ${params.python}`,
      remediation: 'Create the venv and set PANOPTIC_PYTHON (see docs/pipelines/panoptic-scan.md — Setup).',
    }, Date.now() - started)
  }
  if (!(await exists(workerPath))) {
    return finish(manifestPath, {
      ...base,
      skippedReason: `panoptic worker not found: ${workerPath}`,
      remediation: 'Install the worker and set PANOPTIC_DIR (see docs/pipelines/panoptic-scan.md — Setup).',
    }, Date.now() - started)
  }

  // 2. Input guard. Segmenting nothing is a skip with the action that fixes it,
  //    not an empty success — the same distinction splat_detect draws.
  const frames = await sessionKeyframes(opts.sessionDir, params.maxFrames)
  if (frames.length === 0) {
    return finish(manifestPath, {
      ...base,
      skippedReason: 'session has no keyframe images',
      remediation: 'Capture with "Stream keyframes" enabled, then re-run.',
    }, Date.now() - started)
  }

  // 3. Run the worker.
  const args = [
    workerPath,
    '--session-dir', opts.sessionDir,
    '--out', segmentsPath,
    '--model', params.model,
    '--max-frames', String(params.maxFrames),
    '--min-segment-pixels', String(params.minSegmentPixels),
    ...(haveThingLabels ? ['--thing-labels', thingLabelsPath] : []),
  ]
  let result: { code: number; stderr: string }
  try {
    result = opts._spawn
      ? await opts._spawn(params.python, args, {})
      : await defaultSpawn(params.python, args, {})
  } catch (e) {
    return finish(manifestPath, {
      ...base,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    }, Date.now() - started)
  }
  if (result.code !== 0) {
    // Keep the stderr tail: a CUDA OOM and a bad model id are the two most
    // likely failures and are indistinguishable from the exit code alone.
    const tail = result.stderr.trim().split('\n').slice(-6).join('\n')
    return finish(manifestPath, {
      ...base,
      status: 'error',
      error: `panoptic worker exited ${result.code}${tail ? `: ${tail}` : ''}`,
    }, Date.now() - started)
  }

  // 4. Read back what it wrote. A clean exit that produced nothing is an error,
  //    not an ok-with-zero — silence there would look like "no objects here".
  let payload: { frames?: RawPanopticFrame[] }
  try {
    payload = JSON.parse(await Deno.readTextFile(segmentsPath)) as typeof payload
  } catch (e) {
    return finish(manifestPath, {
      ...base,
      status: 'error',
      error: `panoptic worker exited 0 but wrote no readable ${segmentsPath}: ${e instanceof Error ? e.message : String(e)}`,
    }, Date.now() - started)
  }

  const split = splitPanopticSegments(payload.frames ?? [], params.minSegmentPixels)
  return finish(manifestPath, {
    ...base,
    status: 'ok',
    framesSegmented: (payload.frames ?? []).length,
    thingCount: split.things.length,
    stuffCount: split.stuff.length,
    thingLabelsUsed: haveThingLabels,
    segmentsPath: segmentsPath.split('/').pop() ?? segmentsPath,
  }, Date.now() - started)
}
