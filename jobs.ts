/**
 * Legacy `JobQueue` shape definitions.
 *
 * `JobQueue` (the persistent job runner that used to live in this file) was
 * ported onto `WorldJob` and retired by
 * docs/factory/01-merge-jobs/0005-retire-jobqueue.md, per
 * docs/adr/0003-merged-job-system.md. `main.ts` is the sole job system now:
 * `WorldJob` (`src/world/types.ts`), scheduled by `world_job_pump.ts`'s
 * single-flight pump, with boot-time crash recovery
 * (`recoverWorldJobsOnBoot()`) and per-world dedupe/bounded-history in place
 * of what `JobQueue` used to provide.
 *
 * `Job`/`JobStatus`/`OptimizeScanManifest` survive here — not as a second
 * live queue, but because they're still load-bearing:
 *   - `Job`/`JobStatus` are the on-the-wire legacy shape `main.ts`'s
 *     `worldJobToLegacyJob()` shim translates `optimize-scan` `WorldJob`s
 *     into, so `GET /jobs`, `GET /jobs/:id`, `GET /scans`'s job-status field,
 *     and the `'job-update'` event keep responding in exactly the shape they
 *     always have (ticket 0004), and so the one-shot migration
 *     (`migrate_jobs.ts`, ticket 0005) has a typed shape to read
 *     `<scansDir>/jobs.json` history into.
 *   - `OptimizeScanManifest` is the on-disk artifact-index shape
 *     `main.ts`'s `_runOptimizeScanJob()` still writes to
 *     `<base>.manifest.json` — unrelated to which queue calls it; only the
 *     *caller* moved (ticket 0003), never this format.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  type: 'optimize-scan'
  /** Scan filename inside the scans directory */
  target: string
  status: JobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  note?: string
}

export interface OptimizeScanManifest {
  source: string
  createdAt: string
  stats: Record<string, number>
  stages: Array<{ name: string; ok: boolean; ms: number; note?: string }>
  artifacts: {
    optimized: { filename: string; bytes: number; draco: boolean; quantized: boolean }
    /** Coarsest first — viewer loads lods[0] as the instant preview */
    lods: Array<{ filename: string; bytes: number; points: number; voxelM: number }>
  }
}
