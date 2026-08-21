/**
 * Spatial resolver — converts VLM bounding boxes into 3D world positions.
 *
 * For each detection:
 *   1. Compute the bbox centroid in pixel space
 *   2. Normalise to 0–1 screen coords (matching XR8.XrController.hitTest convention)
 *   3. Run a hit-test against the SLAM feature map → {x, y, z} in world space
 *   4. Deduplicate: if an existing detection of the same label is within 0.3m,
 *      merge (update confidence, keep earlier thumbnail)
 *
 * For the WebXR provider, hitTest() is synchronous but returns null —
 * the caller must pass an async hitTestFn override in that case.
 */
import * as THREE from 'three'
import type { ARProvider, Pose, HitResult } from '../ar/provider'
import type { RawDetection } from '../inference/prompt'
import type { PointCloud } from '../scene/pointcloud'
import type { DetectionObservation } from '../world/types'

// Widened from 0.3 m: hit-test/raycast noise and viewing-angle differences
// commonly place the same real object 0.3-0.4 m apart across two captures,
// which was defeating dedup outright. Still a fixed radius, not adaptive to
// object size. Kept below 0.5 m deliberately — the existing "highly cluttered
// environment" test (tests/e2e-suite.spec.ts, Test 34) treats two same-label
// objects 0.5 m apart as genuinely distinct, and that's a real constraint on
// how far this can be pushed without merging separate furniture.
const DEDUP_RADIUS_M = 0.4
const FALLBACK_DEPTH_M = 2.0

export interface ViewSize {
  width: number
  height: number
}

export interface WorldDetection extends RawDetection {
  detectionId: string
  observations: DetectionObservation[]
  lastSeenAt: number
  worldPos: { x: number; y: number; z: number }
  worldRot: { x: number; y: number; z: number; w: number }
  captureTimestamp: number
  /** Sequential index of the capture event that produced this detection (1-based) */
  captureIndex?: number
}

/** Async hit-test override for WebXR (which needs a frame context) */
export type AsyncHitTestFn = (x: number, y: number) => Promise<HitResult | null>

export interface ResolveOptions {
  provider: ARProvider
  /** Pass WebXRProvider.hitTestAsync when using WebXR */
  asyncHitTest?: AsyncHitTestFn
  /** Current camera pose — used to estimate world pos when hit test returns nothing */
  cameraPose?: Pose
  /**
   * Three.js PerspectiveCamera built from the capture-time SLAM pose + intrinsics.
   * When provided, the resolver casts a proper frustum ray from the camera through
   * the bbox NDC.
   */
  captureCamera?: THREE.PerspectiveCamera
  /** Dimensions of the image sent to inference, or the same aspect before downscale. */
  imageSize?: ViewSize
  /** Dimensions of the live AR viewport receiving XR hit-tests. */
  viewportSize?: ViewSize
  /** Accumulated point cloud from room scanning, used for raycasting fallback */
  pointCloud?: PointCloud
  sessionId?: string
}

/**
 * Resolve raw detections to world positions.
 * Returns an array of WorldDetection — may be shorter than `detections`
 * if some hit-tests return no result.
 */
function ensureValidRotation(q: any): { x: number; y: number; z: number; w: number } {
  if (!q) return { x: 0, y: 0, z: 0, w: 1 }

  // Extract values, checking standard properties (x, y, z, w), private fields (_x, _y, _z, _w), and arrays
  let x = typeof q.x === 'number' ? q.x : (typeof q._x === 'number' ? q._x : (Array.isArray(q) ? q[0] : undefined))
  let y = typeof q.y === 'number' ? q.y : (typeof q._y === 'number' ? q._y : (Array.isArray(q) ? q[1] : undefined))
  let z = typeof q.z === 'number' ? q.z : (typeof q._z === 'number' ? q._z : (Array.isArray(q) ? q[2] : undefined))
  let w = typeof q.w === 'number' ? q.w : (typeof q._w === 'number' ? q._w : (Array.isArray(q) ? q[3] : undefined))

  // If any values are missing, non-numeric, or null, use default identity quaternion parts
  if (x === undefined || x === null || isNaN(x)) x = 0
  if (y === undefined || y === null || isNaN(y)) y = 0
  if (z === undefined || z === null || isNaN(z)) z = 0
  if (w === undefined || w === null || isNaN(w)) w = 1

  const lenSq = x * x + y * y + z * z + w * w
  // If quaternion has zero/near-zero length or is invalid, return identity quaternion
  if (lenSq < 0.001 || isNaN(lenSq)) {
    return { x: 0, y: 0, z: 0, w: 1 }
  }

  const len = Math.sqrt(lenSq)
  return { x: x / len, y: y / len, z: z / len, w: w / len }
}

/** A hit-test/fallback position is only usable once every axis is a real, finite number. */
function isFiniteVec3(p: { x: number; y: number; z: number } | null | undefined): p is { x: number; y: number; z: number } {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function raycastPointCloud(
  ray: THREE.Raycaster,
  pointCloud: PointCloud,
  maxDistanceToRay = 0.25, // 25 cm tolerance
  minDepth = 0.5,
  maxDepth = 5.0
): { position: { x: number; y: number; z: number } } | null {
  const pts = pointCloud.toFloat32Array()
  const count = pointCloud.count
  if (count === 0) return null

  let bestPoint: { x: number; y: number; z: number } | null = null
  let bestDistToRay = Infinity

  const rayOrigin = ray.ray.origin
  const rayDir = ray.ray.direction

  for (let i = 0; i < count; i++) {
    const px = pts[i * 3]
    const py = pts[i * 3 + 1]
    const pz = pts[i * 3 + 2]

    // Calculate projection of point onto ray
    // v = p - origin
    const vx = px - rayOrigin.x
    const vy = py - rayOrigin.y
    const vz = pz - rayOrigin.z

    // depth along the ray (dot product)
    const depth = vx * rayDir.x + vy * rayDir.y + vz * rayDir.z
    if (depth < minDepth || depth > maxDepth) continue

    // perpendicular distance to ray
    // perp = v - depth * dir
    const perpx = vx - depth * rayDir.x
    const perpy = vy - depth * rayDir.y
    const perpz = vz - depth * rayDir.z
    const distToRay = Math.sqrt(perpx * perpx + perpy * perpy + perpz * perpz)

    if (distToRay < maxDistanceToRay) {
      if (distToRay < bestDistToRay) {
        bestDistToRay = distToRay
        bestPoint = { x: px, y: py, z: pz }
      }
    }
  }

  return bestPoint ? { position: bestPoint } : null
}

function pointOnCaptureRay(
  cx: number,
  cy: number,
  camera: THREE.PerspectiveCamera,
  depth = FALLBACK_DEPTH_M,
): { x: number; y: number; z: number } {
  const ndc = new THREE.Vector2(cx * 2 - 1, -(cy * 2 - 1))
  const ray = new THREE.Raycaster()
  ray.setFromCamera(ndc, camera)
  const point = ray.ray.origin.clone().add(ray.ray.direction.clone().multiplyScalar(depth))
  return { x: point.x, y: point.y, z: point.z }
}

/**
 * Convert a VLM bbox point from captured-image coordinates into live viewport
 * coordinates. XR8 renders the camera feed as a full-bleed canvas; when the
 * captured camera frame has a different aspect ratio than the viewport, the
 * visual feed is effectively cover-cropped. Hit-tests and Three.js rays must
 * use the post-crop viewport coordinate, not the raw image coordinate.
 */
export function imagePointToViewportPoint(
  x: number,
  y: number,
  imageSize: ViewSize | undefined,
  viewportSize: ViewSize | undefined,
): { x: number; y: number } {
  if (!imageSize || !viewportSize) return { x, y }
  const iw = imageSize.width
  const ih = imageSize.height
  const vw = viewportSize.width
  const vh = viewportSize.height
  if (![iw, ih, vw, vh].every((n) => Number.isFinite(n) && n > 0)) return { x, y }

  const scale = Math.max(vw / iw, vh / ih)
  const displayedW = iw * scale
  const displayedH = ih * scale
  const offsetX = (vw - displayedW) / 2
  const offsetY = (vh - displayedH) / 2
  return {
    x: (x * iw * scale + offsetX) / vw,
    y: (y * ih * scale + offsetY) / vh,
  }
}

export async function resolveDetections(
  detections: RawDetection[],
  timestamp: number,
  opts: ResolveOptions,
): Promise<WorldDetection[]> {
  const results: WorldDetection[] = []

  for (const det of detections) {
    console.log(`[resolver] Resolving object "${det.label}" with bbox:`, JSON.stringify(det.bbox))
    const [x1, y1, x2, y2] = det.bbox
    const imageCx = (x1 + x2) / 2
    const imageCy = (y1 + y2) / 2
    const mapped = imagePointToViewportPoint(imageCx, imageCy, opts.imageSize, opts.viewportSize)
    const cx = mapped.x
    const cy = mapped.y
    if (cx !== imageCx || cy !== imageCy) {
      console.log('[resolver] image bbox center mapped to viewport:', JSON.stringify({
        image: { x: imageCx, y: imageCy },
        viewport: { x: cx, y: cy },
        imageSize: opts.imageSize,
        viewportSize: opts.viewportSize,
      }))
    }

    let hitPos: { x: number; y: number; z: number } | null = null
    let hitRot = { x: 0, y: 0, z: 0, w: 1 }

    // 1. Try synchronous provider hit-testing at centroid (0-1 screen coordinates)
    const syncHit = opts.provider.hitTest(cx, cy)
    if (syncHit) {
      let dist = syncHit.distance
      if (dist === undefined || isNaN(dist)) {
        if (opts.cameraPose) {
          const cp = opts.cameraPose.position
          const hp = syncHit.position
          dist = Math.sqrt((cp.x - hp.x) ** 2 + (cp.y - hp.y) ** 2 + (cp.z - hp.z) ** 2)
        } else {
          dist = 1.0
        }
      }
      if (dist >= 0.3) {
        if (isFiniteVec3(syncHit.position)) {
          hitPos = syncHit.position
          hitRot = ensureValidRotation(syncHit.rotation)
          console.log(`[resolver] Centroid hitTest accepted at distance ${dist.toFixed(2)}m:`, JSON.stringify(hitPos))
        } else {
          console.warn('[resolver] Centroid hitTest rejected: non-finite position', JSON.stringify(syncHit.position))
        }
      } else {
        console.warn(`[resolver] Centroid hitTest rejected: too close to camera (${dist.toFixed(3)}m)`)
      }
    }

    // 2. Try asynchronous hit-testing fallback (for WebXR frame context)
    if (!hitPos && opts.asyncHitTest) {
      const asyncHit = await opts.asyncHitTest(cx, cy)
      if (asyncHit) {
        let dist = asyncHit.distance
        if (dist === undefined || isNaN(dist)) {
          if (opts.cameraPose) {
            const cp = opts.cameraPose.position
            const hp = asyncHit.position
            dist = Math.sqrt((cp.x - hp.x) ** 2 + (cp.y - hp.y) ** 2 + (cp.z - hp.z) ** 2)
          } else {
            dist = 1.0
          }
        }
        if (dist >= 0.3) {
          if (isFiniteVec3(asyncHit.position)) {
            hitPos = asyncHit.position
            hitRot = ensureValidRotation(asyncHit.rotation)
            console.log(`[resolver] Async hitTest accepted at distance ${dist.toFixed(2)}m:`, JSON.stringify(hitPos))
          } else {
            console.warn('[resolver] Async hitTest rejected: non-finite position', JSON.stringify(asyncHit.position))
          }
        } else {
          console.warn(`[resolver] Async hitTest rejected: too close to camera (${dist.toFixed(3)}m)`)
        }
      }
    }

    // 3. Try raycasting against the accumulated point cloud
    if (!hitPos && opts.captureCamera && opts.pointCloud) {
      const cam = opts.captureCamera
      const ndc = new THREE.Vector2(cx * 2 - 1, -(cy * 2 - 1))
      const ray = new THREE.Raycaster()
      ray.setFromCamera(ndc, cam)

      const cloudHit = raycastPointCloud(ray, opts.pointCloud)
      if (cloudHit && isFiniteVec3(cloudHit.position)) {
        hitPos = cloudHit.position
        // Fallback to camera orientation
        hitRot = ensureValidRotation(opts.cameraPose?.rotation)
        console.log('[resolver] Point cloud raycast hit:', JSON.stringify(hitPos))
      } else if (cloudHit) {
        console.warn('[resolver] Point cloud raycast rejected: non-finite position', JSON.stringify(cloudHit.position))
      }
    }

    // 4. Fallback: place object along its bbox camera ray, or straight ahead
    // when no capture camera is available. These are two independent attempts,
    // not an either/or on which inputs happen to be present — a non-finite
    // bbox-ray candidate (4a) must still fall through to the camera-pose
    // candidate (4b) when cameraPose is also available, same as every earlier
    // tier falls through on an invalid result.
    if (!hitPos && opts.captureCamera) {
      const candidate = pointOnCaptureRay(cx, cy, opts.captureCamera)
      if (isFiniteVec3(candidate)) {
        hitPos = candidate
        hitRot = ensureValidRotation(opts.cameraPose?.rotation ?? opts.captureCamera.quaternion)
        console.warn(`[resolver] Hit test miss for "${det.label}" — using bbox ray fallback:`, JSON.stringify(hitPos))
      } else {
        console.warn(`[resolver] Hit test miss for "${det.label}" — bbox ray fallback produced a non-finite position`)
      }
    }

    if (!hitPos && opts.cameraPose) {
      const p = opts.cameraPose.position
      const q = opts.cameraPose.rotation
      const cameraDir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
      const candidate = {
        x: p.x + cameraDir.x * FALLBACK_DEPTH_M,
        y: p.y + cameraDir.y * FALLBACK_DEPTH_M,
        z: p.z + cameraDir.z * FALLBACK_DEPTH_M,
      }
      if (isFiniteVec3(candidate)) {
        hitPos = candidate
        hitRot = ensureValidRotation(q)
        console.warn(`[resolver] Hit test miss for "${det.label}" — using fallback position in front of camera:`, JSON.stringify(hitPos))
      } else {
        console.warn(`[resolver] Hit test miss for "${det.label}" — camera-relative fallback produced a non-finite position`)
      }
    }

    if (!hitPos && !opts.captureCamera && !opts.cameraPose) {
      console.warn(`[resolver] Hit test miss for "${det.label}" and no camera pose — skipping`)
    }

    // Every tier above only assigns hitPos once its candidate passes isFiniteVec3 — this is
    // the single place that catches "no tier produced anything usable" and skips the
    // detection, rather than persisting a NaN/Infinity worldPos that would corrupt dedup
    // bucketing (bucket()/dist() both go silently wrong on non-finite input) and any
    // downstream bounding-box math.
    if (!hitPos) {
      console.warn(`[resolver] No usable position for "${det.label}" — skipping`)
      continue
    }

    console.log(`[resolver] Resolved "${det.label}" to worldPos:`, JSON.stringify(hitPos), 'worldRot:', JSON.stringify(hitRot))

    const captureIndex = (det as { captureIndex?: number }).captureIndex
    const observation = observationFromDetection(det, hitPos, hitRot, timestamp, opts.sessionId ?? 'local', captureIndex)
    results.push({
      ...det,
      detectionId: `det-${timestamp}-${crypto.randomUUID().slice(0, 8)}`,
      observations: [observation],
      lastSeenAt: timestamp,
      label: det.label,
      confidence: det.confidence,
      description: det.description,
      bbox: det.bbox,
      worldPos: hitPos,
      worldRot: hitRot,
      captureTimestamp: timestamp,
    })
  }

  return results
}

/**
 * Merge a new set of world detections into an existing accumulator,
 * deduplicating by (label + proximity < DEDUP_RADIUS_M).
 *
 * Returns a new Map — does not mutate `existing`.
 */
export function mergeDetections(
  existing: Map<string, WorldDetection>,
  incoming: WorldDetection[],
): Map<string, WorldDetection> {
  const merged = new Map(existing)

  for (const det of incoming) {
    const key = findNearbyKey(merged, det)
    if (key) {
      // Update confidence; keep earlier timestamp, description of higher confidence
      const prev = merged.get(key)!
      const observations = appendObservation(prev.observations, observationFromWorldDetection(det))
      merged.set(key, {
        ...prev,
        confidence: Math.max(prev.confidence, det.confidence),
        description: det.confidence > prev.confidence ? det.description : prev.description,
        observations,
        lastSeenAt: Math.max(prev.lastSeenAt ?? prev.captureTimestamp, det.captureTimestamp),
      })
    } else {
      // New unique detection — key by label + position bucket
      const newKey = `${det.label}:${bucket(det.worldPos)}`
      merged.set(newKey, det)
    }
  }

  return merged
}

export function observationFromWorldDetection(det: WorldDetection): DetectionObservation {
  return det.observations?.[0] ?? observationFromDetection(
    det,
    det.worldPos,
    det.worldRot,
    det.captureTimestamp,
    'local',
    det.captureIndex,
  )
}

function observationFromDetection(
  det: RawDetection,
  worldPos: { x: number; y: number; z: number },
  worldRot: { x: number; y: number; z: number; w: number },
  captureTimestamp: number,
  sessionId: string,
  captureIndex?: number,
): DetectionObservation {
  return {
    observationId: `obs-${captureTimestamp}-${crypto.randomUUID().slice(0, 8)}`,
    sessionId,
    label: det.label,
    confidence: det.confidence,
    description: det.description,
    bbox: det.bbox,
    worldPos,
    worldRot,
    captureTimestamp,
    ...(captureIndex !== undefined ? { captureIndex } : {}),
  }
}

function appendObservation(
  existing: DetectionObservation[] | undefined,
  incoming: DetectionObservation,
): DetectionObservation[] {
  const observations = existing?.length ? [...existing] : []
  observations.push(incoming)
  if (observations.length <= 50) return observations
  return [observations[0], ...observations.slice(-49)]
}

/** Nearest same-label entry within DEDUP_RADIUS_M, not just the first one iterated. */
function findNearbyKey(map: Map<string, WorldDetection>, det: WorldDetection): string | null {
  let bestKey: string | null = null
  let bestDist = DEDUP_RADIUS_M
  for (const [key, existing] of map) {
    if (existing.label !== det.label) continue
    const d = dist(existing.worldPos, det.worldPos)
    if (d < bestDist) {
      bestDist = d
      bestKey = key
    }
  }
  return bestKey
}

function dist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

/** Coarse pos bucket for key generation */
export function bucket(p: { x: number; y: number; z: number }): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`
}
