> **Type:** Backend
> **Wave:** 01-merge-jobs
> **Branch:** `refactor/retire-jobqueue`
> **Commit style:** `refactor(jobs): migrate jobs.json, delete JobQueue`
> **Design:** implements ADR 0003 (`docs/adr/0003-merged-job-system.md`)
> **Dependencies:** 0004 (hard — nothing may still read `JobQueue` before this lands)

## Goal

With optimize-scan running through `WorldJob` (0003) and every external surface
shimmed (0004), retire `jobs.ts`'s `JobQueue` for real: a one-shot migration of any
`<scansDir>/jobs.json` history into the corresponding worlds' `WorldJob` arrays (so
historical job records aren't silently lost on upgrade), then delete the class and
its call sites.

## Non-goals

- Do not delete `jobs.ts` itself if `pipeline.ts` or anything else still imports from
  it beyond `JobQueue`/the legacy `Job`/`OptimizeScanManifest` types — check first.
  If nothing else lives there, delete the file; if something does, keep it and strip
  only the retired pieces.
- Do not delete `OptimizeScanManifest` (renamed from `ScanManifest` in
  foundation-updates/0003) — it's still the on-disk artifact-index shape 0003's
  `_runOptimizeScanJob` writes; only the *queue* is retired, not the manifest format.
- Do not run the migration automatically on every boot — it's a one-shot, explicitly
  invoked script/task, not a startup hook (avoid re-migrating or double-counting on
  every restart).

## Pinned conventions

- Migration output must match the `WorldJob` shape 0003 already produces for new
  optimize-scan jobs — reuse `worldJobToLegacyJob()`'s inverse (or write the mirror
  function) so migrated and newly-created jobs are indistinguishable in shape
  (ADR 0001: one conversion path, not two). Implemented as `worldJobFromLegacyJob()`
  in `migrate_jobs.ts`.
- **Correction (implementation time):** the line below — "map to whichever world
  currently references their target scan filename" — predates ADR 0003 actually
  settling the "which world" question. ADR 0003's own "Which world does an
  optimize-scan WorldJob belong to?" section (written after this ticket was
  drafted) is unambiguous: every `optimize-scan` `WorldJob`, new or migrated, is
  parked under the `'default'` world — the only world `GET /jobs`/`GET /jobs/:id`
  (ticket 0004's shim) ever reads. Mapping migrated jobs to "whichever world
  references the scan" instead would silently orphan them from that shim. Resolved
  in favor of ADR 0003's actual decision, not the speculative draft below — see
  `migrate_jobs.ts`'s header comment for the full reasoning.
- ~~Historical jobs.json entries map to whichever world currently references their
  `target` scan filename; a job for a scan not in any world's `scans[]` (deleted
  scan) is migrated as an orphaned record or dropped — ADR 0003 must have specified
  which; if it didn't, resolve here and note the decision in Open Q&A.~~ Superseded
  by the correction above (world) and the Open Q&A answer below (missing scan).

## Before implementation

- `jobs.ts`'s `init()` and persistence format (`<scansDir>/jobs.json`) — the exact
  on-disk shape being migrated away from.
- Confirm 0004 shipped and its acceptance criteria hold in this codebase state before
  starting (grep `JobQueue`/`jobQueue\.` — every remaining reference is what this
  ticket removes).

## Open questions & answers

- Q: What happens to a `jobs.json` job whose target scan file no longer exists on
  disk? — **A (resolved):** ADR 0003 does not cover migration at all (it's silent on
  `jobs.json`/migration by design — that's this ticket's exclusive concern per the
  ADR's own "Follow-up" list). Adopted this ticket's own recommended resolution
  verbatim: logged and skipped, not migrated as an orphaned record. Implemented in
  `migrate_jobs.ts`'s `migrateJobsToWorldJob()` — a `Deno.stat()` check on
  `<scansDir>/<target>` before migrating; a miss is pushed to
  `summary.skippedMissingScan` and logged, the migration continues, and the run
  never fails because of it. Covered by
  `migrate_jobs.test.ts`'s "skips the one with a deleted target scan" case.
- Q: Which world does a migrated job land in? — **A (resolved, not originally asked
  here but forced by the Pinned Conventions correction above):** always `'default'`,
  matching ADR 0003's `enqueueOptimizeScanJob` precedent exactly — not "whichever
  world references the scan." See the Pinned Conventions correction above.

## Files impacted

- Changed: `main.ts` (deleted `JobQueue` instantiation/boot wiring — the
  `const jobQueue = new JobQueue(...)` / `await jobQueue.init()` lines and the
  `JobQueue`/`Job`/`JobStatus`/`OptimizeScanManifest` import, trimmed to a
  type-only import of the three surviving types — now fully replaced by 0002's
  hardened WorldJob runner, which was already the only thing actually processing
  jobs as of ticket 0003).
- Changed (kept, trimmed — not deleted): `jobs.ts`. Grepped the full repo:
  `main.ts` is the only importer, and it still needs the `Job`/`JobStatus`/
  `OptimizeScanManifest` type definitions (the `/jobs` shim's translation target
  and the on-disk manifest shape) — per Non-goals, that means "keep it and strip
  only the retired pieces," not delete the file. Stripped: the `JobQueue` class,
  `MAX_JOB_HISTORY`, and the `pipeline.ts`/`events.ts` imports it alone needed.
  Kept: `JobStatus`, `Job`, `OptimizeScanManifest`.
- New: a one-shot migration **script**, `migrate_jobs.ts` (Deno TypeScript, run via
  `deno run --allow-read --allow-write --allow-env migrate_jobs.ts` or
  `deno task migrate-jobs`) — not a server flag, so it stays fully decoupled from
  `main.ts`'s boot path per the Non-goals' "not a startup hook." Exports
  `migrateJobsToWorldJob()`/`worldJobFromLegacyJob()` for the unit/fixture tests in
  `migrate_jobs.test.ts`.
- Changed: `CLAUDE.md`/ADR 0001 — updated the "two job systems" language to past
  tense; historical record kept, reframed as resolved (both cite ADR 0003 and
  ticket 0005). `docs/FACTORY.md` confirmed to still have no job-system language —
  left untouched, per the pre-flight note.
- Changed: `src/shared/events.ts` — both the file-header note and `JOB_UPDATE`'s own
  doc comment updated to past tense (no `JobQueue`-as-current-producer language
  remains; `JOB_UPDATE` now has exactly one described producer, `main.ts`'s
  `broadcastLegacyJobUpdate`).

## Schema required

None new — the migration writes existing `WorldJob` shape; no format changes.

## Definition of Done

- [x] `jobs.ts`'s `JobQueue` class no longer exists (the file is kept, per
      Before-implementation's grep — `main.ts` still needs the `Job`/`JobStatus`/
      `OptimizeScanManifest` types — but only those three type/interface
      definitions remain; the class, `MAX_JOB_HISTORY`, and its `pipeline.ts`/
      `events.ts` imports are gone).
- [x] A pre-migration `jobs.json` (one `done` entry, one `error` entry, plus a third
      entry whose target scan is deliberately missing) is migrated into the
      `'default'` world's `WorldJob` array with no data loss for the two entries
      whose target scan still exists — verified in
      `migrate_jobs.test.ts`'s fixture test (asserts both entries land with the
      correct `status`/`payload.filename`/`error`/`result`).
- [x] `main.ts` boots cleanly with no `JobQueue` references anywhere. Verified: `deno
      task check` passes, and a live isolated-server boot (`PORT=8100
      TAILSCALE_HOSTNAME=localhost INFERENCE_MODE=mock`) came up healthy with no
      `JobQueue`-related errors; `grep -n "new JobQueue\|jobQueue\."` across `main.ts`
      returns nothing (only historical/provenance comments mentioning the retired
      class by name remain, e.g. "mirrors the retired JobQueue's ... pattern").
- [x] `CLAUDE.md` and ADR 0001 are updated to reflect the merge is complete (past
      tense), not still describing two live systems. Both now say the two
      job-queue systems *used to* exist side by side and cite ADR 0003 / this
      ticket for the merge; ADR 0001's own "Revisit this ADR if ... merged" note is
      answered inline as "Revisited 2026-08-16."

## Tests

- [x] `deno task check` passes — clean, no errors.
- [x] `deno task test` — 95 passed, 9 failed, 1 ignored (105 total: the 98 from
      before this ticket + `migrate_jobs.test.ts`'s new 7 tests). All 9
      failures are the *same* pre-existing, unrelated `splat_detect.test.ts`/
      `splat_train.test.ts` failures tickets 0002/0003/0004 already documented on
      this box (Windows sandbox lacking a real python/`run_local.py` toolchain) —
      re-confirmed via `git diff 44f6c5a HEAD -- splat_detect.ts
      splat_detect.test.ts splat_train.ts splat_train.test.ts` (still empty; these
      files remain untouched by this entire wave). Every ticket-relevant suite
      passes clean: `world_job_pump.test.ts` (11/11) and the new
      `migrate_jobs.test.ts` (7/7).
- [x] Migration test: `migrate_jobs.test.ts` runs `migrateJobsToWorldJob()` against
      a real fixture `jobs.json` (one `done`, one `error`, one entry whose target
      scan is deliberately absent) + a matching `worlds/default.json` fixture in a
      temp dir, and asserts the resulting world JSON contains the two expected
      `WorldJob` entries in the exact shape `worldJobFromLegacyJob()` produces
      (status, `payload.filename`, `error`/`result` mapping), that the
      missing-scan entry is skipped and logged, and — separately — that running it
      twice does not duplicate entries (`afterSecond.jobs.length` unchanged, jobIds
      still unique). 7/7 pass standalone (`deno test --allow-read --allow-write
      --allow-env migrate_jobs.test.ts`) and inside the full `deno task test` run.
- [x] Full regression, with a caveat: the literal `npm run test:box` command fails
      in this sandbox for a pre-existing, unrelated environment reason —
      `scripts/test-box.mjs` (confirmed byte-identical to pre-wave `main` via
      `git diff 44f6c5a HEAD -- scripts/test-box.mjs`, empty) spawns `deno`/`npx` via
      Node's `child_process` without `shell: true`; on this Windows box that throws
      `ENOENT`/`EINVAL` (Node's non-shell `spawn()` can't resolve `/bin/sh` for the
      `command -v deno` probe, nor invoke the Windows `.cmd` shim for `npx`
      directly — reproduced standalone with a 3-line Node repro, independent of
      this ticket's code). Ran the **exact same isolated-server + seed + Playwright
      sequence `test-box.mjs` itself performs**, by hand: `PORT=8100
      TAILSCALE_HOSTNAME=localhost INFERENCE_MODE=mock` Deno (isolated
      `SCANS_DIR`/`WORLDS_DIR`/`SUMMARIES_DIR`), `VITE_PORT=5273` Vite,
      `scripts/seed-test-homes.mjs` (24/24 homes uploaded — each now creating its
      `optimize-scan` `WorldJob` through the post-retirement path, not `JobQueue`),
      then `playwright test --project=api --project=chromium-mock`. Result: 48
      passed, 4 flaky-then-passed-on-retry (including this wave's own
      `api-optimize-scan-worldjob.spec.ts` and `mock-optimize-scan-job-update.spec.ts`
      — the flakiness is the single global pump's ADR-0003-accepted "cheap job
      queues behind a slow one" tradeoff under this run's heavy concurrent load, not
      a new bug: `jobQueue.enqueue()` had zero call sites anywhere in the tree
      *before* this ticket touched anything, per ticket 0004's own closing grep, so
      deleting the dead instantiation cannot change any job's scheduling behavior),
      2 failed (`mock-ftue.spec.ts`, `mock-xr8-scan.spec.ts` — the exact
      already-documented pre-existing SLAM-mock-in-headless-Chromium issue from
      ticket 0004's own Tests section, re-confirmed empty-diff). One previously
      undocumented failure surfaced, `api-photo-ingest.spec.ts`'s
      `POST /ingest-photos` 500: root-caused to `main.ts`'s
      `new URL('./scripts/ingest-photos.mjs', import.meta.url).pathname` producing
      a malformed `C:\C:\...` path on Windows — confirmed pre-existing and wholly
      unrelated via `git blame`/`git diff 44f6c5a HEAD` (that line hasn't changed
      since commit `70db0af`, 2026-07-06, five weeks before this wave started).

```
deno task check
deno task test
npm run test:box
```

## Acceptance Criteria

- [x] Given a production-shaped `jobs.json` with historical entries, when the
      migration runs, then every entry whose target scan still exists appears as a
      `WorldJob` in the correct world, and the process is idempotent (running it
      twice does not duplicate entries). Verified by `migrate_jobs.test.ts`'s
      "migrates done+error entries..." and "running it twice does not duplicate
      entries (idempotent)" tests — both pass.
- [x] Given the merge is complete, when a developer greps the repo for `JobQueue`,
      then there are zero hits outside historical docs/ADRs explicitly describing the
      old system in the past tense — this includes `src/shared/events.ts`'s doc
      comments (added by foundation-updates/0006), not just `CLAUDE.md`/ADR 0001.
      Verified: `CLAUDE.md`, ADR 0001, and `events.ts` all updated to past tense
      (checked individually — see Definition of Done / Files impacted). Every
      remaining `JobQueue`/`jobQueue.` hit in `main.ts`, `jobs.ts`, and
      `world_job_pump.ts` is a comment citing the retired class as historical
      provenance for the code that replaced it (e.g. "ported near-verbatim from
      jobs.ts's JobQueue._runOptimize()"), not a live reference — no code anywhere
      constructs, calls, or type-references the `JobQueue` class itself. **Note:**
      `README.md`/`../../architecture.md` still describe `jobs.ts` as "Async Job Queue
      Coordinator"/draw `JobQueue` as a live Mermaid node in present tense — these
      were never in this ticket's (or the wave's) Files-impacted list and are out
      of the explicit scope given for this pass; flagged as follow-up doc debt in
      the implementer's closing report rather than changed here.

## Risks / potential issues

- **Risk:** silent data loss if the migration mis-maps a job to the wrong world or
  drops one. — **Mitigation:** the migration test above uses a real fixture with
  known expected output, and the script logs every migrated/skipped entry so a
  human can audit the log before trusting the deletion of `jobs.json`.
- **Risk:** deleting `jobs.ts` breaks an import this ticket's grep missed.
  — **Mitigation:** `deno task check` (a full type-check) catches any broken import
  immediately — treat a check failure here as a real signal, not noise to silence.

## Subtasks

1. [x] Write the one-shot migration script/flag. — `migrate_jobs.ts` (script,
       `deno task migrate-jobs`).
2. [x] Write the migration test with a real fixture. — `migrate_jobs.test.ts`.
3. [x] Run the migration test; verify idempotency (run twice, diff). — 7/7 pass,
       including the explicit "running it twice" test asserting an unchanged
       `world.jobs.length` and still-unique `jobId`s after a second run.
4. [x] Remove `JobQueue` wiring from `main.ts`; delete or trim `jobs.ts` per
       Non-goals. — Trimmed (kept for the still-needed legacy types); class
       removed.
5. [x] Update `CLAUDE.md` and ADR 0001 to past tense. — Both done, plus
       `src/shared/events.ts` (added to scope after this ticket was drafted, per
       foundation-updates/0006 landing later — see Files impacted).
6. [x] Run full verification including `npm run test:box`. — `deno task
       check`/`deno task test` pass (9 pre-existing/unrelated failures, evidenced);
       `npm run test:box` itself fails in this sandbox on an unrelated
       Node-spawn-on-Windows environment issue (evidenced, pre-existing), so ran
       the identical manual isolated-server + seed + Playwright sequence instead —
       see Tests section for the full breakdown.
