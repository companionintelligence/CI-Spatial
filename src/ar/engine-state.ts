/**
 * Whether the 8th Wall engine is part of this page, and how its load ended.
 *
 * Split from main.ts for the reason preflight.ts and tracking-quality.ts were: main() touches
 * the DOM when it loads, so node cannot import it, and a rule that lives only there is a rule no
 * test can run. This one decides what a person is told when no AR runtime can be made, and a wrong
 * answer sends them to fix something that is not broken.
 *
 * That is why there are four states and not three. A page that never loads the engine has not had
 * a load fail, so it must not be told one did. The desktop app is the case that went wrong: its
 * bundle leaves the engine out and index.html does not request it, so main.ts skipped the wait and
 * kept the state it started in, `failed`. The start screen then said "The AR engine did not load.
 * Reload the page. If it keeps failing, the server may be down." Reloading cannot add a file that
 * is not in the bundle, and no server is involved.
 */

/**
 * How the engine's load ended, as far as main.ts can tell.
 *
 *  - `ready`: XR8 is there.
 *  - `failed`: xr.js was requested and errored.
 *  - `timeout`: xr.js never arrived, or arrived and never set XR8, in time.
 *  - `absent`: this page never loads the engine (see engineExpected), so nothing was requested and
 *    nothing failed. No wait produces it. It is the state main.ts starts in, and a page that waits
 *    leaves it with the wait's answer.
 *
 * Only `failed` and `timeout` put the blame on the download. `absent` is not a fault to fix, so
 * the reason a page in it gives is the device's, not the network's.
 */
export type XR8Load = 'ready' | 'failed' | 'timeout' | 'absent'

/**
 * Whether this page loads the 8th Wall engine at all.
 *
 * It is the decision index.html makes before main() runs, when it chooses whether to request
 * xr.js: no request when the page is forced into WebXR (`?ar=webxr`), and none in the desktop app
 * (Tauri gives every page `__TAURI_INTERNALS__`, and the desktop bundle leaves the engine out).
 * tests/unit/node/desktop_engine_state.test.ts checks that the two still agree.
 *
 * `forcedMode` is the page's `ar` query value, and `desktopShell` is isDesktopShell().
 */
export function engineExpected(forcedMode: string | null, desktopShell: boolean): boolean {
  return forcedMode !== 'webxr' && !desktopShell
}
