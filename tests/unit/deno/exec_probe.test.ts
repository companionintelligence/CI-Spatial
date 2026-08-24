/**
 * Tests for exec_probe.ts's isRunnable().
 *
 * The bug these pin: on Windows, Deno.stat() reports a synthesized mode
 * (0o100666 — exec bits always clear) rather than the `null` the original
 * code's fallback was written against, so `mode & 0o111` called every
 * binary non-runnable. splat_train/splat_detect therefore took their
 * "skipped" branch for workers that were actually present, failing 9 tests
 * on Windows dev boxes while passing in Linux CI.
 *
 * Both platform branches are exercised explicitly via the injectable
 * `platform` argument, so these assertions mean the same thing whether they
 * run on a Windows laptop or a Linux CI box — the whole point being that
 * "green locally" and "green in CI" stop disagreeing.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { isRunnable } from '../../../server/exec_probe.ts'

async function withTempFile(
  contents: string,
  fn: (path: string) => Promise<void>,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'exec-probe-' })
  const path = `${dir}/probe-target`
  try {
    await Deno.writeTextFile(path, contents)
    if (opts.mode !== undefined && Deno.build.os !== 'windows') {
      await Deno.chmod(path, opts.mode)
    }
    await fn(path)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('isRunnable: a missing path is never runnable', async () => {
  assertEquals(await isRunnable('/definitely/not/a/real/binary', 'linux'), false)
  assertEquals(await isRunnable('/definitely/not/a/real/binary', 'windows'), false)
})

Deno.test('isRunnable: a directory is not runnable, on either platform', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'exec-probe-dir-' })
  try {
    assertEquals(await isRunnable(dir, 'linux'), false)
    assertEquals(await isRunnable(dir, 'windows'), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('isRunnable (windows): an existing file is runnable despite clear exec bits', async () => {
  // The regression itself. A 0o666-mode file is exactly what Deno.stat()
  // reports for every file on Windows; masking exec bits would say false.
  await withTempFile('binary-ish', async (path) => {
    assertEquals(await isRunnable(path, 'windows'), true)
  }, { mode: 0o666 })
})

Deno.test('isRunnable (posix): a non-executable file is not runnable', async () => {
  if (Deno.build.os === 'windows') return // chmod is a no-op here; covered in Linux CI
  await withTempFile('not-executable', async (path) => {
    assertEquals(await isRunnable(path, 'linux'), false)
  }, { mode: 0o644 })
})

Deno.test('isRunnable (posix): an executable file is runnable', async () => {
  if (Deno.build.os === 'windows') return // chmod is a no-op here; covered in Linux CI
  await withTempFile('#!/bin/sh\ntrue\n', async (path) => {
    assertEquals(await isRunnable(path, 'linux'), true)
  }, { mode: 0o755 })
})

Deno.test('isRunnable: the real Deno binary is runnable on the host platform', async () => {
  // End-to-end guard against the actual symptom: before the fix this
  // returned false on Windows for a binary that is self-evidently running.
  assertEquals(await isRunnable(Deno.execPath()), true)
})
