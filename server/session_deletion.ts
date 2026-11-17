/**
 * Removing a scan's camera frames, so that deleting a scan deletes what the scan was made from.
 *
 * `DELETE /scans/:filename` used to remove the GLB, its sidecar and the optimizer's files, and nothing else:
 * the keyframe JPEGs, their poses and every file a job wrote beside them stayed under
 * `scans/sessions/<id>/` with nothing pointing at them. Those are photographs of the inside of a person's
 * home. This module is the one place that knows how a scan finds its sessions and how a session directory
 * is taken away. It lives apart from main.ts, which a test cannot import (it serves at import), so that
 * both can be tested against real temporary directories.
 *
 * ## How a scan finds its sessions
 *
 * A capture session is a directory of keyframes (`session.json`, `keyframes.jsonl`, `kf-NNNNN.jpg`, and
 * whatever a reconstruction job wrote beside them). It is tied to a scan two ways, and a scan may have
 * several sessions, because the scanner closes a session and opens another after every export (audit
 * W4-4: about twenty short sessions for one room):
 *
 *   1. the scan's own sidecar names one: `<scan>.json` has `sessionId`;
 *   2. a session names the scan: `session.json` has `glbFilename`, set when the session is finalized.
 *      Several sessions can name one scan, so every one is taken, not the first (`SessionIndex.byGlb`
 *      keeps only the first);
 *   3. a session follows the scan: `session.json` has `followsGlbFilename`. The scanner rotates its session after
 *      every export, so the session that is open when the walk ends holds the frames taken after the last export and
 *      never had a scan of its own to be finalized against. The streamer finalizes it against the scan its stream last
 *      exported, in this separate field (`glbFilename` keeps its one meaning: the scan made from this session), so that
 *      deleting that scan takes the trailing frames of the same walk with it. A walk that never exported has no scan to
 *      follow: its frames go with the retention setting or "Delete frames this phone sent".
 *
 * A scan made from an upload (a video, photos, a tripod sweep, a person clip) has no GLB until a job
 * writes one. Its filename is the synthetic `<sessionId>.glb`, and the session is the scan's data.
 *
 * ## What is not taken
 *
 * A session that another scan still names is kept, and said to be kept, with the scans that hold it: the
 * frames are that scan's data too, and deleting one scan must not take another one's source. It goes when
 * the last scan that names it is deleted.
 *
 * ## Order, and what a failure leaves
 *
 * The sessions go before the scan's own files. A scan that stays because a session could not be removed
 * can be deleted again; a scan that went first would have taken the only link to the frames it left.
 * Inside a session directory the frames go first and `session.json` goes with the directory itself, for the same
 * reason: it is what the `glbFilename` link is read from, so a removal that stopped half way still leaves the session
 * findable. A file that appears while the removal runs (a reconstruction job writing beside the frames) is taken with the
 * directory, not left in a folder nothing points to. A repeated delete finds nothing to do and succeeds.
 */
import { loadSessionIndex, type SessionIndex } from './scan_index.ts'
import { SESSION_ID_RE, sessionDirPath } from './session_id.ts'
import { PART_SUFFIX } from './world/scan_store.ts'
import { queueKeyframeWrite } from './wp-a-keyframes.ts'

/** What became of each session a call was asked to remove. Session ids and nothing from inside a session. */
export interface SessionDeletionReport {
  /** Removed by this call. */
  deleted: string[]
  /** Already gone, which counts as done: a repeated delete is a success. */
  missing: string[]
  /** Could not be removed, with the error's name. What was removed before the failure stays removed. */
  failed: Array<{ sessionId: string; reason: string }>
  /** Bytes the removed sessions held, measured before removal. */
  bytes: number
}

/** A scan's sessions split by what happens to them. */
export interface ScanSessionPlan {
  /** Sessions only this scan names. */
  delete: string[]
  /** Sessions another scan still names, with those scans. */
  retained: Array<{ sessionId: string; usedBy: string[] }>
}

const DERIVED_GLB = /\.(opt|lod\d+)\.glb$/

/**
 * Files read at once when a directory is measured or its scans' sidecars are read. Adopted, not measured (ADR 0005
 * rule 5): the scan listing reads sidecars 64 at a time (main.ts SCAN_LIST_CONCURRENCY), and a delete is rare, so half of it.
 */
const READ_CONCURRENCY = 32

/** Whether `value` is a server-minted capture-session id, the only kind that names a directory here. */
function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/**
 * The sessions a scan names: the one its sidecar says, every session finalized against it, every session that
 * follows it (the frames taken after its export), and, for a scan made from an upload, its own synthetic id.
 * Ids only; says nothing about whether a directory exists.
 */
export function sessionIdsLinkedToScan(
  index: SessionIndex,
  filename: string,
  meta: Record<string, unknown>,
): string[] {
  const ids = new Set<string>()
  if (isSessionId(meta['sessionId'])) ids.add(meta['sessionId'])
  for (const [sessionId, record] of index.bySessionId) {
    if (!isSessionId(sessionId)) continue
    if (record['glbFilename'] === filename || record['followsGlbFilename'] === filename) ids.add(sessionId)
  }
  const synthetic = filename.endsWith('.glb') ? filename.slice(0, -'.glb'.length) : ''
  if (isSessionId(synthetic)) ids.add(synthetic)
  return [...ids]
}

/** Runs `work` over `items`, at most `READ_CONCURRENCY` at a time, and returns the results in order. */
async function mapBounded<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    const batch = items.slice(i, i + READ_CONCURRENCY)
    const results = await Promise.all(batch.map(work))
    results.forEach((result, offset) => {
      out[i + offset] = result
    })
  }
  return out
}

async function readSidecar(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * How long a scan that is still being written (`<name>.glb.part`, scan_store.ts) counts as a user of the sessions its
 * sidecar names. An upload takes seconds; one older than this was cut short by a crash and will never be published, and
 * must not keep a session alive for good. Adopted, not measured (ADR 0005 rule 5): an hour is far past any upload this
 * server accepts, and the cost of being wrong is a session kept until the next delete or the retention purge.
 */
export const UNPUBLISHED_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000

/**
 * The sessions every scan in `scansDir` names, by the scan's filename: each GLB with its sidecar, each scan
 * made from an upload, which has a sidecar `<sessionId>.json` and no GLB, and each scan that is being written right
 * now: its sidecar is in place before its `.part` is renamed to `.glb`, so for a moment it names sessions and is
 * not listed. Deleting another scan that shares one of them must not take the frames of a scan a moment from being
 * published. Only the files at the top of the directory are read, so nothing under `sessions/` or `projects/` is.
 */
export async function collectScanSessionLinks(
  scansDir: string,
  index: SessionIndex,
  now: number = Date.now(),
): Promise<Map<string, string[]>> {
  const glbs = new Set<string>()
  const uploadSidecars: string[] = []
  const parts: string[] = []
  for await (const entry of Deno.readDir(scansDir)) {
    if (!entry.isFile) continue
    if (entry.name.endsWith('.glb') && !DERIVED_GLB.test(entry.name)) glbs.add(entry.name)
    else if (entry.name.endsWith(`.glb${PART_SUFFIX}`)) parts.push(entry.name)
    else if (entry.name.endsWith('.json') && isSessionId(entry.name.slice(0, -'.json'.length))) uploadSidecars.push(entry.name)
  }
  const filenames = [...glbs]
  for (const sidecar of uploadSidecars) {
    const synthetic = `${sidecar.slice(0, -'.json'.length)}.glb`
    if (!glbs.has(synthetic)) filenames.push(synthetic)
  }
  for (const part of parts) {
    const future = part.slice(0, -PART_SUFFIX.length)
    if (glbs.has(future) || filenames.includes(future)) continue
    try {
      const info = await Deno.stat(`${scansDir}/${part}`)
      if (info.mtime && now - info.mtime.getTime() <= UNPUBLISHED_UPLOAD_MAX_AGE_MS) filenames.push(future)
    } catch { /* gone since the listing: published or abandoned, either way not a user */ }
  }
  const links = new Map<string, string[]>()
  await mapBounded(filenames, async (filename) => {
    const meta = await readSidecar(`${scansDir}/${filename.replace(/\.glb$/, '.json')}`)
    links.set(filename, sessionIdsLinkedToScan(index, filename, meta))
  })
  return links
}

/**
 * Which of `ownIds` go with the scan `filename` and which stay because another scan in `links` still names
 * them. `links` may include `filename` itself, which is ignored: a scan is not its own other user.
 */
export function planScanSessionDeletion(
  ownIds: readonly string[],
  links: ReadonlyMap<string, readonly string[]>,
  filename: string,
): ScanSessionPlan {
  const plan: ScanSessionPlan = { delete: [], retained: [] }
  for (const sessionId of new Set(ownIds)) {
    const usedBy = [...links]
      .filter(([other, ids]) => other !== filename && ids.includes(sessionId))
      .map(([other]) => other)
    if (usedBy.length === 0) plan.delete.push(sessionId)
    else plan.retained.push({ sessionId, usedBy })
  }
  return plan
}

/** Total size of the files under `dir`, not following links. A file that cannot be read counts for nothing. */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  const names: Array<{ name: string; isDirectory: boolean }> = []
  try {
    for await (const entry of Deno.readDir(dir)) names.push({ name: entry.name, isDirectory: entry.isDirectory })
  } catch {
    return 0
  }
  const sizes = await mapBounded(names, async ({ name, isDirectory }) => {
    if (isDirectory) return await directoryBytes(`${dir}/${name}`)
    try {
      const info = await Deno.lstat(`${dir}/${name}`)
      return info.isFile ? info.size : 0
    } catch {
      return 0
    }
  })
  for (const size of sizes) total += size
  return total
}

/** The name of an error, for a report that must not carry a path. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

/** Removes `path` (a directory with its contents, or a file or link on its own). A path that is already gone is done. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true })
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}

/**
 * How many times the removal lists a session's folder again before it gives up waiting for it to go quiet. Adopted, not
 * measured (ADR 0005 rule 5): a writer that adds files faster than they can be removed is not one this can outrun, and
 * the folder is then removed whole, with what it holds, by the last step.
 */
const MAX_QUIET_PASSES = 4

/** What a test may do while a removal runs, to be a writer that adds a file late. Never set in production. */
export interface RemoveSessionHooks {
  /**
   * Called after each listing's files have been removed, `quiet` when that listing held nothing but `session.json`. A file
   * written from here arrived after the listing it follows.
   */
  afterPass?: (dir: string, info: { pass: number; quiet: boolean }) => Promise<void>
}

/**
 * Removes one session directory: everything but `session.json` first, listing again until nothing else is left, then
 * the folder itself with `session.json` in it. A half-removed session keeps its record, so it can be found and the
 * scan that names it deleted again. A file that appears after the last listing (a reconstruction job writing beside the
 * frames) is the session's too and goes with the folder: removing it non-recursively would fail on it with the record
 * already gone, and leave a folder with the pictures' neighbours in it and nothing pointing to it.
 * Runs behind the session's keyframe write queue (server/wp-a-keyframes.ts), so a frame being written
 * is finished before the removal starts and cannot land in a directory that is being emptied.
 * Resolves false when the directory was already gone.
 */
export function removeSessionDirectory(dir: string, hooks: RemoveSessionHooks = {}): Promise<boolean> {
  return queueKeyframeWrite(dir, async () => {
    for (let pass = 0; pass < MAX_QUIET_PASSES; pass++) {
      const names: string[] = []
      try {
        for await (const entry of Deno.readDir(dir)) names.push(entry.name)
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return pass > 0
        throw error
      }
      const others = names.filter((item) => item !== 'session.json')
      // A link inside a session is removed as a link: removal does not follow it.
      for (const name of others) await removeIfPresent(`${dir}/${name}`)
      await hooks.afterPass?.(dir, { pass, quiet: others.length === 0 })
      if (others.length === 0) break
    }
    // Recursive on purpose: what arrived after the last listing is taken with the folder (see above).
    await removeIfPresent(dir)
    return true
  })
}

/**
 * Removes the sessions `ids` name under `sessionsDir`. An id that is not a session id is refused without
 * touching the filesystem. A directory that is a link, or not a directory, is refused too: only a real
 * directory directly under `sessionsDir` is ever removed. Never throws for one session: each outcome is in
 * the report.
 */
export async function deleteSessionDirectories(
  sessionsDir: string,
  ids: readonly string[],
): Promise<SessionDeletionReport> {
  const report: SessionDeletionReport = { deleted: [], missing: [], failed: [], bytes: 0 }
  for (const sessionId of new Set(ids)) {
    const dir = sessionDirPath(sessionsDir, sessionId)
    if (!dir) {
      report.failed.push({ sessionId, reason: 'InvalidSessionId' })
      continue
    }
    let info: Deno.FileInfo
    try {
      info = await Deno.lstat(dir)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) report.missing.push(sessionId)
      else report.failed.push({ sessionId, reason: reasonOf(error) })
      continue
    }
    if (!info.isDirectory) {
      report.failed.push({ sessionId, reason: 'NotADirectory' })
      continue
    }
    const bytes = await directoryBytes(dir)
    try {
      if (await removeSessionDirectory(dir)) {
        report.deleted.push(sessionId)
        report.bytes += bytes
      } else {
        report.missing.push(sessionId)
      }
    } catch (error) {
      report.failed.push({ sessionId, reason: reasonOf(error) })
    }
  }
  return report
}

/** What deleting a scan did to its sessions: what was decided, and what happened. */
export interface ScanSessionDeletion {
  plan: ScanSessionPlan
  report: SessionDeletionReport
}

/**
 * Removes the sessions that only the scan `filename` names. Reads the scan's sidecar itself (missing or
 * unreadable counts as empty, so a scan whose sidecar is already gone still finds the sessions that name it).
 */
export async function deleteScanSessions(opts: {
  scansDir: string
  sessionsDir: string
  filename: string
}): Promise<ScanSessionDeletion> {
  const { scansDir, sessionsDir, filename } = opts
  const index = await loadSessionIndex(sessionsDir)
  const meta = await readSidecar(`${scansDir}/${filename.replace(/\.glb$/, '.json')}`)
  const own = sessionIdsLinkedToScan(index, filename, meta)
  const links = own.length > 0 ? await collectScanSessionLinks(scansDir, index) : new Map<string, string[]>()
  const plan = planScanSessionDeletion(own, links, filename)
  return { plan, report: await deleteSessionDirectories(sessionsDir, plan.delete) }
}

/** The part of a deletion a client is told: counts, and the ids it can act on. No paths. */
export function scanSessionDeletionBody(deletion: ScanSessionDeletion): {
  sessions: number
  missing: number
  failed: number
  bytes: number
  retained: ScanSessionPlan['retained']
} {
  return {
    sessions: deletion.report.deleted.length,
    missing: deletion.report.missing.length,
    failed: deletion.report.failed.length,
    bytes: deletion.report.bytes,
    retained: deletion.plan.retained,
  }
}

/**
 * Removes every session directory under `sessionsDir`, for the call that clears all scan storage. A
 * session is a scan's source, and no scan is left to name it.
 */
export async function deleteAllSessions(sessionsDir: string): Promise<SessionDeletionReport> {
  const ids: string[] = []
  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (entry.isDirectory && isSessionId(entry.name)) ids.push(entry.name)
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return await deleteSessionDirectories(sessionsDir, ids)
}

/** The reply to `DELETE /sessions/:id`: a status and a body, so the route is a few lines. */
export interface SessionDeleteReply {
  status: 200 | 400 | 404 | 409 | 500
  body: Record<string, unknown>
}

/**
 * `DELETE /sessions/:id`: removes one session's camera frames. A phone that withdraws its consent to send frames
 * uses it to delete the ones it sent. A session that is the source of a scan made from an upload (its record says
 * `source` or `captureKind`) is refused: its frames are that scan's data, and they go when the scan is deleted.
 * A session of a scanner's own export is not refused even when a scan names it: the scan is the GLB, and what
 * is removed is the camera frames beside it. A session that is gone answers 404, which a caller reads as done.
 */
export async function deleteStreamedSession(sessionsDir: string, id: string): Promise<SessionDeleteReply> {
  const dir = sessionDirPath(sessionsDir, id)
  if (!dir) return { status: 400, body: { error: 'Invalid session id' } }
  const record = await readSidecar(`${dir}/session.json`)
  const isSource = (typeof record['source'] === 'string' && record['source'] !== '') ||
    (typeof record['captureKind'] === 'string' && record['captureKind'] !== '')
  if (isSource) {
    return {
      status: 409,
      body: { error: 'This session is the source of a scan. Delete the scan to remove it.', sessionId: id },
    }
  }
  const report = await deleteSessionDirectories(sessionsDir, [id])
  if (report.failed.length > 0) {
    return { status: 500, body: { error: 'Could not remove this session', sessionId: id, reason: report.failed[0]!.reason } }
  }
  if (report.deleted.length === 0) return { status: 404, body: { error: 'Session not found' } }
  return { status: 200, body: { ok: true, sessionId: id, bytes: report.bytes } }
}
