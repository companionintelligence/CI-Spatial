/**
 * WP-J (J9): runWithDeadline copies its result without throwing when a child's
 * stream was not piped, and the timeout reason is reported for a child killed
 * with its streams unpiped. The header's claim about output after the grace
 * period is checked too: a child whose pipes stay open returns empty output.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-run-with-deadline.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { runWithDeadline } from '../../../server/run_with_deadline.ts'
import { whichPath } from '../../../server/exec_probe.ts'

const SH = await whichPath('sh')
const SLEEP = await whichPath('sleep')
const isWindows = Deno.build.os === 'windows'

Deno.test({
  name: 'runWithDeadline: a child with unpiped streams returns its exit code, not a throw',
  ignore: isWindows || SH === null,
  fn: async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'exit 3'], stdout: 'null', stderr: 'null' }, 5_000)
    assertEquals(out.code, 3)
    assertEquals(out.success, false)
    assertEquals(out.timeoutReason, null)
    assertEquals(out.stdout.length, 0)
    assertEquals(out.stderr.length, 0)
  },
})

Deno.test({
  name: 'runWithDeadline: a piped child keeps its output and its exit code',
  ignore: isWindows || SH === null,
  fn: async () => {
    const out = await runWithDeadline(SH!, { args: ['-c', 'echo out; echo err >&2; exit 4'], stdout: 'piped', stderr: 'piped' }, 5_000)
    assertEquals(out.code, 4)
    assertEquals(new TextDecoder().decode(out.stdout), 'out\n')
    assertEquals(new TextDecoder().decode(out.stderr), 'err\n')
    assertEquals(out.timeoutReason, null)
  },
})

Deno.test({
  name: 'runWithDeadline: a child killed at the deadline with unpiped streams reports the timeout, not a throw',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const out = await runWithDeadline(SLEEP!, { args: ['30'], stdout: 'null', stderr: 'null' }, 100)
    assertStringIncludes(out.timeoutReason ?? '', 'timed out after 100 ms')
    assertEquals(out.success, false)
  },
})

Deno.test({
  name: 'runWithDeadline: a child whose pipes stay open past the grace period returns empty output with the reason',
  ignore: isWindows || SH === null,
  // The grandchild outlives the kill and keeps the pipe open, so the read stays pending. That is
  // the case under test, so op sanitizers are off, and the grandchild is killed by pid afterwards.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'wp-j-deadline-' })
    const pidFile = `${dir}/grandchild.pid`
    try {
      // Output written before the kill is lost once the helper stops waiting (see its header).
      const out = await runWithDeadline(
        SH!,
        { args: ['-c', `echo before-kill; sleep 60 & echo $! > '${pidFile}'; wait`], stdout: 'piped', stderr: 'piped' },
        300,
        100,
      )
      assertStringIncludes(out.timeoutReason ?? '', 'timed out after 300 ms')
      assertEquals(out.code, 137)
      assertEquals(out.stdout.length, 0, 'output from before the kill was returned after the grace period')
    } finally {
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
