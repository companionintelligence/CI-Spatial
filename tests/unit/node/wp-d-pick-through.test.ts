/**
 * SceneEditor.pick() takes the first raycast hit that resolves to an edit target, not
 * only the nearest hit (src/viewer/editor.ts). A point cloud, or the transform gizmo's
 * helper, in front of a semantic object must not hide it or clear the selection.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-d-pick-through.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SceneEditor } from '../../../src/viewer/editor.ts'

/** A camera on +Z looking back at the origin, so the centre NDC ray travels -Z. */
function cameraAtZ(z = 5): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, z)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return camera
}

function unitMesh(name: string, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  mesh.name = name
  mesh.position.z = z
  return mesh
}

/** A point cloud with one point at (0, 0, z). The centre ray passes through it. */
function pointCloudAt(z: number): THREE.Points {
  const points = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, z], 3)),
    new THREE.PointsMaterial({ size: 0.5 }),
  )
  points.name = 'scan-points'
  return points
}

/** An LOD with one labelled level, the shape upgradeSemanticMeshes() produces. */
function labelledLod(name: string, label: string, z = 0): THREE.LOD {
  const lod = new THREE.LOD()
  lod.name = name
  lod.position.z = z
  lod.userData = { label, objectId: `${name}:lod` }
  const mesh = unitMesh(`${name}-mesh`)
  mesh.userData = { label }
  lod.addLevel(mesh, 0)
  return lod
}

function sceneWith(...objects: THREE.Object3D[]): { editor: SceneEditor } {
  const scene = new THREE.Scene()
  for (const obj of objects) scene.add(obj)
  scene.updateMatrixWorld(true)
  const editor = new SceneEditor()
  editor.setScene(scene)
  return { editor }
}

test('a point cloud in front of a semantic object does not hide it', () => {
  const { editor } = sceneWith(pointCloudAt(2), labelledLod('LOD_chair', 'chair'))

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked instanceof THREE.LOD, 'the object behind the points is picked')
  assert.equal(picked.name, 'LOD_chair')
  assert.equal(editor.selectedObject, picked)
})

test('when only unlabelled points are hit, nothing resolves and the selection clears', () => {
  const elsewhere = unitMesh('elsewhere')
  elsewhere.position.x = 3
  elsewhere.userData = { label: 'table' }
  const { editor } = sceneWith(elsewhere, pointCloudAt(2))
  editor.selectObject(elsewhere)
  assert.equal(editor.selectedObject, elsewhere)

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
  assert.equal(editor.selectedObject, null)
})

test('the gizmo helper in front of an object is skipped when it is excluded', () => {
  // Shaped like TransformControls' root: a group holding an unlabelled handle mesh.
  const helper = new THREE.Group()
  helper.name = 'TransformControlsRoot'
  helper.add(unitMesh('gizmo-handle', 2))
  const { editor } = sceneWith(helper, labelledLod('LOD_chair', 'chair'))

  const picked = editor.pick(0, 0, cameraAtZ(), helper)

  assert.ok(picked instanceof THREE.LOD)
  assert.equal(picked.name, 'LOD_chair')
})

test('without an exclusion the gizmo handle is solid and blocks the pick', () => {
  // The viewer always passes the helper as `excluded`. This pins why it must.
  const helper = new THREE.Group()
  helper.name = 'TransformControlsRoot'
  helper.add(unitMesh('gizmo-handle', 2))
  const { editor } = sceneWith(helper, labelledLod('LOD_chair', 'chair'))

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
})

test('an unlabelled solid mesh in front still blocks the pick', () => {
  // A wall or room surface is not a point cloud: it must not select what is behind it.
  const { editor } = sceneWith(unitMesh('wall', 2), labelledLod('LOD_chair', 'chair'))

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
  assert.equal(editor.selectedObject, null)
})

test('the nearest resolving hit wins over a farther one', () => {
  const { editor } = sceneWith(
    labelledLod('LOD_far', 'table'),
    labelledLod('LOD_near', 'sofa', 2),
  )

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.equal(picked?.name, 'LOD_near')
})
