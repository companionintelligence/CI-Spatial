/**
 * Gaussian Splatting support via @sparkjsdev/spark.
 *
 * Renders .ply/.spz/.splat/.ksplat/.sog assets as SplatMesh objects inside
 * the existing Three.js scene — SparkRenderer hooks into the normal
 * renderer.render(scene, camera) call automatically, no render-loop changes
 * needed.
 *
 * Loading is by URL or local file. Splats reach the viewer three ways now:
 * the `splat-train` world job (Brush, `server/splat/splat_train.ts`), the
 * `person-4d-reconstruct` job's per-timestep sequence
 * (`src/viewer/splat4d-layer.ts`), and the manual URL/file panel for assets
 * exported from an external trainer (gsplat, Postshot, Polycam, etc).
 *
 * (This comment previously said there was no in-repo training pipeline and that
 * `splat-train` only recorded its inputs. That stopped being true when Brush
 * landed.)
 */
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

/** Creates the scene's SparkRenderer and adds it. Call once per scene. */
export function attachSparkRenderer(renderer: THREE.WebGLRenderer, scene: THREE.Scene): SparkRenderer {
  const spark = new SparkRenderer({ renderer })
  spark.name = 'spark-renderer'
  scene.add(spark)
  return spark
}

export interface LoadedSplat {
  id: string
  label: string
  mesh: SplatMesh
  /**
   * Set only for a member of a 4D sequence — one timestep of a person capture.
   * Absent for an ordinary static splat, which is every other caller.
   */
  sequence?: { frameIndex: number; frameCount: number }
}

export type SplatSource =
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileBytes: ArrayBuffer; fileName: string }

let nextSplatId = 0

/** Loads a splat and resolves once it's ready to render (or rejects on failure). */
export async function loadSplat(source: SplatSource): Promise<LoadedSplat> {
  const label = source.kind === 'url' ? (source.url.split('/').pop() || source.url) : source.fileName
  const mesh = source.kind === 'url'
    ? new SplatMesh({ url: source.url })
    : new SplatMesh({ fileBytes: source.fileBytes, fileName: source.fileName })
  mesh.name = `splat: ${label}`
  await mesh.initialized
  return { id: `splat-${nextSplatId++}`, label, mesh }
}

export function disposeSplat(loaded: LoadedSplat): void {
  loaded.mesh.removeFromParent()
  loaded.mesh.dispose()
}

/**
 * Places a loaded splat with the ROW-MAJOR 4x4 similarity transform that
 * `SplatAlignManifest.projectTransform` carries (SfM space → a Place's metric
 * project space). Returns false, leaving the mesh untouched, for any matrix it
 * cannot trust.
 *
 * **Row-major is the entire reason this helper exists rather than a one-liner at
 * the call site.** `THREE.Matrix4.fromArray()` copies straight into
 * `Matrix4.elements`, which THREE stores COLUMN-major — so `fromArray()` on a
 * row-major array silently yields the *transpose*. `Matrix4.set()` is the
 * row-major entry point: three/src/math/Matrix4.js documents its arguments as
 * row-major and assigns `te[0] = n11; te[4] = n12; …`. This uses `set()`, and
 * must never be "simplified" to `fromArray()`.
 *
 * The failure mode is why it gets a comment instead of a test-and-move-on: a
 * transposed similarity still renders. The splat appears somewhere, at some
 * size, with some heading, and nothing throws — it is merely in the wrong place,
 * which is exactly the error this whole alignment path exists to make visible.
 *
 * Note the deliberate contrast with viewer.ts's `applyMatrix()`, which reads
 * `ScanManifest.localToWorld` through `fromArray()`: *that* array is
 * column-major. Both conventions live in this codebase and the two arrays are
 * not interchangeable.
 */
export function applyRowMajorTransform(loaded: LoadedSplat, rowMajor: readonly number[]): boolean {
  if (rowMajor.length !== 16) return false
  for (const n of rowMajor) {
    if (!Number.isFinite(n)) return false
  }
  const matrix = new THREE.Matrix4().set(
    rowMajor[0], rowMajor[1], rowMajor[2], rowMajor[3],
    rowMajor[4], rowMajor[5], rowMajor[6], rowMajor[7],
    rowMajor[8], rowMajor[9], rowMajor[10], rowMajor[11],
    rowMajor[12], rowMajor[13], rowMajor[14], rowMajor[15],
  )
  // A singular (or near-singular) matrix cannot be decomposed into a meaningful
  // position/quaternion/scale — decompose() would hand back a degenerate scale
  // and the splat would collapse to a point or plane. Reject instead.
  const determinant = matrix.determinant()
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false

  // `projectTransform` maps SfM space -> PROJECT space. The caller attaches this
  // mesh under the scan's root, and that root already carries
  // `ScanManifest.localToWorld`, which maps the scan's session space -> that
  // same project space. Assigning `projectTransform` as this mesh's *local* TRS
  // would therefore compose the two — world = localToWorld · projectTransform —
  // and the splat would render at the wrong place and scale while every status
  // string cheerfully reported "aligned". A wrong answer that looks like a right
  // one is the specific failure this whole path exists to prevent, so the parent
  // is cancelled explicitly rather than assumed to be identity.
  //
  // Cancelling it (local = parentWorld⁻¹ · projectTransform) keeps the mesh a
  // real child — it still rides the editor's transform gizmo and the scan's own
  // placement, exactly like the GLB geometry does — while landing at
  // projectTransform in world space.
  const parent = loaded.mesh.parent
  if (parent) {
    parent.updateWorldMatrix(true, false)
    const parentWorldInverse = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    const parentDet = parent.matrixWorld.determinant()
    // A singular parent cannot be cancelled. Refuse rather than emit NaNs that
    // would silently blank the splat.
    if (!Number.isFinite(parentDet) || Math.abs(parentDet) < 1e-12) return false
    matrix.premultiply(parentWorldInverse)
  }

  matrix.decompose(loaded.mesh.position, loaded.mesh.quaternion, loaded.mesh.scale)
  loaded.mesh.updateMatrix()
  return true
}
