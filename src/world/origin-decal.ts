/**
 * The calibrated origin, drawn on the ground in the scanner's AR scene: a
 * crosshair at the origin, an arrow along the user-set heading, and a north
 * tick that makes the decal world-direction aware (wave 12, ticket 0001).
 *
 * Geometry only. What the origin *is* (where it sits, which way it faces, which
 * way north lies) is decided by `originDecalPlan()` in `./geo.ts`, so this file
 * has nothing to get wrong that a unit test could not see.
 *
 * A sibling of `buildAnchorMarker()` rather than an extension of it. That
 * marker is what the World Editor and the viewer draw for every scan's anchor,
 * and its tests pin its group yaw to the compass bearing. An arrow needs its own
 * yaw, separate from north, so it cannot share that group without changing what
 * the editor shows. The ring radius is reused from there, so the two decals
 * stay the same size on the ground.
 */
import * as THREE from 'three'
// Explicit extensions: the Node unit tests load this file directly, and Node's
// ESM resolver does not add `.ts` the way Vite does. types.ts does the same.
import { ANCHOR_RADIUS_M } from './anchor-marker.ts'
import type { OriginDecalPlan } from './geo.ts'

/** Which decal this is. Both are drawn in the same language; only emphasis and name differ. */
export type OriginDecalEmphasis = 'committed' | 'stored'

/**
 * Scene name of the committed origin. Stable on purpose: re-committing in one
 * session replaces this object rather than stacking a second origin on the
 * same spot, and the Chromium mock asserts on it.
 */
export const COMMITTED_ORIGIN_NAME = 'calibration origin'
/** Scene name of the stored origin drawn on a return visit. */
export const STORED_ORIGIN_NAME = 'calibration stored origin'

const RING_SEGMENTS = 48
/** Where the north tick ends, as a multiple of the ring radius. */
const NORTH_TICK_OUTER = 1.35
/** Arrowhead length is the smaller of this and a share of the arrow's own length. */
const ARROW_HEAD_MAX_M = 0.25
const ARROW_HEAD_SHARE = 0.3
/** Half-width of each arrowhead barb, as a multiple of the head length. */
const ARROW_HEAD_HALF_WIDTH = 0.6

/** The flow's baseline colour, so the heading arrow reads as the same thing the user drew. */
const ARROW_COLOR = 0x72ddd4
const RING_COLOR = 0x72ddd4
const CROSSHAIR_COLOR = 0xffffff
/** Matches `buildAnchorMarker`'s north tick, so the two compass ticks read alike. */
const NORTH_COLOR = 0xff6b6b

/** Ring and crosshair without a compass fix: "not yet a frame", as the anchor marker shows. */
const NO_COMPASS_OPACITY = 0.35
/** The stored origin is a reference to compare against, so it recedes behind the committed one. */
const STORED_OPACITY_SCALE = 0.5

function lineSegments(vertices: number[], color: number, opacity: number, name: string): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  // A fresh material per call: the decal's opacity is set per emphasis, and a
  // shared material would let one decal's dimming leak into another.
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  const line = new THREE.LineSegments(geometry, material)
  line.name = name
  return line
}

/**
 * Builds the origin decal for a plan. The group's position is the origin, so
 * its `y` is the committed ground height and the decal sits on the floor.
 *
 * The arrow lives in its own group rotated to the heading, and the north tick
 * in another rotated to north. Keeping them apart is what lets the arrow point
 * where the user pointed while the tick still points at true north.
 */
export function buildOriginDecal(plan: OriginDecalPlan, emphasis: OriginDecalEmphasis): THREE.Group {
  const group = new THREE.Group()
  group.name = emphasis === 'committed' ? COMMITTED_ORIGIN_NAME : STORED_ORIGIN_NAME
  group.position.set(plan.origin.x, plan.origin.y, plan.origin.z)

  const scale = emphasis === 'committed' ? 1 : STORED_OPACITY_SCALE
  const compassDim = plan.northYawDeg == null ? NO_COMPASS_OPACITY : 1
  const ringOpacity = scale * compassDim

  const ringVertices: number[] = []
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a0 = (i / RING_SEGMENTS) * Math.PI * 2
    const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2
    ringVertices.push(
      Math.cos(a0) * ANCHOR_RADIUS_M, 0, Math.sin(a0) * ANCHOR_RADIUS_M,
      Math.cos(a1) * ANCHOR_RADIUS_M, 0, Math.sin(a1) * ANCHOR_RADIUS_M,
    )
  }
  group.add(lineSegments(ringVertices, RING_COLOR, ringOpacity, 'origin ring'))

  const R = ANCHOR_RADIUS_M
  group.add(lineSegments(
    [-R, 0, 0, R, 0, 0, 0, 0, -R, 0, 0, R],
    CROSSHAIR_COLOR,
    ringOpacity,
    'origin crosshair',
  ))

  if (plan.headingDeg != null && plan.arrowLengthM > 0) {
    const heading = new THREE.Group()
    heading.name = 'origin heading'
    // Local +Z is the arrow's direction, so a yaw of `headingDeg` (compass
    // convention, 0 = +Z) points it along the baseline the user defined.
    heading.rotation.y = THREE.MathUtils.degToRad(plan.headingDeg)
    const length = plan.arrowLengthM
    const headLength = Math.min(ARROW_HEAD_MAX_M, length * ARROW_HEAD_SHARE)
    const halfWidth = headLength * ARROW_HEAD_HALF_WIDTH
    heading.add(lineSegments(
      [
        0, 0, 0, 0, 0, length,
        0, 0, length, -halfWidth, 0, length - headLength,
        0, 0, length, halfWidth, 0, length - headLength,
      ],
      ARROW_COLOR,
      scale,
      'origin heading arrow',
    ))
    group.add(heading)
  }

  if (plan.northYawDeg != null) {
    const north = new THREE.Group()
    north.name = 'origin north'
    north.rotation.y = THREE.MathUtils.degToRad(plan.northYawDeg)
    north.add(lineSegments(
      [0, 0, R, 0, 0, R * NORTH_TICK_OUTER],
      NORTH_COLOR,
      scale,
      'origin north tick',
    ))
    group.add(north)
  }

  return group
}
