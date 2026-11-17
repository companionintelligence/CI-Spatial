/**
 * WP-J (J3): the pump's deadline callback. `onDeadline` is told only when a
 * dispatch is still running one grace period after its deadline, and a callback
 * that rejects, throws or never settles is logged or bounded, never allowed to
 * become an unhandled rejection or to hold the queue.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-pump-deadline.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { WorldJobPump } from '../../../server/world/world_job_pump.ts'

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Collect what the pump logs while `fn` runs, so the expected log lines can be asserted. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '))
  }
  try {
    await fn()
  } finally {
    console.error = real
  }
  return logged
}

Deno.test('WorldJobPump onDeadline: not told when the dispatch settles inside the grace period', async () => {
  const events: string[] = []
  const timedOut: string[] = []
  const pump = new WorldJobPump(
    (_slug, jobId, signal) => {
      events.push(`start:${jobId}`)
      if (jobId !== 'job-a') {
        events.push(`end:${jobId}`)
        return Promise.resolve()
      }
      // A runner that honours the abort and winds down within the grace period.
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          setTimeout(() => {
            events.push(`end:${jobId}`)
            resolve()
          }, 20)
        })
      })
    },
    { deadlineMs: 30, graceMs: 2_000, onDeadline: (_slug, jobId) => { timedOut.push(jobId) } },
  )

  pump.enqueue('default', 'job-a')
  pump.enqueue('default', 'job-b')
  await waitUntil(() => events.includes('end:job-b'), 3_000)

  assertEquals(timedOut, [], 'the runner kept its own outcome, so the caller was not told')
  assertEquals(events, ['start:job-a', 'end:job-a', 'start:job-b', 'end:job-b'])
})

Deno.test('WorldJobPump onDeadline: an async callback that rejects is logged, and the queue still moves on', async () => {
  const events: string[] = []
  const logged = await captureErrors(async () => {
    const pump = new WorldJobPump(
      (_slug, jobId) => {
        events.push(`start:${jobId}`)
        if (jobId === 'job-hung') return new Promise<void>(() => {}) // never settles
        events.push(`end:${jobId}`)
        return Promise.resolve()
      },
      {
        deadlineMs: 20,
        graceMs: 20,
        onDeadline: () => Promise.reject(new Error('callback rejected')),
      },
    )
    pump.enqueue('default', 'job-hung')
    pump.enqueue('default', 'job-next')
    await waitUntil(() => events.includes('end:job-next'), 3_000)
    assertEquals(events, ['start:job-hung', 'start:job-next', 'end:job-next'])
  })

  assert(logged.some((line) => line.includes('onDeadline failed for job-hung')), `logged: ${logged.join(' | ')}`)
  assert(logged.some((line) => line.includes('callback rejected')))
})

Deno.test('WorldJobPump onDeadline: a synchronous throw is logged the same way, not thrown into the pump', async () => {
  const events: string[] = []
  const logged = await captureErrors(async () => {
    const pump = new WorldJobPump(
      (_slug, jobId) => {
        events.push(`start:${jobId}`)
        if (jobId === 'job-hung') return new Promise<void>(() => {})
        events.push(`end:${jobId}`)
        return Promise.resolve()
      },
      {
        deadlineMs: 20,
        graceMs: 20,
        onDeadline: () => {
          throw new Error('sync throw')
        },
      },
    )
    pump.enqueue('default', 'job-hung')
    pump.enqueue('default', 'job-next')
    await waitUntil(() => events.includes('end:job-next'), 3_000)
  })

  assertStringIncludes(logged.join(' | '), 'onDeadline failed for job-hung')
  assertStringIncludes(logged.join(' | '), 'sync throw')
})

Deno.test('WorldJobPump onDeadline: a callback that never settles does not hold the queue past the grace period', async () => {
  const events: string[] = []
  const pump = new WorldJobPump(
    (_slug, jobId) => {
      events.push(`start:${jobId}`)
      if (jobId === 'job-hung') return new Promise<void>(() => {})
      events.push(`end:${jobId}`)
      return Promise.resolve()
    },
    {
      deadlineMs: 20,
      graceMs: 20,
      onDeadline: () => new Promise<void>(() => {}), // never settles
    },
  )
  const started = performance.now()
  pump.enqueue('default', 'job-hung')
  pump.enqueue('default', 'job-next')
  await waitUntil(() => events.includes('end:job-next'), 3_000)
  const took = performance.now() - started

  assertEquals(events, ['start:job-hung', 'start:job-next', 'end:job-next'])
  assert(took < 2_000, `took ${took}ms, so the callback held the queue`)
  assert(!pump.isWorking)
})
