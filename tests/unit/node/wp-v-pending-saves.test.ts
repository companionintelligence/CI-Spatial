/**
 * PendingSaves, second pass (src/viewer/editor.ts).
 *
 * The Place-epoch rule: a run takes its Place epoch when its save is queued, and a run from an
 * older Place reports nothing, so the Edit panel never shows Saved for a Place where the edit was
 * dropped. wp-d-pending-saves.test.ts (near line 112) pins the result for a Place switch in the
 * middle of a run: a single 'saving' state.
 *
 * Also covers the per-key result: save(key, edit) resolves on that key's own edit, not
 * on the whole run. A permanently refused edit (a 4xx other than 408 or 429) stays pending,
 * is not sent again by later saves, and goes out again only when its own key is saved again.
 * 408, 429 and server errors are retried like any other failure.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v-pending-saves.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSaves, isPermanentEditError, type EditSaveState } from '../../../src/viewer/editor.ts'

function recorder() {
  const states: EditSaveState[] = []
  return { states, notify: (state: EditSaveState) => { states.push(state) } }
}

/** An error shaped like httpError() in viewer.ts: a message and the HTTP status. */
function httpFailure(status: number): Error {
  return Object.assign(new Error(`${status} refused`), { status })
}

test('an edit cleared while a run is in flight is never posted, and the panel gets one Saving and nothing after', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  // Both are queued before the run starts. The first post is in flight when the Place is
  // replaced, so the second edit, which belongs to the old scene, must not post.
  const first = saves.save('semantic:a', async () => {
    calls.push('a')
    saves.clear()
  })
  const second = saves.save('semantic:b', async () => { calls.push('b') })

  assert.equal(await first, true)
  assert.equal(await second, false, 'its edit was dropped with its Place and never reached the server')
  assert.deepEqual(calls, ['a'])
  assert.equal(saves.pendingCount, 0)
  assert.deepEqual(rec.states, ['saving'], 'the stale run neither says Saving nor Saved')
})

test('a run queued before a Place switch reports nothing, even when it starts after the switch', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  // Queued in the Place being left. The switch lands before its run starts.
  const old = saves.save('semantic:old', async () => { calls.push('old') })
  saves.clear()
  // Queued in the new Place.
  const current = saves.save('semantic:new', async () => { calls.push('new') })

  assert.equal(await old, false, 'its edit was dropped with its Place and never reached the server')
  assert.equal(await current, true)
  assert.deepEqual(calls, ['new'], 'the edit from the old Place is never posted')
  assert.deepEqual(rec.states, ['saving', 'saved'], 'only the current run speaks to the panel')
})

test('the result of a save is about its own edit, not the whole run', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  // Both are queued before the first run starts, so that run posts the failing older edit
  // and then the newer one.
  const older = saves.save('semantic:old', async () => {
    calls.push('old')
    throw new Error('offline')
  })
  const own = saves.save('semantic:own', async () => { calls.push('own') })

  assert.equal(await older, false, 'its own edit failed')
  assert.equal(await own, true, 'its own edit posted, although an older edit in the same run failed')
  assert.deepEqual(calls, ['old', 'own', 'old'], 'the older edit is retried by the next run')
  assert.equal(saves.pendingCount, 1)
})

test('an edit the server refuses for good is not posted again by later saves', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  const refused = await saves.save('semantic:bad', async () => {
    calls.push('bad')
    throw httpFailure(400)
  })
  assert.equal(refused, false, 'its own save reports not saved')
  assert.equal(saves.pendingCount, 1, 'it still counts as unsaved, so a Place switch can warn about it')

  const other = await saves.save('semantic:ok', async () => { calls.push('ok') })

  assert.equal(other, true, 'a later save of another edit still succeeds')
  assert.deepEqual(calls, ['bad', 'ok'], 'the refused edit is not sent again')
  assert.equal(saves.pendingCount, 1)
  assert.deepEqual(rec.states, ['saving', 'failed', 'saving', 'failed'], 'the panel keeps saying Not saved')
})

test('saving a refused edit again sends it once more, and clears it when accepted', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  await saves.save('semantic:bad', async () => {
    calls.push('bad')
    throw httpFailure(422)
  })
  const again = await saves.save('semantic:bad', async () => { calls.push('bad again') })

  assert.equal(again, true)
  assert.deepEqual(calls, ['bad', 'bad again'])
  assert.equal(saves.pendingCount, 0)
  assert.deepEqual(rec.states, ['saving', 'failed', 'saving', 'saved'])
})

test('Save Tags does not send a refused edit, and does not claim Saved while it is unsaved', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  await saves.save('semantic:bad', async () => {
    calls.push('bad')
    throw httpFailure(403)
  })
  const flushed = await saves.save(null)

  assert.equal(flushed, false)
  assert.deepEqual(calls, ['bad'])
  assert.equal(saves.pendingCount, 1)
})

test('408, 429 and server errors are retried by every later save', async (t) => {
  t.mock.method(console, 'error', () => {})
  for (const status of [408, 429, 500, 503]) {
    const saves = new PendingSaves(() => {})
    const calls: string[] = []

    await saves.save('semantic:a', async () => {
      calls.push('a')
      throw httpFailure(status)
    })
    await saves.save('semantic:b', async () => { calls.push('b') })

    assert.deepEqual(calls, ['a', 'a', 'b'], `status ${status} is retried`)
    assert.equal(saves.pendingCount, 1)
  }
})

test('isPermanentEditError: a 4xx other than 408 and 429, and nothing without a status', () => {
  assert.equal(isPermanentEditError(httpFailure(400)), true)
  assert.equal(isPermanentEditError(httpFailure(401)), true)
  assert.equal(isPermanentEditError(httpFailure(404)), true)
  assert.equal(isPermanentEditError(httpFailure(422)), true)
  assert.equal(isPermanentEditError(httpFailure(408)), false, 'a timeout is worth sending again')
  assert.equal(isPermanentEditError(httpFailure(429)), false, 'rate limiting is worth sending again')
  assert.equal(isPermanentEditError(httpFailure(500)), false)
  assert.equal(isPermanentEditError(httpFailure(503)), false)
  assert.equal(isPermanentEditError(new Error('offline')), false, 'a network failure has no status')
  assert.equal(isPermanentEditError(null), false)
  assert.equal(isPermanentEditError('400'), false)
})
