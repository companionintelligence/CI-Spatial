/**
 * The one capture-session id vocabulary, shared verbatim by both runtimes.
 *
 * There used to be two. The client minted `session-${Date.now()}` once per
 * `DetectionStore` construction — i.e. once per browser tab — while the server
 * minted `sess-${Date.now()}-${Math.random()…}` in `POST /sessions`, and the
 * validating regex accepted *both* prefixes. Only the server ever created the
 * directory an id names, and it always used its own id, so every client-minted
 * id resolved to a plausible path that had never been created. Keyframe
 * lookups returned `[]` with a 200, and the job preflight that exists to catch
 * exactly this passed, because a non-empty string is truthy. See
 * docs/factory/07-scan-identity/0002-one-session-identity.md.
 *
 * Deno-API-free on purpose (ADR 0002): `main.ts`, the `DetectionStore` and the
 * GLB exporter all import this, so it cannot reach for `Deno` or for the DOM.
 * The existence-aware half lives in the root `session_id.ts`, which is
 * server-only because it stats the filesystem.
 */

/** Prefix of every server-minted capture-session id. */
export const SERVER_SESSION_PREFIX = 'sess-'

/** Prefix of a client-local id that has no server session behind it. */
export const LOCAL_SESSION_PREFIX = 'local-'

/**
 * A server-minted capture-session id, and nothing else.
 *
 * Deliberately narrow. It is also a path-safety guard — the id becomes a
 * directory name under `SESSIONS_DIR` — so it admits only `[a-z0-9-]`, which
 * rejects separators and `..` traversal by construction.
 *
 * Notably rejected:
 * - `session-1787174216556` — the retired client shape. `^sess-` needs a
 *   literal hyphen after `sess`, and this has an `i`. That is the cutover:
 *   an id that never named a real directory stops validating.
 * - `local-…` — a store id with no server session behind it, which must never
 *   be mistaken for one.
 */
export const SESSION_ID_RE = /^sess-[a-z0-9-]+$/

/** Whether `id` is a server-minted session id — the only kind that names a directory. */
export function isServerSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

/**
 * A fresh client-local session id.
 *
 * `DetectionStore` needs an IndexedDB key the moment it is constructed, long
 * before (and possibly without ever) opening a server session. This shape is
 * deliberately one that {@link SESSION_ID_RE} rejects, so a local id can never
 * be sent to the server as a session reference or mistaken for one on the way
 * back. Uses `crypto.randomUUID()` per the repo's id house style — the two
 * session ids were the only ids that did not, and were themselves the defect.
 */
export function newLocalSessionId(): string {
  return `${LOCAL_SESSION_PREFIX}${crypto.randomUUID()}`
}

/**
 * A fresh server-minted capture-session id. Called only by `POST /sessions`,
 * which is the single minting site.
 */
export function newServerSessionId(): string {
  return `${SERVER_SESSION_PREFIX}${crypto.randomUUID()}`
}
