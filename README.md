# Companion Scan

An AR room-scanning application that uses 8th Wall SLAM for spatial mapping, a local LFM2.5-VL vision-language model for object detection, and Three.js for 3D visualisation. Results are exported as `.glb` files and can be composed into shared world projects in the browser-based scan editor.

## Features

- **AR scanning** — 8th Wall OSS SLAM tracks the environment and accumulates a colourised point cloud in real time
- **On-device + server inference** — detects objects via LFM2.5-VL-1.6B-ONNX; runs on a local Deno server (CPU/GPU via ONNX Runtime) or falls back to a WebGPU worker
- **3D object pins** — detected objects are placed at their SLAM-resolved world positions as live 3D labels tracking the scene
- **Session persistence** — every scan is saved to IndexedDB; browse, reload, edit, or delete past sessions from the history drawer
- **GLTF export** — exports the full scan (point cloud + camera path + labelled boxes) as a `.glb` file, saved locally and uploaded to the server
- **World scan editor** — `/viewer.html?world=default` loads many scans into one ENU/Y-up Three.js workspace with map pins, layer toggles, labels, camera frustums, compass, scale, coordinate readout, and transform controls
- **Shareable scanner/viewer links** — editor/owner share links carry capability tokens; regular world manifests redact stored tokens, and strict role enforcement is available with `WORLD_STRICT_AUTH=1`
- **Processing queue foundation** — world jobs cover ingest, layer extraction, alignment, point merging, semantic passes, depth reconstruction, splat training, and world export; the local coordinator validates inputs and records artifacts while heavier Open3D/CV/splat workers remain pluggable
- **Automatic scan optimization** — every upload runs through a persistent job queue: quantization + Draco + point-cloud LODs (`.opt.glb`, `.lodN.glb`, `.manifest.json`), roughly halving file size
- **Quality-gated autosave** — GLB exports and autosaves include coverage, point count, drift/light/reflection warnings, and `ready` / `needs-review` / `needs-rescan` state
- **Keyframe streaming** — ☁ button streams pose+intrinsics-tagged keyframes to the server while you walk: reconstruction-ready `FrameObservation` sidecars under `scans/sessions/`
- **Live geometry to desktop** — the WebRTC live stream also carries point-cloud deltas, detections, and camera pose; the desktop editor shows the scan growing in real time
- **Desktop world editor** — `/viewer` places scans in a shared ENU world with transform gizmos, semantic tagging, layer toggles, and progressive LOD-first loading (Draco-aware)
- **PWA** — installable on iOS/Android with app-shell caching and an offline write queue for uploads, keyframes, patches, jobs, summaries, and project writes

---

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org) | ≥ 20 | Vite dev server + build |
| [Deno](https://deno.land) | ≥ 2.0 | Inference server |
| [Python 3](https://python.org) | ≥ 3.8 | Model downloader |
| 8th Wall OSS binary | any | `public/xr.js` — SLAM engine |

An iOS or Android device with camera is required for AR scanning. The 3D viewer and inference server work on desktop.

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/companionintelligence/CI-Web-XR-Scan.git
cd CI-Web-XR-Scan
npm install
```

### 2. Download the LFM2.5-VL ONNX model (~2.9 GB)

```bash
python3 download_models.py
```

This downloads into `public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/`.

### 3. Place the 8th Wall OSS engine

Download the 8th Wall standalone engine from [8th.io/xrjs](https://8th.io/xrjs) and copy it to:

```
public/xr.js
```

### 4. Set up HTTPS (required for camera access)

For trusted HTTPS on all devices via [Tailscale](https://tailscale.com):

```bash
tailscale cert <your-machine>.<your-tailnet>.ts.net
```

The hostname is auto-detected at Vite startup: `TAILSCALE_HOSTNAME` env var →
`tailscale status --json` → a `<hostname>.ts.net.crt` file in the repo root.
Set `TAILSCALE_HOSTNAME` explicitly only if detection picks the wrong name
(see `.env.example` for all configuration knobs).

### 5. Start both servers

```bash
npm start
```

This uses `concurrently` to run:
- **Deno inference server** on `:8000` (`npm run server`)
- **Vite dev server** on `:5173` with HTTPS (`npm run dev`)

Open `https://<tailscale-hostname>:5173` on your phone to scan, or on desktop to use the world editor at `https://<tailscale-hostname>:5173/viewer.html?world=default`.

Key routes (replace the hostname with your machine's):

- Scanner: `https://<your-tailscale-hostname>:5173/scanner.html?world=default`
- Viewer/editor: `https://<your-tailscale-hostname>:5173/viewer.html?world=default`
- WebXR scanner: `https://<your-tailscale-hostname>:5173/webxr.html`

For persistent serving from a Linux box (systemd units, GPU inference, cert
renewal) see [docs/DEPLOY.md](docs/DEPLOY.md); for the on-device test protocol
see [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md).

### WebXR mode (HelloXR on iOS)

`/webxr.html` runs the same scanner on a **native WebXR `immersive-ar` session**
instead of the 8th Wall SLAM engine. Safari on iOS has no WebXR AR, so open the
URL inside [HelloXR](https://apps.apple.com/us/app/helloxr/id6757726359), a
WebXR-enabled iOS browser (Android Chrome and headset browsers work directly).
The page auto-detects support and forwards to the scanner in forced-WebXR mode
(`/?ar=webxr` — `xr.js` is not loaded at all on this path); without support it
shows the HelloXR install link and fallbacks. The 🥽 button in the AR app and
the WebXR button in the viewer toolbar navigate between the two runtimes.
In WebXR mode the point cloud accumulates from per-frame hit-test samples
(WebXR exposes no SLAM feature points), so sweep the camera slowly across
surfaces.

---

## Project Structure

```
.
├── main.ts                  # Deno HTTP server (inference + scan storage)
├── inference.ts             # LFM2.5-VL ONNX inference engine
├── prompt.ts                # VLM prompt builder + JSON parser (server)
├── download_models.py       # Model download helper
├── index.html               # AR scanning app entry point
├── viewer.html              # Standalone 3D viewer entry point
├── scanner.html             # Share-link scanner redirect entry point
├── vite.config.ts           # Vite + Tailscale HTTPS config
├── package.json
├── deno.json
│
├── public/
│   ├── xr.js                # 8th Wall OSS engine (download separately)
│   ├── manifest.json        # PWA manifest
│   ├── icon-192.png         # PWA icons (generated by scripts/generate-icons.mjs)
│   ├── icon-512.png
│   ├── models/              # LFM2.5-VL ONNX model files (gitignored, ~2.9GB)
│   └── resources/           # 8th Wall worker scripts + tflite models
│
├── scans/                   # Uploaded .glb scan files (created at runtime)
├── worlds/                  # World manifests, edit patches, and queued jobs (created at runtime)
│
├── src/
│   ├── main.ts              # Frontend app bootstrap
│   ├── ar/
│   │   ├── provider.ts      # ARProvider interface
│   │   ├── eighthwall.ts    # 8th Wall SLAM implementation
│   │   ├── webxr.ts         # WebXR fallback implementation
│   │   └── scanner.ts       # Continuous SLAM point-cloud accumulator
│   ├── capture/
│   │   └── capture.ts       # Camera frame capture + thumbnail
│   ├── export/
│   │   └── gltf.ts          # GLTF/GLB exporter (local + server upload)
│   ├── inference/
│   │   ├── router.ts        # WebGPU ↔ server inference router
│   │   ├── server.ts        # Server inference client
│   │   ├── webgpu.worker.ts # In-browser WebGPU inference worker
│   │   └── prompt.ts        # Prompt builder + detection parser (client)
│   ├── scene/
│   │   ├── store.ts         # Reactive detection store + IndexedDB
│   │   └── pointcloud.ts    # Voxel-deduplicated point cloud
│   ├── spatial/
│   │   └── resolver.ts      # 2D bbox → 3D world position resolver
│   ├── ui/
│   │   ├── overlay.ts       # AR pin labels + 3D projection
│   │   ├── panel.ts         # Side panel (object manifest)
│   │   └── history.ts       # Session history drawer
│   ├── viewer/
│   │   └── viewer.ts        # World scan editor
│   └── world/
│       ├── types.ts         # WorldProject, ScanManifest, LayerManifest, EditPatch
│       ├── geo.ts           # WGS84/GeoPose to local ENU helpers
│       └── layers.ts        # Layer ordering and default layer manifests
│
├── scripts/
│   ├── generate-icons.mjs   # PWA icon generator (pure Node.js)
│   └── iwdp-console.mjs     # iOS WebKit debug proxy console
│
└── tests/
    ├── ar-scan.spec.ts      # Playwright E2E tests (AR flow + API)
    └── server.spec.ts       # Server endpoint unit tests
```

---

## Development Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start both Vite and Deno servers together |
| `npm run dev` | Vite only |
| `npm run server` | Deno inference server only |
| `npm run build` | TypeScript check + Vite production build |
| `npm test` | Playwright tests (webkit-desktop) |
| `npm run test:mobile` | Playwright tests (webkit iPhone 15 emulation) |
| `npm run gen-icons` | Regenerate PWA icons |

---

## Server API

All endpoints are served by the Deno server on `:8000` and proxied through Vite on `:5173`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ status: "ok", model: "..." }` |
| `POST` | `/infer` | Multipart `image` → `RawDetection[]` |
| `POST` | `/upload-scan` | Multipart `file` (.glb) + optional `metadata` (JSON) → saves to `scans/` |
| `GET` | `/scans` | Returns JSON array of `{ filename, size, uploadedAt }` |
| `GET` | `/scans/:filename` | Serves a `.glb` file with `model/gltf-binary` content-type |
| `DELETE` | `/scans/:filename` | Deletes one stored `.glb`, sidecar metadata, and world manifest references |
| `DELETE` | `/scans?confirm=delete-all` | Clears test scan storage and prunes scans from world manifests |
| `GET` | `/worlds` | Lists world projects |
| `POST` | `/worlds` | Creates a world project |
| `GET` | `/worlds/:slug` | Returns a world manifest with scans, layers, members, jobs, and patches |
| `GET` | `/worlds/:slug/share` | Returns owner/editor/viewer/scanner role links |
| `POST` | `/worlds/:slug/patches` | Persists transform, label, category, notes, and visibility edit patches |
| `GET` | `/worlds/:slug/jobs` | Lists queued, processing, completed, and failed world jobs |
| `POST` | `/worlds/:slug/jobs` | Queues processing jobs such as `align-scan`, `semantic-pass`, or `splat-train` |
| `GET` | `/worlds/:slug/frames/:scanId` | Returns pose, intrinsics, RGB URL, and frustum metadata for streamed keyframes |
| `GET` | `/sessions/:id/keyframes/:file` | Serves a captured RGB keyframe JPEG |

By default, world reads are open for local/Tailscale development and world member
tokens are redacted from manifests. Invalid tokens are rejected. Set
`WORLD_STRICT_AUTH=1` to require capability tokens for protected world actions
such as share-link generation, edit patches, and processing jobs.

---

## Inference

The app routes inference through two paths:

1. **Server path** (default) — POSTs a JPEG to the Deno server, which runs LFM2.5-VL-1.6B-ONNX via ONNX Runtime Node. ~2–8s on Apple Silicon.
2. **WebGPU path** (fallback) — Runs the model in-browser via `@huggingface/transformers`. Slower but works without the server.

The router (`src/inference/router.ts`) pings `/health` on startup to decide which path to use.

### LingBot-Map server processing

Sessions that stream RGB keyframes can be densified server-side with [LingBot-Map](https://github.com/Robbyant/lingbot-map) — a feed-forward Geometric Context Transformer that runs streaming 3D reconstruction directly from the JPEG keyframes the mobile app uploads.

**Setup** (one-time, on the inference box):

```bash
# 1. Install LingBot-Map in a venv the Deno server can reach
git clone https://github.com/Robbyant/lingbot-map ~/lingbot-map
python3 -m venv ~/.venvs/lingbot-map && source ~/.venvs/lingbot-map/bin/activate
pip install -e ~/lingbot-map

# 2. Download a checkpoint (see lingbot-map README for variants)
huggingface-cli download robbyant/lingbot-map --local-dir ~/models/lingbot-map

# 3. Point the Deno server at the venv python + checkpoint
export LINGBOT_MAP_PYTHON=~/.venvs/lingbot-map/bin/python
export LINGBOT_MAP_MODEL_PATH=~/models/lingbot-map/checkpoint.pt
```

**Triggering a reconstruction.** The server exposes the `lingbot-map-reconstruct` world job type. Enqueue one against a scan that has a finalized session:

```bash
curl -X POST http://<host>:8000/worlds/default/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"lingbot-map-reconstruct","scanId":"<scanId>"}'
```

The job invokes `scripts/lingbot_map_worker.py` as a subprocess and writes three sibling artifacts into the session directory:

| File | What it is |
|------|-----------|
| `lingbot-map.point-cloud.ply` | Binary PLY of merged world points (XYZ + RGB when available) |
| `lingbot-map.poses.json` | Per-frame camera-to-world matrices + intrinsics |
| `lingbot-map.manifest.json` | Run index + stats; always written, even on skip/error |

All three are served read-only at `/sessions/<id>/<artifact>`. The desktop editor consumes them via the world-job artifact metadata. If LingBot-Map / torch is not installed, or the checkpoint is missing, the worker writes a `skipped` manifest with a `remediation` hint and the world job completes with that message rather than failing — so the UI explains *why* no reconstruction was produced.

See [docs/lingbot-map.md](docs/lingbot-map.md) for the full architecture diagram, UI walkthrough with screenshots, test setup, and CC-BY clip provenance.

For the splat tools (view / train / detect / ingest-video / compress) see [docs/splat-toolbox.md](docs/splat-toolbox.md).
For the two-story-house field acceptance protocol see [docs/HOUSE_VALIDATION.md](docs/HOUSE_VALIDATION.md) (`npm run links:house`, `npm run test:house`).

---

## Testing

```bash
# Unit + E2E tests (desktop WebKit)
npm test

# iPhone simulator
npm run test:mobile

# Real iPhone over USB (requires ios-webkit-debug-proxy)
npm run test:iphone
```

See `playwright.config.ts` for project configurations.

### 8th Wall Simulator

The 8th Wall engine ships with a desktop simulator that replays pre-recorded SLAM sessions. To use it for automated testing:

1. Launch the app in Chrome/Edge on desktop — XR8 will load its simulator UI
2. Load a pre-recorded session from `public/test-fixtures/slam-replay.bin` (if present)
3. Playwright tests tagged `@simulator` can drive the capture loop headlessly

---

## Architecture

See [architecture.md](architecture.md) for a detailed breakdown of the data flow, component responsibilities, and design decisions.

---

## Roadmap

See [roadmap.md](roadmap.md) for planned features and known limitations.

---

## License

MIT
