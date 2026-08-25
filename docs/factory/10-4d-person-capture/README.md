# 10-4d-person-capture

Teaches Companion Scan to capture **a person**, not just the room around them.

Every capture path in this repo today produces a static place: a walkthrough of an empty space,
turned into points, then a splat. [4DAnyone](https://4danyone.github.io/) (SIGGRAPH Asia 2026,
Ant Research) does the other half — it takes a casual monocular video of a person and
synthesizes the multi-view video a calibrated camera array would have recorded, which lifts into
a Gaussian-splat model. This wave adds the capture and playback halves of that to Companion
Scan, and puts the GPU-class inference behind a boundary.

The organising idea:

> **4DAnyone is a view-densifier that stands in for cameras you didn't have.**

With N synchronized phones you already have real views and don't need it for the angles you
covered. With one phone, it synthesizes the rest. **Both paths converge on one artifact** — a
per-timestep set of posed multi-view frames — which is exactly the shape
`server/splat/splat_train_dataset.ts` already builds for Brush. That convergence is what lets
this wave ship a working multi-camera rig with **no GPU at all**, and treat 4DAnyone as a
swappable box behind a contract rather than a dependency.

The second organising idea is a reuse, not an invention: **ADR 0005 already built the rig
calibration.** Two phones that tap the same two ground markers are, by construction, in the same
project frame. That is precisely the extrinsics a multi-camera rig needs, so this wave adds no
calibration mechanism — `src/ar/project-calibration.ts` *is* the rig calibration.

## Why the inference is not on the appliance

Measured, not assumed. 4DAnyone's own `docs/inference_performance.md` (in the upstream
[ant-research/4DAnyone](https://github.com/ant-research/4DAnyone) repo, not this one) reports its 6-view
full-orbit configuration at **43.3 GiB peak CUDA allocation** and 8–26 min per clip across
H200 / H20-3E / RTX A6000.

Probed on the tailnet, 2026-08-24:

| Host | GPU | VRAM per device |
| --- | --- | --- |
| `beta-1` | 2× Radeon RX 7900 XTX, ROCm 6.4.0-47, no CUDA | **23.98 GiB** |
| `beta-red` | RTX 3080 | 10 GiB |
| `beta-max`, `bench-1`, `core-1`, `beta-ms-a2` | none usable | — |
| `razer-3` | unreachable (Windows; SSH rejects key auth) | — |

Nothing on the fleet can run it: it needs ~1.8× beta-1's per-device VRAM, diffusion inference
does not shard across two cards, and the stack is CUDA (FlashAttention-3, GVHMR, ViTPose,
SMPL-X) against an AMD fleet. Upstream's own TODO lists "Low-memory inference (<32 GB)" as
**not done**, and even that would not fit in 24 GiB.

`razer-3` could not be probed — it is a Windows host and rejects key-based SSH. It is recorded
as unmeasured rather than assumed, but it does not change the conclusion: the largest mobile
GPU shipped in any Razer Blade is 24 GB, which is the same wall `beta-1` hits. **If a host with
≥44 GiB on one CUDA device is added to the tailnet, nothing in this wave needs to change** —
point `FDANYONE_HOST` at it (ticket 0005) and the skip path becomes the real path.

So the heavy stages live in `subsystems/4d-capture/` (ticket 0006), reachable over the tailnet
on a cloud or CUDA box, and the appliance tracks one job. This is also what keeps the
`WorldJobPump`'s *global* single-flight guarantee (`server/world/world_job_pump.ts:35-72`)
survivable: a 5 s clip at 5 fps is ~24 timesteps, and training those on-box would block every
`optimize-scan` on the machine for over an hour.

## Tickets

| # | Title | Type | Depends on |
| --- | --- | --- | --- |
| [0001](0001-take-model-and-multi-client-rooms.md) | A Take is N sessions sharing a `takeId`; generalize the room relay to N members | Backend | none |
| [0002](0002-measured-clock-sync.md) | Measured clock offset across clients, with an honest `syncStatus` | Full-stack | 0001 |
| [0003](0003-person-clip-recorder.md) | `MediaRecorder` person-capture mode + pose track sidecar | Frontend | 0001 |
| [0004](0004-durable-clip-storage.md) | Keep the clip; add video mime types, take association, and ranged serving | Backend | 0001, 0003 |
| [0005](0005-frame-set-contract-and-job.md) | The frame-set contract and the `person-4d-reconstruct` WorldJob | Backend | 0004 |
| [0006](0006-processing-subsystem.md) | `subsystems/4d-capture/` — 4DAnyone + per-timestep Brush, off-box | Infra | 0005 |
| [0007](0007-splat4d-playback.md) | `splat4d` animated playback in the World Editor | Frontend | 0005 |
| [0008](0008-adr-docs-atlas.md) | ADR 0006, pipeline doc, atlas pass | Docs | all |

## Execution order

**0001 lands first**, and everything else hangs off it — it is the only ticket that defines
what a Take *is*, and both the recorder (0003) and the storage layer (0004) need that vocabulary
before they can name anything.

**0006 can start immediately and in parallel with all of it.** It shares no files with any other
ticket in the wave, and its stub mode is what unblocks 0007's tests. Starting it late is the
main way this wave stalls.

```
0001 ──┬─▶ 0002
       ├─▶ 0003 ──┐
       └─────────┴─▶ 0004 ──▶ 0005 ──┬─▶ 0007 ──▶ 0008
                                     │
0006 (any time, no shared files) ────┴──────────────┘
```

0002 is independent of 0003/0004 once 0001 exists and can land at any point after it; it is
listed second because a take recorded before sync is measurable carries no usable
`syncResidualMs` and has to be re-shot.

**One sequencing constraint worth stating explicitly:** 0003's on-device camera-contention
question (below) should be answered *before* 0004 pins upload limits and 0005 pins the frame-set
resolution. If 8th Wall forces a lower-resolution recording path on iOS, both downstream tickets
change. Run the Checklist C item early rather than at the end.

## What can actually run in parallel

Less than the graph suggests, and the reason is shared files rather than logic:

| File | Touched by |
| --- | --- |
| `server/main.ts` | 0001, 0002, 0004, 0005 |
| `src/world/types.ts` | 0001, 0002, 0005, 0007 |
| `src/main.ts` | 0002, 0003 |
| `index.html` | 0003 |
| `src/world/manifests.ts` | 0005 |
| `.env.example` | 0005, 0006 |
| `docs/testing/DEVICE_TESTING.md` | 0003, 0008 |

Genuinely conflict-free in parallel:

- **0006** — an entirely new top-level directory. Its only shared touchpoint is a few lines of
  `.env.example`.
- **0007** — confined to `src/viewer/`, plus one `LayerType` member it shares with 0005.
- **0003's recorder module** — new files under `src/capture/`; it collides with 0002 only on
  `src/main.ts` wiring.

Everything else serialises on `server/main.ts`. Four tickets append to it; two tickets can be
*developed* concurrently, but whichever merges second rebases. Note that `server/main.ts` is
~4,500 lines and the job-system edit sites (0005) are scattered across a dozen of them — that
ticket is the one most likely to conflict, and is deliberately sequenced late.

## The atlas

Until this wave's atlas pass, `docs/factory/atlas.html` described capture as exclusively
place-shaped: the AR Capture section has cards for the keyframe streamer, auto-capture, and the
two AR providers, and the realtime section describes `/rtc-signal` as a one-phone-one-viewer
preview relay. There was no entry for video recording — correctly, because none existed — and
no notion of a capture whose subject is a person. That gap is filled as part of this wave's
Phase 6 pass, which is what gives its before/after diffs something accurate to diff against.

Entries this wave changes: the **realtime relay** card (1:1 → N-member rooms), a new
**Person capture** card under AR Capture, the **video ingest** entry under reconstruction (the
clip becomes durable rather than discarded), a new **4D capture subsystem** card, `LayerType`
and `WorldJobType` schema rows, the `Session` schema row (gains `takeId`/`clientId`/sync
fields), and the config table (gains the `FDANYONE_*` group).

The same pass corrected the `#waves` dek, which counted eight waves and omitted wave 09
entirely (gap filled). One stale item is deliberately **left** for ticket 0008: wave 09's
`HANDOFF.md` records that its ticket 0002's badge still reads open when it has landed — that
badge belongs to its own author to flip, as the 09 wave card says, so this wave flags it rather
than reaching into another wave's status.

## Landed

All eight tickets landed 2026-08-24. `npm run verify`, `npm run build`, the subsystem's own
suite, and the `api` Playwright project are green.

**New test coverage:** 5 Deno unit files (take ids, room membership, sync aggregation, range
parsing, the person-4d driver), 3 Node unit files (clock sync, clip validation, playback
window), 1 consolidated Playwright API spec, and 21 subsystem tests. `npm run verify` was
extended to include the three new Node suites, which the hand-maintained list would otherwise
have silently skipped.

### What the work found

Three things surfaced during implementation that the tickets had not anticipated.

- **A person clip could be lost to a thumbnail failure.** The first end-to-end run returned 500
  on upload: ffmpeg rejected the test clip, and the route failed the whole request — discarding
  the video. That is exactly backwards for person mode, where the clip *is* the durable
  artifact and the frames are a preview. `/ingest-video` now degrades in person mode: it mints
  a session, keeps the clip, records `thumbnailsUnavailable`, and only walkthrough mode still
  hard-fails (there the keyframes genuinely are the artifact). Found by the API spec, not by
  review.
- **Stub frames were silently identical.** `buildStubPly` drove its pose from a single sine, so
  phases 0 and 0.5 both produced zero displacement and byte-identical frames — a sequence that
  "played" while proving nothing about the playback clock. Fixed with a second component in
  quadrature; the test now asserts across four phases rather than two.
- **The roster broadcast silently broke the live feed.** The first draft of the N-member relay
  sent a `roster` frame to *every* member on join, ahead of the existing `peer-ready`. That
  changed the first frame a joining viewer receives, and `mock-rtc-room.spec.ts` asserts on
  exactly that frame — so the live-feed rendezvous the wave promised not to touch broke, with
  no type error and no server-side symptom. The roster is a take concept; it now goes to
  `capture` members only, and the preview pair's message stream is byte-for-byte what it was.
  Caught by the existing regression specs, which is what they are for — and a reminder that
  "extend the relay, don't fork it" (ADR 0001) puts the burden of not disturbing the incumbent
  protocol on the extension.
- **The job reported success while every frame 404'd.** Ticket 0005 said the driver "submits,
  polls, and ingests" — the ingest half was missing. The manifest was written and served, the
  job went green, and the frames stayed on the subsystem's own disk where no browser can reach
  them. Caught only by running the full path with the stub attached and then asking for a frame,
  which is the kind of check a unit test cannot make. `runPerson4D` now pulls the sequence back,
  reports **what actually landed** rather than what was promised (a manifest claiming 24 frames
  when 2 transferred would loop the viewer over files that are not there), and treats a failed
  transfer as an error rather than a green job.
- **`GET /jobs/:id` is optimize-scan-only.** The legacy shim 404s for every other `WorldJob`
  type. Worth knowing before writing any test that polls a job.

### A pre-existing failure this work did not cause

`mock-rtc-room.spec.ts` fails 2 of 3 locally, and `mock-rtc-robustness.spec.ts` one of three —
**not** because of the relay refactor. All of them fail inside the shared `startBroadcasting()`
helper at `expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/)`: the `?mock=xr8` scan
never produces points, so the test never reaches any signalling assertion.

Verified by A/B rather than assumed: `git stash`-ing only `src/main.ts` and `index.html` and
re-running gives the **identical** failure and the identical error string. The cause is
upstream of this wave, in the XR8 mock scan path.

That check is worth doing before believing any red spec near a refactor — the first reading
here was "the relay change broke the live feed", and it was wrong.

### Still unrun, and deliberately not checked off

- **The 4DAnyone stage itself.** No host on the fleet can run it (see above). Everything around
  it is real and tested through the subsystem's stub mode; the inference is not. Its atlas badge
  reads *pending GPU host*, not done.
- **Checklist C** (`docs/testing/DEVICE_TESTING.md`) — four items needing a person holding a
  phone. C1 (8th Wall camera contention on iOS) is the one that could still reorder this work:
  if a second `getUserMedia` cannot coexist with `XR8`, person capture is WebXR/Android-only
  until the 8th Wall path records from `XR8.CameraPixelArray` instead. C3 is what would replace
  the adopted `DEFAULT_SYNC_TOLERANCE_MS = 50` with a measured one.
- **Two browser specs** — `mock-person-recorder.spec.ts` (0003) and `mock-splat4d.spec.ts`
  (0007). The logic beneath both is unit-tested and the API path is covered end to end, but the
  `chromium-mock` specs themselves were not written. Their boxes are left unchecked rather than
  marked done.

## Found and deferred

Real work this wave surfaced and deliberately did not take on:

- **A deformable 4DGS trainer** (4DGaussians / Deformable-3DGS / SpacetimeGaussians). A
  canonical splat plus a learned deformation field would be far smaller on disk and smoother in
  motion than this wave's per-timestep sequence. Deferred because it is a second external GPU
  tool to install, gate, and document, and because SparkJS has no deformation support — it would
  need its own renderer work. The frame-set contract in 0005 is deliberately trainer-agnostic so
  this can be swapped in later without touching capture or playback.
- **Server-side recording of the WebRTC stream.** Would remove the separate upload step, but
  WebRTC's lossy realtime encoding is a poor reconstruction source and the server currently
  holds no media path at all. The live stream stays what it is: the operator's monitor view.
- **Audio.** Every capture path in this repo is `audio: false`, and a talking 4D person
  obviously wants sound. Out of scope because nothing downstream — storage, manifest, viewer —
  has any audio concept to extend, so it is its own wave rather than a field.
- **Body tracking / retargeting.** 4DAnyone extracts a skeleton internally (GVHMR) and discards
  it at the boundary. Surfacing that as a `Thing`-adjacent record would connect this to
  `08-places-and-things`, but nothing consumes it yet.
- **Replacing GVHMR.** It is a mandatory stage and is research/non-profit licensed (see 0008).
  Swapping it for a commercially-licensed pose estimator is the work that would make this
  shippable as a product feature; it is a real project, not a ticket.
