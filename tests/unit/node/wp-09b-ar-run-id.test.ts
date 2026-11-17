/**
 * `<arRunId>.<epoch>` (WP-09b, src/shared/ar-run-id.ts): the id of a run as of one frame epoch.
 *
 * WP-02 reserved the dot. A scan that is begun again after the runtime redefined its origin is a new frame inside the
 * same run, and what it stores is stamped with the run and the epoch it began in. The first epoch of a run carries no
 * suffix, an epoch is replaced and never added to, and an id from before epochs were appended splits as itself.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-ar-run-id.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { arRunIdAtEpoch, newArRunId, splitArRunId } from '../../../src/shared/ar-run-id.ts'

test('an epoch is appended with a dot, and the first epoch of a run has no suffix', () => {
  assert.equal(arRunIdAtEpoch('run-a', 1), 'run-a.1')
  assert.equal(arRunIdAtEpoch('run-a', 12), 'run-a.12')
  assert.equal(arRunIdAtEpoch('run-a', 0), 'run-a', 'epoch 0 is the run itself')
})

test('an id that already has an epoch has it replaced, never a second one added', () => {
  assert.equal(arRunIdAtEpoch('run-a.1', 3), 'run-a.3')
  assert.equal(arRunIdAtEpoch('run-a.3', 0), 'run-a', 'back to the run itself')
  assert.equal(arRunIdAtEpoch(arRunIdAtEpoch('run-a', 1), 2), 'run-a.2')
  assert.equal(arRunIdAtEpoch('run-a', 1).split('.').length, 2)
})

test('an epoch that is not a whole number of at least 1 is no epoch, and the id comes back as the run', () => {
  for (const epoch of [-1, 0.5, Number.NaN, Infinity, 1.5]) {
    assert.equal(arRunIdAtEpoch('run-a', epoch), 'run-a', String(epoch))
  }
  assert.equal(arRunIdAtEpoch('run-a.2', Number.NaN), 'run-a', 'a bad epoch drops the old one rather than keeping a stale one')
})

test('an id is taken apart into the run and the epoch its suffix names', () => {
  assert.deepEqual(splitArRunId('run-a'), { run: 'run-a', epoch: null })
  assert.deepEqual(splitArRunId('run-a.4'), { run: 'run-a', epoch: 4 })
  assert.deepEqual(splitArRunId('run-a.120'), { run: 'run-a', epoch: 120 })
})

test('a suffix that is not an epoch splits as no epoch, and the run is still what is before the first dot', () => {
  for (const id of ['run-a.0', 'run-a.x', 'run-a.01', 'run-a.', 'run-a.1.2', 'run-a.-1', 'run-a.1e3', `run-a.${'9'.repeat(30)}`]) {
    assert.deepEqual(splitArRunId(id), { run: 'run-a', epoch: null }, id)
  }
})

test('the ids this app makes never contain a dot, so the first one is always the separator', () => {
  for (let i = 0; i < 200; i++) assert.equal(newArRunId().includes('.'), false)
  // The fallback shape an old webview gets (no randomUUID) has none either.
  for (let i = 0; i < 50; i++) assert.equal(newArRunId({ getRandomValues: undefined }).includes('.'), false)
})

test('a made id survives the round trip through an epoch', () => {
  const id = newArRunId()
  assert.deepEqual(splitArRunId(arRunIdAtEpoch(id, 7)), { run: id, epoch: 7 })
  assert.equal(arRunIdAtEpoch(arRunIdAtEpoch(id, 7), 0), id)
})
