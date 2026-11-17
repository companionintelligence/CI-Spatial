/**
 * The per-session keyframe byte budget and the keyframes.jsonl line rule (server/wp-a-keyframes.ts).
 *
 * POST /sessions/:id/keyframes refuses a write that would take the session past its budget, and a
 * repeated index overwrites its frame without adding a second line, because finalize counts lines.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  KEYFRAME_SESSION_DEFAULT_MAX_BYTES,
  keyframeRecorded,
  keyframeSizesIn,
  overKeyframeBudget,
} from '../../../server/wp-a-keyframes.ts'

const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

Deno.test('the default budget is 2 GiB', () => {
  assertEquals(KEYFRAME_SESSION_DEFAULT_MAX_BYTES, 2 * 1024 * 1024 * 1024)
})

Deno.test('keyframeSizesIn counts only keyframe files, by their size on disk', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-s-keyframes-' })
  try {
    await Deno.writeFile(`${dir}/kf-00000.jpg`, new Uint8Array(100))
    await Deno.writeFile(`${dir}/kf-00001.jpg`, new Uint8Array(250))
    await Deno.writeFile(`${dir}/keyframes.jsonl`, new Uint8Array(9_999))
    await Deno.writeFile(`${dir}/kf-1.jpg`, new Uint8Array(7))
    const sizes = await keyframeSizesIn(dir, KEYFRAME_FILE_RE)
    assertEquals([...sizes.entries()].sort(), [['kf-00000.jpg', 100], ['kf-00001.jpg', 250]])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('keyframeSizesIn reads a missing session directory as empty', async () => {
  const sizes = await keyframeSizesIn('/definitely/not/a/real/session-dir', KEYFRAME_FILE_RE)
  assertEquals(sizes.size, 0)
})

Deno.test('a write that stays within the budget is admitted, and the one that passes it is refused', () => {
  const sizes = new Map([['kf-00000.jpg', 600], ['kf-00001.jpg', 300]])
  assertEquals(overKeyframeBudget(sizes, 'kf-00002.jpg', 100, 1000), false, 'exactly to the budget')
  assertEquals(overKeyframeBudget(sizes, 'kf-00002.jpg', 101, 1000), true, 'one byte past it')
})

Deno.test('a repeated index replaces its own bytes, so they are not counted twice', () => {
  const sizes = new Map([['kf-00000.jpg', 600], ['kf-00001.jpg', 300]])
  // Retrying index 1 with a frame of the same size: the old 300 bytes are replaced, not added to.
  assertEquals(overKeyframeBudget(sizes, 'kf-00001.jpg', 300, 900), false)
  assertEquals(overKeyframeBudget(sizes, 'kf-00001.jpg', 301, 900), true)
})

Deno.test('an empty session takes a frame up to the budget', () => {
  assertEquals(overKeyframeBudget(new Map(), 'kf-00000.jpg', 2000, 2000), false)
  assertEquals(overKeyframeBudget(new Map(), 'kf-00000.jpg', 2001, 2000), true)
})

Deno.test('keyframeRecorded finds a frame by its name in keyframes.jsonl', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-s-keyframes-' })
  try {
    const jsonl = `${dir}/keyframes.jsonl`
    assertEquals(await keyframeRecorded(jsonl, 'kf-00000.jpg'), false, 'a missing file holds no record')
    await Deno.writeTextFile(
      jsonl,
      '{"index":0,"file":"kf-00000.jpg","bytes":5}\nnot json at all\n\n{"index":1,"file":"kf-00001.jpg"}\n',
    )
    assertEquals(await keyframeRecorded(jsonl, 'kf-00000.jpg'), true)
    assertEquals(await keyframeRecorded(jsonl, 'kf-00001.jpg'), true)
    assertEquals(await keyframeRecorded(jsonl, 'kf-00002.jpg'), false)
    assert(!(await keyframeRecorded(jsonl, 'kf-0000')), 'a partial name is not a match')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
