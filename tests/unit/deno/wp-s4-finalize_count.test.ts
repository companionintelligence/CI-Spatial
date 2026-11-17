/**
 * The finalize keyframe count (countKeyframeLines in server/wp-a-keyframes.ts) reads keyframes.jsonl
 * through the session's keyframe queue. A count queued behind a keyframe write waits for that write's
 * line, and a count queued before a write does not include the line that write adds.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { countKeyframeLines, queueKeyframeWrite, writeKeyframe } from '../../../server/wp-a-keyframes.ts'

const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

/** A section the test holds open by hand, so a count can be queued behind it before its line is written. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Resolves after a short delay, so a count that should be waiting has had its chance to run. */
function settle(): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve('settled'), 20))
}

async function withSessionDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-s4-finalize-count-' })
  try {
    await run(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** A frame of `size` bytes for a session whose budget is `maxBytes`. */
function frame(name: string, size: number, maxBytes: number) {
  return {
    name,
    bytes: new Uint8Array(size).fill(1),
    meta: { source: 'wp-s4-finalize_count' },
    maxBytes,
    fileName: KEYFRAME_FILE_RE,
  }
}

Deno.test('a count queued behind a keyframe write waits for that write\'s line', async () => {
  await withSessionDir(async (dir) => {
    const jsonl = dir + '/keyframes.jsonl'
    await Deno.writeTextFile(jsonl, '{"file":"kf-00000.jpg"}\n')
    const release = gate()
    const write = queueKeyframeWrite(dir, async () => {
      // The second line is held back until the count is queued behind this section. A count that
      // skipped the queue would read only the first line here, so it would return 1, not 2.
      await release.wait
      await Deno.writeTextFile(jsonl, '{"file":"kf-00001.jpg"}\n', { append: true })
    })
    const count = countKeyframeLines(dir)
    const early = await Promise.race([count.then(() => 'counted'), settle()])
    assertEquals(early, 'settled', 'the count waits behind the write')
    release.open()
    await write
    assertEquals(await count, 2, 'the count reads both lines')
  })
})

Deno.test('a count queued after a keyframe write counts that frame\'s line', async () => {
  await withSessionDir(async (dir) => {
    const [outcome, lines] = await Promise.all([
      writeKeyframe(dir, frame('kf-00000.jpg', 100, 10_000)),
      countKeyframeLines(dir),
    ])
    assertEquals(outcome, 'written')
    assertEquals(lines, 1, 'the count runs after the frame line is appended')
  })
})

Deno.test('a count queued before a keyframe write does not include that write', async () => {
  await withSessionDir(async (dir) => {
    const [lines, outcome] = await Promise.all([
      countKeyframeLines(dir),
      writeKeyframe(dir, frame('kf-00000.jpg', 100, 10_000)),
    ])
    assertEquals(lines, 0, 'the count ran before the frame line existed')
    assertEquals(outcome, 'written')
    assertEquals(await countKeyframeLines(dir), 1, 'a later count sees the line')
  })
})

Deno.test('a session with no keyframes.jsonl counts 0', async () => {
  await withSessionDir(async (dir) => {
    assertEquals(await countKeyframeLines(dir), 0)
  })
})
