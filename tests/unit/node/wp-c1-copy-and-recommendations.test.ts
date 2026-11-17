/**
 * Scan copy and quality advice (publish-readiness fix wave 2, package C1).
 *
 * The quality monitor's advice is checked through its summary, so the lines a
 * user reads are the ones under test. The untracked-capture status, the engine
 * download line and the engine caption are read from source, the way the other
 * scanner copy tests read main.ts and panel.ts (those modules touch the DOM at
 * import and cannot be loaded under node).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c1-copy-and-recommendations.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('C1-8: a sparse point cloud is told to collect more before export', () => {
  const summary = new ScanQualityMonitor().summary({ pointCount: 10, detectionCount: 0, poseCount: 0, keyframeCount: 1 })
  assert.ok(summary.recommendations.includes('Collect more tracking points before export'))
})

test('C1-8: a full point cloud is not asked for more', () => {
  const summary = new ScanQualityMonitor().summary({ pointCount: 500, detectionCount: 0, poseCount: 0, keyframeCount: 1 })
  assert.ok(!summary.recommendations.some((line) => line.startsWith('Collect more tracking points')))
})

test('C1-8: the reflective-surfaces advice names the action to take', () => {
  const quality = read('src/capture/quality-monitor.ts')
  assert.match(quality, /recommendations\.push\('Review reflective surfaces for false geometry'\)/)
  assert.doesNotMatch(quality, /'Reflective surfaces can add false geometry'/, 'the line that named no action is gone')
})

test('C1-8: the advice lines are short instructions, with no sentence stop and no engine jargon', () => {
  const quality = read('src/capture/quality-monitor.ts')
  const lines = [...quality.matchAll(/recommendations\.push\('([^']+)'\)/g)].map((m) => m[1])
  assert.ok(lines.length >= 7, 'the advice list is still there')
  for (const line of lines) {
    assert.ok(!line.endsWith('.'), `no sentence stop in advice line: ${line}`)
    assert.ok(!/SLAM|splat|floor-grid/.test(line), `no engine jargon in advice line: ${line}`)
  }
})

test('C1-7: the untracked-capture status says the photo was saved, not placed, and what to do next', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /const UNPLACED_STATUS = '⚠ Tracking not ready\. Photo saved, not placed\. Move slowly, then capture again\.'/,
  )
})

test('C1-3: a failed engine download has a reload line of its own, apart from an unsupported device', () => {
  const main = read('src/main.ts')
  assert.match(main, /xr8Load === 'failed'\n\s+\? 'The AR engine did not load\\n• Reload the page\. If it keeps failing, the server may be down'/)
  assert.doesNotMatch(main, /Check your connection/, 'the copy does not blame the network: a 404 for the engine file fails the same way')
})

test('C1-11: the engine caption at mount uses the same line as a mode switch', () => {
  const panel = read('src/ui/panel.ts')
  assert.doesNotMatch(panel, /Runs on the scan server/, 'the old caption is gone from the source')
  assert.match(panel, /aiNote\.textContent = this\._aiNoteText\(this\._currentInferMode\)/)
  assert.match(panel, /'Sends photos to your Scan server for analysis\.'/)
})
