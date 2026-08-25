> **Type:** Infra
> **Wave:** foundation-updates
> **Branch:** `test/typecheck-specs`
> **Commit style:** `test(infra): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Bring `tests/*.spec.ts` under a real TypeScript check, so a type error in a Playwright
spec is caught by a command someone actually runs. Today none of them are checked by
anything, which means a spec's type annotations can be wrong — including wrong in ways
that silently switch checking off — and every verification command in the repo still
reports success.

## Why this is not cosmetic

`tsconfig.json` ends with `"include": ["src"]`. Nothing under `tests/` is in the
program. The three places a frontend type-check happens all inherit that scope:

| Where | Command | Covers `tests/`? |
| --- | --- | --- |
| `package.json` `"verify"` | `deno task check && deno task test && tsc --noEmit && …` | no |
| `package.json` `"build"` | `tsc --noEmit && vite build` | no |
| `.githooks/pre-push` | `npm run verify` | no |
| `.github/workflows/deno-ci.yml` | `deno task check`, `deno task test` | no — it never runs `tsc` at all |

Playwright itself transpiles with esbuild and does not type-check. So a spec is checked
by **nothing**, on any machine, at any point.

**This was found the expensive way.** Wave 09 ticket 0007 (PR #176) shipped a helper
annotated `Promise<Record<string, never>>`. That type is not merely wrong about the
return value — `Record<string, never>` makes every indexed value `never`, so the four
`expect()` calls reading through it were comparing `never` and accepting anything. A
reviewer caught it by eye; `npx tsc --noEmit`, `npm run verify`, the pre-push hook and
CI all passed with it in place, and would have kept passing indefinitely. Verifying the
*fix* required hand-writing a throwaway tsconfig, which is what surfaced this ticket.

Every wave-09 ticket lists `npx tsc --noEmit` in its Definition of Done. For anything
under `tests/`, that line has never meant what it appears to mean.

## The actual scope, measured

Run before drafting, against `main` at `c904765` plus PR #176, with a tests-only
project extending the root config:

- **34 spec files. 27 are already type-clean.** Only 7 have errors at all.
- **64 errors total**, of which **41 are not real defects**: they are
  `await import('/src/capture/capture.ts')` and similar **inside `page.evaluate()`** —
  browser-runtime specifiers that Vite resolves in the page and TypeScript cannot
  resolve and should not try to. These need a documented, narrowly-scoped suppression,
  **not** a rewrite.
- The remaining ~23 are genuine, and concentrated:

| File | Errors | Nature |
| --- | --- | --- |
| `tests/e2e-suite.spec.ts` | 38 | mostly the `page.evaluate` imports; plus `WorldDetection[]` fixture drift (TS2345), `Cannot find namespace 'THREE'` (TS2503), one implicit `any` (TS7006) |
| `tests/server.spec.ts` | 15 | TS2345 argument mismatches |
| `tests/mock-splat-toolbox.spec.ts` | 4 | |
| `tests/mock-splat-train.spec.ts` | 3 | |
| `tests/mock-editor-homes.spec.ts` | 2 | |
| `tests/mock-lingbot-map.spec.ts` | 1 | |
| `tests/mock-editor-quality.spec.ts` | 1 | |

The TS2345s are the interesting ones: they are object literals built as
`WorldDetection` fixtures that no longer match `WorldDetection`. That is exactly the
drift this ticket exists to make visible, and it is evidence the check earns its keep
rather than a reason to defer it.

**`@types/node` is not installed** (`node_modules/@types/` holds only `leaflet`,
`three`, `webxr`). Specs use `Buffer` — `tests/api-house-readiness.spec.ts`,
`tests/api-reference-photos.spec.ts`, `tests/mock-two-point-calibration.spec.ts` — so
the tests project needs it as a `devDependency`.

## Non-goals

- **Do not fold `tests/` into the root `tsconfig.json`.** Its `lib` is
  `ES2022, DOM, DOM.Iterable` on purpose — a browser program. Specs are Node programs
  that drive a browser and need Node and Playwright types the app must never see.
  Folding them in also puts spec files in `npm run build`'s type graph, which is the
  class of cross-runtime leak ADR 0002 exists because of.
- **Do not add `tests/unit/deno/` to the TypeScript project.** Those use `jsr:`
  specifiers and Deno globals; `deno task check` and `deno task test` already
  type-check them, and CI runs both. `playwright.config.ts` already `testIgnore`s
  `**/unit/**` for the same class of reason.
- **Do not rewrite the `page.evaluate()` dynamic imports to static imports.** They are
  runtime-resolved by Vite in the page by design; making them static would change what
  the test executes.
- **Do not fix a real type error by loosening the type in `src/`.** The fixtures are
  stale, not the schema. If a fixture cannot be made to satisfy `WorldDetection`, that
  is a finding to report, not a cast to add.
- **Do not change what any test asserts.** This ticket makes existing tests
  type-check; it does not alter a single expectation. Any spec whose behaviour changes
  is a bug in this ticket.
- Do not add `tsc` to `.github/workflows/deno-ci.yml`. That workflow is Deno-only and
  installs with `deno install`, not `npm ci`; wiring a Node type-check into it is its
  own decision about CI shape. The pre-push hook is where this repo's frontend
  type-check lives today, and this ticket keeps it there.

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — no schema, env var or
client↔server connection is touched, but the reuse rule still applies to verification
entry points. What is reused rather than duplicated:

| Existing | Where | How used |
| --- | --- | --- |
| `tsconfig.json` | repo root | the tests project **extends** it, overriding only `include`, `lib`/`types`, and any check deliberately relaxed for tests. Compiler options are not restated. |
| `npm run verify` | `package.json:11` | gains the new script in its existing `&&` chain. No second verification entry point. |
| `.githooks/pre-push` | | unchanged — it already runs `npm run verify`, so it picks this up for free. Its own comment promises the checks are hermetic (no servers, no browsers, no corpus); a type-check keeps that promise. |

**ADR 0002**
(`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`)
— read it before adding any type shared between a spec and `src/`. A spec that
`import type`s from a Deno driver file drags that file's `Deno.*` calls into the
type-check graph. This is the first time specs will be in a `tsc` program at all, so it
is the first time that can bite.

**Naming.** `tsconfig.tests.json` at the repo root, matching the existing flat
`tsconfig.json` / `playwright.config.ts` / `vite.config.ts` layout — the repo has no
`config/` directory and should not gain one here.

**Script naming.** `"typecheck:tests"`, following the existing `test:*` colon
convention in `package.json` rather than inventing a new separator.

## Before implementation

- `tsconfig.json` — the whole file; note `include`, `lib`, `strict`,
  `noUnusedLocals`, `noUnusedParameters`.
- `package.json:10-11` — the `build` and `verify` scripts, and the `test:*` block for
  the naming convention.
- `.githooks/pre-push` — its comment states exactly which checks belong there and why.
- `playwright.config.ts` — the `testIgnore: '**/unit/**'` comment explains why Deno
  unit tests must stay out of any Node/TS program, and is the precedent for this
  ticket's equivalent exclusion.
- `tests/e2e-suite.spec.ts:152` — a representative `await import('/src/...')` inside
  `page.evaluate()`, the pattern behind 41 of the 64 errors.
- `tests/e2e-suite.spec.ts:712` — a representative stale `WorldDetection` fixture.

## Open questions & answers

- Q: Separate `tsconfig.tests.json`, or extend the root `include`? — A: **Separate.**
  The root config is a browser program (`lib: DOM`, no Node types) and is consumed by
  `vite build`; specs are Node programs. Folding them in would both pollute the
  production build's type graph and force Node types into the app's `lib`. (Decided in
  this ticket.)
- Q: Should the 41 `page.evaluate` import errors be fixed or suppressed? — A:
  **Suppressed, narrowly and with a comment naming the reason.** They are not defects:
  the specifier is resolved by Vite in the page at runtime. A blanket
  `// @ts-nocheck` on the file would be wrong — it would take the 23 real errors down
  with it, which is the opposite of this ticket's point. Prefer a targeted
  `// @ts-expect-error` (or a typed `evaluateModule` helper) per site, so a *new* bad
  import in the same file still fails. (Decided in this ticket.)
- Q: Does `noUnusedLocals` / `noUnusedParameters` want relaxing for specs? — A:
  **Decide from the measurement, not in advance.** The scope run above disabled both
  and reported 64 errors; re-run with them enabled and, if the delta is small and the
  findings are genuine dead code, keep them on. Record the number either way.
- Q: Which spec files must this cover — all of `tests/`, or only what CI/devs run? —
  A: **All 34 `tests/*.spec.ts`.** Excluding a file because it is currently red would
  reproduce this ticket's own root cause on a smaller scale. If `e2e-suite.spec.ts`
  turns out to be dead (it is the largest offender at 38 errors — check whether any
  npm script or workflow still runs it), deleting it is a legitimate resolution;
  silently excluding it is not. (Decided in this ticket.)
- Q: Does this need `@types/node`? — A: **Yes**, as a `devDependency`. Confirmed
  missing, and `Buffer` is used in at least three specs. Install with `npm ci`
  semantics in mind — see CLAUDE.md: `npm install` mutating an existing tree is what
  corrupts it, so add the dep and then `rm -rf node_modules && npm ci`. (Decided in
  this ticket.)

## Files impacted

New:
- `tsconfig.tests.json`

Changed:
- `package.json` (the `typecheck:tests` script; `verify` chain; `@types/node` devDependency)
- `package-lock.json` (`@types/node`)
- `tests/e2e-suite.spec.ts`, `tests/server.spec.ts`, `tests/mock-splat-toolbox.spec.ts`,
  `tests/mock-splat-train.spec.ts`, `tests/mock-editor-homes.spec.ts`,
  `tests/mock-lingbot-map.spec.ts`, `tests/mock-editor-quality.spec.ts` — the 7 files
  with errors. **Re-measure before trusting this list**; it was taken at `c904765` +
  PR #176 and specs change often.
- `CLAUDE.md` — one line under Key commands, so the next person knows the command
  exists. `npx tsc --noEmit` alone has been quietly misleading every ticket that cited it.

## Schema required

None.

## Definition of Done

- [ ] `tsconfig.tests.json` exists, extends the root config, and includes exactly
      `tests/**/*.spec.ts` — not `tests/unit/**`
- [ ] `npm run typecheck:tests` exists and exits non-zero on a type error in any spec
- [ ] `npm run verify` runs it, so `.githooks/pre-push` picks it up with no hook change
- [ ] `@types/node` is a devDependency and `Buffer` resolves in specs
- [ ] All 34 `tests/*.spec.ts` type-check clean
- [ ] The `page.evaluate` dynamic-import specifiers are suppressed **per site with a
      comment naming why**, never file-wide
- [ ] Every genuine error is fixed in the spec, not by weakening a type in `src/`
- [ ] No test's assertions changed; the suites behave identically
- [ ] `CLAUDE.md` Key commands mentions the new command
- [ ] `npx tsc --noEmit`, `deno task check`, `deno task test`, `npm run typecheck:tests` pass

## Tests

- [ ] **Negative control — this is the whole ticket, so prove it.** Inject a deliberate
      type error into a spec (e.g. read a property that does not exist on a real
      schema type), confirm `npm run typecheck:tests` fails and names it, then revert.
      The PR description must quote the error text. A green run proves nothing on its
      own: a misconfigured `include` also produces a green run, which is precisely the
      state this ticket is fixing
- [ ] Negative control for scope: confirm `npm run build` and the root
      `npx tsc --noEmit` still do **not** pull spec files in, so the production build
      is unaffected
- [ ] Confirm `tests/unit/deno/` is excluded — its `jsr:` specifiers must not appear
      as errors
- [ ] Re-run the affected Playwright suites and confirm identical results to before,
      since the point is that behaviour did not change:
      `--project=chromium-mock` for the `mock-*` files touched, `--project=api` for the
      `api-*` files touched

```bash
npm run typecheck:tests && npm run verify && npm run build
```

## Acceptance Criteria

- [ ] Given a spec with a type error, When `npm run verify` runs, Then it fails and
      names the file and line
- [ ] Given the PR #176 regression re-introduced (`readPlace()` annotated
      `Promise<Record<string, never>>`), When the check runs, Then it fails — the
      specific case that motivated this ticket
- [ ] Given `npm run build`, Then no file under `tests/` is in its program
- [ ] Given a spec's `page.evaluate` runtime import, Then it does not error, and a
      *different* bad import in the same file still does
- [ ] Given the full Playwright suites, Then their pass/fail set is unchanged from
      before this ticket

## Risks / potential issues

- **Risk:** A blanket suppression is the easy way to "finish" this, and it would leave
  the repo in exactly the state it is in now while *appearing* fixed — worse than
  today, because the check would look like coverage. — **Mitigation:** the per-site
  requirement is in the Definition of Done, and the negative-control test is written
  to catch a file-wide `@ts-nocheck`.
- **Risk:** The TS2345 `WorldDetection` fixtures may be stale because the *fixture* is
  wrong, or because the *schema* drifted and the tests were right. Those need opposite
  fixes. — **Mitigation:** check each against `src/world/types.ts` and its git history
  before editing; if a fixture is right and the schema moved, that is a finding worth
  reporting, not a cast.
- **Risk:** `@types/node` in the tests program can leak Node globals into editor
  IntelliSense for `src/` files if the tests config is picked up by the language
  server for the wrong files. — **Mitigation:** keep `include` tight and verify the
  root config still resolves first for `src/`.
- **Risk:** Adding a devDependency invites `npm install`, which CLAUDE.md documents as
  the thing that corrupts this repo's tree and produces a Playwright error naming the
  wrong cause. — **Mitigation:** `rm -rf node_modules && npm ci` after the
  `package.json` edit, and say so in the PR.
- **Risk:** The 64/7 measurement ages. — **Mitigation:** re-run the scope command
  first; treat the table above as the state at `c904765`, per this wave's standing
  "grep ground truth yourself" convention.

## Subtasks

1. [ ] Re-measure: build a throwaway tests-only project extending `tsconfig.json` and
       record the current error count per file, with `noUnusedLocals` both on and off
2. [ ] Add `@types/node` as a devDependency; `rm -rf node_modules && npm ci`
3. [ ] Add `tsconfig.tests.json` (extends root; `include` = `tests/**/*.spec.ts`)
4. [ ] Add `"typecheck:tests"` to `package.json` and chain it into `"verify"`
5. [ ] Suppress the `page.evaluate` runtime-import specifiers per site, each with a
       comment naming why TypeScript cannot resolve them
6. [ ] Fix the genuine errors, file by file, smallest first — `mock-editor-quality`
       and `mock-lingbot-map` (1 each) before `server.spec.ts` (15) and
       `e2e-suite.spec.ts` (38)
7. [ ] Determine whether `tests/e2e-suite.spec.ts` is still run by anything; if not,
       propose deleting it rather than repairing it, and say so explicitly
8. [ ] Run the negative control; quote the failure in the PR
9. [ ] Re-run the touched Playwright suites; confirm the pass/fail set is unchanged
10. [ ] Add the command to `CLAUDE.md` Key commands
11. [ ] `npm run typecheck:tests && npm run verify && npm run build`
