/**
 * What deleting a Place has to look at besides its registry entry, so that deleting one leaves no camera data
 * behind that nothing points at, and no record of where the person lives.
 *
 * `DELETE /projects/:id` refuses a Place that holds scans (409). Three things slipped past that:
 *
 *   1. A scan made from an upload (a video, photos, a tripod sweep, a person clip) is a session and has no GLB
 *      until a job writes one, so counting the Place's GLBs did not count it. The Place could be deleted
 *      while its frames stayed under `scans/sessions/`, with the scan row still in the Place's world.
 *   2. A Place's reference photos (`scans/projects/<id>/`, the two pictures a calibration takes of its landmark
 *      and its heading marker) were never removed with it.
 *   3. A Place's world file (`worlds/<slug>.json`) was never removed with it. It holds the Place's name, its
 *      latitude, longitude and street address, its Things (what was in the rooms and where), its comments and
 *      the share tokens, and `GET /worlds/<slug>` answers with it without a sign-in on an open install. The world
 *      export built from it (`<slug>.world.glb`, a copy of every scan's geometry) stayed too.
 *
 * The policy, stated once: deleting a Place never removes keyframes by itself, and never leaves them behind.
 * It is refused while the Place holds any scan, an upload scan included. Each scan takes its own sessions
 * with it when it is deleted (server/session_deletion.ts), so by the time a Place can be deleted nothing of
 * it is left for the frames to belong to. The reference photos and the world belong to the Place alone and go
 * with it, before its registry entry does, so that a failure leaves a Place that can be deleted again and not a
 * folder nothing names.
 *
 * Lives apart from main.ts, which a test cannot import, so both can be tested against real directories.
 */
import { projectMediaDirPath } from './project_media.ts'
import { safeSlug } from './scan_id.ts'
import { SESSION_ID_RE } from './session_id.ts'
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

/**
 * Removes every world that says it is `projectId`'s, with the export built from it: the Place's own world
 * (`project-<id>`) and a world a merge re-labelled into it. Each world is read and removed inside its own lock, so a
 * write to it cannot land after it has gone. A world that names another Place, or none (the default world), is never
 * touched. Resolves how many worlds were removed. Throws when one cannot be removed, so the caller can keep the Place.
 */
export async function removePlaceWorlds(worldsDir: string, projectId: string): Promise<number> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(worldsDir)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name)
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0
    throw error
  }
  let removed = 0
  for (const name of names) {
    const base = name.slice(0, -'.json'.length)
    const gone = await withWorldLock(safeSlug(base), async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(await Deno.readTextFile(`${worldsDir}/${name}`))
      } catch {
        return false // not a world this Place can own: unreadable, or already gone
      }
      if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>)['projectId'] !== projectId) return false
      // The export first: a failure then leaves the world, which still names the Place, to be found again.
      for (const path of [`${worldsDir}/${base}.world.glb`, `${worldsDir}/${name}`]) {
        try {
          await Deno.remove(path)
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error
        }
      }
      return true
    })
    if (gone) removed += 1
  }
  return removed
}
