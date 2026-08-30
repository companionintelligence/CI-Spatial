# 0007. Splat backends are selectable; a rotation-only sweep is not a reconstruction capture

- **Status:** Proposed — the licensing half needs an owner's sign-off before any code lands.
- **Date:** 2026-08-30
- **Related:** [ADR 0001](0001-reuse-existing-domain-model.md) (the reuse rule this follows),
  [ADR 0003](0003-merged-job-system.md) (the job system this extends rather than parallels),
  [ADR 0006](0006-person-capture-is-a-calibrated-take-and-densification-is-a-subsystem.md)
  (the precedent for recording a licence constraint without resolving it),
  `docs/pipelines/splat-train.md`, `docs/pipelines/colmap-poses.md`,
  `docs/operations/GIMBAL_INTEGRATION.md`, `docs/factory/11-panoramic-canvas/`

## Context

### The reconstruction toolchain is five installs in five places, and PATH sees one of them

Everything downstream of a capture — poses, points, splat, segmentation — is an external
program this repo shells out to. None of them arrive together, and no two arrive the same way.
Probed on this box on 2026-08-30:

| Tool | How it is installed here | On `PATH`? | Resolved by |
| --- | --- | --- | --- |
| ffmpeg 7.0.2 (static) | `~/.local/bin/ffmpeg`, hand-placed | yes | `PATH` |
| COLMAP 3.13.0 (CUDA) | `~/.local/micromamba/envs/colmap/bin/colmap` | **no** | `FALLBACK_COLMAP_BINS`, `server/colmap/colmap_poses.ts:96` |
| Brush | `~/brush/target/release/brush-cli`, a `cargo build --release -p brush-cli` | **no** | `DEFAULT_BRUSH_BIN`, `server/splat/splat_train.ts:97` |
| Panoptic (Mask2Former) | `~/.venvs/panoptic` + a `~/panoptic` checkout + a HuggingFace download | **no** | `PANOPTIC_PYTHON` / `PANOPTIC_DIR` |
| LingBot-Map | a torch install and a model checkpoint, neither present for its interpreter | **no** | `LINGBOT_MAP_PYTHON`, default `python3` |

`command -v` finds exactly one of the four non-ffmpeg entries — none of them. That is not a
misconfiguration; it is what a no-sudo install of each of these tools normally looks like, and
the two `DEFAULT_*`/`FALLBACK_*` constants above exist precisely because reporting "not found"
for a tool that is installed is a false negative that reads like a missing dependency.

The sharpest illustration is torch. `server/lingbot-map/lingbot_map.ts:115` defaults to the bare
interpreter `python3`, and tonight's run skipped correctly:

```
"status": "skipped",
"skippedReason": "torch import failed: No module named 'torch'",
"remediation": "Install torch + lingbot-map (see README — `LingBot-Map server processing`)."
```

Measured immediately afterwards: system `python3` has no torch, and
`~/.venvs/panoptic/bin/python` — a different interpreter on the same machine, installed for a
different stage of the same pipeline — has **torch 2.13.0+cu130**. The capability is present on
the box and absent from the process that needs it. Nothing in the manifest is wrong; the skip
contract did its job and the job stayed green. The problem is the *shape* of the toolchain, not
the contract that reports on it.

**What it cost.** A single end-to-end capture attempt tonight spent the bulk of its wall clock
on locating, building, and reconciling tools — a missing ffmpeg, a COLMAP that `which` denied,
a Brush build, an interpreter that owned torch and a different interpreter that needed it — and
comparatively little of it on reconstruction. The reconstruction, once the tools were found,
took 27.6 s (COLMAP) plus 166 s (Brush).

### The candidate

[Spirula Studio](https://github.com/harry7557558/spirula-studio) is one self-contained
C++/Vulkan binary covering frame extraction, its own SfM, AI masking, 3DGS training, and
meshing. Verified against the repository on 2026-08-30 (GitHub API and the repo's own
`README.md` / `docs/build.md` / `docs/datasets.md`; `master`, last pushed 2026-08-30, 237
stars):

- **Licence: GPL-3.0.** Reported by the GitHub licence API as `gpl-3.0`, and by the README's
  own badge. This is the section that matters, below.
- **Cross-vendor.** Vulkan backend covering NVIDIA, AMD, Intel and Apple; an optional CUDA
  backend. The underlying trainer is published as VkSplat (arXiv 2605.00219), which reports
  ~3.3x training speed and ~33 % VRAM reduction against a CUDA+PyTorch gsplat baseline on
  Mip-NeRF 360, benchmarked on an RTX 3090 and validated on AMD and Intel hardware. **Those are
  upstream's numbers on upstream's data — we have measured none of them.**
- **Claimed capacity:** 10M full-SH (SH3) Gaussians in 8 GB VRAM. Also unmeasured here.
- **Native 360°/equirectangular and fisheye support**, including >180° FOV, with no
  undistortion pass required. Panoramas are assumed 2:1.
- **It has a CLI** (`spirula --help`, `spirula train`) and ships prebuilt Linux/Windows/macOS
  binaries on its Releases page. This matters: it means the arm's-length integration described
  below is actually available, not hypothetical.
- **It already reads our dataset.** Its loader auto-detects Nerfstudio, then COLMAP, then
  Metashape. `server/splat/splat_train_dataset.ts` already writes a Nerfstudio `transforms.json`
  plus `images/` and `sparse_pc.ply` — that is literally format #1 — and
  `server/colmap/colmap_poses.ts` already writes a COLMAP sparse model, format #2. No new
  artifact contract is needed for a trial.

## The licensing question — read this before writing any code

**This section records a constraint. It does not resolve one.** Nobody on this side of the
repo owns licensing, and the paragraphs below are the common reading of GPL-3.0, not a legal
opinion and not settled law. Treat it as the brief you hand to whoever does own it.

**Start by not trusting the licence claims — including ours.** `CLAUDE.md` warns that this
repo has already shipped a licence contradiction once (a doc claiming MIT over a restrictive
commercial licence,
`docs/factory/foundation-updates/0001-reconcile-license-contradiction.md`). Grepped again on
2026-08-30: `LICENSE.md` is LifeScope INC's Commercial Standard License (`CI-Commercial-1.0`),
§4 forbids distribution and forbids merging or incorporating the Software into other products
without written consent, and §5 says the Software ships as object code only. And `README.md`
still carries an **open question of its own** — whether the commercial licence is the licence
this repo is intended to carry has not been confirmed by whoever owns licensing at LifeScope.
So the incoming licence is verified GPL-3.0 and the outgoing licence is *asserted* commercial
and *not confirmed*. Any analysis below inherits that uncertainty.

**What is off the table.** Copying, vendoring, adapting, translating, or statically or
dynamically linking Spirula's source into this repo. GPL-3.0's copyleft reaches derivative
works, and a `CI-Commercial-1.0` distribution of a derivative of GPL-3.0 code cannot satisfy
both licences at once — §4's ban on disclosing source and GPL-3.0's requirement to offer it are
directly opposed. There is no clever framing that makes this work; it would relicense this repo
to GPL. Do not lift so much as an algorithm implementation out of their `src/sfm/` for
reference. (Every `src/…` and `docs/…` path in this section is a path in *their* tree, not
ours.)

**What is the same arrangement we already ship.** Executing a separately-obtained,
separately-installed binary as a child process, communicating only through argv, exit codes,
and files on disk. This is exactly what `server/splat/splat_train.ts` does with Brush and
`server/colmap/colmap_poses.ts` does with COLMAP today — the user installs the tool themselves,
we never redistribute it, and no Spirula code enters this repo or its build. The common reading
is that this "mere aggregation at arm's length" does not create a derivative work, and it is
the same posture the FSF's own GPL FAQ takes on separate processes exchanging data. **The
common reading is not a ruling.** Two facts that would change the analysis if they became true:
shipping the binary inside our container image or installer (that is redistribution of a
GPL-3.0 work, which is permissible but carries source-offer and notice obligations we would
have to actually meet), or building any intimate coupling — a shared plugin ABI, a linked
library, a fork with our patches.

**Recommendation:** arm's-length invocation only, no bundled binary, and a licence review by
the owner **before** anything ships to a customer. Development and internal benchmarking behind
that boundary is a much smaller question than distribution, and the two should not be conflated
in either direction.

**A second licence surface, inherited from the models.** Spirula's masking uses Meta SAM
checkpoints — SAM 2.1 under Apache-2.0, SAM 3 under Meta's own licence — downloaded on first
use rather than bundled. This is the same split ADR 0006 recorded for 4DAnyone: permissive code,
weights with their own terms. If we ever enable masking, the weights need their own line in the
same review, and the download must stay an explicit opt-in for the same reason ADR 0006 made it
one.

**The patented-codec build flag.** Spirula's `SS_ENABLE_PATENTED` (default **off**) compiles in
Vulkan Video GPU decode for H.264/H.265/AV1 instead of shelling out to ffmpeg. Upstream's
`docs/build.md` reports roughly 15x faster frame extraction — a 127-second 1080p30 clip in about
ten seconds rather than minutes — and states plainly that `src/video/` is the part of the
repository carrying third-party patent exposure (H.264/H.265 via MPEG LA and Access Advance,
AV1 via the claims asserted against AOMedia), with the burden on whoever turns it on: "you are
responsible for ensuring compliance with local patent laws regarding AVC/HEVC playback."

That is directly relevant here, because **this product ingests user video** — a decoder is on
the hot path for every video-ingest session, not an optional extra. The default is off and the
fallback is ffmpeg, which this box now has. **Decision: leave it off.** A 15x speedup on frame
extraction is not worth acquiring a patent-compliance obligation on a product whose whole input
is other people's video, and the stage it accelerates is not the bottleneck (frame extraction
is seconds; training is minutes).

## Capture geometry: the dome cannot be reconstructed, and that is geometry, not tuning

The gimbal dome scan rotates the phone about the gimbal's own axes from a fixed station.
Monocular SfM triangulates a 3D point by intersecting the rays to it from two camera centres
that are **in different places**; with no translation the rays are collinear, the intersection
is undefined at any noise level, and the two-view geometry degenerates to a homography.
COLMAP names this exact condition — its diagnosis on such pairs is `PLANAR_OR_PANORAMIC`. A
rotation-only sweep is not a badly-tuned reconstruction capture. It is a different kind of
capture that the current pipeline cannot use, and no amount of frame count, exposure, or
matcher tuning changes that.

Three measurements, all from this repo, ordered by how much the camera actually moved:

| Capture | Frames | Camera translation | Result |
| --- | --- | --- | --- |
| Gimbal, one narrow station (`docs/operations/GIMBAL_INTEGRATION.md`) | 9 | effectively none — lens offset from the pan/tilt axes only | **4 / 9 registered**; 29 of 36 pairs `PLANAR_OR_PANORAMIC` |
| Handheld phone, `sess-a7e2f642-…` | 17 | 0.88 m max baseline, 3.62 m path, over 90.4° of rotation | **3 / 17 registered**, 1 triangulated point — and still reported `status: "ok"` |
| Synthetic walkthrough video, `sess-video-20260830-033839` | 32 | 13.6 units max baseline against a 2.2–2.5 unit scene depth | **32 / 32 registered**, 9362 points, 140 KB sparse cloud, gravity-aligned; Brush then trained 15k iterations to a 37.5 MB `.ply` in 166 s |

(Baselines computed on 2026-08-30 from `keyframes.jsonl` poses and from
`brush-dataset/transforms.json`; COLMAP's units are scale-free, so the third row is a ratio of
baseline to scene depth, not metres.)

The middle row is the honest one. Rotation dominated translation; the capture was near-in-place
without being literally in place; and it produced a reconstruction with one point in it while
the manifest said `ok`. That an unusable reconstruction can report success is a separate defect
in its own right — recorded here, out of scope for this ADR, and worth its own ticket.

There are exactly two ways to make a dome useful, and they are different products:

- **(a) Treat the dome as what it is — a panorama.** A rotation-only sweep from one station is
  the *ideal* input for an equirectangular projection and a terrible input for SfM; those are
  the same property viewed from two sides. Spirula ingests equirectangular datasets natively.
  This also lands next to work already planned:
  `docs/factory/11-panoramic-canvas/0003-equirectangular-canvas.md` builds an equirectangular
  canvas from posed keyframes for the VLM. A dome would be the highest-quality possible input
  to that canvas. **It would not produce a metric 3D model** — a single-station panorama has no
  depth, and pointing Spirula's 3DGS trainer at one does not manufacture any.
- **(b) Give the gimbal a baseline** — move it along an arc or a rail between grids and pool the
  sessions (`scripts/scan-room.ts --pool …`). `GIMBAL_INTEGRATION.md` already names this as the
  remedy and already flags that **multi-station pooling is untested from this capture path**.
  That flag stands; nothing tonight tested it.

Both are worth doing and neither is a substitute for the other. What must stop is running a
dome and expecting a reconstruction.

## Decision

We will treat the splat trainer as a **selectable backend behind the existing skip-with-
remediation contract**, evaluate Spirula as the second such backend, and keep Brush the default
until an A/B on our own data says otherwise.

1. **`splat-train` stays one `WorldJob` type with one manifest shape.** Per ADR 0003 there is
   one job system; per ADR 0001 a second trainer is not a second job type, a second queue, or a
   second artifact contract. It selects a different child process inside the existing runner.

2. **One new config variable, and only one:** a backend selector (`SPLAT_TRAIN_BACKEND`,
   default `brush`). The per-tool binary path keeps the convention already established twice —
   `BRUSH_BIN` and `COLMAP_BIN` override; a `DEFAULT_*` constant pointing at the documented
   install path is a fallback, never an override (`splat_train.ts:97`, `colmap_poses.ts:96`).
   Do not invent a second path variable that duplicates `BRUSH_BIN`'s semantics under a new
   name; that is how this repo got two `ScanManifest`s.

3. **A missing or unselected backend is `skipped` with a `remediation` string, never a crash** —
   the canonical shape at `colmap_poses.ts:348-359` and `splat_train.ts:173-191`. An appliance
   with neither trainer installed keeps running and keeps its jobs green. This is the property
   that lets us add a backend without adding a deployment requirement.

4. **Arm's length only.** Spirula is invoked as a separately-installed binary over argv and
   files, exactly as Brush and COLMAP are. No source is copied, adapted, or linked; no binary is
   bundled into our image or installer; licence review by the owner before anything ships.

5. **`SS_ENABLE_PATENTED` stays off,** and if we ever build Spirula ourselves rather than using
   a release binary, the build recipe must pin it off explicitly rather than inherit a default.

6. **The dome is documented as a panorama capture, not a reconstruction capture.** Its output
   feeds the equirectangular canvas path (wave 11), and any claim that a dome produces a 3D
   model requires a measured multi-station pooled run first.

7. **The A/B that decides whether Spirula stays.** Run both trainers on
   `sess-video-20260830-033839` — the known-good 32/32 fixture — and on at least one real phone
   capture. Compare wall clock, peak VRAM, output size, and a held-out-view PSNR. Brush's number
   on the fixture is already on the board: **166 s, 37.5 MB, 15k iterations.** Until Spirula has
   a number next to it, "Spirula is faster" is upstream's claim about upstream's data, and this
   ADR does not assert it.

## Alternatives considered

**Stay on Brush + COLMAP and fix nothing.** Cheapest, and genuinely defensible: this pair
produced a working reconstruction tonight, and the resolver constants already absorb the
install-location problem. Rejected as the *only* answer because it leaves us with a five-install
toolchain, no cross-vendor story (Brush needs Vulkan/Metal; the panoptic and LingBot stages want
CUDA torch), and no path at all for 360° input. Note it is not rejected as a *default* — item 7
exists precisely because Brush may well win.

**Vendor or adapt Spirula's source.** Rejected on licence. GPL-3.0 into a repo that asserts
`CI-Commercial-1.0` is not a trade-off to weigh; it is a relicensing of this repo.

**Write our own SfM or 3DGS trainer.** Rejected on cost. VkSplat is a paper-scale effort, and
COLMAP is fifteen years of accumulated degenerate-case handling — the `PLANAR_OR_PANORAMIC`
diagnosis above is itself an example of the kind of thing we would have to rediscover. We do
not have a reason to be in this business.

**Fold the whole pipeline into a single vendor's stack (all-CUDA, all-torch).** Rejected
implicitly by ADR 0006: the fleet is mixed-vendor (2x Radeon RX 7900 XTX on ROCm, a 10 GiB RTX
3080, this box's RTX 4080), and a CUDA-only pipeline is what already forces the person-capture
stage off-box.

## Consequences

**Easier.** One selector variable makes trainer choice a deployment decision instead of a code
change, and the skip contract means a host that has neither trainer degrades to green-with-a-hint
rather than red. Because Spirula reads Nerfstudio and COLMAP layouts directly, the trial costs a
process spawn and an arg list — `splat_train_dataset.ts` and `colmap_poses.ts` are unchanged. And
if the A/B goes Spirula's way, the 360° path and the cross-vendor path arrive together, which is
the combination nothing else on the table offers.

**Harder.** A second backend is a second set of failure modes, a second stderr dialect to
translate into a useful `remediation`, and a second thing that can drift from its documented
install path. Backend choice also becomes a variable in every "why does this scan look wrong"
investigation, so the manifest must record which backend produced an artifact — reuse the
existing `params` block that already records `colmapBin` and friends rather than adding a field
beside it.

**A licence obligation that is deferred, not discharged.** Nothing here is safe to ship until
the owner reviews it, and the review has two open items, not one: whether arm's-length
invocation of a GPL-3.0 binary is acceptable, and — still outstanding from
`foundation-updates/0001` — what licence this repo actually carries. An unrecorded constraint is
exactly the failure mode ADR 0006 was written to avoid.

**Claims this ADR deliberately does not make.** That Spirula is faster than Brush on our data;
that 10M Gaussians fit in 8 GB on our hardware; that its own SfM registers our dim, low-texture
phone keyframes better than COLMAP does (it might — ALIKED-class learned features are in its
tree and would plausibly beat SIFT on the 3/17 capture — but that is a hypothesis with a cheap
experiment attached, not a finding); or that a dome-as-panorama produces anything useful
downstream. Every one of those is unmeasured, and each has a specific experiment that would
settle it.

## When to revisit

- **The A/B in item 7 produces numbers.** If Spirula wins on our data, the default flips and
  this ADR is superseded by one that says so. If it loses, the backend selector still earns its
  place — but Spirula's entry should then be marked as evaluated-and-parked rather than left
  looking like a live option.
- **The licence review comes back.** Either outcome changes this document: approval discharges
  the deferred obligation; refusal removes the candidate and leaves the capture-geometry half
  standing on its own.
- **Anyone proposes bundling the binary, forking it, or linking it.** That is a different
  licence question from the one analysed here, and it needs its own review before, not after.
- **A multi-station pooled gimbal run is actually measured.** That would discharge
  `GIMBAL_INTEGRATION.md`'s standing untested flag and settle whether option (b) is real.
- **A capture path starts producing genuine equirectangular frames.** At that point the 360°
  support stops being a differentiator on paper and becomes a requirement, and the ordering in
  item 7 changes.
