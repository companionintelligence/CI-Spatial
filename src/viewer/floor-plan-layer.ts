/**
 * Floor-plan layer discovery.
 *
 * When a scan has been through the `floor-plan` world job, the server lands
 * the derived 2D plan next to the source scan:
 *
 *   /scans/<base>.floor-plan.json           walls/rooms/areaM2 (derived plan)
 *   /scans/<base>.floor-plan.svg            rendered plan (inline preview)
 *   /scans/<base>.floor-plan.manifest.json  run index (status/areaM2/wallCount)
 *
 * This module mirrors splat-layer.ts: pure URL helpers + a manifest fetcher
 * the viewer's Layers-tab "Floor Plan" section drives. Kept fetch-injectable
 * so the mock spec can exercise it without a live coordinator.
 */
import type { ScanManifest } from '../world/types'
import { scanArtifactBase } from './splat-layer'

export interface FloorPlanManifestLite {
  status: 'ok' | 'skipped' | 'error'
  planPath?: string
  svgPath?: string
  areaM2?: number
  wallCount?: number
  roomCount?: number
  ceilingHeightM?: number
  skippedReason?: string
  remediation?: string
  error?: string
  timing?: { elapsedMs?: number }
}

/** URL of a scan's floor-plan manifest on the gated artifact route. */
export function floorPlanManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.manifest.json`)}`
}

/** URL of a scan's rendered floor-plan SVG on the gated artifact route. */
export function floorPlanSvgUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.svg`)}`
}

/** URL of a scan's floor-plan JSON (walls/rooms/areaM2) on the gated artifact route. */
export function floorPlanJsonUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.floor-plan.json`)}`
}

/**
 * Fetch the scan's floor-plan manifest. Returns null when the scan has never
 * been through the floor-plan job (a 404 is the expected "no plan yet" state).
 */
export async function fetchFloorPlanManifest(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<FloorPlanManifestLite | null> {
  const response = await fetcher(floorPlanManifestUrl(scan))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`floor-plan manifest fetch failed: ${response.status}`)
  const manifest = await response.json() as FloorPlanManifestLite
  if (manifest.status !== 'ok' && manifest.status !== 'skipped' && manifest.status !== 'error') {
    throw new Error('floor-plan manifest has no status')
  }
  return manifest
}
