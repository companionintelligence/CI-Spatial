/**
 * The frame-set contract — the piece both capture paths converge on.
 *
 * The most important assertions here are about `choosePath`: a multi-clip take
 * whose members never measured each other must NOT be sliced as simultaneous,
 * because doing so feeds frames from different instants to the trainer as if
 * they were one and produces a smeared reconstruction with no error anywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestClip, choosePath, planFrameSets, planTimesteps } from '../stages/frameset.mjs'

const measured = (residualMs = 10, toleranceMs = 50) => ({
  method: 'measured', offsetMs: 0, residualMs, toleranceMs, sampleCount: 11,
})
const unsynced = { method: 'unsynced', reason: 'solo-take' }

test('planTimesteps derives count from duration and rate', () => {
  // 4.8s at 5fps ⇒ 24 timesteps, which is the documented worked example.
  assert.equal(planTimesteps({ durationMs: 4800, timestepFps: 5 }).length, 24)
  assert.equal(planTimesteps({ durationMs: 10000, timestepFps: 2 }).length, 20)
})

test('planTimesteps samples the middle of each interval, not the edge', () => {
  // The first and last frames of a clip are the likeliest to be blurred.
  const steps = planTimesteps({ durationMs: 1000, timestepFps: 2 })
  assert.deepEqual(steps.map(s => s.timeMs), [250, 750])
})

test('planTimesteps is empty for nonsense input rather than throwing', () => {
  assert.deepEqual(planTimesteps({ durationMs: 0, timestepFps: 5 }), [])
  assert.deepEqual(planTimesteps({ durationMs: 5000, timestepFps: 0 }), [])
})

test('planFrameSets emits every view at every timestep', () => {
  const views = [{ source: 'a.mp4' }, { source: 'b.mp4' }, { source: 'c.mp4' }]
  const sets = planFrameSets({ views, durationMs: 2000, timestepFps: 5 })
  assert.equal(sets.length, 10)
  for (const s of sets) assert.equal(s.views.length, 3)
})

test('a per-view offset shifts that view’s sample time', () => {
  // This is how a measured clock offset is applied: at slice time, never by
  // mutating a device clock.
  const views = [{ source: 'a.mp4' }, { source: 'b.mp4', offsetMs: -20 }]
  const [first] = planFrameSets({ views, durationMs: 1000, timestepFps: 1 })
  assert.equal(first.views[0].timeMs, 500)
  assert.equal(first.views[1].timeMs, 480)
})

test('a single clip densifies', () => {
  const d = choosePath([{ sync: unsynced }])
  assert.equal(d.viewSource, 'densified')
})

test('several synchronised clips skip 4DAnyone entirely', () => {
  const d = choosePath([{ sync: measured() }, { sync: measured() }, { sync: measured() }])
  assert.equal(d.viewSource, 'multi-camera')
  assert.match(d.reason, /3 synchronised/)
})

test('multi-clip WITHOUT a measured sync falls back to densify rather than mixing instants', () => {
  const d = choosePath([{ sync: unsynced }, { sync: unsynced }])
  assert.equal(d.viewSource, 'densified')
  assert.equal(d.degraded, true)
  assert.match(d.reason, /mix instants/)
})

test('a residual over tolerance also falls back, and says the numbers', () => {
  const d = choosePath([{ sync: measured(200, 50) }, { sync: measured(200, 50) }])
  assert.equal(d.viewSource, 'densified')
  assert.equal(d.degraded, true)
  assert.match(d.reason, /200ms/)
  assert.match(d.reason, /50ms/)
})

test('bestClip prefers a clip with a pose track, then the longest', () => {
  const clips = [
    { id: 'a', durationMs: 9000 },
    { id: 'b', durationMs: 5000, poseTrackUrl: '/p.json' },
    { id: 'c', durationMs: 6000, poseTrackUrl: '/p.json' },
  ]
  // A known camera path beats raw length.
  assert.equal(bestClip(clips).id, 'c')
  // With no pose tracks at all, length decides.
  assert.equal(bestClip([{ id: 'x', durationMs: 1000 }, { id: 'y', durationMs: 4000 }]).id, 'y')
  assert.equal(bestClip([]), null)
})
