/**
 * Asking the server what is tied to a Place's reference: `GET /projects/:id/frame-status` (WP-08).
 *
 * The scanner asks before it lets a person replace a Place's reference, so the confirmation can say how many scans
 * were made against the one being replaced. The answer is read by `readFrameStatus` (../world/frame-replacement.ts),
 * the one place that knows its shape. The request is a read: the service worker lets every `/projects` GET through
 * to the network (`API_PREFIXES` in public/sw.js), so the count is never an old one from a cache.
 *
 * Never throws. A status that could not be read, for any reason, is `null`, and the confirmation says it could
 * not check: it never reads a failure as "no scans".
 */
import { readFrameStatus, type ReferenceStatus } from '../world/frame-replacement.ts'
import { isQueuedOffline } from '../shared/offline-queue.ts'
import { browserFrameSyncEnv, fetchWithin, type FrameSyncEnv } from './frame-sync.ts'

/**
 * Longest the confirmation waits for the count, in ms. Adopted, not measured (ADR 0005 rule 5): a person is
 * looking at a screen that says it is checking, which is a shorter wait to tolerate than the
 * `FRAME_REQUEST_TIMEOUT_MS` a frame or a photo is given. Past it the confirmation goes on without a count.
 */
export const FRAME_STATUS_TIMEOUT_MS = 8_000

/** What the server says of one Place's reference and the scans made against it, or null when it cannot be read. */
export async function fetchFrameStatus(
  projectId: string,
  env: FrameSyncEnv = browserFrameSyncEnv(),
): Promise<ReferenceStatus | null> {
  try {
    const response = await fetchWithin(
      { ...env, requestTimeoutMs: Math.min(env.requestTimeoutMs ?? FRAME_STATUS_TIMEOUT_MS, FRAME_STATUS_TIMEOUT_MS) },
      env.url(`/projects/${encodeURIComponent(projectId)}/frame-status`),
      {},
    )
    if (!response.ok || isQueuedOffline(response)) return null
    return readFrameStatus(await response.json())
  } catch {
    return null
  }
}
