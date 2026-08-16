# 0002. Shared types importable by the browser must live in Deno-API-free files

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related issue:** N/A — workspace policy, surfaced while implementing
  `docs/factory/foundation-updates/0005-shared-manifest-envelope.md`.

## Context

Ticket 0005 extracted one shared `PipelineManifestBase` envelope from five
hand-rolled copies scattered across the three Deno-side pipeline drivers
(`splat_train.ts`, `splat_detect.ts`, `splat_finish.ts`, all at the repo root)
and two browser-side viewer files (`src/viewer/splat-layer.ts`,
`src/viewer/splat-detect-layer.ts`). The ticket's own text assumed the
per-tool interfaces (`SplatTrainManifest`, `SplatDetectManifest`,
`SplatFinishManifest`) would stay declared in those three driver files, with
the viewer importing them via `import type`.

That assumption turned out to be wrong, and not in an obvious way.
TypeScript's `import type` is erased for bundling/codegen, but it is **not**
erased for `tsc`'s type-checking pass — resolving `import type { X } from
'./splat_train.ts'` still requires `tsc` to parse and type-check
`splat_train.ts`'s entire body, which pulls in every `Deno.readFile`,
`Deno.Command`, `Deno.env.get`, etc. call the file makes. The frontend's
`tsconfig.json` (`lib: ES2022+DOM`, no `deno.ns`) has no idea what `Deno` is.
The result — confirmed empirically, not theoretically — was 30+ "Cannot find
name 'Deno'" errors surfacing from `splat_train.ts` and
`splat_train_dataset.ts` the moment a viewer file type-imported straight from
`splat_train.ts`, which would have silently broken `npm run build`'s `tsc
--noEmit` step (a step `deno check` never exercises, since Deno's own
type-checker knows about `Deno.*` — this is precisely why the failure mode
didn't show up until a real `npm run build` was run).

This is a general hazard, not a one-off manifest problem: the repo already
has a small set of files known to be safe for the browser to import — even
type-only — because they contain zero `Deno.*` references
(`src/world/types.ts`, and the `src/shared/` modules: `cv-palette.ts`,
`test-homes.ts`, `events.ts`, `storage-keys.ts`). Nothing previously wrote
down *why* those specific files are the safe import surface, or warned that
adding a Deno-flavored import to one of them — or defining a browser-needed
type inside a Deno-only driver file and re-exporting it — would quietly
reintroduce this failure mode for the next contributor, who would not
discover it until a real `npm run build`, not `deno check`.

## Decision

Any TypeScript type that needs to be importable — even type-only — from
browser-side code (`src/viewer/*`, `src/*` generally) must be **declared**
in a file with zero `Deno.*` API references, not merely re-exported from one.
Concretely:

- The established Deno-API-free homes stay: `src/world/types.ts` (plus its
  sibling `src/world/manifests.ts`, added by 0005) for domain/pipeline types,
  and `src/shared/*.ts` for runtime-agnostic values/logic imported by both
  runtimes.
- A Deno-side driver file (`main.ts`, `jobs.ts`, `splat_train.ts`,
  `splat_detect.ts`, `splat_finish.ts`, `lingbot_map*.ts`, etc.) may still
  `import` and `export type { X }` a type declared in one of the homes above,
  for convenience/backward-compat at its own call sites — but the browser
  must import `X` from the Deno-API-free home directly, never from the
  driver file, even via `import type`.
- Before adding a new interface intended for cross-runtime use, check the
  file you're putting it in for any `Deno.*` reference (including indirectly,
  via another same-file export) — if there's one anywhere in the file, that
  file is not a safe browser-import target regardless of whether the type
  itself only touches JSON-serializable data.
- `deno check` passing is **not sufficient** evidence that a cross-runtime
  type-only import is safe — it doesn't exercise the frontend's
  `tsconfig.json` program. `npm run build` (`tsc --noEmit && vite build`)
  is the actual gate; run it after any change that adds a new
  browser-importable type or moves one.

## Consequences

- **Easier:** the "is this file safe for the browser to type-import from?"
  question now has a mechanical answer (grep the file for `Deno.`) instead of
  needing a real `npm run build` failure to discover the hard way.
- **Harder:** a type that's conceptually "owned" by a Deno-side driver file
  (e.g. `SplatTrainManifest` living next to the code that actually produces
  it) must instead be declared in a shared home and merely re-exported from
  the driver — a one-level indirection that can feel like it's fighting
  colocation, but is the point.
- **Follow-up:** none of the existing Deno-API-free homes need to change; this
  ADR only writes down why they're safe and what breaks the guarantee. If a
  future contributor adds a `Deno.*` call to `src/world/types.ts`,
  `src/world/manifests.ts`, or any `src/shared/*.ts` file, that's the signal
  to split the file rather than accept the regression.
- **Revisit this ADR** if the frontend build ever gains its own `deno.ns`-style
  ambient declaration that makes `Deno.*` references type-check harmlessly in
  the browser program (unlikely, and probably undesirable even if possible —
  it would hide real runtime-availability bugs, not just type-check noise).
