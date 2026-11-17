/**
 * The six `WorldJobType`s that have no worker, and what a completed one honestly says.
 *
 * `ingest`, `extract-layers`, `align-scan`, `merge-points`, `semantic-pass` and
 * `depth-reconstruct` complete through the pump's shared placeholder path
 * (`_dispatchWorldJob` in server/main.ts, ADR 0003 "Placeholder WorldJobTypes"): a 650 ms
 * sleep, an input check, a result sentence and a report artifact. Nothing is computed and no
 * scan is changed: `applyCompletedJobToWorld` writes no status for any of the six. Until this
 * module those sentences said otherwise ("Alignment recorded from current world transform",
 * "Layer index is available from ..."), the editor's job list showed only `completed`, and
 * `align-scan` also stamped the scan `'aligned'`, so a user who pressed Prepare saw a green
 * outcome for a step that did nothing. See docs/product/UX_FLOW.md, "Planned-vs-real".
 *
 * Every sentence here starts with `No-op:` and names what was not done. The editor prints a
 * job's result in its job list (src/viewer/job-row.ts), so this is the line a person reads.
 *
 * A job type belongs in this list exactly while `_dispatchWorldJob` has no runner for it.
 * tests/unit/node/honest_placeholders.test.ts reads `_dispatchWorldJob` and fails the day a
 * runner is added for one of these (the sentence would then be false) or a new type reaches
 * the placeholder path without being listed.
 *
 * ## Jobs an older build already completed
 *
 * Every world on disk holds jobs that an older build completed with one of the old sentences,
 * and nothing printed them until the job list started to. So the old sentences would appear,
 * under their `completed`, in the job list of every existing install. {@link honestPlaceholderText}
 * names the text a stored placeholder job should carry in their place. The server applies it to every
 * job when it reads a world ({@link healPlaceholderJobs}, called from `refreshWorldScans`), which also
 * corrects what the API serves, and the job list applies it again when it draws, for an editor that talks
 * to a server that does not yet. A job the placeholder path did not complete (queued, running, a real
 * job's result) is never touched.
 *
 * Lives in src/shared, not server/, because the editor imports it too: ADR 0002.
 */
import type { WorldJob, WorldJobType } from '../world/types.ts'

export type PlaceholderJobType =
  | 'ingest'
  | 'extract-layers'
  | 'align-scan'
  | 'merge-points'
  | 'semantic-pass'
  | 'depth-reconstruct'

/** The prefix every placeholder result carries. */
export const NO_OP_PREFIX = 'No-op:'

const PLACEHOLDER_JOB_RESULTS: Record<PlaceholderJobType, string> = {
  ingest:
    `${NO_OP_PREFIX} nothing was ingested. A scan is listed and its layers are read from its files when the Place loads.`,
  'extract-layers':
    `${NO_OP_PREFIX} no layers were extracted. The layer list is read from the scan's own files when the Place loads.`,
  'align-scan':
    `${NO_OP_PREFIX} no alignment was computed and no scan was moved. A calibrated scan keeps the place its calibration gave it. To move a scan, drag it in the editor and save.`,
  'merge-points': `${NO_OP_PREFIX} no points were merged. This job has no worker yet.`,
  'semantic-pass': `${NO_OP_PREFIX} no semantic pass ran. This job has no worker yet.`,
  'depth-reconstruct':
    `${NO_OP_PREFIX} no depth was reconstructed. It only checked that the scan has a keyframe session.`,
}

/** The job types with no worker, in the order the editor lists them. */
export const PLACEHOLDER_JOB_TYPES = Object.keys(PLACEHOLDER_JOB_RESULTS) as PlaceholderJobType[]

export function isPlaceholderJobType(type: WorldJobType): type is PlaceholderJobType {
  return Object.hasOwn(PLACEHOLDER_JOB_RESULTS, type)
}

/** The result a completed placeholder job carries. Always starts with {@link NO_OP_PREFIX}. */
export function placeholderJobResult(type: PlaceholderJobType): string {
  return PLACEHOLDER_JOB_RESULTS[type]
}

/** What an `align-scan` fails with when the Place has fewer than two scans (`jobFailureReason`, server/main.ts). */
export const ALIGN_SCAN_NEEDS_TWO_SCANS = 'align-scan needs at least two scans in the world.'

/**
 * The same failure as an older build wrote it. It went on to offer "a manual control-point target", an input no
 * screen or route has ever had, and it is in the job history of every world where Prepare was pressed with one scan.
 */
const LEGACY_ALIGN_SCAN_FAILURE = 'align-scan needs at least two scans in the world or a manual control-point target.'

/** The fields of a stored job that {@link honestPlaceholderText} reads. */
export type PlaceholderJobFields = Pick<WorldJob, 'type' | 'status' | 'result' | 'error'>

/** The text to put in place of what a stored job holds. A key is present only for a field that changes. */
export interface PlaceholderTextFix {
  result?: string
  error?: string
}

/**
 * What a stored placeholder job should say instead of what it says, or `null` when it holds nothing false.
 *
 *  - Completed: its result is the `No-op:` sentence for its type, unless it already starts with the prefix. Whatever
 *    else a completed placeholder holds was written by an older build, which claimed an outcome the job never had.
 *    A completed job with no result at all gets the sentence too: it did nothing, and says so.
 *  - Failed `align-scan`: the older failure text is replaced by the current one. Every other failure of these types
 *    ("requires a selected scan", "requires RGB keyframe observations") was and is true, and is left alone.
 *  - A job of any other type, and a job that is queued or running: `null`.
 */
export function honestPlaceholderText(job: PlaceholderJobFields): PlaceholderTextFix | null {
  if (!isPlaceholderJobType(job.type)) return null
  if (job.status === 'completed') {
    return typeof job.result === 'string' && job.result.startsWith(NO_OP_PREFIX)
      ? null
      : { result: placeholderJobResult(job.type) }
  }
  if (job.status === 'failed' && job.type === 'align-scan') {
    const fix: PlaceholderTextFix = {}
    if (job.result === LEGACY_ALIGN_SCAN_FAILURE) fix.result = ALIGN_SCAN_NEEDS_TWO_SCANS
    if (job.error === LEGACY_ALIGN_SCAN_FAILURE) fix.error = ALIGN_SCAN_NEEDS_TWO_SCANS
    return fix.result !== undefined || fix.error !== undefined ? fix : null
  }
  return null
}

/**
 * Corrects, in place, every job in a stored world that holds a claim an older build wrote, and says whether it changed
 * any, so the caller knows to write the world back. Idempotent: what it has corrected it finds honest the next time.
 */
export function healPlaceholderJobs(jobs: readonly WorldJob[]): boolean {
  let changed = false
  for (const job of jobs) {
    const fix = honestPlaceholderText(job)
    if (fix) {
      Object.assign(job, fix)
      changed = true
    }
  }
  return changed
}

/**
 * The one sentence the editor's job list prints under a job: its result, else its failure, as
 * {@link honestPlaceholderText} would correct them. Empty when the job has said nothing yet.
 */
export function jobOutcomeText(job: PlaceholderJobFields): string {
  const fix = honestPlaceholderText(job)
  return (fix?.result ?? job.result)?.trim() || (fix?.error ?? job.error)?.trim() || ''
}
