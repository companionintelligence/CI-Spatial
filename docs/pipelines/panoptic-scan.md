# Panoptic scan

Segments **every** pixel of a session's keyframes into discrete objects
("things": chair, table, lamp) and room surfaces ("stuff": wall, floor,
ceiling), so a scan can answer "what is in this room" rather than only "what did
the detector happen to spot".

A second stage then lifts each object segment to a 3-D world position — or says
which ones it cannot place, and why. See
[Lifting a segment to a world position](#lifting-a-segment-to-a-world-position).

Read [`thingCount` is a count of sightings, not of
objects](#thingcount-is-a-count-of-sightings-not-of-objects) before quoting a
number from this stage: it counts one object once per keyframe it appears in.

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
`thing_match`**. A real run on the 17-keyframe phone capture with no list:
`thingCount: 0, stuffCount: 169, thingLabelsUsed: false`.

To enable things, supply the ADE20K-150 split from a source you trust:

```bash
node scripts/fetch-ade20k-things.mjs        # → server/panoptic/ade20k-things.json
python ~/panoptic/panoptic_worker.py ... --thing-labels ~/panoptic/ade20k-things.json
```

### Match by class id, not by label string

The generated list carries three things: `thingIds` (the 100 ADE20K-150 classes
flagged `isthing=1` upstream), `names` (all 150 upstream names) and `things`
(the same 100 by name, plus each name's leading synonym). **`thingIds` is the
one that decides**, and that is not a tidiness preference — matching by name was
wrong on eight classes:

| id | Mask2Former repo | checkpoint `id2label` |
| --- | --- | --- |
| 8 | `window ` | `windowpane` |
| 37 | `tub` | `bathtub` |
| 38 | `rail` | `railing` |
| 87 | `street lamp` | `streetlight` |
| 89 | `tv` | `television receiver` |
| 90 | `plane` | `airplane` |
| 92 | `clothes` | `apparel` |
| 138 | `trash can` | `ashcan` |

All eight are `isthing=1`, so a name compare filed every one of them as a room
surface. Measured on the 17-frame phone capture: **111 object sightings by name,
119 by class id** — the eight recovered are 7 × `windowpane` and 1 × `ashcan`,
a window and a bin that were being reported as wall. Overall 140 of the
checkpoint's 150 names agree with the repo's; the other two disagreements
(`pool`/`swimming pool`, `falls`/`waterfall`) are `isthing=0` either way.

An id is only meaningful within one taxonomy — id 8 is `windowpane` in ADE20K
and something else entirely in COCO — so the worker *proves* the checkpoint is
that taxonomy before trusting one: same class count, and ≥ 2/3 of names
matching. The supported checkpoints score 150 labels / 140 agree
(`…-ade-panoptic`, `…-ade-semantic`) against 133 (`…-coco-panoptic`) and 19
(`…-cityscapes-panoptic`), which fail on size before the name check runs — so
the threshold sits in an empty gap rather than being fitted to anything.

When the proof fails, matching falls back to the label strings and **says so**:
the worker prints `thing-labels: matched by label-string — class ids NOT used: …`,
writes `"thingSource": "label-string"` at the top of `panoptic.segments.json`,
and the driver logs a `[panoptic]` warning naming the fix. That matters because
`thingLabelsUsed: true` on the manifest is satisfied by the wrong path too: it
only says a list was *found*.

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

## `thingCount` is a count of sightings, not of objects

One physical object appears in many keyframes as many segments, and **nothing
in this stage merges them**. `thingCount: 38` on the 48-frame fixture is 38
sightings; 30 of them are the label `step`, which is one ledge seen thirty
times. Read as objects it overstates that room by about an order of magnitude.

Merging properly needs each sighting's world position, and that is exactly what
the lift cannot supply on these captures — a video keyframe carries no metric
capture pose (0 of 48) and solved SfM poses are scale-free, so the lift places
nothing (see [the measurement below](#measured-on-a-video-ingest-capture-0-of-29-placed-for-two-structural-reasons)).
Merging on 2-D evidence instead — label plus bbox overlap between neighbouring
frames — was **deliberately not done**: it cannot re-identify an object that
leaves the frame and is revisited, so it would replace one honest over-count
with an authoritative-looking number wrong by an unknown factor.

What *is* provable with no 3-D at all: if a single frame shows four `cabinet`
segments, the room holds at least four cabinets. `summarizePanopticSegments`
sums that per-frame maximum over labels into `distinctObjectsAtLeast`, and the
driver logs it on every run:

```
[panoptic] …: 38 object sighting(s) of 6 label(s) over 33 frame(s) —
             at least 8 distinct object(s), not 38; step×30, table×3, towel×2, …
```

It is a lower bound on distinct *segment identities*. It is only a bound on
objects where the label is right — on the synthetic fixture four of the eight
are `towel`, `bench`, `door` and `flag` read off untextured noise.

### Measured label distributions

Three sessions, current code, `--min-segment-pixels 1500`. "max/frame" is the
most sightings of that label in any one frame — the per-label lower bound.

#### `sess-video-20260830-054518` — 48 frames, synthetic room (38 object sightings, ≥ 8 objects)

| sightings | max/frame | kind | label | score min–max |
| ---: | ---: | --- | --- | --- |
| 47 | 1 | stuff | `floor` | 0.92–1.00 |
| 46 | 1 | stuff | `wall` | 0.75–1.00 |
| 30 | 1 | stuff | `ceiling` | 0.61–1.00 |
| 30 | 2 | thing | `step` | 0.51–0.95 |
| 10 | 1 | stuff | `rug` | 0.53–0.94 |
| 3 | 2 | stuff | `sky` | 0.61–0.99 |
| 3 | 2 | thing | `table` | 0.50–0.73 |
| 2 | 1 | thing | `towel` | 0.70–0.99 |
| 1 | 1 | thing | `bench` | 0.59–0.59 |
| 1 | 1 | thing | `cabinet` | 0.63–0.63 |
| 1 | 1 | thing | `door` | 0.92–0.92 |

#### `sess-video-20260830-033839` — 32 frames, same synthetic room (30 object sightings, ≥ 9 objects)

| sightings | max/frame | kind | label | score min–max |
| ---: | ---: | --- | --- | --- |
| 31 | 1 | stuff | `wall` | 0.82–1.00 |
| 30 | 1 | stuff | `floor` | 0.96–1.00 |
| 21 | 2 | thing | `step` | 0.51–0.95 |
| 20 | 1 | stuff | `ceiling` | 0.65–1.00 |
| 7 | 1 | stuff | `rug` | 0.56–0.92 |
| 3 | 1 | thing | `table` | 0.60–0.82 |
| 1 | 1 | thing | `bench` | 0.57–0.57 |
| 1 | 1 | thing | `chair` | 0.67–0.67 |
| 1 | 1 | thing | `door` | 0.57–0.57 |
| 1 | 1 | thing | `flag` | 0.53–0.53 |
| 1 | 1 | stuff | `sky` | 1.00–1.00 |
| 1 | 1 | thing | `towel` | 0.99–0.99 |
| 1 | 1 | thing | `windowpane` | 0.72–0.72 |

#### `sess-a7e2f642-…` — 17 frames, real phone capture (119 object sightings, ≥ 29 objects)

| sightings | max/frame | kind | label | score min–max |
| ---: | ---: | --- | --- | --- |
| 24 | 4 | thing | `cabinet` | 0.52–0.99 |
| 17 | 1 | stuff | `floor` | 0.99–1.00 |
| 17 | 1 | stuff | `wall` | 0.96–1.00 |
| 15 | 4 | thing | `swivel chair` | 0.58–0.99 |
| 11 | 1 | thing | `bag` | 0.72–0.96 |
| 11 | 1 | stuff | `ceiling` | 0.93–1.00 |
| 11 | 2 | thing | `door` | 0.59–0.91 |
| 10 | 2 | thing | `desk` | 0.65–0.98 |
| 7 | 2 | thing | `box` | 0.53–0.83 |
| 7 | 1 | thing | `curtain` | 0.79–0.97 |
| 7 | 1 | thing | `windowpane` | 0.63–0.97 |
| 6 | 2 | thing | `chair` | 0.54–0.93 |
| 5 | 1 | thing | `bed ` | 0.72–0.99 |
| 4 | 1 | stuff | `crt screen` | 0.55–0.90 |
| 4 | 1 | thing | `table` | 0.54–0.91 |
| 3 | 1 | thing | `computer` | 0.55–0.88 |
| 3 | 1 | thing | `person` | 0.68–0.83 |
| 1 | 1 | thing | `ashcan` | 0.52–0.52 |
| 1 | 1 | stuff | `blind` | 0.83–0.83 |
| 1 | 1 | thing | `column` | 0.94–0.94 |
| 1 | 1 | thing | `mirror` | 0.79–0.79 |
| 1 | 1 | thing | `monitor` | 0.53–0.53 |
| 1 | 1 | thing | `seat` | 0.51–0.51 |
| 1 | 1 | thing | `signboard` | 0.56–0.56 |

The two synthetic sessions are a grey box with a floating cube and a ledge: good
geometry, almost no semantics. The ledge takes `step` for 30 of 38 and 21 of 30
object sightings, and `towel` / `bench` / `flag` / `door` are read off untextured
noise. The real capture is the opposite — 19 labels, most of them plausible for
the room, and the misreads (`person`, `column`, `signboard`) are singletons.
**Use the phone capture, not the fixtures, to judge anything semantic.**

### Why there is no confidence floor and no higher area floor

Both were considered against the distributions above and both were rejected,
because neither separates the wrong labels from the right ones:

- **Confidence.** Mask2Former's `post_process_panoptic_segmentation` already
  drops everything below 0.5, so the observed minimum over all three sessions is
  0.504 — a 0.5 floor is a no-op, and anything above it is fitted to these three
  captures. The ranking also runs the wrong way: the synthetic room's
  highest-scoring segments are its wrong ones (`sky` 1.00 indoors, `towel` 0.99,
  `door` 0.92 in a room with no door), while a real cabinet on the phone capture
  scores 0.52.
- **Area.** On the real capture the *correct* things are the small ones —
  `swivel chair` median 5,370 px, `box` 3,207 px, `monitor` 2,343 px — while the
  synthetic room's misreads are large (`bench` 131,461 px, `door` 234,644 px).
  Any floor high enough to cut the misreads deletes most of the real capture's
  true objects. `MIN_SEGMENT_PIXELS` stays at 1500 (0.22 % of a 720×960 phone
  keyframe, 0.13 % of a 1440×810 video-ingest one), which exists to drop
  boundary slivers with meaningless centroids — not to judge labels.

A filter that deletes true positives and keeps confident false ones is not a
quality gate. What a misread needs is a second view of the same surface (the
lift), not a threshold tuned against two fixtures.

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
| `out-of-range` | the cone hit geometry, but **every** point of it was outside `[MIN_DEPTH_M, MAX_DEPTH_M]` |
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

### Measured on a video-ingest capture: 0 of 29 placed, for two structural reasons

The numbers above come from `sess-a7e2f642`, a phone room-scan with capture
poses. The lift was then run against a **video-ingest** session, which is the
source the reconstruction pipelines actually feed today, and it placed nothing.
Both causes are structural, neither is a threshold, and neither was legible in
the manifest before this pass.

Session `sess-video-20260830-033839`: 32 keyframes, COLMAP solved with all 32
images registered, `colmap.point-cloud.ply` 9362 points, `colmap.poses.json`
with solved intrinsics (`fx = fy = 635.72`, `cx = 720`, `cy = 405`, 1440×810).
Re-segmented with the current worker: **29 thing segments**, 90 stuff, 0
dropped; all 29 carry `bboxPx` and `centroidOnMask`, and none is off-mask.

**1. A video-ingest session has no capture pose at all — not one.** Its
`keyframes.jsonl` records are `{index, file, timestamp}` and nothing more:
0 of 32 frames here, 0 of 48 on `sess-video-20260830-054518`. So the driver's
capture-poses-only rule (below) refuses every segment, and the real run is:

```
segmentCount 29  confidentCount 0  undeterminedCount 29  reasons { "no-pose": 29 }
```

That is correct behaviour, not a bug — but "29 × no-pose" reads like a broken
filename join, so the manifest now carries a `remediation` naming the cause and
distinguishing *"this session has SfM poses that are deliberately not used"*
from *"nothing solved this session at all"*.

**2. Handed the solver's own poses, the metre depth window rejects 100 % of the
geometry.** COLMAP poses and `colmap.point-cloud.ply` *are* in one frame — the
gravity alignment rotates images and points together, and `openCvW2cToC2w` only
swaps the camera's local axes — so that pairing is self-consistent and was worth
measuring. It yields:

```
reasons { "out-of-range": 23, "unsupported": 6 }   placed 0   medianConfidence n/a
```

Before this pass those 23 read `no-geometry`, which says "the cloud is too
sparse". It is not. Those same 23 cones hold **1 to 605 points each (median
109)** at depths of **3.6 to 18.1** along the ray, and `[0.5, 5.0]` threw all of
them away. The reconstruction spans 18.93 × 11.56 × 21.23 units with a max
pairwise camera baseline of 13.6 (mean 4.36) for a small room — a monocular SfM
world is scale-free, so its unit is not the metre and a metre window means
nothing against it. Hence the new `out-of-range` reason and the `nearestDepthM`
diagnostic, which names where the geometry actually was.

**The confidence model was not exercised, and nothing here re-tunes it.** Zero
segments reached `liftConfidence` on either path, so this data says nothing
about whether 0.20 separates good placements from bad — it only says the two
gates *upstream* of confidence are what bind on a video ingest. Moving
`MIN_CONFIDENCE` would change nothing on this session and would be fitting to
absent data.

Two further cautions about this capture, recorded so nobody reads more into the
numbers than they support:

- **It is a synthetic scene.** The frames are a procedurally-generated grey box
  room with one floating cube and a ledge. Mask2Former labels the ledge `step`
  (21 of 29 segments here, 30 of 38 on `-054518`) and produces `bench`, `towel`,
  `flag`, `door`, `chair` on untextured noise. The label population is not a
  room's contents, so no per-label conclusion is available from it.
- **The whole population is effectively one object seen 21 times.** Even had the
  window admitted it, that is not a distribution to fit a threshold to.

What would actually make the confidence model arguable: a capture that has
capture poses *and* a dense metric cloud, i.e. a phone room-scan run through
reconstruction, so that a real population reaches `liftConfidence` and the
cross-frame agreement check (two rays, two cameras, one Thing) can be run at
scale rather than on the single `curtain` pair available today.

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

The measurement above sharpens what that rule is really protecting, because the
obvious objection is that COLMAP's poses and COLMAP's *own* seed cloud are in
one frame, so pairing those two would be self-consistent. They are — and it
still does not help, which is the useful part: run that way, the session places
0 of 29 and reports `out-of-range` on 23, because self-consistent is not the
same as metric. `thing_match` fuses at 0.75 **m** and `MIN_DEPTH_M`/`MAX_DEPTH_M`
are **metres**; a scale-free reconstruction satisfies neither. So the rule is not
"capture poses are better" but **"poses and cloud must be in one frame *and*
that frame must be metres"**, and a solved-pose path only becomes correct once a
scale is established (the job `SplatAlignManifest` exists for). Until then a
solved-pose fallback would be a way to get plausible numbers in the wrong unit,
which is worse than `no-pose`.

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

Landed since, from running all three sessions above end to end: the class-id
thing/stuff match and its taxonomy proof (`thingIds`/`names` in the generated
list, `thingSource` in `panoptic.segments.json`, the fall-back warning),
`summarizePanopticSegments`/`formatSegmentSummary` and the per-run `[panoptic]`
log line that states the counts as sightings with a distinct-object lower bound,
and 20 more Deno tests — 34 in `tests/unit/deno/panoptic_scan.test.ts`, still
with no model, venv or GPU present.

Landed here: the lift — `src/shared/panoptic_lift.ts` (pure geometry +
confidence, Deno- and `three`-free per ADR 0002), `server/panoptic/panoptic_lift.ts`
(the driver), `PanopticLiftManifest` extending `PipelineManifestBase` in its
canonical home, the worker's `bboxPx`/`centroidOnMask` fields, and 50 tests
(30 Node on the shared policy, 20 Deno on the driver) that run with no model, no
GPU and no GLB.

Landed since: the `'panoptic-lift'` `WorldJob` type and `_runPanopticLiftJob`
(`server/main.ts`), and — from the measurement above — the `out-of-range` reason,
the `nearestDepthM` diagnostic, and `liftRemediation`, which puts a cause on the
manifest of a run that placed nothing.

**Known gaps**, all outside this file's own modules:

1. **A video-ingest capture cannot be lifted at all today.** It has no capture
   pose (measured: 0 of 32 and 0 of 48) and no metric cloud, and the two are one
   problem: what the lift needs is poses and a cloud in one frame *in metres*.
   Establishing a metric scale for a monocular reconstruction is the missing
   piece, not a change to this stage.
2. **`_runPanopticLiftJob` discards `result.remediation` on the run that most
   needs it.** `server/main.ts:3499` answers a zero-placed `ok` run with a
   hardcoded *"a capture that rotates in place has almost no parallax — walk the
   room to give the scan a baseline"*. On both sessions measured that sentence is
   simply false (the captures do walk; a video ingest has 13.6 units of camera
   baseline). The `skipped` branch four lines below already forwards
   `result.remediation`; the `ok` branch should do the same.
3. **The scan manifest has nowhere to put the honest count.** `thingCount` /
   `stuffCount` are sightings, and `PanopticScanManifest` in
   `src/world/manifests.ts` carries no field for `distinctObjectsAtLeast` or for
   `thingSource` — so both currently reach an operator only through the
   `[panoptic]` log line, not through the job artifact the editor shows. Three
   fields on that interface (and their pass-through in `_runPanopticScanJob`)
   would close it; the counting and the wording already exist and are tested in
   `panoptic_segments.ts`.
4. **`detectionLikesForWorld` does not read the detections sidecar.** It remains
   the single aggregation point into `runThingCorrespondence` (ADR 0001), and it
   should gather `<base>.panoptic.detections.json` with `targetId` set to
   `` `${scan.scanId}:panoptic:${file}:${segmentIndex}` `` so a re-lift updates
   the same `ThingObservation` rather than duplicating it. `splat-detect` has the
   identical gap — its `<base>.interactions.json` boxes never reach Things
   either — and the same extension point serves both.
