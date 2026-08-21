/**
 * GLTF exporter — converts a complete room scan session into a .glb download.
 *
 * Scene graph hierarchy (glTF "extras" carry machine-readable metadata):
 *
 *   Scene "room-scan"
 *     Group "Floor_Ground"                  ← one group per floor
 *       Group "Room_Unknown"                ← one group per room
 *         Node  "point-cloud"               ← SLAM feature points (THREE.Points)
 *         Node  "camera-path"               ← capture trajectory (THREE.Line)
 *         Node  "floor-plane"               ← estimated horizontal quad
 *         Group "detections"
 *           Node  "<safe-label>_NNN"        ← semantic object box
 *                 extras: { objectType, class, roomName, floorName,
 *                           confidence, dimensions, sourceScanIds,
 *                           captureIndex, … }
 *
 * All metadata lives in node.userData which GLTFExporter writes to `extras`.
 *
 * EVERY node above — not only the detections — carries a ScanProvenance stamp
 * (`sessionId`, `capturedAt`; see src/shared/provenance.ts), because
 * `roomName`/`floorName` are place labels rather than identity: two
 * walkthroughs of the same room both write `Room_Unknown`, so without the
 * stamp the geometry of a merged file would be anonymous. `scanId` is the one
 * provenance field the client does not write — the server derives it from the
 * stored filename and stamps it during the optimize pass. The one node that
 * stays bare is the wireframe child of a detection mesh: it is a rendering
 * artifact, not a logical object, and stamping it would double-count in any
 * traversal that does not guard the way hasLabelledAncestor() does.
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import type { DetectionStore } from '../scene/store'
import type { PointCloud } from '../scene/pointcloud'
import type { Pose } from '../ar/provider'
import { isQueuedOffline } from '../shared/offline-queue.ts'
import { isServerSessionId } from '../shared/session-id.ts'
import type { ScanProvenance } from '../shared/provenance'
import type { ScanEntry } from '../project/project-store'
import type { GeoFix } from '../geo/geo-tracker'
import type { ScanQualitySummary } from '../world/types'

// Per-category colour palette (used for detection boxes and semantic view)
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
  wall:     0x78909c,
  floor:    0x546e7a,
  ceiling:  0x90a4ae,
  default:  0xb0bec5,
}

function labelColor(label: string): number {
  const lower = label.toLowerCase()
  for (const [key, color] of Object.entries(LABEL_COLORS)) {
    if (lower.includes(key)) return color
  }
  return LABEL_COLORS.default
}

/** Infer a broad semantic class from the VLM label string */
function inferClass(label: string): string {
  const l = label.toLowerCase()
  if (/wall|floor|ceiling|stair|column|ramp/.test(l)) return 'architecture'
  if (/door|window/.test(l)) return 'opening'
  if (/chair|sofa|couch|bed|desk|table|shelf|lamp|plant/.test(l)) return 'furniture'
  if (/sink|toilet|tub|shower|countertop|cabinet/.test(l)) return 'fixture'
  if (/monitor|tv|laptop|appliance/.test(l)) return 'electronics'
  if (/outlet|switch|vent|light/.test(l)) return 'infrastructure'
  return 'object'
}

export interface ExportData {
  store: DetectionStore
  pointCloud: PointCloud
  poseHistory: Pose[]
  scanEntry?: ScanEntry   // project/floor/room assignment (optional)
  geoFix?: GeoFix         // GPS/bearing/address at time of export (optional)
  qualitySummary?: ScanQualitySummary
}

export interface ExportOptions {
  download?: boolean
  upload?: boolean
  filenamePrefix?: string
  autoSaved?: boolean
}

/**
 * What became of the server upload.
 *
 * `uploadedFilename` alone cannot say: it is absent for three different
 * reasons — queued offline, rejected by the server, or never attempted — and
 * callers were treating all three as "sync failed". A scan sitting safely in
 * the offline queue is not a failure, and telling the user it is teaches them
 * to distrust a message that is usually wrong.
 */
export type UploadOutcome =
  /** The server has it; `uploadedFilename` is set. */
  | 'uploaded'
  /** The service worker queued it offline; it replays on reconnect. */
  | 'queued-offline'
  /** The server rejected it, or the request errored. */
  | 'failed'
  /** No upload was requested (`upload: false`). */
  | 'skipped'

export interface ExportResult {
  filename: string
  size: number
  uploadedFilename?: string
  upload: UploadOutcome
}

export async function exportToGLB(data: ExportData, options: ExportOptions = {}): Promise<ExportResult> {
  const { store, pointCloud, poseHistory, scanEntry, geoFix, qualitySummary } = data
  const {
    download = true,
    upload = true,
    filenamePrefix = 'room-scan',
    autoSaved = false,
  } = options
  const scene = new THREE.Scene()
  scene.name = 'room-scan'

  const bb = pointCloud.count > 0 ? pointCloud.boundingBox() : null
  const floorY = pointCloud.count > 0 ? pointCloud.estimateFloorY() : 0
  const floorName  = scanEntry?.floorId  ? `Floor_${scanEntry.floorId.slice(-4)}`  : 'Floor_Ground'
  const roomName   = scanEntry?.roomId   ? `Room_${scanEntry.roomId.slice(-4)}`    : 'Room_Unknown'
  const scanName   = scanEntry?.name     ?? `scan-${store.sessionId.slice(-6)}`

  // The server session id, or null. `store.sessionId` may be a `local-…` id
  // when keyframe streaming never started, and a local id names no directory —
  // writing it here is what made every scan claim keyframes it did not have.
  // null is the honest value, and ScanManifest.sessionId already allows it.
  const serverSessionId = isServerSessionId(store.sessionId) ? store.sessionId : null

  // One timestamp for the whole export. The scene extras, every node stamp and
  // the upload metadata must agree; four separate `new Date()` calls could
  // disagree by milliseconds, which is enough to make two records of the same
  // export look like two exports.
  const capturedAt = new Date().toISOString()

  /**
   * Stamped onto every node the exporter writes. `scanId` is deliberately
   * absent — the client cannot know it; the server adds it during the optimize
   * pass (ticket 0004).
   */
  const nodeProvenance: ScanProvenance = { sessionId: serverSessionId, capturedAt }

  scene.userData = {
    generator:       'ci-spatial',
    version:         '2.0',
    capturedAt,
    sessionId:       serverSessionId,
    scanName,
    floorName,
    roomName,
    projectId:       scanEntry?.projectId ?? null,
    areaId:          scanEntry?.areaId ?? null,
    autoSaved,
    pointCount:      pointCloud.count,
    detectionCount:  store.detections.size,
    poseCount:       poseHistory.length,
    qualitySummary:  qualitySummary ?? null,
    calibration:     scanEntry?.calibration ?? null,
    boundingBox:     bb,
    floorY,
    // ── Geo metadata ─────────────────────────────────────────────────────────
    geoLat:          geoFix?.lat          ?? null,
    geoLng:          geoFix?.lng          ?? null,
    geoAccuracy:     geoFix?.accuracy     ?? null,
    geoAltitudeM:    geoFix?.altitudeM    ?? null,
    geoBearing:      geoFix?.bearing      ?? null,
    geoAddress:      geoFix?.address      ?? null,
    geoDisplayAddress: geoFix?.displayAddress ?? null,
    geoFixedAt:      geoFix?.fixedAt      ?? null,
  }

  // ── Hierarchy: Scene > Floor group > Room group >Content ────────────────────
  const floorGroup = new THREE.Group()
  floorGroup.name = floorName
  floorGroup.userData = { type: 'floor', floorName, ...nodeProvenance }

  const roomGroup = new THREE.Group()
  roomGroup.name = roomName
  roomGroup.userData = { type: 'room', roomName, floorName, scanName, ...nodeProvenance }

  floorGroup.add(roomGroup)
  scene.add(floorGroup)

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
    cloud.userData = { type: 'slam_feature_points', count: pointCloud.count, roomName, floorName, ...nodeProvenance }
    roomGroup.add(cloud)
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
    path.userData = { type: 'camera_trajectory', poseCount: poseHistory.length, roomName, floorName, ...nodeProvenance }
    roomGroup.add(path)
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
      objectType: 'estimated_floor', tag: 'floor',
      roomName, floorName,
      y: floorY, widthM: roomW, depthM: roomD,
      ...nodeProvenance,
    }
    roomGroup.add(floor)
  }

  // ── 4. Detected objects as labelled, metadata-rich boxes ─────────────────────
  if (store.detections.size > 0) {
    const detectionsGroup = new THREE.Group()
    detectionsGroup.name = 'detections'
    detectionsGroup.userData = { type: 'detections', roomName, floorName, ...nodeProvenance }

    let objIndex = 0
    for (const [, det] of store.detections) {
      objIndex++
      const [x1, y1, x2, y2] = det.bbox
      const bw = Math.max((x2 - x1) * 3.5, 0.25)
      const bh = Math.max((y2 - y1) * 3.0, 0.20)
      const bd = bw * 0.75

      const boxGeo = new THREE.BoxGeometry(bw, bh, bd)
      const boxMat = new THREE.MeshStandardMaterial({
        color: labelColor(det.label),
        transparent: true,
        opacity: 0.30,
        roughness: 0.9,
      })
      const mesh = new THREE.Mesh(boxGeo, boxMat)
      mesh.position.set(det.worldPos.x, det.worldPos.y, det.worldPos.z)
      mesh.quaternion.set(det.worldRot.x, det.worldRot.y, det.worldRot.z, det.worldRot.w)

      const safeName = det.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
      mesh.name = `${safeName}_${String(objIndex).padStart(3, '0')}`

      mesh.add(new THREE.Mesh(boxGeo.clone(),
        new THREE.MeshBasicMaterial({ color: labelColor(det.label), wireframe: true, transparent: true, opacity: 0.8 })))

      mesh.userData = {
        objectId:           mesh.name,
        objectType:         'detection',
        class:              inferClass(det.label),
        label:              det.label,
        tag:                det.label.toLowerCase().replace(/\s+/g, '_'),
        roomName,
        floorName,
        confidence:         det.confidence,
        description:        det.description,
        thumbnailDataUrl:   det.thumbnailDataUrl ?? null,
        captureTimestamp:   det.captureTimestamp,
        worldPos:           det.worldPos,
        worldRot:           det.worldRot,
        bbox:               det.bbox,
        dimensions:         { w: bw, h: bh, d: bd },
        ...nodeProvenance,
        // Which capture produced this detection. It exists on WorldDetection,
        // is persisted to IndexedDB, and is the summary's "Scan #" column — the
        // GLB was the one artifact that dropped it, so a detection lost its
        // capture attribution in exactly the file that outlives the session.
        // Omitted rather than null when absent: "not attributed" and
        // "attributed to nothing" are different claims.
        ...(det.captureIndex !== undefined ? { captureIndex: det.captureIndex } : {}),
        // NOTE: this holds a *session* id under a *scan* id's name, and has no
        // readers anywhere today. Left as-is beyond dropping local ids; giving
        // it real scan ids is wave 08's cross-session correspondence work.
        sourceScanIds:      serverSessionId ? [serverSessionId] : [],
        reviewedByUser:     false,
        ignored:            false,
        structuralCategory: inferClass(det.label) === 'architecture' ? 'structural' : 'non-structural',
      }

      detectionsGroup.add(mesh)
    }

    roomGroup.add(detectionsGroup)
  }

  // ── 5. Pack as GLB, trigger local download, and upload to server ──────────
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
  const filename = `${filenamePrefix}-${ts}.glb`
  if (download) triggerDownload(buffer, filename)
  console.log(
    `[export] GLB: ${(buffer.byteLength / 1024).toFixed(0)} KB,`,
    `${pointCloud.count} pts, ${poseHistory.length} poses, ${store.detections.size} objects`,
  )

  let uploadedFilename: string | undefined
  let uploadOutcome: UploadOutcome = 'skipped'
  if (upload) {
    const result = await uploadToServer(buffer, filename, data, autoSaved, capturedAt, serverSessionId)
    uploadedFilename = result.filename
    uploadOutcome = result.outcome
  }
  return { filename, size: buffer.byteLength, uploadedFilename, upload: uploadOutcome }
}

/**
 * POST the GLB to the Deno server's /upload-scan endpoint so it is persisted
 * in the scans/ folder and available in the 3D viewer.
 * Returns the server-assigned filename, or null when the upload failed.
 */
async function uploadToServer(
  buffer: ArrayBuffer,
  filename: string,
  data: ExportData,
  autoSaved: boolean,
  /** The export's single timestamp — same value the scene extras carry. */
  capturedAt: string,
  /**
   * The export's single session id — same value baked into the scene/node
   * extras. Passed rather than re-read from `store.sessionId`: GLTFExporter's
   * binary path yields to the event loop (FileReader), and a keyframe session
   * opening or rotating in that window could change the live value, making
   * the uploaded sidecar disagree with what the GLB itself already says.
   */
  serverSessionId: string | null,
): Promise<{ filename?: string; outcome: UploadOutcome }> {
  const { store, pointCloud, poseHistory, scanEntry, geoFix, qualitySummary } = data
  try {
    const metadata = JSON.stringify({
      detectionCount: store.detections.size,
      labels: [...store.detections.values()].map(d => d.label),
      // `labels` above stays a plain string[] for process-scan's text summary
      // reader; this carries each detection's real world position/confidence
      // alongside its label so server-side thing-correspondence can match on
      // actual geometry instead of fabricating a position from array index.
      detections: [...store.detections.values()].map(d => ({
        label: d.label,
        confidence: d.confidence,
        worldPos: d.worldPos,
      })),
      exportedAt: new Date().toISOString(),
      capturedAt,
      // Server session id or null — main.ts reads this straight into
      // ScanManifest.sessionId, so a local id here would name a directory
      // that does not exist. See scene.userData above.
      sessionId:  serverSessionId,
      scanName: filename.replace(/\.glb$/, ''),
      projectId: scanEntry?.projectId ?? null,
      areaId: scanEntry?.areaId ?? null,
      floorId: scanEntry?.floorId ?? null,
      roomId: scanEntry?.roomId ?? null,
      projectTransform: scanEntry?.calibration?.sessionToProject ?? null,
      calibrationMethod: scanEntry?.calibration?.method ?? null,
      calibrationResidualM: scanEntry?.calibration?.residualM ?? null,
      calibrationToleranceM: scanEntry?.calibration?.toleranceM ?? null,
      calibrationStatus: scanEntry?.calibration?.status ?? 'uncalibrated',
      calibration: scanEntry?.calibration ?? null,
      autoSaved,
      pointCount: pointCloud.count,
      poseCount: poseHistory.length,
      qualityStatus: qualitySummary?.status ?? null,
      qualityCoverageScore: qualitySummary?.coverageScore ?? null,
      qualityMissingAreas: qualitySummary?.missingAreas ?? null,
      qualityLowLightFrames: qualitySummary?.lowLightFrames ?? null,
      qualityDriftEvents: qualitySummary?.driftEvents ?? null,
      qualityReflectiveWarnings: qualitySummary?.reflectiveWarnings ?? null,
      qualityRecommendations: qualitySummary?.recommendations ?? [],
      qualitySummary: qualitySummary ?? null,
      // Geo fields — written flat so the server can index them for /scan-locations
      geoLat:     geoFix?.lat          ?? null,
      geoLng:     geoFix?.lng          ?? null,
      geoAltitudeM: geoFix?.altitudeM  ?? null,
      geoAccuracy: geoFix?.accuracy    ?? null,
      geoBearing: geoFix?.bearing      ?? null,
      geoAddress: geoFix?.address      ?? null,
      geoDisplayAddress: geoFix?.displayAddress ?? null,
      geoFixedAt: geoFix?.fixedAt      ?? null,
    })
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: 'model/gltf-binary' }), filename)
    form.append('metadata', metadata)
    const resp = await fetch('/upload-scan', { method: 'POST', body: form })
    // Queued offline is a 2xx, so the success branch below used to run and
    // destructure a `filename` the queued response does not carry — yielding
    // undefined, which the caller reports as a failed server sync for an
    // upload that was in fact stored safely and will replay on reconnect.
    // There is still no server filename to return; what changes is that the
    // log and the caller now describe what actually happened.
    if (isQueuedOffline(resp)) {
      console.log('[export] Offline — scan queued, will upload when the network returns')
      return { outcome: 'queued-offline' }
    }
    if (resp.ok) {
      const { filename: saved } = await resp.json() as { filename: string }
      console.log(`[export] Uploaded to server: ${saved}`)
      return { filename: saved, outcome: 'uploaded' }
    }
    console.warn(`[export] Server upload failed: ${resp.status}`)
  } catch (err) {
    console.warn('[export] Server upload error:', err)
  }
  return { outcome: 'failed' }
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
