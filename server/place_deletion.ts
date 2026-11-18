/**
 * What deleting a Place has to look at besides its registry entry, so that deleting one leaves no camera data
 * behind that nothing points at, and no record of where the person lives.
 *
 * `DELETE /projects/:id` refuses a Place that holds scans (409). Four things slipped past that:
 *
 *   1. A scan made from an upload (a video, photos, a tripod sweep, a person clip) is a session and has no GLB
 *      until a job writes one, so counting the Place's GLBs did not count it. The Place could be deleted
 *      while its frames stayed under `scans/sessions/`, with the scan row still in the Place's world.
 *   2. A Place's reference photos (`scans/projects/<id>/`, the two pictures a calibration takes of its landmark
 *      and its heading marker) were never removed with it.
 *   3. A Place's world file (`worlds/<slug>.json`) was never removed with it. It holds the Place's name, its
 *      latitude, longitude and street address, its Things (what was in the rooms and where), its comments and
 *      the share tokens, and `GET /worlds/<slug>` answers a request that carries no token with all of it but the
 *      tokens. The world export built from it (`<slug>.world.glb`, a copy of every scan's geometry) stayed too.
 *   4. A Place that a merge took out of the registry left that world and its export behind. The merge hands the
 *      scans over and no longer relabels the world as the target's (ADR 0011), so nothing named the world any
 *      more: `DELETE /projects/:id` answered 404 for a Place the registry no longer had, and deleting the
 *      target removed only worlds that say they are the target's.
 *
 * The policy, stated once: deleting a Place never removes keyframes by itself, and never leaves them behind.
 * It is refused while the Place holds any scan, an upload scan included. Each scan takes its own sessions
 * with it when it is deleted (server/session_deletion.ts), so by the time a Place can be deleted nothing of
 * it is left for the frames to belong to. The reference photos and the world belong to the Place alone and go
 * with it, before its registry entry does, so that a failure leaves a Place that can be deleted again and not a
 * folder nothing names. A merge takes the merged-away Place out of the registry first, because what it moves
 * is filed by that registry, so its world goes after: once nothing in it is waiting to be handed over
 * (`removeLeftoverPlaceWorlds`), and a world that is left, because something was waiting or because it could not
 * be removed, is found again by the Place's id and removed by `DELETE /projects/:id` or by asking for the merge again.
 *
 * Lives apart from main.ts, which a test cannot import, so both can be tested against real directories.
 */
import type { EditPatch } from '../src/world/types.ts'
import { projectMediaDirPath } from './project_media.ts'
import { isPlainScanFilename } from './scan_deletion.ts'
import { safeSlug } from './scan_id.ts'
import { SESSION_ID_RE } from './session_id.ts'
import { movesScanByMatrix } from './world/scan_carry.ts'
import { withWorldLock } from './world/world_lock.ts'

/**
 * The scans made from an upload that `projectId` holds, as the synthetic filenames (`<sessionId>.glb`) the world and
 * the scan routes know them by. They have a sidecar `<sessionId>.json` in `scansDir` and, until a job writes
 * geometry, no GLB. A GLB that does exist is counted with the Place's other GLB scans, not here.
 */
export async function uploadScansOfPlace(scansDir: string, projectId: string): Promise<string[]> {
  const found: string[] = []
  const sidecars: string[] = []
  for await (const entry of Deno.readDir(scansDir)) {
    if (!entry.isFile || !entry.name.endsWith('.json')) continue
    if (SESSION_ID_RE.test(entry.name.slice(0, -'.json'.length))) sidecars.push(entry.name)
  }
  for (const sidecar of sidecars) {
    const base = sidecar.slice(0, -'.json'.length)
    try {
      const meta: unknown = JSON.parse(await Deno.readTextFile(`${scansDir}/${sidecar}`))
      if (!meta || typeof meta !== 'object' || (meta as Record<string, unknown>)['projectId'] !== projectId) continue
      // A scan with a real GLB is one of the Place's GLB scans already.
      const hasGlb = await Deno.stat(`${scansDir}/${base}.glb`).then(() => true, () => false)
      if (!hasGlb) found.push(`${base}.glb`)
    } catch { /* an unreadable sidecar names no Place */ }
  }
  return found
}

/**
 * Removes a Place's reference photos. Resolves true when a folder was removed, false when the Place had none. An
 * id that is not a Place id touches nothing. Only `<mediaRoot>/<projectId>` is ever removed.
 */
export async function removePlaceMedia(mediaRoot: string, projectId: string): Promise<boolean> {
  const dir = projectMediaDirPath(mediaRoot, projectId)
  if (!dir) return false
  try {
    const info = await Deno.lstat(dir)
    // A link here would be removed as a link, never followed; anything but a folder is not ours.
    if (!info.isDirectory) return false
    await Deno.remove(dir, { recursive: true })
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

/** A world file as it is read here: only what the rules below look at. */
export type StoredWorld = Record<string, unknown>

/**
 * Says whether a world is held back for now, instead of removed. It is given the world as its file holds it, inside that
 * world's lock, so what it sees is what the removal would take.
 */
export type KeepWorld = (world: StoredWorld) => boolean | Promise<boolean>

/** What `removeLeftoverPlaceWorlds` did. */
export interface LeftoverWorlds {
  /** The worlds removed, each with its export. */
  removed: number
  /** The worlds `keep` held back. They are as they were, and still say they are the Place's. */
  kept: number
  /**
   * The placements set by hand over a whole scan that the removed worlds held (`placementsInWorld`), counted from each world as
   * its file held it when it was removed. ADR 0011 keeps such a placement in the world a scan was moved out of, because it is a
   * position in that world; it goes with the world, and this is how many went. Worlds that were kept add none.
   */
  placementsRemoved: number
}

/** The names of the `*.json` files in the worlds folder. A folder that is not there has none. */
async function worldFileNames(worldsDir: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(worldsDir)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name)
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return []
    throw error
  }
  return names
}

/**
 * The slugs of the worlds that say they are `projectId`'s, read as they are now and under no lock: for a caller that is
 * about to read them through the server, which hands over the scans a world still holds. Only the id in the file is compared;
 * it is never used to build a path.
 */
export async function placeWorldSlugs(worldsDir: string, projectId: string): Promise<string[]> {
  const slugs: string[] = []
  for (const name of await worldFileNames(worldsDir)) {
    try {
      const parsed: unknown = JSON.parse(await Deno.readTextFile(`${worldsDir}/${name}`))
      if (parsed && typeof parsed === 'object' && (parsed as StoredWorld)['projectId'] === projectId) slugs.push(name.slice(0, -'.json'.length))
    } catch { /* not a world this Place can own: unreadable, or already gone */ }
  }
  return slugs
}

/**
 * How many placements set by hand over a whole scan a world holds: the patches that move a scan by a matrix (`movesScanByMatrix`,
 * server/world/scan_carry.ts, the rule the hand-over keeps them by). Once a scan has been handed over to another Place's world,
 * the ones left here are the placements it had against this world's origin, which ADR 0011 keeps in the world they were made in.
 * Read from the world as its file holds it: entries that are not patches are not counted, and do not stop the count.
 */
export function placementsInWorld(world: StoredWorld): number {
  const patches = world['editPatches']
  if (!Array.isArray(patches)) return 0
  return patches.filter((patch) => typeof patch === 'object' && patch !== null && movesScanByMatrix(patch as EditPatch)).length
}

async function removeWorldsOf(worldsDir: string, projectId: string, keep?: KeepWorld): Promise<LeftoverWorlds> {
  const result: LeftoverWorlds = { removed: 0, kept: 0, placementsRemoved: 0 }
  for (const name of await worldFileNames(worldsDir)) {
    const base = name.slice(0, -'.json'.length)
    const outcome = await withWorldLock(safeSlug(base), async (): Promise<{ removed: true; placements: number } | 'kept' | 'not-ours'> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(await Deno.readTextFile(`${worldsDir}/${name}`))
      } catch {
        return 'not-ours' // not a world this Place can own: unreadable, or already gone
      }
      if (!parsed || typeof parsed !== 'object' || (parsed as StoredWorld)['projectId'] !== projectId) return 'not-ours'
      if (keep && await keep(parsed as StoredWorld)) return 'kept'
      // Counted before anything goes, from the world as it is held under this lock: nothing that can fail comes after the removal.
      const placements = placementsInWorld(parsed as StoredWorld)
      // The export first: a failure then leaves the world, which still names the Place, to be found again.
      for (const path of [`${worldsDir}/${base}.world.glb`, `${worldsDir}/${name}`]) {
        try {
          await Deno.remove(path)
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error
        }
      }
      return { removed: true, placements }
    })
    if (outcome === 'kept') result.kept += 1
    else if (outcome !== 'not-ours') {
      result.removed += 1
      result.placementsRemoved += outcome.placements
    }
  }
  return result
}

/**
 * Removes every world that says it is `projectId`'s, with the export built from it: the Place's own world
 * (`project-<id>`) and a world an earlier build's merge re-labelled into it (this build's merge does not relabel: the
 * merged-away Place's world goes with `removeLeftoverPlaceWorlds`). Each world is read and removed inside its own lock, so a
 * write to it cannot land after it has gone. A world that names another Place, or none (the default world), is never
 * touched. Resolves how many worlds were removed. Throws when one cannot be removed, so the caller can keep the Place.
 */
export async function removePlaceWorlds(worldsDir: string, projectId: string): Promise<number> {
  return (await removeWorldsOf(worldsDir, projectId)).removed
}

/**
 * Removes the worlds of a Place that is no longer in the registry (a merge took it out), with their exports, except the
 * ones `keep` holds back. Same locking, same order and same reach as `removePlaceWorlds`: only worlds that say they are
 * `projectId`'s, and the export before the world so that a failure leaves a world that can be found again. Throws when
 * one cannot be removed.
 */
export function removeLeftoverPlaceWorlds(worldsDir: string, projectId: string, keep: KeepWorld): Promise<LeftoverWorlds> {
  return removeWorldsOf(worldsDir, projectId, keep)
}

/**
 * Whether a world still has something in it that a merge was to hand over, or that is working: a scan row, or a job that is
 * queued or running. A merge hands every scan of the world over to the world of the Place it is filed under now, and takes
 * with it what was made of the scan; a row that is still here is a scan whose hand-over has not been done (the other world was
 * busy or could not be read) or one the hand-over never moves (an upload with no GLB yet, which ADR 0011 lists as an older
 * gap), and a job that is running would write its result into a world that had gone and make a new one. A world that is in use
 * is not removed by the merge; it is the `keep` of `removeLeftoverPlaceWorlds`.
 */
export function worldIsInUse(world: StoredWorld): boolean {
  const scans = world['scans']
  if (Array.isArray(scans) && scans.length > 0) return true
  const jobs = world['jobs']
  return Array.isArray(jobs) && jobs.some((job) => {
    const status = (job as { status?: unknown } | null)?.status
    return status === 'queued' || status === 'processing'
  })
}

/**
 * Whether a world still lists a scan whose GLB is in `scansDir`. The Place the world belongs to is gone, and a Place that
 * holds a scan is not deleted, so such a scan is filed under another Place (or under none) and what was made of it is waiting
 * to be handed over to that Place's world: it would be lost with this one. A row whose GLB is not there is not waiting:
 * nothing moves it. A name that is not a plain scan name is never made into a path.
 */
export async function worldHoldsScansOnDisk(world: StoredWorld, scansDir: string): Promise<boolean> {
  const scans = world['scans']
  if (!Array.isArray(scans)) return false
  for (const scan of scans) {
    const filename = (scan as { filename?: unknown } | null)?.filename
    if (typeof filename !== 'string' || !isPlainScanFilename(filename)) continue
    if (await Deno.stat(`${scansDir}/${filename}`).then(() => true, () => false)) return true
  }
  return false
}
