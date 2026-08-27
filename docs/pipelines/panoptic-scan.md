# Panoptic scan

Segments **every** pixel of a session's keyframes into discrete objects
("things": chair, table, lamp) and room surfaces ("stuff": wall, floor,
ceiling), so a scan can answer "what is in this room" rather than only "what did
the detector happen to spot".

- Driver: [`server/panoptic/panoptic_scan.ts`](../../server/panoptic/panoptic_scan.ts)
- Policy: [`server/panoptic/panoptic_segments.ts`](../../server/panoptic/panoptic_segments.ts)
- Worker: [`scripts/panoptic_worker.py`](../../scripts/panoptic_worker.py)

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

mkdir -p ~/panoptic && cp scripts/panoptic_worker.py ~/panoptic/

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

## Status

Landed: the driver, the segment policy, the worker, the `panoptic-scan`
`WorldJob` type (extending `WorldJob`, not a new queue), and 14 tests covering
every guard and the read-back with no model present.

Not yet landed — **lifting a 2-D mask centroid to a 3-D world position**, and
feeding the result into `thing_match`.

That is a real design question rather than remaining typing.
`src/spatial/resolver.ts` already does exactly this lifting for VLM detections
(bbox centroid → hit-test against the SLAM map → point-cloud raycast fallback,
with depth bounds learned from real failures), and reusing it is obviously right
per ADR 0001 — but it is **client-side**: it needs a live `ARProvider` and
`three`, while panoptic runs offline on stored keyframes. So either the resolver
grows a headless path over a stored point cloud, or the lifting moves to capture
time. Camera intrinsics are no longer the blocker: `colmap-poses` now carries
COLMAP's solved `fx/fy/cx/cy` in `colmap.poses.json`.
