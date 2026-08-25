/**
 * 4DAnyone's input rules, checked on the device.
 *
 * The interesting assertions are the ones about what is *not* claimed: motion
 * and subject-count cannot be checked here, and the result must say so rather
 * than implying a check passed.
 *
 * Run: npm run test:clip-validation
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIP_MIME_CANDIDATES,
  estimateFrames,
  extensionForMime,
  MIN_FRAMES,
  pickClipMimeType,
  validateClip,
} from '../../../src/capture/clip-validation.ts'

/** A clip that satisfies every rule: 1080×1920, 30fps, 5s ⇒ 150 frames. */
const good = { width: 1080, height: 1920, durationMs: 5000, fps: 30, hasArSession: true }

test('a conforming clip passes', () => {
  const r = validateClip(good, { medianSpeedMps: 0.3 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
  assert.equal(r.estimatedFrames, 150)
})

test('estimateFrames floors, and is zero for nonsense input', () => {
  assert.equal(estimateFrames(5000, 30), 150)
  assert.equal(estimateFrames(1000, 29.97), 29)
  assert.equal(estimateFrames(0, 30), 0)
  assert.equal(estimateFrames(5000, 0), 0)
  assert.equal(estimateFrames(NaN, 30), 0)
})

test('a clip below the frame floor is rejected, and the message names the real duration', () => {
  const r = validateClip({ ...good, durationMs: 3200 })
  assert.equal(r.ok, false)
  const problem = r.problems.find(p => p.code === 'too-short')
  assert.ok(problem)
  assert.match(problem.message, /3\.2s/)
  // The required minimum is expressed in seconds at this device's rate, not as
  // a raw frame count the user has no way to act on.
  assert.match(problem.message, /4\.0s/)
})

test('the frame floor is expressed at the actual fps, not assumed 30', () => {
  // 121 frames at 24fps needs 5.04s, so 4.5s must fail.
  const r = validateClip({ ...good, fps: 24, durationMs: 4500 })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some(p => p.code === 'too-short'))
  // ...and at 60fps the same 4.5s is plenty.
  const fast = validateClip({ ...good, fps: 60, durationMs: 4500 })
  assert.equal(fast.ok, true)
  assert.ok(fast.estimatedFrames >= MIN_FRAMES)
})

test('landscape is rejected, and says so in those words', () => {
  const r = validateClip({ ...good, width: 1920, height: 1080 })
  assert.equal(r.ok, false)
  const problem = r.problems.find(p => p.code === 'not-portrait')
  assert.ok(problem)
  assert.match(problem.message, /upright|landscape/i)
})

test('a portrait frame with the wrong aspect is still rejected', () => {
  // 3:4 portrait — upright, but not 9:16.
  const r = validateClip({ ...good, width: 1080, height: 1440 })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some(p => p.code === 'not-portrait'))
})

test('sub-720p is a blocking failure; 720p is an advisory only', () => {
  const low = validateClip({ ...good, width: 480, height: 854 })
  assert.equal(low.ok, false)
  assert.ok(low.problems.some(p => p.code === 'too-low-res'))

  const okay = validateClip({ ...good, width: 720, height: 1280 }, { medianSpeedMps: 0.2 })
  assert.equal(okay.ok, true, '720p meets the floor and must not block')
  assert.ok(okay.advisories.some(a => a.code === 'below-recommended-res'))
})

test('an empty recording is rejected without cascading other complaints', () => {
  const r = validateClip({ width: 0, height: 0, durationMs: 0, fps: 30, hasArSession: false })
  assert.equal(r.ok, false)
  assert.equal(r.problems.length, 1)
  assert.equal(r.problems[0].code, 'empty')
})

test('with no AR session, motion is reported as unmeasured rather than passing', () => {
  const r = validateClip({ ...good, hasArSession: false })
  // Still a usable clip — the single-clip densify path needs no pose track.
  assert.equal(r.ok, true)
  assert.ok(r.advisories.some(a => a.code === 'no-pose-track'))
  assert.ok(
    r.advisories.some(a => a.code === 'motion-unverifiable'),
    'an unmeasurable check must be reported as unmeasured, never silently passed',
  )
  assert.ok(!r.advisories.some(a => a.code === 'motion-high'))
})

test('measured excessive motion is an advisory, not a block', () => {
  const r = validateClip(good, { medianSpeedMps: 1.6 })
  assert.equal(r.ok, true, 'a clip the user cannot re-shoot must not be refused over motion')
  const advisory = r.advisories.find(a => a.code === 'motion-high')
  assert.ok(advisory)
  assert.match(advisory.message, /1\.6 m\/s/)
})

test('mime negotiation picks the first supported candidate', () => {
  assert.equal(pickClipMimeType(t => t === CLIP_MIME_CANDIDATES[0]), CLIP_MIME_CANDIDATES[0])
  // mp4 unavailable (older Chrome) ⇒ falls through to webm.
  assert.equal(pickClipMimeType(t => t.startsWith('video/webm')), 'video/webm;codecs=vp9')
})

test('mime negotiation returns null when nothing is supported', () => {
  // A real outcome on some browsers; it must surface, not half-start a recorder.
  assert.equal(pickClipMimeType(() => false), null)
})

test('extensionForMime maps container, not codec', () => {
  assert.equal(extensionForMime('video/mp4;codecs=avc1.42E01E'), 'mp4')
  assert.equal(extensionForMime('video/webm;codecs=vp9'), 'webm')
})
