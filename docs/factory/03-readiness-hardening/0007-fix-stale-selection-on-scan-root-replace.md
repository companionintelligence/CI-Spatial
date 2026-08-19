> **Type:** Frontend
> **Wave:** 03-readiness-hardening
> **Branch:** `fix/editor-stale-selection-reload`
> **Commit style:** `fix(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Independent of 0004 (same file, disjoint code path — 0004
> touches `pick()`'s walk and is closed; this touches `integrateScanRoot()`'s teardown).

> **Filed 2026-08-19.** Not one of the wave's original six tickets — found live during
> an adversarial multi-agent code review run against this codebase the same night,
> verified by 3-way adversarial voting, and confirmed by reading the code (not just
> asserted) while closing out 0004. Same file, same general theme (a stale/mismatched
> object reference in the World Editor surviving a reload) as 0004, but a different root
> cause: 0004 is about *which node* a save is written against; this is about *whether
> the node a save is written against is even still in the scene*. Filed here for
> topical proximity, not folded into "the six items" 03-readiness-hardening's own README
> describes itself as closing — see that README's wave-progress note if the count there
> looks stale against this file's existence.

## Goal

When a background reload replaces the root of a scan the user currently has selected,
clear the stale selection instead of leaving `TransformControls` and
`selectedTransformTarget` attached to the now-detached old object. Today,
`saveSelectedTransform()` can silently `POST` a patch computed from a disconnected
object's matrix while flashing "Saved" — the save "succeeds" but the transform it wrote
no longer describes anything in the visible scene.

## Non-goals

- Do not try to re-select "the same" object in the new root by `objectId`. That's a
  strictly better UX (the user's edit-in-progress survives the swap) but is a separate,
  harder design question — does an in-flight *unsaved* transform drag survive too, and
  if so how — and this ticket's bar is "stop the silent-wrong-save," not "make the swap
  invisible to the user." Worth a follow-up if this fix feels too abrupt in practice.
- Do not change `enqueueScanLoad()` / the per-`scanId` load chaining
  (`viewer.ts:645-653`). That serialization is correct and unrelated — this bug fires
  even with loads perfectly serialized, because the problem is *within* one scan's
  load replacing its own previous root, not two loads racing each other.
- Do not touch `loadScanIntoWorld()`'s catch block or the phantom-`Group`-on-failure
  behavior — that is 0008, a distinct bug in a different branch of the same function
  family.
- Do not change what `saveSelectedTransform()` serializes or how patches are targeted —
  that's 0004's territory (closed) and orthogonal here.

## Pinned conventions

**ADR 0001 (reuse, don't duplicate)** — no new type, env var, route, job type, or
config variable. This is a client-only state-sync fix reusing, unchanged:

| Existing | Where | How used |
| --- | --- | --- |
| `clearSelection()` | `src/viewer/viewer.ts:1586-1595` | called when the selection's owning root is replaced, same as it's already called on an empty pick (`viewer.ts:270`) and on hide-object (`:2631`) |
| `selectedTransformTarget` | `src/viewer/viewer.ts:144` | read, not restructured |
| `LoadedScan` | `src/viewer/viewer.ts:58-66` | unchanged shape |
| `loadedScans` | `src/viewer/viewer.ts:117` | unchanged Map |

## Before implementation

Read, in this order:

1. `src/viewer/viewer.ts:724-773` — `integrateScanRoot()`. The teardown block at
   `:727-740` removes `previous.root` from `worldGroup` and clears its labels/detection
   bounds, but never checks whether `selectedTransformTarget` (module state, `:144`) is
   `previous.root` itself or a descendant of it.
2. `src/viewer/viewer.ts:1573-1584` — `selectEditableObject()`, and `:1109-1124` —
   `selectScan()`. Both are the two ways a selection gets made: picking an object inside
   a scan, or clicking the scan in the sidebar list (which attaches to `loaded.root`
   directly, `:1116-1117`). Either kind of selection can be pointing into a root that
   `integrateScanRoot()` is about to remove.
3. `src/viewer/viewer.ts:1586-1595` — `clearSelection()`, the existing helper this
   ticket calls into.
4. `src/viewer/viewer.ts:655-691` — `loadScanIntoWorld()`, for context on *when*
   `integrateScanRoot()` runs more than once for the same scan: the progressive
   preview→full-quality swap (`:664-673`, every load) and a background job-completion
   reload (`handleJobUpdate` → `enqueueScanLoad`, `:2675-2691`) are both real, common
   triggers — this isn't an edge case, it's the normal progressive-load path racing
   normal user interaction.
5. `src/viewer/editor.ts` — `SceneEditor.selectedObject` / `_selectObject` /
   `_clearSelection` (`:283-318`). `editor`'s own `_selected` has the identical
   staleness problem (used for highlight-material bookkeeping) — decide during
   implementation whether `clearSelection()` growing to also call
   `editor` selection-clearing is in scope, or whether `editor`'s copy is cosmetic
   enough to leave (see Open questions).

## Open questions & answers

- Q: Clear the selection, or try to re-resolve it in the new root? — A: **Clear it.**
  See Non-goals — re-resolving is a real UX improvement but a separate, harder ticket;
  clearing is the smallest change that removes the silent-wrong-save. (decided during
  drafting, 2026-08-19)
- Q: Does `SceneEditor`'s own `_selected` (used for emissive highlight, not for
  transform/save) need the same fix? — OPEN. It has the same staleness in principle
  (highlighting a detached object is harmless — no save path reads it directly — but it
  leaks a `THREE.Mesh` reference and its emissive-restore in `_clearSelection()` would
  silently no-op against a disposed object). Decide during implementation: cheapest is
  to route `viewer.ts`'s `clearSelection()` through `editor`'s own clear too, if that
  doesn't fight `_selectObject`'s per-mesh material bookkeeping in some case not yet
  found. Not required for the silent-wrong-save fix, which only needs
  `selectedTransformTarget`/`transformControls`.

## Files impacted

- **Changed:** `src/viewer/viewer.ts` — `integrateScanRoot()` gains a check against
  `selectedTransformTarget` before tearing down `previous.root`.
- **Changed:** a new spec (or an addition to an existing mock-editor spec) covering the
  race — see Tests.

No server file changes. No schema changes.

## Schema required

None.

## Definition of Done

- [ ] `integrateScanRoot()` checks, before removing `previous.root`, whether
      `selectedTransformTarget` is `previous.root` or has `previous.root` as an
      ancestor.
- [ ] If so, it calls `clearSelection()` before proceeding with the swap, so
      `transformControls` detaches and `selectedTransformTarget` becomes `null` rather
      than pointing at a removed object.
- [ ] If not (the common case — no selection, or the selection belongs to a different
      scan), behavior is unchanged — no extra `clearSelection()` call, no flicker for
      the common path.
- [ ] `saveSelectedTransform()` called after the swap either no-ops (selection was
      cleared) rather than `POST`ing a patch computed from a detached object's matrix.
- [ ] `npx tsc --noEmit` is clean.

## Tests

- [ ] A spec that: selects an object inside a scan, triggers a reload of that same scan
      while the selection is live (e.g. via the `__editorTest` hook's pattern from 0004,
      or by forcing a second `integrateScanRoot()` call), and asserts the selection is
      cleared — `edit-no-selection` panel visible, not `edit-selected-info`.
- [ ] Same spec — attempting `saveSelectedTransform()` after the reload does not `POST`
      to `/worlds/:slug/patches` (no patch recorded for the stale object).
- [ ] Regression guard — selecting an object in scan A, then a reload of *unrelated*
      scan B, does not clear scan A's selection.

```
# servers must be up: INFERENCE_MODE=mock deno run ... main.ts   +   npm run dev
npx tsc --noEmit
VITE_URL=https://localhost:5173 npx playwright test --project=chromium-mock <new spec>
VITE_URL=https://localhost:5173 npm run test:mock
deno task check
```

## Acceptance Criteria

- [ ] **Given** an object selected inside a scan, **when** that scan's root is replaced
      by a reload (preview→full-quality swap or a job-completion reload), **then** the
      selection is cleared — no gizmo left attached to a detached object.
- [ ] **Given** a cleared selection from the above, **when** the user clicks
      "Save Transform" (or it's called programmatically), **then** no patch is posted.
- [ ] **Given** a selection in scan A, **when** scan B's root is replaced, **then**
      scan A's selection is untouched.

## Risks / potential issues

- **Risk:** Clearing the selection is itself a UX regression if the user is mid-drag
  when the swap happens — their gizmo disappears with no explanation.
  — **Mitigation:** Out of scope to make seamless (see Non-goals); this ticket's bar is
  correctness (no silent wrong save) over polish. Note the abrupt-UX tradeoff in the
  wave README if this ships before a re-resolve follow-up exists.
- **Risk:** The ancestor-walk to check "is `selectedTransformTarget` under
  `previous.root`" needs to handle `selectedTransformTarget === previous.root` itself
  (the scan-root selection case from `selectScan()`, not just an object nested inside
  it). — **Mitigation:** Explicit acceptance criterion and test for scan-root selection,
  not just object selection.
- **Risk:** Some other code path also reads `selectedTransformTarget` after this kind of
  swap and assumes it's always valid once non-null (e.g. `updateTransformReadout()`,
  `fitCamera`). — **Mitigation:** `grep -rn "selectedTransformTarget" src/viewer/viewer.ts`
  before changing; clearing it fully (not leaving a dangling non-null reference) is the
  point, so any reader that already null-checks is fine by construction.

## Subtasks

1. [ ] Read the five locations in "Before implementation."
2. [ ] `grep -rn "selectedTransformTarget" src/viewer/viewer.ts` and confirm every
       reader either null-checks or is only reachable when a selection is valid.
3. [ ] Add the ancestor/self check and `clearSelection()` call in `integrateScanRoot()`.
4. [ ] Run `npx tsc --noEmit` and `deno task check`.
5. [ ] Add the tests above; confirm they fail against the current code (a stale-save
       goes through) and pass with the fix.
6. [ ] Run the full `npm run test:mock` tier for regressions.
7. [ ] Resolve the open question about `SceneEditor`'s own `_selected`, one way or the
       other, and record the decision in this file.
8. [ ] Flip this ticket's atlas diff (`atlas.html`, "Multi-scan World Editor" fcard) to
       `is-done` with the merged PR number.
