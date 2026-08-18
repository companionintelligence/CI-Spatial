> **Type:** Frontend
> **Wave:** 03-readiness-hardening
> **Branch:** `fix/editor-lod-pick`
> **Commit style:** `fix(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None to implement. Verification wants `0003` (the WebKit/Chromium tiers must actually run) — but this ticket's own regression test is a `chromium-mock` spec, which runs today via the `CHROMIUM_EXECUTABLE_PATH` hatch.

## Goal

Make an object transform edited in the World Editor come back in the same place after a
reload. Today the gizmo moves one **level** of a `THREE.LOD` while the saved patch is
replayed onto the **LOD node**, so the object reappears displaced and rescaled — the one
clause of the scan → pin → export → editor bar that does not hold.

## Non-goals

- Do not change the LOD distances, the proxy geometry, or `createMediumPolyAsset` /
  `loadSemanticAsset` in `src/viewer/assets.ts`. The level *contents* are fine; only
  which node is selected is wrong.
- Do not change the `EditPatch` / `TransformPatch` schema in `src/world/types.ts`, the
  `POST /worlds/:slug/patches` route, or the patch persistence format. The wire format
  is correct; the wrong node is being serialized into it.
- Do not "fix" the `hasLabelledAncestor` guard. It has **moved** since this ticket was
  written: it now lives in `src/viewer/detections.ts:72` and has two consumers —
  `createSemanticLabels` (`src/viewer/viewer.ts:1096`) and `collectDetections`
  (`detections.ts:64`). It is still a second symptom of the same shared-`userData` root
  cause, but removing it is no longer merely a visual change: `buildDetectionBounds`
  resolves detections through `collectDetections`, so without the guard every detection
  is found once per LOD level and gets three sets of bounds and sample points (see #87
  and its follow-up). Treat it as load-bearing, not as deferred cleanup.
- Do not migrate or rewrite already-persisted patches. See Risks.
- Do not introduce a new object-identity scheme. `stableObjectId()` already exists.

## Pinned conventions

**ADR 0001 (reuse, don't duplicate)** — this ticket touches a client↔server connection
(the edit-patch round trip), so per `CLAUDE.md` it must state what it reuses. It adds
**no** new type, env var, route, or job type. It reuses, unchanged:

| Existing | Where | How used |
| --- | --- | --- |
| `SceneEditor.pick()` | `src/viewer/editor.ts:164-187` | the two conditions inside its existing walk are reordered; no new method |
| `stableObjectId(obj)` | `src/viewer/viewer.ts:2279` | already returns the LOD's `objectId`; unchanged |
| `serializeTransform(obj)` | `src/viewer/viewer.ts:1721` | already serializes `obj.matrix`; unchanged |
| `findObjectByTargetId(root, id)` | `src/viewer/viewer.ts:2267` | already resolves the LOD parent-first; unchanged |
| `applyMatrix(obj, matrix)` | `src/viewer/viewer.ts:2260` | unchanged |
| `EditPatch` / `TransformPatch` | `src/world/types.ts` | unchanged wire shape |

Pinned facts, re-verified against source at `f8d0779`. Line numbers were originally
pinned at `6217e0b` and drifted by roughly a dozen lines through PRs #85–#97;
`src/viewer/editor.ts`, `src/viewer/assets.ts` and `src/viewer/splat-detect-layer.ts`
are untouched, so every reference into those still holds:

- `upgradeSemanticMeshes` builds `lod.userData` as
  `{ ...mesh.userData, scanId, objectId: \`${scanId}:${mesh.name || label}:lod\` }`
  (`viewer.ts:797-801`), then assigns that **same object by reference** to
  `medium.userData` (`:813`) and `high.userData` (`:817`).
- Because of that reference sharing every LOD level carries `label`, so in `pick()`'s
  walk the `userData['label']` test at `editor.ts:175` always matches **before** the
  `obj.parent instanceof THREE.LOD` test at `:178` can run. The LOD branch is dead code.
- The three level shapes, all direct children of the `THREE.LOD`:
  - far: the original `THREE.Mesh`, `lod.addLevel(mesh, 8)` (`viewer.ts:810`) — keeps its
    **own** `userData` because `lod.userData` is a new object built with a spread. Whether
    that includes an `objectId` now depends on the scan: in a freshly exported GLB the far
    level carries the extras (e.g. `bed_001`), but in an **optimized** one it is the mesh
    `quantize()` hoisted out of the labelled node, which carries no extras at all (#87).
    This weakens the legacy-patch note under "Found but deferred" in the wave README:
    on an optimized scan there is no `bed_001` for such a patch to resolve to.
  - medium: `createMediumPolyAsset(label)` returns a `THREE.Group`
    (`src/viewer/assets.ts:147`) whose child meshes carry **no** `label`.
  - high: `loadSemanticAsset(label)` attaches **asynchronously** (`viewer.ts:816-819`), so
    it may be absent at pick time.
- `serializeTransform` writes `obj.matrix` — a **local** matrix. For the medium proxy that
  already includes a normalisation scale, which is why the reload rescales.

## Before implementation

Read, in this order:

1. `src/viewer/editor.ts:164-187` — `pick()` and its walk.
2. `src/viewer/viewer.ts:787-825` — `upgradeSemanticMeshes`, the reference sharing.
3. `src/viewer/viewer.ts:1573-1588` — `selectEditableObject`, what the gizmo attaches to.
4. `src/viewer/viewer.ts:1674-1708` — `saveSelectedTransform`, the `serializeTransform` +
   `stableObjectId` pairing.
5. `src/viewer/viewer.ts:840-861` — `applyStoredPatches`, and `:2260-2278` for
   `applyMatrix` / `findObjectByTargetId`.
6. `src/viewer/detections.ts:72` — `hasLabelledAncestor`, and the comment above
   `createSemanticLabels` (`src/viewer/viewer.ts:1085-1100`), which already documents
   this exact reference sharing.
7. `tests/mock-editor-homes.spec.ts` — the spec file this ticket's test extends.

## Open questions & answers

- Q: Reorder the two conditions in `pick()`, or stop sharing `userData` by reference in
  `upgradeSemanticMeshes`? — A: **Reorder `pick()`.** Verified by walking all three level
  shapes: hitting the far mesh gives `obj.parent === lod` directly; hitting a medium/high
  child gives an unlabelled mesh whose parent is the level `Group`, so the walk steps to
  the level, whose parent is the LOD. Testing `parent instanceof THREE.LOD` first
  therefore resolves to the LOD from every level. Un-sharing `userData` **wholesale** would
  also fix `pick()` but changes what `createSemanticLabels` sees and what the far mesh
  reports — a strictly larger blast radius. (A *narrower* variant, differentiating only
  `objectId` while keeping the shared `label`, is a separate question below and is worth
  doing as defence in depth.) (decided during drafting, 2026-08-17)
- Q: Does reordering break selection of labelled meshes that are *not* inside an LOD? —
  A: No. `src/viewer/splat-detect-layer.ts:147` sets `userData['label']` on detect boxes
  that are never added to a `THREE.LOD`, so `parent instanceof THREE.LOD` is false and the
  walk falls through to the unchanged `label` test. Covered by an acceptance criterion.
  (decided during drafting, 2026-08-17)
- Q: Is the reorder definitely safe across every hit shape? — A: **Yes**, independently
  re-walked: far raw mesh → parent IS the LOD; proxy child mesh → no label, step to the
  proxy `Group`, whose parent IS the LOD; detection sample `Points` (`viewer.ts:1074`,
  children of the raw mesh) → no label, step to the raw mesh, parent IS the LOD; labelled
  non-LOD nodes → parent is not an LOD, so the label test still decides, unchanged. Order
  only matters when both conditions are true on the same node, which is exactly the
  raw-mesh case. `e2e-suite.spec.ts:423-448` and `:821-830` still pass. (confirmed by the
  reuse audit, 2026-08-17)
- Q: Should the levels also stop **sharing `objectId`**, so three nodes stop claiming one
  id? — A: **Worth doing, and narrower than the option rejected below.** Keep the shared
  `label` (so `createSemanticLabels`' dedupe stays correct) but give the proxies distinct
  ids — `medium.userData = { ...lod.userData, objectId: \`${objectId}:medium\` }`, likewise
  `:high`. That makes `findObjectByTargetId` resolve the LOD **by identity** rather than by
  relying on `traverse` being parent-first, and removes the three-nodes-one-id state that
  makes today's behaviour depend on which level was visible when the user clicked. Treat as
  defence in depth: the reorder alone fixes the round trip, so land it first and measure
  this separately if it risks the label dedupe. (raised by the reuse audit, 2026-08-17)
- Q: Should `hasLabelledAncestor` be removed once levels no longer need to be skipped? —
  A: **No, not in this ticket.** It guards `createSemanticLabels` against stacking one
  label pill per level, which is caused by the reference sharing this ticket deliberately
  leaves in place. Removing it is only correct alongside the un-sharing option that was
  rejected above. (decided during drafting, 2026-08-17)
- Q: What happens to patches already persisted against a level's id? — A: See Risks; they
  still resolve, to the far mesh, exactly as they do today. No migration. (decided during
  drafting, 2026-08-17)

## Files impacted

- **Changed:** `src/viewer/editor.ts` — reorder the two conditions in `pick()`'s walk and
  correct the comment above it.
- **Changed:** `tests/mock-editor-homes.spec.ts` — add the round-trip tests **inside the
  existing `editor with test-home data` describe**. Its `beforeAll` (`:24-40`) already seeds
  the first three homes through the real `/upload-scan` pipeline, which is exactly the
  corpus these assertions need, and the block is already
  `test.describe.configure({ mode: 'serial' })`. An earlier draft proposed a new
  `tests/mock-editor-transform.spec.ts`; that would have duplicated the seeding and split
  editor coverage across two files, which is the same mistake this wave argues against in
  0006.

No server file changes. No schema changes.

## Schema required

None. This ticket changes which existing object a patch is written against; the
`EditPatch` / `TransformPatch` shape in `src/world/types.ts` and the
`POST /worlds/:slug/patches` payload are untouched.

## Definition of Done

- [ ] In `pick()`, the `obj.parent instanceof THREE.LOD` test runs **before** the
      `obj.userData['label']` test, so the walk resolves to the `THREE.LOD` node.
- [ ] The comment above the walk states what it resolves to and why the order matters.
- [ ] Selecting an object attaches `TransformControls` to the `THREE.LOD`, so all levels
      move together.
- [ ] `saveSelectedTransform()` serializes the LOD's own local matrix and pairs it with
      the LOD's `objectId` — the same node on both sides.
- [ ] A dragged object is in the same world position after a reload, within tolerance.
- [ ] Labelled objects that are not inside an LOD still select as themselves.
- [ ] `npx tsc --noEmit` is clean.

## Tests

- [ ] `tests/mock-editor-homes.spec.ts` (new tests in the existing describe) — pick an object in a seeded test home,
      assert the selected node is the `THREE.LOD` (name starts `LOD_`), not a level.
- [ ] Same spec — read the object's world position, apply a known translation via the
      editor's save path, reload the page, and assert the world position matches within
      1e-3. **This assertion fails on current `main`** — that is the point of the ticket.
- [ ] Same spec — assert scale is unchanged across the reload (the medium proxy's
      normalisation scale is what leaks today).
- [ ] Same spec — assert the persisted patch's `targetId` ends in `:lod`.
- [ ] Regression guard — a labelled non-LOD object (splat-detect box) still picks as
      itself.

```
# servers must be up: INFERENCE_MODE=mock deno run ... main.ts   +   npm run dev
export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"
export CHROMIUM_EXECUTABLE_PATH=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
npm run gen:test-data && npm run seed:test-data

npx tsc --noEmit
VITE_URL=https://localhost:5173 npx playwright test --project=chromium-mock tests/mock-editor-homes.spec.ts
VITE_URL=https://localhost:5173 npm run test:mock          # no regression in the existing editor specs
deno task check
```

## Acceptance Criteria

- [ ] **Given** a seeded test home open in the editor, **when** an object is clicked,
      **then** the selected object is the `THREE.LOD` node and its name starts `LOD_`.
- [ ] **Given** a selected object, **when** it is dragged +1m in x and saved, **then**
      every LOD level moves with it and the object does not jump when the camera crosses
      an LOD distance threshold (levels are at 8 / 4 / 0).
- [ ] **Given** a saved transform, **when** the page is reloaded, **then** the object's
      world position matches the pre-reload position within 1e-3 and its scale is
      unchanged.
- [ ] **Given** the same edit repeated twice, **then** the second reload does not compound
      the offset (the patch is idempotent on replay).
- [ ] **Given** a splat-detect box (labelled, not inside an LOD), **when** it is clicked,
      **then** it selects as itself and remains editable.

## Risks / potential issues

- **Risk:** Patches persisted *before* this fix carry a level's identity. A patch whose
  `targetId` is the far mesh's GLB id (e.g. `bed_001`) still resolves — `findObjectByTargetId`
  will not match the LOD (its `objectId` is `…:lod`) and will walk on to the raw mesh —
  so such a patch keeps moving the mesh *inside* the LOD, as it does today.
  — **Mitigation:** Out of scope to migrate, and not a new break: behaviour for those
  patches is unchanged. Note it in the wave README as found-but-deferred. If it becomes a
  real problem, the fix is a one-time patch rewrite keyed on `scanId`, which needs its own
  ticket.
- **Risk:** The high-detail level attaches asynchronously (`viewer.ts:816-819`), so a pick
  that lands before it loads walks a two-level LOD. — **Mitigation:** The reorder is
  level-count independent; it resolves to the LOD from whichever level was hit. The test
  should click without waiting for the high asset to prove it.
- **Risk:** `TransformControls` attached to a `THREE.LOD` — LOD updates its children's
  visibility per frame based on camera distance. — **Mitigation:** The gizmo attaches to
  the LOD *node*, whose own transform LOD does not touch; only child visibility is
  swapped. Assert the gizmo stays attached across a threshold crossing.
- **Risk:** Some other caller depends on `pick()` returning a level. — **Mitigation:**
  `grep -rn "\.pick(" src/` before changing; the walk's stated intent (its own comment,
  `editor.ts:173`) is already "find the node containing label metadata **or LOD group**",
  so the LOD was always the intended result.

## Subtasks

1. [ ] Read the seven locations in "Before implementation" and confirm the line numbers
       still match; this ticket pins them at `6217e0b`.
2. [ ] `grep -rn "\.pick(" src/` and confirm every caller wants the whole object.
3. [ ] Swap the two conditions in `pick()`'s walk (`src/viewer/editor.ts:174-183`) so the
       LOD test runs first; rewrite the comment to say the walk resolves to the LOD and
       why the order is load-bearing (every level shares `lod.userData`, so the `label`
       test would otherwise always win).
4. [ ] Run `npx tsc --noEmit` and `deno task check`.
5. [ ] Add the five cases above to the existing `editor with test-home data` describe in
       `tests/mock-editor-homes.spec.ts`, reusing its `beforeAll` seeding.
6. [ ] Confirm the position assertion **fails** with the fix reverted, then passes with it
       — a regression test that passes on the broken code is worthless.
7. [ ] Run the full `npm run test:mock` tier for regressions in the existing editor specs.
8. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
