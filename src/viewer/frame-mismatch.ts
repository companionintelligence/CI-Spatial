/**
 * A merge or a scan reassign the server refused because the two Places have different references (WP-08).
 *
 * Merging a Place into another, or moving a scan to another Place, used to re-point the scans and say nothing: a scan
 * measured against one Place's reference was read as if it were in the other's, and the scan's manual alignment went
 * with the Place it left. The server now answers 409 `{ code: 'frame-mismatch', error }` unless the two references
 * match or the request says `acceptFrameMismatch`. The Places panel (./places.ts) shows the server's sentence, asks, and
 * sends the request again with that flag only when the person says go on.
 *
 * The 409 is a refusal a person has to see: it is never retried by the service worker (it drops a queued body on any 4xx
 * outside 401, 403, 408 and 429), so these two writes are sent with the opt-out header and are not queued at all.
 */
import { readFrameMismatch } from '../world/frame-replacement.ts'

/** The sentence when the server's refusal carries none. */
export const FRAME_MISMATCH_FALLBACK = 'These Places have different references, so their scans would not line up.'

/**
 * What the Places panel says when a merge or a move did not reach the server. They are sent with the opt-out header, so a
 * service worker does not queue them and replay them later without the person who decided on them (it would drop the
 * server's refusal of a replayed one): offline, they have to be done again. The words are those of the picker's own
 * (`PLACE_NEEDS_CONNECTION`, src/project/frame-sync.ts).
 */
export const MERGE_NEEDS_CONNECTION = 'Merging Places needs a connection'
export const ASSIGN_NEEDS_CONNECTION = 'Moving a scan needs a connection'

/**
 * What the Places panel asks when the server refused a merge or a move for different references: the server's sentence, then what
 * going on does and does not do. Neither moves the scans to match the Place they join: they stay where the reference they were
 * measured against put them, and the editor lists them as measured against another reference.
 */
export function mergeQuestion(serverSentence: string): string {
  return `${serverSentence}\n\nMerge anyway? The scans of the merged Place are not moved to match this Place's reference.`
}

export function assignQuestion(serverSentence: string): string {
  return `${serverSentence}\n\nAssign anyway? The scan is not moved to match this Place's reference.`
}

/** The server's sentence when `response` is the frame-mismatch refusal, else null. The response is left readable. */
export async function frameMismatchMessage(response: Response): Promise<string | null> {
  if (response.status !== 409) return null
  const body: unknown = await response.clone().json().catch(() => null)
  return readFrameMismatch(response.status, body, FRAME_MISMATCH_FALLBACK)?.message ?? null
}

/** The answer to a request, or null when it never got one: the network was down, or the request was given up on. */
async function answerOf(send: () => Promise<Response>): Promise<Response | null> {
  try {
    return await send()
  } catch {
    return null
  }
}

/**
 * Sends a request, and when the server refuses it for different references, asks the person with the server's sentence
 * and sends it again with `acceptFrameMismatch` if they say go on. Returns the answer to the request that counts: the
 * refusal when they say no, or the retry's. Null when a request was never answered, so the caller can say that it needs a
 * connection and not leave the person looking at a button that did nothing.
 */
export async function sendUnlessReferencesDiffer(
  send: (acceptFrameMismatch: boolean) => Promise<Response>,
  ask: (message: string) => boolean,
): Promise<Response | null> {
  const first = await answerOf(() => send(false))
  if (first === null) return null
  const message = await frameMismatchMessage(first)
  if (message === null || !ask(message)) return first
  return answerOf(() => send(true))
}
