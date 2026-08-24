# Splat toolbox

The **Splat Toolbox** is the set of tools that turn a Companion-Scan capture
session into a viewable, trainable, and queryable 3D Gaussian-splat scene. Each
tool is a thin Deno/Node driver over a proven external engine, wired into the
Companion Scan Spatial Editor as a job type (or exposed as a script). This document is the
inventory: what each tool is, when you reach for it, and how to drive it from
the **editor UI**, from a **scanner/session**, and from **curl**.

All the trained/derived artifacts land next to the scan in `SCANS_DIR` as
sidecars (`<base>.splat.ply`, `<base>.splat-train.manifest.json`,
`<base>.interactions.json`, `<base>.splat-detect.manifest.json`), and are served
back through the `/scans/:filename` routes the Spatial Editor already understands.

---

## Tools at a glance

| Tool | Engine | Job type / entry point | Produces |
|------|--------|------------------------|----------|
| **View** | SparkJS (`@sparkjsdev/spark`) | viewer splat layer | in-browser 3DGS render |
| **Train** | [Brush](https://github.com/ArthurBrussee/brush) (wgpu) | `splat-train` world job | `<base>.splat.ply` (+ manifest) |
| **Finish** | [@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform) | `splat-finish` world job (auto-chained after train) | `<base>.sog` + `<base>.compressed.ply` (+ manifest) |
| **Detect** | [splat_analyzer](#detect--splat_analyzer) + OWLv2 | `splat-detect` world job | `<base>.interactions.json` (+ manifest) |
| **Ingest video** | ffmpeg (+ adaptive fps + blur gate) | `scripts/ingest-video.mjs` / `POST /ingest-video` | keyframe session (pose-less) |
| **Ingest photos** | sharp/jimp (+ EXIF ordering + blur gate) | `scripts/ingest-photos.mjs` / `POST /ingest-photos` | keyframe session(s) (pose-less) |

### GPU placement (beta-1, 2× RX 7900 XTX)

Placement differs by engine, and **the HIP device numbering is inverted vs
`rocm-smi`** — do not trust the index you read off `rocm-smi` for the pin:

| Engine | Pin env | Value on this box |
|--------|---------|-------------------|
| Brush (train / compress) | `CUBECL_WGPU_DEFAULT_DEVICE` | wgpu adapter index |
| splat_analyzer torch/HIP (detect) | `HIP_VISIBLE_DEVICES` | `1` |

Unpinned Ollama has OOM'd torch jobs; keep the pins explicit when running detect
alongside a warm model.

---

## View — SparkJS

**What:** renders a trained `<base>.splat.ply` in the Spatial Editor as a
**Trained Splat** layer under the owning scan, using SparkJS's `SplatMesh`.

**When:** any time a scan has a `splat-train` manifest with `status: ok`.

**How**
- **Editor:** open the scan; the splat layer auto-discovers the manifest and
  loads the served `.ply` (`src/viewer/splat-layer.ts` → `splat-viewer.ts`).
- **curl:** `curl $BASE/scans/<base>.splat-train.manifest.json` to confirm a
  splat exists, then `GET /scans/<base>.splat.ply` for the geometry.

See `splat-train.md` for the full viewer wiring.

---

## Train — Brush

**What:** converts a scan's keyframe session into a Nerfstudio dataset and spawns
the Brush CLI to train an INRIA-format 3DGS `.ply`, landed as a scan sidecar.

**When:** a scan has a finalized session with keyframes **and** poses (either
per-keyframe poses, or a LingBot-Map `lingbot-map.poses.json` fallback for
video-ingest sessions). Give it a reconstructed session, get back a splat.

**How**
- **Editor:** Splat Toolbox → **Train splat** on the selected scan (enqueues a
  `splat-train` world job).
- **Session:** a video-ingest session first runs `lingbot-map-reconstruct` to
  estimate poses; then `splat-train` consumes them via `splat_train_dataset.ts`.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-train","scanId":"scan-<id>"}'
  ```

**Env:** `BRUSH_BIN` (default `~/brush/src/target/release/brush-cli`). Missing
binary → a `skipped` manifest with a remediation hint, never a crash. Full
env/params table in `splat-train.md`.

Invariants preserved by the dataset converter: Nerfstudio `camera_model` is
**PERSPECTIVE**, and poses are emitted as OpenGL camera-to-world with **no extra
axis flip** (LingBot's `cameraToWorld` is treated as OpenCV world-to-camera and
converted).

---

## Detect — splat_analyzer

**What:** runs open-vocabulary 3D object detection over a splat. The driver
(`splat_detect.ts`) spawns `splat_analyzer/run_local.py`, which renders the
splat, runs **OWLv2** open-vocab detection on the renders, lifts the 2D boxes
into 3D, and writes `interactions.json`. The driver copies that next to the scan
and writes a `splat-detect` manifest.

**When:** a scan has a trained `<base>.splat.ply` (preferred), **or** a session
point cloud (`lingbot-map.point-cloud.ply`) that the driver first converts to a
3DGS-attribute PLY via `pointcloud_to_gs.py`. So you can detect even before a
full Brush train has run.

**Tuning:** camera coverage (`SPLAT_DETECT_QUALITY` low/medium/high) and the
clustering knobs (`SPLAT_DETECT_MIN_VOTES` / `_SCORE_THRESHOLD` / `_MIN_PEAK_SCORE`,
or per-job payload `quality`/`minVotes`/`scoreThreshold`/`minPeakScore`) decide
detection quality far more than the pipeline does. They ship **uncalibrated** —
run `npm run tune:detect -- <room>.splat.ply` against a real trained room splat to
pick values, then set the env. See **[SPLAT_DETECT_ROADMAP.md](SPLAT_DETECT_ROADMAP.md)**
for the calibration runbook and the plan to surface detections in the AR scanner.

**How**
- **Editor:** Splat Toolbox → **Detect objects**; optional prompt override.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-detect","scanId":"scan-<id>","payload":{"prompt":"sofa, chair, table, tv"}}'
  ```

**Prompt:** optional per-job; defaults to env `SPLAT_DETECT_PROMPT`
(`sofa, chair, table, tv, lamp, plant, bed, desk, shelf, door, window`).

**Env:** `SPLAT_DETECT_PYTHON` (default `~/.venvs/splat-analyzer/bin/python`),
`SPLAT_DETECT_DIR` (default `~/splat_analyzer`), `HIP_VISIBLE_DEVICES` (default
`1`), `POINT_SPLAT_SIZE` (default `6`). A missing python/dir → a `skipped`
manifest; an analyzer crash or a run with no `interactions.json` → an `error`
manifest carrying a stderr tail.

---

## Ingest video — ffmpeg

**What:** "walk the house shooting normal video, upload it, get a 3D map." Splits
an ordinary phone video into scaled JPEG keyframes and lays them down as a
capture session the rest of the pipeline understands. The records carry **no
pose** — poses come later from `lingbot-map-reconstruct`.

Two quality gates run automatically:

- **Adaptive fps** — with no explicit `--fps`, the sample rate adapts to the
  clip length (`ffprobe` duration): `max(2, ceil(40 / seconds))`, capped at 10.
  Short clips still yield ≥40 frames of parallax; long walkthroughs keep the
  economical 2fps. An explicit `--fps` (or the route's `fps` field) always wins.
- **Blur gate** — each extracted frame's sharpness (variance of the 3x3
  Laplacian on downscaled grayscale, `scripts/ingest-quality.mjs`) is measured
  and frames under `--min-sharpness` (default 60, env `INGEST_MIN_SHARPNESS`,
  0 disables) are dropped. Survivors are re-indexed so `kf-NNNNN.jpg` stays
  contiguous; the count lands in `session.json` as `droppedBlurry`. If the gate
  would drop *every* frame, it keeps them all instead.

**When:** you have a video instead of a live AR scan, or you want a
non-interactive capture path.

**How**
- **Scanner:** the scanner's **Upload video** control posts to `/ingest-video`.
- **Script (box-side):**
  ```sh
  node scripts/ingest-video.mjs <video.mp4> --scans-dir <isolated-dir>
  ```
  Last stdout line is JSON `{ sessionId, frameCount, sessionDir, droppedBlurry, fps }`.
- **curl:**
  ```sh
  curl -X POST $BASE/ingest-video \
    -F video=@floor1.mp4 -F name='Downstairs'
  # → 202 { sessionId, scanId, jobId, frameCount }
  ```
  The route registers a `scan-<sessionId>` in the `default` world and
  auto-enqueues a `lingbot-map-reconstruct` job. Uploads over
  `INGEST_MAX_VIDEO_BYTES` (default 1.5 GB) get a `413`.

---

## Ingest photos — sharp/jimp

**What:** "shot a burst of stills around the room / found a folder of house
photos." Orders a photo set by capture time (EXIF `DateTimeOriginal`, file
mtime fallback — noted as `timesFrom` in `session.json`), drops blurry shots
with the same blur gate as the video arm, scales to the same long-edge cap,
and lays the survivors down as a pose-less keyframe session
(`source: 'photo-ingest'`). The CLI additionally **clusters by capture-time
gap** (default: a gap > 2h starts a new session — archive folders often hold
several visits); the server route always ingests one upload as one session.

**How**
- **Script (box-side, clustering on):**
  ```sh
  node scripts/ingest-photos.mjs <photos-dir> --scans-dir <isolated-dir> \
    [--cluster-gap-hours 2] [--min-sharpness 60]
  ```
  Last stdout line is JSON `{ sessionId, frameCount, sessionDir, droppedBlurry,
  timesFrom, sessions: [...] }`.
- **curl:**
  ```sh
  curl -X POST $BASE/ingest-photos \
    -F name='Kitchen stills' \
    -F files=@img_0001.jpg -F files=@img_0002.jpg -F files=@img_0003.jpg
  # → 202 { sessionId, scanId, jobId, frameCount, droppedBlurry }
  ```
  The route registers a `scan-<sessionId>` in the `default` world and
  auto-enqueues a `lingbot-map-reconstruct` job, exactly like `/ingest-video`.
  Uploads over `INGEST_MAX_PHOTOS_BYTES` (default 500 MB) get a `413`.

---

## Finish — splat-transform (SOG + compressed PLY)

**What:** the post-processing Stage 4. `splat_finish.ts` spawns the
[@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform)
CLI (an npm devDependency, run via node) on a scan's trained
`<base>.splat.ply` to produce the two web-delivery artifacts plus a manifest:

- `<base>.sog` — super-compressed SOG bundle (ONE ZIP file holding `meta.json`
  + WebP attribute textures). ~8x smaller than the raw PLY (12.6% on the
  verify fixture); SparkJS loads it natively.
- `<base>.compressed.ply` — SuperSplat compressed PLY, ~4x smaller (26.5% on
  the fixture); loads through Spark's standard PLY path.
- `<base>.splat-finish.manifest.json` — status, `sizes`
  (`inputBytes`/`sogBytes`/`compressedBytes`), timing.

The viewer's splat layer **prefers the finished artifacts** (`.sog`, then
`.compressed.ply`) and gracefully falls back to the raw `.splat.ply`; the Splat
Toolbox shows the compressed sizes and a **Download .sog** link next to the
existing Download .ply.

**When:** automatically — every successful `splat-train` auto-enqueues a
`splat-finish` for the same scan (kill switch: `SPLAT_FINISH_AUTO=0`). Or
manually re-run it after tuning, via the job queue.

**How**
- **Editor:** Processing Queue → **Splat finish (compress)**.
- **curl:**
  ```sh
  curl -X POST $BASE/worlds/default/jobs \
    -H 'authorization: Bearer <editor-token>' \
    -H 'content-type: application/json' \
    -d '{"type":"splat-finish","scanId":"scan-<id>"}'
  ```
- **CLI (box-side smoke):**
  ```sh
  node node_modules/@playcanvas/splat-transform/bin/cli.mjs -w -g cpu \
    <base>.splat.ply <base>.sog
  node node_modules/@playcanvas/splat-transform/bin/cli.mjs -w \
    <base>.splat.ply <base>.compressed.ply
  ```

**Env:** `SPLAT_FINISH_AUTO` (default on; `0` disables the auto-chain),
`SPLAT_FINISH_GPU` (default `cpu`; a WebGPU adapter index from `-L` — dawn/
Vulkan numbering, NOT a HIP id), `SPLAT_FINISH_SH_ITERS` (k-means iterations,
default 10), `SPLAT_TRANSFORM_CLI` (override the cli.mjs path). A missing
input splat or CLI → a `skipped` manifest with a remediation; a CLI crash or a
run with no output → an `error` manifest carrying the stderr tail.

---

## Further reading / candidate tools

Curated from the [awesome-3D-gaussian-splatting](https://github.com/MrNeRF/awesome-3D-gaussian-splatting)
index (which now fans out to an external paper database) against our specific
roadmap gaps. Verify current status before adopting; these are directions, not
dependencies.

**Compression (shrink the splat we ship to the viewer):**
- **Self-Organizing Gaussians (SOG)** — ✅ landed as the `splat-finish` job
  above (splat-transform's SOG writer); the viewer already prefers the `.sog`.
- **SPZ (Niantic)** — a compact binary splat container; splat-transform can
  also write `.spz`, so adding it to `splat_finish.ts` is a one-liner if a
  consumer wants that format.

**Meshing from splats (the GLTF export leg):**
- **2D Gaussian Splatting (2DGS)** — flattens 3D Gaussians to oriented disks,
  giving far cleaner surfaces to extract a mesh from than vanilla 3DGS; the
  natural front-end for a splat→GLTF path.
- **SuGaR** — binds Gaussians to a surface and extracts a mesh via Poisson
  reconstruction; a candidate for turning a room splat into the GLTF the editor
  already renders.

**SLAM-coupled / pose-free 3DGS (skip or shore up LingBot-Map poses):**
- **MonoGS / Gaussian Splatting SLAM** — monocular SLAM that builds the splat and
  the trajectory jointly; could replace the two-stage ingest→reconstruct→train
  for the video arm.
- **COLMAP-Free 3DGS (CF-3DGS)** — trains without precomputed poses, relevant to
  our pose-less video-ingest sessions where LingBot-Map is the only pose source.

**Splat segmentation / language-embedded (richer than box detection):**
- **LangSplat** — embeds CLIP language features per Gaussian for open-vocab 3D
  queries; a step beyond OWLv2 boxes toward "select the sofa" in the splat.
- **Gaussian Grouping** — segments and edits the splat by object identity; useful
  for per-object layers in the editor instead of flat interaction boxes.
