/**
 * SceneEditor.pick() skips hidden objects (src/viewer/editor.ts).
 *
 * The raycaster does not test `visible`, so a hidden unlabelled solid used to stop the walk
 * and block a visible object behind it. A hidden object, or anything under a hidden node,
 * is not drawn, so it neither resolves to an edit target nor blocks the pick.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v-pick-visible.test.ts
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

test('a hidden solid in front does not block a visible object behind it', () => {
  const hiddenWall = unitMesh('hidden-wall', 2)
  hiddenWall.visible = false
  const { editor } = sceneWith(hiddenWall, labelledLod('LOD_chair', 'chair'))

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked instanceof THREE.LOD, 'the visible object behind the hidden wall is picked')
  assert.equal(picked.name, 'LOD_chair')
  assert.equal(editor.selectedObject, picked)
})

test('a hidden group hides the solids under it, so they do not block either', () => {
  const group = new THREE.Group()
  group.name = 'hidden-group'
  group.visible = false
  group.add(unitMesh('wall-in-hidden-group', 2))
  const { editor } = sceneWith(group, labelledLod('LOD_chair', 'chair'))

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked instanceof THREE.LOD)
  assert.equal(picked.name, 'LOD_chair')
})

test('a hidden labelled object is not picked, and the selection clears', () => {
  const hidden = labelledLod('LOD_hidden', 'sofa')
  hidden.visible = false
  const { editor } = sceneWith(hidden)
  editor.selectObject(hidden)
  assert.equal(editor.selectedObject, hidden)

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
  assert.equal(editor.selectedObject, null)
})

test('a visible solid in front still blocks the pick', () => {
  // Regression guard: skipping hidden objects must not let solids through.
  const { editor } = sceneWith(unitMesh('wall', 2), labelledLod('LOD_chair', 'chair'))

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
  assert.equal(editor.selectedObject, null)
})

test('a hidden solid in front does not block when the object behind it is also hidden', () => {
  const hiddenWall = unitMesh('hidden-wall', 2)
  hiddenWall.visible = false
  const hiddenChair = labelledLod('LOD_chair', 'chair')
  hiddenChair.visible = false
  const { editor } = sceneWith(hiddenWall, hiddenChair)

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
})
