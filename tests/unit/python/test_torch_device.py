#!/usr/bin/env python3
"""Unit tests for scripts/_torch_device.py.

Run with plain stdlib — no pytest, no torch:

    python3 tests/unit/python/test_torch_device.py

`resolve_torch_device` takes `torch` as an argument precisely so this file can
hand it a fake. That matters: the fleet has NVIDIA and AMD boxes and the Macs
are developer laptops, so no single machine can exercise all four branches, and
CI has no GPU at all. A fake module is the only way every branch is covered
anywhere.

The fakes mirror what real torch reports, which is not obvious for AMD:
a ROCm build answers `torch.cuda.is_available() == True` and wants the device
string "cuda" — `torch.version.hip` is the only discriminator.
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

from _torch_device import resolve_torch_device  # noqa: E402


def fake_torch(*, cuda: bool = False, hip: str | None = None,
               mps_available: bool = False, mps_built: bool = False,
               cuda_raises: bool = False) -> types.SimpleNamespace:
    """A stand-in with only the attributes the resolver actually probes."""

    def is_available() -> bool:
        if cuda_raises:
            raise RuntimeError("CUDA driver version is insufficient")
        return cuda

    t = types.SimpleNamespace()
    t.cuda = types.SimpleNamespace(is_available=is_available)
    t.version = types.SimpleNamespace(cuda="12.4" if cuda and hip is None else None, hip=hip)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(
            is_available=lambda: mps_available,
            is_built=lambda: mps_built,
        )
    )
    t.float16 = "float16"
    t.float32 = "float32"
    return t


NVIDIA = dict(cuda=True)
ROCM = dict(cuda=True, hip="6.2.41133")
APPLE = dict(mps_available=True, mps_built=True)
BARE = dict()


class AutoResolution(unittest.TestCase):
    def test_nvidia_cuda(self):
        d = resolve_torch_device(fake_torch(**NVIDIA))
        self.assertEqual(d.device, "cuda")
        self.assertEqual(d.vendor, "NVIDIA CUDA")
        self.assertTrue(d.is_cuda)
        self.assertFalse(d.is_rocm)
        self.assertTrue(d.fp16_ok)

    def test_rocm_keeps_the_cuda_device_string_but_reports_amd(self):
        d = resolve_torch_device(fake_torch(**ROCM))
        # The whole point: torch wants "cuda" here. Reporting AMD must not
        # change what we hand to .to().
        self.assertEqual(d.device, "cuda")
        self.assertEqual(d.vendor, "AMD ROCm")
        self.assertTrue(d.is_cuda)
        self.assertTrue(d.is_rocm)
        self.assertTrue(d.fp16_ok)
        self.assertIn("hip", d.reason)

    def test_apple_silicon_picks_mps_not_cpu(self):
        # The bug this module was written for: both old resolvers fell to CPU
        # here and said nothing.
        d = resolve_torch_device(fake_torch(**APPLE))
        self.assertEqual(d.device, "mps")
        self.assertEqual(d.vendor, "Apple MPS")
        self.assertFalse(d.is_cuda)
        self.assertTrue(d.fp16_ok, "MPS supports fp16; the old code gave it fp32")

    def test_mps_built_but_unavailable_is_not_selected(self):
        # An Apple wheel on an Intel Mac: is_built() True, is_available() False.
        d = resolve_torch_device(fake_torch(mps_built=True, mps_available=False))
        self.assertEqual(d.device, "cpu")

    def test_nothing_available_is_cpu_fp32(self):
        d = resolve_torch_device(fake_torch(**BARE))
        self.assertEqual(d.device, "cpu")
        self.assertEqual(d.vendor, "CPU")
        self.assertFalse(d.fp16_ok)
        self.assertFalse(d.is_cuda)

    def test_cuda_wins_over_mps_when_both_claim_available(self):
        d = resolve_torch_device(fake_torch(cuda=True, mps_available=True, mps_built=True))
        self.assertEqual(d.device, "cuda")

    def test_broken_cuda_install_falls_back_instead_of_raising(self):
        d = resolve_torch_device(fake_torch(cuda_raises=True))
        self.assertEqual(d.device, "cpu")

    def test_pre_1_12_torch_without_backends_mps(self):
        t = fake_torch(**BARE)
        del t.backends.mps
        self.assertEqual(resolve_torch_device(t).device, "cpu")

    def test_none_and_empty_and_auto_are_the_same(self):
        for requested in (None, "", "  ", "auto", "AUTO"):
            with self.subTest(requested=requested):
                self.assertEqual(resolve_torch_device(fake_torch(**NVIDIA), requested).device, "cuda")


class ExplicitOverrides(unittest.TestCase):
    def test_cpu_is_honoured_on_a_gpu_box(self):
        d = resolve_torch_device(fake_torch(**NVIDIA), "cpu")
        self.assertEqual(d.device, "cpu")
        self.assertFalse(d.fp16_ok)

    def test_cuda_honoured_when_present(self):
        self.assertEqual(resolve_torch_device(fake_torch(**NVIDIA), "cuda").device, "cuda")

    def test_indexed_cuda_passes_through_verbatim(self):
        # panoptic_worker.py --device has always been free-form; `cuda:1` is a
        # real thing operators pass on the multi-GPU box.
        d = resolve_torch_device(fake_torch(**NVIDIA), "cuda:1")
        self.assertEqual(d.device, "cuda:1")
        self.assertTrue(d.fp16_ok)

    def test_requested_cuda_but_unavailable_downgrades_with_a_reason(self):
        # The one behaviour lingbot_map_worker.py already had and
        # panoptic_worker.py did not; it crashed instead.
        d = resolve_torch_device(fake_torch(**BARE), "cuda")
        self.assertEqual(d.device, "cpu")
        self.assertFalse(d.fp16_ok)
        self.assertIn("downgraded to cpu", d.reason)
        self.assertEqual(d.requested, "cuda")

    def test_requested_mps_but_unavailable_downgrades_with_a_reason(self):
        d = resolve_torch_device(fake_torch(**NVIDIA), "mps")
        self.assertEqual(d.device, "cpu")
        self.assertIn("downgraded to cpu", d.reason)

    def test_requested_mps_honoured_on_apple(self):
        self.assertEqual(resolve_torch_device(fake_torch(**APPLE), "mps").device, "mps")

    def test_impossible_device_is_passed_through_but_not_given_fp16(self):
        # torch keeps adding backends (xpu, hpu). Refusing them would remove an
        # escape hatch; claiming fp16 works there would be a guess.
        d = resolve_torch_device(fake_torch(**BARE), "wumpus")
        self.assertEqual(d.device, "wumpus")
        self.assertEqual(d.vendor, "unvalidated")
        self.assertFalse(d.fp16_ok)
        self.assertFalse(d.is_cuda)


class DtypeAndCudnnPolicy(unittest.TestCase):
    def test_dtype_matches_fp16_ok(self):
        t = fake_torch(**NVIDIA)
        self.assertEqual(resolve_torch_device(t).dtype(t), "float16")
        self.assertEqual(resolve_torch_device(t, "cpu").dtype(t), "float32")
        m = fake_torch(**APPLE)
        self.assertEqual(resolve_torch_device(m).dtype(m), "float16")

    def test_cudnn_workaround_is_cuda_only(self):
        self.assertTrue(resolve_torch_device(fake_torch(**NVIDIA)).wants_cudnn_workaround())
        # ROCm still gets it: `device.startswith("cuda")` already did, and
        # nobody has measured whether MIOpen cares.
        self.assertTrue(resolve_torch_device(fake_torch(**ROCM)).wants_cudnn_workaround())
        self.assertFalse(resolve_torch_device(fake_torch(**APPLE)).wants_cudnn_workaround())
        self.assertFalse(resolve_torch_device(fake_torch(**BARE)).wants_cudnn_workaround())

    def test_label_is_loggable(self):
        self.assertEqual(resolve_torch_device(fake_torch(**ROCM)).label, "cuda (AMD ROCm, fp16)")
        self.assertEqual(resolve_torch_device(fake_torch(**BARE)).label, "cpu (CPU, fp32)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
