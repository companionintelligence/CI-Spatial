/**
 * Regression tests for the per-slug world lock (`world_lock.ts`).
 *
 * The bug it exists to prevent: `main.ts`'s `saveWorld()` writes atomically
 * (tmp file + rename), but nothing serialized the surrounding
 * `loadWorld() → mutate → saveWorld()` cycle, so two concurrent cycles could
 * interleave and the second writer — holding a snapshot taken before the
 * first writer saved — silently reverted the first writer's change. It showed
 * up in `npm run test:box` as optimize-scan jobs stuck at
 * `status: 'processing'`, `progress: 0.35` (the values `_dispatchWorldJob`
 * writes when it claims a job) minutes after they had completed, with other
 * jobs still finishing normally around them — impossible under the pump's
 * single-flight execution (ADR 0003), and the signature of a lost update.
 *
 * The first test reproduces exactly that interleaving against a real file,
 * unlocked and locked, so the failure mode and the fix are both pinned.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertRejects } from 'jsr:@std/assert@^1.0.0/rejects'
import { heldWorldLocks, withWorldLock } from './world_lock.ts'

type Doc = Record<string, string>

async function withTempFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'world-lock-test-' })
  try {
    await fn(`${dir}/default.json`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** The `loadWorld → mutate → saveWorld` shape, with the read and the write
 * separated by an await — exactly what lets a second cycle slip in between. */
async function readModifyWrite(path: string, key: string, value: string): Promise<void> {
  const doc = JSON.parse(await Deno.readTextFile(path)) as Doc
  await new Promise((resolve) => setTimeout(resolve, 10)) // the worker/await gap
  doc[key] = value
  const tmp = `${path}.${crypto.randomUUID()}.tmp` // atomic, like saveWorld()
  await Deno.writeTextFile(tmp, JSON.stringify(doc))
  await Deno.rename(tmp, path)
}

Deno.test('withWorldLock: interleaved read-modify-write cycles keep both updates', async () => {
  await withTempFile(async (path) => {
    // Unlocked: the second cycle's stale snapshot overwrites the first's
    // change. This is the bug — asserted so the test below means something.
    await Deno.writeTextFile(path, JSON.stringify({ base: 'kept' }))
    await Promise.all([
      readModifyWrite(path, 'jobA', 'completed'),
      readModifyWrite(path, 'jobB', 'completed'),
    ])
    const unlocked = JSON.parse(await Deno.readTextFile(path)) as Doc
    assertEquals(Object.keys(unlocked).length, 2, 'unlocked: one update should be lost')

    // Locked on the same slug: the second cycle reads what the first wrote.
    await Deno.writeTextFile(path, JSON.stringify({ base: 'kept' }))
    await Promise.all([
      withWorldLock('default', () => readModifyWrite(path, 'jobA', 'completed')),
      withWorldLock('default', () => readModifyWrite(path, 'jobB', 'completed')),
    ])
    const locked = JSON.parse(await Deno.readTextFile(path)) as Doc
    assertEquals(locked, { base: 'kept', jobA: 'completed', jobB: 'completed' })
  })
})

Deno.test('withWorldLock: serializes same slug, not different slugs', async () => {
  const order: string[] = []
  const section = (name: string, ms: number) => async () => {
    order.push(`${name}:start`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(`${name}:end`)
  }

  await Promise.all([
    withWorldLock('same', section('first', 20)),
    withWorldLock('same', section('second', 0)),
    withWorldLock('other', section('other', 0)),
  ])

  // 'second' waits for 'first'; 'other' is a different world and does not.
  assertEquals(order.indexOf('first:end') < order.indexOf('second:start'), true)
  assertEquals(order.indexOf('other:start') < order.indexOf('first:end'), true)
})

Deno.test('withWorldLock: a failing section releases the lock and does not poison the queue', async () => {
  await assertRejects(
    () => withWorldLock('flaky', () => Promise.reject(new Error('save failed'))),
    Error,
    'save failed',
  )
  assertEquals(await withWorldLock('flaky', () => Promise.resolve('ran')), 'ran')
})

Deno.test('withWorldLock: releases its bookkeeping once a slug goes idle', async () => {
  await withWorldLock('transient', () => Promise.resolve())
  // One extra turn for the cleanup continuation to run.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertEquals(heldWorldLocks().includes('transient'), false)
})
