# 0004. Optimize pipeline must preserve provenance extras

> **Type:** Backend
> **Wave:** 07-scan-identity
> **Branch:** `fix/pipeline-preserve-provenance`
> **Commit style:** `fix(pipeline): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003 (node-level provenance in the exported GLB). There is nothing to
> preserve until 0003 writes it.

## Goal

Guarantee that the per-node provenance ticket 0003 writes survives `dedup()`, `prune()`,
`quantize()` and `draco()`, with regression tests that fail loudly if it stops surviving — and
stamp the server-side `scanId` that 0003 deliberately left blank.

The viewer prefers the optimized file. Provenance written by 0003 and dropped here would be
invisible in exactly the scans users see, with no error — the same failure shape this repo
has already been bitten by once.

## The hazard, in the repo's own words

This is not a hypothetical. `src/viewer/detections.ts:10-26` documents the last time a
pipeline transform quietly reshaped a detection node and every downstream feature went dark:

> Usually the labelled node *is* the mesh: `exportToGLB` writes the detection extras onto the
> node holding the box mesh. The two come apart after optimization. `exportToGLB` gives every
> detection a wireframe child, and glTF-Transform's `quantize()` cannot put a dequantization
> transform on a node that has both a mesh and children — so it hoists the mesh into a new
> unnamed sibling, leaving the labelled node holding only children. Measured on a real
> capture: 8 of 8 detection nodes carry a mesh in the source GLB, 0 of 8 in the `.opt.glb`.
> Since the viewer *prefers* the optimized file, gating on `instanceof Mesh` matched nothing
> in exactly the scans users see, and every detection feature went dark with no error.

**One mechanical correction to that comment, verified for this ticket, and it changes the
recommended fix.** The hoisted node is created as a **child** of the labelled node, not a
sibling. `transformMeshParents()` in
`node_modules/@gltf-transform/functions/dist/index.js:3958-3984` does:

```js
const isParentNode = parent.listChildren().length > 0;
...
if (isParentNode || isAnimated) {
  targetNode = document.createNode("").setMesh(mesh);
  parent.addChild(targetNode).setMesh(null);
}
```

That is why `resolveDetectionMesh()` (`src/viewer/detections.ts:27-44`) searches
`node.children` and finds it. The consequence for provenance is good news and must be stated
so the fix is not over-built: **the labelled node keeps its own extras and remains the
ancestor of the hoisted mesh.** Provenance on the labelled node is not moved, not copied, and
not deleted by `quantize()`.

## Three concrete threats

### 1. `quantize()` reparents the mesh away from the labelled node

`pipeline.ts:121` (LOD path: `quantize({ quantizePosition: 14, quantizeColor: 8 })`) and
`pipeline.ts:138` (full document, additionally `quantizeNormal: 8`).

The new node is created with an empty name and **no extras** — hence
`src/viewer/detections.ts:50`'s "after optimization the hoisted mesh is unnamed and carries no
extras, so reading either from the wrong one silently loses the detection's identity."

**Severity: low, but it defines the invariant.** Because the hoisted node is a descendant, any
consumer that walks *up* from geometry to find provenance still succeeds — which is exactly
what `scanForObject()` (`src/viewer/viewer.ts:2337-2345`) already does. The threat is to
consumers that key on the mesh-bearing node itself. The invariant to write down and test:
**provenance lives on the labelled node, and a consumer must resolve it by ancestor walk, never
by assuming the mesh-bearing node carries it.**

### 2. `dedup()` collapses meshes across sessions

`pipeline.ts:109` (`doc.transform(dedup(), prune())`), called with no options.

Verified defaults in `node_modules/@gltf-transform/functions/dist/index.js:1690-1698`:

```js
const DEDUP_DEFAULTS = {
  keepUniqueNames: false,
  propertyTypes: [ ACCESSOR, MESH, TEXTURE, MATERIAL, SKIN ]
};
```

`NODE` is **not** in that list, so nodes are never merged and node-level extras are safe.
`MESH` **is**, and `keepUniqueNames: false` means differing mesh names do not prevent a merge.
Two sessions of the same place plausibly contain byte-identical geometry — the exporter builds
every detection box from `new THREE.BoxGeometry(bw, bh, bd)` (`src/export/gltf.ts:253`) with
dimensions derived from the same bbox maths, and the floor plane from
`new THREE.PlaneGeometry(roomW, roomD)` (`:216`) — so **anything hung off a `Mesh` or a
`Primitive` would be merged across sessions**, silently attributing one session's geometry to
the other.

This is the single strongest argument for keeping provenance on **nodes only**. It is
currently true by luck (0003 writes `userData`, and `GLTFExporter` puts `userData` on nodes);
this ticket makes it a stated, tested invariant. Today's pipeline runs `dedup()` on a
single-session document, so the cross-session case has never been exercised at all — the test
below is the first time.

### 3. `prune()` removes a provenance-only node

`pipeline.ts:109` and `pipeline.ts:121`, both called with no options.

Verified at `node_modules/@gltf-transform/functions/dist/index.js:2593-2612` and `:2743-2753`:

```js
const PRUNE_DEFAULTS = { propertyTypes: [ NODE, ... ], keepLeaves: false, ..., keepExtras: false };

function nodeTreeShake(graph, prop, keepExtras) {
  ...
  const isEmpty = graph.listChildren(prop).length === 0;
  const needsExtras = keepExtras && !isEmptyObject(prop.getExtras());
  if (isEmpty && !isUsed && !needsExtras) prop.dispose();
}
```

With the default `keepExtras: false`, `needsExtras` is always `false`, so **a node carrying
provenance extras but no mesh and no children is disposed.** The library ships the exact
opt-out for this: `prune({ keepExtras: true })`.

Which exporter nodes are at risk today: `Room_*` and `Floor_*` (`src/export/gltf.ts:158-166`)
are empty when a scan has no point cloud, no poses, no floor bounding box and no detections —
which is precisely the shape autosave uploads early in a session (`src/main.ts:529-532`, guarded
only against the all-three-empty case at `:525`). Ordering note: `prune()` runs *before*
`quantize()` on both paths (`:109` unconditionally, and `:121` as `transform(prune(), quantize(…))`),
and nothing prunes after a hoist — so threat 3 applies to nodes as the exporter wrote them, not
to quantize's output.

## The existing coverage gap

`pipeline_detection_graph.test.ts` is the only test that reads a pipeline-produced GLB. Its
strongest extras assertion is `:116`:

```ts
assert.equal(labelled.length, 3, 'optimization must not drop the label extras')
```

keyed on `node['extras']['label']` via `labelledNodes()` (`:98-103`). It proves the `label`
key survives on nodes that have a mesh and a child. There is **no** test asserting that a
`sessionId`/`scanId`/`capturedAt` extra survives, none covering an extras-bearing node with no
geometry, and none covering two sessions' worth of identical geometry through `dedup()`. That
is the gap this ticket closes.

## The fix

`pipeline.ts` never calls `getExtras()`/`setExtras()` today — grep the file, there are zero
hits. It relies entirely on glTF-Transform's default passthrough, which is correct for two of
the three threats and wrong for the third.

**Pinned: option (c) — a documented invariant plus tests that fail loudly — with the one
concrete code change threat 3 actually requires.** Specifically:

1. `prune({ keepExtras: true })` at `pipeline.ts:109` and `pipeline.ts:121`. This is the whole
   of the code fix for threat 3: a one-option change to a library call, using the option the
   library provides for exactly this purpose.
2. A `provenance` invariant documented in `pipeline.ts`'s header (`:1-20`) and in
   `src/shared/provenance.ts`: provenance is carried on **nodes only**, never on a `Mesh`,
   `Primitive`, `Accessor` or `Material`, because those five property types are dedup targets.
3. Regression tests (below) covering all four transforms and the cross-session dedup case.

**Option (a) — a post-pass re-attaching provenance to hoisted nodes — is rejected**, and the
reasoning is the mechanical correction above: the hoisted node is a **descendant** of the
labelled node, so provenance is already reachable by ancestor walk. Copying it down would put
two provenance records on one logical object, which is precisely the duplication
`collectDetections()` already has to defend against with `hasLabelledAncestor()`
(`src/viewer/detections.ts:72-78`), and it would make a future merge job count one object
twice. Option (b) — keeping provenance only on nodes quantize will not touch — is rejected
because it makes the exporter's node layout load-bearing for a glTF-Transform implementation
detail that has already changed once.

4. **Stamp `scanId` server-side.** Ticket 0003 pinned that the client writes `sessionId` +
   `capturedAt` and the server writes `scanId`, because `scanIdFor(filename, meta)`
   (`main.ts:1359-1363`) only runs after upload. This ticket owns both files that change:
   extend `PipelineOptions` (`pipeline.ts:61-66`) with an optional
   `provenance?: { scanId: string }`, apply it to every node's extras inside `optimizeScan`
   before the transforms run, and pass it from `_runOptimizeScanJob` (`main.ts:2477-2496`,
   the `optimizeScan(glb)` call at `:2492`). Precedent for the server stamping GLB provenance:
   `main.ts:2100` already hands `glbExtras: { sessionId, scanId: scan.scanId }` to the
   LingBot-Map runner, which writes it via `doc.getRoot().setExtras()`
   (`lingbot_map_glb.ts:80`). Scope call logged in Open questions.

## Non-goals

- **Do not** build the merged per-place GLB here. It is a later wave, and the pieces are worth
  naming so nobody re-invents them: `@gltf-transform/functions@4.4.0` (verified installed,
  `node_modules/@gltf-transform/functions/package.json`) already exports `mergeDocuments`,
  `copyToDocument` and `joinPrimitives`, and a repo-wide grep finds **zero** imports of any of
  the three; the Deno server can already author a GLB from scratch — `lingbot_map_glb.ts:44-90`
  builds a `new Document()` from a PLY, creating accessors, a primitive, a mesh, a node and a
  scene, then quantizing and writing binary; and `export-world` is an existing placeholder
  `WorldJobType` (`src/world/types.ts:28`, dispatched at `main.ts:2765` and `:2850-2856`) whose
  stated purpose is already "World export manifest is ready for a combined GLB and semantic
  JSON worker." This ticket is what makes that job viable. Building it here would fuse two
  unrelated diffs and make a merge bug unattributable.
- **Do not** add a new `WorldJobType`, job queue or route. ADR 0001 and ADR 0003: `WorldJob` is
  the one job system, and `optimize-scan` is already a member of it.
- **Do not** break `pipeline.ts`'s runtime-agnostic contract. Its header (`:18-19`) states "no
  Deno/Node globals, so the same code runs in the Deno server and under Node for tests" — that
  is what lets `pipeline_detection_graph.test.ts` import it under
  `node --experimental-strip-types`. Any new import must be dependency-free and extension-qualified.
- **Do not** change the quantization bit depths (`quantizePosition: 14`, `quantizeColor: 8`,
  `quantizeNormal: 8`), the LOD voxel sizes (`DEFAULT_LOD_VOXELS_M`, `pipeline.ts:68`), or the
  `lodMinPoints` threshold. Retuning compression while changing extras handling would make a
  size regression unattributable.
- **Do not** disable or reorder any transform. `prune()` gains an option; it does not move.
- **Do not** change how the viewer resolves detections (`src/viewer/detections.ts`). The
  ancestor-walk rule it already implements is the one this ticket writes down.
- **Do not** re-stamp `sessionId` server-side. The client owns that field (0003); the server
  adds `scanId` and nothing else.

## Pinned conventions

**ADR 0001 (`docs/adr/0001-reuse-existing-domain-model.md`)** — this touches schema (glTF
extras) and the optimize path. What is reused rather than created:

| Existing | Where | How used |
| --- | --- | --- |
| `ScanProvenance` / `NODE_PROVENANCE_KEYS` | `src/shared/provenance.ts` (added by 0003) | imported, not redefined; the pipeline guard keys on the shared constant |
| `ScanManifest.scanId` | `src/world/types.ts:147` | the value stamped; `scan.scanId` from the WorldJob's scan |
| `scanIdFor(filename, meta)` | `main.ts:1359-1363` | unchanged; already the sole derivation |
| `PipelineOptions` | `pipeline.ts:61-66` | **extended** with one optional field, not replaced |
| `optimize-scan` `WorldJob` | `src/world/types.ts:28`, `main.ts:2477` | unchanged dispatch; only the `optimizeScan()` call gains an argument |
| `glbExtras` server-stamp pattern | `main.ts:2100`, `lingbot_map_glb.ts:80` | the precedent this follows |
| `prune()` / `dedup()` / `quantize()` / `draco()` | `pipeline.ts:109/121/138/150` | same calls, one option added to `prune()` |
| `pipeline_detection_graph.test.ts` harness | `glbJson()` `:82-87`, `labelledNodes()` `:98-103`, `buildExporterShapedScan()` `:46-80` | **extended**, not duplicated into a new harness |

**ADR 0002** — `src/shared/provenance.ts` must stay Deno-API-free and dependency-free, because
`pipeline.ts` (Deno + Node), `main.ts` (Deno) and `src/export/gltf.ts` (browser) all import it.
Import it from `pipeline.ts` and `main.ts` as `'./src/shared/provenance.ts'` (extension
required under `node --experimental-strip-types` and Deno), and from `src/` as
`'../shared/provenance'` (extensionless, Vite). `npm run build` (`tsc --noEmit && vite build`)
is the real gate — `deno check` does not exercise the frontend program.

**Extras are carried on nodes only.** Never `Mesh`, `Primitive`, `Accessor`, `Material` or
`Texture` — all five are in `DEDUP_DEFAULTS.propertyTypes`
(`node_modules/@gltf-transform/functions/dist/index.js:1690-1698`). Write this in
`pipeline.ts`'s header so the next contributor does not "helpfully" move a key onto a mesh.

**No schema library.** Hand-written interfaces.

**Branch/commit:** branch `fix/pipeline-preserve-provenance`; commits `fix(pipeline): …` and
`test(pipeline): …`.

## Before implementation

- `pipeline.ts:1-20` — the runtime-agnostic header contract that must be preserved and extended.
- `pipeline.ts:95-181` — `optimizeScan()`: the `dedup+prune` stage (`:108-110`), the LOD loop
  (`:114-134`, `prune`+`quantize` at `:121`), the full-document `quantize` (`:136-139`), the
  Draco stage (`:143-163`), and the dropped-extension reporter (`:165-173`).
- `pipeline.ts:61-66` — `PipelineOptions`, the interface being extended.
- `pipeline_detection_graph.test.ts:1-30` (why it exists), `:46-80` (`buildExporterShapedScan`,
  the fixture to extend), `:82-103` (`glbJson`, `resolvesToGeometry`, `labelledNodes`),
  `:105-139` (the two pipeline tests).
- `src/viewer/detections.ts:10-26` and `:46-52` — the quoted comment and the "metadata from the
  node, geometry from the mesh" rule this ticket generalises to provenance.
- `main.ts:2477-2530` — `_runOptimizeScanJob`; the `optimizeScan(glb)` call at `:2492`.
- `main.ts:2088-2101` — `_runLingBotMapJob` and the `glbExtras` precedent.
- `lingbot_map_glb.ts:44-90` — the Deno server authoring a GLB from scratch (context for the
  deferred merge job; do not build it).
- `src/shared/provenance.ts` — added by 0003; the key names this guard preserves.
- `node_modules/@gltf-transform/functions/dist/index.js:1690-1698` (`DEDUP_DEFAULTS`),
  `:2593-2612` (`PRUNE_DEFAULTS`), `:2743-2753` (`nodeTreeShake`), `:3958-3984`
  (`transformMeshParents`). Re-verify these before relying on them — they are library
  internals at `4.4.0` and a minor bump can move them.

## Open questions & answers

- Q: Guard style — (a) a post-pass re-attaching provenance to hoisted nodes, (b) keep
  provenance only on nodes quantize will not touch, or (c) a documented invariant plus a test
  that fails loudly? — A: **(c), plus `prune({ keepExtras: true })`, which is the only code
  change any of the three threats actually requires.** (a) is rejected because the hoisted node
  is a *descendant* (`index.js:3978`, `parent.addChild(targetNode)`), so provenance is already
  reachable by ancestor walk; copying it down would duplicate one object's identity, the exact
  hazard `hasLabelledAncestor()` (`src/viewer/detections.ts:72-78`) exists to prevent. (b) is
  rejected because it makes the exporter's node layout hostage to a glTF-Transform
  implementation detail that has already changed once. (Decided 2026-08-19.)
- Q: Does `prune()` really drop an extras-only node, or is that theoretical? — A: **Really.**
  `PRUNE_DEFAULTS.keepExtras` is `false` (`index.js:2611`) and `nodeTreeShake` disposes when
  `isEmpty && !isUsed && !needsExtras` (`:2752`). `keepExtras: true` is the library's own
  opt-out. (Verified by reading the installed 4.4.0 source, 2026-08-19.)
- Q: Does `dedup()` merge nodes? — A: **No** — `DEDUP_DEFAULTS.propertyTypes` is
  `[ACCESSOR, MESH, TEXTURE, MATERIAL, SKIN]` (`index.js:1690-1698`). Nodes are safe; meshes are
  not, and `keepUniqueNames: false` means names do not protect them. Hence "extras on nodes
  only" as a pinned invariant. (Verified 2026-08-19.)
- Q: Should the server-side `scanId` stamp live here or in its own ticket? — A: **Here.** This
  is the only ticket in the wave that touches `pipeline.ts` and `_runOptimizeScanJob`, it is
  about five lines (one optional option field, one extras loop, one call-site argument), and
  splitting it would leave 0003's pinned contract with no owner. Flagged as a deliberate scope
  call so review can push back. (Decided 2026-08-19.)
- Q: Stamp `scanId` before or after the transforms? — A: **Before**, immediately after
  `io.readBinary(glb)` (`pipeline.ts:104`), so the stamp is subject to the same preservation
  guarantees everything else is — and so the tests exercise the real path rather than a
  post-write patch. (Decided 2026-08-19.)
- Q: Does the raw uploaded `.glb` get a `scanId` too? — A: **No.** Only `.opt.glb` and the LODs,
  because only they pass through `optimizeScan`. Rewriting the uploaded original would destroy
  the byte-fidelity of what the device sent. 0003's Risks section records this gap and why it
  is acceptable. (Decided 2026-08-19.)
- Q: Does `keepExtras: true` have side effects beyond nodes? — A: Yes in principle — it makes
  extras keep *any* property type alive, so an unused mesh or material carrying extras would no
  longer be pruned. In this codebase extras are written only on nodes and on the document root
  (`lingbot_map_glb.ts:80`), so the practical effect is nil today. Listed under Risks; the size
  assertion in Tests is what would catch it if it changed. (Decided 2026-08-19.)
- Q: Does Draco threaten provenance? — A: **No, and it cannot reach point clouds at all.**
  `draco()` (`pipeline.ts:150`) compresses primitive geometry, not node extras, and it runs on
  a `cloneDocument(doc)` (`:149`) that is discarded unless it is smaller (`:152-155`).
  glTF-Transform logs `[KHR_draco_mesh_compression] Skipping Draco compression of N
  non-TRIANGLES primitives.`
  (`node_modules/@gltf-transform/extensions/dist/index.js:3113`) for every point primitive, so
  point-cloud provenance takes a structurally different path from mesh provenance and must be
  asserted separately. (Verified 2026-08-19.)

## Files impacted

Changed:
- `pipeline.ts` — `PipelineOptions` gains `provenance?`; `optimizeScan` applies it after parse;
  `prune()` → `prune({ keepExtras: true })` at `:109` and `:121`; header (`:1-20`) documents the
  extras-on-nodes-only invariant.
- `main.ts` — `_runOptimizeScanJob` passes `{ provenance: { scanId } }` at the `optimizeScan(glb)`
  call (`:2492`).
- `pipeline_detection_graph.test.ts` — extended: provenance assertions, an extras-only-node
  case, and a two-session cross-dedup fixture.
- `src/shared/provenance.ts` — header note that the pipeline relies on nodes-only placement
  (no signature change).
- `docs/factory/atlas.html:357` — the "GLB optimization pipeline" fcard, which lists
  dedup/prune/LOD/quantize/Draco and says nothing about what it must not destroy.

New: none. The tests extend the existing file rather than adding a sibling — same harness, same
`npm run test:pipeline:graph` entry point, per ADR 0001.

## Schema required

**Extends `PipelineOptions` (`pipeline.ts:61-66`). No new domain type.**

```ts
export interface PipelineOptions {
  /** Voxel sizes (metres) for point-cloud LODs, coarsest first. Default [0.30, 0.12]. */
  lodVoxelsM?: number[]
  /** Skip LOD generation when the cloud has fewer points than this. Default 5000. */
  lodMinPoints?: number
  /**
   * Server-side provenance stamped onto every node before the transforms run.
   * `scanId` is not knowable client-side (see ticket 0003 and main.ts:1359) — the
   * client writes sessionId + capturedAt, the server adds this. Omitted for callers
   * that have no scan context (the smoke script, fixtures); nothing is stamped then.
   */
  provenance?: { scanId: string }
}
```

No change to `PipelineResult`, `PipelineArtifact`, `PipelineStats` or `PipelineStageLog`.

The glTF-extras contract, unchanged in shape and now enforced: node `extras` may carry the keys
in `NODE_PROVENANCE_KEYS` (`src/shared/provenance.ts`, from 0003) — `sessionId`, `scanId`,
`capturedAt`, `captureIndex`, `sourceScanIds`. `scanId` is written by the pipeline; the rest by
the exporter. **No provenance key may be written to a `Mesh`, `Primitive`, `Accessor`,
`Material` or `Texture`.**

## Definition of Done

- [ ] `prune()` is called as `prune({ keepExtras: true })` at both `pipeline.ts:109` and `:121`
- [ ] `PipelineOptions.provenance?: { scanId: string }` exists and is applied to every node's
      extras immediately after `io.readBinary(glb)`, before any transform
- [ ] `_runOptimizeScanJob` passes the job's `scan.scanId`; a job with no resolvable scan omits
      `provenance` and the pipeline stamps nothing rather than writing `undefined`
- [ ] `pipeline.ts` still contains no Deno or Node globals — the header contract at `:18-19` holds
- [ ] `pipeline.ts`'s header documents the invariant: provenance on nodes only, never on Mesh /
      Primitive / Accessor / Material / Texture, with the `DEDUP_DEFAULTS` reason
- [ ] `pipeline_detection_graph.test.ts` asserts provenance extras survive dedup + prune +
      quantize + Draco, on both the optimized artifact and every LOD
- [ ] A cross-session `dedup()` test exists and asserts each session's nodes keep their own
      `sessionId` despite byte-identical geometry
- [ ] An extras-only node (no mesh, no children) survives `prune()` — this test fails without
      the `keepExtras` change
- [ ] A point-cloud node's provenance is asserted separately from a mesh node's (Draco skips
      non-TRIANGLES primitives)
- [ ] `docs/factory/atlas.html:357` names provenance preservation as part of the pipeline's contract
- [ ] `npm run test:pipeline:graph`, `deno task test`, `npm run verify` and `npm run build` pass

## Tests

All extend `pipeline_detection_graph.test.ts`, reusing `buildExporterShapedScan()` (`:46-80`),
`glbJson()` (`:82-87`) and `labelledNodes()` (`:98-103`) rather than building a second harness.
`buildExporterShapedScan` gains an optional provenance argument so a fixture can be built for a
named session.

- [ ] **Provenance survives the optimized path.** Every node that carried `extras.sessionId` in
      the source GLB still carries the same value in `result.optimized.bytes`, after
      dedup + prune + quantize (+ Draco when it wins on size).
- [ ] **Provenance survives every LOD.** The same assertion over `result.lods[*].bytes` —
      the LOD path runs its own `prune()` + `quantize()` at `:121`.
- [ ] **`scanId` is stamped.** `optimizeScan(glb, { provenance: { scanId: 'scan-abc' } })`
      produces nodes carrying `extras.scanId === 'scan-abc'`; called without `provenance`, no
      node gains a `scanId` key.
- [ ] **`capturedAt` and `captureIndex` round-trip** through the full pipeline unchanged.
- [ ] **Cross-session dedup.** Build one document containing two sessions' worth of
      **byte-identical** geometry (identical `CUBE_POSITIONS`/`CUBE_INDICES` accessors) whose
      nodes carry `sessionId: 'session-A'` and `sessionId: 'session-B'`. After `optimizeScan`,
      assert: (i) both session ids are still present, one per node; (ii) no node carries both;
      (iii) the mesh/accessor count dropped, proving `dedup()` really did merge the geometry and
      the test is exercising the hazard rather than sidestepping it.
- [ ] **Extras-only node survives prune.** A node with provenance extras, no mesh and no
      children is still present after `optimizeScan`. Confirm this test **fails** on `main`
      before the `keepExtras: true` change — a regression test that never went red proves nothing.
- [ ] **Point-cloud provenance.** The `point-cloud` node (`buildExporterShapedScan:56`) keeps its
      provenance in both the optimized artifact and the LODs, where `downsamplePointPrimitives()`
      (`pipeline.ts:255-289`) rebuilds its accessors and Draco skips it entirely.
- [ ] **The extras-on-nodes-only invariant is asserted, not just documented.** After
      `optimizeScan`, no `meshes[*].extras`, `materials[*].extras` or `accessors[*].extras` in
      the output JSON contains any key from `NODE_PROVENANCE_KEYS`.
- [ ] **The existing label contract still holds** — `:116`'s
      `assert.equal(labelled.length, 3, …)` and both `resolvesToGeometry` loops still pass.
- [ ] **Size sanity.** Record `result.optimized.bytes.byteLength` for the standard fixture
      before and after this change and assert it has not grown by more than a few percent — the
      guard against `keepExtras: true` keeping junk alive.

```
npm run test:pipeline:graph
deno task test
npm run verify
npm run build
```

## Acceptance Criteria

- [ ] Given a GLB whose nodes carry `sessionId`, When it is run through `optimizeScan`, Then
      every one of those nodes carries the same `sessionId` in the optimized bytes and in every
      LOD
- [ ] Given a labelled detection node whose mesh `quantize()` hoists into a new child, When the
      optimized file is read, Then the labelled node still holds the provenance extras and the
      hoisted child holds none — and a consumer walking up from the mesh finds exactly one
      provenance record
- [ ] Given one document holding two sessions' byte-identical geometry, When `dedup()` merges
      the meshes, Then each session's nodes still report their own `sessionId`, and the mesh
      count is provably lower than before (the merge really happened)
- [ ] Given a node with provenance extras and no geometry, When `prune()` runs, Then the node
      survives — and given the same input on `main`, it does not
- [ ] Given `_runOptimizeScanJob` completing for a scan with `scanId` `scan-session-123`, When
      `.opt.glb` is read, Then its nodes carry `extras.scanId === 'scan-session-123'`
- [ ] Given `grep -n "Deno\.\|process\.\|globalThis\." pipeline.ts`, When run, Then there are no
      hits — the runtime-agnostic contract survives
- [ ] Given a scan whose only primitives are POINTS, When Draco logs "Skipping Draco compression
      of N non-TRIANGLES primitives.", Then provenance on the point-cloud node is unaffected

## Risks / potential issues

- **Risk:** `keepExtras: true` defeats part of prune's job — an unused mesh, material or
  accessor carrying extras is now kept alive, inflating the optimized file. — **Mitigation:**
  In this codebase extras are written only on nodes and the document root
  (`lingbot_map_glb.ts:80`), so the practical exposure today is nil. The size-sanity assertion
  in Tests is the tripwire. If it ever fires, narrow the option to a prune call whose
  `propertyTypes` is `[NODE]` and leave a second default-options `prune()` for the rest.
- **Risk:** A guard that defeats quantize's size win. — **Mitigation:** Does not arise with the
  chosen fix. `quantize()` is untouched, its bit depths are unchanged, and the only added bytes
  are the `scanId` string per node — ~35 bytes of JSON per node, ~0.7 KB for a 20-node scan,
  against a GLB measured in hundreds of KB. The size assertion pins it. (Option (b) *would*
  have traded quantization away, which is part of why it was rejected.)
- **Risk:** Draco is skipped for non-TRIANGLES primitives — observed in real logs as
  `Skipping Draco compression of 8 non-TRIANGLES primitives.`
  (`node_modules/@gltf-transform/extensions/dist/index.js:3113`) — so point-cloud provenance
  travels a different path from mesh provenance and a single test would not cover both.
  — **Mitigation:** Separate assertions for the point-cloud node and the detection nodes, and
  a fixture that always contains both (`buildExporterShapedScan` already does, `:51-56`).
- **Risk:** The `dedup()` cross-session hazard is currently latent — today's pipeline only ever
  sees one session per document, so a test could accidentally pass by never triggering a merge.
  — **Mitigation:** The test asserts the mesh/accessor count actually dropped, so it fails if
  `dedup()` did not merge; the provenance assertion is only meaningful alongside it.
- **Risk:** The library-internal line numbers cited throughout (`index.js:1690`, `:2593`,
  `:2743`, `:3958`, and the extensions package's `:3113`) are `@gltf-transform/*@4.4.0`
  internals and will move on any version bump. — **Mitigation:** The behaviours are asserted by
  tests, not by the line numbers; the numbers are evidence for the reviewer, not a dependency.
  Re-verify before relying on them, and note the version next to each in the commit message.
- **Risk:** `pipeline.ts` importing `src/shared/provenance.ts` breaks one of the three runtimes
  that load it (Deno via `main.ts`, Node via `--experimental-strip-types`, and `tsc --noEmit`
  over the frontend program). — **Mitigation:** ADR 0002. Keep the shared file dependency-free,
  import it with the `.ts` extension from repo-root files, and run **both** `npm run verify`
  and `npm run build` — `deno check` alone will not catch it.
- **Risk:** The stamp runs before the transforms, so a bug in it corrupts LODs and the optimized
  file alike. — **Mitigation:** Deliberate (Open questions) — one code path, one set of
  assertions, and the tests cover both artifacts. A post-write patch would have been two paths.
- **Risk:** A future contributor "tidies" provenance onto a mesh where it reads more naturally,
  and cross-session dedup silently merges two places' identities. — **Mitigation:** The
  invariant is in `pipeline.ts`'s header, in `src/shared/provenance.ts`, and asserted by the
  nodes-only test — which fails loudly rather than producing a wrong merge.

## Subtasks

1. [ ] Confirm 0003 has landed and `src/shared/provenance.ts` exports `NODE_PROVENANCE_KEYS`
2. [ ] Re-verify the four glTF-Transform internals cited in "Three concrete threats" against the
       installed `4.4.0`
3. [ ] Add the failing tests first: extras-only node survives prune; provenance survives the
       optimized path and every LOD. Confirm both go **red** on `main`
4. [ ] Change `prune()` → `prune({ keepExtras: true })` at `pipeline.ts:109` and `:121`; confirm
       the extras-only test goes green
5. [ ] Extend `PipelineOptions` with `provenance?: { scanId: string }` and apply it to every node
       right after `io.readBinary(glb)` (`pipeline.ts:104`)
6. [ ] Pass `{ provenance: { scanId: scan.scanId } }` from `_runOptimizeScanJob` (`main.ts:2492`);
       handle the no-scan case by omitting the option
7. [ ] Add the cross-session dedup fixture and its three assertions (both ids present, neither
       node carries both, mesh count dropped)
8. [ ] Add the point-cloud provenance assertion and the nodes-only assertion over
       `meshes`/`materials`/`accessors` extras
9. [ ] Add the size-sanity assertion; record before/after bytes for the standard fixture
10. [ ] Document the invariant in `pipeline.ts`'s header and in `src/shared/provenance.ts`
11. [ ] Run `npm run test:pipeline:graph`, `deno task test`, `npm run verify`, `npm run build`
12. [ ] Update `docs/factory/atlas.html:357`
