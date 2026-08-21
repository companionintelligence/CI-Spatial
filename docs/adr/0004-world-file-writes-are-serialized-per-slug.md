# 0004. World-file writes are serialized per slug

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related issue:** N/A — workspace policy, not a GitHub issue. Fixes a lost-update
  bug found in a `npm run test:box` run on 2026-08-16.

## Context

`worlds/<slug>.json` is the single source of truth for a `WorldProject`: its scans,
its edit patches, and — since ADR 0003 merged the two job systems — every `WorldJob`
including `optimize-scan`. `saveWorld()` wrote it atomically (temp file + rename), so
a reader never saw a torn file.

Atomicity is not isolation. Nothing serialized the surrounding cycle:

```
loadWorld(slug) → mutate the in-memory WorldProject → saveWorld(world)
```

Two cycles could interleave, and the second writer — holding a snapshot taken before
the first writer saved — silently reverted the first writer's change. `grep -c
"mutex\|lock\|semaphore" main.ts` returned 0.

Observed in `.test-run/worlds/default.json` after a box run: of 66 `optimize-scan`
jobs, 4 were stranded at `status: "processing"`, `progress: 0.35` — precisely the
values `_dispatchWorldJob` writes when it claims a job — with `updatedAt` timestamps
spread over 14 seconds, while *other* jobs kept completing for ~3 minutes afterwards.
That pattern cannot come from concurrent execution: the pump is strictly serial (ADR
0003, "Single-flight execution"). It is a lost update — the pump marked the job
processing, ran it, and marked it completed, and a concurrent writer holding the
pre-completion snapshot saved that snapshot back over the top. Boot recovery would
requeue such a job, but only at the next restart; until then it reads as stuck at 35%
forever, and job-completion polls time out.

ADR 0003 made this materially worse rather than causing it. `optimize-scan` used to
persist to its own `scans/jobs.json` behind a single writer (the retired `JobQueue`),
and now shares `worlds/<slug>.json` with every `/upload-scan`, every job transition,
and every editor action. Write contention on one file went up sharply.

## Decision

Every read-modify-write of a world file runs inside a per-slug critical section.

- `world_lock.ts` owns the primitive: `withWorldLock(slug, fn)`, a promise chain per
  slug. Same shape as `src/viewer/viewer.ts`'s `enqueueScanLoad()` chaining per
  scanId, and a sibling of `world_job_pump.ts`'s pump — that one serializes job
  *execution*, this one serializes world-file *persistence*. Separate module, like
  the pump, so it is unit-testable without `main.ts`'s top-level side effects.
- `main.ts` exposes exactly three locked entry points, and no others touch the file:
  - `loadWorld(slug)` — locked read.
  - `updateWorld(slug, mutate)` — locked load → mutate → save. The write is
    unconditional, so a mutator cannot forget to persist what it changed.
  - `mutateWorldFiles(mutator)` — the every-world sweep, one lock per file.
- `readWorldUnlocked` / `writeWorldUnlocked` are the unlocked primitives those three
  call. Their names are the warning: calling them anywhere else reintroduces the bug.
- The lock is **not reentrant**. A mutator must not call `loadWorld`/`updateWorld`
  for its own slug — it already holds the live `world` object.
- Long-running work (a worker subprocess), broadcasts, and pump enqueues stay
  *outside* the critical section. A runner claims its job in one locked cycle, runs
  the worker unlocked, then commits the result in a second locked cycle
  (`commitWorldJob`). Holding the lock across a Brush training run would serialize
  the whole server behind it.

In-process only. This assumes the single-process server ADR 0003 already assumes for
crash recovery; two server processes sharing a `WORLDS_DIR` would still race.

## Consequences

- The lost update is gone: `world_lock.test.ts` pins it, asserting both that the
  unlocked interleaving loses an update and that the locked one does not.
- Concurrency is unchanged in practice. Sections are short (read file, mutate JSON,
  write file), different worlds never block each other, and the pump was already
  serial.
- One more rule for new code, in the same family as ADR 0001's "reuse, don't
  duplicate": if you are writing `worlds/*.json` outside `updateWorld`, stop.
- Job runners lost their duplicated boilerplate along the way — `markJobFailed`,
  `claimScanJob`/`claimJobScan`/`claimSessionJob`, `commitWorldJob`, and
  `failWorldJob` replace the same 5-to-20-line blocks that were copy-pasted across
  all six `_run*Job` functions, so the locking rule is expressed once rather than
  six times.
