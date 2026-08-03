/**
 * Capture stage for Companion Scan (CI-Web-XR-Scan).
 *
 * `ci-video capture` drives the REAL app through this config. Companion Scan is
 * an AR app, so the interesting question is "how do you film AR without a
 * phone?" — and this repo already answered it: `public/test-fixtures/xr8-mock.js`
 * is a drop-in replacement for the 8th Wall engine, loaded by index.html when
 * `?mock=xr8` is present (index.html:37). It flies a scripted camera through a
 * synthetic 6x6 m room, emitting SLAM poses, world feature points and a fake
 * camera feed. Every shot in storyboard.json goes through it, which is why the
 * capture needs no device, no SLAM binary and no model.
 *
 * ── Stage ────────────────────────────────────────────────────────────────────
 *   TAILSCALE_HOSTNAME=localhost npm run dev      # Vite on :5173, HTTPS
 *   cd video && npm run capture
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
 *  6. DEAD API UPSTREAM — vite.config.ts proxies ~15 routes to a Deno server on
 *     :8000 that this stage deliberately does not run (nothing in the storyboard
 *     needs it). A proxied request to a dead upstream stalls until the proxy
 *     gives up, which delays `networkidle` and makes shutter timing jittery. The
 *     routes are short-circuited below so they fail fast instead.
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
 *  9. AUTOSAVE TIMESTAMP — `#autosave-status` can render `Autosaved … · ${time}`
 *     (src/main.ts:426), but only after a capture is resolved. No shot clicks
 *     `#capture-btn`, so it stays on the static "Autosave ready". If a future
 *     shot films the detections panel, mask it.
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

    // Hazard 6 — fail fast instead of hanging on the absent Deno API. These are
    // the vite.config.ts PROXIED_ROUTES that index.html can touch. Nothing here
    // fabricates data: every route the storyboard films is client-side only.
    await context.route(
      /\/(infer|health|upload-scan|upload-summary|ingest-video|ingest-photos|scans|process-scan|projects|worlds|scan-locations|sessions|jobs|client-logs)(\?|$)/,
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
