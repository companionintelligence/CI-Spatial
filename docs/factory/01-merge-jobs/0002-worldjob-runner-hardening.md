> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/worldjob-runner-hardening`
> **Commit style:** `refactor(jobs): give the WorldJob runner crash recovery and single-flight`
> **Design:** implements ADR 0003 (`docs/adr/0003-merged-job-system.md`) — do not start
> until that ADR is accepted; this ticket's schema section defers to it
> **Dependencies:** 0001 (hard — this is its first implementation ticket)

## Goal

Today `completeJobSoon()` (`main.ts:1585`) runs every WorldJob immediately and
concurrently via `setTimeout(..., 25)`, with no boot-time recovery for jobs stuck in
`processing` when the process dies, no dedupe, and no history cap. Give the WorldJob
runner all four guarantees `jobs.ts`'s `JobQueue` already has — crash recovery,
single-flight, dedupe, and bounded history (per the wave README's ticket table and
ADR 0003's guarantee table, both of which assign all four to this ticket) —
**before** `optimize-scan` moves onto it in 0003 — so the merge is a strict upgrade,
not a regression during the transition window.

## Non-goals

- Do not port `optimize-scan` itself in this ticket — that's 0003, and it must land
  against an already-hardened runner.
- Do not change any `WorldJobType`'s actual work (lingbot-map/splat-*/memory-push
  logic) — only the dispatch/scheduling wrapper around them.
- Do not add cross-process or multi-worker coordination — single-process,
  single-flight, matching ADR 0003's decision.

## Pinned conventions

- Per ADR 0003 (0001's deliverable): [recovery algorithm, status vocabulary, and
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
- ADR 0003's recovery-algorithm and single-flight-scope decisions.

## Open questions & answers

- Q: How does boot-time recovery find `processing` jobs across potentially many
  worlds when `WORLDS_DIR` may hold many world JSON files? — A: iterate
  `WORLDS_DIR` the same way `main.ts` already does for `GET /worlds` (reuse that
  listing logic, don't add a second directory-scan implementation — ADR 0001).

## Files impacted

- Changed: `main.ts` (`completeJobSoon()` replaced by a real queue; new boot-time
  recovery pass)

## Schema required

Per ADR 0003. At minimum: an in-process queue structure (module-level, mirroring
`jobs.ts`'s `_jobs`/pump pattern) that serializes execution across all worlds, plus
whatever recovery-state fields ADR 0003 specifies (e.g. reusing `WorldJob.result` for
a "requeued after restart" note, per that ADR's Open Questions answer).

## Definition of Done

- [x] At most one `WorldJob` is `processing` at a time, globally, across all worlds.
- [x] A `WorldJob` left `processing` when the process is killed is recovered on next
      boot per ADR 0003's algorithm (requeued or failed, as specified — not left
      stuck forever).
- [x] `GET /worlds/:slug/jobs` and the `'world-job-update'` event stream are unchanged
      in shape — only scheduling behavior changes, not the API surface.
- [x] Existing splat-train/detect/finish/lingbot-map/memory-push behavior is
      unaffected when run one at a time (the common case today). Lingbot-map,
      memory-push, and splat-finish suites are fully green; splat-detect/splat-train
      have 9 pre-existing failures in this worktree that reproduce identically with
      or without this ticket's changes (confirmed via `git stash`) — see Tests notes.
- [x] Dedupe: creating a `WorldJob` with the same `type` and target (`scanId` if set,
      else `payload.filename`) as an existing `queued`/`processing` job in the same
      world returns the existing job instead of creating a duplicate — ADR 0003
      "Dedupe", implemented in `createWorldJob()` (`main.ts`) via
      `findDuplicateWorldJob()`/`worldJobTarget()` (`world_job_pump.ts`), applied
      uniformly at every `createWorldJob` call site.
- [x] Bounded history: each world's `jobs` array is capped at
      `MAX_WORLD_JOB_HISTORY = 200`, trimming `completed`/`failed` jobs to the most
      recent 100 once exceeded (`queued`/`processing` jobs are never trimmed) — ADR
      0003 "Bounded history", implemented as `trimWorldJobHistory()`
      (`world_job_pump.ts`), applied inside `createWorldJob()` on every push.

## Tests

- [x] `deno task check` passes.
- [ ] `deno task test` passes (existing splat_*/lingbot_map/memory_push tests must
      still pass against the new dispatch wrapper). **Not fully green in this
      worktree** — 9 pre-existing failures in `splat_detect.test.ts`/
      `splat_train.test.ts` (out of 98 total tests as of the round-2 dedupe test added
      below; 88 pass, 1 ignored), all rooted in `isRunnable()`
      (`splat_train.ts`/`splat_detect.ts`) using a POSIX exec-bit check
      (`mode & 0o111`) that Windows `Deno.stat()` never sets — confirmed directly
      (`Deno.stat()` on a known-executable path on this machine returns numeric
      `mode: 33206` / `0o100666`, not `null`, so the "unsupported platform → fall back
      to exists" branch never triggers, and `0o666 & 0o111 === 0` on every file) —
      every candidate binary reports non-runnable, so those tests hit the "skipped"
      branch instead of "ok"/"error". Confirmed pre-existing and unrelated to this
      ticket two independent ways: (1) `git diff --stat -- splat_detect.ts
      splat_train.ts splat_detect.test.ts splat_train.test.ts` shows those four files
      byte-for-byte unmodified in this worktree (not in `git status --porcelain`
      either), so the identical failures are guaranteed to reproduce on the base
      commit with or without this ticket's changes; (2) `git stash` against this same
      worktree before any of this ticket's edits reproduces the same 9 failures.
      **Deliberately left unfixed** — out of scope per this ticket's Non-goals ("Do not
      change any `WorldJobType`'s actual work... only the dispatch/scheduling
      wrapper") and not covered by ADR 0003 at all (the ADR never mentions
      cross-platform runnability detection); fixing it would mean improvising a new
      design decision (how `isRunnable()` should detect executability on Windows) that
      neither the ticket nor the ADR authorizes, which this ticket's own Pinned
      Conventions says to escalate rather than improvise on. Reported here instead;
      worth its own ticket if Windows dev-machine test parity is wanted.
- [x] New test: enqueue two WorldJobs back to back; assert the second doesn't start
      `processing` until the first reaches a terminal state. (`world_job_pump.test.ts`)
- [x] New test (or documented manual repro): kill the process mid-job (simulate by
      writing a world JSON with a job stuck in `processing` and an old `updatedAt`),
      restart, confirm recovery fires per ADR 0003. Automated pure-logic test in
      `world_job_pump.test.ts` (`recoverStuckWorldJobs`) plus a live manual repro
      actually run during implementation: wrote a world JSON with a `processing` job
      and a stale `updatedAt` under a scratch `WORLDS_DIR`, booted `main.ts` against
      it, and confirmed via server log (`[world-jobs] recovered 1 stuck job(s)...`)
      and `GET /worlds/default/jobs` that the job flipped to `completed` with
      `result: "requeued after restart"` having been the intermediate state.
- [x] Dedupe + bounded-history coverage: `world_job_pump.test.ts` —
      `findDuplicateWorldJob` (scanId match, `payload.filename` fallback, and that a
      `completed`/`failed` job is never treated as a duplicate) and
      `trimWorldJobHistory` (no-op under the cap; keeps all active jobs and trims
      `completed`/`failed` to the most recent 100 once over the cap).

**Found during post-implementation adversarial review, fixed, and re-verified:**
`recoverWorldJobsOnBoot()` was originally called immediately after `jobQueue.init()`
(right where the ADR's prose places it), *before* several module-level `const`s the
seeded pump's dispatch chain can reach were initialized — `sleep` (used by the
generic 650ms placeholder-completion path), `WORLD_JOB_TYPES`,
`LINGBOT_MAP_ARTIFACTS`, the ingest script path constants, etc. Because recovery
seeds the pump synchronously and the pump's dispatch runs as a detached async chain
interleaved with the rest of top-level module evaluation, a recovered job whose
dispatch reached one of those not-yet-initialized `const`s before the module finished
loading would throw `ReferenceError: Cannot access '<name>' before initialization`
(TDZ) — silently swallowed by `_dispatchWorldJob`'s own try/catch, permanently
stranding that job in `processing` (defeating the entire point of recovery). This is
a genuine race, not deterministic: the original manual repro in this ticket happened
not to trigger it. Verified with a standalone reproduction (a minimal pump seeded
during a `for await` boot loop reliably raced ahead of a `const` declared later in
the same module and hit the identical `ReferenceError`) and fixed by moving the
`recoverWorldJobsOnBoot()` call to immediately before `Deno.serve(...)` — after every
other top-level statement has executed — which also more literally satisfies ADR
0003's actual requirement ("before the server starts accepting requests") than the
original placement did. Re-verified live: booted `main.ts` against a scratch
`WORLDS_DIR` with a `processing` job of a *placeholder* type (`extract-layers`, which
exercises the `sleep`-based generic completion path) and confirmed via server log and
`GET /worlds/default/jobs` that it reached a terminal state (no TDZ crash, no stuck
job). `deno task check` and `deno task test` re-run clean after the move (identical
87 passed / 9 failed / 1 ignored — same pre-existing, unrelated failures as before).

**Found during a second, independent adversarial review against ADR 0003, fixed, and
re-verified:**

1. `recoverWorldJobsOnBoot()` reimplemented the `WORLDS_DIR` directory-scan loop a
   third time (`for await (const entry of Deno.readDir(WORLDS_DIR)) { if
   (!entry.isFile || !entry.name.endsWith('.json')) continue; ... }`) instead of
   reusing `mutateWorldFiles()` — the existing "iterate every world file, apply logic,
   save only if changed" helper `removeScanFromWorlds`/`removeAllScansFromWorlds`
   already use. This directly contradicted this ticket's own Open Questions answer
   ("reuse that listing logic, don't add a second directory-scan implementation — ADR
   0001") and CLAUDE.md's Hard Rule. Fixed: `recoverWorldJobsOnBoot()` now calls
   `mutateWorldFiles()`, with the mutator computing `recoverStuckWorldJobs()` and
   returning whether to save; broadcasting and pump-seeding happen in a second pass
   after `mutateWorldFiles()` resolves (over a small array of `{worldId, shareSlug,
   jobs}` collected from the mutator) so every recovered job is still persisted via
   `saveWorld()` before it's broadcast or handed to the pump — preserving the
   save-before-broadcast ordering every other job transition in `main.ts` follows.
   Re-verified live the same way as the first round: booted `main.ts` against a
   scratch `WORLDS_DIR` with a stuck `processing` job and a stuck `queued` job,
   confirmed both recovered correctly via server log and `GET /worlds/default/jobs`.
2. `findDuplicateWorldJob`/`worldJobTarget` (`world_job_pump.ts`) treated any two
   queued/processing jobs of the same `type` as duplicates of each other whenever
   neither had a `scanId` nor a `payload.filename` — `worldJobTarget()` returned
   `undefined` for both, and `undefined === undefined` matched. Reachable via `POST
   /worlds/:slug/jobs` for a placeholder type (e.g. `export-world`, `ingest`) posted
   without `scanId`/`payload.filename`: a second such request would silently return
   the first job instead of creating a new one. `jobs.ts`'s original predicate never
   had this ambiguity because `Job.target` was a mandatory string. Fixed:
   `findDuplicateWorldJob()` now returns `undefined` immediately when the incoming
   `target` is `undefined` — an untargeted job is never treated as a duplicate of
   another untargeted job. New test added:
   `world_job_pump.test.ts` — "an undefined target never dedupes, even against
   another untargeted job of the same type".
3. The `deno task test` 9-failure count (`splat_detect`/`splat_train`, Windows
   `isRunnable()` exec-bit check) was independently re-confirmed pre-existing and
   out-of-scope rather than re-fixed — see the Tests section entry above for the full
   reasoning (`git diff --stat` shows the affected files byte-for-byte unmodified in
   this worktree; not covered by ADR 0003; excluded by this ticket's Non-goals).

`deno task check` and `deno task test` re-run after both fixes: identical shape,
88 passed / 9 failed / 1 ignored (one more passing test than the first round, from the
new dedupe test above) — same 9 pre-existing, unrelated `splat_detect`/`splat_train`
failures as before, nothing newly broken.

```
deno task check
deno task test
```

## Acceptance Criteria

- [x] Given two WorldJobs queued in quick succession, when the first is still
      running, then the second does not begin executing until the first finishes.
- [x] Given a world JSON with a job stuck in `processing` from a previous process,
      when the server boots, then that job is recovered exactly as ADR 0003 specifies
      — never left silently stuck.

## Risks / potential issues

- **Risk:** serializing all WorldJob types through one global queue could stall an
  unrelated cheap job (e.g. a future `extract-layers`) behind a slow splat-train.
  — **Mitigation:** this matches `JobQueue`'s existing accepted tradeoff (concurrency
  1 "since the box also runs VLM inference") — same box, same constraint; not a new
  regression, and 0003 inherits it deliberately.
- **Risk:** the recovery pass mis-identifies a legitimately still-running job (e.g.
  server restarted very quickly) as stuck. — **Mitigation:** ADR 0003 must specify a
  staleness threshold or an unconditional restart-implies-not-running assumption
  (single-process server, so any `processing` job found at boot genuinely died with
  the old process) — confirm this reasoning holds and note it in the ADR if not
  already explicit.

## Subtasks

1. [x] Implement the module-level single-flight queue wrapping `completeJobSoon`'s
       current dispatch logic.
2. [x] Implement the boot-time recovery pass per ADR 0003.
3. [x] Implement dedupe and bounded history in `createWorldJob()`, per ADR 0003
       "Dedupe" / "Bounded history" and this ticket's assignment in the wave README's
       ticket table.
4. [x] Add the new tests (single-flight ordering, recovery, dedupe, bounded history).
5. [x] Run full verification, including existing splat/lingbot/memory-push suites
       (see Tests notes above re: 9 pre-existing, unrelated splat_detect/splat_train
       failures on this Windows worktree).
6. [x] Post-implementation adversarial review against ADR 0003 (round 1): found and
       fixed a boot-recovery/module-init ordering race (see Tests notes); re-ran the
       full verification suite after the fix.
7. [x] Post-implementation adversarial review against ADR 0003 (round 2): found and
       fixed `recoverWorldJobsOnBoot()` reimplementing the `WORLDS_DIR` scan instead of
       reusing `mutateWorldFiles()`, and `findDuplicateWorldJob()` falsely deduping two
       untargeted jobs of the same type against each other (see Tests notes); confirmed
       the reported `deno task test` Windows `isRunnable()` failures are pre-existing
       and out of scope rather than a ticket defect; re-ran the full verification suite
       after both fixes.
