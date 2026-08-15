> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/rename-optimize-manifest`
> **Commit style:** `refactor(jobs): rename jobs.ts ScanManifest to OptimizeScanManifest`
> **Design:** this ticket is the spec
> **Dependencies:** None — but must land before 0006 (both touch `jobs.ts`)

## Goal

Two unrelated types are both named `ScanManifest`: the flat GLB-optimizer artifact
index at `jobs.ts:31` and the domain "place" type at `src/world/types.ts:145`. Rename
the `jobs.ts` one to `OptimizeScanManifest` so the name `ScanManifest` means exactly
one thing in this codebase. This is the cheapest fix in the wave: the `jobs.ts` type
has **zero external importers** — it's used only inside `jobs.ts` itself (lines 156
and 171).

## Non-goals

- Do not touch `src/world/types.ts`'s `ScanManifest` — it is the canonical "place"
  type with ~10 importing files and stays as-is.
- Do not change the on-disk `<base>.manifest.json` file format the type describes —
  this is a TypeScript-name-only change; serialized output must be byte-identical.
- Do not merge `jobs.ts`'s `JobQueue` with the WorldJob system — explicitly out of
  scope per ADR 0001's Consequences section.

## Pinned conventions

- ADR 0001 (`docs/adr/0001-reuse-existing-domain-model.md`): this ticket implements
  its "never reuse the name `ScanManifest` for anything that isn't that exact shape"
  clause. Searched: `grep -rn ScanManifest` across all `*.ts` — the only two
  definitions are `jobs.ts:31` and `src/world/types.ts:145`; every import of the name
  resolves to the `src/world/types.ts` one.
- New name `OptimizeScanManifest` mirrors the job type string it belongs to
  (`'optimize-scan'`, `jobs.ts` `Job['type']`).

## Before implementation

- `jobs.ts:31` (the interface), `jobs.ts:156` and `jobs.ts:171` (its two usage sites).
- Confirm no other file imports it: `grep -rn "ScanManifest" --include="*.ts"` and
  check each hit's import source.

## Open questions & answers

- Q: Rename to `OptimizeScanManifest` or `ScanOptimizeManifest`? — A:
  `OptimizeScanManifest`, matching the `'optimize-scan'` job-type string order
  (decided by ticket author, 2026-08-15).

## Files impacted

- Changed: `jobs.ts` (3 lines: definition + 2 usages)
- Changed: `architecture.md` / any doc line that refers to "jobs.ts's ScanManifest"
  disambiguation (grep docs for it; update wording to the new name)

## Schema required

None — TypeScript identifier rename only; the serialized manifest JSON is unchanged.

## Definition of Done

- [ ] `jobs.ts` no longer declares a type named `ScanManifest`.
- [ ] `grep -rn "ScanManifest" --include="*.ts"` resolves every remaining hit to
      `src/world/types.ts`.
- [ ] A freshly produced `<base>.manifest.json` is structurally identical to one
      produced before the change.

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run smoke:pipeline` passes (exercises the optimize pipeline that writes the
      manifest).

```
deno task check
npm run smoke:pipeline
```

## Acceptance Criteria

- [ ] Given the full repo, when a reader greps `ScanManifest`, then every definition
      and import refers to exactly one type (`src/world/types.ts:145`).

## Risks / potential issues

- **Risk:** a doc or comment still says "the jobs.ts ScanManifest," confusing future
  readers. — **Mitigation:** grep `*.md` for the phrase and update alongside.

## Subtasks

1. [ ] Rename the interface and its two usages in `jobs.ts`.
2. [ ] Update doc mentions (`architecture.md`, `CLAUDE.md` if it names the collision
       as current fact — reword to past tense there).
3. [ ] Run the verification commands.
