/**
 * Run something once the page has loaded, whether or not it already has.
 *
 * `window.addEventListener('load', run, { once: true })` runs `run` only if the listener is
 * added before the `load` event fires. A page script that adds it after that point waits
 * forever: nothing ever fires `load` again, and nothing says so.
 *
 * That bit the service worker. `main()` in src/main.ts used to call `registerPWA()` before it
 * awaited anything, which is always before `load` (module scripts run first). The writer-role
 * check (`await acquireScannerRole(navigator)`, publish-readiness wave 9) now sits ahead of
 * it, so on a fast, warm load the continuation runs after `load`, the listener is added too
 * late, and no service worker registers at all. The offline upload queue then does not exist
 * for that page view: a scan exported offline is not queued and not retried. It happened on
 * about a quarter to a half of cold loads in the isolated browser suite
 * (tests/mock-offline-queue.spec.ts waited for a controller that never came).
 *
 * `document.readyState` is `'complete'` exactly when `load` has fired, so that is the check.
 * `'loading'` and `'interactive'` both still have the event ahead of them.
 *
 * Structural parameters, so a test can pass fakes and this file imports nothing.
 */
export interface LoadEventTarget {
  addEventListener(type: 'load', listener: () => void, options: { once: boolean }): void
}

export interface ReadyStateSource {
  readonly readyState: string
}

export function whenPageLoaded(win: LoadEventTarget, doc: ReadyStateSource, run: () => void): void {
  if (doc.readyState === 'complete') {
    run()
    return
  }
  win.addEventListener('load', run, { once: true })
}
