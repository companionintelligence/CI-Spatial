/**
 * The service worker's queued-offline response contract.
 *
 * When the network is unreachable, `public/sw.js` does not fail a queueable
 * write — it stores the request in the offline queue and synthesizes a
 * response so the page can carry on. That response is `202 Accepted`, and 202
 * is inside the 2xx range, so `resp.ok` is **true** for it.
 *
 * Every caller in this app checked exactly `resp.ok`, and a grep for `202` or
 * `queuedOffline` across `src/` returned nothing — so a request that had only
 * been *queued* was read as *delivered*, everywhere:
 *
 *   - `KeyframeStreamer` counted queued frames as sent and never set
 *     `_offlineUntil`, so the offline path switched off its own backpressure
 *     and kept encoding a full-resolution JPEG every 1.2 s into an
 *     ever-growing IndexedDB queue.
 *   - `exportToGLB`'s uploader took the success branch and destructured a
 *     `filename` that isn't in a queued response, so an upload that queued
 *     perfectly well was reported to the user as a failed server sync.
 *   - `KeyframeStreamer.start()` accepted a queued `POST /sessions`, read
 *     `sessionId` as `undefined`, and reported "streaming" while discarding
 *     every frame it then encoded.
 *
 * The service worker has always set the header below (`sw.js`, in
 * `networkOrQueue()`); nothing read it. This module is the one declaration of
 * that contract, per ADR 0001. `public/sw.js` is a classic script and cannot
 * import it, so it keeps its own literal plus a pointer comment, and
 * `sync.test.ts` asserts the two have not drifted — the same arrangement used
 * for the cache name, queue DB name, and Background Sync tag in
 * `./storage-keys.ts`.
 */

/**
 * Response header the service worker sets, with the value `'1'`, when it has
 * queued a write instead of delivering it. Must stay byte-identical to the
 * literal in `public/sw.js`.
 */
export const QUEUED_OFFLINE_HEADER = 'X-Companion-Queued-Offline'

/**
 * True when this response came from the offline queue rather than the server.
 *
 * Treat it as "not delivered yet": the request is durably stored and will be
 * replayed when connectivity returns, but nothing has reached the server, so
 * no server-assigned value (a `sessionId`, a saved `filename`) exists to read.
 */
export function isQueuedOffline(resp: Response): boolean {
  return resp.headers.get(QUEUED_OFFLINE_HEADER) === '1'
}
