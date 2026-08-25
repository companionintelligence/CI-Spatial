> **Type:** Backend
> **Wave:** 11-panoramic-canvas
> **Branch:** `feat/canvas-frame-selection`
> **Commit style:** `feat(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0003

## Goal

Choose which keyframes build a canvas. OneCanvas uses **K = 32** frames per scene; a
Companion-Scan session holds up to **2000**. Picking the wrong 32 is the difference between a
canvas that covers a room and one that stares at a wall.

## Non-goals

- Do not change the canvas maths. This ticket produces an ordered frame list; 0003 consumes it.
- Do not re-implement blur detection. The ingest path already measures sharpness.
- Do not hard-code 32. It is the documented default because it is what the adapters were
  evaluated at, not a law.
- Do not drop the ability to build from all frames. A caller that asks for everything should
  still get everything, slowly.

## Pinned conventions

**ADR 0001** — touches no schema. The selection is a pure function over records that already
exist (`keyframes.jsonl`), and its output is the `frames` field `CanvasManifest` already
declares. Searched for an existing selector before writing one: `scripts/ingest-video.mjs` has
an *adaptive fps* sampler and `scripts/ingest-quality.mjs` has the **blur filter**
(variance of the 3×3 Laplacian on downscaled grayscale) — both select frames, but both select
by *time* and *sharpness*, neither by pose coverage, which is the thing that fills a panorama.
So: reuse the sharpness signal, add the coverage criterion.

**Selection is by pose coverage, not by time.** Every-Nth is the obvious approach and the wrong
one: a capture that lingers in a doorway gives most of its frames to the doorway. What fills a
canvas is *angular and positional spread*.

**Determinism.** The same session must select the same frames every run — a canvas that changes
between rebuilds for no reason is unreviewable. No `Math.random`, and ties broken by frame
index.

## Before implementation

- `src/capture/keyframes.ts:61-72` — the capture-time cadence (`minDistanceM: 0.3`,
  `minRotationDeg: 20`), which is already a coarse spatial filter and tells you what spread a
  session plausibly has.
- `scripts/ingest-quality.mjs` — `filterBlurryFrames` and the sharpness metric.
- `scripts/ingest-video.mjs` — the adaptive-fps sampler, as the existing precedent for "choose a
  subset of frames" in this repo.
- `server/splat/splat_train_dataset.ts` — how keyframe records and poses are read.

## Open questions & answers

- Q: What is the selection criterion, concretely? — A: **Greedy farthest-point sampling in pose
  space**, over a distance that combines camera position and viewing direction. Start from the
  frame nearest the canvas origin, then repeatedly take the frame farthest from everything
  already chosen. It is simple, deterministic, has no tuning beyond the position/rotation
  weighting, and is the standard answer for "spread K samples over a set". (Decided in this
  ticket.)
- Q: How are metres and degrees combined into one distance? — A: A weighting constant,
  `ROTATION_WEIGHT_M_PER_RAD`, **adopted at 1.0 m/rad** — a 57° turn counts as much as a metre
  of walking. That is a guess shaped by the capture cadence (0.3 m / 20° thresholds suggest
  rotation is the cheaper axis to accumulate), and it should be revisited against a real scan.
  State it as adopted at its definition with a revisit trigger, per ADR 0005 rule 5.
- Q: Where does sharpness come in? — A: As a **gate, not a score**. Drop frames below the
  existing blur floor first, then spread over what remains. Mixing a quality score into the
  spread metric makes both harder to reason about, and a blurry frame in a well-covered
  direction is still better than no frame there — so the gate is deliberately permissive, and
  falls back to including blurry frames if dropping them would leave a direction uncovered.
- Q: What if a session has fewer than K frames? — A: Use them all, and record it. A 20-frame
  canvas is legitimate; silently reporting 32 would not be.
- Q: Should selection depend on the canvas origin? — A: Yes — coverage is angular *from the
  origin*, so a situated canvas centred elsewhere wants a different 32. Take the origin as an
  input. (Decided in this ticket.)

## Files impacted

New:
- `server/canvas/select_frames.ts` — pure
- `tests/unit/deno/select_frames.test.ts`

Changed:
- `server/canvas/build_canvas.ts` — call it; record the result in the manifest
- `.env.example` — `CANVAS_FRAME_COUNT`

## Schema required

None. The output populates `CanvasManifest.frames`, which 0003 already declares.

```ts
/** Frames the canvas should be built from, best-spread first. */
export function selectCanvasFrames(
  frames: readonly PosedFrame[],
  origin: { position: Vec3 },
  opts: { count: number; minSharpness?: number },
): PosedFrame[]
```

## Definition of Done

- [ ] Selection is a pure, deterministic function — same input, same output, every run
- [ ] It spreads over pose, measurably better than every-Nth (see Tests)
- [ ] Blurry frames are gated out, unless dropping them would leave a direction uncovered
- [ ] Fewer than K available uses them all, and the manifest reports the real count
- [ ] The count is a parameter defaulting to 32, documented as the adapters' evaluation value
- [ ] The origin is an input, so a situated canvas selects for its own viewpoint
- [ ] `deno task check`, `deno task test` pass

## Tests

- [ ] Unit: **beats the baseline.** On a synthetic session that lingers — 200 frames, 150 of
      them clustered in one corner — selection covers more distinct viewing directions than
      every-Nth over the same set. This is the assertion that justifies the ticket, and it
      should fail if selection degenerates to time sampling.
- [ ] Unit: deterministic — two runs over the same input return identical lists
- [ ] Unit: 20 frames available, 32 requested → all 20, no padding, no throw
- [ ] Unit: an all-blurry session still returns frames rather than an empty canvas
- [ ] Unit: two different origins over the same session select different sets

```bash
deno task check
deno task test
```

## Acceptance Criteria

- [ ] Given a session that lingers in one spot, When frames are selected, Then the canvas is not
      built predominantly from that spot
- [ ] Given the same session twice, Then the same frames are chosen
- [ ] Given a canvas manifest, Then a reviewer can see exactly which frames built it

## Risks / potential issues

- **Risk:** `ROTATION_WEIGHT_M_PER_RAD` is adopted, not measured, and it is the one knob that
  decides whether selection prefers walking or turning. — **Mitigation:** stated as adopted at
  its definition with a revisit trigger; the coverage test is written so a bad weighting shows
  up as worse coverage rather than passing silently.
- **Risk:** farthest-point sampling picks extremes, so it may favour the odd frame shot from a
  doorway over the room's body. — **Mitigation:** that is usually the *right* bias for panorama
  coverage; the lingering-session test is what catches it if it is not.
- **Risk:** the blur gate could empty a direction. — **Mitigation:** the gate is explicitly
  permissive and falls back, and there is a test for the all-blurry case.

## Subtasks

1. [ ] Write the coverage metric and the baseline comparison test first
2. [ ] Implement greedy farthest-point selection over pose
3. [ ] Add the sharpness gate with its uncovered-direction fallback
4. [ ] Wire into `build_canvas.ts`; record `frames` in the manifest
5. [ ] Document `CANVAS_FRAME_COUNT`; state the weighting constant as adopted
6. [ ] `deno task check`, `deno task test`
