/**
 * WP-J3 (J3-4): the poll interval from FDANYONE_POLL_MS is read the way the request
 * timeout is, capped at the longest timer and never zero. An oversized value used
 * to reach setTimeout unchanged, which fires at once, so the poll ran in a tight loop.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j3-person4d-poll.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { resolveParams } from '../../../server/person4d/person_4d.ts'

const NAME = 'FDANYONE_POLL_MS'
const DEFAULT_POLL_MS = 15_000
const MAX_TIMER_MS = 2_147_483_647

const OPTS = { takeId: 'take-j3', clips: [], sequenceDir: '/x', manifestPath: '/x/m.json' }

/** The poll interval `resolveParams` gives for one value of the env var. */
function pollFromEnv(value: string | undefined): number {
  const previous = Deno.env.get(NAME)
  try {
    if (value === undefined) Deno.env.delete(NAME)
    else Deno.env.set(NAME, value)
    return resolveParams(OPTS).pollIntervalMs
  } finally {
    if (previous === undefined) Deno.env.delete(NAME)
    else Deno.env.set(NAME, previous)
  }
}

Deno.test('resolveParams: an oversized FDANYONE_POLL_MS is capped at the longest timer', () => {
  assertEquals(pollFromEnv('99999999999999'), MAX_TIMER_MS)
})

Deno.test('resolveParams: a poll interval under one millisecond takes the default, not a zero sleep', () => {
  assertEquals(pollFromEnv('0.5'), DEFAULT_POLL_MS)
  assertEquals(pollFromEnv('0'), DEFAULT_POLL_MS)
  assertEquals(pollFromEnv('-3'), DEFAULT_POLL_MS)
  assertEquals(pollFromEnv('soon'), DEFAULT_POLL_MS)
})

Deno.test('resolveParams: a sensible FDANYONE_POLL_MS is kept, rounded down, and unset takes the default', () => {
  assertEquals(pollFromEnv('2500'), 2500)
  assertEquals(pollFromEnv('2500.8'), 2500)
  assertEquals(pollFromEnv(undefined), DEFAULT_POLL_MS)
})
