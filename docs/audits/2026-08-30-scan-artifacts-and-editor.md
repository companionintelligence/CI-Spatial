# Audit — what the pipeline produced, and what the editor says about it

**2026-08-30, branch `claude/panoptic-lift-editor`.** Every number here was measured on this box
tonight. Where a finding came from looking at the UI rather than from reading a file, it says so.

Method: `node scripts/audit-scan-glb.mjs <all 426 GLBs> --summary`, plus direct reads of the
sidecar manifests, the source PLYs, `GET /worlds/default`, and the editor at
`http://localhost:5175/viewer.html?world=default`.

---

## 1. The sweep

426 GLBs in `scans/`. **360 clean, 39 with warnings, 27 with errors.** The run takes 2.5 s.

The two warnings the brief expected on COLMAP-generated GLBs — *no estimated_floor*, *no
camera_trajectory* — are still there and still the only structural ones. They were **not** the
only warnings the script emitted, but the extra ones were the script's own fault, not the data's:

| before tonight | after |
| --- | --- |
| 23 files killed the script with a raw stack trace | 0 — unreadable input is now a report with an error in it |
| 295 of 405 readable GLBs warned "point cloud spans 65534 m" | 0 — that number was never real |

Both were auditor defects, fixed in `scripts/audit-scan-glb.mjs`:

- **The 65534 m extents.** The extent walk read `POSITION` with `getArray()` and ignored the node
  transform. On a `KHR_mesh_quantization` accessor `getArray` returns raw normalized int16, and
  `quantize()` parks the dequantization scale on the *node* — in
  `1787789921923_home-00-studio-a.opt.glb`, scale 2.470 and translation (0, 1.300, 0). So every
  quantized artifact reported a ~65 km room and tripped the drift heuristic. The repo already knew
  this: `server/panoptic/panoptic_lift.ts:225` (`collectPointPositions`) does the walk correctly and
  says why. `pointCloudBounds` in the auditor now matches it (a second implementation, because that
  module resolves `@std/path`, which node cannot load).
- **The crashes.** 21 were `*_probe.glb` files of 1 and 7 bytes — upload smoke tests, not scans.
  Two were real captures using `KHR_materials_unlit`, which the auditor did not register:
  gltf-transform threw `Missing optional extension`, the process exited 1, and that is
  indistinguishable from "this scan has errors". It now registers `ALL_EXTENSIONS`, as
  `panoptic_lift.ts` already did.

After the fix the largest extent in `scans/` is **61.0 x 49.6 x 54.3 m** — real drift on the
2026-08-27 gimbal captures, consistent with the 63.41 m figure already recorded in the source.

## 2. The three artifacts of tonight's two video sessions

```
  scans/sess-video-20260830-033839.glb          9,362 pts   18.9 x 11.6 x 21.2 sfm
  scans/sess-video-20260830-054518.glb         12,430 pts   20.7 x 10.8 x 17.4 sfm
  scans/sess-video-20260830-054518.lingbot.glb  2,436,672 pts   0.0370 x 0.0364 x 0.0367 m
```

Provenance is clean on all three: scene extras carry `sessionId` and `capturedAt`, the node-only
invariant from `src/shared/provenance.ts` holds everywhere, and no provenance key is misplaced onto
a dedup candidate. The COLMAP pair also carries `scanId`; the LingBot GLB does not, which is
correct — it never went through the optimize pass that stamps it.

**Trustworthy.** Everything that describes the COLMAP pair. `colmap-poses.manifest.json` says 48/48
and 32/32 registered, `quality.status: ready`, `degenerate: false`, and the GLB point counts match
the manifests exactly (12,430 and 9,362). The splat manifests agree with each other and with the
files on disk: 253,021 and 246,838 gaussians, unchanged from `splat-train` through `splat-finish`,
with the .ply/.sog/.compressed.ply all present and non-empty at the declared sizes.

**Not trustworthy — the LingBot-Map reconstruction.** `lingbot-map.manifest.json` reports
`status: ok, pointCount: 2436672, elapsedMs: 21127`. All 2,436,672 of those points sit inside a
**3.7 cm cube**:

```
lingbot-map.point-cloud.ply   x 0.0465..0.0835   y -0.0113..0.0251   z -0.0916..-0.0549
```

That is read straight out of the binary PLY, so it is not a GLB decoding artifact — and the GLB
agrees to four decimals, as does three.js loading the same file in the browser. COLMAP's cloud for
the **same session** spans ~20 units. Two reconstructions of one room, 559x apart in scale, with no
`splat-align` fit on disk relating them. The count looks like a triumph and there is no room in
there. This is the repo's recurring defect in its purest form, and nothing on disk or in the UI
says so.

**Absent, not failed.** No `panoptic-lift.manifest.json` and no `.panoptic.detections.json` exists
for either session, so the 38 and 29 thing segments the segmenter found have never been turned into
positions. That is consistent with the brief's structural explanation (0 of 48 keyframes carry a
metric capture pose) — but the *absence of the manifest* means nothing on disk records the reason.
A lift that ran and honestly abstained would leave a `reasons` breakdown; a lift that never ran
leaves the same silence as a lift that was never wired up.

## 3. New cross-artifact checks

The auditor knew about geometry, structure, detections and provenance. It knew nothing about the
sidecars, so a scan could be a healthy GLB and an incoherent *set*. `coherenceFindings` now reads
`colmap-poses`, `panoptic`, `lingbot-map`, `splat-train`, `splat-align`, `splat-detect`,
`splat-finish` and `panoptic-lift` beside each scan and checks:

- a stage reporting `ok` whose declared output is **missing or zero bytes** — error
- a stage reporting `ok` with its **principal count at 0** (gaussians, points, frames, objects) — error
- a **degenerate pose solve feeding a downstream `ok`** — error, naming the registration ratio
- **gaussian counts that change** between training and compression — error
- a **GLB holding a different point count** than the solve says it wrote — error
- the lift's own arithmetic: `confident + undetermined == segmentCount`, `reasons` summing to
  `undetermined`, `lowConfidence` a subset and not a third bucket — errors, exactly as
  `src/world/manifests.ts` states them
- the lift's **detections sidecar against its manifest** — placements claimed vs positions carried,
  records with neither a position nor a reason, positions with no confidence
- **two clouds of one session at incompatible scales** — error
- a **collapsed cloud** (< 0.25 units across) — error in metres, warning in SfM units
- objects segmented and **never lifted**; a segmenter run with **no thing-label list**; a splat with
  **no alignment fit**; optional tooling that **skipped with no remediation**

Extents are also now labelled honestly. A cloud whose `colmap-poses` manifest names it is in
structure-from-motion units, and the 30 m room heuristic is not applied to it — judging a scale-free
reconstruction against a metric threshold is a verdict the script has not earned.

35 unit tests in `tests/unit/node/scan_coherence.test.ts` pin all of it, including the abstentions.
One of them exists because the checker got it wrong first: reading `worldPos` as an array (it is the
`Vec3` object `src/shared/panoptic_lift.ts:65` declares) made it report a lift that placed 6 objects
as having placed 0. A checker that manufactures findings is worse than no checker.

**What tonight's data cannot exercise:** the degenerate-solve check. The only degenerate verdict the
brief mentions (sess-a7e2f642, 3/17) has no `colmap-poses.manifest.json` on disk any more — the two
that exist are both `ready` at 100%. That check is covered by unit test only, not by live data.

## 4. Findings against the editor

All confirmed by loading `http://localhost:5175/viewer.html?world=default`, reading the rendered
text, and comparing it to the files. Nothing here is fixed — `src/viewer/**` is another agent's.

### 4.1 A metric size for an unscaled reconstruction

`src/viewer/viewer.ts:2785` renders `Size` with a literal `m` suffix; `src/viewer/editor.ts:283-285`
produces the number from `Box3.setFromObject`. For **fps-fix verification** the card reads:

```
Size   20.7 x 10.79 x 17.36m
```

That is exactly the COLMAP cloud's extent — in structure-from-motion units. Nothing in the chain
establishes metres: there is no `splat-align` manifest, `colmap-poses.manifest.json` carries no
scale, and `panoptic_lift.ts` refuses solved poses precisely *because* they have no metres in them.
The same card for **Synthetic walkthrough fixture** reads `18.93 x 11.56 x 21.23m`, likewise the raw
SfM extent. The splat panel three inches below gets this exactly right — "Not measured against the
real room yet, so it may appear much larger or smaller than life size" — so the honest phrasing
already exists in the product; the size card just does not use it.

### 4.2 The size card for the LingBot scan does not describe the LingBot scan

```
Scan   sess-video-20260830-054518.lingbot
Size   1.48 x 0.74 x 1.61m
```

Measured three independent ways, that GLB's contents span **0.0370 x 0.0364 x 0.0367**: the auditor,
the source PLY (no GLB decode involved), and three.js `Box3.setFromObject` loading the same URL from
the same dev server inside that same page. The card is 40x out on x, 20x on y, 44x on z — not a
uniform factor, so it is not the cloud expressed in different units. Something other than the point
cloud is inside the box `getInspectorData` measures.

### 4.3 "Nothing has looked for things in this scan yet"

`src/viewer/panoptic-layer.ts:427-434`. Both video scans show:

> Nothing has looked for things in this scan yet. The room itself is here — it just has not been
> read for objects, so there is nothing to list. **Nothing is wrong with the scan.**

Something did look. `panoptic.manifest.json` for sess-video-20260830-054518 records
`status: ok, framesSegmented: 48, thingCount: 38, stuffCount: 136, thingLabelsUsed: true`, finished
at 05:45:45. For sess-video-20260830-033839 it is 29 things. What has not happened is the *lift*.
`placementVerdictOf(null)` only ever sees the lift sidecar, so it cannot distinguish "the segmenter
never ran" from "the segmenter found 38 objects and nothing placed them" — and it resolves the
ambiguity toward reassurance. Its own doc comment flags `null` as the branch that "is the one case
the caller cannot get from a manifest"; the manifest that would settle it is
`panoptic.manifest.json`, which this code does not read.

### 4.4 A collapsed reconstruction reported as ready

The scan list shows `sess-video-20260830-054518.lingbot — Ready`, and the workspace panel says
"Reconstruction ready — 2,436,672 points, 16 poses. Run took 21.1s on 16 frames." Every one of those
numbers matches the manifest. None of them is wrong, and the sentence is still false: the thing is
3.7 cm across. `GET /worlds/default` also gives it `status: "ready"` and `qualitySummary: null` —
there is no quality gate on this path at all, the way `colmap-poses` has one.

### 4.5 The LingBot output is a separate scan with no session

In `GET /worlds/default` that entry is `scanId: scan-sess-video-20260830-054518-lingbot` with
**`sessionId: null`**, even though the GLB's own scene extras carry
`sessionId: sess-video-20260830-054518`. It is placed at world (6, 0, 54) while its COLMAP sibling
sits at (6, 0, 51). Two reconstructions of one room are presented as two unrelated rooms 3 m apart,
at a 559x scale difference, with the link to the session dropped on the way into the world model.

### 4.6 Layers that claim to be in the GLB and are not

Every scan's `layerIndex` marks `mesh`, `floor`, `cameraPath`, `detections` and `labels` as
`encodedInGlb: true, source: "glb"` — `src/world/layers.ts:63-68` decides this by layer *type*
alone, never by looking in the file. For both video scans the GLB contains no surface geometry
(0 triangle vertices), no `estimated_floor` node, no `camera_trajectory` node and no detection
nodes. Five of the thirteen layers offered describe content that is not in the artifact they name.
`count` is `null` for all of them, so nothing contradicts the claim on screen either.

### 4.7 `layer-splat: source "future"` for a scan with a trained splat

Both video scans carry `{"id":"layer-splat","source":"future","count":null}` in the world payload,
which is the reserved placeholder `server/main.ts:3712-3719` is supposed to promote to
`source: "sidecar"` with the gaussian count when a `splat-train` job completes. It was never
promoted, so the world model says a Gaussian splat is a future capability for a scan that has a
38.5 MB one. The workspace panel reads the manifest directly and gets it right ("Trained splat
ready — 253,021 gaussians"), so the two halves of the same screen disagree.

### 4.8 Three different scan counts on one screen

`GET /worlds/default` returns **112** scans, every file present on disk. The header reads
**107 SCANS**, the list holds 107 rows, and the viewport HUD reads **106 scans loaded**. The five
scans the list omits are the five oldest — `autosave-room-scan-2026-08-27T05-51-51`,
`room-scan-2026-08-27T06-06-28`, `autosave-room-scan-2026-08-27T07-42-36`,
`room-scan-2026-08-27T07-43-34`, `room-scan-2026-08-27T07-54-01`. It is not a status filter: 19
scans are `needs-rescan` and 14 of those are listed. Four of the five happen to be the world's worst
artifacts (the only zero-geometry GLB, and three of the four worst-drift captures), and the fifth is
clean, so the omission is not quality-driven either. Nothing on screen says five scans are hidden,
and nothing says which one of the 107 listed did not load.

### 4.9 Internal job type names shown to the user

The jobs panel lists `lingbot-map-reconstruct — completed · fps-fix verification` and
`lingbot-map-reconstruct — failed · fps-fix verification`. CLAUDE.md's rule is to name outcomes, not
`WorldJob` types.

## 5. What holds up

- Provenance. The node-only invariant survives the optimize pass on every readable GLB in `scans/`;
  no misplaced keys anywhere in 426 files.
- The splat chain's self-consistency, and the way the splat panel reports it — including the
  unprompted admission that the splat has no metric scale yet. That is the standard the size card
  should be held to.
- Optional-tool degradation. `lingbot-map` on sess-video-20260830-033839 reports
  `Skipped: torch import failed: No module named 'torch'` and the UI shows it as a skip with the
  reason, not as a failure and not as a success.
- COLMAP's quality gate. It computes a verdict, records the thresholds it used, and both of
  tonight's sessions genuinely pass it at 100% registration.

## 6. Not done

- `scripts/audit-scan-glb.mjs` is not wired into `npm run verify`, and neither is
  `tests/unit/node/scan_coherence.test.ts` — that needs a `package.json` edit, which three other
  agents were holding tonight. Run it with:
  `node --experimental-strip-types --no-warnings --test tests/unit/node/scan_coherence.test.ts`
- The degenerate-solve coherence check has no live data to fire on (§3).
- No editor finding in §4 was fixed; `src/viewer/**` belongs to another agent.
