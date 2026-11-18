/**
 * The origin decal as a camera looking straight down on the floor sees it: the one measurement of "clockwise" that
 * needs no opinion about which way a session yaw grows.
 *
 * A compass bearing is the angle clockwise from north seen from above, and the decal's north tick is what marks north
 * on the floor. So the bearing of the decal's arrow is the angle, clockwise on the screen of a camera above the floor,
 * from the tick to the arrow. The camera is three.js's own, and the angle is read from the points it projects: nothing
 * here knows what `atan2(x, z)` is, which is the point. (The test that used to stand in for this measured
 * "clockwise" with `atan2(x, z)` yaws, which grow counter-clockwise seen from above, and so pinned the formula's
 * sign instead of checking it.)
 *
 * Not a test file (no `.test.ts` name, so no runner collects it).
 */
import * as THREE from 'three'
import assert from 'node:assert/strict'

const DEG = Math.PI / 180

/** The far end of a decal line (its second vertex) in world space. */
export function tipOf(decal: THREE.Object3D, lineName: string): THREE.Vector3 {
  decal.updateMatrixWorld(true)
  const line = decal.getObjectByName(lineName) as THREE.LineSegments | undefined
  assert.ok(line, `the decal has a ${lineName}`)
  const positions = line.geometry.getAttribute('position')
  return new THREE.Vector3(positions.getX(1), positions.getY(1), positions.getZ(1)).applyMatrix4(line.matrixWorld)
}

/**
 * The angle, in degrees clockwise in [0, 360), from the decal's north tick to its arrow as a camera looking straight
 * down on the floor sees it. `rollDeg` turns the camera about its own axis, which turns the whole picture and must not
 * change the answer.
 */
export function clockwiseFromTickToArrow(decal: THREE.Object3D, rollDeg = 0): number {
  decal.updateMatrixWorld(true)
  const here = new THREE.Vector3().setFromMatrixPosition(decal.matrixWorld)
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(here.x, here.y + 6, here.z)
  // Which way the top of the screen is: any horizontal direction, since the angle between two marks does not care.
  camera.up.set(Math.sin(rollDeg * DEG), 0, -Math.cos(rollDeg * DEG))
  camera.lookAt(here.x, here.y, here.z)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const onScreen = (point: THREE.Vector3) => point.clone().project(camera)
  const centre = onScreen(here)
  // The screen's y runs up, so atan2(x, y) is the angle clockwise from the top of the screen.
  const clockwiseFromTop = (point: THREE.Vector3): number => {
    const p = onScreen(point)
    return Math.atan2(p.x - centre.x, p.y - centre.y) / DEG
  }
  const turn = clockwiseFromTop(tipOf(decal, 'origin heading arrow')) - clockwiseFromTop(tipOf(decal, 'origin north tick'))
  return ((turn % 360) + 360) % 360
}
