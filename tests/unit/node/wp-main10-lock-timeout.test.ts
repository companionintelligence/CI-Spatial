/**
 * The scanner role's bounded wait (publish-readiness wave 10, package MAIN10, item MAIN10-7).
 *
 * The lock request normally answers at once. A request that never answers must not leave main()
 * waiting, so the acquisition gives up after SCANNER_ROLE_TIMEOUT_MS, logs one warning and takes the
 * writer role. These run against stub lock managers, the same way wp-main9-scanner-lock.test.ts does.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main10-lock-timeout.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SCANNER_ROLE_TIMEOUT_MS, acquireScannerRole } from '../../../src/shared/scanner-lock.ts'
import type { LockManagerLike } from '../../../src/shared/scanner-lock.ts'

/** A lock manager that never calls back and never settles: the case the bound exists for. */
function silentLocks(): LockManagerLike {
  return {
    request() {
      return new Promise<unknown>(() => {})
    },
  }
}

/** Let every pending promise callback run, without advancing any timer. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('MAIN10-7: the bound is three seconds', () => {
  assert.equal(SCANNER_ROLE_TIMEOUT_MS, 3000)
})

test('MAIN10-7: a lock manager that never answers resolves writer at the bound, and warns once', { timeout: 5000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let outcome: string | null = null
  void acquireScannerRole({ locks: silentLocks() }).then((role) => {
    outcome = role
  })

  t.mock.timers.tick(SCANNER_ROLE_TIMEOUT_MS - 1)
  await flushPromises()
  assert.equal(outcome, null, 'still waiting one millisecond before the bound')
  assert.equal(warn.mock.callCount(), 0, 'no warning before the bound')

  t.mock.timers.tick(1)
  await flushPromises()
  assert.equal(outcome, 'writer', 'the page takes the writer role at the bound')
  assert.equal(warn.mock.callCount(), 1, 'exactly one console warning')
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /scanner-lock/, 'the warning names the lock')
})

test('MAIN10-7: a short bound is a parameter, so the timeout path runs without waiting three seconds', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  assert.equal(await acquireScannerRole({ locks: silentLocks() }, 5), 'writer')
  assert.equal(warn.mock.callCount(), 1, 'one warning for the one timeout')
})

test('MAIN10-7: an answer inside the bound is taken as it is, and the timer is cleared, so nothing warns later', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const granted: LockManagerLike = {
    request(_name, _options, callback) {
      return Promise.resolve().then(() => callback({ name: 'companion-scanner-writer' }))
    },
  }
  const busy: LockManagerLike = {
    request(_name, _options, callback) {
      return Promise.resolve().then(() => callback(null))
    },
  }
  assert.equal(await acquireScannerRole({ locks: granted }), 'writer')
  assert.equal(await acquireScannerRole({ locks: busy }), 'readOnly')
  t.mock.timers.tick(SCANNER_ROLE_TIMEOUT_MS * 2)
  await flushPromises()
  assert.equal(warn.mock.callCount(), 0, 'the bound never fires once the lock manager has answered')
})

test('MAIN10-7: a late answer after the bound changes nothing and does not warn a second time', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const answers: Array<(lock: unknown) => unknown> = []
  const late: LockManagerLike = {
    request(_name, _options, callback) {
      answers.push(callback)
      return new Promise<unknown>(() => {})
    },
  }
  assert.equal(await acquireScannerRole({ locks: late }, 5), 'writer')
  assert.equal(warn.mock.callCount(), 1)
  // The browser answers after all, with the lock free. The role is already settled, so it stays writer.
  const held = answers[0]?.({ name: 'companion-scanner-writer' })
  assert.ok(held instanceof Promise, 'the late callback still holds the lock, as a writer does')
  assert.equal(warn.mock.callCount(), 1, 'the late answer does not warn again')
})
