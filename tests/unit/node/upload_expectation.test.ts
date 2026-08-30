/**
 * Pre-upload expectation copy — src/capture/upload-expectation.ts.
 *
 * The thing under test is a claim, not a computation: an uploaded video
 * rebuilds the room and places nothing in it (measured — 48/48 frames
 * registered, 12,430 points, 38.5 MB splat, and 0 of 29 candidate objects
 * placed, because video keyframes carry no record of where the camera was).
 * These tests hold the copy to saying that before the upload, in words that do
 * not require knowing what any of the machinery is, and to not recommending a
 * live scan on a device already found unable to run one.
 *
 * Run: npm run test:upload:expectation
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UPLOAD_RESULT_NOTE,
  uploadExpectation,
  uploadExpectationLine,
  type ScanCapability,
} from '../../../src/capture/upload-expectation.ts'

const ALL: ScanCapability[] = ['available', 'unavailable', 'unknown']

test('every verdict says the upload builds the room AND that it places nothing', () => {
  // Both halves, always. "Builds a 3D reconstruction" alone is the sentence
  // that was already on the start card and is what sent someone off to wait
  // for a furniture list that was never coming; "cannot place objects" alone
  // would read as a failure notice for a path that works.
  for (const scan of ALL) {
    const copy = uploadExpectation(scan)
    assert.match(copy.builds, /3D/, `${scan}: must name what it does build`)
    assert.match(copy.limit, /cannot|not/i, `${scan}: must name what it does not`)
    assert.match(copy.limit, /furniture|objects/i, `${scan}: the limit must be about things`)
  }
})

test('a device that can scan is told scanning is the way to place objects', () => {
  const copy = uploadExpectation('available')
  assert.match(copy.alternative, /walking the room with this phone/i)
  // Uploading is a legitimate choice, so the alternative must read as "and
  // also", not as "you should have done this instead".
  assert.match(copy.alternative, /upload now/i)
})

test('a device that cannot scan is not told to scan instead', () => {
  // The XREAL Beam Pro case (src/ar/preflight.ts): AR is advertised, no AR
  // service exists behind it, and no amount of retrying changes that. Telling
  // that user to walk the room with the phone is advice they cannot take.
  const copy = uploadExpectation('unavailable')
  assert.match(copy.alternative, /this device cannot/i)
  assert.doesNotMatch(
    copy.alternative,
    /(walk|scan) the room with this phone/i,
    'must not recommend the one thing this device has already been found unable to do',
  )
})

test('an unsettled verdict claims nothing about this device', () => {
  // wireContentUpload() runs before the secure-context check and long before
  // an AR runtime exists, so a fast tap lands here. The copy may describe the
  // method; it may not describe the phone in the user's hand.
  const copy = uploadExpectation('unknown')
  assert.doesNotMatch(copy.alternative, /this device|this phone/i)
  assert.match(copy.alternative, /walking a room with a phone/i)
})

test('no verdict prints implementation vocabulary at the user', () => {
  // Same rule the startup budget spec applies to onboarding copy, applied to
  // the copy one tap further in. 'no-pose' in particular is the internal
  // refusal reason and must never reach a screen.
  const banned = [
    'pose', 'SfM', 'COLMAP', 'parallax', 'VIO', 'SLAM', 'keyframe', 'segment',
    'pipeline', 'job', 'metric scale', 'panoptic', 'splat', 'no-pose',
  ]
  for (const scan of ALL) {
    const copy = uploadExpectation(scan)
    const all = `${copy.title} ${copy.builds} ${copy.limit} ${copy.alternative}`
    for (const term of banned) {
      assert.doesNotMatch(all, new RegExp(term, 'i'), `${scan}: copy must not say "${term}"`)
    }
  }
  assert.doesNotMatch(UPLOAD_RESULT_NOTE, /pose|splat|panoptic|job/i)
})

test('the one-line form carries the whole verdict, in order', () => {
  // #upload-video-progress is a single centred paragraph with no room for a
  // heading, so if the line dropped a part there would be nowhere else for it.
  for (const scan of ALL) {
    const copy = uploadExpectation(scan)
    const line = uploadExpectationLine(scan)
    assert.ok(line.includes(copy.builds), `${scan}: line drops what it builds`)
    assert.ok(line.includes(copy.limit), `${scan}: line drops the limit`)
    assert.ok(line.includes(copy.alternative), `${scan}: line drops the alternative`)
    assert.ok(
      line.indexOf(copy.builds) < line.indexOf(copy.limit),
      `${scan}: what the upload builds must lead — it is the reason to do it`,
    )
    // The heading is a dialog affordance; repeating it inline would read as a
    // stray sentence fragment.
    assert.ok(!line.includes(copy.title))
  }
})

test('the finished-upload note stays short enough for the result line', () => {
  // It is appended to "Uploaded — N keyframes extracted." in a 380 px centred
  // block; measured at 65 characters, and a paragraph there would be skipped.
  assert.ok(
    UPLOAD_RESULT_NOTE.length <= 80,
    `result note is ${UPLOAD_RESULT_NOTE.length} chars, budget 80`,
  )
  assert.match(UPLOAD_RESULT_NOTE, /objects are not placed/i)
})
