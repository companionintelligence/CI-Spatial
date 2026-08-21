# 0003. Merged job system: `WorldJob` absorbs `JobQueue`

- **Status:** Accepted
- **Date:** 2026-08-15
- **Related issue:** N/A — workspace policy, not a GitHub issue. See
  `docs/factory/01-merge-jobs/` (this ADR is ticket 0001's deliverable).

*(Numbered 0003, not 0002: `docs/adr/0002-*.md` was independently claimed by
foundation-updates' `0005-shared-manifest-envelope` ticket — an unrelated ADR about
browser-importable shared types — shortly after this wave was first drafted against
"0002". See `docs/factory/01-merge-jobs/README.md`'s "Pre-flight check" section.)*

## Context

`jobs.ts`'s `JobQueue` (one job type, `optimize-scan`, on raw GLBs in `SCANS_DIR`) and
the `WorldJob` system in `main.ts`/`src/world/types.ts` (`ingest`,
`lingbot-map-reconstruct`, `splat-train`/`splat-detect`/`splat-finish`,
`memory-push`, plus five more placeholder types) are two independent job systems.
ADR 0001 stopped a third from appearing and named this exact merge as necessary
follow-up work; this ADR is that follow-up.

`WorldJob` is the richer model — 12 types, artifacts, progress, per-world scoping,
capability-token auth — and is the designated survivor. But as read on 2026-08-15/16,
it is missing three guarantees `JobQueue` already has, and has no notion of "world"
for a job type (`optimize-scan`) that today operates purely on raw filenames with no
associated `WorldProject`:

| Guarantee | `JobQueue` (`jobs.ts`) | `WorldJob` (`main.ts`) today |
|---|---|---|
| Crash recovery: `running`/interrupted jobs resume on boot | `init()`, `jobs.ts:71-86` — requeues `running`→`queued`, note `"requeued after restart"` | **Absent** — no boot-time scan; a job stuck in `processing`, or even `queued` if the process died within the 25ms `completeJobSoon` delay, never runs again |
| Single-flight concurrency (box also runs the VLM) | `_pump()`'s `_working` flag, `jobs.ts:115-143` | **Absent** — `completeJobSoon()` (`main.ts:1585`) fires a bare `setTimeout`; every call runs independently and concurrently |
| Dedupe: no duplicate queued/running job for same type+target | `enqueue()`, `jobs.ts:88-93` | **Absent** — `createWorldJob` (`main.ts:1550`) and the `POST /worlds/:slug/jobs` route (`main.ts:2537-2556`) always create a new job |
| Bounded history (`MAX_JOB_HISTORY=200`, `jobs.ts:44`) | Enforced in `enqueue()`, `jobs.ts:103-106` | **Absent** — `WorldProject.jobs` grows unboundedly inside the per-world JSON |

The merged system must have all four, without regressing anything `WorldJob`'s
existing five active job types (`lingbot-map-reconstruct`, `splat-train`,
`splat-detect`, `splat-finish`, `memory-push`) already rely on.

## Decision

We will make `WorldJob` the sole job system. `JobQueue` is ported onto it, then
deleted (`docs/factory/01-merge-jobs/0002`–`0005`); nothing new is built to hold
`optimize-scan` going forward.

### Status vocabulary — `WorldJobStatus` survives, mapped 1:1

`WorldJobStatus` (`src/world/types.ts:30`) is the vocabulary going forward. `Job`'s
four states map onto it exactly — no state is dropped or split:

| `JobStatus` (old) | `WorldJobStatus` (new) |
|---|---|
| `queued` | `queued` |
| `running` | `processing` |
| `done` | `completed` |
| `error` | `failed` |

### Field mapping — `Job` → `WorldJob`, no new fields

| `Job` field | `WorldJob` equivalent | Notes |
|---|---|---|
| `id` | `jobId` | Same generation pattern (`job-${Date.now()}-…`), already used by `createWorldJob` |
| `type` | `type` | `'optimize-scan'` added verbatim to `WorldJobType` — see below |
| `target` (scan filename) | `payload.filename` | No new field — see "Which world" below |
| `status` | `status` | Per the table above |
| `createdAt` | `createdAt` | Direct |
| `startedAt` | *(none — use `updatedAt`)* | The transition to `processing` already bumps `updatedAt`; no second timestamp field is added |
| `finishedAt` | *(none — use `updatedAt`)* | The transition to `completed`/`failed` already bumps `updatedAt` |
| `error` | `error` | `WorldJob.error?: string` already exists (`types.ts:185`) |
| `note` | `result` | `WorldJob.result?: string` (`types.ts:182`) is the existing free-text field every `_run*Job` already writes human-readable outcomes into (e.g. `jobResultFor()`, `main.ts:2238-2265`) — reuse it, don't add a second string field |

No schema changes to `src/world/types.ts` beyond adding `'optimize-scan'` to the
`WorldJobType` union (`types.ts:16-28`). Everything else this ADR requires is
scheduling/persistence *behavior* in `main.ts`, not new shape.

### `WorldJobType` gains `'optimize-scan'`, verbatim

Add the literal `'optimize-scan'` to `WorldJobType` — reusing `Job['type']`'s exact
string (`jobs.ts:21`), per ADR 0001's reuse principle. No rename, no new name to
reconcile against the on-disk `OptimizeScanManifest` artifact index
(`jobs.ts:32`, renamed from `ScanManifest` by foundation-updates/0003), which this
merge does not touch — only `optimize-scan`'s *caller* changes, never its artifact
shape.

### Which world does an `optimize-scan` `WorldJob` belong to?

This is the one real gap the wave's tickets didn't surface: `/upload-scan`,
`/scans/:filename/optimize`, and `/sessions/:id/finalize` (`main.ts:324`, `428`,
`694`) all operate on raw filenames in `SCANS_DIR` with **no** `WorldProject`
association today — `GET /scans` (`main.ts:379-412`) is a raw-filesystem listing,
entirely separate from a world's own `scans[]` array. But `WorldJob.worldId` is
required.

**Decision: park `optimize-scan` `WorldJob`s under the `'default'` world**, exactly
matching the existing precedent in `enqueueLegacyProcessJob` (`main.ts:1566-1583`),
which already solves this identical problem for legacy per-file actions
(`object-count`, `floor-plan`, etc.) by doing `loadWorld('default')` and passing the
raw filename through `payload`. Ticket 0003's `_runOptimizeScanJob` should follow the
same shape:

```ts
const world = await loadWorld('default')
const job = createWorldJob(world, 'optimize-scan', undefined, { filename })
```

`scanId` stays `undefined` (no `ScanManifest` entry exists for most of these files);
`payload.filename` is the field every dedupe/lookup/runner keys off, mirroring
`Job.target`. Do not invent a second "raw scan job" concept — this is exactly the
shape `enqueueLegacyProcessJob` already uses, reused per ADR 0001.

### Single-flight execution

Replace `completeJobSoon()`'s current body — a bare `setTimeout(fn, 25)` that runs
immediately and independently per call (`main.ts:1585-1662`) — with a module-level
pending-job queue and a serializing pump, mirroring `jobs.ts`'s `_jobs`/`_pump()`
pattern (`jobs.ts:47`, `115-143`) exactly:

- A module-level array (e.g. `_pendingWorldJobs: Array<{ slug: string; jobId: string }>`)
  and a `_worldJobPumpRunning` flag, both alongside the existing `jobQueue` instance
  (`main.ts:174`).
- `completeJobSoon(slug, jobId)` pushes `{ slug, jobId }` onto that array and kicks the
  pump, instead of scheduling its own independent `setTimeout`.
- The pump processes one entry at a time, in order: for each, run exactly what
  `completeJobSoon`'s body already does today (set `status: 'processing'`, `progress:
  0.35`, broadcast, dispatch to `_runLingBotMapJob`/`_runSplatTrainJob`/
  `_runSplatDetectJob`/`_runSplatFinishJob`/`_runMemoryPushJob`/the new
  `_runOptimizeScanJob` for their six named types, or the generic 650ms completion
  path for the seven placeholder types) — and **wait for it to fully settle** (the
  function returns, or the generic path's inner `setTimeout` fires) before dequeuing
  the next entry. The per-type dispatch chain (`main.ts:1608-1631`) itself is
  unchanged; only what wraps and gates it changes.
- Global scope, not per-world: matches `JobQueue`'s current guarantee and is required
  because `splat-train` holds one GPU regardless of which world asked (Risk noted in
  ticket 0002).

### Crash recovery — boot-time requeue, one function, reusing the `WORLDS_DIR` scan

A new function (e.g. `recoverWorldJobsOnBoot()`), called once at server startup
immediately after `await jobQueue.init()` (`main.ts:175`), before the server starts
accepting requests:

1. Iterate `WORLDS_DIR` the same way `GET /worlds` already does
   (`for await (const entry of Deno.readDir(WORLDS_DIR))`, `main.ts:2442-2447`) — do
   not add a second directory-scan implementation (ADR 0001).
2. For each world, find every job with `status === 'processing'` **or**
   `status === 'queued'`. Both states are stuck without recovery: a `processing` job's
   process died mid-run, and a `queued` job that never got its `completeJobSoon`
   `setTimeout` to fire (the ~25ms window, or any window once 0002 lands and jobs sit
   in the pending-array instead) has no other path back to execution — nothing polls
   for queued `WorldJob`s the way `jobs.ts`'s `_pump()` does.
3. For each such job: set `status: 'queued'`, `result: 'requeued after restart'`
   (reusing `jobs.ts:79`'s exact note text as precedent, mapped onto `WorldJob.result`
   per the field table above), bump `updatedAt`, `saveWorld()`, broadcast
   `EVENT.WORLD_JOB_UPDATE`.
4. Push `{ slug, jobId }` onto the same `_pendingWorldJobs` queue from the
   single-flight design above — recovery does not get its own execution path; it just
   seeds the normal pump.

**Recovery algorithm: requeue-always, not type-dependent.** Every job type re-runs
from scratch on recovery, matching `JobQueue`'s existing behavior for `optimize-scan`.
Justification: the single-process-server assumption holds (a `processing`/`queued`
job found at boot definitely has no live worker — the boot *is* the fresh process),
and no active `_run*Job` has a known non-idempotent side effect that requeue-always
would corrupt:
- `lingbot-map-reconstruct`/`splat-train`/`splat-detect`/`splat-finish` each write
  deterministic output paths and overwrite on re-run; a wasted partial GPU run
  (`splat-train`) is a cost, not a correctness bug.
- `memory-push` is the one type with an external side effect (pushing to Companion
  Memory), but the receiving side already deduplicates by `sourceSystem`/`sourceId`
  (see `CLAUDE.md`'s do-not-rename entry for memory-push's `sourceSystem`
  `'companion-scan'`, and `_runMemoryPushJob`'s existing `pushed.eventDuplicate`
  handling, `main.ts:2068-2069`) — a re-push after a crash-during-processing is
  observably a no-op, not a duplicate.

If a future job type has a genuinely non-idempotent side effect, requeue-always
should be revisited for that type specifically — that's an owner decision at the time
that type is added, not something this merge needs to solve for placeholder types
with no runner yet.

### Dedupe

Before creating a new `WorldJob`, check for an existing job in the same world with
the same `type` and the same target (`scanId` if set, else `payload.filename`) whose
`status` is `queued` or `processing`; if found, return it instead of creating a
duplicate — the exact predicate shape `jobs.ts:88-93` already uses, applied per-world
instead of globally (since `WorldJob`s are already world-scoped). Both `createWorldJob`
call sites (`POST /worlds/:slug/jobs`, `main.ts:2537-2556`, and the new
`_runOptimizeScanJob`/`enqueueLegacyProcessJob`-style callers) route through this
check.

### Bounded history

Cap each world's `jobs` array at the same `MAX_JOB_HISTORY = 200` `jobs.ts` uses
(`jobs.ts:44`), with the identical trim shape: keep every `queued`/`processing` job,
and trim `completed`/`failed` jobs to the most recent 100 once the total exceeds 200
(mirroring `jobs.ts:103-106`'s filter-and-slice exactly, in `WorldJobStatus` terms).
Applied wherever a job is pushed onto `world.jobs` (same call sites as dedupe, above).

### Placeholder `WorldJobType`s — seven, not five, out of scope

Verified 2026-08-15: **seven** `WorldJobType`s have no dedicated `_run*Job` and no
active producer anywhere in `src/` — not the five ticket 0001's Non-goals originally
named. `extract-layers`, `align-scan`, `merge-points`, `semantic-pass`,
`depth-reconstruct` (the original five) plus `ingest` and `export-world` (same shape:
listed in `WORLD_JOB_TYPES`, `main.ts:1016-1029`; generic placeholder branches in
`jobResultFor`/`jobArtifactsFor`, `main.ts:2238-2354`; fall through to the generic
650ms completion path, `main.ts:1633-1657`; no dedicated runner). All seven are
explicitly out of scope for this merge — they gain the single-flight/recovery/dedupe/
history guarantees above for free (the pump and boot recovery are type-agnostic), but
whether any of them ever gets a real runner is a separate, later owner decision.

## Consequences

- **Easier:** one job system, one status vocabulary, one event-consumption path in
  the viewer for the tickets after this ADR to build on. Crash recovery and
  single-flight — real gaps today for `splat-train`, which holds a GPU for minutes —
  are fixed as a side effect of the merge, not a separate project.
- **Harder:** the single global pump means an unrelated cheap job type (a future
  `extract-layers`, say) queues behind a slow `splat-train` — this matches
  `JobQueue`'s already-accepted concurrency-1 tradeoff (`jobs.ts:4-5`, "the box also
  runs VLM inference"), not a new regression.
- **Follow-up:** `docs/factory/01-merge-jobs/0002` implements the single-flight pump
  and boot recovery; `0003` ports `optimize-scan` onto the hardened runner using the
  `'default'`-world pattern above; `0004` shims `GET /jobs`, `GET /jobs/:id`, `GET
  /scans`'s job-status field, and the `'job-update'` event onto translated `WorldJob`
  data so nothing external has to change; `0005` migrates `jobs.json` history into
  the corresponding worlds' `WorldJob` arrays and deletes `JobQueue`.
- **Revisit this ADR** if a future `WorldJobType` needs non-idempotent-safe recovery
  (the requeue-always default would need to become type-dependent for that type), or
  if any of the seven placeholder types gains a real runner and needs its own
  recovery/dedupe nuance this ADR didn't anticipate.
