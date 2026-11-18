/**
 * Carrying a scan from the world of one Place into the world of another, with what was made of it (ADR 0011).
 *
 * A scan belongs to the world of the Place its record names, so when a scan is filed under another Place (a
 * reassign, a merge) the world it was in stops holding it: `refreshWorldScans` (server/main.ts) drops the row
 * the next time that world is read. What the people who worked on the scan made of it lives beside the row, in
 * the world's own collections: the placement they set by hand (`editPatches`), the notes on it (`comments`) and
 * what was run on it (`jobs`). Dropping those with the row threw away a manual alignment that nothing else keeps.
 *
 * This module is the part of the hand-over that is decisions and no I/O, so a test can hold it: what goes with a
 * scan (`bundleScan`), where it is put in the other world (`adoptBundle`), what is taken out of the one it leaves
 * (`dropBundle`) and the order of it all, with the worlds stood in for (`handEvictedScansOver`). The reading and
 * writing of the two world files, under their locks, is `server/main.ts`'s, and the retrying of a hand-over that
 * could not be done is `./world_hand_over.ts`'s.
 *
 * ## What travels
 *
 *  - The scan's **patches**, **comments** and **finished jobs**, each named for the other world (`worldId`).
 *    Jobs still queued or processing do not travel: the pump finds a job by the slug of the world it was queued
 *    in, so one moved to another world could never run, and it would sit there as a job nothing finishes. They
 *    are dropped, as before.
 *  - The scan's **row**, when the scan is placed by its own record (`placedByRecord`: its sidecar's
 *    `projectTransform` is what put it where it is, so its `localToWorld` is the same in every world), and its
 *    **placement patches** (`scope: 'scan'` with a matrix), which are absolute and so mean the same in every world
 *    too. A world that already has a row for the file keeps it (the row a read built from the record, or the one
 *    the scan came back to): it takes the placement the patches say, and nothing else of the carried row.
 *
 * ## What stays
 *
 * A scan that is not placed by its record has a `localToWorld` that is relative to the origin of the world it was
 * in (GPS or the grid), and so is every placement set by hand over it: a matrix is a position in that world.
 * In the world it joins the same matrix would put the scan somewhere else, and nothing says what the person
 * meant it to line up with (a world that holds calibrated and GPS-placed scans mixes two frames), so it is not
 * converted. The scan's row is built again from its record in the world it joins, as it always was, and its placement
 * patches are **kept** in the world they were made in: not destroyed, and found again if the scan comes back. The
 * routes tell the caller how many (`HandOverReport.placementsKept`). Its notes, comments and finished jobs travel. A merge
 * deletes the world they were kept in, once everything else in it has been handed over, and then says how many went with it
 * instead (`placementsRemoved`, counted by `placementsInWorld`, server/place_deletion.ts).
 *
 * Deno-API-free and importing no server module that is not, so a test can import it.
 */
import type { EditPatch, ReviewComment, ScanManifest, WorldJob, WorldProject } from '../../src/world/types.ts'
import { checkPlacementMatrix } from '../../src/world/scan-placement.ts'
import { legacyScanId, scanIdFor } from '../scan_id.ts'

/** Everything that goes with one scan when it changes worlds. */
export interface ScanBundle {
  /** The scan's row as the world it leaves held it. */
  scan: ScanManifest
  /** Whether the scan's placement comes from its own record, so the row and the placement patches mean the same in any world. */
  placedByRecord: boolean
  /** The patches that travel: all of them for a scan placed by its record, and the ones that are not placements otherwise. */
  patches: EditPatch[]
  /** The patches that stay in the world the scan leaves: the placements set against that world's origin. */
  kept: EditPatch[]
  comments: ReviewComment[]
  /** The jobs of the scan that finished, completed or failed. */
  jobs: WorldJob[]
}

/** The ids a world's records may name a scan by: its id, the id an older build gave it, and its file name. */
function scanKeys(scan: ScanManifest): { ids: Set<string>; filename: string } {
  return { ids: new Set([scan.scanId, legacyScanId(scan), scanIdFor(scan.filename)]), filename: scan.filename }
}

type Keys = ReturnType<typeof scanKeys>

function patchNamesScan(patch: EditPatch, keys: Keys): boolean {
  return (patch.scanId !== undefined && keys.ids.has(patch.scanId)) || patch.targetId === keys.filename
}

/** Whether a patch moves a whole scan by a matrix: the one kind that is a position in its world. */
export function movesScanByMatrix(patch: EditPatch): boolean {
  return patch.scope === 'scan' && Array.isArray(patch.transform?.matrix)
}

/** The records of `world` that belong to `scan`, as a bundle. Reads `world`; changes nothing. */
export function bundleScan(world: WorldProject, scan: ScanManifest, placedByRecord: boolean): ScanBundle {
  const keys = scanKeys(scan)
  const named = world.editPatches.filter((patch) => patchNamesScan(patch, keys))
  return {
    scan,
    placedByRecord,
    patches: placedByRecord ? named : named.filter((patch) => !movesScanByMatrix(patch)),
    kept: placedByRecord ? [] : named.filter(movesScanByMatrix),
    comments: (world.comments ?? []).filter((comment) => comment.scanId != null && keys.ids.has(comment.scanId)),
    jobs: world.jobs.filter((job) =>
      job.scanId !== undefined && keys.ids.has(job.scanId) && (job.status === 'completed' || job.status === 'failed')),
  }
}

/**
 * Takes a scan's records out of the world it leaves: the patches that travelled, its comments and every job that
 * names it, including the ones that did not travel. The placements in `bundle.kept` stay. Not the row: the refresh
 * that evicted the row has already dropped it, and a caller that holds it drops it itself.
 */
export function dropBundle(world: WorldProject, bundle: ScanBundle): void {
  const keys = scanKeys(bundle.scan)
  const kept = new Set(bundle.kept.map((patch) => patch.patchId))
  world.editPatches = world.editPatches.filter((patch) => kept.has(patch.patchId) || !patchNamesScan(patch, keys))
  world.comments = (world.comments ?? []).filter((comment) => !(comment.scanId != null && keys.ids.has(comment.scanId)))
  world.jobs = world.jobs.filter((job) => !(job.scanId !== undefined && keys.ids.has(job.scanId)))
}

/** Takes everything that names the scan out of the world, kept placements too: for a scan that has no world to go to. */
function dropAllOf(world: WorldProject, scan: ScanManifest): void {
  dropBundle(world, { scan, placedByRecord: true, patches: [], kept: [], comments: [], jobs: [] })
}

/** Whether `a` was made after `b`: both have a time, and it is later. A patch with no usable time is later than nothing. */
function madeAfter(a: EditPatch, b: EditPatch): boolean {
  const first = Date.parse(a.createdAt)
  const second = Date.parse(b.createdAt)
  return Number.isFinite(first) && Number.isFinite(second) && first > second
}

/**
 * Puts `patch` in `log` where its time puts it: after every patch made before it or at the same time, and before the
 * ones made after it. The log is read in order (the last placement patch of a scan is where the scan is), so a patch
 * that came from another world is not set above what was made here since.
 */
function insertByTime(log: EditPatch[], patch: EditPatch): void {
  let at = log.length
  while (at > 0 && madeAfter(log[at - 1]!, patch)) at -= 1
  log.splice(at, 0, patch)
}

/** The matrix of the last placement patch of the scan in `log` that is a usable placement, or null when there is none. */
function lastPlacement(log: readonly EditPatch[], keys: Keys): number[] | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const patch = log[i]!
    if (!movesScanByMatrix(patch) || !patchNamesScan(patch, keys)) continue
    const matrix = patch.transform!.matrix!
    if (checkPlacementMatrix(matrix).ok) return matrix
  }
  return null
}

/**
 * Puts a bundle into the world of the Place the scan is filed under now, `toProjectId`. A record the world
 * already has (the same id) is left as it is, so carrying a bundle twice, after a crash between the two worlds'
 * writes or by a retry, changes nothing the second time. Returns how many records were added.
 *
 *  - Patches go into the world's log in the order of the time they were made, so a placement set here after the one
 *    that arrives is still the placement the log ends on.
 *  - A scan placed by its record brings its row when the world has none. A row the world has is never replaced: it
 *    may be the one the scan came back to, with the patches that belong to it, or one built from the record that
 *    nobody has moved, and either is as good as the carried one. What the arrival does change in it is where the
 *    scan stands, when a placement patch came: the row takes the last usable placement the merged log holds, as
 *    `applyPatchToWorld` leaves it for every patch that is posted.
 *  - A scan that is not placed by its record brings no row: a world with none builds one from the record on its
 *    next read.
 */
export function adoptBundle(world: WorldProject, bundle: ScanBundle, toProjectId: string): number {
  const keys = scanKeys(bundle.scan)
  let added = 0
  let placements = 0

  const patchIds = new Set(world.editPatches.map((patch) => patch.patchId))
  for (const patch of bundle.patches) {
    if (patchIds.has(patch.patchId)) continue
    patchIds.add(patch.patchId)
    insertByTime(world.editPatches, { ...patch, worldId: world.worldId })
    added += 1
    if (movesScanByMatrix(patch)) placements += 1
  }

  if (bundle.placedByRecord) {
    let row = world.scans.find((candidate) => candidate.filename === bundle.scan.filename)
    if (!row) {
      row = { ...bundle.scan, projectId: toProjectId }
      world.scans.push(row)
      added += 1
    }
    const placement = placements > 0 ? lastPlacement(world.editPatches, keys) : null
    if (placement) row.localToWorld = [...placement]
  }

  const comments = (world.comments ??= [])
  const commentIds = new Set(comments.map((comment) => comment.commentId))
  for (const comment of bundle.comments) {
    if (commentIds.has(comment.commentId)) continue
    comments.push({ ...comment, worldId: world.worldId })
    added += 1
  }

  const jobIds = new Set(world.jobs.map((job) => job.jobId))
  const carried = bundle.jobs.filter((job) => !jobIds.has(job.jobId))
  if (carried.length > 0) {
    world.jobs.push(...carried.map((job) => ({ ...job, worldId: world.worldId })))
    // A world's jobs are newest first (`createWorldJob` puts a new one at the front), and the history bound keeps the front.
    world.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    added += carried.length
  }
  return added
}

// ── The hand-over ────────────────────────────────────────────────────────────────────────────────

/** A scan row a world no longer holds, the Place its record files it under now (null when it names none), and how it was placed. */
export interface EvictedScan {
  scan: ScanManifest
  toProjectId: string | null
  /** Whether the scan's sidecar has a usable `projectTransform`, which is what placed its row (`ScanBundle.placedByRecord`). */
  placedByRecord: boolean
}

/** What the hand-over needs from the server: which Places there are, and the world of a Place under its lock. */
export interface HandOverWorlds {
  /** The ids of the Places the registry holds. Rejects when the registry cannot be read. */
  places(): Promise<ReadonlySet<string>>
  /**
   * Runs `edit` on the world of the Place and saves it, and answers true; or answers false, having run nothing,
   * when that world is busy (`tryWithWorldLock`, ./world_lock.ts). Rejects when that world cannot be read or saved.
   */
  editIfFree(projectId: string, edit: (world: WorldProject) => void): Promise<boolean>
}

/** A world a hand-over could not be done into, and why. */
export interface HandOverFailure {
  projectId: string
  error: unknown
}

/** What `handEvictedScansOver` did. */
export interface HandOverResult {
  /** The scans that could not be handed over now: untouched, with every record, to stay where they are until the world is read again. */
  stayed: ScanManifest[]
  /** For each scan that was handed over, how many placement patches stay in the world it left (only those with any). By file name. */
  kept: Record<string, number>
  /** The worlds that could not be read or saved. A world that was only busy is not a failure. */
  failures: HandOverFailure[]
}

/**
 * Hands the scans a world no longer holds over to the world of the Place each is filed under now, with what travels
 * with them (the top of this file), and takes those records out of `source`, which the caller holds under its lock.
 *
 *  - The other world is taken only if it is free: the caller already holds one world's lock, and waiting for a second
 *    while holding the first can wait for good when the second's holder wants the first. A busy world puts the
 *    hand-over off, and loses nothing.
 *  - A world that cannot be read or saved puts the hand-over off in the same way, and says so in `failures`: it is that
 *    world's trouble, and not a reason for this one to be unreadable, or for the scan's records to be dropped.
 *  - A scan filed under no Place, or under one the registry does not have, has nowhere to go: its records are
 *    dropped, as a refresh always did.
 *  - When the registry cannot be read nothing can be told to have nowhere to go, so nothing is dropped and nothing moves.
 */
export async function handEvictedScansOver(
  source: WorldProject,
  evicted: EvictedScan[],
  worlds: HandOverWorlds,
): Promise<HandOverResult> {
  const result: HandOverResult = { stayed: [], kept: {}, failures: [] }
  if (evicted.length === 0) return result
  let places: ReadonlySet<string>
  try {
    places = await worlds.places()
  } catch (error) {
    console.warn('[worlds] could not read the Places to hand scans over, so they stay where they are:', error)
    result.stayed = evicted.map((entry) => entry.scan)
    return result
  }
  const byPlace = new Map<string | null, EvictedScan[]>()
  for (const entry of evicted) byPlace.set(entry.toProjectId, [...(byPlace.get(entry.toProjectId) ?? []), entry])
  for (const [toProjectId, entries] of byPlace) {
    if (toProjectId === null || !places.has(toProjectId)) {
      for (const { scan } of entries) dropAllOf(source, scan)
      continue
    }
    const bundles = entries.map(({ scan, placedByRecord }) => bundleScan(source, scan, placedByRecord))
    let handed = false
    try {
      handed = await worlds.editIfFree(toProjectId, (target) => {
        for (const bundle of bundles) adoptBundle(target, bundle, toProjectId)
      })
    } catch (error) {
      result.failures.push({ projectId: toProjectId, error })
    }
    if (!handed) {
      result.stayed.push(...entries.map((entry) => entry.scan))
      continue
    }
    for (const bundle of bundles) {
      dropBundle(source, bundle)
      if (bundle.kept.length > 0) result.kept[bundle.scan.filename] = bundle.kept.length
    }
  }
  return result
}
