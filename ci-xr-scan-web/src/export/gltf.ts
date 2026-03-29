/**
 * GLTF exporter — converts the detection store into a .glb download.
 *
 * Each detection becomes an empty Object3D at its world position.
 * userData is serialised into the glTF node's `extras` field:
 *   { label, confidence, description, thumbnailDataUrl, captureTimestamp }
 *
 * Thumbnail data URLs are kept ≤ ~50 KB JPEG so base64 overhead stays small.
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import type { DetectionStore } from '../scene/store'

export async function exportToGLB(store: DetectionStore): Promise<void> {
  const scene = new THREE.Scene()
  scene.name = 'ci-xr-scan'

  for (const [, det] of store.detections) {
    const node = new THREE.Object3D()
    node.name = det.label.replace(/[^a-z0-9_-]/gi, '_')
    node.position.set(det.worldPos.x, det.worldPos.y, det.worldPos.z)
    node.quaternion.set(det.worldRot.x, det.worldRot.y, det.worldRot.z, det.worldRot.w)

    // userData → gltf extras
    node.userData = {
      label: det.label,
      confidence: det.confidence,
      description: det.description,
      thumbnailDataUrl: det.thumbnailDataUrl ?? null,
      captureTimestamp: det.captureTimestamp,
      worldPos: det.worldPos,
    }

    scene.add(node)
  }

  const exporter = new GLTFExporter()
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result)
        } else {
          // Should not happen with binary: true, but guard
          const json = JSON.stringify(result)
          const enc = new TextEncoder().encode(json)
          resolve(enc.buffer)
        }
      },
      reject,
      { binary: true, includeCustomExtensions: false },
    )
  })

  triggerDownload(buffer, `ci-scan-${Date.now()}.glb`)
}

function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
