import { geoToEnu, hasGeoPose } from '../../src/world/geo.ts'
import type { GeoPose, ScanManifest, WorldProject } from '../../src/world/types.ts'

export const WORLD_SCAN_MAX_RADIUS_M = Number(Deno.env.get('WORLD_SCAN_MAX_RADIUS_M') ?? 250)

export interface StoredScanLike {
  filename: string
  size: number
  meta: Record<string, unknown>
}

export function scanProjectId(meta: Record<string, unknown>): string | null {
  const value = meta['projectId']
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function belongsToWorldProject(
  worldProjectId: string | null,
  scanProjectIdValue: string | null,
  existingScanFilenames: Set<string> = new Set(),
  filename = '',
): boolean {
  if (worldProjectId === null) {
    return existingScanFilenames.has(filename) || scanProjectIdValue === null
  }
  return scanProjectIdValue === worldProjectId
}

export function shouldIncludeStoredScanInWorld<T extends StoredScanLike>(
  worldProjectId: string | null,
  scan: T,
  basePredicate: (scan: T) => boolean,
  existingScanFilenames: Set<string> = new Set(),
): boolean {
  return basePredicate(scan)
    && belongsToWorldProject(worldProjectId, scanProjectId(scan.meta), existingScanFilenames, scan.filename)
}

export function geoDistanceM(origin: GeoPose, scan: GeoPose): number | null {
  if (!hasGeoPose(origin) || !hasGeoPose(scan)) return null
  const enu = geoToEnu(origin, scan)
  return Math.sqrt(enu.x ** 2 + enu.z ** 2)
}

export function placeScanTransform(
  origin: GeoPose,
  scanGeoPose: GeoPose,
  fallbackIndex: number,
  maxRadiusM = WORLD_SCAN_MAX_RADIUS_M,
): { translation: { x: number; y: number; z: number }; geoDistanceM: number | null; geoOutlier: boolean } {
  const distance = geoDistanceM(origin, scanGeoPose)
  if (distance !== null && distance <= maxRadiusM) {
    return { translation: geoToEnu(origin, scanGeoPose), geoDistanceM: distance, geoOutlier: false }
  }
  return {
    translation: { x: (fallbackIndex % 6) * 3, y: 0, z: Math.floor(fallbackIndex / 6) * 3 },
    geoDistanceM: distance,
    geoOutlier: distance !== null,
  }
}

export function ensureWorldProjectCollections(world: WorldProject): void {
  world.projectId ??= null
  world.things ??= []
  world.thingObservations ??= []
  world.comments ??= []
  for (const scan of world.scans) {
    scan.projectId ??= null
    scan.geoDistanceM ??= null
  }
}
