/**
 * WP-J3 (J3-3): a stage budget read from the environment is never zero. A value
 * between 0 and 1 used to floor to 0, and a zero-length timer fires at once, which
 * killed the stage before it started.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j3-budget.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { budgetFromEnv } from '../../../server/run_with_deadline.ts'

const NAME = 'WP_J3_TEST_BUDGET_MS'

function withEnv(value: string, fn: () => void): void {
  const previous = Deno.env.get(NAME)
  try {
    Deno.env.set(NAME, value)
    fn()
  } finally {
    if (previous === undefined) Deno.env.delete(NAME)
    else Deno.env.set(NAME, previous)
  }
}

Deno.test('budgetFromEnv: a value that rounds down to zero takes the default, not a zero timer', () => {
  for (const raw of ['0.5', '0.999', '0.0001']) {
    withEnv(raw, () => assertEquals(budgetFromEnv(NAME, 777), 777, `raw ${raw}`))
  }
})

Deno.test('budgetFromEnv: a value of at least one millisecond is kept, rounded down', () => {
  withEnv('1', () => assertEquals(budgetFromEnv(NAME, 777), 1))
  withEnv('1.9', () => assertEquals(budgetFromEnv(NAME, 777), 1))
  withEnv('1500.7', () => assertEquals(budgetFromEnv(NAME, 777), 1500))
})

Deno.test('budgetFromEnv: infinite, negative, zero and unparseable values take the default', () => {
  for (const raw of ['Infinity', '-Infinity', 'NaN', '-0.5', '-5', '0', 'abc', '']) {
    withEnv(raw, () => assertEquals(budgetFromEnv(NAME, 777), 777, `raw ${JSON.stringify(raw)}`))
  }
})
