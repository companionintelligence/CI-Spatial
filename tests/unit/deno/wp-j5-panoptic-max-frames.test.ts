/**
 * WP-J5 (J5-2): the panoptic frame cap is read the way intFromEnv reads an integer knob. It is
 * floored first and then taken only when it is at least 1, and anything else takes the default.
 * A fraction used to reach the worker as --max-frames 2.5, which its int parser rejects, and a
 * value under one skipped the run with the remediation for a missing keyframe folder. The
 * explicit maxFrames option, which the job payload passes through, takes the same rule.
 *
 * These tests check the resolved cap and the argument list the worker is started with. They do
 * not run a model.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j5-panoptic-max-frames.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { resolveParams, runPanopticScan } from '../../../server/panoptic/panoptic_scan.ts'

const DEFAULT_MAX_FRAMES = 64
const OPTS = { sessionDir: '/x' }

/** Runs `read` with one env var set to `value` (or unset), then puts it back. */
async function withEnv<T>(name: string, value: string | undefined, read: () => T | Promise<T>): Promise<T> {
  const previous = Deno.env.get(name)
  try {
    if (value === undefined) Deno.env.delete(name)
    else Deno.env.set(name, value)
    return await read()
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
}

/** The keyframe names a worker was started with, in the order they were given with --frame. */
function framesPassed(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '--frame' ? [arg] : []))
}

Deno.test('resolveParams: a fractional PANOPTIC_MAX_FRAMES is floored, so the worker gets a whole number', async () => {
  assertEquals(await withEnv('PANOPTIC_MAX_FRAMES', '2.5', () => resolveParams(OPTS).maxFrames), 2)
  assertEquals(await withEnv('PANOPTIC_MAX_FRAMES', '8.9', () => resolveParams(OPTS).maxFrames), 8)
})

Deno.test('resolveParams: a PANOPTIC_MAX_FRAMES under one takes the default, not a cap of zero', async () => {
  for (const value of ['0.5', '0', '-3', 'many', '']) {
    const maxFrames = await withEnv('PANOPTIC_MAX_FRAMES', value, () => resolveParams(OPTS).maxFrames)
    assertEquals(maxFrames, DEFAULT_MAX_FRAMES, 'PANOPTIC_MAX_FRAMES=' + JSON.stringify(value))
  }
})

Deno.test('resolveParams: a whole PANOPTIC_MAX_FRAMES is kept; unset takes the default', async () => {
  assertEquals(await withEnv('PANOPTIC_MAX_FRAMES', '12', () => resolveParams(OPTS).maxFrames), 12)
  assertEquals(await withEnv('PANOPTIC_MAX_FRAMES', undefined, () => resolveParams(OPTS).maxFrames), DEFAULT_MAX_FRAMES)
})

Deno.test('resolveParams: an explicit maxFrames takes the same rule as the env var', () => {
  assertEquals(resolveParams({ ...OPTS, maxFrames: 2.5 }).maxFrames, 2)
  assertEquals(resolveParams({ ...OPTS, maxFrames: 0 }).maxFrames, DEFAULT_MAX_FRAMES)
  assertEquals(resolveParams({ ...OPTS, maxFrames: 5 }).maxFrames, 5)
})

/** A session of ten keyframes and a worker folder, with the worker's args captured by the spawn seam. */
async function runWithCap(envValue: string | undefined) {
  const root = await Deno.makeTempDir({ prefix: 'wp-j5-panoptic-cap-' })
  const dir = root + '/session'
  const panopticDir = root + '/worker'
  try {
    await Deno.mkdir(dir)
    await Deno.mkdir(panopticDir)
    await Deno.writeTextFile(panopticDir + '/panoptic_worker.py', '')
    for (let i = 0; i < 10; i++) {
      await Deno.writeTextFile(dir + '/kf-' + String(i).padStart(5, '0') + '.jpg', '')
    }
    let seenArgs: string[] = []
    const manifest = await withEnv('PANOPTIC_MAX_FRAMES', envValue, () =>
      runPanopticScan({
        sessionDir: dir,
        python: '/bin/sh',
        panopticDir,
        _spawn: (_bin, args) => {
          seenArgs = args
          return Promise.resolve({ code: 1, stderr: '' })
        },
      }))
    return { manifest, seenArgs }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test('runPanopticScan: a fractional PANOPTIC_MAX_FRAMES reaches the worker as a whole cap, not a skip', async () => {
  const { manifest, seenArgs } = await runWithCap('2.5')
  assertEquals(manifest.status === 'skipped', false, 'the run is not skipped')
  assertEquals(manifest.params.maxFrames, 2)
  assertEquals(seenArgs[seenArgs.indexOf('--max-frames') + 1], '2')
  assertEquals(framesPassed(seenArgs), ['kf-00000.jpg', 'kf-00009.jpg'])
})

Deno.test('runPanopticScan: a PANOPTIC_MAX_FRAMES under one runs with the default cap, not a skip', async () => {
  const { manifest, seenArgs } = await runWithCap('0.5')
  assertEquals(manifest.status === 'skipped', false, 'the run is not skipped')
  assertEquals(seenArgs[seenArgs.indexOf('--max-frames') + 1], String(DEFAULT_MAX_FRAMES))
  assertEquals(framesPassed(seenArgs).length, 10)
})
