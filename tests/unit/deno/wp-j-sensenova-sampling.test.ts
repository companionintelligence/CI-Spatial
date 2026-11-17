/**
 * WP-J (J6): the frames SenseNova is given are spread evenly across the session,
 * not taken from its first N names. The helper is tested directly, and the
 * launcher's recorded arguments show the same choice reaching the run.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-sensenova-sampling.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { sampleEvenly } from '../../../server/sample_even.ts'
import { runSenseNovaVision } from '../../../server/sensenova_vision.ts'
import { whichPath } from '../../../server/exec_probe.ts'

const hasBash = (await whichPath('bash')) !== null

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

Deno.test('sampleEvenly: a list no longer than the limit comes back whole, in order', () => {
  assertEquals(sampleEvenly(['a', 'b', 'c'], 3), ['a', 'b', 'c'])
  assertEquals(sampleEvenly(['a', 'b'], 8), ['a', 'b'])
  assertEquals(sampleEvenly([], 4), [])
})

Deno.test('sampleEvenly: the sample takes the first and last item, spaced evenly, in order', () => {
  assertEquals(sampleEvenly(range(10), 4), [0, 3, 6, 9])
  assertEquals(sampleEvenly(range(7), 3), [0, 3, 6])
  assertEquals(sampleEvenly(range(5), 2), [0, 4])
})

Deno.test('sampleEvenly: it reaches the end of the walk, where taking the first N never would', () => {
  const sample = sampleEvenly(range(100), 8)
  assertEquals(sample.length, 8)
  assertEquals(sample[0], 0)
  assertEquals(sample[7], 99)
  assert(sample.some((i) => i >= 50), 'every frame in the sample came from the first half')
  assertEquals(sample, [...sample].sort((a, b) => a - b), 'the sample keeps the capture order')
})

Deno.test('sampleEvenly: the limit is always met, with no duplicates, even when it nearly equals the list', () => {
  for (const [n, limit] of [[9, 8], [10, 9], [17, 16], [3, 2]] as const) {
    const sample = sampleEvenly(range(n), limit)
    assertEquals(sample.length, limit, `n=${n} limit=${limit}`)
    assertEquals(new Set(sample).size, limit, `n=${n} limit=${limit} repeated an item`)
    assertEquals(sample[0], 0)
    assertEquals(sample[limit - 1], n - 1)
  }
})

Deno.test('sampleEvenly: a single slot takes the middle item, and a zero limit takes nothing', () => {
  assertEquals(sampleEvenly(range(9), 1), [4])
  assertEquals(sampleEvenly(range(9), 0), [])
})

Deno.test('sampleEvenly: a fractional limit is floored to whole slots, so no item comes back undefined', () => {
  // 2.5 used to return three items with the third undefined; 0.5 used to return one item.
  assertEquals(sampleEvenly(range(10), 2.5), [0, 9])
  assertEquals(sampleEvenly(range(10), 1.9), [4])
  assertEquals(sampleEvenly(range(10), 0.5), [])
  assertEquals(sampleEvenly(range(10), Number.NaN), [])
})

const RECORDING_LAUNCHER = `#!/bin/sh
out="$(dirname "$0")/args.txt"
: > "$out"
for a in "$@"; do printf '%s\\n' "$a" >> "$out"; done
exit 0
`

Deno.test({
  name: 'SenseNova: a 10-keyframe walk hands the run 8 frames spread across it, not the first 8',
  ignore: !hasBash,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-j-sensenova-' })
    try {
      const repo = `${root}/repo`
      await Deno.mkdir(`${repo}/scripts`, { recursive: true })
      await Deno.writeTextFile(`${repo}/scripts/run_sensenova_vision.sh`, RECORDING_LAUNCHER)
      const sessionDir = `${root}/sess-sensenova-walk`
      await Deno.mkdir(sessionDir, { recursive: true })
      for (let i = 0; i < 10; i++) {
        await Deno.writeFile(`${sessionDir}/kf-${String(i).padStart(5, '0')}.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
      }

      const result = await runSenseNovaVision({
        sessionDir,
        outputDir: `${root}/out`,
        task: 'recon3d',
        repoDir: repo,
        modelPath: '/models/sensenova-test',
        bashBin: 'bash',
      })
      assertEquals(result.status, 'ok', `expected ok, got ${result.status}: ${result.remediation ?? result.error}`)

      const recorded = (await Deno.readTextFile(`${repo}/scripts/args.txt`)).split('\n')
      const imageArg = recorded.find((line) => line.includes('.jpg'))
      assert(imageArg !== undefined, 'the launcher was not given the image list')
      const images = imageArg.split(',').map((p) => p.split('/').pop())
      assertEquals(images.length, 8)
      assertEquals(images[0], 'kf-00000.jpg')
      assertEquals(images[7], 'kf-00009.jpg', 'the last frame of the walk was left out')
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
