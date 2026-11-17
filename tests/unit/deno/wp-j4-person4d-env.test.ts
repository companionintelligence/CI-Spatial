/**
 * WP-J4 (J4-3): an integer knob read from the environment is floored first, then taken
 * only when it is at least 1, and otherwise the default is used. Testing before flooring
 * let FDANYONE_MAX_WAIT_MS=0.5 through, and it floored to 0, so the poll gave up at once.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j4-person4d-env.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { resolveParams } from '../../../server/person4d/person_4d.ts'

const OPTS = { takeId: 'take-j4', clips: [], sequenceDir: '/x', manifestPath: '/x/m.json' }
const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000
const DEFAULT_VIEWS_PER_LAYER = 6
const DEFAULT_TIMESTEP_FPS = 5

/** Runs `read` with one env var set to `value` (or unset), then puts it back. */
function withEnv<T>(name: string, value: string | undefined, read: () => T): T {
  const previous = Deno.env.get(name)
  try {
    if (value === undefined) Deno.env.delete(name)
    else Deno.env.set(name, value)
    return read()
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
}

Deno.test('resolveParams: FDANYONE_MAX_WAIT_MS under one takes the default, not a zero wait', () => {
  for (const value of ['0.5', '0', '-3', 'soon']) {
    const maxWaitMs = withEnv('FDANYONE_MAX_WAIT_MS', value, () => resolveParams(OPTS).maxWaitMs)
    assertEquals(maxWaitMs, DEFAULT_MAX_WAIT_MS, 'FDANYONE_MAX_WAIT_MS=' + value)
  }
})

Deno.test('resolveParams: a whole-number FDANYONE_MAX_WAIT_MS is kept, rounded down; unset takes the default', () => {
  assertEquals(withEnv('FDANYONE_MAX_WAIT_MS', '1800000.9', () => resolveParams(OPTS).maxWaitMs), 1800000)
  assertEquals(withEnv('FDANYONE_MAX_WAIT_MS', undefined, () => resolveParams(OPTS).maxWaitMs), DEFAULT_MAX_WAIT_MS)
})

Deno.test('resolveParams: the other integer knobs follow the same floor-then-at-least-one rule', () => {
  assertEquals(withEnv('FDANYONE_TIMESTEP_FPS', '0.5', () => resolveParams(OPTS).timestepFps), DEFAULT_TIMESTEP_FPS)
  assertEquals(withEnv('FDANYONE_TIMESTEP_FPS', '2.9', () => resolveParams(OPTS).timestepFps), 2)
  assertEquals(withEnv('FDANYONE_VIEWS_PER_LAYER', '0.5', () => resolveParams(OPTS).viewsPerLayer), DEFAULT_VIEWS_PER_LAYER)
  assertEquals(withEnv('FDANYONE_VIEWS_PER_LAYER', '24.7', () => resolveParams(OPTS).viewsPerLayer), 24)
})
