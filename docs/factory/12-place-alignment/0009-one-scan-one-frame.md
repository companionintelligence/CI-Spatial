> **Type:** Frontend (scanner) + Server (one small reader) + Docs
> **Wave:** 12-place-alignment
> **Branch:** `feat/one-scan-one-frame`
> **Commit style:** `feat(scan): summary`
> **Design:** this ticket is the spec; it is work package WP-09b of the place-alignment build plan.
> **Dependencies:** the calibration commit extraction (`src/ar/calibration-commit.ts`, WP-04b step 0) and the frame-epoch tracker (`src/ar/frame-epoch.ts`, WP-09a). The drift check reads its taps through `sampleTap` (`src/ar/tap-sampling.ts`, WP-05a) in its own module; the calibration flow reads its own taps through it once WP-05b merges, which this ticket does not wait for.

## Goal

A scan lives in one frame. When the AR runtime's frame may have moved under a scan that was calibrated against a Place, the scanner stops adding to the scan, says so, and lets the person choose: **Re-anchor here** saves the scan as it is and begins another, calibrated again against the Place's saved points in the epoch the runtime is in now; **Keep going** records on and leaves the scan marked for review. A **Check drift** button measures how far the frame has moved by tapping the landmark again. Nothing splits a scan on its own unless the page was opened with `?autosplit=1` (owner decision D13).

## Non-goals

- Do not split a scan without being asked. `?autosplit=1` exists for the device experiment DX4 and nothing else turns it on.
- Do not add fields to `ProjectSpatialFrame`, `Project`, `ScanCalibration` or `ScanManifest` (the schema step S0 owns them), and do not add server matrix logic: a re-anchored scan is an ordinary scan with its own calibration.
- Do not retune `FRAME_EPOCH_THRESHOLDS` (DX4 does) or the 0.15 m, 1.0 m, 0.25 m and 0.30 m constants.
- Do not claim a frame moved. A discontinuity is the runtime saying tracking was lost or its origin moved; the words say tracking was interrupted and that parts MAY be shifted.
- Do not store anchors relative to anything: anchors become epochs (WP-17b).

## Pinned conventions

ADR 0001 (reuse, do not duplicate). Extended, not added: `ScanFrameEpochLog` and `FrameEpochsSidecar` (`closures`, `forgetCalibration`), `ScanQualitySummary` (`mixedEpochs`; `frameShifts` already existed) and `qualitySummaryFromMeta` (`server/main.ts`, through `server/frame_epoch_fields.ts`), `ScanQualityMonitor.summary` (`closureExceeded`), `KeyframeStreamer` (`hold`, `runId`), `DetectionStore` (`beginSession`), `arRunId` and its reserved dot separator (`arRunIdAtEpoch`), `runProjectCalibration` in return-visit mode, `exportToGLB` and the autosave path for ending a scan, `sampleTap` and `tapRefusalText`, `sessionDisagreementM` and `baselineGuidance` for the figure the copy quotes, `resetScanner`, the status line, and the `scan-calibration-note` classes of the editor's scan list. No new job, queue, route, environment variable or IndexedDB database. ADR 0002: every file the browser imports is free of Deno references. ADR 0005 rule 3: nothing says "verified"; the closure verdict is conditional on the same spots having been tapped. Rule 5: every adopted number is a named constant that says so (`CLOSURE_RETAP_SIGMA_M`, `CLOSURE_SIGMAS`, `FINISH_LIMIT_MS`, `CAPTURE_SETTLE_LIMIT_MS`). No identifier in CLAUDE.md "Do not rename" is touched.

## Before implementation

`src/ar/frame-epoch.ts` (the tracker and `ScanFrameEpochLog`), `src/ar/calibration-commit.ts`, `src/ar/project-calibration.ts` (the shell: hook lines only), `src/ar/tap-sampling.ts`, `src/world/baseline-guidance.ts`, `src/export/gltf.ts` (what the sidecar carries), `src/main.ts` (`resetScanner`, `doCapture`, `runAutoSave`, `calibrateScan`).

## Open questions & answers

- Q: Warn and mark for review, or split on a shift? — A: warn and mark for review (D13). Split only behind `?autosplit=1`.
- Q: Offer Re-anchor against a provisional two-point frame? — A: yes, labelled less accurate: the prompt says the new scan inherits the saved pair's error and gives the figure the calibration card gives for the same pair, as an estimate.
- Q: Closure limits that sit above 3 sigma of a human re-tap, and the standing rule "no tolerance that scales with baseline length"? — OPEN. The translation and height limits are flat (17.5 cm). The heading limit is three sigma of a direction, which is inversely proportional to the pair's length (14.2 degrees at 1 m, 4.7 at 3 m, never below the 3.5 degrees the product's own accuracy target allows at 5 m). A flat length tolerance on the heading marker would give 10 degrees at 1 m and 2 degrees at 5 m. The implemented option is the brief's recommended one; the result says what a limit that wide still lets through. Needs the owner's ruling.
- Q: What does a drift check do when the runtime is interrupted while it is open? — A: the check ends and the interruption is put to the person as at any other time, with recording held: its taps would be in two frames.
- Q: What if the Place's saved points were set by the very calibration that ran across the interruption? — A: no re-anchor is offered against them; the person is told the saved points may be shifted and the scan is marked for review.

## Files impacted

New: `src/ar/closure.ts`, `src/ar/drift-tap.ts`, `src/ar/calibration-epoch.ts`, `src/ar/reanchor-flow.ts`, `src/ar/reanchor-host.ts`, `src/ar/reanchor-banner.ts`, `src/ar/reanchor-copy.ts`, `server/frame_epoch_fields.ts`, the tests under `tests/unit/node/wp-09b-*.test.ts` (including `wp-09b-auto-capture-hold.test.ts`), `tests/unit/deno/frame_epoch_fields.test.ts`, `tests/mock-reanchor.spec.ts`.
Changed: `src/main.ts` and `server/main.ts` (hooks), `src/ar/project-calibration.ts` (hooks), `src/ar/frame-epoch.ts`, `src/capture/quality-monitor.ts`, `src/capture/keyframes.ts`, `src/capture/auto-capture.ts`, `src/scene/store.ts`, `src/shared/ar-run-id.ts`, `src/viewer/scan-calibration-chip.ts`, `src/world/types.ts` (`ScanQualitySummary.mixedEpochs` only).

## Schema required

None new. Optional keys only: `frameEpochs.closures` in the upload sidecar (present only when a check was made), `ScanQualitySummary.mixedEpochs`, `arRunId` in keyframe meta, `CalibrationResult.calibrationEpoch` (client only, absent for a provider with no epoch signal). A sidecar from before any of them is read as before.

## Definition of Done

- [x] The calibration result carries `calibrationEpoch`; the sidecar carries `frameEpochs.calibrationEpoch`.
- [x] A discontinuity after the calibration, with a stored two-point Place frame, holds recording and offers Re-anchor here (default) and Keep going.
- [x] Keep going leaves the scan marked for review; nothing splits a scan unless `?autosplit=1`.
- [x] Re-anchor saves the scan through the existing export, begins a new session, stamps `<arRunId>.<epoch>` on detections, captures and keyframes, and runs the return-visit calibration; with no usable stored frame the person is told and the scan is marked for review.
- [x] Check drift taps the landmark and heading marker through `sampleTap`, stores `{translationM, dyM, yawDeg, pathLengthM}` in the sidecar, and proposes Re-anchor above limits that sit above 3 sigma of a re-tap.
- [x] `frameShifts` and `mixedEpochs` reach the editor; the scan list says "Tracking interrupted N times".
- [ ] Device experiments DX4 and DX6 record the closure at 5, 10, 20 and 40 m and replace the adopted constants.

## Tests

- [x] `tests/unit/node/wp-09b-*.test.ts`: the flow against a fake provider, the sequence against the real store, the closure maths on synthetic drift, the copy against ADR 0005 rule 3, the banner, the wiring of `src/main.ts` by source shape.
- [x] `tests/unit/deno/frame_epoch_fields.test.ts` and `tests/unit/deno/scan_manifest_calibration_server.test.ts`.
- [x] `tests/mock-reanchor.spec.ts` (`?mockJumpAt`).

```
node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-*.test.ts tests/unit/node/scan_calibration_chip.test.ts tests/unit/node/wp-c-keyframes.test.ts
deno task check && deno task test && npx tsc --noEmit && npm run typecheck:tests
```

## Acceptance Criteria

- [x] Given a calibrated scan and a stored two-point frame, when the runtime's frame is interrupted, then nothing more is added to the scan until the person chooses, and the HUD says recording is paused and does not show the scan as ready.
- [x] Given Re-anchor, when the save does not answer within a minute, then the choice comes back and nothing was ended.
- [x] Given Re-anchor, when an export is made while the next scan's calibration is running, then the entry it made takes the calibration once it is made, and every later upload of the scan carries it.
- [x] Given a closure over its limits, then the words say what was measured and that the frame has moved only if the same spots were tapped.

## Risks / potential issues

- **Risk:** nuisance banners from benign blips (the adopted thresholds in `FRAME_EPOCH_THRESHOLDS` read a recovery after more than a second of limited tracking, `RECOVERY_SUSPECT_MS`, as an interruption). — **Mitigation:** DX4 sets them; Keep going is one press and is remembered for that epoch.
- **Risk:** re-anchoring against a provisional two-point frame inherits its error. — **Mitigation:** the prompt says so, with the figure and the word "estimate".
- **Risk:** a yaw-only shift is invisible without a closure tap, and a consistent shift of every tap is invisible to any check made of taps. — **Mitigation:** the check says what it measured, never that nothing moved.
- **Risk:** the heading limit is wide for a short pair. — **Mitigation:** the result says what a turn as large as the limit would do; see the open question.
- **Risk:** after the person has been told that the Place's saved points were set across an interruption, a later interruption in the same scan offers a re-anchor against those same points. — **Mitigation:** the return-visit calibration compares the new pair's length with the saved one and asks before keeping a pair that differs by more than the separation tolerance (0.15 m). A shift that leaves the saved pair's length as it was is not caught by that, and nothing made of taps can catch it.
- **Risk:** a drift check over its limits marks the scan for review for good, even if a later check is clean: a clean check does not show that what was recorded between them was not shifted. — **Mitigation:** every check stays in the sidecar, so a reader can see which came when.

## Subtasks

1. [x] Calibration epoch on the result and in the sidecar.
2. [x] The flow, its host, its banner and its words.
3. [x] The closure and the drift check.
4. [x] Quality verdict, sidecar, server reader and editor line.
5. [x] Tests and the mock-session smoke.
6. [ ] Atlas entries (AR Capture; Data schema, Capture and AR) and the DX4 closure procedure in `docs/testing/DEVICE_TESTING.md`.
