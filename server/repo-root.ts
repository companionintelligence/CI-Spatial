/**
 * The repository root as a `file://` URL, for resolving paths that live outside
 * `server/` — `scripts/`, `public/models/`, `node_modules/`.
 *
 * Why this exists rather than each caller writing `new URL('../', import.meta.url)`:
 * that idiom encodes the caller's own depth, so it is silently wrong the moment
 * the file moves. It has already been wrong twice here — the whole
 * `tests/unit/` move broke two fixture readers, and PR #155 moved
 * `splat_finish.ts` from the repo root into `server/splat/`, which quietly
 * repointed its splat-transform fallback at `server/splat/node_modules/`. That
 * one degraded to "binary not found" instead of throwing, so nothing failed and
 * nothing noticed.
 *
 * Importers get the root regardless of their own nesting, because the depth is
 * stated once, here.
 */
export const REPO_ROOT = new URL('../', import.meta.url)
