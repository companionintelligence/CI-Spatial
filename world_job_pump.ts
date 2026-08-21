/**
 * WorldJob scheduling primitives: single-flight pump, dedupe, bounded
 * history, and boot-time recovery decisions.
 *
 * Implements docs/adr/0003-merged-job-system.md's "Single-flight execution",
 * "Dedupe", "Bounded history", and "Crash recovery" sections. Mirrors
 * jobs.ts's `_jobs`/`_pump()`/`_working` pattern (jobs.ts:47, 115-143) — the
 * reference implementation docs/factory/01-merge-jobs/0002's Pinned
 * conventions point at — but WorldJobs live inside potentially many
 * per-world JSON files (persisted via main.ts's `updateWorld()`, which
 * serializes each world's read-modify-write cycle through `world_lock.ts`)
 * instead of one `jobs.json`, so this module owns only the in-process
 * scheduling primitive and the pure predicates; main.ts owns persistence,
 * dispatch to
 * the per-type `_run*Job` functions, and the boot-time `WORLDS_DIR` scan
 * (reusing `GET /worlds`'s directory-scan shape, per ADR 0001).
 *
 * Pulled out of main.ts (rather than living as bare module-level state
 * there) purely so it's importable — and unit-testable — without pulling in
 * main.ts's unconditional top-level side effects (hostname resolution, VLM
 * engine load, `Deno.serve`), which no existing test in this repo does.
 */
import type { WorldJob, WorldJobType } from './src/world/types.ts'

// ── Single-flight pump (ADR 0003 "Single-flight execution") ──────────────────

export type PumpDispatch = (slug: string, jobId: string) => Promise<void>

/**
 * Global (not per-world) single-flight queue: one pending array, one
 * `_working` flag — matches `JobQueue`'s existing concurrency-1 guarantee,
 * required because e.g. `splat-train` holds the box's one GPU regardless of
 * which world asked.
 */
export class WorldJobPump {
  private _pending: Array<{ slug: string; jobId: string }> = []
  private _working = false

  constructor(private readonly dispatch: PumpDispatch) {}

  /** Push a job onto the queue and kick the pump if it isn't already running. */
  enqueue(slug: string, jobId: string): void {
    this._pending.push({ slug, jobId })
    void this._pump()
  }

  get pendingCount(): number {
    return this._pending.length
  }

  get isWorking(): boolean {
    return this._working
  }

  private async _pump(): Promise<void> {
    if (this._working) return
    this._working = true
    try {
      for (;;) {
        const next = this._pending.shift()
        if (!next) break
        try {
          // Awaited fully before the loop dequeues the next entry — this is
          // the single-flight guarantee: at most one WorldJob is
          // `processing`, globally, at a time.
          await this.dispatch(next.slug, next.jobId)
        } catch (err) {
          console.error(`[world-jobs] pump dispatch failed for ${next.jobId}:`, err)
        }
      }
    } finally {
      this._working = false
    }
  }
}

// ── Dedupe (ADR 0003 "Dedupe") ────────────────────────────────────────────────

/** Same target concept as jobs.ts's `Job.target`: `scanId` if set, else `payload.filename`. */
export function worldJobTarget(job: Pick<WorldJob, 'scanId' | 'payload'>): string | undefined {
  if (job.scanId) return job.scanId
  const filename = job.payload?.['filename']
  return typeof filename === 'string' ? filename : undefined
}

/**
 * Find an existing queued/processing job with the same type and target —
 * the exact predicate shape jobs.ts's `enqueue()` uses (jobs.ts:88-93),
 * applied per-world (call with `world.jobs`) instead of globally.
 *
 * `target === undefined` never dedupes: in jobs.ts, `Job.target` was a
 * mandatory string, so "same target" was always a meaningful comparison. A
 * `WorldJob` with neither `scanId` nor `payload.filename` has no target at
 * all — treating two such jobs as "the same target" would collapse two
 * unrelated jobs of the same placeholder type into one. Without a real
 * target to compare, the safe behavior is "don't dedupe", not "dedupe
 * everything untargeted together".
 */
export function findDuplicateWorldJob(
  jobs: WorldJob[],
  type: WorldJobType,
  target: string | undefined,
): WorldJob | undefined {
  if (target === undefined) return undefined
  return jobs.find((j) =>
    j.type === type &&
    (j.status === 'queued' || j.status === 'processing') &&
    worldJobTarget(j) === target
  )
}

// ── Bounded history (ADR 0003 "Bounded history") ──────────────────────────────

export const MAX_WORLD_JOB_HISTORY = 200
const COMPLETED_HISTORY_KEEP = 100

/**
 * Cap `jobs` at `MAX_WORLD_JOB_HISTORY` once exceeded: keep every
 * queued/processing job, trim completed/failed jobs to the most recent 100.
 * Mirrors jobs.ts:103-106's filter-and-slice exactly, in `WorldJobStatus`
 * terms. `jobs` is assumed newest-first (world.jobs is built with
 * `unshift()`), so "most recent" is the front of the array — returns the
 * same array reference unchanged when no trim is needed.
 */
export function trimWorldJobHistory(jobs: WorldJob[]): WorldJob[] {
  if (jobs.length <= MAX_WORLD_JOB_HISTORY) return jobs
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'processing')
  const settled = jobs.filter((j) => j.status === 'completed' || j.status === 'failed')
  return active.concat(settled.slice(0, COMPLETED_HISTORY_KEEP))
}

// ── Boot-time recovery (ADR 0003 "Crash recovery") ─────────────────────────────

/**
 * Pure decision step of boot-time recovery: requeue-always, not
 * type-dependent (ADR 0003 — the single-process-server assumption means any
 * `processing`/`queued` job found at boot has no live worker; no active
 * `_run*Job` has a non-idempotent side effect requeue-always would corrupt).
 * Mutates matching jobs in place (`status` → `'queued'`, `result` → the
 * recovery note, bumps `updatedAt`) and returns the ones it touched, so the
 * caller can decide whether to persist/broadcast/seed the pump. No I/O here
 * — kept pure so it's unit-testable without a filesystem.
 */
export function recoverStuckWorldJobs(
  jobs: WorldJob[],
  now: () => string = () => new Date().toISOString(),
): WorldJob[] {
  const recovered: WorldJob[] = []
  for (const job of jobs) {
    if (job.status === 'processing' || job.status === 'queued') {
      job.status = 'queued'
      job.result = 'requeued after restart'
      job.updatedAt = now()
      recovered.push(job)
    }
  }
  return recovered
}
