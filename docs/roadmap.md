# Roadmap

Status and timelines for Companion Scan live **here and only here**. This file
uses phase framing — **Shipped**, **Near-term**, **Later / Exploratory** — not
calendar dates. For the system design, data model, and full API table see
[architecture.md](architecture.md). For the everyday-user first-time journey see
[product/UX_FLOW.md](product/UX_FLOW.md). For the field-acceptance protocol see
[testing/HOUSE_VALIDATION.md](testing/HOUSE_VALIDATION.md). The current Place-first
product model and migration rules live in
[product/PLACE_SCAN_DESIGN.md](product/PLACE_SCAN_DESIGN.md).

---

## Shipped

Everything below is implemented on `main` and exercised by the test suite (31
Playwright specs in `tests/` + 32 Deno unit tests at the repo root). The
TypeScript codebase compiles clean.

### Capture (phone)

- **AR SLAM scanning** — 8th Wall SLAM with a WebXR fallback; per-frame JPEG
  capture, hit-test-anchored geometry, live point cloud.
- **Live quality monitoring** — `quality-monitor.ts` surfaces a coverage bar,
  drift / lighting / reflection badges, and a missing-areas count during
  capture, and computes a `ready` / `needs-review` / `needs-rescan` verdict with
  recommendations (written into the GLB; see Near-term for surfacing it on the
  phone).
- **Three capture pipelines** — manual tap-to-capture, auto-capture as you walk,
  and keyframe streaming for reconstruction jobs (`capture/keyframes.ts`).
- **Autosave** — first capture uploads silently to the server.

### Inference (engine-agnostic)

- **Ollama (default)** — `INFERENCE_MODE=ollama`, `OLLAMA_MODEL` defaults to
  `qwen3-vl:4b`; install candidates with `npm run setup:models`, pick with `npm run bench:models`.
- **ONNX** — `INFERENCE_MODE=onnx` runs the bundled
  `LiquidAI/LFM2.5-VL-1.6B-ONNX` via `onnxruntime-node` (~1.5 GB download).
- **Mock** — `INFERENCE_MODE=mock` is a deterministic colour-blob CV engine for
  CI and tests.
- **WebGPU vs server routing** — opt-in via the localStorage key `infer-mode`
  (`src/inference/router.ts`); defaults to server-side. Not auto-detected.
- **Sync scan analysis** — `/process-scan` runs `object-count`,
  `scene-description`, and `floor-plan` actions.

### Spatial + storage

- **Spatial resolver** — `spatial/resolver.ts` pins detections to world-space
  positions.
- **IndexedDB persistence** — sessions and detections survive refresh.
- **GLB export** — point cloud + metadata exported as `.glb`; browser download
  plus server upload (`/upload-scan`), stored server-side and served from
  `/scans`.

### Companion Scan Spatial Editor (`/editor`, implemented by `viewer.html`)

- **4D world model** — loads a `WorldProject` (`src/world/types.ts`): many scans
  placed in one anchored `ENU_Y_UP`, metric (`meters`) frame, geo-anchored at an
  `originGeoPose`. Time lives in per-frame `FrameObservation` streams and the
  append-only `EditPatch[]` log, so a world holds multiple scans of the same
  place captured at different moments.
- **Layers** — typed, addressable layers (points, mesh, floor, detections,
  labels, cameraPath, cameraFrustums, rgbFrames, depth, splat, semanticMasks),
  each independently toggled.
- **Editing** — transform controls, label editing, and measurement, recorded as
  append-only `EditPatch` records.
- **Navigation aids** — compass, scale, coordinate readout, geomap, render modes
  (solid / points / wire / semantic), and live feed.

### Optimization pipeline

- **Scan optimization** — quantization, Draco compression, and progressive LOD
  generation on export; the Spatial Editor streams keyframes and loads coarse LODs
  first.

### Realtime + reconstruction jobs

- **WebRTC live geometry** — `/rtc-signal` signalling + `rtc/broadcaster.ts`
  stream live geometry; `/events` (SSE) for server push.
- **Async job queue** — `/jobs` runs the `WorldJobType` set: `ingest`,
  `extract-layers`, `align-scan`, `merge-points`, `semantic-pass`,
  `depth-reconstruct`, `lingbot-map-reconstruct`, `pipelines/splat-train`, `splat-detect`,
  `export-world` (status `queued | processing | completed | failed`). The
  editor's Queue-Job dropdown exposes 9; `splat-detect` fires from the Splat
  Toolbox.
- **Splat toolbox** — train (Brush, GPU-pinned), detect (3D interaction boxes),
  view, and compress Gaussian splats (`viewer/splat-*.ts`).
- **Video ingest** — `/ingest-video` turns an uploaded walkthrough video into a
  session scan (no `.glb` on disk).
- **LingBot-Map reconstruction** — `lingbot-map-reconstruct` produces point
  cloud + poses sidecars keyed off `sessionId`.

### App shell + UX

- **PWA / offline** — manifest + icons, installable on iOS/Android; Service
  Worker caches the app shell.
- **Onboarding + accessibility** — 3-step onboarding overlay (gated on
  `localStorage['companion-scan-onboarded']`, replayable via `#help-btn`,
  skippable with `?onboarding=0` or `?mock`), accessible controls.

### QA

- **House validation kit** — the two-way (live AR + video) field-acceptance
  protocol and helper scripts (`npm run test:house`, `npm run links:house`); see
  [testing/HOUSE_VALIDATION.md](testing/HOUSE_VALIDATION.md).

---

## Near-term

Realistic next steps that build directly on shipped surfaces.

- **Surface the completion verdict on the phone** — render
  `qualityMonitor.summary()` as a status chip (`✓ Ready to export` / `Review
  recommended` / `Keep scanning`) plus the top recommendation, and add a
  `Done / Finish scan` affordance near the capture button. The verdict already
  exists in code but only appears in the Spatial Editor today. See the guided
  "finish your map" flow in [product/UX_FLOW.md](product/UX_FLOW.md).
- **Close the export loop** — after Export GLB, add a `View in 3D →` link back
  into the world (reuse the video-upload open pattern); gate manual export
  behind a confirm when status is `needs-rescan`.
- **Auth / JWT** — optional token auth on the Deno server so scans and worlds
  can be namespaced per user (minimal email + magic-link UI). No auth today.
- **Shared world links polish** — role-scoped links
  (`/worlds/<shareSlug>`, view/comment/edit/scanner/owner tokens) exist; add QR UI plus token
  revocation and expiry controls.
- **Loop-closure / drift correction** — reduce SLAM drift on long walk-throughs
  via loop closure and origin-return recalibration in the `align-scan` /
  `merge-points` workers (alignment is a local-grid placeholder today).
- **Multi-scan align + merge UX** — surface the manual placement and
  align/merge flow in the editor beyond code comments; wire the Open3D refiner.

---

## Later / Exploratory

Larger bets that are not yet scoped for delivery.

- **Semantic / vector search** — index detection labels and world layers in a
  lightweight vector store; `GET /scans?q=chair`-style ranked queries.
- **Multi-device collaboration** — several devices editing the same world live
  over WebSocket, building on the existing SSE/WebRTC transports.
- **Cloud sync** — mirror server storage to S3-compatible object storage and
  CDN-serve `.glb`/`.splat` assets in share links.
- **Distributed job workers** — move the single job coordinator to a queue
  (e.g. Redis Streams) with CPU/GPU worker capability advertising.
- **AR glasses support** — adapt the provider for WebXR hand-tracking headsets;
  detection pins become volumetric objects.
- **One-click world export bundle** — turn `export-world` into a single bundled
  GLB + semantic-JSON download rather than a manifest/worker-ready step.

---

## Known limitations

- **No auth by default** — anyone who can reach the server can upload/download
  scans and open worlds. Auth is Near-term.
- **SLAM drift on long scans** — pose error accumulates over long (~10 min)
  sessions; walking back to the origin helps. Loop-closure is Near-term.
- **Single-worker job queue** — the async `/jobs` runner is a single worker that
  shares the box with the VLM; heavy reconstruction jobs and inference contend
  for the same hardware.
- **Planned vs real artifacts** — several job runners emit plan/placeholder
  artifacts unless the real worker (Brush, LingBot-Map Python, Open3D) is wired
  via env vars; the runner reports a "hint" when unset, and this distinction is
  currently invisible to the user.
- **GLB size** — file size grows with session length; quantization/Draco/LOD
  reduce but do not cap it.
- **WebXR on iOS** — the WebXR fallback path needs the HelloXR shim on iOS;
  camera + motion permissions cannot be programmatically granted in Playwright
  WebKit, so those paths are verified manually on device.

---

## Architecture

See [architecture.md](architecture.md) for the system diagram, the 4D world data
model, the complete API table, and deployment topology.
