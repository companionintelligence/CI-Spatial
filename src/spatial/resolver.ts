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
import type { ARProvider, Pose } from '../ar/provider'
import type { RawDetection } from '../inference/prompt'

const DEDUP_RADIUS_M = 0.3

export interface WorldDetection {
  label: string
  confidence: number
  description: string
  /** Normalised [x1,y1,x2,y2] bounding box from VLM inference */
  bbox: [number, number, number, number]
  worldPos: { x: number; y: number; z: number }
  worldRot: { x: number; y: number; z: number; w: number }
  captureTimestamp: number
  /** Sequential index of the capture event that produced this detection (1-based) */
  captureIndex?: number
}

/** Async hit-test override for WebXR (which needs a frame context) */
export type AsyncHitTestFn = (x: number, y: number) => Promise<
  { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } } | null
>

export interface ResolveOptions {
  provider: ARProvider
  /** Pass WebXRProvider.hitTestAsync when using WebXR */
  asyncHitTest?: AsyncHitTestFn
  /** Current camera pose — used to estimate world pos when hit test returns nothing */
  cameraPose?: Pose
  /**
   * Three.js PerspectiveCamera built from the capture-time SLAM pose + intrinsics.
   * When provided, the resolver casts a proper frustum ray from the camera through
   * the bbox NDC and samples multiple points along it for higher-accuracy placement.
   */
  captureCamera?: THREE.PerspectiveCamera
}

/**
 * Resolve raw detections to world positions.
 * Returns an array of WorldDetection — may be shorter than `detections`
 * if some hit-tests return no result.
 */
export async function resolveDetections(
  detections: RawDetection[],
  timestamp: number,
  opts: ResolveOptions,
): Promise<WorldDetection[]> {
  const results: WorldDetection[] = []

  for (const det of detections) {
    const [x1, y1, x2, y2] = det.bbox
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2

    let hitPos: { x: number; y: number; z: number } | null = null
    let hitRot = { x: 0, y: 0, z: 0, w: 1 }

    // --- Frustum raycast strategy ---
    // When we have the capture-time camera, the bbox center in image space
    // (0-1) maps to NDC as: ndcX = cx*2-1, ndcY = -(cy*2-1).
    // We cast a THREE.Raycaster ray from the camera through that NDC point,
    // then sample along the ray at several depths to find SLAM feature points.
    // This is more accurate than passing cx/cy directly to hitTest, especially
    // when the captured image aspect differs from the display.
    if (opts.captureCamera) {
      const cam   = opts.captureCamera
      const ndc   = new THREE.Vector2(cx * 2 - 1, -(cy * 2 - 1))
      const ray   = new THREE.Raycaster()
      ray.setFromCamera(ndc, cam)

      // Convert the ray origin + direction back to normalised screen coords in
      // XR8-space (XR8 hitTest uses display-normalised 0-1, Y down).
      // We sample a few depths and pick the first that returns a SLAM hit.
      const depths = [1.0, 1.5, 2.0, 2.5, 3.0]
      for (const depth of depths) {
        const worldPt = ray.ray.origin.clone().addScaledVector(ray.ray.direction, depth)
        // Project back to screen NDC to get the x/y for hitTest
        const screenNDC = worldPt.clone().project(cam)
        const hx = (screenNDC.x + 1) / 2
        const hy = (-screenNDC.y + 1) / 2
        if (hx < 0 || hx > 1 || hy < 0 || hy > 1) continue
        const syncHit = opts.provider.hitTest(hx, hy)
        if (syncHit) {
          hitPos = syncHit.position
          hitRot = syncHit.rotation
          break
        }
      }

      // If ray-sampled hitTest yielded nothing, fall back to bbox-center hitTest
      if (!hitPos) {
        const syncHit = opts.provider.hitTest(cx, cy)
        if (syncHit) { hitPos = syncHit.position; hitRot = syncHit.rotation }
      }
    } else {
      // No camera available — simple bbox-centre hit test
      const syncHit = opts.provider.hitTest(cx, cy)
      if (syncHit) { hitPos = syncHit.position; hitRot = syncHit.rotation }
    }

    // WebXR async fallback (no sync hitTest support)
    if (!hitPos && opts.asyncHitTest) {
      const asyncHit = await opts.asyncHitTest(cx, cy)
      if (asyncHit) { hitPos = asyncHit.position; hitRot = asyncHit.rotation }
    }

    if (!hitPos) {
      // SLAM hit test had no feature points yet — estimate position 2 m in front of
      // the camera using the quaternion to derive the forward direction.
      if (opts.cameraPose) {
        const p = opts.cameraPose.position
        const q = opts.cameraPose.rotation
        // Rotate the -Z world axis by the camera quaternion to get forward vector.
        // forward = q * (0,0,-1) * q^-1 (simplified)
        const fx = 2 * (q.x * q.z + q.w * q.y)
        const fy = 2 * (q.y * q.z - q.w * q.x)
        const fz = 1 - 2 * (q.x * q.x + q.y * q.y)
        const DEPTH = 2.0 // metres
        hitPos = { x: p.x + fx * DEPTH, y: p.y + fy * DEPTH, z: p.z - fz * DEPTH }
        hitRot = q
        console.warn(`[resolver] Hit test miss for "${det.label}" — using estimated pos`, hitPos)
      } else {
        console.warn(`[resolver] Hit test miss for "${det.label}" and no camera pose — skipping`)
        continue
      }
    }

    results.push({
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
      merged.set(key, {
        ...prev,
        confidence: Math.max(prev.confidence, det.confidence),
        description: det.confidence > prev.confidence ? det.description : prev.description,
      })
    } else {
      // New unique detection — key by label + position bucket
      const newKey = `${det.label}:${bucket(det.worldPos)}`
      merged.set(newKey, det)
    }
  }

  return merged
}

function findNearbyKey(map: Map<string, WorldDetection>, det: WorldDetection): string | null {
  for (const [key, existing] of map) {
    if (existing.label !== det.label) continue
    if (dist(existing.worldPos, det.worldPos) < DEDUP_RADIUS_M) return key
  }
  return null
}

function dist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

/** Coarse pos bucket for key generation */
function bucket(p: { x: number; y: number; z: number }): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`
}
