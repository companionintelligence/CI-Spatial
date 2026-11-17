/**
 * Keeping a scan's deletion and the jobs that work on it from writing at the same time.
 *
 * Every upload gets an optimize job, and the splat, LingBot-Map, COLMAP and SenseNova jobs run for minutes to hours.
 * Each reads the scan and writes its outputs beside it when it finishes. A scan deleted while one of them runs
 * answered 200, and the job then wrote its files after the delete: `.opt.glb`, `.lod1.glb`, a manifest, a splat, a
 * dataset inside a session folder that had just been removed. Measured on the real server: 7 of 12 deletes during an
 * upload's own optimize job left the optimizer's files behind, and the server went on serving them.
 *
 * The rule is the simplest one that holds: a scan is deleted only while no job is running on it.
 *
 *   - A job still waiting for its turn is cancelled by the deletion. It is taken out of its world under that world's
 *     lock, and the pump starts a job only after finding it there in the same lock, so a cancelled job cannot start.
 *   - A job that is running is not interrupted and not waited for (a splat job can take hours). The delete answers
 *     409 and names it; the person tries again when it has finished.
 *   - A job that is queued or created after the check, in the few milliseconds before the files go, meets the second
 *     half: the deletion marks the scan as being deleted (below) before it looks, and the pump's dispatch looks at the
 *     mark after it has found its job and before it starts it. Each side writes its flag and then reads the other's,
 *     so at least one sees the other, whichever goes first.
 *
 * Pure of the world's storage and of the server, so main.ts calls it and a test can too (main.ts serves at import).
 */
import type { WorldJob, WorldProject } from '../src/world/types.ts'
import { legacyScanId, scanIdFor } from './scan_id.ts'

/** A job running on a scan, as the 409 names it: its id and what it is. Nothing from its payload. */
export interface RunningScanJob {
  jobId: string
  type: string
}

/** What a world holds that bears on deleting one scan. */
export interface ScanJobsInWorld {
  /** Running on the scan now, or an export of a world that holds it: the deletion must wait for them. */
  running: RunningScanJob[]
  /** Waiting for their turn on the scan: the deletion cancels them. */
  waiting: string[]
  /** The finished SenseNova jobs for the scan: each wrote a folder of camera-derived files named by its job id. */
  senseNovaJobIds: string[]
}

/**
 * The ids a scan goes by in `world`: the one derived from its filename, the one its row carries, and the one it carried
 * before scan ids were made per upload (a job written then can still name that one).
 */
export function scanIdsInWorld(world: Pick<WorldProject, 'scans'>, filename: string): Set<string> {
  const ids = new Set<string>([scanIdFor(filename)])
  const row = world.scans.find((scan) => scan.filename === filename)
  if (row) {
    ids.add(row.scanId)
    ids.add(legacyScanId(row))
  }
  return ids
}

/**
 * The filename a job names its scan by in its payload, or null. The optimizer's job (`optimize-scan`, queued for every
 * upload and parked in the default world) carries no `scanId`: only `payload.filename`.
 */
function payloadFilename(job: Pick<WorldJob, 'payload'>): string | null {
  const value = job.payload?.['filename']
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Sorts the jobs of `world` that bear on deleting the scan `filename`. A job names the scan by its `scanId` or, for the
 * optimizer's, by `payload.filename`. A world that does not hold the scan can still hold jobs that name it (a row pruned
 * while its job was kept), so the jobs are matched by name, not by the row.
 */
export function scanJobsInWorld(world: Pick<WorldProject, 'scans' | 'jobs'>, filename: string): ScanJobsInWorld {
  const ids = scanIdsInWorld(world, filename)
  const holdsScan = world.scans.some((scan) => scan.filename === filename)
  const found: ScanJobsInWorld = { running: [], waiting: [], senseNovaJobIds: [] }
  for (const job of world.jobs) {
    const names = (job.scanId !== undefined && ids.has(job.scanId)) || payloadFilename(job) === filename
    // An export reads every scan's file into one world file. One running now may have read this scan, and writes
    // that file when it finishes, so the deletion waits for it as it would for a job on the scan itself.
    const exportsThisWorld = job.type === 'export-world' && holdsScan
    if (job.status === 'processing' && (names || exportsThisWorld)) found.running.push({ jobId: job.jobId, type: job.type })
    else if (job.status === 'queued' && names) found.waiting.push(job.jobId)
    else if (names && job.type === 'sensenova-vision') found.senseNovaJobIds.push(job.jobId)
  }
  return found
}

/** The jobs running on any scan, for the call that clears every scan. */
export function runningScanJobs(jobs: readonly Pick<WorldJob, 'jobId' | 'type' | 'status' | 'scanId' | 'payload'>[]): RunningScanJob[] {
  return jobs
    .filter((job) => job.status === 'processing' && (job.scanId !== undefined || payloadFilename(job) !== null))
    .map((job) => ({ jobId: job.jobId, type: job.type }))
}

// ── The mark the pump looks at ──────────────────────────────────────────────

const beingDeleted = new Map<string, number>()
let everyScanBeingDeleted = 0

function countDown(ids: readonly string[]): void {
  for (const id of ids) {
    const left = (beingDeleted.get(id) ?? 0) - 1
    if (left > 0) beingDeleted.set(id, left)
    else beingDeleted.delete(id)
  }
}

/**
 * Marks scans as being deleted, by the ids and filenames a job can name one by. Returns what lifts the mark: call it when
 * the deletion is over, whatever it came to. Counted, so two deletions of one scan at once do not lift each other's mark.
 */
export function markScansBeingDeleted(ids: Iterable<string>): () => void {
  const marked = [...ids]
  for (const id of marked) beingDeleted.set(id, (beingDeleted.get(id) ?? 0) + 1)
  let lifted = false
  return () => {
    if (lifted) return
    lifted = true
    countDown(marked)
  }
}

/** Marks every scan as being deleted, for the call that clears them all. */
export function markEveryScanBeingDeleted(): () => void {
  everyScanBeingDeleted += 1
  let lifted = false
  return () => {
    if (lifted) return
    lifted = true
    everyScanBeingDeleted -= 1
  }
}

/** Whether `job` must not start now, because the scan it names is being deleted. */
export function jobIsForScanBeingDeleted(job: Pick<WorldJob, 'scanId' | 'payload'>): boolean {
  const filename = payloadFilename(job)
  if (everyScanBeingDeleted > 0) return job.scanId !== undefined || filename !== null
  return (job.scanId !== undefined && beingDeleted.has(job.scanId)) || (filename !== null && beingDeleted.has(filename))
}

/** What the pump records on a job it did not start because its scan is being deleted. */
export const SCAN_BEING_DELETED_NOTE = 'The scan is being deleted, so this job did not start.'
