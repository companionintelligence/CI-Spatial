/**
 * WP-J (J8): a PATH probe for `colmap -h` that runs out of time is reported as a
 * timeout, not as a missing binary, and the skip reason says so.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-colmap-probe.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { colmapNotFoundSkip, locateColmapBin } from '../../../server/colmap/colmap_poses.ts'
import { whichPath } from '../../../server/exec_probe.ts'

const SLEEP = await whichPath('sleep')
const SH = await whichPath('sh')
const isWindows = Deno.build.os === 'windows'

Deno.test({
  name: 'colmap probe: a `colmap -h` that never answers is timed out, and is not reported as missing',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-j-colmap-' })
    const previousPath = Deno.env.get('PATH') ?? ''
    try {
      // A stand-in `colmap` that hangs. It is first on PATH for this test only.
      const bin = `${root}/colmap`
      await Deno.writeTextFile(bin, `#!/bin/sh\nexec ${SLEEP} 30\n`)
      await Deno.chmod(bin, 0o755)
      Deno.env.set('PATH', `${root}:${previousPath}`)

      const started = performance.now()
      const located = await locateColmapBin('colmap', 100)
      const took = performance.now() - started

      assertEquals(located.pathProbe, 'timed-out')
      assert(took < 10_000, `took ${took}ms; the probe was not bounded`)
      const skip = colmapNotFoundSkip('colmap', located.pathProbe)
      assertStringIncludes(skip.skippedReason, 'probe timed out')
      assert(!skip.skippedReason.includes('not found'), 'a timed-out probe was reported as a missing binary')
    } finally {
      Deno.env.set('PATH', previousPath)
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'colmap probe: a colmap on PATH that answers `-h` is found, and the probe does not throw',
  ignore: isWindows || SH === null,
  fn: async () => {
    // The probe discards the child's output (stdout and stderr are not piped). That used to
    // make the probe throw, so a colmap on PATH was never found.
    const root = await Deno.makeTempDir({ prefix: 'wp-j-colmap-' })
    const previousPath = Deno.env.get('PATH') ?? ''
    try {
      const bin = `${root}/colmap`
      await Deno.writeTextFile(bin, `#!${SH}\nexit 0\n`)
      await Deno.chmod(bin, 0o755)
      Deno.env.set('PATH', `${root}:${previousPath}`)

      const located = await locateColmapBin('colmap', 5_000)

      assertEquals(located.pathProbe, 'found')
      assertEquals(located.bin, 'colmap')
    } finally {
      Deno.env.set('PATH', previousPath)
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test('colmap probe: a binary that is simply absent is still reported as not found', () => {
  const skip = colmapNotFoundSkip('colmap', 'missing')
  assertStringIncludes(skip.skippedReason, 'not found')
  assert(!skip.skippedReason.includes('timed out'))
  assertStringIncludes(skip.remediation, 'COLMAP_BIN')
})

Deno.test('colmap probe: an explicitly named binary that is not runnable keeps its plain not-found reason', () => {
  const skip = colmapNotFoundSkip('/opt/no-such/colmap', 'not-tried')
  assertEquals(skip.skippedReason, 'COLMAP binary not found: /opt/no-such/colmap')
})
