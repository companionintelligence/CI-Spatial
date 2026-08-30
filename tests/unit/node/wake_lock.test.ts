/**
 * Screen wake lock.
 *
 * Regression: a gimbal-driven dome scan produced 0 keyframes across 10
 * converged positions because the phone locked partway through. Nothing in the
 * app kept the screen alive, so Chrome backgrounded and KeyframeStreamer
 * stopped — correctly, and invisibly.
 *
 * Run: npm run test:wake-lock
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScreenWakeLock } from '../../../src/capture/wake-lock.ts'

function fakeDoc(state: 'visible' | 'hidden' = 'visible') {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (t: string, l: () => void) => { (listeners[t] ??= []).push(l) },
    removeEventListener: (t: string, l: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((x) => x !== l)
    },
    fire: (t: string) => (listeners[t] ?? []).forEach((l) => l()),
    count: (t: string) => (listeners[t] ?? []).length,
  }
}

function fakeNav() {
  let granted = 0
  const made: Array<{ released: boolean; release: () => Promise<void>; addEventListener: (t: 'release', l: () => void) => void; fireRelease: () => void }> = []
  return {
    get granted() { return granted },
    made,
    wakeLock: {
      request: async () => {
        granted++
        let onRelease: (() => void) | null = null
        const s = {
          released: false,
          release: async () => { s.released = true; onRelease?.() },
          addEventListener: (_t: 'release', l: () => void) => { onRelease = l },
          fireRelease: () => { s.released = true; onRelease?.() },
        }
        made.push(s)
        return s
      },
    },
  }
}

test('start acquires a screen lock, stop releases it', async () => {
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  assert.equal(nav.granted, 1)
  assert.equal(wl.held, true)
  await wl.stop()
  assert.equal(wl.held, false)
  assert.equal(nav.made[0].released, true)
})

test('a browser-initiated release is noticed, not assumed away', async () => {
  // Android drops the lock when the tab hides or battery saver kicks in. If we
  // kept believing we held one, the reacquire below would no-op forever.
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  nav.made[0].fireRelease()
  assert.equal(wl.held, false)
})

test('returning to visible re-acquires — the case naive versions miss', async () => {
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  assert.equal(nav.granted, 1)
  nav.made[0].fireRelease()          // browser drops it on hide
  doc.visibilityState = 'visible'
  doc.fire('visibilitychange')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nav.granted, 2, 'must request a new lock when the page comes back')
})

test('while hidden it does not request', async () => {
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  doc.visibilityState = 'hidden'
  doc.fire('visibilitychange')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nav.granted, 1, 'no extra request while hidden')
})

test('stop unsubscribes, so a stopped scan never re-acquires', async () => {
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  assert.equal(doc.count('visibilitychange'), 1)
  await wl.stop()
  assert.equal(doc.count('visibilitychange'), 0)
  doc.fire('visibilitychange')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nav.granted, 1)
})

test('a browser with no wakeLock is not an error', async () => {
  // Safari < 16.4 and any non-secure context. A hand-held scan still works.
  const doc = fakeDoc()
  const wl = createScreenWakeLock({}, doc as never)
  await wl.start()
  assert.equal(wl.held, false)
  await wl.stop()
})

test('a rejected request degrades quietly', async () => {
  const doc = fakeDoc()
  const nav = { wakeLock: { request: async () => { throw new Error('denied') } } }
  const wl = createScreenWakeLock(nav as never, doc as never)
  await wl.start()
  assert.equal(wl.held, false)
})

test('start is idempotent — a second call does not stack locks', async () => {
  const nav = fakeNav(); const doc = fakeDoc()
  const wl = createScreenWakeLock(nav, doc as never)
  await wl.start()
  await wl.start()
  assert.equal(nav.granted, 1)
  assert.equal(doc.count('visibilitychange'), 1)
})
