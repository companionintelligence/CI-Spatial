/**
 * PendingSaves, fourth pass (src/viewer/editor.ts): refused edits and world-link refusals.
 *
 * V4-3: an own edit that an earlier run already saw refused is not posted again by its own save.
 * A transient failure is still posted again by its own save; that double post is by design.
 *
 * V4-2: a 401 or 403 is still a permanent refusal for retries (isPermanentEditError is unchanged).
 * PendingSaves also names which refused edits the world link turned down, so the copy can say the
 * link cannot save them instead of calling the change refused.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v4-refused-saves.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PendingSaves,
  isPermanentEditError,
  isLinkRefusalError,
  type EditSaveState,
} from '../../../src/viewer/editor.ts'

function recorder() {
  const states: EditSaveState[] = []
  return { states, notify: (state: EditSaveState) => { states.push(state) } }
}

/** An error shaped like httpError() in viewer.ts: a message and the HTTP status. */
function httpFailure(status: number): Error {
  return Object.assign(new Error(String(status) + ' refused'), { status })
}

test('V4-3: an own edit an earlier run already saw refused is posted once, not again by its own save', async (t) => {
  t.mock.method(console, 'error', () => {})
  const rec = recorder()
  const saves = new PendingSaves(rec.notify)
  const calls: string[] = []

  // Both are queued before any run starts. The first run posts the other edit, then reaches the
  // edit for key k as a non-own entry, and the server refuses it. The run for k then finds it refused.
  const other = saves.save('semantic:other', async () => { calls.push('other') })
  const k = saves.save('semantic:k', async () => {
    calls.push('k')
    throw httpFailure(400)
  })

  assert.equal(await other, true)
  assert.equal(await k, false, 'its own edit was refused')
  assert.deepEqual(calls, ['other', 'k'], 'the refused edit is posted once')
  assert.equal(saves.refusedCount, 1)
  assert.equal(saves.pendingCount, 1, 'it stays unsaved')
  assert.deepEqual(rec.states, ['saving', 'saving', 'failed'])
})

test('V4-3: a transient failure of an own edit is still posted again by its own save, by design', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})
  const calls: string[] = []

  // The same queueing as above, but the first attempt at k drops in flight and the retry gets through.
  const other = saves.save('semantic:other', async () => { calls.push('other') })
  const k = saves.save('semantic:k', async () => {
    calls.push('k')
    if (calls.filter(call => call === 'k').length === 1) throw new Error('offline')
  })

  assert.equal(await other, true)
  assert.equal(await k, true, 'the retry posted its own edit')
  assert.deepEqual(calls, ['other', 'k', 'k'], 'a transient failure is posted again')
  assert.equal(saves.pendingCount, 0)
})

test('V4-2: a 401 or 403 is still refused for retries, and PendingSaves names it as a world-link refusal', async (t) => {
  t.mock.method(console, 'error', () => {})
  for (const status of [401, 403]) {
    const saves = new PendingSaves(() => {})
    const calls: string[] = []

    const refused = await saves.save('semantic:a', async () => {
      calls.push('a')
      throw httpFailure(status)
    })
    assert.equal(refused, false, 'its own save reports not saved')
    assert.equal(saves.refusedCount, 1, 'status ' + String(status) + ' is refused, as before')
    assert.equal(saves.linkRefusedCount, 1, 'status ' + String(status) + ' is named as a world-link refusal')

    await saves.save('semantic:b', async () => { calls.push('b') })
    assert.deepEqual(calls, ['a', 'b'], 'status ' + String(status) + ' is not sent again by a later save')
  }
})

test('V4-2: other refusals and transient failures are not named as a world-link refusal', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})

  await saves.save('semantic:a', async () => { throw httpFailure(400) })
  await saves.save('semantic:b', async () => { throw httpFailure(422) })
  await saves.save('semantic:c', async () => { throw new Error('offline') })
  await saves.save('semantic:d', async () => { throw httpFailure(503) })

  assert.equal(saves.refusedCount, 2)
  assert.equal(saves.linkRefusedCount, 0)
  assert.equal(saves.pendingCount, 4, 'all four stay unsaved')
})

test('V4-2: the world-link naming ends once the refused edit is saved again and accepted', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})

  await saves.save('semantic:a', async () => { throw httpFailure(401) })
  assert.equal(saves.linkRefusedCount, 1)

  assert.equal(await saves.save('semantic:a', async () => {}), true)
  assert.equal(saves.linkRefusedCount, 0)
  assert.equal(saves.refusedCount, 0)
  assert.equal(saves.pendingCount, 0)
})

test('V4-2: isLinkRefusalError is true for 401 and 403 only', () => {
  assert.equal(isLinkRefusalError(httpFailure(401)), true)
  assert.equal(isLinkRefusalError(httpFailure(403)), true)
  assert.equal(isLinkRefusalError(httpFailure(400)), false)
  assert.equal(isLinkRefusalError(httpFailure(404)), false)
  assert.equal(isLinkRefusalError(httpFailure(408)), false)
  assert.equal(isLinkRefusalError(httpFailure(429)), false)
  assert.equal(isLinkRefusalError(httpFailure(500)), false)
  assert.equal(isLinkRefusalError(new Error('offline')), false, 'a network failure has no status')
  assert.equal(isLinkRefusalError(null), false)
  assert.equal(isLinkRefusalError('401'), false)
})

test('V4-2: the retry treatment of 401 and 403 is unchanged (a product call, so only the copy moved)', () => {
  assert.equal(isPermanentEditError(httpFailure(401)), true)
  assert.equal(isPermanentEditError(httpFailure(403)), true)
})
