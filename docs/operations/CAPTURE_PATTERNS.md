# Capture patterns — how to walk (or not walk) a room

Which way to capture a space, how to do each one properly, and what each one can and cannot
produce. Written for someone standing in a room holding a tripod.

The one idea underneath all of it: **the reconstructor works out where things are by seeing them
from two places that are genuinely apart.** Turning the camera on the spot does not count as two
places, no matter how many photos you take. Everything below is a consequence of that sentence.

The reasoning and the measurements are in
[ADR 0008](../adr/0008-station-dome-capture-is-a-supported-path-and-its-baseline-comes-from-moving-the-tripod.md);
this page is the practical half.

---

## Pick a pattern

| You have | Use | Gives you |
| --- | --- | --- |
| A tracking-capable phone (ARCore, or an iPhone with 8th Wall working) and someone willing to walk | **Walkthrough** | The best-measured result, and the only one with real-world scale |
| A tripod and gimbal, any phone, no AR | **Station domes** — 3 to 5 stops, sweep at each | A 3-D model with no real-world scale |
| One spot you can stand in, and you want a picture, not a model | **Single dome** | A panorama. Not a model — see below |
| A phone and a few minutes | **Video walkthrough** (upload the clip) | Same as a walkthrough, minus the scale |

If you are unsure, and the phone can track: walk it. If the phone cannot track — which on the
XREAL Beam Pro it cannot, permanently — use station domes.

---

## Station domes (the tripod pattern)

Set the tripod down, sweep, pick it up, carry it somewhere else, sweep again. Three to five stops
for an ordinary room.

**All of the depth information comes from the carrying**, not from the sweeping. The sweep is how
you cover the walls; the walk between stops is what makes the coverage into a model. This is why
one dome from one spot gives nothing, and five domes from five spots give a room.

### How many stations

- **Two is the bare geometric minimum** — the point at which any parallax exists at all — and
  **three is the practical minimum**, because two stations give you one baseline and nothing to
  cross-check it against.
- **Five for an ordinary room** (say up to about 6 × 5 m). That is what has been measured.
- **More for an L-shape, a corridor, or a room with a big obstruction in the middle** — anything
  that can hide part of the room from a station needs a station on the other side of it. The test
  is not floor area, it is line of sight: *every surface you care about should be clearly visible
  from at least two stations.*

### How far apart

- **About 2 m between neighbouring stations** is what the measured capture used (1.9–2.2 m
  between nearest neighbours, up to 4.3 m across the room).
- **Rule of thumb: move at least a tenth of the distance to what you are capturing**, and prefer
  a lot more. If the far wall is 4 m away, 40 cm is the bare minimum and 1.5–2 m is what you
  actually want. Under the minimum, the reconstructor cannot tell depth from noise.
- **Do not move so far that neighbouring stations see nothing in common.** Frames with no shared
  detail cannot be linked, however far apart the camera was. If in doubt, add a station rather
  than stretching the gap.

### Where to put them

- **Never in a straight line.** Stations along a wall, or down the middle of a corridor, are
  *degenerate* — the geometry fails along that line specifically, and it fails quietly. Spread
  them out: a rough ring around the room plus one in the middle is the layout that was measured.
- **Roughly a metre off the walls**, so each station sees the wall behind it in some other
  station's sweep.
- **Same height at every station** — about 1.4–1.6 m, and do not adjust the legs between stops
  unless the floor forces it. Consistency is worth more than any particular height.
- **Each station should see the area around the previous one.** Walk the ring in order; do not
  hop across the room and back.

### What to sweep at each station

- **A 150° pan arc, in two tilt rows** (one roughly level, one angled down) is the shape that was
  measured. Serpentine it — pan one way along the top row, back along the bottom — so you are not
  driving the gimbal back across the whole arc between rows.
- **Stay inside the gimbal's reachable arc: about +82° … 180° … −100°.** The arc runs *behind*
  the operator, across the ±180 seam; the ~180° spanning the front is a dead zone it cannot
  rotate through. Centre each dome near **171°** (straight back) and it fits. A move aimed into
  the dead zone drives into the mechanical stop, which is a jam, not a slow move. (An older note
  in `GIMBAL_INTEGRATION.md` records the arc as ±175° avoiding the ±180 seam; the tighter figure
  above is the more recent measurement. Plan against the tighter one.)
- **Keep tilt between about −40° and +15°.** The gimbal converges down to −40° but stalls near
  +16° — that is a mechanical limit, not a setting.
- **Pan step: 15–20°, and 20° is the coarsest to use.** At 20° neighbouring frames overlap about
  60 % with the phone in portrait (measured horizontal field of view ≈ 51°; in landscape ≈ 80°,
  where 20° gives ~75 %); at 15° — the dome planner's default — it is about 70 %. Take the finer
  step unless you are short of time. Over a 150° arc, 20° is 9 columns × 2 rows ≈ **18 photos per
  station**, about 90 for a five-station room; 15° is 11 columns, ≈ 22 per station.
  - One catch specific to the scanner-app capture mode (where the phone records its own poses
    rather than the gimbal triggering the shutter): the app only emits a keyframe every 20° of
    rotation, so a grid stepped finer than that will not produce one keyframe per position.
  - The measured 36/36 capture actually used coarser steps — about 7 usable frames per station,
    ~30° apart — and still registered every frame. It was a fully textured simulated room. In a
    real room with plain walls, take the extra frames; they cost seconds.

### What it produces, and what it does not

**Produces:** camera positions for every frame, a sparse point cloud, and (with the splat stages)
a gaussian splat of the room. Coverage that is even, in focus, and the same every time you do it.

**Does not produce: real-world scale.** Photos alone carry nothing metric, so the reconstruction
is correct in shape and arbitrary in size — 1 unit is not 1 metre and there is no way to find out
what it is from the photos. Anything downstream that needs metres (measurements, and the 3-D
object lift that turns detected things into placed things) will correctly report that it skipped,
with a reason. That is not a bug and not something to work around; it is what a pose-less capture
means. Scale needs either a tracking-capable phone or a known-size reference measured into the
scene.

---

## Single dome — a panorama, not a model

One tripod position, sweeping the whole way round. This is the *ideal* input for a panorama and a
useless input for reconstruction, and those are the same property seen from two sides.

Measured, repeatedly: a narrow single-station gimbal capture registered **4 of 9** photos, with 29
of its 36 image pairs classified as panoramic-with-no-depth; a near-in-place handheld capture
registered **3 of 17** and recovered a single 3-D point. Adding frames does not help. Adding
resolution does not help. A wider sweep helps slightly and for an unrelated reason (the lens sits
off the rotation axis, so a big pan does produce a few centimetres of travel), and it still is not
a reconstruction.

Use a single dome when you want a picture of a place. Do not use it when you want a model of one.

---

## Walkthrough

Carry the phone and walk the room, either in the live scanner or as a video you upload afterwards.

- **Keep moving sideways, not just turning.** Rotating on the spot mid-walk contributes nothing;
  a curved path across the room contributes a lot.
- **Do not walk straight down the middle staring ahead.** A dead-straight dolly along the view
  direction produces almost no parallax for anything near the centre of frame. Cross the room
  diagonally, and keep the furniture off to one side as you pass it.
- **Slow down.** Motion blur is the main thing that makes a hand-carried capture worse than a
  gimbal one; the ingest drops blurry frames, so a fast pass silently becomes a short one.
- Measured results: 48 of 48 and 32 of 32 frames registered on simulated walkthroughs. This is
  the best-measured pattern there is.
- **In the live scanner on a tracking-capable phone this is the only pattern that gives real-world
  scale**, because the phone's own motion tracking measures actual movement. Uploading a video
  does not — a video is pose-less like a photo batch.

---

## Things that quietly ruin a capture

- **Moving furniture between stations.** The reconstructor assumes the room held still. Shift a
  chair between stop 2 and stop 3 and it will try to place it in both positions at once.
- **Blank walls.** Featureless paint gives the matcher nothing to hold on to. It is the single
  biggest difference between a test room and a real one. Where a wall is completely bare, make
  sure some furniture or doorway is in the same frame, and do not spend a whole station facing it.
- **Changing the lighting** mid-capture, or capturing into a bright window that makes everything
  else a silhouette. Lights on, blinds down.
- **Changing the tripod height** between stations.
- **Touching the joystick while a run is going.** The backend rejects manual moves during a grid
  run with a 409 for a reason — two controllers fighting over the same motors once pinned a
  gimbal at one pose for six consecutive positions, photographing the same view each time.
- **Walking through your own shot.** You are a moving object in a scene assumed to be static.
- **Leaving the gimbal driving.** Its speed commands latch — it keeps driving until told to stop.
  Every code path stops the motors on the way out; if you interrupt one by hand, check the gimbal
  is actually still before you walk away. This has overheated a real unit.

---

## Getting the photos into the system

1. Collect the photos from the capture.
2. `POST /ingest-photos` (multipart `files: File[]`, optional `name`) → `202 {sessionId, scanId,
   jobId, frameCount, droppedBlurry}`. It orders them, drops the blurry ones, and queues the
   reconstruction.
3. Poll `GET /worlds/default/jobs` for that `jobId`.
4. If you captured a room as several separate sessions, pool them into one before reconstructing:
   `deno run -A scripts/scan-room.ts --pool <id-a> <id-b> … --as <new-id>`. Pooling is what lifted
   one reference capture from 4 of 9 registered to 20 of 22.

---

## Did it actually work?

Read `colmap-poses.manifest.json` in the session directory. A good station capture looks like
this — this is the measured five-station run:

```json
"frameCount": 36,
"registeredImages": 36,
"pointCount": 9914,
"quality": { "registrationRatio": 1, "degenerate": false, "status": "ready", "reasons": [] }
```

What to check, in order:

- **`registeredImages` against `frameCount`.** Below about 60 % the job says so itself
  (`status` stops being `ready`). Anywhere below ~90 % on a station capture is worth a second
  look even when it passes.
- **`pointCount`.** A few thousand for a room. A handful of points with a healthy-looking status
  is the signature of a capture with no baseline — that is exactly how the 3-of-17 run above
  reported itself.
- **Which frames survived — check this by hand.** A ratio computed over the frames COLMAP kept
  cannot tell you that everything it kept came from one station. Open `colmap.poses.json` and
  confirm that photos from *every* station are in the `frames` list. If one station is missing
  entirely, that station did not link to the rest — usually too far from its neighbours, or
  facing something they never saw. Re-shoot with a station in between. **There is no automated
  check for this yet.**

A green job is not by itself evidence of a good capture. The whole reason this page exists is
that a capture with no baseline can complete successfully and produce almost nothing.

---

## When something goes wrong mid-run

| What you see | What it is | What to do |
| --- | --- | --- |
| A move reports jammed, or "closed 0.6° of distance" | The gimbal is against a mechanical stop | Recenter; check the sweep stays inside the pan arc and the tilt band. A longer timeout will not help — it just holds the motors against the stop |
| Three positions in a row end at the same pose | The gimbal's BLE stack has wedged | Hold Shutter + Switch + Trigger together ~1 s to hardware-reset it, check the phone is balanced in the cradle, reconnect, re-run |
| Motion commands ignored, everything looks connected | Usually an unbonded gimbal | See `GIMBAL_INTEGRATION.md` — this one has been misdiagnosed as a code bug before |
| The gimbal is warm and still moving after a run ended | A latched speed command | Stop the motors; do not leave it. Repeated, this thermally shuts the unit down |
| Lots of dropped-blurry frames | Moving on before the gimbal settled | Increase the dwell at each position |
| Few frames registered, on a capture that looked fine | No baseline, or stations too far apart | Re-read "How far apart" and "Where to put them" above. This is a capture problem, not a settings problem |

---

## See also

- [ADR 0008](../adr/0008-station-dome-capture-is-a-supported-path-and-its-baseline-comes-from-moving-the-tripod.md)
  — why station capture works, with the measurements
- [ADR 0007](../adr/0007-splat-backends-are-selectable-and-a-rotation-only-sweep-is-not-a-reconstruction-capture.md)
  — why a rotation-only sweep cannot be reconstructed
- [`GIMBAL_INTEGRATION.md`](GIMBAL_INTEGRATION.md) — running the gimbal: presets, limits, known
  hardware gotchas
- [`AR_DEVICE_SUPPORT.md`](AR_DEVICE_SUPPORT.md) — which phones can track, and how we know
- [`../pipelines/colmap-poses.md`](../pipelines/colmap-poses.md) — what the pose solver does with
  what you captured
