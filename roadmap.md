# Roadmap

## v1.0 — Shipped ✅

The initial working product. All core features are implemented and the TypeScript codebase compiles clean.

### Completed
- **AR scanning** — 8th Wall SLAM + per-frame JPEG capture
- **LFM2.5-VL inference** — Deno server runs the vision model via `llama.cpp` bindings; detections arrive as 3D-pinned markers in the AR scene
- **3D pins** — `THREE.Sprite` overlays anchored to world-space hit-test positions, persist across frames via the detection store
- **Session persistence** — IndexedDB stores every session; detections survive page refresh
- **GLTF export** — exports the live point-cloud + metadata as a `.glb`; browser download + server upload (`POST /upload-scan`)
- **Server scan storage** — Deno writes `.glb` files to `./scans/`; served via `GET /scans` + `GET /scans/:filename`
- **3D desktop viewer** — `viewer.html` + Three.js OrbitControls, loads scans from the server, HTML label overlays
- **History drawer** — slide-in panel; expandable per-session detection list; select / edit / delete
- **Side panel** — object manifest with close button, per-detection select/deselect/inline edit
- **Reactive store** — `store.ts` with `updateDetection`, `toggleSelect`, `selectAll`, `deselectAll`
- **PWA** — manifest + icons, `start_url`, installable on iOS/Android
- **Test suite** — Playwright tests covering the app shell, health endpoints, inference API, scan storage CRUD, path-traversal guards, 3D viewer page, side panel, history drawer, AR flow

---

## v1.1 — Near-term

Focus: **quality-of-life + CI/CD**

| # | Feature | Notes |
|---|---------|-------|
| 1.1.0 | **World scan editor foundation** | `viewer.html` now loads a `WorldProject` instead of a single GLB: many scans can be placed in one ENU/Y-up scene, aligned with sidecar transforms, and inspected with compass, scale, coordinate readout, map pins, layer toggles, labels, camera frustums, and transform controls. |
| 1.1.1 | **8th Wall simulator in CI** | Use XR8's built-in desktop replay mode to run `@simulator`-tagged Playwright tests headlessly. Capture a reference SLAM session (`.bin`) once on device and commit to `public/test-fixtures/`. |
| 1.1.2 | **Docker image** | Single `Dockerfile` running the Deno server; `docker-compose.yml` with a volume for `./scans/`. Enables reproducible local dev and cloud deploy. |
| 1.1.3 | **GitHub Actions CI** | `push` → lint + `tsc --noEmit` + Playwright (`webkit-desktop` project); cache Deno and npm modules. |
| 1.1.4 | **Lighthouse / a11y audit** | Run `@lhci/cli` against both `index.html` and `viewer.html`; fail build on score < 80. |
| 1.1.5 | **Scan delete** | `DELETE /scans/:filename` endpoint + delete button in viewer sidebar and history drawer. |
| 1.1.6 | **Richer metadata** | Store device orientation, GPS (if granted), and session duration alongside each `.glb`. Show in viewer sidebar. |
| 1.1.7 | **Confidence threshold UI** | Slider in settings panel to filter low-confidence detections from export and viewer. |

---

## v1.2 — Medium-term

Focus: **sharing + search**

| # | Feature | Notes |
|---|---------|-------|
| 1.2.1 | **QR share links** | Each saved scan gets a short URL (`/view/:id`). Page renders viewer.html pre-loaded with that scan. QR code shown in export dialog. |
| 1.2.2 | **Semantic search** | Index detection labels with a lightweight vector store (e.g. `chromadb` sidecar or `sqlite-vss`). `GET /scans?q=chair` returns ranked results. |
| 1.2.3 | **Scan thumbnail** | Capture a WebGL screenshot at export time; store as `<timestamp>.thumb.jpg` alongside the `.glb`. Show in scan-list cards. |
| 1.2.4 | **Offline-first** | Service Worker caches the Vite build shell + viewer; requests queue with background sync when the Deno server is unreachable. |
| 1.2.5 | **Progressive mesh LOD** | On export, generate a low-poly version of the point cloud (Draco compression via `gltf-pipeline`). Viewer loads LOD0 first. |
| 1.2.6 | **User accounts (optional)** | JWT-based auth on the Deno server; scans are namespaced per user. Minimal UI: email + magic link. |
| 1.2.7 | **Shared world links** | World-level links now exist for `/viewer.html?world=<slug>&token=<role-token>` and `/scanner.html?world=<slug>&token=<scanner-token>`; next step is QR UI and token revocation/expiry controls. |
| 1.2.8 | **Processing workers** | The local coordinator exposes queued job records for `ingest`, `extract-layers`, `align-scan`, `merge-points`, `semantic-pass`, `depth-reconstruct`, `splat-train`, and `export-world`; next step is Redis Streams plus CPU/GPU worker capability advertising. |

---

## v1.3 — Long-term

Focus: **collaboration + cloud**

| # | Feature | Notes |
|---|---------|-------|
| 1.3.1 | **Real-time collaboration** | WebSocket (Hono `upgradeWebSocket`) broadcasts detection events; multiple devices update the same shared session live. |
| 1.3.2 | **Cloud sync** | Option to mirror `./scans/` to S3-compatible storage (Cloudflare R2 / AWS S3). CDN-served `.glb` URLs in share links. |
| 1.3.3 | **AR glasses support** | Adapt the 8th Wall provider for WebXR hand-tracking (Meta Quest, Magic Leap). Detection pins become volumetric objects. |
| 1.3.4 | **Floor-plan export** | Post-process the scan's detected object positions to generate a 2D SVG floor plan with labelled furniture. |
| 1.3.5 | **LLM scene description** | After export, POST the detection list to an LLM endpoint; get a one-paragraph natural-language summary of the room. Show in viewer sidebar. |
| 1.3.6 | **Multi-session merge** | Align two scans taken from different angles using overlapping detections as registration anchors; merge into a single `.glb`. |
| 1.3.7 | **Semantic world map + splats** | Capture RGB frames, poses, intrinsics, optional depth, and camera frustums as `FrameObservation` sidecars; train Gaussian splats as visual layers while keeping canonical geometry, labels, categories, and edit patches structured. |

---

## Known Limitations

- **Camera + motion permissions on iOS** cannot be programmatically granted in Playwright WebKit; those test paths must be verified manually on device.
- **LFM2.5-VL inference latency** is ~0.5–2 s per frame depending on hardware; frame-skip logic mitigates this but object-dense rooms may lag.
- **SLAM drift** accumulates over long sessions (~10 min); recalibrating by walking back to the origin helps.
- **GLB file size** grows with session length; no mesh simplification or point-cloud decimation is applied yet (see v1.2.5).
- **No auth** on the Deno server — anyone on the local network can upload/download scans (see v1.2.6).

---

## Architecture Notes

See [architecture.md](architecture.md) for the full system diagram and component inventory.
