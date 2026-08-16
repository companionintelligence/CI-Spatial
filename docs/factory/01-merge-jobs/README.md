# Wave: 01-merge-jobs

Merge the two background-job systems into one. Today `jobs.ts`'s `JobQueue` (single
job type: `optimize-scan`) and the `WorldJob` system in `main.ts` (ingest,
lingbot-map-reconstruct, splat-train/detect/finish, memory-push, and five
placeholder types) run side by side: different status vocabularies, different
persistence, different events, different API routes, and neither knows the other
exists. ADR 0001 stopped a *third* system from appearing and deferred this merge as
this actual merge — a migration with crash-recovery semantics to preserve, not a
cleanup — to a follow-up wave. This wave is that migration.

**Canonical survivor: the WorldJob system** — it's the richer model (12 types,
artifacts, progress, per-world scoping, capability-token auth) and ADR 0001 already
directs new job types there. `optimize-scan` becomes a `WorldJobType`; `JobQueue` is
retired.

## What must not regress (verified 2026-08-15/16)

| Guarantee | Where it lives today | Status in the other system |
|---|---|---|
| Crash recovery: `running` jobs re-queued on boot | `jobs.ts:76-79` (`init()`, note "requeued after restart") | **Absent** — a WorldJob stuck in `processing` when the process dies stays `processing` forever (`main.ts` has only in-run catch→`failed`, e.g. lines 1751-1765 for lingbot-map, and equivalent blocks for splat-train/detect/finish) |
| Single-flight concurrency (box also runs the VLM) | `jobs.ts` pump loop, concurrency 1 by design | **Absent** — every `completeJobSoon()` (`main.ts:1585`) runs immediately and concurrently |
| Dedupe: no duplicate queued/running job for same type+target | `jobs.ts:90` | Absent |
| Bounded history (MAX_JOB_HISTORY=200) | `jobs.ts:44` | Unbounded (jobs array grows inside the world JSON) |
| Auto-enqueue on `/upload-scan`, `/scans/:filename/optimize`, `/sessions/:id/finalize` | `main.ts` → `jobQueue.enqueue` | n/a — must re-point to the merged system |
| `/jobs`, `/jobs/:id`, and per-scan job status in `GET /scans` | `main.ts` → `JobQueue` accessors | n/a — back-compat shims required |
| `'job-update'` event (viewer listens at `src/viewer/viewer.ts:2590`) | `jobs.ts:213` | `'world-job-update'` — both consumed by the same viewer switch |

Since this table was first drafted, foundation-updates/0006 (merged) routed both event
names through `src/shared/events.ts`'s `EVENT.JOB_UPDATE`/`EVENT.WORLD_JOB_UPDATE`
constants instead of raw string literals — the wire values are unchanged
(`EVENT.JOB_UPDATE === 'job-update'`), but 0004's shim must key off the constant, not
grep for the string.

The merged system must have **all** of the left column. Several are upgrades the
WorldJob side gains for free (crash recovery and single-flight fix real gaps for
splat-train, which holds a GPU for minutes).

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [design-adr-merged-job-system](0001-design-adr-merged-job-system.md) | ADR: field/status mapping, persistence, recovery, event plan — the contract every later ticket implements |
| 0002 | [worldjob-runner-hardening](0002-worldjob-runner-hardening.md) | Give the WorldJob runner JobQueue's guarantees: boot recovery, single-flight, dedupe, bounded history |
| 0003 | [port-optimize-scan-to-worldjob](0003-port-optimize-scan-to-worldjob.md) | `optimize-scan` becomes a `WorldJobType`; the three auto-enqueue routes re-point |
| 0004 | [legacy-api-and-event-shims](0004-legacy-api-and-event-shims.md) | `/jobs`, `/jobs/:id`, `GET /scans` job fields, and the `'job-update'` event keep working unchanged |
| 0005 | [retire-jobqueue](0005-retire-jobqueue.md) | One-shot `jobs.json` migration, delete `JobQueue`, update docs |

## Execution order & parallelization

This wave is **mostly serial by design** — each ticket builds on the previous
contract:

```
0001 (design/ADR — everything blocks on it)
  └─ 0002 (runner hardening)
       └─ 0003 (port optimize-scan — needs the hardened runner so guarantees hold)
            └─ 0004 (shims — needs the new job shape to map from)
                 └─ 0005 (retirement — needs shims proven so nothing consumes JobQueue)
```

The only safe parallelism: **0004's shim design can be drafted alongside 0002/0003**
(it's mapping logic), but its implementation lands after 0003. Do not parallelize
0002 and 0003 — both edit the `completeJobSoon()` dispatch region of `main.ts`.

This wave should not run concurrently with foundation-updates **0006**
(`shared-event-type-constants`) or **0010** (`VITE_PORT`) — all touch `main.ts`.
Recommended: land foundation-updates Batches A–C first, then start this wave.
`02-typed-event-payloads` is sequenced after this wave (its payload types must
describe the *merged* job events, not the two legacy shapes).

**Status: unblocked.** foundation-updates fully landed 2026-08-16 (all 11 tickets,
PRs #68/#71/#73/#76), including 0006 and 0010 above — this wave is clear to start.

## Pre-flight check — 2026-08-15

Before starting 0001, this wave's citations were re-verified against current source
(foundation-updates had rewritten parts of `jobs.ts`/`main.ts`/`src/viewer/viewer.ts`
after these tickets were drafted). Two things were found and fixed across this README
and all five tickets:

- **ADR-number collision (the real blocker):** every ticket cited `ADR 0002`
  (`docs/adr/0002-merged-job-system.md`) as the design doc 0001 produces. That slot was
  independently claimed ~45 minutes after this wave was drafted by foundation-updates'
  own `0005-shared-manifest-envelope` ticket, whose ADR landed as
  `docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`
  (Accepted). All references in this wave now point to **ADR 0003** instead — the next
  free slot.
- **Drifted line numbers:** foundation-updates 0010 added lines above `completeJobSoon()`
  in `main.ts` (now line 1585, was 1580) and the catch→`failed` blocks below it (now
  ~1751-1765 per job type); foundation-updates 0006 added an import line to
  `src/viewer/viewer.ts`, shifting its `'job-update'` branch from 2589 to 2590. All
  citations in this wave's tickets have been updated. No underlying claim was
  invalidated — every guarantee/gap in the table above still holds exactly as stated.

## Explicitly deferred

- Distributed/multi-worker execution (`WorldJob.workerId`/`capabilities` hint at it) —
  the merged runner stays single-process, single-flight.
- Removing the five placeholder `WorldJobType`s that have no runner
  (`extract-layers`, `align-scan`, `merge-points`, `semantic-pass`,
  `depth-reconstruct`) — ticket 0001 documents them; removal is an owner call.
