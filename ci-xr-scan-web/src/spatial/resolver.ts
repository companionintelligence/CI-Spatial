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
import type { ARProvider } from '../ar/provider'
import type { RawDetection } from '../inference/prompt'

const DEDUP_RADIUS_M = 0.3

export interface WorldDetection {
  label: string
  confidence: number
  description: string
  worldPos: { x: number; y: number; z: number }
  worldRot: { x: number; y: number; z: number; w: number }
  captureTimestamp: number
}

/** Async hit-test override for WebXR (which needs a frame context) */
export type AsyncHitTestFn = (x: number, y: number) => Promise<
  { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } } | null
>

export interface ResolveOptions {
  provider: ARProvider
  /** Pass WebXRProvider.hitTestAsync when using WebXR */
  asyncHitTest?: AsyncHitTestFn
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

    // Try synchronous 8th Wall path first
    const syncHit = opts.provider.hitTest(cx, cy)
    if (syncHit) {
      hitPos = syncHit.position
      hitRot = syncHit.rotation
    } else if (opts.asyncHitTest) {
      // WebXR async path
      const asyncHit = await opts.asyncHitTest(cx, cy)
      if (asyncHit) {
        hitPos = asyncHit.position
        hitRot = asyncHit.rotation
      }
    }

    if (!hitPos) continue

    results.push({
      label: det.label,
      confidence: det.confidence,
      description: det.description,
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
