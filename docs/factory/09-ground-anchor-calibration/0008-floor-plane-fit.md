> **Type:** Frontend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `fix/floor-plane-fit`
> **Commit style:** `fix(scene): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003 (which introduced `groundEstimate()` and the lock machinery this
> keeps intact) — **landed**. Unblocked.

## Goal

Replace `estimateFloorY()`'s 8th-percentile heuristic with a **supported fit**: find the
horizontal layer of points the room's floor actually generates, instead of taking a fixed
position in the sorted Y ordering. The percentile has been observed ~0.9 m out on a real
capture, and everything the floor gate does downstream inherits that error.

## Why the percentile fails, precisely

`estimateFloorY()` sorts every Y and returns the value at index `0.08 × n`
(`src/scene/pointcloud.ts:171-177`). That is a **position in the ordering**, not a property
of the room. It is only correct while the floor supplies at least ~8 % of all points.

It breaks whenever it does not. A user sweeping a room at eye level — which is what the
capture flow actually encourages, since the scanner wants wall and furniture features —
leaves the floor under-sampled. Once floor points fall below 8 % of the cloud, index
`0.08 × n` lands *above* the floor cluster entirely, and the estimate jumps to whatever
surface is there. The observed capture returned **+0.84 m while the lowest detected object
sat at −0.05 m**.

The failure is silent and self-consistent: the estimate is stable, so 0003's lock machinery
locks it, and `groundEstimate().locked` reports a confidently wrong floor.

**What it costs today.** PR #166 removed the frame's dependence on it — the landmark's own
measured tap defines project-space `y = 0` — so a bad estimate no longer displaces a whole
scan. What remains:

- `isTapOnGround()` (`src/ar/ground-gate.ts:46`) judges every calibration tap against it, so
  an over-high estimate rejects genuine floor taps as "cm above the floor". That symptom is
  already documented at `GROUND_TAP_TOLERANCE_M`'s definition, which names this estimator as
  the more likely cause and tells the reader to check the floor overlay before widening the
  tolerance. Widening a tolerance to compensate for a broken estimator is the outcome this
  ticket prevents.
- `src/export/gltf.ts:139` uses it for exported floor height.
- 0003's readiness gate waits on `locked`, so a wrong estimate is what the user is made to
  wait *for*.

## The fit this needs, and why it is not a general plane fit

The handoff note calls for "a RANSAC plane fit". Read literally that is the wrong tool here,
and the reason belongs in the ticket rather than being decided silently in a diff.

**The session frame is gravity-aligned.** Both providers give a Y-up pose, and this codebase
already depends on it everywhere — `composeYUpTransform`, `twoPointToProjectTransform`'s
`atan2(x, z)` yaw, and `estimateFloorY()` itself, which returns a **scalar**. A floor in such
a frame is a plane of constant `y`. Fitting a general 3-DOF plane would add two free
parameters the geometry does not have, and the cost is concrete: an unconstrained fit can
satisfy itself on a **wall**, which is the largest planar surface in most rooms and is
exactly what must never be returned.

So: fit the one parameter that is free. Choose a `y` by **how many points actually support
it** rather than by a fixed quantile. That is the same robust-estimation idea as RANSAC
(count inliers, ignore outliers) reduced to the one degree of freedom the problem actually
has, and it is `O(n)` with a histogram where the current sort is `O(n log n)`.

Which supported band, though, is the next question — and "the best-supported" is the wrong
answer. See below.

Preferring density alone is not enough: a well-sampled tabletop can out-vote a sparsely-seen
floor. So among bands with **substantial** support, take the **lowest**. "Lowest well-supported
horizontal layer" is a description of a floor; "8th percentile" is not.

**Tilt is out of scope but must not stay invisible.** If SLAM's gravity estimate is off, the
floor is not level in the session frame — a 3° error across a 4 m room is ~20 cm of height
variation, well past `GROUND_LOCK_TOLERANCE_M` (0.03). A band fit cannot correct that, and
this ticket does not try. It must **report** it: the residual spread of the chosen band's
inliers is the signal, and surfacing it turns a silently-degraded estimate into a visible
one. Acting on it is a follow-on ticket, and should be written only if the number says so.

## Non-goals

- Do not fit a general/tilted plane, or change `groundEstimate()` to return a normal. The
  scalar contract is what every consumer wants; see above.
- Do not change `GROUND_TAP_TOLERANCE_M`, `GROUND_LOCK_TOLERANCE_M`,
  `GROUND_UNLOCK_TOLERANCE_M`, `GROUND_HISTORY_SIZE`, `GROUND_RECOMPUTE_INTERVAL_MS` or
  `MIN_POINTS_FOR_GROUND_ESTIMATE`. They are 0003's, they are adopted-not-measured, and
  retuning them is 0006's job — not something to do while their input changes underneath.
- Do not change the lock/unlock state machine in `_maybeRecomputeGround()`. This ticket
  replaces the **candidate producer** only. Changing both at once would make a regression
  impossible to attribute.
- Do not change `boundingBox()`, `add()`, the voxel dedupe, or `_decimate()`.
- Do not touch `isTapOnGround()`'s signature or `src/export/gltf.ts`'s call. A better
  estimate must be a drop-in.
- Do not add a dependency. This is ~40 lines of arithmetic.

## Pinned conventions

**ADR 0001** — `GroundEstimate` (`src/scene/pointcloud.ts:34-42`) is extended with optional
diagnostic fields, **not** replaced and not paralleled by a second type. Searched before
concluding nothing exists to reuse: `groundEstimate()` is the only floor-height producer in
the codebase (`grep -rn "estimateFloorY\|groundEstimate"`), and `src/export/gltf.ts:139` is
its only consumer outside the calibration path. New fields are optional so no consumer needs
updating.

**ADR 0002** — `pointcloud.ts` must stay DOM- and Deno-API-free. It is imported by
`tests/unit/deno/pointcloud.test.ts`, which runs under `deno task test` in CI; a DOM type
here breaks that. This is why `ground-gate.ts` exists as a separate module, and the same
constraint applies to anything added here.

**Constant naming and documentation.** Every threshold this adds follows the block at
`src/scene/pointcloud.ts:11-33`: a named `const`, a doc comment stating what it does, and —
per ADR 0005 rule 5 and the precedent set across this wave — an explicit
**"Adopted by decision, not by measurement"** note plus a **"Revisit when:"** trigger. Do not
ship a number here that reads as measured.

## Before implementation

- `src/scene/pointcloud.ts:9-42` — the constants block and `GroundEstimate`.
- `src/scene/pointcloud.ts:130-177` — `_maybeRecomputeGround()` and `estimateFloorY()`.
  Note the candidate producer and the lock machine are already cleanly separated; keep them so.
- `src/ar/ground-gate.ts:31` — `GROUND_TAP_TOLERANCE_M`'s "Revisit when" names this
  estimator as the likelier cause. That sentence changes when this lands.
- `tests/unit/deno/pointcloud.test.ts:20-30` — `floorPoints()`, the fixture helper, and
  `fakeClock()`. Note the comment explaining why a fixed lattice collides with the 5 cm
  voxel dedupe.
- `tests/unit/deno/pointcloud.test.ts:51-63` — the existing "converges on the floor cluster,
  not the furniture above it" test. It passes **today**, because its floor is 62 % of the
  cloud. It must keep passing, and it is not sufficient.
- `src/export/gltf.ts:139` — the other consumer.

## Open questions & answers

- Q: Band width? — A: Start at the voxel size (0.05 m), because the cloud is already
  deduplicated at that resolution — a narrower band cannot resolve detail the data does not
  contain, and a wider one blurs a floor into a low step. Name it as its own constant rather
  than reading `_voxelSize`, so a voxel-size change does not silently retune the estimator.
  (Decided in this ticket.)
- Q: How much support is "substantial", for picking the lowest qualifying band? — A: A
  fraction of the **whole cloud**, not an absolute — absolute counts do not survive
  `_decimate()` halving the cloud. Start at 0.04.
  **Corrected during implementation.** This ticket originally said "a fraction of the best
  band's count, start at 0.5", and that is exactly backwards: the failure being repaired is an
  *under-sampled floor*, so measuring the floor against the best-sampled surface in the room is
  the comparison that discards it. In the regression fixture the eye-level walls hold ~180
  points per band and the floor ~30 — at 0.5 of the best band the floor would not have
  qualified, and the fix would have failed on the case it exists for. Sized against uniform
  scatter instead (~1.7 % per band over a 3 m range at 5 cm), which is what "no structure"
  actually looks like.
- Q: How reliable is that structure-vs-scatter test? — A: **Only above ~1000 points, and this
  was measured rather than assumed.** It is a statistical test, and a sparse structureless
  cloud throws up a chance band above the share: at 400 points, 2 of 3 seeds produced a false
  positive; at 1000+ it was stable across every seed tried. `MIN_POINTS_FOR_GROUND_ESTIMATE` is
  50, far below that, so `fallback: false` on a sparse cloud does not mean a floor was really
  found. `inlierCount` and `residualM` are the confidence signal there, and a test pins the
  difference. Recorded on the constant. (Found during implementation.)
- Q: What if no band qualifies — a cloud with no floor in it at all? — A: Fall back to
  today's percentile and say so in a diagnostic field. A sparse or floor-less cloud is
  exactly the case 0003's `MIN_POINTS_FOR_GROUND_ESTIMATE` and the `locked` flag already
  exist to communicate; inventing a new failure mode here would bypass them. The gate treats
  `groundY === null` as "no opinion" and must keep being able to reach that state.
  (Decided in this ticket.)
- Q: Should the returned `y` be the band centre or the mean of its inliers? — A: **The mean
  of the inliers.** The band is a search grid, not the answer; returning a grid centre
  quantises every estimate to 5 cm and would show up as a floor of the same size on
  `residualM`. (Decided in this ticket.)
- Q: Does the lock machinery need retuning once candidates get less noisy? — A: **Do not
  pre-empt it.** A less noisy candidate stream locks *sooner*, which is an improvement, and
  `GROUND_LOCK_TOLERANCE_M` is 0003's constant with 0006's measurement still owed on it.
  Record what the tests show about time-to-lock and leave the constant alone. (Decided in
  this ticket.)
- Q: Is the gravity-alignment assumption safe to depend on? — A: It is already depended on —
  a scalar `estimateFloorY()` is meaningless without it — so this ticket does not introduce
  the risk, only names it and adds the spread readout that would expose it. (Decided in this
  ticket.)

## Files impacted

New:
- none

Changed:
- `src/scene/pointcloud.ts` — the new estimator, its constants, the extra `GroundEstimate` fields
- `src/ar/ground-gate.ts` — `GROUND_TAP_TOLERANCE_M`'s "Revisit when" paragraph, which
  currently tells the reader the estimator is probably at fault
- `tests/unit/deno/pointcloud.test.ts` — the regression case and the new coverage
- `docs/factory/09-ground-anchor-calibration/README.md`, `HANDOFF.md`,
  `docs/factory/atlas.html` — ticket table, order of work, and the atlas entry

## Schema required

Extends `GroundEstimate` (`src/scene/pointcloud.ts:34`) with optional diagnostics. Optional,
so every existing consumer compiles unchanged:

```ts
export interface GroundEstimate {
  y: number
  locked: boolean
  sampleCount: number
  /** Points supporting the chosen band. Low support means a poorly-seen floor. */
  inlierCount?: number
  /**
   * RMS distance of those points from `y`, in metres. The tilt readout: a level
   * floor sits near hit-test noise, a tilted one spreads far past the band width.
   */
  residualM?: number
  /** True when no band qualified and the legacy percentile was used instead. */
  fallback?: boolean
}
```

## Definition of Done

- [ ] `estimateFloorY()` returns the mean Y of the lowest well-supported horizontal band
- [ ] It falls back to the percentile when no band qualifies, and flags that in `fallback`
- [ ] `GroundEstimate` carries `inlierCount`, `residualM` and `fallback`; no consumer changed
- [ ] Every new constant is named, documented, and carries an explicit
      "adopted by decision, not by measurement" note and a "Revisit when:" trigger
- [ ] `_maybeRecomputeGround()`'s lock/unlock logic is **unchanged**
- [ ] `pointcloud.ts` stays DOM- and Deno-API-free (ADR 0002)
- [ ] `GROUND_TAP_TOLERANCE_M`'s "Revisit when" paragraph is corrected — it currently tells
      the reader the estimator is the likelier cause of a false rejection
- [ ] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

- [ ] **The regression case, written first and failing against the current estimator.** An
      under-sampled floor: enough floor points to be a real cluster, but under 8 % of the
      cloud, with the rest at eye level. Assert the current code returns a value ~0.7 m+ too
      high, then that the new one lands on the floor. Without this the ticket cannot show it
      fixed anything
- [ ] The existing "converges on the floor cluster, not the furniture above it" case still
      passes unchanged — a well-sampled floor must not regress
- [ ] A tabletop better sampled than the floor still yields the floor, not the tabletop —
      the case that motivates "lowest qualifying band" over "densest band"
- [ ] A genuinely structureless cloud sets `fallback` and does not invent a floor — asserted
      across several seeds at a density where the check is actually reliable
- [ ] A *sparse* structureless cloud, where the share test can be fooled, is still visibly
      unconfident through `inlierCount` and `residualM` — the honest boundary of the check above
- [ ] `residualM` is small for a level floor and large for a deliberately tilted one — the
      tilt readout does what it claims
- [ ] The returned `y` is not quantised to the band grid: a floor at a value off the grid
      (e.g. −0.037) is returned near that, not snapped to a multiple of the band width
- [ ] Lock/unlock behaviour is unchanged: the existing lock, unlock-on-level-change and
      throttle tests pass untouched
- [ ] Record time-to-lock before and after in the PR, without changing any constant

```bash
npx tsc --noEmit && deno task check && deno task test
```

## Acceptance Criteria

- [ ] Given a cloud whose floor is under 8 % of points, When the estimate is computed, Then
      it returns the floor, not the surface the percentile lands on
- [ ] Given a well-sampled floor, Then the estimate is unchanged from today's behaviour
- [ ] Given a tabletop with more points than the floor, Then the floor is returned
- [ ] Given a cloud with no floor at all, Then `fallback` is true and no floor is invented
- [ ] Given any existing consumer (`isTapOnGround`, `src/export/gltf.ts`), Then it compiles
      and behaves identically for a well-sampled floor
- [ ] Given a tilted floor, Then `residualM` is materially larger than for a level one

## Risks / potential issues

- **Risk:** Changing the estimator changes what the floor gate accepts, and
  `GROUND_TAP_TOLERANCE_M` was adopted against the *old* estimator's behaviour. A better
  estimate could make the gate stricter in practice. — **Mitigation:** the tolerance is
  unchanged here deliberately; if the gate starts rejecting genuine taps the correct response
  is 0006's measurement, not a widened constant. The floor overlay from #166 makes the
  estimate visible for exactly this check.
- **Risk:** "Lowest well-supported band" could latch onto a low step, a sunken area, or
  points below the floor from a reflective surface — cases the percentile happened to average
  over. — **Mitigation:** the support fraction is the control; the floor-less test pins the
  degenerate end. Recorded as this constant's revisit trigger.
- **Risk:** A histogram over a decimated cloud has half the counts, so an absolute support
  threshold would silently change meaning after `_decimate()`. — **Mitigation:** the
  threshold is a fraction of the **whole cloud**, never an absolute — and never a fraction of
  the best-supported band either, which is the separate error Open questions records this
  ticket having made and corrected.
- **Risk:** This is the input to a gate whose own tolerances are unmeasured, so a
  "better" estimator cannot be proven better on device without 0006. — **Mitigation:** be
  honest about that: the tests prove it fixes a **reproducible, constructed** failure. The
  device claim stays unmade until 0006 runs.

## Subtasks

1. [ ] Write the failing regression test against the current estimator; record the actual
       wrong value it returns
2. [ ] Add the band-width and support-fraction constants, documented to this wave's standard
3. [ ] Implement the histogram fit with the inlier-mean refinement and the percentile fallback
4. [ ] Extend `GroundEstimate`; populate the new fields in `groundEstimate()`
5. [ ] Add the remaining test cases
6. [ ] Confirm the lock/unlock and throttle tests pass untouched; record time-to-lock
7. [ ] Fix `GROUND_TAP_TOLERANCE_M`'s now-stale "Revisit when" paragraph
8. [ ] Update the wave README ticket table, HANDOFF's order of work, and the atlas entry
9. [ ] `npx tsc --noEmit && deno task check && deno task test`
