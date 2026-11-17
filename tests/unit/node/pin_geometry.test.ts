/**
 * Pin placement under a letterboxed camera canvas.
 *
 * Under the `contain` fit the camera canvas is smaller than the viewport on one axis. A pin
 * must sit on its object at the canvas edges, not at the window edges. The old mapping used the
 * whole window, so a 9:16 frame in a 390x844 viewport drifted by tens of pixels at the top and
 * bottom. These tests pin the mapping, and the fallback that must stay identical to the old one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cameraViewRect, ndcToScreen } from '../../../src/ui/pin-geometry.ts'

const viewport = { width: 390, height: 844 }
// A 4:3 camera frame fitted into the width: 390 x 292.5, centred vertically.
const letterboxed = { left: 0, top: 275.75, width: 390, height: 292.5 }

test('the centre of the camera image maps to the centre of the canvas, not the window', () => {
  const p = ndcToScreen(0, 0, letterboxed)
  assert.equal(p.x, 195)
  assert.equal(p.y, 275.75 + 146.25)
})

test('the top and bottom edges of the image map to the canvas edges, not the window edges', () => {
  const top = ndcToScreen(0, 1, letterboxed)
  const bottom = ndcToScreen(0, -1, letterboxed)
  assert.equal(top.y, 275.75)
  assert.equal(bottom.y, 275.75 + 292.5)
  // The old full-window mapping would have put the top edge at y = 0.
  assert.ok(top.y > 200, 'the top edge must not sit at the top of the window')
})

test('left and right edges map to the canvas sides', () => {
  const offset = { left: 40, top: 0, width: 300, height: 844 }
  assert.equal(ndcToScreen(-1, 0, offset).x, 40)
  assert.equal(ndcToScreen(1, 0, offset).x, 340)
})

test('with no canvas, the mapping is the old full-window mapping, unchanged', () => {
  const rect = cameraViewRect(null, viewport)
  assert.deepEqual(rect, { left: 0, top: 0, width: 390, height: 844 })
  for (const [nx, ny] of [[0, 0], [1, 1], [-1, -1], [0.5, -0.25]]) {
    const p = ndcToScreen(nx, ny, rect)
    assert.equal(p.x, ((nx + 1) / 2) * 390)
    assert.equal(p.y, ((-ny + 1) / 2) * 844)
  }
})

test('a canvas that has no size yet falls back to the whole viewport', () => {
  const rect = cameraViewRect({ left: 0, top: 0, width: 0, height: 0 }, viewport)
  assert.deepEqual(rect, { left: 0, top: 0, width: 390, height: 844 })
})

test('a canvas that fills the viewport gives the same screen position as the window', () => {
  const full = cameraViewRect({ left: 0, top: 0, width: 390, height: 844 }, viewport)
  const p = ndcToScreen(0.3, -0.6, full)
  assert.equal(p.x, ((0.3 + 1) / 2) * 390)
  assert.equal(p.y, ((0.6 + 1) / 2) * 844)
})
