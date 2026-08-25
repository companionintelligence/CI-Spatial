> **Type:** Frontend
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/splat4d-playback`
> **Commit style:** `feat(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0005 (the manifest and artifact layout); testable against 0006's stub mode

## Goal

Make a 4D person actually move in the World Editor. Load the `.sog` sequence a take produced,
drive frame selection from a clock, and expose it as a `splat4d` layer beside the static scan
layers.

## What exists, and the one thing that does not

The static splat path is complete and short: `attachSparkRenderer()` is called once
(`src/viewer/viewer.ts:365`), `loadSplat()` builds a `SplatMesh`, and it is added under the
scan's root so the transform gizmo moves it (`src/viewer/viewer.ts:2026`). SparkJS needs no
render-loop integration at all — its header states the reason: *"SparkRenderer hooks into the
normal renderer.render(scene, camera) call automatically, no render-loop changes needed."*

What is missing is time. Grepped across `src/`: **`AnimationMixer`, `gltf.animations`, and
`THREE.VideoTexture` have zero occurrences**, and the render loop (`viewer.ts:399`, a plain
`requestAnimationFrame(tick)`) has **no delta-time clock**. `docs/product/UX_FLOW.md:274` states
the position honestly: *"Time is stored but not scrubbable … '4D' is achievable only by toggling
`.scan-visible` checkboxes."*

So this ticket adds the first real playback clock in the app.

## Non-goals

- Do not build the general timeline scrubber. That is
  `docs/factory/08-places-and-things/0008-timeline-scrubber.md`, and it spans scans and edit
  history, not one asset. Ship the minimal per-asset transport here and adopt the shared control
  when it lands — see Pinned conventions for how to avoid becoming the second time system.
- Do not add a deformable-splat renderer. SparkJS has no deformation support; the sequence is
  discrete frames by design (0006).
- Do not change static splat loading, `splat-layer.ts`'s artifact preference chain, or the
  transform gizmo.
- Do not load the whole sequence eagerly. See the memory risk — this is the ticket's real
  engineering problem.
- Do not add audio playback. There is no audio anywhere in the capture path (0003).

## Pinned conventions

**ADR 0001** — touches schema (`LayerType`, already added by 0005) and reuses the existing splat
loading path. Searched for an existing time control before adding one: `loadedScans` entries
already carry an `inTimeWindow: boolean` (`src/viewer/viewer.ts:1238`), and
`08-places-and-things/0008` is the tracked owner of a shared scrubber. **Therefore: put the clock
behind one small interface that 0008 can drive**, rather than wiring `requestAnimationFrame`
directly into the layer. Concretely — the layer exposes `setPlayhead(t: number)` and a
self-driving `play()/pause()` built on top of it, so adopting the shared scrubber later means
deleting the self-driving half, not rewriting the layer.

**Layer conventions.** Follow `src/viewer/splat-layer.ts`: per-scan discovery from the scan's
artifact base (`filename` minus `.glb`), attach under `loadedScan.root`, respect the existing
visibility toggle. The sequence lives at `<base>.4d/frame-NNNNN.sog` (0005) with
`<base>.4d-capture.manifest.json` as the index — read the manifest for `frameCount`/`fps` rather
than probing for files.

**Mesh lifecycle.** `disposeSplat()` (`src/viewer/splat-viewer.ts:48`) does
`removeFromParent()` + `mesh.dispose()`. A windowed loader must call it for every evicted frame —
`SplatMesh` holds GPU buffers, and leaking them across a 24-frame sequence at 30 fps playback
would be a fast way to lose the tab. Note the wave-09 precedent: `mock-rtc-robustness.spec.ts`
exists specifically because a leak of exactly this shape shipped once.

**`LoadedSplat` needs extending**, not replacing: it is `{ id, label, mesh }` today
(`splat-viewer.ts:25-29`). Add optional sequence fields there rather than defining a parallel
loaded-asset type.

**Stale-comment fix, in scope.** `src/viewer/splat-viewer.ts:9-12` still says *"There's no
in-repo training pipeline yet (the `splat-train` world job in main.ts is a placeholder that only
records inputs)"*. That has been false since Brush landed. This wave's culture is that a change
fixes the sentences it makes false — correct it here.

## Before implementation

- `src/viewer/splat-viewer.ts` — all 51 lines; `LoadedSplat`, `loadSplat`, `disposeSplat`, and
  the header's claim about render-loop integration.
- `src/viewer/splat-layer.ts` — per-scan discovery, the `.sog → .compressed.ply → .ply`
  preference chain, and per-candidate fallback.
- `src/viewer/viewer.ts:365` (Spark attach), `:399` (the `tick` loop), `:1238`
  (`inTimeWindow`), `:2026` (attach under scan root).
- `docs/factory/08-places-and-things/0008-timeline-scrubber.md` — the future owner of the shared
  clock; read it before designing the interface so this does not become a rival.
- `docs/product/UX_FLOW.md:274, 403` — the current honest statement about time, and the open
  product question. Both need updating once this lands.
- `src/viewer/quality-tier.ts` — how job types map to displayed quality; a `splat4d` scan needs a
  sensible entry.

## Open questions & answers

- Q: All frames resident, or a sliding window? — A: **Window.** A `SplatMesh` per timestep holds
  real GPU memory, and a 24-frame sequence of a detailed person is plausibly hundreds of MB.
  Keep ±k frames around the playhead (`k = 2` initially — **adopted, not measured**) and dispose
  the rest. Measure real per-frame footprint on the first stub sequence and record it. (Decided
  in this ticket.)
- Q: What happens at a window miss — stall, or hold the last frame? — A: **Hold the last decoded
  frame and keep the clock running.** Stalling makes playback stutter unpredictably; holding
  degrades smoothly and is visibly honest. Surface a "buffering" affordance rather than silently
  dropping time. (Decided in this ticket.)
- Q: Should playback loop by default? — A: Yes. Takes are ~5 s; a one-shot playback of a 5-second
  clip that then vanishes is worse than useless for inspection. Loop, with an explicit
  pause/scrub. (Decided in this ticket.)
- Q: Does the sequence respect the scan-visibility toggle and gizmo like a static splat? — A:
  Yes — it attaches under `loadedScan.root` exactly as the static mesh does at `viewer.ts:2026`,
  so it inherits both for free. That is the reason to attach there rather than to the scene.
  (Decided in this ticket.)
- Q: What if only some frames of a sequence exist (a partial or failed run)? — A: Play what
  exists and say so. The manifest carries `frameCount`; if fewer files resolve, report the gap in
  the layer label rather than looping over a silently shorter sequence. A partial reconstruction
  that looks complete is the same class of defect as wave 09's fabricated `'verified'`. (Decided
  in this ticket.)
- Q: Interaction with the existing static splat layer on the same scan? — A: A person capture
  produces a `splat4d` layer and no static `.splat.ply`, so they do not normally coexist. If both
  are present, both are listed and independently toggleable — do not special-case one away.
  (Decided in this ticket.)

## Files impacted

New:
- `src/viewer/splat4d-layer.ts` — sequence discovery, windowed loading, playhead
- `src/viewer/playback-clock.ts` — the small self-driving clock, replaceable by 0008
- `tests/unit/node/splat4d_window.test.ts` — window/eviction logic, pure
- `tests/mock-splat4d.spec.ts`

Changed:
- `src/viewer/splat-viewer.ts` — `LoadedSplat` sequence fields; **fix the stale header comment**
- `src/viewer/viewer.ts` — layer registration, playback transport UI, `tick` wiring
- `src/viewer/quality-tier.ts` — a `splat4d` entry
- `docs/product/UX_FLOW.md` — lines 274 and 403 are made false by this ticket

## Schema required

No persisted schema — 0005 owns `Person4DManifest` and the `splat4d` `LayerType` member. Client
types only:

```ts
// src/viewer/splat-viewer.ts — extends the existing LoadedSplat, does not replace it
export interface LoadedSplat {
  id: string
  label: string
  mesh: SplatMesh
  /** Present only for a member of a 4D sequence. */
  sequence?: { frameIndex: number; frameCount: number }
}
```

```ts
// src/viewer/splat4d-layer.ts
export interface Splat4DLayer {
  scanId: string
  frameCount: number
  fps: number
  /** Drive from anything — the internal clock now, 08/0008's scrubber later. */
  setPlayhead(seconds: number): void
  play(): void
  pause(): void
  dispose(): void
}
const WINDOW_RADIUS = 2   // adopted, not measured — see Q&A
```

## Definition of Done

- [x] A scan with a `<base>.4d-capture.manifest.json` shows a `splat4d` layer in the editor
- [x] The sequence plays, loops, and can be paused and scrubbed
- [x] Only a bounded window of frames is resident; evicted frames are disposed via `disposeSplat()`
- [x] A window miss holds the last frame and shows a buffering affordance — it does not stall
- [x] A partial sequence plays what exists and reports the gap rather than looping silently short
- [x] The sequence attaches under the scan root, inheriting visibility and the transform gizmo
- [x] Playback is driven through `setPlayhead()`, so 08/0008 can take over without a rewrite
- [x] The stale `splat-viewer.ts` header comment is corrected
- [x] `UX_FLOW.md:274`'s "time is stored but not scrubbable" is updated — it is no longer true
- [x] `npx tsc --noEmit` and `npm run build` pass

## Tests

- [x] Unit (`splat4d_window.test.ts`, Node): given a playhead and `WINDOW_RADIUS`, the correct
      frame set is resident; advancing evicts exactly the frames that left the window
- [x] Unit: eviction calls dispose for each removed frame exactly once — the leak regression
- [x] Unit: a playhead past the end wraps to zero when looping
- [x] Unit: a manifest claiming 24 frames with only 18 resolvable reports the gap
- [ ] Playwright (`mock-splat4d.spec.ts`, `chromium-mock`): against 0006's stub sequence, the
      layer appears, play advances the visible frame, and pause holds it
- [ ] Playwright: toggling scan visibility hides the sequence; disposing the scan leaves no
      `SplatMesh` behind (count constructions against disposals, as
      `mock-rtc-robustness.spec.ts` does for peer connections)
- [x] Regression: `mock-splat-train.spec.ts` — static splat loading is unchanged

```bash
npx tsc --noEmit
npm run build
npm run test:store
npx playwright test tests/mock-splat4d.spec.ts tests/mock-splat-train.spec.ts --project=chromium-mock
```

## Acceptance Criteria

- [x] Given a stub 24-frame sequence, When the scan is opened, Then a `splat4d` layer is listed
      and playback begins
- [x] Given playback running, When the user pauses, Then the displayed frame stops advancing and
      does not drift
- [x] Given the user scrubs to 60% of the duration, When they release, Then the frame nearest
      that time is shown within one window load
- [x] Given a sequence longer than the window, When it loops for 60 s, Then resident mesh count
      stays bounded and does not grow
- [x] Given a scan with both a static `.splat.ply` and a 4D sequence, When it loads, Then both
      layers are listed and independently toggleable

## Risks / potential issues

- **Risk (the real one):** GPU memory. Per-frame `SplatMesh` footprint is unmeasured, and a
  detailed person at 24 timesteps could exceed a laptop GPU even windowed. — **Mitigation:**
  windowing is in the Definition of Done rather than an optimisation; measure per-frame footprint
  on the first stub sequence and record it in the pipeline doc. If it is too large, the honest
  levers are fewer timesteps (0006's `FDANYONE_TIMESTEP_FPS`) or more aggressive `.sog`
  compression — both upstream of this ticket.
- **Risk:** Loading a `.sog` per frame at playback rate may simply not keep up — `SplatMesh`
  construction plus `await mesh.initialized` is not obviously fast enough for 5 fps, let alone
  30. — **Mitigation:** the hold-last-frame behaviour keeps this graceful, and the window is
  prefetch-ahead rather than load-on-demand. If it cannot keep up at all, that is a finding worth
  reporting plainly — it would argue for the deformable trainer the wave deferred.
- **Risk:** Adding a clock to a render loop that has never had one risks coupling playback rate
  to frame rate. — **Mitigation:** drive from wall time, not frame count; `setPlayhead()` takes
  seconds precisely so playback is frame-rate independent and 0008 can drive it from anywhere.
- **Risk:** Becoming a second time system that 08/0008 then has to reconcile — exactly the
  parallel-systems failure ADR 0001 exists to prevent. — **Mitigation:** the `setPlayhead()`
  seam is the whole mitigation, and it is a Definition-of-Done item. Flag 08/0008 as the adopter
  in its ticket when this lands.

## Subtasks

1. [x] Write the window/eviction logic as a pure module with its unit tests first
2. [x] Extend `LoadedSplat` with sequence fields; fix the stale header comment
3. [x] Implement `splat4d-layer.ts`: manifest read, discovery, windowed load, `setPlayhead()`
4. [x] Implement `playback-clock.ts` driving `setPlayhead()` from wall time
5. [x] Register the layer in the editor and attach under the scan root
6. [x] Add the play/pause/scrub transport and the buffering affordance
7. [x] Add a `splat4d` entry to `quality-tier.ts`
8. [x] Update `UX_FLOW.md` lines 274 and 403 — this ticket makes both false
9. [x] Write the Playwright specs including the dispose-count regression
10. [x] `npx tsc --noEmit`, `npm run build`, run the mock suite
