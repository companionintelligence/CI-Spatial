# COLMAP setup

Operator notes for the `colmap-poses` stage
([`docs/pipelines/colmap-poses.md`](../pipelines/colmap-poses.md) explains what
the stage does and why). This file records how COLMAP gets onto a box without
sudo, and — because it is the thing that costs the most time — why `which
colmap` failing does **not** mean COLMAP is missing.

## `which colmap` is the wrong check

On the current dev box `which colmap` returns nothing and COLMAP 3.13.0 is
installed and working. The supported install is a micromamba env, and a
micromamba env is not on `PATH` unless you activate it. `resolveColmapBin()`
(`server/colmap/colmap_poses.ts:107`) already knows this — it falls back to
`~/.local/micromamba/envs/colmap/bin/colmap` — so the pipeline runs fine while
every by-hand check reports "not installed".

Check like the server does:

```bash
ls ~/.local/micromamba/envs/colmap/bin/colmap && \
  ~/.local/micromamba/envs/colmap/bin/colmap -h | head -2
```

On this box that prints `COLMAP 3.13.0 -- ... (Commit Unknown on Unknown with
CUDA)`.

**Do not symlink it onto `PATH`.** It would work (conda-forge binaries use
`$ORIGIN`-relative RPATH, which glibc resolves through symlinks), but the
fallback already covers it and the manifest is better without it: the resolver
writes the *absolute* path it ran into `colmap-poses.manifest.json`'s
`params.colmapBin`, so an operator reading a manifest can re-run the exact
binary by hand. If `colmap` resolves on `PATH`, manifests record the useless
string `colmap` instead. Use `COLMAP_BIN` if you need to point at a different
build.

## Installing it (no sudo, ~5 min, no compiling)

The env on this box was created with:

```bash
# micromamba itself, if absent — a single static binary, no sudo
"${SHELL}" <(curl -L micro.mamba.pm/install.sh)      # installs to ~/.local/micromamba

~/.local/micromamba/bin/micromamba create -y -n colmap -c conda-forge colmap
```

That is the whole install. conda-forge ships a **prebuilt CUDA binary**
(`colmap-3.13.0-cuda_129h1e19e12_4`) with Ceres, Eigen, FLANN and the CUDA
runtime bundled — nothing is compiled locally. Building COLMAP from source
instead means Ceres + Eigen + FLANN + SQLite + Qt and a 20–60 min compile; do
not, when a 5-minute prebuilt package exists.

Cost on disk: 2.0 GB for the env plus 938 MB of package cache
(`~/.local/micromamba/pkgs`, safe to delete afterwards with `micromamba clean
-a`).

The CUDA build runs fine on a CPU-only host — CUDA is loaded lazily and the
pipeline asks for CPU features anyway (see below), so there is no reason to
hunt for a separate CPU-only package.

## What the pipeline actually needs

`runColmapPoses()` shells out to three subcommands — `feature_extractor`,
`exhaustive_matcher`, `mapper` (the last one twice; the two-pass mapper is
deliberate, see `colmap_poses.ts:20`). No GUI, no dense stage, no `patch_match_stereo`,
so a headless build with no Qt is sufficient.

Every option spelling the code passes was checked against this build's own
`-h` output and all are accepted:

| Subcommand | Options the code passes |
|---|---|
| `feature_extractor` | `--ImageReader.single_camera`, `--ImageReader.camera_model`, `--FeatureExtraction.type`, `--FeatureExtraction.use_gpu`, `--SiftExtraction.max_image_size` |
| `exhaustive_matcher` | `--FeatureMatching.type`, `--FeatureMatching.use_gpu` |
| `mapper` | `--Mapper.init_min_num_inliers`, `--Mapper.abs_pose_min_num_inliers`, `--Mapper.min_num_matches`, `--Mapper.init_min_tri_angle`, `--Mapper.tri_min_angle` |

The 3.12 option-namespace move (`max_image_size` stayed under `SiftExtraction`
while `type`/`use_gpu` moved to `FeatureExtraction`) is the one that bites, and
it is already handled — `colmap_poses.ts:247` records what the wrong spelling
looked like.

## GPU is off on purpose, and it is not the bottleneck

`USE_GPU = '0'` is hardcoded (`colmap_poses.ts:81`) because GPU feature
extraction needs a display on most hosts. On *this* box that is pessimistic —
`--FeatureExtraction.use_gpu 1` runs headless against the RTX 4080 and exits 0
— but nothing here is slow enough to be worth trading portability for: a
17-frame session solves in **5.9 s wall** end to end on CPU. Revisit only if a
capture arrives with hundreds of frames, and then via `COLMAP_BIN`-style env
config rather than by flipping the constant.

## Verified on this box, 2026-08-29

```bash
deno run -A <runner calling runColmapPoses({ sessionDir })>  # 17 keyframes
```

Result: `status: "ok"`, 5.9 s, binary resolved through the fallback to
`/home/liam/.local/micromamba/envs/colmap/bin/colmap`, poses and seed cloud
written. `deno test -A tests/unit/deno/colmap_poses.test.ts` — 27 passed.

**But the reconstruction was degenerate: 3 of 17 images registered, 1
triangulated point.** That is a capture problem, not a tool problem. The
keyframes in `scans/sessions/sess-a7e2f642-…` are a dim room shot at 720×960,
and COLMAP found only ~50–330 SIFT features per frame — too few, and too poorly
distributed, to establish a baseline. Note the images are *below*
`COLMAP_MAX_IMAGE_SIZE` (1600), so no downscaling was involved; the frames are
simply dark and low-texture.

So COLMAP being installed does not by itself make the gimbal grid-capture path
produce a usable model. The next thing to fix is capture quality — brighter
scene, more texture, real translation between shots — not the solver. A run
that registers a handful of images out of many still reports `status: "ok"`;
read `registeredImages` against `frameCount` in the manifest before trusting a
result.
