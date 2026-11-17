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
import type { WorldJob, WorldJobType } from '../../src/world/types.ts'
import { budgetFromEnv, describeBudget, within } from '../run_with_deadline.ts'

// ── Single-flight pump (ADR 0003 "Single-flight execution") ──────────────────

/**
 * Runs one job to a terminal state. `signal` aborts when the pump's deadline
 * passes. The abort is inert until the signal is forwarded: main.ts's dispatch
 * drops it, so no runner receives it yet. Until then an overrunning dispatch is
 * only waited for, up to the grace period.
 */
export type PumpDispatch = (slug: string, jobId: string, signal?: AbortSignal) => Promise<void>

export interface WorldJobPumpOptions {
  /** Wall-clock ceiling for one dispatch. Default: WORLD_JOB_DEADLINE_MS, then 12 h. */
  deadlineMs?: number
  /** How long a timed-out dispatch gets to settle before the queue moves on. Default 60 s. */
  graceMs?: number
  /**
   * Told when a dispatch is still running one grace period after its deadline,
   * so the caller can mark the job failed. Not told when the dispatch settles
   * inside the grace period: its own outcome stands, and a second write from
   * here would race it. Awaited before the queue moves on, and bounded by the
   * grace period too, so a callback that never settles cannot stall the queue.
   * A rejection is logged, never thrown into the pump.
   */
  onDeadline?: (slug: string, jobId: string) => void | Promise<void>
}

/**
 * Longer than any one stage's own budget (see run_with_deadline.ts). The pump
 * deadline is the backstop for a job that stalls outside a child process, not
 * the first line of defence against a hung stage.
 */
const DEFAULT_JOB_DEADLINE_MS = 12 * 60 * 60 * 1000
const DEFAULT_GRACE_MS = 60_000

/**
 * Global (not per-world) single-flight queue: one pending array, one
 * `_working` flag — matches `JobQueue`'s existing concurrency-1 guarantee,
 * required because e.g. `splat-train` holds the box's one GPU regardless of
 * which world asked.
 */
export class WorldJobPump {
  private _pending: Array<{ slug: string; jobId: string }> = []
  private _working = false

  constructor(
    private readonly dispatch: PumpDispatch,
    private readonly options: WorldJobPumpOptions = {},
  ) {}

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
          // Awaited before the loop dequeues the next entry, so at most one
          // WorldJob is `processing` at a time. The exception is a dispatch still
          // running after its grace period (see _runWithDeadline): the loop starts
          // the next job while that one winds down. The pump never kills a child.
          // It only aborts the signal, which no runner receives yet (see PumpDispatch above).
          // A timed-out child is killed by its runner's own deadline (run_with_deadline.ts).
          await this._runWithDeadline(next.slug, next.jobId)
        } catch (err) {
          console.error(`[world-jobs] pump dispatch failed for ${next.jobId}:`, err)
        }
      }
    } finally {
      this._working = false
    }
  }

  /**
   * One dispatch under the pump's deadline (F29, F36).
   *
   * Past the deadline the dispatch's signal aborts. The abort is inert until the
   * signal is forwarded: main.ts's dispatch drops it, so no runner receives it and
   * none stops its child on it. The queue waits up to the grace period for the
   * dispatch to settle, and then moves on whether or not it has.
   *
   * `onDeadline` is told only when the dispatch is still running after the grace
   * period. That is a deliberate choice. Told at the deadline, the caller would
   * mark the job failed while a cooperating runner was still winding down, and
   * the two writes would race. A dispatch that settles inside the grace period
   * keeps its own outcome. A dispatch still running after the grace period is
   * left alone and the queue moves on, so one stuck job does not hold every job
   * behind it. That case is logged, because the single-flight guarantee no longer
   * holds for it.
   */
  private async _runWithDeadline(slug: string, jobId: string): Promise<void> {
    const deadlineMs = this.options.deadlineMs ?? budgetFromEnv('WORLD_JOB_DEADLINE_MS', DEFAULT_JOB_DEADLINE_MS)
    const graceMs = this.options.graceMs ?? DEFAULT_GRACE_MS
    const controller = new AbortController()
    const run = this.dispatch(slug, jobId, controller.signal)
    if (await within(run.then(() => true), deadlineMs, false)) return

    console.error(`[world-jobs] ${jobId} ran past its ${describeBudget(deadlineMs)} deadline; aborting it`)
    controller.abort(new Error(`WorldJob ${jobId} exceeded its ${describeBudget(deadlineMs)} deadline`))
    const settled = await within(
      run.then(() => true, (err) => {
        console.error(`[world-jobs] pump dispatch failed for ${jobId} after its deadline:`, err)
        return true
      }),
      graceMs,
      false,
    )
    if (settled) return

    console.error(
      `[world-jobs] ${jobId} is still running ${describeBudget(graceMs)} after its deadline; ` +
        'telling the caller and starting the next job anyway',
    )
    // Awaited, and bounded by the grace period, so a callback that never settles
    // cannot hold the queue. A sync throw becomes a rejection here. Every rejection
    // is logged in the chain, including one that arrives after the bound has passed.
    const told = Promise.resolve()
      .then(() => this.options.onDeadline?.(slug, jobId))
      .catch((err: unknown) => console.error(`[world-jobs] onDeadline failed for ${jobId}:`, err))
    await within(told, graceMs, undefined)
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
