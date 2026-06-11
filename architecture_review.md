# Architectural Review: Distributed 3D Scanning and Reconstruction

This document presents a rigorous architectural review of the CI Web XR Scan system, covering mobile capture mechanisms, CV backend ingestion, desktop editor rendering, live state synchronization, and Tailscale testing integrations.

---

## 1. Distributed 3D Scanning and Reconstruction Architecture

The system coordinates client-side spatial scanning on a mobile device and a containerized computer vision backend, with desktop editor visualization and synchronization.

```
       ┌────────────────────────────────────────────────────────┐
       │                     Mobile Client                      │
       │  (Vite + TypeScript, running 8th Wall / WebXR engine)  │
       └─────────────────────────┬──────────────┬───────────────┘
                                 │              │
                    WebSocket    │              │ POST /upload-scan (GLB)
                    Signaling    │              │ POST /infer (Image)
                                 ▼              ▼
       ┌────────────────────────────────────────────────────────┐
       │                    Vite Dev Proxy                      │
       │   (Binds to 0.0.0.0:5173, Proxies API to Deno :8000)   │
       └─────────────────────────┬──────────────────────────────┘
                                 │
                            HTTP │ (Internal Relay)
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │                   CV Deno Backend                      │
       │    (Hono, running ONNX Runtime / Ollama VLM pipeline)  │
       └────────────────────────────────────────────────────────┘
```

### 1.1 Mobile Capture Mechanisms (8th Wall & WebXR Fallback)
The system abstracts the underlying AR framework using the `ARProvider` interface:
* **8th Wall**: Provides visual-inertial odometry (VIO) in WASM. It performs native feature mapping, populating a client-side voxel grid (`PointCloud`) from `reality.worldPoints` at 5cm resolution. Camera frame bytes are extracted via `XR8.CameraPixelArray` and compressed to JPEG.
* **WebXR Fallback**: Extracted via `immersive-ar`. Key architectural gaps resolved in this implementation include:
  - *Hardcoded FOV Gap*: Standard WebXR fallback hardcoded vertical FOV to 60°. We extract the camera projection matrix from the `XRView` at runtime:
    $$\text{fovY} = 2 \cdot \arctan\left(\frac{1}{\text{projectionMatrix}[5]}\right) \cdot \frac{180}{\pi}$$
    $$\text{aspect} = \frac{\text{projectionMatrix}[5]}{\text{projectionMatrix}[0]}$$
  - *Hit-Test Centroid Bug*: Centroid hit-testing originally queried only the center viewer ray. We create an `XRRay` from the camera origin through normalized device coordinates (NDC) mapped from the VLM's 2D bounding box centroids, requesting transient hit-test sources on the fly.
  - *WebXR Camera Stream*: Captured using a canvas buffer snapshot or a synchronized helper stream.

### 1.2 CV Backend Pipeline and Ingestion
* **Vite Proxy**: Resolves HTTPS Mixed-Content restrictions on mobile Safari/Chrome. Mobile browsers require HTTPS to enable camera/AR APIs, whereas local Deno servers typically run over HTTP on port 8000. Vite acts as a reverse proxy, mapping secure requests from port 5173 to localhost:8000.
* **Inference Pipeline**: The Deno Hono server coordinates VLM execution (LiquidAI LFM2.5-VL-1.6B-ONNX via `onnxruntime-node` or local Ollama instances). The ONNX runtime requires `--allow-ffi` sandbox flags in Deno 2.x to load native dynamic libraries.
* **Metadata Concurrency**: Scans and room structures are persisted in `projects.json`. Concurrent client writes are managed using atomic file-writing and reading techniques to prevent corruption.

### 1.3 Desktop 3D Scene Editor Rendering
* **Scene Graph Structure**: Organizes elements hierarchically: Floor -> Room -> PointCloud/Camera Path/Semantic Mesh Box. Custom parameters (`label`, `confidence`, `description`, `dimensions`) are saved in the glTF node's `userData`.
* **LOD Gaps**: High point-cloud densities cause frame rate drops. We address this using point-cloud decimation (rendering every N-th vertex at far distances) and THREE.LOD to swap complex 3D meshes with bounding boxes based on camera distance.
* **Asset Loading**: Models and textures are loaded asynchronously, avoiding blocking the main execution thread.

### 1.4 Live State Synchronization
* **WebRTC Signaling**: RELAY is achieved through Hono WebSockets (`/rtc-signal`). The phone joins as `phone` and the desktop as `viewer`.
* **WebRTC RTCDataChannel**: Exists to broadcast real-time state out-of-band:
  - *Camera Pose*: Streamed at 30Hz as `[Float32 × 7]` array (`[x, y, z, qx, qy, qz, qw]`).
  - *Incremental Points*: Sends new voxel grid occupied points as they are captured.
  - *Object Upserts*: Transmits VLM detection events (label, confidence, pos, dimensions) directly to the viewer.
  - *Bidirectional Override*: Tag changes made in the desktop editor are transmitted back to the mobile device's IndexedDB.

---

## 2. Tailscale & Mobile Testing Configuration

To support testing on a physical iPhone over a Tailscale Tailnet (`https://liambook.capybara-ulmer.ts.net`), the network and container settings are configured as follows:

```
[iPhone on Tailnet]
        │
        │ HTTPS (Vite Port 5173, Tailscale certs)
        ▼
[Vite Host (0.0.0.0)] ────Proxy to http://localhost:8000────► [Deno Server Container]
```

* **Vite Host Binding**: Vite binds to `0.0.0.0` to listen on all interfaces. The HMR client targets the Tailnet domain `liambook.capybara-ulmer.ts.net`, allowing the iPhone to establish HMR WebSocket connections.
* **Hono CORS Policy**: Hono CORS middleware evaluates incoming origin headers:
  - Allowing matches containing `.ts.net` (Tailscale domain).
  - Allowing Tailscale subnet IP addresses (within `100.64.0.0/10` address range).
* **Deno Sandbox Environment**: CMD executions run with unrestricted `--allow-env` or explicit listings to prevent `PermissionDenied` errors when querying backend environments (e.g. `SCANS_DIR`, `SUMMARIES_DIR`, `PROJECTS_FILE`, `OLLAMA_HOST`).
* **Docker Network Bridging**: The Deno container maps port `8000` to `0.0.0.0:8000` on the host, ensuring loopback proxy calls from Vite resolve correctly.
