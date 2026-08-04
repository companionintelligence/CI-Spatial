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
 *  1. LIVE POINT COUNT — `#scan-stats` is written as `${pointCloud.count} pts`
 *     (src/main.ts:726). The mock accumulates points on a 33 ms setInterval, so
 *     the count is a function of how many ticks elapsed before the shutter, i.e.
 *     wall-clock timing. Verified NOT fixable by the frozen clock: the kit calls
 *     `context.clock.install()`, but Playwright's fake clock still advances
 *     timers in real time (measured: 45 vs 46 ticks over 1500 ms with and
 *     without install). MASKED.
 *
 *  2. HUD STATUS LINE — `#status-text` is rewritten every scanner tick by the
 *     quality monitor (src/main.ts:738-741, 776-781): it flips between
 *     "Tracking — tap to capture", "⚠ Moving too fast — slow down" and the top
 *     recommendation, depending on accumulated points and poses. MASKED.
 *
 *  3. VERDICT CHIP + COVERAGE — `#verdict-chip` flips between "✓ Ready",
 *     "⚠ Review" and "❌ Sparse" (src/main.ts:751-757) and
 *     `#quality-coverage-text` is a live percentage. Both track the same
 *     tick-dependent quality snapshot. MASKED.
 *
 *  4. GEOLOCATION — `#geo-chip` renders a reverse-geocoded street address and
 *     raw lat/lng to five decimals (src/main.ts:1138-1140). That is both
 *     non-deterministic AND a privacy leak: an unmasked capture would burn the
 *     developer's home address into a public product video. MASKED, and it
 *     should stay masked even once the HUD copy is pinnable.
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
 *     1.2 s later (main.ts:297, 398), so this is now live in two shots. MASKED in
 *     both. The prediction in the previous revision of this comment was correct.
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
