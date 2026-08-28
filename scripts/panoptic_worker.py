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
            "JSON array of label strings that are discrete objects. Without it "
            "every segment is reported isThing=null, which the TS side treats as "
            "stuff — safe, but nothing reaches thing_match."
        ),
    )
    p.add_argument(
        "--device",
        default=None,
        help="torch device; defaults to cuda when available, else cpu",
    )
    return p.parse_args()


def keyframes(session_dir: Path, limit: int) -> list[Path]:
    names = sorted(p for p in session_dir.iterdir() if p.is_file() and KEYFRAME_RE.match(p.name))
    return names[:limit]


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

    frames_in = keyframes(args.session_dir, args.max_frames)
    if not frames_in:
        print(f"panoptic worker: no keyframes in {args.session_dir}", file=sys.stderr)
        return 3

    # Some torch wheels ship a cuDNN whose sublibraries disagree with the driver
    # and every conv dies with CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH. Disabling
    # cuDNN falls back to native CUDA kernels — measured at 0.7 s/frame for
    # Swin-L on a 4080, which is fast enough that chasing the wheel is not worth
    # it. Harmless when cuDNN is healthy.
    torch.backends.cudnn.enabled = False

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    # fp16 on GPU roughly halves both the weights and the peak activation, which
    # is what keeps Swin-L inside a 12GB card. CPU stays fp32: fp16 on CPU is
    # slower, not faster.
    dtype = torch.float16 if device.startswith("cuda") else torch.float32

    processor = AutoImageProcessor.from_pretrained(args.model)
    model = Mask2FormerForUniversalSegmentation.from_pretrained(args.model, torch_dtype=dtype)
    model.to(device)
    model.eval()

    # The checkpoint's own taxonomy. `id2label` is the source of truth for names.
    id2label = model.config.id2label

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
    thing_labels: set[str] | None = None
    if args.thing_labels:
        raw = json.loads(args.thing_labels.read_text())
        # Accept either a bare array or the generated {"things": [...]} object,
        # so a hand-written list and scripts/fetch-ade20k-things.mjs output both work.
        labels = raw["things"] if isinstance(raw, dict) else raw
        thing_labels = {str(x).strip().lower() for x in labels}
        print(f"thing-labels: {len(thing_labels)} labels supplied", file=sys.stderr)
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
            label = str(id2label.get(label_id, f"class_{label_id}"))
            segments.append(
                {
                    "label": label,
                    # .strip() matters: several ADE20K names carry trailing whitespace
                    # ("bed ") and the supplied list is stripped, so an unstripped
                    # compare silently filed a bed as a room surface.
                    "isThing": (label.strip().lower() in thing_labels) if thing_labels is not None else None,
                    "score": float(info.get("score", 0.0)),
                    "areaPx": area,
                    "centroidPx": [float(xs.mean()), float(ys.mean())],
                }
            )

        out_frames.append({"file": path.name, "segments": segments})
        print(f"{path.name}: {len(segments)} segments", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"model": args.model, "frames": out_frames}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
