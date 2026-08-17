/**
 * Decides whether a world manifest may drop scan entries whose `.glb` is not
 * on disk.
 *
 * Why this exists: `refreshWorldScans()` in `main.ts` self-heals a manifest by
 * removing entries whose file has gone — a scan deleted out of band, or a
 * storage reset that never reached the manifest. Left unguarded that filter
 * has the failure direction backwards, because the two sides of the comparison
 * are not equally trustworthy. The manifest is the durable record: it carries
 * manual `localToWorld` alignment, names, and review status that exist nowhere
 * else. The `scans/` directory is the volatile side — it is gitignored, it is
 * pointed at a throwaway path by every test harness, and it can be cleaned,
 * remounted, or reset without anything else in the system noticing.
 *
 * Observed: a checkout whose `scans/` held one capture served a single
 * `GET /worlds/default`, and the manifest went from 253 scans to 1. No write
 * endpoint was called; a read was enough. The entries were only recoverable
 * because `worlds/default.json` happens to be tracked in git.
 *
 * So the rule is inverted from "prune unless the listing is empty" to "prune
 * only when the listing is at least as complete as the manifest". A directory
 * holding fewer scans than the manifest describes is treated as the stale
 * side, and nothing is dropped. The cost is that a genuinely deleted scan can
 * linger as a stale row until the directory returns to parity; that is a
 * visible, reversible annoyance, where the alternative is silent, permanent
 * loss of the only copy. Explicit deletion is unaffected — `DELETE /scans`
 * prunes through `removeScanFromWorlds()`, which knows a file is gone because
 * it is the thing that removed it.
 */

/** Why a prune pass declined to remove anything. */
export type PruneSkipReason =
  /** The directory listing came back empty — unmounted or moved aside, not necessarily empty. */
  | 'empty-listing'
  /** Fewer scans on disk than the manifest describes — the directory is the stale side. */
  | 'listing-thinner-than-manifest'

export interface PruneResult<T> {
  /** The surviving entries. Always a new array — never the caller’s. */
  scans: T[]
  /** How many entries were removed. */
  pruned: number
  /** How many entries have a filename with no matching file on disk, pruned or not. */
  missing: number
  /** Set when the pass declined to prune; `null` when the prune ran. */
  skipped: PruneSkipReason | null
}

/**
 * Remove manifest entries whose file is absent from disk — but only when the
 * listing is credible enough to be treated as authoritative.
 *
 * @param scans          The manifest's scan entries. Not mutated.
 * @param onDisk         Every filename present in the scans directory, derived
 *                       artifacts included — this answers "does this file exist",
 *                       so it must not be pre-filtered to world-eligible scans.
 * @param eligibleOnDisk How many on-disk scans are eligible to appear in a world.
 *                       Compared against `scans.length`, so it must be counted
 *                       with the same predicate that decides world membership,
 *                       or the two sides aren't measuring the same thing.
 */
export function pruneScansMissingFromDisk<T extends { filename?: string }>(
  scans: readonly T[],
  onDisk: ReadonlySet<string>,
  eligibleOnDisk: number,
): PruneResult<T> {
  // An entry with no filename is not file-backed and is never a prune candidate.
  const missing = scans.filter(scan => scan.filename && !onDisk.has(scan.filename)).length

  if (onDisk.size === 0) {
    return { scans: [...scans], pruned: 0, missing, skipped: 'empty-listing' }
  }
  if (eligibleOnDisk < scans.length) {
    return { scans: [...scans], pruned: 0, missing, skipped: 'listing-thinner-than-manifest' }
  }

  const kept = scans.filter(scan => !scan.filename || onDisk.has(scan.filename))
  return { scans: kept, pruned: scans.length - kept.length, missing, skipped: null }
}
