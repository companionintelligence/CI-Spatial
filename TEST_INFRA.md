# Test Infrastructure Guide — Companion Scan

This guide details the test architecture, configuration, commands, and setups for testing the **CI-Web-XR-Scan** project.

---

## 1. Commands

### Run Server and Dev Server
The project runs Vite (frontend dev server) and Deno (backend/inference server) concurrently. To launch both:
```bash
npm run start
```
This spawns:
1. **Deno Server:** runs `main.ts` with `--allow-net`, `--allow-read`, `--allow-write`, `--allow-env`, and `--allow-ffi` permissions on port `8000`.
2. **Vite Dev Server:** serves the client pages (HTML/TS) on port `5173`.

Alternatively, you can run them individually:
*   **Inference Server:** `npm run server` (runs Deno)
*   **Vite Dev Server:** `npm run dev`

### Run E2E Test Suite
The E2E test suite is driven by **Playwright**.
*   **Run all tests (Desktop Webkit simulation):**
    ```bash
    npx playwright test --project=webkit-desktop
    ```
*   **Run Mobile Safari viewport simulation:**
    ```bash
    npx playwright test --project=webkit-iphone15
    ```
*   **Run tests exercising Tailscale URLs with iPhone User-Agent:**
    ```bash
    npx playwright test --project=iphone-usb
    ```
*   **Run specific spec files:**
    ```bash
    npx playwright test tests/e2e-suite.spec.ts --project=webkit-desktop
    npx playwright test tests/server.spec.ts --project=webkit-desktop
    npx playwright test tests/project.spec.ts --project=webkit-desktop
    npx playwright test tests/ar-scan.spec.ts --project=webkit-desktop
    ```

---

## 2. Environment Variables

Configure these variables in your environment or a `.env` file:

*   **`VITE_URL`**: The base URL where Vite is serving the application.
    *   *Default (development):* `https://liambook.capybara-ulmer.ts.net:5175` or `http://localhost:5173`
    *   *Usage:* Checked by the Playwright tests to know what URL to load and query.
*   **`PORT`**: Port for the Deno Hono server.
    *   *Default:* `8000`
*   **`ALLOWED_ORIGIN_PREFIX`**: Prefix for CORS origin filtering on the server.
    *   *Default:* Localhost and tailscale networks (matched via RegExp pattern in `main.ts`).
*   **`SCANS_DIR`**: Directory on the server where uploaded `.glb` scans and companion JSON metadata are saved.
    *   *Default:* `./scans`
*   **`SUMMARIES_DIR`**: Directory where markdown session summaries are saved.
    *   *Default:* `./summaries`
*   **`PROJECTS_FILE`**: Location of the JSON file storing project configurations.
    *   *Default:* `./projects.json`

---

## 3. Test Architecture & Tiers

The test suite contains **53+ browser and server checks** organized across 4 distinct test tiers:

### Tier 1: Feature Coverage (Tests 1–15)
*   **F1 (Backend API):** Boot & Health (`GET /health`), Inference (`POST /infer`), Scan Upload (`POST /upload-scan`), Scan Listing/Deletion (`GET /scans`, `DELETE /scans/:filename`, guarded `DELETE /scans?confirm=delete-all`), Scan Locations Index (`GET /scan-locations`), Projects CRUD.
*   **F2 (Mobile Capture):** Frame conversion & JPEG compression, Focal length to vertical FOV conversion ($58.71^{\circ}$ check), SLAM point cloud extraction, Centroid mapping.
*   **F3 (Web3D Viewer):** Async model loading, click-to-pick raycasting, View Mode (semantic colors) material overrides, Custom tags & notes edits, downsampled/wireframe overlays.

### Tier 2: Boundary & Corner Cases (Tests 16–30)
*   **Security & Validation:** Rejects missing image params on `/infer` (400), sanitizes filenames and blocks path traversal attempts on `/scans/:filename`.
*   **Robustness:** Truncated VLM JSON string parsing and recovery, denormalized pixel coordinates normalization, server startup fallback when ONNX models are missing.
*   **Fallback Physics:** Null hit-test placements (2.0 meters in front of camera), point cloud raycast projections, duplicate detections mitigation (dedup within `0.3m`), corrupt/NaN camera intrinsics fallback, invalid view mode recovery, divide-by-zero model scaling protection, CDN Leaflet library load failure recovery.

### Tier 3: Cross-Feature Combinations (Tests 31–33)
*   **Inference Toggles:** Toggling from remote server inference to local client-side WebGPU (F1 + F2).
*   **Collab Sync:** WebRTC communication syncing 3D canvas edits to connected peers (F1 + F3).
*   **Geotag Flow:** End-to-end capture with GPS geolocation to index map markers in GeoMap (F2 + F3 + F1).

### Tier 4: Real-World Scenarios (Tests 34–38)
*   **Stress & Offline:** Continuous scans in heavily cluttered rooms with duplicate objects, sequential queue handling for rapid-fire frame capture, offline scanning persisting data in IndexedDB with delayed synchronizations.
*   **Walkthroughs:** Multi-floor construction project site setups and real-time remote inspection.

---

## 4. Setup Guidelines

### Tailscale Integration & CORS
The Deno server is designed to support remote devices (like iPhones) connecting over a Tailscale Tailnet.
*   **CORS Origin Matching:** In `main.ts`, the CORS allowed origins are programmatically matched against `localhost`, `127.0.0.1`, private local subnets (`192.168.x.x`, `10.x.x.x`, `172.16.0.0/12`), Tailscale subnet IPs (`100.64.0.0/10`), and Tailscale domain names (`*.ts.net`).
*   **Configuring HTTPS:** To use WebXR/8th Wall on a remote phone, the app must be served over HTTPS. Ensure the Tailscale URL is configured with HTTPS or use `vite-plugin-basic-ssl` to test securely.

### Deno Execution Flags
Make sure to execute Deno with the following permission flags in the Docker container or local commands:
*   `--allow-net`: Necessary for HTTP endpoints, WebRTC signaling, and Ollama connections.
*   `--allow-read`: Reads model files, projects, and saved scans.
*   `--allow-write`: Saves projects, scans, and summaries.
*   `--allow-env`: Accesses port configuration and system variables.
*   `--allow-ffi`: Required if loading ONNX runtime compiled binaries.

### Offline vs. Online Scenarios
*   **Offline Scanning:** When offline, the app writes frame data, telemetry, and temporary detections into the browser's local **IndexedDB** database.
*   **Delayed Sync:** When connection is restored, the client reads the queue of unsynced sessions from IndexedDB, uploads them sequentially to `/upload-scan`, and clears the local cache.
