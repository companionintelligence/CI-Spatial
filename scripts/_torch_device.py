"""One torch device resolver, shared by this repo's Python workers.

`panoptic_worker.py` and `lingbot_map_worker.py` each used to carry their own
copy of `"cuda" if torch.cuda.is_available() else "cpu"` — two implementations
of the same decision, which is the duplication ADR 0001 exists to stop. Both now
call `resolve_torch_device()`.

The duplicated pair was also wrong in the same two ways:

  * **Apple Silicon never won.** Neither resolver ever looked at
    `torch.backends.mps`, so a Mac fell through to CPU and said nothing about
    it — the slowness looked like the model rather than the backend. Hence the
    `reason` field: the worker prints why it picked what it picked.
  * **AMD was half-wired.** `server/splat/splat_detect.ts` pins
    `HIP_VISIBLE_DEVICES` for a ROCm torch, but the workers' own resolution was
    a cuda-or-cpu binary with no idea ROCm existed. ROCm torch reports
    `torch.cuda.is_available() == True` and wants the device string `"cuda"` —
    that is how ROCm works, not a bug — so this module keeps the device string
    torch actually wants and distinguishes AMD only via `torch.version.hip`,
    for reporting and for the cuDNN decision below.

Leading underscore: this is an importable helper, not one of the `scripts/`
entrypoints. It has no imports beyond the stdlib and takes `torch` as an
argument rather than importing it, so it is unit-testable on a box with no
torch installed (`tests/unit/python/test_torch_device.py` injects a fake).

**Deployment note.** Both workers are deployed by *copying the single .py file*
(`docs/pipelines/panoptic-scan.md` — `cp scripts/panoptic_worker.py ~/panoptic/`;
`Dockerfile` — `COPY scripts/lingbot_map_worker.py`), not by installing the
repo, so this file must be copied next to them. Both workers treat a missing
`_torch_device.py` as a clean skip/exit with that instruction rather than an
ImportError traceback.
"""
from __future__ import annotations

import dataclasses
from typing import Any

AUTO = "auto"
CPU = "cpu"
CUDA = "cuda"
MPS = "mps"

# Accepted by `--device`. Anything else is still passed through to torch
# verbatim (see `resolve_torch_device`), because `panoptic_worker.py --device`
# has always been free-form and `cuda:1` is a real thing operators pass.
CHOICES = (AUTO, CPU, CUDA, MPS)

VENDOR_NVIDIA = "NVIDIA CUDA"
VENDOR_ROCM = "AMD ROCm"
VENDOR_APPLE = "Apple MPS"
VENDOR_CPU = "CPU"
VENDOR_UNVALIDATED = "unvalidated"


@dataclasses.dataclass(frozen=True)
class TorchDevice:
    """What a worker needs to run on a backend *and* to log about it honestly."""

    device: str
    """The string torch wants — `"cuda"`, `"cuda:1"`, `"mps"`, `"cpu"`. On ROCm
    this is `"cuda"`; see the module docstring."""

    vendor: str
    """Human label for logs and manifests. The only place NVIDIA and AMD differ."""

    fp16_ok: bool
    """Whether float16 is a win here. See `dtype()`."""

    is_cuda: bool
    """True for both NVIDIA and ROCm — i.e. torch's `cuda` code path is in play."""

    is_rocm: bool
    """True only when `torch.version.hip` is set. Narrower than `is_cuda`."""

    requested: str
    """The normalized `--device` value that produced this, for the log line."""

    reason: str
    """Why this backend, in words — including any downgrade that happened."""

    @property
    def label(self) -> str:
        return f"{self.device} ({self.vendor}, {'fp16' if self.fp16_ok else 'fp32'})"

    def dtype(self, torch: Any) -> Any:
        """The dtype to load weights and inputs in.

        fp16 roughly halves both the weights and the peak activation, which is
        what keeps Swin-L inside a 12 GB card, and it is supported on CUDA (the
        measured path: 0.7 s/frame for Mask2Former on a 4080) and on MPS. CPU
        stays fp32 — fp16 on CPU is slower, not faster, and can produce NaNs
        where fp32 does not.
        """
        return torch.float16 if self.fp16_ok else torch.float32

    def wants_cudnn_workaround(self) -> bool:
        """Whether to apply `panoptic_worker.py`'s `cudnn.enabled = False`.

        Some torch wheels ship a cuDNN whose sublibraries disagree with the
        driver and every conv dies with `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`
        (measured on `torch 2.13.0+cu130` on this box). That flag was set
        unconditionally, which is pointless on CPU and MPS — neither goes near
        cuDNN — so it is gated on the CUDA path here.

        ROCm is deliberately still included even though it dispatches to MIOpen
        rather than cuDNN: today's `device.startswith("cuda")` already applies
        the flag there, nobody has measured whether disabling it costs AMD
        anything, and a guess either way would be an unmeasured behaviour change.
        """
        return self.is_cuda


def _cuda_available(torch: Any) -> bool:
    # A broken CUDA install can raise here rather than return False; a worker
    # that cannot ask the question should fall back, not crash.
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _is_rocm(torch: Any) -> bool:
    # `torch.version.hip` is the only honest NVIDIA/AMD discriminator: a ROCm
    # build sets it to a HIP version string and leaves `torch.version.cuda`
    # populated too, and still answers True to `torch.cuda.is_available()`.
    try:
        return getattr(torch.version, "hip", None) is not None
    except Exception:
        return False


def _mps_available(torch: Any) -> bool:
    # Both halves matter: `is_built()` is False on a non-Apple wheel, and
    # `is_available()` is False on an Apple wheel running on an Intel Mac.
    # `torch.backends.mps` itself is absent before torch 1.12.
    try:
        mps = torch.backends.mps
        return bool(mps.is_available()) and bool(mps.is_built())
    except Exception:
        return False


def _cuda_result(device: str, requested: str, rocm: bool, reason: str) -> TorchDevice:
    return TorchDevice(
        device=device,
        vendor=VENDOR_ROCM if rocm else VENDOR_NVIDIA,
        # True for ROCm as well as NVIDIA: the resolvers this replaced tested
        # `device.startswith("cuda")`, which already handed ROCm fp16. Keeping
        # that is preserving measured-in-production behaviour, not a new claim
        # about AMD.
        fp16_ok=True,
        is_cuda=True,
        is_rocm=rocm,
        requested=requested,
        reason=reason,
    )


def _cpu_result(requested: str, reason: str) -> TorchDevice:
    return TorchDevice(
        device=CPU,
        vendor=VENDOR_CPU,
        fp16_ok=False,
        is_cuda=False,
        is_rocm=False,
        requested=requested,
        reason=reason,
    )


def resolve_torch_device(torch: Any, requested: str | None = None) -> TorchDevice:
    """Pick the best backend `torch` can actually reach, and say why.

    `torch` is passed in rather than imported so this is testable without it.
    `requested` is the worker's `--device` (None/"" means `auto`).

    Priority when `auto`: CUDA (NVIDIA or ROCm) → MPS → CPU. CUDA first because
    it is the one path with measured numbers on this fleet; MPS second because
    it beats CPU on the only hardware that has it; CPU last because it always
    works.

    An explicit request is honoured when the backend is there and **downgraded
    to CPU with a reason** when it is not — never raised. Optional GPU tooling
    in this repo degrades, it does not crash.
    """
    req = (requested or AUTO).strip().lower() or AUTO

    if req == CPU:
        return _cpu_result(req, "requested explicitly")

    rocm = _is_rocm(torch)

    # `cuda:1` and friends: honoured verbatim, which is what
    # `panoptic_worker.py --device` did before this module existed.
    if req.startswith(CUDA):
        if _cuda_available(torch):
            return _cuda_result(req, req, rocm, "requested explicitly")
        return _cpu_result(
            req,
            f"requested {req}, but torch.cuda.is_available() is False — downgraded to cpu",
        )

    if req == MPS:
        if _mps_available(torch):
            return TorchDevice(
                device=MPS,
                vendor=VENDOR_APPLE,
                fp16_ok=True,
                is_cuda=False,
                is_rocm=False,
                requested=req,
                reason="requested explicitly",
            )
        return _cpu_result(
            req,
            "requested mps, but torch.backends.mps is not available and built — downgraded to cpu",
        )

    if req != AUTO:
        # Not a backend this repo knows (torch grows them: xpu, hpu, …). Hand it
        # to torch unchanged so the escape hatch keeps working, but do not claim
        # fp16 is safe somewhere nobody has tried.
        return TorchDevice(
            device=req,
            vendor=VENDOR_UNVALIDATED,
            fp16_ok=False,
            is_cuda=False,
            is_rocm=False,
            requested=req,
            reason="requested explicitly; passed to torch unvalidated, so fp32 is assumed",
        )

    if _cuda_available(torch):
        return _cuda_result(
            CUDA,
            req,
            rocm,
            "auto: torch.cuda.is_available()" + (" with torch.version.hip set" if rocm else ""),
        )
    if _mps_available(torch):
        return TorchDevice(
            device=MPS,
            vendor=VENDOR_APPLE,
            fp16_ok=True,
            is_cuda=False,
            is_rocm=False,
            requested=req,
            reason="auto: torch.backends.mps is available and built",
        )
    return _cpu_result(req, "auto: no CUDA/ROCm/MPS backend available")
