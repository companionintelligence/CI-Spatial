> **Type:** Docs / Design
> **Wave:** 02-typed-event-payloads
> **Branch:** `docs/event-payload-union-design`
> **Commit style:** `docs(events): design the /events payload discriminated union`
> **Design:** this ticket produces the design; no prior doc to link
> **Dependencies:** foundation-updates/0006 and 01-merge-jobs (both must be merged first)

## Goal

Decide, precisely, the discriminated-union type for every `/events` WebSocket
payload, where it lives, and the typed API `broadcast()` and its callers use — so
0002/0003 are pure implementation with no design decisions left.

## Non-goals

- Do not implement anything — design only.
- Do not change any wire value — payload *shapes* are being typed as they already
  are today (post `01-merge-jobs`), not redesigned.
- Do not attempt to type WebSocket messages the client sends *to* the server
  (`/rtc-signal`'s SDP/ICE relay is intentionally payload-blind per its own design —
  out of scope) — this is `/events` (server→client broadcast) only.

## Pinned conventions

- Builds on `foundation-updates/0006`'s `src/shared/events.ts` (the `EVENT` const map
  + `EventType` union of name strings) — this ticket adds the *payload* type per
  name; it does not re-derive the name list.
- Per ADR 0001: extend `src/shared/events.ts` rather than creating a second
  events-related file.
- `'job-update'`'s payload type is explicitly `{ type: 'job-update'; job: Job }`
  (importing the legacy `Job` type, which post-`01-merge-jobs`/0004 is a translation
  output, not an independent shape) — `'world-job-update'`'s is
  `{ type: 'world-job-update'; worldId: string; job: WorldJob }`. Both are real,
  permanent, distinct wire shapes (back-compat, per that wave's 0004) — the union
  models two members, it does not collapse them.

  **Correction found during this ticket's grep (2026-08-24):** `job: Job` above does
  not match what `main.ts` actually sends. `broadcastLegacyJobUpdate`
  (`main.ts:2183-2197`) takes the `Job` that `worldJobToLegacyJob()` produces and
  re-shapes it a second time before broadcasting, to stay byte-identical to the
  retired `JobQueue`'s original `_emit()` payload: the field is `jobType`, not
  `type`, and `error`/`note` are `string | null` (coerced with `?? null`), not
  `Job`'s optional `string | undefined`. Reusing `Job` verbatim would not typecheck
  against the real call site without changing the wire value, which Non-goals
  forbids. The design below therefore types `job` as a new `LegacyJobUpdateJob`
  (`src/shared/events.ts`) — the actual wire shape — not `Job`. This does not
  change which two events exist or that they stay distinct, only what `job-update`'s
  `job` field is typed as.

## Before implementation

- `src/shared/events.ts` as landed by `foundation-updates/0006` (its exact `EVENT`
  map and any documentation-per-event it already carries).
- Every `broadcast({ type: ..., ... })` call site in `main.ts` post-`01-merge-jobs`
  (the payload fields actually sent for each of the ~10 event types).
- `src/viewer/viewer.ts`'s event-consumer switch and `scripts/logs-watch.mjs`'s
  matching, to know what fields consumers actually read.

## Open questions & answers

- Q: A typed `broadcast<T extends EventPayload>(payload: T): void` overload, or keep
  `broadcast(event: Record<string, unknown>)` and rely on call-site literal typing? —
  A: typed overload — `broadcast(payload: EventPayload)` where `EventPayload` is the
  full discriminated union; this is what actually catches a mistyped field at the
  call site instead of only at consumption (decided by ticket author, 2026-08-16).
- Q: Should `WebSocket.send()`'s `JSON.stringify()` call be centralized so payload
  shape and serialization can't drift? — A: yes, `broadcast()` already does this in
  one place (`main.ts:160`) — no change needed there, just its parameter type.

## Files impacted

- Changed: `src/shared/events.ts` (add the payload union alongside the existing name
  constants)

## Schema required

`EventPayload` — a discriminated union (discriminant: `type`) covering every event
name in `foundation-updates/0006`'s `EVENT` map, with the exact field set each
`broadcast()` call site sends today (enumerate each member's fields precisely in this
ticket's Open Q&A or a table — the full list is 0002's implementation input, not
something 0002 should have to re-derive from `main.ts` itself).

The full type declarations are landed in `src/shared/events.ts` (this ticket's
deliverable, per Subtask 3) — this table is the same information, kept here per this
section's own instruction so 0002 doesn't have to re-derive it from `main.ts`:

| `type` | `main.ts` call site(s) | Fields beyond `type` |
|---|---|---|
| `client-log` | 1 (`/client-logs`, per log entry, line 447) | `ts: number`, `level: string`, `msg: string`, `stack?: string`, `url?: string`, `ua?: string`, `ip: string` |
| `scan-added` | 1 (`/upload-scan`, line 521) | `filename: string`, `size: number` |
| `scan-deleted` | 1 (`DELETE /scans/:filename`, line 744) | `filename: string` |
| `scans-cleared` | 1 (`DELETE /scans`, line 765) | `deleted: number` |
| `session-started` | 1 (`POST /sessions`, line 806) | `sessionId: string` |
| `session-finalized` | 1 (`POST /sessions/:id/finalize`, line 940) | `sessionId: string`, `keyframeCount: number`, `glbFilename: string \| null` |
| `video-ingested` | 1 (`/ingest-video`, line 1046) | `sessionId: string`, `scanId: string`, `jobId: string`, `frameCount: number` |
| `photos-ingested` | 1 (`/ingest-photos`, line 1154) | `sessionId: string`, `scanId: string`, `jobId: string`, `frameCount: number` |
| `world-job-update` | 6 (lines 2284, 2355, 2393, 3119, 3151, 3181 — every `WorldJob` status transition) | `worldId: string`, `job: WorldJob` |
| `job-update` | 1 (`broadcastLegacyJobUpdate`, line 2186, itself called from 4 of the 6 `world-job-update` sites; a no-op for every `WorldJobType` but `optimize-scan`) | `job: LegacyJobUpdateJob` — see the Pinned-conventions correction above for why it isn't `Job` |

All 10 rows are exact transcriptions verified against the current call sites — see
Tests below.

## Definition of Done

- [x] `EventPayload` union is fully specified, one member per event name, with exact
      field lists matching current `main.ts` call sites.
- [x] The `broadcast()` typed-overload API is specified (signature + how `main.ts`'s
      existing `eventSockets`/`JSON.stringify` internals stay unchanged).
- [x] `'job-update'` and `'world-job-update'` are both modeled explicitly, each citing
      why they're distinct (back-compat vs the real WorldJob shape).

## Tests

- [x] N/A — no code. Verify by grepping every `broadcast({ type:` call site in
      `main.ts` and confirming each has a corresponding union member in the design.
      (Done: all 10 `EVENT.*` names used at `broadcast()` call sites have exactly one
      matching `typeof EVENT.*` member in `EventPayload` — see `src/shared/events.ts`.
      `deno task check`, `tsc --noEmit`, and `deno task test` all pass unchanged.)

## Acceptance Criteria

- [x] Given the finished design, when 0002 is implemented, then no `broadcast()` call
      site requires a design decision — only a mechanical type annotation.

## Risks / potential issues

- **Risk:** a `broadcast()` call site sends a field the design misses (e.g. an
  optional field only sent in an error branch). — **Mitigation:** the Before
  Implementation grep must read every call site's surrounding branches, not just the
  happy path.

## Subtasks

1. [x] Grep every `broadcast()` call site in `main.ts`; tabulate type + fields.
2. [x] Design `EventPayload` and the typed `broadcast()` signature.
3. [x] Write both into `src/shared/events.ts` as the ticket's actual deliverable
       (design ticket, but the type declarations themselves are cheap enough to land
       here rather than duplicate them into prose first).
