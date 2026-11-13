#!/usr/bin/env python3
"""gpu_backend_report.py: check which GPU backend the CV workers would use on this machine.

Run it on each machine you want to verify (NVIDIA, AMD ROCm, Apple Silicon, Intel XPU):

    python3 scripts/gpu_backend_report.py                 # auto: the choice the workers make
    python3 scripts/gpu_backend_report.py --device xpu    # ask for one backend explicitly
    python3 scripts/gpu_backend_report.py --out report.json

It uses the resolver that panoptic_worker.py and lingbot_map_worker.py use
(scripts/_torch_device.py), so the answer matches the workers. It then runs a small
convolution and a matmul on the chosen device, in the dtype the resolver picks, and checks
the result is finite. It downloads no model.

Exit status: 0 when the forward pass ran and was finite; 1 when it failed; 2 when torch is
not installed in this interpreter.
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _synchronize(torch, device: str) -> None:
    kind = device.split(":")[0]
    module = getattr(torch, kind, None) if kind in ("cuda", "mps", "xpu") else None
    sync = getattr(module, "synchronize", None)
    if callable(sync):
        sync()


def _torch_facts(torch) -> dict:
    def safe(fn):
        try:
            return bool(fn())
        except Exception:
            return False

    return {
        "version": str(torch.__version__),
        "cudaBuild": getattr(torch.version, "cuda", None),
        "hipBuild": getattr(torch.version, "hip", None),
        "cudaAvailable": safe(torch.cuda.is_available),
        "mpsAvailable": safe(lambda: torch.backends.mps.is_available()),
        "xpuAvailable": safe(lambda: torch.xpu.is_available()),
    }


def _forward_check(torch, dev) -> dict:
    device = dev.device
    dtype = dev.dtype(torch)
    try:
        conv = torch.nn.Conv2d(3, 16, 3, padding=1).to(device=device, dtype=dtype).eval()
        x = torch.randn(2, 3, 128, 128, device=device, dtype=dtype)
        a = torch.randn(256, 256, device=device, dtype=dtype)
        with torch.inference_mode():  # warm-up: the first call pays for kernel setup, not the work
            conv(x)
            a @ a
        _synchronize(torch, device)
        started = time.perf_counter()
        with torch.inference_mode():
            y = conv(x)
            z = a @ a
        _synchronize(torch, device)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        finite = bool(torch.isfinite(y).all().item()) and bool(torch.isfinite(z).all().item())
        return {
            "ok": finite,
            "finite": finite,
            "elapsedMs": round(elapsed_ms, 2),
            "outputDtype": str(y.dtype),
            "outputShape": list(y.shape),
        }
    except Exception as exc:  # the report is the point; keep the error text
        return {"ok": False, "finite": False, "error": f"{type(exc).__name__}: {exc}"}


def build_report(torch, requested: str | None) -> dict:
    from _torch_device import resolve_torch_device

    dev = resolve_torch_device(torch, requested)
    forward = _forward_check(torch, dev)
    asked = (requested or "auto").strip().lower() or "auto"
    if not forward["ok"]:
        verdict = "failed"
    elif asked != "auto" and not dev.device.startswith(asked.split(":")[0]):
        verdict = "downgraded"
    else:
        verdict = "ok"
    return {
        "host": {"platform": platform.system(), "machine": platform.machine(), "python": platform.python_version()},
        "torch": _torch_facts(torch),
        "requested": asked,
        "resolved": {
            "device": dev.device,
            "vendor": dev.vendor,
            "fp16": dev.fp16_ok,
            "dtype": str(dev.dtype(torch)),
            "reason": dev.reason,
        },
        "forward": forward,
        "verdict": verdict,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--device", default=None, help="auto (default), cpu, cuda, cuda:N, mps, xpu, or another torch device")
    parser.add_argument("--out", type=Path, default=None, help="also write the JSON report to this file")
    args = parser.parse_args(argv)

    try:
        import torch
    except ImportError as exc:
        payload = {
            "verdict": "no-torch",
            "error": f"ImportError: {exc}",
            "hint": "Install torch for this machine (see docs/operations/GPU_BACKENDS.md), then run this again.",
        }
        print(json.dumps(payload, indent=2))
        return 2

    report = build_report(torch, args.device)
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    summary = f"{report['verdict']}: {report['resolved']['device']} ({report['resolved']['vendor']}, {report['resolved']['dtype']})"
    print(summary, file=sys.stderr)
    return 0 if report["verdict"] in ("ok", "downgraded") else 1


if __name__ == "__main__":
    raise SystemExit(main())
