/**
 * PendingSaves: the Edit panel's save queue (src/viewer/editor.ts).
 *
 * Covers the rule behind the "Saving… / Saved / Not saved. Save again to retry." status line: an edit
 * that fails stays pending and is posted again by the next save, saves run one at a time,
 * and a Place switch (clear) stops anything still in flight from posting.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-d-pending-saves.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSaves, type EditSaveState } from '../../../src/viewer/editor.ts'

function recorder() {
  const states: EditSaveState[] = []
  return { states, notify: (state: EditSaveState) => { states.push(state) } }
}

test('a save that succeeds resolves true and leaves nothing pending', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  const saved = await saves.save('semantic:a', async () => { calls.push('a') })

  assert.equal(saved, true)
  assert.deepEqual(calls, ['a'])
  assert.equal(saves.pendingCount, 0)
  assert.deepEqual(rec.states, ['saving', 'saved'])
})

test('a failed save stays pending and reports Not saved', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)

  const saved = await saves.save('semantic:a', async () => { throw new Error('offline') })

  assert.equal(saved, false)
  assert.equal(saves.pendingCount, 1, 'the unsaved edit is kept in memory')
  assert.deepEqual(rec.states, ['saving', 'failed'])
})

test('the next save retries the pending edit before posting its own', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []
  let online = false

  await saves.save('semantic:a', async () => {
    calls.push('a')
    if (!online) throw new Error('offline')
  })
  online = true
  const saved = await saves.save('semantic:b', async () => { calls.push('b') })

  assert.equal(saved, true)
  assert.deepEqual(calls, ['a', 'a', 'b'])
  assert.equal(saves.pendingCount, 0)
  assert.deepEqual(rec.states, ['saving', 'failed', 'saving', 'saved'])
})

test('Save Tags with no edit retries whatever is still pending', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})
  const calls: string[] = []
  let online = false

  await saves.save('semantic:a', async () => {
    calls.push('a')
    if (!online) throw new Error('offline')
  })
  online = true
  const saved = await saves.save(null)

  assert.equal(saved, true)
  assert.deepEqual(calls, ['a', 'a'])
  assert.equal(saves.pendingCount, 0)
})

test('a newer save for the same edit replaces the older one', async () => {
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  const first = saves.save('semantic:a', async () => { calls.push('first') })
  const second = saves.save('semantic:a', async () => { calls.push('second') })

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.deepEqual(calls, ['second'], 'only the latest in-memory state is posted')
  assert.equal(saves.pendingCount, 0)
})

test('an edit cleared while a run is in flight is never posted', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  // Both are queued before the run starts. The first post is in flight when the Place
  // is replaced, so the second edit, which belongs to the old scene, must not post.
  const first = saves.save('semantic:a', async () => {
    calls.push('a')
    saves.clear()
  })
  const second = saves.save('semantic:b', async () => { calls.push('b') })

  assert.equal(await first, true)
  assert.equal(await second, false)
  assert.deepEqual(calls, ['a'])
  assert.equal(saves.pendingCount, 0)
  assert.deepEqual(rec.states, ['saving'])
})

test('a run that a Place switch overtakes reports nothing to the Edit panel', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)

  const saved = await saves.save('semantic:a', async () => { saves.clear() })

  assert.equal(saved, true)
  assert.deepEqual(rec.states, ['saving'], 'no Saved line for a Place that is gone')
})

test('saves run one at a time', async () => {
  const saves = new PendingSaves(() => {})
  let inFlight = 0
  let maxInFlight = 0
  const post = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    inFlight--
  }

  await Promise.all([saves.save('a', post), saves.save('b', post), saves.save(null)])

  assert.equal(maxInFlight, 1)
})
