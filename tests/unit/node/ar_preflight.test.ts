/**
 * Device AR preflight — the verdicts src/ar/preflight.ts reaches.
 *
 * The cases below are the ones actually observed on an XREAL Beam Pro (no
 * ARCore installed, verified against the full installed-package list):
 * `isSessionSupported('immersive-ar')` answers true, `requestSession()` rejects
 * with NotSupportedError, and 8th Wall on the same device reports ready,
 * acquires a 960x720 camera track, and never emits a frame.
 *
 * The distinction the tests exist to protect is "not yet" vs "never": a device
 * that is merely slow must never be routed off the AR path.
 *
 * Run: npm run test:ar:preflight
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIRST_POSE_TIMEOUT_MS,
  firstFrameVerdict,
  probeVerdict,
  startFailureVerdict,
} from '../../../src/ar/preflight.ts'

// ── probeVerdict — what is knowable before the user commits ──────────────────

test('an insecure context is unavailable, and does not blame AR', () => {
  const v = probeVerdict({
    secureContext: false, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.canScan, false)
  assert.match(v.detail, /HTTPS/)
})

test('a loaded 8th Wall engine is only ever "warming-up", never "ready"', () => {
  // The Beam Pro reaches exactly this state and then emits nothing. Claiming
  // readiness from the engine having loaded is the lie this must not repeat.
  const v = probeVerdict({
    secureContext: true, xr8Loaded: true, webxrApi: false, immersiveArAdvertised: false,
  })
  assert.equal(v.outcome, 'warming-up')
  assert.equal(v.canScan, true)
  assert.equal(v.routeToUpload, false)
})

test('an advertised immersive-ar session is warming-up, and the detail says why that is weak', () => {
  const v = probeVerdict({
    secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(v.outcome, 'warming-up')
  assert.equal(v.canScan, true)
  // isSessionSupported() reports whether the API exists, not whether anything
  // backs it. A verdict that presented this as a green light would be the bug.
  assert.match(v.detail, /API is present/i)
})

test('the negative answer IS trustworthy — no immersive-ar means unavailable', () => {
  const v = probeVerdict({
    secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: false,
  })
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.canScan, false)
  assert.equal(v.routeToUpload, true)
  assert.match(v.detail, /Upload Content/)
})

test('no engine and no WebXR API at all is unavailable and routes to Upload', () => {
  const v = probeVerdict({
    secureContext: true, xr8Loaded: false, webxrApi: false, immersiveArAdvertised: false,
  })
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.routeToUpload, true)
})

// ── startFailureVerdict — classifying a provider.start() rejection ───────────

test('the Beam Pro rejection gets its own sentence, not the generic one', () => {
  // The literal message requestSession() rejects with when the AR API exists
  // and no AR service backs it.
  const err = new Error('The specified session configuration is not supported')
  err.name = 'NotSupportedError'
  const v = startFailureVerdict(err)
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.routeToUpload, true)
  // The point of the separate sentence: retrying is not a next step here.
  assert.match(v.detail, /retrying will not help/i)
  assert.match(v.detail, /Play Services for AR/)
  // …while still leading with the consequence clause every start failure
  // shares. tests/mock-webxr-session-failure.spec.ts asserts that phrase
  // reaches the banner, and it is the half that is true regardless of cause.
  assert.match(v.detail, /AR could not start/)
  // The runtime's own words name no consequence and no next step, so they must
  // not be what the user is handed.
  assert.doesNotMatch(v.detail, /session configuration/i)
})

test('NotSupportedError is caught by name even when the message is unhelpful', () => {
  const err = new Error('')
  err.name = 'NotSupportedError'
  assert.match(startFailureVerdict(err).detail, /no AR service installed/i)
  assert.equal(startFailureVerdict(err).headline, 'This device has no AR service')
})

test('a permission claim is only made when a permission error backs it', () => {
  const err = new Error('Permission denied')
  err.name = 'NotAllowedError'
  const v = startFailureVerdict(err)
  assert.equal(v.headline, 'Camera access is blocked')
  assert.match(v.detail, /Allow camera access/)
})

test('SecurityError also counts as a permission failure', () => {
  const err = new Error('blocked')
  err.name = 'SecurityError'
  assert.equal(startFailureVerdict(err).headline, 'Camera access is blocked')
})

test('an unrelated crash is NOT reported as a permission problem', () => {
  // The regression this rule exists for: `window.THREE does not exist` was
  // reported as "Camera access denied" for weeks, sending people to check
  // settings that were already correct.
  const v = startFailureVerdict(new TypeError('window.THREE does not exist'))
  assert.equal(v.headline, 'AR could not start on this device')
  assert.doesNotMatch(v.detail, /camera access/i)
})

test('a non-Error rejection still produces a verdict rather than throwing', () => {
  const v = startFailureVerdict('something went wrong')
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.canScan, false)
})

// ── firstFrameVerdict — the "not yet" vs "never" distinction ─────────────────

test('inside the grace window nothing is judged, however bad it looks', () => {
  // No frame, no pose, 1 s in: this is what a normal cold start looks like on a
  // phone. Routing away here would push working devices off the AR path.
  const v = firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 1_000 })
  assert.equal(v.outcome, 'warming-up')
  assert.equal(v.canScan, true)
  assert.equal(v.routeToUpload, false)
})

test('the grace window is the provider\'s existing 5 s pose timer', () => {
  assert.equal(FIRST_POSE_TIMEOUT_MS, 5_000)
  // Just under it: still not yet. Exactly at it: judged.
  assert.equal(
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 4_999 }).outcome,
    'warming-up',
  )
  // Past the window is 'degraded', not 'unavailable': see the no-frame test below.
  assert.equal(
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 5_000 }).outcome,
    'degraded',
  )
})

test('no camera frame past the window is "not this time", NOT "never"', () => {
  // This test used to assert the opposite, and was wrong. The Beam Pro signature
  // — engine ready, camera track acquired, aspect diagnostic reading
  // `frame: "unreported"` — was read as proof the device could never scan. It is
  // not: the same device later reached trackingStatus NORMAL with a pose 2.37 s
  // after start. The failure is intermittent, about two starts in eight, and
  // correlates with the orientation getUserMedia returns rather than with the
  // hardware. A five-second sample cannot support a permanent claim.
  const v = firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 6_000 })
  assert.equal(v.outcome, 'degraded')
  assert.equal(v.canScan, true, 'the capture rail must stay live on a device that succeeds 1 in 4')
  assert.equal(v.routeToUpload, false, 'do not push someone away from a scanner that may work on retry')
  assert.doesNotMatch(v.detail, /cannot run the live scanner/, 'no permanent claim from one sample')
  assert.match(v.detail, /second try|try again|again/i, 'retrying is the thing that actually works here')
})

test('frames but no pose is "not yet, and here is why" — fixable in the room', () => {
  // The engine is alive; SLAM has not converged. A dark or featureless room
  // causes this, and the person can fix it where they are standing — so this
  // must NOT send them to Upload Content.
  const v = firstFrameVerdict({ sawCameraFrame: true, sawPose: false, elapsedMs: 6_000 })
  assert.equal(v.outcome, 'degraded')
  assert.equal(v.canScan, true)
  assert.equal(v.routeToUpload, false)
  assert.match(v.detail, /light/i)
  assert.doesNotMatch(v.detail, /Upload Content/)
})

test('a pose beats everything, however late it arrives', () => {
  // A device that recovers at 8 s is a working device, and a UI that warned at
  // 5 s has to be able to take the warning back.
  const v = firstFrameVerdict({ sawCameraFrame: true, sawPose: true, elapsedMs: 8_000 })
  assert.equal(v.outcome, 'ready')
  assert.equal(v.canScan, true)
})

test('a pose without a reported frame size still counts as ready', () => {
  // Frame-size hooks and poses arrive from different engine callbacks; a pose
  // is the stronger evidence and must not be second-guessed by the weaker one.
  const v = firstFrameVerdict({ sawCameraFrame: false, sawPose: true, elapsedMs: 9_000 })
  assert.equal(v.outcome, 'ready')
})

test('the grace window is overridable, so callers with a different timer agree', () => {
  assert.equal(
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 3_000, timeoutMs: 2_000 }).outcome,
    'degraded',
  )
})

// ── caveat — which verdicts are worth reading before committing ──────────────

test('a loaded 8th Wall engine carries no caveat — a working phone gets a clean start screen', () => {
  const v = probeVerdict({
    secureContext: true, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(v.caveat, false)
})

test('an advertised-but-unproven WebXR session DOES carry a caveat', () => {
  // The whole reason the flag exists: this verdict says "yes" and is exactly
  // what the Beam Pro's browser said minutes before requestSession() failed.
  const v = probeVerdict({
    secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(v.canScan, true)
  assert.equal(v.caveat, true)
})

test('a healthy live session says nothing — no caveat while warming up or tracking', () => {
  assert.equal(firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 1_000 }).caveat, false)
  assert.equal(firstFrameVerdict({ sawCameraFrame: true, sawPose: true, elapsedMs: 8_000 }).caveat, false)
})

test('every verdict that cannot scan is worth reading', () => {
  const cannotScan = [
    probeVerdict({ secureContext: false, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true }),
    probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: false, immersiveArAdvertised: false }),
    probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: false }),
    startFailureVerdict(new Error('boom')),
    // firstFrameVerdict is deliberately absent: a missing first frame is no longer
    // a dead end, because it clears on retry on real hardware.
  ]
  for (const v of cannotScan) {
    assert.equal(v.canScan, false)
    assert.equal(v.caveat, true, `a dead end must be readable: ${v.headline}`)
  }
})

test('every verdict carries a headline and a detail — no empty UI', () => {
  const verdicts = [
    probeVerdict({ secureContext: true, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true }),
    probeVerdict({ secureContext: true, xr8Loaded: false, webxrApi: false, immersiveArAdvertised: false }),
    startFailureVerdict(new Error('boom')),
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 0 }),
    firstFrameVerdict({ sawCameraFrame: false, sawPose: false, elapsedMs: 9_000 }),
    firstFrameVerdict({ sawCameraFrame: true, sawPose: false, elapsedMs: 9_000 }),
    firstFrameVerdict({ sawCameraFrame: true, sawPose: true, elapsedMs: 9_000 }),
  ]
  for (const v of verdicts) {
    assert.ok(v.headline.length > 0, `empty headline for ${v.outcome}`)
    assert.ok(v.detail.length > 0, `empty detail for ${v.outcome}`)
    // A verdict that cannot scan must always name where to go instead, unless
    // the page itself is the problem (insecure context).
    if (!v.canScan && !/HTTPS/.test(v.detail)) {
      assert.equal(v.routeToUpload, true, `no route out of ${v.outcome}`)
    }
  }
})
