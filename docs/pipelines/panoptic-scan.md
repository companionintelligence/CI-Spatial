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

```bash
python3 -m venv ~/.venvs/panoptic
~/.venvs/panoptic/bin/pip install torch transformers pillow numpy
mkdir -p ~/panoptic && cp scripts/panoptic_worker.py ~/panoptic/

export PANOPTIC_PYTHON=~/.venvs/panoptic/bin/python
export PANOPTIC_DIR=~/panoptic
# export PANOPTIC_MODEL=facebook/mask2former-swin-base-coco-panoptic   # optional
```

The weights download on first run (HF cache). `.env` is **not** read by the
server — nothing passes `--env-file` — so export these into the shell that runs
`npm start` (`set -a; . ./.env; set +a` works).

Check it end to end without a GPU: point the driver at a session and confirm the
skip path reports the right remediation.

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

Landed: the driver, the segment policy, the worker, and 14 tests that cover
every guard and the read-back with no model present.

Not yet landed:

- The `panoptic-scan` `WorldJob` type (extends `WorldJob` — not a new queue).
- Lifting a 2-D mask centroid to a 3-D world position. This needs real camera
  intrinsics; `colmap-poses` now carries COLMAP's solved `fx/fy/cx/cy` in
  `colmap.poses.json`, which is the prerequisite that was missing.
- Feeding the lifted things into `thing_match`.
