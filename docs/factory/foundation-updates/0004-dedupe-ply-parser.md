> **Type:** Refactor
> **Wave:** foundation-updates
> **Branch:** `refactor/dedupe-ply-parser`
> **Commit style:** `refactor(viewer): import the shared PLY parser instead of a copied one`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

`src/viewer/lingbot-map.ts:58` (`parseBinaryPLY()` + `_findHeaderEnd():106`) is a
verbatim copy of `lingbot_map_ply.ts:22` (`parseLingBotMapPLY()` +
`findHeaderEnd():72`) — identical header scan, identical regexes, identical stride
logic, identical error strings; only a local variable name differs. The shared file's
own header comment (`lingbot_map_ply.ts:12`) says it is runtime-agnostic "so both the
Deno server's GLB builder and the browser viewer can import it" — but the viewer never
did. Make the viewer import it and delete the copy.

## Non-goals

- Do not touch `splat_train.ts:297`'s `countPlyVertices()` — it is a deliberately
  weaker header-only scan (first 4096 bytes) used by `splat_train.ts` and
  `splat_finish.ts` for a gaussian count, not a full parse. Leave it.
- Do not touch the PLY *writers* (`scripts/lingbot_map_worker.py:163-174`,
  `scripts/make-lingbot-fixture.mjs:95-102`, `scripts/make-splat-fixture.mjs:74-76`) —
  generators, not parsers; different languages; out of scope.
- Do not change the parsed output shape (`{xyz, rgb, count}`) or add support for new
  PLY layouts.

## Pinned conventions

- ADR 0001: this reuses the existing parser rather than keeping a duplicate.
  Searched: all PLY-parsing sites are `lingbot_map_ply.ts` (full parser),
  `src/viewer/lingbot-map.ts` (the copy being deleted), and `splat_train.ts:297`
  (header-count only, intentionally left).
- Import pattern: `src/viewer/lingbot-map.ts` already imports from outside `src/`
  indirectly via types; Vite resolves relative imports to root-level `.ts` files fine
  (`lingbot_map_glb.ts` imports `lingbot_map_ply.ts` the same way on the Deno side).
  Use a relative import: `import { parseLingBotMapPLY } from '../../lingbot_map_ply.ts'`.

## Before implementation

- Read both parser implementations side by side and diff them to confirm behavioral
  identity (the audit found only variable-name/wrapping differences — verify).
- Read `lingbot_map_ply.ts`'s `ParsedPLY` interface vs what
  `src/viewer/lingbot-map.ts`'s callers destructure — confirm field-name compatibility.

## Open questions & answers

- Q: Does Vite bundle a root-level `.ts` import into the browser build without config
  changes? — A: verify by building; `vite.config.ts` has no `src/`-only restriction,
  and TS type-only imports from `src/world/types.ts` already cross that boundary. If
  the *value* import fails at build time, move `lingbot_map_ply.ts` to
  `src/shared/ply.ts` and update the two Deno-side importers instead — both outcomes
  are acceptable; record which happened here. — OPEN until build verified.

## Files impacted

- Changed: `src/viewer/lingbot-map.ts` (delete `parseBinaryPLY`/`_findHeaderEnd`,
  import the shared parser)
- Possibly moved: `lingbot_map_ply.ts` → `src/shared/ply.ts` (only if the Open
  question resolves that way; then also update `lingbot_map_glb.ts`'s import)

## Schema required

None.

## Definition of Done

- [ ] Exactly one binary-PLY full parser exists in the repo.
- [ ] The viewer's LingBot-Map overlay still renders a reconstructed point cloud
      (same `{xyz, rgb, count}` consumption).
- [ ] The Open question above is resolved and recorded.

## Tests

- [ ] `deno task check` passes.
- [ ] `npm run build` succeeds (proves Vite can bundle the import).
- [ ] `deno task test` passes (`lingbot_map.test.ts`, `lingbot_map_glb.test.ts` cover
      the server-side consumer).

```
deno task check
npm run build
deno task test
```

## Acceptance Criteria

- [ ] Given a session with `lingbot-map.point-cloud.ply` present, when the viewer
      loads its LingBot-Map overlay, then the point cloud renders exactly as before.

## Risks / potential issues

- **Risk:** Vite may not tree-shake or resolve a root-level Deno-flavored `.ts` import
  cleanly. — **Mitigation:** the fallback (move to `src/shared/ply.ts`) is pre-approved
  in the Open question; either way one parser remains.
- **Risk:** subtle divergence between the two copies that the audit missed.
  — **Mitigation:** diff before deleting; the Playwright viewer specs
  (`npm run test:mock`) exercise the overlay rendering path with fixture data.

## Subtasks

1. [ ] Diff the two implementations; record any difference found in Open Q&A.
2. [ ] Replace the viewer's copy with the shared import (or move the module to
       `src/shared/ply.ts` per the Open question).
3. [ ] Run verification commands; exercise the viewer overlay against
       `scripts/make-lingbot-fixture.mjs` output.
