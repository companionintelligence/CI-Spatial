# Companion Scan — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Scan's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

The cuts are built **locally, on demand, and are not stored** — there is no GitHub Actions run,
no uploaded artifact, no committed `.mp4`, no release asset. An MP4 is a build output: make one
when you need it, then delete it. What *is* kept is the input — the screenshots under
[`assets/shots/`](assets/shots) and the voiceover under `assets/audio/` — so anyone can render a
cut without booting the stage, and a moved UI shows up as a reviewable image diff.

## Make the video

One command, from a CI-Engineering checkout in the same workspace:

```bash
node tools/make-videos.mjs companion-scan
```

It exports this directory from `origin/main`, renders both cuts from the committed shots, and
writes the MP4s to `~/Movies/CI-Product-Videos/companion-scan/` — outside every repo. Takes about
ninety seconds and needs nothing running. `--list` shows every product and its shot count.

The runner resolves `@companionintelligence/video-kit` straight from the CI-Common checkout on
disk, so it needs no npm registry and no token.

## Working on the cut itself

To iterate on a single step — or to re-shoot the screens, which the runner cannot do for this
product yet (it carries no stage recipe, so `--capture` falls back to rendering the committed
shots) — drive `ci-video` directly from this directory:

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the stage running (see below):
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-web-xr-scan-landscape.mp4 and out/ci-web-xr-scan-portrait.mp4
```

`npm install` here pulls video-kit from the private package registry and needs a token for it;
the runner above avoids that entirely by reading the package off disk.

## The stage

**One command, from the repo root.** [`scripts/video-stage.mjs`](../scripts/video-stage.mjs)
generates the fixtures, starts the Deno API on isolated data dirs, seeds world `default`, blocks
until every optimize job is `done`, and then runs Vite in the foreground. `Ctrl-C` tears both down.

```bash
node scripts/video-stage.mjs                       # Vite :5173, API :8000
# or, when other agents are staging apps at the same time:
VIDEO_PORT=5182 VIDEO_API_PORT=18182 node scripts/video-stage.mjs
```

Then, in this directory:

```bash
APP_URL=https://localhost:5182 npm run capture
```

Health-check the stage at `https://localhost:$VIDEO_PORT/health` — Vite proxies it to the API, so
one green response means both servers are up. Knobs: `VIDEO_PORT`, `VIDEO_API_PORT`, `VIDEO_SCANS`
(default 3), `VIDEO_DATA_DIR`.

The script also places the seeded homes **adjacent** rather than 122 m apart — see
[Framing the World Editor](#framing-the-world-editor) for why that is load-bearing rather than
cosmetic, and read its header comment before changing the layout.

<details>
<summary>The same stage by hand, in two terminals</summary>

```bash
# terminal 1 — the API, on isolated data dirs
npm run gen:test-data
INFERENCE_MODE=mock \
SCANS_DIR=/tmp/ci-video-scans \
WORLDS_DIR=/tmp/ci-video-worlds \
SUMMARIES_DIR=/tmp/ci-video-summaries \
  npm run server
COUNT=3 npm run seed:test-data     # three homes into world "default"

# terminal 2 — the app
TAILSCALE_HOSTNAME=localhost npm run dev -- --port 5173 --strictPort
```

By hand you must also place the homes adjacent yourself, or the World Editor shots reproduce the
122 m framing bug. Prefer the script.

</details>

Three things about the Vite command are load-bearing:

- **`TAILSCALE_HOSTNAME=localhost`** — `vite.config.ts` pins `server.allowedHosts` to a
  Tailscale name (resolved from the Tailscale CLI, falling back to a hard-coded `*.ts.net`
  host). Without the override Vite rejects a `localhost` Host header and every shot captures a
  blocked-request page instead of the app.
- **`--strictPort`** — Vite silently walks to 5174 if 5173 is busy, which would leave capture
  pointed at a dead port.
- **HTTPS, not HTTP** — Vite serves TLS with a self-signed cert when no Tailscale cert is
  present. `baseURL` is `https://localhost:5173`; the kit already sets `ignoreHTTPSErrors`.

**The API is required — do not delete it from the stage again.** An earlier revision of this file
said no backend was needed, which was true when the cut was five shots of the FTUE and the scanner.
It is not true now: `world-editor` and `semantic-world` read `/worlds/default`, and
`objects-named` and `review-and-export` need `/infer` to return detections. Deleting the server
does **not** fail the build — video-kit substitutes a branded "capture pending" slate for any shot
whose PNG is missing, so the cut would quietly hollow out instead.

**No models are needed, though.** `INFERENCE_MODE=mock` selects a colour-blob CV engine that only
needs jimp; `onnxruntime-node` is imported dynamically on the onnx path alone. The camera feed is
still this repo's own 8th Wall mock (`public/test-fixtures/xr8-mock.js`, loaded by `index.html`
when `?mock=xr8` is set), which flies a scripted camera through a synthetic room and emits SLAM
poses and feature points entirely client-side — and it paints the same CV palette the mock engine
recognises, so `/infer` returns the same objects every run.

`capture.config.mjs` short-circuits the API **write** routes (`/upload-scan`, `/ingest-video`, …).
That is load-bearing for byte stability, not just speed: an autosave upload would add a fourth scan
to world "default" carrying a live server-side timestamp, changing what the two World Editor shots
film. Read routes go to the real server.

`capture.config.mjs` also carries the full list of determinism hazards found in this app — read
its header before adding a shot.

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. They are the inputs, and they are the reason a render needs no stage.

`out/` is not committed, and no MP4 is stored anywhere else either. Re-shooting the screens after
a UI change is a deliberate act: run `npm run capture` against the stage, review the image diff,
and commit the shots like any other change.

### The landscape cut is complete; five portrait frames are deliberately not shot

All seventeen shots exist at 1280×720. The seven that had never been taken (`onboard-sweep`,
`live-scan-early`, `objects-manifest`, `review-panel-empty`, `world-editor-focus`,
`world-editor-points`, `world-editor-quality`) and the three that had gone stale
(`world-editor-scans`, `world-editor-semantic`, `review-export-panel`) were all shot against the
stage above. Two consecutive runs, on two independently built stages, produced **byte-identical**
PNGs for every one of them.

**Five 360×640 frames are missing on purpose** and render as the kit's "capture pending" slate:

| Not shipped | Why |
|---|---|
| `objects-manifest.mobile`, `review-panel-empty.mobile` | `#panel-content` is ~90 CSS px tall at 360×640 — the footer takes the rest — so the panel slices its own content mid-line. "No objects yet." is cut in half; the sofa card is cut through its description row. |
| `world-editor-focus.mobile`, `world-editor-points.mobile`, `world-editor-quality.mobile` | The World Editor has no 360 px layout. The sidebar takes the top two thirds, `#inspector-panel` lands on top of the world-stats overlay, and the semantic labels clip against the left edge of the canvas strip (`lamp 94%` → `%`). |

The rule this follows: a missing shot is a known gap, a bad shot is a lie that ships. Do **not**
"fix" these by re-running `capture` — the kit shoots both viewports for every shot, so a plain
`npm run capture` regenerates all five. Delete them again, or give the product a mobile layout.

Three portrait frames in the same family — `review-export-panel.mobile`,
`world-editor-scans.mobile`, `world-editor-semantic.mobile` — **were** re-shot and committed. They
have the same layout crowding, but they were already committed *and* the versions they replace
burned a live street-level `ENU … 37.775726, -122.418800` readout into the frame. Replacing a
coordinate leak with a crowded layout is strictly better; dropping them is better still, and is the
recommendation once someone decides the portrait cut can lose those beats.

### Framing the World Editor

The committed `world-editor-*` frames are a near-empty black viewport, and the cause is the
**seed**, not the camera code. `viewer.ts:428` already calls `fitCamera(worldGroup)` once the
scans load, so the camera is correctly framing the whole world — but `COUNT=3 npm run seed:test-data`
seeds three *different* test homes, and `src/shared/test-homes.ts:169` offsets each one by
`0.0011°` of latitude, about **122 m apart**. Three six-metre rooms spread over a quarter of a
kilometre is what fills the frame with black; the `50 m` scale bar in the committed shot is the
tell.

Two ways out, and they compose:

1. **What the storyboard now does.** `viewer.ts:431` selects the first scan on load, so
   `selectedTransformTarget` is set, and `#btn-reset-camera` therefore takes the
   `fitCamera(selectedTransformTarget)` branch (`viewer.ts:2289`) and frames that one room. Every
   viewer shot except `world-editor-focus` now clicks it. `world-editor-focus` needs no click:
   clicking a `.scan-item` calls `selectScan(id, true)` (`viewer.ts:511`), and `focus: true`
   already fits the camera to that scan.
2. **Better, and now what the stage does.** `scripts/video-stage.mjs` rewrites `geoLat`/`geoLng` in
   the seeded homes' metadata so the three rooms sit **9 m apart in one row** instead of 122 m
   apart in three postcodes. Nothing about the product is faked: the geo pose is fixture data and
   the viewer's geo→local assembly is untouched. What changes is that "every room you scan lands in
   one 3D world" becomes literally what the viewport shows — and the two off-camera rooms stop
   flinging their semantic labels into the top-right corner, where they used to land on top of
   `#inspector-panel` and cover its Size / Room / Floor values.

   Direction matters and was measured, not guessed: with `#btn-reset-camera` framing the
   auto-selected scan, neighbours stepped **west** stay inside the canvas, and neighbours stepped
   east, north or south fall behind the camera and out of frame entirely.

`map-quality` was the one shot expected to contradict its own narration, and it does not. The
seeded homes carry neither a reconstruction manifest nor a trained splat, so `quality-tier.ts:56-70`
lights **Preview** with the other two tiers dark — but it also renders the app's own next-step copy,
"Reconstruct from your keyframes to reach Reconstructed", under a three-step Preview → Reconstructed
→ Photoreal ladder. The narration is "every scan *can be* upgraded to a photoreal map", and a lit
first rung above the route to the other two is exactly that claim. Seeding a real Photoreal scan
(`npm run test:splat:make-fixture`) would show the end state instead of the path; it is not needed
to make the shot true. One blemish remains: at the sidebar's 280 px the middle step elides to
`Reconstr…` in the landscape frame. The portrait frame renders all three labels in full.

| Shot | Scene | What it caught |
|---|---|---|
| `onboard-sweep` | `ftue-permissions` | FTUE card 2 of 5, "Sweep the Room Slowly" |
| `live-scan-early` | `live-scan` | the HUD at `mockFreeze=90` — 2,110 pts, a `SPARSE` chip and "Low — keep scanning" |
| `objects-manifest` | `objects-named` | the side panel at the top of the object list: `4 OBJECTS`, `sofa 95%`, "large orange sofa, centre of frame", X·Y·Z |
| `review-panel-empty` | `review-and-export` | the same panel opened *before* the first capture — "No objects yet. Tap the capture button to scan." |
| `world-editor-focus` | `world-editor` | second scan picked: camera flown to it, Edit tab open on its transform and semantic tags |
| `world-editor-points` | `semantic-world` | the world drawn as a raw point cloud |
| `world-editor-quality` | `map-quality` | the Layers tab's Preview / Reconstructed / Photoreal stepper |

Six of the seven are one half of a two-shot scene — `live-scan-early`, `review-panel-empty` and
`world-editor-points` open their scene and dissolve into the committed shot; `onboard-sweep`,
`objects-manifest` and `world-editor-focus` are what the committed shot dissolves *into*. The
seventh, `world-editor-quality`, is the only shot of the new `map-quality` scene. Capturing them
is what turns those beats from a still into a state change.

Two things reviewers ask about, both checked against the pixels rather than assumed:

- **The mock is no longer visible in the frame.** `INFERENCE_MODE=mock` used to write
  `mock colour-blob detection (N samples)` into every detection's `description`, which the UI
  renders verbatim. `describeMockBlob` (inference.ts, PR #32) replaced it with a phrase built from
  the blob's own colour and bbox, inside the same 7-word contract the real engines follow. The
  shipped frames read "large orange sofa, centre of frame" — derived from the pixels, not a canned
  string, and no debug text anywhere in the shot.
- **The camera feed is synthetic and looks it.** Every scanner frame is
  `public/test-fixtures/xr8-mock.js` painting a flat-shaded room. That is the documented way to
  film AR without a phone; it is a stand-in for a camera, not a claim about output quality.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
