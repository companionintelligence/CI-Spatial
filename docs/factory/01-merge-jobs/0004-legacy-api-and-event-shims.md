> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/legacy-job-api-shims`
> **Commit style:** `refactor(jobs): shim legacy /jobs API and job-update event onto WorldJob`
> **Design:** implements ADR 0002 (`docs/adr/0002-merged-job-system.md`)
> **Dependencies:** 0003 (hard — needs optimize-scan actually producing WorldJobs to shim from)

## Goal

`GET /jobs`, `GET /jobs/:id`, `GET /scans`'s per-scan job-status field, and the
`'job-update'` broadcast event (consumed by `src/viewer/viewer.ts:2589`) all currently
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
  legacy name; this ticket makes it correctly-sourced, not renamed.
- Do not shim anything beyond these four surfaces — if another undiscovered consumer
  of `JobQueue` state exists, find it now (grep) rather than discovering it in 0005.

## Pinned conventions

- Per ADR 0002's status-vocabulary mapping (`queued|running|done|error` ↔
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
- `src/viewer/viewer.ts:2585-2595` — the exact fields the `'job-update'` branch reads
  off the event payload; the shim must supply all of them.
- ADR 0002's status/field mapping table.

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
`WorldJob` per ADR 0002's field mapping.

## Definition of Done

- [ ] `GET /jobs` and `GET /jobs/:id` return the same shape and the same job
      population (optimize-scan only) as before 0003, now sourced from `WorldJob`s.
- [ ] `GET /scans`'s per-file job-status field is unchanged.
- [ ] The viewer's existing `'job-update'` handling path (`viewer.ts:2589`) fires
      correctly for optimize-scan jobs with no viewer-side code changes.
- [ ] A full repo grep for `JobQueue`/`jobQueue\.` usage outside `jobs.ts` itself
      turns up nothing this ticket missed (or, if it does, it's added to scope here
      before closing).

## Tests

- [ ] `deno task check` passes.
- [ ] New test: enqueue an optimize-scan WorldJob (via the real upload route), poll
      `GET /jobs` and `GET /jobs/:id`, assert shape and status match what the old
      JobQueue-backed test (if one exists) expected.
- [ ] `npm run test:mock` passes (viewer specs that watch for job completion via
      the event stream — if any exist, confirm; if none do, note it and add one that
      asserts the viewer's UI updates on an optimize-scan `'job-update'`).

```
deno task check
deno task test
npm run test:mock
```

## Acceptance Criteria

- [ ] Given a script polling `GET /jobs` exactly as it did before this wave, when it
      runs against the post-0003 server, then it observes no difference.
- [ ] Given the desktop viewer open during a scan upload, when optimization
      completes, then the viewer's UI updates exactly as it did before this wave.

## Risks / potential issues

- **Risk:** an undiscovered consumer of `JobQueue` state exists outside the four
  surfaces named (e.g. a script in `scripts/`). — **Mitigation:** the Definition of
  Done requires a full-repo grep as a closing check, not an assumption.
- **Risk:** the translation function silently drops a field the viewer actually reads
  (only spotted at runtime). — **Mitigation:** the acceptance criteria's manual
  viewer-open verification is a real end-to-end check, not just a unit test on the
  translator.

## Subtasks

1. [ ] Write `worldJobToLegacyJob()` per ADR 0002's mapping.
2. [ ] Re-point `GET /jobs`, `GET /jobs/:id`, `GET /scans`'s job-status field.
3. [ ] Fire `'job-update'` for optimize-scan WorldJob transitions alongside the
       existing `'world-job-update'`.
4. [ ] Grep for any other `JobQueue` consumer; resolve or scope in.
5. [ ] Run full verification, including a manual viewer-open check.
