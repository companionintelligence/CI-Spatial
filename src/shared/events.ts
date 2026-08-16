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
 * Runtime-agnostic: imported by Deno (`main.ts`, `jobs.ts`) and the Vite/
 * browser bundle (`src/viewer/viewer.ts`), following the `src/shared/`
 * precedent (`cv-palette.ts`, `test-homes.ts`).
 *
 * Two independent job systems both broadcast over `/events` (ADR 0001,
 * "Hard rule: reuse, don't duplicate" — they are deliberately kept separate,
 * not merged): `JOB_UPDATE` comes from `jobs.ts`'s `JobQueue` (the
 * GLB-optimizer pipeline), `WORLD_JOB_UPDATE` comes from the `WorldJob`
 * system in `main.ts` (ingest / lingbot-map-reconstruct / splat-train /
 * splat-detect / splat-finish / memory-push).
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
   * Producer: `jobs.ts` (`JobQueue['_emit']`, 1 site), emitted through the
   * `broadcast` callback `JobQueue` receives from `main.ts` at construction
   * (`new JobQueue(SCANS_DIR, broadcast)`) — the literal itself lives in
   * `jobs.ts`, not `main.ts`.
   * Consumer: `src/viewer/viewer.ts` (`connectServerEvents` → `handleJobUpdate`).
   *
   * Not the same event as `WORLD_JOB_UPDATE` above — see file-header note.
   */
  JOB_UPDATE: 'job-update',
} as const

export type EventType = typeof EVENT[keyof typeof EVENT]
