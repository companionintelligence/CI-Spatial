/**
 * Splat-detect overlay: labeled 3D object boxes from the `splat-detect` job.
 *
 * When a scan has been through the `splat-detect` world job, the server lands
 * two sidecars next to the source scan (see main.ts artifact allowlist):
 *
 *   /scans/<base>.interactions.json          splat-analyzer objects + boxes
 *   /scans/<base>.splat-detect.manifest.json run index (status/objectCount/prompt)
 *
 * `interactions.json` is copied verbatim from splat_analyzer's run_local.py; its
 * shape is `{ objects: [{ label, position{x,y,z}, rotation{x,y,z,w}, scale{x,y,z},
 * frames:[…] }], frame_annotations:{} }`. Each object is an oriented bounding box:
 * `position` is the centre, `scale` the full extent, `rotation` a quaternion.
 *
 * This module fetches both sidecars and, for the `ok` case, builds a THREE.Group
 * of wireframe boxes + label markers ready to attach under the selected scan's
 * root — mirroring the LingBot-Map overlay attach pattern so the transform gizmo
 * moves the boxes with the rest of the scan. Label DOM sprites are the viewer's
 * job (it owns the projected-label container); this module returns the world
 * positions + text so the caller can create them.
 */
import * as THREE from 'three'
import type { ScanManifest, SplatDetectManifest as ServerSplatDetectManifest } from '../world/types'
import { type DetectObject, parseDetectObjects } from '../world/detect-objects'
import { scanArtifactBase } from './splat-layer'

// The interactions.json shape + parser moved to ../world/detect-objects.ts so
// the Deno-side memory push can read the same sidecar without type-importing
// this file (it imports `three`) — ADR 0001/0002. Re-exported here because
// this module has been the import point for both since they were written.
export { type DetectObject, type DetectObjectRecord, parseDetectObjects, parseDetectRecords } from '../world/detect-objects'

/**
 * Viewer-side read of a splat-detect manifest — the real server type
 * (SplatDetectManifest, defined in src/world/manifests.ts as an extension of
 * PipelineManifestBase and re-exported from src/world/types.ts), loosened
 * for older on-disk manifests: `schemaVersion`/`tool` predate this ticket's
 * shared envelope, `prompt` predates detect's open-vocab prompt support, and
 * `timing.elapsedMs` predates timing being recorded at all.
 */
export type SplatDetectManifest = Omit<ServerSplatDetectManifest, 'schemaVersion' | 'tool' | 'prompt' | 'timing'> & {
  schemaVersion?: number
  tool?: string
  prompt?: string
  timing?: { elapsedMs?: number }
}

export interface DetectLabelMarker {
  text: string
  position: THREE.Vector3
}

export interface ScanDetectLayer {
  scanId: string
  manifest: SplatDetectManifest
  /** Wireframe-box group, ready to attach under the scan root. */
  boxesGroup: THREE.Group
  /** Label text + world-space anchor for each detected object. */
  labels: DetectLabelMarker[]
  objectCount: number
}

/** URL of a scan's splat-detect manifest on the gated artifact route. */
export function detectManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.splat-detect.manifest.json`)}`
}

/** URL of a scan's interactions.json on the gated artifact route. */
export function detectInteractionsUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.interactions.json`)}`
}

const BOX_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x72ddd4,
  transparent: true,
  opacity: 0.9,
})

/**
 * Build a wireframe-box group + label anchors from parsed detect objects.
 * Each box is a unit BoxGeometry edge set scaled to the object's extent and
 * placed/oriented by its pose. Exported so the unit/integration test can build
 * boxes without hitting the network.
 */
export function buildDetectBoxes(objects: DetectObject[]): {
  group: THREE.Group
  labels: DetectLabelMarker[]
} {
  const group = new THREE.Group()
  group.name = 'splat-detect-boxes'
  const labels: DetectLabelMarker[] = []
  const unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!
    const box = new THREE.LineSegments(unitEdges, BOX_MATERIAL)
    box.scale.set(Math.abs(obj.scale.x) || 0.1, Math.abs(obj.scale.y) || 0.1, Math.abs(obj.scale.z) || 0.1)
    box.position.set(obj.position.x, obj.position.y, obj.position.z)
    if (obj.rotation) {
      box.quaternion.set(obj.rotation.x, obj.rotation.y, obj.rotation.z, obj.rotation.w)
    }
    box.name = `detect-box-${i}-${obj.label}`
    box.userData['label'] = obj.label
    box.userData['detectIndex'] = i
    group.add(box)
    labels.push({
      text: obj.label,
      position: new THREE.Vector3(obj.position.x, obj.position.y, obj.position.z),
    })
  }
  return { group, labels }
}

/**
 * Fetch a scan's splat-detect sidecars and build the box overlay. Returns null
 * when the scan has no detect manifest yet (the job hasn't run). `fetcher` is
 * injectable so callers can add an access token / route it at a test server,
 * mirroring fetchScanSplatLayer / fetchLingBotMapArtifacts.
 */
export async function fetchScanDetectLayer(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<ScanDetectLayer | null> {
  const manifestResp = await fetcher(detectManifestUrl(scan))
  if (!manifestResp.ok) return null
  const manifest = (await manifestResp.json()) as SplatDetectManifest

  const empty = new THREE.Group()
  empty.name = 'splat-detect-boxes'
  if (manifest.status !== 'ok') {
    return { scanId: scan.scanId, manifest, boxesGroup: empty, labels: [], objectCount: 0 }
  }

  const interactionsResp = await fetcher(detectInteractionsUrl(scan))
  if (!interactionsResp.ok) {
    return { scanId: scan.scanId, manifest, boxesGroup: empty, labels: [], objectCount: manifest.objectCount ?? 0 }
  }
  let objects: DetectObject[] = []
  try {
    objects = parseDetectObjects(await interactionsResp.json())
  } catch (e) {
    console.warn('[splat-detect] interactions parse failed:', e)
  }
  const { group, labels } = buildDetectBoxes(objects)
  return {
    scanId: scan.scanId,
    manifest,
    boxesGroup: group,
    labels,
    objectCount: manifest.objectCount ?? objects.length,
  }
}
