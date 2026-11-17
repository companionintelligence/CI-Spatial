/**
 * The marks the calibration flow draws on the floor besides its markers (WP-07): the ring at a stored point's distance and
 * the floor grid that outlives the flow. src/ar/calibration-guides.ts, and the ring arithmetic it shares with the anchor
 * decal, `ringVertices` in src/world/anchor-marker.ts.
 *
 * The ring arithmetic was inline in `buildAnchorMarker` and is now a function both rings call, so the one thing to hold
 * is that the decal's ring did not change: its vertices are compared, bit for bit, with the loop it was extracted from,
 * written out again here from the old file's text. The distance ring is then held to geometry that does not borrow
 * anything from the code under test: every vertex on the circle, in the floor plane, closed, and as round as a line on
 * the floor needs to be.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-guides.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  DISTANCE_RING_COLOR,
  DISTANCE_RING_NAME,
  DISTANCE_RING_OPACITY,
  KEPT_GRID_OPACITY,
  buildDistanceRing,
  keepFloorGrid,
} from '../../../src/ar/calibration-guides.ts'
import { ANCHOR_RADIUS_M, buildAnchorMarker, ringVertices } from '../../../src/world/anchor-marker.ts'

/** The loop `buildAnchorMarker` carried before `ringVertices` was taken out of it, as that file spelled it. */
function oldInlineRing(): number[] {
  const segments = 48
  const verts: number[] = []
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    verts.push(
      Math.cos(a0) * ANCHOR_RADIUS_M, 0, Math.sin(a0) * ANCHOR_RADIUS_M,
      Math.cos(a1) * ANCHOR_RADIUS_M, 0, Math.sin(a1) * ANCHOR_RADIUS_M,
    )
  }
  return verts
}

// ── The shared ring arithmetic ────────────────────────────────────────────────────────────────────

test('the anchor decal\'s ring is the vertices it always was: ringVertices at the anchor radius is the old inline loop, bit for bit', () => {
  assert.deepEqual(ringVertices(ANCHOR_RADIUS_M), oldInlineRing())
  assert.deepEqual(ringVertices(ANCHOR_RADIUS_M, 48), oldInlineRing())
  const decal = buildAnchorMarker(null)
  const ring = decal.getObjectByName('anchor ring') as THREE.LineSegments
  const stored = Array.from(ring.geometry.getAttribute('position').array as Float32Array)
  assert.deepEqual(stored, Array.from(new Float32Array(oldInlineRing())), 'the geometry a decal is built with')
})

test('a ring is two points to a segment, closed, flat, and every point is the radius from the centre', () => {
  for (const [radius, segments] of [[0.35, 48], [3.2, 96], [7.75, 12]] as const) {
    const verts = ringVertices(radius, segments)
    assert.equal(verts.length, segments * 2 * 3)
    for (let i = 0; i < verts.length; i += 3) {
      assert.equal(verts[i + 1], 0, 'flat')
      near(Math.hypot(verts[i]!, verts[i + 2]!), radius, 1e-12, `vertex ${i / 3}`)
    }
    // Each segment ends where the next begins, and the last returns to the first.
    for (let s = 0; s < segments; s++) {
      const end = (s * 6) + 3
      const next = ((s + 1) % segments) * 6
      near(verts[end]!, verts[next]!, 1e-12)
      near(verts[end + 2]!, verts[next + 2]!, 1e-12)
    }
  }
})

function near(actual: number, expected: number, tolerance: number, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not ${expected} (within ${tolerance})`)
}

// ── The distance ring ─────────────────────────────────────────────────────────────────────────────

test('a distance ring is named for the scene, lies on the floor round its own origin, and is as long as a circle of that radius', () => {
  const ring = buildDistanceRing(3.2)
  assert.equal(ring.name, DISTANCE_RING_NAME)
  assert.equal(DISTANCE_RING_NAME, 'calibration distance ring')
  const p = ring.geometry.getAttribute('position')
  let length = 0
  let worstSagitta = 0
  for (let i = 0; i < p.count; i += 2) {
    near(p.getY(i), 0, 0, 'flat')
    near(Math.hypot(p.getX(i), p.getZ(i)), 3.2, 1e-5, 'on the circle')
    const chord = Math.hypot(p.getX(i + 1) - p.getX(i), p.getZ(i + 1) - p.getZ(i))
    length += chord
    // How far the middle of the chord is inside the circle: the most the line can sit off the true ring.
    worstSagitta = Math.max(worstSagitta, 3.2 - Math.hypot((p.getX(i) + p.getX(i + 1)) / 2, (p.getZ(i) + p.getZ(i + 1)) / 2))
  }
  near(length, 2 * Math.PI * 3.2, 0.01, 'circumference')
  assert.ok(worstSagitta < 0.002, `a 3.2 m ring is within ${(worstSagitta * 1000).toFixed(2)} mm of round`)
})

test('a distance ring moves with its position: put at a landmark it is centred there', () => {
  const ring = buildDistanceRing(2)
  ring.position.set(1.5, -1.2, 4)
  ring.updateMatrixWorld(true)
  const centre = new THREE.Box3().setFromObject(ring).getCenter(new THREE.Vector3())
  near(centre.x, 1.5, 1e-5)
  near(centre.y, -1.2, 1e-5)
  near(centre.z, 4, 1e-5)
})

test('a distance ring is drawn to be seen: a line, solid, and not in the grid\'s colour, which would make it a brighter curve of the grid', () => {
  const ring = buildDistanceRing(3.2)
  const material = ring.material as THREE.LineBasicMaterial
  assert.ok(material instanceof THREE.LineBasicMaterial, 'a line, like the grid and the decals: no new kind of mark')
  assert.equal(material.transparent, true)
  assert.equal(material.opacity, DISTANCE_RING_OPACITY)
  assert.ok(DISTANCE_RING_OPACITY >= 0.8, 'about as solid as the decal\'s ring, which it is read beside')
  assert.equal(material.color.getHex(), DISTANCE_RING_COLOR)
  // The grid helper keeps its colour in its vertices, not in its material: it is the teal it was built with.
  const { grid } = gridInPlacement()
  const teal = new THREE.Color(0x72ddd4)
  const vertex = grid.geometry.getAttribute('color')
  teal.toArray().forEach((channel, i) => near([vertex.getX(0), vertex.getY(0), vertex.getZ(0)][i]!, channel, 1e-6, 'the grid the flow builds is the overlay\'s teal'))
  assert.equal(material.color.equals(teal), false, 'and the ring is not')
  assert.ok(material.opacity > (grid.material as THREE.Material).opacity, 'and more solid than the grid it lies on')
})

// ── The floor grid that stays ─────────────────────────────────────────────────────────────────────

function gridInPlacement() {
  const scene = new THREE.Scene()
  const placement = new THREE.Group()
  placement.name = 'calibration placement'
  scene.add(placement)
  const grid = new THREE.GridHelper(10, 20, 0x72ddd4, 0x72ddd4)
  grid.name = 'calibration floor plane'
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.4
  grid.position.set(1, -1.2, 2)
  placement.add(grid)
  return { scene, placement, grid }
}

test('the kept grid is handed to the scene: it survives its placement group being removed, fainter, where it was', () => {
  const { scene, placement, grid } = gridInPlacement()
  const kept = keepFloorGrid(scene, grid, placement)
  assert.equal(kept, null, 'the flow no longer holds it, so its teardown leaves it alone')
  assert.equal(grid.parent, scene)
  assert.ok(!placement.children.includes(grid))
  assert.equal((grid.material as THREE.Material).opacity, KEPT_GRID_OPACITY)
  assert.ok(KEPT_GRID_OPACITY < 0.4, 'fainter than while the markers were being placed')
  assert.deepEqual([grid.position.x, grid.position.y, grid.position.z], [1, -1.2, 2])

  scene.remove(placement)
  assert.equal(scene.getObjectByName('calibration floor plane'), grid, 'still in the scene after the flow\'s own group is gone')
})

test('with no scene to give it to, or no grid, the flow keeps what it had, and disposes it with the rest', () => {
  const { placement, grid } = gridInPlacement()
  assert.equal(keepFloorGrid(null, grid, placement), grid)
  assert.equal(grid.parent, placement, 'not moved')
  assert.equal((grid.material as THREE.Material).opacity, 0.4, 'not changed')
  const scene = new THREE.Scene()
  assert.equal(keepFloorGrid(scene, null, placement), null)
  assert.equal(scene.children.length, 0)
})
