> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/worldjob-runner-hardening`
> **Commit style:** `refactor(jobs): give the WorldJob runner crash recovery and single-flight`
> **Design:** implements ADR 0002 (`docs/adr/0002-merged-job-system.md`) — do not start
> until that ADR is accepted; this ticket's schema section defers to it
> **Dependencies:** 0001 (hard — this is its first implementation ticket)

## Goal

Today `completeJobSoon()` (`main.ts:1580`) runs every WorldJob immediately and
concurrently via `setTimeout(..., 25)`, with no boot-time recovery for jobs stuck in
`processing` when the process dies. Give the WorldJob runner the three guarantees
`jobs.ts`'s `JobQueue` already has — **before** `optimize-scan` moves onto it in 0003
— so the merge is a strict upgrade, not a regression during the transition window.

## Non-goals

- Do not port `optimize-scan` itself in this ticket — that's 0003, and it must land
  against an already-hardened runner.
- Do not change any `WorldJobType`'s actual work (lingbot-map/splat-*/memory-push
  logic) — only the dispatch/scheduling wrapper around them.
- Do not add cross-process or multi-worker coordination — single-process,
  single-flight, matching ADR 0002's decision.

## Pinned conventions

- Per ADR 0002 (0001's deliverable): [recovery algorithm, status vocabulary, and
  single-flight scope are specified there — implement exactly what it says. If this
  ticket is started before 0002's ADR exists, stop and escalate; do not improvise.]
- Existing pattern to mirror: `jobs.ts`'s `_pump()` loop and `init()` — read them as
  the reference implementation for "how a persisted, recovering, single-flight queue
  looks in this codebase," even though the merged version persists via `saveWorld()`
  across potentially many world JSON files instead of one `jobs.json`.

## Before implementation

- `jobs.ts` in full (the reference implementation).
- `main.ts`'s `completeJobSoon()` and every `_run*Job` function.
- `main.ts`'s server-boot sequence (where `jobQueue.init()` is currently called) — the
  new WorldJob recovery pass hooks in alongside it.
- ADR 0002's recovery-algorithm and single-flight-scope decisions.

## Open questions & answers

- Q: How does boot-time recovery find `processing` jobs across potentially many
  worlds when `WORLDS_DIR` may hold many world JSON files? — A: iterate
  `WORLDS_DIR` the same way `main.ts` already does for `GET /worlds` (reuse that
  listing logic, don't add a second directory-scan implementation — ADR 0001).

## Files impacted

- Changed: `main.ts` (`completeJobSoon()` replaced by a real queue; new boot-time
  recovery pass)

## Schema required

Per ADR 0002. At minimum: an in-process queue structure (module-level, mirroring
`jobs.ts`'s `_jobs`/pump pattern) that serializes execution across all worlds, plus
whatever recovery-state fields ADR 0002 specifies (e.g. reusing `WorldJob.result` for
a "requeued after restart" note, per that ADR's Open Questions answer).

## Definition of Done

- [ ] At most one `WorldJob` is `processing` at a time, globally, across all worlds.
- [ ] A `WorldJob` left `processing` when the process is killed is recovered on next
      boot per ADR 0002's algorithm (requeued or failed, as specified — not left
      stuck forever).
- [ ] `GET /worlds/:slug/jobs` and the `'world-job-update'` event stream are unchanged
      in shape — only scheduling behavior changes, not the API surface.
- [ ] Existing splat-train/detect/finish/lingbot-map/memory-push behavior is
      unaffected when run one at a time (the common case today).

## Tests

- [ ] `deno task check` passes.
- [ ] `deno task test` passes (existing splat_*/lingbot_map/memory_push tests must
      still pass against the new dispatch wrapper).
- [ ] New test: enqueue two WorldJobs back to back; assert the second doesn't start
      `processing` until the first reaches a terminal state.
- [ ] New test (or documented manual repro): kill the process mid-job (simulate by
      writing a world JSON with a job stuck in `processing` and an old `updatedAt`),
      restart, confirm recovery fires per ADR 0002.

```
deno task check
deno task test
```

## Acceptance Criteria

- [ ] Given two WorldJobs queued in quick succession, when the first is still
      running, then the second does not begin executing until the first finishes.
- [ ] Given a world JSON with a job stuck in `processing` from a previous process,
      when the server boots, then that job is recovered exactly as ADR 0002 specifies
      — never left silently stuck.

## Risks / potential issues

- **Risk:** serializing all WorldJob types through one global queue could stall an
  unrelated cheap job (e.g. a future `extract-layers`) behind a slow splat-train.
  — **Mitigation:** this matches `JobQueue`'s existing accepted tradeoff (concurrency
  1 "since the box also runs VLM inference") — same box, same constraint; not a new
  regression, and 0003 inherits it deliberately.
- **Risk:** the recovery pass mis-identifies a legitimately still-running job (e.g.
  server restarted very quickly) as stuck. — **Mitigation:** ADR 0002 must specify a
  staleness threshold or an unconditional restart-implies-not-running assumption
  (single-process server, so any `processing` job found at boot genuinely died with
  the old process) — confirm this reasoning holds and note it in the ADR if not
  already explicit.

## Subtasks

1. [ ] Implement the module-level single-flight queue wrapping `completeJobSoon`'s
       current dispatch logic.
2. [ ] Implement the boot-time recovery pass per ADR 0002.
3. [ ] Add the two new tests (single-flight ordering, recovery).
4. [ ] Run full verification, including existing splat/lingbot/memory-push suites.
