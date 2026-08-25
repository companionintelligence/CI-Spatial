# 6. A person capture is a calibrated take; view densification is a subsystem

Date: 2026-08-24

## Status

Accepted

Related: [ADR 0001](0001-reuse-existing-domain-model.md),
[ADR 0003](0003-merged-job-system.md),
[ADR 0005](0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md),
`docs/factory/10-4d-person-capture/`

## Context

Every capture path in this repo produces a static place: a walkthrough of an empty room,
turned into points, then a splat. Capturing **a person** — something that moves — is a
different problem, and [4DAnyone](https://4danyone.github.io/) is the piece that makes it
tractable: it takes a casual monocular video of a person and synthesizes the multi-view video
a calibrated camera array would have recorded, which lifts into a Gaussian-splat model.

Two facts shaped everything about how it fits here.

**The first is cost, and it is measured.** 4DAnyone's own published benchmarks report
**43.3 GiB of peak CUDA allocation** and 8–26 minutes per clip for the 6-view configuration
alone. Probed on this tailnet on 2026-08-24: `beta-1` is 2× Radeon RX 7900 XTX at 23.98 GiB
each, on ROCm 6.4, with no CUDA; `beta-red` is a 10 GiB RTX 3080; nothing else has a usable
GPU. That is a ~1.8× per-device shortfall against a model that does not shard across cards,
on the wrong vendor's stack. Upstream lists "Low-memory inference (<32 GB)" as *not done* —
and even that would not fit.

**The second is that the app already knows where its cameras are.** ADR 0005 established that
a Place's spatial frame comes from two ground markers tapped on an established ground plane.
Two phones that tap the *same* two markers are, by construction, in the same project frame.
That is exactly the extrinsics a multi-camera rig needs, and it was already shipped.

Put together, those two facts point at a design that is not obvious from the paper: with N
real cameras there is nothing for 4DAnyone to synthesize.

## Decision

**We will treat a person capture as a calibrated multi-client take, and treat view
densification as a swappable subsystem behind one artifact contract.**

Concretely:

1. **A Take is the set of capture sessions sharing a `takeId`** — a derived set, not a stored
   aggregate, and not a new identity system. Per ADR 0001, this extends the existing session
   record rather than adding a parallel one.

2. **The rig calibration is ADR 0005's calibration.** No new mechanism. Devices in one take
   are in one frame because they tapped the same two ground markers, which they already did.

3. **The contract between capture and processing is a per-timestep set of posed multi-view
   frames.** Both paths produce it:
   - one clip → 4DAnyone synthesizes the views a camera array would have seen
   - N clips → the real cameras already provide them, and 4DAnyone is skipped entirely

   That shape is not arbitrary: it is what `server/splat/splat_train_dataset.ts` already
   builds for Brush.

4. **4DAnyone is a view-densifier standing in for cameras we did not have** — not a
   dependency. Nothing downstream of the frame set knows which path produced it.

5. **GPU-class inference runs off-box**, in `subsystems/4d-capture/`, reached over the
   tailnet. The appliance holds one `WorldJob` slot and delegates. An unconfigured or
   unreachable subsystem is `skipped` with a remediation string — a **green** job — matching
   `BRUSH_BIN`, `LINGBOT_MAP_*` and `SENSENOVA_DIR`.

6. **"4D" now names two different things, and both are legitimate.** They must be kept
   distinct in prose:
   - **4D-the-map** (the existing sense, `docs/architecture.md`): a place observed repeatedly
     over time — a time-series of posed observations composed into one anchored frame.
   - **4D-the-asset** (this wave): a single capture whose *content* moves.

   An asset sits inside the map; they compose. An unnamed collision is how a vocabulary rots.

## Consequences

**Easier.** The capture half is valuable with no GPU at all — N calibrated phones recording
one subject is a working multi-view rig, and it is the part that must live in the app.
Swapping the densifier (a rented H100, a future ROCm port, a deformable 4DGS trainer instead
of per-timestep Brush) touches nothing upstream or downstream of the contract. And the
appliance keeps working unchanged for anyone who never attaches a GPU host.

**Harder.** The subsystem is a second deployable with its own README, its own environment, and
its own failure modes, and a person job holds the global single-flight pump slot for as long as
it polls (ADR 0003 — there is no priority lane). Sequence artifacts are also large: a splat per
timestep is real disk, and nothing in this repo prunes session directories.

**Unverified, and stated as such.** No host on the fleet can run 4DAnyone, so its stage ships
against documented behaviour with unit-tested arg assembly and output parsing, and a stub mode
that produces a real loadable sequence. The atlas badge for that stage reads *pending GPU host*
rather than done. Marking it done would claim a verification nobody performed — the defect
ADR 0005 rule 3 exists to prevent, one subsystem over.

**A licensing constraint that gates productization, not development.** 4DAnyone's *code* is
Apache-2.0, but the shipped weights are mixed:

| Component | Licence | Note |
| --- | --- | --- |
| 4DAnyone model | Apache-2.0 | Commercial use permitted |
| **GVHMR** (`gvhmr_siga24_release.ckpt`) | **research / non-profit** | **A mandatory pipeline stage** |
| YOLOv8 (`yolov8x.pt`) | AGPL-3.0 | Source-disclosure obligations |
| VGG-19 | CC BY 4.0 | Attribution |

Companion Scan ships under a commercial licence (`LICENSE.md`). **This is recorded, not
resolved** — it is an owner decision, and it is why the model download is an explicit opt-in
step rather than automatic on first run. `CLAUDE.md` already warns that this repo has carried a
licence contradiction before and says to grep rather than trust; an unrecorded constraint is
exactly that failure mode.

**A privacy posture that differs from scanning empty rooms.** Wave 06 left an open question
about whether real captures of a real home belong in a repo. Capturing identifiable *people*
sharpens it, and sending those clips to a cloud GPU sharpens it again. Clips are durable
artifacts on the appliance by design; where they travel is a deployment decision that must be
made explicitly.

## When to revisit

- A host with ≥44 GiB on one CUDA device joins the fleet — the skip path becomes the real path,
  and the "unverified" caveats above can finally be discharged.
- GVHMR is replaced by a commercially-licensed pose estimator, which is what would make this
  shippable as a product feature rather than an internal capability.
- A deformable 4DGS trainer replaces per-timestep Brush. The contract is designed to absorb
  this; if it does not, the contract was wrong.
- Multi-client sync proves unachievable over the network. If the measured residual floor
  (ADR 0005 rule 5, and the Checklist C procedure) is too high for a moving subject, the
  multi-camera path is not viable and only the densify path is — which would make 4DAnyone a
  dependency after all, and this ADR's central claim false.
