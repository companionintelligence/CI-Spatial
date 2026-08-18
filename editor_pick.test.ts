/**
 * SceneEditor.pick() — which node an edit is written against.
 *
 * upgradeSemanticMeshes() (src/viewer/viewer.ts) wraps each detected object in a
 * THREE.LOD and assigns `lod.userData` to every level **by reference**, so all three
 * levels report the same `label`. pick() walks up from the raycast hit looking for
 * either a labelled node or an LOD parent; because the label test used to run first,
 * the walk stopped at whichever level happened to be under the cursor.
 *
 * The gizmo then moved that level while saveSelectedTransform() persisted the patch
 * against the LOD's objectId, so on reload the matrix was replayed onto the LOD and
 * the object came back displaced — and rescaled, because the medium proxy carries a
 * normalisation scale. Testing for the LOD parent first resolves to the LOD from every
 * level shape, so the node that is saved and the node that is replayed are the same one.
 *
 * Run: npm run test:editor:pick
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SceneEditor } from './src/viewer/editor.ts'

/** A camera on +Z looking back at the origin, so an NDC (0,0) ray travels -Z. */
function cameraAtZ(z = 5): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, z)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return camera
}

function unitMesh(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  mesh.name = name
  return mesh
}

/**
 * Rebuild the shape upgradeSemanticMeshes() produces: an LOD whose userData is shared
 * with every level by reference, so each level reports the same label and objectId.
 */
function buildSemanticLod(opts: { far?: boolean; medium?: boolean; high?: boolean } = {}) {
  const { far = true, medium = true, high = true } = opts
  const lod = new THREE.LOD()
  lod.name = 'LOD_bed_001'
  lod.userData = { label: 'bed', scanId: 'scan-1', objectId: 'scan-1:bed_001:lod' }

  if (far) {
    // The original GLB mesh. It keeps its OWN userData (lod.userData was built with a
    // spread), which in a freshly exported scan still carries the label.
    const mesh = unitMesh('bed_001')
    mesh.userData = { label: 'bed', id: 'bed_001' }
    lod.addLevel(mesh, 8)
  }
  if (medium) {
    // createMediumPolyAsset() returns a Group whose child meshes carry no label.
    const group = new THREE.Group()
    group.name = 'medium-bed'
    group.add(unitMesh('medium-bed-body'))
    group.userData = lod.userData
    lod.addLevel(group, 4)
  }
  if (high) {
    // loadSemanticAsset() attaches asynchronously, so it may be absent at pick time.
    const group = new THREE.Group()
    group.name = 'detailed-bed'
    group.add(unitMesh('detailed-bed-body'))
    group.userData = lod.userData
    lod.addLevel(group, 0)
  }
  return lod
}

function sceneWith(...objects: THREE.Object3D[]): { scene: THREE.Scene; editor: SceneEditor } {
  const scene = new THREE.Scene()
  for (const obj of objects) scene.add(obj)
  scene.updateMatrixWorld(true)
  const editor = new SceneEditor()
  editor.setScene(scene)
  return { scene, editor }
}

test('pick: a hit on the far mesh resolves to the LOD, not the mesh', () => {
  const lod = buildSemanticLod({ medium: false, high: false })
  const { editor } = sceneWith(lod)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked, 'the ray hits the LOD level')
  assert.equal(picked.name, 'LOD_bed_001')
  assert.ok(picked instanceof THREE.LOD)
})

test('pick: a hit on a medium-proxy child resolves to the LOD', () => {
  const lod = buildSemanticLod({ far: false, high: false })
  const { editor } = sceneWith(lod)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked)
  assert.ok(picked instanceof THREE.LOD, 'walks proxy child → proxy Group → LOD')
  assert.equal(picked.name, 'LOD_bed_001')
})

test('pick: a hit on the async high-detail child resolves to the LOD', () => {
  const lod = buildSemanticLod({ far: false, medium: false })
  const { editor } = sceneWith(lod)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked)
  assert.ok(picked instanceof THREE.LOD)
})

test('pick: detection sample Points under the raw mesh resolve to the LOD', () => {
  const lod = buildSemanticLod({ medium: false, high: false })
  const mesh = lod.levels[0].object
  const points = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0.6], 3),
    ),
    new THREE.PointsMaterial({ size: 0.5 }),
  )
  points.name = 'detection-samples'
  mesh.add(points)
  const { editor } = sceneWith(lod)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked)
  assert.ok(picked instanceof THREE.LOD, 'samples → raw mesh → LOD')
})

test('pick: a full three-level LOD resolves to the LOD, never to a level', () => {
  // The real shape, and the one the bug hit: every level reports the same label, so
  // before the fix the walk stopped at whichever level the ray reached first.
  const lod = buildSemanticLod()
  const { editor } = sceneWith(lod)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked)
  assert.ok(picked instanceof THREE.LOD, 'selection is the LOD node itself')
  assert.equal(picked.name, 'LOD_bed_001')
  assert.equal(
    (picked.userData as Record<string, unknown>)['objectId'],
    'scan-1:bed_001:lod',
    'the id that gets persisted is the LOD’s, matching the node it is replayed onto',
  )
  // Guard the specific regression: no LOD *level* may be returned.
  for (const level of lod.levels) {
    assert.notEqual(picked, level.object, `picked a level (${level.object.name}) instead of the LOD`)
  }
})

test('pick: a labelled object outside an LOD still selects as itself', () => {
  // Mirrors a splat-detect box (src/viewer/splat-detect-layer.ts): a labelled Mesh whose
  // parent is never an LOD. The label test must still decide for these.
  const box = unitMesh('detect-box-0-tv')
  box.userData = { label: 'tv', detectIndex: 0 }
  const { editor } = sceneWith(box)

  const picked = editor.pick(0, 0, cameraAtZ())

  assert.ok(picked)
  assert.equal(picked.name, 'detect-box-0-tv')
  assert.ok(!(picked instanceof THREE.LOD))
})

test('pick: an unlabelled mesh outside an LOD selects nothing', () => {
  const { editor } = sceneWith(unitMesh('plain-wall'))

  assert.equal(editor.pick(0, 0, cameraAtZ()), null)
})

test('pick: a miss clears the selection and returns null', () => {
  const lod = buildSemanticLod()
  const { editor } = sceneWith(lod)

  // Ray through the top-right corner, well clear of the unit box at the origin.
  assert.equal(editor.pick(0.99, 0.99, cameraAtZ()), null)
})
