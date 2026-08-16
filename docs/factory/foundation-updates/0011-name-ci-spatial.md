> **Type:** Refactor / Docs
> **Wave:** foundation-updates
> **Branch:** `refactor/name-ci-spatial`
> **Commit style:** `refactor(naming): rename cosmetic Companion-Scan identifiers to CI-Spatial`
> **Design:** this ticket is the spec
> **Dependencies:** 0009 (hard — 0009 logs the naming decision as an open question;
> this ticket implements whichever answer that question gets, and must not start
> until it's actually answered by an owner)

## Goal

0009 found a real naming split and correctly refused to resolve it: the repo is
`CI-Spatial` on GitHub, but the running product still calls itself "Companion Scan"
internally — `package.json`'s name (`companion-scan-web`), the glTF `generator` tag
(`src/export/gltf.ts:110`, `'ci-xr-scan'`), the geo-tracker's User-Agent string
(`src/geo/geo-tracker.ts:196`, `'ci-xr-scan/1.0'`), plus prose across
`scripts/generate-test-homes.mjs`, `TEST_INFRA.md`, `history/ORIGINAL_REQUEST.md`,
`video/package.json`, and `video/storyboard.json`. **This ticket does not decide the
name.** It exists only to execute the rename once an owner answers 0009's open
question, so the decision and the mechanical work stay separate and the mechanical
work doesn't stall the decision.

## Non-goals

- Do not touch anything on 0009's frozen list — `src/scene/store.ts`'s IndexedDB
  name `'ci-xr-scan'`, the `'ci-xr-geo-fix'` sessionStorage key, the SW's
  `'companion-scan-*'` cache/queue/sync-tag names, the GHCR image name
  (`ghcr.io/companionintelligence/ci-web-xr-scan`), the OIDC client id
  (`'ci-web-xr-scan'`), or `memory_push.ts`'s `sourceSystem` default
  (`'companion-scan'`). Every one of those breaks persisted user data or an external
  integration if renamed — 0009 froze them for a reason that doesn't change here.
- Do not open a PR for this ticket until the naming decision (0009's open question)
  has an explicit, dated answer from an owner recorded in this ticket's Open
  Questions section. A ticket implementing an unmade decision is exactly the kind of
  guessing this repo's ticket discipline exists to prevent.
- Do not rename anything user-facing in the UI copy itself (onboarding text, HUD
  labels) unless the decision explicitly covers UI copy — scope this to the
  *identifiers* 0009 listed as cosmetic-safe, not a full rebrand, unless told
  otherwise.

## Pinned conventions

- Whatever name wins, apply it consistently across every site 0009 marked
  cosmetic-safe — do not rename some and leave others, which would recreate exactly
  the kind of split this ticket exists to close.
- ADR 0001: this doesn't add a new identifier, it consolidates existing ones onto one
  name — consistent with "reuse, don't duplicate," applied to naming instead of code.

## Before implementation

- 0009's "Safe to rename (cosmetic)" list in full — it is the authoritative scope
  boundary for this ticket; re-verify each item still applies (grep fresh, don't
  trust the list without re-checking, since other tickets in this wave may have
  touched some of these files).
- The owner's actual decision, once made — read it before touching anything.

## Open questions & answers

- Q: Companion Scan or CI-Spatial, for the cosmetic-safe identifiers listed above? —
  OPEN — owner decision required before this ticket can start. Record the answer,
  who made it, and the date here the moment it's available.

## Files impacted

Per 0009's cosmetic-safe list (re-verified at implementation time):
`package.json`, `package-lock.json`, `src/export/gltf.ts`,
`src/geo/geo-tracker.ts`, `scripts/generate-test-homes.mjs`, `TEST_INFRA.md`,
`history/ORIGINAL_REQUEST.md`, `video/package.json`, `video/storyboard.json`, and any
remaining prose hits in `docs/*.md`.

## Schema required

None.

## Definition of Done

- [ ] The Open Question above has a recorded, dated, owner-attributed answer.
- [ ] Every cosmetic-safe identifier from 0009's list consistently reflects that
      answer.
- [ ] Every identifier on 0009's frozen list is unchanged (verify by diff — this
      ticket's diff should contain zero hits on any frozen name).
- [ ] `deno task check` and `npm run build` still pass (glTF generator tag and UA
      string changes are string literals, not structural — should be inert, but
      verify).

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run build` passes.
- [ ] Manual: export a scan to GLB, confirm the `generator` field in the output
      matches the new name and the file still loads correctly in the viewer.

```
deno task check
npm run build
```

## Acceptance Criteria

- [ ] Given the repo after this ticket, when a reader compares `package.json`'s name,
      the glTF generator tag, and the UA string, then all three agree — and none of
      the frozen identifiers changed.

## Risks / potential issues

- **Risk:** starting this ticket before the naming decision is made, guessing at an
  answer. — **Mitigation:** the Non-goals section explicitly blocks opening a PR
  until the Open Question is answered; this is the ticket's primary discipline, not
  an afterthought.
- **Risk:** scope creep into a full UI-copy rebrand. — **Mitigation:** Non-goals
  explicitly excludes UI copy unless the decision says otherwise.

## Subtasks

1. [ ] Wait for and record the owner's naming decision.
2. [ ] Re-verify 0009's cosmetic-safe file list against current `main`.
3. [ ] Apply the rename consistently across that list.
4. [ ] Run verification, including the manual GLB-export check.
