/**
 * isDragRelease(): decides whether a canvas click follows a drag (src/viewer/editor.ts).
 *
 * OrbitControls captures the pointer, so a drag that ends on the canvas still fires a
 * click. The viewer records the press position and skips the pick when the pointer moved
 * farther than DRAG_TOLERANCE_PX (see the F84 audit finding).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-d-click-drag.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAG_TOLERANCE_PX, isDragRelease } from '../../../src/viewer/editor.ts'

test('the tolerance is 4 CSS px', () => {
  assert.equal(DRAG_TOLERANCE_PX, 4)
})

test('a click with no recorded press is not a drag', () => {
  assert.equal(isDragRelease(null, { x: 100, y: 100 }), false)
})

test('a release within the tolerance is a click', () => {
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 10, y: 10 }), false)
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 12, y: 12 }), false, 'about 2.8 px')
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 14, y: 10 }), false, 'exactly 4 px')
})

test('a release farther than the tolerance is a drag', () => {
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 15, y: 10 }), true, '5 px')
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 13, y: 14 }), true, '5 px diagonal')
  assert.equal(isDragRelease({ x: 0, y: 0 }, { x: 0, y: -40 }), true, 'a full orbit flick')
})

test('a caller can tighten the tolerance', () => {
  assert.equal(isDragRelease({ x: 0, y: 0 }, { x: 3, y: 0 }, 2), true)
  assert.equal(isDragRelease({ x: 0, y: 0 }, { x: 3, y: 0 }), false)
})
