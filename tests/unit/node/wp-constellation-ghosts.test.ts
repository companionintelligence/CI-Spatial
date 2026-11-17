/**
 * The ghosts of a Place's stored points as they are drawn into the live scene (src/ar/constellation-ghosts.ts, WP-04b).
 *
 *  1. WHAT IS DRAWN. One dim ring per ghost, named as the stored pair's ring was named, carrying the point's role and its
 *     residual in centimetres; and, for a point that is a millimetre or more off, a line from the marker to the ring whose length
 *     is that residual. A point compared by distance has no residual and no line.
 *  2. THE LIVE LAYER. It follows a re-tap by redrawing, and does not rebuild what has not moved (the modal redraws every 200 ms);
 *     it clears on request, when there is nothing to show, when the scene is not there yet, and moves with the scene it is
 *     given. What it removes it disposes, so a long calibration does not leak geometry.
 *  3. THE SCENE IS THE FLOW'S. What the layer draws from a real comparison is where the stored points land in this session
 *     (the inverse of the visit's own matrix) and the lines are the residuals the card prints: the two cannot disagree.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-constellation-ghosts.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import {
  GHOST_GAP_NAME,
  GHOST_NAME,
  createGhostLayer,
  drawStoredConstellation,
} from '../../../src/ar/constellation-ghosts.ts'
import { compareVisit, ghostPlan, type GhostPoint, type VisitPoints } from '../../../src/ar/constellation-flow.ts'
import type { TwoPointFrame } from '../../../src/ar/calibration-commit.ts'
import { buildAnchorMarker } from '../../../src/world/anchor-marker.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { transformPoint } from '../../../src/world/geo.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const ghost = (role: GhostPoint['role'], tap: Vec3, at: Vec3, residualM: number | null): GhostPoint => ({ role, tap, ghost: at, residualM })

const GHOSTS: GhostPoint[] = [
  ghost('landmark', { x: 1, y: -1.2, z: 2 }, { x: 1.03, y: -1.2, z: 2.04 }, 0.05),
  ghost('heading', { x: 1, y: -1.2, z: 5.5 }, { x: 1, y: -1.2, z: 5.5 }, 0.0004),
  ghost('check', { x: -1.6, y: -1.2, z: 3 }, { x: -1.7, y: -1.2, z: 3.1 }, null),
]

const named = (objects: readonly THREE.Object3D[], name: string): THREE.Object3D[] => objects.filter((o) => o.name === name)

// ── 1. What is drawn ─────────────────────────────────────────────────────────────────────────────────

test('a ring for every ghost, at the ghost, named as the stored pair\'s ring was and carrying its role and residual', () => {
  assert.equal(GHOST_NAME, 'calibration stored reference')
  assert.equal(GHOST_GAP_NAME, 'calibration stored reference gap')
  const parent = new THREE.Group()
  const added = drawStoredConstellation(parent, GHOSTS)
  const rings = named(added, GHOST_NAME)
  assert.equal(rings.length, 3)
  rings.forEach((ring, index) => {
    const want = GHOSTS[index]!
    assert.deepEqual([ring.position.x, ring.position.y, ring.position.z], [want.ghost.x, want.ghost.y, want.ghost.z])
    assert.equal(ring.userData.role, want.role)
    assert.equal(ring.userData.residualCm, want.residualM === null ? null : want.residualM * 100)
    assert.equal(ring.parent, parent)
  })
  // Everything that was added is under the parent, and nothing else is.
  assert.deepEqual(parent.children, added)
})

test('the ring is the anchor decal without its north tick: the same marker the scene already draws, dimmed', () => {
  const [ring] = named(drawStoredConstellation(new THREE.Group(), GHOSTS.slice(0, 1)), GHOST_NAME)
  const decal = buildAnchorMarker(null)
  assert.equal(ring!.children.length, decal.children.length)
  assert.deepEqual(ring!.children.map((c) => c.type), decal.children.map((c) => c.type))
})

test('a point a millimetre or more off has a line to its ring, as long as the residual; one that agrees to the millimetre has none', () => {
  const added = drawStoredConstellation(new THREE.Group(), GHOSTS)
  const lines = named(added, GHOST_GAP_NAME)
  // The landmark (5 cm) has one. The heading marker (0.4 mm) is inside the display floor, and the check point has no residual.
  assert.equal(lines.length, 1)
  const line = lines[0] as THREE.Line
  assert.equal(line.userData.role, 'landmark')
  assert.ok(Math.abs(line.userData.residualCm - 5) < 1e-9)
  const at = line.geometry.getAttribute('position')
  assert.equal(at.count, 2)
  // From the marker to the ring, in that order: the line starts where the person tapped and ends where the Place says it is.
  const [a, b] = [new THREE.Vector3().fromBufferAttribute(at, 0), new THREE.Vector3().fromBufferAttribute(at, 1)]
  assert.ok(a.distanceTo(new THREE.Vector3(1, -1.2, 2)) < 1e-5, 'starts at the marker')
  assert.ok(b.distanceTo(new THREE.Vector3(1.03, -1.2, 2.04)) < 1e-5, 'ends at the ring')
  assert.ok(Math.abs(a.distanceTo(b) - 0.05) < 1e-5, 'as long as the residual')
})

test('a millimetre is the floor: just under draws no line, exactly that draws one', () => {
  const at = (gap: number) => ghost('landmark', { x: 0, y: 0, z: 0 }, { x: gap, y: 0, z: 0 }, gap)
  assert.equal(named(drawStoredConstellation(new THREE.Group(), [at(0.00099)]), GHOST_GAP_NAME).length, 0)
  assert.equal(named(drawStoredConstellation(new THREE.Group(), [at(0.001)]), GHOST_GAP_NAME).length, 1)
  // Arithmetic noise from a fit of points that agree is not geometry, and neither is a figure that is not a number.
  assert.equal(named(drawStoredConstellation(new THREE.Group(), [at(1e-16)]), GHOST_GAP_NAME).length, 0)
  assert.equal(named(drawStoredConstellation(new THREE.Group(), [at(Number.NaN)]), GHOST_GAP_NAME).length, 0)
  assert.equal(named(drawStoredConstellation(new THREE.Group(), [ghost('check', { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, null)]), GHOST_GAP_NAME).length, 0)
})

test('no ghosts draws nothing and adds nothing', () => {
  const parent = new THREE.Group()
  assert.deepEqual(drawStoredConstellation(parent, []), [])
  assert.equal(parent.children.length, 0)
})

// ── 2. The live layer ────────────────────────────────────────────────────────────────────────────────

/** Counts the dispose calls of every geometry and material under the objects, so a removal can be seen to release them. */
function spyOnDisposal(objects: readonly THREE.Object3D[]): { disposed: () => number; total: number } {
  let count = 0
  let total = 0
  for (const object of objects) {
    object.traverse((child) => {
      const drawable = child as Partial<THREE.Mesh>
      const things = [drawable.geometry, ...(Array.isArray(drawable.material) ? drawable.material : [drawable.material])]
      for (const thing of things) {
        if (!thing) continue
        total += 1
        const original = thing.dispose.bind(thing)
        thing.dispose = () => {
          count += 1
          original()
        }
      }
    })
  }
  return { disposed: () => count, total }
}

test('the layer draws under the scene it is given, and a redraw of the same ghosts, as a new array, rebuilds nothing', () => {
  const parent = new THREE.Group()
  const layer = createGhostLayer()
  layer.sync(parent, GHOSTS)
  const first = [...parent.children]
  assert.equal(first.length, 4, 'three rings and one line')
  layer.sync(parent, GHOSTS.map((g) => ({ ...g, tap: { ...g.tap }, ghost: { ...g.ghost } })))
  assert.equal(parent.children.length, 4)
  assert.ok(parent.children.every((child, index) => child === first[index]), 'the same objects, so the 200 ms redraw costs nothing')
})

test('a re-tap redraws: the old ghosts go, disposed, and the new ones are where the markers now put them', () => {
  const parent = new THREE.Group()
  const layer = createGhostLayer()
  layer.sync(parent, GHOSTS)
  const old = [...parent.children]
  const spy = spyOnDisposal(old)
  assert.ok(spy.total > 0)
  const moved = GHOSTS.map((g, index) => (index === 0 ? { ...g, ghost: { ...g.ghost, x: g.ghost.x + 0.5 }, residualM: 0.5 } : g))
  layer.sync(parent, moved)
  assert.equal(old.filter((child) => child.parent === parent).length, 0, 'none of the old ones is left in the scene')
  assert.equal(spy.disposed(), spy.total, 'every geometry and material of the old ones was released')
  const rings = named(parent.children, GHOST_NAME)
  assert.equal(rings.length, 3)
  assert.equal(rings[0]!.position.x, GHOSTS[0]!.ghost.x + 0.5)
  assert.equal(named(parent.children, GHOST_GAP_NAME)[0]!.userData.residualCm, 50)
})

test('nothing to show, or no scene yet, clears the layer; clearing again is safe', () => {
  const parent = new THREE.Group()
  const layer = createGhostLayer()
  layer.sync(parent, GHOSTS)
  assert.equal(parent.children.length, 4)
  layer.sync(parent, [])
  assert.equal(parent.children.length, 0, 'an empty plan clears')
  layer.sync(parent, GHOSTS)
  layer.sync(parent, null)
  assert.equal(parent.children.length, 0, 'no plan clears')
  layer.sync(parent, GHOSTS)
  layer.sync(null, GHOSTS)
  assert.equal(parent.children.length, 0, 'the provider has no scene yet')
  layer.sync(null, null)
  layer.clear()
  layer.clear()
  assert.equal(parent.children.length, 0)
  // And it still works afterwards.
  layer.sync(parent, GHOSTS)
  assert.equal(parent.children.length, 4)
})

test('clear() removes and disposes what the layer drew, and only that', () => {
  const parent = new THREE.Group()
  const bystander = new THREE.Group()
  parent.add(bystander)
  const layer = createGhostLayer()
  layer.sync(parent, GHOSTS)
  const drawn = parent.children.filter((child) => child !== bystander)
  const spy = spyOnDisposal(drawn)
  layer.clear()
  assert.deepEqual(parent.children, [bystander], 'the marker groups the modal drew are untouched')
  assert.equal(spy.disposed(), spy.total)
})

test('given another scene, the layer moves: the old scene is emptied and the new one drawn', () => {
  const one = new THREE.Group()
  const two = new THREE.Group()
  const layer = createGhostLayer()
  layer.sync(one, GHOSTS)
  layer.sync(two, GHOSTS)
  assert.equal(one.children.length, 0)
  assert.equal(two.children.length, 4)
})

// ── 3. The scene is the flow's ───────────────────────────────────────────────────────────────────────

const L: Vec3 = { x: 0, y: 0, z: 0 }
const H: Vec3 = { x: 0, y: 0, z: 3.5 }
const C: Vec3 = { x: -2.6, y: 0, z: 1 }
const STORED: TwoPointFrame = {
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: L,
  headingMarker: H,
  separationM: 3.5,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  checkPoints: [C],
}

/** The Place frame turned 150 degrees and shifted, with a few centimetres of tap error on each point. */
function visit(): VisitPoints {
  const t = (150 * Math.PI) / 180
  const into = (p: Vec3, error: Vec3): Vec3 => ({
    x: p.x * Math.cos(t) + p.z * Math.sin(t) + 2 + error.x,
    y: -1.2 + p.y + error.y,
    z: -p.x * Math.sin(t) + p.z * Math.cos(t) - 3 + error.z,
  })
  return {
    landmark: into(L, { x: 0.02, y: 0, z: -0.01 }),
    headingMarker: into(H, { x: -0.03, y: 0.01, z: 0.02 }),
    checkPoint: into(C, { x: 0.01, y: -0.01, z: 0.04 }),
  }
}

test('what is drawn from a real comparison: rings where the stored points land in this session, lines as long as the card\'s residuals', () => {
  const tapped = visit()
  const comparison = compareVisit({ tapped, stored: STORED, sigmaHatM: 0.03 })
  assert.ok(comparison.fit, 'three points were fitted')
  const parent = new THREE.Group()
  const added = drawStoredConstellation(parent, ghostPlan({ drawn: tapped, stored: STORED, comparison }))
  const rings = named(added, GHOST_NAME)
  const lines = named(added, GHOST_GAP_NAME) as THREE.Line[]
  assert.equal(rings.length, 3)
  assert.equal(lines.length, 3, 'every point is more than a millimetre off')
  const inverse = invertAffine(comparison.sessionToProject)!
  ;[L, H, C].forEach((stored, index) => {
    const landed = transformPoint(inverse, stored)
    const ring = rings[index]!
    assert.ok(Math.hypot(ring.position.x - landed.x, ring.position.z - landed.z) < 1e-9, `ring ${index} is where the stored point lands`)
    const at = lines[index]!.geometry.getAttribute('position')
    const length = new THREE.Vector3().fromBufferAttribute(at, 0).distanceTo(new THREE.Vector3().fromBufferAttribute(at, 1))
    assert.ok(Math.abs(length - comparison.fit!.perPoint[index]!.residualM) < 1e-5, `line ${index} is the residual the card prints`)
    assert.ok(Math.abs(ring.userData.residualCm - 100 * comparison.fit!.perPoint[index]!.residualM) < 1e-9)
  })
})

/** A point reflected across the line through two others, on the floor: a check point tapped on the wrong side of the pair. */
function reflectAcrossBaseline(point: Vec3, a: Vec3, b: Vec3): Vec3 {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const along = ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz)
  const footX = a.x + along * dx
  const footZ = a.z + along * dz
  return { x: 2 * footX - point.x, y: point.y, z: 2 * footZ - point.z }
}

test('points that could not be fitted at all draw the pair\'s two rings and the check point\'s, with a line to the check point only', () => {
  // The check point on the wrong side of the line: there is no fit to invert, so the ghosts come from the frame the pair makes.
  const tapped = visit()
  const mirrored: VisitPoints = { landmark: tapped.landmark, headingMarker: tapped.headingMarker, checkPoint: reflectAcrossBaseline(tapped.checkPoint!, tapped.landmark, tapped.headingMarker) }
  const comparison = compareVisit({ tapped: mirrored, stored: STORED, sigmaHatM: 0.03 })
  assert.equal(comparison.fit, null)
  assert.equal(comparison.checkedBy, 'constellation')
  const parent = new THREE.Group()
  const added = drawStoredConstellation(parent, ghostPlan({ drawn: mirrored, stored: STORED, comparison }))
  const rings = named(added, GHOST_NAME)
  const lines = named(added, GHOST_GAP_NAME) as THREE.Line[]
  assert.deepEqual(rings.map((ring) => ring.userData.role), ['landmark', 'heading', 'check'])
  assert.deepEqual(lines.map((line) => line.userData.role), ['check'], 'the pair agrees with itself by construction: only the check point has a gap')
  const at = lines[0]!.geometry.getAttribute('position')
  const from = new THREE.Vector3().fromBufferAttribute(at, 0)
  const to = new THREE.Vector3().fromBufferAttribute(at, 1)
  assert.ok(Math.hypot(from.x - mirrored.checkPoint!.x, from.z - mirrored.checkPoint!.z) < 1e-5, 'from the check point as it was tapped')
  assert.ok(Math.hypot(to.x - rings[2]!.position.x, to.z - rings[2]!.position.z) < 1e-5, 'to its ghost')
  assert.ok(from.distanceTo(to) > 1, 'a long way: the other side of the line')
})

// ── Purity of the file itself ────────────────────────────────────────────────────────────────────────

test('the file reads no DOM and no Deno API, and imports only three, the anchor decal and the flow\'s types', () => {
  const source = readFileSync(resolve(ROOT, 'src/ar/constellation-ghosts.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\b(document|window|navigator|localStorage|sessionStorage)\b/.test(code), 'no DOM')
  assert.ok(!/\bDeno\b/.test(code), 'no Deno API')
  assert.deepEqual(
    [...code.matchAll(/^import\s+(?:type\s+)?[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ['three', '../world/anchor-marker.ts', './constellation-flow.ts'],
  )
  assert.ok(/^import type \{ GhostPoint \} from '\.\/constellation-flow\.ts'/m.test(code), 'the flow is a type import, so nothing of it runs here')
})
