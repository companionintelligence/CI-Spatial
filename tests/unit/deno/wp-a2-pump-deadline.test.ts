/**
 * WP-A2 (F29, F36): the pump's per-job deadline. A dispatch that never settles
 * must not hold every job behind it: its signal aborts, and once the grace period
 * passes without it settling the caller is told, so it can fail the job. Then the
 * next job starts. A dispatch that settles inside the grace period is not reported.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-pump-deadline.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { WorldJobPump } from '../../../server/world/world_job_pump.ts'

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

Deno.test('WorldJobPump deadline: a dispatch that never settles is aborted, reported after the grace period, and the next job still runs', async () => {
  const events: string[] = []
  const signals = new Map<string, AbortSignal>()
  const timedOut: string[] = []
  const pump = new WorldJobPump(
    (_slug, jobId, signal) => {
      events.push(`start:${jobId}`)
      if (signal) signals.set(jobId, signal)
      if (jobId === 'job-hung') return new Promise<void>(() => {}) // never settles
      events.push(`end:${jobId}`)
      return Promise.resolve()
    },
    { deadlineMs: 30, graceMs: 30, onDeadline: (_slug, jobId) => { timedOut.push(jobId) } },
  )

  pump.enqueue('default', 'job-hung')
  pump.enqueue('default', 'job-next')
  await waitUntil(() => events.includes('end:job-next'), 3_000)

  assertEquals(timedOut, ['job-hung'])
  assert(signals.get('job-hung')?.aborted, 'the hung dispatch was not told to stop')
  assertEquals(events, ['start:job-hung', 'start:job-next', 'end:job-next'])
  assertEquals(pump.pendingCount, 0)
  assert(!pump.isWorking)
})

Deno.test('WorldJobPump deadline: a runner that honours the signal finishes before the next job starts', async () => {
  const events: string[] = []
  const pump = new WorldJobPump(
    (_slug, jobId, signal) => {
      events.push(`start:${jobId}`)
      if (jobId !== 'job-a') {
        events.push(`end:${jobId}`)
        return Promise.resolve()
      }
      // Stands in for a runner whose child was killed by the signal: it takes a
      // moment to wind down, then returns.
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          setTimeout(() => {
            events.push(`end:${jobId}`)
            resolve()
          }, 20)
        })
      })
    },
    { deadlineMs: 30, graceMs: 2_000 },
  )

  pump.enqueue('default', 'job-a')
  pump.enqueue('default', 'job-b')
  await waitUntil(() => events.includes('end:job-b'), 3_000)

  assertEquals(events, ['start:job-a', 'end:job-a', 'start:job-b', 'end:job-b'])
})

Deno.test('WorldJobPump deadline: a job that finishes in time is never aborted or reported', async () => {
  const events: string[] = []
  const timedOut: string[] = []
  let sawAbort = false
  const pump = new WorldJobPump(
    async (_slug, jobId, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (signal?.aborted) sawAbort = true
      events.push(`end:${jobId}`)
    },
    { deadlineMs: 2_000, onDeadline: (_slug, jobId) => { timedOut.push(jobId) } },
  )

  pump.enqueue('default', 'job-quick')
  await waitUntil(() => events.includes('end:job-quick'), 3_000)

  assertEquals(timedOut, [])
  assertEquals(sawAbort, false)
})

Deno.test('WorldJobPump deadline: WORLD_JOB_DEADLINE_MS sets the default ceiling', async () => {
  const name = 'WORLD_JOB_DEADLINE_MS'
  const previous = Deno.env.get(name)
  const events: string[] = []
  try {
    Deno.env.set(name, '40')
    const pump = new WorldJobPump(
      (_slug, jobId, signal) => {
        events.push(`start:${jobId}`)
        if (jobId !== 'job-slow') return Promise.resolve()
        // Honours the abort at once, so the default grace period is not spent.
        return new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve())
        })
      },
    )
    pump.enqueue('default', 'job-slow')
    pump.enqueue('default', 'job-after')
    await waitUntil(() => events.includes('start:job-after'), 3_000)
    assertEquals(events, ['start:job-slow', 'start:job-after'])
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
})
