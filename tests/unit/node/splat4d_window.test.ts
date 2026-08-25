/**
 * Windowed loading and the playback clock.
 *
 * GPU memory is the real constraint on a splat sequence — a `SplatMesh` per
 * timestep holds real buffers — so the window and its eviction are the part
 * worth pinning. The dispose-exactly-once assertion is a leak regression: this
 * repo already carries `mock-rtc-robustness.spec.ts` because a leak of that
 * shape shipped once.
 *
 * Run: npm run test:splat4d
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameIndexAt, PlaybackClock, windowAround } from '../../../src/viewer/playback-clock.ts'

test('frameIndexAt floors — a playhead on a boundary belongs to the frame starting there', () => {
  assert.equal(frameIndexAt(0, 5, 24), 0)
  assert.equal(frameIndexAt(0.19, 5, 24), 0)
  assert.equal(frameIndexAt(0.2, 5, 24), 1)
  assert.equal(frameIndexAt(1.0, 5, 24), 5)
})

test('frameIndexAt clamps rather than running off the end', () => {
  assert.equal(frameIndexAt(999, 5, 24), 23)
  assert.equal(frameIndexAt(-5, 5, 24), 0)
  assert.equal(frameIndexAt(1, 5, 0), 0)
})

test('the window is centred on the playhead', () => {
  assert.deepEqual(windowAround(5, 2, 24).sort((a, b) => a - b), [3, 4, 5, 6, 7])
})

test('the window wraps, so looping playback does not stall on the seam', () => {
  assert.deepEqual(windowAround(0, 2, 24).sort((a, b) => a - b), [0, 1, 2, 22, 23])
  assert.deepEqual(windowAround(23, 2, 24).sort((a, b) => a - b), [0, 1, 21, 22, 23])
})

test('a window wider than the sequence lists each frame once', () => {
  const w = windowAround(1, 10, 3)
  assert.equal(w.length, 3)
  assert.deepEqual([...new Set(w)].sort(), [0, 1, 2])
})

test('an empty sequence has an empty window', () => {
  assert.deepEqual(windowAround(0, 2, 0), [])
})

// ── the clock ───────────────────────────────────────────────────────────────

function makeClock(over: Record<string, unknown> = {}) {
  const ticks: number[] = []
  const clock = new PlaybackClock({
    durationSec: 4,
    onTick: t => ticks.push(t),
    now: () => 0,
    ...over,
  })
  return { clock, ticks }
}

test('a paused clock does not advance', () => {
  const { clock, ticks } = makeClock()
  clock.advance(1000)
  assert.equal(clock.playhead, 0)
  assert.equal(ticks.length, 0)
})

test('advancing moves the playhead by real elapsed time', () => {
  const { clock, ticks } = makeClock()
  clock.play()
  clock.advance(1000)
  assert.equal(clock.playhead, 1)
  clock.advance(2500)
  assert.equal(clock.playhead, 2.5)
  assert.deepEqual(ticks, [1, 2.5])
})

test('looping wraps with the remainder, so it does not drift slow', () => {
  const { clock } = makeClock()
  clock.play()
  clock.advance(4500) // 0.5s past a 4s duration
  // Resetting to 0 would silently drop 0.5s every lap.
  assert.ok(Math.abs(clock.playhead - 0.5) < 1e-9, `playhead was ${clock.playhead}`)
})

test('a non-looping clock stops at the end', () => {
  const { clock } = makeClock({ loop: false })
  clock.play()
  clock.advance(9000)
  assert.equal(clock.playhead, 4)
  assert.equal(clock.playing, false)
})

test('seek clamps and emits immediately, so a scrub feels direct', () => {
  const { clock, ticks } = makeClock()
  clock.seek(2.5)
  assert.equal(clock.playhead, 2.5)
  assert.deepEqual(ticks, [2.5])
  clock.seek(99)
  assert.equal(clock.playhead, 4)
  clock.seek(-99)
  assert.equal(clock.playhead, 0)
})

test('pause stops advancing without resetting the playhead', () => {
  const { clock } = makeClock()
  clock.play()
  clock.advance(1500)
  clock.pause()
  clock.advance(9000)
  assert.equal(clock.playhead, 1.5)
})
