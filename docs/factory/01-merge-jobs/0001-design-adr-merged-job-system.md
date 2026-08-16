> **Type:** Docs / Design
> **Wave:** 01-merge-jobs
> **Branch:** `docs/merged-job-system-adr`
> **Commit style:** `docs(adr): design the merged WorldJob/JobQueue system`
> **Design:** this ticket *produces* the design (a new ADR) — no prior doc to link
> **Dependencies:** None — this ticket blocks every other ticket in the wave

## Goal

Before any code moves, write **ADR 0003** (`docs/adr/0003-merged-job-system.md`)
specifying exactly how `jobs.ts`'s `JobQueue` (`optimize-scan` only) and `main.ts`'s
`WorldJob` system merge into one, with the WorldJob system as the canonical survivor.
The ADR is the deliverable; it must be precise enough that tickets 0002-0005 require
no further design decisions, only implementation.

*(Numbered 0003, not 0002 — foundation-updates' own `0005-shared-manifest-envelope`
ticket independently claimed `docs/adr/0002-*.md` for an unrelated ADR, "Shared types
importable by the browser must live in Deno-API-free files", which landed Accepted
shortly after this wave was first drafted. Confirm `0003` is still free — check
`docs/adr/README.md`'s index — before writing the file, in case another ADR lands
first.)*

## Non-goals

- Do not write or change any implementation code in this ticket — ADR only.
- Do not decide to distribute or parallelize job execution — the merged system stays
  single-process, single-flight (matching `JobQueue`'s current guarantee).
- Do not remove the placeholder `WorldJobType`s with no dedicated runner — document
  them as out of scope for this merge, pending an owner decision. Verified
  2026-08-15: this is seven types, not five — `extract-layers`, `align-scan`,
  `merge-points`, `semantic-pass`, `depth-reconstruct` have no `_run*Job` function at
  all, and `ingest`/`export-world` are the same shape (generic placeholder branches in
  `jobResultFor`/`jobArtifactsFor`, no dedicated runner, no active producer anywhere in
  `src/`) even though they're easy to miss since they sound implemented. The ADR
  should say what happens to all seven, not just the original five.

## Pinned conventions

- ADR 0001 (`docs/adr/0001-reuse-existing-domain-model.md`): this *is* the "join one
  of the two existing systems deliberately" work it named as a follow-up. Cite it.
- ADR template: `docs/adr/0000-adr-template.md` (Status/Date/Related issue,
  Context/Decision/Consequences).
- The guarantee table in the wave README ("What must not regress") is the floor,
  verified against source on 2026-08-15/16 (re-verified 2026-08-15 after
  foundation-updates landed — line numbers refreshed, no claim invalidated) — the ADR
  must account for every row, not silently drop one.

## Before implementation

Read in full: `jobs.ts` (`Job`, `JobStatus`, `MAX_JOB_HISTORY`, `init()`, the pump
loop, `enqueue()`'s dedupe check), `src/world/types.ts`'s `WorldJob`/`WorldJobType`/
`WorldJobStatus`, and `main.ts`'s `completeJobSoon()` (~line 1585) plus every
`_run*Job` function it dispatches to.

## Open questions & answers

- Q: Does `WorldJob` gain a `note`-equivalent field (`Job.note`, e.g. "requeued after
  restart", or `jobs.ts`'s human-readable size-reduction summary)? — A: Yes —
  `WorldJob.result: string` already exists and is the natural home; the ADR must say
  so explicitly so 0002 doesn't invent a second field.
- Q: Where does WorldJob-level persistence (currently: whole `WorldProject` JSON,
  including the `jobs` array, rewritten via `saveWorld()` on every transition) get its
  boot-time recovery hook? — A: the ADR must specify where a Deno-side "on boot, for
  every persisted world, find jobs in `status==='processing'` and requeue or fail
  them" pass lives (a new function called once at server startup, alongside the
  existing `jobQueue.init()` call site) — decide and write it into the ADR, don't
  leave it open for 0002.
- Q: Single-flight scope — one queue across ALL worlds, or one per world? — A: one
  queue across all worlds, matching `JobQueue`'s current global (not per-scan)
  single-flight; splat-train genuinely holds one GPU regardless of which world asked.
  Write this into the ADR's Decision section explicitly.

## Files impacted

- New: `docs/adr/0003-merged-job-system.md`
- Changed: `docs/adr/README.md` (index entry)

## Schema required

The ADR must specify, exactly:
- The unified `WorldJobType` union (does `'optimize-scan'` get added? under what
  name — reuse the existing string per ADR 0001, or is there a collision to avoid?).
- The unified status vocabulary (`WorldJobStatus` is `queued|processing|completed|
  failed` vs `Job`'s `queued|running|done|error` — pick one; recommend keeping
  `WorldJobStatus`'s names since it's the survivor, and specify the exact mapping
  table old→new for 0004's shim).
- Which `WorldJob` fields carry `Job`'s `startedAt`/`finishedAt` (likely `createdAt`/
  `updatedAt` already cover this — confirm or add fields).
- The recovery-on-boot algorithm (what happens to a `processing` job found at boot:
  requeue to `queued`, or fail immediately with a "process restarted" error — pick
  one and justify it against `optimize-scan`'s current "requeued after restart"
  behavior, which assumes requeue-not-fail is safe for that job type; splat-train may
  differ since a partial GPU run isn't cheaply resumable — the ADR should say whether
  recovery is requeue-always or type-dependent).

## Definition of Done

- [ ] ADR 0003 is written, accepted, and answers every Open Question above inline.
- [ ] The guarantee table from the wave README is fully mapped: for each row, the ADR
      states which field/mechanism in the merged system provides it.
- [ ] ADR 0003 is linked from `docs/adr/README.md`'s index.
- [ ] Tickets 0002-0005 are reviewed against the finished ADR and need no design
      decisions of their own during implementation (mechanical fixups only).

## Tests

- [ ] N/A — no code. Verification is a re-read: walk `jobs.ts` line by line and
      confirm every behavior it implements has an explicit answer in the ADR.

## Acceptance Criteria

- [ ] Given the finished ADR, when someone implements 0002 without talking to anyone,
      then every design choice they'd otherwise have to guess at is already answered.

## Risks / potential issues

- **Risk:** rushing this ADR to "unblock the wave" produces a design with gaps that
  surface mid-implementation, costing more time than the extra hour here would.
  — **Mitigation:** the Definition of Done requires an explicit line-by-line
  guarantee-table check, not just "looks reasonable."
- **Risk:** recovery semantics differ legitimately by job type (cheap GLB optimize vs
  expensive GPU splat-train), and a one-size-fits-all "always requeue" is wrong.
  — **Mitigation:** the Schema Required section requires the ADR to explicitly decide
  requeue-always vs type-dependent, not default silently.

## Subtasks

1. [ ] Read all source listed in Before Implementation.
2. [ ] Draft ADR 0003 answering every Open Question and covering the guarantee table.
3. [ ] Self-review against the Definition of Done checklist.
4. [ ] Add the ADR to `docs/adr/README.md`'s index.
