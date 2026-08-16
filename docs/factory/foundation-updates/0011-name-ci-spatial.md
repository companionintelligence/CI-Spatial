> **Type:** Refactor / Docs
> **Wave:** foundation-updates
> **Branch:** `refactor/name-ci-spatial`
> **Commit style:** `refactor(naming): rename cosmetic Companion-Scan identifiers to CI-Spatial`
> **Design:** this ticket is the spec
> **Dependencies:** 0009 (hard — 0009 logs the naming decision as an open question;
> this ticket implements whichever answer that question gets, and must not start
> until it's actually answered by an owner)
> **Status:** ⬜ Still blocked, 2026-08-16 — 0009's Open Question is still unanswered.
> Files impacted re-verified against current `main` ahead of the decision landing
> (two file-list corrections and a line-number fix — see Goal/Non-goals/Files
> impacted); no code changed, since the Non-goals section still forbids opening a
> PR before the decision is recorded.

## Goal

0009 found a real naming split and correctly refused to resolve it: the repo is
`CI-Spatial` on GitHub, but the running product still calls itself "Companion Scan"
internally — `package.json`'s name (`companion-scan-web`), the glTF `generator` tag
(`src/export/gltf.ts:110`, `'ci-xr-scan'`), the geo-tracker's User-Agent string
(`src/geo/geo-tracker.ts:197` — shifted from `:196` since 0008 added an import above
it; re-grep, `'ci-xr-scan/1.0'`), plus prose across `TEST_INFRA.md` and
`video/storyboard.json` (see the corrected file list below — the original audit's
`scripts/generate-test-homes.mjs` and `history/ORIGINAL_REQUEST.md` hits do not
actually hold up on re-verification, 2026-08-16). **This ticket does not decide the
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
- Do not touch `history/ORIGINAL_REQUEST.md` — removed from Files impacted,
  2026-08-16. It doesn't contain a "Companion Scan" hit at all (only an unrelated
  literal working-directory path, `/Users/liam/devel/3d/CI-Web-XR-Scan`, from the
  original request record), and 0009's implementation already established the
  precedent that this file is an immutable historical record, not live docs — editing
  it would be revisionist regardless of what naming decision this ticket implements.
- Do not touch `video/storyboard.json`'s `_focusNote` prose fields — they describe,
  in pixel-level detail, where the words "Companion" and "Scan" actually land in an
  **already-rendered** video frame (used to compute crop/zoom windows for a video
  editing pipeline). Renaming the product doesn't re-render that video; touching this
  prose would desync the metadata from the real asset it describes without fixing
  anything. Scope this file to its `"name"`/`"title"` fields only (see Files impacted).
- Do not touch `video/package.json`'s `@companionintelligence/video-kit` dependency
  — that's the GitHub org/npm-scope name (`companionintelligence`, matching the repo
  path used everywhere, including 0009's own fixes), not the product display name.
  Renaming it would break the actual package resolution.
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

Re-verified against `main` at 2026-08-16 (corrected from the original audit — see
Non-goals for what changed and why):

- `package.json` (`"name": "companion-scan-web"`), `package-lock.json` (regenerate
  after the `package.json` name change — `npm install`, don't hand-edit).
- `src/export/gltf.ts:110` (`generator: 'ci-xr-scan'`).
- `src/geo/geo-tracker.ts:197` (UA string `'ci-xr-scan/1.0'`).
- `deploy/systemd/cscan-web.service` (comments only — "Companion Scan" at lines 1
  and 6; not in the original audit's file list, found during this re-verification).
- `TEST_INFRA.md` — two independent things, don't conflate them: line 1's title
  ("Companion Scan") is the naming-decision-dependent rename this ticket handles;
  line 3's `**CI-Web-XR-Scan**` is the *separate*, already-known-stale repo-name
  issue 0009 explicitly declined to fix here (out of its scope, not this ticket's
  either, strictly — but trivial to fix in the same pass if touching the file
  anyway; use judgment). Ignore line 57's "companion JSON metadata" — generic
  English, not a brand reference.
- `video/storyboard.json` — narrowly, its `"name": "Companion Scan"` (line 5) and
  `"title": "Companion Scan"` (line 103) fields only. Its `"repo":
  "companionintelligence/CI-Web-XR-Scan"` field (line 6) is the same separate
  stale-repo-name category as `TEST_INFRA.md` above, not this ticket's core scope.
  Do NOT touch the `_focusNote` prose (see Non-goals) or the
  `companion-scan-living-room-server-acme.ci.computer` placeholder hostname
  strings (used repeatedly as example video-staging data, not a real identifier —
  confirm before touching, don't assume).
- Any remaining prose hits in `docs/*.md` (re-grep; don't trust this list blindly —
  it has already been wrong once, see above).

~~`scripts/generate-test-homes.mjs`~~ — dropped. Its only match on re-verification
is the phrase "companion metadata" in a comment, meaning "an accompanying file,"
not the product name — a false positive in the original audit.

~~`history/ORIGINAL_REQUEST.md`~~ — dropped; see Non-goals.

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
