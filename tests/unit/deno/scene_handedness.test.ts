/**
 * The scene mapping is a rotation and not a mirror (src/world/enu.ts), and z is south.
 *
 * (east, up, north) is a left-handed set of axes: east x up points south. A right-handed AR session placed in it
 * by a rotation comes out mirrored east to west, whatever the compass and the GPS say, and no rotation can undo
 * a mirror. The scene is therefore x east, y up, z SOUTH, which the linear map from (east, north, up) to it makes
 * a rotation: determinant +1. tests/unit/deno/enu.test.ts checks the sign of z and
 * tests/unit/deno/world_registration.test.ts checks that a placement lands where a physical model says; what
 * neither states is the determinant of the mapping itself, the one number that tells a rotation from a mirror,
 * and that a mapping with z north has the other sign. This file holds that, so that mapping z to north fails
 * here by name, and not only by an east-west swap in a placement test.
 *
 * Nothing here shares code with the module beyond what it checks: the determinant, the dot products and the
 * legacy mapping it is compared with are written out below.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { enuFromScene, sceneFromEnu, sceneYawForBearingDeg, type Enu } from '../../../src/world/enu.ts'
import { composeYUpTransform } from '../../../src/world/geo.ts'
import { applyColumnMajor, rotationDeterminant } from './physical_oracle.ts'

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]]

const EAST: Enu = { east: 1, north: 0, up: 0 }
const NORTH: Enu = { east: 0, north: 1, up: 0 }
const UP: Enu = { east: 0, north: 0, up: 1 }

/** A map's matrix, columns being the images of east, north and up, so a row is one scene axis. */
function matrixOf(map: (v: Enu) => { x: number; y: number; z: number }): Mat3 {
  const e = map(EAST)
  const n = map(NORTH)
  const u = map(UP)
  return [
    [e.x, n.x, u.x],
    [e.y, n.y, u.y],
    [e.z, n.z, u.z],
  ]
}

function determinant(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/** The legacy frame the worlds declare: x east, y up, z NORTH. A reflection: a mirror, not a turn. */
const legacy = (v: Enu) => ({ x: v.east, y: v.up, z: v.north })

Deno.test('sceneFromEnu is a rotation: determinant +1, and its columns are an orthonormal set', () => {
  const m = matrixOf(sceneFromEnu)
  assertAlmostEquals(determinant(m), 1, 1e-15)
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const dot = m[0][a] * m[0][b] + m[1][a] * m[1][b] + m[2][a] * m[2][b]
      assertAlmostEquals(dot, a === b ? 1 : 0, 1e-15, `columns ${a} and ${b}`)
    }
  }
})

Deno.test('the legacy mapping with z north is a mirror (determinant -1), so the check above fails if z is ever mapped to north', () => {
  assertAlmostEquals(determinant(matrixOf(legacy)), -1, 1e-15)
  // The two disagree in sign, which is the whole defect: one is a rotation of the (east, north, up) world, the other a reflection of it.
  assert(determinant(matrixOf(sceneFromEnu)) * determinant(matrixOf(legacy)) < 0)
  // And they differ in the north column only: z north against z south.
  assertEquals(sceneFromEnu(NORTH), { x: 0, y: 0, z: -1 })
  assertEquals(legacy(NORTH), { x: 0, y: 0, z: 1 })
  assertEquals(sceneFromEnu(EAST), legacy(EAST))
  assertEquals(sceneFromEnu(UP), legacy(UP))
})

Deno.test('z is south and never north: a step north lowers z, a step south raises it, and east and up leave z alone', () => {
  assert(sceneFromEnu({ east: 0, north: 1, up: 0 }).z < 0, 'north is -z')
  assert(sceneFromEnu({ east: 0, north: -1, up: 0 }).z > 0, 'south is +z')
  assertEquals(sceneFromEnu({ east: 5, north: 0, up: 3 }).z, 0)
  assertEquals(enuFromScene({ x: 0, y: 0, z: -1 }), { east: 0, north: 1, up: 0 })
  assertEquals(enuFromScene({ x: 0, y: 0, z: 1 }), { east: 0, north: -1, up: 0 })
})

Deno.test('a frame whose +Z points north is turned a half turn into the scene, so its +Z lands on scene -z: nothing maps z to north', () => {
  // In the legacy frame +Z already is north and a frame at bearing 0 would need no turn. In the scene north is -z,
  // so it needs 180 degrees: sceneYawForBearingDeg(0).
  assertEquals(sceneYawForBearingDeg(0), 180)
  const m = composeYUpTransform({ x: 0, y: 0, z: 0 }, sceneYawForBearingDeg(0), 1)
  const z = applyColumnMajor(m, { x: 0, y: 0, z: 1 })
  assertAlmostEquals(z.x, 0, 1e-12)
  assertAlmostEquals(z.z, sceneFromEnu(NORTH).z, 1e-12)
  // And a frame whose +Z points south (bearing 180) needs none: scene +z is south.
  assertEquals(sceneYawForBearingDeg(180), 0)
})

Deno.test('every placement into the scene puts the frame\'s origin at the site and its +Z at the scene direction of its bearing, and is a rotation: determinant +1', () => {
  // The determinant of a placement's 3x3 block is +1 whatever `sceneFromEnu` does, because composeYUpTransform only ever
  // turns about +Y; it cannot tell a mirrored scene from a right-handed one. What can is where the placement puts things:
  // the site is the translation `sceneFromEnu` gives, and a frame whose +Z points at bearing B has its +Z axis on the
  // scene's own image of the direction at bearing B (east sin B, north cos B). With z mapped to north that image is
  // (sin B, 0, cos B) and the yaw the scene gives, 180 - B, lands the axis on (sin B, 0, -cos B): they disagree.
  let n = 0
  for (let bearing = 0; bearing < 360; bearing += 7.5) {
    const rad = (bearing * Math.PI) / 180
    const direction = sceneFromEnu({ east: Math.sin(rad), north: Math.cos(rad), up: 0 })
    for (const site of [{ east: 0, north: 0, up: 0 }, { east: 12, north: -7, up: 0.3 }, { east: -400, north: 250, up: 12 }]) {
      const m = composeYUpTransform(sceneFromEnu(site), sceneYawForBearingDeg(bearing), 1)
      assertAlmostEquals(rotationDeterminant(m), 1, 1e-12, `bearing ${bearing}`)
      const origin = applyColumnMajor(m, { x: 0, y: 0, z: 0 })
      const expectedOrigin = sceneFromEnu(site)
      assertAlmostEquals(origin.x, expectedOrigin.x, 1e-9, `bearing ${bearing}: origin x`)
      assertAlmostEquals(origin.y, expectedOrigin.y, 1e-9, `bearing ${bearing}: origin y`)
      assertAlmostEquals(origin.z, expectedOrigin.z, 1e-9, `bearing ${bearing}: origin z`)
      const z = applyColumnMajor(m, { x: 0, y: 0, z: 1 })
      assertAlmostEquals(z.x - origin.x, direction.x, 1e-9, `bearing ${bearing}: +Z east`)
      assertAlmostEquals(z.y - origin.y, direction.y, 1e-9, `bearing ${bearing}: +Z up`)
      assertAlmostEquals(z.z - origin.z, direction.z, 1e-9, `bearing ${bearing}: +Z north-south`)
      n++
    }
  }
  assertEquals(n, 48 * 3)
})
