# Wave: foundation-updates

Unify and harden the repo without changing what it does. The system is a working MVP
that builds a map of **places** and an index of **things** from various input types
(live AR scan, video, photos); this wave removes the internal duplication that makes
it fragile to extend, and freezes the identifiers that must never drift. Every ticket
preserves current behavior — wire formats, on-disk formats, storage keys, and defaults
are all byte-identical after this wave.

Grounding: the Companion Scan Atlas review (full feature/schema/connection map) plus
two line-level audits (2026-08-15) verifying each duplication before it became a
ticket. ADR 0001 (`docs/adr/0001-reuse-existing-domain-model.md`) is the standing rule
this wave enforces retroactively. ADR 0002
(`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`)
was added mid-wave, during 0005 — see "Batch B — landed" below.

## Tickets

| # | Ticket | One-line goal | Status |
|---|--------|---------------|--------|
| 0001 | [reconcile-license-contradiction](0001-reconcile-license-contradiction.md) | README license claim matches LICENSE.md | ✅ merged (#68) |
| 0002 | [fix-allowed-origin-prefix-autodetect](0002-fix-allowed-origin-prefix-autodetect.md) | main.ts auto-detects the Tailscale hostname like vite.config.ts | ✅ merged (#68) |
| 0003 | [rename-jobs-scanmanifest](0003-rename-jobs-scanmanifest.md) | end the `ScanManifest` name collision (jobs.ts side, zero importers) | ✅ merged (#71) |
| 0004 | [dedupe-ply-parser](0004-dedupe-ply-parser.md) | delete the viewer's verbatim copy of the binary PLY parser | ✅ merged (#71) |
| 0005 | [shared-manifest-envelope](0005-shared-manifest-envelope.md) | one `PipelineManifestBase`; viewer imports real types instead of 5 redeclarations | ✅ merged (#73) |
| 0006 | [shared-event-type-constants](0006-shared-event-type-constants.md) | `/events` message types declared once, producers/consumers documented | ✅ merged (#73) |
| 0007 | [worlddetection-extends-rawdetection](0007-worlddetection-extends-rawdetection.md) | make the thing-shape lineage real in the type system | ✅ merged (#71) |
| 0008 | [storage-keys-and-palette-sync](0008-storage-keys-and-palette-sync.md) | central storage-key constants + a test that catches cv-palette drift | ✅ merged (#73) |
| 0009 | [config-docs-and-naming-cleanup](0009-config-docs-and-naming-cleanup.md) | document every env var, fix stale repo names, freeze protected identifiers | ✅ merged (#71) |
| 0010 | [single-source-vite-port](0010-single-source-vite-port.md) | `VITE_PORT` env var replaces six magic 5173s | ✅ merged (#76) |
| 0011 | [name-ci-spatial](0011-name-ci-spatial.md) | cosmetic Companion-Scan→CI-Spatial rename, once an owner picks the name | ✅ merged (#76) |

## Execution order & parallelization

Three ordering constraints exist:

- **0003 → 0006** (both edit `jobs.ts`)
- **0006 → 0010** (both edit `main.ts`)
- **0009 → 0011** (0011 implements whichever naming decision 0009 surfaces as an open
  question — it cannot start until an owner actually answers it, independent of any
  other batch's timing)

Everything else is disjoint. Safe schedule:

```
Batch A (fully parallel):   0003   0004   0007   0009
Batch B (after 0003):       0006   0005   0008
Batch C (after 0006):       0010
```

- **Batch A** — four independent worktrees/agents can run simultaneously; no file
  overlaps. 0003 and 0009 are the smallest; 0004 carries the one open build question
  (Vite bundling a root-level import).
- **Batch B** — 0005 and 0008 are mutually parallel and parallel with 0006 (0005
  touches `splat_*.ts` + viewer layer files; 0006 touches `main.ts`/`jobs.ts`/
  `viewer.ts`; 0008 touches `src/shared/` + scattered small files — the only common
  file is `src/main.ts`, where 0008 changes one constant line; trivial rebase if they
  collide).
- **Batch C** — 0010 alone (needs 0006's `main.ts` changes landed). Its `.env.example`
  overlap with 0009 is append-only from both sides.

Each ticket is one PR to `main` (no stacking — verify landings in git, not by badge).
The whole wave is ~11 focused PRs; nothing in it blocks feature work happening in
parallel elsewhere, except that in-flight feature branches touching `main.ts` should
land before Batch B starts or rebase after. 0011 sits outside the batch schedule
entirely — it starts whenever the naming decision lands, whether that's before Batch A
or after Batch C.

## Now separate waves (found here, scoped elsewhere)

- **Unifying the two job systems** (`jobs.ts` `JobQueue` vs `WorldJob`) — ADR 0001
  deliberately stopped at "no third system" here; the actual merge is
  [`docs/factory/01-merge-jobs/`](../01-merge-jobs/README.md), a migration with
  crash-recovery semantics to preserve, not a cleanup.
- **Typed `/events` payloads** (discriminated union per event) — 0006 does constants
  only; full payload typing is
  [`docs/factory/02-typed-event-payloads/`](../02-typed-event-payloads/README.md),
  sequenced after `01-merge-jobs` so it types the merged job-event shapes once, not
  the two independently-drifting ones.

## Batch A — landed 2026-08-16

0003, 0004, 0007, and 0009 shipped together as one PR: [#71](https://github.com/companionintelligence/CI-Spatial/pull/71)
(four isolated worktrees, merged and verified together, one Copilot review comment
addressed post-merge). No new ADR was created — all four tickets implemented ADR 0001
directly rather than establishing a new standing rule, so the only ADR in the repo
remains [0001](../../adr/0001-reuse-existing-domain-model.md) (already linked above).

**What this means for Batch B / Batch C:**

- **0006 is now unblocked.** Its `Dependencies: 0003` is satisfied — `jobs.ts` now
  declares `OptimizeScanManifest`, not `ScanManifest`. Batch B can start.
- **0005 needs no rework.** It already wrote its Non-goals and grep-exclusion list
  against the post-0003 name (`OptimizeScanManifest`), and its Files-impacted list for
  `src/viewer/lingbot-map.ts` already anticipated 0004's shared-parser import existing
  there. One line-number drift to be aware of: `LingBotMapManifest`'s declaration
  in that file moved from line 19 to line 20 (0004 added one import line above it) —
  re-grep before trusting the cited line, per this wave's own "grep ground truth
  yourself" convention.
- **0008 can cite 0009's registry directly.** 0008's Non-goals references "0009's
  do-not-rename list" abstractly; that list is now live at `CLAUDE.md`'s "Do not
  rename" section and can be linked directly.
- **0009's naming Open Question is still unresolved** — "Companion Scan" vs
  "CI-Spatial" — and blocks 0011 (ticketed since; see the table above), which starts
  the moment an owner answers it.
- **Unplanned files touched:** a post-merge PR review caught a JSDoc comment 0007
  dropped in the `WorldDetection extends RawDetection` refactor. The fix landed on
  `src/inference/prompt.ts` and root `prompt.ts` (not originally in 0007's Files
  impacted) — worth knowing if a later ticket also touches those files.

## Batch B — landed 2026-08-16

0005, 0006, and 0008 shipped together as one PR: [#73](https://github.com/companionintelligence/CI-Spatial/pull/73)
(three isolated worktrees off latest `main`, merged and verified together, one
Copilot review comment addressed post-merge). The three had zero real file overlaps
with each other — 0006 touches root `main.ts` (the Deno server), 0008 touches the
separate `src/main.ts` (the browser entry point); despite the similar names these are
different files, so the "only common file" caution in "Execution order &
parallelization" above turned out not to matter in practice.

**A new ADR landed this batch:** [0002](../../adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md)
— "shared types importable by the browser must live in Deno-API-free files."
0005 discovered that a browser file `import type`-ing straight from a Deno driver
file (`splat_train.ts` etc.) still drags that file's `Deno.*` calls into `tsc`'s
type-check graph and breaks `npm run build`, even though `deno check` stays clean.
Read it before adding any new type meant to be shared between server and browser
code.

**What this means for Batch C and the two new waves planned the same day ([#72](https://github.com/companionintelligence/CI-Spatial/pull/72)):**

- **0010 is now unblocked.** Its `Dependencies: 0006` is satisfied.
- **Re-grep `main.ts` line numbers before trusting 0010's citations.** 0006 added an
  `EVENT` import near the top of `main.ts`, shifting everything below it.
  `viteBaseUrlFromEnv` (0010's primary concern) is now at `main.ts:1455`, not the
  `1457` the ticket cites; the `:5173` fallback is now around line 1458.
- **`npm run build` is now part of this wave's real verification surface**, not just
  `deno task check` — ADR 0002 is the reason why. If 0010 (or any later ticket) adds
  or moves a type touched by both runtimes, run the real build, not just `deno check`.
- **Relevant precedent for `docs/factory/01-merge-jobs/` and
  `docs/factory/02-typed-event-payloads/`** (planned the same day, in parallel with
  this batch's implementation): `src/shared/events.ts` now exists with both
  `EVENT.JOB_UPDATE` and `EVENT.WORLD_JOB_UPDATE` centralized side by side, each with
  producer/consumer doc comments — `02-typed-event-payloads` can build its
  discriminated union on top of this file rather than re-deriving the event list.
  Likewise, `01-merge-jobs` retiring `jobs.ts`'s `JobQueue` will need to decide what
  happens to `jobs.ts`'s `OptimizeScanManifest` (renamed by 0003) and whether it
  should extend `PipelineManifestBase`/live in `src/world/manifests.ts` (added by
  0005) once optimize-scan moves onto `WorldJob` — neither of those two waves'
  existing tickets mention this yet since they were drafted before 0005 landed.
- One environmental lesson from this batch, not code-related: running `npm run
  test:mock` against a dev server with many accumulated scans from repeated local
  test runs can produce false-looking failures (timeouts waiting for scan status)
  that look like regressions but are just UI-rendering load — clear `scans/` and
  restart the server before trusting a surprising `test:mock` result.

## Batch C — landed 2026-08-16 — wave complete

0010 and 0011 shipped together as one PR: [#76](https://github.com/companionintelligence/CI-Spatial/pull/76)
(two isolated worktrees off latest `main`, merged and verified together). This is
the last batch — **all 11 tickets in `foundation-updates` are now merged.** No new
ADR was created this batch; both tickets extended existing patterns (0010 followed
0002's Deno/Node-parallel-env-var precedent exactly; 0011 was a mechanical rename
once the naming decision landed) rather than surfacing a new standing rule, so ADR
0001 and 0002 (linked above) remain the complete set.

**0011's naming decision, made during this batch:** the repo owner picked
**CI-Spatial** over "Companion Scan" for every cosmetic-safe identifier 0009
catalogued. Frozen identifiers (IndexedDB name, storage keys, GHCR image, OIDC
client id, memory-push `sourceSystem`) are unaffected either way — see 0009's and
0011's Non-goals for the list.

**0010 found a real gap the original design missed:** `scripts/test-box.mjs` (the
two-instance isolated-test-run tool) never passed its own `VITE_PORT` value to its
isolated Deno child, so the ticket's own Acceptance Criteria couldn't have held true
without adding that file to scope — a good example of why this wave's tickets ask
implementers to re-verify against current code rather than trust the original audit.

**Two things worth knowing for whoever picks up `01-merge-jobs` or
`02-typed-event-payloads` next:**

- `package.json`'s name is now `ci-spatial-web` (was `companion-scan-web`) and the
  glTF `generator`/UA-string identifiers are now `ci-spatial`/`ci-spatial/1.0` (were
  `ci-xr-scan`/`ci-xr-scan/1.0`) — if either of those two waves' tickets cite the old
  values anywhere, they're stale now.
- `main.ts` gained a `VITE_PORT` read and `scripts/test-box.mjs` gained a new env
  key passed to its Deno child — neither should conflict with either wave's scope,
  but re-grep rather than assume if either wave also touches those files.

## Explicitly deferred (found, not ticketed — needs an owner decision first)

- **Normalizing lingbot-map's flat `elapsedMs`** to the splat manifests' nested
  `timing.elapsedMs` — requires a data-tolerant reader window; noted in 0005.
