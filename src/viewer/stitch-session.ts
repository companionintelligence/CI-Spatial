/**
 * The pivot proxy and the record of unsaved moves, on real THREE objects but with no DOM.
 *
 * ## The pivot proxy
 *
 * `TransformControls` moves the one object it is attached to. Attached to a scan root it turned the scan
 * about the root's origin: the spot the AR session started, usually metres from the room's content.
 * This attaches it to a proxy (an empty Object3D) standing on the pivot instead (transform-tools.ts
 * chooses it: the calibrated landmark, else the middle of the scan's points) and, each time the proxy
 * moves, poses the scan root from the proxy's move: a turn of the proxy is a turn of the scan about the
 * pivot, so a small yaw fix is one gizmo action and not a turn and then a shift.
 *
 * The proxy is never scaled into the scan (the scale lock is in rootFromProxy), a drag can snap to whole
 * steps measured from where it began, and every move that does not come from the gizmo (a nudge, a typed
 * number, a reset) re-seats the proxy on the pivot so the gizmo follows the scan.
 *
 * ## Unsaved moves
 *
 * A drag lives only in the scene until Save Transform posts it, and nothing said so: a reload threw it
 * away silently. {@link UnsavedTracker} remembers, for each object a person may drag, the matrix it last
 * had on the server (when it was loaded, or last saved), so "unsaved" is a fact about the matrices and
 * cannot go stale: moving an object back where it was clears it, and a save that failed leaves it set.
 *
 * Takes the gizmo and the way to pose a root as arguments, so a Node test drives it with real THREE
 * objects and a stand-in for the controls.
 */
import * as THREE from 'three'
import {
  MAX_CENTROID_SAMPLES,
  centroidOf,
  degreesToRadians,
  fixSize,
  matricesClose,
  moveToOffset,
  nudge,
  offsetBetween,
  pivotWorld,
  rootFromProxy,
  sampleIndex,
  snapSteps,
  snappedPosition,
  type Matrix16,
  type NudgeAxis,
  type PivotChoice,
  type PlacementOffset,
  type ProxyPose,
  type SnapMode,
} from './transform-tools.ts'
import type { Vec3 } from '../world/types.ts'

/** The part of `TransformControls` the session uses. A test passes a stand-in with the same shape. */
export interface GizmoLike {
  object: THREE.Object3D | undefined
  readonly mode: 'translate' | 'rotate' | 'scale'
  attach(object: THREE.Object3D): unknown
  detach(): unknown
  setRotationSnap(radians: number | null): unknown
  addEventListener(type: 'objectChange' | 'dragging-changed', listener: (event: { value?: boolean }) => void): void
}

export interface PivotHooks {
  /** Put the proxy in the scene, outside every scan root, so framing a scan on screen never counts it. */
  addToScene(proxy: THREE.Object3D): void
  /** Pose a scan root from a matrix: the viewer's own applyMatrix. */
  apply(root: THREE.Object3D, matrix: Matrix16): void
  /** The scan root moved, whoever moved it: refresh what shows it. */
  changed(): void
}

/** An object's own matrix (relative to its parent), the thing a patch saves. */
export function matrixOf(object: THREE.Object3D): Matrix16 {
  object.updateMatrix()
  return object.matrix.toArray()
}

function poseOf(object: THREE.Object3D): ProxyPose {
  const q = object.quaternion
  return {
    position: { x: object.position.x, y: object.position.y, z: object.position.z },
    quaternion: [q.x, q.y, q.z, q.w],
  }
}

const UNIT_QUATERNION = [0, 0, 0, 1] as const

export class PivotSession {
  readonly proxy = new THREE.Object3D()
  private readonly gizmo: GizmoLike
  private readonly hooks: PivotHooks
  private root: THREE.Object3D | null = null
  private pivot: PivotChoice = { kind: 'origin', local: { x: 0, y: 0, z: 0 } }
  private rootStart: Matrix16 = []
  private proxyStart: ProxyPose = { position: { x: 0, y: 0, z: 0 }, quaternion: UNIT_QUATERNION }
  private snap: SnapMode = 'off'

  constructor(gizmo: GizmoLike, hooks: PivotHooks) {
    this.gizmo = gizmo
    this.hooks = hooks
    this.proxy.name = 'stitch pivot proxy'
    gizmo.addEventListener('objectChange', () => this.onProxyMoved())
    gizmo.addEventListener('dragging-changed', (event) => {
      if (!event.value) this.onDragEnd()
    })
  }

  /** The scan root the gizmo is driving, or null. */
  get target(): THREE.Object3D | null {
    return this.root
  }

  get pivotChoice(): PivotChoice {
    return this.pivot
  }

  /** Attach the gizmo to a proxy standing on `pivot` and drive `root` from it. */
  attachRoot(root: THREE.Object3D, pivot: PivotChoice): void {
    this.root = root
    this.pivot = pivot
    this.hooks.addToScene(this.proxy)
    this.reseat()
    this.applySnap()
    this.gizmo.attach(this.proxy)
  }

  /** Hand the gizmo to something else, and take the proxy out of the scene. The caller attaches or detaches. */
  release(): void {
    if (!this.root) return
    this.root = null
    this.gizmo.setRotationSnap(null)
    this.proxy.removeFromParent()
  }

  setSnap(mode: SnapMode): void {
    this.snap = mode
    this.applySnap()
  }

  /** The root's matrix now. */
  matrix(): Matrix16 {
    return this.root ? matrixOf(this.root) : []
  }

  /** Where the pivot is in the Place now. */
  pivotPosition(): Vec3 {
    return pivotWorld(this.matrix(), this.pivot.local)
  }

  /** How far the root is from `baseline`, read at the pivot. */
  offsetFrom(baseline: readonly number[]): PlacementOffset {
    return offsetBetween(baseline, this.matrix(), this.pivot.local)
  }

  /** Put the root at `matrix` (a reset, an undo, a discard, a proposal) and stand the proxy back on the pivot. */
  setMatrix(matrix: Matrix16): void {
    if (!this.root) return
    this.hooks.apply(this.root, matrix)
    this.reseat()
    this.hooks.changed()
  }

  /** One nudge step: a shift in metres along a world axis, or a turn in degrees about the pivot. */
  nudge(axis: NudgeAxis, amount: number): void {
    if (!this.root) return
    this.setMatrix(nudge(this.matrix(), this.pivot.local, axis, amount))
  }

  /** Move the root so it is `target` away from `baseline` (typed fields), keeping anything else it had. */
  moveTo(baseline: readonly number[], target: PlacementOffset): void {
    if (!this.root) return
    this.setMatrix(moveToOffset(this.matrix(), baseline, this.pivot.local, target))
  }

  /** "Fix size": resize about the pivot. The one way to change a scan's size. */
  resize(wanted: number): { ok: true } | { ok: false; message: string } {
    if (!this.root) return { ok: false, message: 'Select a scan first.' }
    const result = fixSize(this.matrix(), this.pivotPosition(), wanted)
    if (!result.ok) return result
    this.setMatrix(result.matrix)
    return { ok: true }
  }

  private applySnap(): void {
    if (!this.root) return
    const steps = snapSteps(this.snap)
    this.gizmo.setRotationSnap(steps.yawDeg === null ? null : degreesToRadians(steps.yawDeg))
  }

  /** Stand the proxy on the pivot, at rest, and remember where the root was: the start of the next drag. */
  private reseat(): void {
    if (!this.root) return
    const matrix = matrixOf(this.root)
    const at = pivotWorld(matrix, this.pivot.local)
    this.rootStart = matrix
    this.proxy.position.set(at.x, at.y, at.z)
    this.proxy.quaternion.set(0, 0, 0, 1)
    this.proxy.scale.set(1, 1, 1)
    this.proxy.updateMatrixWorld(true)
    this.proxyStart = { position: at, quaternion: UNIT_QUATERNION }
  }

  private onProxyMoved(): void {
    if (!this.root || this.gizmo.object !== this.proxy) return
    const now = poseOf(this.proxy)
    const step = snapSteps(this.snap).translateM
    const matrix = rootFromProxy({ rootStart: this.rootStart, proxyStart: this.proxyStart, proxyNow: now, snapTranslateM: step })
    // The gizmo follows the snapped place, not the pointer, so what is drawn is what the scan did.
    const shown = snappedPosition(this.proxyStart.position, now.position, step)
    this.proxy.position.set(shown.x, shown.y, shown.z)
    this.proxy.updateMatrixWorld(true)
    this.hooks.apply(this.root, matrix)
    this.hooks.changed()
  }

  private onDragEnd(): void {
    if (!this.root || this.gizmo.object !== this.proxy) return
    this.reseat()
    this.hooks.changed()
  }
}

/**
 * The middle of a scan's point clouds, in the scan root's own coordinates, or null when it has none: the
 * pivot for a scan with no calibrated landmark. Reads at most `maxSamples` points in all, shared between
 * the clouds by size, so a million-point scan costs no more to select than a small one.
 */
export function pointCentroid(root: THREE.Object3D, clouds: readonly THREE.Points[], maxSamples = MAX_CENTROID_SAMPLES): Vec3 | null {
  root.updateMatrixWorld(true)
  const toRoot = root.matrixWorld.clone().invert()
  const withPoints = clouds.filter((cloud) => (cloud.geometry.getAttribute('position')?.count ?? 0) > 0)
  const total = withPoints.reduce((sum, cloud) => sum + cloud.geometry.getAttribute('position')!.count, 0)
  if (total === 0) return null

  const local = new THREE.Matrix4()
  const point = new THREE.Vector3()
  const flat: number[] = []
  for (const cloud of withPoints) {
    const position = cloud.geometry.getAttribute('position')!
    local.multiplyMatrices(toRoot, cloud.matrixWorld)
    const samples = Math.min(position.count, Math.max(1, Math.round((maxSamples * position.count) / total)))
    for (let k = 0; k < samples; k++) {
      const i = sampleIndex(k, samples, position.count)
      point.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(local)
      flat.push(point.x, point.y, point.z)
    }
  }
  return centroidOf(flat, flat.length / 3)
}

/**
 * For each object a person may drag, the matrix it last had on the server. An object whose matrix
 * differs is "unsaved": it shows a marker and the page asks before it is left.
 */
export class UnsavedTracker {
  private readonly baselines = new Map<THREE.Object3D, Matrix16>()

  /** Start watching `object`, with its matrix now as the saved one. Replaces an earlier baseline. */
  track(object: THREE.Object3D): void {
    this.baselines.set(object, matrixOf(object))
  }

  /** Watch `object` from now if it is not watched yet; a baseline already held stays. */
  trackIfNew(object: THREE.Object3D): void {
    if (!this.baselines.has(object)) this.track(object)
  }

  has(object: THREE.Object3D): boolean {
    return this.baselines.has(object)
  }

  baselineOf(object: THREE.Object3D): Matrix16 | undefined {
    return this.baselines.get(object)
  }

  /** The server now holds what `object` shows. */
  markSaved(object: THREE.Object3D): void {
    this.baselines.set(object, matrixOf(object))
  }

  /** The server holds `matrix` for `object`, which is what it is now at (a reset, an undo, a discard). */
  markSavedAs(object: THREE.Object3D, matrix: Matrix16): void {
    this.baselines.set(object, [...matrix])
  }

  isDirty(object: THREE.Object3D): boolean {
    const baseline = this.baselines.get(object)
    return baseline !== undefined && !matricesClose(matrixOf(object), baseline)
  }

  /**
   * Every watched object that is unsaved and still in the scene (`isLive`). An object that left the scene (its
   * scan was reloaded, or the Place was switched) is forgotten here: nothing can save it any more.
   */
  dirty(isLive: (object: THREE.Object3D) => boolean): THREE.Object3D[] {
    const out: THREE.Object3D[] = []
    for (const object of [...this.baselines.keys()]) {
      if (!isLive(object)) {
        this.baselines.delete(object)
        continue
      }
      if (this.isDirty(object)) out.push(object)
    }
    return out
  }

  /**
   * A scan root was rebuilt (a preview swapped for the full scan) while its predecessor had an unsaved move:
   * the new root takes the move and the old baseline, so the swap neither loses the drag nor calls it saved.
   * Returns whether it carried one.
   */
  carry(previous: THREE.Object3D | null, next: THREE.Object3D): boolean {
    if (!previous || previous === next || !this.isDirty(previous)) return false
    const baseline = this.baselines.get(previous)!
    next.position.copy(previous.position)
    next.quaternion.copy(previous.quaternion)
    next.scale.copy(previous.scale)
    next.updateMatrixWorld(true)
    this.baselines.delete(previous)
    this.baselines.set(next, baseline)
    return true
  }

  clear(): void {
    this.baselines.clear()
  }
}
