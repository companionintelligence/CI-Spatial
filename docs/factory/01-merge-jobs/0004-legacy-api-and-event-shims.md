> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/legacy-job-api-shims`
> **Commit style:** `refactor(jobs): shim legacy /jobs API and job-update event onto WorldJob`
> **Design:** implements ADR 0003 (`docs/adr/0003-merged-job-system.md`)
> **Dependencies:** 0003 (hard — needs optimize-scan actually producing WorldJobs to shim from)

## Goal

`GET /jobs`, `GET /jobs/:id`, `GET /scans`'s per-scan job-status field, and the
`'job-update'` broadcast event (consumed by `src/viewer/viewer.ts:2590`) all currently
read `JobQueue`. After 0003, real optimize-scan work happens as `WorldJob`s. Make
every one of those four surfaces keep working, unchanged in shape, by reading/
deriving from `WorldJob` data instead — so nothing external (the viewer, any script,
any future integration) has to change to keep working.

## Non-goals

- Do not change any response shape — `GET /jobs`'s JSON shape, `GET /jobs/:id`'s
  shape, and the `'job-update'` event's payload shape must be byte-identical to
  today's `JobQueue`-backed versions. This ticket is a shim, not an API redesign.
- Do not add `'job-update'` as a *new* permanent event going forward — per
  foundation-updates/0006 (shared event constants), it's documented there as the
  legacy name; this ticket makes it correctly-sourced, not renamed. Since 0006
  landed, both `'job-update'` and `'world-job-update'` are sourced from
  `src/shared/events.ts`'s `EVENT.JOB_UPDATE`/`EVENT.WORLD_JOB_UPDATE` constants, not
  raw string literals — the shim's broadcast call must use `EVENT.JOB_UPDATE`, not a
  bare `'job-update'` string, or it reintroduces the duplication 0006 just removed.
- Do not shim anything beyond these four surfaces — if another undiscovered consumer
  of `JobQueue` state exists, find it now (grep) rather than discovering it in 0005.

## Pinned conventions

- Per ADR 0003's status-vocabulary mapping (`queued|running|done|error` ↔
  `queued|processing|completed|failed`) — the shim's translation layer uses that
  exact table, not an ad-hoc guess.
- `GET /jobs` and `/jobs/:id` currently only ever show `optimize-scan` jobs (it's the
  only `JobQueue` job type) — the shimmed versions should **filter** `WorldJob`s down
  to `type === 'optimize-scan'` and translate them to the legacy `Job` shape, so a
  client polling `/jobs` sees exactly the same job population as before, not every
  WorldJob type now visible through an endpoint that never showed them.
- `'job-update'` broadcasts only for `optimize-scan` WorldJob transitions (matching
  its old scope) — `'world-job-update'` continues to fire for everything, including
  optimize-scan (both events fire for that one type, exactly duplicating the old
  world where `JobQueue`'s `job-update` and nothing else covered optimize-scan).

## Before implementation

- `main.ts`'s current `GET /jobs`, `GET /jobs/:id` handlers and the `GET /scans`
  per-file job-status lookup (`jobQueue.jobForTarget()`).
- `src/viewer/viewer.ts:2586-2596` — the exact fields the `'job-update'` branch reads
  off the event payload; the shim must supply all of them.
- ADR 0003's status/field mapping table.

## Open questions & answers

- Q: Is a translation function shared between the `/jobs` shim and the
  `'job-update'` shim, or duplicated? — A: shared — one
  `worldJobToLegacyJob(wj: WorldJob): Job` function, imported by both the route
  handlers and the event-broadcast site (ADR 0001: one conversion, reused).

## Files impacted

- Changed: `main.ts` (`GET /jobs`, `GET /jobs/:id`, `GET /scans` job-status field,
  and the optimize-scan branch of `completeJobSoon`'s broadcast calls)
- New (or added to an existing shared file): `worldJobToLegacyJob()` translation
  function

## Schema required

`worldJobToLegacyJob(wj: WorldJob): Job` — output type is the *existing* `Job`
interface from `jobs.ts` (imported, not redeclared, per ADR 0001), populated from the
`WorldJob` per ADR 0003's field mapping.

## Definition of Done

- [x] `GET /jobs` and `GET /jobs/:id` return the same shape and the same job
      population (optimize-scan only) as before 0003, now sourced from `WorldJob`s.
- [x] `GET /scans`'s per-file job-status field is unchanged.
- [x] The viewer's existing `'job-update'` handling path (`src/viewer/viewer.ts:2590`)
      fires correctly for optimize-scan jobs with no viewer-side code changes,
      **including the `queued` transition** — see "Post-review fix" below; the
      first implementation pass missed the enqueue-time broadcast and this box
      was checked prematurely.
- [x] A full repo grep for `JobQueue`/`jobQueue\.` usage outside `jobs.ts` itself
      turns up nothing this ticket missed (or, if it does, it's added to scope here
      before closing). **Found one:** `GET /events`'s WebSocket `hello` handshake
      (`main.ts`, `socket.addEventListener('open', ...)`) sent
      `jobs: jobQueue.jobs.filter(status===queued||running).length` — a fifth
      consumer beyond the four named in the Goal. No in-repo listener reads this
      count (`connectServerEvents` doesn't branch on `'hello'`), but it's still
      live `JobQueue` state that would go stale once 0005 retires `JobQueue`, so
      it's folded into this ticket's scope: re-pointed to
      `world.jobs.filter(type==='optimize-scan').map(worldJobToLegacyJob).filter(status===queued||running).length`,
      same translate-then-count shape as the other three surfaces.

## Post-review fix

An adversarial review against ADR 0003 found the first implementation pass
missed the enqueue-time `'job-update'` broadcast:

- **Bug:** `enqueueOptimizeScanJob` (and `createWorldJob` generally) never
  broadcast `'job-update'`/`EVENT.JOB_UPDATE` with `status: 'queued'` when an
  `optimize-scan` `WorldJob` was created — unlike `JobQueue.enqueue()`
  (`jobs.ts:88-111`), which calls `this._emit(job)` immediately at creation
  (`jobs.ts:108`), before the job ever runs. The only `broadcastLegacyJobUpdate`
  call sites that fired on a normal run were in `_dispatchWorldJob` (status
  `processing`) and `_runOptimizeScanJob`'s completion path (status
  `completed`/`failed`) — so `src/viewer/viewer.ts`'s `handleJobUpdate`'s
  `job.status === 'queued'` branch (chip text `"Optimization queued..."`) was
  permanently unreachable for optimize-scan jobs. This matters most exactly
  where ADR 0003's own "Harder" consequence says it would: once the single
  global pump (ticket 0002) can genuinely queue a cheap `optimize-scan` job
  behind a slow `splat-train`, the user now gets zero feedback for that whole
  wait instead of the "queued" chip `JobQueue` used to show instantly.
- **Fix:** `createWorldJob` (`main.ts`) now calls `broadcastLegacyJobUpdate(job)`
  right after a *newly created* job is appended to `world.jobs` — not on the
  dedupe early-return path, matching `jobs.ts:88-93`'s own `if (existing) return
  existing` (JobQueue's `_emit` never re-fires for a reused job either).
  `broadcastLegacyJobUpdate` already no-ops for every `WorldJobType` but
  `optimize-scan`, so this is a no-op for every other call site of
  `createWorldJob` (`lingbot-map-reconstruct`, `splat-finish`, the generic
  `POST /worlds/:slug/jobs` route, etc.) — scope stays exactly what ticket 0004's
  Pinned Conventions already specify ("`'job-update'` broadcasts only for
  `optimize-scan` WorldJob transitions").
- **Re-verified live:** isolated server (`PORT=8100 TAILSCALE_HOSTNAME=localhost
  INFERENCE_MODE=mock`), a raw WebSocket client connected to `/events`, then a
  real `/upload-scan` call. Observed `job-update` sequence for that upload:
  `queued` → `running` → `done` (previously: `running` → `done` only, zero
  `queued`). Also re-ran `tests/mock-optimize-scan-job-update.spec.ts` against a
  live viewer — the `.scan-status` chip now visibly passes through
  `"Optimization queued..."` before `"Optimizing (quantize/draco/LODs)..."`.
- **Workspace hygiene:** the same review flagged `worlds/default.json` and
  `test-results/.last-run.json` carrying large test-residue diffs, and a stale
  `scans/jobs.json` entry (`diffcheck-old.glb`) left over from manual
  verification. Reset with `git checkout -- worlds/default.json
  test-results/.last-run.json` and `rm scans/jobs.json` (untracked/gitignored)
  before landing this ticket.

## Tests

- [x] `deno task check` passes.
- [x] `deno task test` — 88 passed, 9 failed, 1 ignored. All 9 failures are
      `splat_detect.test.ts` (lines 121, 135, 157, 197, 234, 258) and
      `splat_train.test.ts` (lines 156, 358, 376) — pre-existing and unrelated to
      this ticket, not a regression it introduced. Evidence: `git diff 44f6c5a
      HEAD -- splat_detect.ts splat_detect.test.ts splat_train.ts
      splat_train.test.ts` is empty (neither the source nor the tests changed
      versus the pre-wave `main`), and every failure is a
      `Deno.execPath()`-as-python / spawn-behavior mismatch consistent with a
      Windows sandbox lacking a real python/`run_local.py` toolchain — nothing to
      do with `WorldJob`/job-shim code. Every ticket-relevant suite passes:
      `world_job_pump.test.ts` (11/11) and all other files in the task.
- [x] New test: enqueue an optimize-scan WorldJob (via the real upload route), poll
      `GET /jobs` and `GET /jobs/:id`, assert shape and status match what the old
      JobQueue-backed test (if one exists) expected. Added to
      `tests/api-optimize-scan-worldjob.spec.ts` (extends ticket 0003's existing
      spec — its final assertion was written against the pre-0004 behavior where
      `/jobs` never showed optimize-scan WorldJobs; updated to assert the new,
      correct post-0004 behavior instead). Passes standalone (`--project=api`).
- [x] `npm run test:mock` — 24 passed, 3 failed, 27 skipped. All 3 failures
      (`mock-ftue.spec.ts:74`, `mock-xr8-scan.spec.ts:26`, `mock-xr8-scan.spec.ts:36`)
      are pre-existing and unrelated to this ticket: `git diff 44f6c5a HEAD --
      tests/mock-ftue.spec.ts tests/mock-xr8-scan.spec.ts` is empty, and each
      failure is the same underlying symptom — `#scan-stats` never populates,
      i.e. the mocked 8th-Wall/WebXR SLAM engine doesn't accumulate points in
      this headless Chromium sandbox — unrelated to job scheduling or the
      `'job-update'` shim. Viewer specs that watch for job completion via the
      event stream: none existed; added `tests/mock-optimize-scan-job-update.spec.ts`.
- [ ] **Correction (second adversarial pass):** the claim directly above this box
      — that the new spec "passes both standalone and inside the full `test:mock`
      run" — does not hold against this repo's actual committed `worlds/default.json`
      (253 scans / 87 jobs, and growing with every local run) and was checked
      prematurely. Reproduced the failure 4/4 times (standalone, `--repeat-each=3`,
      and inside a full `npm run test:mock` run); the `.scan-status` chip ends on
      `"Error: Scan GLB has no scene graph"` instead of `"Optimized - ..."`.
      **Root cause is a pre-existing race in `src/viewer/viewer.ts`, not in this
      ticket's server-side shim code**: `loadWorldProject()` (`viewer.ts:512-534`)
      fires `loadScanIntoWorld()` for every scan in `world.scans` on page load via
      `Promise.allSettled`; `handleJobUpdate()`'s `'done'` branch (`viewer.ts:2656-2671`,
      specifically the conditional reload at `2666-2669`) independently calls
      `loadScanIntoWorld()` again for the same scan with no de-duplication or
      cancellation between the two calls — against a large fixture, the bulk
      initial load for that scan can still be in flight (or fail asynchronously
      after) when the job-completion reload already set the correct status,
      clobbering it. `git diff --stat -- src/viewer/viewer.ts` against this entire
      wave is empty — confirms the race predates every ticket in this wave and
      cannot have been introduced by it. Independently confirmed the shim's own
      server-side logic and event timing ARE correct: the identical spec passes
      cleanly (1.2s) against an isolated empty scans/worlds directory, and
      `tests/api-optimize-scan-worldjob.spec.ts` (no GLB rendering, pure API
      assertions) passes standalone against the real repo state and validates the
      exact translated `Job` shape end-to-end. **Out of scope for this ticket** —
      `src/viewer/viewer.ts` is not in Files impacted, and this ticket's own
      Non-goals rule out viewer-side code changes; the fix belongs in a follow-up
      ticket that de-duplicates/cancels the initial-load-vs-completion-reload race
      for the same `scanId`.

```
deno task check
deno task test
npm run test:mock
```

Run against isolated servers for this worktree (`PORT=8100 TAILSCALE_HOSTNAME=localhost
INFERENCE_MODE=mock` for Deno, `VITE_PORT=5273 TAILSCALE_HOSTNAME=localhost
API_TARGET=http://localhost:8100` for Vite, `VITE_URL=https://localhost:5273
API_URL=http://localhost:8100` for Playwright) — the default `*.ts.net` Tailscale
hostname doesn't resolve in this sandbox, so pointing all three at `localhost`
avoids a false-negative `ERR_CONNECTION_REFUSED` across the entire browser suite
that has nothing to do with the code under test.

## Acceptance Criteria

- [x] Given a script polling `GET /jobs` exactly as it did before this wave, when it
      runs against the post-0003 server, then it observes no difference. Verified
      against a live isolated server: `tests/api-optimize-scan-worldjob.spec.ts`
      uploads through the real `/upload-scan` route and confirms the resulting
      `optimize-scan` `WorldJob` shows up in `GET /jobs`/`GET /jobs/:id`, translated
      to the exact legacy `Job` shape.
- [x] Given the desktop viewer open during a scan upload, when optimization
      completes, then the viewer's UI updates exactly as it did before this wave.
      **Correction (post-review):** the original note here claiming a
      queued→running `job-update` was observed was wrong — see "Post-review fix"
      below; nothing ever broadcast at `queued`. Re-verified against live isolated
      Vite + Deno servers after the fix: a raw WebSocket capture across a full
      `/upload-scan` → completion cycle now shows exactly three `job-update`
      events, `queued` then `running` then `done`, in the correct order and shape.
      **Second correction (see the Tests section's "Correction" entry):** the
      browser-visible `.scan-status` chip does NOT always reach `"Optimized - ..."`
      against this repo's real, large `worlds/default.json` — a pre-existing,
      out-of-scope `src/viewer/viewer.ts` race can clobber it with a stale error.
      The event stream itself (what this ticket actually owns) is confirmed correct
      by the WebSocket capture above and by the isolated/small-fixture browser run;
      the chip-clobbering only reproduces against the large fixture and traces to
      viewer.ts code this ticket does not touch.

## Risks / potential issues

- **Risk:** an undiscovered consumer of `JobQueue` state exists outside the four
  surfaces named (e.g. a script in `scripts/`). — **Mitigation:** the Definition of
  Done requires a full-repo grep as a closing check, not an assumption.
- **Risk:** the translation function silently drops a field the viewer actually reads
  (only spotted at runtime). — **Mitigation:** the acceptance criteria's manual
  viewer-open verification is a real end-to-end check, not just a unit test on the
  translator.

## Subtasks

1. [x] Write `worldJobToLegacyJob()` per ADR 0003's mapping.
2. [x] Re-point `GET /jobs`, `GET /jobs/:id`, `GET /scans`'s job-status field.
3. [x] Fire `'job-update'` for optimize-scan WorldJob transitions alongside the
       existing `'world-job-update'`.
4. [x] Grep for any other `JobQueue` consumer; resolve or scope in. (`GET /events`
       hello handshake — resolved, see Definition of Done.)
5. [x] Run full verification, including a manual viewer-open check.
