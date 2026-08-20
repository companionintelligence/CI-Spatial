/**
 * Tests cover the Deno-side surface only — the Python worker is exercised
 * in the integration job test. Here we just make sure:
 *
 *  1. Session-id validation gates spawning so a request for `../etc/passwd`
 *     can never reach the subprocess.
 *  2. CLI argument assembly is stable.
 *  3. A missing python executable produces a structured error result
 *     rather than throwing — this is the "deps not installed" fallback the
 *     world-job coordinator relies on.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  buildWorkerArgs,
  isValidSessionDir,
  runLingBotMapReconstruction,
} from './lingbot_map.ts'

Deno.test('isValidSessionDir accepts canonical session ids', () => {
  assert(isValidSessionDir('/tmp/scans/sessions/sess-12345-abcde'))
})

Deno.test('isValidSessionDir rejects the retired client-minted shape', () => {
  // 07-scan-identity/0002 cut SESSION_ID_RE over to sess-* only, everywhere —
  // session-* named a directory the server never created. This file used to
  // carry its own, wider copy of the regex that still accepted it.
  assert(!isValidSessionDir('./scans/sessions/session-19710101-test'))
})

Deno.test('isValidSessionDir rejects path traversal and other dirs', () => {
  assert(!isValidSessionDir('/etc/passwd'))
  assert(!isValidSessionDir('../../etc'))
  assert(!isValidSessionDir('/tmp/scans/sessions/'))
  assert(!isValidSessionDir('/tmp/scans/sessions/sess'))
})

Deno.test('buildWorkerArgs only emits the fields it was given', () => {
  const args = buildWorkerArgs({
    scriptPath: '/srv/lingbot_map_worker.py',
    sessionDir: '/srv/scans/sessions/sess-1-abc',
  })
  assertEquals(args, [
    '/srv/lingbot_map_worker.py',
    '--session-dir',
    '/srv/scans/sessions/sess-1-abc',
  ])
})

Deno.test('buildWorkerArgs forwards overrides', () => {
  const args = buildWorkerArgs({
    scriptPath: '/srv/lingbot_map_worker.py',
    sessionDir: '/srv/scans/sessions/sess-1-abc',
    modelPath: '/models/lingbot.ckpt',
    keyframeInterval: 4,
    maxFrames: 256,
    device: 'cuda',
  })
  assertEquals(args, [
    '/srv/lingbot_map_worker.py',
    '--session-dir',
    '/srv/scans/sessions/sess-1-abc',
    '--model-path',
    '/models/lingbot.ckpt',
    '--keyframe-interval',
    '4',
    '--max-frames',
    '256',
    '--device',
    'cuda',
  ])
})

Deno.test('runLingBotMapReconstruction rejects invalid session dirs without spawning', async () => {
  const result = await runLingBotMapReconstruction({
    sessionDir: '/etc/passwd',
    scriptPath: '/does-not-matter.py',
    python: '/usr/bin/this-binary-does-not-exist',
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 2)
  assert(typeof result.error === 'string' && result.error.includes('invalid session directory'))
})

Deno.test({
  name: 'runLingBotMapReconstruction reports structured error when python is missing',
  permissions: {
    run: ['/this/binary/definitely/does/not/exist'],
    read: true,
    write: true,
    env: true,
  },
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'lingbot-test-' })
    const sessionDir = `${tmp}/sess-test-abcd`
    await Deno.mkdir(sessionDir, { recursive: true })
    const result = await runLingBotMapReconstruction({
      sessionDir,
      scriptPath: `${tmp}/missing.py`,
      python: '/this/binary/definitely/does/not/exist',
    })
    assertEquals(result.status, 'error')
    assert(result.exitCode === 3 || result.exitCode === 2)
    assert(typeof result.error === 'string' && result.error.length > 0)
    await Deno.remove(tmp, { recursive: true })
  },
})
