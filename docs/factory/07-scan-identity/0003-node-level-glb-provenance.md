# 0003. Node-level provenance in the exported GLB

> **Type:** Frontend
> **Wave:** 07-scan-identity
> **Branch:** `feat/node-glb-provenance`
> **Commit style:** `feat(export): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (unique `scanId`) and 0002 (one session identity). Provenance must
> stamp the *corrected* ids, not today's colliding ones — see "Why 0001 and 0002 come first".

## Goal

Stamp every provenance-bearing node in an exported scan GLB with the identity of the scan
that produced it (`sessionId`, `scanId`, `capturedAt`, plus `captureIndex` on detection
nodes), so that a node still knows where it came from once it is no longer the only thing
in the file. Fix the two defects found while establishing what provenance already exists.

This is one half of the pair that makes a future consolidated per-place GLB possible. This
ticket puts provenance *on* nodes; ticket 0004 proves it survives the optimize pipeline.

## The gap, precisely

Verified against `src/export/gltf.ts` at the branch point.

Provenance today is written **once, at scene level**. `scene.userData` (`src/export/gltf.ts:130-155`)
carries `generator`, `version`, `capturedAt`, `sessionId`, `scanName`, `floorName`, `roomName`,
`projectId`, `autoSaved`, the counts, the quality summary and the geo block. `GLTFExporter`
writes that to the glTF scene's `extras`.

Per **node**, the only provenance that exists anywhere in the file is on detection meshes:
`sourceScanIds: [store.sessionId]` at `src/export/gltf.ts:286`, inside the `userData` block
at `:270-290`.

Every other node the exporter writes carries no session identity at all:

| Node | Written at | Its `userData` today |
| --- | --- | --- |
| `Floor_*` group | `gltf.ts:158-160` | `{ type, floorName }` |
| `Room_*` group | `gltf.ts:162-164` | `{ type, roomName, floorName, scanName }` |
| `point-cloud` | `gltf.ts:188-190` | `{ type, count, roomName, floorName }` |
| `camera-path` | `gltf.ts:206-208` | `{ type, poseCount, roomName, floorName }` |
| `floor-plane` | `gltf.ts:223-235` | `{ objectType, tag, roomName, floorName, y, widthM, depthM }` |
| `detections` group | `gltf.ts:241-243` | `{ type, roomName, floorName }` |
| `<label>_NNN` detection | `gltf.ts:260-290` | the block above, incl. `sourceScanIds` |

`roomName`/`floorName` are *place* labels, not identity — two sessions of the same room both
write `Room_Unknown` (`gltf.ts:127`). Nothing on a point-cloud, camera-path or floor-plane
node distinguishes one walkthrough from another. Merge two of those files and the geometry
is anonymous.

### Bug A — `captureIndex` never reaches the GLB

`captureIndex` exists on `WorldDetection` (`src/spatial/resolver.ts:22-28`, declared
`captureIndex?: number` at `:27`), is assigned after resolution (`src/main.ts:365`,
`for (const wd of worldDets) wd.captureIndex = currentCaptureIdx`), is persisted to IndexedDB
through `DetectionStore.upsert()`, and is rendered as the "Scan #" column of the markdown
summary (`src/export/summary.ts:141`). The GLB `userData` block at `gltf.ts:270-290` simply
omits it. Detection → capture-event attribution is present everywhere except the artifact
that outlives the session.

### Bug B — the exporter and the inspector disagree on a key name

`src/export/gltf.ts:286` **writes** `sourceScanIds` (plural, array).
`src/viewer/editor.ts:267` **reads** `ud['sourceScan']` (singular, string).

Nothing in the repo writes `sourceScan`; a repo-wide grep for the identifier returns exactly
four hits — the doc comment at `gltf.ts:15`, the write at `gltf.ts:286`, the field declaration
`sourceScan?: string` at `editor.ts:82`, and the read at `editor.ts:267`. So
`InspectorData.sourceScan` is unconditionally `undefined`.

It is worse than a mismatch: **no consumer renders it either.** `showInspector()`
(`src/viewer/viewer.ts:1646-1670`) builds its rows from `data.tag`, `data.aiLabel`,
`data.confidence`, `data.dimensions`, `data.roomName`, `data.floorName`, `data.description`
and `data.notes`. Its one "Scan" row (`viewer.ts:1660`) reads `scan.manifest.name`, resolved
by `scanForObject()` (`viewer.ts:2337-2345`) from the viewer's own loaded-scan registry — not
from node provenance. `InspectorData.sourceScan` is a field computed from a key nobody writes
and displayed by nobody. Fixing the name alone would still render nothing, so this ticket
fixes both ends.

### Dead code found in the same file

`SceneEditor.exportTagMap()` (`src/viewer/editor.ts:292-295`) has **zero callers repo-wide**
(grep for `exportTagMap` returns only its own declaration). It is the only caller of
`flushTags()` outside `flushTags()`'s own public contract. Remove it — see Subtasks. If a
reviewer would rather keep it, it must gain a caller or an explicit "kept for X" comment;
silently dead code next to a provenance bug is how the provenance bug survived.

## The decision that matters: who stamps `scanId`

**`scanId` is not knowable client-side.** The client does not choose the stored filename, and
the id is derived on the server after upload by `scanIdFor(filename, meta)`
(`main.ts:1359-1363`):

```ts
function scanIdFor(filename: string, meta: Record<string, unknown>): string {
  const sessionId = asString(meta['sessionId'])
  if (sessionId) return `scan-${safeSlug(sessionId)}`
  return `scan-${safeSlug(filename.replace(/\.glb$/, ''))}`
}
```

**Pinned: the client stamps `sessionId` + `capturedAt` (+ `captureIndex` on detection nodes);
the server stamps `scanId` during the optimize pass.** No client-side correlation id is
introduced. Reasoning, in order of weight:

1. **No new identity is needed.** The client already sends `sessionId` in the upload metadata
   (`gltf.ts:352`), and `scanIdFor` derives `scanId` from exactly that field. `sessionId`
   *is* the correlation key. Minting an `exportId` would be a fourth identifier doing a job
   three already do — precisely what ADR 0001 forbids.
2. **Precedent exists for the server stamping GLB provenance.** `main.ts:2100` already hands
   `glbExtras: { sessionId, scanId: scan.scanId }` to `runLingBotMapReconstruction()`, which
   writes it into a GLB the server authors (`lingbot_map_glb.ts:80`).
3. **Mirroring `safeSlug()` client-side would be a second parallel implementation of an id
   algorithm** — the same hazard CLAUDE.md flags for `resolveHostname()` in
   `vite.config.ts`/`main.ts`. One of the pair would drift, and the symptom would be silently
   mismatched provenance, not an error.
4. Ticket 0001 is about to break the 1:1 `sessionId → scanId` mapping (a session that
   autosaves several times — `src/main.ts:529-532` — uploads several files that all derive
   the same `scanId` today). Once it does, the client *cannot* compute `scanId` even in
   principle. Server-side stamping is the only option that survives 0001.

**Consequence, stated plainly:** the raw uploaded `.glb` carries `sessionId` and `capturedAt`
but not `scanId`; only `.opt.glb` and the LODs carry all three. That is acceptable because
(a) the viewer prefers the optimized file, (b) `assignStableObjectIds()`
(`src/viewer/viewer.ts:864-875`) already stamps `data['scanId'] = data['scanId'] ?? scanId` on
every node at load time — a baked-in value wins, an absent one is filled from the manifest —
and (c) the future merge job consumes optimized files server-side, where the manifest is at
hand anyway.

**The server-side stamp itself is implemented in ticket 0004**, which is the ticket that owns
`pipeline.ts` and `_runOptimizeScanJob` (`main.ts:2477-2496`). This ticket pins the contract
and ships the client half.

## Why 0001 and 0002 come first

Stamping today's ids would bake in the collision. `scanIdFor` maps one `sessionId` to one
`scanId`, but `exportToGLB` runs on both the manual export path (`src/main.ts:468-471`) and
the autosave path (`src/main.ts:529-532`) with the same `store.sessionId` — so one
walkthrough uploads several distinct files that all claim the same `scanId`. Node-level
provenance is only worth writing once 0001 makes `scanId` actually unique per uploaded GLB
and 0002 settles what "one session" means.

## Non-goals

- **Do not** implement the server-side `scanId` stamp, and do not touch `pipeline.ts` or
  `_runOptimizeScanJob`. That is ticket 0004's diff. This ticket must not make the pipeline
  provenance-aware; keep the two diffs separable so a pipeline regression is attributable.
- **Do not** build a merged per-place GLB, and do not revive the `export-world` placeholder
  `WorldJobType`. Phase 1 keeps the multi-root virtual composite in the viewer (owner
  decision, logged below). This ticket only makes the future merge possible.
- **Do not** add a new `WorldJobType`, job queue, route or manifest type. Nothing here is a
  background job.
- **Do not** change `scene.userData` (`gltf.ts:130-155`) beyond hoisting its `capturedAt`
  timestamp into a shared const. The scene-level block is a working contract with
  `scanManifestFromStored()` (`main.ts:1369-1403`) and the World Editor.
- **Do not** rename `sessionId`, `scanId` or `capturedAt`. They are the field names on
  `ScanManifest` (`src/world/types.ts:146-163`) and must stay identical across the wire.
- **Do not** change `scanIdFor()` (`main.ts:1359`) — that is ticket 0001's territory.
- **Do not** add a schema-validation library. This repo uses hand-written interfaces.
- **Do not** stamp provenance onto the wireframe child mesh (`gltf.ts:267-268`). One
  provenance record per logical object; the child is a rendering artifact, and duplicating
  provenance onto it would double-count in any traversal that does not already guard the way
  `hasLabelledAncestor()` (`src/viewer/detections.ts:72-78`) does.

## Pinned conventions

**ADR 0001 (`docs/adr/0001-reuse-existing-domain-model.md`)** — this touches schema and a
client↔server connection, so it states what it reuses. Nothing is replaced; every field name
below already exists somewhere in the domain model and is being *projected onto nodes*:

| Existing | Where it is declared | How this ticket uses it |
| --- | --- | --- |
| `ScanManifest.sessionId` | `src/world/types.ts:148` (`string \| null`) | same name, same value, now also per node |
| `ScanManifest.scanId` | `src/world/types.ts:147` | same name; stamped server-side by 0004 |
| `ScanManifest.capturedAt` | `src/world/types.ts:156` | same name; ISO-8601 string |
| `WorldDetection.captureIndex` | `src/spatial/resolver.ts:27` (`captureIndex?: number`) | carried through to the GLB — Bug A |
| `scene.userData.sessionId` / `.capturedAt` | `src/export/gltf.ts:133-134` | node values are the *same* two values, hoisted to one const |
| `sourceScanIds` | `src/export/gltf.ts:286` | **kept, plural** — see the naming decision below |
| node `userData` / glTF `extras` | throughout `gltf.ts` | extended in place; no new carrier mechanism |
| `userData['scanId']` on nodes | `src/viewer/viewer.ts:867` (`?? scanId`) | already the viewer's node-level key — this makes the GLB fill it |
| `src/shared/*.ts` cross-runtime home | `src/shared/events.ts` precedent | new `src/shared/provenance.ts` follows it exactly |

**No new type in the domain sense.** `ScanProvenance` is a per-node projection of fields that
already exist on `ScanManifest` and `WorldDetection`; it introduces no new identifier, no new
env var, no new route.

**ADR 0002 (`docs/adr/0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md`)**
— `ScanProvenance` and the key-name constants must be **declared** in a Deno-API-free file,
because they are imported by browser code (`src/export/gltf.ts`, `src/viewer/editor.ts`) *and*
by `pipeline.ts` in ticket 0004. Home: **`src/shared/provenance.ts`**, following the
`src/shared/events.ts` precedent — that file is imported by `main.ts:63` (Deno, with the `.ts`
extension) and by `src/viewer/viewer.ts:36` (Vite, extensionless). Keep it dependency-free: no
`three`, no `Deno.*`, no DOM.

**Import-extension convention, which differs by runtime and is load-bearing:**
- from `src/` (Vite/tsc): `import { ... } from '../shared/provenance'` — no extension, matching
  `gltf.ts:24`'s `from '../shared/offline-queue'`.
- from repo-root files (`main.ts`, `pipeline.ts`, `*.test.ts` under `node --experimental-strip-types`):
  `from './src/shared/provenance.ts'` — **with** the extension, matching `main.ts:63`.

**`npm run build` (`tsc --noEmit && vite build`) is the real gate for the ADR 0002 hazard.**
`deno check` does not exercise the frontend's `tsconfig.json` program and will not catch
cross-runtime breakage. `npm run verify` runs `tsc --noEmit` but **not** `vite build`, so run
both.

**Naming decision — plural, `sourceScanIds: string[]`.** Pinned. A node in a future merged
document may legitimately have several sources (the same physical chair seen in two
walkthroughs, corresponded as one Thing per the owner's identity model). A singular string
would have to be widened later, and widening a persisted key is a migration. The exporter
already writes the plural form; the inspector is the side that changes.

**Timestamps:** ISO-8601 via `new Date().toISOString()`, one value per export. `gltf.ts`
currently calls `new Date()` four separate times (`:133` scene `capturedAt`, `:316` the
filename stamp, `:350` `exportedAt`, `:351` metadata `capturedAt`), so the scene extras and
the upload metadata can disagree by milliseconds. Hoist **one** `capturedAt` const and use it
for `:133`, `:351` and every node stamp. Leave `:316` and `:350` alone.

**Branch/commit:** branch `feat/node-glb-provenance`; commits `feat(export): …`,
`fix(viewer): …` for the Bug B half.

## Before implementation

- `src/export/gltf.ts:113-296` — the whole scene-building body; every node this ticket stamps
  is written here. Note the `userData` shape of each node listed in the table above.
- `src/export/gltf.ts:339-397` — `uploadToServer()`; the metadata JSON that carries `sessionId`
  to the server, which is what makes the server-side `scanId` derivation possible.
- `src/spatial/resolver.ts:22-28` — `WorldDetection`, where `captureIndex` is declared.
- `src/main.ts:363-365` — where `captureIndex` is assigned; `:468-471` and `:529-532` — the two
  `exportToGLB` call sites (manual export and autosave, same `sessionId`).
- `src/export/summary.ts:130-148` — the one place `captureIndex` is currently surfaced.
- `src/viewer/editor.ts:73-87` (`InspectorData`), `:249-273` (`getInspectorData`), `:292-295`
  (`exportTagMap`, the dead method).
- `src/viewer/viewer.ts:1646-1670` (`showInspector`, where a row must be added),
  `:2337-2345` (`scanForObject`, the existing "Scan" row's real source),
  `:864-875` (`assignStableObjectIds`, whose `??` makes a baked-in `scanId` win).
- `main.ts:1359-1403` — `scanIdFor` and `scanManifestFromStored`; why `scanId` is server-side.
- `main.ts:2100` and `lingbot_map_glb.ts:44-90` — the existing precedent for the server
  stamping provenance extras into a GLB.
- `src/shared/events.ts:1-20` — the header that documents the `src/shared/` cross-runtime
  contract the new file must follow.
- `editor_pick.test.ts:1-30` — the precedent for a Node `--experimental-strip-types` test that
  imports browser source directly.
- `docs/adr/0001-…`, `docs/adr/0002-…` — both cited above.

## Open questions & answers

- Q: Who stamps `scanId`, given the client cannot know it? — A: **The server, during the
  optimize pass (implemented in 0004).** The client stamps `sessionId` + `capturedAt` +
  `captureIndex`. No client-side correlation id. Full reasoning in "The decision that matters"
  above: `sessionId` already *is* the correlation key that `scanIdFor` (`main.ts:1359`) uses,
  a new id would violate ADR 0001, mirroring `safeSlug()` client-side would create a second
  parallel id implementation, and ticket 0001 will make client-side derivation impossible in
  principle. (Decided by owner, 2026-08-19.)
- Q: Singular `sourceScan` or plural `sourceScanIds`? — A: **Plural, `sourceScanIds: string[]`.**
  A merged node may have several sources; widening a persisted key later is a migration. The
  exporter already writes plural, so the inspector changes. (Decided by owner, 2026-08-19.)
- Q: Where does `ScanProvenance` live? — A: **`src/shared/provenance.ts`.** ADR 0002 permits
  `src/world/types.ts`, `src/world/manifests.ts` or `src/shared/*.ts`; `src/shared/` wins
  because ticket 0004 needs the key names as **runtime values** (a constant array) inside
  `pipeline.ts`, not just as types, and `src/shared/` is documented as the home for
  "runtime-agnostic values/logic imported by both runtimes". (Decided 2026-08-19.)
- Q: Is a merged per-place GLB in scope? — A: **No.** Phase 1 keeps the multi-root virtual
  composite in the viewer. A real consolidated GLB is deferred to a future wave that revives
  the existing `export-world` placeholder `WorldJob` (`src/world/types.ts:28`, `main.ts:2765`,
  `main.ts:2850-2856`). These two tickets exist to make that possible. (Decided by owner,
  2026-08-19.)
- Q: What is the identity model these fields encode? — A: Three levels — **Project** (a place)
  → **Session** (a walkthrough) → **Scan** (one uploaded GLB) — plus a **Thing** corresponded
  across sessions. `projectId` already exists at scene level (`gltf.ts:138`); this ticket adds
  the Session and Scan levels per node; the Thing level is `sourceScanIds` growing to more
  than one entry after a future merge. (Decided by owner, 2026-08-19.)
- Q: Remove `exportTagMap()`, or keep it? — A: **Remove.** Zero callers repo-wide. If review
  disagrees it must gain a caller or an explicit justification comment. (Decided 2026-08-19.)
- Q: Can the provenance assertions run as a Node test, given `exportToGLB` is browser code?
  — A: **Yes.** `three`'s `GLTFExporter` touches the DOM in exactly one place — `getCanvas()`
  at `node_modules/three/examples/jsm/exporters/GLTFExporter.js:535-541` — which is reached
  only for texture processing, and scan GLBs carry no textures (`pipeline.ts:14-16` states
  this). `DetectionStore`'s constructor (`src/scene/store.ts:41-44`) does not open IndexedDB.
  `exportToGLB` reads only `store.sessionId` and `store.detections`, so the test passes a
  structural stub cast to `DetectionStore` and calls with `{ download: false, upload: false }`,
  which skips `triggerDownload()` and `fetch`. If this proves wrong on the day, fall back to a
  Playwright spec alongside `tests/mock-export-outcome.spec.ts` and say so in the ticket.
  (Verified 2026-08-19.)
- Q: Do 0001 and 0002 exist on disk yet? — A: **Not at the time of writing** —
  `docs/factory/07-scan-identity/` contained only this pair. Re-check the exact field names
  and the `scanId` uniqueness rule against 0001/0002 before coding; if they diverge from the
  table in Pinned conventions, they win and this ticket is amended. (Noted 2026-08-19.)

## Files impacted

New:
- `src/shared/provenance.ts` — `ScanProvenance`, `DetectionProvenance`, `NODE_PROVENANCE_KEYS`.
- `glb_provenance.test.ts` (repo root) — the Node round-trip test.

Changed:
- `src/export/gltf.ts` — hoist one `capturedAt`; build a `nodeProvenance` object; spread it
  into the seven `userData` blocks; add `captureIndex` to the detection block; update the
  file-header diagram comment (`:4-18`) which currently shows provenance only on detections.
- `src/viewer/editor.ts` — `InspectorData.sourceScan?: string` → `sourceScanIds?: string[]`
  (`:82`); read `ud['sourceScanIds']` (`:267`); also surface `sessionId`, `scanId` and
  `captureIndex`; delete `exportTagMap()` (`:292-295`).
- `src/viewer/viewer.ts` — render a "Source" row in `showInspector()` (`:1656-1667`).
- `package.json` — add `test:provenance` to `scripts` and to the `verify` chain.
- `docs/factory/atlas.html:392` — the "GLB scan export" fcard, which describes what the
  exporter packs and does not mention provenance.

Not changed (deliberately): `pipeline.ts`, `main.ts`, `src/spatial/resolver.ts`,
`src/export/summary.ts`.

## Schema required

**Extends existing shapes. No new domain type, no new identifier, no new env var, no new route.**

New file `src/shared/provenance.ts` — hand-written interfaces, no schema library:

```ts
/** Per-node provenance. Every field name is already a field of ScanManifest
 *  (src/world/types.ts:146-163) — this is that identity projected onto a node. */
export interface ScanProvenance {
  /** DetectionStore.sessionId — the walkthrough. Written client-side. */
  sessionId: string
  /** ScanManifest.scanId — one uploaded GLB. Stamped SERVER-side (ticket 0004);
   *  absent in the raw upload, present in .opt.glb and the LODs. */
  scanId?: string
  /** ISO-8601. One value per export, shared with scene.userData.capturedAt. */
  capturedAt: string
}

/** Detection nodes carry the scan provenance plus their capture event. */
export interface DetectionProvenance extends ScanProvenance {
  /** WorldDetection.captureIndex (src/spatial/resolver.ts:27), 1-based. */
  captureIndex?: number
  /** Scans this node's geometry came from. Plural: a merged node may have several. */
  sourceScanIds: string[]
}

/** The extras keys ticket 0004's pipeline guard must preserve. Runtime value,
 *  not just a type — that is why this lives in src/shared/ and not src/world/. */
export const NODE_PROVENANCE_KEYS = [
  'sessionId', 'scanId', 'capturedAt', 'captureIndex', 'sourceScanIds',
] as const
```

Nodes that gain a `ScanProvenance` spread in `src/export/gltf.ts`: `Floor_*` (`:160`),
`Room_*` (`:164`), `point-cloud` (`:190`), `camera-path` (`:208`), `floor-plane` (`:231-235`),
`detections` group (`:243`). The detection node (`:270-290`) gains a `DetectionProvenance`
spread — `captureIndex` (new, Bug A) and the already-present `sourceScanIds`.

All fields are additive. No existing key changes name, type or value, with one exception:
`InspectorData.sourceScan?: string` becomes `sourceScanIds?: string[]` — a viewer-local
in-memory type with no persisted representation, so no migration.

## Definition of Done

- [ ] `src/shared/provenance.ts` exists, contains zero `Deno.*` references, imports nothing
      (no `three`, no DOM), and declares `ScanProvenance`, `DetectionProvenance` and
      `NODE_PROVENANCE_KEYS`
- [ ] `exportToGLB` computes `capturedAt` once and uses it for `scene.userData` (`:133`), the
      upload metadata (`:351`) and every node stamp
- [ ] All seven node kinds listed in "The gap, precisely" carry `sessionId` and `capturedAt`
      in their `userData`
- [ ] Detection nodes additionally carry `captureIndex` (Bug A) and keep `sourceScanIds`
- [ ] No node carries a client-written `scanId` — that key is left for the server (0004)
- [ ] The wireframe child (`gltf.ts:267-268`) carries **no** provenance
- [ ] `InspectorData.sourceScanIds?: string[]` replaces `sourceScan?: string`, and
      `getInspectorData` reads `ud['sourceScanIds']` (Bug B, exporter side unchanged)
- [ ] `showInspector()` renders a "Source" row when `sourceScanIds` is non-empty, distinct
      from the existing "Scan" row that comes from `scanForObject()`
- [ ] `SceneEditor.exportTagMap()` is deleted
- [ ] The `gltf.ts` file-header diagram (`:4-18`) describes provenance on every node kind,
      not only detections
- [ ] `docs/factory/atlas.html:392` says the export carries per-node provenance
- [ ] `npm run build` passes (the ADR 0002 gate — `tsc --noEmit` **and** `vite build`)
- [ ] `npm run verify` passes

## Tests

New Node test `glb_provenance.test.ts`, run by `npm run test:provenance`
(`node --experimental-strip-types --no-warnings --test glb_provenance.test.ts`), following
`editor_pick.test.ts`. It builds a scan with a `PointCloud`, a pose history of ≥2 poses, and
two detections carrying different `captureIndex` values; calls `exportToGLB(..., { download:
false, upload: false })`; then reads the returned GLB's JSON chunk the way
`pipeline_detection_graph.test.ts:82-87` does (`glbJson`) and asserts against `extras`.

- [ ] Every node kind (`Floor_*`, `Room_*`, `point-cloud`, `camera-path`, `floor-plane`,
      `detections`, each `<label>_NNN`) has `extras.sessionId === store.sessionId`
- [ ] Every one of those nodes has an `extras.capturedAt` that parses as a date, and all of
      them are byte-identical to `scene.extras.capturedAt`
- [ ] `captureIndex` round-trips: a detection resolved at capture #2 has `extras.captureIndex === 2`
      (Bug A — this assertion fails on `main`)
- [ ] A detection with no `captureIndex` set omits the key rather than writing `null`
- [ ] `extras.sourceScanIds` is an array containing the session id
- [ ] No node carries `extras.scanId` (the client must not guess it)
- [ ] The wireframe child node carries no provenance keys
- [ ] `getInspectorData()` on a node whose `userData` has `sourceScanIds: ['session-x']`
      returns `sourceScanIds: ['session-x']` (Bug B — fails on `main`, where the read is
      `ud['sourceScan']`); extend `editor_pick.test.ts` or add the case to the new file
- [ ] `showInspector()` renders the source row — add a case to
      `tests/e2e-suite.spec.ts` near the existing `getInspectorData` cases (`:485-500`,
      `:835-850`), asserting the row is present for a node with `sourceScanIds` and absent for
      one without. **Assert against a GLB loaded from bytes, not a hand-built runtime graph**:
      `assignStableObjectIds()` (`viewer.ts:867`) stamps `scanId` onto every node at load time,
      so a runtime-graph assertion would pass even with the file-level fix reverted
- [ ] `npm run build` and `npm run verify` pass

```
npm run test:provenance
npm run build
npm run verify
```

## Acceptance Criteria

- [ ] Given a session that exports a scan, When the GLB's JSON chunk is inspected, Then every
      node the exporter writes carries `extras.sessionId` and `extras.capturedAt`
- [ ] Given two GLBs exported from two different sessions of the same room, When their node
      extras are compared, Then `sessionId` differs on every node — even though `roomName` and
      `floorName` are identical (`Room_Unknown`/`Floor_Ground`) on both
- [ ] Given a detection resolved during capture #3, When the scan is exported, Then that
      detection's node has `extras.captureIndex === 3`, matching the "Scan #" column
      `src/export/summary.ts:141` writes for the same detection
- [ ] Given a node whose extras carry `sourceScanIds`, When it is selected in the World
      Editor, Then the inspector shows a source row naming the scan(s) — a row that renders on
      no scan today
- [ ] Given `grep -rn "sourceScan\b" src/`, When run after the change, Then there are no hits
      for the singular form
- [ ] Given `grep -rn "exportTagMap" .` excluding `node_modules`, When run after the change,
      Then there are no hits
- [ ] Given `grep -n "Deno\." src/shared/provenance.ts`, When run, Then there are no hits
      (ADR 0002's mechanical check)
- [ ] Given the raw uploaded `.glb`, When inspected, Then no node carries `scanId` — the
      server adds it in 0004, and this ticket must not fake it

## Risks / potential issues

- **Risk:** GLB size growth from per-node extras. — **Mitigation:** Bounded and small. The
  added keys are roughly `sessionId` (~21 chars, `session-<epoch-ms>`) + `capturedAt` (24) +
  key names (~45) ≈ **130 bytes of JSON per node**, and the count of nodes does not scale with
  point count — the whole point cloud is one node. A real capture with 8 detections has on the
  order of 20 nodes → **~2.6 KB**, against a GLB measured in hundreds of KB to MB. For scale:
  each detection's extras already carry `thumbnailDataUrl` (`gltf.ts:280`), a base64 data URL
  that dominates the JSON chunk by orders of magnitude. Record the before/after
  `buffer.byteLength` from the `[export]` log line (`gltf.ts:319-322`) in the PR anyway.
- **Risk:** `scanId` is not knowable client-side, so provenance is incomplete until the
  optimize pass runs. — **Mitigation:** This is the pinned design, not an accident. Mitigated
  by `assignStableObjectIds()`'s `??` (`viewer.ts:867`) filling it from the manifest at load
  time, and by 0004 stamping it into `.opt.glb`. The gap is real only for a raw `.glb` opened
  outside this app; note it in the `provenance.ts` header so the next reader is not surprised.
- **Risk:** These extras must survive optimization, and today they demonstrably might not —
  `prune()` runs with `keepExtras: false` and `quantize()` reshapes detection nodes.
  — **Mitigation:** **That is ticket 0004's job, explicitly.** This ticket is not complete as
  a user-visible feature until 0004 lands; the viewer prefers the optimized file, so
  provenance written here and dropped there would be invisible in exactly the scans users see
  — the same shape of failure `src/viewer/detections.ts:10-26` documents for detection meshes.
  Land them in the same PR train and say so in the commit message.
- **Risk:** Renaming `InspectorData.sourceScan` breaks a caller. — **Mitigation:** Grepped:
  the only reads are `editor.ts:82` and `:267`. `tests/e2e-suite.spec.ts:493` and `:842` use
  `getInspectorData` but read `tag`/`notes`/`name`/`confidence` only. `tsc --noEmit` catches
  anything missed.
- **Risk:** Landing this before 0001 bakes in the `scanId` collision (one `scanId` per
  `sessionId`, several uploads per session). — **Mitigation:** Hard dependency, stated at the
  top. Do not merge this ahead of 0001/0002.
- **Risk:** `GLTFExporter` serializes `userData` as JSON and silently drops values it cannot
  handle. — **Mitigation:** Every provenance value is a string, a number or an array of
  strings. The test asserts presence in the written bytes, not in the in-memory scene, so a
  silent drop fails the test.
- **Risk:** `src/shared/provenance.ts` later acquires a `Deno.*` reference or a `three` import
  and quietly breaks `npm run build` for every browser importer. — **Mitigation:** ADR 0002's
  mechanical check is an acceptance criterion above; repeat the warning in the file header the
  way `src/shared/events.ts:12-14` does.

## Subtasks

1. [ ] Read the files in "Before implementation"; confirm the line references still hold
2. [ ] Confirm 0001 and 0002 have landed and re-check their field names against Pinned conventions
3. [ ] Create `src/shared/provenance.ts` with the three exports from "Schema required" and a
       header explaining the ADR 0002 constraint and the client/server split of `scanId`
4. [ ] In `gltf.ts`, hoist a single `capturedAt` const and use it at `:133` and `:351`
5. [ ] In `gltf.ts`, build one `nodeProvenance: ScanProvenance` and spread it into the six
       non-detection `userData` blocks (`:160`, `:164`, `:190`, `:208`, `:231`, `:243`)
6. [ ] In `gltf.ts:270-290`, add `captureIndex: det.captureIndex` (Bug A) and spread the
       provenance; leave `sourceScanIds` as-is; leave the wireframe child bare
7. [ ] Update the `gltf.ts` header diagram (`:4-18`) to show provenance on every node kind
8. [ ] In `editor.ts`, change `InspectorData.sourceScan` to `sourceScanIds?: string[]`, read
       `ud['sourceScanIds']`, and surface `sessionId`/`scanId`/`captureIndex`
9. [ ] Delete `SceneEditor.exportTagMap()` (`editor.ts:292-295`)
10. [ ] Add the "Source" row to `showInspector()` (`viewer.ts:1656-1667`)
11. [ ] Write `glb_provenance.test.ts`; add `test:provenance` to `package.json` scripts and to
        the `verify` chain
12. [ ] Add the inspector case to `tests/e2e-suite.spec.ts`, loading from GLB bytes
13. [ ] Run `npm run test:provenance`, `npm run build`, `npm run verify`
14. [ ] Update `docs/factory/atlas.html:392`
15. [ ] Record the before/after GLB byte size from the `[export]` log line in the PR
