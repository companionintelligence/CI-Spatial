> **Type:** Infra
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/4d-capture-subsystem`
> **Commit style:** `feat(subsystem): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0005 for the wire contract — but **start it immediately**; it shares no files
> with any other ticket and its stub mode unblocks 0007's tests.

## Goal

Build `subsystems/4d-capture/` — the detached worker that turns a take into a playable 4D
sequence. It runs 4DAnyone when there is only one clip, skips it when there are real cameras,
and trains a Gaussian splat per timestep either way. It runs on a cloud or CUDA box, never on
the appliance.

## Why this is detached

Measured, not assumed. Upstream 4DAnyone's own `docs/inference_performance.md` (in
[ant-research/4DAnyone](https://github.com/ant-research/4DAnyone), not this repo) reports the
6-view full-orbit configuration at **43.3 GiB peak CUDA allocation**, with denoising alone taking 7.8 min on an
H200 and 22.9 min on an RTX A6000.

Probed on the tailnet 2026-08-24: `beta-1` is 2× Radeon RX 7900 XTX at **23.98 GiB each**, ROCm
6.4.0-47, **no CUDA**. `beta-red` is a 10 GiB RTX 3080. Nothing else on the fleet has a usable
GPU. That is a ~1.8× per-device VRAM shortfall against a model that does not shard across cards,
on the wrong vendor's stack. Upstream lists "Low-memory inference (<32 GB)" as **not done**, and
even that would not fit.

So this subsystem is written to run *somewhere else*, and the appliance never depends on it
being present — 0005's skip contract is what makes that safe.

## Non-goals

- Do not add this to the Deno server, the Vite build, the root `package.json`, or `deno.json`. It
  is a sibling of `subsystems/osmo-ble/`, with its own dependency tree.
- Do not vendor 4DAnyone's weights or code into this repo. It shells out to an existing checkout,
  exactly as `SPLAT_DETECT_DIR` and `SENSENOVA_DIR` already do.
- Do not implement a deformable 4DGS trainer. Per-timestep Brush is this wave's chosen path; the
  frame-set contract keeps the door open (see the wave README's Found and deferred).
- Do not implement optical/flash sync refinement. Deferred with the rest of 0002's Non-goals.
- Do not build a UI. The appliance is the only client.

## Pinned conventions

**Subsystem shape.** Mirror `subsystems/osmo-ble/`: own `package.json`, own `README.md`, own
`.gitignore`, source split by role. Its README is the model for **honesty about confidence** —
it states plainly which parts are verified against real hardware and which are synthesized from
reverse-engineering. Do the same here: this subsystem will ship substantially unverified against
real 4DAnyone until a GPU exists, and the README must say so rather than implying it works.

**4DAnyone invocation** — pin from its README, do not improvise:

```bash
conda create -n 4danyone python=3.11 -y
pip install -r requirements.txt
python scripts/download_smplx.py && python scripts/download_model.py
python inference.py --video_path "<clip>" --views_per_layer 6
```

- `views_per_layer` **must be divisible by 4 or 6**. Validate before spawning; a bad value fails
  deep inside the model.
- Other flags: `--layer_pitches`, `--start_yaw`, `--yaw_span`, `--data_dir` (default `data`).
- Output layout, pinned:

```
data/fdanyone/<clip>/
├── metadata.json          settings, timings, resources
├── cameras.json           the camera rig — the extrinsics for the densified path
├── skeletons/00.mp4 …
└── videos/
    ├── sparse/{00,04,09,12,14,19}.mp4
    └── dense/00.mp4 … <N-1>.mp4
```

**Brush invocation** — reuse the conventions `server/splat/splat_train.ts` and
`splat_train_dataset.ts` already pin, because getting these wrong produces a plausible-looking
but wrong splat:

- Dataset is Nerfstudio `transforms.json` + `images/` + optional `sparse_pc.ply`.
- **No axis flip.** Companion-Scan / WebXR / three.js poses are already in the OpenGL/Blender
  camera-to-world convention Nerfstudio expects. This is stated explicitly in
  `docs/pipelines/splat-train.md` and it is the single easiest thing to get wrong here.
- **Read real image dimensions from the JPEG SOF marker**, never trust recorded metadata — the
  existing converter does this because phone downscaling makes recorded dims drift.
- GPU selection is an env var, not a flag: `CUBECL_WGPU_DEFAULT_DEVICE` (from `BRUSH_DEVICE`).
- Defaults to inherit: `BRUSH_TRAIN_ITERS=15000`, `BRUSH_SH_DEGREE=2`, `BRUSH_MAX_RES=1280`.
  **Expect to lower iterations here** — 15000 × N timesteps is the sequence's whole cost budget.

**`.sog` conversion** reuses `@playcanvas/splat-transform`, as `server/splat/splat_finish.ts`
does, so the viewer's existing `.sog` preference chain works unchanged.

**Error contract.** Match the house taxonomy exactly — every stage returns `ok` / `skipped` /
`error`, always writes a manifest, and treats a missing binary as `skipped` with a `remediation`
string rather than an error. The appliance's driver (0005) maps these straight through.

**Stub mode is a first-class feature, not a test fixture.** Mirror
`scripts/make-splat-fixture.mjs`, which writes a valid INRIA 3DGS `.ply` plus the manifest a real
run would have produced — its whole point is that "the served-`.ply` → `SplatMesh` data path is
identical to a real run". Stub mode must produce a sequence with that same property.

## Before implementation

- `subsystems/osmo-ble/README.md` and `package.json` — the structure and the confidence-levels
  voice.
- `server/splat/splat_train.ts` and `server/splat/splat_train_dataset.ts` — the Brush invocation
  and the dataset conventions to reproduce.
- `server/splat/splat_finish.ts` — the `.sog` conversion.
- `docs/pipelines/splat-train.md` — the "Setup" and "Environment variables" sections; this
  subsystem's doc should mirror them.
- `scripts/make-splat-fixture.mjs` — the stub-artifact precedent.
- `scripts/lingbot_map_worker.py` — the repo's one existing Python worker, and the convention
  that **the worker itself writes the manifest** on every path including skip.
- 4DAnyone's `docs/output.md` and `docs/inference_performance.md` — **upstream repo, not ours**.

## Open questions & answers

- Q: HTTP service or a job directory on a shared filesystem? — A: **HTTP.** 0005 polls, and a
  shared filesystem across the tailnet would need mount management on both ends plus its own
  failure modes. A small HTTP service with submit/status/fetch is the least infrastructure.
  (Decided in this ticket.)
- Q: Submit must be idempotent on `takeId` — whose responsibility? — A: **Both.** 0005
  re-attaches after a crash, and this side must return the existing job rather than starting a
  second one when a `takeId` is resubmitted. Correctness should not depend on one side alone; a
  duplicate submit costs real GPU money. (Decided in this ticket.)
- Q: How many timesteps should a clip produce? — A: `FDANYONE_TIMESTEP_FPS`, default **5** —
  **adopted, not measured**. A 121-frame clip at 25 fps is ~4.8 s, so 5 fps gives ~24 timesteps.
  The real value trades reconstruction time against motion smoothness and cannot be chosen
  honestly before a real run exists. State it as adopted at its definition with a revisit
  trigger, per ADR 0005 rule 5. (Decided in this ticket.)
- Q: Per-timestep training from scratch, or warm-start each timestep from the previous? — A:
  Start with from-scratch, because it is what the existing Brush integration does and it
  parallelises trivially across GPUs. Warm-starting would likely cut total time substantially and
  improve temporal coherence — record it as the first optimisation to try once a real run exists,
  not a guess to bake in now. (Decided in this ticket.)
- Q: Can the multi-camera path work with as few as 2 clips? — A: It will *run*, and it will
  produce a poor splat — two views is far below what Brush wants. Do not block it; report
  `viewCount` in the manifest so the quality ceiling is visible. Where clip count is low, the
  honest option is to densify *anyway* from the best single clip. Make that a documented mode
  rather than an implicit fallback. (Decided in this ticket.)
- Q: What about a take whose members are unsynced (0002)? — A: Slice each clip on its own
  timeline and **do not** claim cross-clip simultaneity. If `syncResidualMs` is absent for a
  multi-clip take, prefer the densify path from the single best clip over a multi-camera train
  that would silently mix instants. Record which path was taken and why. (Decided in this ticket.)
- Q: Which GPU does this actually run on? — **OPEN.** No host on the current tailnet qualifies.
  The subsystem is written host-agnostically and validated in stub mode; the real-hardware
  question is a procurement/cloud decision recorded in the wave README, not something this ticket
  can close. **Do not let this block the ticket** — that is the entire point of stub mode.

## Files impacted

New — all under `subsystems/4d-capture/`:
- `README.md` — what it is, hardware requirements, setup, **confidence levels**
- `package.json`, `.gitignore`
- `subsystems/4d-capture/server/service.mjs` — HTTP: submit / status / fetch, idempotent on `takeId`
- `subsystems/4d-capture/server/pipeline.mjs` — stage orchestration and the ok/skipped/error contract

  (note the full paths: bare `server/pipeline.mjs` would read as this repo's `server/pipeline.ts`,
  which is the unrelated glTF optimizer)
- `stages/densify.mjs` — 4DAnyone invocation and output parsing
- `stages/frameset.mjs` — clips + `cameras.json` → per-timestep posed frame sets
- `stages/train.mjs` — Brush per timestep → `.ply` → `.sog`
- `stages/stub.mjs` — synthetic sequence, no GPU
- `test/frameset.test.mjs`, `test/args.test.mjs`

Changed:
- `.env.example` — the subsystem-side vars (host-side vars are 0005's)

## Schema required

The wire contract with 0005. Kept minimal deliberately — the durable schema is
`Person4DManifest` (0005), and this must not become a second copy of it.

```jsonc
// POST /takes           → 202 { jobId, takeId, attached: boolean }
// idempotent on takeId: a resubmit returns the existing job with attached: true
{
  "takeId": "take-…",
  "clips": [ { "clientId": "…", "url": "…", "mimeType": "…", "poseTrackUrl": "…"|null,
               "sync": { /* TakeSync, passed through verbatim — never defaulted */ } } ],
  "params": { "viewsPerLayer": 6, "timestepFps": 5 }
}

// GET /takes/:takeId    → { status: 'queued'|'running'|'ok'|'skipped'|'error',
//                           stage, progress, frameCount?, viewSource?, remediation?, error? }
// GET /takes/:takeId/sequence  → the .sog frames + the manifest fragment
```

## Definition of Done

- [x] `subsystems/4d-capture/` exists with its own `package.json` and is **not** referenced by
      the root `package.json`, `deno.json`, or `vite.config.ts`
- [x] `npm run stub` produces a complete valid sequence with no GPU, and the appliance can ingest
      it end to end through 0005
- [x] Single-clip takes route through 4DAnyone; multi-clip takes skip it; the chosen path and its
      reason are recorded in the result
- [x] `views_per_layer` divisibility is validated before spawning
- [x] Brush is invoked with the pinned dataset conventions — no axis flip, real image dims
- [x] Every stage returns ok/skipped/error and always writes a manifest; a missing binary is
      `skipped` with `remediation`
- [x] Submit is idempotent on `takeId`
- [x] The README states hardware requirements and confidence levels honestly, including that the
      4DAnyone path is unverified until a qualifying GPU exists
- [x] `npm test` in the subsystem passes

## Tests

- [x] Unit (`args.test.mjs`): 4DAnyone arg assembly is stable and ordered; `views_per_layer` not
      divisible by 4 or 6 is rejected before spawn
- [x] Unit: Brush arg assembly matches the pinned conventions
- [x] Unit (`frameset.test.mjs`): given a synthetic `cameras.json` plus N dense videos, the
      frame-set slicer emits the right number of timesteps with the right view count each
- [x] Unit: a multi-clip take with no measured sync selects the densify path and records why
- [x] Unit: a missing 4DAnyone checkout yields `skipped` + `remediation`, not `error`
- [x] Unit: resubmitting a `takeId` returns the existing job with `attached: true`
- [x] Integration (stub): `npm run stub` end to end produces a loadable sequence
- [x] **Cross-repo**: 0005's Playwright spec runs against this stub — the real proof that the
      contract holds from both sides
- [ ] **Unrun until hardware exists**: a real 4DAnyone run. Track explicitly as unrun rather than
      pretending stub coverage is equivalent, the way wave 09 tracks its device checklist.

```bash
cd subsystems/4d-capture && npm install && npm test && npm run stub
```

## Acceptance Criteria

- [x] Given a take with one clip, When submitted, Then the result reports
      `viewSource: 'densified'`
- [x] Given a take with four synchronised clips, When submitted, Then 4DAnyone is not invoked and
      the result reports `viewSource: 'multi-camera'`
- [x] Given no 4DAnyone checkout configured, When a single-clip take is submitted, Then the
      result is `skipped` with a remediation string and the service stays up
- [x] Given the same `takeId` submitted twice, When the second arrives, Then no second GPU job
      starts and the response reports `attached: true`
- [x] Given stub mode, When a take is submitted, Then a sequence is produced whose `.sog` files
      load in the World Editor exactly as a real run's would

## Risks / potential issues

- **Risk (the wave's central one):** none of the 4DAnyone path can be verified until a ≥44 GiB
  CUDA host exists. Everything shipped here is written against documented behaviour and unrun. —
  **Mitigation:** stub mode makes every *other* ticket real and testable, the arg assembly and
  output parsing are unit-tested against the documented layout, and the README says plainly what
  is unverified. This is a stated limitation, not a hidden one.
- **Risk:** Total sequence time is the product of two numbers nobody has measured — timesteps ×
  per-timestep train. It could be hours per clip. — **Mitigation:** `FDANYONE_TIMESTEP_FPS` and
  the iteration count are both tunable and both marked adopted; measure both on the first real
  run and record the numbers in the pipeline doc. Warm-starting is the recorded first
  optimisation.
- **Risk:** GVHMR, YOLOv8, and SMPL-X weights carry licences incompatible with commercial use
  (see 0008). A subsystem that quietly downloads them normalises that. — **Mitigation:** the
  README states the licence position at the top, and the download step is explicit and opt-in
  rather than automatic on first run.
- **Risk:** 4DAnyone's output layout changes upstream and the parser breaks silently. —
  **Mitigation:** parse `metadata.json` and validate the expected directory shape explicitly,
  failing with a clear message naming what was missing rather than producing an empty sequence.
- **Risk:** Sending clips of identifiable people to a cloud GPU is a materially different privacy
  posture from scanning empty rooms. — **Mitigation:** out of scope to decide here, but the
  README must state where clips travel, and ADR 0006 (0008) must answer it.
- **Risk:** Disk. Hundreds of `.sog` files per take plus 4DAnyone's intermediate dense videos is
  large, and `beta-1` is already at 89% full. — **Mitigation:** clean intermediates after a
  successful run; document the per-take footprint once measured.

## Subtasks

1. [x] Scaffold `subsystems/4d-capture/` mirroring `osmo-ble`'s structure and README voice
2. [x] Write `stages/stub.mjs` **first** — it is what unblocks 0005 and 0007
3. [x] Implement the HTTP service with `takeId` idempotence
4. [x] Implement `stages/frameset.mjs` with its unit tests — the contract's core
5. [x] Implement `stages/densify.mjs`: arg assembly, validation, output parsing
6. [x] Implement `stages/train.mjs`: Brush per timestep with the pinned conventions, then `.sog`
7. [x] Wire the ok/skipped/error contract and manifest-always through every stage
8. [x] Write the README including hardware requirements and confidence levels
9. [x] Add subsystem vars to `.env.example`; run `npm test` and `npm run stub`
