/**
 * PendingSaves answers for the edit each save queued (src/viewer/editor.ts), third pass.
 *
 * A save resolves true only when the edit it queued reached the server. A save whose edit a
 * newer save for the same key replaced before its run got to it resolves with that newer save,
 * because the newer edit is the one that posts. A save whose Place was left resolves false.
 * refusedCount tells the Edit panel how many unsaved edits Save Tags will not send again.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v3-pending-saves.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSaves, type EditSaveState } from '../../../src/viewer/editor.ts'

function recorder() {
  const states: EditSaveState[] = []
  return { states, notify: (state: EditSaveState) => { states.push(state) } }
}

/** An error shaped like httpError() in viewer.ts: a message and the HTTP status. */
function httpFailure(status: number): Error {
  return Object.assign(new Error(String(status) + ' refused'), { status })
}

test('a save replaced before its run answers true when the newer edit posts', async () => {
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  const first = saves.save('semantic:a', async () => { calls.push('first') })
  const second = saves.save('semantic:a', async () => { calls.push('second') })

  assert.equal(await first, true, 'its edit is the newer one, which reached the server')
  assert.equal(await second, true)
  assert.deepEqual(calls, ['second'], 'only the latest in-memory state is posted')
  assert.equal(saves.pendingCount, 0)
})

test('a save replaced before its run answers false when the newer edit fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  const first = saves.save('semantic:a', async () => { calls.push('first') })
  const second = saves.save('semantic:a', async () => {
    calls.push('second')
    throw new Error('offline')
  })

  assert.equal(await first, false, 'the edit that posted did not reach the server')
  assert.equal(await second, false)
  assert.equal(saves.pendingCount, 1, 'still unsaved, so the next save retries it')
  assert.deepEqual(calls, ['second', 'second'], 'the run that reached the newer edit posts it, and the newer run posts it again')
})

test('a save replaced before its run answers false when the newer edit is refused for good', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})

  const first = saves.save('semantic:a', async () => { throw httpFailure(403) })
  const second = saves.save('semantic:a', async () => { throw httpFailure(403) })

  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal(saves.refusedCount, 1, 'the refused edit is counted once, under its key')
})

test('a save whose Place is left before its run starts answers false, and a newer save for the same key does too', async () => {
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  const first = saves.save('semantic:a', async () => { calls.push('first') })
  const second = saves.save('semantic:a', async () => { calls.push('second') })
  saves.clear()

  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.deepEqual(calls, [], 'nothing from the Place that was left is posted')
})

test('a Save Tags run that a Place switch overtakes answers false and says nothing', async () => {
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)

  const flushed = saves.save(null)
  saves.clear()

  assert.equal(await flushed, false, 'nothing it was asked to send reached the server')
  assert.deepEqual(rec.states, [], 'no Saving or Saved line for a Place that is gone')
})

test('refusedCount counts the refused edits, and a refused edit is cleared once its own key is accepted', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})
  let online = false
  const calls: string[] = []

  await saves.save('semantic:bad', async () => {
    calls.push('bad')
    throw httpFailure(403)
  })
  await saves.save('semantic:transient', async () => {
    calls.push('transient')
    if (!online) throw new Error('offline')
  })
  assert.equal(saves.refusedCount, 1)
  assert.equal(saves.pendingCount, 2)

  // Save Tags retries the transient edit, never the refused one.
  online = true
  const flushed = await saves.save(null)
  assert.equal(flushed, false, 'the refused edit is still unsaved, so Save Tags does not claim Saved')
  assert.deepEqual(calls, ['bad', 'transient', 'transient'], 'the refused edit is not sent again')
  assert.equal(saves.refusedCount, 1, 'the refused edit stays unsaved')

  // Saving that object again sends the refused edit once more, and clears it when accepted.
  const again = await saves.save('semantic:bad', async () => { calls.push('bad again') })
  assert.equal(again, true)
  assert.equal(saves.refusedCount, 0)
  assert.equal(saves.pendingCount, 0)
})

test('Save Tags answers false while an edit the server refused is still unsaved', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})

  await saves.save('semantic:bad', async () => { throw httpFailure(422) })
  const flushed = await saves.save(null)

  assert.equal(flushed, false)
  assert.equal(saves.refusedCount, 1)
})
