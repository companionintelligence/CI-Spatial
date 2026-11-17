/**
 * Scanner wiring for publish-readiness fix wave 2, package C1 (checked against source).
 *
 * main.ts, panel.ts and history.ts touch the DOM when they load, so these read the
 * source for the rules a regression would break. Each test names the review item it
 * guards. The router's probe is covered by behaviour in wp-c-router-webgpu.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c1-scanner-wiring.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('C1-1: the side panel is built after the WebGPU probe, and init() reuses it', () => {
  const main = read('src/main.ts')
  const probe = main.indexOf('await router.probeWebGPU()')
  const panel = main.indexOf('const panel = new SidePanel(')
  const init = main.indexOf('await router.init(')
  assert.ok(probe > 0, 'the probe is awaited in main')
  assert.ok(probe < panel, 'the probe finishes before the panel reads hasWebGPU')
  assert.ok(init > panel, 'init() still runs after the panel, and reuses the probe')
})

test('C1-2: the 8th Wall wait has an overall ceiling of 120 to 180 s, on the page clock', () => {
  const main = read('src/main.ts')
  const constant = main.match(/const XR8_OVERALL_TIMEOUT_MS = ([\d_]+)/)
  assert.ok(constant, 'the ceiling is a named, documented constant')
  const ms = Number(constant[1].replaceAll('_', ''))
  assert.ok(ms >= 120_000 && ms <= 180_000, `between 120 and 180 s, got ${ms} ms`)
  const poll = main.slice(main.indexOf('const poll = setInterval('), main.indexOf('function settle(result: XR8Load)'))
  assert.match(poll, /performance\.now\(\) >= XR8_OVERALL_TIMEOUT_MS/, 'the poll checks the ceiling, so a stalled download still settles')
  assert.match(poll, /settle\('timeout'\)/, 'the ceiling settles as timeout, which shows the reload message')
})

test('C1-3: the failed download reason comes before the unsupported-device reason', () => {
  const main = read('src/main.ts')
  const reason = main.slice(main.indexOf('const reason = forcedMode'), main.indexOf('overlay.setStatus(reason)'))
  const download = reason.indexOf("'The AR engine did not load\\n")
  const unsupported = reason.indexOf('AR not available on this device')
  assert.ok(download > 0, 'the download failure has its own copy')
  assert.ok(unsupported > download, 'only a device that cannot run AR gets the unsupported line')
})

test('C1-6: a reset takes the detection count from its caller, not from the store', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function resetScanner(detectionCount: number): void {')
  assert.ok(start > 0, 'resetScanner takes the count it was given')
  const body = main.slice(start, main.indexOf('qualityMonitor.reset()', start))
  assert.match(body, /detectionCount,\n\s+poseCount: poseHistory\.length/)
  assert.match(body, /qualitySummary: currentQualitySummary\(detectionCount\)/)
  assert.doesNotMatch(body, /store\.detections\.size/, 'the store has already been changed by the caller')
})

test('C1-6: a late status from the closed stream cannot write its count back', () => {
  const main = read('src/main.ts')
  assert.match(main, /if \(s\.active\) keyframeCountClosed = false\n\s+if \(!keyframeCountClosed\) latestKeyframeCount = s\.sent/)
  assert.match(main, /latestKeyframeCount = 0\n\s+keyframeCountClosed = true/)
})

test('C1-13: the stream toggle ignores a tap during its own start or stop', () => {
  const main = read('src/main.ts')
  const handler = main.slice(
    main.indexOf('let streamToggleBusy = false'),
    main.indexOf('// ── 4b. Onboarding overlay'),
  )
  const guard = handler.indexOf('if (streamToggleBusy || kfStreamer.isTransitioning) return')
  assert.ok(guard > 0, 'a tap during a transition returns early')
  assert.ok(guard < handler.indexOf('if (kfStreamer.active)'), 'the guard comes before choosing stop or start')
  assert.match(handler, /\.finally\(settleStreamToggle\)/, 'the guard clears once the transition settles, success or failure')
  assert.doesNotMatch(handler, /\.disabled = /, 'the disabled state stays with disableCaptureControls, which also disables this button')
})

test('C1-10: a failed session load shows an alert on its row and restores the button', () => {
  const history = read('src/ui/history.ts')
  const handler = history.slice(history.indexOf('loadBtn.addEventListener'), history.indexOf('const delBtn = document.createElement'))
  assert.match(handler, /try \{\n\s+loaded = await this\.store\.loadSession\(s\.sessionId\)\n\s+\} catch \(err\) \{/)
  assert.match(handler, /finally \{\n\s+loadBtn\.style\.opacity = ''/, 'the half-faded button is restored on failure')
  assert.match(handler, /note\.setAttribute\('role', 'alert'\)/)
  assert.match(handler, /Could not load this session\. Try again\./)
})

test('C1-9: focus is put back on the control that had it, and the caret with it', () => {
  const panel = read('src/ui/panel.ts')
  assert.doesNotMatch(panel, /\[data-editing="true"\] input/, 'focus is no longer always sent to the label input')
  assert.match(panel, /labelInput\.dataset\['focusId'\] = `\$\{key\}:label`/)
  assert.match(panel, /descInput\.dataset\['focusId'\] = `\$\{key\}:desc`/)
  assert.match(panel, /target\.setSelectionRange\(caret\.start, caret\.end\)/)
})
