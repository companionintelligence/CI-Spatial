# GPU backends for the CV server

This is the setup runbook for the box that runs the computer-vision stages: panoptic
segmentation, LingBot-Map reconstruction, Brush and Spirula splat training, and Ollama
vision inference. It says which GPU vendors can run which stage, what each vendor needs
installed, and which models are NVIDIA-only by design.

What was actually run, and on which hardware, is recorded in
[PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md#accelerators). This file describes setup only.

## The rule

One resolver decides the torch device: `scripts/_torch_device.py`. Model code never branches
on vendor. It asks the resolver for `device`, `dtype` and whether to autocast. The NVIDIA
path is the one that was measured first, and it stays unchanged. Apple, AMD and Intel are
reached through the same resolver, and each reports what it actually used.

## Support by stage

| Stage | NVIDIA (CUDA) | AMD (ROCm) | Apple (MPS) | Intel (XPU) | CPU |
| --- | --- | --- | --- | --- | --- |
| Ollama vision inference (`server/inference.ts`) | Supported | Supported (ROCm); Vulkan is opt-in | Supported (Metal) | Experimental (Vulkan, opt-in) | Supported |
| Panoptic segmentation, Mask2Former (`scripts/panoptic_worker.py`) | fp16. **Verified** on RTX 3070, 2026-11-12 | fp16 via ROCm torch. Unverified | fp16. Unverified | fp32 until measured. Unverified | fp32 |
| LingBot-Map (`scripts/lingbot_map_worker.py`) | fp16 autocast. Unverified here (no checkpoint on this box) | fp16 autocast via ROCm torch. Unverified | fp32; autocast is not used on MPS | fp32 until measured. Unverified | fp32 |
| Brush splat training (wgpu) | Vulkan | Vulkan | Metal | Vulkan. Unverified | Not usable |
| Spirula splat training (wgpu) | Vulkan | Vulkan | No macOS build in this repo | Vulkan. Unverified | Not usable |
| 4DAnyone person capture | **NVIDIA only**, one device with at least 44 GiB, off-box (ADR 0006) | Not supported | Not supported | Not supported | Not supported |
| SenseNova Recon3D | **NVIDIA only** (CUDA 12.x, FlashAttention, `scripts/setup-sensenova-wsl.sh`) | Not supported | Not supported | Not supported | Not supported |

## Per-vendor setup

### NVIDIA

Keep the CUDA wheel. The version verified here is torch 2.11.0+cu128 on an RTX 3070
(driver 580.178.04).

```bash
uv venv --python 3.12 ~/.venvs/cv-gpu
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python ~/.venvs/cv-gpu/bin/python transformers pillow numpy scipy
```

The resolver should report `cuda (NVIDIA CUDA, fp16)`.

### AMD (ROCm) — unverified

Install a ROCm torch wheel from the PyTorch install selector. A ROCm torch reports
`torch.cuda.is_available() == True` and uses the device string `cuda`. The resolver tells
it apart from NVIDIA by `torch.version.hip`, and labels it `AMD ROCm`.

- On a multi-GPU host, pick a device with `HIP_VISIBLE_DEVICES`.
- `server/splat/splat_detect.ts` defaults `HIP_VISIBLE_DEVICES` to `1`, which is wrong on a
  single-GPU AMD box. Set it to `0`. See [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md#rocm-is-not-a-separate-branch-and-must-not-become-one).

### Apple Silicon (MPS) — unverified

The standard PyPI torch wheel includes MPS.

```bash
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision
```

- The panoptic and LingBot workers set `PYTORCH_ENABLE_MPS_FALLBACK=1`. An operator op that
  MPS lacks then falls back to CPU rather than aborting the run. Export a different value to
  override it.
- LingBot runs in fp32 on MPS. fp16 autocast is wired for CUDA and XPU only, because autocast
  on MPS has not been run in this repo.
- Spirula has no macOS build referenced here, so it is not an option on a Mac. Brush needs
  Metal. Untested.

### Intel GPU (XPU) — unverified

Install the Intel GPU driver first, then Intel's torch XPU wheel. PyTorch's Intel GPU guide
gives the stable command:

```bash
uv pip install --python ~/.venvs/cv-gpu/bin/python torch torchvision --index-url https://download.pytorch.org/whl/xpu
python3 -c "import torch; print(torch.xpu.is_available())"   # must print True
```

- The resolver reports `xpu (Intel XPU, fp32)`. fp32 is used until fp16 has been measured on
  Intel hardware. The reason is printed with the device.
- On a multi-GPU host, select the device with `ZE_AFFINITY_MASK` (the Level Zero selector).
  That is the standard Intel mechanism. It is not verified on this repo's hardware.
- Ollama on Intel uses its Vulkan path, which is experimental and opt-in:
  `OLLAMA_VULKAN=1 ollama serve`. Reports are mixed, so treat it as unverified.
- Brush and Spirula use Vulkan. Check that `vulkaninfo --summary` lists the Intel device;
  the capability probe reports the same thing.

### CPU only

Every worker degrades with a printed reason. Ollama and the panoptic and LingBot workers run
on CPU. Brush and Spirula are not usable on CPU.

## Check what a box will actually use

```bash
deno run --allow-read --allow-env --allow-run server/capabilities.ts
```

The torch line reports the accelerator: `cuda`, `rocm`, `mps`, `xpu` or `cpu`.

```bash
cd scripts && ~/.venvs/cv-gpu/bin/python -c "import torch; from _torch_device import resolve_torch_device as r; d = r(torch); print(d.label, '—', d.reason)"
```

## Environment variables

| Variable | What it does |
| --- | --- |
| `PANOPTIC_DEVICE` | Panoptic device: `auto` (default), `cpu`, `cuda`, `cuda:N`, `mps`, `xpu`. Read by `server/panoptic/panoptic_scan.ts` |
| `LINGBOT_MAP_DEVICE` | LingBot device: `auto`, `cpu`, `cuda`, `mps`, `xpu`. Read by `server/lingbot-map/lingbot_map.ts` |
| `PYTORCH_ENABLE_MPS_FALLBACK` | Set to `1` by the workers unless already exported. Unsupported MPS ops fall back to CPU |
| `HIP_VISIBLE_DEVICES` | AMD device selection (ROCm) |
| `ZE_AFFINITY_MASK` | Intel device selection (Level Zero) |
| `OLLAMA_VULKAN` | Ollama's experimental Vulkan path, for AMD and Intel |

`auto` is a request, not an answer. An unreachable backend is downgraded to CPU with a
reason. Read `params.resolvedDevice` and `params.deviceVendor` from the LingBot manifest to
see what ran.

## NVIDIA-only models, kept by design

- **4DAnyone** runs off-box on a CUDA device with at least 44 GiB. See ADR 0006 and
  [docs/pipelines/4d-person.md](../pipelines/4d-person.md).
- **SenseNova Recon3D** needs CUDA 12.x and FlashAttention, set up by
  `scripts/setup-sensenova-wsl.sh`. On a non-NVIDIA host leave `SENSENOVA_DIR` unset. The
  server then reports `skipped` with a remediation, and nothing crashes.

These are not ported. Making them run elsewhere would mean a different attention kernel and
different weights, which is a model decision, not a device one.

## Sources for the vendor install commands

- PyTorch Intel GPU guide: <https://docs.pytorch.org/docs/stable/notes/get_start_xpu.md>
- Ollama GPU documentation, Vulkan path: <https://docs.ollama.com/gpu>
