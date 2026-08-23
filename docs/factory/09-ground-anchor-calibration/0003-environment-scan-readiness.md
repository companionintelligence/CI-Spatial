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
"Aim at a textured floor and tap again" (`src/ar/project-calibration.ts:52, 102`), but the
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
- `src/ar/project-calibration.ts:63-75` (`update()`, the current tracking-only gate) and
  `89-134` (`placeAt()`, where the floor gate goes).
- `src/main.ts:939-946` — the call site; `pointCloud` is already in scope
  (`src/main.ts:202`).
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
  stalled tracking (`src/ar/project-calibration.ts:65-69`). Proceeding this way skips the
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
  below. **Ticket 0006 measures the actual vertical spread of floor hit-tests** and sets this;
  the gap between 0.25 and a chair seat at 0.45 is not large, so a worse-than-assumed noise
  figure narrows the usable window quickly. (Decided in this ticket; value pending 0006.)
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

## Files impacted

New:
- `pointcloud.test.ts` (repo root)

Changed:
- `src/scene/pointcloud.ts`
- `src/ar/project-calibration.ts` (readiness step + tap gate + new `CalibrationOptions` member)
- `src/main.ts` (pass the ground accessor)
- `index.html` (readiness-step copy; reuse existing card styles)
- `deno.json` (register the new test file)

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

New `CalibrationOptions` member (`src/ar/project-calibration.ts:13-26`), matching the existing
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

- [ ] `PointCloud.groundEstimate()` implemented per the signature above
- [ ] Recompute throttled inside `add()`, only when points were inserted
- [ ] `estimateFloorY()`, `boundingBox()`, `add()`'s return, `clear()`, `count`,
      `decimations` all unchanged
- [ ] `CalibrationOptions.ground` added and passed from `src/main.ts`
- [ ] A readiness step gates **all** marker placement on tracking **and** a locked ground
      estimate, showing live progress and ground-facing guidance — the landmark cannot be
      placed against an unestablished plane
- [ ] `GROUND_WAIT_TIMEOUT_MS` offers "continue anyway" via the existing `-promoted` treatment
- [ ] `placeAt()` applies the two-step floor gate, skipped entirely when `ground()` is `null`
      (including after a "continue anyway")
- [ ] Status copy distinguishes: waiting for floor, floor unknown/overridden, tap rejected as
      off-floor, tap accepted
- [ ] `pointcloud.test.ts` created **and appended to `deno.json`'s `"test"` task string**
- [ ] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

- [ ] Empty cloud → `groundEstimate()` returns `null`
- [ ] Below `MIN_POINTS_FOR_GROUND_ESTIMATE` → `null`
- [ ] A floor-height cluster plus high-Y outliers (walls, furniture) → estimate converges near
      the cluster, not dragged upward
- [ ] `GROUND_HISTORY_SIZE` consecutive stable batches → `locked === true`
- [ ] After locking, a batch beyond `GROUND_UNLOCK_TOLERANCE_M` → `locked === false` and the
      estimate moves toward the new level
- [ ] Two `add()` calls inside `GROUND_RECOMPUTE_INTERVAL_MS` recompute once (injected clock
      or `sampleCount`; state which in the PR)
- [ ] `estimateFloorY()`/`boundingBox()` unchanged for a fixed input set (regression guard)
- [ ] Gate as a pure function: within tolerance → accept; beyond → reject first, accept on
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

1. [ ] Add constants and private state to `src/scene/pointcloud.ts`
2. [ ] Implement `groundEstimate()` and the throttled recompute in `add()`
3. [ ] Write `pointcloud.test.ts`; append it to `deno.json`'s `"test"` task string
4. [ ] Add `ground` to `CalibrationOptions`; pass it from `src/main.ts`
5. [ ] Add the readiness step to the calibration overlay with live progress, ground-facing
       guidance, and the timeout escape hatch
6. [ ] Implement the two-step floor gate in `placeAt()` as a testable pure function plus a
       thin call site
7. [ ] Write the gate's unit tests
8. [ ] `npx tsc --noEmit`, `deno task check`, `deno task test`
9. [ ] On-device: time how long lock takes in a normal room; verify a floor tap passes first
       try and a tabletop tap is caught; retune constants if not
