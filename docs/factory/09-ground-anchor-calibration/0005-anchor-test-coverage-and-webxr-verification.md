> **Type:** Frontend (test/verification)
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `test/anchor-calibration-coverage`
> **Commit style:** `test(ar): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None — can land in parallel with every other ticket in this wave.

## Goal

Put test coverage under the calibration math #141 shipped with none, and carry out the
on-device WebXR verification that PR's own source comment says it still needs. Everything
this wave's other tickets build sits on top of `anchorToProjectTransform()` and the WebXR
renderer rework; both are currently unverified.

**Scope note:** this ticket covers what *#141 already shipped*. Ticket 0004's own
`twoPointToProjectTransform()` tests live with that ticket (it would be strange to test an
unwritten function here), but they belong in the same `anchor_calibration.test.ts` file this
ticket creates — so this ticket establishes the file, the harness, and the conventions 0004
extends. Landing this first makes 0004's test work additive.

## What is unverified

**No automated coverage at all.** Grepped this session: no test file anywhere references
`anchorToProjectTransform`, `buildAnchorMarker`, or `'ground-tap-compass'`.
`deno.json`'s `"test"` task lists 21 files, none covering the calibration path. So:

- `anchorToProjectTransform()` (`src/world/geo.ts`) — the matrix every calibrated scan's
  placement depends on, including hand-indexed column-major arithmetic
  (`r00 = rotation[0], r01 = rotation[4], …`) where a single transposed index yields a
  plausible-looking but wrong transform.
- `buildAnchorMarker()` (`src/world/anchor-marker.ts`) — including the documented claim that
  Three.js's Y-rotation "is exactly compass bearing's own 0°=north/90°=east convention, so no
  sign flip is needed", which nothing tests.
- The `null`-bearing path (no compass fix) through both.

**The WebXR side is self-flagged as unproven.** `src/ar/webxr.ts`'s own header, added by
#141:

> This is the less-proven half of the calibration-decal work (the 8th Wall side has a working
> in-repo reference; this doesn't) — needs verification on a real WebXR device, not just
> review.

That half is not small. #141 replaced the provider's hand-rolled
`session.requestAnimationFrame` loop with `THREE.WebGLRenderer` + `renderer.xr.setSession()`
+ `setAnimationLoop()`, added a `local-floor`/`local` reference-space fallback on two
independent request paths, added a frame-loop guard for Three's own non-XR rAF firing with
`frame === undefined`, and reordered renderer disposal to follow `session.end()`. Each is a
real behavioral change to the Android/Quest capture path, justified in comments but confirmed
by review only.

## Non-goals

- Do not change `anchorToProjectTransform()`, `buildAnchorMarker()`, or the WebXR provider's
  behavior. This ticket characterises what shipped. If a test proves something wrong, the fix
  is its own ticket referencing the failing case — do not silently repair and re-baseline in
  the same commit.
- Do not add Playwright coverage of the live AR capture flow itself. WebXR/8th Wall sessions
  cannot be driven headlessly here; that is what the on-device checklist is for.
- Do not test Three.js's own internals (`Matrix4`, `setAnimationLoop`).
- Do not add a mock XR runtime. `tests/` already has 8th Wall mock fixtures
  (`public/test-fixtures/xr8-mock.js`, `tests/mock-xr8-scan.spec.ts`); building an equivalent
  WebXR mock is a much larger piece of infrastructure and is not this ticket.

## Pinned conventions

**ADR 0001** — no schema, config, or connection touched. Pure test addition.

**Deno test convention**: root-level flat `*.test.ts` importing from `./src/...`, and the
filename **must** be appended to `deno.json`'s hand-maintained `"test"` task string — it does
not glob, so an unregistered file silently never runs. Follow the existing style of
`world_membership.test.ts` / `thing_tags.test.ts` (pure-module tests, `Deno.test(...)` with
`@std/assert`).

**Matrix layout**: `anchorToProjectTransform()` returns column-major
(`THREE.Matrix4.fromArray()` convention), documented inline in `src/world/geo.ts`. Assertions
must state which convention they assume, so a future reader can tell a convention change from
a math bug.

**On-device checklist convention**: `docs/DEVICE_TESTING.md` holds this repo's manual device
protocol (Checklist A: iPhone/8th Wall; Checklist B: Android/WebXR). Extend Checklist B
rather than inventing a parallel document. Note #141/#142 already edited that file (68 lines)
— read it as it now stands before adding.

## Before implementation

- `src/world/geo.ts` — `composeYUpTransform()` and `anchorToProjectTransform()`, including the
  column-major index comments.
- `src/world/anchor-marker.ts` — the bearing→`group.rotation.y` claim.
- `src/ar/webxr.ts` — the renderer/session/frame-loop changes and their justifying comments.
- `world_membership.test.ts` — the closest existing example of a pure-module Deno test.
- `docs/DEVICE_TESTING.md` — Checklist B and the results matrix.
- `deno.json` — the `"test"` task string.

## Open questions & answers

- Q: Can `buildAnchorMarker()` be tested under Deno given it imports Three.js? — A: Yes.
  Three.js is a pure-JS npm dependency already resolvable in this repo's Deno setup
  (`nodeModulesDir: "auto"`), and `buildAnchorMarker()` touches no DOM, canvas, or WebGL
  context — only `BufferGeometry`, `LineSegments`, `Group`, and `MathUtils`. If it
  nonetheless fails to import under Deno, fall back to asserting the geometry math via a
  small extracted pure helper rather than pulling in a DOM shim, and note the fallback in
  this section. (Decided in this ticket; verify on first run.)
- Q: What is the expected `sessionToProject` for a known input? — A: Derived from the
  function's own stated invariant — the tapped point must map to project-space `(0,0,0)`.
  That gives a convention-independent assertion: for any `tapPos` and `bearingDeg`, applying
  the returned matrix to `tapPos` yields `(0,0,0)`. This is the strongest available test
  because it restates the contract rather than re-deriving the arithmetic (a re-derivation
  would just reproduce any indexing bug it contains). (Decided in this ticket.)
- Q: Should the WebXR verification block this ticket from closing? — A: Yes for the ticket,
  no for the wave. The automated-coverage half can merge first; the on-device half stays an
  unchecked box until a real Android/WebXR device runs it. That is the same pattern
  `04-capture-path-truthfulness/0002` used (implementation merged, on-device box unchecked
  until measured). (Decided in this ticket.)
- Q: Which device? — A: Per `docs/DEVICE_TESTING.md`'s fleet, an ARCore-backed Android is
  required — the Galaxy Tab S9 Ultra or S8 Ultra. Quest browser is a useful second data point
  because it exercises the controller-driven `pointerdown` path (`project-calibration.ts:153`)
  that a touchscreen never hits, but is not required. iPhone/Safari does **not** exercise this
  code at all (no `immersive-ar`; it runs the 8th Wall provider). (Decided in this ticket.)

## Files impacted

New:
- `anchor_calibration.test.ts` (repo root)

Changed:
- `deno.json` (register the new test file)
- `docs/DEVICE_TESTING.md` (extend Checklist B + results matrix with the anchor-decal rows)

## Schema required

None.

## Definition of Done

- [ ] `anchor_calibration.test.ts` exists, is registered in `deno.json`'s `"test"` task, and
      passes
- [ ] `anchorToProjectTransform()` covered: origin-maps-to-zero invariant, `null` bearing,
      a non-zero bearing, and a tap at a non-zero Y
- [ ] `buildAnchorMarker()` covered: north tick present with a bearing / absent without,
      dimmed material state when `bearingDeg == null`, and `rotation.y` matching the bearing
      in radians
- [ ] `docs/DEVICE_TESTING.md` Checklist B extended with the anchor-decal steps below
- [ ] `deno task test` passes with the new file included
- [ ] **On-device (Android/WebXR)**: the checklist below completed and its result recorded in
      this ticket

## Tests

Automated:

- [ ] For several `(tapPos, bearingDeg)` pairs including `bearingDeg: null`, applying the
      returned matrix to `tapPos` yields `(0,0,0)` within floating-point tolerance
- [ ] A point offset from `tapPos` by a known vector maps to a project-space position at the
      same distance from the origin (proves the transform is rigid — no scale or skew crept
      into the hand-indexed arithmetic)
- [ ] `bearingDeg: 0` and `bearingDeg: 90` produce different, non-degenerate rotations, and a
      point due north of the tap maps consistently with the 0°=north/90°=east convention the
      code claims
- [ ] The returned array has length 16 and its last row/column is `[…, 1]` as a well-formed
      affine matrix
- [ ] `buildAnchorMarker(45)` has a north-tick child; `buildAnchorMarker(null)` does not, and
      its ring/crosshair use the dimmed opacities
- [ ] `buildAnchorMarker(90).rotation.y ≈ Math.PI / 2`

On-device (Android/WebXR, Checklist B addition — not automatable):

- [ ] Open `/webxr.html`, start AR, and complete calibration: the anchor decal appears on the
      ground at the tapped point
- [ ] The decal stays world-locked — walk around it and it remains on the same physical spot
      rather than drifting with the camera
- [ ] The decal does not blank or flicker the camera passthrough (checks
      `renderer.autoClear = false` and the `frame === undefined` skip)
- [ ] The north tick points at true north (cross-check against a phone compass app)
- [ ] Scanning proceeds normally after calibration — point count grows, capture works (checks
      the `setAnimationLoop` swap did not disturb the existing frame loop's other work)
- [ ] Stop and restart the AR session in one page load; the second session still tracks and
      renders (checks the renderer disposal ordering in `stop()`)
- [ ] Record which runtime/device/browser versions were used

```bash
deno test --allow-read --allow-env anchor_calibration.test.ts
deno task test
npm run qr -- "webxr.html"    # get the URL onto the device
```

## Acceptance Criteria

- [ ] Given any `(tapPos, bearing)`, When `anchorToProjectTransform()` runs, Then the tapped
      point maps to project-space origin — the invariant its own doc comment claims
- [ ] Given a transposed or mis-indexed change to that function's arithmetic, When the suite
      runs, Then at least one test fails (the coverage is load-bearing, not decorative)
- [ ] Given `buildAnchorMarker(null)`, Then no north tick is produced and the dimmed
      no-compass state renders
- [ ] Given a real Android WebXR device, Then the on-device checklist passes and its result is
      recorded here, satisfying the verification `src/ar/webxr.ts`'s header asks for

## Risks / potential issues

- **Risk:** The origin-maps-to-zero invariant is necessary but not sufficient — a matrix with
  a wrong *rotation* still satisfies it (the translation is derived from the rotation, so both
  move together). A bearing bug could survive this test. — **Mitigation:** the rigidity test
  and the explicit north/east convention test target the rotation specifically; the on-device
  compass cross-check is the final backstop, since only a real magnetometer can confirm the
  rendered tick points at actual north.
- **Risk:** Characterising `'ground-tap-compass'`'s `bearingDeg ?? 0` behavior could read as
  endorsing it, when ticket 0002 documents it as the degraded tier and 0004 supersedes it for
  the default path. — **Mitigation:** the null-bearing test must assert the *actual* behavior
  (identity rotation, frame left at the session's arbitrary yaw) with a comment naming it as
  the known limitation that motivates two-point calibration — a characterisation test, not an
  approval.
- **Risk:** Three.js may not import cleanly under Deno's test runner, blocking the
  `buildAnchorMarker()` half. — **Mitigation:** the fallback in Open questions (test extracted
  pure math instead of the Three.js objects); the `anchorToProjectTransform()` half has no
  such dependency and is the more important of the two.
- **Risk:** The on-device box may sit unchecked indefinitely if no Android device is
  available, leaving the wave's riskiest change permanently unverified while looking
  "covered" because the automated tests are green. — **Mitigation:** the box is explicitly
  part of Definition of Done and the automated tests do not touch the WebXR renderer at all;
  this ticket must not be marked done on `deno task test` alone.
- **Risk:** Characterisation tests written against current behavior will lock in a bug if one
  exists. — **Mitigation:** every assertion is written against a *stated contract* (the doc
  comments' own claims), not against observed output — so a test that fails on first run means
  the implementation contradicts its documentation, which is a finding, not a test to adjust.

## Subtasks

1. [ ] Create `anchor_calibration.test.ts` with the `anchorToProjectTransform()` cases
2. [ ] Add the `buildAnchorMarker()` cases; if Three.js will not import under Deno, apply the
       Open-questions fallback and record it there
3. [ ] Append the filename to `deno.json`'s `"test"` task string
4. [ ] Run `deno task test`; if any assertion fails, stop and record it as a finding rather
       than adjusting the assertion to match
5. [ ] Extend `docs/DEVICE_TESTING.md` Checklist B and its results matrix with the
       anchor-decal rows
6. [ ] Run the on-device checklist on an ARCore Android device; record versions and results
       in this ticket's Open questions & answers
