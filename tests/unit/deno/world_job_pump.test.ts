/**
 * Deno unit tests for world_job_pump.ts — the WorldJob single-flight pump,
 * dedupe predicate, bounded-history trim, and boot-recovery decision logic
 * ticket docs/factory/01-merge-jobs/0002-worldjob-runner-hardening.md adds.
 *
 * Extracted to its own file (rather than living as bare module-level state
 * in main.ts) specifically so these can run as real Deno unit tests without
 * pulling in main.ts's unconditional top-level side effects (hostname
 * resolution, VLM engine load, Deno.serve) — see world_job_pump.ts's header.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import {
  findDuplicateWorldJob,
  MAX_WORLD_JOB_HISTORY,
  recoverStuckWorldJobs,
  trimWorldJobHistory,
  WorldJobPump,
} from '../../../server/world/world_job_pump.ts'
import type { WorldJob } from '../../../src/world/types.ts'

function makeJob(overrides: Partial<WorldJob> = {}): WorldJob {
  return {
    jobId: overrides.jobId ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    worldId: 'world-default',
    type: 'splat-train',
    status: 'queued',
    capabilities: [],
    progress: 0,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── Required test 1: single-flight ordering ───────────────────────────────────
// "enqueue two WorldJobs back to back; assert the second doesn't start
// processing until the first reaches a terminal state" (ticket 0002 Tests).

Deno.test('WorldJobPump: single-flight — second job does not start until the first settles', async () => {
  const events: string[] = []
  let resolveFirst: (() => void) | null = null
  const firstStarted = Promise.withResolvers<void>()

  const pump = new WorldJobPump(async (_slug, jobId) => {
    events.push(`start:${jobId}`)
    if (jobId === 'job-a') {
      firstStarted.resolve()
      // Held open until the test explicitly releases it, so we can assert
      // job-b has NOT started while job-a is still "processing".
      await new Promise<void>((resolve) => { resolveFirst = resolve })
    }
    events.push(`end:${jobId}`)
  })

  pump.enqueue('default', 'job-a')
  pump.enqueue('default', 'job-b') // enqueued back-to-back, before job-a settles

  await firstStarted.promise
  // job-a is "processing" (its dispatch call is in flight) — job-b must not
  // have started yet.
  assertEquals(events, ['start:job-a'])
  assert(pump.isWorking)
  assertEquals(pump.pendingCount, 1, 'job-b should still be waiting in the pending queue')

  resolveFirst!()
  // Let the pump drain: job-a finishes, then (and only then) job-b starts+finishes.
  await sleep(10)

  assertEquals(events, ['start:job-a', 'end:job-a', 'start:job-b', 'end:job-b'])
  assertEquals(pump.pendingCount, 0)
  assert(!pump.isWorking)
})

Deno.test('WorldJobPump: a slow first dispatch does not block enqueue() itself, only execution order', () => {
  const pump = new WorldJobPump(() => new Promise(() => {})) // never resolves
  pump.enqueue('default', 'job-a')
  pump.enqueue('default', 'job-b')
  pump.enqueue('default', 'job-c')
  // enqueue() itself is synchronous/non-blocking — this assertion running at
  // all (without awaiting anything) proves it didn't wait on job-a.
  assertEquals(pump.pendingCount, 2) // job-a is being dispatched; b, c still queued
})

// ── Required test 2: boot-time recovery ───────────────────────────────────────
// "kill the process mid-job (simulate by writing a world JSON with a job
// stuck in processing and an old updatedAt), restart, confirm recovery
// fires per ADR 0003" (ticket 0002 Tests). recoverStuckWorldJobs() is the
// pure decision step main.ts's recoverWorldJobsOnBoot() calls after reading
// each world JSON off disk — see that function's doc comment in main.ts for
// the filesystem-scanning half (mirrors GET /worlds's Deno.readDir loop,
// intentionally left untested here per the ticket's "or documented manual
// repro" allowance; manual repro: write a world JSON under WORLDS_DIR with a
// job at status:'processing' and a stale updatedAt, start the server, then
// GET /worlds/:slug/jobs and confirm that job is 'queued' with
// result:'requeued after restart' and progressing again).

Deno.test('recoverStuckWorldJobs: requeues a job stuck "processing" from a killed process', () => {
  const staleUpdatedAt = '2020-01-01T00:00:00.000Z' // ancient — simulates a killed process
  const stuck = makeJob({ jobId: 'job-stuck', status: 'processing', updatedAt: staleUpdatedAt, progress: 0.35 })
  const healthy = makeJob({ jobId: 'job-done', status: 'completed', updatedAt: staleUpdatedAt })
  const jobs = [stuck, healthy]

  const recovered = recoverStuckWorldJobs(jobs, () => '2026-08-15T12:00:00.000Z')

  assertEquals(recovered.length, 1)
  assertEquals(recovered[0].jobId, 'job-stuck')
  assertEquals(stuck.status, 'queued')
  assertEquals(stuck.result, 'requeued after restart')
  assertEquals(stuck.updatedAt, '2026-08-15T12:00:00.000Z')
  // Untouched: a completed job is never "stuck" and must not be reopened.
  assertEquals(healthy.status, 'completed')
  assertEquals(healthy.updatedAt, staleUpdatedAt)
})

Deno.test('recoverStuckWorldJobs: also requeues a job still "queued" (no poller ever picked it up)', () => {
  // ADR 0003: a queued job that never got its completeJobSoon setTimeout to
  // fire (or, pre-restart, its pending-array entry) has no other path back
  // to execution — must be recovered exactly like a processing job.
  const neverStarted = makeJob({ jobId: 'job-never-started', status: 'queued' })
  const recovered = recoverStuckWorldJobs([neverStarted])
  assertEquals(recovered.length, 1)
  assertEquals(neverStarted.status, 'queued')
  assertEquals(neverStarted.result, 'requeued after restart')
})

Deno.test('recoverStuckWorldJobs: a failed job is left alone (not stuck, not re-run)', () => {
  const failed = makeJob({ jobId: 'job-failed', status: 'failed', error: 'boom' })
  const recovered = recoverStuckWorldJobs([failed])
  assertEquals(recovered.length, 0)
  assertEquals(failed.status, 'failed')
  assertEquals(failed.result, undefined)
})

// ── Supporting coverage: dedupe (ADR 0003 "Dedupe") ────────────────────────────

Deno.test('findDuplicateWorldJob: reuses an existing queued/processing job for the same type+scanId', () => {
  const existing = makeJob({ jobId: 'job-existing', type: 'splat-train', scanId: 'scan-1', status: 'processing' })
  const jobs = [existing]
  assertEquals(findDuplicateWorldJob(jobs, 'splat-train', 'scan-1'), existing)
})

Deno.test('findDuplicateWorldJob: falls back to payload.filename when scanId is unset (optimize-scan / legacy shape)', () => {
  const existing = makeJob({
    jobId: 'job-existing',
    type: 'extract-layers',
    scanId: undefined,
    payload: { filename: 'a.glb' },
    status: 'queued',
  })
  assertEquals(findDuplicateWorldJob([existing], 'extract-layers', 'a.glb'), existing)
  assertEquals(findDuplicateWorldJob([existing], 'extract-layers', 'b.glb'), undefined)
})

Deno.test('findDuplicateWorldJob: a completed/failed job of the same type+target is not a duplicate', () => {
  const done = makeJob({ type: 'splat-train', scanId: 'scan-1', status: 'completed' })
  assertEquals(findDuplicateWorldJob([done], 'splat-train', 'scan-1'), undefined)
})

Deno.test('findDuplicateWorldJob: an undefined target never dedupes, even against another untargeted job of the same type', () => {
  // Neither scanId nor payload.filename set — e.g. a placeholder type like
  // 'export-world'/'ingest' posted via POST /worlds/:slug/jobs with no
  // scanId and no payload.filename. worldJobTarget() returns undefined for
  // both this queued job and any lookup with no target; without the
  // target-undefined guard, two unrelated untargeted jobs of the same type
  // would incorrectly collapse into "duplicates".
  const untargeted = makeJob({ type: 'export-world', scanId: undefined, payload: undefined, status: 'queued' })
  assertEquals(findDuplicateWorldJob([untargeted], 'export-world', undefined), undefined)
})

// ── Supporting coverage: bounded history (ADR 0003 "Bounded history") ─────────

Deno.test('trimWorldJobHistory: no-op under the cap', () => {
  const jobs = [makeJob(), makeJob()]
  assertEquals(trimWorldJobHistory(jobs), jobs)
})

Deno.test('trimWorldJobHistory: keeps all active jobs, trims completed/failed to the most recent 100', () => {
  const active = Array.from({ length: 5 }, (_, i) => makeJob({ jobId: `active-${i}`, status: 'queued' }))
  // Newest-first (unshift order), 200 settled jobs — well past the 100 keep-limit,
  // and 5 + 200 = 205 exceeds MAX_WORLD_JOB_HISTORY so the trim actually triggers.
  const settled = Array.from({ length: 200 }, (_, i) => makeJob({ jobId: `settled-${i}`, status: 'completed' }))
  const jobs = [...active, ...settled]
  assert(jobs.length > MAX_WORLD_JOB_HISTORY)

  const trimmed = trimWorldJobHistory(jobs)

  assertEquals(trimmed.length, 5 + 100)
  for (const j of active) assert(trimmed.includes(j))
  // The 100 most recent (first, since newest-first) settled jobs survive…
  for (let i = 0; i < 100; i++) assert(trimmed.includes(settled[i]))
  // …and the oldest 100 are dropped.
  for (let i = 100; i < 200; i++) assert(!trimmed.includes(settled[i]))
})
