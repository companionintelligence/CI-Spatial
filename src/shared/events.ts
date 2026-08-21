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
