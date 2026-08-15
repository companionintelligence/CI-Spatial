> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/thing-shape-lineage`
> **Commit style:** `refactor(spatial): WorldDetection extends RawDetection; document thing-shape lineage`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

The "thing" pipeline has a clean conceptual lineage — `RawDetection` (`prompt.ts:13`,
what the VLM returns) → `WorldDetection` (`src/spatial/resolver.ts:22`, + world pose)
→ `StoredDetection` (`src/scene/store.ts:14`, + thumbnail) — but `WorldDetection`
restates RawDetection's four fields inline (`resolver.ts:23-27`) instead of extending
it, so the lineage is invisible to the type system and the two copies can drift. Make
`WorldDetection extends RawDetection`, and document the two *legitimately separate*
thing shapes (`DetectObject`, `FurnitureItem`) at their declaration sites so nobody
"unifies" them incorrectly later.

## Non-goals

- Do not merge `DetectObject` (`src/viewer/splat-detect-layer.ts:38`) into the
  lineage — it is the deserialized shape of the external splat_analyzer's
  `interactions.json` (oriented 3D boxes: `position/rotation?/scale`), a different
  producer with a different contract. Same for `FurnitureItem`
  (`src/shared/test-homes.ts:12`) — synthetic ground truth with `size`+`rgb`, not a
  detection.
- Do not add fields, rename fields, or change any runtime behavior — `extends` +
  comments only.

## Pinned conventions

- ADR 0001: this is the "new 'thing' data extends WorldDetection" rule applied
  retroactively to WorldDetection itself. Searched: the five thing shapes and their
  fields were compared field-by-field in this wave's audit; only the
  RawDetection→WorldDetection restatement is a true duplicate.
- `StoredDetection extends WorldDetection` already exists (`store.ts:14`) — this
  ticket completes the chain one level up, matching that established pattern.
- Import style: `resolver.ts` gains `import type { RawDetection } from
  '../../prompt.ts'` — if that root-level import is awkward for Vite, re-export
  `RawDetection` from `src/world/types.ts` instead (the shared-type home) and import
  from there; record the choice in Open Q&A. `inference.ts` already re-exports it, so
  a browser-safe re-export point may be preferable.

## Before implementation

- `prompt.ts:13` (RawDetection), `src/spatial/resolver.ts:22-33` (WorldDetection and
  its restated block), `src/scene/store.ts:14` (the existing extends pattern).
- Check every `WorldDetection` construction site in `resolver.ts` still type-checks
  when the four fields come from the base.

## Open questions & answers

- Q: Import RawDetection straight from `prompt.ts` or re-export via
  `src/world/types.ts`? — OPEN, implementer's call after checking the Vite build;
  record here.

## Files impacted

- Changed: `src/spatial/resolver.ts` (extends; delete 4 restated fields)
- Changed: `src/viewer/splat-detect-layer.ts`, `src/shared/test-homes.ts` (doc
  comments stating why these shapes are intentionally separate, citing ADR 0001)
- Possibly changed: `src/world/types.ts` (re-export, per Open question)

## Schema required

None — `extends` produces an identical structural type; zero runtime change.

## Definition of Done

- [ ] `WorldDetection extends RawDetection`; the restated field block is gone.
- [ ] `DetectObject` and `FurnitureItem` carry declaration-site comments naming their
      producer and why they are not part of the detection lineage.
- [ ] No runtime diff: scanning, detection pinning, session storage, and GLB export
      behave identically.

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run test:mock` passes (mock-engine scan flow exercises
      RawDetection→WorldDetection→StoredDetection end to end).

```
deno task check
npm run test:mock
```

## Acceptance Criteria

- [ ] Given a future field added to `RawDetection`, when `deno task check` runs, then
      `WorldDetection` and `StoredDetection` inherit it automatically instead of
      silently drifting.

## Risks / potential issues

- **Risk:** RawDetection's `bbox` tuple type is declared subtly differently in the
  restated copy (e.g. `[number,number,number,number]` vs `number[]`), and `extends`
  surfaces a latent mismatch. — **Mitigation:** that surfacing is the point; fix the
  construction sites to the canonical tuple, don't loosen the base.

## Subtasks

1. [ ] Apply the `extends`, delete the restated block, resolve the import path (Open
       question).
2. [ ] Add the two declaration-site comments.
3. [ ] Run verification.
