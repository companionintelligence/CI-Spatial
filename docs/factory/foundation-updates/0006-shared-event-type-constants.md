> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/shared-event-types`
> **Commit style:** `refactor(events): shared /events message-type constants`
> **Design:** this ticket is the spec
> **Dependencies:** 0003 (both edit `jobs.ts` — land 0003 first)

## Goal

The `/events` WebSocket message types are raw string literals duplicated between
producers and consumers with no shared source of truth. Producers: `main.ts` (9
distinct types across 27 `broadcast()` call sites — `client-log`, `scan-added`,
`scan-deleted`, `scans-cleared`, `session-started`, `session-finalized`,
`video-ingested`, `photos-ingested`, `world-job-update`) and `jobs.ts:213`
(`job-update`, emitted through the `broadcast` callback). Consumers re-match raw
strings: `src/viewer/viewer.ts:2587-2591` and `scripts/logs-watch.mjs:60`.

This duplication already caused a real misread during this wave's audit: the
`'job-update'` branch at `viewer.ts:2589` was reported as dead code because the
producer lives in `jobs.ts`, not `main.ts` — it is in fact live. Centralize the type
strings so liveness is greppable from one file.

## Non-goals

- Do not remove or rename any event type — the six types with no `src/` listener
  (`scan-deleted`, `scans-cleared`, `session-started`, `video-ingested`,
  `photos-ingested`, and `client-log`'s in-viewer case) may have external consumers
  (`logs-watch.mjs` consumes `client-log`; future tools may consume others). Constant-
  ize, don't prune.
- Do not merge `job-update` (JobQueue) with `world-job-update` (WorldJob) — they are
  events from two different job systems (see ADR 0001's Consequences: the systems
  stay separate for now).
- Do not convert `scripts/logs-watch.mjs` (plain Node .mjs) to TypeScript — give it a
  comment pointing at the constants file instead.

## Pinned conventions

- ADR 0001: one connection contract, shared — not per-file literals. Searched: the
  producer/consumer sites listed in Goal are the complete set (grep `broadcast(` in
  `main.ts`, `onEvent` in `jobs.ts`, `msg['type']`/`msg.type` in `src/` and
  `scripts/`).
- Location: `src/shared/` is the established home for runtime-agnostic modules
  imported by both Deno and browser code (`cv-palette.ts`, `test-homes.ts` precedent).
  New file: `src/shared/events.ts` exporting a `const EVENT = { SCAN_ADDED:
  'scan-added', ... } as const` object plus a derived `EventType` union.
- String **values are frozen** — they're the wire protocol; only their declaration
  site moves.

## Before implementation

- `main.ts`: all 27 `broadcast()` call sites (grep `broadcast({ type:`).
- `jobs.ts:213` (`onEvent({ type: 'job-update', ... })`).
- `src/viewer/viewer.ts:2585-2595` (the consumer switch).
- `scripts/logs-watch.mjs:60`.

## Open questions & answers

- Q: Type the `broadcast()` payload too (a discriminated union per event)? — A: Not in
  this ticket — constants + the `EventType` union only. A full payload union is a
  bigger change with real signature churn; log it as a candidate for a future wave
  (decided by ticket author, 2026-08-15).

## Files impacted

- New: `src/shared/events.ts`
- Changed: `main.ts`, `jobs.ts`, `src/viewer/viewer.ts` (literals → constants)
- Changed: `scripts/logs-watch.mjs` (comment only, pointing at events.ts)

## Schema required

None on the wire — string values unchanged. New TS module exports `EVENT` const map +
`EventType` union (extends the existing connection per ADR 0001 rather than adding a
new one).

## Definition of Done

- [ ] Every event-type literal in `main.ts`, `jobs.ts`, and `src/viewer/viewer.ts`
      comes from `src/shared/events.ts`.
- [ ] `src/shared/events.ts` documents, per event, its producer(s) and known
      consumer(s) — including "no in-repo listener" notes for the six, so the next
      auditor doesn't have to re-derive liveness.
- [ ] Wire strings byte-identical to before.

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run test:mock` passes (viewer specs assert live updates on scan upload).
- [ ] Manual: with `npm start` running, upload a scan and confirm the viewer refreshes
      (proves `scan-added`/`job-update` round-trip still works).

```
deno task check
npm run test:mock
```

## Acceptance Criteria

- [ ] Given `src/shared/events.ts`, when a reader wants to know who produces and who
      consumes any event, then the answer is in that one file's comments.

## Risks / potential issues

- **Risk:** a typo during mechanical replacement changes a wire string.
  — **Mitigation:** the `as const` map is written by copying the grep output, and the
  manual round-trip test catches a broken `scan-added` immediately.
- **Risk:** merge conflict with 0003 in `jobs.ts`. — **Mitigation:** ordering
  dependency declared above; 0003 lands first.

## Subtasks

1. [ ] Create `src/shared/events.ts` with all 10 event types, producer/consumer
       documentation per event.
2. [ ] Replace literals in `main.ts` (27 sites), `jobs.ts` (1), `viewer.ts` (4).
3. [ ] Add the pointer comment to `logs-watch.mjs`.
4. [ ] Run verification + the manual round-trip check.
