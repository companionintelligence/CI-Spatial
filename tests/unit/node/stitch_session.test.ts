/**
 * The pivot proxy, the record of unsaved moves and the compare styling, on real THREE objects with a
 * stand-in for TransformControls (src/viewer/stitch-session.ts, src/viewer/compare-style.ts).
 *
 * The stand-in is driven the way the real controls drive an attached object: the test sets the
 * proxy's position and quaternion, as a drag does, and fires `objectChange`, then
 * `dragging-changed` with `value: false` when the drag ends. What it checks is what the editor
 * ends up showing: where the scan root is, whether the pivot moved, and what counts as unsaved.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/stitch_session.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { checkPlacementMatrix } from '../../../src/world/scan-placement.ts'
import {
  PivotSession,
  UnsavedTracker,
  matrixOf,
  pointCentroid,
  type GizmoLike,
  type PivotHooks,
} from '../../../src/viewer/stitch-session.ts'
import {
  GHOST_OPACITY_FACTOR,
  PLAIN_STYLE,
  TINT_PALETTE,
  applyCompareStyle,
  baseMaterial,
  isPlainStyle,
  tintForIndex,
} from '../../../src/viewer/compare-style.ts'
import {
  NUDGE_COARSE_DEG,
  NUDGE_FINE_DEG,
  NUDGE_FINE_M,
  degreesToRadians,
  fixSize,
  pivotWorld,
  rotateAbout,
  scaleOf,
  translateBy,
  type Matrix16,
  type PivotChoice,
} from '../../../src/viewer/transform-tools.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── Stand-ins and fixtures ──────────────────────────────────────────────────

class FakeGizmo implements GizmoLike {
  object: THREE.Object3D | undefined
  mode: 'translate' | 'rotate' | 'scale' = 'translate'
  rotationSnap: number | null = null
  private readonly listeners = new Map<string, Array<(event: { value?: boolean }) => void>>()

  attach(object: THREE.Object3D): this {
    this.object = object
    return this
  }

  detach(): this {
    this.object = undefined
    return this
  }

  setRotationSnap(radians: number | null): this {
    this.rotationSnap = radians
    return this
  }

  addEventListener(type: 'objectChange' | 'dragging-changed', listener: (event: { value?: boolean }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  fire(type: 'objectChange' | 'dragging-changed', event: { value?: boolean } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** The investigation's calibrated scene: a landmark 2 m right and 1 m ahead of the session start, the device turned 37 degrees. */
function scene37(): { calibrated: Matrix16; landmark: Vec3 } {
  const turn = (37 * Math.PI) / 180
  const rotate = (p: Vec3): Vec3 => ({ x: p.x * Math.cos(turn) + p.z * Math.sin(turn), y: p.y, z: -p.x * Math.sin(turn) + p.z * Math.cos(turn) })
  const landmark = rotate({ x: 2, y: 0, z: 1 })
  return { calibrated: twoPointToProjectTransform(landmark, rotate({ x: 2, y: 0, z: 4 })), landmark }
}

function poseRoot(root: THREE.Object3D, matrix: readonly number[]): void {
  new THREE.Matrix4().fromArray([...matrix]).decompose(root.position, root.quaternion, root.scale)
  root.updateMatrixWorld(true)
}

interface Rig {
  scene: THREE.Scene
  root: THREE.Group
  gizmo: FakeGizmo
  session: PivotSession
  changes: { count: number }
  landmark: Vec3
  calibrated: Matrix16
  pivot: PivotChoice
}

function rig(): Rig {
  const { calibrated, landmark } = scene37()
  const scene = new THREE.Scene()
  const world = new THREE.Group()
  scene.add(world)
  const root = new THREE.Group()
  world.add(root)
  poseRoot(root, calibrated)
  const gizmo = new FakeGizmo()
  const changes = { count: 0 }
  const hooks: PivotHooks = {
    addToScene: (proxy) => scene.add(proxy),
    apply: (target, matrix) => poseRoot(target, matrix),
    changed: () => { changes.count++ },
  }
  const session = new PivotSession(gizmo, hooks)
  const pivot: PivotChoice = { kind: 'landmark', local: landmark }
  session.attachRoot(root, pivot)
  return { scene, root, gizmo, session, changes, landmark, calibrated, pivot }
}

/** A drag as TransformControls makes it: set the proxy's pose, then announce the change. */
function drag(r: Rig, change: { position?: Vec3; yawDeg?: number; scale?: number }): void {
  if (change.position) r.session.proxy.position.set(change.position.x, change.position.y, change.position.z)
  if (change.yawDeg !== undefined) r.session.proxy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (change.yawDeg * Math.PI) / 180)
  if (change.scale !== undefined) r.session.proxy.scale.set(change.scale, change.scale, change.scale)
  r.gizmo.fire('objectChange')
}

const endDrag = (r: Rig): void => r.gizmo.fire('dragging-changed', { value: false })

function assertNear(actual: readonly number[], expected: readonly number[], eps: number, label: string): void {
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i]! - expected[i]!) <= eps, `${label}: entry ${i} is ${actual[i]}, wanted ${expected[i]}`)
}

// ─── The pivot proxy ─────────────────────────────────────────────────────────

test('the gizmo stands on the calibrated landmark, not on the scan root\'s own origin', () => {
  const r = rig()
  assert.equal(r.gizmo.object, r.session.proxy, 'the gizmo is attached to the proxy')
  assert.equal(r.session.proxy.parent, r.scene, 'the proxy is in the scene, outside every scan root')
  const standing = r.session.proxy.position
  assert.ok(distance({ x: standing.x, y: standing.y, z: standing.z }, { x: 0, y: 0, z: 0 }) < 1e-12, 'the landmark is the Place\'s zero')
  const rootOrigin = { x: r.root.position.x, y: r.root.position.y, z: r.root.position.z }
  assert.ok(distance(rootOrigin, { x: 0, y: 0, z: 0 }) > 2, `the old gizmo stood ${distance(rootOrigin, { x: 0, y: 0, z: 0 }).toFixed(2)} m away, where the AR session began`)
  assert.equal(r.session.target, r.root)
})

test('one gizmo action fixes a 3 degree yaw: the landmark does not move and no shift is needed afterwards', () => {
  const r = rig()
  const before = pivotWorld(matrixOf(r.root), r.landmark)
  drag(r, { yawDeg: 3 })
  endDrag(r)
  assert.ok(distance(pivotWorld(matrixOf(r.root), r.landmark), before) < 1e-12, 'the landmark stayed')
  assertNear(matrixOf(r.root), rotateAbout(r.calibrated, before, 3), 1e-12, 'the root is the calibrated placement turned about the landmark')
  assert.ok(r.changes.count >= 2, 'the readouts were told')
  // Turning about the root's own origin, which is what attaching the gizmo to the root did, moved the landmark.
  const old = rotateAbout(r.calibrated, { x: r.calibrated[12]!, y: r.calibrated[13]!, z: r.calibrated[14]! }, 3)
  assert.ok(distance(pivotWorld(old, r.landmark), before) > 0.1)
})

test('each event poses the root from where the drag began, so a long drag does not compound', () => {
  const r = rig()
  for (const yaw of [1, 4, 2, 3.5, 3]) drag(r, { yawDeg: yaw })
  assertNear(matrixOf(r.root), rotateAbout(r.calibrated, { x: 0, y: 0, z: 0 }, 3), 1e-12, 'the last event decides')
})

test('ending a turning drag stands the proxy back at rest on the pivot, so the next drag starts from nothing', () => {
  const r = rig()
  drag(r, { yawDeg: 3 })
  assert.ok(r.session.proxy.quaternion.angleTo(new THREE.Quaternion()) > 0.04, 'mid-drag the proxy carries the turn')
  endDrag(r)
  assert.ok(r.session.proxy.quaternion.angleTo(new THREE.Quaternion()) < 1e-12, 'at rest again')
  const pivot = pivotWorld(matrixOf(r.root), r.landmark)
  assert.ok(distance({ x: r.session.proxy.position.x, y: r.session.proxy.position.y, z: r.session.proxy.position.z }, pivot) < 1e-12)
  // The turn is in the scan now; a second drag of 2 degrees from rest makes 5, not 2 and not 3 + 5.
  drag(r, { yawDeg: 2 })
  assertNear(matrixOf(r.root), rotateAbout(r.calibrated, pivot, 5), 1e-12, 'one turn after another')
})

test('dragging the proxy moves the scan by the same vector, and ending a drag stands the proxy back on the pivot at rest', () => {
  const r = rig()
  drag(r, { position: { x: 0.12, y: 0.02, z: -0.5 } })
  assertNear(matrixOf(r.root), translateBy(r.calibrated, { x: 0.12, y: 0.02, z: -0.5 }), 1e-12, 'drag')
  endDrag(r)
  const pivot = pivotWorld(matrixOf(r.root), r.landmark)
  assert.ok(distance({ x: r.session.proxy.position.x, y: r.session.proxy.position.y, z: r.session.proxy.position.z }, pivot) < 1e-12)
  assert.ok(r.session.proxy.quaternion.angleTo(new THREE.Quaternion()) < 1e-12, 'at rest')
  // The next drag starts from here: turn 5 degrees about the new pivot position.
  drag(r, { yawDeg: 5 })
  assert.ok(distance(pivotWorld(matrixOf(r.root), r.landmark), pivot) < 1e-12)
})

test('the scale lock: a gizmo that resizes the proxy cannot resize the scan', () => {
  const r = rig()
  drag(r, { scale: 2.5 })
  assert.ok(Math.abs(scaleOf(matrixOf(r.root)) - 1) < 1e-12, `the scan is ${scaleOf(matrixOf(r.root))} times its size`)
  assert.equal(checkPlacementMatrix(matrixOf(r.root)).ok, true)
})

test('snap: a drag rounds to whole steps from where it began, the gizmo shows the snapped place, and turns snap through the controls', () => {
  const r = rig()
  r.session.setSnap('fine')
  assert.ok(Math.abs(r.gizmo.rotationSnap! - (NUDGE_FINE_DEG * Math.PI) / 180) < 1e-15)
  const start = { x: r.session.proxy.position.x, y: r.session.proxy.position.y, z: r.session.proxy.position.z }
  drag(r, { position: { x: start.x + 0.0137, y: start.y, z: start.z - 0.0262 } })
  assertNear(matrixOf(r.root), translateBy(r.calibrated, { x: 0.01, y: 0, z: -0.03 }), 1e-12, 'snapped drag')
  assert.ok(Math.abs(r.session.proxy.position.x - (start.x + 0.01)) < 1e-12, 'the gizmo moved to the snapped place')
  // The first tiny move is no move at all: it does not jump to a grid.
  const small = rig()
  small.session.setSnap('fine')
  drag(small, { position: { x: small.session.proxy.position.x + 0.002, y: 0, z: small.session.proxy.position.z } })
  assertNear(matrixOf(small.root), small.calibrated, 1e-14, 'a move under half a step')
  small.session.setSnap('off')
  assert.equal(small.gizmo.rotationSnap, null)
  assert.equal(NUDGE_FINE_M, 0.01)
})

test('a nudge, a typed offset, a size and a reset all move the scan and stand the proxy back on the pivot', () => {
  const r = rig()
  const baseline = matrixOf(r.root)

  r.session.nudge('x', 0.05)
  assert.ok(distance(r.session.pivotPosition(), { x: 0.05, y: 0, z: 0 }) < 1e-12)
  assert.ok(distance({ x: r.session.proxy.position.x, y: r.session.proxy.position.y, z: r.session.proxy.position.z }, r.session.pivotPosition()) < 1e-12, 'the gizmo followed')

  r.session.nudge('yaw', 2)
  assert.ok(Math.abs(r.session.offsetFrom(baseline).yawDeg - 2) < 1e-9)
  assert.ok(distance(r.session.pivotPosition(), { x: 0.05, y: 0, z: 0 }) < 1e-12, 'a turn leaves the pivot where it was')

  r.session.moveTo(baseline, { dx: -0.1, dy: 0.02, dz: 0.3, yawDeg: -1.5 })
  const read = r.session.offsetFrom(baseline)
  assert.ok(Math.abs(read.dx + 0.1) < 1e-9 && Math.abs(read.dy - 0.02) < 1e-9 && Math.abs(read.dz - 0.3) < 1e-9 && Math.abs(read.yawDeg + 1.5) < 1e-9, JSON.stringify(read))

  const grown = r.session.resize(1.2)
  assert.deepEqual(grown, { ok: true })
  assert.ok(Math.abs(scaleOf(matrixOf(r.root)) - 1.2) < 1e-12)
  assert.ok(distance(r.session.pivotPosition(), { x: -0.1 + 0, y: 0.02, z: 0.3 }) < 1e-9, 'the size changed about the pivot')
  const refused = r.session.resize(3)
  assert.equal(refused.ok, false)
  assert.ok(Math.abs(scaleOf(matrixOf(r.root)) - 1.2) < 1e-12, 'a refused size changes nothing')

  r.session.setMatrix(baseline)
  assertNear(matrixOf(r.root), baseline, 0, 'put back')
  assert.ok(r.changes.count >= 5)
})

test('nudge steps are small and exact: five 1 cm nudges move the pivot 5 cm', () => {
  const r = rig()
  for (let i = 0; i < 5; i++) r.session.nudge('z', NUDGE_FINE_M)
  assert.ok(distance(r.session.pivotPosition(), { x: 0, y: 0, z: 0.05 }) < 1e-12)
})

test('a snap chosen from the menu is on again when a scan is selected, after the controls were handed back without one', () => {
  const r = rig()
  r.session.setSnap('coarse')
  assert.ok(Math.abs(r.gizmo.rotationSnap! - degreesToRadians(NUDGE_COARSE_DEG)) < 1e-15)
  r.session.release()
  assert.equal(r.gizmo.rotationSnap, null, 'handed back to what was selected next: no snap of ours on it')
  r.session.attachRoot(r.root, r.pivot)
  assert.ok(Math.abs(r.gizmo.rotationSnap! - degreesToRadians(NUDGE_COARSE_DEG)) < 1e-15, 'and the choice is back with the next scan')
})

test('a gizmo mode that resized the proxy leaves it at its own size 1 and at rest when the drag ends', () => {
  const r = rig()
  drag(r, { scale: 2, yawDeg: 20 })
  assert.deepEqual(r.session.proxy.scale.toArray(), [2, 2, 2], 'the stand-in really did resize it')
  endDrag(r)
  assert.deepEqual(r.session.proxy.scale.toArray(), [1, 1, 1])
  assert.ok(r.session.proxy.quaternion.angleTo(new THREE.Quaternion()) < 1e-15)
})

test('a gizmo attached to something else is not the proxy: its changes do not move the scan, and releasing frees the controls', () => {
  const r = rig()
  const other = new THREE.Group()
  r.scene.add(other)
  r.session.release()
  r.gizmo.attach(other)
  assert.equal(r.session.proxy.parent, null, 'the proxy left the scene')
  assert.equal(r.gizmo.rotationSnap, null)
  assert.equal(r.session.target, null)
  const before = matrixOf(r.root)
  r.session.proxy.position.set(9, 9, 9)
  r.gizmo.fire('objectChange')
  assertNear(matrixOf(r.root), before, 0, 'the scan did not move')
  r.session.nudge('x', 1)
  assertNear(matrixOf(r.root), before, 0, 'with no scan attached a nudge does nothing')
  assert.equal(r.session.resize(1.1).ok, false)
})

test('re-attaching to the next scan stands the proxy on that scan\'s pivot', () => {
  const r = rig()
  const second = new THREE.Group()
  r.scene.add(second)
  poseRoot(second, translateBy(r.calibrated, { x: 10, y: 0, z: 4 }))
  r.session.attachRoot(second, { kind: 'centroid', local: { x: 1, y: 0, z: 1 } })
  assert.equal(r.session.target, second)
  assert.equal(r.session.pivotChoice.kind, 'centroid')
  assert.ok(distance(r.session.pivotPosition(), pivotWorld(matrixOf(second), { x: 1, y: 0, z: 1 })) < 1e-12)
  drag(r, { yawDeg: 90 })
  assert.ok(distance(pivotWorld(matrixOf(second), { x: 1, y: 0, z: 1 }), r.session.pivotPosition()) < 1e-12)
})

// ─── The middle of a scan ────────────────────────────────────────────────────

test('the middle of a scan is the mean of its points in the scan root\'s own coordinates, wherever the root and the cloud sit', () => {
  const root = new THREE.Group()
  root.position.set(30, 1, -12)
  root.rotation.y = 0.8
  const cloud = new THREE.Points(new THREE.BufferGeometry())
  // Points at the corners of a 2 m cube, in the cloud's own space; the cloud itself sits 5 m along the root's x.
  const corners: number[] = []
  for (const x of [0, 2]) for (const y of [0, 2]) for (const z of [0, 2]) corners.push(x, y, z)
  cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3))
  cloud.position.set(5, 0, 0)
  root.add(cloud)
  const middle = pointCentroid(root, [cloud])!
  assert.ok(distance(middle, { x: 6, y: 1, z: 1 }) < 1e-6, JSON.stringify(middle))

  const empty = new THREE.Points(new THREE.BufferGeometry())
  assert.equal(pointCentroid(root, [empty]), null)
  assert.equal(pointCentroid(root, []), null)

  // Two clouds are weighted by how many points each has.
  const big = new THREE.Points(new THREE.BufferGeometry())
  big.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(300).fill(0).flatMap(() => [10, 0, 0]), 3))
  const small = new THREE.Points(new THREE.BufferGeometry())
  small.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  root.add(big, small)
  const weighted = pointCentroid(root, [big, small])!
  assert.ok(Math.abs(weighted.x - (300 * 10) / 301) < 0.2, `${weighted.x}`)
})

test('a million-point scan is sampled, and the middle is still the middle', () => {
  const root = new THREE.Group()
  const count = 1_000_000
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (i % 1000) / 100
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = Math.floor(i / 1000) / 100
  }
  const cloud = new THREE.Points(new THREE.BufferGeometry())
  cloud.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  root.add(cloud)
  const middle = pointCentroid(root, [cloud], 2000)!
  assert.ok(Math.abs(middle.x - 5) < 0.3 && Math.abs(middle.z - 5) < 0.3, JSON.stringify(middle))
})

// ─── Unsaved moves ───────────────────────────────────────────────────────────

test('a move is unsaved until it is saved, moving it back clears it, and a save that did not happen leaves it', () => {
  const tracker = new UnsavedTracker()
  const root = new THREE.Group()
  poseRoot(root, scene37().calibrated)
  tracker.track(root)
  assert.equal(tracker.isDirty(root), false)

  root.position.x += 0.4
  assert.equal(tracker.isDirty(root), true)
  assert.deepEqual(tracker.dirty(() => true), [root])

  root.position.x -= 0.4
  assert.equal(tracker.isDirty(root), false, 'back where it was')

  root.position.x += 0.4
  // A save that failed never reaches markSaved: it is still unsaved.
  assert.equal(tracker.isDirty(root), true)
  tracker.markSaved(root)
  assert.equal(tracker.isDirty(root), false)
  root.position.z += 1e-12
  assert.equal(tracker.isDirty(root), false, 'a nanometre of round-off is not a move')
  root.position.z += 1e-3
  assert.equal(tracker.isDirty(root), true)
  assert.equal(tracker.isDirty(new THREE.Group()), false, 'an object nobody tracks is not unsaved')
})

test('what the server holds can be set directly, as a reset or an undo does, and a baseline is only replaced on purpose', () => {
  const tracker = new UnsavedTracker()
  const root = new THREE.Group()
  poseRoot(root, scene37().calibrated)
  tracker.track(root)
  const original = tracker.baselineOf(root)!
  root.position.x += 1
  tracker.trackIfNew(root)
  assert.deepEqual(tracker.baselineOf(root), original, 'trackIfNew keeps the baseline it already had')
  assert.equal(tracker.has(root), true)
  tracker.markSavedAs(root, matrixOf(root))
  assert.equal(tracker.isDirty(root), false)
})

test('an object that left the scene is forgotten, so a reloaded scan cannot hold the page hostage', () => {
  const tracker = new UnsavedTracker()
  const scene = new THREE.Scene()
  const gone = new THREE.Group()
  const here = new THREE.Group()
  scene.add(gone, here)
  tracker.track(gone)
  tracker.track(here)
  gone.position.x = 1
  here.position.x = 1
  const live = (object: THREE.Object3D): boolean => object.parent === scene
  assert.equal(tracker.dirty(live).length, 2)
  scene.remove(gone)
  assert.deepEqual(tracker.dirty(live), [here])
  assert.equal(tracker.has(gone), false)
  tracker.clear()
  assert.deepEqual(tracker.dirty(() => true), [])
})

test('a scan root rebuilt after an unsaved Fix size takes the size as well as the placement', () => {
  const { calibrated, landmark } = scene37()
  const tracker = new UnsavedTracker()
  const old = new THREE.Group()
  poseRoot(old, calibrated)
  tracker.track(old)
  const resized = fixSize(calibrated, pivotWorld(calibrated, landmark), 1.25)
  assert.ok(resized.ok)
  poseRoot(old, resized.matrix)
  const next = new THREE.Group()
  poseRoot(next, calibrated)
  assert.equal(tracker.carry(old, next), true)
  assert.ok(Math.abs(scaleOf(matrixOf(next)) - 1.25) < 1e-12, `the rebuilt root is at size ${scaleOf(matrixOf(next))}`)
  assert.deepEqual(next.scale.toArray().map((entry) => Number(entry.toFixed(12))), [1.25, 1.25, 1.25])
  assert.equal(tracker.isDirty(next), true, 'and the size is still not saved')
})

test('a scan root rebuilt mid-drag takes the unsaved move and the old baseline, and a clean one is left alone', () => {
  const tracker = new UnsavedTracker()
  const { calibrated } = scene37()
  const preview = new THREE.Group()
  poseRoot(preview, calibrated)
  tracker.track(preview)
  preview.position.x += 0.6
  preview.rotation.y += 0.1
  preview.updateMatrixWorld(true)

  const full = new THREE.Group()
  poseRoot(full, calibrated)
  assert.equal(tracker.carry(preview, full), true)
  assert.equal(tracker.isDirty(full), true, 'the drag is still unsaved')
  assertNear(matrixOf(full), matrixOf(preview), 1e-12, 'and the new root shows it')
  assert.equal(tracker.has(preview), false)

  tracker.markSaved(full)
  const next = new THREE.Group()
  poseRoot(next, calibrated)
  assert.equal(tracker.carry(full, next), false, 'nothing unsaved to carry')
  assert.equal(tracker.carry(null, next), false)
  assert.equal(tracker.carry(next, next), false)
})

// ─── Compare styling ─────────────────────────────────────────────────────────

function cloudWith(material: THREE.PointsMaterial): THREE.Points {
  const cloud = new THREE.Points(new THREE.BufferGeometry(), material)
  cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  return cloud
}

const materialOf = (object: THREE.Object3D): THREE.Material => (object as THREE.Mesh).material as THREE.Material

test('a tint is multiplied into a colour that is not white, so a scan keeps the shades it had under it', () => {
  const root = new THREE.Group()
  const grey = new THREE.MeshStandardMaterial({ color: 0x808080 })
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), grey))
  applyCompareStyle(root, { tint: TINT_PALETTE[0]!, ghost: false })
  const styled = (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial
  const expected = new THREE.Color(0x808080).multiply(new THREE.Color(TINT_PALETTE[0]!))
  assert.equal(styled.color.getHex(), expected.getHex())
  assert.notEqual(styled.color.getHex(), TINT_PALETTE[0], 'a grey scan is not painted over with the tint')
  assert.equal(grey.color.getHex(), 0x808080, 'the scan\'s own material is untouched')
})

test('a tint multiplies the colour of the scan\'s own material, and clearing it puts the very same material back', () => {
  const original = new THREE.PointsMaterial({ color: 0xffffff, vertexColors: true })
  const root = new THREE.Group()
  const cloud = cloudWith(original)
  root.add(cloud)

  applyCompareStyle(root, { tint: 0x4fc3f7, ghost: false })
  const styled = materialOf(cloud) as THREE.PointsMaterial
  assert.notEqual(styled, original, 'the node has its own copy')
  assert.equal(styled.color.getHex(), 0x4fc3f7)
  assert.equal(styled.vertexColors, true, 'the rest of the material is kept')
  assert.equal(original.color.getHex(), 0xffffff, 'the original was never touched')
  assert.equal(baseMaterial(styled), original)

  let freed = 0
  styled.addEventListener('dispose', () => { freed++ })
  applyCompareStyle(root, PLAIN_STYLE)
  assert.equal(materialOf(cloud), original, 'the same object, not an equal one')
  assert.equal(freed, 1, 'the copy was freed')
  assert.equal(original.color.getHex(), 0xffffff)
})

test('ghost keeps half of the opacity the material had, writes no depth, and a tint on top multiplies, not replaces', () => {
  const original = new THREE.MeshStandardMaterial({ color: 0x808080, opacity: 0.8, transparent: true })
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original)
  root.add(mesh)
  applyCompareStyle(root, { tint: 0xff0000, ghost: true })
  const styled = materialOf(mesh) as THREE.MeshStandardMaterial
  assert.ok(Math.abs(styled.opacity - 0.8 * GHOST_OPACITY_FACTOR) < 1e-12)
  assert.equal(styled.transparent, true)
  assert.equal(styled.depthWrite, false)
  assert.equal(styled.color.r > 0 && styled.color.g === 0 && styled.color.b === 0, true, 'a grey cast red')
  assert.equal(original.opacity, 0.8)
  assert.equal(original.depthWrite, true)
  assert.equal(GHOST_OPACITY_FACTOR, 0.5)

  applyCompareStyle(root, { tint: null, ghost: true })
  const ghostOnly = materialOf(mesh) as THREE.MeshStandardMaterial
  assert.equal(ghostOnly.color.getHex(), original.color.getHex(), 'the tint came off and the ghost stayed')
  assert.ok(Math.abs(ghostOnly.opacity - 0.4) < 1e-12, 'half of the original 0.8, not half of half')
})

test('a material two scans share is not tinted for both: each node gets its own copy', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0xffffff })
  const first = new THREE.Group()
  const second = new THREE.Group()
  const a = new THREE.Mesh(new THREE.BoxGeometry(), shared)
  const b = new THREE.Mesh(new THREE.BoxGeometry(), shared)
  first.add(a)
  second.add(b)
  applyCompareStyle(first, { tint: 0xffb74d, ghost: false })
  assert.equal((materialOf(a) as THREE.MeshStandardMaterial).color.getHex(), 0xffb74d)
  assert.equal(materialOf(b), shared, 'the other scan still has the shared material')
  assert.equal(shared.color.getHex(), 0xffffff)
})

test('applying the same style again changes nothing, and a different style replaces the copy rather than stacking on it', () => {
  const original = new THREE.PointsMaterial({ color: 0xffffff })
  const root = new THREE.Group()
  const cloud = cloudWith(original)
  root.add(cloud)
  applyCompareStyle(root, { tint: 0x4fc3f7, ghost: false })
  const first = materialOf(cloud)
  applyCompareStyle(root, { tint: 0x4fc3f7, ghost: false })
  assert.equal(materialOf(cloud), first, 'the same copy')
  applyCompareStyle(root, { tint: 0xffb74d, ghost: false })
  assert.equal((materialOf(cloud) as THREE.PointsMaterial).color.getHex(), 0xffb74d, 'not 0x4fc3f7 times 0xffb74d')
  assert.equal(baseMaterial(materialOf(cloud)), original)
})

test('when the editor swaps a node\'s material (a view mode) the style wraps the new one, and an old copy it puts back is unwrapped on clear', () => {
  const original = new THREE.MeshStandardMaterial({ color: 0xffffff })
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original)
  root.add(mesh)
  applyCompareStyle(root, { tint: 0x4fc3f7, ghost: false })
  const copy = materialOf(mesh)

  // Wireframe mode replaces the material with its own.
  const wireframe = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true })
  mesh.material = wireframe
  applyCompareStyle(root, { tint: 0xffb74d, ghost: false })
  assert.equal(baseMaterial(materialOf(mesh)), wireframe, 'the wireframe is what got styled')
  assert.equal((materialOf(mesh) as THREE.MeshBasicMaterial).wireframe, true)

  // Switching back, the editor puts the material it saved: the old copy. Clearing the style unwraps it.
  mesh.material = copy
  applyCompareStyle(root, PLAIN_STYLE)
  assert.equal(materialOf(mesh), original)
})

test('every material of a multi-material node is styled and restored, and nodes without a material are skipped', () => {
  const root = new THREE.Group()
  const materials = [new THREE.MeshStandardMaterial({ color: 0xffffff }), new THREE.MeshStandardMaterial({ color: 0x00ff00 })]
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), materials)
  root.add(mesh, new THREE.Group(), new THREE.Object3D())
  applyCompareStyle(root, { tint: 0x4fc3f7, ghost: true })
  const styled = mesh.material as THREE.Material[]
  assert.equal(styled.length, 2)
  assert.deepEqual(styled.map((m) => baseMaterial(m)), materials)
  applyCompareStyle(root, PLAIN_STYLE)
  assert.deepEqual(mesh.material, materials)
})

test('the palette is distinct, rounds for any number of scans, and a plain style is plain', () => {
  assert.equal(new Set(TINT_PALETTE).size, TINT_PALETTE.length)
  for (let i = 0; i < 20; i++) assert.equal(tintForIndex(i), TINT_PALETTE[i % TINT_PALETTE.length])
  assert.equal(tintForIndex(-1), TINT_PALETTE[TINT_PALETTE.length - 1])
  assert.equal(isPlainStyle(PLAIN_STYLE), true)
  assert.equal(isPlainStyle({ tint: 0, ghost: false }), false, 'black is a tint')
  assert.equal(isPlainStyle({ tint: null, ghost: true }), false)
})
