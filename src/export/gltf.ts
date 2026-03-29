/**
 * GLTF exporter — converts a complete room scan session into a .glb download.
 *
 * Scene graph structure:
 *   Scene: "room-scan"
 *     Node: "point-cloud"   — THREE.Points with SLAM feature positions
 *     Node: "camera-path"   — THREE.Line showing the trajectory walked
 *     Node: "floor-plane"   — estimated horizontal floor quad
 *     Group: "detections"
 *       Node: "<label>"     — semi-transparent box at each object's world pos
 *                             extras: { label, confidence, description, … }
 *
 * All metadata is stored in node.userData which GLTFExporter writes to `extras`.
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import type { DetectionStore } from '../scene/store'
import type { PointCloud } from '../scene/pointcloud'
import type { Pose } from '../ar/provider'

// Distinct colours per semantic category (HSL hue wheel)
const LABEL_COLORS: Record<string, number> = {
  chair:    0x4fc3f7,
  table:    0x81c784,
  sofa:     0xff8a65,
  couch:    0xff8a65,
  bed:      0xce93d8,
  desk:     0xa5d6a7,
  monitor:  0x80cbc4,
  tv:       0x80cbc4,
  door:     0xffcc80,
  window:   0x80deea,
  shelf:    0xc5e1a5,
  bookcase: 0xc5e1a5,
  lamp:     0xfff176,
  plant:    0x66bb6a,
  default:  0xb0bec5,
}

function labelColor(label: string): number {
  const lower = label.toLowerCase()
  for (const [key, color] of Object.entries(LABEL_COLORS)) {
    if (lower.includes(key)) return color
  }
  return LABEL_COLORS.default
}

export interface ExportData {
  store: DetectionStore
  pointCloud: PointCloud
  poseHistory: Pose[]
}

export async function exportToGLB(data: ExportData): Promise<void> {
  const { store, pointCloud, poseHistory } = data
  const scene = new THREE.Scene()
  scene.name = 'room-scan'

  const bb = pointCloud.count > 0 ? pointCloud.boundingBox() : null
  const floorY = pointCloud.count > 0 ? pointCloud.estimateFloorY() : 0

  scene.userData = {
    generator: 'ci-xr-scan',
    version: '2.0',
    capturedAt: new Date().toISOString(),
    pointCount: pointCloud.count,
    detectionCount: store.detections.size,
    poseCount: poseHistory.length,
    boundingBox: bb,
    floorY,
  }

  // ── 1. Point cloud ──────────────────────────────────────────────────────────
  if (pointCloud.count > 0) {
    const positions = pointCloud.toFloat32Array()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    // Colour each point based on height (heatmap: blue=floor → red=ceiling)
    const colors = new Float32Array(pointCloud.count * 3)
    const { min: bbMin, max: bbMax } = pointCloud.boundingBox()
    const yRange = Math.max(bbMax.y - bbMin.y, 0.01)
    for (let i = 0; i < pointCloud.count; i++) {
      const t = Math.max(0, Math.min(1, (positions[i * 3 + 1] - bbMin.y) / yRange))
      colors[i * 3]     = t               // R: 0→1 (floor=0, ceiling=1)
      colors[i * 3 + 1] = 1 - Math.abs(t * 2 - 1) // G: peak at mid-height
      colors[i * 3 + 2] = 1 - t           // B: 1→0
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mat = new THREE.PointsMaterial({ vertexColors: true, size: 0.035, sizeAttenuation: true })
    const cloud = new THREE.Points(geo, mat)
    cloud.name = 'point-cloud'
    cloud.userData = { type: 'slam_feature_points', count: pointCloud.count }
    scene.add(cloud)
  }

  // ── 2. Camera trajectory ────────────────────────────────────────────────────
  if (poseHistory.length >= 2) {
    const pathPositions = new Float32Array(poseHistory.length * 3)
    for (let i = 0; i < poseHistory.length; i++) {
      const p = poseHistory[i].position
      pathPositions[i * 3]     = p.x
      pathPositions[i * 3 + 1] = p.y
      pathPositions[i * 3 + 2] = p.z
    }
    const pathGeo = new THREE.BufferGeometry()
    pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3))
    const pathMat = new THREE.LineBasicMaterial({ color: 0xffeb3b })
    const path = new THREE.Line(pathGeo, pathMat)
    path.name = 'camera-path'
    path.userData = { type: 'camera_trajectory', poseCount: poseHistory.length }
    scene.add(path)
  }

  // ── 3. Estimated floor plane ────────────────────────────────────────────────
  if (bb) {
    const roomW = Math.max(bb.max.x - bb.min.x + 1.5, 1)
    const roomD = Math.max(bb.max.z - bb.min.z + 1.5, 1)
    const floorGeo = new THREE.PlaneGeometry(roomW, roomD)
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x263238,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    })
    const floor = new THREE.Mesh(floorGeo, floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(
      (bb.min.x + bb.max.x) / 2,
      floorY,
      (bb.min.z + bb.max.z) / 2,
    )
    floor.name = 'floor-plane'
    floor.userData = {
      type: 'estimated_floor',
      y: floorY,
      widthM: roomW,
      depthM: roomD,
    }
    scene.add(floor)
  }

  // ── 4. Detected objects as labelled boxes ───────────────────────────────────
  if (store.detections.size > 0) {
    const group = new THREE.Group()
    group.name = 'detections'

    for (const [, det] of store.detections) {
      // Estimate box dimensions from the VLM bounding box (0-1 normalised)
      // and a rough scene scale of ~4m width × 3m height for a typical room.
      const [x1, y1, x2, y2] = det.bbox
      const bw = Math.max((x2 - x1) * 3.5, 0.25)  // metres
      const bh = Math.max((y2 - y1) * 3.0, 0.20)
      const bd = bw * 0.75

      const boxGeo = new THREE.BoxGeometry(bw, bh, bd)
      const boxMat = new THREE.MeshBasicMaterial({
        color: labelColor(det.label),
        transparent: true,
        opacity: 0.30,
        wireframe: false,
      })
      const mesh = new THREE.Mesh(boxGeo, boxMat)
      mesh.position.set(det.worldPos.x, det.worldPos.y, det.worldPos.z)
      mesh.quaternion.set(det.worldRot.x, det.worldRot.y, det.worldRot.z, det.worldRot.w)
      mesh.name = det.label.replace(/[^a-z0-9_-]/gi, '_')

      // Wireframe overlay for cleaner visualisation
      const wireGeo = boxGeo.clone()
      const wireMat = new THREE.MeshBasicMaterial({
        color: labelColor(det.label),
        wireframe: true,
        opacity: 0.8,
        transparent: true,
      })
      const wire = new THREE.Mesh(wireGeo, wireMat)
      mesh.add(wire)

      mesh.userData = {
        label: det.label,
        confidence: det.confidence,
        description: det.description,
        thumbnailDataUrl: det.thumbnailDataUrl ?? null,
        captureTimestamp: det.captureTimestamp,
        worldPos: det.worldPos,
        worldRot: det.worldRot,
        bbox: det.bbox,
        estimatedSizeM: { w: bw, h: bh, d: bd },
      }

      group.add(mesh)
    }

    scene.add(group)
  }

  // ── 5. Pack as GLB and trigger download ────────────────────────────────────
  const exporter = new GLTFExporter()
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result)
        } else {
          const enc = new TextEncoder().encode(JSON.stringify(result))
          resolve(enc.buffer)
        }
      },
      reject,
      { binary: true, includeCustomExtensions: false },
    )
  })

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  triggerDownload(buffer, `room-scan-${ts}.glb`)
  console.log(
    `[export] GLB: ${(buffer.byteLength / 1024).toFixed(0)} KB,`,
    `${pointCloud.count} pts, ${poseHistory.length} poses, ${store.detections.size} objects`,
  )
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

