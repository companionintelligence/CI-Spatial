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
    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation
    except ImportError as exc:  # pragma: no cover - environment-dependent
        print(f"panoptic worker: missing dependency: {exc}", file=sys.stderr)
        print("install with: pip install torch transformers pillow numpy", file=sys.stderr)
        return 2

    frames_in = keyframes(args.session_dir, args.max_frames)
    if not frames_in:
        print(f"panoptic worker: no keyframes in {args.session_dir}", file=sys.stderr)
        return 3

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    # fp16 on GPU roughly halves both the weights and the peak activation, which
    # is what keeps Swin-L inside a 12GB card. CPU stays fp32: fp16 on CPU is
    # slower, not faster.
    dtype = torch.float16 if device.startswith("cuda") else torch.float32

    processor = AutoImageProcessor.from_pretrained(args.model)
    model = Mask2FormerForUniversalSegmentation.from_pretrained(args.model, torch_dtype=dtype)
    model.to(device)
    model.eval()

    # The checkpoint's own taxonomy. `id2label` is the source of truth for names,
    # and the processor knows which ids are "things" for this dataset.
    id2label = model.config.id2label
    thing_ids = set(getattr(model.config, "thing_ids", []) or [])

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
            segments.append(
                {
                    "label": str(id2label.get(label_id, f"class_{label_id}")),
                    # Fall back to the processor's flag when the config has no
                    # thing_ids; never guess from the label string.
                    "isThing": bool(label_id in thing_ids) if thing_ids else bool(info.get("was_fused") is False),
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
