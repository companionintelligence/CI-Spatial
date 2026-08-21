> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/thing-shape-lineage`
> **Commit style:** `refactor(spatial): WorldDetection extends RawDetection; document thing-shape lineage`
> **Design:** this ticket is the spec
> **Dependencies:** None
> **Status:** ✅ Done — merged via [PR #71](https://github.com/companionintelligence/CI-Spatial/pull/71)
> (commit `1e52f56`, plus a review follow-up `4d24989`), 2026-08-16. Note: `RawDetection`
> actually lives at `src/inference/prompt.ts:15` (the browser-safe copy resolver.ts
> already imported), not root `prompt.ts:13` as this ticket's Goal section says — the
> root `prompt.ts` is the Deno-side twin, kept hand-in-sync per its own header comment.

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
  `src/world/types.ts`? — A: **Straight import**, and it turned out to already exist:
  `resolver.ts:16` already had `import type { RawDetection } from '../inference/prompt'`
  (used elsewhere in the file for a `RawDetection[]` parameter), so no new import or
  `src/world/types.ts` re-export was needed — just changing the interface declaration
  to `extends RawDetection` and deleting the restated fields.
- Q: (found during review, not originally listed) — `WorldDetection`'s doc comment on
  `bbox` (`/** Normalised [x1,y1,x2,y2] bounding box from VLM inference */`) was lost
  when the field moved to the inherited base. — A: restored on `RawDetection.bbox` in
  `src/inference/prompt.ts` (and mirrored to root `prompt.ts` per its own
  must-stay-in-sync header) rather than re-added to `WorldDetection`, since duplicating
  it there would recreate the drift risk this ticket removes. See PR #71 review thread.

## Files impacted

- Changed: `src/spatial/resolver.ts` (extends; delete 4 restated fields)
- Changed: `src/viewer/splat-detect-layer.ts`, `src/shared/test-homes.ts` (doc
  comments stating why these shapes are intentionally separate, citing ADR 0001)
- ~~Possibly changed: `src/world/types.ts` (re-export, per Open question)~~ — not
  needed; see Open Q&A.
- Changed (post-merge review follow-up, not originally scoped): `src/inference/prompt.ts`,
  `prompt.ts` (restored the `bbox` JSDoc onto `RawDetection` — see Open Q&A).

## Schema required

None — `extends` produces an identical structural type; zero runtime change.

## Definition of Done

- [x] `WorldDetection extends RawDetection`; the restated field block is gone.
- [x] `DetectObject` and `FurnitureItem` carry declaration-site comments naming their
      producer and why they are not part of the detection lineage.
- [x] No runtime diff: scanning, detection pinning, session storage, and GLB export
      behave identically.

## Tests

- [x] `deno task check` passes.
- [x] `npm run test:mock` passes (mock-engine scan flow exercises
      RawDetection→WorldDetection→StoredDetection end to end). 27 passed / 23 skipped;
      3 pre-existing failures unrelated to this ticket (verified identical against the
      pre-batch base commit — headless-Chromium mock-SLAM limitation of the sandbox).

```
deno task check
npm run test:mock
```

## Acceptance Criteria

- [x] Given a future field added to `RawDetection`, when `deno task check` runs, then
      `WorldDetection` and `StoredDetection` inherit it automatically instead of
      silently drifting.

## Risks / potential issues

- **Risk:** RawDetection's `bbox` tuple type is declared subtly differently in the
  restated copy (e.g. `[number,number,number,number]` vs `number[]`), and `extends`
  surfaces a latent mismatch. — **Mitigation:** that surfacing is the point; fix the
  construction sites to the canonical tuple, don't loosen the base.

## Subtasks

1. [x] Apply the `extends`, delete the restated block, resolve the import path (Open
       question).
2. [x] Add the two declaration-site comments.
3. [x] Run verification.
4. [x] (Review follow-up) Restore the `bbox` JSDoc lost in the restatement, on
       `RawDetection` rather than `WorldDetection`.
