/**
 * How many on-disk scans belong to one world, for the prune guard.
 *
 * The guard in world_prune.ts refuses to prune when the directory holds fewer
 * eligible scans than the world's manifest lists. This count is the world's own
 * scans only, so a Place's manifest is checked against that Place's files. The
 * scans other Places hold in the directory do not count toward it.
 */
import { type StoredScanLike, shouldIncludeStoredScanInWorld } from './world/world_membership.ts'

export function eligibleOnDiskForWorld<T extends StoredScanLike>(
  worldProjectId: string | null,
  stored: readonly T[],
  basePredicate: (scan: T) => boolean,
  existingScanFilenames: Set<string>,
): number {
  return stored.filter(scan =>
    shouldIncludeStoredScanInWorld(worldProjectId, scan, basePredicate, existingScanFilenames)
  ).length
}
