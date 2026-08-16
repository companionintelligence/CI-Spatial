/**
 * LingBot-Map reconstruction overlay.
 *
 * Loads the three artifacts the server's lingbot-map-reconstruct job writes
 *   <session>/lingbot-map.point-cloud.ply        binary PLY (LE)
 *   <session>/lingbot-map.poses.json             per-frame extrinsics+intrinsics
 *   <session>/lingbot-map.manifest.json          run index + stats
 * and renders them as two togglable Three.js groups (points + camera path)
 * attached under the selected scan's root, so the existing transform gizmo
 * moves the reconstruction with the rest of the scan.
 *
 * Loading is lazy and per-scan: a scan that has never been reconstructed
 * surfaces a hint in the side panel; a scan whose session lives on the server
 * but has no manifest yet shows "not yet reconstructed".
 */
import * as THREE from 'three'
import type { ScanManifest } from '../world/types'
import { parseLingBotMapPLY } from '../../lingbot_map_ply.ts'

export interface LingBotMapManifest {
  status: 'ok' | 'skipped' | 'error'
  pointCount?: number
  frameCount?: number
  elapsedMs?: number
  skippedReason?: string
  error?: string
}

export interface LingBotMapPoseFrame {
  index?: number
  file?: string
  timestampMs?: number | null
  cameraToWorld?: number[][] | number[] | null
  intrinsicsMatrix?: number[][] | number[] | null
}

export interface LingBotMapPoses {
  schemaVersion?: number
  frames: LingBotMapPoseFrame[]
}

export interface LingBotMapOverlay {
  scanId: string
  sessionId: string
  manifest: LingBotMapManifest
  pointsGroup: THREE.Group
  pathGroup: THREE.Group
  pointCount: number
  poseCount: number
}

const POINTS_MATERIAL = new THREE.PointsMaterial({
  size: 0.018,
  vertexColors: true,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.95,
})

const POINTS_MATERIAL_NO_RGB = new THREE.PointsMaterial({
  size: 0.018,
  color: 0xa5d6a7,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.85,
})

const PATH_MATERIAL = new THREE.LineBasicMaterial({
  color: 0xffd54f,
  transparent: true,
  opacity: 0.85,
})

const FRUSTUM_MATERIAL = new THREE.LineBasicMaterial({
  color: 0xff8a65,
  transparent: true,
  opacity: 0.6,
})

function _buildPoints(parsed: ReturnType<typeof parseLingBotMapPLY>): THREE.Points {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(parsed.xyz, 3))
  let material: THREE.PointsMaterial
  if (parsed.rgb) {
    const colors = new Float32Array(parsed.count * 3)
    for (let i = 0; i < colors.length; i++) colors[i] = parsed.rgb[i] / 255
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    material = POINTS_MATERIAL
  } else {
    material = POINTS_MATERIAL_NO_RGB
  }
  geom.computeBoundingSphere()
  const points = new THREE.Points(geom, material)
  points.name = 'lingbot-map-points'
  return points
}

function _poseToVec3(frame: LingBotMapPoseFrame): THREE.Vector3 | null {
  const ctw = frame.cameraToWorld
  if (Array.isArray(ctw) && ctw.length >= 3) {
    if (typeof ctw[0] === 'number') {
      const flat = ctw as number[]
      if (flat.length >= 16) return new THREE.Vector3(flat[3], flat[7], flat[11])
      if (flat.length >= 12) return new THREE.Vector3(flat[3], flat[7], flat[11])
    } else if (Array.isArray(ctw[0])) {
      const m = ctw as number[][]
      if (m.length >= 3 && m[0].length >= 4) {
        return new THREE.Vector3(m[0][3], m[1][3], m[2][3])
      }
    }
  }
  return null
}

function _buildPath(poses: LingBotMapPoses): { group: THREE.Group; poseCount: number } {
  const group = new THREE.Group()
  group.name = 'lingbot-map-path'
  const positions: number[] = []
  let poseCount = 0
  for (const frame of poses.frames) {
    const v = _poseToVec3(frame)
    if (!v) continue
    positions.push(v.x, v.y, v.z)
    poseCount += 1
  }
  if (poseCount >= 2) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const line = new THREE.Line(geom, PATH_MATERIAL)
    line.name = 'lingbot-map-camera-line'
    group.add(line)
  }
  // Small frustum markers every Nth frame
  const stride = Math.max(1, Math.floor(poseCount / 24))
  let placed = 0
  for (const frame of poses.frames) {
    const v = _poseToVec3(frame)
    if (!v) continue
    if (placed % stride === 0) {
      const helper = new THREE.LineSegments(_frustumGeom(), FRUSTUM_MATERIAL)
      helper.position.copy(v)
      helper.name = `lingbot-map-frustum-${placed}`
      group.add(helper)
    }
    placed += 1
  }
  return { group, poseCount }
}

function _frustumGeom(): THREE.BufferGeometry {
  const s = 0.05
  const positions = new Float32Array([
    0, 0, 0,  s, s, -s,
    0, 0, 0, -s, s, -s,
    0, 0, 0,  s, -s, -s,
    0, 0, 0, -s, -s, -s,
     s,  s, -s,  -s,  s, -s,
    -s,  s, -s,  -s, -s, -s,
    -s, -s, -s,   s, -s, -s,
     s, -s, -s,   s,  s, -s,
  ])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return g
}

export async function fetchLingBotMapArtifacts(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<LingBotMapOverlay | null> {
  if (!scan.sessionId) return null
  const sessionId = scan.sessionId
  const base = `/sessions/${encodeURIComponent(sessionId)}`
  const manifestResp = await fetcher(`${base}/lingbot-map.manifest.json`)
  if (!manifestResp.ok) return null
  const manifest = (await manifestResp.json()) as LingBotMapManifest
  if (manifest.status !== 'ok') {
    const empty = new THREE.Group()
    empty.name = 'lingbot-map-empty'
    return {
      scanId: scan.scanId,
      sessionId,
      manifest,
      pointsGroup: empty,
      pathGroup: new THREE.Group(),
      pointCount: 0,
      poseCount: 0,
    }
  }
  const [plyResp, posesResp] = await Promise.all([
    fetcher(`${base}/lingbot-map.point-cloud.ply`),
    fetcher(`${base}/lingbot-map.poses.json`),
  ])
  const pointsGroup = new THREE.Group()
  pointsGroup.name = 'lingbot-map-points-group'
  let pointCount = 0
  if (plyResp.ok) {
    try {
      const parsed = parseLingBotMapPLY(new Uint8Array(await plyResp.arrayBuffer()))
      pointsGroup.add(_buildPoints(parsed))
      pointCount = parsed.count
    } catch (e) {
      console.warn('[lingbot-map] PLY parse failed:', e)
    }
  }
  let pathGroup = new THREE.Group()
  pathGroup.name = 'lingbot-map-path'
  let poseCount = 0
  if (posesResp.ok) {
    try {
      const poses = (await posesResp.json()) as LingBotMapPoses
      const built = _buildPath(poses)
      pathGroup = built.group
      poseCount = built.poseCount
    } catch (e) {
      console.warn('[lingbot-map] poses parse failed:', e)
    }
  }
  return {
    scanId: scan.scanId,
    sessionId,
    manifest,
    pointsGroup,
    pathGroup,
    pointCount,
    poseCount,
  }
}
