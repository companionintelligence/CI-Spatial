/**
 * Gaussian Splatting support via @sparkjsdev/spark.
 *
 * Renders .ply/.spz/.splat/.ksplat/.sog assets as SplatMesh objects inside
 * the existing Three.js scene — SparkRenderer hooks into the normal
 * renderer.render(scene, camera) call automatically, no render-loop changes
 * needed.
 *
 * There's no in-repo training pipeline yet (the `splat-train` world job in
 * main.ts is a placeholder that only records inputs — see jobNoteFor), so
 * loading is manual: point this at a URL or a local file exported from an
 * external trainer (gsplat, Postshot, Polycam, etc).
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
