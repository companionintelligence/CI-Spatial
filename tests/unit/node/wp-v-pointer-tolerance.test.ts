/**
 * The canvas click's drag tolerance depends on the pointer type (src/viewer/editor.ts).
 *
 * A finger or a pen drifts more than a mouse pointer, so a touch or pen press gets 12 CSS px.
 * A mouse press keeps 4 px. The viewer reads PointerEvent.pointerType when the press starts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v-pointer-tolerance.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAG_TOLERANCE_PX,
  TOUCH_DRAG_TOLERANCE_PX,
  dragToleranceFor,
  isDragRelease,
} from '../../../src/viewer/editor.ts'

test('touch and pen presses get about 12 px, and a mouse press keeps 4 px', () => {
  assert.equal(TOUCH_DRAG_TOLERANCE_PX, 12)
  assert.equal(dragToleranceFor('touch'), 12)
  assert.equal(dragToleranceFor('pen'), 12)
  assert.equal(DRAG_TOLERANCE_PX, 4)
  assert.equal(dragToleranceFor('mouse'), 4)
})

test('a pointer type that is not touch or pen keeps the mouse tolerance', () => {
  assert.equal(dragToleranceFor(''), DRAG_TOLERANCE_PX)
})

test('a finger tap that drifts about 10 px is still a click', () => {
  const tolerance = dragToleranceFor('touch')

  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 20, y: 10 }, tolerance), false, '10 px')
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 10, y: 22 }, tolerance), false, 'exactly 12 px')
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 10, y: 23 }, tolerance), true, 'beyond 12 px')
})

test('the same 10 px move made with a mouse is a drag', () => {
  assert.equal(isDragRelease({ x: 10, y: 10 }, { x: 20, y: 10 }, dragToleranceFor('mouse')), true)
})

test('a pen press that drifts 10 px diagonally is still a click', () => {
  assert.equal(isDragRelease({ x: 0, y: 0 }, { x: 6, y: 8 }, dragToleranceFor('pen')), false, '10 px diagonal')
})
