/**
 * Where a capture session's numbering resumes.
 *
 * A capture's record id is its session id, a `-c` and its index (see
 * DetectionStore.captureIdFor), and putCapture() replaces whatever record already
 * holds that id. A session that is resumed, loaded or adopted must therefore count
 * on from its highest stored index. Counting from 0 let the first capture after a
 * reload take an index that was already stored, so its frame replaced the old one.
 *
 * It reads each record's own sessionId and captureIndex, not its id: adopting a
 * server session moves a record to the new sessionId and keeps the id it was made
 * with, so the id would not say which session the record belongs to now.
 *
 * Pure and DOM-free, so the node tests can import it directly.
 */

/** The two fields of a stored capture this rule reads. A CaptureRecord has both. */
export interface StoredCaptureIndex {
  sessionId: string
  captureIndex: number
}

/**
 * The highest capture index stored for `sessionId`, or 0 when it holds none.
 *
 * Captures of other sessions are ignored. With no live session (an empty id)
 * the answer is 0, so the next capture starts a new session at 1.
 */
export function highestCaptureIndex(captures: Iterable<StoredCaptureIndex>, sessionId: string): number {
  if (!sessionId) return 0
  let highest = 0
  for (const capture of captures) {
    if (capture.sessionId === sessionId && capture.captureIndex > highest) highest = capture.captureIndex
  }
  return highest
}

/**
 * The capture counter once the live session may have changed: a Clear, a delete, a
 * load, or a remote erase or rename.
 *
 * `current` is the counter, and `counted` the session it has been counting for. The same
 * session keeps the larger of the counter and its stored highest index. A Clear empties
 * the store but keeps the session, so the stored captures alone would hand out an index
 * that a capture still being analysed holds, and that analysis would then write onto the
 * new record.
 *
 * A different session takes the larger of its stored highest index and the counter it
 * was left at (`left`, keyed by session id). A session loaded back therefore never reuses
 * an index it issued before, even if a Clear removed its records in between.
 */
export function captureCountFor(
  live: string,
  counted: string,
  current: number,
  captures: Iterable<StoredCaptureIndex>,
  left: ReadonlyMap<string, number>,
): number {
  const stored = highestCaptureIndex(captures, live)
  if (live === counted) return Math.max(current, stored)
  return Math.max(stored, left.get(live) ?? 0)
}

/** The fields of a stored capture that tell one capture from another. A CaptureRecord has all of them. */
export interface CaptureIdentity extends StoredCaptureIndex {
  captureId: string
  timestamp: number
}

/**
 * Whether the record now held under a capture's id is the record that capture made, so a
 * write that follows the capture's analysis may go ahead. This is record identity only: the
 * live session is not part of it (isSameCapture adds that for the write into the scan).
 *
 * Two things pass. The same record object. Or a record with the same captureId and timestamp.
 * Adopting a server session re-keys a record by copying it under the new sessionId, so the
 * copy keeps the id and the timestamp but not the sessionId the capture was made with. A
 * different record that takes the old id, a capture numbered again after a Clear, has its own
 * timestamp and does not pass.
 *
 * A load of another session moves the live scan on, but the record the capture made stays in
 * the store under its own session, and the analysis still has to settle it. Nothing passes
 * when either side is missing.
 */
export function isSameRecord(
  current: CaptureIdentity | undefined,
  captured: CaptureIdentity | undefined,
): boolean {
  if (!current || !captured) return false
  return current === captured || (current.captureId === captured.captureId && current.timestamp === captured.timestamp)
}

/**
 * Whether a capture's detections may be written into the live scan: the record must still be
 * the one the capture made (isSameRecord), and it must belong to the live session. A record of
 * another session never passes, because a load has moved the live scan on and these detections
 * do not belong to it. Nothing passes when there is no live session.
 */
export function isSameCapture(
  current: CaptureIdentity | undefined,
  captured: CaptureIdentity | undefined,
  liveSessionId: string,
): boolean {
  if (!liveSessionId || !current || current.sessionId !== liveSessionId) return false
  return isSameRecord(current, captured)
}
