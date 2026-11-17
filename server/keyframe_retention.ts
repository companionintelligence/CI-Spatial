/**
 * Keyframe retention: how long a server keeps the camera frames a scanner streamed to it, and the purge that
 * enforces it.
 *
 * The setting is `KEYFRAME_RETENTION_DAYS`. Unset, empty, `off` or `keep` keeps every frame until the scan
 * is deleted: the default, because how long a person wants their own server to hold their own rooms is the
 * owner's decision (docs/operations/PRIVACY.md). A whole number of days turns the purge on. Anything else keeps
 * everything and says why: a typo must never start deleting. That includes `0`: it reads as "keep none" to one
 * person and "no limit" to another, so it is not taken for either, and it keeps everything.
 *
 * ## What the purge removes
 *
 * A capture session directory (`scans/sessions/<id>/`: the frames, their poses and whatever a job wrote beside
 * them) whose last activity is older than the setting. The last activity is the newest of the session's own
 * `startedAt` and `finalizedAt`, and the modification times of `session.json` and `keyframes.jsonl`, which is
 * appended to for every frame: a session that is being streamed to, or was streamed or finalized this week, is not old.
 * Work a job did on the session later does not count: a purge removes what a job wrote in the folder with the frames.
 *
 * ## What it never removes
 *
 *   - a session that is a scan's own source: one made from an upload (a video, photos, a tripod sweep, a person
 *     clip). Its record says `source` or `captureKind`. The upload is the scan, so retention, which is about
 *     the frames a scanner streamed as a by-product, does not apply; deleting that scan deletes it;
 *   - anything that is not a real directory directly under the sessions directory with a session id for its
 *     name: a link, a file, another folder;
 *   - anything at all when the sessions directory is not inside the scans directory. The purge deletes only
 *     under `SCANS_DIR`, so a mistaken `SESSIONS_DIR` cannot point it at something else. It says so and stops.
 *
 * ## How it runs
 *
 * As a `keyframe-purge` WorldJob (ADR 0003): one at a time with every other job, so it never removes a session while a
 * reconstruction job is reading it. The server queues a real pass at boot and every day while a period is set.
 *
 * A request can queue one too, and a request is a dry run unless it says otherwise: only `payload.dryRun === false`
 * removes anything, so a payload that is missing, malformed or spelt another way (`"true"`, `1`, `"yes"`) reports and
 * removes nothing. A real pass takes the period from the server's environment and nowhere else. A dry run may name a
 * period of its own (`payload.days`) to show what turning the setting on would remove, before it is turned on: it deletes
 * nothing, so asking for another period costs nothing.
 *
 * ## What it logs
 *
 * Counts, and nothing that names a session, a scan, a path or a place (`purgeSummary`).
 */
import { isAbsolute, relative, SEPARATOR } from '@std/path'
import { deleteSessionDirectories, directoryBytes } from './session_deletion.ts'
import { SESSION_ID_RE } from './session_id.ts'

/** The environment variable that sets the retention period, in whole days. */
export const KEYFRAME_RETENTION_ENV = 'KEYFRAME_RETENTION_DAYS'

/**
 * How often the server queues a purge while a retention period is set. Adopted, not measured (ADR 0005 rule 5):
 * the setting is in whole days, so a daily pass is as fine as it can be told apart, and a pass over a few
 * thousand session folders costs a directory listing and a few small reads. Revisit if a purge is ever slow.
 */
export const KEYFRAME_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The longest period accepted, a hundred years. A larger number is a typo. Adopted, not measured (ADR 0005 rule 5): a sanity bound, not a need. */
const MAX_RETENTION_DAYS = 36_500

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionSetting {
  /** Days to keep a streamed session, or null to keep it until its scan is deleted. */
  days: number | null
  /** Set when the value was neither a number of days nor a way of saying "keep": the reason, for the log. */
  problem: string | null
}

/** Reads the value of `KEYFRAME_RETENTION_DAYS`. */
export function parseKeyframeRetentionDays(raw: string | null | undefined): RetentionSetting {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'off' || value === 'keep') return { days: null, problem: null }
  if (/^[0-9]+$/.test(value)) {
    const days = Number(value)
    if (days >= 1 && days <= MAX_RETENTION_DAYS) return { days, problem: null }
  }
  return {
    days: null,
    problem: `${KEYFRAME_RETENTION_ENV} must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or unset to keep everything` +
      `${/^0+$/.test(value) ? ' (0 is not accepted: it could mean either)' : ''}. Keeping everything.`,
  }
}

export type PurgeSkip = 'retention-off' | 'sessions-dir-missing' | 'sessions-outside-scans'

/** What one pass did. Counts and bytes only. */
export interface PurgeReport {
  dryRun: boolean
  /** The period this pass judged by: the server's setting, or, on a dry run that named one, that period. */
  retentionDays: number | null
  /** The server's own setting. Differs from `retentionDays` only on a dry run that named another period. */
  settingDays: number | null
  /** Why nothing was examined, or null when the pass ran. */
  skipped: PurgeSkip | null
  /** Session folders examined. */
  scanned: number
  /** Older than the period and eligible: removed on a real pass, would be removed on a dry run. */
  expired: number
  /** Removed. Always 0 on a dry run. */
  deleted: number
  /** Not examined for age because the session is a scan's own source (an upload). */
  keptSource: number
  /** Younger than the period, or with no date to judge it by. */
  keptYoung: number
  /** Expired but could not be removed. */
  failed: number
  /** Bytes the expired sessions hold: freed on a real pass, would be freed on a dry run. */
  bytes: number
}

export interface PurgeOptions {
  sessionsDir: string
  scansDir: string
  /** The period to judge by. Null makes the pass do nothing. */
  retentionDays: number | null
  /** The server's own setting, for the report. Defaults to `retentionDays`. */
  settingDays?: number | null
  /** Report only. */
  dryRun: boolean
  /** The clock, in ms since the epoch. */
  now?: number
}

function emptyReport(opts: PurgeOptions): PurgeReport {
  return {
    dryRun: opts.dryRun,
    retentionDays: opts.retentionDays,
    settingDays: opts.settingDays === undefined ? opts.retentionDays : opts.settingDays,
    skipped: null,
    scanned: 0,
    expired: 0,
    deleted: 0,
    keptSource: 0,
    keptYoung: 0,
    failed: 0,
    bytes: 0,
  }
}

/** True when `child` is `parent` or lies under it, by their real paths. */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || !(path === '..' || path.startsWith(`..${SEPARATOR}`) || isAbsolute(path))
}

async function readRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function modifiedMs(path: string): Promise<number | null> {
  try {
    const info = await Deno.stat(path)
    return info.mtime ? info.mtime.getTime() : null
  } catch {
    return null
  }
}

/** The newest sign of life in a session, in ms, or null when there is none to read. */
async function lastActivityMs(dir: string, record: Record<string, unknown> | null): Promise<number | null> {
  const times: number[] = []
  for (const field of ['startedAt', 'finalizedAt']) {
    const value = record?.[field]
    const ms = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isFinite(ms)) times.push(ms)
  }
  for (const file of ['session.json', 'keyframes.jsonl']) {
    const ms = await modifiedMs(`${dir}/${file}`)
    if (ms !== null) times.push(ms)
  }
  if (times.length === 0) {
    const ms = await modifiedMs(dir)
    if (ms !== null) times.push(ms)
  }
  return times.length === 0 ? null : Math.max(...times)
}

/** Whether a session record is the source of a scan made from an upload. */
function isScanSource(record: Record<string, unknown> | null): boolean {
  const source = record?.['source']
  const kind = record?.['captureKind']
  return (typeof source === 'string' && source !== '') || (typeof kind === 'string' && kind !== '')
}

/**
 * One purge pass. Removes the expired sessions, or counts them on a dry run. Never throws for a session it
 * cannot read or remove: that session is counted as failed and the pass goes on.
 */
export async function purgeExpiredKeyframeSessions(opts: PurgeOptions): Promise<PurgeReport> {
  const report = emptyReport(opts)
  if (opts.retentionDays === null) return { ...report, skipped: 'retention-off' }

  let realSessions: string
  let realScans: string
  try {
    realSessions = await Deno.realPath(opts.sessionsDir)
    realScans = await Deno.realPath(opts.scansDir)
  } catch {
    return { ...report, skipped: 'sessions-dir-missing' }
  }
  if (!isInside(realScans, realSessions)) return { ...report, skipped: 'sessions-outside-scans' }

  const cutoff = (opts.now ?? Date.now()) - opts.retentionDays * DAY_MS
  const expired: string[] = []
  for await (const entry of Deno.readDir(realSessions)) {
    // A link is not a directory here, so a link to somewhere else is never examined, let alone removed.
    if (!entry.isDirectory || !SESSION_ID_RE.test(entry.name)) continue
    report.scanned += 1
    const dir = `${realSessions}/${entry.name}`
    const record = await readRecord(`${dir}/session.json`)
    if (isScanSource(record)) {
      report.keptSource += 1
      continue
    }
    const last = await lastActivityMs(dir, record)
    // A session with no readable sign of life is left alone: nothing says it is old.
    if (last === null || last > cutoff) {
      report.keptYoung += 1
      continue
    }
    expired.push(entry.name)
  }

  report.expired = expired.length
  if (opts.dryRun) {
    let bytes = 0
    for (const id of expired) bytes += await directoryBytes(`${realSessions}/${id}`)
    return { ...report, bytes }
  }
  // Removed through the path the server names the folder by, not its real path, so that each removal waits in the same
  // per-session queue as a frame being written to that session (server/wp-a-keyframes.ts keys the queue by that path).
  const removed = await deleteSessionDirectories(opts.sessionsDir, expired)
  // A session that vanished between the listing and the removal is gone, which is what the pass wanted.
  return { ...report, deleted: removed.deleted.length, failed: removed.failed.length, bytes: removed.bytes }
}

function size(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1000)} kB`
}

/**
 * The one line a pass is reported in, for the log and the job's result: counts only, in plain words.
 * It names no session, scan or path.
 */
export function purgeSummary(report: PurgeReport): string {
  if (report.skipped === 'retention-off') {
    return `Retention is off (${KEYFRAME_RETENTION_ENV} is not set): nothing was deleted.` +
      (report.dryRun ? ' To see what a period would remove, queue a dry run with the days: payload {"dryRun": true, "days": 30}.' : '')
  }
  if (report.skipped === 'sessions-dir-missing') {
    return 'The sessions folder could not be read: nothing was deleted.'
  }
  if (report.skipped === 'sessions-outside-scans') {
    return 'The sessions folder is not inside the scans folder (SESSIONS_DIR, SCANS_DIR): nothing was deleted. The purge removes only under the scans folder.'
  }
  const kept = `Kept ${report.keptYoung} newer or undated and ${report.keptSource} that are a scan's own source.`
  if (report.dryRun) {
    const setting = report.settingDays === null
      ? `The server's own setting is off, so nothing is purged until ${KEYFRAME_RETENTION_ENV} is set.`
      : report.settingDays === report.retentionDays
        ? ''
        : `The server's own setting is ${report.settingDays} days.`
    return `Dry run, retention ${report.retentionDays} days: ${report.expired} of ${report.scanned} capture sessions are expired (${size(report.bytes)}). ${kept} Nothing was deleted.${setting ? ` ${setting}` : ''}`
  }
  return `Retention ${report.retentionDays} days: deleted ${report.deleted} of ${report.scanned} capture sessions (${size(report.bytes)}). ${kept} ${report.failed} could not be deleted.`
}

/** What a job asks of a pass. */
export interface PurgeRequest {
  /** Report only. True unless the request said, with the boolean `false`, that it is a real pass. */
  dryRun: boolean
  /** A period for a dry run to judge by instead of the server's setting, or null. Always null on a real pass. */
  previewDays: number | null
}

/**
 * Reads a job's payload. Only `dryRun: false`, the boolean, makes a real pass: a payload that is missing, empty, or has
 * `dryRun` as a string, a number or anything else is a dry run, so that spelling a flag another way can never delete.
 * `days` is read only on a dry run, and only as a whole number of days in the range the setting takes.
 */
export function purgeRequestFromPayload(payload: Record<string, unknown> | null | undefined): PurgeRequest {
  const dryRun = payload?.['dryRun'] !== false
  const days = payload?.['days']
  const previewDays = dryRun && typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS ? days : null
  return { dryRun, previewDays }
}

/**
 * One pass for the `keyframe-purge` job: reads the server's period from `env`, purges, logs the counts, and returns the line
 * the job reports. A real pass judges by the server's period alone. A dry run may judge by `previewDays` instead, which is
 * honoured only here and only when nothing is deleted.
 */
export async function runKeyframePurge(opts: {
  sessionsDir: string
  scansDir: string
  env: (name: string) => string | undefined
  dryRun: boolean
  previewDays?: number | null
}): Promise<string> {
  const settingDays = parseKeyframeRetentionDays(opts.env(KEYFRAME_RETENTION_ENV)).days
  const report = await purgeExpiredKeyframeSessions({
    sessionsDir: opts.sessionsDir,
    scansDir: opts.scansDir,
    retentionDays: opts.dryRun && opts.previewDays ? opts.previewDays : settingDays,
    settingDays,
    dryRun: opts.dryRun,
  })
  const summary = purgeSummary(report)
  console.log(`[keyframe-retention] ${summary}`)
  return summary
}

/** What the job says when a pass stops on an error, and what the log says: the error's name, never its message, which can hold a path. */
export function keyframePurgeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error'
  console.error(`[keyframe-retention] the purge stopped on an error (${name})`)
  return `The purge stopped on an error (${name}).`
}

/**
 * With a retention period in `raw`, runs `queue` now and once a day, so a purge is queued at boot and every
 * `KEYFRAME_PURGE_INTERVAL_MS`. A period that is unset keeps every frame and schedules nothing. One that is not a number
 * of days is ignored with a warning, and schedules nothing: a typo never starts deleting. Returns what stops the daily run.
 */
export function scheduleKeyframeRetention(raw: string | undefined, queue: () => Promise<unknown>): () => void {
  const setting = parseKeyframeRetentionDays(raw)
  if (setting.problem) console.warn(`[keyframe-retention] ${setting.problem}`)
  if (setting.days === null) return () => {}
  console.log(`[keyframe-retention] camera frames are kept ${setting.days} days; a purge is queued now and every day`)
  const run = () => void queue().catch((err) => console.error(`[keyframe-retention] could not queue a purge (${err instanceof Error ? err.name : 'Error'})`))
  run()
  const timer = setInterval(run, KEYFRAME_PURGE_INTERVAL_MS)
  // The server's own exit is not held up by the daily timer.
  Deno.unrefTimer(timer)
  return () => clearInterval(timer)
}
