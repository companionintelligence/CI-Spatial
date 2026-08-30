#!/usr/bin/env python3
"""Panoptic segmentation over a capture session's keyframes.

Driven by `server/panoptic/panoptic_scan.ts`, which owns every policy decision
this script does NOT make: which frames, what counts as too small, and what
happens to the output. This side only runs the model and reports what it saw.

Contract with the driver (stable — the TS tests assert on it):

    panoptic_worker.py --session-dir DIR --out FILE.json
                       --model HF_ID --max-frames N --min-segment-pixels N

    exit 0 + writes FILE.json   ran; see `frames`
    exit non-zero + stderr      failed; the driver keeps the stderr tail

    {
      "model": "facebook/mask2former-swin-large-ade-panoptic",
      "thingSource": "class-id",
      "frames": [
        {"file": "kf-00000.jpg",
         "segments": [
           {"label": "chair", "isThing": true, "score": 0.94,
            "areaPx": 20134, "centroidPx": [361.2, 480.9]}
         ]}
      ]
    }

`isThing` comes from the model's own label metadata, never from a table written
here. Which of ADE20K's 150 classes are "stuff" is the checkpoint's business; a
hand-copied table would be a second, silently-wrong copy of it — and the split
matters, because the TS side feeds things into `thing_match` and deliberately
does not feed stuff (see panoptic_segments.ts for why that would be harmful).

`thingSource` says HOW the split was decided — "class-id", "label-string" or
"none" — because those are not equally trustworthy and used to be
indistinguishable from outside. See `resolve_thing_split` below.

Setup: see docs/pipelines/panoptic-scan.md.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Keyframe names the streamer writes. Matching here as well as in the driver is
# deliberate: this script is runnable by hand for debugging, and a stray JPEG in
# a session dir should not silently become a "frame" in the output.
KEYFRAME_RE = re.compile(r"^kf-\d+\.(jpe?g|png)$", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session-dir", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--model", required=True)
    p.add_argument("--max-frames", type=int, default=64)
    p.add_argument("--min-segment-pixels", type=int, default=1500)
    p.add_argument(
        "--thing-labels",
        default=None,
        type=Path,
        help=(
            "Which classes are discrete objects: either the generated object "
            "(thingIds + names + things — matched by class id, which survives a "
            "checkpoint renaming a class) or a bare JSON array of label strings. "
            "Without it every segment is reported isThing=null, which the TS side "
            "treats as stuff — safe, but nothing reaches thing_match."
        ),
    )
    p.add_argument(
        "--device",
        default=None,
        help=(
            "torch device: auto (default), cpu, cuda, cuda:N, mps. auto prefers "
            "CUDA/ROCm, then Apple MPS, then cpu. Anything else is passed to "
            "torch unvalidated. See scripts/_torch_device.py."
        ),
    )
    return p.parse_args()


def _import_device_resolver():
    """Load the shared resolver, tolerating the copy-one-file deployment.

    docs/pipelines/panoptic-scan.md installs this worker with
    `cp scripts/panoptic_worker.py ~/panoptic/`, so `_torch_device.py` lives
    next to it rather than on an installed package path. `python worker.py`
    already puts that directory on sys.path, but `PANOPTIC_DIR` can be reached
    other ways, so fall back to an explicit sibling lookup before giving up.
    """
    try:
        from _torch_device import resolve_torch_device
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from _torch_device import resolve_torch_device
    return resolve_torch_device


def keyframes(session_dir: Path, limit: int) -> list[Path]:
    names = sorted(p for p in session_dir.iterdir() if p.is_file() and KEYFRAME_RE.match(p.name))
    return names[:limit]


def label_aliases(name: str) -> set[str]:
    """Every string a checkpoint might plausibly use for one taxonomy entry.

    ADE20K names carry comma-separated synonyms ("computer, computing machine,
    ..."), and a checkpoint's id2label may use either the whole string or the
    leading one.
    """
    n = name.strip().lower()
    head = n.split(",")[0].strip()
    return {n, head} - {""}


# How much of a checkpoint's vocabulary must match the supplied taxonomy's own
# names before its class *ids* are trusted.
#
# Measured, on the checkpoints this driver can actually be pointed at:
#
#   facebook/mask2former-swin-large-ade-panoptic    150 labels, 140/150 agree (93%)
#   facebook/mask2former-swin-large-ade-semantic    150 labels, same ADE20K-150 vocabulary
#   facebook/mask2former-swin-base-coco-panoptic    133 labels — different size, rejected first
#   facebook/mask2former-swin-large-cityscapes-...   19 labels — different size, rejected first
#
# So the two outcomes are 93% and "wrong size", with nothing in between: any
# threshold inside that gap behaves identically, and 2/3 leaves room for upstream
# to rename a few more synonyms without silently downgrading the split. It is NOT
# tuned to make a number look good — 93% is what the one supported checkpoint
# scores, and all ten disagreements are documented synonyms of the same class
# (see scripts/fetch-ade20k-things.mjs).
TAXONOMY_AGREEMENT = 2 / 3


def resolve_thing_split(raw, id2label: dict[int, str]):
    """Decide how to tell things from stuff, and report which way it went.

    Returns `(thing_ids, thing_labels, source, note)`. `source` is one of
    "class-id" / "label-string" / "none" and lands in the output JSON, because
    the three are not equally trustworthy and used to be indistinguishable from
    outside: a name compare against this checkpoint silently files eight
    isthing=1 ADE20K classes as room surface (windowpane, bathtub, railing,
    streetlight, television receiver, airplane, apparel, ashcan) because the
    Mask2Former repo and the HF checkpoint name them differently. Class ids are
    exact — but only once the checkpoint is *shown* to be that taxonomy, since
    id 8 is `windowpane` in ADE20K and something else entirely in COCO.
    """
    labels = raw.get("things", raw) if isinstance(raw, dict) else raw
    thing_labels = {str(x).strip().lower() for x in labels}
    ids = raw.get("thingIds") if isinstance(raw, dict) else None
    names = raw.get("names") if isinstance(raw, dict) else None

    if not ids or not names:
        return None, thing_labels, "label-string", (
            f"{len(thing_labels)} label string(s) supplied; the list carries no class ids, "
            "so a checkpoint that renames a class files it as room surface — "
            "re-run scripts/fetch-ade20k-things.mjs to get ids"
        )

    names = {int(k): str(v) for k, v in names.items()}
    agree = sum(1 for i, lab in id2label.items() if str(lab).strip().lower() in label_aliases(names.get(i, "")))
    if len(names) != len(id2label) or agree < TAXONOMY_AGREEMENT * max(len(id2label), 1):
        return None, thing_labels, "label-string", (
            f"class ids NOT used: checkpoint has {len(id2label)} classes against {len(names)} "
            f"in the list, and {agree} name(s) agree — this is not that taxonomy, so the split "
            f"falls back to matching {len(thing_labels)} label string(s) and may be wrong"
        )

    return {int(i) for i in ids}, thing_labels, "class-id", (
        f"{len(ids)} thing class id(s); taxonomy confirmed by {agree}/{len(id2label)} label names"
    )


def main() -> int:
    args = parse_args()

    # Imported inside main so `--help` works in a venv that has not finished
    # installing, and so an import failure is a clean stderr message rather than
    # a traceback before argument parsing.
    # torchvision is not imported here, but transformers' AutoImageProcessor
    # requires it and fails at from_pretrained() rather than at import time —
    # so name it explicitly in the hint below, or the error reads as a
    # transformers bug rather than a missing install.
    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation
    except ImportError as exc:  # pragma: no cover - environment-dependent
        print(f"panoptic worker: missing dependency: {exc}", file=sys.stderr)
        print("install with: pip install torch torchvision transformers pillow numpy", file=sys.stderr)
        return 2

    try:
        resolve_torch_device = _import_device_resolver()
    except ImportError as exc:  # pragma: no cover - deployment-dependent
        print(f"panoptic worker: shared device resolver not importable: {exc}", file=sys.stderr)
        print(
            "copy scripts/_torch_device.py next to panoptic_worker.py in PANOPTIC_DIR "
            "(see docs/pipelines/panoptic-scan.md — Setup)",
            file=sys.stderr,
        )
        return 2

    frames_in = keyframes(args.session_dir, args.max_frames)
    if not frames_in:
        print(f"panoptic worker: no keyframes in {args.session_dir}", file=sys.stderr)
        return 3

    # One resolver, shared with lingbot_map_worker.py — see scripts/_torch_device.py
    # for why NVIDIA, ROCm, MPS and CPU are told apart the way they are. Printed
    # because a Mac silently falling back to CPU used to look like a slow model
    # rather than a missing backend.
    dev = resolve_torch_device(torch, args.device)
    print(f"device: {dev.label} — {dev.reason}", file=sys.stderr)
    device = dev.device
    dtype = dev.dtype(torch)

    # Some torch wheels ship a cuDNN whose sublibraries disagree with the driver
    # and every conv dies with CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH. Disabling
    # cuDNN falls back to native CUDA kernels — measured at 0.7 s/frame for
    # Swin-L on a 4080, which is fast enough that chasing the wheel is not worth
    # it. Harmless when cuDNN is healthy. Now gated on the CUDA path: it was
    # unconditional, which does nothing on CPU or MPS since neither touches cuDNN.
    if dev.wants_cudnn_workaround():
        torch.backends.cudnn.enabled = False

    processor = AutoImageProcessor.from_pretrained(args.model)
    model = Mask2FormerForUniversalSegmentation.from_pretrained(args.model, torch_dtype=dtype)
    model.to(device)
    model.eval()

    # The checkpoint's own taxonomy. `id2label` is the source of truth for names.
    # Keys normalised to int: they arrive as strings from a JSON config on some
    # transformers versions, and an int/str mix makes every id lookup below miss.
    id2label = {int(k): v for k, v in model.config.id2label.items()}

    # ── The stuff/thing split is NOT in this checkpoint ──────────────────────
    # Verified on facebook/mask2former-swin-large-ade-panoptic: config has no
    # `thing_ids`, and post_process_panoptic_segmentation returns only
    # {id, label_id, score, was_fused}. `was_fused` is NOT a stuff flag — it
    # means the segment was merged from several queries, and with
    # `label_ids_to_fuse` unset (the default) transformers logs "No instance
    # will be fused" and it is False for EVERY segment, wall and floor included.
    #
    # So there is nothing here to infer the split from, and guessing from the
    # label string would be the hand-copied taxonomy this worker exists to avoid.
    # Absent an operator-supplied list, report `null` and let the TS side apply
    # its unknown-counts-as-stuff rule: that loses object detections (visible,
    # recoverable) rather than pushing walls toward thing_match's un-prunable
    # MAX_THINGS_PER_WORLD ceiling (silent, permanent).
    thing_ids: set[int] | None = None
    thing_labels: set[str] | None = None
    thing_source = "none"
    if args.thing_labels:
        # Accept either a bare array or the generated {"thingIds": …, "things": […]}
        # object, so a hand-written list and scripts/fetch-ade20k-things.mjs output
        # both work — the object form is the one that can be matched by class id.
        raw = json.loads(args.thing_labels.read_text())
        thing_ids, thing_labels, thing_source, note = resolve_thing_split(raw, id2label)
        print(f"thing-labels: matched by {thing_source} — {note}", file=sys.stderr)
    else:
        print(
            "thing-labels: none supplied — every segment reported isThing=null "
            "(treated as stuff downstream). See docs/pipelines/panoptic-scan.md.",
            file=sys.stderr,
        )

    out_frames = []
    for path in frames_in:
        image = Image.open(path).convert("RGB")
        inputs = processor(images=image, return_tensors="pt").to(device, dtype)
        with torch.inference_mode():
            outputs = model(**inputs)

        # post_process_panoptic_segmentation is the step that MAKES this panoptic:
        # it merges the model's per-query masks into one label per pixel. Sized
        # back to the source frame so centroids and areas are in source pixels,
        # which is the unit the driver and every downstream consumer expect.
        result = processor.post_process_panoptic_segmentation(
            outputs, target_sizes=[(image.height, image.width)]
        )[0]
        seg_map = result["segmentation"].cpu().numpy()

        segments = []
        for info in result["segments_info"]:
            label_id = int(info["label_id"])
            mask = seg_map == info["id"]
            area = int(mask.sum())
            if area < args.min_segment_pixels:
                continue
            ys, xs = np.nonzero(mask)
            cx, cy = float(xs.mean()), float(ys.mean())
            label = str(id2label.get(label_id, f"class_{label_id}"))
            segments.append(
                {
                    "label": label,
                    # .strip() matters: several ADE20K names carry trailing whitespace
                    # ("bed ") and the supplied list is stripped, so an unstripped
                    # compare silently filed a bed as a room surface. The id path
                    # sidesteps naming entirely and is preferred when available.
                    "isThing": (
                        (label_id in thing_ids)
                        if thing_ids is not None
                        else ((label.strip().lower() in thing_labels) if thing_labels is not None else None)
                    ),
                    "score": float(info.get("score", 0.0)),
                    "areaPx": area,
                    "centroidPx": [cx, cy],
                    # Mask extent, [x0, y0, x1, y1] inclusive. The 3-D lift derives
                    # the segment's angular footprint from areaPx as
                    # atan(sqrt(area/pi)/fl_y), which assumes the mask is a disc. A
                    # curtain or a bed is nothing like a disc, and the bbox is the
                    # cheap correction — free here (np.nonzero is already computed),
                    # and optional downstream so an older segments file still lifts.
                    "bboxPx": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                    # Is the centroid actually ON the object?
                    #
                    # A mean of the mask's pixel coordinates is not a point of the
                    # mask when the mask is concave or split into parts — a curtain
                    # either side of a window, or two cabinets merged into one
                    # segment, put the centroid in the gap BETWEEN them. The 3-D
                    # lift casts a ray through that centroid, so a false here means
                    # the ray measures whatever is visible through the hole and
                    # reports it with full confidence. Cheap to check, impossible to
                    # recover later, so it is reported rather than inferred.
                    "centroidOnMask": bool(mask[int(round(cy)), int(round(cx))]),
                }
            )

        out_frames.append({"file": path.name, "segments": segments})
        print(f"{path.name}: {len(segments)} segments", file=sys.stderr)

    # One line per label, most-seen first — for a hand-run of this worker, which
    # is how the docs say to debug it. Printed rather than persisted: the TS side
    # owns the counting policy (server/panoptic/panoptic_segments.ts) and a second
    # persisted tally computed here would be the second, silently-diverging copy
    # ADR 0001 is about. Under the driver this stderr is piped and only kept on a
    # non-zero exit, so the same distribution is logged again from the TS side —
    # "30 of these 38 sightings are the same ledge" is the fact that changes what
    # the counts mean, and it must reach a run through the job system too.
    tally: dict[tuple[str, object], int] = {}
    for frame in out_frames:
        for seg in frame["segments"]:
            key = (seg["label"], seg["isThing"])
            tally[key] = tally.get(key, 0) + 1
    print(
        f"labels: {sum(tally.values())} segment(s) over {len(out_frames)} frame(s), "
        f"{len(tally)} distinct label(s):",
        file=sys.stderr,
    )
    for (lab, is_thing), n in sorted(tally.items(), key=lambda kv: (-kv[1], kv[0][0])):
        kind = "thing" if is_thing else ("stuff" if is_thing is False else "unknown")
        print(f"  {n:>4}  {kind:<7} {lab}", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"model": args.model, "thingSource": thing_source, "frames": out_frames}, indent=2)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
