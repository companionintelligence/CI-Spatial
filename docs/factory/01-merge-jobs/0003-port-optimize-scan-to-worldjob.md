> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/port-optimize-scan-to-worldjob`
> **Commit style:** `refactor(jobs): optimize-scan becomes a WorldJobType`
> **Design:** implements ADR 0003 (`docs/adr/0003-merged-job-system.md`)
> **Dependencies:** 0002 (hard — needs the hardened, recovering, single-flight runner)

## Goal

Add `'optimize-scan'` to `WorldJobType`, give it a runner (`_runOptimizeScanJob`,
mirroring `_runLingBotMapJob` etc.), and re-point the three routes that currently call
`jobQueue.enqueue('optimize-scan', ...)` — `POST /upload-scan`,
`POST /scans/:filename/optimize`, `POST /sessions/:id/finalize` — to create a
`WorldJob` instead. `pipeline.ts`'s `optimizeScan()` itself is untouched; only its
caller moves.

## Non-goals

- Do not change `pipeline.ts` — `optimizeScan()`'s dedup/prune/LOD/quantize/Draco
  logic is unrelated to which queue calls it.
- Do not change the artifact output (`<base>.opt.glb`, `<base>.lodN.glb`,
  `<base>.manifest.json`) — same files, same names, same content.
- Do not delete `jobs.ts`/`JobQueue` yet — 0004 (shims) must land and be verified
  before 0005 retires it. This ticket adds the new path alongside the old one; it does
  not remove the old one.
- Do not change `completeJobSoon()`'s dispatch structure (the `if (job.type === ...)`
  chain, currently `main.ts:1608-1631`, immediately before the generic-completion
  fallback) beyond adding one more `if (job.type === 'optimize-scan')` branch (ADR
  0001: extend, don't rebuild).

## Pinned conventions

- Per ADR 0003: the exact `WorldJobType` string to use for optimize-scan (confirm
  it's `'optimize-scan'` verbatim, reusing the string `Job['type']` already used, per
  ADR 0001's reuse principle) and the status-vocabulary mapping table.
- `jobs.ts`'s `OptimizeScanManifest` (renamed from `ScanManifest` by
  foundation-updates/0003, merged 2026-08-16 in PR #71) stays the on-disk
  artifact-index shape; only its *caller* changes, not its *shape*.
- Follow the existing `_run*Job` function signature pattern exactly:
  `async function _runOptimizeScanJob(slug: string, jobId: string): Promise<void>`.

## Before implementation

- `jobs.ts`'s `_runOptimize()` (the current implementation) — port its body, don't
  rewrite it.
- One existing `_run*Job` function in full (e.g. `_runMemoryPushJob`, the simplest —
  a single linear try/catch with no result-branching) as the structural template.
- The three call sites: grep `jobQueue.enqueue` in `main.ts`.
- Confirm foundation-updates/0003 (jobs.ts ScanManifest rename) has landed — if not,
  this ticket's `Files impacted` below still applies to the pre-rename name; note
  which is actually true at implementation time.

## Open questions & answers

- Q: Does the new `_runOptimizeScanJob` call `pipeline.ts`'s `optimizeScan()`
  directly, or keep a thin `jobs.ts`-side wrapper for it? — A: call directly from
  `main.ts`, matching every other `_run*Job`'s pattern of importing its worker module
  directly (`splat_train.ts`'s `runSplatTrain`, etc.) — no wrapper needed
  (decided by ticket author, 2026-08-16).

## Files impacted

- Changed: `src/world/types.ts` (`WorldJobType` union: add `'optimize-scan'`)
- Changed: `main.ts` (new `_runOptimizeScanJob`; three route call sites re-pointed
  from `jobQueue.enqueue` to `createWorldJob(...) + completeJobSoon(...)`)

## Schema required

`WorldJobType` gains `'optimize-scan'`. `WorldJob.payload`/`.artifacts`/`.result` for
this job type carry what `_runOptimize()` currently produces (the manifest path,
LOD list, size-reduction note) — map field-for-field per ADR 0003's guidance; extend
`WorldJob`, don't invent a parallel shape (ADR 0001).

## Definition of Done

- [x] Uploading a scan (`POST /upload-scan`) creates a `WorldJob` of type
      `optimize-scan`, not a legacy `Job`. Verified live: uploaded a scan against a
      running server, confirmed `job.jobId` matches an entry in
      `GET /worlds/default/jobs` with `type: 'optimize-scan'`, and confirmed
      `GET /jobs` (legacy) never saw the target filename.
- [x] The produced `<base>.opt.glb`/`.lodN.glb`/`.manifest.json` files are
      byte-identical to what the old path produced for the same input. Verified by
      running the same fixture GLB through both the untouched `jobs.ts` `JobQueue`
      and the new `_runOptimizeScanJob` and diffing output: `.opt.glb` is
      byte-identical (`cmp`), and `.manifest.json` is identical modulo the
      `source`/`createdAt` fields (which vary run-to-run under the old path too).
- [x] `POST /scans/:filename/optimize` and `POST /sessions/:id/finalize` both create
      `WorldJob`s the same way. Both call the same new `enqueueOptimizeScanJob`
      helper `POST /upload-scan` uses. `/scans/:filename/optimize` verified live
      (manually re-triggered optimize on an already-uploaded scan — dedupe correctly
      returned the in-flight job, then a fresh call after completion produced a new
      completed `optimize-scan` `WorldJob`). `/sessions/:id/finalize` verified by
      code inspection only (same helper call, not separately exercised live — no
      session fixture was built for this pass).
- [x] The hardened runner from 0002 applies: optimize-scan jobs respect single-flight
      and are recovered on crash exactly like every other WorldJobType. Dispatch goes
      through the same `worldJobPump`/`_dispatchWorldJob` used by every other type
      (no bypass), and `recoverStuckWorldJobs`/boot recovery key off `status` only,
      never `job.type`, so optimize-scan jobs are recovered identically to every
      other type by construction.

## Tests

- [x] `deno task check` passes.
- [x] `npm run smoke:pipeline` passes unchanged (exercises `pipeline.ts` directly,
      unaffected by the caller change — proves the artifact logic itself is untouched).
- [x] New/updated test: upload a scan via the real route, assert a `WorldJob` of type
      `optimize-scan` appears in `GET /worlds/:slug/jobs` and reaches `completed`.
      Added `tests/api-optimize-scan-worldjob.spec.ts` (Playwright `api` project,
      matching `tests/api-test-homes.spec.ts`'s conventions); ran it live against a
      real server and it passes.
- [ ] Existing `deno task test` suite still passes. **Not fully true as written**: 9
      of 97 tests fail (`splat_detect.test.ts` ×6, `splat_train.test.ts` ×3), but
      these are pre-existing and unrelated to this ticket — confirmed by
      `git stash`-ing this ticket's entire diff and re-running: the identical 9 tests
      fail with none of this ticket's changes present. Looks like an environment
      issue (python venv / CLI binary detection returning `error`/`ok` instead of
      `skipped` on this box) in code this ticket never touches. The 88 unaffected
      tests, including the new `world_job_pump.test.ts` suite (11/11), pass.

```
deno task check
npm run smoke:pipeline
deno task test
```

## Acceptance Criteria

- [x] Given a fresh scan upload, when optimization finishes, then `GET
      /worlds/:slug/jobs` shows an `optimize-scan` WorldJob in `completed` status with
      the correct artifact references — with no `jobs.json` entry created for it.
      Verified live end-to-end (see Definition of Done above) and covered by
      `tests/api-optimize-scan-worldjob.spec.ts`.

## Risks / potential issues

- **Risk:** `_runOptimize()`'s current error handling / partial-artifact cleanup
  behavior is subtle and easy to lose in translation. — **Mitigation:** port the
  function body near-verbatim rather than rewriting from scratch; diff the ported
  logic against the original line by line before removing the original call site.
- **Risk:** scans uploaded *during* this ticket's rollout (if deployed mid-session)
  could have jobs split across both systems. — **Mitigation:** 0004's shims (next
  ticket) exist precisely so both systems remain queryable during the transition;
  this ticket doesn't need to solve that itself.

## Subtasks

1. [x] Add `'optimize-scan'` to `WorldJobType`.
2. [x] Port `_runOptimize()`'s body into a new `_runOptimizeScanJob`.
3. [x] Re-point the three route call sites.
4. [x] Add the new WorldJob-based upload test.
5. [x] Run full verification; diff artifact output against a pre-change baseline
       (ran the identical fixture through the untouched `jobs.ts` `JobQueue` and
       compared byte-for-byte; see Definition of Done).
