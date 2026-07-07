/**
 * Floor-plan worker driver.
 *
 * Mirrors splat_detect.ts: the TS side stays thin — it locates the session's
 * LingBot-Map point cloud, spawns scripts/floor_plan_worker.py (stdlib+numpy:
 * height histogram → wall-band occupancy grid → RANSAC wall segments → room
 * polygon) as a subprocess, then lands the produced plan JSON + SVG next to
 * the scan and writes a `floor-plan.manifest.json` the world-job coordinator
 * persists.
 *
 * The driver never hard-crashes the server:
 *   - a missing python venv, worker script, or point cloud yields a `skipped`
 *     result with a remediation hint (exactly like splat_detect handles a
 *     missing analyzer),
 *   - a crash or a run that produced no plan JSON yields an `error`.
 *
 * Worker facts baked in (see scripts/floor_plan_worker.py):
 *   floor_plan_worker.py --ply <cloud> --out-json <p> --out-svg <p>
 *     [--min-wall-m 0.5]
 *   Deterministic (seeded RANSAC, no timestamps); CPU + numpy only, no GPU.
 *   The worker does not emit a manifest — this driver writes it.
 */

const DEFAULT_FLOORPLAN_PYTHON = `${Deno.env.get('HOME') ?? '~'}/.venvs/lingbot-map/bin/python`
const DEFAULT_WORKER_PATH = new URL('./scripts/floor_plan_worker.py', import.meta.url).pathname
const SESSION_ID_RE = /^(sess|session)-[a-z0-9-]+$/

export interface FloorPlanRunOptions {
  /** Absolute path to the session dir (holds lingbot-map.point-cloud.ply). */
  sessionDir?: string
  /** Where the plan JSON should land (e.g. <SCANS>/<base>.floor-plan.json). */
  outputJsonPath: string
  /** Where the plan SVG should land (e.g. <SCANS>/<base>.floor-plan.svg). */
  outputSvgPath: string
  /** Path where the floor-plan manifest is written (defaults next to outputJsonPath). */
  manifestPath?: string
  /** Python interpreter. Falls back to env FLOORPLAN_PYTHON, then the lingbot venv. */
  python?: string
  /** Worker script path. Falls back to env FLOORPLAN_WORKER, then scripts/floor_plan_worker.py. */
  workerPath?: string
  /** Minimum wall-segment length in meters. Env FLOORPLAN_MIN_WALL_M, then "0.5". */
  minWallM?: string
  /** For testing: skip the real spawn and treat these results as the worker run. */
  _spawn?: (bin: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>
  /** Provenance forwarded into the manifest. */
  provenance?: { sessionId?: string; scanId?: string }
}

export type FloorPlanStatus = 'ok' | 'skipped' | 'error'

export interface FloorPlanManifest {
  schemaVersion: number
  tool: 'floor-plan-worker'
  status: FloorPlanStatus
  createdAt: string
  /** Basename of the landed plan JSON (relative to SCANS_DIR), when 'ok'. */
  planPath?: string
  /** Basename of the landed plan SVG (relative to SCANS_DIR), when 'ok'. */
  svgPath?: string
  /** Total closed-room area in square meters. */
  areaM2?: number
  /** Number of extracted wall segments. */
  wallCount?: number
  /** Number of closed room polygons. */
  roomCount?: number
  /** Estimated floor-to-ceiling height in meters. */
  ceilingHeightM?: number
  params: {
    python: string
    workerPath: string
    minWallM: string
  }
  timing?: { elapsedMs: number }
  skippedReason?: string
  remediation?: string
  error?: string
  /** Provenance from the world job. */
  sessionId?: string
  scanId?: string
}

export interface FloorPlanResult {
  status: FloorPlanStatus
  manifest: FloorPlanManifest
  /** Absolute path of the landed plan JSON when status is 'ok'. */
  planJsonPath?: string
  /** Absolute path of the landed plan SVG when status is 'ok'. */
  planSvgPath?: string
  areaM2?: number
  wallCount?: number
  /** stderr tail from the worker — surfaced in the UI on failure. */
  log: string
  /** Subprocess exit code (or a synthetic code on skip/pre-spawn failure). */
  exitCode: number
}

export function isValidSessionDir(sessionDir: string): boolean {
  const base = sessionDir.split('/').filter(Boolean).pop() ?? ''
  return SESSION_ID_RE.test(base)
}

export function resolveParams(opts: FloorPlanRunOptions) {
  const python = opts.python ?? Deno.env.get('FLOORPLAN_PYTHON') ?? DEFAULT_FLOORPLAN_PYTHON
  const workerPath = opts.workerPath ?? Deno.env.get('FLOORPLAN_WORKER') ?? DEFAULT_WORKER_PATH
  const minWallM = opts.minWallM ?? Deno.env.get('FLOORPLAN_MIN_WALL_M') ?? '0.5'
  return { python, workerPath, minWallM }
}

/** Assemble the floor_plan_worker.py CLI arguments in a stable order. */
export function buildFloorPlanArgs(
  workerPath: string,
  plyPath: string,
  outJsonPath: string,
  outSvgPath: string,
  params: ReturnType<typeof resolveParams>,
): string[] {
  return [
    workerPath,
    '--ply', plyPath,
    '--out-json', outJsonPath,
    '--out-svg', outSvgPath,
    '--min-wall-m', params.minWallM,
  ]
}

export async function runFloorPlan(opts: FloorPlanRunOptions): Promise<FloorPlanResult> {
  const params = resolveParams(opts)
  const manifestPath = opts.manifestPath
    ?? opts.outputJsonPath.replace(/\.floor-plan\.json$/, '') + '.floor-plan.manifest.json'
  const started = Date.now()

  const baseManifest: FloorPlanManifest = {
    schemaVersion: 1,
    tool: 'floor-plan-worker',
    status: 'error',
    createdAt: new Date().toISOString(),
    params,
    sessionId: opts.provenance?.sessionId,
    scanId: opts.provenance?.scanId,
  }

  // 1. Guard: python + the worker script must exist before we do any work.
  //    A missing venv/script is a *skip*, not an error — the server keeps
  //    running and the UI shows a remediation.
  if (!(await isRunnable(params.python))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `floor-plan python not found or not executable: ${params.python}`,
      remediation: 'Create the numpy venv and set FLOORPLAN_PYTHON.',
    }, 0, `floor-plan python missing: ${params.python}`)
  }
  if (!(await exists(params.workerPath))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: `floor_plan_worker.py not found: ${params.workerPath}`,
      remediation: 'Restore scripts/floor_plan_worker.py or set FLOORPLAN_WORKER.',
    }, 0, `floor-plan worker missing: ${params.workerPath}`)
  }

  // 2. Resolve the input cloud: the session's LingBot-Map reconstruction.
  const srcCloud = opts.sessionDir ? `${opts.sessionDir}/lingbot-map.point-cloud.ply` : undefined
  if (!srcCloud || !(await exists(srcCloud))) {
    return _finish(manifestPath, {
      ...baseManifest,
      status: 'skipped',
      skippedReason: 'no point cloud: the session has no lingbot-map.point-cloud.ply',
      remediation: 'Run the lingbot-map-reconstruct job on this scan first.',
    }, 0, 'floor-plan has no input point cloud')
  }

  // 3. Spawn the worker into a temp job dir, then land the outputs.
  const jobDir = await Deno.makeTempDir({ prefix: 'floor-plan-' })
  try {
    const jobJson = `${jobDir}/floor-plan.json`
    const jobSvg = `${jobDir}/floor-plan.svg`
    const args = buildFloorPlanArgs(params.workerPath, srcCloud, jobJson, jobSvg, params)

    let spawnResult: { code: number; stderr: string }
    try {
      spawnResult = opts._spawn
        ? await opts._spawn(params.python, args, {})
        : await defaultSpawn(params.python, args, {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `floor-plan worker spawn failed: ${msg}`,
      }, 3, msg)
    }

    if (spawnResult.code !== 0) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: `floor-plan worker exited ${spawnResult.code}`,
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code || 3, spawnResult.stderr)
    }

    // 4. Read + validate the produced plan.
    let planText: string
    let svgText: string
    try {
      planText = await Deno.readTextFile(jobJson)
      svgText = await Deno.readTextFile(jobSvg)
    } catch {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'floor-plan worker finished but produced no plan JSON/SVG',
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }
    const summary = summarizePlan(planText)
    if (!summary) {
      return _finish(manifestPath, {
        ...baseManifest,
        status: 'error',
        error: 'floor-plan worker produced unparseable plan JSON',
        timing: { elapsedMs: Date.now() - started },
      }, spawnResult.code, spawnResult.stderr)
    }

    // 5. Land the artifacts next to the scan.
    await Deno.writeTextFile(opts.outputJsonPath, planText)
    await Deno.writeTextFile(opts.outputSvgPath, svgText)

    const manifest: FloorPlanManifest = {
      ...baseManifest,
      status: 'ok',
      planPath: opts.outputJsonPath.split('/').pop(),
      svgPath: opts.outputSvgPath.split('/').pop(),
      areaM2: summary.areaM2,
      wallCount: summary.wallCount,
      roomCount: summary.roomCount,
      ceilingHeightM: summary.ceilingHeightM,
      timing: { elapsedMs: Date.now() - started },
    }
    await writeManifest(manifestPath, manifest)

    return {
      status: 'ok',
      manifest,
      planJsonPath: opts.outputJsonPath,
      planSvgPath: opts.outputSvgPath,
      areaM2: summary.areaM2,
      wallCount: summary.wallCount,
      log: spawnResult.stderr,
      exitCode: spawnResult.code,
    }
  } finally {
    await removeQuietly(jobDir)
  }
}

/** Pull the headline numbers out of a floor-plan.json payload. */
export function summarizePlan(text: string): {
  areaM2: number
  wallCount: number
  roomCount: number
  ceilingHeightM: number
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const plan = parsed as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const walls = plan['walls']
  const rooms = plan['rooms']
  if (!Array.isArray(walls) || !Array.isArray(rooms)) return null
  return {
    areaM2: num(plan['areaM2']),
    wallCount: Array.isArray(walls) ? walls.length : 0,
    roomCount: Array.isArray(rooms) ? rooms.length : 0,
    ceilingHeightM: num(plan['ceilingHeightM']),
  }
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

async function writeManifest(path: string, manifest: FloorPlanManifest): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.warn('[floor-plan] failed to write manifest:', e)
  }
}

async function _finish(
  manifestPath: string,
  manifest: FloorPlanManifest,
  exitCode: number,
  log: string,
): Promise<FloorPlanResult> {
  await writeManifest(manifestPath, manifest)
  return { status: manifest.status, manifest, log, exitCode }
}
