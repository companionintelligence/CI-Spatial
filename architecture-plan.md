## Repo: `companion-scan-web`

### What this is

A from-scratch web app that lets anyone point their phone at a room, tap Capture, and walk away with a `.glb` semantic map of the space — every detected object placed at its real 3D world position. Works on Android, iOS, tablets, Quest, and desktop. No app install.

This is a CI product: private by default, runs the VLM on-device when the hardware supports it, falls back to your Deno server when it doesn't.

---

### Tech decisions

**Framework:** Vite + vanilla JS (no framework overhead in an AR loop). TypeScript for the inference and spatial layers, plain JS for the 8th Wall pipeline hooks.

**AR runtime:** 8th Wall as primary (covers Android + iOS + headsets with the same API). WebXR `immersive-ar` as secondary for devices where 8th Wall isn't available (Quest browser, Android XR). A thin provider abstraction means the capture layer doesn't care which is active.

**VLM:** LFM2.5-VL-1.6B-ONNX. Two paths, one interface: the router checks `navigator.gpu` at startup and either loads the WebGPU worker (on-device, Android Chrome 121+, desktop) or routes POST calls to your Deno server (iOS, older Android, fallback). The caller just awaits `infer(imageBlob)` — it doesn't know which path ran.

**3D / export:** Three.js scene graph accumulates detected objects as `Object3D` nodes with `userData`. `GLTFExporter` serializes the whole thing to `.glb` on demand.

---

### File structure

```
companion-scan-web/
├── index.html
├── vite.config.ts
├── package.json
│
├── src/
│   ├── main.ts                    # entry — boots AR, wires modules
│   │
│   ├── ar/
│   │   ├── provider.ts            # abstract ARProvider interface
│   │   ├── eighthwall.ts          # 8th Wall implementation
│   │   └── webxr.ts               # WebXR fallback implementation
│   │
│   ├── capture/
│   │   └── capture.ts             # CaptureModule — bitmap + pose + hits on button press
│   │
│   ├── inference/
│   │   ├── router.ts              # feature-detect → webgpu or server
│   │   ├── webgpu.worker.ts       # LFM2.5-VL ONNX in Web Worker
│   │   ├── server.ts              # Deno REST client
│   │   └── prompt.ts              # structured prompt template + JSON parser
│   │
│   ├── spatial/
│   │   └── resolver.ts            # bbox → ray → hitTest → worldPos + dedup
│   │
│   ├── scene/
│   │   └── store.ts               # reactive store, IndexedDB persistence
│   │
│   ├── export/
│   │   └── gltf.ts                # three.js GLTFExporter wrapper → .glb download
│   │
│   └── ui/
│       ├── overlay.ts             # AR label pins, capture button, progress
│       └── panel.ts               # detected objects list, export button
│
└── server/                        # Deno server (separate deploy)
    ├── main.ts                    # Hono HTTP server
    ├── inference.ts               # onnxruntime-node LFM sessions
    └── Dockerfile
```

---

### Build order — what to write first

**Phase 1 — Capture works, inference is stubbed**
Get 8th Wall running, the capture button grabs a bitmap + pose, logs them to console. No VLM yet. Validates the AR pipeline end-to-end on a real Android device. One day.

**Phase 2 — Inference router returns real detections**
Wire the WebGPU worker with LFM2.5-VL. Stub the spatial resolver — just log the bounding boxes and the pose together. Deploy the Deno server with the same model. Validate both paths return the same JSON shape. Two to three days.

**Phase 3 — Spatial resolver places objects in 3D**
`XR8.XrController.hitTest(x, y)` takes normalized screen coordinates (0–1) and returns estimated 3D world positions. Take each bbox centroid, normalize it to 0–1 screen space, hit-test, store the world position. Add deduplication — if two captures return the same label within 0.3m of each other, merge them. One to two days.

**Phase 4 — Scene store + live UI pins**
Store accumulates detections. Overlay renders a label pin at each object's screen-projected world position on every AR frame. Feels like the Quest/Unity experience, in a browser tab. One day.

**Phase 5 — GLTF export**
The GLTFExporter pipeline traverses the Three.js scene graph — for each `Object3D`, `processNode()` generates a node definition, and `userData` is preserved in the export. Each detection becomes an empty `Object3D` at its world position with `userData` containing label, confidence, description, and thumbnail data URL. Export → `.glb` download. Half a day.

**Phase 6 — iOS + polish**
Test iOS path (Deno server fallback). Add model download progress UI for the first WebGPU load. PWA manifest so it installs to home screen. Add a "session replay" mode that loads a saved IndexedDB session and re-renders the map. One to two days.

---

### The inference prompt

```
You are a spatial object detector. Analyze this image and respond with 
ONLY a JSON array. No other text. Format:
[{"label": "chair", "bbox": [x1,y1,x2,y2], "confidence": 0.92, 
  "description": "wooden dining chair, brown"}]
Where bbox values are 0–1 normalized to image dimensions.
```

LFM2.5-VL handles this reliably — it was designed for structured output and OCR-style tasks.

---

### Platform support matrix

| Device | AR runtime | VLM path | GLTF export |
|---|---|---|---|
| Android (Chrome 121+) | 8th Wall | On-device WebGPU | ✅ |
| Android (older) | 8th Wall | Deno server | ✅ |
| iPhone / iPad | 8th Wall | Deno server | ✅ |
| Quest 3 browser | WebXR | On-device WebGPU | ✅ |
| Desktop Chrome | WebXR / no AR | On-device WebGPU | ✅ (no spatial) |

---

### Connection to CI product

This repo is a standalone web experience but designed to slot into the Companion Intelligence ecosystem. The `.glb` output and the raw detection JSON (label, worldPos, description, timestamp) can feed directly into Digital Memory — rooms and objects as first-class entities in the personal database. The Deno server can run on Companion Core hardware. The on-device WebGPU path is zero-data-exfiltration by design, matching CI's privacy-first positioning.
