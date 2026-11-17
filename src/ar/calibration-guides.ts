/**
 * The marks the calibration flow draws on the floor besides the markers themselves: the ring at a stored point's
 * distance, and the floor grid that outlives the flow (WP-07).
 *
 * Plain three.js objects over the AR scene, like the anchor decals (`src/world/anchor-marker.ts`), and for the same
 * reason: a ring or a grid is a line drawing, so no new mark, material or geometry kind is invented here. The ring is
 * the anchor decal's own ring arithmetic (`ringVertices`) at another radius, and the grid is the `THREE.GridHelper`
 * the flow already builds in `refreshFloorGrid` (./project-calibration.ts), handed over rather than rebuilt.
 *
 * ## The ring
 *
 * On a return visit the person has tapped Point A again and has to find Point B. A ring on the floor around Point A at
 * the distance Point B was from it shows where to walk, in distance if not in direction (the photo gives the direction).
 * It needs no transform: a distance on the ground is the same in the stored frame and in this session's, so the ring is
 * drawn round the landmark's session position at the stored radius (`ringRadiiFromStoredPoints`, ./reference-photo.ts).
 * It assumes this session's unit is the one the points were stored in, like every distance on the card.
 *
 * ## The grid
 *
 * The owner asked for a ground plane that persists for the whole scan (R10). The flow drew its floor grid under its own
 * placement group, which `clearPlacement()` removes at every exit, so the grid vanished the moment the alignment was
 * committed and the scan that followed had no floor on screen. `keepFloorGrid` moves it onto the scene at the commit, as
 * the committed markers already are (`dropPersistentMarker`), fainter than while the markers were being placed. A person
 * who continues uncalibrated has committed nothing, and the grid goes with the flow.
 */
import * as THREE from 'three'
import { ringVertices } from '../world/anchor-marker.ts'

/** The scene name of a distance ring, so a test, or a person reading the scene, can find it. */
export const DISTANCE_RING_NAME = 'calibration distance ring'

/**
 * Segments to a distance ring. Adopted, not measured (ADR 0005 rule 5): at 96 the chords of a 3 m ring are 20 cm and the
 * ring stays within 2 mm of a circle, which is all a line drawn on the floor is asked to be. Revisit when a ring is
 * drawn at a radius over 10 m, where chords reach 65 cm.
 */
const DISTANCE_RING_SEGMENTS = 96

/** How solid a distance ring is. Adopted, not measured: as solid as the anchor decal's ring, which it is read beside. */
export const DISTANCE_RING_OPACITY = 0.85

/**
 * The colour of a distance ring: white. Adopted, not measured (ADR 0005 rule 5). The floor grid, the baseline and the anchor
 * decals draw in the overlay's teal, and a ring in the same hue read as a brighter curve of the grid and not as a thing to
 * walk to; white is the overlay's other line colour (the decal's crosshair) and is not the red of a warning. A line is one
 * pixel wide whatever its colour, so the colour is all there is to tell the ring apart with. Revisit when a device shows it
 * lost on a light floor.
 */
export const DISTANCE_RING_COLOR = 0xffffff

/**
 * How solid the floor grid is once it is kept. Adopted, not measured (ADR 0005 rule 5): the flow draws it at 0.4 while a
 * landmark is placed, and a grid that stays for a whole scan is a reference to glance at and not a thing to read through.
 * Revisit when a person on a device says it is in the way, or too faint to find the floor by.
 */
export const KEPT_GRID_OPACITY = 0.25

/** A flat ring of `radiusM` on the floor around the origin of its own space: put it at a landmark with `position`. */
export function buildDistanceRing(radiusM: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ringVertices(radiusM, DISTANCE_RING_SEGMENTS), 3))
  const material = new THREE.LineBasicMaterial({ color: DISTANCE_RING_COLOR, transparent: true, opacity: DISTANCE_RING_OPACITY })
  const ring = new THREE.LineSegments(geometry, material)
  ring.name = DISTANCE_RING_NAME
  return ring
}

/**
 * Hands the flow's floor grid to the scene so it stays when the flow's own group is removed, and returns what the flow
 * should go on holding as its grid: null once the scene has it, so the flow's teardown leaves it alone.
 *
 * With no scene to hand it to, or no grid, the flow keeps what it had, and its teardown disposes it with the rest.
 */
export function keepFloorGrid(
  scene: THREE.Scene | null,
  grid: THREE.GridHelper | null,
  placement: THREE.Object3D,
): THREE.GridHelper | null {
  if (!scene || !grid) return grid
  placement.remove(grid)
  ;(grid.material as THREE.Material).opacity = KEPT_GRID_OPACITY
  scene.add(grid)
  return null
}
