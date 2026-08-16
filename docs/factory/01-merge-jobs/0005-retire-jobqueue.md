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
  (ADR 0001: one conversion path, not two).
- Historical jobs.json entries map to whichever world currently references their
  `target` scan filename; a job for a scan not in any world's `scans[]` (deleted
  scan) is migrated as an orphaned record or dropped — ADR 0003 must have specified
  which; if it didn't, resolve here and note the decision in Open Q&A.

## Before implementation

- `jobs.ts`'s `init()` and persistence format (`<scansDir>/jobs.json`) — the exact
  on-disk shape being migrated away from.
- Confirm 0004 shipped and its acceptance criteria hold in this codebase state before
  starting (grep `JobQueue`/`jobQueue\.` — every remaining reference is what this
  ticket removes).

## Open questions & answers

- Q: What happens to a `jobs.json` job whose target scan file no longer exists on
  disk? — OPEN if ADR 0003 didn't cover it; resolve here (recommend: log and skip,
  don't fail the migration) and record the decision.

## Files impacted

- Changed: `main.ts` (delete `JobQueue` instantiation/boot wiring, now fully replaced
  by 0002's hardened WorldJob runner)
- Changed or deleted: `jobs.ts` (per Non-goals — keep if anything else still imports
  from it, otherwise delete)
- New: a one-shot migration script (e.g. `scripts/migrate-jobs-to-worldjob.mjs` or a
  `--migrate-jobs` server flag — implementer's call, record which)
- Changed: `CLAUDE.md`/ADR 0001 — update the "two job systems" language now that
  there's one; do not delete the historical record of why this merge happened,
  reframe it as resolved. (Verified 2026-08-15: `docs/FACTORY.md` itself has no
  job-system language to update — drop it from this bullet if it's still here when
  you re-check.)
- Changed: `src/shared/events.ts` — foundation-updates/0006 (landed after this ticket
  was drafted) added doc comments there describing `JobQueue` as `JOB_UPDATE`'s live
  producer in the present tense; update to past tense alongside CLAUDE.md/ADR 0001, or
  the Acceptance Criteria's "zero hits outside historical docs/ADRs" grep will still
  find a live-code hit.

## Schema required

None new — the migration writes existing `WorldJob` shape; no format changes.

## Definition of Done

- [ ] `jobs.ts`'s `JobQueue` class no longer exists (or the file is deleted entirely,
      per what Before-implementation's grep found).
- [ ] A pre-migration `jobs.json` (with at least one `done` and one `error` entry) is
      migrated into the correct world(s)' `WorldJob` arrays with no data loss for
      entries whose target scan still exists.
- [ ] `main.ts` boots cleanly with no `JobQueue` references anywhere.
- [ ] `CLAUDE.md` and ADR 0001 are updated to reflect the merge is complete (past
      tense), not still describing two live systems.

## Tests

- [ ] `deno task check` passes.
- [ ] `deno task test` passes with no `jobs.ts`-specific test files remaining unless
      `jobs.ts` itself remains for a legitimate reason (Non-goals).
- [ ] Migration test: run the migration script against a fixture `jobs.json` +
      matching world JSON, assert the resulting world JSON contains the expected
      `WorldJob` entries.
- [ ] Full regression: `npm run test:box` (the isolated CI loop) passes end to end.

```
deno task check
deno task test
npm run test:box
```

## Acceptance Criteria

- [ ] Given a production-shaped `jobs.json` with historical entries, when the
      migration runs, then every entry whose target scan still exists appears as a
      `WorldJob` in the correct world, and the process is idempotent (running it
      twice does not duplicate entries).
- [ ] Given the merge is complete, when a developer greps the repo for `JobQueue`,
      then there are zero hits outside historical docs/ADRs explicitly describing the
      old system in the past tense — this includes `src/shared/events.ts`'s doc
      comments (added by foundation-updates/0006), not just `CLAUDE.md`/ADR 0001.

## Risks / potential issues

- **Risk:** silent data loss if the migration mis-maps a job to the wrong world or
  drops one. — **Mitigation:** the migration test above uses a real fixture with
  known expected output, and the script logs every migrated/skipped entry so a
  human can audit the log before trusting the deletion of `jobs.json`.
- **Risk:** deleting `jobs.ts` breaks an import this ticket's grep missed.
  — **Mitigation:** `deno task check` (a full type-check) catches any broken import
  immediately — treat a check failure here as a real signal, not noise to silence.

## Subtasks

1. [ ] Write the one-shot migration script/flag.
2. [ ] Write the migration test with a real fixture.
3. [ ] Run the migration test; verify idempotency (run twice, diff).
4. [ ] Remove `JobQueue` wiring from `main.ts`; delete or trim `jobs.ts` per
       Non-goals.
5. [ ] Update `CLAUDE.md` and ADR 0001 to past tense.
6. [ ] Run full verification including `npm run test:box`.
