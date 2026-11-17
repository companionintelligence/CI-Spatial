# 0001 — One origin decal, the floor kept for the scan, and the ground height recorded with the scan

> **Type:** Frontend + schema (additive)
> **Wave:** 12-origin-calibration-v1
> **Branch:** `liam/web-origin-calibration-v1-449f78`
> **Commit style:** `feat(calibration): summary`
> **Design:** this ticket is the spec. Builds on 09-ground-anchor-calibration 0002 (frame schema), 0004 (two-point flow) and 0007 (reference photos), and on ADR 0005.
> **Dependencies:** 09-ground-anchor-calibration 0002, 0003, 0004, 0007. None outstanding in code.

## Goal

Make the calibrated origin one thing the scanner shows and records. It should be a crosshair and a heading arrow on the ground, with a north tick. The floor it stands on should stay visible for the whole scan. Its ground height should be written with the scan, so it can be read back without decomposing a matrix.

Before this ticket the committed origin was two separate rings, one per point, with nothing showing the heading direction. The floor grid was torn down at commit, so the origin floated with no ground under it. The floor height existed only inside `sessionToProject`'s translation.

## Non-goals

- Do not change how the frame is computed. `sessionToProject`, the two-point transform and the separation check are unchanged.
- Do not edit `buildAnchorMarker` in `src/world/anchor-marker.ts`. The viewer and the Spatial Editor draw it, and `tests/unit/deno/anchor_calibration.test.ts` pins its group yaw.
- Do not edit the native AR provider or its plugins (`src/ar/native.ts`, the iOS and Android plugins). The native session owns them.
- Do not edit the Spatial Editor's anchor UI.
- Do not change `src/ar/eighthwall.ts` or `src/ar/webxr.ts`. Both runtimes already feed the floor estimate through the point cloud.
- Do not add automatic alignment, or a single-tap user-heading calibration tier. See the wave README.
- Do not add a field to `ProjectSpatialFrame`. Its floor is `y = 0` in project space by construction.

## Pinned conventions

- **ADR 0001 (reuse).** This ticket extends existing types and helpers. It adds two optional fields and one builder module, and no new record type.
  - Extends `ScanCalibration` (`src/world/types.ts`) with optional `groundY`.
  - Extends `ScanManifest` (`src/world/types.ts`) with optional `calibrationGroundY`. The server fills it from the same `calibration` record the sidecar already carries, next to `calibrationSeparationM` in `server/main.ts`.
  - Extends `src/world/geo.ts`, the origin-math home, with `originDecalPlan()`, the `OriginDecalPlan` type and `readCalibrationGroundY()`. The file imports only types, so Deno can import it.
  - New `src/world/origin-decal.ts`, a Three builder. It is a sibling of `buildAnchorMarker()`, not an extension of it.
  - Searched before adding: `buildAnchorMarker` (kept, see Non-goals). `ProjectSpatialFrame` (no change needed). `GeoPose`, `LocalFrame` and `WorldProject` (these describe GPS placement and the server world file, not the AR origin, so they are untouched). `ScanEntry.calibration` (already written whole into the sidecar by `src/export/gltf.ts`, so the new field rides along with no writer change).
- **ADR 0005.** The heading on the decal comes from the two-point geometry. The compass sets only the north tick and never the transform.
- **Scene names** (the Chromium mock asserts on these, so renaming one breaks it):
  - Objects: `calibration origin` (committed), `calibration stored origin` (return visit), `calibration floor plane` (kept).
  - Parts: `origin ring`, `origin crosshair`, `origin heading` (group), `origin heading arrow`, `origin north` (group), `origin north tick`.
- **Conventions.** Yaw is in degrees on the compass convention, 0 = +Z, in `twoPointHeadingDeg`. Groups are rotated by `rotation.y` in radians, the same as `buildAnchorMarker`. All heights and distances are metres in session space unless a name says `Project`.

## Before implementation

- `src/ar/project-calibration.ts`: `clearPlacement`, `dropPersistentMarker` (replaced), `dropCommittedPair` (replaced), `drawStoredPair`, `refreshFloorGrid`, and the commit branches `commitSinglePoint` and the two-point commit.
- `src/world/anchor-marker.ts`: the north convention, and `ANCHOR_RADIUS_M`, which the decal reuses.
- `src/world/geo.ts`: `twoPointToProjectTransform`, `twoPointHeadingDeg`, `twoPointSeparationM`.
- `tests/mock-two-point-calibration.spec.ts`: `sceneObjectNames`, which reads `XR8.Threejs.xrScene()`.

## Open questions & answers

- Q: Does the brief's "no persistent origin yet" still hold? — A: No. Wave 09 persists the two-point frame on `Project.spatialFrame` and one `ScanCalibration` per scan. This ticket adds what was still missing. (decided by the implementer, 2026-11-16)
- Q: Should the origin take a single tap and a user-set heading? — A: Not as a durable frame. A heading the user sets cannot be verified across sessions, and ADR 0005 requires verification before a frame can be called verified. The compass-only fallback tier stays. (decided by the implementer, 2026-11-16)
- Q: Should the arrow be its own decal? — A: No. One group, `calibration origin`, with the arrow's tip on the heading point. The heading point was its own ring before. The arrowhead now marks it. (decided by the implementer, 2026-11-16)
- Q: Where does the ground height live? — A: On the scan, as `ScanCalibration.groundY`, which is the landmark's measured `y` in session metres. The Place-level frame gets no field, because its floor is `y = 0`. (decided by the implementer, 2026-11-16)
- Q: Should the stored origin draw a north tick? — A: No. The committed origin carries the frame's one compass fix, and a second tick would read as an independent reading. (decided by the implementer, 2026-11-16)
- Q: Should the floor grid stay after commit? — A: Yes. It moves out of the flow's placement group and is dimmed to 0.12. Re-committing replaces it, so it never stacks. (decided by the implementer, 2026-11-16)
- Q: Should `buildAnchorMarker` take an arrow parameter? — A: No. The editor and the viewer draw it, and its group yaw is tested against the bearing. A sibling builder keeps their output identical. (decided by the implementer, 2026-11-16)
- Q: Is the decal correct on a phone? — OPEN. Only DEVICE_TESTING § A-origin can answer this.

## Files impacted

- **New:** `src/world/origin-decal.ts`, `tests/unit/node/origin_decal.test.ts`, `tests/unit/node/origin_persistence.test.ts`, `docs/factory/12-origin-calibration-v1/README.md`, this ticket.
- **Changed:** `src/world/geo.ts`, `src/world/types.ts`, `src/ar/project-calibration.ts`, `server/main.ts`, `tests/mock-two-point-calibration.spec.ts`, `docs/testing/DEVICE_TESTING.md`, `docs/factory/atlas.html`, `package.json` (`test:origin`, and the `verify` chain).

## Schema required

- `ScanCalibration.groundY?: number | null` (extends the existing type). Session-space metres: the landmark's measured `y` at commit. Written by both commit tiers. Absent on records written before this ticket. `null` when unknown or not finite. Read through `readCalibrationGroundY()`.
- `ScanManifest.calibrationGroundY?: number | null` (extends the existing type). The server's mapping of the same value, read from `meta.calibration`. `null` when absent or not finite.
- No change to `ProjectSpatialFrame`, `GeoPose`, `LocalFrame` or `WorldProject`.

## Definition of Done

- [x] Origin math and decal geometry are pure and tested (`tests/unit/node/origin_decal.test.ts`).
- [x] Persisted records round-trip, including the legacy shape and the sidecar read path (`tests/unit/node/origin_persistence.test.ts`).
- [x] The committed origin draws one decal, and the stored origin draws the same decal at half opacity (`src/ar/project-calibration.ts`).
- [x] The floor grid stays up after commit, and is removed on skip (`keepFloorPlane`, the existing exit path).
- [x] `groundY` is written by both commit tiers, and `ScanManifest.calibrationGroundY` is populated on the server (`server/main.ts`).
- [x] `npx tsc --noEmit`, `deno task check` and `npm run test:origin` pass.
- [x] The Chromium mock calibration spec passes on an isolated stack (see Tests).
- [ ] DEVICE_TESTING § A-origin O1 to O10 run on an iPhone (Safari, 8th Wall).
- [ ] The same checks run on Android WebXR (Checklist B2).

## Tests

- [x] `tests/unit/node/origin_decal.test.ts`: the arrow tip lands on the heading point in world space, for several headings; the north tick follows the anchor-marker convention; a missing compass dims the ring; the stored decal takes its own name and recedes; materials are not shared.
- [x] `tests/unit/node/origin_persistence.test.ts`: a scan's origin survives JSON through the sidecar and reads back its `groundY`; a floor point at `groundY` maps to project `y = 0`; a legacy record reads as `null`; a non-finite `groundY` reads as `null`; the Place frame round-trips.
- [x] `tests/mock-two-point-calibration.spec.ts`, updated to the new names: the commit keeps the origin, its crosshair and arrow, and the floor plane; a return visit draws the stored origin; the skip path removes the floor plane.
- Commands:
  - `npm run test:origin`
  - `npx tsc --noEmit`
  - `npm run typecheck:tests`
  - `deno task check`
  - `npx playwright test --project=chromium-mock tests/mock-two-point-calibration.spec.ts`, against this worktree's own API and Vite
- Note: `tsconfig.tests.json` covers only `tests/**/*.spec.ts`, so the two `tests/unit/node/origin_*.test.ts` files were type-checked with an ad-hoc config that loads `@types/node`. Adding them to a tsconfig is a separate change.

## Acceptance Criteria

- Given a committed two-point frame, when calibration closes, then the scene holds one `calibration origin` whose arrow tip is on the heading point, and a `calibration floor plane`.
- Given a re-commit in the same session, then the scene still holds one `calibration origin`, not two.
- Given a return visit whose separation check passes, then a `calibration stored origin` is drawn at half opacity beside the committed one.
- Given a skip, then no `calibration origin` and no `calibration floor plane` remain.
- Given a scan committed on a floor at session height `h`, then its record carries `groundY = h`, and `ScanManifest.calibrationGroundY` is `h` for that scan.
- Given a record written before this ticket, then `groundY` reads as `null`, and the rest of the record is unchanged.
- On a phone, the decal sits on the floor and stays fixed as the user walks, and the north tick agrees with a compass. (Device; DEVICE_TESTING § A-origin O1 to O4.)

## Risks / potential issues

- **Risk:** the kept floor grid (10 m, dimmed) is busy over a whole scan. **Mitigation:** it is dimmed to 0.12, and O5 judges it on a phone. Reverting to removal at commit is one line in `project-calibration.ts`.
- **Risk:** the arrow's length is the measured separation, so a long baseline draws a long line across the floor. **Mitigation:** that line is the baseline the user defined. The grid's 0.5 m cells double as a distance gauge (`FLOOR_GRID_SIZE_M`). Check it in O3.
- **Risk:** the stored origin shares its landmark with the committed one, so the two overlap and differ only by the arrow's residual. **Mitigation:** the stored decal is at half opacity. Check legibility in O7.
- **Risk:** scans uploaded before this ticket carry no `groundY`, so `calibrationGroundY` is `null` for them. **Mitigation:** `null` is the documented meaning, not an error.
- **Risk:** the Node tests are outside `tsconfig.tests.json`, so `npm run typecheck:tests` does not catch a type error in them. **Mitigation:** they were checked with an ad-hoc config. Adding them to a tsconfig is a follow-up.

## Subtasks

1. [x] `src/world/geo.ts`: `OriginDecalPlan`, `originDecalPlan()`, `readCalibrationGroundY()`.
2. [x] `src/world/origin-decal.ts`: `buildOriginDecal()` with ring, crosshair, arrow and north tick.
3. [x] `src/world/types.ts`: `ScanCalibration.groundY`, `ScanManifest.calibrationGroundY`.
4. [x] `src/ar/project-calibration.ts`: `replacePersistent`, `keepFloorPlane`, `dropCommittedOrigin`, the stored-origin render, `groundY` at both commit tiers.
5. [x] `server/main.ts`: `calibrationGroundY` mapping.
6. [x] Unit tests and the `test:origin` script, added to `verify`.
7. [x] Mock spec updated to the new names and parts.
8. [x] `DEVICE_TESTING.md` § A-origin.
9. [x] Atlas diff blocks.
