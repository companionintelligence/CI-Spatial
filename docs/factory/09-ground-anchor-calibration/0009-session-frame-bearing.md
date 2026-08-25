> **Type:** Frontend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `fix/session-frame-bearing`
> **Commit style:** `fix(world): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Independent of 0007 and 0008.

## Goal

Record and use the bearing of the **session frame**, not of the **device**. Every consumer of
`anchorBearingDeg` and every call into `composeYUpTransform` wants to know which way the AR
session's axes point; what was being passed is which way the phone was pointing when the user
tapped. The two differ by however the camera was held — and at the session's starting
orientation they differ by exactly 180°.

## The bug, derived rather than asserted

`composeYUpTransform(t, b)` builds a Y-up rotation whose third column is `(sin b, 0, cos b)`.
It therefore maps **session +Z to the ENU direction at bearing `b`** — `geoToEnu` defines
`x = east, y = up, z = north`, and `(sin b, 0, cos b)` is the unit vector at compass bearing
`b` in that basis. So `b` must be *the bearing of session +Z*.

What was passed is `geoTracker.snapshot().bearing` — a `deviceorientation` heading, i.e. where
the **device** points. Two separate errors follow:

1. **A 180° flip.** The camera looks down its own −Z. Where the session frame is established
   at the camera's starting orientation, session +Z points *behind* the initial view, so a
   frame built from the raw heading faces exactly backwards.
2. **The camera's yaw within the session.** The heading is sampled at *tap* time, not at
   session start. Any turning the user did in between is in the reading and none of it belongs
   to the frame. This is the larger error of the two — it is unbounded, where the flip is a
   constant.

**Do not fix this by subtracting a literal 180.** That encodes a guess about how WebXR and
8th Wall each initialise their world frames — neither guarantees it — and it leaves error 2
untouched.

**Fix it by measuring instead.** At the moment the heading is read, the camera's forward
direction is a single physical direction described in *both* frames at once: as a yaw within
the session (computable from the pose quaternion, which is already available) and as a compass
bearing (the reading itself). Their difference **is** the offset between the frames:

```
sessionFrameBearing = deviceBearing − cameraYawInSession
```

This assumes nothing about the provider, and the 180° falls out on its own whenever the camera
happens to sit at the session's starting orientation.

## What this does and does not fix

**Fixed:** the `'ground-tap-compass'` tier, where the bearing *is* the frame's entire heading,
and the `anchorBearingDeg` recorded on every new frame of either tier.

**Also fixed, same root cause, found during implementation:** the anchor marker's north tick.
`buildAnchorMarker(bearingDeg)` yaws the decal so its tick points along `(sin θ, 0, cos θ)` in
its **parent** frame. That equals north only where the parent's +Z is already north — true of
project space, false of an AR session. The calibration decals live in session space, so the
tick was aimed at whatever the compass read rather than at north, and with the camera near its
starting orientation that is exactly backwards. The parameter is renamed `northYawDeg`,
because a yaw in the parent frame is what it has always geometrically been. The viewer's call
passes nothing (`src/viewer/viewer.ts:1671` — its own comment calls the tick a
live-capture-only refinement), so it is unaffected.

**Not fixed, and it cannot be here:** `server/main.ts`'s GPS fallback,
`composeYUpTransform(translation, geoPose.bearing, 1)`. `geoPose.bearing` is the device heading
stored on the scan, and the server has no camera pose to correct it with. That path only runs
for a scan with **no** `projectTransform` at all — i.e. one that was never calibrated — so
there is no session frame bearing in existence for it to use. Correcting it needs the client to
persist a frame bearing into scan meta, which is a data-format change and its own ticket. Left
explicitly broken rather than papered over.

**Two-point frames were already immune** and stay so: their heading comes from the
landmark→marker geometry and never touches the compass (ADR 0005). This ticket only makes their
recorded `anchorBearingDeg` metadata correct.

## Non-goals

- Do not subtract a hardcoded 180 anywhere. See above.
- Do not change `composeYUpTransform`, `anchorToProjectTransform`, or
  `twoPointToProjectTransform`. They are correct given a correct bearing; the bug is entirely
  in what was handed to them. Changing a convention that three call sites and a test suite
  already agree on would be the riskiest possible way to fix a caller.
- Do not touch the two-point tier's heading derivation.
- Do not migrate stored `anchorBearingDeg` values. See Risks — a stored value cannot be
  corrected after the fact, because the camera pose that would fix it was never recorded.
- Do not change `server/main.ts`. See above.
- Do not add a compass-calibration UI, or re-open whether the compass sets a frame's rotation
  — settled 2026-08-25 and recorded in HANDOFF.

## Pinned conventions

**ADR 0001** — no new type, queue or route. The two new functions live in `src/world/geo.ts`
beside `composeYUpTransform`, whose convention they exist to satisfy; putting them anywhere
else would let the two drift. Searched first: no existing helper converts a quaternion to a
yaw (`grep -rn "atan2" src/` finds only `twoPointHeadingDeg`, which takes two points, and
`viewer.ts`'s HUD, which reads a matrix).

**ADR 0002** — `geo.ts` must stay DOM- and Deno-API-free; it is imported by `server/main.ts`
*and* by Deno unit tests. The additions are arithmetic over a plain `Quat`.

**Yaw convention** — `atan2(x, z)`, matching `composeYUpTransform` and `twoPointHeadingDeg`.
`geo.ts`'s own comment already pins these three as one convention; a fourth would be the bug
this wave keeps finding.

## Before implementation

- `src/world/geo.ts:124-135` — `composeYUpTransform`. Work out its third column by hand before
  changing any caller; the whole ticket rests on what it maps +Z to.
- `src/world/geo.ts:86-99` — `geoToEnu`, which fixes `x = east, z = north`.
- `src/ar/provider.ts:4-7, 59` — `Pose` and `getPose()`, the pose that makes the correction
  measurable.
- `src/geo/geo-tracker.ts:162-167` — where `bearing` comes from, and that it is a device
  heading.
- `src/world/anchor-marker.ts:19-28` — the doc comment claiming no sign flip is needed, which
  is true only in a north-aligned parent.
- `server/main.ts:1493-1494` — the GPS fallback this ticket deliberately leaves alone.

## Open questions & answers

- Q: Subtract 180, or measure the camera yaw? — A: **Measure.** A literal 180 encodes an
  unguaranteed assumption about provider frame initialisation and leaves the tap-time yaw error
  in place. Measuring fixes both and assumes nothing. (Decided in this ticket.)
- Q: Should `anchorBearingDeg`'s meaning change, or should a new field be added? — A: **Change
  the meaning.** Every consumer already wanted the frame's bearing; none wanted the device's. A
  second field would leave the wrong one in place for something to keep reading. The field's
  doc comment now says which it is. (Decided in this ticket.)
- Q: Can stored values be migrated? — A: **No, and this must be said plainly.** Correcting a
  stored bearing needs the camera pose at the instant it was sampled, which was never recorded.
  A blanket −180 would fix only frames captured at the session's starting orientation and would
  *add* error to the rest. Records written before this ticket are wrong by an unknown amount;
  the honest handling is to leave them and note it. (Decided in this ticket.)
- Q: Does the marker tick belong in this ticket or its own? — A: **This one.** Same root cause,
  same one-line class of error, and it is the only user-visible symptom — a scan's data being
  180° out is invisible until two scans are overlaid, but a north tick pointing south is
  visible immediately. Splitting it would leave the visible half of one bug open.
  (Found and decided during implementation.)
- Q: Why not fix the server's GPS fallback too? — A: It needs data that does not exist. See
  "What this does and does not fix". (Decided in this ticket.)

## Files impacted

New:
- none

Changed:
- `src/world/geo.ts` — `cameraYawInSessionDeg()`, `sessionFrameBearingDeg()`, `normaliseBearingDeg()`
- `src/world/anchor-marker.ts` — parameter renamed to `northYawDeg`, doc corrected
- `src/ar/project-calibration.ts` — samples the corrected bearing; marker tick takes a session yaw
- `src/world/types.ts` — `anchorBearingDeg`'s doc comment on both tiers
- `tests/unit/deno/anchor_calibration.test.ts` — the geometry proofs
- wave README, HANDOFF, `docs/factory/atlas.html`

## Schema required

No shape change. `anchorBearingDeg`'s **meaning** changes on both tiers — from "the device's
compass heading when the user tapped" to "the true-north bearing of the session frame's +Z
axis" — and both doc comments must say so, including that records written before this ticket
carry the old meaning and cannot be migrated.

## Definition of Done

- [ ] `cameraYawInSessionDeg()` returns the camera's forward yaw in session coordinates,
      `atan2(x, z)`, with an identity rotation giving 180°
- [ ] `sessionFrameBearingDeg()` returns `deviceBearing − cameraYawInSession`, normalised, and
      `null` for a null/non-finite heading
- [ ] No literal 180 appears anywhere in the fix
- [ ] Both calibration commit paths record the corrected bearing
- [ ] `anchorToProjectTransform` on the one-point tier is built from the corrected bearing
- [ ] `buildAnchorMarker`'s parameter is `northYawDeg`, documented as a parent-frame yaw, and
      the session-space caller converts
- [ ] `anchorBearingDeg`'s doc comment on both tiers states the new meaning and the
      un-migratable history
- [ ] `server/main.ts` is unchanged, and the reason is written down
- [ ] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

- [ ] `cameraYawInSessionDeg`: identity → 180°; ±90° yaw quaternions → ∓90°; 180° → 0°
- [ ] **The defining property:** for a grid of device bearings × camera yaws, the camera's
      forward direction resolves to the *same* compass bearing whether read as a bearing or
      pushed through `composeYUpTransform(frameBearing, cameraSessionYaw)`. Deriving the answer
      from the matrix rather than asserting an angle is what ties the test to the real contract
- [ ] **The bug, as a test:** at the session's starting orientation the uncorrected value is
      exactly 180° out, and the uncorrected transform reports a camera looking east as facing
      west
- [ ] Turning 60° mid-session changes the device heading by 60° and the frame bearing by 0
- [ ] A null, undefined or `NaN` heading yields `null`, never 0
- [ ] `normaliseBearingDeg` folds negatives and >360 into `[0, 360)`
- [ ] The existing `anchor_calibration.test.ts` cases pass untouched — the conventions this
      builds on are unchanged
- [ ] `mock-two-point-calibration` passes: the calibration flow still commits

```bash
npx tsc --noEmit && deno task check && deno task test
VITE_URL=https://<host>:<port> npx playwright test --project=chromium-mock mock-two-point-calibration
```

## Acceptance Criteria

- [ ] Given the camera at the session's starting orientation and a compass reading of 90°,
      Then the recorded frame bearing is 270°, not 90°
- [ ] Given a user who turns 60° between session start and tapping, Then the recorded frame
      bearing is unchanged by the turn
- [ ] Given no compass fix, Then the recorded bearing is `null`, not 0
- [ ] Given a one-point calibration, Then `sessionToProject` is built from the corrected bearing
- [ ] Given a two-point calibration, Then its heading still comes from geometry alone and only
      the recorded metadata changes
- [ ] Given the anchor decal in session space, Then its north tick points at true north

## Risks / potential issues

- **Risk (the important one):** **Frames recorded before this ticket are wrong by an unknown
  amount and cannot be migrated.** The correction needs the camera pose at the instant the
  bearing was sampled, which was never stored. A blanket −180 would fix only those captured at
  the session's starting orientation and would add error to every other. — **Mitigation:** do
  not migrate. Document it on the field. Any consumer comparing an old frame with a new one is
  comparing two different quantities, and nothing in the app does that today because *nothing
  reads `anchorBearingDeg` at all* — which is the only reason this is survivable.
- **Risk:** No device verification. The derivation is analytic and the tests are self-consistent
  with `composeYUpTransform`'s convention; if that convention is itself wrong relative to the
  real world, these tests would agree with it and still be wrong. — **Mitigation:** the one
  on-device check that would settle it is small — stand facing a known bearing, calibrate, read
  back `anchorBearingDeg` — and belongs with 0005's device checklist. Recorded there rather
  than claimed here.
- **Risk:** `getPose()` returning a stale or default pose would silently produce a wrong
  correction. — **Mitigation:** both providers return their live `latestPose`, and calibration
  cannot reach a commit without `isTracking()` having been true. Worth re-checking if a third
  provider is ever added.
- **Risk:** Renaming `buildAnchorMarker`'s parameter is a signature change on a shared decal
  used by both the capture view and the viewer. — **Mitigation:** it is positional and both
  call sites are in-repo; the viewer passes nothing at all.

## Subtasks

1. [ ] Derive `composeYUpTransform`'s third column by hand and confirm what it maps +Z to
2. [ ] Add `cameraYawInSessionDeg`, `normaliseBearingDeg`, `sessionFrameBearingDeg` to `geo.ts`
3. [ ] Write the geometry tests, including the round-trip that reads the answer back out of the
       matrix and the "uncorrected is 180° out" case
4. [ ] Sample the corrected bearing in both calibration commit paths
5. [ ] Rename `buildAnchorMarker`'s parameter; convert at the session-space call site
6. [ ] Update `anchorBearingDeg`'s doc comment on both tiers
7. [ ] Run the mock calibration spec
8. [ ] Update the wave README, HANDOFF finding 2, and the atlas
9. [ ] `npx tsc --noEmit && deno task check && deno task test`
