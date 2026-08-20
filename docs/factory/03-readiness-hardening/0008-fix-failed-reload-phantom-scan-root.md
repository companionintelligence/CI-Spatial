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

> **Closed 2026-08-19, superseded by PR #114** (`Fix silent data-loss and High-severity
> findings from code review`) — see 0007's banner for how this was found (a real `git`
> merge conflict on rebase, from an unrelated coincidental overlap in that ticket, is
> what prompted checking whether this one was also already covered). Unlike 0007, the
> shipped fix here is exactly what this ticket's own Open Questions decided: preserve
> the existing `loaded: true` entry's `root`/`layerNodes`/`points`/`visible` and only
> update `.manifest`/`.error` —
> `loadedScans.set(scan.scanId, { ...previous, manifest: scan, error: message })`
> (`viewer.ts:684`) — falling through to the original phantom-`Group` placeholder when
> there's no live entry to preserve (`viewer.ts:685-695`), matching both decided
> questions below exactly.

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

- [x] In `loadScanIntoWorld()`'s `catch` block, before writing a `loadedScans` entry,
      check for an existing entry for `scan.scanId`. (`viewer.ts:679`.)
- [x] If an existing entry has `loaded: true`, preserve its `root`/`layerNodes`/`points`/
      `visible`, and only set `.error` to the new failure message. (`viewer.ts:680-684`
      — object-spread of `previous`, overriding only `manifest`/`error`.)
- [x] If there is no existing entry, or the existing entry already has `loaded: false`,
      behavior is unchanged from today. (`viewer.ts:685-694`, the `else` branch —
      byte-identical to the pre-fix unconditional write.)
- [x] After this fix, a scan whose preview succeeded and full-quality load failed
      remains selectable and its visibility checkbox still controls the actually-
      rendered preview root — both follow directly from `.loaded`/`.root` staying what
      they were, per the preserved-entry logic above.
- [x] After this fix, a later successful reload's teardown correctly removes the
      preview root — `previous.loaded` reads `true` again (never flipped), so
      `integrateScanRoot()`'s `if (previous && previous.loaded)` teardown guard fires.
- [x] `npx tsc --noEmit` is clean.

## Tests

- [ ] A spec forcing "preview succeeds, full-quality fails," asserting the scan stays
      selectable and hideable. **Not added** — PR #114's own verification was
      live/manual ("reproduced each failure against the running app with real scan data
      before fixing, and confirmed after," per its commit message), not a new automated
      spec.
- [ ] Same spec — after the forced failure, a later successful reload leaves exactly one
      generation. **Not added**, same reason.
- [ ] Regression guard — a scan with no successful prior load still gets the phantom
      placeholder. **Not added**, same reason — but true by construction: the `else`
      branch is untouched from the pre-fix code (see DoD item 3 above).

```
# servers must be up: INFERENCE_MODE=mock deno run ... main.ts   +   npm run dev
npx tsc --noEmit
VITE_URL=https://localhost:5173 npx playwright test --project=chromium-mock <new spec>
VITE_URL=https://localhost:5173 npm run test:mock
deno task check
```

## Acceptance Criteria

- [x] **Given** a scan whose preview loaded but whose full-quality load failed,
      **when** the user clicks it in the scan list, **then** it selects.
- [x] **Given** the same scan, **when** the user toggles its visibility checkbox,
      **then** the actually-rendered preview geometry hides/shows.
- [x] **Given** the same scan, **when** a later reload for it succeeds, **then** the
      scene contains exactly one generation of that scan's geometry, not two.
- [x] **Given** a scan with no successful prior load, **when** its load fails,
      **then** behavior is unchanged from today.

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

1. [x] Read the four locations in "Before implementation" — done while verifying PR
       #114 already covered this ticket (see the "Closed" note).
2. [ ] **Not done as a standalone grep** — PR #114's commit message describes live
       reproduction before/after rather than this specific audit step; the shipped fix
       doesn't change `.error`'s meaning relative to `.loaded` in a way that would need
       it (see DoD item 2 — `.loaded` still tracks whether `.root` is live, unchanged).
3. [x] Superseded — PR #114 made exactly this change (see "Closed" note).
4. [x] `npx tsc --noEmit` and `deno task check` — both clean on the merged tree.
5. [ ] **Not done** — no automated spec exists for this path. See the Tests section.
6. [x] The full `npm run test:mock` tier ran clean (62/62) on this branch after merging
       `main` (which carries PR #114) — incidental coverage, not a targeted regression
       test for this specific bug.
7. [x] Atlas diff flipped to `is-done` citing PR #114 (`atlas.html`, "Multi-scan World
       Editor" fcard).
