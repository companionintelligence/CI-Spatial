> **Type:** Frontend
> **Wave:** 03-readiness-hardening
> **Branch:** `fix/bundle-leaflet`
> **Commit style:** `fix(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** `0001` (a supported Node for the install). Verification of the browser leg wants `0003`.

## Goal

Bundle Leaflet from npm instead of fetching it from unpkg at runtime, and delete the
loader race that makes the map crash. The repo already declares `@types/leaflet` but not
the runtime package, so the library only ever arrives over the network — and the loader
resolves before the script has executed, handing `undefined` to `L.map()`.

**Honest scope:** this does not make the map fully offline. Tile imagery still comes from
`basemaps.cartocdn.com` (`src/viewer/geomap.ts:137`, `src/main.ts:1297`). Offline yields a
dark map canvas with correctly-positioned pins and popups, but no tiles. That is a large
improvement over a crash, and it is not "works offline".

## Non-goals

- Do not self-host or vendor map **tiles**. Out of scope; see Goal.
- Do not edit `APP_SHELL` in `public/sw.js:9-21`. Bundled assets get hashed filenames that
  cannot be listed statically, and `staleWhileRevalidate` already covers them.
  (An earlier draft also claimed `APP_SHELL` is drift-guarded by `sync.test.ts`. **That is
  false** — `sync.test.ts` guards `CV_PALETTE` and `OFFLINE_QUEUE_DB_NAME` /
  `SW_CACHE_NAME` / `SW_SYNC_TAG`. `APP_SHELL` has no guard. The reason not to touch it
  stands on the hashed-filename argument alone.)
- Do not add a new degradation UI. `GeoMap._setEmptyState()` already exists and already
  receives `'Map unavailable'` — it was merely unreachable.
- Do not add a new spec file. Two existing tests already own this scenario by name.
- Do not widen the CDN assertion beyond `unpkg.com` in this ticket.
- Do not change tile URLs, zoom behaviour, pin rendering, or the drawer's layout.

## Pinned conventions

**ADR 0001** — this changes a client dependency and a client↔network connection, so it
states what it reuses. Verified at `6217e0b`:

| Existing | Where | How used |
| --- | --- | --- |
| `@types/leaflet@^1.9.21` | `package.json:53` (devDependencies) | this adds the **missing runtime half** of a dependency the repo already half-declares; the types stay in devDependencies because `leaflet@1.9.4` ships no `types` field |
| `loadLeaflet()` | `src/viewer/geomap.ts:27-55` | body replaced; name, signature and return type kept, so its single call site (`:113`) is untouched |
| `GeoMap._L` + its try/catch | `src/viewer/geomap.ts:61, 112-118` | reused — the failure path already exists and is correct |
| `GeoMap._setEmptyState()` | `src/viewer/geomap.ts:204-211` | reused — the existing user-visible degradation channel |
| `staleWhileRevalidate()` | `public/sw.js:88, 120-129` | reused with **zero** `sw.js` changes — it already caches same-origin GETs outside `API_PREFIXES`; the current unpkg URL can never be cached because `public/sw.js:74` hard-returns on cross-origin |
| `initDrawerGeoMap()` | `src/main.ts:1281` | extended sync→async; its only caller (`src/main.ts:191-192`) is already fire-and-forget |
| `import('leaflet').Map` / `.Marker` | via `@types/leaflet` | **replaces** the hand-rolled `LeafletMap`/`LeafletMarker` structural subsets at `src/main.ts:1266-1270` |
| `tests/e2e-suite.spec.ts:892-912` "Test 30: CDN Load Rejections for Leaflet" | | **the** existing home for this regression — extended, not duplicated |
| `tests/ar-scan.spec.ts:649-658` | | already asserts `.leaflet-container` visible; must keep passing, and becomes network-independent |
| `vite.config.ts:127-134` `rollupOptions.input` | | unchanged — Vite already builds both entry points |
| `npm run verify` (`package.json:8`) | | reused as-is; no new verification script |

Collapsing the hand-rolled types is the same ADR 0001 pattern the repo has already applied
twice — `foundation-updates/0005` (two hand-written manifest subsets) and `0007`
(`WorldDetection`'s restated fields).

**The two defects, precisely:**

- **The race** — `src/viewer/geomap.ts:45`:
  `if (document.querySelector('script[data-leaflet]')) { resolve(); return }` tests for the
  tag's *presence*, not its *execution*. A tag still in flight (or one that already fired
  `onerror`) satisfies the selector, so `loadLeaflet()` resolves immediately and `:54`
  returns `window['L']` — `undefined`, laundered through an unchecked `as` cast that
  suppresses the error TypeScript would otherwise raise.
- **The uncaught throw** — the caller's `try` closes at `src/viewer/geomap.ts:119`, but
  `const L = this._L` (`:121`) and `L.map(this._mapEl!, …)` (`:130`) are **outside** it, so
  the resulting `TypeError: Cannot read properties of undefined (reading 'map')` is not
  caught by geomap's own handler.

**Loading:** use dynamic `await import('leaflet')` in **both** files, not a static import.
The main entry chunk is only ~145 KB against a ~5.1 MB viewer chunk; an eager import would
roughly double the phone capture app's critical path for a feature behind a drawer.

## Before implementation

1. `src/viewer/geomap.ts:27-55` (loader), `:61`, `:112-140` (caller, try boundary),
   `:204-211` (`_setEmptyState`), `:260-271` (style overrides).
2. `src/main.ts:1264-1345` — the drawer geo-map block, including the hand-rolled types at
   `:1266-1270` and the caller at `:191-192`.
3. `index.html:21-23` — the static CDN `<link>` and `<script>`.
4. `public/sw.js:9-21, 74, 88, 120-129` — enough to confirm no `sw.js` edit is needed.
5. `tests/e2e-suite.spec.ts:892-912` — Test 30 as it stands.
6. `vite.config.ts:127-134` — the build inputs.

## Open questions & answers

- Q: Bundle from npm, or keep the CDN and fix the loader? — A: **Bundle.** Decided at the
  wave's Phase 3 gate. The types are already vendored, so this completes a half-declared
  dependency rather than adding one; it removes an availability dependency on unpkg; and it
  makes the library same-origin and therefore cacheable by the existing service worker,
  which a CDN URL can never be. (decided by user at Phase 3 approval, 2026-08-17)
- Q: Static or dynamic import? — A: **Dynamic, in both files**, with per-chunk byte budgets
  in Definition of Done. (decided during drafting, 2026-08-17)
- Q: Does Vite's CJS→ESM interop expose `{ default: L }` rather than named exports, which
  would leave `L.map` undefined at runtime while `tsc` stays green? — A: **No.** Confirmed
  from source: `dist/leaflet-src.js` ends with explicit `exports.map = createMap;
  exports.marker = marker; exports.tileLayer = tileLayer; exports.divIcon = divIcon; …`.
  Verify once at runtime anyway — the acceptance criteria require the map to actually
  render. (decided during drafting, 2026-08-17)
- Q: New spec file for the offline case? — A: **No.** `e2e-suite` Test 30 already owns this
  by name and is cited in `TEST_INFRA.md:78`; it simply asserts nothing today (its
  `return threw || geoMap !== null` is tautological). Extend it. A third file would be the
  test-suite version of this repo's duplicate-`ScanManifest` mistake. (decided during
  drafting, 2026-08-17)
- Q: Should `@types/leaflet` move to `dependencies`? — A: **No** — it stays in
  devDependencies; only the runtime package is added. (decided during drafting, 2026-08-17)

## Files impacted

- **Changed:** `package.json` — add `"leaflet": "1.9.4"` to `dependencies` (it ships in the
  browser bundle), beside `three` / `@sparkjsdev/spark` / `@huggingface/transformers`.
- **Changed:** `package-lock.json` — regenerated by
  `npm install leaflet@1.9.4 --save-exact`. No hand edits.
- **Changed:** `src/viewer/geomap.ts` — `import 'leaflet/dist/leaflet.css'`; replace the
  whole body of `loadLeaflet()` (`:27-55`) with a dynamic `await import('leaflet')`,
  deleting the `window.L` fast path, the CSS `<link>` injection, the `<script>` injection
  and the presence-test race; move the `L.map(...)` construction inside the existing `try`.
- **Changed:** `index.html` — delete lines 21-23 (the comment, the CDN `<link>`, and the
  render-blocking `<script>`).
- **Changed:** `src/main.ts` — `initDrawerGeoMap` (`:1281`) becomes `async`, `void`-ed at
  its caller; the `window.L` global read becomes `await import('leaflet')`; delete the
  hand-rolled `LeafletMap`/`LeafletMarker` types (`:1266-1270`) in favour of
  `import('leaflet').Map` / `.Marker`.
- **Changed:** `tests/e2e-suite.spec.ts` — rewrite Test 30 (`:892-912`).
- **Changed:** `TEST_INFRA.md:78` — the line claims "CDN Leaflet library load failure
  recovery", which is false twice over (nothing was asserted, and there is no longer a CDN).
- **Changed:** `docs/UI_MANUAL.md` — `:347` cites `src/main.ts:884-947` for
  `initDrawerGeoMap`, which now lives at `1264-1345`; fix the citation while editing it.
- **Changed:** `docs/factory/atlas.html` — see the wave README.

## Schema required

None. No domain type, env var, route, or job type. `leaflet` is a build-time dependency
addition; the only type change **removes** two hand-rolled interfaces in favour of the
already-vendored `@types/leaflet` declarations.

## Definition of Done

- [ ] `leaflet@1.9.4` is in `dependencies`; `package-lock.json` regenerated by npm.
- [ ] No `unpkg.com` reference remains anywhere in `src/`, `index.html`, or `viewer.html`
      (`grep -rn unpkg . --exclude-dir=node_modules` is clean).
- [ ] `loadLeaflet()` keeps its name, signature and return type; its call site is untouched.
- [ ] Both files load Leaflet via dynamic `await import('leaflet')`.
- [ ] The `L.map(...)` construction is inside the existing `try`, so a failed load reaches
      `_setEmptyState('Map unavailable')` instead of throwing uncaught.
- [ ] The hand-rolled `LeafletMap`/`LeafletMarker` types are gone.
- [ ] Chunk budgets recorded from `ls -la dist/assets/`: the main entry chunk does not grow
      materially (it must not absorb Leaflet), and Leaflet appears in its own lazily-loaded
      chunk.
- [ ] `npm run verify` passes.

## Tests

- [ ] `tests/e2e-suite.spec.ts` Test 30 — rewritten. Install
      `page.route('**unpkg.com/**', r => r.abort())` **before** `page.goto`, record
      requests, and assert `cdnHits` is `[]`. Delete the tautological
      `return threw || geoMap !== null`.

      **Three blockers the first draft would have hit — the rewrite must handle all of
      them, or it cannot pass:**
      1. The existing test creates its own `<div id="geomap-drawer">` at `:895-897`, and
         `geoMap.mount()` then builds a **second** element with the same id
         (`geomap.ts:215`). A `#geomap-drawer` locator resolves to the first, empty one.
         Delete the stray div.
      2. `_buildDrawer()` sets `display: none` (`geomap.ts:222`) and only `open()` flips it
         to flex (`geomap.ts:84`). A test that never opens the drawer will find
         `.leaflet-container` present but **not visible**, so `toBeVisible()` fails. Either
         call `geoMap.open()` or drive the real UI the way `tests/ar-scan.spec.ts:650-652`
         does.
      3. Scope the render assertion out of this test entirely — `ar-scan.spec.ts:650-652`
         already owns it against the real UI. Test 30 should own **only** the network
         assertion, or the two should be folded together. Asserting the render in both is
         the duplication this wave is supposed to avoid.
- [ ] `tests/ar-scan.spec.ts:649-658` — must keep passing, now without network reliance.
- [ ] `tests/mock-ui-desktop.spec.ts:107-113` → `docs/ui-flow/desktop/10-geomap.png` — the
      visual check for the CSS load-order change.
- [ ] Type-level: `tsc --noEmit` clean after deleting the hand-rolled types.

```
export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"
npm install leaflet@1.9.4 --save-exact
npm run verify                       # deno task check && deno task test && tsc --noEmit
npm run build && ls -la dist/assets/ # record chunk sizes; leaflet must be its own chunk
grep -rn unpkg . --exclude-dir=node_modules --exclude-dir=dist   # expect no hits

# browser legs (need Vite + Deno up)
export CHROMIUM_EXECUTABLE_PATH=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
VITE_URL=https://localhost:5173 npx playwright test --project=webkit-desktop tests/e2e-suite.spec.ts -g "Test 30"
VITE_URL=https://localhost:5173 npx playwright test --project=webkit-desktop tests/ar-scan.spec.ts -g "geomap"
VITE_URL=https://localhost:5173 npx playwright test --project=chromium-mock tests/mock-ui-desktop.spec.ts
```

## Acceptance Criteria

- [ ] **Given** all requests to `unpkg.com` are blocked, **when** the geomap drawer is
      opened, **then** the map renders with pins and **zero** requests reach unpkg.
- [ ] **Given** the dynamic import fails, **then** the drawer shows `Map unavailable` via
      the existing `_setEmptyState` and no uncaught `TypeError` reaches the console.
- [ ] **Given** a built bundle, **then** Leaflet is in its own chunk and the main entry
      chunk has not materially grown.
- [ ] **Given** the map renders, **then** `L.map` resolved to a real function — proving the
      CJS→ESM interop exposes named exports as expected.
- [ ] **Given** map chrome styling, **then** it is unchanged from the committed
      `10-geomap.png` reference.

## Risks / potential issues

- **Risk:** Vite's CJS→ESM interop could expose `{ default: L }`, leaving `L.map` undefined
  at runtime while `tsc` stays green (because `@types/leaflet` declares named exports).
  — **Mitigation:** Confirmed from `dist/leaflet-src.js`'s explicit `exports.*` assignments;
  backstopped by an acceptance criterion that the map actually renders.
- **Risk:** `import 'leaflet/dist/leaflet.css'` is the **first** CSS import in the repo
  (`find dist -name '*.css'` currently returns nothing), so build output shape changes — new
  `dist/assets/*.css` and injected `<link>` tags. — **Mitigation:** Call it out in the PR;
  functionally it is an improvement, since the CSS becomes same-origin and SW-cacheable.
- **Risk:** Leaflet's stylesheet lands in a different cascade position, changing map chrome.
  — **Mitigation:** Audited — `index.html:1356-1360` all use `!important` and
  `src/viewer/geomap.ts:260-271` uses higher-specificity compound selectors, so both win
  under any ordering. Backstopped by the screenshot check.
- **Risk:** Making `initDrawerGeoMap` async turns a sync click handler into fire-and-forget,
  so a rejected import becomes an unhandled rejection rather than a silent return.
  — **Mitigation:** Its only caller (`src/main.ts:191-192`) is already fire-and-forget; wrap
  the `await import` in the same try/catch shape geomap uses.
- **Risk:** Readers will assume "bundled" means the map works offline. — **Mitigation:**
  Stated in the Goal, and required in the atlas "after" text: pins yes, tiles no.
- **Risk:** Test 30 runs under `webkit-desktop`, which needs live servers — easy to skip
  locally and let this regress. — **Mitigation:** Commands listed verbatim above;
  `npm run verify` (enforced by `.githooks/pre-push`) still catches the type-level half.
- **Risk:** A future contributor re-adds a CDN `<script>` for a different library.
  — **Mitigation:** Out of scope to prevent generally; the assertion is unpkg-scoped by
  design. Widening it to any cross-origin script host is a reasonable follow-up.

## Subtasks

1. [ ] Read the six locations in "Before implementation".
2. [ ] `npm install leaflet@1.9.4 --save-exact`.
3. [ ] Rewrite `loadLeaflet()`'s body; add the CSS import; move `L.map(...)` inside the
       existing `try`.
4. [ ] Delete `index.html:21-23`.
5. [ ] Convert `initDrawerGeoMap` to async; replace the `window.L` read; delete the
       hand-rolled types.
6. [ ] `npm run verify`, then `npm run build` and record chunk sizes.
7. [ ] Rewrite Test 30 with the route-abort and the `cdnHits` assertion; confirm it **fails**
       against the pre-fix code.
8. [ ] Run the three browser legs; refresh `10-geomap.png` only if the diff is explainable.
9. [ ] Fix `TEST_INFRA.md:78` and the stale `docs/UI_MANUAL.md:347` citation.
10. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
