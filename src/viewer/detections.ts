/**
 * Locating a detection's geometry in a scan graph.
 *
 * Extracted from viewer.ts so the rule can be tested without a browser: the
 * graph shape it handles is produced by the optimize pipeline, and
 * pipeline_detection_graph.test.ts asserts the two halves still meet.
 */
import * as THREE from 'three'

/**
 * Find the mesh carrying a labelled detection's geometry.
 *
 * Usually the labelled node *is* the mesh: `exportToGLB` writes the detection
 * extras onto the node holding the box mesh. The two come apart after
 * optimization. `exportToGLB` gives every detection a wireframe child, and
 * glTF-Transform's `quantize()` cannot put a dequantization transform on a node
 * that has both a mesh and children — so it hoists the mesh into a new unnamed
 * child, leaving the labelled node holding only children. (`transformMeshParents`
 * in `@gltf-transform/functions`: `parent.addChild(targetNode).setMesh(null)` —
 * the labelled node stays the *ancestor*, which is why the search below walks
 * `node.children`.)
 *
 * Measured on a real capture: 8 of 8 detection nodes carry a mesh in the source
 * GLB, 0 of 8 in the `.opt.glb`. Since the viewer *prefers* the optimized file,
 * gating on `instanceof Mesh` matched nothing in exactly the scans users see,
 * and every detection feature went dark with no error.
 *
 * Returns null when a labelled node has no geometry under it at all.
 */
export function resolveDetectionMesh(node: THREE.Object3D): THREE.Mesh | null {
  if (node instanceof THREE.Mesh) return node

  // The hoisted mesh sits alongside the wireframe overlay, which shares its
  // geometry. Prefer the solid one — the semantic LOD swap replaces whichever
  // we pick, and swapping the wireframe would leave the solid box behind.
  let firstMesh: THREE.Mesh | null = null
  for (const child of node.children) {
    if (!(child instanceof THREE.Mesh)) continue
    firstMesh ??= child
    const material = child.material
    const isWireframe = Array.isArray(material)
      ? material.every((m) => (m as THREE.MeshBasicMaterial).wireframe)
      : (material as THREE.MeshBasicMaterial).wireframe
    if (!isWireframe) return child
  }
  return firstMesh
}

/**
 * Every labelled detection in `root`, paired with the mesh holding its geometry.
 *
 * Metadata always comes from `node` and geometry always from `mesh`: after
 * optimization the hoisted mesh is unnamed and carries no extras, so reading
 * either from the wrong one silently loses the detection's identity.
 */
export function collectDetections(root: THREE.Object3D): Array<{ node: THREE.Object3D; mesh: THREE.Mesh }> {
  const found: Array<{ node: THREE.Object3D; mesh: THREE.Mesh }> = []
  root.traverse((node) => {
    if (!(node.userData as Record<string, unknown>)['label']) return
    // One entry per detected object, not one per level of detail.
    // upgradeSemanticMeshes() runs before buildDetectionBounds() and copies the
    // label onto the LOD wrapper and every proxy level it adds, so a detection
    // is reachable three ways by then. Without this, bounds and sample points
    // were built once per copy — triple geometry, a wrong detections-layer
    // count, and z-fighting wireframes. createSemanticLabels() guards the same
    // hazard for the same reason.
    if (hasLabelledAncestor(node, root)) return
    const mesh = resolveDetectionMesh(node)
    if (mesh) found.push({ node, mesh })
  })
  return found
}

/** True when some ancestor of `obj` (up to but excluding `root`) is itself labelled. */
export function hasLabelledAncestor(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  if (obj === root) return false
  for (let node = obj.parent; node && node !== root; node = node.parent) {
    if ((node.userData as Record<string, unknown>)['label']) return true
  }
  return false
}
