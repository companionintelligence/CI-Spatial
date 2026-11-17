/**
 * The 8th Wall provider keeps the engine's tracking reason next to its tracking status.
 *
 * 8th Wall publishes `trackingReason` beside `trackingStatus` on every reality frame, and documents the values
 * INITIALIZING and UNSPECIFIED for it (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule). The other
 * names this app handles (RELOCALIZING, TOO_MUCH_MOTION, NOT_ENOUGH_TEXTURE) are not in that documentation: they are
 * test inputs here, standing for whatever the engine reports, and DX4 logs which names a phone does. The provider read the
 * status and dropped the reason, so a session that went LIMITED could not say whether it was moving too fast, looking at
 * a blank wall, or relocalizing, and a relocalization (the one that can move the world frame) looked like any other dip.
 * The `?debug=probe` line (src/capture/probe-log.ts) records the reason at each tap, and the transition log names it,
 * so a run that saw a frame shift can say what tracking reported at the time. Nothing branches on it.
 *
 * `_syncReality` is the engine-facing step and is private, so the test reaches it through a view of the class,
 * with the browser globals the provider reads stubbed the way wp-c-camera-verdict.test.ts stubs them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tracking_reason.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'

;(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = {
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
}

/** The private step the engine's frames go through, as a test sees it. */
interface Frames {
  _syncReality(source: unknown, label: string, canvas: unknown): void
  getTrackingDiagnostics(): { status: string; poseJumps: number; lastJumpM: number; reason?: string }
  trackingStatus(): string
}

const frame = (extra: Record<string, unknown>) => ({
  position: { x: 0, y: 1.3, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  ...extra,
})

/**
 * The four fields this file is about. The frame-epoch tracker (src/ar/frame-epoch.ts) reports more beside them
 * (epoch, jump angle, limited time, motion statistics), which its own tests cover.
 */
const core = (d: { status: string; poseJumps: number; lastJumpM: number; reason?: string }) => ({
  status: d.status,
  poseJumps: d.poseJumps,
  lastJumpM: d.lastJumpM,
  ...('reason' in d ? { reason: d.reason } : {}),
})

function provider(): Frames {
  return new EighthWallProvider() as unknown as Frames
}

test('before any frame there is no reason, and the status is unknown', () => {
  const diagnostics = provider().getTrackingDiagnostics()
  assert.deepEqual(core(diagnostics), { status: 'UNKNOWN', poseJumps: 0, lastJumpM: 0 })
  assert.equal('reason' in diagnostics, false, 'absent, not an empty string a caller could print')
})

test('a frame with a status and a reason keeps both', (t) => {
  t.mock.method(console, 'log', () => {})
  const p = provider()
  p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: 'TOO_MUCH_MOTION' }) }, 'test', {})
  assert.deepEqual(core(p.getTrackingDiagnostics()), { status: 'LIMITED', poseJumps: 0, lastJumpM: 0, reason: 'TOO_MUCH_MOTION' })
  assert.equal(p.trackingStatus(), 'LIMITED')
})

test('the reason follows the engine from frame to frame, and goes when the engine stops giving one', (t) => {
  t.mock.method(console, 'log', () => {})
  const p = provider()
  p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: 'RELOCALIZING' }) }, 'test', {})
  assert.equal(p.getTrackingDiagnostics().reason, 'RELOCALIZING')
  p._syncReality({ reality: frame({ trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED' }) }, 'test', {})
  assert.deepEqual([p.getTrackingDiagnostics().status, p.getTrackingDiagnostics().reason], ['NORMAL', 'UNSPECIFIED'])
  p._syncReality({ reality: frame({ trackingStatus: 'NORMAL' }) }, 'test', {})
  assert.equal('reason' in p.getTrackingDiagnostics(), false, 'a frame with no reason leaves none behind')
})

test('a reason that is not text is no reason', (t) => {
  t.mock.method(console, 'log', () => {})
  for (const bad of [3, null, {}, ['TOO_MUCH_MOTION'], true]) {
    const p = provider()
    p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: bad }) }, 'test', {})
    assert.equal('reason' in p.getTrackingDiagnostics(), false, JSON.stringify(bad))
  }
})

test('the transition log names the reason, and a change of reason under the same status is a transition', (t) => {
  const lines: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  const p = provider()
  p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: 'NOT_ENOUGH_TEXTURE' }) }, 'test', {})
  p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: 'NOT_ENOUGH_TEXTURE' }) }, 'test', {})
  p._syncReality({ reality: frame({ trackingStatus: 'LIMITED', trackingReason: 'TOO_MUCH_MOTION' }) }, 'test', {})
  p._syncReality({ reality: frame({ trackingStatus: 'NORMAL' }) }, 'test', {})
  const transitions = lines.filter((line) => line.startsWith('[8thwall] trackingStatus:'))
  assert.deepEqual(transitions, [
    '[8thwall] trackingStatus: LIMITED (NOT_ENOUGH_TEXTURE)',
    '[8thwall] trackingStatus: LIMITED (TOO_MUCH_MOTION)',
    '[8thwall] trackingStatus: NORMAL',
  ], 'one line per change, and none for a repeat')
})
