# Project: CI Web XR Scan

## Architecture
- Mobile Capture (8th Wall/WebXR) and CV backend pipeline.
- Desktop Editor Rendering (WebGL/WebGPU) with Three.js.
- Live state synchronization via WebRTC.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Architectural Review | Perform architectural review and generate architecture_review.md | None | PLANNED |
| 2 | Fix Backend Container | Fix Dockerfile and model path mismatches | None | PLANNED |
| 3 | Optimize Mobile Capture | Expose camera intrinsics, depth, and pose; optimize payload | None | PLANNED |
| 4 | Desktop Editor Enhancements | Add LOD and async asset loading | None | PLANNED |
| 5 | E2E Verification | End-to-end integration and Forensic Auditor checks | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
- Mobile Capture to server payload: image frame + pose + camera intrinsics + depth.
- Desktop Editor: level of detail, asynchronous asset loading interfaces.

## Code Layout
- `main.ts`, `inference.ts`, `prompt.ts`, `Dockerfile`: Deno Backend server
- `src/ar/`: AR providers (8th Wall / WebXR)
- `src/capture/`: Camera capture logic
- `src/spatial/`: 3D position resolvers
- `src/scene/`: Client scene database
- `src/viewer/`: Editor and desktop 3D viewer
