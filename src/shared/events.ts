import type { JobStatus } from '../../server/jobs.ts'
import type { WorldJob } from '../world/types.ts'

/**
 * `/events` WebSocket message-type constants — the wire protocol for the
 * server's live broadcast stream (see `main.ts`'s `broadcast()`/`/events`
 * upgrade handler).
 *
 * String VALUES here are the frozen wire protocol: byte-identical to what
 * producers have always sent. This file only centralizes *where* each
 * literal is declared — not what it says on the wire. If you need a new
 * event type, add it here first, then reference `EVENT.XXX` from the
 * producer/consumer — never re-introduce a raw string literal.
 *
 * Runtime-agnostic: imported by Deno (`main.ts`) and the Vite/browser bundle
 * (`src/viewer/viewer.ts`), following the `src/shared/` precedent
 * (`cv-palette.ts`, `test-homes.ts`).
 *
 * The two job systems named below have been merged
 * (docs/adr/0003-merged-job-system.md, docs/factory/01-merge-jobs/):
 * `WorldJob` (`main.ts`) was the designated survivor, and `JobQueue`
 * (`jobs.ts`) was ported onto it and retired (ticket 0005) — the class no
 * longer exists. `JOB_UPDATE` is now produced solely by `main.ts`
 * (`broadcastLegacyJobUpdate`, ticket 0004) for `optimize-scan` `WorldJob`
 * transitions, translated through `worldJobToLegacyJob` so the payload shape
 * stays byte-identical to `JobQueue`'s original `_emit()` — kept as a
 * distinct event (not folded into `WORLD_JOB_UPDATE`) because
 * `src/viewer/viewer.ts`'s existing `'job-update'` consumer still expects
 * this exact shape, scoped to `optimize-scan` only. `WORLD_JOB_UPDATE` comes
 * from the `WorldJob` system in `main.ts` (ingest / lingbot-map-reconstruct /
 * splat-train / splat-detect / splat-finish / memory-push / optimize-scan).
 */

export const EVENT = {
  /**
   * Producer: `main.ts` (1 site — remote-phone console log ingest).
   * Consumer: `scripts/logs-watch.mjs` (pretty-prints entries for
   * `?debug=remote` sessions). No in-repo (`src/`) listener — the viewer's
   * `/events` handler does not branch on this type.
   */
  CLIENT_LOG: 'client-log',

  /**
   * Producer: `main.ts` (1 site — a scan file finished uploading).
   * Consumer: `src/viewer/viewer.ts` (`connectServerEvents` — schedules a
   * world refresh).
   */
  SCAN_ADDED: 'scan-added',

  /**
   * Producer: `main.ts` (1 site — a scan was deleted).
   * No in-repo listener today; kept for external/future consumers — do not
   * remove.
   */
  SCAN_DELETED: 'scan-deleted',

  /**
   * Producer: `main.ts` (1 site — all scans were cleared).
   * No in-repo listener today; kept for external/future consumers — do not
   * remove.
   */
  SCANS_CLEARED: 'scans-cleared',

  /**
   * Producer: `main.ts` (1 site — a capture session began).
   * No in-repo listener today; kept for external/future consumers — do not
   * remove.
   */
  SESSION_STARTED: 'session-started',

  /**
   * Producer: `main.ts` (1 site — a capture session finished processing).
   * Consumer: `src/viewer/viewer.ts` (`connectServerEvents` — schedules a
   * world refresh).
   */
  SESSION_FINALIZED: 'session-finalized',

  /**
   * Producer: `main.ts` (1 site — a video capture finished ingesting).
   * No in-repo listener today; kept for external/future consumers — do not
   * remove.
   */
  VIDEO_INGESTED: 'video-ingested',

  /**
   * Producer: `main.ts` (1 site — a photo-set capture finished ingesting).
   * No in-repo listener today; kept for external/future consumers — do not
   * remove.
   */
  PHOTOS_INGESTED: 'photos-ingested',

  /**
   * Producer: `main.ts` (19 sites — the `WorldJob` system: ingest,
   * lingbot-map-reconstruct, splat-train/detect/finish, memory-push).
   * Consumer: `src/viewer/viewer.ts` (`connectServerEvents` — refreshes the
   * LingBot-Map / splat-layer / splat-detect panels on completion).
   *
   * Not the same event as `JOB_UPDATE` below — see file-header note.
   */
  WORLD_JOB_UPDATE: 'world-job-update',

  /**
   * Producer: `main.ts` (`broadcastLegacyJobUpdate`, since ticket
   * 01-merge-jobs/0004) — fires for `optimize-scan` `WorldJob` transitions,
   * translated through `worldJobToLegacyJob` so the payload shape stays
   * byte-identical to the retired `JobQueue`'s original `_emit()`
   * (`jobs.ts`, before ticket 01-merge-jobs/0005 retired the class — see
   * file-header note). No other producer remains: `JobQueue` itself no
   * longer exists, so this event now comes from exactly one site.
   * Consumer: `src/viewer/viewer.ts` (`connectServerEvents` → `handleJobUpdate`).
   *
   * Not the same event as `WORLD_JOB_UPDATE` above — see file-header note.
   */
  JOB_UPDATE: 'job-update',
} as const

export type EventType = typeof EVENT[keyof typeof EVENT]

// ── Payload shapes (docs/factory/02-typed-event-payloads/0001) ───────────────
//
// `EventPayload` is the discriminated union (discriminant: `type`) of every
// shape a `broadcast()` call site in `main.ts` sends today. It exists so
// `broadcast()` can be typed as `broadcast(payload: EventPayload): void`
// instead of `broadcast(event: Record<string, unknown>): void` — the same
// function body (`main.ts:228-235`: spread the payload, stamp `at: Date.now()`,
// `JSON.stringify`, fan out to `eventSockets`) stays byte-identical; only the
// parameter type changes, so a call site with a missing/misspelled/mistyped
// field fails at the `broadcast()` call, not only where a consumer reads it.
// That's ticket 0002's mechanical implementation — this file only specifies
// the type. Landing the real declarations here (not as prose first) is this
// design ticket's own explicit call (0001 Subtask 3): the shapes are cheap
// enough that writing them twice would just be duplication for its own sake.
//
// Every wire VALUE below is a transcription of what `main.ts` already sends
// (grepped post-`01-merge-jobs`) — none were changed or redesigned to produce
// this union; see the per-member call-site citations.

/**
 * The `job` field of a `'job-update'` broadcast (`main.ts`'s
 * `broadcastLegacyJobUpdate`, `main.ts:2183-2197`) — deliberately **not** the
 * `Job` interface (`server/jobs.ts`). `worldJobToLegacyJob()` first produces a
 * real `Job` (field `type`, optional `error`/`note`), but
 * `broadcastLegacyJobUpdate` then re-shapes *that* one more time before it
 * goes on the wire, to stay byte-identical to the retired `JobQueue`'s
 * original `_emit()` payload: `type` becomes `jobType`, and `error`/`note`
 * are coerced from `undefined` to `null` (`legacy.error ?? null`,
 * `legacy.note ?? null`) rather than omitted. That second re-shape — not
 * `Job` itself — is what's actually broadcast, so it's what this type models.
 * (`Job` reused verbatim would not typecheck against the real call site, and
 * fixing that by changing the call site would be a wire-value change, out of
 * scope per this ticket's Non-goals.)
 */
export interface LegacyJobUpdateJob {
  id: string
  jobType: 'optimize-scan'
  target: string
  status: JobStatus
  error: string | null
  note: string | null
}

/**
 * Discriminated union covering every `/events` broadcast. One member per
 * `EVENT` name above; field lists are exact transcriptions of each
 * `broadcast({ type: ..., ... })` call site in `main.ts` (post
 * `01-merge-jobs`), including error-branch-only fields.
 *
 * | `type` | `main.ts` call site(s) | Fields beyond `type` |
 * |---|---|---|
 * | `client-log` | 1 (`/client-logs` handler, per log entry) | `ts: number`, `level: string`, `msg: string`, `stack?: string`, `url?: string`, `ua?: string`, `ip: string` — spread from the per-entry `record`; `stack`/`url`/`ua` are optional because the client didn't send them (`entry.stack`, `entry.url`, `body.ua` are all optional on the request body). |
 * | `scan-added` | 1 (`/upload-scan`, after save) | `filename: string`, `size: number` (`buffer.byteLength`) |
 * | `scan-deleted` | 1 (`DELETE /scans/:filename`) | `filename: string` |
 * | `scans-cleared` | 1 (`DELETE /scans`) | `deleted: number` |
 * | `session-started` | 1 (`POST /sessions`) | `sessionId: string` |
 * | `session-finalized` | 1 (`POST /sessions/:id/finalize`) | `sessionId: string`, `keyframeCount: number`, `glbFilename: string \| null` (`null` when the client didn't send one, or `safeScanName()` rejected it) |
 * | `video-ingested` | 1 (`/ingest-video`, after registering the scan) | `sessionId: string`, `scanId: string`, `jobId: string`, `frameCount: number` |
 * | `photos-ingested` | 1 (`/ingest-photos`, after registering the scan) | `sessionId: string`, `scanId: string`, `jobId: string`, `frameCount: number` |
 * | `world-job-update` | 6 (every `WorldJob` status transition — dispatch start/progress, claim, complete, requeue-on-crash-recovery) | `worldId: string`, `job: WorldJob` (the full record, including the not-ok/failed-claim branches — same shape every time) |
 * | `job-update` | 1 (`broadcastLegacyJobUpdate`, itself called from 4 of the 6 `world-job-update` sites, a no-op for every `WorldJobType` but `optimize-scan`) | `job: LegacyJobUpdateJob` (see that type's doc comment for why it isn't `Job`) |
 *
 * `'job-update'` and `'world-job-update'` both fire for the same
 * `optimize-scan` transition (paired, per `01-merge-jobs`/0004) but are
 * modeled as two distinct members, not collapsed: `'world-job-update'`
 * carries the real `WorldJob`, `'job-update'` carries the legacy
 * back-compat shape existing consumers (`src/viewer/viewer.ts`'s
 * `handleJobUpdate`) still expect. Both are permanent wire shapes, not a
 * migration in progress.
 *
 * `sessionId` on `session-finalized` is read from a `Record<string, unknown>`
 * at the call site (`record['sessionId']`, `main.ts:940`) — statically
 * `unknown` today even though the runtime value is always the `string`
 * minted by `POST /sessions`. Modeling it as `string` here is the payload's
 * true wire type; ticket 0002 will need a narrowing cast or a typed `record`
 * at that one call site to satisfy it — not a design change, a mechanical
 * consequence of this file being typed for the first time.
 */
export type EventPayload =
  | {
    type: typeof EVENT.CLIENT_LOG
    ts: number
    level: string
    msg: string
    stack?: string
    url?: string
    ua?: string
    ip: string
  }
  | { type: typeof EVENT.SCAN_ADDED; filename: string; size: number }
  | { type: typeof EVENT.SCAN_DELETED; filename: string }
  | { type: typeof EVENT.SCANS_CLEARED; deleted: number }
  | { type: typeof EVENT.SESSION_STARTED; sessionId: string }
  | {
    type: typeof EVENT.SESSION_FINALIZED
    sessionId: string
    keyframeCount: number
    glbFilename: string | null
  }
  | {
    type: typeof EVENT.VIDEO_INGESTED
    sessionId: string
    scanId: string
    jobId: string
    frameCount: number
  }
  | {
    type: typeof EVENT.PHOTOS_INGESTED
    sessionId: string
    scanId: string
    jobId: string
    frameCount: number
  }
  | { type: typeof EVENT.WORLD_JOB_UPDATE; worldId: string; job: WorldJob }
  | { type: typeof EVENT.JOB_UPDATE; job: LegacyJobUpdateJob }
