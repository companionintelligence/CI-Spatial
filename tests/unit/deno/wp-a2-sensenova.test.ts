/**
 * WP-A2 (F32): SenseNova's bash is found the way a shell finds it, through PATH,
 * and a missing one is named in the skip reason. A run past its budget is
 * stopped and reported as an error. The launcher here is a stand-in that records
 * its arguments, so no SenseNova checkout or model is needed.
 *
 * Limitation: the timeout test's stand-in launcher is `exec sleep 30`, so the
 * kill reaches the process that is actually running. The real launcher is a bash
 * script that runs python as a child. SIGKILL goes only to bash, so that python
 * child can keep running after the timeout is reported. The helper's grace period
 * then returns without its output. This test shows the timeout is reported and
 * bounded. It does not show that no child survives the kill.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-sensenova.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { runSenseNovaVision } from '../../../server/sensenova_vision.ts'
import { whichPath } from '../../../server/exec_probe.ts'

const hasBash = (await whichPath('bash')) !== null

/** A launcher that writes its own arguments, one per line, next to itself. */
const RECORDING_LAUNCHER = `#!/bin/sh
out="$(dirname "$0")/args.txt"
: > "$out"
for a in "$@"; do printf '%s\\n' "$a" >> "$out"; done
exit 0
`

/**
 * A launcher that never finishes on its own. `exec` replaces the shell with sleep,
 * so the kill reaches the process that is running. A real launcher's python child
 * would not be reached (see the limitation in the header).
 */
const HANGING_LAUNCHER = `#!/bin/sh
exec sleep 30
`

async function makeFixture(root: string, launcher: string): Promise<{ repo: string; sessionDir: string; outputDir: string }> {
  const repo = `${root}/repo`
  await Deno.mkdir(`${repo}/scripts`, { recursive: true })
  await Deno.writeTextFile(`${repo}/scripts/run_sensenova_vision.sh`, launcher)
  const sessionDir = `${root}/sess-sensenova-0001`
  await Deno.mkdir(sessionDir, { recursive: true })
  await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  return { repo, sessionDir, outputDir: `${root}/out` }
}

Deno.test({
  name: 'SenseNova: a bare "bash" resolves through PATH, so the launcher actually runs',
  ignore: !hasBash,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-a2-sensenova-' })
    try {
      const { repo, sessionDir, outputDir } = await makeFixture(root, RECORDING_LAUNCHER)
      const result = await runSenseNovaVision({
        sessionDir,
        outputDir,
        task: 'recon3d',
        repoDir: repo,
        modelPath: '/models/sensenova-test',
        bashBin: 'bash',
      })

      assertEquals(result.status, 'ok', `expected ok, got ${result.status}: ${result.remediation ?? result.error}`)
      const recorded = (await Deno.readTextFile(`${repo}/scripts/args.txt`)).split('\n')
      assert(recorded.includes('inference'))
      assert(recorded.includes('recon3d'))
      assert(recorded.includes('--model_path'))
      assert(recorded.includes('/models/sensenova-test'))
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test('SenseNova: a bare bash name that is not on PATH is skipped, and the skip names it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-a2-sensenova-' })
  try {
    const { repo, sessionDir, outputDir } = await makeFixture(root, RECORDING_LAUNCHER)
    const result = await runSenseNovaVision({
      sessionDir,
      outputDir,
      task: 'recon3d',
      repoDir: repo,
      modelPath: '/models/sensenova-test',
      bashBin: 'wp-a2-no-such-shell',
    })

    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.remediation ?? '', 'wp-a2-no-such-shell')
    assertStringIncludes(result.remediation ?? '', 'PATH')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('SenseNova: an absolute bash path that does not exist is skipped, and the skip names that path', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-a2-sensenova-' })
  try {
    const { repo, sessionDir, outputDir } = await makeFixture(root, RECORDING_LAUNCHER)
    const missing = `${root}/no-such-dir/bash`
    const result = await runSenseNovaVision({
      sessionDir,
      outputDir,
      task: 'recon3d',
      repoDir: repo,
      modelPath: '/models/sensenova-test',
      bashBin: missing,
    })

    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.remediation ?? '', missing)
    // SENSENOVA_BASH already holds a full path, so the fix must not send the operator to PATH.
    assert(!(result.remediation ?? '').includes('on PATH'), 'the remediation asks for a full path that is already set')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test({
  name: 'SenseNova: a run past SENSENOVA_TIMEOUT_MS is killed and reported as an error',
  ignore: !hasBash,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-a2-sensenova-' })
    const previous = Deno.env.get('SENSENOVA_TIMEOUT_MS')
    try {
      Deno.env.set('SENSENOVA_TIMEOUT_MS', '300')
      const { repo, sessionDir, outputDir } = await makeFixture(root, HANGING_LAUNCHER)
      const started = performance.now()
      const result = await runSenseNovaVision({
        sessionDir,
        outputDir,
        task: 'recon3d',
        repoDir: repo,
        modelPath: '/models/sensenova-test',
        bashBin: 'bash',
      })
      const took = performance.now() - started

      assertEquals(result.status, 'error')
      assertStringIncludes(result.error ?? '', 'timed out after 300 ms and was stopped')
      assert(took < 10_000, `took ${took}ms, so the launcher was not stopped`)
    } finally {
      if (previous === undefined) Deno.env.delete('SENSENOVA_TIMEOUT_MS')
      else Deno.env.set('SENSENOVA_TIMEOUT_MS', previous)
      await Deno.remove(root, { recursive: true })
    }
  },
})
