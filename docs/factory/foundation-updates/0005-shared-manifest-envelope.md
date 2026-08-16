> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/shared-manifest-envelope`
> **Commit style:** `refactor(manifests): one PipelineManifest envelope, imported everywhere`
> **Design:** this ticket is the spec
> **Dependencies:** None — but coordinate with 0004 if it moves files into `src/shared/`

## Goal

The pipeline-stage manifest envelope — `schemaVersion, tool, status ('ok'|'skipped'|
'error'), createdAt, params, timing?, skippedReason?, remediation?, error?,
sessionId?, scanId?` — is declared **five separate times** with no shared base:
`splat_train.ts:55` (`SplatTrainManifest`), `splat_detect.ts:69`
(`SplatDetectManifest`), `splat_finish.ts:67` (`SplatFinishManifest`), plus two
hand-written structural subsets on the viewer side (`src/viewer/splat-layer.ts:31,43`
and `src/viewer/splat-detect-layer.ts:26`), with a sixth loose reader for lingbot-map
(`src/viewer/lingbot-map.ts:19`). Extract one shared base interface, extend it
per-tool, and make the viewer import the real types instead of redeclaring subsets.

## Non-goals

- Do not change any serialized manifest JSON — files on disk stay byte-identical.
  This is a type-layer unification only.
- Do not "fix" lingbot-map's flat `elapsedMs` (vs the splat manifests' nested
  `timing.elapsedMs`) by changing the Python writer — the viewer's reader must keep
  tolerating the flat shape. Normalizing the writer is a separate, data-migration-
  aware ticket if ever wanted.
- Do not touch `jobs.ts`'s `OptimizeScanManifest` (see 0003) — it's a different
  manifest family (the GLB optimizer), not a pipeline-stage envelope.

## Pinned conventions

- ADR 0001: extends existing types rather than adding a sixth copy. Searched: the
  five declarations above are the complete set (grep `Manifest` across `*.ts`,
  excluding `ScanManifest`/`LayerManifest`/`OptimizeScanManifest`).
- Location: `src/world/types.ts` is the established home for types shared between the
  Deno server and the browser (`main.ts:56` and all `src/viewer/*` already import
  from it). Put `PipelineManifestBase` there (or a sibling
  `src/world/manifests.ts` re-exported from types.ts if types.ts is getting long —
  implementer's choice, record it in Open Q&A).
- Per-tool extensions keep their current names and their current extra fields
  (`gaussianCount?`, `objectCount?`, `sogPath?`, `sizes?`, etc.) exactly.

## Before implementation

- Read all five declarations and build a field-by-field table: which fields are
  common (the envelope), which are per-tool, and where the viewer subsets are looser
  (e.g. `splat-layer.ts` makes `timing.elapsedMs` optional; `splat-detect-layer.ts`
  makes `schemaVersion`/`tool` optional). The shared type must be the *strictest
  shape the server actually writes*; viewer-side leniency is expressed with
  `Partial<>`/optional wrappers where genuinely needed, not by redeclaring.

## Open questions & answers

- Q: `src/world/types.ts` or a new `src/world/manifests.ts`? — OPEN, implementer's
  call; record here.
- Q: Should `LingBotMapManifest` join the base? — A: Give it the envelope fields it
  actually shares (`status`, `skippedReason?`, `error?`) via the base, but keep its
  flat `elapsedMs?` as its own field with a comment noting the divergence from
  `timing.elapsedMs` (decided by ticket author, 2026-08-15 — reader tolerance per
  Non-goals).

## Files impacted

- Changed: `src/world/types.ts` (or new `src/world/manifests.ts`)
- Changed: `splat_train.ts`, `splat_detect.ts`, `splat_finish.ts` (extend the base)
- Changed: `src/viewer/splat-layer.ts`, `src/viewer/splat-detect-layer.ts`,
  `src/viewer/lingbot-map.ts` (delete local redeclarations, import)

## Schema required

`PipelineManifestBase` (exact): `schemaVersion: number; tool: string;
status: 'ok' | 'skipped' | 'error'; createdAt: string; timing?: { elapsedMs: number };
skippedReason?: string; remediation?: string; error?: string; sessionId?: string;
scanId?: string`. Per-tool interfaces extend it and add their existing fields
unchanged. Extends existing types per ADR 0001; no serialized format change.

## Definition of Done

- [ ] One base interface; three server manifests extend it; zero viewer-side
      redeclarations remain.
- [ ] Serialized manifest output is unchanged (compare a fixture manifest before/after).
- [ ] The viewer still renders splat layers, detect boxes, and lingbot overlays from
      fixture manifests, including 'skipped'/'error' states.

## Tests

- [ ] `deno task check` passes.
- [ ] `deno task test` passes (splat_train/detect/finish tests serialize manifests).
- [ ] `npm run test:mock` passes (viewer specs load fixture manifests via
      `scripts/make-splat-fixture.mjs`, including the error-state fixture).

```
deno task check
deno task test
npm run test:mock
```

## Acceptance Criteria

- [ ] Given the repo, when a new pipeline stage is added later, then it has exactly
      one obvious envelope type to extend — and the viewer imports it rather than
      redeclaring.

## Risks / potential issues

- **Risk:** the viewer subsets were looser than the server types *on purpose*
  (tolerating older on-disk manifests from before some field existed).
  — **Mitigation:** the field-by-field table in "Before implementation" decides
  strictness per field from evidence; when in doubt keep the viewer-facing type
  lenient (`Partial<Pick<...>>`) and note it.
- **Risk:** import cycle if manifests.ts imports from types.ts and vice versa.
  — **Mitigation:** the envelope has no dependencies on other world types; keep it
  dependency-free.

## Subtasks

1. [ ] Build the field-by-field comparison table (paste into Open Q&A).
2. [ ] Add the base type; extend the three server manifests.
3. [ ] Replace the three viewer redeclarations with imports.
4. [ ] Run verification; compare a before/after fixture manifest byte-for-byte.
