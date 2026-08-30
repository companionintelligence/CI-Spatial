# CI-Spatial — Documentation Index

CI-Spatial turns a phone walk-through or uploaded media from a place you own
into a private, structured, explorable **4D place record** — captured on phone
or desktop, composed and reconstructed in the Companion Scan Spatial Editor,
and shareable with scoped capabilities. Inference is
**engine-agnostic**: `INFERENCE_MODE=ollama` (default) runs whatever
`OLLAMA_MODEL` is set to (`qwen3-vl:4b` by default — see `npm run setup:models`), `onnx` runs the bundled
`LiquidAI/LFM2.5-VL-1.6B-ONNX`, and `mock` is a deterministic colour-blob CV
engine for CI and tests.

Docs are grouped by directory, and each doc owns exactly one thing. The
directory is the grouping — if you are adding a doc, put it in the folder whose
description it fits rather than at this level.

| Folder | Owns |
|---|---|
| *(this level)* | The two cross-cutting authorities — system design and status — plus the Factory workflow. |
| [`product/`](product/) | What the product is and how it behaves: vocabulary, user journeys, UI reference. |
| [`operations/`](operations/) | Running it: deploy, CI, and hardware subsystems. |
| [`testing/`](testing/) | How it is verified: test architecture, on-device QA, fixture banks. |
| [`pipelines/`](pipelines/) | The reconstruction processors and their integrations. |
| [`adr/`](adr/) | Architecture Decision Records — decisions that outlive a single ticket. |
| [`factory/`](factory/) | Ticket waves. Local-only; never pushed to an issue board. |

## Top level

| Doc | What it covers |
|---|---|
| [../README.md](../README.md) | Front door: what CI-Spatial is, quick start, the engine-agnostic inference explainer, and pointers into every other doc. |
| [architecture.md](architecture.md) | **Canonical system-design authority** — architecture diagrams, the 4D world data model, the complete API + world-job tables, deployment topology, Design Decisions, and Implementation Notes. |
| [roadmap.md](roadmap.md) | The **only** owner of timelines and status — what has shipped vs. what is planned. |
| [FACTORY.md](FACTORY.md) | The Factory ticket workflow, the atlas, and how a wave justifies itself. |

## product/ — what it is and how it behaves

| Doc | What it covers |
|---|---|
| [product/PLACE_SCAN_DESIGN.md](product/PLACE_SCAN_DESIGN.md) | **Current product contract** — Place/Area/Scan/Layer/Thing vocabulary, capture and upload flows, alignment, processing, sharing, GIS, and migration rules. |
| [product/UX_FLOW.md](product/UX_FLOW.md) | The everyday-user first-time journey (FTUE) — the happy path from place selection through capture or upload, calibration, structure, reconstruct, and share. |
| [product/UI_MANUAL.md](product/UI_MANUAL.md) | Surface-by-surface UI reference — the exhaustive control catalog for the AR HUD, start screen, and desktop editor. |
| [product/ui-flow/](product/ui-flow/) | **Screenshot gallery** — mobile + desktop captures of every UI/UX flow, generated automatically from the running app. |
| [product/ui-manual/](product/ui-manual/) | Screenshots backing the UI manual. |

## operations/ — running it

| Doc | What it covers |
|---|---|
| [operations/DEPLOY.md](operations/DEPLOY.md) | Self-hosting and deployment — Deno server, Vite proxy, Ollama, and Tailscale/HTTPS setup. |
| [operations/PLATFORM_SUPPORT.md](operations/PLATFORM_SUPPORT.md) | What runs on which OS and accelerator, what is untested, and `server/capabilities.ts` — the probe that answers "what can this machine actually do?" for your own box. |
| [operations/CI.md](operations/CI.md) | What CI runs, and what it deliberately does not. |
| [operations/GIMBAL_INTEGRATION.md](operations/GIMBAL_INTEGRATION.md) | DJI Osmo Mobile 6 gimbal control over BLE, the `osmo-gimbal` MCP server, and automated grid capture into the ingest pipeline. |
| [operations/COLMAP_SETUP.md](operations/COLMAP_SETUP.md) | Installing COLMAP for the `colmap-poses` pose solve — including why the supported install lands somewhere `which` cannot see. |

## testing/ — how it is verified

| Doc | What it covers |
|---|---|
| [testing/TEST_INFRA.md](testing/TEST_INFRA.md) | Test architecture — tiers, mocks, the mock CV engine, and the npm test commands. |
| [testing/DEVICE_TESTING.md](testing/DEVICE_TESTING.md) | On-device QA over the tailnet, the Android MCP device fleet, and the room-loop drift benchmark. |
| [testing/HOUSE_VALIDATION.md](testing/HOUSE_VALIDATION.md) | Field-acceptance / whole-house validation procedure. |
| [testing/user-test-suite.md](testing/user-test-suite.md) | Scripted user-facing test scenarios. |
| [testing/REAL_CAMERA_FIXTURE_BANK.md](testing/REAL_CAMERA_FIXTURE_BANK.md) | Privacy-safe local bank of validated Android camera evidence. |
| [testing/REAL-SCAN-FIXTURE.md](testing/REAL-SCAN-FIXTURE.md) | The real-scan fixture used by the pipeline tests. |

## pipelines/ — reconstruction processors

| Doc | What it covers |
|---|---|
| [pipelines/colmap-poses.md](pipelines/colmap-poses.md) | COLMAP pose solve — the CPU path to `poses.json` + a sparse seed cloud, and the quality verdict that says whether the solve is usable. |
| [pipelines/lingbot-map.md](pipelines/lingbot-map.md) | LingBot-Map reconstruction integration — point cloud + poses from a session. |
| [pipelines/splat-toolbox.md](pipelines/splat-toolbox.md) | Splat tools index — the desktop editor's Splat Toolbox (train, download `.ply`, splat-detect). |
| [pipelines/splat-train.md](pipelines/splat-train.md) | 3DGS training deep-dive — the dataset converter, the skip contract, and **both `SPLAT_BACKEND` drivers** (Brush, the default, and Spirula Studio) with the measured A/B between them. |
| [pipelines/splat-align.md](pipelines/splat-align.md) | Fitting a trained splat to the scan's metric ground calibration. |
| [pipelines/panoptic-scan.md](pipelines/panoptic-scan.md) | Per-keyframe panoptic segmentation and the lift that turns its 2D segments into world positions. |
| [pipelines/4d-person.md](pipelines/4d-person.md) | Person capture as an animated splat sequence — the one job type that delegates off-box (ADR 0006). |
| [pipelines/SPLAT_DETECT_ROADMAP.md](pipelines/SPLAT_DETECT_ROADMAP.md) | Where splat-based detection is heading. |

## adr/ — decisions

Start at [adr/README.md](adr/README.md) for the index. ADR 0001 (reuse the
existing domain model) is the one most likely to apply to a change you are
about to make.

## factory/ — ticket waves

Waves live in numbered folders with a `README.md` each; see
[FACTORY.md](FACTORY.md) for the workflow and
[factory/TICKET_TEMPLATE.md](factory/TICKET_TEMPLATE.md) for the shape of a
ticket. `factory/atlas.html` is the living picture of the system.

---

_Provenance: the original project request is frozen at
[../history/ORIGINAL_REQUEST.md](../history/ORIGINAL_REQUEST.md). Timelines live
only in [roadmap.md](roadmap.md); system design lives only in
[architecture.md](architecture.md)._
