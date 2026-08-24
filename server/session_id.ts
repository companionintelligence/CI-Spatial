/**
 * Server-side capture-session path resolution.
 *
 * The id *vocabulary* lives in `src/shared/session-id.ts` so both runtimes
 * share one regex (ADR 0002 — that file must stay Deno-API-free). This module
 * is the half that touches the filesystem, and it exists separately from
 * `main.ts` for the same reason `world_prune.ts`, `scan_index.ts` and
 * `world_lock.ts` do: `main.ts` cannot be imported by a test without running
 * its unconditional top-level side effects (hostname resolution, VLM engine
 * load, `Deno.serve`).
 *
 * Two resolvers, deliberately:
 *
 * - {@link sessionDirPath} is a *shape* test. Cheap and synchronous — the right
 *   one for a route that immediately stats or reads the directory anyway, where
 *   a second existence check would just duplicate the first.
 * - {@link resolveSessionDir} additionally proves the directory *exists*. The
 *   right one wherever a missing directory would otherwise be indistinguishable
 *   from an empty one — which is the bug this ticket exists to remove: a
 *   well-formed id that was never created read as "this session has no
 *   keyframes" all the way through preflight.
 *
 * See docs/factory/07-scan-identity/0002-one-session-identity.md.
 */
import { SESSION_ID_RE } from '../src/shared/session-id.ts'

export { isServerSessionId, newServerSessionId, SESSION_ID_RE } from '../src/shared/session-id.ts'

/**
 * The directory `id` would name under `sessionsDir`, or `null` when `id` is not
 * a well-formed server session id. Says nothing about whether it exists.
 */
export function sessionDirPath(sessionsDir: string, id: string | null | undefined): string | null {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null
  return `${sessionsDir}/${id}`
}

/**
 * The directory `id` names, only when it is well-formed **and** present on
 * disk. `null` otherwise — the two failures are not distinguished here because
 * every caller treats them the same way; callers that need to *report* which
 * one it was pair this with {@link sessionDirPath}.
 */
export async function resolveSessionDir(
  sessionsDir: string,
  id: string | null | undefined,
): Promise<string | null> {
  const dir = sessionDirPath(sessionsDir, id)
  if (!dir) return null
  try {
    const stat = await Deno.stat(dir)
    return stat.isDirectory ? dir : null
  } catch {
    return null
  }
}
