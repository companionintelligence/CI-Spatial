# Camera poses (COLMAP)

Structure-from-motion pose solving on CPU, so a scan can reconstruct
end-to-end on a laptop.

## Why this stage exists

Brush trains from *posed* images. Keyframes streamed from a live WebXR/SLAM
session carry a pose per frame; `photo-ingest` and video sessions do not.
Until this stage existed, the only fallback for a pose-less session was
`lingbot-map.poses.json`, written by a GPU-bound Python worker — so on any
host without that worker installed, the entire splat chain died here:

```
dataset build failed: no camera poses: keyframe records carry no pose …
```

The trainer was never the blocker. Every `photo-ingest` session on a machine
without LingBot-Map was unreconstructable, and the error named only the GPU
provider, which sent operators looking for a GPU rather than at the actual
gap.

## What it writes

Into the session directory, deliberately mirroring LingBot-Map's outputs:

| File | Contents |
|---|---|
| `colmap.poses.json` | `{ tool, frames: [{ file, cameraToWorld }] }` — a 3×4 **world-to-camera** matrix in the **OpenCV** convention per registered frame |
| `colmap.point-cloud.ply` | Sparse triangulated cloud (xyz + rgb), used to seed Brush's splat init |
| `colmap-poses.manifest.json` | Run index — status, registered image count, point count, timing, plus `gravityAligned` and the pre-rotation `upAxis` (see below) |

`cameraToWorld` holding a *world-to-camera* matrix is a misnomer inherited
from `lingbot_map_worker.py`. It is preserved on purpose: matching the format
byte-for-byte is what lets `buildBrushDataset` read either provider through
one already-audited conversion (`openCvW2cToC2w`) rather than growing a
second pose path (ADR 0001).

## The emitted model is gravity-aligned (world +Y up)

SfM has no gravity reference. COLMAP's world frame is whatever the initial
image pair happened to establish, so the raw reconstruction comes out tilted
at an arbitrary angle and a Y-up viewer renders the room on its side. (Brush
hits the same problem and records its own guess in the exported PLY's
`comment Vertical axis:` line — on the reference capture that came out as
roughly −X.)

So both the poses and the point cloud are rotated before they are written:
`estimateUpAxis()` (`server/colmap/colmap_model.ts`) averages row 1 of every
registered image's world-to-camera rotation — in the OpenCV convention that
row is the camera's *down* vector in world space — and `rotationBetween()`
maps the result onto +Y. Averaging over every view cancels per-shot tilt; the
cue it relies on is simply that a handheld phone is held roughly upright.

Two consequences to know:

- **It is an estimate, not a measurement.** ADR 0005: nothing here has been
  checked against a measured vertical, so treat "up is +Y" as approximate.
  When the mean down-vector is too short to be meaningful (fewer than 3
  registered images, or views pointing in wildly different directions) the
  rotation is skipped rather than applied confidently in the wrong direction
  — the manifest then has `gravityAligned: false` and no `upAxis`.
- **It fixes orientation, not scale.** The model is still in arbitrary SfM
  units. Metres come only from `splat-align` (Umeyama fit against a
  calibrated scan) — see [`splat-align.md`](splat-align.md).

## Running it

Auto-chained — `splat-train` runs it when a session has no poses, so normally
you do nothing. To run it explicitly:

```bash
curl -X POST localhost:8000/worlds/default/jobs \
  -H 'content-type: application/json' \
  -d '{"type":"colmap-poses","scanId":"<scan-id>"}'
```

Or drive the whole chain from the CLI:

```bash
deno run -A scripts/scan-room.ts <session-id>
```

## Setup

```bash
brew install colmap     # or: apt install colmap
```

A missing binary is reported as a **skip** with a remediation, never a
failure — the server keeps running and the UI explains what to install.

| Env | Default | Purpose |
|---|---|---|
| `COLMAP_BIN` | `colmap` (PATH) | Binary location |
| `COLMAP_FEATURE_TYPE` | `SIFT` | `ALIKED_N16ROT` / `ALIKED_N32` also work |
| `COLMAP_MATCHER_TYPE` | `SIFT_BRUTEFORCE` | Pair with the feature type |
| `COLMAP_MAX_IMAGE_SIZE` | `1600` | Longest edge fed to feature extraction |
| `SPLAT_TRAIN_AUTO_POSES` | `1` | `0` disables auto-chaining from `splat-train` |

## Two behaviours worth knowing

**The mapper runs twice.** A single pass over a handheld indoor capture
routinely registers a fraction of the frames and discards the model as
"insufficient size". Re-running it seeded with `--input_path` grows the
reconstruction substantially — on the reference capture, 11 → 20 of 22
images and 0.69px → 0.52px mean reprojection error. A failed second pass
falls back to the first model rather than losing a usable one.

**COLMAP writes two different layouts.** A fresh `mapper` run emits numbered
sub-models (`0/`, `1/`, …) and `0` is *not* reliably the largest. A run given
`--input_path` writes its single model **directly into `--output_path`**,
with no subdirectory. Model discovery checks both; looking only for
subdirectories silently discards every seeded pass.

## When it legitimately cannot solve

SfM needs **parallax** — the camera must translate, not just rotate. A camera
panning in place (a gimbal, a phone pivoting on one spot) produces views
related by a homography, from which no depth can be triangulated at any
resolution, with any feature detector, on any GPU.

COLMAP names this precisely. Its two-view geometry classification is the
diagnostic:

```sql
-- in <session>/colmap-work/db.db
SELECT config, COUNT(*) FROM two_view_geometries WHERE rows > 0 GROUP BY config;
--   2 = CALIBRATED           usable baseline
--   6 = PLANAR_OR_PANORAMIC  homography only — rotation-only or a flat scene
```

All `PLANAR_OR_PANORAMIC` and no `CALIBRATED` means the capture cannot be
reconstructed. The stage reports this as an error naming the cause, because
the fix is a re-capture, not a setting.

Measured on the Osmo gimbal rig: a grid confined to **one narrow station**
classified **29 of 36 image pairs `PLANAR_OR_PANORAMIC`** and registered only
**4 of 9 images**. Widening the sweep helps (the phone's lens sits off the
pan/tilt axes, so a large pan yields a small baseline, and each station sees
more of the room), which is why that rig's default preset is a 105-position
dome — but no sweep width manufactures translation. See
[`../operations/GIMBAL_INTEGRATION.md`](../operations/GIMBAL_INTEGRATION.md).

**Frame count matters more than frame quality.** A 9-photo sweep of one room
registered only 4 images; pooling four captures of the same room to 22 images
registered 20. `scripts/scan-room.ts --pool <a> <b> … --as <id>` merges
sessions for exactly this reason.
