> **Type:** Frontend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `feat/two-point-calibration-flow`
> **Commit style:** `feat(ar): summary`
> **Design:** this ticket is the spec. UX follows the two-point calibration pattern used by
> BIM/AR field tools (see Open questions for what was adopted and what was not).
> **Dependencies:** 0002 (schema), 0003 (environment-scan readiness). Should land after 0001,
> which it supersedes on the status question.

## Goal

Replace #141's single tap with a staged three-stage capture — establish the ground plane,
place the landmark on it, then place the heading marker — deriving the project frame's
heading from the landmark→marker geometry instead of the compass. On a repeat visit, verify
the re-measured separation against the stored `separationM` and report a real residual.

## The flow

Each stage completes before the next begins. Nothing is placed against an unestablished
reference.

1. **Establish the ground plane** (ticket 0003). The readiness step — tracking stable *and*
   the ground estimate locked. The plane is now a session artifact, not just a gate: it
   constrains both markers below.
2. **Place the landmark** — the origin, the permanent spot in the room. Tap the ground; the
   hit is projected onto the established plane and a decal drops there. The user confirms it
   before continuing, so the landmark is committed and stationary while they walk to place
   the second marker.
3. **Place the heading marker** — walk at least `MIN_POINT_SEPARATION_M` away and tap a
   second ground point, also projected onto the same plane. While placing, a live readout
   shows the current distance from the committed landmark and a connecting line renders
   between them, so the user can see the baseline forming and judge whether it is long
   enough.
4. **Adjust and commit** — either marker can be re-placed before committing (tap-near to
   select, tap again to move); the separation readout updates live. Commit builds
   `sessionToProject`, computes the residual against any stored frame, and finishes.

On a first calibration the frame is written to `Project.spatialFrame`. On a repeat visit the
stored frame is verified: if the re-measured separation deviates from `separationM` by more
than `toleranceM`, the user is told the markers do not match the recorded pair and is asked
to re-place rather than being silently accepted.

## The math

**Ground-plane projection comes first.** Both markers are snapped to the established plane's
`y` before any frame math runs:

```
landmark    = { x: hitA.x, y: groundY, z: hitA.z }
headingMark = { x: hitB.x, y: groundY, z: hitB.z }
```

This is not cosmetic. Hit-test results carry a few centimetres of noise in `y`, and an
unprojected pair produces a baseline with a spurious vertical component — which tilts the
frame, so the room's floor is no longer level in project space. Projecting both onto one
plane guarantees a horizontal baseline and makes project-space `y = 0` the floor, the third
alignment axis ticket 0002 describes.

Then, with both markers on the plane:

- `headingRad = Math.atan2(headingMark.x - landmark.x, headingMark.z - landmark.z)` — the
  same `atan2(x, z)` Y-up convention already used by `src/viewer/viewer.ts:3266`'s
  `updateWorldHud()` and matching `composeYUpTransform`'s own rotation construction
  (`src/world/geo.ts:60-71`), so all three agree on handedness.
- The frame is then exactly what `anchorToProjectTransform()` already builds — origin at the
  landmark, rotation about Y — but with the yaw supplied by geometry instead of the compass.
  Add a sibling `twoPointToProjectTransform(landmark, headingMark)` in `src/world/geo.ts`
  that computes the heading and delegates the matrix construction, rather than duplicating
  the column-major translation arithmetic (`src/world/geo.ts:86-98`) a second time.
- `separationM = Math.hypot(dx, dz)` — a 2D distance, since both markers are coplanar by
  construction. Using `Math.hypot(dx, dy, dz)` here would be harmless but misleading, implying
  a vertical component that projection has already removed.

## Non-goals

- Do not remove the single-point path. It stays as the documented fallback tier (ticket 0002)
  for when a second point is impractical — reachable from this flow, clearly labelled as
  lower accuracy, not the default.
- Do not use the compass to build a two-point frame. Record `anchorBearingDeg` as metadata
  only (ticket 0002's separation of geometry-for-relative vs compass-for-absolute).
- Do not build map/BIM point-picking. The cited reference picks two points on an existing
  model first; this app has no such model on a first calibration. Deferred — see Open
  questions.
- Do not add drag-to-reposition gestures. Adjustment is select-then-retap, reusing the
  existing tap handlers (see Pinned conventions).
- Do not gate on the residual so hard that a user is trapped. A mismatch warns and offers
  re-placement or explicit override; it does not permanently block scanning.
- Do not change `anchorToProjectTransform()`'s signature or behavior — add a sibling.

## Pinned conventions

**ADR 0005** — `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md`
governs this wave: a frame's orientation comes from tracked geometry, the compass is metadata
for absolute orientation only, and a `'verified'` status must be backed by a measurement.

**ADR 0001** — consumes ticket 0002's schema; adds no persisted type. The Place write path is
the existing `projectStore.updateProject()` + `persistProjectSpatialFrame()`'s
`PUT /projects/:id` (`src/main.ts`'s `projectStore.updateProject()` + `persistProjectSpatialFrame()` path) — no new route or store.

**Reuse `buildAnchorMarker()`** (`src/world/anchor-marker.ts`) for both point decals — it is
the shared "a calibration reference sits here" visual used by both the capture view and the
World Editor. Pass a bearing only for the committed frame's origin; pass `null` while placing,
using the dimmed state it already renders. Do not add a second decal geometry.

**Reuse `provider.getScene()`** (`src/ar/provider.ts:79-87`) exactly as
`runProjectCalibration()`'s `provider.getScene()` decal block already does. Every decal added during placement must
be removed on any exit path — #141 deliberately leaves the committed origin marker in the
scene for the session; in-progress placement decals must not leak.

**Reuse the existing input handlers.** `runProjectCalibration()`'s `onTouchStart`/`onPointerDown` handlers already
handles `touchstart` + `pointerdown` with the `pointerType === 'touch'` double-fire skip and
`placeAt()`'s non-finite/out-of-range coordinate rejection (in `placeAt()`). Extend that path; do not
write a second input mechanism.

**Reuse the existing overlay chrome.** `.project-calibration-card`,
`.project-calibration-status`, `.project-calibration-link`, and the
`.project-calibration-link-promoted` state (`index.html`, as #142 left them) — no new visual
language. Note #141 removed the multi-step progress dots; a two-step flow may want them back,
which is a revert of a deletion rather than a new component.

**`atan2(x, z)` convention** as above — matched to `viewer.ts:3266` and
`composeYUpTransform`.

## Before implementation

- `src/ar/project-calibration.ts` (full file) — the flow being extended, especially
  `placeAt()` and the `onTouchStart`/`onPointerDown` handlers.
- `src/world/geo.ts:60-98` — `composeYUpTransform` and `anchorToProjectTransform`, whose
  translation arithmetic the new sibling must reuse rather than copy.
- `src/world/anchor-marker.ts` — `buildAnchorMarker()`, `ANCHOR_RADIUS_M`.
- `src/main.ts`'s `runProjectCalibration()` call site — the call site and Place persistence.
- `index.html` — the calibration card styles as #142 left them.
- Tickets 0002 (schema/constants) and 0003 (readiness gate).

## Open questions & answers

- Q: What was adopted from the cited reference, and what was not? — A: Adopted: two
  real-world points as the accurate method; a distinct environment-scan/plane-detection step
  before alignment (ticket 0003); adjust-a-placed-point-before-committing; explicit
  lock/commit rather than immediate acceptance. Not adopted: picking the two points on a
  Map/BIM model first (no such model exists on a first calibration here), and hover-reticle
  targeting (this app is tap-driven per #141; a hover reticle presumes a persistent aiming
  cursor the flow no longer has). (Decided in this ticket.)
- Q: Could a later visit pick its two points against the *previous scan* rather than
  physically re-finding them — the reference's Map/BIM step? — A: Yes, and that is the natural
  end state: the World Editor already renders anchors as a layer (#141's `'anchor'` LayerType).
  Deferred to its own ticket because it needs the previous scan loaded on the device during
  capture, which this wave does not otherwise require. Worth revisiting once two-point
  landing proves out. (Decided in this ticket.)
- Q: Selecting a placed point to adjust it — how, without a hover reticle? — A: Tap-near.
  A tap within `ANCHOR_RADIUS_M` of an existing point selects it instead of placing a new one;
  the next tap re-places the selected point. This reuses the existing tap path with a distance
  check, adds no gesture handling, and matches the reference's intent (adjust before commit)
  without its cursor model. Selection state must be visible on the decal. (Decided in this
  ticket.)
- Q: What if the user cannot reach a second point ≥ `MIN_POINT_SEPARATION_M` away? — A: The
  single-point fallback stays reachable from this flow, writing a `'ground-tap-compass'` frame
  and clearly labelled lower-accuracy with no cross-session verification. This is the tier
  boundary ticket 0002 defines, surfaced in UI. (Decided in this ticket.)
- Q: Does committing a verified two-point calibration produce `status: 'verified'`? — A: Yes —
  and unlike #141's version this is measured, restoring the producer ticket 0001 retired.
  `'verified'` = a stored frame existed and the re-measured separation matched within `toleranceM`.
  `'provisional'` = first calibration, or a single-point fallback, or a user override after a
  mismatch. This ticket owns updating the `status` doc comment 0001 added. (Decided in this
  ticket.)
- Q: Does the residual go into the GLB sidecar? — A: Yes, via the existing generic
  `calibrationResidualM`/`calibrationToleranceM` keys — which already exist in
  `src/export/gltf.ts:429-430` and currently write `null` because #141 removed the fields
  they read. This ticket makes those keys carry real values again with no export-path change.
  (Decided in this ticket, verified by direct read.)

## Files impacted

Changed:
- `src/world/geo.ts` (new `twoPointToProjectTransform()`)
- `src/ar/project-calibration.ts` (the two-point flow)
- `src/main.ts` (persist a changed frame on repeat visits, not only first calibration)
- `src/world/types.ts` (update the `status` doc comment per Open questions)
- `index.html` (two-step copy/controls, reusing existing calibration-card styles)

## Schema required

None new — consumes ticket 0002's `'two-point-ground'` member.

One behavioral note on an existing invariant: `src/main.ts`'s `if (calibration.spatialFrame)` branch currently treats
`calibration.spatialFrame` as "this was the first calibration" (#141 returns it only then).
A repeat visit that re-places points must also return an updated frame, so that branch's
meaning changes from *first-ever* to *frame changed* and needs re-reading rather than
assuming.

## Definition of Done

- [ ] `twoPointToProjectTransform(landmark, headingMarker)` added to `src/world/geo.ts`,
      delegating to the existing translation construction rather than duplicating it
- [ ] Staged placement implemented: ground plane established → landmark placed and confirmed
      → heading marker placed, with `MIN_POINT_SEPARATION_M` enforced and explanatory copy
- [ ] Both markers projected onto the established ground plane's `y` before any frame math
- [ ] The committed landmark stays rendered while the heading marker is being placed, with a
      live distance readout and a connecting line between them
- [ ] Tap-near selection re-places an existing marker; selection state is visible
- [ ] Commit builds the frame from geometry; `anchorBearingDeg` recorded as metadata only
- [ ] Repeat visits compute `residualM` against stored `separationM` and warn beyond
      `toleranceM`, offering re-place or explicit override
- [ ] `status` is `'verified'` only on a measured match; `'provisional'` otherwise
- [ ] Single-point fallback reachable and labelled as lower-accuracy
- [ ] All placement decals removed from the provider scene on every exit path
- [ ] `spatialFrame` returned whenever the frame changed; `src/main.ts` persists it locally
      and via `PUT /projects/:id`
- [ ] `status` doc comment in `src/world/types.ts` updated to the measured definition
- [ ] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

Automated (extend `anchor_calibration.test.ts` from ticket 0005):

- [ ] `twoPointToProjectTransform()` maps the landmark to project-space `(0,0,0)`
- [ ] It maps the heading marker onto the frame's forward axis at the recorded separation
      from the origin — the defining property of a two-point frame
- [ ] Rotating the input pair about the vertical axis produces the *same* project-space
      result for both markers (proves the frame is derived from the pair, not from the AR
      session's arbitrary yaw — the exact defect this ticket exists to fix)
- [ ] The frame is rigid: no scale or skew (distances between arbitrary transformed points
      are preserved)
- [ ] Ground projection: two hits with differing `y` produce coplanar markers, a horizontal
      baseline, and a heading unaffected by the discarded `y` noise
- [ ] Project-space `y = 0` is the ground plane — a third point hit-tested on the floor maps
      to `y ≈ 0`, not to an arbitrary offset
- [ ] Separation below `MIN_POINT_SEPARATION_M` is rejected
- [ ] Residual computation: matching separation → within tolerance; a deliberately different
      second pair → beyond tolerance
- [ ] A commit with a matching stored frame yields `'verified'`; first calibration, fallback,
      and post-override all yield `'provisional'`
- [ ] Playwright (`tests/`, matching `tests/ar-scan.spec.ts`): the overlay always unmounts;
      skipping still lets scanning proceed uncalibrated

On-device (Android or iOS; not automatable):

- [ ] Calibrate with two points ~2 m apart against fixed architectural features; scan; export
- [ ] New session, same two physical features: residual reports within a few centimetres and
      status is `'verified'`
- [ ] New session, deliberately wrong second point: residual exceeds tolerance and the
      mismatch is reported rather than accepted
- [ ] **Compass-independence check:** calibrate two sessions of the same room while starting
      the AR session facing different directions; confirm both scans land in the same
      orientation in the World Editor. This is the regression #141 cannot pass when
      `bearingDeg` is null, and is the clearest single demonstration of the ticket's value

```bash
npx tsc --noEmit && deno task check && deno task test
npx playwright test tests/ar-scan.spec.ts
```

## Acceptance Criteria

- [ ] Given the ground plane has not yet locked, When calibration opens, Then the landmark
      cannot be placed — the stages are strictly ordered
- [ ] Given a landmark and heading marker ≥ `MIN_POINT_SEPARATION_M` apart, When committed,
      Then the frame's origin is the landmark and its heading follows landmark→marker, with
      no compass contribution
- [ ] Given two hits whose raw `y` differs by several centimetres, When committed, Then both
      markers are coplanar on the established ground plane and the baseline is horizontal
- [ ] Given a committed two-point frame, Then a floor point hit-tested anywhere in the room
      maps to project-space `y ≈ 0`
- [ ] Given no compass fix at all, When a two-point calibration is committed, Then the frame
      is still fully determined (the `bearingDeg ?? 0` failure mode is unreachable on this
      path)
- [ ] Given a Place with a stored two-point frame, When a later session places both markers
      on the same two features, Then `residualM` is small and status is `'verified'`
- [ ] Given a later session that uses a different pair, Then the mismatch is reported with the
      measured discrepancy and the user can re-place or override
- [ ] Given a placed marker, When the user taps within `ANCHOR_RADIUS_M` of it and then
      elsewhere, Then that marker moves and the separation readout updates
- [ ] Given the single-point fallback, Then a `'ground-tap-compass'` frame is written and
      labelled lower-accuracy with no verification claim
- [ ] Given any exit path, Then no placement decal remains in the scene during scanning

## Risks / potential issues

- **Risk (highest):** heading accuracy scales inversely with separation — hit-test noise of a
  few centimetres over a short baseline produces large angular error, and the failure is
  silent (a plausible frame, subtly rotated). — **Mitigation:** `MIN_POINT_SEPARATION_M = 1.0`
  enforced in UI with copy encouraging a longer baseline; the live separation readout makes
  the tradeoff visible; the on-device compass-independence check is the real proof.
- **Risk:** Two taps plus adjustment is more friction than #141's one tap, on a flow that
  runs before every scan. — **Mitigation:** the single-point fallback remains for users who
  want speed; the accuracy difference is stated rather than imposed. If telemetry-free
  observation shows users always take the fallback, that is a signal the second tap needs to
  be optional-but-encouraged rather than default — capture it rather than assume.
- **Risk:** `separationM` verifies that two points the *right distance apart* were tapped —
  not that they were the *same* two points. A room with two door frames 2 m apart in different
  places passes. — **Mitigation:** honest limitation, stated in copy: the residual detects
  gross mistakes, not identity. `pointLabels` (ticket 0002) help the user pick the same
  features. Genuine identity requires image targets or VPS anchors, out of scope for this
  wave and worth naming as the reason the cited reference calls two-point the method to use
  *when image targets are unavailable*.
- **Risk:** Changing `src/main.ts`'s `if (calibration.spatialFrame)` branch's `spatialFrame` semantics from first-ever to
  frame-changed could double-write or skip a write. — **Mitigation:** called out in Schema
  required and Definition of Done; that branch must be re-read, not assumed.
- **Risk:** Re-placing a point after committing to project space mid-flow could mix
  coordinate frames. — **Mitigation:** keep both points in session-local coordinates for the
  entire placement phase and convert once at commit; never convert incrementally.

## Subtasks

1. [ ] Add `twoPointToProjectTransform()` to `src/world/geo.ts` with its unit tests
2. [ ] Extend `runProjectCalibration()` to a staged state machine (ground established →
       landmark placed and confirmed → heading marker placed → adjust → commit), keeping both
       markers session-local until commit
3. [ ] Project both hits onto the established ground plane's `y` at placement time
4. [ ] Keep the committed landmark rendered while the heading marker is placed; add the
       connecting line, the live distance readout, and `MIN_POINT_SEPARATION_M` enforcement
5. [ ] Add tap-near selection and re-placement
6. [ ] Implement residual computation and the mismatch warn/re-place/override path
7. [ ] Wire the single-point fallback as an explicit, labelled option
8. [ ] Ensure every exit path clears placement decals
9. [ ] Return `spatialFrame` on any frame change; update `src/main.ts` persistence
10. [ ] Update the `status` doc comment in `src/world/types.ts`
11. [ ] Add staged copy/controls to `index.html`
12. [ ] Write the unit and Playwright tests
13. [ ] `npx tsc --noEmit`, `deno task check`, `deno task test`, Playwright
14. [ ] Run the on-device checks, especially the compass-independence one; record results here
