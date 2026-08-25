/**
 * The take id vocabulary, shared verbatim by both runtimes.
 *
 * A **take** is N simultaneous captures of one subject — several phones
 * recording the same person at the same moment. It is deliberately *not* a
 * stored aggregate: a take is the set of capture sessions whose `session.json`
 * carries the same `takeId`. That keeps one identity system rather than two,
 * and means a take inherits the session directory's existing durability,
 * pruning and crash behaviour for free.
 *
 * Deno-API-free on purpose (ADR 0002): both `server/main.ts` and browser code
 * import this, so it can reach for neither `Deno` nor the DOM. Unlike
 * `session-id.ts` there is no filesystem-aware half — a take never names a
 * directory, precisely because it is derived rather than stored.
 *
 * See docs/factory/10-4d-person-capture/0001-take-model-and-multi-client-rooms.md.
 */

/** Prefix of every take id. */
export const TAKE_PREFIX = 'take-'

/**
 * A take id, and nothing else.
 *
 * Narrow for the same reason `SESSION_ID_RE` is: a take id is echoed into
 * signalling room names and into `session.json`, so it admits only
 * `[A-Za-z0-9_-]`, which rejects path separators and `..` by construction.
 * The length bound mirrors `PROJECT_ID_RE` in `server/project_media.ts`.
 */
export const TAKE_ID_RE = /^take-[A-Za-z0-9_-]{1,64}$/

/**
 * Whether `id` is a well-formed take id.
 *
 * Takes `unknown` rather than `string | null | undefined` because every caller
 * applies it to parsed JSON from a request body or an on-disk record, where the
 * field is genuinely of unknown type. Narrowing at the guard is the point.
 */
export function isTakeId(id: unknown): id is string {
  return typeof id === 'string' && TAKE_ID_RE.test(id)
}

/**
 * A fresh take id.
 *
 * Uses `crypto.randomUUID()` per the repo's id house style — the two session
 * ids were the only ids that did not, and were themselves the defect that
 * `docs/factory/07-scan-identity/0002-one-session-identity.md` fixed.
 */
export function newTakeId(): string {
  return `${TAKE_PREFIX}${crypto.randomUUID()}`
}

/**
 * A stable per-device id within a take.
 *
 * Distinct from the take id because a device that drops and reconnects must be
 * recognised as the *same* member rather than doubling the roster. Callers
 * persist this for the lifetime of a capture session.
 */
export function newClientId(): string {
  return `client-${crypto.randomUUID()}`
}

/** Whether `id` is a well-formed client id. Accepts `unknown` for the same reason {@link isTakeId} does. */
export function isClientId(id: unknown): id is string {
  return typeof id === 'string' && /^client-[A-Za-z0-9_-]{1,64}$/.test(id)
}
