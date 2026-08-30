"""LingBot-Map streaming reconstruction worker.

Reads a Companion-Scan keyframe session (JPEG sequence + ``keyframes.jsonl``)
and runs the LingBot-Map ``Geometric Context Transformer`` over the frames to
produce three sibling artifacts in the same session directory:

    lingbot-map.point-cloud.ply   binary PLY of merged world points
    lingbot-map.poses.json        per-frame intrinsics + camera-to-world poses
    lingbot-map.manifest.json     index + run stats (always written)

The script is invoked as a subprocess from the Deno server. Exit codes:

    0   success or skipped-with-reason (manifest still written)
    2   unrecoverable input error (manifest may not exist)
    3   model load / inference error (manifest written with ``error``)

Why the worker writes a manifest even when it fails: the Deno coordinator
serves ``lingbot-map.manifest.json`` over HTTP and shows ``error`` /
``skippedReason`` in the world-job artifact, so the UI can explain *why* a
reconstruction did not produce a point cloud instead of falling back to a
generic "job failed".

Usage:
    python scripts/lingbot_map_worker.py --session-dir <path> \\
        [--model-path <ckpt>] [--max-frames N] [--keyframe-interval K] \\
        [--device {auto,cpu,cuda,mps}]
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Iterable


KEYFRAME_FILE_RE = re.compile(r"^kf-\d{5}\.jpg$")
DEFAULT_IMAGE_SIZE = 518
DEFAULT_PATCH_SIZE = 14


@dataclasses.dataclass
class FrameMeta:
    file: str
    index: int
    timestamp_ms: float | None
    pose: dict[str, Any] | None
    intrinsics: dict[str, Any] | None


def _load_keyframes(session_dir: Path) -> list[FrameMeta]:
    """Read ``keyframes.jsonl`` and return frames in capture order.

    Drops records whose image is missing on disk so a partially-uploaded
    session is still reconstructable up to the last contiguous frame the
    client managed to flush.
    """
    jsonl = session_dir / "keyframes.jsonl"
    if not jsonl.exists():
        raise FileNotFoundError(f"keyframes.jsonl not found in {session_dir}")

    frames: list[FrameMeta] = []
    with jsonl.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"[lingbot-map] skip malformed line {line_no}: {e}", file=sys.stderr)
                continue
            file = rec.get("file")
            if not isinstance(file, str) or not KEYFRAME_FILE_RE.match(file):
                continue
            if not (session_dir / file).exists():
                continue
            frames.append(
                FrameMeta(
                    file=file,
                    index=int(rec.get("index", -1)),
                    timestamp_ms=_float_or_none(rec.get("timestamp")),
                    pose=rec.get("pose") if isinstance(rec.get("pose"), dict) else None,
                    intrinsics=rec.get("intrinsics") if isinstance(rec.get("intrinsics"), dict) else None,
                )
            )
    frames.sort(key=lambda f: f.index if f.index >= 0 else f.file)
    return frames


def _float_or_none(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _write_manifest(session_dir: Path, payload: dict[str, Any]) -> None:
    (session_dir / "lingbot-map.manifest.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )


def _sample_frames(frames: list[FrameMeta], keyframe_interval: int, max_frames: int) -> list[FrameMeta]:
    sampled = frames[::max(1, keyframe_interval)]
    if max_frames > 0:
        sampled = sampled[:max_frames]
    return sampled


def _try_import_torch() -> tuple[Any, str | None]:
    try:
        import torch
        return torch, None
    except Exception as e:
        return None, f"torch import failed: {e}"


def _try_import_lingbot() -> tuple[Any, str | None]:
    """Import the upstream model, against the API it actually ships.

    This used to do `from lingbot_map.models.lingbot_map import LingBotMap` and
    then `LingBotMap.from_pretrained(path)`. Neither exists: measured against
    Robbyant/lingbot-map at 2026-08-30, the package exposes `GCTStream`
    (Geometric Context Transformer) in `models.gct_stream` / `.gct_stream_window`,
    and the checkpoint is a plain torch archive loaded by hand — see the
    upstream `demo.py:load_model`, which this mirrors. `load_and_preprocess_images`
    and `pose_encoding_to_extri_intri` were already correct.

    Windowed vs streaming is upstream's own switch; streaming is the default
    there and is what a walkthrough session is, so that is the default here too.
    """
    try:
        if os.environ.get("LINGBOT_MAP_MODE", "streaming") == "windowed":
            from lingbot_map.models.gct_stream_window import GCTStream as _GCTStream
        else:
            from lingbot_map.models.gct_stream import GCTStream as _GCTStream
        from lingbot_map.utils.load_fn import load_and_preprocess_images
        from lingbot_map.utils.pose_enc import pose_encoding_to_extri_intri

        return (
            {
                "GCTStream": _GCTStream,
                "load_and_preprocess_images": load_and_preprocess_images,
                "pose_encoding_to_extri_intri": pose_encoding_to_extri_intri,
            },
            None,
        )
    except Exception as e:
        return None, f"lingbot_map import failed: {e}"


def _try_import_device_resolver() -> tuple[Any, str | None]:
    """Load the shared resolver, tolerating the copy-one-file deployment.

    The Dockerfile installs this worker with `COPY scripts/lingbot_map_worker.py`
    and `LINGBOT_MAP_SCRIPT` can point anywhere, so `_torch_device.py` has to be
    found as a sibling rather than on an installed package path. Same failure
    style as `_try_import_torch`: a reason string the caller turns into a
    `skipped` manifest, never a traceback.
    """
    try:
        try:
            from _torch_device import resolve_torch_device
        except ImportError:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from _torch_device import resolve_torch_device
        return resolve_torch_device, None
    except Exception as e:
        return None, f"_torch_device import failed: {e}"


def _write_ply(path: Path, xyz: Iterable[tuple[float, float, float]], rgb: Iterable[tuple[int, int, int]] | None) -> int:
    """Write a binary-little-endian PLY. Returns the number of vertices written."""
    xyz_list = list(xyz)
    rgb_list = list(rgb) if rgb is not None else None
    if rgb_list is not None and len(rgb_list) != len(xyz_list):
        rgb_list = None

    import struct

    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {len(xyz_list)}",
        "property float x",
        "property float y",
        "property float z",
    ]
    if rgb_list is not None:
        header.extend([
            "property uchar red",
            "property uchar green",
            "property uchar blue",
        ])
    header.append("end_header\n")

    with path.open("wb") as fh:
        fh.write("\n".join(header).encode("ascii"))
        for i, (x, y, z) in enumerate(xyz_list):
            fh.write(struct.pack("<fff", float(x), float(y), float(z)))
            if rgb_list is not None:
                r, g, b = rgb_list[i]
                fh.write(struct.pack("<BBB", int(r) & 0xFF, int(g) & 0xFF, int(b) & 0xFF))
    return len(xyz_list)


def run(args: argparse.Namespace) -> int:
    session_dir = Path(args.session_dir).resolve()
    if not session_dir.is_dir():
        print(f"[lingbot-map] session dir not found: {session_dir}", file=sys.stderr)
        return 2

    started = time.time()
    base_manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "tool": "lingbot-map",
        "sessionDir": str(session_dir),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "params": {
            "modelPath": args.model_path,
            "device": args.device,
            "keyframeInterval": args.keyframe_interval,
            "maxFrames": args.max_frames,
            "imageSize": args.image_size,
        },
    }

    try:
        frames = _load_keyframes(session_dir)
    except FileNotFoundError as e:
        _write_manifest(session_dir, {**base_manifest, "status": "error", "error": str(e)})
        print(f"[lingbot-map] {e}", file=sys.stderr)
        return 2

    if not frames:
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "skipped",
            "skippedReason": "no keyframes found",
            "frameCount": 0,
        })
        print("[lingbot-map] no keyframes — nothing to reconstruct", file=sys.stderr)
        return 0

    sampled = _sample_frames(frames, args.keyframe_interval, args.max_frames)
    base_manifest["frameCount"] = len(sampled)
    base_manifest["totalCapturedFrames"] = len(frames)

    torch, terr = _try_import_torch()
    if torch is None:
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "skipped",
            "skippedReason": terr,
            "remediation": "Install torch + lingbot-map (see README — `LingBot-Map server processing`).",
        })
        print(f"[lingbot-map] {terr}", file=sys.stderr)
        return 0

    mods, lerr = _try_import_lingbot()
    if mods is None:
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "skipped",
            "skippedReason": lerr,
            "remediation": "pip install -e <lingbot-map-checkout> (see README — `LingBot-Map server processing`).",
        })
        print(f"[lingbot-map] {lerr}", file=sys.stderr)
        return 0

    if not args.model_path or not os.path.exists(args.model_path):
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "skipped",
            "skippedReason": f"model checkpoint not found: {args.model_path}",
            "remediation": "Download from huggingface.co/robbyant/lingbot-map and set LINGBOT_MAP_MODEL_PATH.",
        })
        print(f"[lingbot-map] model not found at {args.model_path}", file=sys.stderr)
        return 0

    resolve_torch_device, derr = _try_import_device_resolver()
    if resolve_torch_device is None:
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "skipped",
            "skippedReason": derr,
            "remediation": "Copy scripts/_torch_device.py next to lingbot_map_worker.py (LINGBOT_MAP_SCRIPT's directory).",
        })
        print(f"[lingbot-map] {derr}", file=sys.stderr)
        return 0

    # One resolver, shared with panoptic_worker.py — see scripts/_torch_device.py.
    # `resolvedDevice` stays the bare torch string the UI and fixtures already
    # read; the vendor is reported alongside it because "cuda" alone cannot tell
    # an operator whether a ROCm box actually picked up its GPU.
    dev = resolve_torch_device(torch, args.device)
    device = dev.device
    base_manifest["params"]["resolvedDevice"] = device
    base_manifest["params"]["deviceVendor"] = dev.vendor
    print(f"[lingbot-map] device: {dev.label} — {dev.reason}", file=sys.stderr)

    try:
        GCTStream = mods["GCTStream"]
        load_and_preprocess_images = mods["load_and_preprocess_images"]
        pose_encoding_to_extri_intri = mods["pose_encoding_to_extri_intri"]

        # Same measured cuDNN fault the panoptic worker documents on this box:
        # a forward pass raises CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH from the
        # first conv2d, because the installed cuDNN sublibraries disagree with the
        # version this torch wheel was built against. Disabling cuDNN falls back to
        # native CUDA kernels — slower per layer, but it runs, and chasing a matched
        # wheel is not worth it. Harmless where cuDNN is healthy, and a no-op on
        # CPU/MPS which never touch it.
        if dev.wants_cudnn_workaround():
            torch.backends.cudnn.enabled = False

        print(f"[lingbot-map] loading model from {args.model_path} on {device}", file=sys.stderr)
        # Mirrors upstream demo.py:load_model. The checkpoint is a torch archive,
        # not a HF snapshot, so it is constructed then loaded — and with
        # strict=False, because upstream itself tolerates missing/unexpected keys
        # across its three published checkpoints (lingbot-map, -long, -stage1).
        # `kv_cache_scale_frames` is upstream's documented lever for limited VRAM
        # ("--num_scale_frames 2 ... shrinks the activation peak of the initial
        # scale phase"; their default is 8). Measured here: at 8 this OOMs on an
        # idle 12 GB 4080 even with 8 frames and autocast, because the peak is set
        # by the scale phase rather than by the frame count. Overridable for hosts
        # with more headroom, where a higher value is more accurate.
        scale_frames = int(os.environ.get("LINGBOT_MAP_SCALE_FRAMES", "2"))
        model = GCTStream(  # type: ignore[operator]
            img_size=args.image_size,
            patch_size=DEFAULT_PATCH_SIZE,
            kv_cache_scale_frames=scale_frames,
            use_sdpa=True,  # FlashInfer is optional upstream; SDPA is the fallback
        )
        ckpt = torch.load(args.model_path, map_location=device, weights_only=False)
        state_dict = ckpt.get("model", ckpt) if isinstance(ckpt, dict) else ckpt
        missing, unexpected = model.load_state_dict(state_dict, strict=False)
        if missing:
            print(f"[lingbot-map] checkpoint missing {len(missing)} key(s)", file=sys.stderr)
        if unexpected:
            print(f"[lingbot-map] checkpoint has {len(unexpected)} unexpected key(s)", file=sys.stderr)
        # Weights stay fp32; mixed precision is applied at the forward pass via
        # autocast below. A blanket `.to(dtype=float16)` was tried first and
        # fails here: this model keeps LayerNorm weights in fp32, so a half input
        # raises "expected scalar type Float but found Half". autocast is the
        # right tool — it halves activation memory (the actual pressure: a
        # 24-frame run OOMed with 11.28 GB allocated on an idle 12 GB card) while
        # leaving the norm layers alone.
        model = model.to(device).eval()
        print(f"[lingbot-map] model on {dev.label}", file=sys.stderr)

        paths = [str(session_dir / f.file) for f in sampled]
        images = load_and_preprocess_images(
            paths,
            mode="crop",
            image_size=args.image_size,
            patch_size=DEFAULT_PATCH_SIZE,
        )
        if hasattr(images, "to"):
            images = images.to(device)

        print(f"[lingbot-map] streaming inference over {len(paths)} frames", file=sys.stderr)
        with torch.no_grad():
            if dev.fp16_ok:
                # halves activation memory; norm layers stay fp32 automatically
                with torch.autocast(device_type=device.split(":")[0], dtype=torch.float16):
                    output = model(images)  # type: ignore[operator]
            else:
                output = model(images)  # type: ignore[operator]

        # ── Extract poses + point cloud from the model output ──────────────
        # LingBotMap returns a dict with `pose_enc`, `world_points`, and
        # `world_points_conf`. We are defensive here because future releases
        # may rename these — the worker degrades to writing a manifest with
        # whatever it could extract instead of crashing the whole job.
        pose_enc = _get(output, "pose_enc")
        world_points = _get(output, "world_points")
        world_conf = _get(output, "world_points_conf")
        rgb_tensor = _get(output, "rgb") or images

        poses_payload = _extract_poses(
            pose_enc=pose_enc,
            sampled=sampled,
            image_size=args.image_size,
            pose_encoding_to_extri_intri=pose_encoding_to_extri_intri,
        )
        (session_dir / "lingbot-map.poses.json").write_text(
            json.dumps(poses_payload, indent=2), encoding="utf-8"
        )

        xyz, rgb = _flatten_world_points(world_points, world_conf, rgb_tensor, args.confidence_threshold)
        point_count = _write_ply(session_dir / "lingbot-map.point-cloud.ply", xyz, rgb)

        elapsed_ms = int((time.time() - started) * 1000)
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "ok",
            "pointCount": point_count,
            "elapsedMs": elapsed_ms,
            "artifacts": {
                "pointCloud": "lingbot-map.point-cloud.ply",
                "poses": "lingbot-map.poses.json",
            },
        })
        print(
            f"[lingbot-map] wrote {point_count} points + {len(poses_payload['frames'])} poses "
            f"in {elapsed_ms}ms",
            file=sys.stderr,
        )
        return 0
    except Exception as e:
        _write_manifest(session_dir, {
            **base_manifest,
            "status": "error",
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        })
        print(f"[lingbot-map] inference failed: {e}", file=sys.stderr)
        traceback.print_exc()
        return 3


def _get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _to_list(tensor: Any) -> list[Any]:
    if tensor is None:
        return []
    if hasattr(tensor, "detach"):
        tensor = tensor.detach().cpu().numpy()
    if hasattr(tensor, "tolist"):
        return tensor.tolist()
    return list(tensor)


def _extract_poses(
    *,
    pose_enc: Any,
    sampled: list[FrameMeta],
    image_size: int,
    pose_encoding_to_extri_intri: Any,
) -> dict[str, Any]:
    frames_out: list[dict[str, Any]] = []
    matrices: list[Any] = []
    intrinsics: list[Any] = []
    if pose_enc is not None and pose_encoding_to_extri_intri is not None:
        try:
            extri, intri = pose_encoding_to_extri_intri(pose_enc, (image_size, image_size))
            matrices = _to_list(extri)
            intrinsics = _to_list(intri)
            # The decoder returns batched tensors (B=1, N, 3, 4) / (B=1, N, 3, 3);
            # drop the batch dim so matrices[i] lines up with sampled[i].
            if len(matrices) == 1 and isinstance(matrices[0], list) and len(matrices[0]) == len(sampled):
                matrices = matrices[0]
            if len(intrinsics) == 1 and isinstance(intrinsics[0], list) and len(intrinsics[0]) == len(sampled):
                intrinsics = intrinsics[0]
        except Exception as e:
            print(f"[lingbot-map] pose decode failed, writing capture-time pose only: {e}", file=sys.stderr)

    for i, fm in enumerate(sampled):
        entry: dict[str, Any] = {
            "index": fm.index,
            "file": fm.file,
            "timestampMs": fm.timestamp_ms,
            "capturePose": fm.pose,
            "captureIntrinsics": fm.intrinsics,
        }
        if i < len(matrices):
            entry["cameraToWorld"] = matrices[i]
        if i < len(intrinsics):
            entry["intrinsicsMatrix"] = intrinsics[i]
        frames_out.append(entry)
    return {"schemaVersion": 1, "frames": frames_out}


def _flatten_world_points(
    world_points: Any,
    world_conf: Any,
    rgb_tensor: Any,
    confidence_threshold: float,
) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]] | None]:
    if world_points is None:
        return [], None
    pts = _to_list(world_points)
    conf = _to_list(world_conf) if world_conf is not None else None
    rgb_src = _to_list(rgb_tensor) if rgb_tensor is not None else None

    flat_xyz: list[tuple[float, float, float]] = []
    flat_rgb: list[tuple[int, int, int]] = []
    has_rgb = rgb_src is not None

    def walk(node: Any, conf_node: Any, rgb_node: Any) -> None:
        if isinstance(node, list):
            if (
                len(node) == 3
                and all(isinstance(v, (int, float)) for v in node)
            ):
                if conf_node is not None:
                    c = conf_node if isinstance(conf_node, (int, float)) else None
                    if c is not None and c < confidence_threshold:
                        return
                flat_xyz.append((float(node[0]), float(node[1]), float(node[2])))
                if has_rgb and isinstance(rgb_node, list) and len(rgb_node) >= 3:
                    flat_rgb.append((
                        _norm_rgb(rgb_node[0]),
                        _norm_rgb(rgb_node[1]),
                        _norm_rgb(rgb_node[2]),
                    ))
                return
            for i, item in enumerate(node):
                walk(
                    item,
                    conf_node[i] if isinstance(conf_node, list) and i < len(conf_node) else conf_node,
                    rgb_node[i] if isinstance(rgb_node, list) and i < len(rgb_node) else rgb_node,
                )

    walk(pts, conf, rgb_src)
    return flat_xyz, (flat_rgb if has_rgb and len(flat_rgb) == len(flat_xyz) else None)


def _norm_rgb(v: Any) -> int:
    if isinstance(v, float) and 0.0 <= v <= 1.0:
        return int(round(v * 255))
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="LingBot-Map reconstruction worker for Companion Scan sessions")
    p.add_argument("--session-dir", required=True, help="Path to scans/sessions/<id>/")
    p.add_argument(
        "--model-path",
        default=os.environ.get("LINGBOT_MAP_MODEL_PATH", ""),
        help="LingBot-Map checkpoint path (defaults to $LINGBOT_MAP_MODEL_PATH)",
    )
    # "mps" is new here: auto already picks it on Apple Silicon, but an operator
    # debugging a Mac needs to be able to ask for it (and to be told when it is
    # unavailable) rather than have argparse reject the word.
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "mps"])
    p.add_argument("--keyframe-interval", type=int, default=1)
    p.add_argument("--max-frames", type=int, default=512)
    p.add_argument("--image-size", type=int, default=DEFAULT_IMAGE_SIZE)
    p.add_argument("--confidence-threshold", type=float, default=0.0)
    args = p.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
