# Wave: 02-typed-event-payloads

Give every `/events` WebSocket message a real, discriminated-union TypeScript type —
not just the string-constant names foundation-updates/0006 gives them, but their full
payload shape, checked at both the `broadcast()` call site and every consumer switch.

## Why this is wave 02, not folded into 01-merge-jobs, and not "01"

You proposed `factory/01-typed-event-payloads/` and left the ordering to judgment.
Here's the call: **sequenced after `01-merge-jobs`, as its own wave**, for one
concrete reason — `01-merge-jobs`/0004 keeps **two** wire shapes for job events by
design (`'job-update'` stays byte-identical to the legacy `Job` shape for back-compat;
`'world-job-update'` carries the real `WorldJob`). Typing those payloads *before* the
merge means typing against `jobs.ts`'s `Job` and `main.ts`'s `WorldJob` as two
independently-evolving shapes — exactly the kind of parallel-system duplication
ADR 0001 exists to prevent. Typing them *after* the merge means both payload types
derive from one settled internal model (`WorldJob`, with `'job-update'` explicitly
documented as `worldJobToLegacyJob()`'s translation output, not a second source of
truth). Same reasoning `01-merge-jobs`'s own README already used to defer this wave —
this README just makes it a real folder instead of a forward reference.

Not folded into `01-merge-jobs` itself because it's a different kind of change (type
safety on an existing, stable wire contract) with different reviewers/timing than a
crash-recovery-sensitive backend migration — bundling them would make `01`'s already
serial, high-stakes PRs harder to review in isolation.

## Tickets

| # | Ticket | One-line goal |
|---|--------|---------------|
| 0001 | [design-event-payload-union](0001-design-event-payload-union.md) | Decide the discriminated-union shape, its home, and the typed-broadcast API |
| 0002 | [type-event-producers](0002-type-event-producers.md) | `main.ts`'s `broadcast()` and every call site are type-checked against the union |
| 0003 | [type-event-consumers](0003-type-event-consumers.md) | `viewer.ts`'s event switch and `logs-watch.mjs` narrow against the union instead of raw string matching |

## Execution order & parallelization

Serial: 0001 → 0002 → 0003 (0002 needs the design; 0003 needs 0002's actual union
export to import). No parallelism within this small wave.

## Prerequisites (must already be merged)

- `foundation-updates/0006` — the event-type name constants this wave's union keys
  off of.
- `01-merge-jobs` (all 5 tickets) — settles the job-event shapes this wave types.
