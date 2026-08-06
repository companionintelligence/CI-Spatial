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

From the **repo root**, **two** servers. Vite serves the app; the Deno API backs the World
Editor and the detections panel.

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

Then `npm run capture` in this directory.

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

### Shots still awaiting a capture run

Seven shots are declared in `storyboard.json` but have no PNG yet, so they render as the kit's
branded "capture pending" slate. The build passes either way — that is the point of the slate —
but the cut is not finished until these are shot. Each one needs the full stage below:

```bash
npm run capture -- --only onboard-sweep,live-scan-early,objects-manifest,review-panel-empty,world-editor-focus,world-editor-points,world-editor-quality
```

Three **committed** shots are also stale, because their `before` arrays changed after they were
taken. Re-shoot them in the same run:

```bash
npm run capture -- --only world-editor-scans,world-editor-semantic,review-export-panel
```

| Shot | Why it is stale |
|---|---|
| `world-editor-scans`, `world-editor-semantic` | now click `#btn-reset-camera` before the shutter (see "Framing the World Editor" below) and hide `#coord-readout` |
| `review-export-panel` | now hides `#scanner-action-rail` as well as `#hud-panel` — the floating rail was sitting on top of Generate Floor Plan, Object Report, Clear session and Start Live Stream |

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
2. **Better, if you are re-seeding anyway.** Seed rooms that belong to *one* home, adjacent in
   space, so "every room, one world" is literally what the viewport shows. That is the frame the
   `world-editor` scene is written for.

`map-quality` needs one more thing from the seed: the seeded homes carry neither a reconstruction
manifest nor a trained splat, so `quality-tier.ts:56-70` will light **Preview** with the other two
tiers dark, while the narration over it says "upgraded to a photoreal map". Seed a Reconstructed
and a Photoreal scan first (`npm run test:splat:make-fixture`) or the shot contradicts its own line.

| Shot | Scene | What it has to catch |
|---|---|---|
| `onboard-sweep` | `ftue-permissions` | FTUE card 2 of 5, "Sweep the Room Slowly" |
| `live-scan-early` | `live-scan` | the HUD at `mockFreeze=90` — a thin map, before the walk fills it |
| `objects-manifest` | `objects-named` | the side panel scrolled to the top of the object list |
| `review-panel-empty` | `review-and-export` | the same panel opened *before* the first capture |
| `world-editor-focus` | `world-editor` | second scan picked: camera flown to it, Edit tab open |
| `world-editor-points` | `semantic-world` | the world drawn as a raw point cloud |
| `world-editor-quality` | `map-quality` | the Layers tab's Preview / Reconstructed / Photoreal stepper |

Six of the seven are one half of a two-shot scene — `live-scan-early`, `review-panel-empty` and
`world-editor-points` open their scene and dissolve into the committed shot; `onboard-sweep`,
`objects-manifest` and `world-editor-focus` are what the committed shot dissolves *into*. The
seventh, `world-editor-quality`, is the only shot of the new `map-quality` scene. Capturing them
is what turns those beats from a still into a state change.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
