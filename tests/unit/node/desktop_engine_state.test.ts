/**
 * The 8th Wall engine's load state, on the pages that never load the engine (merge-review fix,
 * package desktop-engine).
 *
 * The desktop app ships without the engine on purpose: index.html does not request xr.js there,
 * and the desktop bundle leaves it out. Two lines of work met in main.ts. One skipped the wait for
 * the engine on the desktop. The other made the wait a three-state result (`ready`, `failed`,
 * `timeout`) and wrote its reasons around it. The merge kept the skip and left the state it
 * started in, `failed`, so a desktop user who opened Scan a Place was told "The AR engine did not
 * load. Reload the page. If it keeps failing, the server may be down." That text reaches the
 * Start button, the #ar-help line and, through arRuntimeError, the permission banner. Reloading
 * cannot add a file that is not in the bundle, and no server is involved.
 *
 * main() touches the DOM when it loads, so node cannot import it. Two things follow:
 *  - "is the engine part of this page at all" is a pure function, src/ar/engine-state.ts, tested
 *    directly;
 *  - the wait block and the reason ladder are main.ts's own text, run here against stand-ins for
 *    the few things they touch (the overlay, the wait, the shell check), as wp-v4-save-copy runs
 *    viewer.ts's own functions. The copy stays in main.ts, where wp-c1-scanner-wiring,
 *    wp-c1-copy-and-recommendations, wp-main4-scanner-copy-and-erase and wp-b-scanner-flow pin
 *    it. This file pins which page gets which line.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/desktop_engine_state.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineExpected } from '../../../src/ar/engine-state.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const main = read('src/main.ts')

/** The honest line for a device with no AR runtime: nothing to reload, nothing to blame. */
const DEVICE_LINE = 'AR not available on this device'
/** The line for a page the person forced into WebXR, which is not available there. */
const WEBXR_LINE = 'WebXR is not available here'
/** Anything that tells a person the download is to blame, or sends them to reload. */
const ENGINE_BLAME = /did not load|Reload|server may be down/i

type Waited = 'ready' | 'failed' | 'timeout'
const WAITS: Waited[] = ['ready', 'failed', 'timeout']

interface Mode { name: string, forcedMode: string | null, desktopShell: boolean }
const PAGE: Mode = { name: 'a phone or browser page', forcedMode: null, desktopShell: false }
const DESKTOP: Mode = { name: 'the desktop app', forcedMode: null, desktopShell: true }
const FORCED_WEBXR: Mode = { name: 'a page forced into WebXR (?ar=webxr)', forcedMode: 'webxr', desktopShell: false }
const DESKTOP_FORCED_WEBXR: Mode = { name: 'the desktop app forced into WebXR', forcedMode: 'webxr', desktopShell: true }
const NO_ENGINE = [DESKTOP, FORCED_WEBXR, DESKTOP_FORCED_WEBXR]

/** The text of `source` from `from` up to, not including, `to`. Both must be there, in that order. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `main.ts has: ${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `main.ts has, after it: ${to}`)
  return source.slice(start, end)
}

/** A top-level function of `source`, from its `function` line to the closing brace at column 0. */
function topLevelFunction(source: string, name: string): string {
  const from = source.indexOf(`\nfunction ${name}(`)
  assert.notEqual(from, -1, `main.ts declares ${name}`)
  const to = source.indexOf('\n}\n', from)
  assert.notEqual(to, -1, `main.ts ends ${name}`)
  return source.slice(from + 1, to + 3)
}

const WAIT_END = "const xr8Available = xr8Load === 'ready'"
/** main() section 3: the engine-load state and whether to wait for the engine. */
const WAIT_BLOCK = between(main, 'let xr8Load: XR8Load', WAIT_END) + WAIT_END
/** main() section 3: the line written when no AR runtime could be made. */
const LADDER = between(main, 'const reason = forcedMode', 'overlay.setStatus(reason)')

interface BootResult {
  xr8Load: string
  xr8Available: boolean
  /** The line the ladder writes. Null when the engine is used, because the ladder is not reached then. */
  reason: string | null
  /** The statuses written to the overlay by the wait block. */
  statuses: string[]
  /** One entry per wait that was started. */
  waits: number[]
}

type BootBody = (...values: unknown[]) => Promise<{ xr8Load: string, xr8Available: boolean, reason: string }>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...names: string[]) => BootBody

/**
 * Runs main.ts's wait block and its reason ladder as main() would on `mode`, where the wait, if it
 * is started, ends in `waited`. The block and the ladder are main.ts's own text. `engineExpected`
 * is the real function the block imports, and the rest are stand-ins.
 */
async function boot(mode: Mode, waited: Waited): Promise<BootResult> {
  const statuses: string[] = []
  const waits: number[] = []
  const run = new AsyncFunction(
    'forcedMode', 'isDesktopShell', 'engineExpected', 'overlay', 'waitForXR8', 'XR8_LOAD_TIMEOUT_MS',
    stripTypeScriptTypes(`${WAIT_BLOCK}\n${LADDER}`) + '\nreturn { xr8Load, xr8Available, reason }',
  )
  const out = await run(
    mode.forcedMode,
    () => mode.desktopShell,
    engineExpected,
    { setStatus: (text: string) => { statuses.push(text) } },
    async (timeoutMs: number) => { waits.push(timeoutMs); return waited },
    90_000,
  )
  return { ...out, reason: out.xr8Available ? null : out.reason, statuses, waits }
}

interface StartScreen {
  /** The label each showArHelp call gave the Start button. */
  startLabels: Array<string | undefined>
  /** What #ar-help holds afterwards, and whether it is shown. */
  helpText: string
  helpShown: boolean
  /** What went to the permission banner, which showArHelp falls back to when #ar-help is gone. */
  banners: string[]
}

/**
 * main.ts's own showArHelp(), run for `reason` on a device with `userAgent` and page `origin`, on a
 * start screen that has #ar-help. The Start button's state, the banner and the DOM are stand-ins.
 */
function showArHelp(reason: string, userAgent: string, origin: string, desktopShell = false): StartScreen {
  const help = { textContent: '', innerHTML: '', hidden: true }
  const screen: StartScreen = { startLabels: [], helpText: '', helpShown: false, banners: [] }
  const run = new Function(
    'reason', 'setStartButtonState', 'navigator', 'location', 'document', 'showPermissionBanner', 'isDesktopShell',
    stripTypeScriptTypes(`${topLevelFunction(main, 'showArHelp')}\nshowArHelp(reason)`),
  )
  run(
    reason,
    (_state: string, label?: string) => { screen.startLabels.push(label) },
    { userAgent },
    { origin },
    { getElementById: (id: string) => (id === 'ar-help' ? help : null) },
    (message: string) => { screen.banners.push(message) },
    () => desktopShell,
  )
  return { ...screen, helpText: help.textContent || help.innerHTML, helpShown: !help.hidden }
}

/** User agent and origin of the desktop app's webview on macOS, Linux and Windows. None names a phone. */
const DESKTOP_WEBVIEWS: Array<[userAgent: string, origin: string]> = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', 'tauri://localhost'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'tauri://localhost'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'http://tauri.localhost'],
]

/** The members of `type XR8Load` as src/ar/engine-state.ts declares them. */
function declaredStates(): string[] {
  const declaration = read('src/ar/engine-state.ts').match(/export type XR8Load = ([^\n]+)/)
  assert.ok(declaration, 'src/ar/engine-state.ts declares XR8Load on one line')
  return [...declaration[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
}

// ── The rule: is the engine part of this page at all ─────────────────────────────────────────

test('engineExpected: a page loads the engine unless it is forced into WebXR or is the desktop app', () => {
  assert.equal(engineExpected(null, false), true, 'a phone or browser page')
  assert.equal(engineExpected('8thwall', false), true, '?ar=8thwall forces the engine, it never skips it')
  assert.equal(engineExpected('webxr', false), false, '?ar=webxr')
  assert.equal(engineExpected(null, true), false, 'the desktop app')
  assert.equal(engineExpected('webxr', true), false, 'the desktop app forced into WebXR')
  assert.equal(engineExpected('8thwall', true), false, 'the desktop bundle has no engine for ?ar=8thwall to force')
})

test('the states are ready, failed, timeout and absent, so a fifth is a decision made here', () => {
  assert.deepEqual(declaredStates().sort(), ['absent', 'failed', 'ready', 'timeout'])
})

// ── The state main() ends up in, and the line it writes ──────────────────────────────────────

test('a page that loads the engine: it says so, waits once, and a ready engine is used', async () => {
  const ready = await boot(PAGE, 'ready')
  assert.deepEqual([ready.xr8Load, ready.xr8Available, ready.waits.length], ['ready', true, 1])
  assert.deepEqual(ready.statuses, ['Loading AR engine…'], 'the page says it is loading the engine')
  assert.equal(ready.reason, null, 'a ready engine is used, so there is no reason to give')
})

test('a page that loads the engine: a timeout says it did not load in time, with the reload hint', async () => {
  const run = await boot(PAGE, 'timeout')
  assert.deepEqual([run.xr8Load, run.xr8Available], ['timeout', false])
  assert.match(run.reason ?? '', /^The AR engine did not load in time\n• Reload the page to try again$/)
})

test('a page that loads the engine: a failed load says it did not load, with the reload hint', async () => {
  const run = await boot(PAGE, 'failed')
  assert.deepEqual([run.xr8Load, run.xr8Available], ['failed', false])
  assert.match(run.reason ?? '', /^The AR engine did not load\n• Reload the page\. If it keeps failing, the server may be down$/)
})

test('the desktop app: the engine is absent by design, so nothing is waited for and the line is the device line', async () => {
  for (const waited of WAITS) {
    const run = await boot(DESKTOP, waited)
    assert.equal(run.waits.length, 0, `a wait that would say ${waited} is never started`)
    assert.equal(run.xr8Load, 'absent', `a wait that would say ${waited} does not decide the state`)
    assert.equal(run.xr8Available, false)
    assert.equal(run.reason, DEVICE_LINE)
  }
})

test('a page forced into WebXR, in a browser or in the desktop app: absent, never waited for, and the WebXR line', async () => {
  for (const mode of [FORCED_WEBXR, DESKTOP_FORCED_WEBXR]) {
    for (const waited of WAITS) {
      const run = await boot(mode, waited)
      assert.equal(run.waits.length, 0, `${mode.name}: a wait that would say ${waited} is never started`)
      assert.equal(run.xr8Load, 'absent', `${mode.name}: the engine was never expected, so it did not fail`)
      assert.equal(run.reason, WEBXR_LINE, `${mode.name}: the page was forced to WebXR, so that is what is missing`)
    }
  }
})

test('a page that never loads the engine is never told the engine did not load, and is not sent to reload', async () => {
  for (const mode of NO_ENGINE) {
    for (const waited of WAITS) {
      const run = await boot(mode, waited)
      assert.deepEqual(run.statuses, [], `${mode.name}: no "Loading AR engine…" for an engine nobody requested`)
      const reason = run.reason ?? ''
      assert.doesNotMatch(reason, ENGINE_BLAME, `${mode.name}: the line blames nothing that can be reloaded or restarted`)
      assert.ok(!reason.includes('\n'), `${mode.name}: one line, so showArHelp has no next step to print into #ar-help`)
    }
  }
})

test('the desktop app: the start screen is given the device line, with no reload hint and no server to blame', async () => {
  const { reason } = await boot(DESKTOP, 'failed')
  for (const [userAgent, origin] of DESKTOP_WEBVIEWS) {
    const screen = showArHelp(reason ?? '', userAgent, origin, true)
    assert.deepEqual(screen.startLabels, [DEVICE_LINE], `${origin}: the Start button is labelled with the headline`)
    assert.ok(screen.helpShown, `${origin}: #ar-help is shown`)
    assert.doesNotMatch(screen.helpText, ENGINE_BLAME, `${origin}: #ar-help does not send the person to reload or blame the server`)
    // The webview's own origin (tauri://localhost, http://tauri.localhost) is no address a phone can open, so the
    // line must not offer it as one; the app never captures, and the line says so.
    assert.equal(screen.helpText, 'The desktop app cannot capture. Scan on a phone.', `${origin}: the line says what the app is for`)
    assert.doesNotMatch(screen.helpText, /tauri|localhost|open this on a phone/i, `${origin}: the webview's origin is not offered to a phone`)
    assert.deepEqual(screen.banners, [], `${origin}: #ar-help is there, so the permission banner is not the fallback`)
  }
})

test('control: a failed download on a phone page does put the reload hint in #ar-help, so the check above can see the symptom', async () => {
  const { reason } = await boot(PAGE, 'failed')
  const screen = showArHelp(reason ?? '', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', 'https://scan.example.ts.net')
  assert.deepEqual(screen.startLabels, ['The AR engine did not load'])
  assert.equal(screen.helpText, 'Reload the page. If it keeps failing, the server may be down')
})

test('every state is written for on purpose: only failed and timeout blame the download, and only on a page that loads it', async () => {
  const seen = new Set<string>()
  for (const mode of [PAGE, ...NO_ENGINE]) {
    for (const waited of WAITS) {
      const run = await boot(mode, waited)
      seen.add(run.xr8Load)
      const blamesDownload = ENGINE_BLAME.test(run.reason ?? '')
      const mayBlame = engineExpected(mode.forcedMode, mode.desktopShell) && (run.xr8Load === 'failed' || run.xr8Load === 'timeout')
      assert.equal(blamesDownload, mayBlame, `${mode.name}, wait says ${waited}, state ${run.xr8Load}`)
    }
  }
  assert.deepEqual([...seen].sort(), declaredStates().sort(), 'every declared state is reached by some page')
})

// ── Source shape: what these tests lean on, so a refactor cannot leave them checking a copy ───

test('source shape: main.ts starts from absent and asks engineExpected before it waits', () => {
  assert.match(main, /import \{[^}]*\bengineExpected\b[^}]*\} from '\.\/ar\/engine-state/, 'main.ts imports the rule')
  assert.match(main, /import \{[^}]*\btype XR8Load\b[^}]*\} from '\.\/ar\/engine-state/, 'main.ts imports the states')
  assert.doesNotMatch(main, /^type XR8Load = /m, 'the states are declared once, in src/ar/engine-state.ts')
  assert.doesNotMatch(main, /let xr8Load: XR8Load = 'failed'/, 'a page that never waited is not a page whose engine failed')
  assert.match(
    WAIT_BLOCK,
    /^let xr8Load: XR8Load = 'absent'\n\s+if \(engineExpected\(forcedMode, isDesktopShell\(\)\)\) \{\n\s+overlay\.setStatus\('Loading AR engine…'\)\n\s+xr8Load = await waitForXR8\(XR8_LOAD_TIMEOUT_MS\)\n\s+\}\n\s+const xr8Available = xr8Load === 'ready'$/,
    'the only way out of absent is a wait, and the wait is started only where the engine is expected',
  )
})

test('source shape: waiting ends ready, failed or timeout, and never absent', () => {
  const produced = new Set([...topLevelFunction(main, 'waitForXR8').matchAll(/(?:settle|resolve)\('([a-z]+)'\)/g)].map((m) => m[1]))
  assert.deepEqual([...produced].sort(), ['failed', 'ready', 'timeout'], 'absent is for a page that does not wait')
})

test('source shape: one reason feeds the overlay, the start screen and the Start gate', () => {
  const written = between(main, 'const reason = forcedMode', "console.error('[main] No AR runtime available:'")
  assert.match(
    written,
    /overlay\.setStatus\(reason\)[\s\S]*showArHelp\(reason\)[\s\S]*arRuntimeError = reason/,
    'the Start button and #ar-help (showArHelp), the overlay, and the permission banner (arRuntimeError) all read the one ladder',
  )
})

test('source shape: engineExpected is the decision index.html makes when it requests xr.js', () => {
  assert.match(
    read('index.html'),
    /\} else if \(params\.get\('ar'\) !== 'webxr' && !\('__TAURI_INTERNALS__' in window\)\) \{\n\s+const xrScript = document\.createElement\('script'\)/,
    'index.html requests xr.js unless the page is forced into WebXR or is the desktop app: change engineExpected with it',
  )
})
