# 0008. Station-dome capture is a supported path, and its baseline comes from moving the tripod

- **Status:** Proposed — the geometry is measured, but only in simulation. No real gimbal has
  run this pattern yet, and the promotion criterion is in "When to revisit".
- **Date:** 2026-08-30
- **Related:** [ADR 0001](0001-reuse-existing-domain-model.md) (the reuse rule this follows —
  a pattern, not a new job type),
  [ADR 0007](0007-splat-backends-are-selectable-and-a-rotation-only-sweep-is-not-a-reconstruction-capture.md)
  (this amends its item 6 and answers one of its revisit triggers),
  [`../operations/CAPTURE_PATTERNS.md`](../operations/CAPTURE_PATTERNS.md) (the operator guide
  this ADR justifies), [`../operations/GIMBAL_INTEGRATION.md`](../operations/GIMBAL_INTEGRATION.md),
  [`../operations/AR_DEVICE_SUPPORT.md`](../operations/AR_DEVICE_SUPPORT.md),
  [`../pipelines/colmap-poses.md`](../pipelines/colmap-poses.md)

## Context

### Both existing capture paths fail on the device in front of us

`docs/operations/AR_DEVICE_SUPPORT.md` records the XREAL Beam Pro against both live paths, from
the phone's own mirrored console:

- **WebXR: VERIFIED dead, permanently.** `com.google.ar.core` is not in the installed-package
  list. `navigator.xr.isSessionSupported('immersive-ar')` still answers `true` — it reports that
  the API exists, not that anything backs it — and `requestSession()` then rejects with
  `NotSupportedError`. Nothing in this app can fix that; it needs Google Play Services for AR on
  the device, which this device does not get.
- **8th Wall: VERIFIED working, intermittently — about 2 starts in 8.** When it starts it works
  end to end (SLAM ready 2.4 s in). Six times out of eight it does not.

And there is a second problem with 8th Wall here that no amount of retrying fixes: its SLAM
needs the camera to **translate** before it will initialise a map. A phone clamped in a
tripod-mounted gimbal never translates. So on this hardware the two supported paths are
*unavailable* and *unreliable-and-then-still-requires-a-person-to-walk*.

Meanwhile the gimbal is good at exactly what a walking human is bad at: evenly spaced,
repeatable, well-framed coverage, with a pose readout on every position and no motion blur.
It was being used in the one pattern that cannot be reconstructed — a dome from one spot.

### The geometry, and the measurements

Monocular structure-from-motion triangulates a 3-D point by intersecting the rays to it from two
camera centres that are **in different places**. Rotate the camera about its own centre and the
centres coincide: the rays are collinear, the intersection is undefined at any noise level, and
the two-view geometry collapses to a homography. COLMAP names this condition itself —
`PLANAR_OR_PANORAMIC`. A rotation-only sweep is not a badly-tuned reconstruction capture; it is a
different kind of capture, and no frame count, exposure, feature detector or GPU changes that.
ADR 0007 established this. What is new here is where the missing baseline can come from.

Ordered by how much the camera centre actually moved:

| Capture | Frames | Registered | Points | Quality | Evidence |
| --- | --- | --- | --- | --- | --- |
| Real gimbal, one narrow station | 9 | **4** | — | 29 of 36 pairs `PLANAR_OR_PANORAMIC` | `docs/operations/GIMBAL_INTEGRATION.md` |
| Handheld, near-in-place (rotation dominating translation) | 17 | **3** | 1 | degenerate — and the manifest still said `ok` | ADR 0007's table, session `sess-a7e2f642-…` |
| Simulated single dome, one station | 17 | **3** | — | degenerate | tonight's run — see the caveat below |
| **Simulated 5 stations × dome each** | 36 | **36** | **9,914** | `status: "ready"`, `registrationRatio: 1`, `degenerate: false`, gravity-aligned | `scans/sessions/sess-video-20260830-163024/colmap-poses.manifest.json` |
| Simulated continuous walkthrough | 48 | **48** | 12,430 | `status: "ready"` | `scans/sessions/sess-video-20260830-054518/colmap-poses.manifest.json` |
| Simulated continuous walkthrough (ADR 0007's fixture) | 32 | **32** | 9,362 | `status: "ready"` | `scans/sessions/sess-video-20260830-033839/colmap-poses.manifest.json` |

**Caveat on row 3.** Its COLMAP manifest is not on disk in this worktree, unlike rows 4–6 whose
manifests are quoted above and can be re-read. The figure is from tonight's run log. It agrees
in kind with rows 1 and 2, which *are* citable, and no single-station capture recorded anywhere
in this repo has ever registered — but if the single-dome number needs to be cited as evidence
elsewhere, re-run it and keep the manifest.

### Where the baseline came from

The 36/36 fixture puts five tripod stations in a 6.0 × 4.4 × 2.6 m room, camera at 1.5 m, and at
each station sweeps a 150° pan arc across two tilt rows in a serpentine, then jumps to the next
station. No frames are captured in transit. So **within a dome the baseline is exactly zero, by
construction, and stays zero however many frames are added** — every bit of parallax in that
reconstruction came from the four moves between the five stations.

Measured on the station layout: nearest-neighbour spacing **1.89–2.16 m**, widest separation
**4.33 m**, against wall distances of roughly 2–4 m from any station. The customary rule of thumb
for well-conditioned triangulation is a baseline of about **a tenth of the scene depth**; this
capture runs at roughly 0.6 of it, six times over, which is why it registers rather than merely
scraping through. Measured in the solved reconstruction itself (COLMAP units are scale-free, so
this is a ratio, not metres): max camera baseline ÷ median scene depth = **1.43** for the station
capture and **1.09** for the walkthrough. The two captures are in the same regime. That is the
finding — a station capture is not a weaker walkthrough, it is the same geometry sampled at
different places.

Two things about the layout are deliberate and one of them is unmeasured:

- The stations are **spread, not lined up** — a rough ring plus a centre point. Collinear
  stations give a degenerate baseline for anything lying on that line, which is the same failure
  as a rotation-only dome, restricted to one direction. This is standard SfM geometry and the
  fixture was built to avoid it. **We did not run a collinear variant, so it is unmeasured here.**
- Coverage overlaps: each station re-sees a good part of what its neighbours saw. Frames that
  share no features cannot be registered to each other however far apart the cameras are.

**This is ordinary multi-station photogrammetry** — the same principle as registering terrestrial
laser scans from several setups. Nothing about it is novel; what is new for this repo is that it
gives the gimbal a job it can do.

### What the simulation does not prove

Every row above marked "simulated" was rendered by a ray-tracer whose surfaces carry procedural
non-repeating value noise — **every wall is richly textured, and two lights ensure no visible
face is contrast-free**. Real rooms have blank painted walls, which is where SIFT has nothing to
find. So 36/36 is an upper bound on what this pattern does in a real room. It establishes that
the geometry works; it does not establish that a real room registers at 100 %, and it should not
be quoted as if it did.

The fixture that produced it also **is not checked into this repo** (it was written to `/tmp` for
tonight's run), so as things stand the measurement is not reproducible from a clean clone.
Recorded as follow-up, below.

### What this does NOT fix: the panoptic lift still gets nothing

The 3-D lift needs **metric per-frame poses**. `server/panoptic/panoptic_segments.ts:248-251`
states the situation plainly for the 48-frame fixture: a video keyframe carries no capture pose
(0 of 48), and solved SfM poses are scale-free, so the lift places nothing;
`server/panoptic/panoptic_lift.ts:513` distinguishes the two failures ("no capture pose vs a
non-metric cloud") because they need different fixes.

**A station capture with no AR tracking lands in exactly the same place as a video ingest.** The
photos have no pose; COLMAP recovers poses up to an unknown similarity; nothing in the capture is
metric, so nothing can fix the scale. Adding stations improves *registration*, not *scale*. A
capture that registers 36/36 and a capture that registers 3/17 both give the lift nothing to
place — for different reasons, and only the first of those is fixed here.

What would change it: **the device's own VIO surviving the moves between stations.** The plumbing
already exists — `subsystems/osmo-ble/server/backend.mjs:620-637`'s `capturePhotos: false` mode
drives the grid while the phone runs the scanner web app, which captures its own keyframes and
tags each with an AR pose, and the comment there says why that matters: "VIO poses ARE metric
(the IMU measures real acceleration)". On the Beam Pro that mode is unavailable today, because
8th Wall is its only tracker and 8th Wall is the 2-in-8 path that needs translation to start. On
an ARCore phone it is plausible and **unmeasured**: nobody has checked whether an AR session
survives being picked up, carried across a room, tripod and all, and set down — without losing
tracking or drifting enough to poison the poses it hands over. That experiment is cheap and has
not been run.

## Decision

We will treat **a multi-station dome capture as a supported capture pattern** — the third way to
cover a room, beside a WebXR/8th Wall walkthrough and a video ingest — and document it for
operators. Specifically:

1. **It is a pattern, not a new system.** No new session type, no new `WorldJobType`, no new
   manifest, no new config variable (ADR 0001). The photos go to the existing pose-less photo
   ingest — `POST /ingest-photos` (`server/main.ts:1545`), which EXIF-orders, blur-filters and
   auto-enqueues `lingbot-map-reconstruct` (`server/main.ts:1626`); `colmap-poses` is the CPU
   alternative for the same session shape. Several captures of one room pool with the existing
   `scripts/scan-room.ts --pool <ids…> --as <id>`.

2. **The capture shape that this ADR claims support for** is at minimum three stations, spread so
   they are not collinear, moved far enough between stations to give a real baseline, with each
   station's sweep overlapping its neighbours'. The numbers, and the reasoning behind each, live
   in `docs/operations/CAPTURE_PATTERNS.md` — one place, so they can be corrected once when a real
   run disagrees with them.

3. **A single dome remains what ADR 0007 said it is** — a panorama capture, not a reconstruction
   capture. This ADR amends ADR 0007 item 6 only in this respect: multi-station pooling is no
   longer entirely untested, because it has now been measured in simulation. The standing flag in
   `GIMBAL_INTEGRATION.md` that multi-station pooling is untested **from the real gimbal capture
   path** still stands, unchanged.

4. **It claims registration, not metric scale.** Every stage that needs metric input — the
   panoptic lift, splat-align, anything that reports a measurement in metres — keeps reporting
   `skipped`/undetermined with its `remediation` on these captures, exactly as it does today. Do
   not describe a station capture's output to a user as a measured model, and do not let a
   station capture be the reason a metric guard is relaxed.

5. **A capture that covers one station is not a green capture, whatever the ratio says.** The
   existing `colmap-poses` quality block (`registrationRatio`, `degenerate`, thresholds
   `minRegistrationRatio: 0.6` / `minPoints3D: 100`) catches a wholesale failure but **cannot**
   catch the specific failure this pattern introduces: COLMAP registering one station's frames
   cleanly, dropping the rest, and reporting a healthy-looking ratio over the frames it kept.
   Detecting that needs per-station coverage — did frames from every station survive into the
   model — and **no such check exists today**. Until it does, this is a documented manual check
   in the operator guide, not a solved problem. Reporting success that was not earned is this
   codebase's recurring defect; naming the gap is the minimum, and closing it is a ticket.

6. **Status stays Proposed** until this pattern has been run on the real OM6 with a real phone in
   a real room. Simulation established the geometry. It cannot establish that a room with blank
   walls, a gimbal with a hard pan limit, and an operator carrying a tripod produce the same
   result.

## Alternatives considered

**Keep pushing 8th Wall on this device.** Rejected *for this device*. Two starts in eight is not
a capture path, and even a successful start still needs the operator to walk while holding the
phone — which is the thing the tripod exists to avoid. Not rejected generally: 8th Wall remains
the iOS/Safari path and the only live-AR path this repo has, and it is not this ADR's business to
retire it.

**Require a walkthrough for every room.** Rejected as the *only* answer, not as an answer. It
genuinely works — 48/48 and 32/32 above are the best-measured captures on the board, and a
walkthrough remains the recommended pattern when a tracking-capable phone and a willing human are
both available. But it needs a person walking the whole room, its coverage is whatever that
person happened to point at, it is not repeatable between visits, and its frames carry hand
motion blur that a gimbal's do not. A station capture trades operator effort for coverage that is
identical the second time you do it.

**Buy an ARCore-capable phone.** A real option, and the only one on this list that restores
*metric* poses and therefore unblocks the panoptic lift. It costs a device and a re-test, and it
does not remove the reason to have this path (a tripod still gives better, more repeatable
coverage than a hand). Recorded as a live option rather than a rejected one: if metric scale
matters more than hardware count, this is the thing to do, and it is complementary to — not a
substitute for — station capture.

**Move the gimbal along a rail or a turntable instead of carrying it.** Rejected on geometry: a
rail is collinear by definition, which is the degenerate case named above for everything lying
along the rail's line. A turntable moves the camera in a circle, which is fine in principle, but
the diameter that fits on a tripod is far below the baseline these distances need.

## Consequences

**Easier.** A capture path that needs no AR runtime, no SLAM, no ARCore, and no vendor SDK — just
photos and the existing pose-less ingest. It works on the hardware already on the bench, it is
repeatable visit to visit, and every artifact it produces is one the pipeline already knows how
to read.

**Harder — the operational facts this pattern now depends on.** All of these are properties of
the real OM6, and every one of them is a way for a capture to go wrong in the middle:

- **The reachable pan arc is roughly +82° … 180° … −100°.** It cannot rotate through the front,
  so a sweep must be planned inside that arc — which is where the fixture's 150° span comes from.
  Note this **disagrees with the older figure** in `GIMBAL_INTEGRATION.md` ("yaw sweeps cleanly
  across roughly ±175°, provided a single move never has to cross the ±180 seam"). The arc above
  is the more recent measurement and the tighter one; plan against it, and treat the disagreement
  as unresolved until someone re-probes the limits deliberately.
- **Driving into the stop is a jam, and it reports as one.** A jam closes ~0.65° of distance in
  11 s where a healthy move closes ~31° in 7.8 s, so the verdict is computed from **net
  progress**, not from a tick count (`subsystems/osmo-ble/server/backend.mjs:470-490`). Do not
  reintroduce a tick-counting stall check: a tick costs ~880 ms on real hardware, so 12 ticks
  cannot fit inside the default 8000 ms budget and every genuine jam would be reported as a
  retryable timeout.
- **Speed commands LATCH.** The gimbal keeps driving at the last commanded rate until told
  otherwise, so every path that leaves one outstanding leaves the motors running — including a
  thrown error, an aborted scan, and the BLE link simply going away. This has cooked a real OM6.
  `stopMotors()` on every exit path is load-bearing, not defensive
  (`subsystems/osmo-ble/server/backend.mjs:325-337`, and `moveToClosedLoop`'s `finally`).
- **Tilt is asymmetric**: it converges down to about −40° but stalls near +16°, a mechanical
  limit rather than a display artefact. Two tilt rows have to live inside that band.
- **A wedged gimbal aborts the run**, and the recovery is physical (hold Shutter + Switch +
  Trigger ~1 s). A multi-station capture is a longer sequence than a single dome, so this is more
  likely per capture, not less.

**Harder — more operator steps.** Five stations is five chances to place the tripod badly, change
its height, move a chair between stations, or sweep past the pan limit. That is what
`CAPTURE_PATTERNS.md` is for, and it is why item 5 above insists that a green job is not by itself
evidence of a good capture.

**Claims this ADR deliberately does not make.** That a real gimbal run of this pattern will
register (unmeasured — that is why the status is Proposed); that a real room's blank walls behave
like the fixture's textured ones (they will not, to an unknown degree); that collinear stations
fail *by measurement here* (standard geometry, untested in this repo); that device VIO survives
being carried between stations (unmeasured); or that any of this produces metric scale (it does
not, and item 4 exists to keep that from being quietly assumed).

## When to revisit

- **A real 5-station OM6 + phone capture of a real room is measured.** That is the promotion
  criterion for Proposed → Accepted, and it also discharges `GIMBAL_INTEGRATION.md`'s standing
  "multi-station pooling is untested from this capture path" flag. If it registers well below the
  fixture, the guide's numbers change, not this ADR's reasoning.
- **A per-station coverage check lands** (item 5). At that point the manual check in the operator
  guide should be deleted and replaced with a pointer at the automated one.
- **An ARCore-capable phone arrives.** Then run the VIO-across-the-carry experiment described in
  Context. If VIO survives the moves, station capture becomes metric and the panoptic lift's
  no-pose reason disappears for this path — which is a bigger change than this ADR makes.
- **The station fixture is checked into the repo.** Until it is, rows 3–6 of the measurement
  table cannot be regenerated from a clean clone, only re-read from `scans/sessions/`.
- **LingBot-Map runs on a real box.** It is a feed-forward model that predicts geometry rather
  than triangulating it, so it is not bound by the parallax constraint at all, and it may handle
  captures that SfM cannot. Whether it does anything useful with a station capture specifically
  is unmeasured.
