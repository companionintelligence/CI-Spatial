> **Type:** Frontend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `feat/environment-scan-readiness`
> **Commit style:** `feat(ar): summary`
> **Design:** this ticket is the spec. The explicit scan-before-align step follows the
> two-point calibration pattern used by BIM/AR field tools (see Open questions).
> **Dependencies:** None. Ticket 0004 consumes the readiness signal and the gate.

## Goal

Track the room's ground plane continuously for the life of a scan session and establish it as
an explicit **scan the environment** step that must complete before any marker is placed. The
resulting plane is a session artifact with two jobs: rejecting taps that did not land on the
floor, and giving ticket 0004 a surface to project both markers onto. #141 ships a flow that
begins accepting taps the instant `isTracking()` is true and accepts *any* surface the
hit-test returns.

## The gap

**No floor validation.** `runProjectCalibration()`'s copy says "Tap a spot on the ground" and
"Aim at a textured floor and tap again" (`src/ar/project-calibration.ts`'s overlay copy and its no-surface retry message), but the
only rejection in the tap path is `if (!hit)`:

```ts
const hit = await options.hitTest(x, y).catch(() => null)
if (!hit) { /* retry copy */ return }
```

A tabletop tap yields a project origin ~0.75 m above the floor. Every scan aligned through
that frame inherits the offset, and — after ticket 0001 — is honestly reported as
`'provisional'`, because nothing knows it is wrong.

**No persistent ground concept.** `PointCloud.estimateFloorY()`
(`src/scene/pointcloud.ts:68-74`) computes an 8th-percentile Y on demand and is called
exactly once, at export time (`src/export/gltf.ts:139`). It has no notion of confidence,
stability, or whether enough floor has been seen to trust it.

**No readiness step.** #141 gates only on `provider.isTracking()`. Tracking being alive is not
the same as the floor being mapped — the tap can be taken in the first second of a session,
which is exactly when the point cloud is emptiest. The cited reference makes environment
scanning its own step between picking points and aligning them, with explicit guidance to
point the device at the ground; this ticket adopts that.

## Non-goals

- Do not change `estimateFloorY()`'s signature or behavior — `src/export/gltf.ts:139` depends
  on it as a stateless snapshot. Add alongside it.
- Do not add active downward probing (the fixed screen-space probe grid
  `ar-ground-anchor.html` prototyped). `PointCloud` already receives the points the scanner
  harvests every tick; this adds a stability signal over that stream, not a second sampler.
- Do not use AR-runtime plane detection APIs. Neither provider exposes planes today
  (`src/ar/provider.ts` offers `hitTest`/`featurePoints` only), and adding plane detection to
  both is a much larger change — the point cloud already carries the needed information.
- Do not persist the estimate across sessions — transient session state, like the rest of
  `PointCloud`.
- Do not hard-block calibration forever when the ground never resolves. See Open questions.
- Do not render the ground plane itself. The point decals (#141's `buildAnchorMarker`) already
  show where taps land.

## Pinned conventions

**ADR 0005** — `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md`
governs this wave: a frame's orientation comes from tracked geometry, the compass is metadata
for absolute orientation only, and a `'verified'` status must be backed by a measurement.

**ADR 0001** — searched for an existing floor/readiness concept: `PointCloud.estimateFloorY()`
is the only floor logic and has no stability notion; `src/capture/quality-monitor.ts` scores
coverage/drift/light but not floor confidence and is not consulted by calibration. No new
type — new methods and constants on the existing `PointCloud`, and a new option on the
existing `CalibrationOptions`.

**Reuse `estimateFloorY()`** internally for each candidate rather than re-deriving percentile
logic.

**Reuse `quality-monitor.ts`'s vocabulary** for user-facing readiness copy where it already
has an equivalent phrase ("Sweep the room more slowly…"), so calibration and the scan HUD do
not develop two dialects for the same guidance.

**Class conventions** (`src/scene/pointcloud.ts`): `camelCase` methods, `_leadingUnderscore`
privates, JSDoc on public methods, module-scope `SCREAMING_SNAKE` constants.

**Overlay chrome**: reuse `.project-calibration-card` / `.project-calibration-status` and the
`.project-calibration-link-promoted` state (`index.html`, as #142 left them) — #141 already
uses `-promoted` for the stalled-tracking escape hatch, which is the same pattern this
ticket's "continue anyway" needs.

**Testing**: `deno.json`'s `"test"` task is a hand-maintained filename list (21 files as of
#140) and does **not** glob — an unregistered test file silently never runs. Convention is
root-level flat `*.test.ts` importing from `./src/...`.

## Before implementation

- `src/scene/pointcloud.ts` (full file) — `estimateFloorY()` (68-74), `add()` (36-51),
  constructor/privates (12-21).
- `src/ar/project-calibration.ts`'s `update()` (`update()`, the current tracking-only gate) and
  `89-134` (`placeAt()`, where the floor gate goes).
- `src/main.ts`'s `runProjectCalibration()` call site — the call site; `pointCloud` is already in scope
  (`src/main.ts`'s `new PointCloud(...)`).
- `src/capture/quality-monitor.ts` — existing readiness/quality vocabulary.
- `src/export/gltf.ts:138-139` — the `estimateFloorY()` caller that must not change.

## Open questions & answers

- Q: What was adopted from the cited reference? — A: That environment scanning is a *distinct,
  visible step* with its own completion criterion, and its guidance to move slowly and point
  the device toward the ground. Not adopted: its reliance on runtime plane detection — this
  app derives the floor from the point cloud it already accumulates. (Decided in this ticket.)
- Q: Recompute on every `add()`, or throttle? — A: Throttle inside `add()` via
  `performance.now()`, no new timer. `estimateFloorY()` is O(n log n) over up to
  `MAX_POINTS = 250_000`, and `add()` runs every scanner tick (`DEFAULT_INTERVAL_MS = 750`,
  `src/ar/scanner.ts:31`). Recompute at most every `GROUND_RECOMPUTE_INTERVAL_MS = 500`,
  skipped when no points were inserted. (Decided in this ticket.)
- Q: Does the readiness step block indefinitely if the floor never resolves? — A: No. After
  `GROUND_WAIT_TIMEOUT_MS = 20_000` without a locked estimate, offer "continue anyway" via
  the existing `-promoted` link treatment — the same escape hatch #141 already added for
  stalled tracking (`update()`'s stalled-tracking branch). Proceeding this way skips the
  floor gate entirely and records nothing different in the frame; it is a UX affordance, not
  a data state. A feature-poor room must remain scannable. (Decided in this ticket.)
- Q: Reject or warn when a tap misses the floor? — A: Reject with copy naming the discrepancy
  on the first attempt; accept an immediate repeat tap at a similar height, with copy saying
  it is being used anyway. A hard reject traps users whose floor estimate is itself wrong
  (thick carpet, mezzanine, sunken room); a pure warning gets ignored. Two-step keeps the
  default safe and the override explicit. (Decided in this ticket.)
- Q: Gate tolerance? — A: `GROUND_TAP_TOLERANCE_M = 0.25` as a **placeholder pending
  measurement** — chosen to pass a real floor tap including carpet and hit-test noise while
  rejecting a tabletop (~0.75 m) or chair seat (~0.45 m). Distinct from the lock tolerances
  below. This ticket expected **ticket 0006 to measure the actual vertical spread of floor
  hit-tests** and set it — see the correction below, which records that this never happened;
  the gap between 0.25 and a chair seat at 0.45 is not large, so a worse-than-assumed noise
  figure narrows the usable window quickly. (Decided in this ticket. The value is no longer
  pending: 0006 closed unrun on 2026-08-25 and 0.25 stands as an adopted default.)
- Q: Lock/unlock thresholds? — A: Lock once `GROUND_HISTORY_SIZE = 6` consecutive candidates
  agree within `GROUND_LOCK_TOLERANCE_M = 0.03`; unlock immediately if a candidate deviates
  by more than `GROUND_UNLOCK_TOLERANCE_M = 0.15` (a real level change — a step, a mezzanine —
  not noise). `MIN_POINTS_FOR_GROUND_ESTIMATE = 50` before any estimate is offered. (Decided
  in this ticket; all tunable.)
- Q: Does the readiness step delay every calibration, including the common good-conditions
  case? — A: Only until lock, which in a normally-lit textured room should be a few seconds of
  the sweep the user must do anyway. The step shows live progress so the wait is legible
  rather than a spinner. If on-device timing shows lock routinely taking longer than the
  tracking wait already does, `GROUND_HISTORY_SIZE`/`MIN_POINTS_FOR_GROUND_ESTIMATE` are the
  knobs. (Decided in this ticket; measure before tuning.)

- Q: **(found during implementation, and it invalidated the ticket's premise) Does the point
  cloud have any data when the readiness gate runs?** — A: **No — none at all, so the gate as
  specified was inert.** This ticket's Risks section guessed the cloud would be "emptiest"
  during calibration. It is in fact *empty*: `src/main.ts`'s `scanner.start()` callback inside `scanner.start()`'s
  callback is the only caller of `pointCloud.add()` in the app, and `scanner.start()` ran at
  line 1054 — *after* `runProjectCalibration()` at 947. So `groundEstimate()` returned `null`
  for the whole of every calibration: the readiness step would have waited the full
  `GROUND_WAIT_TIMEOUT_MS` and offered the override every single time, and the tap gate would
  have passed everything (`groundY === null` → no opinion). A green test suite would have
  hidden this completely, because every unit test feeds `PointCloud` directly.
  **Fix: `scanner.start()` now runs before calibration**, so the environment-scan step is
  backed by the scanner actually scanning. Verified safe — the callback's dependencies are
  either declared earlier (`qualityMonitor`, `rtc`, which is optional-chained anyway) or
  hoisted `function` declarations (`updateVerdictUI`, `updateQualityOverlay`). The points it
  collects during the sweep are real room geometry in the same AR session frame, so they
  belong in the scan regardless. Note this is adjacent to ticket 0004's non-goal about not
  moving calibration in the boot sequence — calibration has *not* moved; the scanner start
  moved earlier, ahead of it. (Discovered and fixed 2026-08-23.)
- Q: Where does the floor-gate predicate live? — A: `src/ar/ground-gate.ts`, not a private
  helper in `project-calibration.ts`. That file references `TouchEvent`, `PointerEvent` and
  `HTMLCanvasElement`, so importing it into a Deno test drags in DOM lib types and fails
  type-checking — the same ADR 0002 hazard ticket 0006 hit with `Pose`. A pure module keeps
  the threshold testable, which matters most for the constant most likely to be retuned.
  (Decided 2026-08-23.)
- Q: How does the "continue anyway" escape hatch appear? — A: As a **separate** promoted
  action ("Place anchor without floor check"), not by retargeting the existing "Continue
  uncalibrated" link. Overloading one control would mean a user who wants to abandon
  calibration entirely silently gets a different outcome. Both use the existing
  `.project-calibration-link` / `-promoted` styles, so no new visual language and no
  `index.html` change was needed. (Decided 2026-08-23.)
- Q: What value does the estimate settle on when it locks? — A: The mean of the
  `GROUND_HISTORY_SIZE` window that earned the lock, rather than whichever candidate arrived
  last — the consensus, not one arbitrary member of it. While unlocked it tracks the latest
  candidate; once locked it is held steady until a candidate exceeds
  `GROUND_UNLOCK_TOLERANCE_M`, at which point it is abandoned outright rather than drifted
  toward, since half-following a step would describe neither floor. (Decided 2026-08-23.)

**`GROUND_TAP_TOLERANCE_M = 0.25` is measurable now, and the measurement is written down.**
Logged after #145/#147 merged, while scheduling ticket 0006's benchmark.

**Correction, logged 2026-08-25 when 0006 was closed:** 0006 was closed *without* its
benchmark ever being run, so `GROUND_TAP_TOLERANCE_M = 0.25` is now an **adopted default, not
a pending placeholder** — nothing is scheduled to measure it. The constant's own definition in
`src/ar/ground-gate.ts` records the revisit trigger. Note the definition also flags that the
likelier cause of a mis-rejected floor tap is `estimateFloorY()` (an 8th-percentile, observed
~2 m out) rather than this tolerance; the floor overlay added in #166 makes that checkable.
The original scheduling note follows, kept as the record of what was believed at the time.

This ticket shipped the constant as an explicit placeholder pending 0006, and 0006's
Procedure 2 turned out not to be runnable until 0004 exists (see that ticket's Open
questions). The floor gate, though, characterises itself on the current build: the
rejection message this ticket added already reports the measured height in centimetres, so
tapping surfaces of known height reads the ground estimate's accuracy straight off the
screen.

Added to `docs/DEVICE_TESTING.md` as steps 3–5 of **Procedure 2a**: tap a table (~0.75 m),
tap a chair seat (~0.45 m), tap the floor. Two things to watch, both of which would change
this constant:

- The chair seat is the tight end. `GROUND_TAP_TOLERANCE_M`'s own comment claims it
  "comfortably rejects" a ~0.45 m seat, which is a 20 cm margin **only if the ground
  estimate is exact**. If a seat reports 30 cm the real margin is 5 cm, and the value needs
  to come down — or the estimate needs to improve before it can.
- A correct floor tap must never be rejected. One false rejection across five runs is a
  finding, not noise: this gate sits on the path to every scan, and a false rejection there
  is the exact failure mode ADR 0005 rule 5 warns about, one level down.

## Files impacted

New:
- `src/ar/ground-gate.ts` (the pure floor-gate predicate + its tolerance — see Open questions)
- `pointcloud.test.ts` (repo root)

Changed:
- `src/scene/pointcloud.ts`
- `src/ar/project-calibration.ts` (readiness step + tap gate + new `CalibrationOptions` member)
- `src/main.ts` (pass the ground accessor; **move `scanner.start()` ahead of calibration** —
  see Open questions)
- `deno.json` (register the new test file)

Not changed after all:
- `index.html` — the readiness copy lives in the overlay's own markup, and the escape hatch
  reuses the existing `.project-calibration-link-promoted` style, so no CSS was needed.

## Schema required

None persisted. New in-memory API on `PointCloud`:

```ts
groundEstimate(): { y: number; locked: boolean; sampleCount: number } | null
```
`null` when `count === 0` or below `MIN_POINTS_FOR_GROUND_ESTIMATE`. `y` is metres in the AR
session's local frame (same space as `estimateFloorY()`). `locked` is the stability signal the
readiness step gates on.

New private state: `_groundHistory: number[]`, `_groundLocked: boolean`,
`_lastGroundY: number | null`, `_lastGroundSampleAt: number`.

New `CalibrationOptions` member (the `CalibrationOptions` interface in `src/ar/project-calibration.ts`), matching the existing
`bearing: () => number | null` getter style so it is sampled fresh rather than captured when
the modal opened:

```ts
/** Live ground-plane estimate in session-local metres, plus whether it has stabilised. */
ground: () => { y: number; locked: boolean } | null
```

Ticket 0004 projects both markers onto this plane. That projection is a one-line
`{ x: hit.x, y: groundY, z: hit.z }` at the call site rather than a method here — `PointCloud`
should not grow knowledge of calibration markers, and a `projectOntoGround()` helper that only
substitutes one component would obscure more than it abstracts. Stated explicitly so 0004 does
not go looking for an API that deliberately does not exist.

## Definition of Done

- [x] `PointCloud.groundEstimate()` implemented per the signature above
- [x] Recompute throttled inside `add()`, only when points were inserted
- [x] `estimateFloorY()`, `boundingBox()`, `add()`'s return, `count`,
      `decimations` all unchanged
- [x] `CalibrationOptions.ground` added and passed from `src/main.ts`
- [x] A readiness step gates **all** marker placement on tracking **and** a locked ground
      estimate, showing live progress and ground-facing guidance — the landmark cannot be
      placed against an unestablished plane
- [x] `GROUND_WAIT_TIMEOUT_MS` offers "continue anyway" via the existing `-promoted` treatment
- [x] `placeAt()` applies the two-step floor gate, skipped entirely when `ground()` is `null`
      (including after a "continue anyway")
- [x] Status copy distinguishes: waiting for floor, floor unknown/overridden, tap rejected as
      off-floor, tap accepted
- [x] `pointcloud.test.ts` created **and appended to `deno.json`'s `"test"` task string**
- [x] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

- [x] Empty cloud → `groundEstimate()` returns `null`
- [x] Below `MIN_POINTS_FOR_GROUND_ESTIMATE` → `null`
- [x] A floor-height cluster plus high-Y outliers (walls, furniture) → estimate converges near
      the cluster, not dragged upward
- [x] `GROUND_HISTORY_SIZE` consecutive stable batches → `locked === true`
- [x] After locking, a batch beyond `GROUND_UNLOCK_TOLERANCE_M` → `locked === false` and the
      estimate moves toward the new level
- [x] Two `add()` calls inside `GROUND_RECOMPUTE_INTERVAL_MS` recompute once (injected clock
      or `sampleCount`; state which in the PR)
- [x] `estimateFloorY()`/`boundingBox()` unchanged for a fixed input set (regression guard)
- [x] Gate as a pure function: within tolerance → accept; beyond → reject first, accept on
      immediate retry; `null` ground → accept

```bash
deno test --allow-read pointcloud.test.ts
npx tsc --noEmit && deno task check && deno task test
```

## Acceptance Criteria

- [ ] Given a fresh session, When calibration opens, Then point placement is unavailable until
      tracking is stable *and* the ground estimate has locked, with visible progress
- [ ] Given a floor that never resolves, When `GROUND_WAIT_TIMEOUT_MS` elapses, Then
      "continue anyway" is offered and proceeds with the gate disabled
- [ ] Given a locked estimate, When the user taps a tabletop (~0.75 m above it), Then the
      first tap is rejected with copy naming the height discrepancy
- [ ] Given that rejection, When the user immediately taps the same spot again, Then it is
      accepted
- [ ] Given a real floor tap in a normally-scanned room, Then it is accepted first time — no
      added friction in the common case
- [ ] Given `src/export/gltf.ts`'s `estimateFloorY()` call, Then its result is unchanged

## Risks / potential issues

- **Risk (highest):** the readiness gate is placed *before* scanning begins, so the point
  cloud it depends on is at its emptiest exactly when the gate runs. If lock routinely takes
  too long there, the gate becomes a wait users learn to skip, and the floor validation it
  exists to enable rarely applies. — **Mitigation:** the ground-facing guidance is what makes
  lock fast (floor points are what the estimate needs, and pointing down harvests them); the
  timeout escape hatch bounds the worst case; and on-device timing is a Definition-of-Done
  input rather than an assumption. If it proves bad, the structural fix is to allow
  calibration to be deferred until after some scanning, not to loosen the gate.
- **Risk:** `GROUND_TAP_TOLERANCE_M` is guessed. Too tight rejects real floor taps on thick
  carpet or a sloped floor; too loose passes a chair seat. — **Mitigation:** single named
  constant; the two-step override means a wrong value never hard-blocks; on-device tuning
  expected before close, as `04-capture-path-truthfulness/0002` did for `HIT_GRID_N`.
- **Risk:** The 8th-percentile estimate degrades in multi-level spaces where "the floor" is
  not one Y. — **Mitigation:** unlock handles a *change* in level; simultaneous multi-level
  rooms are out of scope and fall back to the override.
- **Risk:** Extra per-`add()` work every scanner tick for the session's life. —
  **Mitigation:** throttle plus early bail; the same sort is already acceptable at export time
  on the same point counts.

## Subtasks

1. [x] Add constants and private state to `src/scene/pointcloud.ts`
2. [x] Implement `groundEstimate()` and the throttled recompute in `add()`
3. [x] Write `pointcloud.test.ts`; append it to `deno.json`'s `"test"` task string
4. [x] Add `ground` to `CalibrationOptions`; pass it from `src/main.ts`
5. [x] Add the readiness step to the calibration overlay with live progress, ground-facing
       guidance, and the timeout escape hatch
6. [x] Implement the two-step floor gate in `placeAt()` as a testable pure function plus a
       thin call site
7. [x] Write the gate's unit tests
8. [x] `npx tsc --noEmit`, `deno task check`, `deno task test`
9. [ ] On-device: time how long lock takes in a normal room; verify a floor tap passes first
       try and a tabletop tap is caught; retune constants if not
