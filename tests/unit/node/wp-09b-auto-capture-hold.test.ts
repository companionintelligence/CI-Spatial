/**
 * Auto-capture while recording is held (WP-09b, src/capture/auto-capture.ts).
 *
 * The re-anchor flow holds the scan while it asks what to do about a frame shift (src/ar/reanchor-flow.ts) and the
 * capture handler turns a capture away then. Auto-capture polls on its own, so without a way to be told it asked every
 * few seconds, was turned away each time, and counted each ask as a capture that was never taken ("N auto captures"),
 * rewriting the status line with the same refusal every time. `hold` is that way: a tick that is held asks for nothing
 * and counts nothing, and a page that gives none is never held, as before.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-auto-capture-hold.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoCapture } from '../../../src/capture/auto-capture.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'

const POLL_MS = 100

/** A provider that is tracking and can be walked along x. */
function walker() {
  let x = 0
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  } as unknown as ARProvider
  return { provider, walkTo: (next: number) => { x = next } }
}

/** Lets the async tick the interval started run to its end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('a tick that is held asks for no capture and counts none, however many there are', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { provider, walkTo } = walker()
  let asked = 0
  const auto = new AutoCapture(provider, async () => { asked++ }, { minIntervalMs: 0, pollIntervalMs: POLL_MS, hold: () => true })
  auto.enable()
  for (let i = 1; i <= 20; i++) {
    walkTo(i)
    t.mock.timers.tick(POLL_MS)
    await flush()
  }
  assert.equal(asked, 0, 'the capture handler was never asked')
  assert.equal(auto.captureCount, 0, 'so no capture was counted that was never taken')
  auto.disable()
})

test('when the hold is let go the next tick captures, and the count starts from what was taken', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { provider, walkTo } = walker()
  let held = true
  let asked = 0
  const auto = new AutoCapture(provider, async () => { asked++ }, { minIntervalMs: 0, pollIntervalMs: POLL_MS, hold: () => held })
  auto.enable()
  for (let i = 1; i <= 5; i++) {
    walkTo(i)
    t.mock.timers.tick(POLL_MS)
    await flush()
  }
  assert.equal(auto.captureCount, 0)
  held = false
  walkTo(10)
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(asked, 1)
  assert.equal(auto.captureCount, 1)
  auto.disable()
})

test('a page that gives no hold is never held: the first tick captures, as it always did', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { provider } = walker()
  let asked = 0
  const auto = new AutoCapture(provider, async () => { asked++ }, { minIntervalMs: 0, pollIntervalMs: POLL_MS })
  auto.enable()
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(asked, 1)
  assert.equal(auto.captureCount, 1)
  auto.disable()
})

test('the hold is read at each tick, so it can come and go while auto-capture stays on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { provider, walkTo } = walker()
  const reads: boolean[] = []
  let held = false
  const auto = new AutoCapture(provider, async () => {}, {
    minIntervalMs: 0,
    pollIntervalMs: POLL_MS,
    hold: () => {
      reads.push(held)
      return held
    },
  })
  auto.enable()
  t.mock.timers.tick(POLL_MS)
  await flush()
  held = true
  walkTo(5)
  t.mock.timers.tick(POLL_MS)
  await flush()
  held = false
  walkTo(10)
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.deepEqual(reads, [false, true, false])
  assert.equal(auto.captureCount, 2, 'the held tick between the two was not one')
  assert.equal(auto.enabled, true)
  auto.disable()
})
