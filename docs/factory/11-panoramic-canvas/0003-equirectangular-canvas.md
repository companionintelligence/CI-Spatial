> **Type:** Backend
> **Wave:** 11-panoramic-canvas
> **Branch:** `feat/panoramic-canvas`
> **Commit style:** `feat(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0002 (needs depth)

## Goal

Build the canvas: reproject the posed keyframes of a scan onto one equirectangular image,
centred on a chosen viewpoint, and write it beside the scan with a manifest. This is the
contract everything else in the wave hangs off.

## The maths, pinned

Fully specified by the paper, and it needs none of OneCanvas's unreleased code.

Per contributing pixel (Phase A) or patch (Phase B):

```
p_world = T_k · [ (u − cx)·z / fx,  (v − cy)·z / fy,  z ]ᵀ
q       = Rᵀ (p_world − c)                    # into the canvas frame
θ       = atan2(qx, qz)                       # longitude
φ       = arctan( −qy / √(qx² + qz²) )        # latitude
```

`c` is the canvas origin, `R` its orientation. `θ ∈ (−π, π]` maps to canvas width, `φ` to
height.

**Nearest depth wins on collision.** The canvas is meant to be occlusion-free *from its
origin*, so when two samples land on the same texel the front-most one is the correct one — not
the last one written, which is what a naive loop gives.

## Non-goals

- Do not project features. Phase A is RGB, deliberately: the trained adapter that reads a
  feature canvas is exactly the part that is unreleased, and a feature canvas fed to an
  un-adapted VLM is noise. The contract is written so the swap is a change of *what* is
  projected.
- Do not select frames — 0004 owns that. Take a frame list.
- Do not call any model. 0005 owns that.
- Do not add a second image pipeline. Reuse what the repo already has for encoding.

## Pinned conventions

**ADR 0001** — touches schema, storage and a job type.

*Job.* Searched before adding: `WorldJobType` has no canvas-shaped member and none of the
placeholder types fits (`extract-layers` is a manifest pass, `semantic-pass` is inference,
`depth-reconstruct` is 0002's). **One new member: `'build-canvas'`.** Every one of the twelve
`WorldJob` edit sites applies — notably `WORLD_JOB_TYPES` in `server/main.ts` (a hand-maintained
`Set`, not derived from the union, so it silently drifts) and `jobResultFor()`, whose exhaustive
switch fails `deno check` without a new case.

*Layer.* One new `LayerType` member, `'canvas'`, promoted `'future'` → `'sidecar'` on success
exactly as `splat-train` promotes `'splat'`.

*Manifest.* `CanvasManifest extends PipelineManifestBase`, declared in `src/world/manifests.ts`
and re-exported from `src/world/types.ts` — ADR 0002, and not negotiable: `tsc --noEmit`
type-checks a file's whole body once it enters the program, so a browser file type-importing
from a Deno driver drags `Deno.*` into the frontend program. `npm run build` is the gate that
catches it, not `deno check`.

*Intrinsics and poses.* Same sources and same reuse as 0002 — `deriveIntrinsics()`, the
`meta.pose` → `lingbot-map.poses.json` fallback, **no axis flip**.

*Artifacts.* `<base>.canvas.png` + `<base>.canvas.manifest.json`, served through the existing
suffix-allowlist route in `server/main.ts` with its traversal guard. Add both suffixes to
`SPLAT_ARTIFACT_MIME` and the route regex; that table is ordered specific-before-general and
the route is registered before the `.glb`-only one deliberately.

**The origin is a parameter, not a constant.** Default to the scene centroid; accept a Place's
calibration anchor (ADR 0005) or an arbitrary pose from the payload. This is the hook that
situated reasoning needs and it is cheap to build in now and expensive to retrofit.

## Before implementation

- `server/splat/splat_train_dataset.ts` — intrinsics, poses, the SOF-marker dimension read.
- `server/splat/splat_train.ts` — the driver contract.
- `server/main.ts:645-700` — the artifact mime table, the suffix-regex route and the ordering
  comment that explains why it is registered first.
- `server/main.ts` — the twelve `WorldJob` edit sites; `_runSplatTrainJob` as the glue archetype.
- `src/world/manifests.ts` — the envelope and its header on why it exists.
- `docs/adr/0005-*.md` — what a Place's spatial frame is, since it is a valid canvas origin.

## Open questions & answers

- Q: Equirectangular, or cube map? — A: Equirectangular, because that is what the paper
  specifies and what the eventual adapters are trained to read. A cube map would be kinder to
  sampling at the poles and would make the later swap impossible. (Decided in this ticket.)
- Q: What resolution? — A: Default to the paper's evaluation sizes — 320×240 for the small case
  and 640×480 for the large — as a parameter, not a constant. **Adopted, and they are the
  numbers the adapters were evaluated at**, which is the strongest reason available. Record the
  resolution in the manifest.
- Q: What happens at the poles, where equirectangular sampling is wildly non-uniform? — A:
  Accept it. The paper accepts it, a room's interesting content is not on the vertical axis, and
  the alternative changes the format. Note it in the manifest doc comment so a future reader
  knows it was considered rather than missed.
- Q: What if a scan has no depth (0002 skipped)? — A: `'skipped'` with a remediation naming
  `depth-reconstruct`. A canvas without depth is not a degraded canvas, it is not a canvas —
  every sample would need a distance to place it. (Decided in this ticket.)
- Q: Should the canvas record which frames contributed? — A: Yes, in the manifest. A canvas
  built from a bad 32 is worth being able to diagnose, and 0004 is the thing that would be at
  fault. (Decided in this ticket.)
- Q: One canvas per scan, or one per origin? — A: One artifact per `(scan, origin)`, keyed by a
  short hash of the origin in the filename. The default-centroid canvas is the common case and
  gets the unsuffixed name; a situated one from 0006 does not overwrite it. (Decided in this
  ticket.)

## Files impacted

New:
- `server/canvas/equirect.ts` — the pure maths (`unproject`, `toSpherical`, `canvasTexelFor`)
- `server/canvas/build_canvas.ts` — the driver
- `tests/unit/deno/equirect.test.ts`
- `tests/api-build-canvas.spec.ts`

Changed:
- `src/world/types.ts` — `'build-canvas'`, `'canvas'`, manifest re-export
- `src/world/manifests.ts` — `CanvasManifest`
- `src/world/layers.ts` — the `'canvas'` label, order and default visibility
- `server/main.ts` — the twelve sites, plus the mime table and route regex

## Schema required

```ts
// src/world/types.ts
export type WorldJobType = … | 'build-canvas'
export type LayerType    = … | 'canvas'
```

```ts
// src/world/manifests.ts
/**
 * One equirectangular canvas: the scan's posed frames reprojected onto a single
 * occlusion-free image, centred on `origin`.
 *
 * The contract between capture and whatever reads it. Phase A projects RGB;
 * a later phase projects frozen-encoder patch features onto the same geometry.
 * Nothing downstream of this manifest knows which.
 *
 * Sampling is non-uniform near the poles — inherent to equirectangular, accepted
 * because a room's content is not on the vertical axis.
 */
export interface CanvasManifest extends PipelineManifestBase {
  tool: 'equirect-canvas';
  sessionId: string;
  /** Canvas origin in world space, and its orientation. */
  origin: { position: Vec3; rotation: Quat };
  /** How the origin was chosen, so a canvas can explain itself. */
  originSource: 'centroid' | 'calibration-anchor' | 'explicit';
  width: number;
  height: number;
  /** Session-relative keyframe filenames that contributed, in projection order. */
  frames?: string[];
  /** Fraction of canvas texels carrying a sample. The canvas's own coverage. */
  coverage?: number;
  /** What was projected. 'rgb' today; 'features' is the drop-in point. */
  projected: 'rgb' | 'features';
  canvasPath?: string;
  params: {
    resolution: [number, number];
    pointRadiusPx: number;
  };
}
```

## Definition of Done

- [ ] `build-canvas` is dispatchable and handled at all twelve sites; `deno check` passes
      (which is what proves `jobResultFor`'s exhaustive switch is complete)
- [ ] A scan with depth produces `<base>.canvas.png` + its manifest, and both are served
- [ ] Nearest-depth wins on texel collision — the canvas is occlusion-free from its origin
- [ ] The origin defaults to the centroid and accepts a calibration anchor or explicit pose,
      recording which in `originSource`
- [ ] A scan without depth is `'skipped'` with a remediation naming `depth-reconstruct`
- [ ] Canvas coverage and the contributing frame list are recorded
- [ ] The maths lives in pure functions and is unit-tested without a scan
- [ ] `deno task check`, `npx tsc --noEmit`, **`npm run build`** all pass

## Tests

- [ ] Unit: a point directly ahead of the origin lands at `θ = 0`; directly behind at `θ = ±π`;
      directly above at `φ = +π/2`
- [ ] Unit: unproject → toSpherical → back round-trips to within a texel
- [ ] Unit: two samples on one texel — the nearer wins regardless of projection order
- [ ] Unit: a frame with zero depth coverage contributes nothing rather than smearing
- [ ] Unit: changing the origin moves a fixed world point to the expected new `(θ, φ)`
- [ ] Fixture: a **synthetic posed session of a box room** with known geometry, so the canvas
      has a checkable expected shape rather than only "an image was produced" — extend the
      approach `scripts/make-splat-fixture.mjs` already uses
- [ ] Playwright: enqueue on the fixture; assert manifest, image, and that a traversal attempt
      on the serve route is rejected

```bash
deno task check
deno task test
npx tsc --noEmit
npm run build
npx playwright test tests/api-build-canvas.spec.ts --project=api
```

## Acceptance Criteria

- [ ] Given a scan with depth, When `build-canvas` runs, Then a canvas exists whose manifest
      names its origin, its resolution and the frames that built it
- [ ] Given the synthetic box-room fixture, When the canvas is built, Then the four walls land
      at the four expected longitude bands
- [ ] Given a second job with an explicit origin, Then it writes its own artifact and does not
      overwrite the centroid canvas
- [ ] Given a scan whose depth job was skipped, Then this job completes green with a hint

## Risks / potential issues

- **Risk:** the geometry is easy to get subtly wrong in a way that still produces a
  plausible-looking image — a mirrored or 90°-rotated canvas looks fine until something depends
  on it. — **Mitigation:** the pure-function unit tests assert *known* directions, and the
  box-room fixture gives a checkable expected shape. This is why the maths is extracted rather
  than inlined in the driver.
- **Risk:** holey depth (0002's open question) makes a holey canvas. — **Mitigation:** canvas
  coverage is recorded, so a poor canvas is explicable; and the frame list says which views to
  blame.
- **Risk:** one artifact per origin could multiply. — **Mitigation:** the default canvas has a
  stable name and situated ones are hash-suffixed; if it becomes a problem it is a retention
  question, which the wave README already records as deferred.
- **Risk:** `WORLD_JOB_TYPES` is hand-maintained and already drifts from the union
  (`'optimize-scan'` is deliberately absent), so a missing entry fails at runtime rather than at
  compile time. — **Mitigation:** the twelve-site table in the Before-implementation list, plus
  `jobResultFor`'s exhaustive switch catching the most important omission at `deno check` time.

## Subtasks

1. [ ] Write `server/canvas/equirect.ts` as pure functions, with the direction tests first
2. [ ] Add the synthetic box-room fixture
3. [ ] Add `CanvasManifest`; add `'build-canvas'` and `'canvas'` to their unions
4. [ ] Write the driver following the `splat_train.ts` contract
5. [ ] Walk the twelve `WorldJob` sites; let `deno check` confirm the switch
6. [ ] Mime table + route regex for the two new suffixes
7. [ ] Promote the `'canvas'` layer on success
8. [ ] Unit + Playwright tests; `deno task check`, `npx tsc --noEmit`, `npm run build`
