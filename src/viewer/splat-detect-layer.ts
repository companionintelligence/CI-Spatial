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
import type { ScanManifest } from '../world/types'
import { scanArtifactBase } from './splat-layer'

export interface SplatDetectManifest {
  schemaVersion?: number
  tool?: string
  status: 'ok' | 'skipped' | 'error'
  objectCount?: number
  prompt?: string
  interactionsPath?: string
  skippedReason?: string
  error?: string
  timing?: { elapsedMs?: number }
}

export interface DetectObject {
  label: string
  position: { x: number; y: number; z: number }
  rotation?: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
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
  color: 0x80ffe1,
  transparent: true,
  opacity: 0.9,
})

/** Read the `objects` array out of a raw interactions.json payload. */
export function parseDetectObjects(payload: unknown): DetectObject[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>)['objects']
        ?? (payload as Record<string, unknown>)['interactions'])
      : null
  if (!Array.isArray(list)) return []
  const out: DetectObject[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const position = _vec3(o['position'])
    const scale = _vec3(o['scale'])
    if (!position || !scale) continue
    out.push({
      label: typeof o['label'] === 'string' ? o['label'] : 'object',
      position,
      rotation: _quat(o['rotation']),
      scale,
    })
  }
  return out
}

function _vec3(v: unknown): { x: number; y: number; z: number } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r['x'] !== 'number' || typeof r['y'] !== 'number' || typeof r['z'] !== 'number') return null
  return { x: r['x'], y: r['y'], z: r['z'] }
}

function _quat(v: unknown): { x: number; y: number; z: number; w: number } | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r['x'] !== 'number' || typeof r['y'] !== 'number'
    || typeof r['z'] !== 'number' || typeof r['w'] !== 'number') return undefined
  return { x: r['x'], y: r['y'], z: r['z'], w: r['w'] }
}

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
