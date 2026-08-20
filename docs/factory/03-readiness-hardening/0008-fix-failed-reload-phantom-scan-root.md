> **Type:** Frontend
> **Wave:** 03-readiness-hardening
> **Branch:** `fix/editor-failed-reload-phantom-root`
> **Commit style:** `fix(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Independent of 0004 and 0007 (same file, disjoint code path).

> **Filed 2026-08-19.** Not one of the wave's original six tickets — found live during
> an adversarial multi-agent code review run against this codebase the same night,
> verified by 3-way adversarial voting, and confirmed by reading the code while closing
> out 0004. See 0007's banner for the shared context (same file, same "stale reference
> in the World Editor surviving a reload" theme, different root cause, filed here for
> topical proximity rather than folded into the wave's original "six items").

## Goal

Stop a failed full-quality reload from overwriting `loadedScans` with a phantom,
detached `THREE.Group` when a previous pass for the same scan already succeeded. Today
the affected scan becomes permanently unselectable and un-hideable, and if a *later*
reload for the same scan succeeds, two generations of it render simultaneously with no
way to clear the first — short of a full page reload.

## Non-goals

- Do not change the progressive preview→full-quality load sequence itself
  (`loadScanIntoWorld()`'s `try` block, `viewer.ts:659-676`) — the two-pass load is
  correct and unrelated; this only touches what happens in the `catch`.
- Do not add retry logic for the failed load. `withTransientRetry` (used inside
  `loadGlbRoot()`, per the comment at `viewer.ts:704-708`) already retries a transient
  fetch drop; this ticket is about what happens once that retry budget is exhausted and
  the promise genuinely rejects, not about retrying harder.
- Do not touch `saveSelectedTransform()` / the pick/save round trip — that's 0004
  (closed) and orthogonal.
- Do not touch the selection-staleness bug where a *successful* reload replaces a
  selected root — that's 0007, a distinct bug in a different branch of the same
  function family (the success path calling `integrateScanRoot()`, vs. this ticket's
  failure path in `loadScanIntoWorld()`'s `catch`).

## Pinned conventions

**ADR 0001 (reuse, don't duplicate)** — no new type, env var, route, job type, or
config variable. Reuses, unchanged:

| Existing | Where | How used |
| --- | --- | --- |
| `LoadedScan` | `src/viewer/viewer.ts:58-66` | unchanged shape — the fix changes *which* value populates `.error`/`.loaded`, not the interface |
| `loadedScans` | `src/viewer/viewer.ts:117` | unchanged Map |
| `setScanStatus()` | `src/viewer/viewer.ts:2367` | unchanged; still called with the error message |

## Before implementation

Read, in this order:

1. `src/viewer/viewer.ts:655-691` — `loadScanIntoWorld()`. The `try` block
   (`:659-676`) may call `integrateScanRoot()` **twice** — once for the preview
   (`:666`, only if `preview` exists), once for the full-quality GLB (`:673`, always).
   The `catch` block (`:677-690`) is reached if *either* `loadGlbRoot()` call rejects —
   including the second one, **after** the preview has already succeeded and is live in
   the scene.
2. `src/viewer/viewer.ts:679-687` — the exact overwrite. `loadedScans.set(scan.scanId, {
   ..., root: new THREE.Group(), loaded: false, error: message })` runs
   unconditionally, with no check for a pre-existing entry.
3. `src/viewer/viewer.ts:724-773` — `integrateScanRoot()`, specifically the teardown
   guard at `:728-729`: `const previous = loadedScans.get(scan.scanId); if (previous &&
   previous.loaded) { worldGroup.remove(previous.root); ... }`. This is the mechanism
   that breaks: once the catch block above has run, `previous.loaded` reads `false` even
   though the *actual* previewed root is still a live child of `worldGroup` — so a
   later successful `integrateScanRoot()` call skips removing it.
4. `src/viewer/viewer.ts:602-608` — the scan-list visibility checkbox handler, and
   `:1109-1124` — `selectScan()`. Both read `loadedScans.get(scanId)` and act on
   `.root`/`.loaded` — this is what "unselectable and un-hideable" cashes out to
   concretely: `selectScan()` returns early on `!loaded.loaded` (`:1111`), and the
   checkbox handler sets `.visible` on the *phantom* `.root` (a `Group` that was never
   added to `worldGroup`), which has no visible effect on the actually-rendered preview.

## Open questions & answers

- Q: On a failed second-pass load, should the entry keep `loaded: true` (pointing at the
  still-good preview) or `loaded: false` with the *preview's* root preserved? — A:
  **Keep the existing entry's `root`/`loaded`/`visible` as they were; only set `.error`.**
  The preview is genuinely loaded and live — `loaded` should keep saying so. A caller
  that wants to show "this scan's full-quality load failed" reads `.error`, which is
  already a field on `LoadedScan` for exactly this. (decided during drafting, 2026-08-19)
- Q: What if there is no pre-existing entry at all (first-ever load for this scan
  fails, e.g. a corrupt upload)? — A: Unchanged from today — write the phantom `Group`
  entry with `loaded: false`. There's nothing to preserve; the phantom is a reasonable
  placeholder so `selectScan()`/the checkbox handler have *something* typed to read
  without a null check at every call site. (decided during drafting, 2026-08-19)

## Files impacted

- **Changed:** `src/viewer/viewer.ts` — `loadScanIntoWorld()`'s `catch` block.
- **Changed:** a new spec (or an addition to an existing mock-editor spec) forcing a
  second-pass load failure — see Tests.

No server file changes. No schema changes.

## Schema required

None.

## Definition of Done

- [ ] In `loadScanIntoWorld()`'s `catch` block, before writing a `loadedScans` entry,
      check for an existing entry for `scan.scanId`.
- [ ] If an existing entry has `loaded: true`, preserve its `root`/`layerNodes`/`points`/
      `visible`, and only set `.error` to the new failure message — do not replace
      `.root` with a phantom `Group`, and do not flip `.loaded` to `false`.
- [ ] If there is no existing entry, or the existing entry already has `loaded: false`,
      behavior is unchanged from today (write the phantom-`Group` placeholder entry).
- [ ] After this fix, a scan whose preview succeeded and full-quality load failed
      remains selectable (`selectScan()` does not early-return) and its visibility
      checkbox still controls the actually-rendered preview root.
- [ ] After this fix, if a *later* reload for the same scan succeeds,
      `integrateScanRoot()`'s teardown correctly removes the preview root (no two
      generations rendering at once).
- [ ] `npx tsc --noEmit` is clean.

## Tests

- [ ] A spec that seeds a scan whose preview load succeeds and whose full-quality load
      is forced to fail (e.g. by having the server return a 404/500 for the optimized
      GLB after the preview has already been served — check what hook the mock
      inference/server path already exposes for forcing a load failure before adding a
      new one; `tests/e2e-suite.spec.ts`'s "Scan GLB has no scene graph" failure path,
      seen incidentally during 0004's `test:mock` run, may already demonstrate the right
      shape of failure to force). Asserts the scan is still selectable afterward (click
      the sidebar item, selection succeeds) and its visibility checkbox still hides the
      rendered preview.
- [ ] Same spec — after the forced failure, trigger a *successful* reload for the same
      scan (e.g. re-upload or re-trigger optimize-scan) and assert only one generation
      of the scan's geometry is present in the scene afterward (count nodes tagged with
      the scan's `objectId`/`scanId`, or count `worldGroup.children` matching the scan
      before vs. after).
- [ ] Regression guard — a scan with **no** successful prior load that fails outright
      still gets the phantom-`Group` placeholder entry (unchanged behavior), so
      `selectScan()` and the visibility checkbox don't throw on a scan that never loaded
      at all.

```
# servers must be up: INFERENCE_MODE=mock deno run ... main.ts   +   npm run dev
npx tsc --noEmit
VITE_URL=https://localhost:5173 npx playwright test --project=chromium-mock <new spec>
VITE_URL=https://localhost:5173 npm run test:mock
deno task check
```

## Acceptance Criteria

- [ ] **Given** a scan whose preview loaded but whose full-quality load failed,
      **when** the user clicks it in the scan list, **then** it selects (no early return
      from a stale `loaded: false`).
- [ ] **Given** the same scan, **when** the user toggles its visibility checkbox,
      **then** the actually-rendered preview geometry hides/shows (not a phantom,
      never-added `Group`).
- [ ] **Given** the same scan, **when** a later reload for it succeeds, **then** the
      scene contains exactly one generation of that scan's geometry, not two.
- [ ] **Given** a scan with no successful prior load, **when** its load fails,
      **then** behavior is unchanged from today (a typed placeholder entry, no crash in
      any caller).

## Risks / potential issues

- **Risk:** Forcing a real "preview succeeds, full-quality fails" scenario in a test
  needs a reliable way to make the *second* `loadGlbRoot()` call fail without also
  failing the first. — **Mitigation:** Investigate the server's existing failure-mode
  hooks (mock inference, `withTransientRetry`'s own tests, or a `page.route()`
  intercept on the specific optimized-GLB URL) during implementation; this is a test
  authoring risk, not an implementation risk — the fix itself doesn't depend on how the
  failure is induced.
- **Risk:** "Preserve the existing entry, only set `.error`" needs `.error` to actually
  be surfaced somewhere useful (today `setScanStatus()` already writes the status chip
  text regardless, so the failure is visible there) — but confirm no caller reads
  `loaded.error` to *gate* behavior in a way that assumes `loaded` and `error` are
  mutually exclusive (today's shape implies that, since the only place `.error` is set
  also sets `loaded: false`). — **Mitigation:** `grep -rn "\.error" src/viewer/viewer.ts`
  scoped to `LoadedScan` reads before changing, to confirm nothing assumes the
  now-broken invariant "error implies not loaded."
- **Risk:** This ticket and 0007 both touch scan-root lifecycle in `viewer.ts` and could
  conflict if implemented concurrently on separate branches. — **Mitigation:** They
  touch different functions (`loadScanIntoWorld`'s catch vs. `integrateScanRoot`'s
  teardown) — a textual conflict is unlikely, but land one before rebasing the other if
  both are in flight at once.

## Subtasks

1. [ ] Read the four locations in "Before implementation" and confirm the line numbers
       still match current `main`.
2. [ ] `grep -rn "\.error" src/viewer/viewer.ts` scoped to `LoadedScan` reads; confirm
       no caller assumes "error implies not loaded."
3. [ ] Change the `catch` block to preserve an existing `loaded: true` entry's
       root/layerNodes/points/visible, updating only `.error`.
4. [ ] Run `npx tsc --noEmit` and `deno task check`.
5. [ ] Add the tests above; confirm the "still selectable after partial failure" and
       "no double-render after a later successful reload" assertions fail against the
       current code and pass with the fix.
6. [ ] Run the full `npm run test:mock` tier for regressions.
7. [ ] Flip this ticket's atlas diff (`atlas.html`, "Multi-scan World Editor" fcard) to
       `is-done` with the merged PR number.
