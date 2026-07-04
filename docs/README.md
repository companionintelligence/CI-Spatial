# Companion Scan — Documentation Index

Companion Scan turns a phone walk-through of a place you own into a private,
structured, explorable **4D map** — scanned on the phone, composed and
reconstructed in a desktop editor, and shareable as a world. Inference is
**engine-agnostic**: `INFERENCE_MODE=ollama` (default) runs whatever
`OLLAMA_MODEL` is set to (`moondream:latest` by default), `onnx` runs the bundled
`LiquidAI/LFM2.5-VL-1.6B-ONNX`, and `mock` is a deterministic colour-blob CV
engine for CI and tests.

This index lists every doc, grouped by purpose. Each doc owns exactly one thing —
see the group headers for where to look.

## Getting started
| Doc | What it covers |
|---|---|
| [../README.md](../README.md) | Front door: what Companion Scan is, quick start, the engine-agnostic inference explainer, and pointers into every other doc. |

## Architecture
| Doc | What it covers |
|---|---|
| [../architecture.md](../architecture.md) | **Canonical system-design authority** — architecture diagrams, the 4D world data model, the complete API + world-job tables, deployment topology, Design Decisions, and Implementation Notes. |
| [../roadmap.md](../roadmap.md) | The **only** owner of timelines and status — what has shipped vs. what is planned. |

## UX & flows
| Doc | What it covers |
|---|---|
| [UX_FLOW.md](UX_FLOW.md) | The everyday-user first-time journey (FTUE) — the happy-path story from install through scan, structure, reconstruct, and share, plus the capture vs. auto-capture vs. keyframe-stream vs. live-RTC mental model. |
| [UI_MANUAL.md](UI_MANUAL.md) | Surface-by-surface UI reference — the exhaustive control catalog for the AR HUD, start screen, and desktop editor. |

## Operations & deploy
| Doc | What it covers |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Self-hosting and deployment — Deno server, Vite proxy, Ollama, and Tailscale/HTTPS setup. |
| [DEVICE_TESTING.md](DEVICE_TESTING.md) | On-device QA — running against a real iPhone/Android over the Tailnet. |
| [HOUSE_VALIDATION.md](HOUSE_VALIDATION.md) | Field-acceptance / whole-house validation procedure. |

## Reconstruction pipeline
| Doc | What it covers |
|---|---|
| [lingbot-map.md](lingbot-map.md) | LingBot-Map reconstruction integration — point cloud + poses from a session. |
| [splat-toolbox.md](splat-toolbox.md) | Splat tools index — the desktop editor's Splat Toolbox (train, download `.ply`, splat-detect). |
| [splat-train.md](splat-train.md) | Brush 3DGS deep-dive — GPU-pinned splat training from captured sessions. |

## Testing & validation
| Doc | What it covers |
|---|---|
| [../TEST_INFRA.md](../TEST_INFRA.md) | Test architecture — tiers, mocks, the mock CV engine, the 14 `tests/` specs + 4 root Deno unit tests, and the npm test commands. |

---

_Provenance: the original project request is frozen at
[../history/ORIGINAL_REQUEST.md](../history/ORIGINAL_REQUEST.md). Timelines live
only in [../roadmap.md](../roadmap.md); system design lives only in
[../architecture.md](../architecture.md)._
