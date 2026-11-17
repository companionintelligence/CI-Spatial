/**
 * A page script must be able to ask for "when the page has loaded" without caring whether it
 * already has (src/shared/page-load.ts).
 *
 * The bug this pins: src/pwa.ts registered the service worker inside a one-shot `load` listener.
 * main() reaches registerPWA() only after `await acquireScannerRole(navigator)`, so on a fast load
 * the listener was added after `load` had fired and never ran. No service worker registered, and
 * the offline upload queue did not exist for that page view. The browser proof is
 * tests/mock-offline-queue.spec.ts (it waits for navigator.serviceWorker.controller, and without
 * this fix it hung in a quarter to a half of cold loads).
 *
 * src/pwa.ts itself cannot be imported under node (it reads import.meta.env), so its use of the
 * helper is checked as source, the way the other wp-main tests check it.
 *
 * Run: npm run test:page-load
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { whenPageLoaded, type LoadEventTarget } from '../../../src/shared/page-load.ts'

/** A window that records its 'load' listeners, and fires them on demand. */
function fakeWindow() {
  const added: Array<{ listener: () => void; once: boolean }> = []
  const win: LoadEventTarget = {
    addEventListener(type, listener, options) {
      assert.equal(type, 'load')
      added.push({ listener, once: options.once })
    },
  }
  return { win, added, fire: () => { for (const { listener } of added.splice(0)) listener() } }
}

test('a page that has already loaded runs the callback at once, and adds no listener that could never fire', () => {
  const { win, added } = fakeWindow()
  let runs = 0
  whenPageLoaded(win, { readyState: 'complete' }, () => { runs++ })
  assert.equal(runs, 1, 'run now')
  assert.equal(added.length, 0, 'nothing is left waiting for an event that already happened')
})

test('a page that is still loading waits for the load event, once, and runs the callback exactly once', () => {
  for (const readyState of ['loading', 'interactive']) {
    const { win, added, fire } = fakeWindow()
    let runs = 0
    whenPageLoaded(win, { readyState }, () => { runs++ })
    assert.equal(runs, 0, `${readyState}: not yet`)
    assert.equal(added.length, 1, `${readyState}: one listener`)
    assert.equal(added[0]!.once, true, `${readyState}: removed after it fires`)
    fire()
    assert.equal(runs, 1, `${readyState}: runs on load`)
  }
})

test('the hazard the helper exists for: a listener added after load never runs, a call through the helper does', () => {
  // The old code, on a page whose load event has already fired.
  const lateListener = fakeWindow()
  let bareRuns = 0
  lateListener.win.addEventListener('load', () => { bareRuns++ }, { once: true })
  // `load` has fired already, so nothing fires it again: the listener sits there forever.
  assert.equal(bareRuns, 0, 'a bare listener added after load waits for an event that is not coming')

  const throughHelper = fakeWindow()
  let helperRuns = 0
  whenPageLoaded(throughHelper.win, { readyState: 'complete' }, () => { helperRuns++ })
  assert.equal(helperRuns, 1, 'the helper does not wait for what already happened')
})

test('source shape: the service worker is registered through the helper, not a bare load listener', () => {
  const pwa = readFileSync(new URL('../../../src/pwa.ts', import.meta.url), 'utf8')
  assert.match(pwa, /import \{ whenPageLoaded \} from '\.\/shared\/page-load'/)
  assert.match(pwa, /whenPageLoaded\(window, document, \(\) => \{\s*navigator\.serviceWorker\.register\('\/sw\.js'/)
  assert.doesNotMatch(pwa, /addEventListener\('load'/, 'a bare load listener is the bug')
})

test('source shape: the scanner still awaits before it registers, which is why the helper is needed', () => {
  // If the await moved after registerPWA() this file's reason would be gone, and so would the need to
  // re-read it: the test says so out loud instead of letting the comment in page-load.ts go stale.
  const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8')
  const awaited = main.indexOf('await acquireScannerRole(navigator)')
  const registered = main.indexOf('registerPWA({ flushQueue: !readOnlyScanner })')
  assert.ok(awaited > 0 && registered > 0, 'both calls are in main.ts')
  assert.ok(awaited < registered, 'the writer-role await comes before registerPWA(): registration can run after load')
})
