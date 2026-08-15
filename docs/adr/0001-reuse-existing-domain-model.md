# 0001. Reuse existing schema, variables, and connections — organize around things and places

- **Status:** Accepted
- **Date:** 2026-08-15
- **Related issue:** N/A — workspace policy, not a GitHub issue. See
  `docs/factory/foundation-updates/` for the review that surfaced this.

## Context

A full feature/schema/config-variable/connection map of this repo (built by reading
the source directly, not the docs) surfaced two concrete cases of the same mistake: a
piece of new work was built as a parallel system instead of extending what already
existed.

1. **Two unrelated types are both named `ScanManifest`** — a flat one in `jobs.ts`
   (the GLB-optimizer's output record) and a much richer one in `src/world/types.ts`
   (a scan's place inside a World). They share a name and nothing else; confusing them
   is an easy, silent bug.
2. **Two entirely separate job-queue systems exist side by side** — `jobs.ts`'s
   `JobQueue` (single job type: `optimize-scan`, on raw GLBs) and the `WorldJob`
   system defined in `main.ts` / `src/world/types.ts` (`ingest`,
   `lingbot-map-reconstruct`, `splat-train`/`splat-detect`/`splat-finish`,
   `memory-push`). Neither knows the other exists. A contributor adding a new
   background job has to already know which of the two systems to extend, because
   nothing in the code says "there are two."

Both are the same root cause: a new need showed up, and rather than extending the
existing schema, queue, or connection, a parallel one was created next to it. The
codebase is small enough right now that this is still findable by reading the source;
it will not stay that way.

The domain this app models is genuinely simple at its core: **places** (a World, a
Scan's position and metadata, a capture Session, a GeoPose) contain **things** (a
detected object, a placed furniture item, a 3D bounding box). Every feature — capture,
inference, reconstruction, the viewer — exists to either locate a *thing* inside a
*place*, or to improve the fidelity of a *place's* own representation. Treating it as
anything more fragmented than that is what produced the two examples above.

## Decision

We will treat this repo as one cohesive system organized around **things** and
**places**, and require new work to **reuse** the existing schema, config variables,
and connections already documented, rather than create parallel ones for convenience.

Concretely:

- Before adding a new TypeScript type, config env var, job type, or client↔server
  connection, **search for an existing one that already does the job**
  (`grep`/`Glob` across `src/world/types.ts`, `main.ts`, and the relevant subsystem
  file first — not just a naming-convention guess).
- New background job types extend the `WorldJob` system (`src/world/types.ts`'s
  `WorldJobType` + `main.ts`'s `completeJobSoon()` dispatch) — not `jobs.ts`'s
  `JobQueue`, which stays scoped to `optimize-scan` only, and not a third system.
- New "thing" data (a detected/placed object) extends `WorldDetection`
  (`src/spatial/resolver.ts`) or the `DetectObject`/`FurnitureItem` shapes already in
  use — not a new parallel object-record type.
- New "place" data (a scan, a session, a world) extends `ScanManifest`,
  `WorldProject`, `GeoPose`, or `LocalFrame` in `src/world/types.ts` — not a new
  manifest type, and never reuse the name `ScanManifest` for anything that isn't that
  exact shape.
- Every Factory ticket that touches schema, config, or a client↔server connection
  must cite this ADR in its **Pinned conventions** section and state which existing
  type/queue/route it is extending — "N/A, this is new" is only acceptable when a real
  search turned up nothing to reuse, and the ticket must say what was searched.

## Consequences

- **Easier:** fewer silent naming collisions; a contributor (human or model) has one
  place to look for "how does a background job work here" instead of two.
- **Harder:** some future features will feel like they don't quite fit the existing
  `WorldJob`/`WorldDetection`/`ScanManifest` shapes and will need a real extension (a
  new field, a new `WorldJobType` member) instead of a quick bolt-on. That friction is
  intentional — it's the cost of not adding a third parallel system.
- **Follow-up:** `jobs.ts`'s `JobQueue` and the `WorldJob` system are not being
  unified by this ADR — that would be a larger, separate migration. This ADR only
  stops a *third* system from appearing, and requires new work to join one of the two
  existing ones deliberately, not by accident.
- **Revisit this ADR** if `jobs.ts`'s `JobQueue` and `WorldJob` are ever actually
  merged — at that point the "extend WorldJob, not JobQueue" guidance above becomes
  moot and should be rewritten.
