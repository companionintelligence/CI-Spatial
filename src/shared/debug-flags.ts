/**
 * Debug flags — the `?debug=` query parameter, parsed as a comma-separated
 * token list.
 *
 * `?debug=remote` (console mirroring, src/debug/remote-log.ts) was the first
 * and for a long time only flag, and was read with an exact string equality
 * check. That made flags mutually exclusive: `?debug=remote,pose` armed
 * neither. A benchmark run wants both at once — the on-screen pose readout to
 * read numbers off, and console mirroring so the box records them — so the
 * value is a token list instead.
 *
 * Backward compatible by construction: `?debug=remote` is a one-token list
 * containing 'remote', so every existing URL and QR code keeps working.
 *
 * Tokens are trimmed and compared case-insensitively; empty tokens are
 * ignored, so `?debug=`, `?debug=,` and a missing param all read as no flags.
 */

/** Known flags, listed so a typo in a call site is a compile error. */
export type DebugFlag =
  /** Mirror console output to the dev server (src/debug/remote-log.ts). */
  | 'remote'
  /** Show the live camera-pose / drift readout in the scanner HUD. */
  | 'pose'
  /**
   * Widen the remote mirror to console.log as well as warn/error. Off by
   * default because the scanner tick logs several times a second and would
   * evict everything else from the 50-entry buffer.
   */
  | 'verbose'

/**
 * True when `flag` appears in the current page's `?debug=` token list.
 *
 * `search` is injectable so this stays a pure function for tests; it defaults
 * to the live location, and returns false rather than throwing in any context
 * where `location` is unavailable.
 */
export function hasDebugFlag(flag: DebugFlag, search?: string): boolean {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  return parseDebugFlags(raw).includes(flag)
}

/** Normalised, lower-cased, non-empty tokens from a `?debug=` value. */
export function parseDebugFlags(search: string): string[] {
  let value: string | null = null
  try {
    value = new URLSearchParams(search).get('debug')
  } catch {
    return []
  }
  if (!value) return []
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
}
