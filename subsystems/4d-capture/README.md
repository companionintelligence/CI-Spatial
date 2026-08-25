# 4D Capture

The off-box worker that turns a **take** — one or more clips of a person, recorded by
Companion Scan — into a playable 4D Gaussian-splat sequence.

It runs [4DAnyone](https://github.com/ant-research/4DAnyone) when a take has only one clip,
skips it when the take has real cameras, and trains one splat per timestep either way.

```
POST /takes            submit a take (idempotent on takeId)
GET  /takes/:takeId    status: queued | running | ok | skipped | error
GET  /takes/:takeId/sequence   the finished frame list + manifest
```

## Confidence levels

Read this before trusting anything below.

| Part | Status |
| --- | --- |
| The service, take lifecycle, and idempotent submit | **Verified** by `npm test` |
| Frame-set slicing from clips + `cameras.json` | **Verified** against synthetic inputs |
| Stub mode | **Verified** — produces a real, loadable `.sog`/`.ply` sequence |
| 4DAnyone invocation (arg assembly, output parsing) | **Unverified against the real model.** Written against its documented CLI and output layout; the arg builder is unit-tested, the actual run is not |
| Brush per-timestep training | **Unverified in this context.** Reuses the conventions `server/splat/splat_train.ts` already ships, which *are* proven — but not at sequence scale |
| End-to-end on real hardware | **Never run.** See below |

**Nothing here has executed a real 4DAnyone inference**, because no host on the fleet can.
That is a stated limitation, not an oversight: `npm run stub` exists precisely so the rest of
the pipeline — capture, upload, the job, playback — is real and testable regardless.

## Hardware requirements

4DAnyone's own measurements (`docs/inference_performance.md` upstream), 6-view full orbit:

| GPU | Backend | Denoising | Peak CUDA allocated |
| --- | --- | ---: | ---: |
| H200 | FlashAttention-3 | 7.8 min | 43.3 GiB |
| H20-3E | FlashAttention-3 | 16.6 min | 43.3 GiB |
| RTX A6000 | SDPA | 22.9 min | 43.3 GiB |

So: **a CUDA GPU with ≥44 GiB, on one device.** It does not shard across two cards, and it is
a CUDA stack (FlashAttention-3, GVHMR, ViTPose, SMPL-X). Upstream lists "Low-memory inference
(<32 GB)" as *not done*.

Probed on this tailnet 2026-08-24: `beta-1` is 2× Radeon RX 7900 XTX at 23.98 GiB each on
ROCm 6.4 with no CUDA; `beta-red` is a 10 GiB RTX 3080. **No host qualifies.** Add one, point
`FDANYONE_HOST` at this service, and the appliance's skip path becomes the real path with no
other change.

## Licensing — read before deploying

The 4DAnyone *code* is Apache-2.0, but the shipped weights are mixed:

- **GVHMR** (`gvhmr_siga24_release.ckpt`) — a **mandatory** pipeline stage — is under a
  research/non-profit licence that **excludes commercial use**.
- **YOLOv8** (`yolov8x.pt`) is AGPL-3.0.
- **VGG-19** is CC BY 4.0 (attribution).

Companion Scan ships under a commercial licence. **This is unresolved**, and it is why the
model download is an explicit opt-in step rather than automatic on first run. Do not deploy
this into a commercial product without settling it. See ADR 0006.

## Setup

```bash
# 1. The service itself (no dependencies beyond Node ≥22)
cd subsystems/4d-capture && npm install

# 2. Stub mode — no GPU, no 4DAnyone, produces a real loadable sequence
npm run stub

# 3. Real mode: install 4DAnyone somewhere with a ≥44 GiB CUDA GPU
git clone https://github.com/ant-research/4DAnyone && cd 4DAnyone
conda create -n 4danyone python=3.11 -y && conda activate 4danyone
pip install -r requirements.txt
python scripts/download_smplx.py && python scripts/download_model.py   # see Licensing

# 4. Point the service at it and run
FDANYONE_DIR=~/4DAnyone \
FDANYONE_PYTHON=~/miniconda3/envs/4danyone/bin/python \
BRUSH_BIN=~/brush/src/target/release/brush-cli \
npm run serve
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `9040` | Listen port |
| `FDANYONE_DIR` | unset | 4DAnyone checkout. Unset ⇒ the densify stage reports `skipped`, never `error` |
| `FDANYONE_PYTHON` | `python3` | Interpreter for `inference.py` |
| `BRUSH_BIN` | `~/brush/src/target/release/brush-cli` | Per-timestep splat trainer |
| `BRUSH_DEVICE` | `DiscreteGpu(1)` | wgpu adapter pin, forwarded as `CUBECL_WGPU_DEFAULT_DEVICE` — **not** a HIP id |
| `BRUSH_TRAIN_ITERS` | `3000` | Lower than the 15000 a static scan uses: this is multiplied by the timestep count |
| `WORK_DIR` | `./work` | Scratch and output |
| `STUB_MODE` | `0` | `1` (or `--stub`) produces a synthetic sequence with no GPU |

## Why the appliance never depends on this

Every failure mode here maps to `skipped` with a remediation string on the Companion Scan
side, never to a failed job — the same contract `BRUSH_BIN` and `LINGBOT_MAP_*` already use.
A Companion Scan install with no `FDANYONE_HOST` set works exactly as it did before this
subsystem existed; person clips are captured and stored, and reconstruction simply reports
that no host is configured.
