/**
 * One-shot migration: `<scansDir>/jobs.json` (the retired `JobQueue`'s
 * persistence file, `jobs.ts`) → the `'default'` world's `WorldJob` array,
 * in the exact shape docs/factory/01-merge-jobs/0003's
 * `enqueueOptimizeScanJob`/`_runOptimizeScanJob` (`main.ts`) already produce
 * for a freshly-created `optimize-scan` `WorldJob`. Implements
 * docs/factory/01-merge-jobs/0005-retire-jobqueue.md, per
 * docs/adr/0003-merged-job-system.md.
 *
 * Explicitly invoked, one-shot — NOT run on every server boot (ticket 0005's
 * Non-goals), so restarting the server never re-migrates or double-counts.
 * Idempotent by construction: a migrated `WorldJob` reuses the legacy
 * `Job`'s own `id` as its `jobId` (both follow the same `job-<ts>-<rand>`
 * shape), so a second run recognizes and skips every job it already
 * migrated — no new "already migrated" marker field was needed (ticket
 * 0005's Schema required: None new).
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env migrate_jobs.ts
 *   deno task migrate-jobs
 *
 * Env (same names/defaults as main.ts's own knobs):
 *   SCANS_DIR   default ./scans   — where jobs.json and the .glb files live
 *   WORLDS_DIR  default ./worlds  — where <slug>.json world files live
 *
 * Which world do migrated jobs land in? Per ADR 0003 "Which world does an
 * optimize-scan WorldJob belong to?": every migrated job is parked under the
 * `'default'` world — the exact place `enqueueOptimizeScanJob` puts every
 * newly-created one, and the *only* world `GET /jobs`, `GET /jobs/:id`, and
 * `GET /scans`'s job-status shim (`main.ts`) ever read. Ticket 0005's own
 * Pinned Conventions draft speculated jobs should map to "whichever world
 * currently references their target scan filename" — but that predates ADR
 * 0003 settling on 'default'-only for this job type, and would silently
 * orphan migrated jobs from every shim this wave built (they'd never appear
 * in `GET /jobs`, which only ever looks at the `'default'` world). Resolved
 * here in favor of ADR 0003's actual, already-implemented decision, not a
 * new one.
 *
 * What happens to a `jobs.json` entry whose target scan file no longer
 * exists on disk? Ticket 0005's Open Q&A left this open with a recommended
 * resolution: logged and skipped, not migrated as an orphaned record —
 * adopted verbatim here.
 */
import type { Job, JobStatus } from './jobs.ts'
import type { WorldJob, WorldJobStatus, WorldProject } from './src/world/types.ts'
import { trimWorldJobHistory } from './world_job_pump.ts'

/** Reverse of main.ts's WORLD_JOB_STATUS_TO_LEGACY — ADR 0003's status-vocabulary table. */
export const LEGACY_STATUS_TO_WORLD: Record<JobStatus, WorldJobStatus> = {
  queued: 'queued',
  running: 'processing',
  done: 'completed',
  error: 'failed',
}

/**
 * Mirrors main.ts's `DEFAULT_WORKER_CAPABILITIES` (main.ts:1086) —
 * duplicated rather than imported because main.ts cannot be imported
 * without running its unconditional top-level side effects (hostname
 * resolution, VLM engine load, `Deno.serve`). Same constraint, same
 * precedent as world_job_pump.ts duplicating `MAX_JOB_HISTORY` as
 * `MAX_WORLD_JOB_HISTORY` for the identical reason (see that file's header).
 */
export const DEFAULT_WORKER_CAPABILITIES = ['cpu', 'onnx', 'ollama', 'open3d', 'splat', 'vggt', 'lingbot-map']

/**
 * Mirrors `_dispatchWorldJob`'s `workerId` ternary (main.ts): `optimize-scan`
 * matches none of the named branches (`lingbot-map-reconstruct`,
 * `splat-train`, `splat-detect`, `splat-finish`, `memory-push`), so it
 * always resolves to the fallback.
 */
const OPTIMIZE_SCAN_WORKER_ID = 'local-coordinator'

/**
 * Pure translation: legacy `Job` → `WorldJob`, in the exact shape ticket
 * 0003's `enqueueOptimizeScanJob`/`_runOptimizeScanJob` already produce for
 * a genuinely new `optimize-scan` job — the inverse of `main.ts`'s
 * `worldJobToLegacyJob()`, both directions tracing back to the same ADR
 * 0003 field-mapping table (ADR 0001: one conversion shape, not two).
 *
 * Reuses the legacy job's own `id` as the `WorldJob`'s `jobId` — not a
 * fresh `job-<ts>-<rand>` id — specifically so migration is idempotent by
 * construction (see `migrateJobsToWorldJob`'s dedupe-by-jobId below)
 * without inventing a new schema field to track "already migrated".
 *
 * `Job` has no field mapping to `WorldJob.artifacts` (ADR 0003's
 * field-mapping table has no artifacts row — `Job` itself never had one),
 * so migrated jobs leave `artifacts` unset, same as any other field the
 * table doesn't name.
 */
export function worldJobFromLegacyJob(job: Job, worldId: string): WorldJob {
  const status = LEGACY_STATUS_TO_WORLD[job.status]
  const terminal = status === 'completed' || status === 'failed'
  const wj: WorldJob = {
    jobId: job.id,
    worldId,
    type: 'optimize-scan',
    status,
    capabilities: DEFAULT_WORKER_CAPABILITIES,
    payload: { filename: job.target },
    progress: terminal ? 1 : status === 'processing' ? 0.35 : 0,
    createdAt: job.createdAt,
    // Job had no startedAt/finishedAt-equivalent WorldJob field either (ADR
    // 0003 field mapping: both reuse `updatedAt`) — best-available source
    // is finishedAt, then startedAt, then createdAt.
    updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt,
  }
  // A migrated 'processing' job has no live worker behind it (the process
  // that ran it is gone) — same situation recoverWorldJobsOnBoot() already
  // handles for every other WorldJobType on every server restart. Rather
  // than duplicate that decision here, leave it 'processing' and let the
  // very next boot's recovery pass requeue it, exactly like any other job
  // found stuck (ADR 0003 "Crash recovery" is requeue-always, type-agnostic).
  if (status !== 'queued') wj.workerId = OPTIMIZE_SCAN_WORKER_ID
  if (job.error !== undefined) wj.error = job.error
  if (job.note !== undefined) wj.result = job.note
  return wj
}

export interface MigrationSummary {
  migrated: WorldJob[]
  skippedAlreadyMigrated: string[]
  skippedMissingScan: Array<{ legacyId: string; target: string }>
}

export interface MigrateJobsOptions {
  /** Same meaning/default as main.ts's SCANS_DIR env var. */
  scansDir: string
  /** Same meaning/default as main.ts's WORLDS_DIR env var. */
  worldsDir: string
  /** World every migrated job is parked under — always 'default' in practice (see header). */
  worldSlug?: string
  log?: (line: string) => void
}

/**
 * Reads `<scansDir>/jobs.json`, migrates every entry whose target scan file
 * still exists into the target world's `WorldJob` array (skipping entries
 * already migrated by a previous run, and entries whose target scan no
 * longer exists — both logged, neither treated as a failure), and persists
 * the world file atomically (write-tmp-then-rename, matching `main.ts`'s
 * own `saveWorld()`). A no-op (nothing read or written) when `jobs.json`
 * doesn't exist or has no entries — the common case once a previous run (or
 * ticket 0004's workspace hygiene) has already cleared it.
 */
export async function migrateJobsToWorldJob(opts: MigrateJobsOptions): Promise<MigrationSummary> {
  const { scansDir, worldsDir } = opts
  const worldSlug = opts.worldSlug ?? 'default'
  const log = opts.log ?? ((line: string) => console.log(line))
  const jobsPath = `${scansDir}/jobs.json`
  const worldPath = `${worldsDir}/${worldSlug}.json`

  const summary: MigrationSummary = { migrated: [], skippedAlreadyMigrated: [], skippedMissingScan: [] }

  // "File absent" is the expected no-op; anything else (malformed JSON, a
  // permission error) must NOT be swallowed. A silent no-op here reads as
  // "nothing to migrate" — and since this migration exists precisely so
  // history isn't lost on upgrade, an operator could then delete a jobs.json
  // that was never actually read.
  let raw: string
  try {
    raw = await Deno.readTextFile(jobsPath)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      log(`[migrate-jobs] no legacy jobs.json found at ${jobsPath} — nothing to migrate.`)
      return summary
    }
    throw err
  }

  let legacyJobs: Job[]
  try {
    legacyJobs = JSON.parse(raw) as Job[]
  } catch (err) {
    throw new Error(
      `[migrate-jobs] ${jobsPath} exists but is not valid JSON, so its history cannot be migrated. ` +
        `Refusing to skip it silently — fix or move the file, then re-run. ` +
        `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!Array.isArray(legacyJobs) || legacyJobs.length === 0) {
    log(`[migrate-jobs] ${jobsPath} has no job entries — nothing to migrate.`)
    return summary
  }

  let world: WorldProject
  try {
    world = JSON.parse(await Deno.readTextFile(worldPath)) as WorldProject
  } catch {
    throw new Error(
      `[migrate-jobs] '${worldSlug}' world not found at ${worldPath}. Start the server at least ` +
        `once first (GET /worlds/${worldSlug} synthesizes it on first request), then re-run this migration.`,
    )
  }

  const alreadyMigratedIds = new Set(world.jobs.map((j) => j.jobId))

  for (const legacy of legacyJobs) {
    if (alreadyMigratedIds.has(legacy.id)) {
      summary.skippedAlreadyMigrated.push(legacy.id)
      log(`[migrate-jobs] skip (already migrated): ${legacy.id} (${legacy.target})`)
      continue
    }
    try {
      await Deno.stat(`${scansDir}/${legacy.target}`)
    } catch {
      summary.skippedMissingScan.push({ legacyId: legacy.id, target: legacy.target })
      log(`[migrate-jobs] skip (target scan no longer exists on disk): ${legacy.id} (${legacy.target})`)
      continue
    }
    const wj = worldJobFromLegacyJob(legacy, world.worldId)
    world.jobs.unshift(wj) // newest-first, matching createWorldJob's convention
    summary.migrated.push(wj)
    log(`[migrate-jobs] migrated: ${legacy.id} (${legacy.target}, ${legacy.status} -> ${wj.status})`)
  }

  if (summary.migrated.length > 0) {
    world.jobs = trimWorldJobHistory(world.jobs)
    world.updatedAt = new Date().toISOString()
    const tmp = `${worldPath}.${crypto.randomUUID()}.tmp`
    await Deno.writeTextFile(tmp, JSON.stringify(world, null, 2))
    await Deno.rename(tmp, worldPath)
    log(`[migrate-jobs] wrote ${summary.migrated.length} migrated job(s) to ${worldPath}`)
  } else {
    log(`[migrate-jobs] nothing new to migrate; ${worldPath} left untouched.`)
  }

  return summary
}

if (import.meta.main) {
  const scansDir = Deno.env.get('SCANS_DIR') ?? './scans'
  const worldsDir = Deno.env.get('WORLDS_DIR') ?? './worlds'
  try {
    const summary = await migrateJobsToWorldJob({ scansDir, worldsDir })
    console.log(
      `[migrate-jobs] done: ${summary.migrated.length} migrated, ` +
        `${summary.skippedAlreadyMigrated.length} already migrated, ` +
        `${summary.skippedMissingScan.length} skipped (missing scan).`,
    )
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
