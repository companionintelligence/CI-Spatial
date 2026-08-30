# LingBot-Map server processing

This document walks through the end-to-end integration between Companion-Scan
sessions and [LingBot-Map](https://github.com/Robbyant/lingbot-map) — a
feed-forward Geometric Context Transformer that produces a dense 3D
reconstruction from a stream of RGB keyframes.

The integration adds a new `lingbot-map-reconstruct` world-job type that
spawns a Python worker over a session's keyframe directory and lands three
sibling artifacts plus a quantised `.lingbot.glb` sidecar that the Companion
Scan Spatial Editor can load alongside the original SLAM scan.

## Architecture

```
Mobile app   ──upload .glb──►  Deno server  ──fork──►  scripts/lingbot_map_worker.py
   │                              │                          │
   └──stream keyframes──►  scans/sessions/<id>/         loads torch + LingBot-Map
                                  │                    runs streaming inference
                                  ▼                          │
                          world-job pipeline                 ▼
                                  │           writes lingbot-map.point-cloud.ply
                                  │                  lingbot-map.poses.json
                                  │                  lingbot-map.manifest.json
                                  ▼
                          PLY → GLB sidecar
                          (lingbot_map_glb.ts)
                                  │
                                  ▼
                       <scan>.lingbot.glb in SCANS_DIR
                                  │
                                  ▼
                          Spatial Editor overlay
                          (src/viewer/lingbot-map.ts)
```

## Files added by this integration

| File | Purpose |
|------|---------|
| `scripts/lingbot_map_worker.py` | Python entrypoint that runs LingBot-Map inference and writes the three sibling artifacts. |
| `server/lingbot-map/lingbot_map.ts` | Deno-side driver that spawns the Python worker, parses the result manifest, and emits the GLB sidecar. |
| `server/lingbot-map/lingbot_map_glb.ts` | PLY → quantised GLB POINTS primitive (via gltf-transform). |
| `lingbot_map_ply.ts` | Runtime-agnostic binary-LE PLY parser shared by server + browser. |
| `src/viewer/lingbot-map.ts` | Three.js loader that pulls the PLY + poses and overlays them under the selected scan. |
| `scripts/fetch-lingbot-test-video.mjs` | Downloads the CC-BY reference clip. |
| `scripts/make-lingbot-fixture.mjs` | Extracts keyframes via ffmpeg and synthesises the artifact triple. |
| `tests/mock-lingbot-map.spec.ts` | Playwright integration test + screenshot capture. |
| `lingbot_map.test.ts` | Deno unit tests for the spawn driver. |
| `lingbot_map_glb.test.ts` | Node `node:test` for the PLY → GLB pipeline. |

## Environment variables

| Var | Default | Used by |
|-----|---------|---------|
| `LINGBOT_MAP_PYTHON` | `python3` | Server, picks the python that has lingbot-map + torch installed. |
| `LINGBOT_MAP_MODEL_PATH` | (unset) | Path to the LingBot-Map checkpoint. If unset the worker emits a `skipped` manifest with a remediation hint. |
| `LINGBOT_MAP_SCRIPT` | `./scripts/lingbot_map_worker.py` | Override the worker location (useful for read-only deployments). |
| `LINGBOT_MAP_DEVICE` | `auto` | Torch backend to request (`auto`/`cpu`/`cuda`/`mps`). `auto` is a request, not an answer — `scripts/_torch_device.py` silently downgrades an unreachable backend to CPU, so read `params.resolvedDevice` and `params.deviceVendor` back out of the manifest to find out what actually ran. |

## Setup (one time, on the inference box)

Verified 2026-08-29 on the RTX 4080 Laptop box. Three things have to line up —
an interpreter with torch, the `lingbot_map` package, and the checkpoint — and
`scripts/lingbot_map_worker.py` gates on them **in that order**, so "checkpoint
missing" is not the first thing a half-installed box reports. Work down the list.

### 1. An interpreter that has torch

`LINGBOT_MAP_PYTHON` defaults to the bare name `python3`
(`server/lingbot-map/lingbot_map.ts`), which on this box resolves to
`/usr/bin/python3` — Python 3.14.4, no torch. That is the interpreter
`server/capabilities.ts` reports, and the reason its `lingbot-map-reconstruct`
row warns about a torchless python.

**Python 3.14 is not the blocker.** torch 2.13.0 publishes `cp314` and `cp314t`
manylinux wheels (checked against the PyPI JSON API). The blocker is that
`/usr/bin/python3` is the system interpreter, which nothing should install into.
Use a venv and point the env var at it:

```bash
uv venv --python 3.12 ~/.venvs/lingbot-map
VIRTUAL_ENV=~/.venvs/lingbot-map uv pip install torch==2.13.0 torchvision==0.28.0
```

`torchvision` is **not** in lingbot-map's `pyproject.toml`, but
`lingbot_map/utils/load_fn.py` imports it — install the package without it and
`load_and_preprocess_images`, one of the three symbols the worker imports, fails
with `No module named 'torchvision'`.

Both installs finished in under two seconds here: uv hardlinks out of a cache
that already held torch 2.13.0 from `~/.venvs/panoptic`, so `du -sh` reports
4.9 GB for the venv while the incremental disk cost is near zero. Budget ~5 GB
of download on a cold cache.

Measured result: `torch 2.13.0+cu130`, `torch.cuda.is_available() == True`,
`NVIDIA GeForce RTX 4080 Laptop GPU`.

### 2. The lingbot-map package

```bash
git clone https://github.com/Robbyant/lingbot-map ~/lingbot-map
VIRTUAL_ENV=~/.venvs/lingbot-map uv pip install -e ~/lingbot-map
```

The clone is 444 MB — 18 MB of that is the paper PDF and 203 MB is `example/`,
neither of which the worker touches.

### 3. The checkpoint

`huggingface.co/robbyant/lingbot-map` is public and ungated: no login, no
licence click-through, no `HF_TOKEN`. It publishes three reconstruction
checkpoints and one sky-segmentation ONNX. There is **no smaller variant** of the
reconstruction weights — all three are ~4.3 GiB, and `skyseg_batch.onnx` is a sky
mask used only by upstream's `demo.py`, never by this worker.

| File | Size | sha256 (HF LFS oid) | Use |
|------|------|---------------------|-----|
| `lingbot-map.pt` | 4,632,303,465 B (4.31 GiB) | `ee665103348e07e6b826d529b8e61de8f413d5432a4f2e84970d6c8fd2e1cd72` | Balanced — upstream's paper/benchmark default. Start here. |
| `lingbot-map-long.pt` | 4,632,303,465 B (4.31 GiB) | `832bc82cbae0bc9bbe946ef5ee1f7226abd8c0e183ccf8beddbb3d133576f409` | Long sequences / large scenes |
| `lingbot-map-stage1.pt` | 4,762,944,015 B (4.44 GiB) | `d95c8d8ac35cff8ed43033045940c6420173297ec6b4e5baa4a415164b2bf246` | Stage-1 weights, loadable into VGGT for bidirectional inference |
| `skyseg_batch.onnx` | 175,997,119 B (168 MiB) | `b09c0f6cf79e1caa2591b946b659487bd7c8208caddd3f80680cbb169617e378` | Not used by this pipeline |

```bash
huggingface-cli download robbyant/lingbot-map lingbot-map.pt --local-dir ~/models/lingbot-map
```

Direct URL, if you would rather not use the CLI:
`https://huggingface.co/robbyant/lingbot-map/resolve/main/lingbot-map.pt`

### 4. Point the server at both

```bash
export LINGBOT_MAP_PYTHON=~/.venvs/lingbot-map/bin/python
export LINGBOT_MAP_MODEL_PATH=~/models/lingbot-map/lingbot-map.pt
```

`LINGBOT_MAP_MODEL_PATH` names a **file**, not a directory — `capabilities.ts`
probes it as `kind: 'file'` and the worker checks it with `os.path.exists`.

## Known blocker: the worker does not match upstream's API

Steps 1 and 2 above are done on this box and verified. Step 3 was deliberately
**not** done, because the checkpoint cannot unblock anything yet:
`scripts/lingbot_map_worker.py` imports and loads a LingBot-Map that the
published upstream does not have, and its import gate runs *before* the
checkpoint gate.

Run against the known-good fixture (`sess-video-20260830-033839`, 32 keyframes),
copied out of `scans/sessions/` first because the worker writes into the session
directory, with a fully installed torch + lingbot-map venv:

```
$ ~/.venvs/lingbot-map/bin/python scripts/lingbot_map_worker.py \
    --session-dir <copy>/sess-video-20260830-033839 \
    --model-path ~/models/lingbot-map/lingbot-map.pt
[lingbot-map] lingbot_map import failed: No module named 'lingbot_map.models.lingbot_map'
```

and the same result through the Deno driver
(`runLingBotMapReconstruction`, `LINGBOT_MAP_PYTHON` set to the venv):

```json
{
  "status": "skipped",
  "skippedReason": "lingbot_map import failed: No module named 'lingbot_map.models.lingbot_map'",
  "exitCode": 0
}
```

Three separate mismatches, all in `scripts/lingbot_map_worker.py`:

1. **The class does not exist.** The worker does
   `from lingbot_map.models.lingbot_map import LingBotMap`. Upstream has no
   `lingbot_map/models/lingbot_map.py`; the model is `GCTStream`, defined three
   times over in `models/gct_stream.py`, `models/gct_stream_window.py` and
   `models/gct_stream_window_v2.py` — `demo.py` picks between the first two on a
   `--mode streaming|windowed` flag. The worker's other two imports,
   `utils/load_fn.load_and_preprocess_images` and
   `utils/pose_enc.pose_encoding_to_extri_intri`, are correct and import cleanly.

2. **`from_pretrained` is the wrong loader for a `.pt` checkpoint.**
   `GCTBase` does inherit `PyTorchModelHubMixin`, so `from_pretrained` exists —
   but it takes a repo id or a HubMixin-format directory, and the HF repo ships
   raw `.pt` state dicts with no `config.json`. Pointing it at the documented
   `LINGBOT_MAP_MODEL_PATH` shape raises
   `HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name'`.
   Upstream constructs the model explicitly and then
   `torch.load(path, map_location=device, weights_only=False)` →
   `load_state_dict(ckpt.get("model", ckpt), strict=False)`.

3. **The default construction path demands FlashInfer.** Calling
   `GCTStream.from_pretrained('robbyant/lingbot-map')` gets as far as building
   the model and then raises
   `RuntimeError: FlashInfer is not available. Please install flashinfer.`
   `demo.py` avoids this by passing `use_sdpa=True`, which the worker would have
   to do too (or flashinfer becomes a fourth install step).

A fourth issue is latent rather than blocking: the worker runs
`model(images)` under a bare `torch.no_grad()` in fp32. Upstream's `demo.py`
runs under `torch.amp.autocast("cuda", dtype=torch.bfloat16)` *and* casts the
aggregator trunk to bf16, with a comment putting the saving at 2–3 GB. fp32
weights alone are 4.3 GiB and this GPU has 12,282 MiB, so 32 frames at 518 px
are likely to OOM even once the loader is fixed.

The output contract, by contrast, is fine: `forward()` returns exactly the
`pose_enc` / `world_points` / `world_points_conf` keys the worker reads. It
returns `images` where the worker looks for `rgb`, but the worker already falls
back to the preprocessed image tensor, so colours survive.

## Triggering a reconstruction from the editor

1. Open the Companion Scan Spatial Editor (`/editor?project=<id>`).
2. Select a scan that has streamed keyframes.
3. In the right drawer, use **Reconstruct**. It queues the
   `LingBot-Map reconstruct` step for the selected scan.

![Legacy advanced-queue screenshot](lingbot-map/screenshots/viewer-job-dropdown.png)

4. Confirm the reconstruction action.

![Job dropdown with LingBot-Map selected](lingbot-map/screenshots/viewer-job-dropdown-selected.png)

5. Watch the job pane — the local coordinator transitions
   `queued → processing → completed`. When `status === 'ok'`, the job
   surfaces two artifacts in its detail row:
   - `lingbot-map-reconstruction` (manifest + PLY + poses)
   - `lingbot-map-glb` (the optimised `.lingbot.glb` sidecar)

6. Switch to the **Layers** tab. The new `LingBot-Map Reconstruction`
   section starts empty until a reconstruction lands.

![Layers panel — controls visible, awaiting a run](lingbot-map/screenshots/viewer-lingbot-panel.png)

7. After the job completes the panel reports the point + pose counts and
   the toggles drive overlay visibility on the selected scan without a
   reload.

![Layers panel — overlay loaded](lingbot-map/screenshots/viewer-lingbot-panel-loaded.png)

## Triggering a reconstruction from curl

```bash
curl -X POST http://localhost:8000/worlds/default/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"lingbot-map-reconstruct","scanId":"<scanId>"}'
```

The server enqueues the job and returns immediately. Subscribe to
`/events` (WebSocket) to receive `world-job-update` frames as the worker
progresses.

## Artifact layout

After a successful run the session directory contains:

```
scans/sessions/<sessionId>/
├── kf-00000.jpg            …
├── keyframes.jsonl         ←  input keyframe metadata (provenance)
├── lingbot-map.point-cloud.ply
├── lingbot-map.poses.json
└── lingbot-map.manifest.json
```

And alongside the source scan:

```
scans/
├── <scan>.glb              ←  original SLAM scan from the mobile app
├── <scan>.opt.glb          ←  optimize-scan output (existing pipeline)
├── <scan>.lod1.glb         ←  optimize-scan LOD (existing pipeline)
└── <scan>.lingbot.glb      ←  LingBot-Map POINTS primitive (this integration)
```

The `.lingbot.glb` carries the reconstruction's point count + session id in
the asset.extras `lingbotMap` block, so a re-loaded scene can re-attach
provenance without re-fetching the manifest.

## Skipping / error contract

The Python worker is intentionally graceful: every run writes
`lingbot-map.manifest.json`, even when it skipped or errored. The job-pane
artifact carries the explanation:

| `status` | When | UI shows |
|----------|------|----------|
| `ok` | Inference produced a point cloud | Point + pose counts + sidecar GLB link |
| `skipped` | torch / lingbot_map not importable, model checkpoint missing, or no keyframes | The `skippedReason` and a `remediation` hint |
| `error` | Inference crashed | Exception class + message + tail of traceback |

## Tests

Three layers of test coverage:

```bash
# Deno unit tests — spawn surface + validation gates
deno test --allow-read --allow-write --allow-env --allow-run lingbot_map.test.ts

# Node unit tests — PLY parser + GLB builder
npm run test:lingbot:glb

# Playwright integration — fixture session + UI + screenshots
npm run test:lingbot:fetch-video     # one-off
npm run test:lingbot:make-fixture    # one-off
API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
  npx playwright test --project=chromium-mock mock-lingbot-map
```

## Test video provenance

`scripts/fetch-lingbot-test-video.mjs` downloads
**Big Buck Bunny** (© 2008 Blender Foundation), licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
Primary source: `download.blender.org`; fallback:
[Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm).
The clip is not redistributed by this repository; it is fetched on demand
when a contributor opts into the integration test.

For more physically meaningful reconstructions, set `SOURCE_URL` to any CC0
indoor walkthrough (a LingBot-Map example scene works well) before running
the fetch script.

## Limitations

- The Python worker has not yet been wired into the optimisation pipeline.
  When the source scan's `.opt.glb` is rebuilt, the `.lingbot.glb` sidecar
  remains valid but is not merged into the optimised file.
- `cameraToWorld` matrices in `lingbot-map.poses.json` are in the LingBot-Map
  output frame, not Companion-Scan's ENU/Y-up world frame. The viewer renders
  them under the selected scan's transform — gizmo edits move both together,
  but cross-scan alignment requires an `align-scan` pass.
- Quantising the GLB at 14 bits/position is fine for indoor scans but starts
  to clip detail past ~30 m walkthroughs. Override via a future
  `quantize: 16` option on the GLB build call if needed.
