/**
 * How src/main.ts is wired to frame epochs (WP-09), checked against source.
 *
 * main.ts touches the DOM when it loads, so, like wp-c1-scanner-wiring.test.ts, this reads
 * the source for the rules a regression would break. The behaviour behind each line is
 * tested where it lives: the log in frame_epoch.test.ts, the cloud in
 * tests/unit/deno/pointcloud.test.ts, the verdict in frame_epoch_quality.test.ts, the
 * sidecar in frame_epoch_sidecar.test.ts. What only main.ts can get wrong is the wiring.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_wiring.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
const calibration = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')

test('the scan has one epoch log, made before anything can reset or export it', () => {
  assert.match(main, /import \{ ScanFrameEpochLog \} from '\.\/ar\/frame-epoch'/)
  const made = main.indexOf('const scanFrameEpochs = new ScanFrameEpochLog()')
  assert.ok(made > 0, 'one log, one per page')
  assert.ok(made < main.indexOf('function resetScanner('), 'a Clear can reach it as soon as the page is up')
  assert.ok(made < main.indexOf('function currentQualitySummary('))
})

test('the log is attached to the provider before the AR session starts, so no discontinuity is missed', () => {
  const attach = main.indexOf('scanFrameEpochs.attach(provider)')
  const start = main.indexOf('await provider.start(canvas)')
  assert.ok(attach > 0 && start > 0)
  assert.ok(attach < start, 'attached first')
})

test('every point goes into the cloud under the epoch its scanner tick read', () => {
  assert.match(main, /pointCloud\.add\(frame\.points, frame\.epoch\)/)
  assert.doesNotMatch(main, /pointCloud\.add\(frame\.points\)/, 'a bare add files every point under epoch 0')
})

test('a new scan starts a new log, beside the monitor and the cloud it belongs with', () => {
  const body = main.slice(main.indexOf('function resetScanner('), main.indexOf('// The On-device toggle and its model row'))
  assert.match(body, /pointCloud\.clear\(\)/)
  assert.match(body, /qualityMonitor\.reset\(\)\n\s+scanFrameEpochs\.reset\(\)/)
})

test('the verdict is given the scan\'s frame shifts and the time it spent degraded', () => {
  const summary = main.slice(main.indexOf('function currentQualitySummary('), main.indexOf('async function ensureSessionScanEntry'))
  assert.match(summary, /frameShifts: scanFrameEpochs\.frameShifts/)
  assert.match(summary, /limitedMs: scanFrameEpochs\.limitedMs/)
})

test('every way of exporting a scan writes the frame epochs into it', () => {
  const calls = [...main.matchAll(/exportToGLB\(\n\s+\{([^\n]+)\},/g)].map((m) => m[1])
  // The third is the export that ends a scan at a re-anchor (WP-09b, src/ar/reanchor-host.ts): the same upload as the autosave's,
  // and its sidecar has to say which stretches of tracking the scan it ends was recorded in as much as any other.
  assert.equal(calls.length, 3, 'the manual export, the autosave and the export that ends a scan at a re-anchor are the three GLB exports')
  for (const call of calls) {
    assert.match(call, /frameEpochs: scanFrameEpochs\.snapshot\(pointCloud\)/, call)
  }
})

test('a capture refused for an old pose says so, instead of "Capture failed"', () => {
  const branch = main.indexOf("message.includes('Tracking lost')")
  const generic = main.indexOf("overlay.setStatus('✕ Capture failed\\n• Try again', 'sticky')", branch)
  assert.ok(branch > 0, 'the provider\'s TRACKING_LOST_MESSAGE is matched')
  assert.ok(generic > branch, 'before the generic branch')
  assert.match(main.slice(branch, generic), /Tracking lost\\n• Hold still, then tap again/)
})

test('the epoch the calibration flow begins in is kept with the calibration, which a Clear does not clear', () => {
  const began = main.indexOf('const calibrationEpoch = scanFrameEpochs.currentEpoch')
  const flow = main.indexOf('await runProjectCalibration({')
  const kept = main.indexOf('sessionCalibration = stampScale(calibration.calibration')
  const noted = main.indexOf('scanFrameEpochs.noteCalibrated(calibrationEpoch)')
  assert.ok(began > 0 && flow > 0 && kept > 0 && noted > 0)
  assert.ok(began < flow, 'read before the flow runs, so a shift while it runs counts against the calibration')
  assert.ok(kept < noted && noted - kept < 120, 'noted in the same step that keeps the calibration')
  // The Clear keeps the calibration (sessionCalibration is not reset in resetScanner), so the log must keep its epoch.
  const reset = main.slice(main.indexOf('function resetScanner('), main.indexOf('// The On-device toggle and its model row'))
  assert.doesNotMatch(reset, /sessionCalibration\s*=/)
  assert.match(reset, /scanFrameEpochs\.reset\(\)/)
})

test('the calibration modal reads its tracking line from frame-epoch.ts, which counts interruptions as well as measured jumps', () => {
  assert.match(calibration, /import \{ describeTracking \} from '\.\/frame-epoch'/)
  assert.match(calibration, /const \{ text, warn \} = describeTracking\(diagnostics\)/)
  assert.doesNotMatch(calibration, /diagnostics\.poseJumps/, 'the modal no longer reads measured jumps alone')
})
