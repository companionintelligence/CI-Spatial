/**
 * How src/main.ts, src/ar/project-calibration.ts and server/main.ts are wired to the re-anchor flow (WP-09b), checked
 * against source.
 *
 * main.ts touches the DOM when it loads, the calibration modal is a hub several packages are editing, and server/main.ts
 * starts a server when it is imported, so, like frame_epoch_wiring.test.ts, this reads the source for the rules a
 * regression would break. The behaviour behind each line is tested where it lives: the flow in wp-09b-reanchor-flow.test.ts,
 * the sequence against the real store in wp-09b-reanchor-host.test.ts, the screen in wp-09b-banner.test.ts, the epoch in
 * wp-09b-calibration-epoch.test.ts. What only the hub can get wrong is the wiring, and these are the lines it gets wrong with.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-wiring.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const main = read('src/main.ts')
const modal = read('src/ar/project-calibration.ts')
const server = read('server/main.ts')

/** The source of the function declared as `signature`, up to the first line that closes it at the same indent. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start > 0, `${signature} is not in the source`)
  const indent = /^ */.exec(source.slice(source.lastIndexOf('\n', start) + 1))![0]
  const end = source.indexOf(`\n${indent}}\n`, start)
  assert.ok(end > start, `${signature} has no end at its indent`)
  return source.slice(start, end)
}

const at = (needle: string, from = 0): number => {
  const found = main.indexOf(needle, from)
  assert.ok(found >= 0, `main.ts has no \`${needle}\``)
  return found
}

// ── The flow exists before anything can ask whether recording is held ───────────────────────────────

test('the flow is built from the re-anchor modules, once, before the scanner, the capture and the keyframe stream can ask it', () => {
  assert.match(main, /import \{ ReanchorFlow, autosplitRequested \} from '\.\/ar\/reanchor-flow'/)
  assert.match(main, /import \{ createReanchorView \} from '\.\/ar\/reanchor-banner'/)
  assert.match(main, /import \{ carryCalibration, createScanHost \} from '\.\/ar\/reanchor-host'/)
  assert.match(main, /import \{ driftTapReader \} from '\.\/ar\/drift-tap'/)
  assert.equal(main.split('new ReanchorFlow(').length, 2, 'one flow per page')
  const built = at('const reanchor = new ReanchorFlow(')
  assert.ok(built < at('keyframes = new KeyframeStreamer('), 'before the keyframe stream is made')
  assert.ok(built < at('async function doCapture('), 'before the capture can run')
  assert.ok(built < at('scanner.start(provider, (frame) => {'), 'before the scanner ticks')
  assert.ok(built < at('function resetScanner('), 'before a Clear can reach it')
})

test('the flow listens to the provider before the AR session starts, beside the epoch log, so no discontinuity is missed', () => {
  const log = at('scanFrameEpochs.attach(provider)')
  const flow = at('reanchor.attach(provider)')
  assert.ok(flow > log && flow - log < 60, 'attached straight after the log')
  assert.ok(flow < at('await provider.start(canvas)'))
})

test('the flow is given the page\'s own run, log, Place frame, calibration, pose trail and status line, and the page\'s query for ?autosplit=1', () => {
  const body = main.slice(at('const reanchor = new ReanchorFlow('), at('Point the capture counter at the live session'))
  assert.match(body, /view: createReanchorView\(\{ canvas \}\)/, 'on the camera canvas the calibration taps')
  assert.match(body, /epochs: scanFrameEpochs,/)
  assert.match(body, /arRunId: \(\) => store\.arRunId,/)
  assert.match(body, /autosplit: autosplitRequested\(location\.search\),/)
  assert.match(body, /storedFrame: \(\) => selectedProject\?\.spatialFrame \?\? null,/)
  assert.match(body, /calibration: \(\) => sessionCalibration,/)
  assert.match(body, /poses: \(\) => poseHistory,/)
  assert.match(body, /say: \(text\) => overlay\.setStatus\(text, 'sticky'\),/)
  assert.match(body, /\.\.\.scanHost,/, 'the scan half of the host')
})

test('a drift check reads its taps through sampleTap, with the host\'s own hit test for WebXR, and the floor as it is when the tap is made', () => {
  const body = main.slice(at('const reanchor = new ReanchorFlow('), at('Point the capture counter at the live session'))
  assert.match(body, /readTap: \(x, y\) => driftTapReader\(\{/)
  assert.match(body, /hitTest: async \(hx, hy\) => \(asyncHitTest \? await asyncHitTest\(hx, hy\) : provider\.hitTest\(hx, hy\)\),/)
  assert.match(body, /ground: \(\) => pointCloud\.groundEstimate\(\),/)
  const reader = read('src/ar/drift-tap.ts')
  assert.match(reader, /sampleTap\(sources\.provider, x, y, \{/)
  assert.match(reader, /singleHit: sources\.hitTest,/)
  assert.match(reader, /floor: sources\.ground\(\),/, 'read at each tap, not once')
  assert.match(reader, /floorRay: 'cross-check',/, 'the floor reports and does not move the point until DX5')
})

// ── The scan half of the host ───────────────────────────────────────────────────────────────────────

const ports = (): string => main.slice(at('const scanHost = createScanHost({'), at('const reanchor = new ReanchorFlow('))

test('a scan is ended through the export the autosave uses, uploaded and not downloaded, with its frame epochs and its calibration', () => {
  const body = ports()
  assert.match(body, /exclusive: withoutAutosave,/)
  assert.match(body, /exportScan: async \(\) => exportToGLB\(/)
  assert.match(body, /scanEntry: await ensureSessionScanEntry\(\)/, 'the old scan\'s entry, with the calibration the old scan was made with')
  assert.match(body, /qualitySummary: currentQualitySummary\(\)/)
  assert.match(body, /frameEpochs: scanFrameEpochs\.snapshot\(pointCloud\)/, 'its sidecar says which stretches of tracking it was recorded in')
  assert.match(body, /\{ download: false, upload: true, filenamePrefix: 'room-scan', autoSaved: false \}/)
  assert.match(body, /hasContent: \(\) => pointCloud\.count > 0 \|\| store\.currentRunDetections\(\)\.size > 0 \|\| poseHistory\.length > 0,/, 'the same emptiness the autosave tests')
})

test('what an uploaded scan leaves behind is recorded where the keyframe session and the Place entry read it', () => {
  const body = ports()
  const recorded = body.slice(body.indexOf('recordUploaded: async (filename) => {'), body.indexOf('resetScan:'))
  assert.match(recorded, /await updateSessionScanFilename\(filename\)/, 'the entry, which becomes ready')
  assert.match(recorded, /lastUploadedFilename = filename/)
  assert.match(recorded, /currentSessionGlbFilename = filename/, 'which resetScanner links the keyframe session to when it stops it')
  assert.match(recorded, /revealDownloadLink\(filename\)/)
})

test('the next scan is begun with the page\'s own reset, and does not carry the calibration of the one before', () => {
  const body = ports()
  assert.match(body, /resetScan: resetScanner,/, 'the reset a Clear does: the cloud, the trail, the entry, the keyframe stream, the epoch log')
  const cleared = body.slice(body.indexOf('clearCalibration: () => {'), body.indexOf('get keyframes()'))
  assert.match(cleared, /sessionCalibration = undefined/, 'a Clear keeps the calibration; a re-anchor must not')
  assert.match(cleared, /scanFrameEpochs\.forgetCalibration\(\)/, 'nor may the log keep counting shifts from the old one\'s epoch')
  assert.match(body, /get keyframes\(\) \{ return keyframes \},/, 'read when it is needed: the stream is made after this')
  assert.match(body, /calibrate: calibrateScan,/)
  assert.match(body, /ensureEntry: ensureSessionScanEntry,/)
})

test('the save waits for a capture that is being analysed: the page says whether one is', () => {
  assert.match(ports(), /capturing: \(\) => captureInFlight,/)
  const flag = main.match(/\blet captureInFlight\b/)
  assert.ok(flag, 'the flag the capture handler sets is the one the host reads')
  const capture = functionBody(main, '  async function doCapture() {')
  assert.match(capture, /captureInFlight = true/)
  assert.match(capture, /captureInFlight = false/)
})

test('an entry that an export made before the calibration finished is given the calibration when the entry is asked for again', () => {
  const body = functionBody(main, '  async function ensureSessionScanEntry(): Promise<ScanEntry> {')
  const carry = body.indexOf('if (carryCalibration(sessionScanEntry, sessionCalibration)) {')
  assert.ok(carry > 0, 'an existing entry is offered the page\'s calibration')
  assert.ok(carry < body.indexOf('return sessionScanEntry'), 'before it is handed back, so the export that asked reads it')
  assert.ok(carry < body.indexOf('sessionScanEntry = await projectStore.addScan('), 'in the branch for an entry that exists')
  assert.match(body, /await projectStore\.updateScan\(sessionScanEntry\)\.catch\(\(error: unknown\) => \{\n\s+console\.warn\(/, 'saved, and a failure to save is said and does not stop the export')
  assert.match(body, /calibration: sessionCalibration,\n\s+\}\)/, 'a new entry still takes the calibration it is made with')
})

test('an autosave does not export a scan whose calibration is still running, and asks again', () => {
  const body = functionBody(main, '  async function runAutoSave(): Promise<void> {')
  assert.match(body, /^\s*async function runAutoSave\(\): Promise<void> \{\n\s+\/\/ [^\n]*\n\s+if \(reanchor\.phase === 'calibrating'\) \{\n\s+queueAutoSave\(\)\n\s+return\n\s+\}\n/, 'first, before it takes the lock')
  assert.ok(body.indexOf("reanchor.phase === 'calibrating'") < body.indexOf('autoSaveInFlight = true'))
})

test('the Place calibration is one function the first scan and a re-anchored one both run, and each run reads its own start', () => {
  const calibrate = functionBody(main, '  async function calibrateScan(): Promise<boolean> {')
  assert.match(calibrate, /^\s*async function calibrateScan\(\): Promise<boolean> \{\n    if \(!selectedProject\) return false\n/, 'no Place, no calibration')
  assert.equal(main.split('const calibrationStartedAt = performance.now()').length, 2, 'the start is read in one place')
  assert.ok(calibrate.includes('const calibrationStartedAt = performance.now()'), 'and it is inside the flow, so a re-anchor reads its own, not the first scan\'s')
  assert.match(calibrate, /const calibration = await runProjectCalibration\(\{/)
  assert.match(calibrate, /scanFrameEpochs\.noteCalibrated\(calibrationEpoch\)/, 'the epoch the flow began in is noted for each calibration')
  assert.match(calibrate, /\n    return !!calibration$/, 'it says whether it made one')
})

test('the first calibration arms the flow, and so does each one a re-anchor makes', () => {
  const first = at('await calibrateScan()')
  assert.match(main.slice(first, first + 80), /^await calibrateScan\(\)\n  reanchor\.arm\(\)\n/)
  assert.ok(first < at('installProbeLog({'), 'before the probe is armed')
  assert.ok(first > at('async function calibrateScan()'))
  assert.equal(main.split('await calibrateScan()').length, 2, 'the page runs it once itself; the flow runs it for a re-anchor through the host')
})

test('an autosave and a re-anchor never export the same scan at once', () => {
  const body = functionBody(main, '  async function withoutAutosave<T>(fn: () => Promise<T>): Promise<T> {')
  assert.match(body, /if \(autoSaveTimer\) clearTimeout\(autoSaveTimer\)/, 'a timer that has not fired is cancelled')
  assert.match(body, /while \(autoSaveInFlight\) await new Promise\(\(resolve\) => setTimeout\(resolve, 100\)\)/, 'one that is running is waited for')
  assert.ok(body.indexOf('autoSaveInFlight = true') > body.indexOf('while (autoSaveInFlight)'), 'then the lock is taken')
  assert.match(body, /finally \{\n\s+autoSaveInFlight = false\n\s+if \(autoSaveQueued\) queueAutoSave\(\)/, 'and let go, with a queued autosave run after')
})

// ── Nothing is recorded while the choice is open ────────────────────────────────────────────────────

test('points and poses are not added to the scan while recording is held, and the "Not recording" hint is not the reason shown for it', () => {
  const tick = main.slice(at('scanner.start(provider, (frame) => {'), at("console.log('[main] Room scanner started')"))
  assert.match(tick, /const held = reanchor\.recordingHeld\n/)
  assert.match(tick, /const inserted = trackingUsable && !held \? pointCloud\.add\(frame\.points, frame\.epoch\) : \[\]/)
  assert.match(tick, /if \(provider\.isTracking\(\) && poseIsFinite\(frame\.pose\) && !held\) poseHistory\.push\(frame\.pose\)/)
  assert.match(tick, /if \(recordingPaused !== !trackingUsable\) \{/, 'the "Not recording" state still follows the runtime\'s tracking and nothing else: the hold has its own hint, below')
})

test('the HUD says that recording is paused while it is held, and a held scan is not shown as ready', () => {
  const body = functionBody(main, '  function updateVerdictUI(): void {')
  assert.match(body, /const heldHint = reanchor\.heldHint\n/)
  assert.match(body, /const summary = \{ \.\.\.base, status: displayedStatus\(base\.status, heldHint !== null\) \}/, 'the chip')
  assert.match(body, /const hintText = heldHint \?\? \(recordingPaused\n/, 'the hold is said before anything else the HUD would say')
  assert.ok(body.indexOf('heldHint ??') < body.indexOf("'⚠ Not recording"), 'ahead of the runtime\'s own line, which has gone by the time the choice is open')
  assert.match(main, /import \{ CAPTURE_HELD_TEXT, displayedStatus \} from '\.\/ar\/reanchor-copy'/)
  const chip = body.slice(body.indexOf("chip.textContent = summary.status === 'ready'"))
  assert.match(chip, /summary\.status/, 'drawn from the status that has been through displayedStatus, not the base one')
  assert.doesNotMatch(chip, /base\.status/)
})

test('auto-capture does not ask for a capture while recording is held, so none is counted that was never taken', () => {
  assert.match(main, /const autoCapture = new AutoCapture\(provider, doCapture, \{ hold: \(\) => reanchor\.recordingHeld \}\)/)
})

test('a capture asked for while the choice is open is refused in words, before it takes a frame', () => {
  const capture = main.slice(at('async function doCapture() {'), at('captureInFlight = true', at('async function doCapture() {')))
  assert.match(capture, /if \(reanchor\.recordingHeld\) \{\n\s+overlay\.setStatus\(CAPTURE_HELD_TEXT, 'sticky'\)\n\s+return\n\s+\}/)
  assert.match(main, /import \{ CAPTURE_HELD_TEXT, displayedStatus \} from '\.\/ar\/reanchor-copy'/)
})

test('keyframes are not taken while it is held, and each carries the run the store is in', () => {
  assert.match(main, /keyframes = new KeyframeStreamer\(provider, \{ hold: \(\) => reanchor\.recordingHeld, runId: \(\) => store\.arRunId \}\)/)
})

// ── The verdict ─────────────────────────────────────────────────────────────────────────────────────

test('the quality verdict does not count the interruptions after which nothing was recorded, and counts a drift check that found a gap', () => {
  const summary = functionBody(main, '  function currentQualitySummary(')
  assert.match(summary, /frameShifts: scanFrameEpochs\.frameShifts - reanchor\.heldShifts,/)
  assert.match(summary, /closureExceeded: scanFrameEpochs\.closureExceeded,/)
})

test('a Clear closes whatever the flow had open', () => {
  const reset = functionBody(main, '  function resetScanner(detectionCount: number): void {')
  assert.match(reset, /scanFrameEpochs\.reset\(\)\n\s+reanchor\.noteScanReset\(\)/, 'after the log is emptied, so the flow sees what the next scan is in')
})

// ── The calibration modal ───────────────────────────────────────────────────────────────────────────

test('the calibration result carries the epoch the flow began in, on both tiers, and the shell took it as hook lines', () => {
  assert.match(modal, /import \{ calibrationEpochField \} from '\.\/calibration-epoch'/)
  assert.match(modal, /const epochField = calibrationEpochField\(options\.provider\)/)
  const begins = modal.indexOf('const epochField = ')
  assert.ok(begins > 0 && begins < modal.indexOf('const trackingWaitStartedAt'), 'read as the flow begins, before any tap')
  assert.match(modal, /close\(\{ calibration, spatialFrame, \.\.\.\(verdict\.frameChanged \? \{ referencePhotos \} : \{\}\), \.\.\.epochField \}\)/)
  assert.match(modal, /close\(\{ calibration: outcome\.calibration, spatialFrame: outcome\.spatialFrame, \.\.\.epochField \}\)/)
  assert.equal(modal.split('epochField').length, 4, 'declared once and spread into the two results')
})

// ── The server ──────────────────────────────────────────────────────────────────────────────────────

test('the server hands the editor the frame-epoch fields of a stored scan from both ways it builds its quality summary', () => {
  assert.match(server, /import \{ frameEpochFieldsFromMeta \} from '\.\/frame_epoch_fields\.ts'/)
  const summary = functionBody(server, 'function qualitySummaryFromMeta(meta: Record<string, unknown>): ScanQualitySummary | null {')
  assert.equal(summary.split('...frameEpochFieldsFromMeta(meta)').length, 3, 'the summary the phone wrote, and the one rebuilt from the flat keys')
})
