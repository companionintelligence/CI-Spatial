# 11-panoramic-canvas

Gives a scanned Place a **single image of itself** — an occlusion-free equirectangular
panorama, reprojected from the posed keyframes a scan already carries — and lets the VLM
already running on this appliance answer questions about the whole room from it.

The organising idea comes from [OneCanvas](https://baranowskibrt.github.io/onecanvas/)
(Baranowski, Chen, Nießner — TUM + Huawei, [arXiv:2606.19253](https://arxiv.org/abs/2606.19253)):
unproject patch features from many posed views into world space, reproject them onto one
panoramic canvas, and hand that to a **standard pretrained VLM** as a single image. No geometry
encoder, no architectural surgery.

**Its code is not released.** The repo carries the project site and says so:

> "The code is not released yet. It will be available here soon."

So this wave is shaped the way `10-4d-person-capture` was: build the contract and everything
around it, ship value without the framework, and leave a drop-in point for when it lands.

## Why this fits, unusually well

What OneCanvas needs, this repo already produces:

| OneCanvas input | Already here | Where |
| --- | --- | --- |
| K posed RGB frames | `kf-NNNNN.jpg` + `keyframes.jsonl` | `src/capture/keyframes.ts` |
| Camera-to-world SE(3) per frame | `meta.pose`; `lingbot-map.poses.json` for pose-less sessions | `server/splat/splat_train_dataset.ts` |
| Pinhole `fx, fy, cx, cy` | **`deriveIntrinsics()` already converts fovY + aspect, with resolution rescaling** | `splat_train_dataset.ts:299` |
| Depth maps | *missing* — but `depth-reconstruct` is a declared `WorldJobType` with no runner, `LayerType` already has `'depth'`, and `FrameObservation.depthUrl` already exists | `src/world/types.ts` |
| A Qwen3-VL backbone | **`qwen3-vl` is the default inference model** | `.env.example` |

Three things worth saying plainly about that table:

1. **The domain model already anticipated depth.** `depthUrl`, the `'depth'` layer and
   `depth-reconstruct` were declared and never implemented. This wave implements a placeholder
   rather than inventing a concept.
2. **The backbone family already runs here.** OneCanvas is Qwen3-VL-8B; this repo defaults to
   `qwen3-vl:4b`. Same family, one size up.
3. **The canvas can be centred on any viewpoint** — the paper's "situated reasoning" result.
   That maps straight onto Places: centre it on a Place's calibration anchor (ADR 0005) or on a
   `Thing`, and the question is asked *from there*.

### And unlike wave 10, it may run on the fleet

4DAnyone needed **43.3 GiB on one CUDA device** and nothing on the tailnet came close.
OneCanvas *training* was 8× A6000 for 72.5 h — but we would never train. **Inference** is
Qwen3-VL-8B with a frozen vision encoder, LoRA adapters and a 2-layer position-embedding MLP.

At fp16 that is roughly 16 GB of weights plus activations and canvas tokens, and `beta-1`'s
23.98 GiB per card is **plausibly enough**.

**Stated as plausible, not established.** The paper reports training compute and gives no
inference VRAM or latency figure. Ticket 0001 is a measurement, and it decides the deployment
shape before anything is built on the assumption — ADR 0005 rule 5, one subsystem over.

## The shape

```
  PRODUCE THE INPUTS              BUILD THE CANVAS          CONSUME IT
  (this repo, no new ML)          (pure geometry)
  ────────────────────            ────────────────
  posed keyframes ──┐
  intrinsics      ──┼─► depth ──► unproject → spherical ──►  NOW:   RGB canvas → the
  LingBot points  ──┘   (0002)    → equirect canvas            EXISTING Ollama qwen3-vl
                                  (0003)                     LATER: the same geometry over
                                                               patch FEATURES → OneCanvas
```

**The canvas construction needs none of their code.** It is fully specified in the paper —
unproject with depth, rotate into the canvas frame, convert to `(θ, φ)`, place. What the
unreleased weights provide is the trained adapter that reads a **feature** canvas.

So the geometry is built now against **RGB**, which is:

- **useful immediately** — one image of a whole scanned room, handed to the VLM already
  running, answers whole-scene questions that per-frame inference cannot;
- **the same code path** the feature canvas will use, so the later swap is a change of what
  gets projected, not a rewrite;
- **independently valuable** as a Place thumbnail, share preview, or editor backdrop.

That is this wave's equivalent of wave 10's stub mode: the thing that makes everything else
real while the framework is unavailable.

## Tickets

| # | Title | Type | Depends on |
| --- | --- | --- | --- |
| [0001](0001-measure-backbone-fit.md) | Measure whether Qwen3-VL-8B inference fits the fleet | Spike | none |
| [0002](0002-implement-depth-reconstruct.md) | Implement `depth-reconstruct` — per-keyframe depth from the LingBot point cloud | Backend | none |
| [0003](0003-equirectangular-canvas.md) | The equirectangular canvas builder and `CanvasManifest` | Backend | 0002 |
| [0004](0004-frame-selection.md) | Frame selection: 2000 keyframes → the K that matter | Backend | 0003 |
| [0005](0005-ask-the-canvas.md) | Ask the canvas a question — wire it to the existing Ollama path | Backend | 0003 |
| [0006](0006-canvas-in-the-editor.md) | Canvas in the editor: layer, origin picker, situated questions | Frontend | 0003, 0005 |
| [0007](0007-adr-docs-atlas.md) | ADR 0007, pipeline doc, atlas pass | Docs | all |

A deliberately-undrafted **0008** is the drop-in point for the released code. Drafting it now
would mean inventing an API that does not exist yet; it gets written against what actually ships.

## Execution order

**0001 lands first and can change the shape of everything after it.** It is a measurement, not
a feature: if Qwen3-VL-8B fits `beta-1`, this is an on-fleet capability and 0005 targets the
local Ollama. If it does not, it becomes a `subsystems/onecanvas/` worker on the `4d-capture`
pattern already in the repo.

**0002 and the paper-reading half of 0003 proceed in parallel with it** — neither depends on
the answer.

```
0001 (measure) ──┐
                 ├─► 0005 ──┐
0002 ──► 0003 ───┴─► 0004   ├─► 0006 ──► 0007
                            │
                    (0008 when the code lands)
```

## What can actually run in parallel

Keyed by shared files, not logic:

| File | Touched by |
| --- | --- |
| `server/main.ts` | 0002, 0003, 0005 |
| `src/world/types.ts` | 0002, 0003 |
| `src/world/manifests.ts` | 0003 |
| `src/viewer/viewer.ts` | 0006 |
| `docs/testing/DEVICE_TESTING.md` | 0001, 0007 |

**0001** is conflict-free — it writes a measurement into its own ticket and a `DEVICE_TESTING.md`
section. **0006** is confined to `src/viewer/`. Everything else serialises on `server/main.ts`.

## The atlas

Until this wave's atlas pass, `docs/factory/atlas.html` described `depth-reconstruct` and the
`'depth'` layer as declared-with-no-producer, and had no entry for any panoramic or
whole-scene-reasoning surface — correctly, because none existed. That gap is filled as part of
this wave's Phase 6 pass, which is what gives its before/after diffs something accurate to diff
against.

Entries this wave changes: the **Inference & Jobs** section (a `depth-reconstruct` producer at
last, and a whole-scene question path beside the per-frame one), a new **Panoramic canvas** card
under Spatial Reconstruction, the `LayerType` and `WorldJobType` schema rows, and the config
table.

## Found and deferred

- **A feature canvas without OneCanvas.** Reprojecting a frozen encoder's patch features is
  possible with what ships in this repo; what is *not* available is the trained adapter that
  reads them. A feature canvas fed to an un-adapted VLM would be noise, so it waits.
- **Forward geocoding for the canvas origin.** The origin is a pose; naming it ("centre on the
  kitchen") needs the `Thing` correspondence work from wave 08 to be further along.
- **Retention.** A canvas per scan per origin is cheap next to a splat, but nothing in this repo
  prunes derived artifacts. Same gap wave 10 recorded.
