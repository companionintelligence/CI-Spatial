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
this wave enforces retroactively.

## Tickets

| # | Ticket | One-line goal | Status |
|---|--------|---------------|--------|
| 0001 | [reconcile-license-contradiction](0001-reconcile-license-contradiction.md) | README license claim matches LICENSE.md | ✅ merged (#68) |
| 0002 | [fix-allowed-origin-prefix-autodetect](0002-fix-allowed-origin-prefix-autodetect.md) | main.ts auto-detects the Tailscale hostname like vite.config.ts | ✅ merged (#68) |
| 0003 | [rename-jobs-scanmanifest](0003-rename-jobs-scanmanifest.md) | end the `ScanManifest` name collision (jobs.ts side, zero importers) | ⬜ |
| 0004 | [dedupe-ply-parser](0004-dedupe-ply-parser.md) | delete the viewer's verbatim copy of the binary PLY parser | ⬜ |
| 0005 | [shared-manifest-envelope](0005-shared-manifest-envelope.md) | one `PipelineManifestBase`; viewer imports real types instead of 5 redeclarations | ⬜ |
| 0006 | [shared-event-type-constants](0006-shared-event-type-constants.md) | `/events` message types declared once, producers/consumers documented | ⬜ |
| 0007 | [worlddetection-extends-rawdetection](0007-worlddetection-extends-rawdetection.md) | make the thing-shape lineage real in the type system | ⬜ |
| 0008 | [storage-keys-and-palette-sync](0008-storage-keys-and-palette-sync.md) | central storage-key constants + a test that catches cv-palette drift | ⬜ |
| 0009 | [config-docs-and-naming-cleanup](0009-config-docs-and-naming-cleanup.md) | document every env var, fix stale repo names, freeze protected identifiers | ⬜ |
| 0010 | [single-source-vite-port](0010-single-source-vite-port.md) | `VITE_PORT` env var replaces six magic 5173s | ⬜ |

## Execution order & parallelization

Two ordering constraints exist, both from shared files:

- **0003 → 0006** (both edit `jobs.ts`)
- **0006 → 0010** (both edit `main.ts`)

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
The whole wave is ~10 focused PRs; nothing in it blocks feature work happening in
parallel elsewhere, except that in-flight feature branches touching `main.ts` should
land before Batch B starts or rebase after.

## Explicitly deferred (found, not ticketed — needs an owner decision first)

- **Unifying the two job systems** (`jobs.ts` `JobQueue` vs `WorldJob`) — ADR 0001
  deliberately stops at "no third system"; an actual merge is a migration with crash-
  recovery semantics to preserve, not a cleanup.
- **Cosmetic product-name renames** (`companion-scan-web` package name, glTF
  `generator` tag, UA string) — blocked on the "Companion Scan vs CI-Spatial" naming
  decision (open question in 0009).
- **Typed `/events` payloads** (discriminated union per event) — 0006 does constants
  only; payload typing is real signature churn, logged in 0006's Open Q&A.
- **Normalizing lingbot-map's flat `elapsedMs`** to the splat manifests' nested
  `timing.elapsedMs` — requires a data-tolerant reader window; noted in 0005.
