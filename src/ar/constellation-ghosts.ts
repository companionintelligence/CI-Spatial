/**
 * Ghosts of a Place's stored points, drawn into the live AR scene (WP-04b).
 *
 * A stored point is in the Place frame, so it can only be drawn once there is a transform from this session into it. A visit
 * that has one (a fit of three points, or the two-point frame its own pair defines) draws each stored point at
 * `transformPoint(invertAffine(sessionToProject), stored)` (./constellation-flow.ts, `ghostPlan`): a dim ring where the
 * Place says that point is, and, for a fit, a line from the marker the person placed to its ghost. The length of the line
 * is the point's residual, shown at room scale instead of as a number, and the number is on the card beside it (the scene
 * itself carries no text). Three points that could not be fitted at all have no fit to invert; their check point's ghost is
 * where the frame the pair makes puts it, with a line to where it was tapped.
 *
 * This is what `drawStoredPair` in the modal drew for the two-point pair, widened to the points a fit compares. It
 * keeps that function's names (`'calibration stored reference'`) so that what a scene says about a visit does not change
 * for the pair.
 *
 * Two lifetimes. While the markers are being adjusted the ghosts are a live layer under the modal's placement group: they
 * follow every re-tap and go with the group when the flow ends. After the commit they are added to the scene itself and
 * stay for the rest of the session, as the committed markers do.
 */
import * as THREE from 'three'
import { buildAnchorMarker } from '../world/anchor-marker.ts'
import type { GhostPoint } from './constellation-flow.ts'

/** The name every ghost ring carries, as the stored pair's did. */
export const GHOST_NAME = 'calibration stored reference'
/** The name of the line from a placed marker to its ghost. */
export const GHOST_GAP_NAME = 'calibration stored reference gap'

/** Amber, against the teal of the markers: a disagreement reads differently from a marker. */
const GAP_COLOR = 0xffc857

/**
 * The shortest gap, in metres, that is drawn as a line: a millimetre. A display detail and not a verdict: the card quotes a
 * residual to a tenth of a centimetre, so a gap below this reads 0.0 there, and a line of arithmetic noise (a fit of
 * points that agree to the last digit leaves 1e-16) would be geometry nobody can see.
 */
const MIN_DRAWN_GAP_M = 0.001

/**
 * Draws the ghosts under `parent` and returns what it added. A ring at each ghost, named `GHOST_NAME`, with the point's role
 * and its residual in centimetres in `userData`; and, for a point whose residual is a millimetre or more, a line from the
 * marker to the ghost, named `GHOST_GAP_NAME`.
 */
export function drawStoredConstellation(parent: THREE.Object3D, ghosts: readonly GhostPoint[]): THREE.Object3D[] {
  const added: THREE.Object3D[] = []
  for (const point of ghosts) {
    const ring = buildAnchorMarker(null)
    ring.name = GHOST_NAME
    ring.position.set(point.ghost.x, point.ghost.y, point.ghost.z)
    ring.userData = { role: point.role, residualCm: point.residualM === null ? null : point.residualM * 100 }
    parent.add(ring)
    added.push(ring)

    if (point.residualM === null || !(point.residualM >= MIN_DRAWN_GAP_M)) continue
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([point.tap.x, point.tap.y, point.tap.z, point.ghost.x, point.ghost.y, point.ghost.z], 3),
    )
    const gap = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: GAP_COLOR, transparent: true, opacity: 0.9 }))
    gap.name = GHOST_GAP_NAME
    gap.userData = { role: point.role, residualCm: point.residualM * 100 }
    parent.add(gap)
    added.push(gap)
  }
  return added
}

function dispose(root: THREE.Object3D): void {
  root.traverse((child) => {
    const drawable = child as Partial<THREE.Mesh>
    drawable.geometry?.dispose()
    const material = drawable.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

/** The live layer: ghosts that follow the markers while they are adjusted. */
export interface GhostLayer {
  /**
   * Shows `ghosts` under `parent`, redrawing only when they or the parent changed, so the modal's 200 ms redraw does not
   * rebuild geometry that has not moved. Null `ghosts`, or a null `parent` (the provider's scene does not exist yet),
   * shows none.
   */
  sync(parent: THREE.Object3D | null, ghosts: readonly GhostPoint[] | null): void
  /** Removes and disposes what the layer drew. Safe to call again. */
  clear(): void
}

export function createGhostLayer(): GhostLayer {
  let drawn: THREE.Object3D[] = []
  let drawnUnder: THREE.Object3D | null = null
  let key: string | null = null

  const clear = (): void => {
    for (const object of drawn) {
      object.parent?.remove(object)
      dispose(object)
    }
    drawn = []
    drawnUnder = null
    key = null
  }

  return {
    sync(parent, ghosts) {
      if (!parent || !ghosts || ghosts.length === 0) {
        if (drawn.length > 0) clear()
        return
      }
      const next = JSON.stringify(ghosts)
      if (parent === drawnUnder && next === key) return
      clear()
      drawn = drawStoredConstellation(parent, ghosts)
      drawnUnder = parent
      key = next
    },
    clear,
  }
}
