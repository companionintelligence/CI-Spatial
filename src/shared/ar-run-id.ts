/**
 * The id of one AR run: one start of the AR runtime, which is one SLAM frame.
 *
 * Every page load starts a new run, and so does any restart of the tracker that gives the session a
 * new origin. A position saved under one run means nothing under another, so the scene store stamps
 * the id on every detection and every capture it writes (`arRunId`), and asks it back before it
 * shows or exports a stored position. See `DetectionStore.currentRunDetections`.
 *
 * Deno-API-free on purpose (ADR 0002): the browser imports it, and the server may one day compare
 * ids. Like the other ids here (src/shared/session-id.ts) it comes from `crypto.randomUUID()`. Old
 * webviews have no `randomUUID`, so there it is the time plus random bytes: a different shape, the
 * same job, because the id is only ever compared for equality.
 *
 * An id never contains a dot. A scan that is begun again after the runtime redefined its origin appends the
 * epoch to it (`<arRunId>.<epoch>`: `arRunIdAtEpoch` below), and the dot has to stay the separator.
 */

/** The two members of `Crypto` this file uses, so a test can hand in a stand-in for an old webview's. */
export type RunIdRandomSource = Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>

/** `bytes` random bytes as lowercase hex. Without `getRandomValues` it falls back to `Math.random`. */
function randomHex(source: RunIdRandomSource | undefined, bytes: number): string {
  const buffer = new Uint8Array(bytes)
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(buffer)
  } else {
    for (let i = 0; i < bytes; i++) buffer[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A fresh AR-run id.
 *
 * `source` is the page's `crypto` unless a caller passes another. A page without it
 * (`typeof crypto === 'undefined'`) gets the fallback.
 */
export function newArRunId(
  source: RunIdRandomSource | undefined = typeof crypto === 'undefined' ? undefined : crypto,
): string {
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  return `${Date.now().toString(36)}-${randomHex(source, 8)}`
}

/**
 * The id of the same run as of one frame epoch: `<arRunId>.<epoch>`.
 *
 * A run is one start of the AR runtime, and the runtime may redefine its origin partway through it (a
 * relocalization, a resume: src/ar/frame-epoch.ts). A scan that is begun again after such a break, set against the
 * Place's frame once more, is a new frame inside the same run, so what it stores is stamped with the run and the epoch
 * it began in. The first epoch of a run carries no suffix, which is why `epoch` 0 gives the id back unchanged, and an
 * id that already has an epoch has it replaced, never a second one added. A suffix that is not a whole number of at
 * least 1 is no epoch, and the id comes back as it was.
 */
export function arRunIdAtEpoch(arRunId: string, epoch: number): string {
  const { run } = splitArRunId(arRunId)
  if (!Number.isInteger(epoch) || epoch < 1) return run
  return `${run}.${epoch}`
}

/**
 * An id taken apart: the run (everything before the first dot, which an id never contains) and the epoch the suffix
 * names, or null when there is none or it is not a whole number of at least 1. An id from before epochs were
 * appended splits as itself and null.
 */
export function splitArRunId(id: string): { run: string; epoch: number | null } {
  const dot = id.indexOf('.')
  if (dot < 0) return { run: id, epoch: null }
  const suffix = id.slice(dot + 1)
  const epoch = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : null
  return { run: id.slice(0, dot), epoch: epoch !== null && Number.isSafeInteger(epoch) ? epoch : null }
}
