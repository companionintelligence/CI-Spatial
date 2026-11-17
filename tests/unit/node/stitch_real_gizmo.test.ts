/**
 * The pivot proxy driven by three.js's own TransformControls, headless: the real class, its real ring and axis picking,
 * with a canvas stand-in that only has to answer the few things it asks of it. stitch_session.test.ts drives the
 * session with a stand-in for the controls that fires the events the real ones fire; this is the check that the real
 * ones fire them the way the stand-in assumes (what `objectChange` carries, when `dragging-changed` fires, what the
 * rotation snap does), and the measurement the stitching work package asked for: one gizmo action fixes a small yaw.
 *
 * A drag is made the way the browser makes it, through the control's own pointerDown / pointerMove / pointerUp, with the
 * axis it would have picked set directly: picking by pixel is the part that depends on rendering.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/stitch_real_gizmo.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { checkPlacementMatrix, normaliseZeros } from '../../../src/world/scan-placement.ts'
import { PivotSession, matrixOf, type GizmoLike } from '../../../src/viewer/stitch-session.ts'
import { choosePivot, offsetBetween, pivotWorld, scaleOf, type Matrix16 } from '../../../src/viewer/transform-tools.ts'

const CALIBRATED = normaliseZeros(twoPointToProjectTransform({ x: 1.5, y: 0, z: -0.4 }, { x: 3.1, y: 0, z: 1.9 }))

function poseRoot(root: THREE.Object3D, matrix: readonly number[]): void {
  new THREE.Matrix4().fromArray([...matrix]).decompose(root.position, root.quaternion, root.scale)
  root.updateMatrixWorld(true)
}

function rig() {
  // What TransformControls asks of its canvas: a few listeners, a size, pointer capture.
  const canvas = {
    style: {} as Record<string, string>,
    ownerDocument: { pointerLockElement: null },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
  }
  const camera = new THREE.PerspectiveCamera(60, 1000 / 800, 0.01, 800)
  camera.position.set(5, 4, 6)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const controls = new TransformControls(camera, canvas as unknown as HTMLElement)
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  scene.add(group)
  scene.add(controls.getHelper())
  const root = new THREE.Group()
  const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial())
  cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 2, 4, 0, 4], 3))
  root.add(cloud)
  poseRoot(root, CALIBRATED)
  group.add(root)

  // The adapter initStitchTools (src/viewer/viewer.ts) hands the tools.
  const gizmo: GizmoLike = {
    get object() { return controls.object },
    get mode() { return controls.mode },
    attach: (object) => controls.attach(object),
    detach: () => controls.detach(),
    setRotationSnap: (radians) => controls.setRotationSnap(radians),
    addEventListener: (type, listener) => controls.addEventListener(type, (event: unknown) => listener(event as { value?: boolean })),
  }
  const session = new PivotSession(gizmo, { addToScene: (proxy) => { scene.add(proxy) }, apply: (target, matrix) => poseRoot(target, matrix), changed: () => {} })
  const pivot = choosePivot({ calibratedLocalToWorld: CALIBRATED, calibrationStatus: 'provisional', calibrationMethod: 'two-point-ground', projectTransformRejected: undefined }, null)
  session.attachRoot(root, pivot)
  scene.updateMatrixWorld(true)
  return { controls, scene, root, session, camera, pivot }
}

type Rig = ReturnType<typeof rig>

const ndcOf = (camera: THREE.Camera, point: THREE.Vector3): { x: number; y: number } => {
  const projected = point.clone().project(camera)
  return { x: projected.x, y: projected.y }
}

/** A drag from `from` to `to` (normalised device coordinates) on `axis`, in `steps` moves. */
function drag(r: Rig, axis: string, from: { x: number; y: number }, to: { x: number; y: number }, steps = 5): void {
  r.scene.updateMatrixWorld(true)
  r.controls.axis = axis
  r.controls.pointerDown({ x: from.x, y: from.y, button: 0 } as never)
  for (let i = 1; i <= steps; i++) {
    r.scene.updateMatrixWorld(true)
    r.controls.pointerMove({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: -1 } as never)
  }
  r.controls.pointerUp({ x: to.x, y: to.y, button: 0 } as never)
  r.scene.updateMatrixWorld(true)
}

const screenOf = (r: Rig, at: { x: number; y: number; z: number }): { x: number; y: number } => ndcOf(r.camera, new THREE.Vector3(at.x, at.y, at.z))
const apart = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

test('one drag of the real turn ring turns the scan about its landmark: the landmark stays where it was, and nothing needs putting back', () => {
  const r = rig()
  r.controls.setMode('rotate')
  const landmark = r.session.pivotPosition()
  assert.ok(apart(landmark, { x: 0, y: 0, z: 0 }) < 1e-12, 'a calibration sends the landmark to the Place\'s zero, and that is where the gizmo stands')
  const at = screenOf(r, landmark)
  drag(r, 'Y', { x: at.x + 0.15, y: at.y }, { x: at.x + 0.17, y: at.y })
  const turned = offsetBetween(CALIBRATED, matrixOf(r.root), r.pivot.local).yawDeg
  assert.ok(Math.abs(turned) > 1, `the ring turned the scan by ${turned} degrees`)
  assert.ok(apart(r.session.pivotPosition(), landmark) < 1e-12, 'and the landmark did not move')
  assert.equal(checkPlacementMatrix(matrixOf(r.root)).ok, true)
  assert.ok(r.session.proxy.quaternion.angleTo(new THREE.Quaternion()) < 1e-12, 'the proxy is back at rest when the drag ends, so the next drag starts from nothing')
})

test('the same turn on the scan root, as the gizmo used to be attached, swings the landmark by decimetres, which is why a second move was needed', () => {
  const r = rig()
  r.session.release()
  r.controls.attach(r.root)
  r.controls.setMode('rotate')
  const landmark = pivotWorld(matrixOf(r.root), r.pivot.local)
  const at = screenOf(r, { x: r.root.position.x, y: r.root.position.y, z: r.root.position.z })
  drag(r, 'Y', { x: at.x + 0.15, y: at.y }, { x: at.x + 0.17, y: at.y })
  const swung = apart(pivotWorld(matrixOf(r.root), r.pivot.local), landmark)
  assert.ok(swung > 0.05, `the landmark swung ${swung} m`)
})

test('a snapped turn lands on a whole step measured from where the drag began, and keeps the landmark', () => {
  for (const [mode, step] of [['fine', 0.5], ['coarse', 2]] as const) {
    const r = rig()
    r.controls.setMode('rotate')
    r.session.setSnap(mode)
    const landmark = r.session.pivotPosition()
    const at = screenOf(r, landmark)
    drag(r, 'Y', { x: at.x + 0.15, y: at.y }, { x: at.x + 0.15 + 0.037, y: at.y })
    const yaw = offsetBetween(CALIBRATED, matrixOf(r.root), r.pivot.local).yawDeg
    assert.ok(Math.abs(yaw) > step / 2, `${mode}: the drag turned the scan`)
    assert.ok(Math.abs(yaw / step - Math.round(yaw / step)) < 1e-6, `${mode}: ${yaw} degrees is not a multiple of ${step}`)
    assert.ok(apart(r.session.pivotPosition(), landmark) < 1e-12)
  }
})

test('a snapped drag of the translate arrows moves by whole steps', () => {
  for (const [mode, step] of [['fine', 0.01], ['coarse', 0.05]] as const) {
    const r = rig()
    r.controls.setMode('translate')
    r.session.setSnap(mode)
    const before = r.session.pivotPosition()
    const at = screenOf(r, before)
    drag(r, 'X', { x: at.x + 0.05, y: at.y }, { x: at.x + 0.113, y: at.y + 0.011 })
    const after = r.session.pivotPosition()
    for (const axis of ['x', 'y', 'z'] as const) {
      const moved = after[axis] - before[axis]
      assert.ok(Math.abs(moved / step - Math.round(moved / step)) < 1e-6, `${mode}: ${axis} moved ${moved}`)
    }
    assert.ok(Math.abs(after.x - before.x) >= step - 1e-9, `${mode}: it moved`)
  }
})

test('a thousand mixed drags of the real controls leave a placement the server takes, at the size the scan had, with the pivot where the gizmo is', () => {
  const r = rig()
  let seed = 12345
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  for (let i = 0; i < 1000; i++) {
    const mode = (['translate', 'rotate'] as const)[Math.floor(next() * 2)]!
    r.controls.setMode(mode)
    const axes = mode === 'translate' ? ['X', 'Y', 'Z', 'XY', 'XZ', 'YZ', 'XYZ'] : ['X', 'Y', 'Z', 'E', 'XYZE']
    const axis = axes[Math.floor(next() * axes.length)]!
    const at = screenOf(r, r.session.pivotPosition())
    const from = { x: at.x + (next() - 0.5) * 0.4, y: at.y + (next() - 0.5) * 0.4 }
    const to = { x: from.x + (next() - 0.5) * 0.3, y: from.y + (next() - 0.5) * 0.3 }
    drag(r, axis, from, to, 3)
    const matrix: Matrix16 = matrixOf(r.root)
    const verdict = checkPlacementMatrix(matrix)
    assert.ok(verdict.ok, `drag ${i} (${mode} ${axis}) left a placement that would be refused: ${verdict.ok ? '' : verdict.message}`)
    assert.ok(Math.abs(scaleOf(matrix) - 1) < 1e-12, `drag ${i}: size ${scaleOf(matrix)}`)
    assert.ok(apart(r.session.proxy.position, r.session.pivotPosition()) < 1e-9, `drag ${i}: the gizmo is on the pivot at rest`)
  }
})

test('the Scale mode of the real controls cannot resize a scan, even reached by a route that skips the button', () => {
  const r = rig()
  r.controls.setMode('scale')
  const at = screenOf(r, r.session.pivotPosition())
  drag(r, 'XYZ', { x: at.x + 0.1, y: at.y }, { x: at.x + 0.3, y: at.y })
  assert.equal(scaleOf(matrixOf(r.root)), 1)
  assert.deepEqual(r.session.proxy.scale.toArray(), [1, 1, 1], 'and the proxy is at its own size again')
})
