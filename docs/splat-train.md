# Splat training (Brush)

This document walks through the end-to-end integration between Companion-Scan
sessions and [Brush](https://github.com/ArthurBrussee/brush) — a fast,
cross-platform Gaussian-splat trainer that runs headless on `wgpu`.

The integration makes the reserved `splat-train` world-job type real: it
converts a scan's keyframe session into a Nerfstudio dataset, spawns the Brush
CLI over it, lands the exported INRIA 3DGS `.ply` as a scan sidecar, and
surfaces it as an auto-loading **Trained Splat** layer in the world editor.

## Architecture

```
Mobile app   ──upload .glb──►  Deno server  ──fork──►  brush-cli (Brush)
   │                              │                          │
   └──stream keyframes──►  scans/sessions/<id>/         trains Gaussian splat
                                  │                    on wgpu (GPU1 pin)
                                  ▼                          │
                          world-job pipeline                 ▼
                          (_runSplatTrainJob)         exports splat_{iter}.ply
                                  │                          │
                    session → Nerfstudio dataset             ▼
                    (splat_train_dataset.ts)      copy to SCANS_DIR as
                                  │               <base>.splat.ply + manifest
                                  ▼                          │
                          <base>.splat.ply in SCANS_DIR      │
                                  │◄─────────────────────────┘
                                  ▼
                          Desktop viewer splat layer
                          (src/viewer/splat-layer.ts →
                           splat-viewer.ts → SplatMesh)
```

## Files added by this integration

| File | Purpose |
|------|---------|
| `splat_train_dataset.ts` | Session → Nerfstudio `transforms.json` converter (pure, Deno-runnable, unit-tested). Reads `keyframes.jsonl` + `kf-*.jpg`, derives per-frame intrinsics, builds c2w matrices, links images, seeds init from a LingBot-Map point cloud when present. |
| `splat_train.ts` | Deno-side driver that builds the dataset, spawns `brush-cli`, locates the exported `.ply`, lands it, and writes a `splat-train` manifest (mirrors `lingbot_map.ts`). |
| `src/viewer/splat-layer.ts` | Viewer loader that discovers a scan's splat manifest and loads the served `.ply` into a SparkJS `SplatMesh` under the selected scan. |
| `scripts/make-splat-fixture.mjs` | Synthesises a valid 3DGS `.ply` + manifest fixture for the integration test (Brush can't run in CI). |
| `tests/mock-splat-train.spec.ts` | Playwright integration test + screenshot capture. |
| `splat_train.test.ts` | Deno unit tests for the driver + dataset converter. |

## Environment variables

| Var | Default | Used by |
|-----|---------|---------|
| `BRUSH_BIN` | `~/brush/src/target/release/brush-cli` | Server — the Brush CLI binary. If missing/unrunnable the job records a `skipped` manifest with a remediation hint. |
| `BRUSH_DEVICE` | `DiscreteGpu(1)` | Server — forwarded as `CUBECL_WGPU_DEFAULT_DEVICE`. Selects the wgpu adapter (**not** HIP). `DiscreteGpu(1)` targets the non-Ollama 7900 XTX and avoids the `llvmpipe` software adapter. |
| `BRUSH_TRAIN_ITERS` | `15000` | Total training iterations. |
| `BRUSH_SH_DEGREE` | `2` | Spherical-harmonic degree of the splats. |
| `BRUSH_MAX_RES` | `1280` | Max image resolution loaded into training. |

## Setup (one time, on the inference box)

```bash
# 1. Build Brush (Rust). See the Brush README for prerequisites.
git clone https://github.com/ArthurBrussee/brush ~/brush
cd ~/brush/src && cargo build --release --bin brush-cli

# 2. Point the Deno server at the binary (default already assumes this path).
export BRUSH_BIN=~/brush/src/target/release/brush-cli

# 3. Pin the GPU adapter (wgpu-native selector, NOT HIP_VISIBLE_DEVICES).
export BRUSH_DEVICE="DiscreteGpu(1)"

# Sanity-check the flags the driver relies on:
brush-cli --help
```

## Data path — session → Nerfstudio dataset

`splat_train_dataset.ts` writes a `brush-dataset/` subdirectory inside the
session:

```
scans/sessions/<id>/brush-dataset/
├── transforms.json     fl_x/fl_y/cx/cy/w/h + frames[] (file_path + 4×4 c2w)
├── images/kf-*.jpg     symlinked (fallback: copied) from the session
└── sparse_pc.ply       (optional) copy of lingbot-map.point-cloud.ply for init
```

Convention notes baked in from the spike:

- **No axis flip.** Companion-Scan / WebXR / three.js poses are already in the
  OpenGL/Blender camera-to-world convention Nerfstudio expects. The pose
  position + quaternion drop straight into the 4×4 `transform_matrix`.
- **Real image dims.** Frame width/height are read from the actual JPEG's
  Start-Of-Frame marker, never trusted from `keyframes.jsonl` (the phone
  downscales frames, so the recorded dims can drift). `fl_x`/`fl_y` are derived
  from the recorded vertical FOV (or client `fx`/`fy`) scaled to real pixels.
- **Seeded init.** When a prior `lingbot-map-reconstruct` job left a
  `lingbot-map.point-cloud.ply`, it is copied in as `sparse_pc.ply` and
  referenced from `transforms.json` (`ply_file_path`). Brush's PLY importer
  accepts a plain xyz(+rgb) cloud as SfM init; otherwise Brush random-inits
  inside the camera frustums.

## Brush invocation

```
brush-cli <brush-dataset/> \
  --total-train-iters $BRUSH_TRAIN_ITERS \
  --sh-degree $BRUSH_SH_DEGREE \
  --max-resolution $BRUSH_MAX_RES \
  --export-every $BRUSH_TRAIN_ITERS \
  --export-path <brush-dataset/exports> \
  --export-name splat_{iter}.ply \
  --eval-every $BRUSH_TRAIN_ITERS
```

The positional dataset argument auto-disables Brush's GUI (headless). The GPU
is pinned via `CUBECL_WGPU_DEFAULT_DEVICE=$BRUSH_DEVICE` in the child's env.
Brush does not write a manifest — the driver counts gaussians from the exported
PLY header and writes the `splat-train` manifest itself.

## Triggering a training run from the editor

1. Open the world editor (`/viewer.html?world=<slug>`).
2. Select a scan that has streamed keyframes.
3. Switch to the **World** tab. The Processing Queue dropdown includes the
   `Splat train` entry.

![Job dropdown with Splat train selected](screenshots/viewer-job-dropdown-splat.png)

4. Pick `Splat train` and click **Queue Job**. The local coordinator
   transitions `queued → processing → completed`. On success the job surfaces a
   `splat-ply` artifact (the `.ply` + gaussian count + manifest link).
5. Switch to the **Layers** tab. The **Trained Splat** section reports the
   gaussian count and the toggle drives the splat's visibility on the selected
   scan without a reload.

![Layers panel — Trained Splat controls](screenshots/viewer-splat-panel.png)
![Layers panel — trained splat loaded](screenshots/viewer-splat-panel-loaded.png)

## Triggering a training run from curl

```bash
curl -X POST http://localhost:8000/worlds/default/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"splat-train","scanId":"<scanId>"}'
```

Subscribe to `/events` (WebSocket) for `world-job-update` frames.

## Artifact layout

After a successful run the scan directory contains:

```
scans/
├── <base>.glb                       ←  original SLAM scan from the mobile app
├── <base>.splat.ply                 ←  trained Gaussian splat (this integration)
├── <base>.compressed.ply            ←  optional compressed variant (if Brush emits one)
└── <base>.splat-train.manifest.json ←  run index: status/gaussianCount/params/timing
```

and inside the session:

```
scans/sessions/<sessionId>/brush-dataset/…   ←  the Nerfstudio dataset Brush trained on
```

All three sidecars are served through the gated `/scans/…` route via a suffix
allowlist (`.splat.ply`, `.compressed.ply`, `.splat-train.manifest.json`), with
the same path-traversal guard as the `.glb` route.

## Skipping / error contract

The driver never hard-crashes the server; every run writes a manifest:

| `status` | When | UI shows |
|----------|------|----------|
| `ok` | Brush produced a `.ply` | Gaussian count + splat layer link |
| `skipped` | `BRUSH_BIN` missing/unrunnable, or the scan has no keyframes | `skippedReason` + a `remediation` hint |
| `error` | Dataset build failed, Brush exited non-zero, or no `.ply` was exported | Error message + stderr tail |

## Tests

```bash
# Deno unit tests — driver validation, arg assembly, dataset converter, skip fallback
npm run test:splat:unit

# Playwright integration — synthetic fixture + UI + screenshots
npm run test:splat:make-fixture      # one-time (re-run after edits)
API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
  npx playwright test --project=chromium-mock mock-splat-train
```

The Playwright fixture is fully synthetic: `scripts/make-splat-fixture.mjs`
writes a valid INRIA 3DGS `.ply` and the `<base>.splat-train.manifest.json` the
world job would have written. The real trainer is a GPU binary that can't run
in CI, but the served-`.ply` → `SplatMesh` data path is identical to a real run.

## Limitations

- A real end-to-end Brush training run has **not** been exercised in CI —
  feasibility was proven by a manual spike (a training run produced a valid
  `.ply` on this box). The integration wiring, dataset conversion, artifact
  serving, and viewer load are all tested; the actual `brush-cli` spawn is
  covered only by the synthetic fixture + the injected-spawn unit test.
- The trained splat is attached under the scan's root transform, so gizmo edits
  move it with the scan, but the splat's own world frame is Brush's — precise
  cross-scan alignment still needs an `align-scan` pass.
- Brush does not emit a compressed PLY by default; the `.compressed.ply` sidecar
  is best-effort (only landed if a compressed variant appears in the export dir).
