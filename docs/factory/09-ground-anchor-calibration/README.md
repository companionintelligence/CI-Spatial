# 09-ground-anchor-calibration

Makes a Place's calibration frame **measurably** repeatable across sessions.

PR #141 replaced the original three-point reference-triangle ritual with a single ground tap
plus a compass bearing, and #142 addressed review feedback on it. That shipped the interaction
this wave builds on, but left three things unresolved: the frame's orientation depends entirely
on an indoor magnetometer reading, nothing verifies that a return visit reproduced the original
frame, and the code reports `'verified'` anyway. This wave fixes the claim first, then makes it
true.

The organising idea: **geometry for relative alignment, compass for absolute orientation.**
Two ground markers fix the origin and heading from tracking geometry alone; the compass is
demoted to recording which way north is, for GPS/world placement. That single separation is
what makes cross-session verification possible at all — see
[ADR 0005](../../adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md).

## Tickets

| # | Title | Type | Depends on |
| --- | --- | --- | --- |
| [0001](0001-honest-calibration-status.md) | Stop reporting `'verified'` for calibrations that were never verified | Frontend | none |
| [0002](0002-two-point-frame-schema.md) | `'two-point-ground'` frame schema, with the one-point method as a documented fallback tier | Frontend (schema) | none |
| [0003](0003-environment-scan-readiness.md) | Establish the ground plane as a session artifact; gate marker placement on it | Frontend | none |
| [0004](0004-two-point-calibration-flow.md) | Staged two-point capture: ground → landmark → heading marker | Frontend | 0002, 0003 |
| [0005](0005-anchor-test-coverage-and-webxr-verification.md) | Test coverage for #141's untested math; the WebXR device verification it asks for | Test | none |
| [0006](0006-room-loop-drift-benchmark.md) | Pose readout + room-loop drift benchmark — supplies the tolerance constants | Frontend + Docs | none |
| [0007](0007-reference-photos.md) | Reference photos of both marker setups, to cut re-acquisition error | Frontend + Backend | 0002, 0004 |
| [0008](0008-floor-plane-fit.md) | Fit the floor to the lowest well-supported horizontal band instead of an 8th percentile | Frontend | 0003 |

## Execution order

**0006 lands first.** Three constants in this wave are currently placeholders —
`GROUND_TAP_TOLERANCE_M` (0003), `DEFAULT_SEPARATION_TOLERANCE_M` and
`MIN_POINT_SEPARATION_M` (0002) — and all three are bounded by one unmeasured quantity: how
repeatably this app places a point in a room. 0006 was to measure it and **closed unrun on
2026-08-25**, so all three remain adopted defaults with revisit triggers recorded at their
definitions. Setting a tolerance below the real drift floor makes every correct repeat visit
report a false mismatch, so this is an accepted risk rather than a retired one.

0006 also has a sequencing constraint of its own: **run its Procedure 2 before 0007 exists**, so
the recorded spread is a clean no-aid baseline that 0007 can be measured against.

**Correction, logged after 0006 landed: the order above is circular as written, and the fix
is Procedure 2a.** 0006's Procedure 2 reads `separationM` and `residualM` off the two-point
flow, which 0004 builds and 0002 types — so it cannot supply the constant 0002 needs. The
underlying quantity is still measurable on the shipped one-point build, via the `?debug=pose`
delta against a session-start pose anchored to taped Point A; that is written up as
**Procedure 2a** in `docs/DEVICE_TESTING.md` and is what 0002 should cite. Procedure 2 stays
as the confirmation run after 0004 lands. Procedure 1 was always runnable and is unaffected.
The "before 0007 exists" constraint now applies to 2a.

```
0006 ──▶ 0001 ──▶ 0002 ──┐
  │               0003 ──┴─▶ 0004 ──▶ 0007
  │                          │
  │  Procedure 2a ───────────┘  (2a measures on the one-point build; Procedure 2
  │                              is the confirmation run once 0004 exists)
         0005 (any time)
```

Then: 0001 (small, and it stops an active false claim), 0002 and 0003 (independent of each
other), 0004 (the integration), 0007 (last — it needs 0004's committed markers to photograph).
0005 can land at any point; it characterises what #141 already shipped.

## What can actually run in parallel

Less than the dependency graph suggests, and the reason is shared files rather than logic:

| File | Touched by |
| --- | --- |
| `src/ar/project-calibration.ts` | 0001, 0003, 0004, 0007 |
| `index.html` | 0003, 0004, 0006, 0007 |
| `src/world/types.ts` | 0001, 0002, 0004, 0007 |
| `src/main.ts` | 0001, 0003, 0004, 0006, 0007 |
| `deno.json` (the hand-maintained `"test"` list) | 0003, 0005, 0007 |
| `../../testing/DEVICE_TESTING.md` | 0005, 0006 |

Genuinely conflict-free in parallel:

- **0003's `src/scene/pointcloud.ts` half** — nothing else in the wave touches it.
- **0005** — almost entirely a new root-level test file; its only shared touchpoints are one
  line in `deno.json` and a `../../testing/DEVICE_TESTING.md` section.
- **0002** — confined to `src/world/types.ts` plus a one-line narrowing fix.

Everything else serialises on `project-calibration.ts` or `index.html`. Two tickets can be
*developed* concurrently; whichever merges second rebases. `deno.json`'s `"test"` task is a
hand-maintained filename list that does **not** glob — three tickets append to that same
string, and a rebase that drops an entry means the test silently never runs again.

## The atlas

Until this wave's atlas pass, `docs/factory/atlas.html` did not describe the calibration
subsystem at all — no feature card for `project-calibration.ts`, and no schema rows for
`ProjectSpatialFrame`/`ScanCalibration`. The feature shipped before #141 and was substantially
rewritten by it, without either change reaching the atlas. That gap is filled as part of this
wave's Phase 6 pass, which is also what gives its before/after diffs something accurate to diff
against.

Entries this wave changes: the new **Project calibration** card and its schema rows (under AR
Capture), the **AR provider abstraction** row (`getScene()`, added by #141 and likewise
undescribed), the **SLAM point-cloud accumulator** card (gains a stable ground estimate), and
`LayerType`/`ScanManifest` rows for the `'anchor'` layer and `calibrationMethod`/
`calibrationStatus` fields.

## Found and deferred

Real work this wave surfaced and deliberately did not take on:

- **Automatic re-acquisition via image targets or VPS anchors.** 8th Wall's Wayspot Anchors
  ship inside the vendored `public/xr.js` and `public/xr-slam.js` but are never called; WebXR's
  native anchors API is likewise unused. Either would replace this wave's manual re-placement
  with genuine relocalization. Deferred because both are large, provider-specific, and only
  worth designing once 0006 says how much error is actually left.
- **Picking the two markers against the previous scan** (the Map/BIM step in the cited
  two-point reference). The World Editor already renders anchors as a layer; the missing piece
  is loading a prior scan on-device during capture. Natural follow-up to 0004.
- **A "walk me to the anchor" hint** for a returning user before they place anything. Needs a
  coarse absolute fix (GPS via `Project.geoPose`, or the 0007 photos) that exists before
  calibration does — a different mechanism from anything here.
- **Per-provider tolerance constants.** 8th Wall and WebXR accumulate points by entirely
  different mechanisms, so their noise figures may differ. Not built pre-emptively; 0006's
  data decides whether one conservative shared value suffices.
- **Landmark editing in the World Editor.** Capture-side only in this wave.
- **`separationM` proves distance, not identity.** Two features the right distance apart in the
  wrong part of the room pass the check. Named honestly in 0004 rather than papered over; it is
  the same limitation that makes image targets the higher tier in the cited reference.

## Provenance

Ticket 0002's two-point method and 0003's explicit environment-scan step follow a two-point
calibration pattern used by BIM/AR field tools, supplied during planning. What was adopted and
what was not is recorded in each ticket's Open questions & answers. 0006's room-loop procedure
is adapted from a proposed SLAM benchmark supplied in the same session — four corrections were
needed before it could be run against this codebase, all listed in that ticket.
