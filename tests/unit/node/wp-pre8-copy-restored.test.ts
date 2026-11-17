/**
 * PRE8-3 and PRE8-4: the copy that the copy pass changed outside the boot line is
 * back to its pre-copy-pass wording, and each restored string is pinned exactly, so
 * the churn cannot come back without a failing test.
 *
 * The strings below are the wording src/ar/preflight.ts had before the Nov 10 copy
 * pass. Three lines are NOT restored, because the boot budget needs them to change,
 * and they are pinned where they live: the advertised caveat and the boot no-AR line
 * (in ar_preflight.test.ts and the wp-pre7 files), and the insecure line, which is
 * charged by the budget and held to the 15-word copy check.
 *
 * Post-tap and post-camera copy is not budgeted (see startup-budget.ts), so these
 * pins are about wording and meaning, not word ceilings.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-pre8-copy-restored.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { firstFrameVerdict, probeVerdict, startFailureVerdict } from '../../../src/ar/preflight.ts'
import { countWords } from '../../support/startup-budget.ts'

/** The next-steps sentence every post-tap dead end ends with, as it was before the copy pass. */
const NO_AR_NEXT_STEP = 'The other ways to capture need no AR and still work here. A phone on a tripod, swept from three to five spots, rebuilds the room from every side. A video or photos you already have of this Place is the other, though it rebuilds the room without cataloguing anything in it.'

/** Its mid-sentence form, used after "If it keeps happening, ". */
const NO_AR_NEXT_STEP_LOWER = 'the other ways to capture need no AR and still work: a phone on a tripod swept from three to five spots, or a video or photos you already have of this Place.'

test('the next-steps sentence is the pre-copy-pass one, fifty-two words', () => {
  assert.equal(countWords(NO_AR_NEXT_STEP), 52)
  // Every failure verdict without a device-level reason ends with this sentence.
  const v = startFailureVerdict(new TypeError('window.THREE does not exist'))
  assert.equal(
    v.detail,
    'AR could not start on this device, so there is nothing for the scanner to track. ' + NO_AR_NEXT_STEP,
  )
})

test('the intermittent no-frame line is the pre-copy-pass wording', () => {
  // elapsedMs 5000 is the first moment the verdict is judged (FIRST_POSE_TIMEOUT_MS).
  const v = firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 5000 })
  assert.equal(v.outcome, 'degraded')
  assert.equal(
    v.detail,
    'The camera opened but the AR engine sent no frame in 5 seconds, so there is nothing to track yet. '
      + 'This often clears on a second try. If it keeps happening, ' + NO_AR_NEXT_STEP_LOWER,
  )
})

test('the frames-but-no-pose line is the pre-copy-pass wording', () => {
  const v = firstFrameVerdict({ sawCameraFrame: true, sawPose: false, elapsedMs: 6000 })
  assert.equal(
    v.detail,
    'The camera is running but AR has not locked on. Add light, point at something with more detail than a blank wall, and move slowly.',
  )
})

test('the warming-up and tracking lines are the pre-copy-pass wording', () => {
  assert.equal(
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 1000 }).detail,
    'The AR runtime is still starting. Hold the phone up and give it a few seconds.',
  )
  assert.equal(
    firstFrameVerdict({ sawCameraFrame: true, sawPose: true, elapsedMs: 6000 }).detail,
    'AR is tracking. Walk the room slowly to build the scan.',
  )
})

test('the failure lines that name the device and the permission are the pre-copy-pass wording', () => {
  const beamPro = new Error('The specified session configuration is not supported')
  beamPro.name = 'NotSupportedError'
  assert.equal(
    startFailureVerdict(beamPro).detail,
    'AR could not start: this device advertises AR support but has no AR service installed to back it '
      + '(on Android that is Google Play Services for AR), so retrying will not help. ' + NO_AR_NEXT_STEP,
  )

  const denied = new Error('Permission denied')
  denied.name = 'NotAllowedError'
  assert.equal(
    startFailureVerdict(denied).detail,
    'Camera access is blocked, so the scanner cannot see the room. Allow camera access for this site in your '
      + 'browser or phone settings and reload, or hand over a video or photos you already have of this Place instead.',
  )
})

test('the engine-loaded line is the pre-copy-pass wording, and is not a boot line', () => {
  // caveat false: applyPreflightToStartScreen() returns before it writes #ar-help.
  const v = probeVerdict({ secureContext: true, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true })
  assert.equal(v.caveat, false)
  assert.equal(
    v.detail,
    'The AR engine loaded. Whether the camera pipeline actually produces frames on this device is checked in the first few seconds after you start.',
  )
})
