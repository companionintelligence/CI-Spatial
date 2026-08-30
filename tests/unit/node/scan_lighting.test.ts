/**
 * Lighting tiers and the single guidance line they compete for.
 *
 * Motivating failure, 19:40: the room was dark, the camera view was black,
 * tracking never acquired, and the only thing on screen was "Tracking lost —
 * move slowly". That advice was not merely unhelpful — it was wrong, and it
 * kept someone walking a room that could not be scanned. Nothing in the app
 * looked at luminance on that path.
 *
 * Run: npm run test:scan:lighting
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { lightingLevel, motionHintText } from '../../../src/capture/quality-monitor.ts'

// ── lightingLevel — the two tiers ────────────────────────────────────────────

test('a normally lit frame is ok', () => {
  assert.equal(lightingLevel(0.5), 'ok')
  assert.equal(lightingLevel(0.22), 'ok')   // the LUMI_LOW boundary is not dim
})

test('dim is the advisory tier — usable, just worse', () => {
  assert.equal(lightingLevel(0.21), 'dim')
  assert.equal(lightingLevel(0.15), 'dim')
  assert.equal(lightingLevel(0.10), 'dim')  // the too-dark boundary is not too dark
})

test('too-dark is the stronger claim, and is reached only well below dim', () => {
  // The gap between the tiers is deliberate: 'dim' says detections will suffer,
  // 'too-dark' says SLAM has no features to find. Making the stronger claim too
  // readily would tell someone in a merely dim room to stop scanning.
  assert.equal(lightingLevel(0.09), 'too-dark')
  assert.equal(lightingLevel(0.0), 'too-dark')
})

test('an unmeasurable luminance says nothing rather than crying dark', () => {
  // A canvas that would not read is not evidence of darkness. Fail open, the
  // same way analyseFrame() does when it cannot decode a blob at all.
  assert.equal(lightingLevel(Number.NaN), 'ok')
  assert.equal(lightingLevel(Number.POSITIVE_INFINITY), 'ok')
})

// ── motionHintText — one line, one decision ──────────────────────────────────

test('a dark room is told about light, not about moving slowly', () => {
  // The exact 19:40 state: too dark AND tracking lost.
  assert.equal(
    motionHintText({ lighting: 'too-dark', trackingLost: true, driftRisk: 'low' }),
    'Too dark to scan — turn on a light',
  )
})

test('light outranks every other signal, because nothing else matters until there is light', () => {
  assert.equal(
    motionHintText({ lighting: 'too-dark', trackingLost: false, driftRisk: 'high' }),
    'Too dark to scan — turn on a light',
  )
})

test('tracking lost in a merely dim room names both, light first', () => {
  assert.equal(
    motionHintText({ lighting: 'dim', trackingLost: true, driftRisk: 'low' }),
    'Tracking lost — add light, or move slowly',
  )
})

test('tracking lost in good light keeps the original advice unchanged', () => {
  // The pre-existing sentence is correct whenever light is not the problem, and
  // this change must not have cost it.
  assert.equal(
    motionHintText({ lighting: 'ok', trackingLost: true, driftRisk: 'low' }),
    'Tracking lost — move slowly',
  )
})

test('speed is only mentioned while tracking still works', () => {
  assert.equal(
    motionHintText({ lighting: 'ok', trackingLost: false, driftRisk: 'high' }),
    '⚠ Moving too fast — slow down',
  )
  // Lost tracking is the bigger problem and wins the line.
  assert.equal(
    motionHintText({ lighting: 'ok', trackingLost: true, driftRisk: 'high' }),
    'Tracking lost — move slowly',
  )
})

test('medium drift is not worth a line', () => {
  assert.equal(motionHintText({ lighting: 'ok', trackingLost: false, driftRisk: 'medium' }), '')
})

test('nothing wrong returns the empty string, so the caller hides the line', () => {
  // Not a placeholder sentence: stale advice left on screen is what made the
  // dark-room message so misleading in the first place.
  assert.equal(motionHintText({ lighting: 'ok', trackingLost: false, driftRisk: 'low' }), '')
})

test('a dim room that is tracking fine is not nagged on this line', () => {
  // 'dim' has its own badge (#quality-light-badge) and its own summary
  // recommendation; it does not need to occupy the motion hint as well.
  assert.equal(motionHintText({ lighting: 'dim', trackingLost: false, driftRisk: 'low' }), '')
})
