> **Type:** Backend
> **Wave:** 11-panoramic-canvas
> **Branch:** `feat/depth-reconstruct`
> **Commit style:** `feat(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Give `depth-reconstruct` a runner. It has been a declared `WorldJobType` with no producer since
the job systems were merged; this makes it render a depth map per keyframe by projecting the
LingBot-Map point cloud through that keyframe's own pose and intrinsics.

Depth is the one canvas input this repo does not already produce.

## Non-goals

- Do not add a monocular depth model. The point cloud and the poses already exist; a second
  source is only warranted if measurement says the first one is insufficient (see Q&A).
- Do not build the canvas. That is 0003 — this ticket stops at "every keyframe has a depth map
  and the manifest says how good it is".
- Do not change `lingbot-map-reconstruct`, its point cloud, or its pose estimation.
- Do not invent a new artifact route pattern. Depth sidecars are served the way keyframes are.

## Pinned conventions

**ADR 0001** — touches schema and storage layout, so the search is recorded.

Searched for an existing depth concept before adding one, and **found three, all already
declared and none implemented**:

| Existing | Where | Status |
| --- | --- | --- |
| `'depth-reconstruct'` | `src/world/types.ts` `WorldJobType` | declared; no runner, and in `KEYFRAME_JOB_TYPES` |
| `'depth'` | `src/world/types.ts` `LayerType` | declared; `LAYERS_HIDDEN_BY_DEFAULT` already lists it |
| `FrameObservation.depthUrl` | `src/world/types.ts` | declared; nothing writes it |

So this ticket **adds no new domain concept** — it supplies the producer three declared ones
have been waiting for. That is the ADR-0001-preferred outcome and it should stay that way: no
new job type, no new layer type, no parallel depth record.

**Intrinsics.** Reuse `deriveIntrinsics()` (`server/splat/splat_train_dataset.ts:299`). It
already converts the recorded `fovYDeg` + `aspect` into `fx/fy/cx/cy` **and rescales for the
actual image dimensions**, which matters because the phone downscales frames and the recorded
dims drift. Do not write a second one.

**Poses.** Same fallback chain the Brush dataset builder uses: the keyframe's own
`meta.pose`, then `lingbot-map.poses.json` for pose-less (video-ingest) sessions.

**Convention.** No axis flip — Companion-Scan / WebXR / three.js poses are already in the
OpenGL/Blender camera-to-world convention, which `docs/pipelines/splat-train.md` states
explicitly and which is the single easiest thing to get wrong here.

**The driver contract**, copied from `server/splat/splat_train.ts`: `resolveParams()` with
`opts.x ?? Deno.env.get('X') ?? DEFAULT`; a pure args/plan builder that unit-tests without I/O;
**always** write `<base>.depth.manifest.json` on every path including skip and error; a missing
input is `'skipped'` with a `remediation` string, never `'error'`; never throw into the server.

**Format.** 16-bit single-channel PNG, metric **millimetres**, `0` meaning *no data* — not zero
distance. A float format would be truer and is not worth the tooling; millimetre integers cover
a room at 1 mm precision within 16 bits up to 65 m.

## Before implementation

- `server/splat/splat_train_dataset.ts` — `deriveIntrinsics`, `poseToMatrix`, the pose fallback,
  and `readJpegDimensions` (which is why real dims are read from the SOF marker, not trusted).
- `server/splat/splat_train.ts` — the driver shape to copy.
- `server/lingbot-map/lingbot_map.ts` and `scripts/lingbot_map_worker.py` — what the point cloud
  and `lingbot-map.poses.json` actually contain.
- `server/main.ts` — `_runSplatTrainJob` as the runner-glue archetype; `claimSessionJob`;
  `KEYFRAME_JOB_TYPES`, which already lists `depth-reconstruct`; the keyframe serve route at
  `/sessions/:id/keyframes/:file` and its `KEYFRAME_FILE_RE`.
- `src/world/layers.ts` — how a layer is promoted from `'future'` to `'sidecar'`.

## Open questions & answers

- Q: Point cloud, monocular model, or the trained splat? — A: **The point cloud**, because it is
  already produced, already in the right frame, and already posed. A monocular model is a new
  dependency with its own scale ambiguity; rendering depth from a trained splat needs the splat
  to exist, which makes depth depend on a much longer chain. Revisit if coverage measures badly.
  (Decided in this ticket.)
- Q: A feed-forward point cloud is sparse — will the depth maps be full of holes? — **OPEN, and
  this ticket's real work.** The plan, in preference order: (a) splat each point with a small
  screen-space radius and keep the nearest; (b) fill small holes by local interpolation;
  (c) fall back to a monocular model only for frames below a coverage threshold. **Pick by
  measuring coverage on a real scan**, and record the figure per frame in the manifest.
- Q: Why record coverage rather than just producing the best depth we can? — A: Because the
  canvas built from it is exactly the kind of artifact that looks plausible while being wrong,
  and a holey canvas is indistinguishable from a badly-posed one by eye. OneCanvas's own
  limitations section names the neighbouring failure — *"pose-estimation failures can still
  degrade the canvas"* — and depth failures do the same. A number in the manifest is what makes
  a poor canvas explicable instead of mysterious. (Decided in this ticket.)
- Q: Should a frame with very low coverage be written at all? — A: Yes, with its coverage
  recorded. Dropping it silently would leave 0003 unable to distinguish "this view was not
  captured" from "this view was captured badly", and those want different responses.
- Q: `0` means no-data — does that collide with a real zero depth? — A: No. A sample at exactly
  0 mm from the camera centre is not physically meaningful, and every consumer treats 0 as a
  gap. Say so in the manifest's format note so nobody later "fixes" it.

## Files impacted

New:
- `server/depth/depth_reconstruct.ts` — the driver
- `tests/unit/deno/depth_reconstruct.test.ts`

Changed:
- `server/main.ts` — dispatch branch, `_runDepthReconstructJob`, `jobResultFor` case, the
  depth serve route
- `src/world/manifests.ts` — `DepthReconstructManifest extends PipelineManifestBase`
- `src/world/types.ts` — re-export it
- `.env.example` — the depth knobs

## Schema required

No new domain concept — the three declarations above finally get a producer. One new manifest,
in `src/world/manifests.ts` per ADR 0002 (it must be type-importable from the browser):

```ts
export interface DepthReconstructManifest extends PipelineManifestBase {
  tool: 'depth-from-points';
  sessionId: string;
  /** Frames a depth map was written for. */
  frameCount?: number;
  /**
   * Fraction of pixels carrying a real sample, per frame, in frame order.
   *
   * Recorded rather than summarised because a canvas is only as good as its
   * worst contributing view, and a mean would hide exactly that.
   */
  coverage?: number[];
  /** Depth is millimetres in a 16-bit PNG; 0 is NO DATA, not zero distance. */
  format: 'png16-mm';
  params: {
    pointRadiusPx: number;
    maxHoleFillPx: number;
  };
}
```

Per-frame sidecars land beside the keyframes they describe:
`scans/sessions/<id>/kf-NNNNN.depth.png`, and `FrameObservation.depthUrl` finally points at
something.

## Definition of Done

- [ ] `depth-reconstruct` has a runner and is dispatchable via `POST /worlds/:slug/jobs`
- [ ] A session with a LingBot point cloud gets one `kf-NNNNN.depth.png` per posed keyframe
- [ ] Coverage is measured per frame and recorded in the manifest
- [ ] A session with **no** point cloud is `'skipped'` with a remediation string — a green job,
      matching `BRUSH_BIN` and `LINGBOT_MAP_*`
- [ ] The scan's declared `'depth'` layer is promoted `'future'` → `'sidecar'`, the way
      `splat-train` promotes `'splat'`
- [ ] `FrameObservation.depthUrl` resolves and the file is served
- [ ] `deriveIntrinsics()` is reused, not reimplemented
- [ ] `deno task check`, `npx tsc --noEmit`, `npm run build` pass

## Tests

- [ ] Unit: unproject/reproject round-trip — a point at a known depth projects back to the pixel
      it came from, within a pixel
- [ ] Unit: a pose-less keyframe falls back to `lingbot-map.poses.json`; a session with neither
      is `'skipped'`, not `'error'`
- [ ] Unit: coverage is 0 for an empty cloud and 1 for a synthetic cloud that fills the frustum
- [ ] Unit: `0` in the PNG round-trips as *no data* rather than as a near sample
- [ ] Unit: a missing point cloud writes a manifest with `remediation` (the fallback the
      coordinator relies on)
- [ ] Playwright (`api-depth-reconstruct.spec.ts`): enqueue against a fixture session; assert the
      manifest, the sidecars and that a depth PNG is served with the right mime

```bash
deno task check
deno task test
npx tsc --noEmit
npx playwright test tests/api-depth-reconstruct.spec.ts --project=api
```

## Acceptance Criteria

- [ ] Given a session that has been through `lingbot-map-reconstruct`, When `depth-reconstruct`
      runs, Then every posed keyframe has a depth sidecar and the manifest reports its coverage
- [ ] Given a session with no point cloud, When it runs, Then the job completes **green** with a
      hint naming `lingbot-map-reconstruct`
- [ ] Given a frame whose coverage is very low, Then it is still written, and the manifest says
      so rather than the frame silently vanishing
- [ ] Given the editor, When the scan loads, Then its `'depth'` layer is a real sidecar layer
      rather than a `'future'` placeholder

## Risks / potential issues

- **Risk (the main one):** the cloud may be too sparse for a usable depth map, making the whole
  canvas holey. — **Mitigation:** this ticket measures coverage rather than assuming it, and the
  monocular fallback is a named, costed escape hatch rather than a surprise.
- **Risk:** a wrong axis convention produces a depth map that looks reasonable and is
  systematically mirrored — the classic silent geometry bug. — **Mitigation:** the round-trip
  unit test is the guard, and it is written first.
- **Risk:** one PNG per keyframe at up to 2000 keyframes per session is real disk, on top of
  the JPEGs. — **Mitigation:** 0004 selects K≈32 frames for the canvas, so depth only needs to
  run for the selected set — make the runner take a frame list rather than always doing all of
  them.
- **Risk:** promoting the `'depth'` layer makes it visible in the editor by default. —
  **Mitigation:** `LAYERS_HIDDEN_BY_DEFAULT` already lists `'depth'`; keep it there.

## Subtasks

1. [ ] Write the projection maths as pure functions, with the round-trip test first
2. [ ] Add `server/depth/depth_reconstruct.ts` following the `splat_train.ts` contract
3. [ ] Measure coverage on a real scan; choose the densification approach from the number
4. [ ] Add the runner glue, the `jobResultFor` case and the dispatch branch in `server/main.ts`
5. [ ] Promote the `'depth'` layer on success; write `depthUrl`
6. [ ] Add the serve route and its traversal guard
7. [ ] `DepthReconstructManifest` in `manifests.ts`, re-exported from `types.ts`
8. [ ] Document the knobs in `.env.example`
9. [ ] `deno task check`, `deno task test`, `npx tsc --noEmit`, `npm run build`
