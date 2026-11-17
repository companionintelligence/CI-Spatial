/**
 * How src/main.ts is wired to the calibration's tap sampler (WP-05b), checked against source.
 *
 * main.ts touches the DOM when it loads, so, like frame_epoch_wiring.test.ts, this reads the source for the lines a
 * regression would break and no unit test could see: the behaviour behind each is tested where it lives (the sampler's
 * in tap_sampling.test.ts and wp-tap-insist.test.ts, the flow's in wp-calibration-taps.test.ts, the modal's in
 * wp-calibration-taps-modal.test.ts, the probe line's in probe_log.test.ts). Without these a build that dropped
 * `sampleTap` would calibrate as it did before sampling and every unit test would still pass, and a probe read with
 * the hit test would measure a different tap from the one that built the frame.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-taps-wiring.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
const shell = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')

test('the page builds one sampler, from the provider, the fitted floor read fresh, and the page\'s own flag', () => {
  assert.equal(main.match(/calibrationTapSampler\(/g)?.length, 1, 'one sampler, so the calibration and the probe read a tap the same way')
  const built = main.indexOf('const tapSampler = calibrationTapSampler({')
  assert.ok(built > 0)
  const body = main.slice(built, main.indexOf('})', built))
  assert.match(body, /provider,/)
  assert.match(body, /singleHit: asyncHitTest,/, 'WebXR\'s synchronous hit test answers nothing, so its asynchronous one is the fallback')
  assert.match(body, /ground: \(\) => pointCloud\.groundEstimate\(\),/)
  assert.match(body, /search: location\.search,/, '?tap=single and ?tap=floor are read from the address')
})

test('the calibration is given the sampler, inside the call that runs it', () => {
  const flow = main.indexOf('await runProjectCalibration({')
  const kept = main.indexOf('sessionCalibration = stampScale(calibration.calibration')
  const given = main.indexOf('sampleTap: tapSampler,', flow)
  assert.ok(flow > 0 && kept > flow, 'the call, and the line that keeps what it returned')
  assert.ok(given > flow && given < kept, '`sampleTap: tapSampler` is an option of that call')
  assert.ok(main.indexOf('const tapSampler = calibrationTapSampler({') < flow, 'built before the flow runs')
})

test('the probe reads its taps with the same sampler, the limits lifted, inside the call that installs it', () => {
  const probe = main.indexOf('installProbeLog({')
  assert.ok(probe > 0)
  const end = main.indexOf('overlay.setStatus(', probe)
  const given = main.indexOf('sample: probeTapReader(tapSampler),', probe)
  assert.ok(given > probe && given < end, '`sample: probeTapReader(tapSampler)` is an option of installProbeLog')
  assert.doesNotMatch(main, /probeAnswerOf/, 'main.ts does not shape the probe\'s answer itself')
})

test('the modal takes the sampler as an option and reads every tap that places a marker through it: one call, in placeAt', () => {
  assert.match(shell, /sampleTap\?: CalibrationTapSampler/)
  assert.match(shell, /sampler: options\.sampleTap,/)
  assert.match(shell, /sampleTap: taps\.read,/)
  assert.equal(shell.match(/readTap\(/g)?.length, 1, 'one place reads a tap to place a marker: placeAt (selecting one takes a single hit and no limit)')
})
