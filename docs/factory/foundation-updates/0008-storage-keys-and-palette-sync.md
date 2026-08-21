> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/storage-keys-palette-sync`
> **Commit style:** `refactor(shared): central storage-key constants + cv-palette sync test`
> **Design:** this ticket is the spec
> **Dependencies:** None
> **Status:** ✅ Done — merged via [PR #73](https://github.com/companionintelligence/CI-Spatial/pull/73)
> (commit `43f896c`), 2026-08-16. `video/capture.config.mjs:315` (mentioned in Goal as
> another site with the `'companion-scan-onboarded'` literal) was intentionally left
> untouched — it was never in this ticket's own Files impacted / Files to change list.

## Goal

Two small drift guards, both in `src/shared/`:

1. **Storage keys.** Five browser-storage keys are scattered as per-file literals:
   `'remote-log'` (`src/debug/remote-log.ts:35`), `'infer-mode'`
   (`src/inference/router.ts:62,74`), `'companion-scan-onboarded'`
   (`src/main.ts:503`), `'ci-xr-geo-fix'` (`src/geo/geo-tracker.ts:51`), and
   `'companion-scan-offline-queue'` + cache/sync names (`public/sw.js:1,33,89`,
   `src/pwa.ts:14`). Tests and tooling re-type them (`tests/ar-scan.spec.ts:22`,
   `tests/e2e-suite.spec.ts:13`, `tests/mock-ftue.spec.ts:129`,
   `video/capture.config.mjs:315`). Centralize the declarations. **Key values are
   frozen forever** — they name persisted user data (IndexedDB scan sessions, the
   offline upload queue, FTUE state); renaming any of them orphans real data.
2. **CV palette.** `public/test-fixtures/xr8-mock.js:43-46` carries a hand-mirrored
   copy of 4 of `src/shared/cv-palette.ts`'s 8 colours, guarded only by a "keep in
   sync" comment (`xr8-mock.js:19`). Since `xr8-mock.js` is a script-tag fixture that
   can't import a module, add a **sync test** that fails when the copies drift,
   instead of refactoring the fixture.

## Non-goals

- Do not rename any key value — see above. This includes leaving `'ci-xr-scan'`
  (IndexedDB DB name, `src/scene/store.ts:26`) exactly as-is; it's documented in
  0009's do-not-rename list.
- Do not convert `public/sw.js` or `public/test-fixtures/xr8-mock.js` to ES modules —
  the service worker and the mock fixture load standalone; give each a comment
  pointing at the constants/palette source instead.
- Do not touch the IndexedDB DB/store names in `src/scene/store.ts` beyond importing
  the new constant for the value it already uses.

## Pinned conventions

- ADR 0001: one declaration per key, everything else imports. Searched: the audit's
  storage-key sweep (grep `localStorage`/`sessionStorage` across `src/`, `public/`,
  `tests/`, `video/`) — the five keys plus the SW's cache/queue/sync names are the
  complete set.
- Location: `src/shared/storage-keys.ts` (precedent: `cv-palette.ts`,
  `test-homes.ts`). Playwright tests import from it directly (they're TS).
- Sync-test style: a Deno or Node test that reads `public/test-fixtures/xr8-mock.js`
  as text, extracts its `rgb(...)` literals, and asserts each matches the
  corresponding `CV_PALETTE` entry — same spirit as the existing fixture generators
  that read `test-homes.ts`.

## Before implementation

- All literal sites listed in Goal; `public/sw.js:89,198` + `src/pwa.ts:14` (the sync
  tag pair that must stay equal — a good candidate to assert in the same sync test).
- `scripts/generate-cv-images.mjs` (already imports the palette correctly — the model
  to follow, not change).

## Open questions & answers

- Q: Can `public/sw.js` import from `src/shared/storage-keys.ts`? — A: No — it's a
  classic (non-module) service worker; it keeps its literals plus a pointer comment,
  and the sync test asserts SW literals match the constants file (decided by ticket
  author, 2026-08-15).

## Files impacted

- New: `src/shared/storage-keys.ts`
- New: `sync.test.ts` at repo root (or extend an existing root test file — match
  `deno task test`'s file list; add it there)
- Changed: `src/debug/remote-log.ts`, `src/inference/router.ts`, `src/main.ts`,
  `src/geo/geo-tracker.ts`, `src/pwa.ts`, `src/scene/store.ts` (import constants)
- Changed: `public/sw.js`, `public/test-fixtures/xr8-mock.js` (pointer comments only)
- Changed: `tests/ar-scan.spec.ts`, `tests/e2e-suite.spec.ts`,
  `tests/mock-ftue.spec.ts` (import instead of retype)

## Schema required

None — constant declarations only; every value byte-identical to today's literals.

## Definition of Done

- [x] `src/shared/storage-keys.ts` declares every key with a comment stating what
      breaks if it's ever renamed (citing CLAUDE.md's "Do not rename" registry
      directly for the four keys already listed there, landed by 0009).
- [x] All `src/` and `tests/` literal sites import from it; `public/` files carry
      pointer comments.
- [x] The sync test fails if (a) xr8-mock's palette colours drift from `CV_PALETTE`,
      (b) sw.js's queue/cache/sync literals drift from the constants file, or
      (c) `src/pwa.ts`'s sync tag differs from `sw.js`'s. All three verified with a
      deliberate perturb-then-revert of a `CV_PALETTE` colour.

## Tests

- [x] `deno task check` passes.
- [x] The new sync test passes, and fails when a palette colour is deliberately
      perturbed (verify once, revert). Done: changed the sofa RGB by one value,
      confirmed only the palette-sync test failed with a clear diff, reverted,
      confirmed all 5 `sync.test.ts` tests pass again.
- [x] `npm run test:mock` passes (mock fixture + FTUE keys exercised). 27 passed /
      23 skipped; 3 pre-existing failures matching the known baseline.

```
deno task check
deno task test
npm run test:mock
```

## Acceptance Criteria

- [x] Given a future edit to `CV_PALETTE`, when tests run, then the stale xr8-mock
      copy is caught mechanically instead of by the "keep in sync" comment.

## Risks / potential issues

- **Risk:** regex-extracting colours from xr8-mock.js is brittle to formatting.
  — **Mitigation:** anchor on the existing `rgb(N,N,N)` literals and label names;
  if the fixture is ever rewritten the test fails loudly, which is the desired
  behavior.

## Subtasks

1. [x] Create `storage-keys.ts` with all keys + rename-consequence comments.
2. [x] Swap literal sites to imports (src + tests); add pointer comments (public).
       The three Playwright specs pass the constant into `addInitScript`/
       `page.evaluate` as an argument, since those closures serialize into the
       browser context and can't close over an outer import directly.
3. [x] Write the sync test (palette + SW literals + sync-tag pair); wire into
       `deno task test` (via `deno.json`).
4. [x] Run verification, including the deliberate-perturbation check.
