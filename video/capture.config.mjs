/**
 * Capture stage for Companion Scan (CI-Web-XR-Scan).
 *
 * `ci-video capture` drives the REAL app through this config. Companion Scan is
 * an AR app, so the interesting question is "how do you film AR without a
 * phone?" — and this repo already answered it: `public/test-fixtures/xr8-mock.js`
 * is a drop-in replacement for the 8th Wall engine, loaded by index.html when
 * `?mock=xr8` is present (index.html:37). It flies a scripted camera through a
 * synthetic 6x6 m room, emitting SLAM poses, world feature points and a fake
 * camera feed. Every `/?mock=xr8` shot goes through it, which is why the capture
 * needs no device, no SLAM binary and no downloaded model.
 *
 * ── Stage ────────────────────────────────────────────────────────────────────
 * TWO servers, not one. Vite alone is no longer enough: the storyboard now films
 * the World Editor and the detections panel, and both are backed by the Deno API.
 *
 *   # terminal 1 — the API, on isolated data dirs so the checkout stays clean
 *   npm run gen:test-data
 *   INFERENCE_MODE=mock \
 *   SCANS_DIR=/tmp/ci-video-scans \
 *   WORLDS_DIR=/tmp/ci-video-worlds \
 *   SUMMARIES_DIR=/tmp/ci-video-summaries \
 *     npm run server                            # Deno on :8000
 *   COUNT=3 npm run seed:test-data              # three homes into world "default"
 *
 *   # terminal 2 — the app
 *   TAILSCALE_HOSTNAME=localhost npm run dev    # Vite on :5173, HTTPS
 *
 *   cd video && npm run capture
 *
 * `INFERENCE_MODE=mock` keeps this cheap and deterministic: the mock engine is a
 * colour-blob CV detector (inference.ts:223 `_inferMock`) that only needs jimp —
 * `onnxruntime-node` is dynamically imported on the onnx path alone
 * (inference.ts:159), so there is no model download and no GPU. It recognises the
 * shared CV palette, which is exactly what the xr8 mock paints, so `/infer`
 * returns the same objects every run.
 *
 * The isolated `*_DIR` overrides (main.ts:68-71) are not cosmetic: `worlds/default.json`
 * is a tracked file and `scans/` churn under the checkout is what vite.config.ts:126-133
 * already guards against. Seeding into /tmp keeps the capture from dirtying the repo.
 *
 * `TAILSCALE_HOSTNAME` is NOT optional. vite.config.ts:96 sets
 * `server.allowedHosts: [HOSTNAME]`, and HOSTNAME is resolved (vite.config.ts:17-45)
 * from the Tailscale CLI, falling back to the hard-coded `liambook.capybara-ulmer.ts.net`.
 * Without the override, Vite rejects a `localhost` Host header outright and every
 * shot fails on a blocked-request page rather than a timeout.
 *
 * ── Determinism hazards found in this app ────────────────────────────────────
 * Shots are committed, so a rerun on unchanged UI must produce identical bytes.
 * Each of these was verified against the source, not assumed:
 *
 *  1. THE WHOLE SCANNER USED TO TRACK WALL TIME — everything the xr8 mock emits
 *     is a pure function of its `tickCount`: currentPose(), worldPoints(),
 *     trackingStatus() and hitTest() derive from it and nothing else. But the
 *     mock advanced it on a 33 ms setInterval, so "wait 2500 ms, then shoot"
 *     photographed a different pose every run — and everything downstream moved
 *     with it: `#scan-stats` (`${pointCloud.count} pts`, src/main.ts:726), the
 *     `#verdict-chip` verdict (src/main.ts:751-757), the coverage percentage,
 *     and the per-object coordinates in the side panel and the Latest-scan
 *     readout. Masking could not fix this and never did: Playwright sizes a mask
 *     rectangle to the masked element's bounding box, so a mask over
 *     variable-width text has a moving EDGE — measured as a live drift band at
 *     CSS x 247-252 on live-scan-hud.
 *
 *     Fixed at the source instead: every scanner shot loads
 *     `?mock=xr8&mockFreeze=700`, which pins the session to tick 700 before the
 *     first frame is emitted (public/test-fixtures/xr8-mock.js). Frames keep
 *     flowing — they must, because a capture is only fulfilled by the NEXT
 *     onProcessCpu (src/ar/eighthwall.ts:196) — but every frame is now identical,
 *     so the app's accumulated state converges instead of tracking the clock.
 *     Measured: 4 consecutive runs agree on point count, verdict, coverage and
 *     every detection coordinate, to the byte. No HUD mask is needed any more.
 *
 *     The freeze must happen inside XR8.run(), not from a `before` action:
 *     RoomScanner starts its own 750 ms accumulation interval moments after
 *     (src/ar/scanner.ts:49), and one scanner tick against a still-moving pose is
 *     enough to change the count. That is why it is a URL parameter.
 *
 *     `?mockFreeze=700` is also an editorial choice — 700 is where the scripted
 *     walk reads as a real session (14,235 points, "Good" coverage, 66% bar)
 *     rather than the thin 48-point map the old 2500 ms wait caught.
 *
 *     THE FREEZE TICK IS THE ONLY HONEST WAY TO FILM "the map fills in". The
 *     `live-scan` scene now cross-dissolves two shots of the same HUD at two
 *     points in the SAME scripted walk: `live-scan-early` at `mockFreeze=90`
 *     (three seconds in — a thin map and whatever quality recommendation the app
 *     genuinely raises for it) and `live-scan-hud` at `mockFreeze=700`. Both are
 *     pinned sessions, so both are byte-stable, and the difference between them
 *     is the app's own accumulation rather than a staged screenshot. Do not try
 *     to get the same contrast with a wall-clock `{ wait: … }` — that is exactly
 *     the drift this hazard was written about.
 *
 *  2. THE 750 ms SCANNER INTERVAL, NOT THE MOCK, FILLS THE MAP — RoomScanner
 *     harvests points on its own timer, so the shutter can fire before the first
 *     harvest and photograph an empty `#scan-stats`. Every scanner shot therefore
 *     waits on `#scan-stats:has-text('pts')` rather than on a settle time.
 *
 *  3. FROZEN MEANS FROZEN, SO THE MAP HAS TO ARRIVE AT ONCE — a frozen session
 *     re-emits one 24-point batch forever and the voxel grid dedupes it, which
 *     would peg the map at 24 points however long the capture waited. freezeAt()
 *     therefore hands over every batch the session would have emitted up to the
 *     frozen tick. The map fills on the first harvest and never changes again.
 *
 *  4. GEOLOCATION — `#geo-chip` renders a reverse-geocoded street address and
 *     raw lat/lng to five decimals (src/main.ts:1138-1140). That is both
 *     non-deterministic AND a privacy leak: a capture on a machine that grants
 *     geolocation would burn the developer's home address into a public product
 *     video. HIDDEN, not masked — a mask is an opaque #0A222E rectangle sitting
 *     in the middle of the HUD, and hiding gives the same guarantee with no box.
 *     It must stay suppressed even once the HUD copy is pinnable.
 *
 *  5. ONBOARDING IS ONCE-ONLY — the FTUE overlay is gated on the
 *     `companion-scan-onboarded` localStorage key (src/main.ts:498, 543). The
 *     kit reuses ONE page across all shots in a viewport, so a shot that
 *     finished onboarding would silently blank the FTUE shots that follow. The
 *     init script below clears the key before every navigation, which makes the
 *     three FTUE shots order-independent. (The storyboard also never clicks
 *     past step 5, so the key is never set in the first place — belt and braces.)
 *
 *  6. THE API IS NOW REQUIRED — this used to say "the Deno API is deliberately
 *     not run". That is no longer true, and re-deleting the server will silently
 *     hollow out four shots rather than fail the build: viewer.ts:403 GETs
 *     /worlds/<slug> and writes "Failed to load world: …" into #viewer-placeholder
 *     on failure, /infer returning 503 gives #capture-btn zero detections, and
 *     video-kit substitutes a branded "capture pending" slate for any shot whose
 *     PNG is missing — so a dead backend still builds green. Only the WRITE
 *     routes are short-circuited below (see hazard 11); reads go to the live API.
 *
 *  7. SELF-SIGNED HTTPS — Vite serves HTTPS via @vitejs/plugin-basic-ssl when no
 *     Tailscale cert is present (vite.config.ts:70-76). The kit already sets
 *     `ignoreHTTPSErrors: true` on every context, so no action is needed here —
 *     noted only so the next person does not go hunting for a cert.
 *
 *  8. CANVAS — `#camerafeed` is painted by the mock through a 2D context with
 *     solid rects and one vertical gradient (xr8-mock.js `drawScene`). The
 *     drawing does not depend on tick count, so the feed is stable frame to
 *     frame. It is still GPU-rasterised, so a macOS-vs-CI-Linux diff of a few
 *     bytes in the gradient is possible; that is the known kit-wide caveat and
 *     is not worth masking the hero image over.
 *
 *  9. AUTOSAVE TIMESTAMP — `#autosave-status` renders `Autosaved … · ${time}`
 *     from a live `toLocaleTimeString` (src/main.ts:426). The `objects-named` and
 *     `review-and-export` shots DO click `#capture-btn`, which queues an autosave
 *     1.2 s later (main.ts:297, 398), so this is live in two shots. Not a hazard
 *     in practice — `fixedTime` below pins the clock, and it renders the same
 *     "· 03:04 PM" on every run (measured) — but both shots suppress the whole
 *     `#hud-panel` anyway, for the reason in hazard 12.
 *
 * 10. VIEWER NAVIGATION IS GUARDED — do not reach viewer.html by clicking
 *     `#viewer-link` or `#xr-mode-link`. src/main.ts:601-612 wraps both in
 *     `confirm('Leave scan? Unsaved progress will be lost.')` whenever
 *     hasUnsavedData() is true (pointCloud.count > 0, i.e. after any live-scan
 *     shot), Playwright auto-dismisses dialogs, so confirm() returns false and
 *     preventDefault() cancels the navigation. The shot would then silently
 *     photograph the scanner again instead of the editor — a wrong picture, not a
 *     failure. A `beforeunload` handler (main.ts:594-600) sits on the same
 *     condition, and the kit reuses ONE page per viewport (capture.mjs:180-186),
 *     so the state persists across shots. Both viewer shots therefore use an
 *     explicit `capture.path` of "/viewer.html?world=default".
 *
 * 11. NO SHOT MAY MUTATE THE WORLD — `world-editor` and `semantic-world` film
 *     `#scan-list`, whose rows are the scans in world "default". Two write paths
 *     would otherwise change what they show, mid-run and between the two viewport
 *     passes: autosave POSTs /upload-scan (main.ts:424, `upload: true`), and
 *     /ingest-video registers a session-backed scan. Both render a `.scan-meta`
 *     line built from `capturedAt`, which for a seeded home is the generator's
 *     FIXED_TIMESTAMP (scripts/generate-test-homes.mjs:111) but for a runtime
 *     upload falls back to `uploadedAt = new Date()` (main.ts:1203, 1238) — a
 *     live wall-clock string that the browser-side frozen clock cannot reach,
 *     because it is minted server-side in Deno. Blocking the write routes below
 *     is therefore load-bearing for byte stability, not just for speed: it pins
 *     the world at exactly the three seeded homes for every shot and both
 *     viewports. Read routes (/infer, /worlds, /scans, /sessions, /jobs,
 *     /scan-locations, /health) must pass through.
 *
 * 12. A MASK IS DRAWN OVER THE PAGE, NOT INSIDE THE ELEMENT — Playwright sizes
 *     each mask rectangle to the masked element's bounding box and paints it on
 *     top of the finished screenshot, ignoring both z-order and scroll clipping.
 *     Two shots were ruined by that and it is easy to do again:
 *       · `#panel-content [data-key] div[style*="monospace"]` matched all four
 *         detection-card position badges, but `#panel-content` is a 311x164
 *         scroll box: the three scrolled-out badges still have layout boxes at
 *         y 306 / 430 / 553, which is where the footer's Export Summary, Scene
 *         Description and Clear session buttons are. They were painted over.
 *       · At 360 px the side panel is 309.6 px wide and covers the HUD, but the
 *         HUD's boxes are still where they were, so every scanner mask landed on
 *         the panel — `#autosave-status` sat squarely on the Export GLB CTA.
 *     Rule of thumb: if the element you want to suppress is BEHIND the subject or
 *     CLIPPED out of it, hide it with a `<style>` rule from an `eval` action;
 *     masks are only safe over something that is actually visible and on top.
 *
 *     Corollary for the three panel shots (`objects-manifest`,
 *     `review-panel-empty`, `review-export-panel`): a CLOSED `#side-panel` is
 *     `transform: translateX(100%)` (index.html:770), not `display:none`, so
 *     Playwright still calls its contents visible and `#panel-content [data-key]`
 *     resolves before the panel is opened. That is why each of those shots
 *     asserts the OPEN state explicitly — `#side-panel.open #…` — instead of
 *     trusting the inner selector. Without the `.open` prefix the shutter can
 *     fire on a panel that is still sliding in, or never opened at all.
 *
 * 14. THE HUD RECOMMENDATION LINE IS A REAL PRODUCT STRING, NOT DEBUG OUTPUT —
 *     `#status-text` is overwritten with `recommendations[0]` on every scanner
 *     tick whenever the scan is not "ready" (src/main.ts:779-781), and
 *     src/capture/quality-monitor.ts:176 unconditionally appends "Stream RGB
 *     keyframes for reconstruction and splat processing." while
 *     `keyframeCount === 0`. No scanner shot starts keyframe streaming, so on a
 *     scan with no other complaint that nag is the whole HUD headline. It is
 *     honest — the app really does say it — but it is off-message for a scene
 *     about coverage, which is why `live-scan` leads on the thin-map shot, where
 *     the coverage recommendation outranks it. If a future shot needs the
 *     keyframe line gone, start the stream (`#stream-btn`) rather than editing
 *     the DOM: a staged status line is a lie about the product.
 *
 * 15. DO NOT MEASURE THE SEMANTIC LABELS IN THE RENDER LOOP — viewer.ts
 *     updateLabels() runs every frame, so an offsetWidth/getBoundingClientRect
 *     read there forces a synchronous layout mid-frame. A layout forced inside
 *     the Manrope swap window bakes a slightly different text shaping, and
 *     every chip then lands about a third of a pixel off. It looks like nothing
 *     and it is not the GPU noise in hazard 13: measured as ~2,800 differing
 *     pixels between a capture on a COLD Vite module graph and one on a warm
 *     graph, while four consecutive warm runs agreed to the byte. That is the
 *     dangerous shape — a first-run-only diff reads as a fluke.
 *
 *     A first attempt cached the measurement instead, which froze page-load
 *     timing into the layout and failed the same way. Batching every read into
 *     one per frame also failed. What works is not reading at all: a chip whose
 *     anchor is inside the edge zone gets `data-pin="left"|"right"` and CSS
 *     aligns it away from that edge using the browser's own width
 *     (`.label3d[data-pin]`, viewer.html). The loop writes and never reads.
 *
 * 16. THE E2E SUITE WRITES INTO THE STAGE'S WORLD — `npm run test:mobile` (and
 *     the other browser projects) POST real scans to whatever VITE_URL points
 *     at. Pointed at this stage, they leave world "default" holding two dozen
 *     scans named `list-test`, `order-a`, `upload-basic`, … each rendering
 *     "Error: Scan GLB has no scene graph", and every later viewer capture then
 *     films "8 scans loaded / 0 points" instead of the three seeded homes. The
 *     route blocker below only guards the CAPTURE browser; it cannot guard
 *     another process. Restart the stage (it wipes VIDEO_DATA_DIR on boot)
 *     before re-shooting anything after a test run.
 *
 * 17. A SEMANTIC CHIP OVER THE CANVAS RASTERISES DIFFERENTLY PER BROWSER
 *     PROCESS — this is hazard 15's sequel, and it survived hazard 15's fix.
 *     The chips are the only text in the app that sits ON TOP of a WebGL
 *     surface, so Chromium decides per process whether to promote each one to
 *     its own compositing layer, and that decision changes how its glyphs are
 *     rasterised. Same box, same border, same metrics — the text run alone
 *     shifts about 0.6 device px, which is a ~4,000-pixel diff at deltas up to
 *     250 and looks exactly like a real UI change.
 *
 *     It is invisible from inside one browser, which is what made it expensive:
 *     six fresh page loads in ONE browser agree on every chip's style.left,
 *     getBoundingClientRect() to 4dp and width, and 200 consecutive frames of
 *     one load produce one framebuffer hash. Only a fresh process disagrees.
 *     Reproduce it by re-running `ci-video capture` (a new browser each time) —
 *     never by reloading a page.
 *
 *     Fixed at the source: `.label3d { will-change: transform }` in viewer.html
 *     makes the promotion unconditional. Measured 2026-08-08, 5 fresh browsers
 *     per condition against one staged world: unmodified 3 distinct frames;
 *     chips hidden 1; canvas hidden 1; blur removed 3; every chip snapped onto
 *     whole device pixels 3; will-change 1. Each half is byte-stable alone —
 *     only the composite moved.
 *
 *     Do NOT reach for `mask` here. On `world-editor-semantic` the labels ARE
 *     the shot, and mask paints solid #0A222E over whatever it covers. Nor for
 *     a longer `settle`: nothing is still moving to settle.
 *
 * 13. THE 3D VIEWPORT IS NOT BIT-REPRODUCIBLE, AND THAT IS THE FLOOR — both
 *     World Editor shots film `#viewer-canvas`, a WebGL surface. Two things used
 *     to move inside it and are now fixed at the source:
 *       · every semantic label was created three times, once per LOD level, and
 *         the copies painted in scan-load-completion order (viewer.ts
 *         createSemanticLabels / upgradeSemanticMeshes; assets.ts:18 resolves the
 *         high-detail level on a timer). One label per object now, painted in
 *         metric depth order.
 *       · `{ wait: 8000 }` was a wall-clock race against the seed's background
 *         optimize jobs: when one finishes, handleJobUpdate re-runs
 *         loadScanIntoWorld and swaps the geometry mid-capture (viewer.ts:2495).
 *         Both shots now wait for all three rows to read "Ready - optimized",
 *         which is only set after the full-quality GLB is in the scene.
 *     The heading is now too pessimistic, and believing it cost a week: with the
 *     chips hidden, 5 fresh browsers rendered the canvas alone byte-identically
 *     on macOS, and after hazard 17 three consecutive FULL captures agreed on
 *     all 30 committed PNGs. The residual 7-35 pixels at a delta of 1-4 levels
 *     recorded here was the chip drift of hazard 17 caught at its small end, not
 *     a GPU floor.
 *
 *     So do not read a viewer-shot diff as noise by size. The expectation is
 *     zero differing pixels; a diff of ANY size is a claim about the product
 *     until someone re-runs the capture and shows it reproducing. If a genuine
 *     rasterisation floor ever does appear on other hardware, record the numbers
 *     here rather than widening this sentence.
 */
export default {
  // HTTPS, not HTTP: vite.config.ts pins `server.https` on (Tailscale cert if
  // present, self-signed otherwise) and `server.port: 5173`.
  baseURL: process.env.APP_URL ?? "https://localhost:5173",

  // CI apps are dark-first. Companion Scan's HUD is dark-only, so this matches
  // what a user actually sees. Pinned locale/timezone/clock keep captures stable.
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: "2026-06-15T15:04:00Z",

  // No auth: index.html has no login wall. Portal OIDC (portal_auth.ts) guards
  // server-side routes only, none of which any shot touches.
  // storageState: "./.auth/state.json",

  async onContext(context) {
    // Hazard 5 — always present the first-run FTUE. Runs before page scripts on
    // every navigation, so shot order cannot leak state between FTUE shots.
    await context.addInitScript(() => {
      try {
        localStorage.removeItem("companion-scan-onboarded");
      } catch {
        /* about:blank has no accessible storage — ignore */
      }
    });

    // Hazards 6 + 11 — the API is live, so this is now a WRITE blocker, not a
    // dead-upstream shim. Every route listed here would persist something into
    // SCANS_DIR / WORLDS_DIR and change what the two World Editor shots film;
    // none of them is the subject of any shot. Reads are deliberately absent
    // from this list and go to the real server.
    //
    // Keep the `(\?|$)` tail: it matches the bare endpoint only, so a genuine
    // read like /scans/home-01-....glb or /worlds/default is never caught.
    await context.route(
      /\/(upload-scan|upload-summary|ingest-video|ingest-photos|process-scan|client-logs)(\?|$)/,
      (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );

    // Warn loudly if an external asset fails — an unstyled capture looks like a
    // UI regression but is really a network failure.
    context.on("requestfailed", (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\.|unpkg|jsdelivr/.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });
  },
};
