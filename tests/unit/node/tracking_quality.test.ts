/**
 * Live tracking-quality gate.
 *
 * The status strings below are the ones 8th Wall actually publishes, as
 * documented on `ARProvider.isTracking()` in src/ar/provider.ts:
 * INITIALIZING / LIMITED / NORMAL / NOT_AVAILABLE.
 *
 * Run: npm run test:tracking:quality
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { trackingIsUsable } from '../../../src/ar/tracking-quality.ts'

test('NORMAL records geometry', () => {
  assert.equal(trackingIsUsable('NORMAL'), true)
})

test('degraded states do not record geometry', () => {
  // These are the states that produced the 60m debris cloud: the runtime is
  // still emitting points, but against a frame it no longer trusts itself.
  assert.equal(trackingIsUsable('LIMITED'), false)
  assert.equal(trackingIsUsable('NOT_AVAILABLE'), false)
})

test('INITIALIZING does not record — the pose is still a guess', () => {
  // Before SLAM converges the frame is about to move underneath any point
  // placed against it, so those points are wrong even though nothing errored.
  assert.equal(trackingIsUsable('INITIALIZING'), false)
})

test('fails open on UNKNOWN so WebXR is not silently disabled', () => {
  // WebXRProvider has no equivalent signal and always reports UNKNOWN. A closed
  // rule would stop it accumulating ANY points — a total capture regression
  // dressed up as a data-quality fix.
  assert.equal(trackingIsUsable('UNKNOWN'), true)
})

test('fails open on absent/empty status', () => {
  assert.equal(trackingIsUsable(null), true)
  assert.equal(trackingIsUsable(undefined), true)
  assert.equal(trackingIsUsable(''), true)
})

test('fails open on an unrecognised status from a future runtime version', () => {
  // A new 8th Wall build inventing a status must not silently stop capture.
  assert.equal(trackingIsUsable('SOME_NEW_STATE'), true)
})

test('matching is exact — no case folding or trimming', () => {
  // The provider returns the runtime's string verbatim; if a runtime ever
  // changes case this must fail open rather than quietly half-work.
  assert.equal(trackingIsUsable('limited'), true)
  assert.equal(trackingIsUsable(' LIMITED'), true)
})
