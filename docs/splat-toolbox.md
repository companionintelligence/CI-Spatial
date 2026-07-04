# Splat toolbox

The **Splat Toolbox** is the set of tools that turn a Companion-Scan capture
session into a viewable, trainable, and queryable 3D Gaussian-splat scene. Each
tool is a thin Deno/Node driver over a proven external engine, wired into the
world-editor as a job type (or exposed as a script). This document is the
inventory: what each tool is, when you reach for it, and how to drive it from
the **editor UI**, from a **scanner/session**, and from **curl**.

All the trained/derived artifacts land next to the scan in `SCANS_DIR` as
sidecars (`<base>.splat.ply`, `<base>.splat-train.manifest.json`,
`<base>.interactions.json`, `<base>.splat-detect.manifest.json`), and are served
back through the `/scans/:filename` routes the viewer already understands.

---

## Tools at a glance

| Tool | Engine | Job type / entry point | Produces |
|------|--------|------------------------|----------|
| **View** | SparkJS (`@sparkjsdev/spark`) | viewer splat layer | in-browser 3DGS render |
| **Train** | [Brush](https://github.com/ArthurBrussee/brush) (wgpu) | `splat-train` world job | `<base>.splat.ply` (+ manifest) |
| **Detect** | [splat_analyzer](#detect--splat_analyzer) + OWLv2 | `splat-detect` world job | `<base>.interactions.json` (+ manifest) |
| **Ingest video** | ffmpeg | `scripts/ingest-video.mjs` / `POST /ingest-video` | keyframe session (pose-less) |
| **Compress** | Brush (best-effort) | rides `splat-train` | `<base>.compressed.ply` when present |

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

**What:** renders a trained `<base>.splat.ply` in the desktop viewer as a
**Trained Splat** layer under the owning scan, using SparkJS's `SplatMesh`.

**When:** any time a scan has a `splat-train` manifest with `status: ok`.

**How**
- **Editor:** open the scan; the splat layer auto-discovers the manifest and
  loads the served `.ply` (`src/viewer/splat-layer.ts` → `splat-viewer.ts`).
- **curl:** `curl $BASE/scans/<base>.splat-train.manifest.json` to confirm a
  splat exists, then `GET /scans/<base>.splat.ply` for the geometry.

See `docs/splat-train.md` for the full viewer wiring.

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
env/params table in `docs/splat-train.md`.

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

**When:** you have a video instead of a live AR scan, or you want a
non-interactive capture path.

**How**
- **Scanner:** the scanner's **Upload video** control posts to `/ingest-video`.
- **Script (box-side):**
  ```sh
  node scripts/ingest-video.mjs <video.mp4> --fps 2 --scans-dir <isolated-dir>
  ```
  Last stdout line is JSON `{ sessionId, frameCount, sessionDir }`.
- **curl:**
  ```sh
  curl -X POST $BASE/ingest-video \
    -F video=@floor1.mp4 -F name='Downstairs' -F fps=2
  # → 202 { sessionId, scanId, jobId, frameCount }
  ```
  The route registers a `scan-<sessionId>` in the `default` world and
  auto-enqueues a `lingbot-map-reconstruct` job. Uploads over
  `INGEST_MAX_VIDEO_BYTES` (default 1.5 GB) get a `413`.

---

## Compress — Brush (best-effort)

**What:** if Brush emits a `*.compressed.ply` in the export dir, `splat_train.ts`
carries it alongside the full `.ply` as `<base>.compressed.ply`. Brush does not
compress by default, so this is opportunistic; there is no standalone compress
job yet.

**When:** transfer/storage of large splats — a smaller sidecar for the same
scene. See the roadmap candidates below for a real compression leg (SOG/SPZ).

---

## Further reading / candidate tools

Curated from the [awesome-3D-gaussian-splatting](https://github.com/MrNeRF/awesome-3D-gaussian-splatting)
index (which now fans out to an external paper database) against our specific
roadmap gaps. Verify current status before adopting; these are directions, not
dependencies.

**Compression (shrink the splat we ship to the viewer):**
- **Self-Organizing Gaussians (SOG)** — sorts Gaussians into a 2D grid so their
  attributes compress as images; strong size wins, directly relevant to serving
  splats over Tailscale to a phone.
- **SPZ (Niantic)** — a compact binary splat container; converters exist in the
  awesome index (`gsbox`, `GaussForge`) for PLY↔SPZ↔SPLAT, a low-effort transfer
  format we could adopt without changing the trainer.

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
