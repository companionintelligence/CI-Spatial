# 0001 — One origin decal, the floor kept for the scan, and the ground height recorded with the scan

> **Type:** Frontend + schema (additive)
> **Wave:** 12-origin-calibration-v1
> **Branch:** `liam/web-origin-calibration-v1-449f78`
> **Commit style:** `feat(calibration): summary`
> **Design:** this ticket is the spec. Builds on 09-ground-anchor-calibration 0002 (frame schema), 0004 (two-point flow) and 0007 (reference photos), and on ADR 0005.
> **Dependencies:** 09-ground-anchor-calibration 0002, 0003, 0004, 0007. None outstanding in code.

## Goal

Make the calibrated origin one thing the scanner shows and records. It should be a crosshair and a heading arrow on the ground, with a north tick. The floor it stands on should stay visible for the whole scan. Its ground height should be written with the scan, so it can be read back without decomposing a matrix. A scan whose floor check was bypassed should say so, and should never author the Place's frame.

Before this ticket the committed origin was two separate rings, one per point, with nothing showing the heading direction. The floor grid was torn down at commit, so the origin floated with no ground under it. The floor height existed only inside `sessionToProject`'s translation.

## Non-goals

- Do not change how the frame is computed. `sessionToProject`, the two-point transform and the separation check are unchanged.
- Do not edit `buildAnchorMarker` in `src/world/anchor-marker.ts`. The World Editor draws it (`src/viewer/viewer.ts`, the `buildAnchorMarker()` call near line 1802), and `tests/unit/deno/anchor_calibration.test.ts` pins its group yaw.
- Do not edit `src/viewer/**`. The Spatial Editor session owns it.
- Do not edit the native AR provider or its plugins (`src/ar/native.ts`, `native-bridge.ts`, `native-codec.ts`, `mobile/**`, `desktop/**`). Other sessions own them.
- Do not change `src/ar/eighthwall.ts`, `src/ar/webxr.ts` or `src/ar/provider.ts`. Both runtimes already feed the floor estimate through the point cloud, and the provider contract is unchanged.
- Do not add automatic alignment, or a single-tap user-heading calibration tier. See the wave README.
- Do not add a field to `ProjectSpatialFrame`. Its floor is `y = 0` in project space by construction.
- Keep the north tick, labelled session-local. The user decided this on 2026-11-17 (see Open questions). The HUD's device needle keeps its meaning. The frame heading is a second, labelled needle beside it.

## Pinned conventions

- **ADR 0001 (reuse).** This ticket extends existing types and helpers. It adds three optional fields and one builder module, and no new record type.
  - Extends `ScanCalibration` (`src/world/types.ts`) with optional `groundY` and optional `floorCheckBypassed`. The nested `ScanCalibration` is the canonical record (see Open questions).
  - Extends `ScanManifest` (`src/world/types.ts`) with optional `calibrationGroundY`, a flat projection the server derives from `meta.calibration.groundY`, next to `calibrationSeparationM`. The client never writes it.
  - Extends `src/world/geo.ts`, the origin-math home, with `originDecalPlan()`, the `OriginDecalPlan` type and `readCalibrationGroundY()`. The file imports only types, so Deno can import it.
  - Extends `src/ar/ground-gate.ts`, the pure calibration-gate module, with `mayWritePlaceFrame()` and `committedStatus()`.
  - New `src/world/origin-decal.ts`, a Three builder. It is a sibling of `buildAnchorMarker()`, not an extension of it (see Open questions).
  - Searched before adding: `buildAnchorMarker` (kept, see Open questions). `ProjectSpatialFrame` (no change needed). `GeoPose`, `LocalFrame` and `WorldProject` (these describe GPS placement and the server world file, not the AR origin, so they are untouched). `ScanEntry.calibration` (already written whole into the sidecar by `src/export/gltf.ts`, so the new fields ride along with no writer change).
- **ADR 0005.** The heading on the decal comes from the two-point geometry. The compass sets only the north tick and never the transform. The one-point tier remains a labelled, explicit choice (decision 4 of ADR 0005).
- **Scene names** (the Chromium mock asserts on these, so renaming one breaks it):
  - Objects: `calibration origin` (committed), `calibration stored origin` (return visit), `calibration floor plane` (kept).
  - Parts: `origin ring`, `origin crosshair`, `origin heading` (group), `origin heading arrow`, `origin north` (group), `origin north tick`.
- **Conventions.** Yaw is in degrees, 0 = +Z, in `twoPointHeadingDeg`. A session yaw is `atan2(x, z)`: it grows counter-clockwise seen from above, the opposite way to a compass bearing, which grows clockwise (amended 2026-11-17: this line said "on the compass convention"). Groups are rotated by `rotation.y` in radians, the same as `buildAnchorMarker`. All heights and distances are metres in session space unless a name says `Project`.
- **Review decisions applied (2026-11-16, from the v1 plan review).**
  - Two taps stay the default. The one-point tier is an explicit button. It was labelled "Use one point instead (lower accuracy)" when this was decided; the merged scanner labels it `ONE_POINT_LABEL` (`src/ar/one-point-offer.ts`), and offers it only on a Place with no frame or a one-point frame (amended 2026-11-17).
  - The north tick is session-local. Its status copy says so.
  - The Place-frame floor is authoritative. A scan that bypassed its floor check records that, is never `verified`, and never writes the Place frame.
  - "Continue uncalibrated" scans do not set the Place frame. This was decided as copy that read "heading unverified"; the merged scanner prints `NO_ALIGNMENT_TEXT` (`src/ar/alignment-status.ts`) instead, and whether it should lead with that phrase again is the owner's call (amended 2026-11-17).

## Before implementation

- `src/ar/project-calibration.ts`: `clearPlacement`, `dropPersistentMarker` (replaced), `dropCommittedPair` (replaced), `drawStoredPair`, `refreshFloorGrid`, the floor-gate branch in `applyTap`, the skip-ground handler, and the commit branches `commitSinglePoint` and the two-point commit.
- `src/ar/ground-gate.ts`: `isTapOnGround`, `isSameHeightRetry`, `GROUND_TAP_TOLERANCE_M`.
- `src/world/anchor-marker.ts`: the north convention, and `ANCHOR_RADIUS_M`, which the decal reuses.
- `src/world/geo.ts`: `twoPointToProjectTransform`, `twoPointHeadingDeg`, `twoPointSeparationM`.
- `tests/mock-two-point-calibration.spec.ts`: `sceneObjectNames`, which reads `XR8.Threejs.xrScene()`.

## Open questions & answers

- Q: Does the brief's "no persistent origin yet" still hold? — A: No. Wave 09 persists the two-point frame on `Project.spatialFrame` and one `ScanCalibration` per scan. This ticket adds what was still missing. (decided by the implementer, 2026-11-16)
- Q: Should the origin take a single tap and a user-set heading? — A: Not as a durable frame. A heading the user sets cannot be verified across sessions, and ADR 0005 requires verification before a frame can be called verified. The compass-only fallback tier stays, behind an explicit button. (decided by the implementer, 2026-11-16)
- Q: Should the arrow be its own decal? — A: No. One group, `calibration origin`, with the arrow's tip on the heading point. The heading point was its own ring before. The arrowhead now marks it. (decided by the implementer, 2026-11-16)
- Q: Where does the ground height live? — A: On the scan, as `ScanCalibration.groundY`, which is the landmark's measured `y` in session metres. The Place-level frame gets no field, because its floor is `y = 0`. (decided by the implementer, 2026-11-16)
- Q: Should the stored origin draw a north tick? — A: No. The committed origin carries the frame's one compass fix, and a second tick would read as an independent reading. (decided by the implementer, 2026-11-16)
- Q: Should the floor grid stay after commit? — A: Yes. It moves out of the flow's placement group and is dimmed to 0.12. Re-committing replaces it, so it never stacks. It goes with the scan it was kept for, so a re-anchor, which begins a scan in another frame, and a skip take it down (`dropCalibrationDrawings`, `src/main.ts`; amended 2026-11-17). (decided by the implementer, 2026-11-16)
- Q: Should `buildAnchorMarker` take an arrow parameter, or should `origin-decal.ts` be folded into it? (raised in the review) — A: No, and the sibling stays. Reasons. (a) `buildAnchorMarker`'s group yaw is the north yaw, and its tests pin `rotation.y` to the bearing. An arrow needs its own yaw, so folding it in forces a nested group whose outer yaw changes what the World Editor draws at `viewer.ts:1802`. That is another session's surface. (b) The HUD arrow at `viewer.ts:3990-3992` is a DOM element, so no code is shared with it. (c) The sibling imports `ANCHOR_RADIUS_M` from `anchor-marker.ts`, so the two rings cannot drift in size. The Spatial Editor may adopt `buildOriginDecal()` for its own origin view. That is a decision for that session, and it changes nothing here. (decided by the implementer, 2026-11-16; review item 1)
- Q: Which scan-calibration shape is canonical, the nested `calibration` object or the flat `calibrationGroundY`? (raised in the review) — A: The nested one. `ScanCalibration.groundY` is what the client writes into the record, the sidecar and the Place. `ScanManifest.calibrationGroundY` is a flat projection that the server derives from `meta.calibration.groundY`, using the same pattern as `calibrationMethod` and `calibrationSeparationM`. Readers that need the value should read the nested record where they have it and the flat field in listings. (decided by the implementer, 2026-11-16; review item 2)
- Q: Is a floor-check bypass recorded? — A: Yes, on committed scans. `ScanCalibration.floorCheckBypassed` is `true` when the user used "Place anchor without floor check" or accepted an off-floor tap by a same-height retry. A bypassed commit is always `'provisional'`. It never writes `Project.spatialFrame`, whether as a first creation or as an override. (decided by the implementer, 2026-11-16; review decision applied)
- Q: What does a bypass on a first visit do to the Place? — A: It leaves the Place without a frame until a floor-checked calibration runs. The alternative, creating a frame from an unchecked floor, would make the Place's floor depend on the check that was skipped. This reading of "the Place-frame floor is authoritative" is confirmed by the user, 2026-11-17. (decided by the implementer, 2026-11-16)
- Q: Are "Continue uncalibrated" scans recorded as bypassed? — A: They have no `ScanCalibration` record. Their sidecar status `uncalibrated` is their record: no floor check ran, and the scan does not set the Place frame. The status copy was decided to read "Heading unverified"; the merged scanner prints `NO_ALIGNMENT_TEXT` (amended 2026-11-17). The Spatial Editor should render `calibrationStatus: 'uncalibrated'` as "heading unverified". (decided by the implementer, 2026-11-16)
- Q: Does the one-point tier stay explicit and labelled? — A: Yes. It is an explicit button shown after the landmark, labelled "Use one point instead (lower accuracy)" when this was decided and `ONE_POINT_LABEL` now (amended 2026-11-17). It is not automatic. (decided by the implementer, 2026-11-16)
- Q: Is absolute north removed from the tick for v1? — A: No. The tick stays and is labelled session-local, as the status copy already says. The brief asks for a world-direction-aware compass, and removing the tick would leave the origin with no north reference. (decided by the user, 2026-11-17)
- Q: Does the HUD compass read "frame heading"? — A: Both. The teal needle keeps the device's compass bearing. A second, hollow amber needle shows the origin's heading arrow as a compass bearing (the compass's north is magnetic, and no declination is applied), labelled "frame heading" with its degrees under the address (`originHeadingBearingDeg`). It uses the compass fix that the committed origin's north tick uses, so it appears after any two-point commit with a compass fix, on a first visit or a return visit. The stored origin drawn beside it on a return visit has no tick and no needle. It stays hidden after a one-point commit, a skip, or a commit with no compass fix, and it is hidden again when the calibration it described is dropped: a re-anchor that begins a scan with none, a skip, a Place frame that lost a conflict (amended 2026-11-17: this said "true-north", and named only the first three). (decided by the user, 2026-11-17; implemented)
- Q: Is the decal correct on a phone? — OPEN. Only DEVICE_TESTING § A-origin can answer this.

## Files impacted

- **New:** `src/world/origin-decal.ts`, `tests/unit/node/origin_decal.test.ts`, `tests/unit/node/origin_persistence.test.ts`, `tests/unit/node/origin_floor_gate.test.ts`, `docs/factory/12-origin-calibration-v1/README.md`, this ticket. Added by the merge review (2026-11-17): `tests/unit/node/origin_decal_truth.test.ts`, `origin_heading_bearing.test.ts` and `origin_lifecycle.test.ts`, with their helpers `origin_picture.ts` and `origin_rig.ts`, and `tests/unit/node/wp-docs-device-claims.test.ts`, which holds the checklist below to the build's own strings.
- **Changed:** `src/world/geo.ts`, `src/world/types.ts`, `src/ar/project-calibration.ts`, `src/ar/ground-gate.ts`, `src/main.ts` (the calibration gate's status copy and the frame-heading needle), `index.html` (the frame-heading needle and its label), `server/main.ts`, `tests/mock-two-point-calibration.spec.ts`, `docs/testing/DEVICE_TESTING.md`, `docs/factory/atlas.html`, `package.json` (`test:origin`, and the `verify` chain; `test:origin` names the three files the merge review added once the script lists them).

## Schema required

- `ScanCalibration.groundY?: number | null` (extends the existing type). Session-space metres: the landmark's measured `y` at commit. Written by both commit tiers. Absent on records written before this ticket. `null` when unknown or not finite. Read through `readCalibrationGroundY()`.
- `ScanCalibration.floorCheckBypassed?: boolean` (extends the existing type). `true` when the floor check was bypassed for this commit, by skip-ground or by an accepted off-floor same-height retry. Written by both commit tiers. Absent on records written before this ticket, which read as "not recorded".
- `ScanManifest.calibrationGroundY?: number | null` (extends the existing type). A server-side projection of `meta.calibration.groundY`. `null` when absent or not finite. Never written by the client.
- No change to `ProjectSpatialFrame`, `GeoPose`, `LocalFrame` or `WorldProject`.

## Definition of Done

- [x] Origin math and decal geometry are pure and tested (`tests/unit/node/origin_decal.test.ts`).
- [x] Persisted records round-trip, including the legacy shape and the sidecar read path (`tests/unit/node/origin_persistence.test.ts`).
- [x] The committed origin draws one decal, and the stored origin draws the same decal at half opacity (`src/ar/project-calibration.ts`).
- [x] The floor grid stays up after commit, and is removed on skip (`keepFloorPlane`; a skip, a re-anchor and a flow that ends uncalibrated take it down, `dropCalibrationDrawings` in `src/main.ts`).
- [x] `groundY` is written by both commit tiers, and `ScanManifest.calibrationGroundY` is populated on the server (`server/main.ts`).
- [x] Review item 1: the sibling builder is kept, and the reason is recorded above.
- [x] Review item 2: the canonical shape is the nested record, and the flat field is a projection.
- [x] Review item 3: `tests/mock-xr8-scan.spec.ts` is triaged (see Tests).
- [x] Review decisions applied: the one-point button is labelled, the floor bypass is recorded and blocks `verified` and the Place-frame write, "Continue uncalibrated" says the scan does not set the Place frame (the merged copy is `NO_ALIGNMENT_TEXT`; the wording decided in review is recorded under Pinned conventions, and the amendment below says what changed), and the tick is labelled session-local.
- [ ] DEVICE_TESTING § A-origin O1 to O13 run on an iPhone (Safari, 8th Wall).
- [ ] The same checks run on Android WebXR (Checklist B2).
- [x] Open questions for the user are answered: absolute north (the tick stays, session-local), the HUD readout (both), and the first-visit bypass (confirmed). The on-device question stays with DEVICE_TESTING § A-origin.

## Tests

- [x] `tests/unit/node/origin_decal.test.ts`: the arrow tip lands on the heading point in world space, for several headings; the north tick follows the anchor-marker convention; a missing compass dims the ring; the stored decal takes its own name and recedes; materials are not shared; the frame-heading bearing is the arrow's clockwise angle from the north tick, in world space, and is null without an arrow or a compass fix.
- [x] `tests/unit/node/origin_persistence.test.ts`: a scan's origin survives JSON through the sidecar and reads back its `groundY`; a floor point at `groundY` maps to project `y = 0`; a legacy record reads as `null`; a non-finite `groundY` reads as `null`; the Place frame round-trips.
- [x] `tests/unit/node/origin_floor_gate.test.ts`: a bypassed commit never writes the Place frame, first creation or override; a bypassed commit is never `verified`; an unbypassed match is `verified`; an override is `provisional`.
- [x] `tests/mock-two-point-calibration.spec.ts`, updated to the new names: the commit keeps the origin, its crosshair and arrow, and the floor plane; a return visit draws the stored origin; the skip path removes the floor plane.
- [x] Triage of `tests/mock-xr8-scan.spec.ts` (review item 3). The HANDOFF's diagnosis is stale. Its test "boots the mock engine" passes, so AR starts and the Scanner Location sheet is no longer the blocker. The other test needs the API to run with `INFERENCE_MODE=mock`. The spec's own probe says so. Run with that setting on this branch's own stack (see the result in the commit message).
- Commands:
  - `npm run test:origin`
  - `npx tsc --noEmit`
  - `npm run typecheck:tests`
  - `deno task check`
  - `npx playwright test --project=chromium-mock tests/mock-two-point-calibration.spec.ts` and `tests/mock-xr8-scan.spec.ts`, against this worktree's own API and Vite. The API needs `INFERENCE_MODE=mock` for the xr8 spec.
- Note: `tsconfig.tests.json` covers only `tests/**/*.spec.ts`, so the `tests/unit/node/origin_*.test.ts` files are type-checked with an ad-hoc config that loads `@types/node`. Adding them to a tsconfig is a separate change.

## Acceptance Criteria

- Given a committed two-point frame, when calibration closes, then the scene holds one `calibration origin` whose arrow tip is on the heading point, and a `calibration floor plane`.
- Given a re-commit in the same session, then the scene still holds one `calibration origin`, not two.
- Given a return visit whose separation check passes, then a `calibration stored origin` is drawn at half opacity beside the committed one.
- Given a skip, then no `calibration origin` and no `calibration floor plane` remain, and the status reads "No project alignment" over "Scanning without it. This scan does not set the Place frame".
- Given a scan committed on a floor at session height `h`, then its record carries `groundY = h`, and `ScanManifest.calibrationGroundY` is `h` for that scan.
- Given a commit that used "Place anchor without floor check" or an off-floor same-height retry, then its record carries `floorCheckBypassed: true`, its status is `'provisional'`, and `Project.spatialFrame` is not written.
- Given a record written before this ticket, then `groundY` and `floorCheckBypassed` read as absent, and the rest of the record is unchanged.
- On a phone, the decal sits on the floor and stays fixed as the user walks, and the north tick agrees with a compass. (Device; DEVICE_TESTING § A-origin O1 to O4.)

## Risks / potential issues

- **Risk:** the kept floor grid (10 m, dimmed) is busy over a whole scan. **Mitigation:** it is dimmed to 0.12, and O5 judges it on a phone. Reverting to removal at commit is one line in `project-calibration.ts`.
- **Risk:** the arrow's length is the measured separation, so a long baseline draws a long line across the floor. **Mitigation:** that line is the baseline the user defined. The grid's 0.5 m cells double as a distance gauge (`FLOOR_GRID_SIZE_M`). Check it in O3.
- **Risk:** the stored origin shares its landmark with the committed one, so the two overlap and differ only by the arrow's residual. **Mitigation:** the stored decal is at half opacity. Check legibility in O7.
- **Risk:** scans uploaded before this ticket carry no `groundY`, so `calibrationGroundY` is `null` for them. **Mitigation:** `null` is the documented meaning, not an error.
- **Risk:** a first-visit bypass leaves a Place without a frame, so later visits repeat the first calibration. **Mitigation:** this is the intended reading of the review decision, flagged for confirmation. The user can always complete a floor-checked calibration.
- **Risk:** the Node tests are outside `tsconfig.tests.json`, so `npm run typecheck:tests` does not catch a type error in them. **Mitigation:** they were checked with an ad-hoc config. Adding them to a tsconfig is a follow-up.

## Subtasks

1. [x] `src/world/geo.ts`: `OriginDecalPlan`, `originDecalPlan()`, `readCalibrationGroundY()`.
2. [x] `src/world/origin-decal.ts`: `buildOriginDecal()` with ring, crosshair, arrow and north tick.
3. [x] `src/world/types.ts`: `ScanCalibration.groundY`, `ScanCalibration.floorCheckBypassed`, `ScanManifest.calibrationGroundY`.
4. [x] `src/ar/project-calibration.ts`: `replacePersistent`, `keepFloorPlane`, `dropCommittedOrigin`, the stored-origin render, `groundY` at both commit tiers.
5. [x] `server/main.ts`: `calibrationGroundY` mapping.
6. [x] Unit tests and the `test:origin` script, added to `verify`.
7. [x] Mock spec updated to the new names and parts.
8. [x] `DEVICE_TESTING.md` § A-origin.
9. [x] Atlas diff blocks (committed in df3c4c7; see the merge-owner question in the report).
10. [x] Review pass: floor-bypass tracking, the pure gate rules and their tests, the status copy, the one-point label, and the mock triage.

## Amendment, 2026-11-17: what the merge with the other branches changed

This ticket is a record of what was decided and built before the branches were merged. The merged scanner differs from it in the places below, and each is marked in the text above. Nothing here reopens a decision.

- **Copy.** The one-point button is `ONE_POINT_LABEL` ("Continue with one point (this scan will not line up with other scans)") and is offered only on a Place with no frame or a one-point frame. "Continue uncalibrated" prints `NO_ALIGNMENT_TEXT` ("No project alignment" over "Scanning without it. This scan does not set the Place frame"), not "Heading unverified". **Owner:** whether that line should lead with "Heading unverified" again is an open call; the decision above is recorded as it was made.
- **The flow.** A first calibration offers the check-point step after the heading point, and **Use this alignment** is on the card only in review, so a commit is: confirm the landmark, the heading point, **Skip the check point** (or place C), **Use this alignment**. A placed check point leaves its own marker (`calibration anchor check`), which is not a second origin.
- **The HUD needle.** A session yaw grows counter-clockwise and a bearing clockwise, so the needle shows `northYaw - arrowYaw` (the clockwise angle on the floor from the tick to the arrow). It was the mirror image before. It is the compass's bearing, which is magnetic.
- **What a dropped calibration leaves.** The needle, the origin, the stored origin, the check marker and the stored-point rings go when the calibration they describe is dropped, and the floor grid goes with a scan that has none. A same-height retry of an off-floor tap bypasses the floor check for the marker it places, and Re-place points, moving the marker onto the floor and taking it away end that bypass.
- **Where the scan stands.** A bypassed commit that wrote no Place frame and matched none is outside the Place frame: the record says `outsidePlaceFrame`, and the editor, the frame counts and Thing matching read it as one rule. On the mismatch screen the button that replaces the Place's reference reads **Record as unverified** under a bypass, and replaces nothing.
- **The checklist** is O1 to O13 (the wave README and the definition of done said O1 to O10 and O1 to O12). `tests/unit/node/wp-docs-device-claims.test.ts` quotes each of its rows against the build.
