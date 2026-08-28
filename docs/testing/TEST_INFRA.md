# Test Infrastructure Guide — CI-Spatial

This guide details the test architecture, configuration, commands, and setups for testing the **CI-Spatial** project.

---

## 0. Where tests live

Three suites, three runners. The directory is the runner — that separation used
to live only in `deno.json`'s hand-maintained file list, where it was invisible
and easy to break.

| Path | Runner | Command | What belongs here |
|---|---|---|---|
| `tests/*.spec.ts` | Playwright | `npm test` | Browser and API end-to-end specs. |
| `tests/unit/deno/` | Deno | `deno task test` | Unit tests for server-side modules. Directory glob — adding a file needs no config change. |
| `tests/unit/node/` | `node --test` | the `npm run test:*` scripts | Unit tests for browser-side modules that need DOM lib types (IndexedDB, canvas, `document`). Deno's type-check rejects these, which is why they are a separate suite rather than a naming convention. |

Two things to know before moving a test between them:

- **Playwright's default `testMatch` includes `*.test.ts`**, so it would try to
  run both unit directories. `playwright.config.ts` ignores `/unit\//` — at the
  top level *and* in each browser project, because a project-level `testIgnore`
  replaces the top-level value rather than merging with it.
- **Resolve repo paths from the repo root, not from the test module.** Tests
  that read source files or fixtures anchor on
  `new URL('../../../', import.meta.url)`. Using `import.meta.url` directly
  silently breaks on any move, and the failure reads as a missing fixture
  rather than a wrong base path.

## 1. Commands

### Run Server and Dev Server
The project runs Vite (frontend dev server) and Deno (backend/inference server) concurrently. To launch both:
```bash
npm run start
```
This spawns:
1. **Deno Server:** runs `server/main.ts` with `--allow-net`, `--allow-read`, `--allow-write`, `--allow-env`, and `--allow-ffi` permissions on port `8000`.
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

### The development loop and the known-failures baseline

Running the Playwright suite raw is not a useful gate right now: a set of specs
has been red for a long time, so a run that fails on all of them every time
teaches you to ignore the result. `scripts/loop.mjs` (`npm run loop`) is the
gate that works instead. It runs tiers in order — types, Deno units, contract
gates, the startup-budget UI specs — and stops at the first failure, because a
type error makes every downstream result meaningless.

`tests/known-failures.json` is that loop's **baseline**: a list of
Playwright test ids (spec file + full title) that were already failing when the
loop was introduced. The loop does not require the list to be empty. It fails on
a **change** in either direction:

- a failure not in the baseline — a regression you just introduced;
- a baselined test that now passes — which is how the list shrinks instead of
  quietly becoming permanent.

```bash
npm run loop            # tiers 0-3, the fast pre-commit loop
npm run loop:full       # through tier 5 — adds the reconstruction check and the
                        # whole mock suite, gated on change rather than on green
npm run loop:baseline   # re-record the baseline from a full mock run
```

Only run `loop:baseline` deliberately, and say why in the commit — it accepts
whatever is red at that moment as the new normal, so an accidental run buries a
regression instead of reporting it. The file's own `note` field states the rule:
shrink it; never grow it without saying why.

---

## 2. Environment Variables

Configure these variables in your environment or a `.env` file:

*   **`VITE_URL`**: The base URL where Vite is serving the application.
    *   *Default (development):* `https://liambook.capybara-ulmer.ts.net:5173` or `http://localhost:5173`
    *   *Usage:* Checked by the Playwright tests to know what URL to load and query.
*   **`PORT`**: Port for the Deno Hono server.
    *   *Default:* `8000`
*   **`ALLOWED_ORIGIN_PREFIX`**: Prefix for CORS origin filtering on the server.
    *   *Default:* Localhost and tailscale networks (matched via RegExp pattern in `server/main.ts`).
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
*   **Fallback Physics:** Null hit-test placements (2.0 meters in front of camera), point cloud raycast projections, duplicate detections mitigation (dedup within `0.3m`), corrupt/NaN camera intrinsics fallback, invalid view mode recovery, divide-by-zero model scaling protection, and the geo map never reaching a CDN for Leaflet (it is bundled from npm; Test 30 asserts zero unpkg requests).

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
*   **CORS Origin Matching:** In `server/main.ts`, the CORS allowed origins are programmatically matched against `localhost`, `127.0.0.1`, private local subnets (`192.168.x.x`, `10.x.x.x`, `172.16.0.0/12`), Tailscale subnet IPs (`100.64.0.0/10`), and Tailscale domain names (`*.ts.net`).
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

---

## 5. Synthetic Test Data & Mocked AR Runtimes

Everything in this section is deterministic — seeded generators, scripted
runtimes, and a model-free CV engine — so the full scan pipeline runs in CI
with no device, no SLAM binary, and no VLM weights.

### Generated corpus (`npm run gen:test-data` → `test-data/`, gitignored)

| Artifact | Generator | Contents |
|---|---|---|
| `test-data/homes/` | `scripts/generate-test-homes.mjs` | **24 procedural home scans** (8 archetypes × 3 variants: studio, living room, kitchen, office, dining, kids, media, one-bed). Each GLB matches the mobile exporter schema — point cloud (11k–22k pts sampled from walls/floor/furniture with SLAM-style noise), camera path, floor plane, detection boxes with full `extras`, geo metadata — plus a server-metadata sidecar and `expected.json` ground truth (dims, furniture positions/sizes/labels). |
| `test-data/cv/` | `scripts/generate-cv-images.mjs` | **16 synthetic room images** (pseudo-3D front views with palette-coloured furniture) + `expected.json` bounding-box ground truth. A deterministic regression fixture for the *mock* engine only — no photo-trained vision model can score meaningfully against it (see below). |

Seed a running server with the corpus: `npm run seed:test-data`
(`COUNT=6` for a subset, `SERVER_URL=` to target another server).

### Real-photograph corpus (`test-data/real/`, checked in — not generated)

Unlike the corpora above, `test-data/real/` is **not** produced by `npm run gen:test-data`
and is carved out of the `test-data/` gitignore. It holds real photographs with
human-verified ground truth (`verifiedBy`/`verifiedAt` per entry) — the only corpus that
can tell a working vision model from a fabricating one; see
`docs/factory/06-detection-ground-truth/0001-real-photograph-corpus.md` and
`test-data/real/README.md` for sourcing, privacy and synonym policy. As of this writing
it is scaffolded (schema + policy) but has **0 photographs** — a manual/physical step not
yet done.

### Mock CV engine (`INFERENCE_MODE=mock`)

`server/inference.ts` gains a third engine: a deterministic colour-blob detector
(grid sampling + union-find connected components over the shared palette in
`src/shared/cv-palette.ts`). It closes the loop with the generated CV images
and the xr8-mock camera feed — `/infer` returns exact, repeatable detections.

Score any engine against a corpus, chosen by `CV_CORPUS` (default `real`):
```bash
npm run eval:cv                       # CV_CORPUS=real (default) → test-data/real/report.json
CV_CORPUS=synthetic npm run eval:cv   # mock-engine fixture → test-data/cv/report.json
STRICT=1 CV_CORPUS=synthetic npm run eval:cv   # CI gate (mock engine baseline: P=R=100%, meanIoU≈0.94)
```
Scoring a non-mock engine against `CV_CORPUS=synthetic` prints a loud warning and adds
`outOfDistributionWarning` to `report.json` — a real vision model is expected to score
~0% there and that is not a verdict on the model. See
`docs/factory/06-detection-ground-truth/0002-retarget-eval-and-bench.md`.

### Detection regression gate

`STRICT=1` (above) is also the regression gate — see
`docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md`. It compares a
run against a **committed baseline** (`<corpus dir>/baseline.json`, a checked-in copy of a
prior `report.json` — same shape, no new format) and fails only on a drop bigger than
`scripts/lib/detection-gate.mjs`'s `BASELINE_TOLERANCE` (±0.05 on precision/recall/meanIoU,
a placeholder pending measured run-to-run variance — see that ticket's "Manual step
remaining"). Without a committed baseline it falls back to the original fixed thresholds,
which is what the synthetic corpus above uses today (it's gitignored, so nothing can be
committed there).

**What triggers it** — a change to any of: `server/inference.ts`, `server/prompt.ts`,
`src/inference/prompt.ts`, `src/shared/model-catalog.ts`, `src/shared/ollama-model.ts`,
`src/capture/capture.ts` (the full list, with why each one matters, is
`scripts/lib/detection-gate.mjs`'s `TRIGGER_FILES`). Deliberately narrow — see
`docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md`'s "What triggers
the gate".

**Two enforcement halves**, per that ticket's chosen option 3:

1. **CI-executable, every PR, no model needed** (`.github/workflows/deno-ci.yml`'s
   `detection-gate` job):
   - A path filter (`npm run check:detection-gate`) that WARNS if a trigger file changed
     but `test-data/real/` has 0 photographs (true as of this writing — 0001's manual step),
     and FAILS if the real corpus is populated but `test-data/real/baseline.json` wasn't
     updated in the same diff.
   - The mock-engine pipeline regression (`npm run gate:mock`) — starts the Deno server
     with `INFERENCE_MODE=mock`, runs `CV_CORPUS=synthetic STRICT=1 npm run eval:cv`. Catches
     harness/schema breakage, not model-quality regressions (the mock engine runs no model).
2. **Local, human, pre-merge — required when you touch a trigger file above:**
   ```bash
   CV_CORPUS=real STRICT=1 npm run eval:cv    # scores your change against the real corpus
   npm run accept:detection-baseline          # promotes report.json -> baseline.json
   git add test-data/real/baseline.json       # commit it alongside your change
   ```
   This needs Ollama and the real corpus populated — CI cannot do it (no GPU, no models; see
   the ticket's "hard constraint: CI has no model"). If `eval:cv` prints a `FAIL` line, the
   diff regressed detection quality beyond tolerance; investigate before promoting a new
   baseline over it.

### Mocked AR runtimes

*   **XR8 mock** (`public/test-fixtures/xr8-mock.js`, load with `/?mock=xr8`):
    scripted replacement for the 8th Wall engine — emits SLAM poses, world
    feature points, and a fake camera feed showing palette-coloured furniture.
    The CI equivalent of the 8th Wall desktop simulator / forum mocks pattern.
*   **WebXR emulation** (`/?ar=webxr&mock=webxr`): installs
    [iwer](https://github.com/meta-quest/immersive-web-emulator) — Meta's
    Immersive Web Emulation Runtime — via a lazy-loaded test hook
    (`src/test/webxr-emulation.ts`), exposing the device as
    `window.__iwerDevice` for tests.

### New Playwright projects

| Project | Needs | Command |
|---|---|---|
| `api` | Deno server only (no browser binary). Pair with `INFERENCE_MODE=mock` + generated corpus. | `API_URL=http://localhost:8000 npm run test:api` |
| `chromium-mock` | Vite + Deno (mock engine) + headless Chromium (fake-media flags). | `VITE_URL=https://localhost:5173 npm run test:mock` |

Coverage: `api-test-homes` (24-home upload → job queue → manifests/LODs →
world synthesis → deletion → keyframe sessions), `api-cv-mock` (/infer shape,
ground-truth IoU ≥ 0.8, determinism), `mock-xr8-scan` (full capture →
inference → resolve pipeline in a browser), `mock-webxr-emulated` (WebXR
route + emulated immersive-ar session), `mock-editor-homes` (editor scan
list, progressive load status, layers, measurement tool).

Note: `@playwright/test` is pinned to **1.58.x** — 1.60.0 has a spec-loading
regression in this repo ("did not expect test.describe()").
