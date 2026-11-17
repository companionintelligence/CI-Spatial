/**
 * One row of the editor's job list (`renderJobs` in src/viewer/viewer.ts).
 *
 * Pure, and kept out of viewer.ts, so that what the row prints and what it escapes can be run in a test instead
 * of read as source. The row shows the job's type, its status and scan, and its own outcome sentence: the result,
 * or for a job that failed the reason. That sentence is what keeps a job with no worker from reading as work
 * done: it says "No-op: ..." (src/shared/placeholder-jobs.ts), and for a job an older build completed with a claim
 * it says what the job really did, whatever the stored text is.
 *
 * Every piece of text goes through `escape`, the viewer's own HTML escape: a job's result and error can carry
 * a file name or a model's words, and the whole sentence is also the row's tooltip, inside an attribute.
 */
import { jobOutcomeText, type PlaceholderJobFields } from '../shared/placeholder-jobs.ts'

/** The fields of a job the row reads. */
export type JobRowJob = PlaceholderJobFields

export function jobRowMarkup(
  job: JobRowJob,
  scanName: string | null | undefined,
  timeLabel: string,
  escape: (text: string) => string,
): string {
  const outcome = jobOutcomeText(job)
  return `
      <div style="min-width:0;">
        <div class="job-title">${escape(job.type)}</div>
        <div class="job-meta">${escape(job.status)}${scanName ? ` · ${escape(scanName)}` : ''}</div>
        ${outcome ? `<div class="job-meta job-result" title="${escape(outcome)}">${escape(outcome)}</div>` : ''}
      </div>
      <span class="job-meta">${escape(timeLabel)}</span>
    `
}
