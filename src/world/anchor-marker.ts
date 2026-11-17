/**
 * Shared calibration-anchor decal — a ring + crosshair (+ north tick,
 * when a compass bearing is known) marking where a project's calibration
 * anchor sits. Built once, used by both the live AR capture view
 * (src/ar/eighthwall.ts, src/ar/webxr.ts) and the World Editor
 * (src/viewer/viewer.ts), so the same visual represents the same concept in
 * both places.
 */
import * as THREE from 'three'

export const ANCHOR_RADIUS_M = 0.35
const ANCHOR_RING_SEGMENTS = 48

const anchorRingMaterial = new THREE.LineBasicMaterial({ color: 0x72ddd4, transparent: true, opacity: 0.85 })
const anchorDimRingMaterial = new THREE.LineBasicMaterial({ color: 0x72ddd4, transparent: true, opacity: 0.32 })
const anchorCrosshairMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
const anchorNorthMaterial = new THREE.LineBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.95 })

/**
 * The segments of a flat ring in the XZ plane (Y = 0) centred on the origin, as x, y, z triples with two points to a
 * segment: the ring the anchor decal draws, and the one the calibration flow draws at a stored point's distance
 * (src/ar/calibration-guides.ts). A ring of any radius is this and a material, so the two do not each carry their own
 * copy of the arithmetic.
 */
export function ringVertices(radiusM: number, segments: number = ANCHOR_RING_SEGMENTS): number[] {
  const verts: number[] = []
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    verts.push(
      Math.cos(a0) * radiusM, 0, Math.sin(a0) * radiusM,
      Math.cos(a1) * radiusM, 0, Math.sin(a1) * radiusM,
    )
  }
  return verts
}

/**
 * Built flat in the XZ plane directly (Y=0), so no separate lie-flat
 * rotation is needed — it's already lying on the ground by construction.
 *
 * `northYawDeg` is the yaw, **in whatever frame this marker is added to**, at
 * which north (the compass's) lies. The group is yawed by it so the tick points north:
 * Three.js's Y-axis rotation maps local +Z to (sin θ, 0, cos θ), matching the
 * `atan2(x, z)` convention used by `composeYUpTransform` and
 * `twoPointHeadingDeg`. `null` (or omitted) renders a dimmed "no compass fix"
 * state instead of guessing an orientation.
 *
 * **It is a yaw, not a compass bearing, and wave 09 ticket 0009 renamed it for
 * that reason.** The two coincide only where the parent frame's +Z already
 * points north — which is true of project space and *not* of an AR session's
 * frame, whose axes are fixed at session start and point wherever the device
 * happened to be facing. Passing a raw bearing to a marker living in session
 * space aims the tick at whatever the compass read rather than at north; with
 * the camera at its starting orientation that is exactly backwards. The
 * session-space caller converts with `northYawInSessionDeg(...)` in ./geo.ts:
 * the session frame's bearing itself, `+sessionFrameBearingDeg(...)`. North is
 * bearing 0 and a session direction at yaw `y` has bearing `B_Z - y`, so north
 * lies at session yaw `B_Z`.
 */
export function buildAnchorMarker(northYawDeg: number | null = null): THREE.Group {
  const group = new THREE.Group()
  group.name = 'calibration anchor'

  const ringGeometry = new THREE.BufferGeometry()
  ringGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ringVertices(ANCHOR_RADIUS_M), 3))
  const ring = new THREE.LineSegments(ringGeometry, (northYawDeg == null ? anchorDimRingMaterial : anchorRingMaterial).clone())
  ring.name = 'anchor ring'
  group.add(ring)

  const crossVerts = [
    -ANCHOR_RADIUS_M, 0, 0, ANCHOR_RADIUS_M, 0, 0,
    0, 0, -ANCHOR_RADIUS_M, 0, 0, ANCHOR_RADIUS_M,
  ]
  const crossGeometry = new THREE.BufferGeometry()
  crossGeometry.setAttribute('position', new THREE.Float32BufferAttribute(crossVerts, 3))
  const crosshair = new THREE.LineSegments(crossGeometry, anchorCrosshairMaterial.clone())
  crosshair.name = 'anchor crosshair'
  if (northYawDeg == null) (crosshair.material as THREE.LineBasicMaterial).opacity = 0.35
  group.add(crosshair)

  if (northYawDeg != null) {
    const tickVerts = [0, 0, ANCHOR_RADIUS_M, 0, 0, ANCHOR_RADIUS_M * 1.35]
    const tickGeometry = new THREE.BufferGeometry()
    tickGeometry.setAttribute('position', new THREE.Float32BufferAttribute(tickVerts, 3))
    const tick = new THREE.LineSegments(tickGeometry, anchorNorthMaterial.clone())
    tick.name = 'anchor north tick'
    group.add(tick)
    group.rotation.y = THREE.MathUtils.degToRad(northYawDeg)
  }

  return group
}

/** Height of an anchor pin's stem, in metres. */
export const ANCHOR_PIN_HEIGHT_M = 0.45
/** Radius of the small ring marking a pin's exact ground point. */
const ANCHOR_PIN_BASE_RADIUS_M = 0.06
const ANCHOR_PIN_HEAD_M = 0.07
const ANCHOR_PIN_BASE_SEGMENTS = 24

/**
 * A vertical pin marking one calibration point in **project space**.
 *
 * Distinct from {@link buildAnchorMarker}, which is the flat ring-and-crosshair
 * decal the live capture view lays on the floor. A flat decal is right there —
 * it sits on the surface the user just tapped. It is wrong in the World Editor,
 * where the camera orbits at room scale and a floor-flat ring is edge-on and
 * invisible from most angles. A pin reads from anywhere and its base still
 * marks the exact point.
 *
 * Colour carries the meaning and is the caller's to choose: the editor draws a
 * Place's **stored** pair and each scan's **actual** pair in different colours,
 * so the gap between them is the calibration residual made visible at room
 * scale rather than read off a number.
 */
export function buildAnchorPin(color: number, name: string): THREE.Group {
  const group = new THREE.Group()
  group.name = name

  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })

  const baseVerts: number[] = []
  for (let i = 0; i < ANCHOR_PIN_BASE_SEGMENTS; i++) {
    const a0 = (i / ANCHOR_PIN_BASE_SEGMENTS) * Math.PI * 2
    const a1 = ((i + 1) / ANCHOR_PIN_BASE_SEGMENTS) * Math.PI * 2
    baseVerts.push(
      Math.cos(a0) * ANCHOR_PIN_BASE_RADIUS_M, 0, Math.sin(a0) * ANCHOR_PIN_BASE_RADIUS_M,
      Math.cos(a1) * ANCHOR_PIN_BASE_RADIUS_M, 0, Math.sin(a1) * ANCHOR_PIN_BASE_RADIUS_M,
    )
  }
  const baseGeometry = new THREE.BufferGeometry()
  baseGeometry.setAttribute('position', new THREE.Float32BufferAttribute(baseVerts, 3))
  const base = new THREE.LineSegments(baseGeometry, material.clone())
  base.name = 'anchor pin base'
  group.add(base)

  const stemGeometry = new THREE.BufferGeometry()
  stemGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 0, ANCHOR_PIN_HEIGHT_M, 0], 3),
  )
  const stem = new THREE.LineSegments(stemGeometry, material.clone())
  stem.name = 'anchor pin stem'
  group.add(stem)

  // A diamond outline at the top — readable against both the point cloud and
  // the mesh, and unambiguous about which end is the measured point.
  const y = ANCHOR_PIN_HEIGHT_M
  const h = ANCHOR_PIN_HEAD_M
  const headVerts = [
    0, y + h, 0, h, y, 0, h, y, 0, 0, y - h, 0, 0, y - h, 0, -h, y, 0, -h, y, 0, 0, y + h, 0,
    0, y + h, 0, 0, y, h, 0, y, h, 0, y - h, 0, 0, y - h, 0, 0, y, -h, 0, y, -h, 0, y + h, 0,
  ]
  const headGeometry = new THREE.BufferGeometry()
  headGeometry.setAttribute('position', new THREE.Float32BufferAttribute(headVerts, 3))
  const head = new THREE.LineSegments(headGeometry, material.clone())
  head.name = 'anchor pin head'
  group.add(head)

  return group
}
