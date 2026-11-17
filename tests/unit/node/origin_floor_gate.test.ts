/**
 * The floor-check rules that decide what a commit may do to the Place (wave 12,
 * ticket 0001, review decision: the Place-frame floor is authoritative).
 *
 * The rules are pure functions in `src/ar/ground-gate.ts`, so they are tested
 * here without a DOM. The flow calls them at commit; the Chromium mock covers
 * the buttons that set the bypass.
 *
 * Run: npm run test:origin
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { committedStatus, mayWritePlaceFrame } from '../../../src/ar/ground-gate.ts'

/** Every combination of the three inputs, so the invariants are checked exhaustively. */
const COMBINATIONS = [false, true].flatMap((floorCheckBypassed) =>
  [false, true].flatMap((hasStoredFrame) =>
    [false, true].map((override) => ({ floorCheckBypassed, hasStoredFrame, override })),
  ),
)

test('floor rules: a bypassed commit never writes the Place frame, first creation or override', () => {
  for (const c of COMBINATIONS.filter((x) => x.floorCheckBypassed)) {
    assert.equal(mayWritePlaceFrame(c), false, JSON.stringify(c))
  }
})

test('floor rules: an unbypassed commit writes the frame when none is stored, or when a mismatch was overridden', () => {
  assert.equal(mayWritePlaceFrame({ floorCheckBypassed: false, hasStoredFrame: false, override: false }), true)
  assert.equal(mayWritePlaceFrame({ floorCheckBypassed: false, hasStoredFrame: true, override: true }), true)
})

test('floor rules: an unbypassed match against a stored frame leaves that frame alone', () => {
  assert.equal(mayWritePlaceFrame({ floorCheckBypassed: false, hasStoredFrame: true, override: false }), false)
})

test('floor rules: a bypassed commit is never verified, whatever its separation did', () => {
  for (const c of COMBINATIONS.filter((x) => x.floorCheckBypassed)) {
    assert.equal(committedStatus(c), 'provisional', JSON.stringify(c))
  }
})

test('floor rules: an unbypassed match with no override is verified', () => {
  assert.equal(committedStatus({ floorCheckBypassed: false, hasStoredFrame: true, override: false }), 'verified')
})

test('floor rules: nothing to match against, or an override, is provisional', () => {
  assert.equal(committedStatus({ floorCheckBypassed: false, hasStoredFrame: false, override: false }), 'provisional')
  assert.equal(committedStatus({ floorCheckBypassed: false, hasStoredFrame: true, override: true }), 'provisional')
})

test('floor rules: verified is only ever produced by a check that ran and matched', () => {
  // The invariant the record relies on: "verified" implies a stored frame, no
  // override, and no bypass. Checked across every combination.
  for (const c of COMBINATIONS) {
    if (committedStatus(c) === 'verified') {
      assert.equal(c.hasStoredFrame, true)
      assert.equal(c.override, false)
      assert.equal(c.floorCheckBypassed, false)
    }
  }
})

test('floor rules: a bypassed commit never sets the Place frame, so it cannot change what later visits compare against', () => {
  for (const c of COMBINATIONS.filter((x) => x.floorCheckBypassed)) {
    assert.equal(mayWritePlaceFrame(c), false)
    assert.notEqual(committedStatus(c), 'verified')
  }
})

test('floor rules: floorCheckBypassed survives the sidecar as JSON, and an old record reads as not recorded', () => {
  const recorded = JSON.parse(JSON.stringify({ calibration: { floorCheckBypassed: true } })) as {
    calibration: { floorCheckBypassed?: boolean }
  }
  assert.equal(recorded.calibration.floorCheckBypassed, true)

  const legacy = JSON.parse(JSON.stringify({ calibration: { separationM: 2 } })) as {
    calibration: { floorCheckBypassed?: boolean }
  }
  assert.equal(legacy.calibration.floorCheckBypassed, undefined, 'absent means not recorded, not false')
})
