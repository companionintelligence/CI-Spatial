/**
 * The per-session keyframe write queue (server/wp-a-keyframes.ts: queueKeyframeWrite and writeKeyframe).
 *
 * A keyframe write checks the session's budget and then writes the frame and its line. Two overlapping
 * POST /sessions/:id/keyframes calls for one index could both pass the budget, and both append a line to
 * keyframes.jsonl, which finalize counts. The queue runs one session's writes in the order they were
 * queued, and does not hold up other sessions.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { queueKeyframeWrite, writeKeyframe } from '../../../server/wp-a-keyframes.ts'

const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

/** A section the test opens by hand, to hold it while another one is queued behind it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Resolves after a short delay, so a section that should be waiting has had its chance to run. */
function settle(): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve('settled'), 20))
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

async function withSessionDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-s-keyframe-queue-' })
  try {
    await run(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** A frame of `size` bytes, each set to `fill`, for a session whose budget is `maxBytes`. */
function frame(name: string, fill: number, size: number, maxBytes: number) {
  return {
    name,
    bytes: new Uint8Array(size).fill(fill),
    meta: { source: 'wp-s-keyframe_queue' },
    maxBytes,
    fileName: KEYFRAME_FILE_RE,
  }
}

async function recordLines(dir: string): Promise<string[]> {
  return (await Deno.readTextFile(`${dir}/keyframes.jsonl`)).split('\n').filter(line => line.trim() !== '')
}

Deno.test('sections queued for one session run in the order they were queued', async () => {
  const log: string[] = []
  const hold = gate()
  const first = queueKeyframeWrite('queue-order-session', async () => {
    log.push('first:start')
    await hold.wait
    log.push('first:end')
  })
  const second = queueKeyframeWrite('queue-order-session', () => {
    log.push('second:start')
    log.push('second:end')
    return Promise.resolve()
  })
  await settle()
  assertEquals(log, ['first:start'], 'the second section waits behind the first')
  hold.open()
  await Promise.all([first, second])
  assertEquals(log, ['first:start', 'first:end', 'second:start', 'second:end'])
})

Deno.test('a section for one session does not hold up a section for another', async () => {
  const log: string[] = []
  const hold = gate()
  const held = queueKeyframeWrite('queue-independent-a', async () => {
    await hold.wait
    log.push('a')
  })
  const other = queueKeyframeWrite('queue-independent-b', () => {
    log.push('b')
    return Promise.resolve()
  }).then(() => 'finished')
  const outcome = await Promise.race([other, settle()])
  assertEquals(outcome, 'finished', 'session b finished while session a was still held')
  hold.open()
  await held
  assertEquals(log, ['b', 'a'])
})

Deno.test('a section that throws reports its own error, and the next section for that session still runs', async () => {
  await assertRejects(
    () => queueKeyframeWrite('queue-failure-session', () => Promise.reject(new Error('disk full'))),
    Error,
    'disk full',
  )
  assertEquals(await queueKeyframeWrite('queue-failure-session', () => Promise.resolve('next ran')), 'next ran')
})

Deno.test('two overlapping writes of one index leave one frame and one keyframes.jsonl line', async () => {
  await withSessionDir(async (dir) => {
    const outcomes = await Promise.all([
      writeKeyframe(dir, frame('kf-00000.jpg', 1, 100, 10_000)),
      writeKeyframe(dir, frame('kf-00000.jpg', 2, 100, 10_000)),
    ])
    assertEquals(outcomes, ['written', 'written'])
    assertEquals((await recordLines(dir)).length, 1, 'a repeated index adds no second line')
    assertEquals((await Deno.readFile(`${dir}/kf-00000.jpg`))[0], 2, 'the later write replaces the frame')
  })
})

Deno.test('two overlapping writes that together exceed the budget admit only the first', async () => {
  await withSessionDir(async (dir) => {
    const outcomes = await Promise.all([
      writeKeyframe(dir, frame('kf-00000.jpg', 1, 100, 150)),
      writeKeyframe(dir, frame('kf-00001.jpg', 2, 100, 150)),
    ])
    assertEquals(outcomes, ['written', 'over-budget'], 'the second write sees the first frame already on disk')
    assertEquals(await exists(`${dir}/kf-00001.jpg`), false, 'the refused frame is not written')
    assertEquals((await recordLines(dir)).length, 1, 'the refused frame adds no line')
  })
})
