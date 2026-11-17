/**
 * The scanner stamps each tick with the frame epoch the points and the pose were read in
 * (WP-09), so the cloud can file them under it.
 *
 * Read in the same synchronous tick as the points: a provider that starts a new epoch drops
 * the points it had not yet handed over, so what the scanner drains and the epoch it reads
 * are the same epoch.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_scanner.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_INTERVAL_MS, RoomScanner, type ScanFrame } from '../../../src/ar/scanner.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'

const POSE = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

/** A provider that hands out `points` once per drain, and reports `epoch` when asked, if it has a signal at all. */
function provider(opts: { epoch?: () => number; points?: () => Array<{ x: number; y: number; z: number }> }): ARProvider {
  return {
    featurePoints: () => opts.points?.() ?? [{ x: 1, y: 0, z: -2 }],
    getPose: () => POSE,
    ...(opts.epoch ? { getFrameEpoch: opts.epoch } : {}),
  } as unknown as ARProvider
}

function run(t: { mock: { timers: { enable(o: { apis: string[] }): void; tick(ms: number): void } } }, p: ARProvider, ticks: number): ScanFrame[] {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const frames: ScanFrame[] = []
  const scanner = new RoomScanner()
  scanner.start(p, (f) => frames.push(f))
  for (let i = 0; i < ticks; i++) t.mock.timers.tick(DEFAULT_INTERVAL_MS)
  scanner.stop()
  return frames
}

test('each scanner frame carries the epoch the provider is in when the tick drains its points', (t) => {
  let epoch = 0
  const frames: ScanFrame[] = []
  t.mock.timers.enable({ apis: ['setInterval'] })
  const scanner = new RoomScanner()
  scanner.start(provider({ epoch: () => epoch }), (f) => frames.push(f))
  t.mock.timers.tick(DEFAULT_INTERVAL_MS)
  epoch = 2
  t.mock.timers.tick(DEFAULT_INTERVAL_MS)
  scanner.stop()
  assert.deepEqual(frames.map((f) => f.epoch), [0, 2])
  assert.equal(frames.length, 2)
})

test('a provider with no epoch signal gives epoch 0 on every frame', (t) => {
  const frames = run(t, provider({}), 3)
  assert.deepEqual(frames.map((f) => f.epoch), [0, 0, 0])
})

test('a provider that answers with nonsense gives epoch 0', (t) => {
  const frames = run(t, provider({ epoch: () => Number.NaN }), 1)
  assert.deepEqual(frames.map((f) => f.epoch), [0])
})

test('the frame still carries the points and the pose it always did', (t) => {
  const [frame] = run(t, provider({ epoch: () => 1 }), 1)
  assert.deepEqual(frame.points, [{ x: 1, y: 0, z: -2 }])
  assert.deepEqual(frame.pose, POSE)
  assert.equal(typeof frame.timestampMs, 'number')
})
