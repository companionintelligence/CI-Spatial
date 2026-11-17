/**
 * Scanner wiring and ordering (publish-readiness WP-B), checked against source.
 *
 * main.ts is one large DOM module, so these tests read it rather than run it.
 * Each rule is one a regression would break: the untracked capture is kept and
 * placed nowhere, the 8th Wall wait follows xr.js, the reset is wired to all three
 * paths, a second tap cannot start a second camera, the shell links open the
 * viewer, and the HUD links can be tapped through the pass-through HUD.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-b-scanner-flow.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('an untracked capture keeps its photo, records that it was not placed, and skips inference', () => {
  const main = read('src/main.ts')
  // The first `if (!poseValid) {` is the wait for tracking, before the capture. The
  // untracked branch is the next one, after the frame has been stored under its index.
  const stored = main.indexOf('const captureIndex = ++captureCount')
  const gate = main.indexOf('if (!poseValid) {', stored)
  const analysing = main.indexOf("overlay.setStatus('Analysing…', 'sticky')")
  const placement = main.indexOf('await resolveDetections(')
  assert.ok(stored > 0, 'the frame is stored under its capture index')
  assert.ok(gate > stored, 'the untracked branch exists, after the frame is stored')
  assert.ok(analysing > gate, 'the branch sits before inference')
  assert.ok(placement > analysing, 'placement stays after inference, so it never runs for an untracked frame')
  const branch = main.slice(gate, analysing)
  assert.match(branch, /await store\.markCaptureFailed\(pendingCaptureId,/, 'the record says the photo was not placed')
  assert.ok(branch.includes('return'), 'the branch returns before any detection work')
  assert.match(branch, /overlay\.setStatus\(UNPLACED_STATUS, 'sticky'\)/)
})

test('before the capture the status is neutral, and "saved, not placed" appears only after it succeeds', () => {
  const main = read('src/main.ts')
  assert.doesNotMatch(main, /Capturing anyway/)
  assert.doesNotMatch(main, /Unstable tracking/)
  const docStart = main.indexOf('async function doCapture()')
  const taken = main.indexOf('await capture.capture(CAPTURE_FRAME_TIMEOUT_MS)', docStart)
  const neutral = main.indexOf("overlay.setStatus('Capturing…', 'sticky')", docStart)
  assert.ok(docStart > 0 && taken > docStart, 'the capture call sits in doCapture')
  assert.ok(neutral > docStart && neutral < taken, 'a neutral line is shown before the capture runs')
  assert.doesNotMatch(main.slice(docStart, taken), /UNPLACED_STATUS/, 'the saved-not-placed line is not shown before the capture')
  assert.ok(main.indexOf("overlay.setStatus(UNPLACED_STATUS, 'sticky')", taken) > taken, 'the saved-not-placed line comes after the capture succeeds')
})

test('the AR-runtime failure reason reaches the start screen, not only the overlay beneath it', () => {
  const main = read('src/main.ts')
  assert.match(main, /overlay\.setStatus\(reason\)[\s\S]*?showArHelp\(reason\)/, 'the reason is passed to the start screen')
  assert.match(main, /function showArHelp\(reason: string\): void \{\n[\s\S]*?setStartButtonState\('unavailable', headline\)/, 'its headline becomes the Start button label')
})

test('a pending verdict leaves the permission banner as it is, and only a ready one takes back a banner it put up', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function applyPreflightVerdict(')
  const body = main.slice(start, main.indexOf('function shortName(', start))
  const pending = body.indexOf("if (verdict.outcome === 'warming-up') return")
  const hide = body.indexOf("banner.style.display = 'none'")
  assert.ok(start > 0 && pending > 0, 'the pending outcome returns before the banner is touched')
  assert.ok(hide > pending, 'the banner is hidden only after the pending return')
  assert.match(body.slice(pending, hide), /if \(verdict\.outcome === 'ready'\)/, 'only a ready verdict reaches the hide')
})

test('source shape: a stream tap is ignored while the streamer is transitioning, and a throw on the way in still clears the busy flag', () => {
  const main = read('src/main.ts')
  const start = main.indexOf("document.getElementById('stream-btn')?.addEventListener('click'")
  const handler = main.slice(start, main.indexOf('\n  })\n', start))
  assert.match(handler, /if \(streamToggleBusy \|\| kfStreamer\.isTransitioning\) return/, 'a transition started from anywhere else also ignores the tap')
  assert.match(read('src/capture/keyframes.ts'), /get isTransitioning\(\): boolean/, 'the streamer exposes the getter the handler reads')
  assert.match(handler, /let transitionStarted = false\n\s+try \{/)
  assert.match(handler, /\} finally \{\n\s+if \(!transitionStarted\) settleStreamToggle\(\)\n\s+\}/, 'the flag is cleared on a throw, and left to the transition otherwise')
})

test('a failed Clear still resets the live scan, and says the erase did not finish', () => {
  const panel = read('src/ui/panel.ts')
  assert.match(panel, /console\.error\('\[panel\] clear failed', err\)/)
  assert.match(panel, /this\.render\(this\.store\.currentRunDetections\(\), this\.store\.selected\)/, 'the list is redrawn from the emptied store')
  assert.match(panel, /note\.setAttribute\('role', 'alert'\)/)
  assert.match(panel, /Could not erase this scan from this phone\. Try again\./)
  // The reset runs before the erase is awaited, so it still happens if the erase fails or hangs.
  assert.match(
    panel,
    /const erasing = this\.store\.clear\(\)[\s\S]*?this\.onScanReset\?\.\(erased\)[\s\S]*?try \{\s+await erasing\s+\} catch \(err\) \{/,
    'the reset runs before the erase is awaited, so it still happens if the erase fails or hangs',
  )
})

test('the 8th Wall wait follows xr.js, falls back at once on a load error, and says why it gave up', () => {
  const main = read('src/main.ts')
  assert.match(main, /const XR8_LOAD_TIMEOUT_MS = 90_000/)
  assert.doesNotMatch(main, /XR8_LOAD_TIMEOUT_MS = 20_000/)
  assert.match(main, /script\?\.dataset\['state'\] === 'loading' \? null : Date\.now\(\)/)
  assert.match(main, /if \(state === 'error'\) \{/)
  assert.match(main, /overlay\.setStatus\('Loading AR engine…'\)/)
  assert.match(main, /xr8Load === 'timeout'[\s\S]*?did not load in time/)
  assert.match(read('index.html'), /xrScript\.dataset\.state = 'error'/)
})

test('after the router reads its saved mode, the panel shows that mode', () => {
  const main = read('src/main.ts')
  const init = main.indexOf('await router.init(')
  const update = main.indexOf('panel.updateInferMode(router.path)')
  assert.ok(init > 0, 'router.init is awaited in main')
  assert.ok(update > init, 'the panel is told the resolved mode after init, not only when the callback fires')
})

test('Clear, deleting the active session and loading another session each reset the live scan', () => {
  const main = read('src/main.ts')
  const panel = read('src/ui/panel.ts')
  const history = read('src/ui/history.ts')
  assert.match(main, /function resetScanner\(detectionCount: number\): void \{/)
  assert.match(main, /pointCloud\.clear\(\)/)
  assert.match(main, /poseHistory\.length = 0/)
  assert.match(main, /sessionScanEntry = null/)
  assert.match(main, /latestKeyframeCount = 0/)
  assert.match(main, /qualityMonitor\.reset\(\)/)
  assert.match(main, /resetScanner,\n\s*\)\n\s*panel\.mount\(\)/, 'the side panel gets the reset')
  assert.match(main, /new SessionHistory\(store, resetScanner\)/, 'the history drawer gets the reset')
  // Each caller counts the scan it is leaving before it changes the store.
  assert.match(panel, /const erased = this\.store\.currentRunDetections\(\)\.size[\s\S]*?const erasing = this\.store\.clear\(\)[\s\S]*?this\.onScanReset\?\.\(erased\)/, 'the reset runs before the erase is awaited, so it still happens if the erase fails or hangs')
  assert.ok(panel.indexOf('this.onScanReset?.(erased)') < panel.indexOf('await erasing'), 'the reset is called before the erase is awaited')
  assert.equal((history.match(/this\.onScanReset\(leavingCount\)/g) ?? []).length, 2, 'the delete and the load both reset')
  assert.match(history, /const leavingCount = this\.store\.currentRunDetections\(\)\.size/)
  assert.match(history, /if \(this\.store\.sessionId !== before\) this\.onScanReset\(leavingCount\)/, 'loading the session already open does not wipe it')
})

test('a second tap while the person recorder is opening asks for a stop, never a second recorder', () => {
  const main = read('src/main.ts')
  const handler = main.slice(main.indexOf("getElementById('person-capture-btn')?.addEventListener('click'"))
  assert.ok(handler.indexOf('if (clipStarting)') >= 0, 'the in-flight guard exists')
  assert.ok(
    handler.indexOf('if (clipStarting)') < handler.indexOf('if (clipRecorder)'),
    'the in-flight guard is checked before the stop branch',
  )
  assert.match(handler, /clipStopAsked = true/)
  assert.match(handler, /clipRecorder = recorder\n\s+started = await recorder\.start\(\)/, 'the recorder is assigned before the await')
  assert.match(handler, /finally \{\n\s+if \(!started\) clipRecorder = null\n\s+clipStarting = false/)
  assert.match(handler, /if \(status\.state === 'starting'\)/, 'the opening camera is shown')
})

test('the shell editor links open the viewer with the same project suffix the scanner builds', () => {
  const index = read('index.html')
  const main = read('src/main.ts')
  assert.match(index, /id="start-editor-card" class="start-path" href="\/viewer\.html"/)
  assert.match(index, /id="upload-video-open" href="\/viewer\.html" hidden/)
  assert.doesNotMatch(index, /href="\/editor"/)
  // The start card's base is editorPath(): /editor on a server and the public site, which rewrite it,
  // and /viewer.html in a native shell, which has no rewrite (src/shared/api-base.ts). The other link
  // is always the viewer file. main.ts never spells '/editor' itself.
  assert.match(main, /\[\['start-editor-card', editorPath\(\)\], \['viewer-link', '\/viewer\.html'\]\]/)
  assert.match(main, /import \{[^}]*\beditorPath\b[^}]*\} from '\.\/shared\/api-base\.ts'/)
  assert.match(
    main,
    /editorPath\(uploadPlaceTarget\.projectId\n\s*\? `\?project=\$\{encodeURIComponent\(uploadPlaceTarget\.projectId\)\}`\n\s*: '\?world=default'\)/,
    'a free upload (no Place) links to the default world, and a Place upload links to that Place, both through editorPath()',
  )
  assert.doesNotMatch(main, /'\/editor'/)
})

test('View in 3D after an export opens the Place the scan went into, and is revealed after its link is set', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /link\.href = scanEntry\.projectId\n\s*\? `\/viewer\.html\?project=\$\{encodeURIComponent\(scanEntry\.projectId\)\}`\n\s*: '\/viewer\.html\?world=default'/,
  )
  const set = main.indexOf('link.href = scanEntry.projectId')
  const reveal = main.indexOf("link.style.display = 'inline-block'", set)
  assert.ok(set > 0 && reveal > set, 'the link is revealed only once its href is set')
})

test('the HUD links opt back in to taps, after the HUD rule that switches them off', () => {
  const index = read('index.html')
  const hud = index.indexOf('#hud-panel {')
  const optIn = index.indexOf('#export-view-link, #export-download-link { pointer-events: auto; }')
  assert.ok(hud > 0, 'the HUD rule exists')
  assert.ok(optIn > hud, 'the opt-in comes after the HUD rule')
  assert.match(index.slice(hud, optIn), /pointer-events: none;/)
})

test('the tripod sheet buttons meet the 44 px target, and the sheet takes and returns focus', () => {
  const index = read('index.html')
  assert.match(index, /\.tripod-wide-btn \{[^}]*min-height: 44px;/)
  assert.match(index, /\.tripod-plain-btn \{[^}]*min-height: 44px;/)
  const main = read('src/main.ts')
  assert.match(main, /<div class="place-sheet-title" tabindex="-1">Tripod Scan/)
  assert.match(main, /sheet\.querySelector<HTMLElement>\('\.place-sheet-title'\)\?\.focus\(\)/)
  assert.match(main, /sheet\.hidden = true\n\s+\/\/ Focus goes back[^\n]*\n\s+card\.focus\(\)/)
})

test('an edit in progress survives a re-render of the side panel, and only within its own session', () => {
  const panel = read('src/ui/panel.ts')
  assert.match(panel, /private _editing: \{ startedAt: number; key: string; label: string; description: string \} \| null = null/)
  // A draft is dropped when its session changed (a load), or its object is gone.
  assert.match(panel, /this\._editing\.startedAt !== this\.store\.startedAt \|\| !dets\.has\(this\._editing\.key\)/)
  assert.match(panel, /const draft = this\._editing\?\.key === key \? this\._editing : null/)
  assert.match(panel, /card\.dataset\['editing'\] = 'true'/)
  assert.match(panel, /labelInput\.addEventListener\('input', keepDraft\)/)
  assert.match(panel, /\[data-focus-id\]/, 'focus goes back to the control that had it, not always the label')
})
