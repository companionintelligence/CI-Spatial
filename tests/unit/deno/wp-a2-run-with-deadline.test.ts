/**
 * WP-A2 (F12, F23, F29, F36): the deadline helper every WorldJob child runs
 * under. A child that never exits must be killed and reported as a timeout, and
 * a child that finishes must come back exactly as `output()` would return it.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-run-with-deadline.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertRejects } from 'jsr:@std/assert@^1.0.0/rejects'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import {
  budgetFromEnv,
  describeBudget,
  runWithDeadline,
} from '../../../server/run_with_deadline.ts'
import { runCapture } from '../../../server/capabilities.ts'
import { whichPath } from '../../../server/exec_probe.ts'

const SLEEP = await whichPath('sleep')
const ECHO = await whichPath('echo')
const SH = await whichPath('sh')
const isWindows = Deno.build.os === 'windows'

Deno.test({
  name: 'runWithDeadline: a child that never exits is SIGKILLed and reports the timeout',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const started = performance.now()
    const out = await runWithDeadline(SLEEP!, { args: ['60'], stdout: 'piped', stderr: 'piped' }, 300)
    const took = performance.now() - started
    assertEquals(out.timeoutReason, 'timed out after 300 ms')
    assertEquals(out.success, false)
    assertEquals(out.signal, 'SIGKILL')
    assert(took < 5_000, `returned after ${took}ms, so the child was not killed promptly`)
  },
})

Deno.test({
  name: 'runWithDeadline: a child that finishes in time keeps its output and status, with no timeout reason',
  ignore: isWindows || ECHO === null,
  fn: async () => {
    const out = await runWithDeadline(ECHO!, { args: ['hello'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.success, true)
    assertEquals(out.code, 0)
    assertEquals(new TextDecoder().decode(out.stdout), 'hello\n')
  },
})

Deno.test({
  name: 'runWithDeadline: a child with a non-zero exit is still a plain failure, not a timeout',
  ignore: isWindows || SH === null,
  fn: async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'exit 3'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.code, 3)
    assertEquals(out.success, false)
  },
})

Deno.test({
  name: 'runWithDeadline: a killed launcher whose grandchild holds the pipe is returned after the grace period',
  ignore: isWindows || SH === null,
  // The grandchild outlives the kill, and its open pipe leaves an output read
  // pending. That read is the point of the test, so op sanitizers are off here.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'wp-a2-deadline-' })
    const pidFile = `${dir}/grandchild.pid`
    try {
      const started = performance.now()
      const out = await runWithDeadline(
        SH!,
        { args: ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], stdout: 'piped', stderr: 'piped' },
        300,
        200,
      )
      const took = performance.now() - started
      assertEquals(out.timeoutReason, 'timed out after 300 ms')
      assertEquals(out.success, false)
      assert(took < 5_000, `returned after ${took}ms; the helper waited on a pipe it should have given up on`)
    } finally {
      // The grandchild is not ours to leave behind.
      try {
        const pid = (await Deno.readTextFile(pidFile)).trim()
        await new Deno.Command('kill', { args: ['-9', pid], stdout: 'null', stderr: 'null' }).output()
      } catch {
        // Already gone, or never started.
      }
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'runWithDeadline: a binary that cannot be spawned throws, as output() does',
  fn: async () => {
    await assertRejects(
      () => runWithDeadline('/definitely/not/a/real/binary', { args: [], stdout: 'piped', stderr: 'piped' }, 1_000),
    )
  },
})

Deno.test({
  name: 'runCapture keeps its contract: a timed-out probe reports the timeout in stderr',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const out = await runCapture(SLEEP!, ['60'], 200)
    assert(out !== null)
    assertEquals(out.stderr, 'timed out after 200 ms')
  },
})

Deno.test('runCapture: a binary that cannot be spawned is still null after the refactor', async () => {
  assertEquals(await runCapture('/definitely/not/a/real/binary', [], 1_000), null)
})

Deno.test('describeBudget: budgets read as hours, minutes, seconds or milliseconds', () => {
  assertEquals(describeBudget(10_800_000), '3 h')
  assertEquals(describeBudget(1_800_000), '30 min')
  assertEquals(describeBudget(90_000), '1.5 min')
  assertEquals(describeBudget(2_500), '2.5 s')
  assertEquals(describeBudget(200), '200 ms')
})

Deno.test('budgetFromEnv: an unset, unparseable or non-positive value takes the default', () => {
  const name = 'WP_A2_TEST_BUDGET_MS'
  const previous = Deno.env.get(name)
  try {
    Deno.env.delete(name)
    assertEquals(budgetFromEnv(name, 777), 777)
    Deno.env.set(name, 'not-a-number')
    assertEquals(budgetFromEnv(name, 777), 777)
    Deno.env.set(name, '0')
    assertEquals(budgetFromEnv(name, 777), 777)
    Deno.env.set(name, '-5')
    assertEquals(budgetFromEnv(name, 777), 777)
    Deno.env.set(name, '1234.9')
    assertEquals(budgetFromEnv(name, 777), 1234)
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
})

Deno.test('budgetFromEnv: a budget past the longest timer is capped, not turned into an immediate kill', () => {
  const name = 'WP_A2_TEST_BUDGET_HUGE_MS'
  const previous = Deno.env.get(name)
  try {
    Deno.env.set(name, '99999999999999')
    assertEquals(budgetFromEnv(name, 777), 2_147_483_647)
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
})

Deno.test({
  name: 'runWithDeadline: the timeout reason names the budget the stage was given',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const out = await runWithDeadline(SLEEP!, { args: ['60'], stdout: 'piped', stderr: 'piped' }, 1_500)
    assertStringIncludes(out.timeoutReason ?? '', '1.5 s')
  },
})
