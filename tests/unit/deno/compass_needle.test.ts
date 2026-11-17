/**
 * The World Editor's compass needle must point where the scene's north axis
 * actually lies on screen.
 *
 * The needle used to turn by `-atan2(dx, dz)` for a camera heading `(dx, dz)`,
 * with north at +z. A camera looking along +x sees +z on its RIGHT, and that
 * dial pointed left: it mirrored the very axis it called north, whenever the
 * camera was not looking along z. (The scene's declared axes are x east, y up,
 * z north, which is left-handed; the dial was a compass for a world the
 * renderer does not draw.)
 *
 * Here the camera is a real three.js `PerspectiveCamera`, and the expected
 * needle angle is read off its own matrices, not off the formula under test:
 *
 *   - where the north axis lies on screen is `atan2(right . n, forward . n)`, with
 *     `right` and `forward` taken from the camera's `matrixWorld` columns, which
 *     are by definition the screen's right and the camera's look direction;
 *   - a point 10 m along north is projected through the camera, and the needle
 *     must lean to the side of the screen the point appears on.
 *
 * Two scenes: the one every world file declares today (`z: 'north'`), and the
 * right-handed scene (`z: 'south'`, north at -z) that the new ENU module defines.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import * as THREE from 'three'
import { compassNeedleRad } from '../../../src/world/enu.ts'
import { D2R } from './physical_oracle.ts'

/** The needle's world-space north axis for each declared scene. */
const NORTH = {
  north: new THREE.Vector3(0, 0, 1),
  south: new THREE.Vector3(0, 0, -1),
} as const

/** A camera at eye height, heading `yawDeg` (0 looks along +z, 90 along +x) and pitched by `pitchDeg` (negative looks down). */
function cameraLooking(yawDeg: number, pitchDeg: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(2, 1.6, -3)
  const y = yawDeg * D2R
  const p = pitchDeg * D2R
  camera.lookAt(
    camera.position.x + Math.sin(y) * Math.cos(p),
    camera.position.y + Math.sin(p),
    camera.position.z + Math.cos(y) * Math.cos(p),
  )
  camera.updateMatrixWorld(true)
  return camera
}

/** What the editor does each frame: ask the camera for its direction, hand it to the needle. */
function needleFor(camera: THREE.PerspectiveCamera, zAxis?: 'north' | 'south' | null): number {
  const direction = new THREE.Vector3()
  camera.getWorldDirection(direction)
  return compassNeedleRad(direction, zAxis)
}

/** Clockwise angle on a top-down dial from the camera's heading to `axis`, read from the camera's own matrix columns. */
function onScreenAngleOf(camera: THREE.PerspectiveCamera, axis: THREE.Vector3): number {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).negate()
  right.y = 0
  forward.y = 0
  right.normalize()
  forward.normalize()
  return Math.atan2(axis.dot(right), axis.dot(forward))
}

const HEADINGS = Array.from({ length: 24 }, (_, i) => i * 15)
const PITCHES = [0, -35, 20]
const wrap = (rad: number) => Math.atan2(Math.sin(rad), Math.cos(rad))

for (const zAxis of ['north', 'south'] as const) {
  Deno.test(`compassNeedleRad (z: '${zAxis}'): points where the scene's north axis lies on screen, at every heading and tilt`, () => {
    for (const heading of HEADINGS) {
      for (const pitch of PITCHES) {
        const camera = cameraLooking(heading, pitch)
        const got = needleFor(camera, zAxis)
        const want = onScreenAngleOf(camera, NORTH[zAxis])
        assertAlmostEquals(wrap(got - want), 0, 1e-9, `heading ${heading}, pitch ${pitch}: needle ${got}, north on screen at ${want}`)
      }
    }
  })

  Deno.test(`compassNeedleRad (z: '${zAxis}'): the needle leans to the side of the screen the north axis is drawn on`, () => {
    for (const heading of HEADINGS) {
      const camera = cameraLooking(heading, 0)
      // A point 10 m along the scene's north axis, at the camera's own height, projected through the camera.
      const point = camera.position.clone().addScaledVector(NORTH[zAxis], 10)
      const inCamera = point.clone().applyMatrix4(camera.matrixWorldInverse)
      const ndc = point.clone().project(camera)
      const inFront = inCamera.z < 0
      const needle = needleFor(camera, zAxis)
      if (inFront && Math.abs(ndc.x) > 1e-6) {
        assert(Math.sign(Math.sin(needle)) === Math.sign(ndc.x), `heading ${heading}: north is drawn at x ${ndc.x} but the needle is at ${needle}`)
      }
      // Whether in front or behind, the needle is the camera-space bearing of the point.
      assertAlmostEquals(wrap(needle - Math.atan2(inCamera.x, -inCamera.z)), 0, 1e-9, `heading ${heading}`)
    }
  })
}

Deno.test('compassNeedleRad: looking straight at north puts the needle straight up, in either scene', () => {
  assertAlmostEquals(needleFor(cameraLooking(0, 0), 'north'), 0, 1e-12)
  assertAlmostEquals(Math.abs(needleFor(cameraLooking(180, 0), 'south')), 0, 1e-12)
  // Looking at the opposite way round, the needle is straight down.
  assertAlmostEquals(Math.abs(needleFor(cameraLooking(180, 0), 'north')), Math.PI, 1e-12)
  assertAlmostEquals(Math.abs(needleFor(cameraLooking(0, 0), 'south')), Math.PI, 1e-12)
})

Deno.test('compassNeedleRad: a camera looking along +x sees +z on its right, so the label-north needle leans right', () => {
  const camera = cameraLooking(90, 0)
  assertAlmostEquals(needleFor(camera, 'north'), Math.PI / 2, 1e-12)
  // Right-handed scene: facing east, north (-z) is on the left, as on a real compass.
  assertAlmostEquals(needleFor(camera, 'south'), -Math.PI / 2, 1e-12)
  // The needle before this change was `-atan2(dx, dz)`: left, away from +z.
  const direction = new THREE.Vector3()
  camera.getWorldDirection(direction)
  assertAlmostEquals(-Math.atan2(direction.x, direction.z), -Math.PI / 2, 1e-12)
  // +z really is on the right of that camera.
  assert(new THREE.Vector3(0, 0, 1).dot(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)) > 0.99)
})

Deno.test('compassNeedleRad: a world that declares nothing, or null, keeps the label it has always had', () => {
  for (const heading of HEADINGS) {
    const camera = cameraLooking(heading, 0)
    const label = needleFor(camera, 'north')
    assertEquals(needleFor(camera), label)
    assertEquals(needleFor(camera, null), label)
    assertEquals(needleFor(camera, undefined), label)
  }
})

Deno.test('compassNeedleRad: only the horizontal part of the direction is read', () => {
  const steep = cameraLooking(40, -80)
  const level = cameraLooking(40, 0)
  assertAlmostEquals(wrap(needleFor(steep, 'south') - needleFor(level, 'south')), 0, 1e-9)
  // Straight down there is no heading: the needle stays finite rather than turning into NaN.
  assert(Number.isFinite(compassNeedleRad({ x: 0, z: 0 }, 'south')))
})

Deno.test('source shape: the editor hands the camera direction and the world\'s declared axis to compassNeedleRad', () => {
  // viewer.ts is one DOM module and cannot be imported here, so its wiring is read as text. This claims no
  // behaviour: that the needle turns on a screen is for the editor's browser specs.
  const source = Deno.readTextFileSync(new URL('../../../src/viewer/viewer.ts', import.meta.url))
  assert(source.includes("import { compassNeedleRad } from '../world/enu'"))
  // The whole statement, so a sign in front of the call or a constant in place of the declared axis shows here.
  assert(
    source.includes("compassArrow.style.transform = `translateX(-50%) rotate(${compassNeedleRad(direction, world?.localFrame?.axes?.z)}rad)`"),
    'the needle is not turned by compassNeedleRad(camera direction, the world\'s declared z axis)',
  )
  assert(!source.includes('Math.atan2(direction.x, direction.z)'), 'the mirrored dial formula is back')
})
