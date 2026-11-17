/**
 * Deleting a scan, so that nothing made from it is left behind: the camera frames it was built from, every file the
 * pipelines wrote beside it, and its place in the worlds. `DELETE /scans/:filename` and `DELETE /scans?confirm=delete-all`
 * are a few lines each in server/main.ts and call this, so that the order, the refusals and the failures are one thing
 * that a test can run against real directories (main.ts serves at import and cannot be imported).
 *
 * ## What a deletion takes
 *
 *   - the scan's GLB and its sidecar;
 *   - what the optimizer wrote: `.opt.glb`, `.lod1.glb`, `.lod2.glb`, `.manifest.json`;
 *   - what LingBot-Map wrote: `.lingbot.glb`, a point cloud coloured from the session's photographs, which for a scan made
 *     from an upload is the only real geometry it has;
 *   - what the splat and person jobs wrote (the suffixes main.ts serves as splat artifacts) and a person scan's `.4d/` folder;
 *   - what SenseNova wrote for it: `.sensenova/<jobId>/`, found through the scan's finished jobs;
 *   - the camera-frame sessions only this scan names (server/session_deletion.ts);
 *   - the world exports that hold a copy of its geometry, and the scan's row, its jobs and its patches in every world.
 *
 * ## The order, and what a failure leaves
 *
 * 1. Mark the scan as being deleted, then cancel the jobs waiting for it and refuse (409) while one is running on it
 *    (server/scan_job_guard.ts). Nothing has been removed yet, so a refusal costs nothing: a running job is looked for first,
 *    and nothing is cancelled when one is found. A failure later on has cancelled the jobs that were waiting, which were queued
 *    for a scan that is being deleted.
 * 2. The sessions, then the scan's own files, then the worlds. A scan that stays because something could not be removed
 *    keeps every link to what is left, so deleting it again finishes the job: the reply is a 500 with counts, never a
 *    200 over a file that is still there. A file that is already gone counts as removed, so a repeated delete succeeds.
 *
 * Replies name no path. A reason, if there is one, is an error's name.
 */
import { safeSlug, scanIdFor } from './scan_id.ts'
import {
  type RunningScanJob,
  markEveryScanBeingDeleted,
  markScansBeingDeleted,
} from './scan_job_guard.ts'
import {
  deleteAllSessions,
  deleteScanSessions,
  scanSessionDeletionBody,
  UNPUBLISHED_UPLOAD_MAX_AGE_MS,
} from './session_deletion.ts'
import { PART_SUFFIX } from './world/scan_store.ts'

/**
 * How long a delete waits for the upload's own optimize-scan job to finish before it answers 409. Adopted, not
 * measured (ADR 0005 rule 5): the optimizer takes a few seconds on a room scan on this server; a delete that finds one
 * still running after this long is told to try again, like one that finds a splat job.
 */
const OPTIMIZE_SETTLE_MAX_MS = 15_000
/** How often that wait looks again. */
const OPTIMIZE_SETTLE_POLL_MS = 100

/** What the optimizer writes beside a scan, by suffix. */
const OPTIMIZER_SUFFIXES = ['.opt.glb', '.lod1.glb', '.lod2.glb', '.manifest.json'] as const

/** LingBot-Map's point cloud for a scan, written beside it. */
const LINGBOT_GLB_SUFFIX = '.lingbot.glb'

/** The folder under the scans directory that SenseNova jobs write into, one folder per job. */
const SENSENOVA_DIR = '.sensenova'

/** The reply a route sends: a status and a body, so the route is a few lines. */
export interface ScanDeleteReply {
  status: 200 | 400 | 404 | 409 | 500
  body: Record<string, unknown>
}

/** What the world side of a deletion is asked to do. main.ts implements it over the world files. */
export interface ScanDeletionDeps {
  scansDir: string
  sessionsDir: string
  /** The suffixes, with their dot, of the files the splat and person jobs write beside a scan (main.ts SPLAT_ARTIFACT_MIME). */
  splatSuffixes: readonly string[]
  /**
   * Cancels the jobs waiting for the scan in every world, and says which are running on it and which finished
   * SenseNova jobs wrote a folder for it.
   */
  claimJobs(filename: string): Promise<{ running: RunningScanJob[]; senseNovaJobIds: string[] }>
  /**
   * Removes the world exports that hold a copy of the scan's geometry (`<world>.world.glb`, built on demand by a job), and
   * resolves how many it removed. Throws when one cannot be removed.
   */
  dropWorldExports(filename: string): Promise<number>
  /** Takes the scan, its jobs and its patches out of every world, and resolves how many worlds held anything of it. */
  removeFromWorlds(filename: string): Promise<number>
}

export interface ScanFilesRemoved {
  glb: boolean
  metadata: boolean
  /** Derived files and folders removed. */
  derived: number
  /** Could not be removed (not counting what was already gone). */
  failed: number
}

type Outcome = 'removed' | 'absent' | 'failed'

/** Removes one path. A path that is already gone is `absent`, which is as good as removed. A link is removed as a link. */
async function removeEntry(path: string, recursive: boolean): Promise<Outcome> {
  try {
    await Deno.remove(path, { recursive })
    return 'removed'
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 'absent'
    console.error(`[scan delete] could not remove a file (${error instanceof Error ? error.name : 'Error'})`)
    return 'failed'
  }
}

/** Whether `filename` is a name this module may build paths from: a plain GLB name, no separators, no control characters. */
export function isPlainScanFilename(filename: string): boolean {
  return filename.length > 0 &&
    filename.endsWith('.glb') &&
    !filename.startsWith('.') &&
    !/[\\/\u0000-\u001f\u007f]/.test(filename)
}

/**
 * Removes what was made from the scan, and then the scan: the files the pipelines wrote beside it, its `.4d/` folder and
 * the folders SenseNova wrote for `senseNovaJobIds` first, attempting every one so that one that cannot be removed does not
 * hide the others; then its GLB and its sidecar, and only when nothing above failed. A scan that stays because something
 * could not be removed is still the scan: it is listed, it names its sessions, and deleting it again finishes the job. Never
 * throws: each outcome is counted.
 */
export async function removeScanFiles(opts: {
  scansDir: string
  filename: string
  splatSuffixes: readonly string[]
  senseNovaJobIds?: readonly string[]
}): Promise<ScanFilesRemoved> {
  const { scansDir, filename } = opts
  const base = filename.replace(/\.glb$/, '')
  const result: ScanFilesRemoved = { glb: false, metadata: false, derived: 0, failed: 0 }
  const count = (outcome: Outcome, onRemoved: () => void): void => {
    if (outcome === 'removed') onRemoved()
    else if (outcome === 'failed') result.failed += 1
  }

  const derivedFiles = [
    ...OPTIMIZER_SUFFIXES,
    LINGBOT_GLB_SUFFIX,
    ...opts.splatSuffixes,
  ].map((suffix) => `${scansDir}/${base}${suffix}`)
  for (const path of derivedFiles) count(await removeEntry(path, false), () => (result.derived += 1))
  const derivedFolders = [
    `${scansDir}/${base}.4d`,
    ...(opts.senseNovaJobIds ?? []).map((jobId) => `${scansDir}/${SENSENOVA_DIR}/${safeSlug(jobId)}`),
  ]
  for (const path of derivedFolders) count(await removeEntry(path, true), () => (result.derived += 1))
  if (result.failed > 0) return result

  // The scan itself goes last. Its GLB first: the sidecar is what names its sessions and its Place, so it stays while the GLB does.
  const glb = await removeEntry(`${scansDir}/${filename}`, false)
  count(glb, () => {
    result.glb = true
  })
  if (glb !== 'failed') {
    count(await removeEntry(`${scansDir}/${base}.json`, false), () => {
      result.metadata = true
    })
  }
  return result
}

/**
 * `DELETE /scans/:filename`. Never throws: whatever goes wrong is a 500 with a fixed message, logged by the error's name.
 */
export async function deleteScan(filename: string, deps: ScanDeletionDeps): Promise<ScanDeleteReply> {
  if (!isPlainScanFilename(filename)) return { status: 400, body: { error: 'Invalid filename' } }
  // The mark goes up before anything is looked at, so a job that starts now sees it (scan_job_guard.ts).
  const lift = markScansBeingDeleted([scanIdFor(filename), filename])
  try {
    let claim = await deps.claimJobs(filename)
    // Every upload queues an optimize-scan job that starts at once and takes a few seconds. A delete sent right after an
    // upload (a script, a test, a person who saw it was the wrong file) would meet it: wait for such a job, for a bounded
    // time, and look again. Any other running job (a splat or a COLMAP run can take hours) is not waited for.
    const settleUntil = Date.now() + OPTIMIZE_SETTLE_MAX_MS
    while (claim.running.length > 0 && claim.running.every((job) => job.type === 'optimize-scan') && Date.now() < settleUntil) {
      await new Promise((resolve) => setTimeout(resolve, OPTIMIZE_SETTLE_POLL_MS))
      claim = await deps.claimJobs(filename)
    }
    if (claim.running.length > 0) {
      return {
        status: 409,
        body: {
          error: 'This scan is still being processed, so it was not deleted. Try again when the job has finished.',
          running: claim.running,
        },
      }
    }
    const keyframes = await deleteScanSessions({ scansDir: deps.scansDir, sessionsDir: deps.sessionsDir, filename })
    if (keyframes.report.failed.length > 0) {
      return {
        status: 500,
        body: {
          error: 'Could not remove all of this scan\'s camera frames, so the scan was kept. Try again.',
          keyframes: scanSessionDeletionBody(keyframes),
        },
      }
    }
    const files = await removeScanFiles({
      scansDir: deps.scansDir,
      filename,
      splatSuffixes: deps.splatSuffixes,
      senseNovaJobIds: claim.senseNovaJobIds,
    })
    if (files.failed > 0) {
      return {
        status: 500,
        body: {
          error: 'Could not remove all of this scan\'s files, so the scan was kept. Try again.',
          files: { failed: files.failed },
          keyframes: scanSessionDeletionBody(keyframes),
        },
      }
    }
    // Before the worlds: a failure here is a 500 that leaves the scan in its worlds, so deleting it again removes the export.
    const worldExports = await deps.dropWorldExports(filename)
    // The worlds last, and always: a scan whose files are already gone (an earlier try that stopped after them, or a file
    // deleted by hand) may still have a row, jobs and patches in a world, and what a person asked for is the scan gone.
    const worlds = await deps.removeFromWorlds(filename)
    const keyframeSessions = keyframes.report.deleted.length
    if (!files.glb && !files.metadata && files.derived === 0 && keyframeSessions === 0 && worldExports === 0 && worlds === 0) {
      return { status: 404, body: { error: 'Scan not found' } }
    }
    return {
      status: 200,
      body: {
        ok: true,
        filename,
        deleted: { glb: files.glb, metadata: files.metadata, sidecars: files.derived, keyframeSessions, worldExports, worlds },
        keyframes: scanSessionDeletionBody(keyframes),
      },
    }
  } catch (error) {
    console.error(`[scan delete] stopped on an error (${error instanceof Error ? error.name : 'Error'})`)
    return { status: 500, body: { error: 'Could not delete the scan. Nothing was reported as removed that was not.' } }
  } finally {
    lift()
  }
}

/** What `DELETE /scans?confirm=delete-all` is asked to do in the worlds. */
export interface DeleteAllDeps {
  scansDir: string
  sessionsDir: string
  splatSuffixes: readonly string[]
  /** The jobs running on any scan, in every world. */
  runningJobs(): Promise<RunningScanJob[]>
  /** Removes every world export (each is a copy of scan geometry). Throws when one cannot be removed. */
  dropAllWorldExports(): Promise<number>
  /** Empties every world of scans, scan jobs and scan patches. */
  removeAllFromWorlds(): Promise<unknown>
}

/** Names directly under `scansDir`, read once, so that removing them does not disturb the listing. */
async function topLevelEntries(scansDir: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = []
  for await (const entry of Deno.readDir(scansDir)) entries.push({ name: entry.name, isFile: entry.isFile, isDirectory: entry.isDirectory })
  return entries
}

/**
 * `DELETE /scans?confirm=delete-all`: every scan, every file made from one, and every camera-frame session. Places and
 * their reference photos stay. A scan being written right now (a `.part` younger than an upload can take) is left alone.
 * Refuses (409) while a job runs on any scan, for the reason a single delete does. Never throws.
 */
export async function deleteAllScans(deps: DeleteAllDeps, now: number = Date.now()): Promise<ScanDeleteReply> {
  const lift = markEveryScanBeingDeleted()
  try {
    const running = await deps.runningJobs()
    if (running.length > 0) {
      return {
        status: 409,
        body: {
          error: 'Scans are still being processed, so nothing was deleted. Try again when the jobs have finished.',
          running,
        },
      }
    }
    // The camera frames go first, for the reason a single delete takes them first: a failure must leave the scans that name them.
    const sessions = await deleteAllSessions(deps.sessionsDir)
    if (sessions.failed.length > 0) {
      return {
        status: 500,
        body: {
          error: 'Could not remove all camera frames, so the scans were kept. Try again.',
          keyframeSessions: { deleted: sessions.deleted.length, failed: sessions.failed.length },
        },
      }
    }
    let deleted = 0
    let failed = 0
    for (const entry of await topLevelEntries(deps.scansDir)) {
      let outcome: Outcome | null = null
      if (entry.isDirectory && (entry.name.endsWith('.4d') || entry.name === SENSENOVA_DIR)) {
        outcome = await removeEntry(`${deps.scansDir}/${entry.name}`, true)
      } else if (entry.isFile && entry.name.endsWith(`.glb${PART_SUFFIX}`)) {
        // An upload that is still arriving keeps its file. One that was cut short will never be published, and is camera data.
        const info = await Deno.stat(`${deps.scansDir}/${entry.name}`).catch(() => null)
        if (info?.mtime && now - info.mtime.getTime() > UNPUBLISHED_UPLOAD_MAX_AGE_MS) {
          outcome = await removeEntry(`${deps.scansDir}/${entry.name}`, false)
        }
      } else if (
        entry.isFile &&
        (entry.name.endsWith('.glb') || entry.name.endsWith('.json') || deps.splatSuffixes.some((suffix) => entry.name.endsWith(suffix)))
      ) {
        outcome = await removeEntry(`${deps.scansDir}/${entry.name}`, false)
      }
      if (outcome === 'removed') deleted += 1
      else if (outcome === 'failed') failed += 1
    }
    if (failed > 0) {
      return {
        status: 500,
        body: { error: 'Could not remove everything, so the worlds were left as they were. Try again.', deleted, failed },
      }
    }
    await deps.dropAllWorldExports()
    await deps.removeAllFromWorlds()
    return { status: 200, body: { ok: true, deleted, keyframeSessions: sessions.deleted.length } }
  } catch (error) {
    console.error(`[scans clear] stopped on an error (${error instanceof Error ? error.name : 'Error'})`)
    return { status: 500, body: { error: 'Could not clear the scans. Nothing was reported as removed that was not.' } }
  } finally {
    lift()
  }
}
