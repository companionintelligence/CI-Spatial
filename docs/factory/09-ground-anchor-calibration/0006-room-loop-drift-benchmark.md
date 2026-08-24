> **Type:** Frontend + Docs (instrumentation & measurement)
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `feat/room-loop-drift-benchmark`
> **Commit style:** `feat(capture): summary`
> **Design:** this ticket is the spec. Adapted from a proposed "Room-Loop" SLAM benchmark
> (see Open questions for what was corrected and why).
> **Dependencies:** None. **Should land first among this wave's measurement work** — its
> output sets the tolerance constants tickets 0002, 0003 and 0004 currently guess at.

## Goal

Add the camera-pose readout the scanner HUD is missing, and document a repeatable room-loop
benchmark that measures two things this wave depends on but cannot currently observe:
within-session SLAM drift, and cross-session calibration repeatability against a fixed
physical marker.

## Why this blocks the rest of the wave

Three constants in this wave are currently guesses, each flagged as such in its own ticket:

| Constant | Ticket | Currently |
| --- | --- | --- |
| `GROUND_TAP_TOLERANCE_M` | 0003 | 0.25, guessed |
| `DEFAULT_SEPARATION_TOLERANCE_M` | 0002 | 0.15, guessed |
| `MIN_POINT_SEPARATION_M` | 0002 | 1.0, derived from an assumed noise figure |

All three are bounded by the same underlying quantity — how repeatably this app's SLAM
tracking and hit-testing place a point in the room — and none of it is measured anywhere. Set
`DEFAULT_SEPARATION_TOLERANCE_M` below the real drift floor and every repeat visit reports a
false mismatch; set it well above and the check stops catching anything. The benchmark is how
that number gets chosen rather than picked.

There is one measurement already in the repo worth noting: `DEDUP_RADIUS_M = 0.4`
(`src/spatial/resolver.ts:27`), widened from 0.3 with the comment that "hit-test/raycast noise
and viewing-angle differences commonly place the same real object 0.3-0.4 m apart across two
captures". That is a detection-placement figure (a ray through a bounding-box centre), not a
direct floor tap, so it is an upper bound rather than the number this wave needs — but it is
the only empirical spatial-repeatability datum currently in the codebase, and a two-point
tolerance an order of magnitude tighter than it deserves scepticism until measured.

## The missing instrument

The proposed benchmark's headline step reads the "camera position coordinate readout in HUD vs
starting (0,0,0)". **No such readout exists in the scanner HUD.** `#scan-stats`
(`index.html:1803`) renders point count only. `#coord-readout` exists but belongs to
`viewer.html`, the desktop World Editor — a different page and a different (virtual orbit)
camera.

`ScanQualitySummary.driftEvents` (`src/capture/quality-monitor.ts:152`) is not a substitute: it
counts how often camera *speed* exceeded `DRIFT_HIGH = 2.0` m/s, a proxy for drift *risk*, not
a measurement of accumulated positional error.

So the benchmark cannot be executed as written. This ticket adds the readout.

## Non-goals

- Do not add automated drift detection, loop-closure correction, or relocalization. This
  ticket measures; it does not change tracking behavior.
- Do not change `quality-monitor.ts`'s existing `driftRisk`/`driftEvents` logic or thresholds.
  The new readout sits alongside them.
- Do not make the readout visible by default to ordinary users — it is a diagnostic. Gate it
  behind the existing debug affordance (see Pinned conventions).
- Do not retune `GROUND_TAP_TOLERANCE_M`, `DEFAULT_SEPARATION_TOLERANCE_M`, or
  `MIN_POINT_SEPARATION_M` in this ticket. Measure, record, and hand the numbers to 0002/0003;
  changing constants and measuring them in the same commit makes neither reviewable.
- Do not build an in-app benchmark runner or scoring UI. The protocol is a documented manual
  procedure, matching how `../../testing/DEVICE_TESTING.md` already works.

## Pinned conventions

**ADR 0001** — no schema, route, or config added. Searched before adding the readout:
`#scan-stats` (point count) and the quality HUD are the existing scanner-HUD readouts;
`provider.getPose()` (`src/ar/provider.ts`) already supplies the pose, and `poseHistory`
(`src/main.ts`) already accumulates it. Nothing new is captured — only displayed.

**Reuse `provider.getPose()`** and the existing `scanner.start()` tick callback
(`src/main.ts`, where `pointCloud.add(frame.points)` and `qualityMonitor.tick()` already run
each interval) as the update cadence. Do not add a timer.

**Debug gating**: reuse the existing `?debug=` query-param convention
(`?debug=remote` is already used for console mirroring, per `../../testing/DEVICE_TESTING.md`). Add
the readout under a `?debug=pose` (or extend the existing param) rather than inventing a
second gating mechanism — confirm which by reading how `debug` is parsed in `src/main.ts`
before implementing, and state the choice in the PR.

**HUD markup**: extend the existing `#status-bar` / `#scan-stats` region in `index.html`
rather than adding a floating panel.

**Protocol docs**: extend `../../testing/DEVICE_TESTING.md`, which already holds Checklist A
(iPhone/8th Wall) and Checklist B (Android/WebXR) plus a results matrix. Add the benchmark as
a new section with its own results table; do not create a parallel document.

**Walking pace**: the proposed protocol's `< 0.8 m/s` matches `DRIFT_MED = 0.8`
(`src/capture/quality-monitor.ts:79`) exactly — keep that number so the procedure and the
in-app warning agree.

## Before implementation

- `index.html:1795-1810` — `#ar-overlay`, `#status-bar`, `#scan-stats`.
- `src/main.ts` — the `scanner.start()` tick callback; the `debug` query-param parsing.
- `src/capture/quality-monitor.ts:70-215` — existing drift metrics, to sit alongside not
  duplicate.
- `src/spatial/resolver.ts:20-27` — `DEDUP_RADIUS_M` and its empirical comment.
- `../../testing/DEVICE_TESTING.md` — Checklists A/B and the results matrix, as #141/#142 left them.

## Open questions & answers

- Q: What was corrected from the proposed protocol? — A: Four things, all verified against
  the code this session:
  1. **Every referenced element id was wrong** — a consistent `btn-X` vs actual `X-btn`
     inversion. Correct ids: `#capture-btn`, `#auto-capture-btn`, `#stream-btn`,
     `#rtc-stream-btn`, `#finish-scan-btn`.
  2. **"> 400 pts/sec" is unachievable on WebXR by construction.** The scanner ticks every
     `DEFAULT_INTERVAL_MS = 750` with `DEFAULT_GRID_SIZE = 6` (36 probes) —
     `src/ar/scanner.ts:31,37` — a ceiling of 48 probes/sec *before* 5 cm voxel dedup
     (`src/scene/pointcloud.ts:9`) discards repeats. 8th Wall harvests per-frame SLAM
     `worldPoints` and can go higher, so the threshold must be stated per provider, not "all
     form factors". Restated below as a per-provider baseline to be *measured first*, not a
     pass/fail asserted up front.
  3. **Dedup radius is 0.4 m, not 0.3 m** — `DEDUP_RADIUS_M` (`src/spatial/resolver.ts:27`)
     was deliberately widened from 0.3, with a comment explaining that 0.3 was defeating dedup
     outright. A 0.3 m pass criterion would fail correct current behavior.
  4. **The drift readout it depends on does not exist** (see The missing instrument).
  (Verified by direct read, this session.)
- Q: The protocol measures within-session loop-closure drift. Is that what this wave needs? —
  A: Necessary but not sufficient. Walking a loop back to a taped marker measures how far the
  *session's own* tracking has slipped. This wave's claim is about **cross-session**
  repeatability — calibrate today, calibrate tomorrow, do the scans align? Cross-session error
  is within-session drift *plus* re-acquisition error (did the user place the landmark on the
  same physical spot?). Within-session drift is therefore a floor on achievable tolerance, not
  the tolerance itself. This ticket adds a second, cross-session procedure using the same
  taped apparatus, which is the one that actually sets `DEFAULT_SEPARATION_TOLERANCE_M`.
  (Decided in this ticket.)
- Q: Why 5 repeats per device? — A: Kept from the proposal. Drift is stochastic — lighting,
  path speed, and feature density vary per run — so a single run cannot distinguish a
  systematic bias from one bad pass. Five gives a usable spread without becoming an
  afternoon's work per device. Record all five, not just the best or the mean. (Decided in
  this ticket.)
- Q: Which devices? — A: Per `../../testing/DEVICE_TESTING.md`'s fleet, at minimum one 8th Wall path
  (iPhone/iPad Safari) and one WebXR path (Galaxy Tab S9 Ultra or S8 Ultra). The two providers
  accumulate points by entirely different mechanisms (per-frame SLAM `worldPoints` vs a 36-ray
  probe grid), so a number measured on one says nothing about the other. (Decided in this
  ticket.)
- Q: Should the taped origin marker be the same physical spot as the wave's calibration
  landmark? — A: Yes — that is what makes the two procedures share an apparatus. The tape marks
  the landmark; the loop test measures returning to it within a session; the cross-session test
  measures re-placing on it across sessions. One piece of tape, three measurements. (Decided
  in this ticket.)

- Q: (Subtask 1, resolved during implementation) `?debug=pose`, or extend the existing param?
  — A: **Extended it to a comma-separated token list.** `src/debug/remote-log.ts:36` read the
  param with exact equality (`get('debug') === 'remote'`), so `?debug=pose` and
  `?debug=remote` would have been mutually exclusive — and a benchmark run wants both at once
  (the readout to take numbers from, console mirroring so the box records them). Added
  `src/shared/debug-flags.ts` with `hasDebugFlag()`, and pointed `remote-log.ts` at it.
  Backward compatible by construction: `?debug=remote` is a one-token list containing
  `remote`, so every existing URL, QR code and doc keeps working — asserted directly in
  `debug_flags.test.ts` because a silent regression there breaks debugging itself.
  (Decided and implemented 2026-08-23.)
- Q: Where should the delta function live, and against which pose type? — A:
  `src/capture/pose-delta.ts`, alongside `quality-monitor.ts`'s metrics rather than inside it
  (the ticket forbids changing that file's behavior). It types its input as a local
  `PoseLike` built from `Vec3`/`Quat` in `world/types.ts`, **not** `Pose` from
  `ar/provider.ts`: provider.ts references `HTMLCanvasElement`, so importing it into a Deno
  test drags in DOM lib types and fails type-checking — the exact hazard ADR 0002 exists for.
  `PoseLike` is structurally identical, so `main.ts` passes a real `Pose` with no cast.
  (Discovered by a failing `deno test` run, fixed 2026-08-23.)
- Q: Which pose is the delta measured against? — A: the first *tracked, finite* pose of the
  session, not the pose at t=0. Before SLAM locks, the reported pose is origin-or-garbage;
  anchoring the reference there would make every later reading an offset from a fiction.
  Until tracking locks the readout says `pose: waiting for tracking`. (Decided 2026-08-23.)
- Q: Yaw extraction convention? — A: standard Y-Euler from the quaternion, which is provably
  identical to `atan2(x, z)` of the rotated +Z axis for any pure-yaw rotation — the
  convention `viewer.ts`'s `updateWorldHud()` and `world/geo.ts`'s `composeYUpTransform()`
  already use. A unit test asserts the two agree, because a readout measuring one convention
  while the wave tunes another would produce numbers that look plausible and mean nothing.
  (Decided 2026-08-23.)

**Procedure 2 cannot be run on the build this ticket landed in, and the wave's stated
order is circular.** Found while trying to schedule the measurement, after #145/#147 merged.

Procedure 2 steps 3 and 4 record `separationM` and `residualM`. Neither exists: today's
calibration is a single ground tap, `ProjectSpatialFrame.method` has exactly one member
(`'ground-tap-compass'`), and no code anywhere computes a separation between two markers.
Those numbers arrive with ticket 0004 — which depends on 0002 — whose
`DEFAULT_SEPARATION_TOLERANCE_M` this procedure is supposed to supply. So the README's
`0006 → 0002 → 0004` order cannot be walked as written.

Not a reason to guess the constant anyway. The quantity Procedure 2 is after — how
repeatably the system reproduces a fixed physical distance across independent sessions —
is measurable on today's build, because `?debug=pose` already reports `Δ` against the
session's first tracked pose. Anchor that first pose to taped Point A by standing on it at
AR start, walk to taped Point B, and the spread of `Δ` across five sessions is the same
repeatability floor, measured through pose rather than through hit-test.

Written up as **Procedure 2a** in `../../testing/DEVICE_TESTING.md`, with Procedure 2 retained and
explicitly marked as the post-0004 confirmation run. 2a is a conservative proxy: it carries
operator standing-position noise that aiming at a taped cross does not, so it should
over-estimate the spread rather than under-estimate it — the safe direction, since a
tolerance set below the true floor is what makes correct repeat visits report false
mismatches.

Procedure 2a also picks up a measurement nothing had asked for and which is available
today: `GROUND_TAP_TOLERANCE_M = 0.25` is already live on `main`, and 0003's rejection copy
reports the measured height in centimetres ("That looked about N cm above the floor"), so
tapping a table and a chair seat characterises the gate directly. That matters — the
constant's own comment claims it "comfortably rejects … a chair seat (~0.45 m)", which is a
20 cm margin *if the ground estimate is exact*. Nobody has measured how exact it is.

**The instrument was disarmed on the WebXR device, and no test could have caught it.**
Found 2026-08-23 while loading the benchmark URL onto the Galaxy Tab S8 Ultra over MCP.

`webxr.html` — the documented Android entry point — forwarded into the scanner with a
hard-coded `location.replace('/?ar=webxr')`. That drops the whole query string, so
`?debug=pose` never reached `hasDebugFlag()` and the pose readout stayed inert on the one
device path the benchmark needs it on. `?project=`, `?world=`, `?mock=` and `?onboarding=`
were lost the same way. `#btn-start`'s static href had the identical bug.

Fixed by building the forward URL from `location.search` with `ar=webxr` set last, verified
on device: the URL bar now reads `/?debug=pose%2Cremote&ar=webxr`.

Worth noting how this hid. `debug_flags.test.ts` covers `parseDebugFlags`/`hasDebugFlag` and
passes; the readout was verified in-browser at `/index.html`, which is the *8th Wall* entry
and reads its own query directly. Both checks were correct and neither could see the
problem, because the defect was in a third file that sits between the QR code and the code
under test. Same shape as this wave's ground-gate finding: the logic was right and the data
never arrived. **Check the entry point the operator is actually told to use, not the one the
test uses.**

**Procedure 1 is unaffected and runnable as written.**

## Files impacted

New:
- `src/shared/debug-flags.ts` (comma-separated `?debug=` token list — see Open questions)
- `src/capture/pose-delta.ts` (the pure delta computation)
- `pose_delta.test.ts`, `debug_flags.test.ts` (repo root, both registered in `deno.json`)

Changed:
- `index.html` (pose readout markup + styles in the existing status bar)
- `src/main.ts` (populate the readout from the scanner tick's pose; debug gating)
- `src/debug/remote-log.ts` (arm via `hasDebugFlag('remote')` instead of exact equality)
- `deno.json` (register the two new test files)
- `../../testing/DEVICE_TESTING.md` (the benchmark protocol + results tables)

## Schema required

None.

## The benchmark (to be written into `../../testing/DEVICE_TESTING.md`)

**Apparatus.** Tape a marker on the floor at **Point A**, noting a fixed facing direction.
Choose three fixed target objects. Define a perimeter path A → B → C → D → A.

**Procedure 1 — within-session loop drift.** Repeat 5×, per device:

| Step | Action | Record |
| --- | --- | --- |
| 1 | Tap `#start-ar-btn` standing on Point A | Time from tap to `Tracking` |
| 2 | Walk the perimeter at < 0.8 m/s | Point count at each waypoint |
| 3 | Return to Point A, same facing | **Reported pose vs. its starting value** — translational and rotational delta |
| 4 | Exercise `#capture-btn`, `#auto-capture-btn`, `#stream-btn`, `#rtc-stream-btn` | Keyframe upload latency; any dropped frames |
| 5 | Capture a target object from two angles ≥ 60° apart | Whether the two detections merged (`DEDUP_RADIUS_M = 0.4`) |
| 6 | Tap `#finish-scan-btn` → export | Quality verdict; upload success |

**Procedure 2 — cross-session calibration repeatability** (the one this wave needs). Repeat
5×, each as a *separate session* (fully stop and restart AR between runs):

| Step | Action | Record |
| --- | --- | --- |
| 1 | Start AR, complete the environment-scan step (ticket 0003) | Time to ground lock |
| 2 | Place the landmark on the taped Point A | — |
| 3 | Place the heading marker on a second taped spot ≥ 1 m away | Reported `separationM` |
| 4 | From run 2 onward | Reported `residualM` against the stored frame |

The spread of `separationM` across five independent sessions **is** the empirical basis for
`DEFAULT_SEPARATION_TOLERANCE_M`. Set the tolerance above the observed spread, or the check
will fire on correct calibrations.

Run Procedure 2 **before ticket 0007's reference photos exist**, so the spread it records is a
clean no-aid baseline. 0007 re-runs the same procedure with photos available and compares —
that difference is the only honest measure of whether the photos actually reduce re-acquisition
error, rather than merely feeling helpful.

**Thresholds.** Loop-closure drift < 10 cm translational / < 5° rotational is a reasonable
*target* carried over from the proposal, but treat the first run as characterisation, not
pass/fail — if measured drift is consistently worse, that is a finding about this app's
tracking, and the correct response is to record it and widen the wave's tolerances, not to
declare the device broken. Point-accumulation rate is to be **measured per provider and
recorded as a baseline**, not asserted (see Open questions).

## Definition of Done

- [x] Scanner HUD shows live camera position (and heading) from `provider.getPose()`, updated
      on the existing scanner tick, gated behind the debug query param
- [x] The readout shows delta-from-session-start as well as absolute position, so step 3 needs
      no arithmetic in the field
- [x] No change to `quality-monitor.ts` behavior
- [x] `../../testing/DEVICE_TESTING.md` carries both procedures, the corrected element ids, and empty
      results tables
- [x] The corrected element ids are used throughout (`#capture-btn`, `#auto-capture-btn`,
      `#stream-btn`, `#rtc-stream-btn`, `#finish-scan-btn`, `#start-ar-btn`)
- [x] `npx tsc --noEmit` passes
- [ ] **Executed**: both procedures run 5× on at least one 8th Wall device and one WebXR
      device, with results recorded in this ticket
- [ ] Measured numbers handed to tickets 0002 and 0003 as their tolerance basis, recorded in
      those tickets' Open questions & answers

## Tests

- [x] Unit: the delta-from-start computation (pose − session-start pose, translational
      magnitude and yaw difference) as a pure function — added to `anchor_calibration.test.ts`
      (ticket 0005) or its own file, registered in `deno.json`'s `"test"` task
- [x] Manual: readout is absent without the debug param (verified in-browser: element present, `display:none`, `aria-hidden`); present-with-it needs a tracking AR session
- [ ] Manual: readout reads ~zero delta immediately after session start (needs a device)
- [ ] The two on-device procedures above

```bash
npx tsc --noEmit
npm run qr -- "?debug=pose"
```

## Acceptance Criteria

- [ ] Given the debug param, When AR is tracking, Then the HUD shows live position and
      delta-from-start, updating at the scanner tick rate
- [ ] Given a completed loop back to the taped marker, Then the reported delta is readable
      directly off the HUD with no manual arithmetic
- [x] Given `../../testing/DEVICE_TESTING.md`, Then every element id it names resolves to a real
      element in `index.html` (all six verified by grep against `index.html`)
- [ ] Given five cross-session runs, Then the `separationM` spread is recorded and cited as
      the basis for `DEFAULT_SEPARATION_TOLERANCE_M` in ticket 0002
- [x] Given ordinary use without the debug param, Then the scanner HUD is visually unchanged
      (verified in-browser at `/index.html`: `#pose-readout` computes to `display:none`)

## Risks / potential issues

- **Risk:** The measured drift may turn out to exceed the tolerances this wave assumes,
  making two-point cross-session verification unreliable in practice — i.e. the benchmark
  could invalidate part of the wave's premise. — **Mitigation:** that is precisely why it
  lands first. Discovering it now costs a tolerance change; discovering it after 0004 ships
  costs a false-mismatch bug reaching users. A negative result is a successful measurement.
- **Risk:** Hand-recorded field measurements are noisy and prone to procedural inconsistency
  (was the phone held at the same height? exactly on the tape?). — **Mitigation:** five
  repeats, all recorded rather than averaged into a single figure; the tape fixes position but
  the operator should also note held-height and facing, which the results table must have
  columns for.
- **Risk:** A pose readout is a debug affordance that tends to become permanent UI clutter. —
  **Mitigation:** debug-param gated from the start, and explicitly a non-goal to surface by
  default.
- **Risk:** The two providers may need genuinely different tolerance constants, which the
  wave's single set of constants cannot express. — **Mitigation:** if the measurements diverge
  materially, that is a finding for 0002/0003 to act on (per-provider constants, or one
  conservative shared value); do not pre-emptively build per-provider tuning before the data
  says it is needed.

## Subtasks

1. [x] Read how `debug` is parsed in `src/main.ts`; choose and document the gating param
2. [x] Add the pose readout markup and styles to `index.html`'s status bar
3. [x] Populate it from `provider.getPose()` in the existing scanner tick, including
       delta-from-session-start
4. [x] Extract the delta computation as a pure function and unit-test it
5. [x] Write both procedures into `../../testing/DEVICE_TESTING.md` with corrected element ids and
       empty results tables
6. [x] `npx tsc --noEmit`
7. [ ] Run Procedure 1 (5×) on an 8th Wall device and a WebXR device; record results here
8. [ ] Run Procedure 2 (5×) on both; record the `separationM` spread here
9. [ ] Hand the measured tolerances to tickets 0002 and 0003; log them in those tickets' Open
       questions & answers
