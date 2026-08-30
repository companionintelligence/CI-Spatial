# Panoptic scan

Segments **every** pixel of a session's keyframes into discrete objects
("things": chair, table, lamp) and room surfaces ("stuff": wall, floor,
ceiling), so a scan can answer "what is in this room" rather than only "what did
the detector happen to spot".

A second stage then lifts each object segment to a 3-D world position — or says
which ones it cannot place, and why. See
[Lifting a segment to a world position](#lifting-a-segment-to-a-world-position).

- Driver: [`server/panoptic/panoptic_scan.ts`](../../server/panoptic/panoptic_scan.ts)
- Policy: [`server/panoptic/panoptic_segments.ts`](../../server/panoptic/panoptic_segments.ts)
- Worker: [`scripts/panoptic_worker.py`](../../scripts/panoptic_worker.py)
- Lift driver: [`server/panoptic/panoptic_lift.ts`](../../server/panoptic/panoptic_lift.ts)
- Lift policy: [`src/shared/panoptic_lift.ts`](../../src/shared/panoptic_lift.ts)

Like every other optional GPU tool here (`BRUSH_BIN`, `SPLAT_DETECT_*`,
`LINGBOT_MAP_*`, `SENSENOVA_*`), an uninstalled runtime yields a `skipped`
result with a remediation hint rather than a failure — so the appliance keeps
working and the whole driver is testable with nothing installed.

## Why not SenseNova-Vision

`server/sensenova_vision.ts` already integrates
[SenseNova-Vision](https://github.com/OpenSenseNova/SenseNova-Vision) and it
supports a `pan_seg` task, so it looks like the obvious answer. Two blockers:

- **Hardware.** Upstream states *1 × 80 GB GPU* for the demo. The box this was
  written on has an RTX 4080 Laptop with **12 GB**. A 7B multimodal model does
  not fit.
- **Shape.** Its driver defaults `pan_seg` to a **single image**
  (`maxImages ?? (task === 'recon3d' || task === 'camera_pose' ? 8 : 1)`). That
  is a segmented photo, not a room.

If you have an 80 GB host, the right move is to run SenseNova **off-box** the
way `person-4d-reconstruct` delegates to `subsystems/4d-capture/` (ADR 0006),
not to squeeze it in here.

## Why a Python venv and not the ONNX runtime already in the tree

Measured, not preferred:

- `server/inference.ts` hardcodes `executionProviders: ['cpu']`.
- The installed `onnxruntime-node` native tree ships `libonnxruntime.so`,
  `libonnxruntime_providers_shared.so` and the napi binding — and **no**
  `libonnxruntime_providers_cuda.so`. The GPU is unreachable from that path.
- `public/ort/` is the browser WASM runtime, a different thing again.
- Mask2Former/OneFormer have no Optimum exporter config, their
  deformable-attention kernel needs replacing with a pure-PyTorch fallback to
  trace, and `post_process_panoptic_segmentation` — the step that actually makes
  the output panoptic — is post-graph Python.

Revisit ONNX only if this ever has to run in-browser.

## Model

Default: **`facebook/mask2former-swin-large-ade-panoptic`** (~216M params,
~3–4 GB VRAM at fp16).

ADE20K rather than COCO because ADE20K-150 *is* an indoor-room ontology — wall,
floor, ceiling, windowpane, door, bed, cabinet, sofa, table, chair, lamp,
curtain, shelf, desk, refrigerator, sink — which is the vocabulary this app's
domain model is already about. Swin-L rather than a smaller backbone because
there is **no ADE20K panoptic checkpoint below it**: the tiny/small/base ADE
variants are *semantic*-only, so downgrading means switching dataset, not
shrinking the model.

| alternative | why you might | why not by default |
|---|---|---|
| `facebook/mask2former-swin-base-coco-panoptic` | ~107M, better on small objects (laptop, mug, remote) | COCO stuff is merged buckets; weaker on architecture |
| `shi-labs/oneformer_ade20k_swin_large` | same ontology, +2–3 PQ, HF card says MIT | ~2× the latency |
| Grounding-DINO + SAM2 | open-vocabulary long tail | instance-only — cannot segment stuff, so it cannot replace this |
| YOLOv8/11-seg | fast | instance-only **and** AGPL-3.0, against this repo's commercial `LICENSE.md` |

⚠️ **Licence, unresolved.** Mask2Former's *code* is MIT (Swin MIT,
Deformable-DETR Apache-2.0), but the HF **checkpoint** is tagged
`license: other`. Recorded here the way ADR 0006 recorded GVHMR — stated, not
resolved. Review it before shipping anything that depends on the weights;
OneFormer's card says MIT if that review fails.

## Setup

Ubuntu splits `ensurepip` out, so `python3 -m venv` fails without
`apt install python3.N-venv` (sudo). [uv](https://astral.sh/uv) avoids that
entirely — a single user-local binary that can also fetch its own Python, which
matters here because torch/transformers do not yet support 3.14:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv --python 3.12 ~/.venvs/panoptic
uv pip install --python ~/.venvs/panoptic/bin/python torch torchvision transformers pillow numpy

# (where `python3 -m venv` already works, that plus pip install of the same
#  five packages is equivalent — uv is only avoiding the ensurepip problem.)

mkdir -p ~/panoptic && cp scripts/panoptic_worker.py scripts/_torch_device.py ~/panoptic/

export PANOPTIC_PYTHON=~/.venvs/panoptic/bin/python
export PANOPTIC_DIR=~/panoptic
# export PANOPTIC_MODEL=facebook/mask2former-swin-base-coco-panoptic   # optional
```

**`torchvision` is not optional**, even though the worker never imports it:
transformers' `AutoImageProcessor` requires it and fails at `from_pretrained()`
rather than at import, so leaving it out reads as a transformers bug rather than
a missing package.

The weights download on first run (HF cache). `.env` is **not** read by the
server — nothing passes `--env-file` — so export these into the shell that runs
`npm start` (`set -a; . ./.env; set +a` works).

Measured on an RTX 4080 Laptop (12 GB), Swin-L at fp16:

| step | time |
|---|---|
| model download (once, ~850 MB) | ~30 s |
| model load | ~4 s |
| inference | **~0.7 s/frame** |
| 8-frame session, end to end via the driver | **5.0 s** |

**cuDNN.** Some torch wheels ship a cuDNN whose sublibraries disagree with the
driver, and every conv dies with `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`
(seen on `torch 2.13.0+cu130`). The worker sets
`torch.backends.cudnn.enabled = False`, falling back to native CUDA kernels —
that is where the 0.7 s/frame above was measured, so chasing a matching wheel is
not worth it. Harmless when cuDNN is healthy.

Check it end to end without a GPU: point the driver at a session and confirm the
skip path reports the right remediation.

## ⚠️ The checkpoint has no stuff/thing split — supply one to enable things

Verified against `facebook/mask2former-swin-large-ade-panoptic` on real frames:
`config` carries **no `thing_ids`**, and `post_process_panoptic_segmentation`
returns only `{id, label_id, score, was_fused}`. `was_fused` is *not* a stuff
flag — it means a segment was merged from several queries, and with
`label_ids_to_fuse` unset (the default) transformers logs *"No instance will be
fused"* and it is `False` for **every** segment, wall and floor included.

So there is nothing in the model output to derive the split from, and guessing
from the label string would be exactly the hand-copied taxonomy this design
avoids. Without an operator-supplied list the worker reports `isThing: null`,
which the TS side treats as stuff — safe, but **no segment reaches
`thing_match`**. A real run on 8 keyframes: `thingCount: 0, stuffCount: 81`.

To enable things, supply the ADE20K-150 split from a source you trust:

```bash
python ~/panoptic/panoptic_worker.py ... --thing-labels ~/panoptic/ade20k-things.json
# ["chair", "swivel chair", "table", "desk", "cabinet", "lamp", "computer", ...]
```

Matching is case-insensitive on the label string. Getting that list from an
authoritative source (Detectron2's ADE20K panoptic metadata is one) rather than
from memory is the whole point — a wrong entry that marks `wall` a thing is the
failure mode the next section describes.

## Stuff is deliberately kept out of `thing_match`

`server/thing_match.ts` fuses detections into `Thing`s by label + world position
within `THING_MATCH_RADIUS_M` (0.75 m). That is right for a chair and wrong for
a wall: one physical wall is tens of metres of surface, so it would land as
dozens of "Thing"s at 0.75 m spacing.

That is not just untidy. `thing_match` **throws** at `MAX_THINGS_PER_WORLD`, and
nothing prunes `world.things` — `removeScanFromWorlds` filters scans,
editPatches, comments and jobs and never touches things. So piping stuff into
fusion could permanently wedge a world's JSON, and deleting the offending scan
would not undo it.

So the worker reports each segment's own `isThing` (from the checkpoint's label
metadata — never a table hand-copied into this repo), and
`splitPanopticSegments` keeps the two apart. A segment whose flag is **unknown
counts as stuff**: mis-filing a chair as stuff loses one visible detection,
while mis-filing a wall as a thing pushes toward that un-prunable ceiling.

## Lifting a segment to a world position

Segmentation answers *what*. A `Thing` is a label **and** a place — `thing_match`
fuses on position — so a second stage turns each thing segment into a 3-D point,
or says plainly that it cannot.

- Driver: [`server/panoptic/panoptic_lift.ts`](../../server/panoptic/panoptic_lift.ts)
- Policy (pure, shared): [`src/shared/panoptic_lift.ts`](../../src/shared/panoptic_lift.ts)

Inputs are all already on disk; the stage adds no capture requirement:

| file | supplies |
| --- | --- |
| `panoptic.segments.json` | label, score, `areaPx`, `centroidPx`, and (newer runs) `bboxPx` + `centroidOnMask` |
| `keyframes.jsonl` | capture pose + intrinsics, joined on `file` |
| `kf-*.jpg` | the pixel frame `centroidPx` is in (SOF header, not the metadata) |
| `scans/<base>.glb` | the point cloud the rays are cast against |

Outputs land beside the scan, matching splat-detect's `<base>.interactions.json`
precedent: `<base>.panoptic.detections.json` and
`<base>.panoptic-lift.manifest.json`.

### Why a separate stage from `panoptic-scan`

The segmenter is a GPU pass over up to 64 frames and its output is already on
disk. Re-tuning the depth policy must not mean re-running Mask2Former.

### Why not `resolver.ts`'s `raycastPointCloud`

That function (the live resolver's tier-3 fallback) takes every cloud point
inside a **fixed 0.25 m cylinder** around the ray and returns the most nearly
collinear one. Both halves were measured against this repo's own data on
`sess-a7e2f642` (5330-point cloud, 50 thing segments, 8 keyframes):

- it returned a confident position for **50 of 50** segments — on a scan whose
  own `session.json` says `coverageScore 0.0027` / `needs-rescan`;
- a 0.25 m cylinder is a 28° cone at 0.5 m and a 2.9° cone at 5 m, unrelated to
  how big the segment actually is;
- against a first-supported-surface depth the winner disagreed by more than
  1.0 m in **12 of 28** comparable segments (median 0.50 m, p90 4.63 m). e.g.
  `kf-00002` `bag`: 173 candidates spanning 0.50–3.68 m, winner 0.74 m, first
  supported surface 5.52 m.

So the lift replaces both halves: the cylinder becomes the segment's **own
angular footprint** — information a mask has and a VLM bbox never did — and
min-perpendicular becomes **the nearest depth cluster with enough support**,
i.e. the first opaque surface.

### Two fields the worker now reports, because they were measurable

Re-running the segmenter on this session (RTX 4080, 8 frames) showed the
area-derived footprint `atan(sqrt(areaPx/π) / fl_y)` was wrong in a way worth
fixing, so `panoptic_worker.py` now also emits `bboxPx` and `centroidOnMask` —
both free (the mask indices are already computed) and both optional downstream,
so an older `panoptic.segments.json` still lifts.

- **`bboxPx`** — the area disc assumes the mask is a disc. 10 of the 50 thing
  segments have a bbox aspect over 2.5, and the worst offenders were the
  segments that mattered most: all three `curtain` masks are ~95 × 435 px, an
  area radius of 92 px against a 46 px inscribed radius. **The cone used for the
  curtains was twice as wide as the curtain.** The lift now prefers
  `min(w, h) / 2` when a bbox is present — it can under-collect on a compact
  object, which shows up honestly as `unsupported`, whereas over-collecting
  silently mixes background into the cluster.
- **`centroidOnMask`** — the mean of a mask's pixel coordinates is not a point
  of the mask when the mask is concave or split. 2 of 50 here, both `bed`, whose
  U-shaped masks put the centroid in the notch so the ray goes past the bed
  entirely. That is a *real surface at a confidently wrong place*, the exact
  failure this stage exists to prevent, so it abstains.

The effect on the same session, same cloud, same policy — only the footprint and
the centroid check changed:

| | confident | median confidence | `curtain` cross-frame agreement |
| --- | --- | --- | --- |
| area disc | 6 | 0.299 | 0.138 / 0.166 / 0.297 m |
| bbox + centroid check | 4 | 0.388 | 0.143 m |

Fewer positions, better ones. The curtain's cone fell from 84 points to 25 while
its cluster share rose to 96 %, its depth moved 0.93 → 0.90 m, and the 1.30 m
outlier from `kf-00004` dropped out rather than being averaged in.

`resolver.ts` keeps its copy for now (it is the live browser resolver and is
owned by other work). When it is free, its tier 3 should call `liftSegment`
rather than keep a second depth policy.

### Every position carries a confidence, and "I don't know" is an answer

A lift is undetermined — `worldPos: null` plus a `reason` — on any of:

| reason | meaning |
| --- | --- |
| `no-pose` | the frame carries no capture pose (see below) |
| `centroid-off-mask` | the centroid is not on its own mask, so the ray misses the object |
| `no-geometry` | no cloud point in the segment's cone at all |
| `unsupported` | no depth cluster reached `MIN_CLUSTER_POINTS` (12), or the winner holds under 30 % of the cone |
| `depth-ambiguous` | the nearest supported cluster is smeared wider than 0.35 m |
| `multi-surface` | two comparably-supported surfaces more than 1.0 m apart |
| `low-confidence` | determinate, but under `MIN_CONFIDENCE` |

Confidence is a product of four factors, each also a hard gate so a single bad
one cannot be averaged away: the segmenter's own score, cluster support (density
× share of the cone), depth sharpness, and a range penalty encoding the parallax
problem.

Measured on `sess-a7e2f642` (50 thing segments), the whole stage runs in 32 ms
and reports:

```
confident 4  low-confidence 7  unsupported 30  no-geometry 5  depth-ambiguous 2  centroid-off-mask 2
```

An 8 % pass rate is the scan telling the truth about itself. The independent
check available here: the two surviving `curtain` lifts come from different
keyframes and land **0.143 m** apart — well inside `THING_MATCH_RADIUS_M`
(0.75 m), so two rays from two cameras fuse into one Thing rather than two.

The confidence floor sits at **0.20**. On the one population available the
eleven segments clearing every structural gate score

```
0.073 0.074 0.120 0.142 0.154 0.156 0.157 | 0.243 0.312 0.464 0.539
```

— a dense band of seven up to 0.157, then a gap to 0.243. Any threshold inside
that gap gives the identical 4/7 split, so the exact value is not load-bearing.
There is a wider gap higher up (0.312 → 0.464) and it is deliberately **not**
used: chasing the largest gap in eleven samples would set the floor at 0.40 and
return two positions from a 50-segment scan, which is fitting a threshold to
noise. Stated plainly, n = 11 from one sparse session is a weak basis and 0.20
is a policy choice placed at a visible break, not a measured error rate. Every
rejected segment's confidence is written to the sidecar, so the data to re-fit
it is always on disk.

### The gate is also what protects `MAX_THINGS_PER_WORLD`

50 thing segments from 8 frames is 6.25/frame; at the shipped
`DEFAULT_MAX_FRAMES` of 64 that is ~400 segments per session before fusion.
Segments landing at scattered wrong depths do not fuse at 0.75 m, so each
becomes a new Thing — against a ceiling that **throws** and that nothing prunes
(see above). At the measured pass rate this session yields ~32 candidate
positions instead of ~400.

### A no-parallax dome must not produce confident nonsense

A gimbal dome rotates in place, so every ray shares an origin and there is no
baseline anywhere in the capture. This session's real translation is a max
pairwise camera baseline of 0.881 m over 17 keyframes (mean 0.452 m, most of it
vertical). A dome gives zero. The single-view cluster policy handles that
correctly by abstaining: a dome scan will legitimately drive the undetermined
count toward 100 %, and **that is the system working, not a regression**.

Triangulation across frames is deliberately not shipped here. Cross-frame
correspondence between same-label masks is unsolved (`kf-00006` alone has four
`swivel chair` and four `cabinet` segments), and a wrong correspondence produces
a *confident wrong* depth — the exact failure being fixed. The confidence value
is a product, so a multi-view agreement term can be multiplied in later without
reshaping anything.

### Capture poses only — no solved-pose fallback

`buildBrushDataset` falls back per frame from a capture pose to
`readSolvedPoses` (COLMAP / LingBot-Map). That is right for a trainer, which
only needs cameras consistent with each other, and wrong here: monocular SfM
reconstructs only up to an unknown scale at an arbitrary origin — the reason
`SplatAlignManifest` exists. A position lifted from a COLMAP pose against the
capture-frame cloud is in a different space *and a different unit*, and
`thing_match` would fuse it against real metres at 0.75 m. A frame with no
capture pose is an honest `no-pose`.

### The cloud is read through the node hierarchy

Measured, not assumed. In the raw autosave GLB the `point-cloud` node and both
its ancestors are identity, so reading `POSITION` straight out happens to work —
but in an **optimized** scan it does not: `quantize()` puts the dequantization on
the node, and in `1787789921923_home-00-studio-a.opt.glb` the `point-cloud` node
carries scale 2.470 and translation (0, 1.300, 0). Reading raw there would place
every point 2.47× out from the origin, silently and plausibly. Only `POINTS`
primitives are read — the `camera-path` line strip and the triangle meshes for
the floor plane and previous detection boxes are skipped, because a detection box
is an *output* of an earlier stage and letting it back in as "surface" would let
this stage confirm its own guesses.

### Why a sidecar and not the scan's meta JSON

Ingest rewrites the whole `<base>.json` meta sidecar with an **unawaited**
`Deno.writeTextFile`, outside the per-slug world lock ADR 0004 establishes. A
stage merging into that file would be last-write-wins against an ingest still in
flight. A separate file per producer means no merge, no race, and a re-lift is an
idempotent whole-file overwrite.

## Status

Landed: the segmentation driver, the segment policy, the worker, the
`panoptic-scan` `WorldJob` type (extending `WorldJob`, not a new queue), and 14
tests covering every guard and the read-back with no model present.

Landed here: the lift — `src/shared/panoptic_lift.ts` (pure geometry +
confidence, Deno- and `three`-free per ADR 0002), `server/panoptic/panoptic_lift.ts`
(the driver), `PanopticLiftManifest` extending `PipelineManifestBase` in its
canonical home, the worker's `bboxPx`/`centroidOnMask` fields, and 46 tests
(26 Node on the shared policy, 17 Deno on the driver, 3 more on the segment
policy) that run with no model, no GPU and no GLB.

**Not yet wired**, and deliberately out of this change's scope because
`server/main.ts` is owned by other work in flight:

1. a `'panoptic-lift'` member on `WorldJobType` plus `WORLD_JOB_TYPES`,
   `jobResultFor` and `applyCompletedJobToWorld` entries;
2. a `_runPanopticLiftJob` modelled on `_runPanopticScanJob`, passing
   `sessionDir`, the scan's GLB path, and `<base>.panoptic.detections.json`;
3. an extension of `detectionLikesForWorld` to gather from that sidecar as well
   as the meta sidecar — keeping it the single aggregation point into
   `runThingCorrespondence` rather than adding a second path (ADR 0001), with
   `targetId` set to `` `${scan.scanId}:panoptic:${file}:${segmentIndex}` `` so a
   re-lift updates the same `ThingObservation` via the natural-key path instead
   of duplicating it.

Worth noting for (3): `splat-detect` has the identical gap. It lands a
`<base>.interactions.json` full of 3-D object boxes next to the scan and nothing
reads it, so those boxes never reach Things either. The same extension point
serves both.
