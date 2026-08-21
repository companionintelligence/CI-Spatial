> **Type:** Frontend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/webxr-probe-grid`
> **Commit style:** `fix(ar): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. (Independent of 0001 — a starved point cloud and a fabricating
> model are unrelated defects that happened to be found in the same session.)

## Goal

Give the WebXR provider the N x N hit-test probe grid the scanner already asks every
provider for, so the point cloud accumulates at a rate comparable to the 8th Wall path
instead of a trickle.

**Status: implemented 2026-08-18.** On-device re-verification is still outstanding — see
Definition of Done.

## The defect, precisely

`ScanController.start()` ticks every 750 ms and calls
`provider.featurePoints(gridSize)` with `DEFAULT_GRID_SIZE = 6` (`src/ar/scanner.ts:30-31`).
That constant's own comment reads `6x6 = 36 hit-tests per tick`.

The two providers honour it very differently:

| Provider | Per tick |
|---|---|
| 8th Wall (`src/ar/eighthwall.ts:294`) | full SLAM world points, or a 6x6 = 36-probe hit-test grid |
| WebXR (`src/ar/webxr.ts:181`, before this change) | whatever accumulated from **one ray at dead centre** |

The WebXR signature was `featurePoints(_gridSize?: number)` — the underscore is accurate,
the parameter was discarded. The frame loop pushed exactly one point per frame, `hits[0]`
from a source created at `src/ar/webxr.ts:79` as
`requestHitTestSource({ space: viewer })` — no `offsetRay`, so a single ray down the
viewport centre.

The consequence is not "fewer points", it is **the wrong shape of sample**. A centre ray
draws a 1-D trail through space. `PointCloud` then voxel-dedupes at 5 cm
(`src/scene/pointcloud.ts:9`), so every sample taken while the device is still collapses
into a single voxel. Only physical camera motion sweeps the ray into new voxels, and in a
small room the ray keeps landing on surfaces already recorded.

Measured on a Lume Pad 2, 2026-08-18: **631 points after five minutes** of scanning a small
space, still reporting `SPARSE`.

There is a second-order harm worth naming. The HUD's standing advice for this state is
*"Sweep the room more slowly to improve surface coverage."* For this failure mode that is
backwards — slower sweeping means fewer new voxels per unit time. The hint actively
lengthens the failure. This ticket does not change the hint (see Non-goals) but the hint
stops being wrong once the grid lands, because coverage no longer depends on sweep speed
alone.

## The fix

Subscribe one persistent `XRHitTestSource` per grid cell, aimed at the cell centre via
`offsetRay`, and drain all of them each frame.

The `offsetRay` capability was already in this file — `hitTestAsync()` (`:222-262`) has
always built one for the spatial resolver. This change extracts that ray construction into
a shared `viewportRay(x, y)` helper and reuses it, rather than writing a second copy.

**The grid is subscribed on the first frame, not in `start()`.** The rays are aimed using
`_fovY` and `_aspect`, which hold defaults of `60` and `1` until a viewer pose has been
read. Subscribing during `start()` would bake those defaults in and aim the grid at a cone
that does not match the actual viewport — on a portrait tablet, badly. A
`hitTestGridState` field (`idle` / `building` / `ready` / `failed`) makes the one-shot
transition explicit and prevents re-entry from the animation loop.

## Non-goals

- Do not change `DEFAULT_GRID_SIZE` or `DEFAULT_INTERVAL_MS` in `src/ar/scanner.ts`. This
  ticket makes WebXR *meet* the existing contract; retuning the contract afterwards is a
  separate decision with 8th Wall on the other side of it.
- Do not change the 5 cm voxel size in `src/scene/pointcloud.ts:9`. The dedupe is correct —
  it was the 1-D sample shape that made it look punitive. Changing both at once would make
  the improvement unattributable.
- Do not rewrite the HUD coverage hint. It is misleading for this failure mode, but the
  quality-monitor recommendation set (`src/capture/quality-monitor.ts:172`) should be
  re-evaluated against the *post-fix* accumulation rate, not guessed at now.
- Do not touch the 8th Wall provider. It already satisfies the contract.
- Do not make `gridSize` per-call dynamic — see Open questions.
- Do not attempt to fix the stale-camera-frame defect in the same file. It is real, it was
  confirmed in the same session (byte-identical 140842-byte JPEGs across 47 minutes), and
  it belongs to ticket 0003's territory. Keep the diffs separable.

## Pinned conventions

**ADR 0001** — this touches a client-side provider contract, so it states what it reuses.
Verified at `489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `ARProvider.featurePoints(gridSize?)` | `src/ar/provider.ts:54` | signature unchanged; the WebXR implementation now actually samples a grid |
| the `offsetRay` + `XRRay` pattern | `src/ar/webxr.ts:222-262` (`hitTestAsync`) | **extracted** into `viewportRay(x, y)` and reused by both call sites, rather than duplicated |
| `_recentHitPoints` ring buffer | `src/ar/webxr.ts:32` | reused; only its cap changes, from an inline `120` to the named `MAX_RECENT_HIT_POINTS` |
| `PointCloud` voxel dedupe | `src/scene/pointcloud.ts:39` | unchanged — it is the reason extra probes are cheap to feed |
| `ScanController` drain loop | `src/ar/scanner.ts:51` | unchanged; it already calls `featurePoints(gridSize)` on a timer |
| normalised 0-1 viewport coords | `hitTestAsync(x, y)` callers | `viewportRay` keeps the same convention (0,0 = top-left) so both call sites aim identically |

No new type, route or connection. Two module-level constants and one private helper.

## Before implementation

- `src/ar/webxr.ts:76-135` — the `start()` hit-test subscription and the XR frame loop
- `src/ar/webxr.ts:222-262` — `hitTestAsync()`, the existing `offsetRay` construction
- `src/ar/scanner.ts:28-58` — the drain interval and grid size the provider must satisfy
- `src/ar/eighthwall.ts:294` — the behaviour being matched
- `src/scene/pointcloud.ts:1-45` — why sample *shape* matters more than sample count

## Open questions & answers

- Q: Can `featurePoints(gridSize)` honour a per-call grid size? — A: No, not without
  re-subscribing sources mid-session. `XRHitTestSource` subscriptions are async and
  persistent, unlike 8th Wall's synchronous probe. The grid is fixed at session start from
  `HIT_GRID_N`, matched to the scanner's default, and `gridSize` is documented as advisory
  for this provider. (Decided 2026-08-18.)
- Q: Sample the grid every frame, or throttle it? — A: Every frame. ARCore computes results
  for every subscribed source per frame regardless of whether they are read, so throttling
  the read saves nothing; the cost is in the subscription count. (Decided 2026-08-18.)
- Q: Is 36 concurrent hit-test sources too many for ARCore on this class of device? — A: No,
  at least not on a Lume Pad 2 (Android 12, ARCore 1.52, Chrome 151). All 36 probes
  subscribed, no console performance warnings, no ARCore errors, point accumulation ~15x the
  previous absolute count, and no perceptible loss of tracking smoothness. Note this is a
  subjective judgement, not an FPS number — the app has no stats readout to take one with.
  `HIT_GRID_N` remains a single constant if a weaker device ever needs it lowered.
  (Verified 2026-08-18.)

## Files impacted

Changed:
- `src/ar/webxr.ts`

## Schema required

None.

## Definition of Done

- [x] `HIT_GRID_N` and `MAX_RECENT_HIT_POINTS` exist as named module constants
- [x] `hitTestSources: XRHitTestSource[]` replaces the single `hitTestSource`
- [x] The grid is subscribed once, on the first frame with a viewer pose, guarded by
      `hitTestGridState`
- [x] The frame loop drains every source
- [x] `viewportRay()` is shared by the grid builder and `hitTestAsync()`
- [x] `stop()` cancels every source and resets the state machine
- [x] A partial subscription (some cells rejected) warns but still works
- [x] A session ending mid-subscription cancels the in-flight sources instead of leaking
- [x] `npx tsc --noEmit` passes
- [x] **On-device: point count climbs materially faster than 631-per-5-min.** Measured
      2026-08-18 on the Lume Pad 2: 4,260 → 8,787 → 9,440 points across a few minutes in an
      already-covered space, versus a 631-per-5-minutes baseline in a fresh one. The badge
      left `SPARSE` for `REVIEW` and coverage moved from "Low — keep scanning" to
      "Partial — scan more surfaces" for the first time in that session. All 36 probes
      subscribed (no partial-subscription warning was emitted).
- [x] **On-device: no frame-rate regression from 36 concurrent hit-test sources.** No
      performance warnings in the console, no ARCore errors, and the accumulation rate itself
      proves the XR frame loop is ticking healthily — a throttled loop could not produce that
      many *new* voxels after 5 cm dedupe. No numeric FPS measurement was taken, because the
      app has no stats readout (`@types/stats.js` is declared in `package.json` but stats.js
      is not wired into `src/`); the check was subjective, by the operator holding the device
      during the session, who reported no degradation in tracking smoothness (2026-08-18).

## Tests

- [ ] Scan the same small space for 60 s on the Lume Pad 2; record the point count
- [ ] Confirm reported FPS / tracking stability is not visibly degraded
- [ ] `npx tsc --noEmit` and `npm run verify` pass

```
npx tsc --noEmit
npm run verify
```

## Acceptance Criteria

- [ ] Given a WebXR session pointed at a surfaced scene, When the device is held still for
      one scanner tick, Then more than one distinct voxel is added (the old behaviour could
      only ever add one)
- [ ] Given 60 s of scanning a small room, When compared against the pre-change baseline of
      631 points per 5 minutes, Then the rate is materially higher
- [ ] Given a runtime without hit-test support (iwer emulation), When a session starts, Then
      it logs the existing "feature points disabled" warning and does not throw

## Risks / potential issues

- **Risk:** 36 concurrent `XRHitTestSource` subscriptions may cost frame rate on a
  mid-range Android tablet. ARCore raycasts every subscribed source each frame. —
  **Mitigation:** `HIT_GRID_N` is a single named constant; dropping to 4 (16 probes) is a
  one-character change and still 16x the old behaviour. **This is the open question above
  and must be measured before the ticket closes.**
- **Risk:** The grid is aimed once, from the FOV of the first frame. A runtime that changes
  projection mid-session (rare) would leave it slightly misaimed. — **Mitigation:** Accepted.
  Probes only need to spread across the view cone; exact FOV correspondence is not required
  for coverage. Re-subscribing on FOV change would add a teardown path for no measured gain.
- **Risk:** `MAX_RECENT_HIT_POINTS = 2048` is sized for one 750 ms interval at 60 fps x 36
  probes (1620). If the scanner stalls, the buffer discards oldest-first. — **Mitigation:**
  Intentional and documented inline; `featurePoints()` splices the buffer empty each tick,
  so the cap only engages when the drain has already stopped.
- **Risk:** More points per tick means more work downstream in the live geometry stream and
  the GLB exporter. — **Mitigation:** Voxel dedupe bounds the growth to actual surface area,
  not probe count. Watch export size; 8th Wall sessions already operate at this density.

## Subtasks

1. [x] Add `HIT_GRID_N` and `MAX_RECENT_HIT_POINTS` module constants
2. [x] Extract `viewportRay(x, y)` from `hitTestAsync()` and reuse it there
3. [x] Replace the `hitTestSource` field with `hitTestSources` plus `hitTestGridState`
4. [x] Add `buildHitTestGrid()`, subscribing one source per cell with `offsetRay`
5. [x] Move subscription out of `start()` into the first-frame path
6. [x] Drain every source in the frame loop; cap the buffer by splice
7. [x] Update `stop()` and the `featurePoints()` doc comment
8. [ ] Measure point accumulation and frame rate on-device; resolve the open question
