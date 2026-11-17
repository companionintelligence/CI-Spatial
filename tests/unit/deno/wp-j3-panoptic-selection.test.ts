/**
 * Panoptic keyframe selection: WP-J3 (J3-5) and the list the driver hands the worker
 * (J4-1). Taking the first N names used to segment a long session from its opening
 * frames only, so the room's far end never reached the model.
 *
 * sessionKeyframes() spreads its picks over the whole walk, and runPanopticScan()
 * passes exactly those picks to panoptic_worker.py with --frame. These tests check the
 * picks and the argument list the worker is started with. They do not run a model.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j3-panoptic-selection.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { runPanopticScan, sessionKeyframes } from '../../../server/panoptic/panoptic_scan.ts'

/** A session dir with `count` keyframes named the way the streamer names them, plus a non-image. */
async function sessionWith(count: number): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-j3-panoptic-' })
  for (let i = 0; i < count; i++) {
    await Deno.writeTextFile(`${dir}/kf-${String(i).padStart(5, '0')}.jpg`, '')
  }
  await Deno.writeTextFile(`${dir}/notes.txt`, '')
  return dir
}

/** The keyframe names a worker was started with, in the order they were given with --frame. */
function framesPassed(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '--frame' ? [arg] : []))
}

Deno.test('sessionKeyframes: a long session is sampled from its first frame to its last', async () => {
  const dir = await sessionWith(100)
  try {
    const picked = await sessionKeyframes(dir, 8)
    assertEquals(picked.length, 8)
    assertEquals(picked[0], 'kf-00000.jpg')
    assertEquals(picked[picked.length - 1], 'kf-00099.jpg')
    // Still in capture order, with no frame picked twice.
    const indices = picked.map((name) => Number(name.slice(3, 8)))
    assert(indices.every((index, i) => i === 0 || index > indices[i - 1]!), 'picks are in capture order')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('sessionKeyframes: a session within the cap is taken whole, in capture order', async () => {
  const dir = await sessionWith(5)
  try {
    assertEquals(await sessionKeyframes(dir, 64), [
      'kf-00000.jpg',
      'kf-00001.jpg',
      'kf-00002.jpg',
      'kf-00003.jpg',
      'kf-00004.jpg',
    ])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('sessionKeyframes: a session with no keyframes selects nothing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-j3-panoptic-' })
  try {
    assertEquals(await sessionKeyframes(dir, 8), [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('sessionKeyframes: an image that is not a streamer keyframe is left out, so the worker is never handed it', async () => {
  const dir = await sessionWith(3)
  try {
    await Deno.writeTextFile(dir + '/thumb.jpg', '')
    await Deno.writeTextFile(dir + '/preview.png', '')
    assertEquals(await sessionKeyframes(dir, 64), ['kf-00000.jpg', 'kf-00001.jpg', 'kf-00002.jpg'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('runPanopticScan: the worker is given the sampled frames by name, first to last', async () => {
  const dir = await sessionWith(100)
  const panopticDir = await Deno.makeTempDir({ prefix: 'wp-j3-panoptic-worker-' })
  try {
    await Deno.writeTextFile(panopticDir + '/panoptic_worker.py', '')
    let seenArgs: string[] = []
    await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir,
      maxFrames: 8,
      _spawn: (_bin, args) => {
        seenArgs = args
        return Promise.resolve({ code: 1, stderr: '' })
      },
    })
    // The even spread across all 100 frames, not the first eight (kf-00000 to kf-00007).
    assertEquals(framesPassed(seenArgs), [
      'kf-00000.jpg',
      'kf-00014.jpg',
      'kf-00028.jpg',
      'kf-00042.jpg',
      'kf-00057.jpg',
      'kf-00071.jpg',
      'kf-00085.jpg',
      'kf-00099.jpg',
    ])
  } finally {
    await Deno.remove(dir, { recursive: true })
    await Deno.remove(panopticDir, { recursive: true })
  }
})

Deno.test('runPanopticScan: a session within the cap is passed to the worker whole, in capture order', async () => {
  const dir = await sessionWith(5)
  const panopticDir = await Deno.makeTempDir({ prefix: 'wp-j3-panoptic-worker-' })
  try {
    await Deno.writeTextFile(panopticDir + '/panoptic_worker.py', '')
    let seenArgs: string[] = []
    await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir,
      maxFrames: 64,
      _spawn: (_bin, args) => {
        seenArgs = args
        return Promise.resolve({ code: 1, stderr: '' })
      },
    })
    assertEquals(framesPassed(seenArgs), [
      'kf-00000.jpg',
      'kf-00001.jpg',
      'kf-00002.jpg',
      'kf-00003.jpg',
      'kf-00004.jpg',
    ])
  } finally {
    await Deno.remove(dir, { recursive: true })
    await Deno.remove(panopticDir, { recursive: true })
  }
})
