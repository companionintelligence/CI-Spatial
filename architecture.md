# CI XR Scan — Architecture

## Overview

CI XR Scan is a mobile-first AR application that scans a room using SLAM, sends camera frames to a vision-language model for object detection, resolves detected objects into 3D world positions, and exports the combined result as a GLTF scene. A companion desktop viewer renders the exported scans without requiring AR hardware.

---

## System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         iOS / Android Browser                        │
│                                                                      │
│  ┌──────────┐   frames   ┌───────────┐  detections  ┌────────────┐  │
│  │ 8th Wall │──────────▶│  Capture  │─────────────▶│ Inference  │  │
│  │  SLAM    │  poses     │  Module   │              │  Router    │  │
│  │ (xr.js)  │──────────▶│           │              │            │  │
│  └──────────┘            └───────────┘              └─────┬──────┘  │
│       │ featurePoints()                                   │         │
│       ▼                                        WebGPU │   │ HTTP    │
│  ┌──────────┐  points   ┌───────────┐          worker│   │POST     │
│  │  SLAM    │──────────▶│ PointCloud│                 │   │/infer   │
│  │ Scanner  │  poses    │  (voxel)  │                 │   ▼         │
│  └──────────┘           └─────┬─────┘       ┌────────────────────┐ │
│                               │             │  Deno Inference    │ │
│  ┌────────────────────────────▼──────────┐  │  Server (:8000)    │ │
│  │         Spatial Resolver              │  │                    │ │
│  │  bbox(0-1) → NDC → ray → hitTest()   │  │  onnxruntime-node  │ │
│  │  → world {x,y,z} via SLAM map        │  │  LFM2.5-VL-1.6B    │ │
│  └────────────────────────────────────────┘  └────────────────────┘ │
│                               │                                      │
│                               ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Detection Store                           │  │
│  │   Map<key, StoredDetection>  ←→  IndexedDB sessions          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         │             │              │                              │
│         ▼             ▼              ▼                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐                      │
│  │ AR Pins  │  │  Panel   │  │  History     │                      │
│  │(overlay) │  │ (list)   │  │  Drawer      │                      │
│  └──────────┘  └──────────┘  └──────────────┘                      │
│                                     │ export .glb                  │
│                                     ▼                              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    GLTF Exporter                             │  │
│  │   point cloud + camera path + floor plane + labelled boxes  │  │
│  │   → local download (.glb)  +  POST /upload-scan             │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

               POST /upload-scan ▼       GET /scans ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Deno Server  (:8000)                              │
│   /infer  →  InferenceEngine  →  RawDetection[]                    │
│   /upload-scan  →  scans/<timestamp>.glb                           │
│   /scans        →  [{ filename, size, uploadedAt }]                │
│   /scans/:file  →  serve .glb with CORS headers                    │
└─────────────────────────────────────────────────────────────────────┘
                                  │ GET /scans
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│               Desktop 3D Viewer  (/viewer.html)                    │
│   Three.js scene + OrbitControls + GLTFLoader                      │
│   sidebar: scan list  →  click → load .glb  → render detection     │
│   labels as HTML overlays (CSS3DRenderer)                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Components

### Frontend (Vite + TypeScript)

#### `src/main.ts` — Bootstrap
Orchestrates the full boot sequence:
1. Opens IndexedDB store
2. Mounts AR overlay, side panel, history drawer
3. Detects AR runtime (8th Wall → WebXR fallback)
4. Initialises inference router (pings `/health` to decide GPU vs server)
5. Starts AR session (must be initiated from a click handler for iOS motion permission)
6. Wires capture button → infer → resolve → store → UI loop
7. Starts the room scanner for continuous point-cloud accumulation

#### `src/ar/` — AR Runtime Abstraction

| File | Purpose |
|------|---------|
| `provider.ts` | `ARProvider` interface — 6-DoF pose, frame capture, hit-test |
| `eighthwall.ts` | 8th Wall SLAM implementation; reads pose via `onUpdate` hook from `processCpuResult.reality` |
| `webxr.ts` | WebXR fallback; async hit-test uses `XRSession.requestHitTestSource` |
| `scanner.ts` | Subscribes to `featurePoints()` each frame to build the point cloud |

**Key design decision**: Pose is read in `onUpdate` (not `onProcessCpu`) because `processCpuResult` is only populated by the time `onUpdate` fires. Reading it in `onProcessCpu` itself gives stale/zero values.

#### `src/capture/capture.ts` — Frame Capture
Grabs the live camera frame from the AR provider and creates a JPEG blob + thumbnail using a canvas. The pixel array comes from `processGpuResult.camerapixelarray` (filled during `onProcessCpu`).

#### `src/inference/` — Inference Router

```
InferenceRouter.init()
  └─ ping GET /health
      ├─ 200  →  ServerInferenceClient  (POST JPEG to /infer)
      └─ fail →  WebGPU worker         (@huggingface/transformers)
```

Both paths return `RawDetection[]` with the same shape:
```typescript
{ label: string; confidence: number; description: string; bbox: [x1, y1, x2, y2] }
```

#### `src/spatial/resolver.ts` — 3D Position
For each detected bounding box:
1. Compute NDC from bbox centroid: `(cx*2-1, -(cy*2-1))`
2. If a `captureCamera` is available: cast `THREE.Raycaster` through NDC, sample 5 depth points (1–3m), run `hitTest()` at each projected screen point, take the median
3. Otherwise: `hitTest()` at bbox centroid directly
4. Fall back to 1.5m in front of camera if all hit tests miss

#### `src/scene/store.ts` — Detection Store
- `Map<string, StoredDetection>` in memory, serialised to IndexedDB on every mutation
- Key format: `label:x.x,y.y,z.z` (label + quantised world position)
- Methods: `upsert()`, `clear()`, `loadSession()`, `deleteSession()`, `updateDetection()`, `toggleSelect()`
- `subscribe()` returns an unsubscribe function; listeners fire synchronously post-mutation

#### `src/scene/pointcloud.ts` — Point Cloud
Voxel grid deduplication (default 5cm cells). Stores `Float32Array` of (x,y,z) triples. Provides `boundingBox()` and `estimateFloorY()` for the GLTF exporter.

#### `src/export/gltf.ts` — GLTF Exporter
Builds a Three.js scene graph:
```
Scene "room-scan"
  Points "point-cloud"       — height-colourised SLAM feature points
  Line "camera-path"         — walk trajectory
  Mesh "floor-plane"         — estimated horizontal quad
  Group "detections"
    Mesh "<label>"           — semi-transparent box at world pos
      └─ wireframe overlay   — same box in wireframe
```
All detection metadata is stored in `node.userData` → `extras` in the GLB.

After generating the `ArrayBuffer`:
1. Triggers a browser download (`<a download>`)
2. POSTs the buffer as `multipart/form-data` to `/upload-scan` on the server

#### `src/ui/` — User Interface

| Component | Description |
|-----------|-------------|
| `overlay.ts` | `AROverlay` — places HTML pins at 3D world positions each frame via frustum projection from the SLAM camera pose |
| `panel.ts` | `SidePanel` — slides in from the right; object manifest with thumbnails, confidence rings, 3D coordinates; close button + export/clear footer |
| `history.ts` | `SessionHistory` — slides in from the left; lists IndexedDB sessions newest-first; per-session detection expansion with inline edit (label, description) and select/deselect |

#### `src/viewer/viewer.ts` — 3D Viewer (Desktop)
Standalone page (`/viewer.html`) that:
1. `GET /scans` → renders a sidebar list of saved scans
2. On click: `GET /scans/:filename` → `GLTFLoader` → scene
3. Traverses detection nodes, creates `CSS2DObject` label overlays
4. `OrbitControls` for mouse/touch navigation
5. Works without any AR hardware or camera

---

### Backend (Deno + Hono)

#### `main.ts` — HTTP Server

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness check; returns model ID |
| `/infer` | POST | Multipart `image` → `RawDetection[]` |
| `/upload-scan` | POST | Multipart `file` (.glb) + `metadata` (JSON) → saves to `scans/` |
| `/scans` | GET | Returns `[{ filename, size, uploadedAt }]` |
| `/scans/:file` | GET | Serves `.glb` with `model/gltf-binary` + CORS headers |

CORS is restricted to the configured Tailscale hostname origin and `localhost`.

#### `inference.ts` — ONNX Inference Engine
Runs LFM2.5-VL-1.6B-ONNX as three ONNX Runtime sessions:
1. `embed_tokens_fp16` — maps token IDs to embeddings
2. `embed_images_fp16` — encodes the 512×512 JPEG into 256 vision tokens
3. `decoder_q4` — autoregressive decoder with Mamba conv + attention KV cache

The model is loaded lazily; `/infer` awaits `engineLoadPromise` so early requests queue rather than 503-ing.

#### `prompt.ts` — Detection Prompt (Server)
Builds the system prompt instructing LFM2.5-VL to return a JSON array of `{ label, confidence, description, bbox }`. Includes a robust parser with:
- **Truncation salvage** — if the JSON is cut off at `MAX_NEW_TOKENS`, finds the last complete `}` and closes the array
- **Pixel-space normalisation** — auto-detects bbox values > 1 (model sometimes returns pixel coordinates) and divides by the input image dimensions

---

## Data Flow: Capture → 3D Pin

```
[User taps capture]
       │
       ▼
CaptureModule.capture()
  → canvas.toBlob(JPEG)           # current camera frame
  → provider.getPose()            # SLAM pose at capture time

       │
       ▼
InferenceRouter.infer(blob)
  → POST /infer (JPEG bytes)
  → Deno: resize → 512×512 → embed_images → decoder → JSON
  → parse → RawDetection[]

       │
       ▼
resolveDetections(rawDets, timestamp, opts)
  → for each detection:
      NDC(cx, cy) = (bbox_cx*2-1,  -(bbox_cy*2-1))
      ray = captureCamera.Raycaster from NDC
      hitTest() at sampled screen points
      → WorldDetection { label, worldPos{x,y,z}, worldRot, ... }

       │
       ▼
DetectionStore.upsert(worldDets, thumbMap)
  → merge with existing (dedup within 0.3m per label)
  → IndexedDB.put(session)
  → notify listeners

       │
       ▼
AROverlay.onRender()              # each frame
  → project worldPos → screen via current SLAM camera matrix
  → position HTML pin element
```

---

## State Management

```
DetectionStore
  _detections: Map<key, StoredDetection>
  selectedKeys: Set<key>           ← UI selection state
  listeners: Set<fn>               ← synchronous reactive subscribers

Subscribers:
  AROverlay  — re-projects pins every frame (driven by XR8 pipeline)
  SidePanel  — re-renders card list on every store change
  SessionHistory — re-renders sessions list when store changes
```

---

## IndexedDB Schema

```
Database:  ci-xr-scan  (version 1)
Store:     sessions  (keyPath: sessionId)

Record: {
  sessionId:  string          // "session-<timestamp>"
  startedAt:  number          // Unix ms
  detections: [key, StoredDetection][]  // Map entries serialised as array
}
```

---

## inference Model

**LFM2.5-VL-1.6B-ONNX** by LiquidAI  
[https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-ONNX](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-ONNX)

- Architecture: Liquid Foundation Model (Mamba SSM + Attention hybrid)
- Quantisation: `embed_tokens_fp16`, `embed_images_fp16`, `decoder_q4`
- Input: 512×512 JPEG padded to square
- Output: JSON array of detections (prompted via chat template)
- Typical latency: 2–8s on Apple M-series (ONNX Runtime CPU EP)

---

## HTTPS / Networking

All camera access on iOS requires HTTPS. The setup uses:

1. **Tailscale cert** — Let's Encrypt cert issued by the Tailscale CA for the machine's MagicDNS name. Trusted by all devices on the tailnet without manual certificate installation.
2. **Vite proxy** — `/infer`, `/health`, `/scans`, `/upload-scan` routes are proxied through Vite so the HTTPS frontend never creates mixed-content requests to the HTTP Deno server.
3. **CORS** — the Deno server's CORS policy accepts the Tailscale hostname (any port) and `localhost` (any port).

---

## Testing

Tests are written with [Playwright](https://playwright.dev).

| Project | Device |
|---------|--------|
| `webkit-desktop` | macOS Safari simulation |
| `webkit-iphone15` | iPhone 15 viewport emulation |
| `iphone-usb` | Real iPhone over USB + `ios-webkit-debug-proxy` |

### 8th Wall Simulator

The 8th Wall OSS engine includes a desktop simulator that replays pre-recorded SLAM sessions without requiring a physical device. Playwright tests tagged `@simulator` use this to drive captures against a fixed scene, making the inference + resolve + store pipeline fully deterministic and automatable.

To use:
1. Record a SLAM session by scanning a room on device; copy the session binary to `public/test-fixtures/slam-replay.bin`
2. Run Chrome/Edge (not WebKit) — the simulator UI appears automatically when XR8 detects non-mobile
3. Calls to `captureFrame()` will pull frames from the replay rather than the live camera
