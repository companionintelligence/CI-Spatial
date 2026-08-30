<!--
This file is the target named by the two remediation strings in
server/capabilities.ts:384,394 and server/splat/splat_detect.ts:174,180
("see docs/splat-detect.md — Setup"). Those strings pointed at a file that did
not exist until this doc was written; keep the "## Setup" heading below so the
hint stays true.
-->

# splat-detect setup — splat_analyzer + OWLv2

`splat-detect` is the `WorldJob` that runs open-vocabulary 3D object detection over a
trained Gaussian splat. The driver (`server/splat/splat_detect.ts`) spawns the external
[splat_analyzer](https://github.com/nigelhartman/splat_analyzer) project's `run_local.py`
— render synthetic views → OWLv2 detection → lift 2D boxes to 3D → `interactions.json`.

The pipeline description lives in [pipelines/splat-toolbox.md](pipelines/splat-toolbox.md#detect--splat_analyzer);
the calibration plan lives in [pipelines/SPLAT_DETECT_ROADMAP.md](pipelines/SPLAT_DETECT_ROADMAP.md).
**This doc is only the install.**

## Setup

Verified end-to-end on `beta-1` (Ubuntu, RTX 4080 Laptop 12 GiB, driver 610.57.04,
CUDA 12.8 toolkit at `/usr/local/cuda-12.8`, no sudo used). Every command is user-local.

The driver's defaults are `~/.venvs/splat-analyzer/bin/python` and `~/splat_analyzer`.
Installing to exactly those two paths means **no env var is needed** — the capability
probe resolves both by fallback. Set `SPLAT_DETECT_PYTHON` / `SPLAT_DETECT_DIR` only if
you install elsewhere.

### 1. Clone the analyzer (14 MB)

```bash
git clone https://github.com/nigelhartman/splat_analyzer.git ~/splat_analyzer
```

### 2. A CUDA-capable host C++ compiler

`gsplat` compiles CUDA kernels, and **CUDA 12.8 refuses any host compiler newer than
gcc 14** — this box's default is gcc 15.2, which fails every `.cu` file with
`crt/host_config.h:143: error: #error -- unsupported GNU version!`. `/usr/bin/gcc-13`
exists here but has no matching `g++-13`, so the C++ half is unavailable. Get a matched
pair user-locally (~928 MB) rather than touching the system compiler:

```bash
export MAMBA_ROOT_PREFIX=~/.local/micromamba
~/.local/micromamba/bin/micromamba create -y -n cuda-hostcc -c conda-forge gxx_linux-64=13

mkdir -p ~/.local/cuda-ccbin
ln -sf ~/.local/micromamba/envs/cuda-hostcc/bin/x86_64-conda-linux-gnu-g++ ~/.local/cuda-ccbin/g++
ln -sf ~/.local/micromamba/envs/cuda-hostcc/bin/x86_64-conda-linux-gnu-gcc ~/.local/cuda-ccbin/gcc
```

### 3. The venv — on a Python that ships headers

Build against a **uv-managed CPython**, not `/usr/bin/python3.12`. The system 3.12 here
has no `Python.h` (`python3.12-dev` is not installed and installing it needs sudo), and
gsplat's `ext.cpp` fails with `fatal error: Python.h: No such file or directory`. The uv
build carries its own headers:

```bash
uv python install 3.12
uv venv --python ~/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12 \
        ~/.venvs/splat-analyzer
export VIRTUAL_ENV=~/.venvs/splat-analyzer
```

### 4. torch matched to the *toolkit*, then the rest

torch must match the nvcc that will compile gsplat — cu128 here, because the toolkit is
12.8. (The unrelated `~/.venvs/panoptic` env carries torch cu130; reusing it would put a
CUDA 13.0 torch in front of a 12.8 nvcc.)

```bash
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
grep -v '^gsplat' ~/splat_analyzer/requirements.txt > /tmp/req.txt
uv pip install -r /tmp/req.txt \
  --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple
```

### 5. gsplat — build it ahead of time, not JIT

Install gsplat **from source** so the extension lands as `gsplat/csrc.so` inside
site-packages:

```bash
export PATH=~/.local/cuda-ccbin:~/.venvs/splat-analyzer/bin:/usr/local/cuda-12.8/bin:$PATH
export CUDA_HOME=/usr/local/cuda-12.8
export TORCH_CUDA_ARCH_LIST=8.9        # RTX 4080 Laptop = compute capability 8.9
export CC=~/.local/cuda-ccbin/gcc CXX=~/.local/cuda-ccbin/g++ MAX_JOBS=16
uv pip install gsplat==1.5.3 --no-build-isolation --no-binary gsplat
```

Takes ~1m40s. **Do not skip `--no-binary gsplat`.** Without it gsplat installs in JIT
mode, where `gsplat/cuda/_backend.py` compiles the kernels at *import* time — and torch
re-runs that build check on every import: it aborts unless `ninja` is on `PATH` before it
will even consult its cache, and it hashes the nvcc arch flags into the cache key
(dropping `TORCH_CUDA_ARCH_LIST` changed `-gencode` to `compute_89,code=compute_89` and
triggered a full 2-minute rebuild instead of a cache hit). That makes the interpreter
depend on the whole build toolchain being present in whatever environment the Deno server
happens to spawn it with. The ahead-of-time build takes the first branch of
`_backend.py` (`from gsplat import csrc as _C`) and never touches ninja or nvcc again.

Confirm the bare interpreter works with *no* environment at all:

```bash
$ env -i HOME=$HOME PATH=/usr/bin:/bin ~/.venvs/splat-analyzer/bin/python -c \
  "import gsplat; from gsplat.cuda._backend import _C; import torch; \
   print(gsplat.__version__, _C is not None, torch.cuda.is_available())"
1.5.3 True True
```

### 6. Verify

```bash
$ deno run -A server/capabilities.ts | grep -iE "splat-detect"
  ok      splat-detect-python  3.12.14  /home/liam/.venvs/splat-analyzer/bin/python  (fallback)
          torch: 2.11.0+cu128 → cuda (cuda 12.8)
  ok      splat-detect-dir     /home/liam/splat_analyzer  (fallback)
  READY   splat-detect
```

Then a real run against a trained splat (`scans/sess-video-20260830-033839.splat.ply`,
37.5 MB, 246,838 gaussians from Brush):

```
[render] Renderer: gsplat  (device=cuda)
[render] Scene center=[-3.008 -0.813 -0.651], radius=9.050
[render] 5 positions × 6 azimuth × 3 elevation = 90 views  (batch=32, device=cuda)
[render] Done. Wrote 90 RGB + depth frames + transforms.json
[pipeline] Loading OWLv2 on cuda …
[pipeline] Done → …/interactions.json (0 objects)
```

28 s wall clock at `--quality medium`. OWLv2's weights
(`google/owlv2-base-patch16-ensemble`, 593 MB) download to `~/.cache/huggingface` on the
first run; the model id is hard-coded in `pipeline.py`, so there is no smaller option.

**0 objects is the correct answer for that fixture**, not a failure — the session it was
built from is a synthetic test scene of untextured grey boxes in a grey room, with no
furniture for the prompt to match. To confirm OWLv2 itself is live rather than silently
returning nothing, run it against one of the session's real keyframes:

```
$ … kf-00016.jpg, prompt ["a box", "a wall", "a floor"], threshold 0.15
device: cuda:0 | detections: 5
  a wall     score=0.416 box=[37.2, 2.5, 1017.1, 610.5]
  a floor    score=0.393 box=[209.4, 478.6, 1045.7, 812.6]
  …
```

### Disk

| Path | Size |
| --- | --- |
| `~/.venvs/splat-analyzer` | 7.1 GB |
| `~/.local/micromamba/envs/cuda-hostcc` | 928 MB |
| `~/.cache/huggingface/…/owlv2-base-patch16-ensemble` | 593 MB |
| `~/splat_analyzer` | 14 MB |

## Known driver/upstream mismatches

`server/splat/splat_detect.ts`'s header says its facts were "confirmed via run_local.py
--help on this box" — but they describe a **ROCm fork**, not upstream `main`
(`a3cd884`). Two of them do not hold, so a `splat-detect` job on this install still fails
even though the capability probe reports READY:

1. **`--renderer point` is not a real flag.** `buildDetectArgs()` always appends it;
   upstream's argparse has no `--renderer`, so the job dies before rendering:

   ```
   $ python run_local.py --ply … --quality low --renderer point --job_dir …
   run_local.py: error: unrecognized arguments: --renderer point
   ; exit 2
   ```

   The driver turns that into an `error` manifest reading `splat-analyzer exited 2`.
   Upstream picks the backend itself (`renderer: "auto"` in `config.py` → `gsplat` on
   CUDA, `gsplat-metal` on Apple), and `renderers/` contains only `gsplat_backend.py`
   and `gsplat_metal_backend.py` — there is no `point_backend.py` anywhere in the repo
   or its history. Dropping the two `--renderer point` args is all that is needed; the
   verified run above is exactly the driver's arg vector minus that flag.
   `POINT_SPLAT_SIZE` is likewise read by nothing upstream.

2. **`pointcloud_to_gs.py` does not exist upstream.** The LingBot point-cloud fallback
   path spawns `$SPLAT_DETECT_DIR/pointcloud_to_gs.py`; that file is not in the
   checkout, so the fallback can only ever produce a spawn error. The trained-splat path
   (the preferred one) is unaffected. `server/capabilities.ts:390` also advertises the
   dir as holding it.

Both need a change in `server/splat/splat_detect.ts`, which this doc's author did not
own — they are reported, not fixed.

`HIP_VISIBLE_DEVICES` (default `"1"`) is harmless here rather than wrong: it is a ROCm
variable that CUDA ignores, so the run lands on GPU 0. It is *not* an alias for
`CUDA_VISIBLE_DEVICES` — setting that to `1` on this single-GPU box would hide the only
device.

## Still uncalibrated

The thresholds ship at upstream's defaults (score 0.12 / votes 8 / peak 0.40) and remain
uncalibrated — see [SPLAT_DETECT_ROADMAP.md](pipelines/SPLAT_DETECT_ROADMAP.md) Phase 1.
The fixture available here cannot calibrate them: it has no furniture, and its 90
rendered views come out as near-featureless fog. Calibration needs a Brush-trained splat
of a real furnished room.
