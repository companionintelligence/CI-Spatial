/**
 * One-shot migration: re-derive every `ScanManifest.scanId` in `worlds/*.json`
 * from the scan's own filename, and re-point every `editPatches[].scanId` and
 * `jobs[].scanId` that named an id which used to mean several scans at once.
 * Implements docs/factory/07-scan-identity/0001-unique-scan-id-per-upload.md.
 *
 * Why anything needs migrating: `scanId` used to be
 * `scan-${safeSlug(meta.sessionId)}` whenever a sessionId existed, and a
 * sessionId names a *browser tab*, not an upload. Every autosave in one
 * walkthrough therefore collided onto a single id. Observed live: four GLBs
 * with four different detection counts sharing `scan-session-1787174216556`,
 * three of them dropped by the viewer's `loadedScans` map at load time while
 * the HUD read "1 scan loaded". `scan_id.ts`'s `scanIdFor()` now derives from
 * the filename alone, which fixes new uploads; this script fixes the worlds
 * already on disk.
 *
 * Explicitly invoked, one-shot — NOT run on server boot, matching
 * `migrate_jobs.ts` (see its header for the reasoning this repo already
 * pinned: a boot-time migration re-runs forever and has to be defended
 * against double-application, and a malformed world file should stop an
 * operator rather than a server).
 *
 * Idempotent by construction, with no "already migrated" marker field: the
 * new id is *derived* from a filename that never changes, so a second run
 * recomputes exactly the same ids, finds every patch and job already pointing
 * at a current id, and writes nothing.
 *
 * Correct in either order relative to a server boot. `refreshWorldScans()`
 * re-derives scan ids on every world read, so the scan rows self-heal — but
 * patches and jobs do not, and that is this script's real work. It therefore
 * derives the *old* id from the retained `ScanManifest.sessionId` rather than
 * reading it back out of the file, so it works whether or not a server has
 * already re-ided the rows.
 *
 * RUN WITH THE SERVER STOPPED. `world_lock.ts` is in-process only (ADR 0004,
 * "In-process only"), so the lock this borrows cannot exclude a separate
 * server process writing the same WORLDS_DIR.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env migrate_scan_ids.ts
 *   deno task migrate-scan-ids
 *
 * Env (same names/defaults as main.ts's own knobs):
 *   WORLDS_DIR  default ./worlds  — where <slug>.json world files live
 */
import type { ScanManifest, WorldProject } from './src/world/types.ts'
import { withWorldLock } from './world_lock.ts'
import { safeSlug, scanIdFor } from './scan_id.ts'

/** One patch/job reference that named an id shared by more than one scan. */
export interface AmbiguousRemap {
  kind: 'patch' | 'job'
  /** `patchId` or `jobId` — whichever this reference belongs to. */
  id: string
  oldScanId: string
  /** How many scans shared `oldScanId`. Always > 1; 1 is not ambiguous. */
  candidates: number
  chosenScanId: string
  chosenFilename: string
}

export interface WorldMigrationResult {
  slug: string
  changed: boolean
  scansReided: Array<{ filename: string; from: string; to: string }>
  patchesRepointed: number
  jobsRepointed: number
  ambiguous: AmbiguousRemap[]
}

export interface MigrateScanIdsOptions {
  /** Same meaning/default as main.ts's WORLDS_DIR env var. */
  worldsDir: string
  log?: (line: string) => void
}

export interface MigrationSummary {
  worlds: WorldMigrationResult[]
  filesWritten: number
}

/**
 * The id this scan carried under the old derivation.
 *
 * Read from `ScanManifest.sessionId` — which ticket 0001 leaves untouched —
 * rather than from the stored `scanId`, so this is correct even after a server
 * boot has already re-derived the rows. A scan with no sessionId always took
 * the filename branch, so its id never moves.
 */
function legacyScanId(scan: ScanManifest): string {
  return scan.sessionId ? `scan-${safeSlug(scan.sessionId)}` : scanIdFor(scan.filename)
}

/**
 * Upload recency within a collided group. `createScanFileExclusive` prefixes
 * every upload with `${Date.now()}_`, so the prefix is both the most precise
 * and the most available signal; `capturedAt` is the fallback for a filename
 * that has no prefix (a `registerSessionScan` synthetic name, say). Both are
 * epoch milliseconds, so they compare directly.
 */
function uploadOrder(scan: ScanManifest): number {
  const prefix = /^(\d+)_/.exec(scan.filename)
  if (prefix) return Number(prefix[1])
  const captured = scan.capturedAt ? Date.parse(scan.capturedAt) : Number.NaN
  return Number.isFinite(captured) ? captured : Number.NEGATIVE_INFINITY
}

/**
 * Which scan a reference to a now-split id should follow: the newest scan of
 * that session.
 *
 * This is a guess, and the caller logs it as one. The collided id was minted
 * per walkthrough, and someone editing in the World Editor was almost
 * certainly looking at the most recent capture of that walkthrough — but
 * nothing in the data records which one they actually meant. Filename breaks
 * a tie so the choice is deterministic rather than dependent on array order.
 */
function newestOf(scans: ScanManifest[]): ScanManifest {
  return scans.reduce((best, scan) => {
    const delta = uploadOrder(scan) - uploadOrder(best)
    if (delta > 0) return scan
    if (delta < 0) return best
    return scan.filename > best.filename ? scan : best
  })
}

/**
 * Re-derive every scan id in `world`, re-point the patch and job references
 * that named a split id, and report what moved. Mutates `world` in place and
 * returns the summary; pure with respect to the filesystem, so the whole
 * migration is unit-testable without touching disk.
 *
 * Throws if two scans in one world derive the same id. `safeSlug` is lossy
 * (every character outside `[a-z0-9_-]` becomes `-`), so two distinct
 * filenames can in principle slug to one id and reintroduce this very bug
 * through the back door. Failing loudly is the point: silently deduping would
 * hide exactly the condition the migration exists to remove.
 */
export function migrateWorldScanIds(
  world: WorldProject,
  log: (line: string) => void = () => {},
): WorldMigrationResult {
  const slug = world.shareSlug
  const result: WorldMigrationResult = {
    slug,
    changed: false,
    scansReided: [],
    patchesRepointed: 0,
    jobsRepointed: 0,
    ambiguous: [],
  }

  const nextIdOf = new Map<ScanManifest, string>()
  const byNextId = new Map<string, ScanManifest[]>()
  for (const scan of world.scans) {
    const next = scanIdFor(scan.filename)
    nextIdOf.set(scan, next)
    const bucket = byNextId.get(next)
    if (bucket) bucket.push(scan)
    else byNextId.set(next, [scan])
  }

  const collisions = [...byNextId.entries()].filter(([, scans]) => scans.length > 1)
  if (collisions.length > 0) {
    const detail = collisions
      .map(([id, scans]) => `  ${id} <- ${scans.map(s => s.filename).join(', ')}`)
      .join('\n')
    throw new Error(
      `[migrate-scan-ids] world '${slug}': ${collisions.length} derived scanId(s) are not unique, ` +
        `so migrating would reintroduce the collision this migration exists to remove. ` +
        `safeSlug() is lossy — distinct filenames can slug to one id. Rename the offending ` +
        `file(s) and re-run; refusing to dedupe silently.\n${detail}`,
    )
  }

  // Group by the id each scan carried BEFORE this migration, so a reference to
  // a split id can be resolved to exactly one successor.
  const byLegacyId = new Map<string, ScanManifest[]>()
  for (const scan of world.scans) {
    const legacy = legacyScanId(scan)
    const bucket = byLegacyId.get(legacy)
    if (bucket) bucket.push(scan)
    else byLegacyId.set(legacy, [scan])
  }

  const currentIds = new Set(nextIdOf.values())

  for (const scan of world.scans) {
    const next = nextIdOf.get(scan)!
    if (scan.scanId !== next) {
      result.scansReided.push({ filename: scan.filename, from: scan.scanId, to: next })
      scan.scanId = next
      result.changed = true
    }
    // frameSetUrl embeds the scanId, so a stale one 404s against
    // GET /worlds/:slug/frames/:scanId. It is derived, never authored — the
    // condition and shape here mirror scanManifestFromStored() exactly.
    const frameSetUrl = scan.sessionId
      ? `/worlds/${encodeURIComponent(safeSlug(slug))}/frames/${encodeURIComponent(next)}`
      : undefined
    if (scan.frameSetUrl !== frameSetUrl) {
      scan.frameSetUrl = frameSetUrl
      result.changed = true
    }
  }

  /**
   * Resolve one `scanId` reference. Returns null when it needs no change:
   * already a current id (the common case on a second run), or naming a scan
   * this world does not have (dangling — left alone rather than guessed at).
   */
  const resolve = (
    scanId: string | undefined,
    kind: 'patch' | 'job',
    id: string,
  ): string | null => {
    if (!scanId) return null
    if (currentIds.has(scanId)) return null
    const candidates = byLegacyId.get(scanId)
    if (!candidates || candidates.length === 0) return null
    const chosen = newestOf(candidates)
    const chosenId = nextIdOf.get(chosen)!
    if (candidates.length > 1) {
      const ambiguity: AmbiguousRemap = {
        kind,
        id,
        oldScanId: scanId,
        candidates: candidates.length,
        chosenScanId: chosenId,
        chosenFilename: chosen.filename,
      }
      result.ambiguous.push(ambiguity)
      log(
        `[migrate-scan-ids] ${slug}: ambiguous ${kind} ${id} — '${scanId}' matched ` +
          `${candidates.length} scans; chose newest (${chosen.filename} -> ${chosenId})`,
      )
    }
    return chosenId === scanId ? null : chosenId
  }

  for (const patch of world.editPatches) {
    const next = resolve(patch.scanId, 'patch', patch.patchId)
    if (next === null) continue
    patch.scanId = next
    result.patchesRepointed += 1
    result.changed = true
  }

  for (const job of world.jobs) {
    const next = resolve(job.scanId, 'job', job.jobId)
    if (next === null) continue
    job.scanId = next
    result.jobsRepointed += 1
    result.changed = true
  }

  return result
}

/**
 * Apply {@link migrateWorldScanIds} to every `<slug>.json` in `worldsDir`,
 * each inside that slug's world lock, persisting only the ones that changed.
 *
 * The lock is taken (and the read → mutate → write cycle kept wholly inside
 * it) to reproduce `updateWorld()`'s shape, per ADR 0004: world files are
 * never written outside it. `main.ts` itself cannot be imported here — its
 * top-level side effects would start a server — which is precisely why
 * `withWorldLock` lives in its own module.
 */
export async function migrateScanIds(opts: MigrateScanIdsOptions): Promise<MigrationSummary> {
  const { worldsDir } = opts
  const log = opts.log ?? ((line: string) => console.log(line))
  const summary: MigrationSummary = { worlds: [], filesWritten: 0 }

  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(worldsDir)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name)
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      log(`[migrate-scan-ids] no worlds directory at ${worldsDir} — nothing to migrate.`)
      return summary
    }
    throw err
  }
  names.sort()

  if (names.length === 0) {
    log(`[migrate-scan-ids] ${worldsDir} holds no world files — nothing to migrate.`)
    return summary
  }

  for (const name of names) {
    const path = `${worldsDir}/${name}`
    const slug = safeSlug(name.replace(/\.json$/, ''))

    const result = await withWorldLock(slug, async () => {
      const raw = await Deno.readTextFile(path)
      let world: WorldProject
      try {
        world = JSON.parse(raw) as WorldProject
      } catch (err) {
        // Never a silent skip: a world file that cannot be read is a world
        // whose patches and jobs still name split ids, and reporting "nothing
        // to migrate" would tell an operator the opposite. Same stance as
        // migrate_jobs.ts takes on a malformed jobs.json.
        throw new Error(
          `[migrate-scan-ids] ${path} exists but is not valid JSON, so its scan ids cannot be ` +
            `migrated. Refusing to skip it silently — fix or move the file, then re-run. ` +
            `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!Array.isArray(world.scans)) {
        throw new Error(
          `[migrate-scan-ids] ${path} has no 'scans' array — it does not look like a world file. ` +
            `Refusing to skip it silently; fix or move the file, then re-run.`,
        )
      }
      world.editPatches ??= []
      world.jobs ??= []

      const outcome = migrateWorldScanIds(world, log)
      if (outcome.changed) {
        world.updatedAt = new Date().toISOString()
        const tmp = `${path}.${crypto.randomUUID()}.tmp`
        await Deno.writeTextFile(tmp, JSON.stringify(world, null, 2))
        await Deno.rename(tmp, path)
      }
      return outcome
    })

    summary.worlds.push(result)
    if (result.changed) {
      summary.filesWritten += 1
      log(
        `[migrate-scan-ids] ${result.slug}: re-ided ${result.scansReided.length} scan(s), ` +
          `re-pointed ${result.patchesRepointed} patch(es) and ${result.jobsRepointed} job(s)` +
          `${result.ambiguous.length > 0 ? `, ${result.ambiguous.length} ambiguous` : ''} — wrote ${path}`,
      )
    } else {
      log(`[migrate-scan-ids] ${result.slug}: already migrated; ${path} left untouched.`)
    }
  }

  return summary
}

if (import.meta.main) {
  const worldsDir = Deno.env.get('WORLDS_DIR') ?? './worlds'
  console.warn(
    `[migrate-scan-ids] Run this with the server STOPPED. The per-slug world lock is in-process ` +
      `only (ADR 0004), so it cannot exclude a running server writing ${worldsDir}.`,
  )
  try {
    const summary = await migrateScanIds({ worldsDir })
    const ambiguous = summary.worlds.reduce((n, w) => n + w.ambiguous.length, 0)
    const reided = summary.worlds.reduce((n, w) => n + w.scansReided.length, 0)
    const patches = summary.worlds.reduce((n, w) => n + w.patchesRepointed, 0)
    const jobs = summary.worlds.reduce((n, w) => n + w.jobsRepointed, 0)
    console.log(
      `[migrate-scan-ids] done: ${summary.filesWritten} world file(s) written, ${reided} scan(s) ` +
        `re-ided, ${patches} patch(es) and ${jobs} job(s) re-pointed, ${ambiguous} ambiguous.`,
    )
    if (ambiguous > 0) {
      console.log(
        `[migrate-scan-ids] Ambiguous references were resolved to the newest scan of their ` +
          `session — a guess, logged above per reference. Review them if any edit looks misplaced.`,
      )
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
