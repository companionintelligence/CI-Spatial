/**
 * Server-side take vocabulary.
 *
 * The id *vocabulary* lives in `src/shared/take-id.ts` so both runtimes share
 * one regex (ADR 0002 — that file must stay Deno-API-free). This module is the
 * server half, and it exists separately from `main.ts` for the same reason
 * `session_id.ts`, `scan_index.ts` and `world_lock.ts` do: `main.ts` cannot be
 * imported by a test without running its unconditional top-level side effects
 * (hostname resolution, VLM engine load, `Deno.serve`).
 *
 * Note the asymmetry with `session_id.ts`: that module has a filesystem half
 * because a session id names a directory. A take id never does — a take is the
 * *derived* set of sessions sharing the id — so there is nothing here to stat.
 * The grouping lives in `scan_index.ts`, folded into the single sweep it
 * already performs.
 */
export {
  isClientId,
  isTakeId,
  newClientId,
  newTakeId,
  TAKE_ID_RE,
  TAKE_PREFIX,
} from '../src/shared/take-id.ts'
