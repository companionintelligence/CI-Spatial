> **Type:** Infra
> **Wave:** 03-readiness-hardening
> **Branch:** `chore/pin-node-version`
> **Commit style:** `chore(tooling): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. First ticket in the wave — everything else is verified with commands that assume a working Node.

## Goal

Make the repo state the Node version it actually requires. Three `scripts/*.mjs` import
TypeScript directly, which only works once Node's type stripping is on by default
(22.18.0+). On an older Node they die with a bare `ERR_UNKNOWN_FILE_EXTENSION` and no
hint, and nothing in the repo says which version to use.

## Non-goals

- Do not convert the `.mjs` scripts to `.ts`, or compile them, or add a build step. The
  direct-`.ts`-import style is deliberate and works fine on a supported Node.
- Do not add `--experimental-strip-types` flags to the npm scripts. That flag is for
  older Node; pinning a supported version is the fix, and the flag would rot.
- Do not add a Node CI workflow. There is no Node job today (`.github/workflows/deno-ci.yml`
  pins only `deno-version: "2.9.5"`) and adding one is its own decision.
- Do not touch `scripts/bench-models.mjs` or `scripts/video-stage.mjs` — see Pinned
  conventions, they do **not** have this problem.
- Do not bump or change any dependency version.

## Pinned conventions

**ADR 0001** — this ticket adds no type, env var, route, or job type. It adds
declarative version metadata only. Verified that `package.json` has **no** `engines` field
and the repo has **no** `.node-version` and no `.nvmrc` (`grep -n '"engines"' package.json`;
`ls -a | grep -E '^\.node-version|^\.nvmrc'` — both empty at `6217e0b`).

**One existing Node version reference does exist and must not be contradicted:**
`Dockerfile:8` is `FROM node:22-alpine AS web`. That is a **floating** tag — it resolves to
the latest 22.x, which is currently ≥ 22.18 but is not pinned, so today's agreement between
it and the new floor is luck rather than design. State the relationship as "stays on the
same major line as the floating `node:22-alpine` tag" rather than claiming the two can never
disagree, and decide whether the Dockerfile should be pinned too (see Open questions).

Exactly three scripts import `.ts` into Node and therefore need type stripping. Verified
with `grep -n "from '.*\.ts'" scripts/*.mjs`:

| Script | Import | Reached by |
| --- | --- | --- |
| `scripts/generate-test-homes.mjs:21` | `from '../src/shared/test-homes.ts'` | `npm run gen:test-data` |
| `scripts/generate-cv-images.mjs:17` | `from '../src/shared/test-homes.ts'` | `npm run gen:test-data` |
| `scripts/smoke-pipeline.mjs:15` | `from '../pipeline.ts'` | `npm run smoke:pipeline` |

Explicitly **not** affected, though a loose `grep "\.ts'"` appears to match them:

- `scripts/bench-models.mjs:138` and `scripts/video-stage.mjs:174` pass the string
  `'main.ts'` as an **argv to `deno run`**. Deno reads it; Node never imports it.
- `scripts/test-box.mjs:156` writes a generated `.mjs` that imports `vite.config.ts`, but
  that file is loaded by **Vite**, which resolves TypeScript configs itself.

Minimum version: **22.18.0**. Node enabled type stripping by default in 22.18.0 (and
23.6.0 on the odd line). Verified that the imported modules use no `enum`, `namespace`,
or decorators — the constructs type stripping does *not* support — so plain stripping is
sufficient (`grep -n "enum \|namespace \|^\s*@" src/shared/test-homes.ts pipeline.ts`
returns nothing).

## Before implementation

1. `package.json` — the `scripts` block and where an `engines` field would sit.
2. `.github/workflows/deno-ci.yml` — confirm it pins only Deno and runs no Node job, so
   nothing in CI needs a matching bump.
3. `README.md` — the "Development Scripts" table, which documents `gen:test-data` and
   `smoke:pipeline` without stating a Node requirement.
4. `docs/factory/03-readiness-hardening/0005-*.md` — its verification commands assume the
   fixture generator runs; this ticket is what makes that assumption safe.

## Open questions & answers

- Q: `engines`, a `.node-version` file, or both? — A: **Both.** `engines` is what npm
  reads and what fails loudly; `.node-version` is what nvm/asdf/fnm read to *select* the
  right runtime automatically. Neither alone both selects and enforces. (decided during
  drafting, 2026-08-17)
- Q: Should `engines` be enforced rather than advisory? npm only warns by default. — A:
  **Yes, add `.npmrc` with `engine-strict=true`.** A warning is exactly what the current
  failure mode already is in spirit — something is wrong and the message doesn't say what.
  (decided during drafting, 2026-08-17)
- Q: Which exact minimum — 22.18.0, or the more conservative 24 LTS? — A: **`>=22.18.0`.**
  It is the true technical floor; pinning higher would exclude working setups for no
  reason. `.node-version` gets a concrete `22.18.0` as the *selected* version. (decided
  during drafting, 2026-08-17)
- Q: Does CI break? — A: No. There is no Node CI job; `deno-ci.yml` pins only Deno. Noted
  so a reviewer doesn't go looking. (decided during drafting, 2026-08-17)
- Q: Should `Dockerfile:8`'s `FROM node:22-alpine` be pinned to match? — OPEN. It is a
  floating tag that happens to satisfy the new floor today. Pinning it to `node:22.18-alpine`
  makes the guarantee real, but changes the image build and belongs to whoever owns
  deployment. **Recommendation: pin it**, and if that is declined, add the Dockerfile to
  whatever drift check the reviewer prefers so the two cannot silently diverge. Do not
  claim the floor is enforced in the container until one of those is done. (found by the
  reuse audit, 2026-08-17)

## Files impacted

- **Changed:** `package.json` — add an `engines` field.
- **New:** `.node-version` — the version managers read this.
- **New:** `.npmrc` — `engine-strict=true` so `engines` fails rather than warns.
- **Changed:** `README.md` — state the Node requirement where the scripts are documented.

## Schema required

None — no runtime type, env var, or wire-format change. The `engines` field is standard
npm metadata:

```json
"engines": { "node": ">=22.18.0" }
```

## Definition of Done

- [ ] `package.json` declares `"engines": { "node": ">=22.18.0" }`.
- [ ] `.node-version` exists at repo root containing `22.18.0`.
- [ ] `.npmrc` sets `engine-strict=true`.
- [ ] `README.md` states the Node requirement adjacent to the script table, naming type
      stripping as the reason so it doesn't read as arbitrary.
- [ ] `npm ci` on a supported Node still succeeds unchanged.
- [ ] `npm run gen:test-data` and `npm run smoke:pipeline` still succeed on a supported Node.

## Tests

This ticket is declarative metadata; it has no unit test. Verification is by command.

- [ ] On Node ≥ 22.18: `npm ci` succeeds and both scripts run.
- [ ] On Node < 22.18: `npm ci` fails with an `engines` error naming the required version
      — not `ERR_UNKNOWN_FILE_EXTENSION`. Verify with a second runtime if one is
      available; if not, state in the PR that this leg was not exercised rather than
      claiming it.
- [ ] No existing suite regresses.

```
node --version                      # expect >= 22.18.0
npm ci
npm run gen:test-data
npm run smoke:pipeline
deno task check && deno task test
```

## Acceptance Criteria

- [ ] **Given** a checkout and a version manager (nvm/asdf/fnm), **when** the contributor
      enters the directory, **then** `.node-version` selects a Node that can run the
      scripts.
- [ ] **Given** an unsupported Node, **when** `npm ci` runs, **then** it fails with a
      message naming the required version, instead of the scripts failing later with
      `ERR_UNKNOWN_FILE_EXTENSION`.
- [ ] **Given** the README, **when** a contributor reads the script table, **then** the
      Node requirement is stated there and says why.

## Risks / potential issues

- **Risk:** `engine-strict=true` is repo-wide and will also block contributors on an older
  Node who only wanted to run, say, `npm run build` — which may itself work fine.
  — **Mitigation:** Intended. A split where some scripts work and others fail obscurely is
  the current state and is worse. The error names the fix.
- **Risk:** `.npmrc` may already exist or be gitignored. — **Mitigation:** Check before
  creating; if it exists, add the key rather than overwriting, and confirm it is not in
  `.gitignore`.
- **Risk:** A future contributor adds a `.ts` import to `bench-models.mjs` or
  `video-stage.mjs` and assumes they were always covered. — **Mitigation:** The Pinned
  conventions table above records why those two are exempt today.
- **Risk:** Type stripping does not support `enum` / `namespace` / decorators, so a future
  edit to `src/shared/test-homes.ts` or `pipeline.ts` could break these scripts even on a
  supported Node. — **Mitigation:** Called out here; `npm run gen:test-data` in the
  verification set catches it.

## Subtasks

1. [ ] Re-verify the three affected scripts with `grep -n "from '.*\.ts'" scripts/*.mjs`.
2. [ ] Add `"engines": { "node": ">=22.18.0" }` to `package.json`.
3. [ ] Create `.node-version` containing `22.18.0`; confirm it is not gitignored.
4. [ ] Create or amend `.npmrc` with `engine-strict=true`.
5. [ ] Update the README script table area with the requirement and its reason.
6. [ ] Run the verification commands.
7. [ ] Flip this ticket's atlas diff to `is-done` with the merged PR number.
