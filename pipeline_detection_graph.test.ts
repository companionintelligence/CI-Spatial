/**
 * The scan → optimize → editor node contract.
 *
 * Nothing in the suite loaded a pipeline-produced GLB, which is why this went
 * unnoticed: `exportToGLB` gives every detection a wireframe child, and
 * glTF-Transform's `quantize()` cannot put a dequantization transform on a node
 * holding both a mesh and children — so it hoists the mesh into a new unnamed
 * sibling. Measured on a real capture, 8 of 8 detection nodes carried a mesh
 * before optimization and 0 of 8 after. The viewer prefers the optimized file
 * and gated its detection features on `instanceof THREE.Mesh`, so boxes,
 * sample points and semantic proxy models silently vanished from every
 * optimized scan while labels kept rendering.
 *
 * `scripts/smoke-pipeline.mjs` could not catch it: its fixture detection node
 * has no children, so it is never a hoist candidate. The fixture here is
 * shaped like real exporter output — mesh plus wireframe child.
 *
 * The contract asserted is the one the viewer actually needs: a labelled node
 * must resolve to geometry *at or below itself*. That holds whether or not the
 * optimizer reshapes the graph, so this test does not break the next time
 * glTF-Transform changes how it hoists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Document, NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { optimizeScan } from './pipeline.ts'
import { collectDetections, resolveDetectionMesh } from './src/viewer/detections.ts'

/** A cube, as 8 indexed corners — enough geometry to survive the pipeline. */
const CUBE_POSITIONS = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
])
const CUBE_INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
])

/**
 * A scan shaped the way `src/export/gltf.ts` writes one: a point cloud, plus
 * detection nodes that carry the label extras, a box mesh, AND a wireframe
 * child. That child is what makes the node a hoist candidate.
 */
async function buildExporterShapedScan(detections: string[]): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene('Scene')

  // A point cloud, so the pipeline has something to decimate for its LODs.
  const cloud = new Float32Array(3000)
  for (let i = 0; i < cloud.length; i++) cloud[i] = (i % 97) / 97
  const cloudPos = doc.createAccessor('cloud-pos').setType('VEC3').setArray(cloud).setBuffer(buffer)
  const cloudPrim = doc.createPrimitive().setMode(0 /* POINTS */).setAttribute('POSITION', cloudPos)
  scene.addChild(doc.createNode('point-cloud').setMesh(doc.createMesh('cloud').addPrimitive(cloudPrim)))

  detections.forEach((label, i) => {
    const pos = doc.createAccessor(`box-pos-${i}`).setType('VEC3').setArray(CUBE_POSITIONS).setBuffer(buffer)
    const idx = doc.createAccessor(`box-idx-${i}`).setType('SCALAR').setArray(CUBE_INDICES).setBuffer(buffer)
    const prim = doc.createPrimitive().setMode(4 /* TRIANGLES */).setAttribute('POSITION', pos).setIndices(idx)

    const name = `${label}_${String(i + 1).padStart(3, '0')}`
    const node = doc.createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(prim))
      .setTranslation([i, 0, i])
    node.setExtras({ objectId: name, objectType: 'detection', label, confidence: 0.9 })

    // The wireframe overlay exportToGLB nests under every detection mesh.
    const wirePos = doc.createAccessor(`wire-pos-${i}`).setType('VEC3').setArray(CUBE_POSITIONS).setBuffer(buffer)
    const wireIdx = doc.createAccessor(`wire-idx-${i}`).setType('SCALAR').setArray(CUBE_INDICES).setBuffer(buffer)
    const wirePrim = doc.createPrimitive().setMode(4).setAttribute('POSITION', wirePos).setIndices(wireIdx)
    node.addChild(doc.createNode().setMesh(doc.createMesh(`${name}-wire`).addPrimitive(wirePrim)))

    scene.addChild(node)
  })

  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression, KHRMeshQuantization])
  return await io.writeBinary(doc)
}

/** Read a GLB's JSON chunk without a full glTF parse. */
function glbJson(glb: Uint8Array): { nodes?: Array<Record<string, unknown>> } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
}

/** The viewer's rule: geometry at the labelled node, or on any node beneath it. */
function resolvesToGeometry(nodes: Array<Record<string, unknown>>, index: number): boolean {
  const node = nodes[index]
  if (node === undefined) return false
  if (node['mesh'] !== undefined) return true
  const children = (node['children'] ?? []) as number[]
  return children.some((child) => resolvesToGeometry(nodes, child))
}

function labelledNodes(glb: Uint8Array): Array<[number, Record<string, unknown>]> {
  const nodes = glbJson(glb).nodes ?? []
  return nodes
    .map((node, index) => [index, node] as [number, Record<string, unknown>])
    .filter(([, node]) => (node['extras'] as Record<string, unknown> | undefined)?.['label'] !== undefined)
}

test('optimizeScan: every labelled detection still resolves to geometry', async () => {
  const source = await buildExporterShapedScan(['monitor', 'chair', 'lamp'])

  const sourceLabelled = labelledNodes(source)
  assert.equal(sourceLabelled.length, 3, 'fixture should carry three labelled detections')

  const result = await optimizeScan(source)
  const optimized = glbJson(result.optimized.bytes)
  const nodes = optimized.nodes ?? []

  const labelled = labelledNodes(result.optimized.bytes)
  assert.equal(labelled.length, 3, 'optimization must not drop the label extras')

  for (const [index, node] of labelled) {
    assert.ok(
      resolvesToGeometry(nodes, index),
      `labelled node ${String(node['name'] ?? index)} resolves to no geometry after optimization — `
      + 'the editor renders its label with no box, sample points or semantic model under it',
    )
  }
})

test('optimizeScan: the LOD artifacts keep the same contract', async () => {
  const result = await optimizeScan(await buildExporterShapedScan(['sofa', 'table']))

  for (const lod of result.lods) {
    const nodes = glbJson(lod.bytes).nodes ?? []
    for (const [index, node] of labelledNodes(lod.bytes)) {
      assert.ok(
        resolvesToGeometry(nodes, index),
        `labelled node ${String(node['name'] ?? index)} resolves to no geometry in LOD at ${lod.voxelM ?? '?'} m`,
      )
    }
  }
})

// ── Consumer half: the viewer's resolver against both graph shapes ───────────
// These are the guard for the `instanceof THREE.Mesh` gate that caused the
// outage. The pipeline tests above would still pass with that gate restored,
// because they assert what the file contains, not what the viewer finds in it.

/** A detection the way a freshly exported scan holds it: extras on the mesh. */
function freshDetection(label: string): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  mesh.name = `${label}_001`
  mesh.userData = { label, objectType: 'detection' }
  mesh.add(new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ wireframe: true }),
  ))
  return mesh
}

/** The same detection after quantize hoists the mesh into an unnamed sibling. */
function hoistedDetection(label: string): THREE.Object3D {
  const node = new THREE.Object3D()
  node.name = `${label}_001`
  node.userData = { label, objectType: 'detection' }
  // Wireframe first, matching the child order glTF-Transform produces.
  node.add(new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ wireframe: true }),
  ))
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  solid.name = 'hoisted'
  node.add(solid)
  return node
}

test('resolveDetectionMesh: a freshly exported detection resolves to itself', () => {
  const mesh = freshDetection('monitor')
  assert.equal(resolveDetectionMesh(mesh), mesh)
})

test('resolveDetectionMesh: a hoisted detection resolves to its solid child, not the wireframe', () => {
  const node = hoistedDetection('monitor')
  const resolved = resolveDetectionMesh(node)

  assert.ok(resolved, 'a hoisted detection must still resolve to geometry')
  assert.equal(resolved.name, 'hoisted', 'the wireframe overlay must not win — the LOD swap replaces whatever we pick')
})

test('resolveDetectionMesh: a labelled node with no geometry resolves to null', () => {
  const node = new THREE.Object3D()
  node.userData = { label: 'ghost' }
  assert.equal(resolveDetectionMesh(node), null)
})

test('collectDetections: finds both graph shapes and keeps metadata on the labelled node', () => {
  const root = new THREE.Group()
  root.add(freshDetection('monitor'))
  root.add(hoistedDetection('chair'))
  // A plain mesh with no label is not a detection.
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))

  const found = collectDetections(root)

  assert.equal(found.length, 2, 'both a fresh and a hoisted detection must be found')
  assert.deepEqual(found.map((d) => d.node.userData['label']), ['monitor', 'chair'])
  for (const { node, mesh } of found) {
    assert.ok(mesh.geometry, 'every detection must pair with real geometry')
    assert.ok(node.userData['label'], 'metadata must come from the labelled node')
  }
})

test('collectDetections: an LOD-wrapped detection counts once, not once per level', () => {
  // upgradeSemanticMeshes() wraps each labelled mesh in a THREE.LOD and copies
  // the label onto the wrapper and every proxy level. buildDetectionBounds()
  // runs after it, so without a dedupe guard each detection is found three
  // ways and gets three sets of bounds and sample points.
  const root = new THREE.Group()
  const detection = freshDetection('monitor')
  const data = { ...detection.userData }

  const lod = new THREE.LOD()
  lod.userData = data                      // wrapper carries the label
  const proxy = new THREE.Group()
  proxy.userData = data                    // and so does every proxy level
  proxy.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
  lod.addLevel(proxy, 4)
  lod.addLevel(detection, 8)               // the original, still labelled
  root.add(lod)

  const found = collectDetections(root)

  assert.equal(found.length, 1, 'one detection, however many levels of detail it has')
  assert.equal(found[0]!.node, lod, 'the outermost labelled node represents the detection')
})
