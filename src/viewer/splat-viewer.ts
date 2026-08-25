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
