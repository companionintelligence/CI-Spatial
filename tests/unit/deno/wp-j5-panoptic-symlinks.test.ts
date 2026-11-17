/**
 * WP-J5 (J5-1): the driver's keyframe list matches the worker's. The worker lists a folder by
 * following links, so a symlinked keyframe that the old first-N path segmented was left out of
 * the spread when the driver filtered on the link itself. A link to a keyframe file is listed
 * now. A broken link, or a link to a folder, is not, as the worker does not list those either.
 *
 * These tests check the picks and the argument list the worker is started with. They do not run
 * a model.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j5-panoptic-symlinks.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { runPanopticScan, sessionKeyframes } from '../../../server/panoptic/panoptic_scan.ts'

/** The keyframe names a worker was started with, in the order they were given with --frame. */
function framesPassed(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '--frame' ? [arg] : []))
}

Deno.test('sessionKeyframes: a symlink to a keyframe file is listed, as the worker lists it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-j5-panoptic-link-' })
  const dir = root + '/session'
  try {
    await Deno.mkdir(dir)
    await Deno.writeTextFile(root + '/real.jpg', '')
    await Deno.writeTextFile(dir + '/kf-00000.jpg', '')
    await Deno.symlink(root + '/real.jpg', dir + '/kf-00001.jpg')
    await Deno.writeTextFile(dir + '/kf-00002.jpg', '')
    assertEquals(await sessionKeyframes(dir, 64), ['kf-00000.jpg', 'kf-00001.jpg', 'kf-00002.jpg'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('sessionKeyframes: a symlinked last keyframe can be one of the spread picks', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-j5-panoptic-link-' })
  const dir = root + '/session'
  try {
    await Deno.mkdir(dir)
    await Deno.writeTextFile(root + '/real.jpg', '')
    for (let i = 0; i < 9; i++) {
      await Deno.writeTextFile(dir + '/kf-' + String(i).padStart(5, '0') + '.jpg', '')
    }
    await Deno.symlink(root + '/real.jpg', dir + '/kf-00009.jpg')
    // Four picks over ten names land on indexes 0, 3, 6 and 9, so the last pick is the link.
    const picked = await sessionKeyframes(dir, 4)
    assertEquals(picked, ['kf-00000.jpg', 'kf-00003.jpg', 'kf-00006.jpg', 'kf-00009.jpg'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('sessionKeyframes: a broken link and a link to a folder are left out, as the worker leaves them out', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-j5-panoptic-link-' })
  const dir = root + '/session'
  try {
    await Deno.mkdir(dir)
    await Deno.mkdir(root + '/a-folder')
    await Deno.writeTextFile(dir + '/kf-00000.jpg', '')
    await Deno.symlink(root + '/missing.jpg', dir + '/kf-00001.jpg')
    await Deno.symlink(root + '/a-folder', dir + '/kf-00002.jpg')
    await Deno.writeTextFile(dir + '/kf-00003.jpg', '')
    assertEquals(await sessionKeyframes(dir, 64), ['kf-00000.jpg', 'kf-00003.jpg'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('runPanopticScan: a symlinked keyframe is passed to the worker by name, in capture order', async () => {
  const root = await Deno.makeTempDir({ prefix: 'wp-j5-panoptic-link-' })
  const dir = root + '/session'
  const panopticDir = root + '/worker'
  try {
    await Deno.mkdir(dir)
    await Deno.mkdir(panopticDir)
    await Deno.writeTextFile(panopticDir + '/panoptic_worker.py', '')
    await Deno.writeTextFile(root + '/real.jpg', '')
    await Deno.writeTextFile(dir + '/kf-00000.jpg', '')
    await Deno.symlink(root + '/real.jpg', dir + '/kf-00001.jpg')
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
    assertEquals(framesPassed(seenArgs), ['kf-00000.jpg', 'kf-00001.jpg'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
