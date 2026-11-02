# Companion Scan review: UI, UX, icons, loading and test coverage (2026-11-02)

## Scope and method

- Covers the web app (`index.html`, `src/main.ts`, `src/ui`, `src/inference`), the service worker (`public/sw.js`), and the Capacitor shell (`mobile/`).
- Base: `origin/main` at `c7e5dec`, with this branch on top.
- UI: a review in Chromium at 390×844 against the dev server, using the mock AR runtime (`?mock=xr8`) and the real start path. The start screen was measured with an iPhone user agent; the HUD, panel and history drawer with a desktop Chrome one. No real iPhone or Safari was used, so iOS behaviour is unverified.
- Follow-up pass: the items that needed no owner decision were fixed, then measured with a temporary probe spec. The probe was deleted before the commit and is not part of this branch.
- Coverage: a read of the suites plus grep counts. The repo has no coverage tooling, so there are no coverage percentages.
- Items marked **(review)** come from the review's own reading and were not re-checked, unless the follow-up table says otherwise.

## What changed on this branch

### Icons and launch screens

- The icons are drawn from `public/ci-logo-mark.svg` by `npm run gen-icons`. The script replaces `scripts/generate-icons.mjs`, which drew the scanner reticle by hand. The old script is in git history.
- Web: `icon-192.png` and `icon-512.png` (purpose `any`), `icon-maskable-512.png` (purpose `maskable`, with the mark inside the safe circle), and `apple-touch-icon.png` at 180 px. The manifest now declares the three separately. The old manifest declared one image as `any maskable`, which Android crops badly.
- iOS: a 1024 px app icon and launch images, all opaque RGB, because App Store builds reject an alpha channel. The launch storyboard background is the night-space colour, not white.
- Android: launcher, round and adaptive foreground icons for each density, and splash images for each portrait and landscape bucket. The Android 12+ splash background is `#041620`. Two unreferenced Capacitor vector drawables were removed.
- One background colour, `#041620`, is used by the manifest, the HTML theme colour, the Capacitor config, both launch screens and the generator. `tests/unit/node/app_icons.test.ts` fails if they drift apart.

**Decision for the owner:** the app icon is now the Companion mark. The scanner reticle is in git history if you want it back.

### Loading

- Web: the start button reads "Preparing…" until the app module boots. If it has not booted after 10 seconds, the line reads "Still loading. Reload to try again." This is a small inline script in `index.html`.
- Native: the launch screens are dark, so there is no white flash before the app appears.

### UI fixes from the review (first commit)

| Priority | Finding | Fix | Checked by |
| --- | --- | --- | --- |
| P0 | The side panel's close button and top rows sat under the help button and the scanner rail. | Panel z-index 18. The help button steps aside while the panel is open (`setOpen` sets `body.side-panel-open`). | `mock-ux-review.spec.ts` |
| P0 | A blank new-place Save wrote its error into the location card, which the popup covers, so nothing visible happened. | The error shows under the Save button in `#place-new-status`. | `mock-ux-review.spec.ts` |
| P1 | No way back from the Place picker except "Skip for now", which starts the scan. | Back button. It closes the picker and does not start AR. | `mock-ux-review.spec.ts` |
| P1 | A failed place-list load looked like "no places". | "Couldn't load your places. Try again." | Code only |
| P1 | A 502 from the proxy showed "Capture failed — try again". | A 502 is a network failure: "Server unreachable", retried. | `inference_server_errors.test.ts` |
| P1 | An upload 5xx showed "Upload failed (502)". | "Upload failed: server unreachable, try again later". The "Upload failed" prefix is kept for the video progress line. | Code only |
| P1 | The first-run copy promised a tap that never happens ("Tap Allow when your phone asks"). | "Your phone asks when you start." Same word count, so the first-run word budget is unchanged. | `mock-ux-review.spec.ts` |
| P1 | The gimbal link (`localhost:8787`, on the visitor's own phone) was visible to every visitor. | Hidden. Remove the `hidden` attribute to show it again. | `mock-ux-review.spec.ts` |
| P1 | Touch targets under 44 px: help button, Menu, onboarding Skip, place Save and Skip, popup Close. | Raised to 44 px. | Code only |
| P2 | The Place Scan Editor card's accessible name did not match what it shows. | "Place Scan Editor. Explore and edit existing places." | `mock-ux-review.spec.ts` |
| P2 | The AR-unavailable banner was titled "Permission Access Required". | "AR is not available". | Code only |

### Follow-up fixes (second commit)

Each row was measured before and after with the same probe, at 390×844.

| Finding | Fix | Checked by |
| --- | --- | --- |
| P1: panel controls under 44 px. Close ✕ 36 px; Export Summary, Generate Floor Plan, Scene Description, Object Report, Clear session and Download 40–42.5 px; Server and On-device 38 px. | Minimum 44 px: `.panel-btn-ghost`, `.ci-toolbar-pill`, `.ci-icon-btn--sm`. The history list buttons share the last class, so they are 44 px too. | `mock-ux-review.spec.ts`. Probe after: no control under 44 px on the start screen, HUD, panel or history drawer. |
| P1: rail buttons under 44 px (review) | Not reproduced. The rail buttons are 48 px. | Probe: none under 44 px in the HUD. |
| P1: onboarding is not a dialog and does not move focus (review) | `role="dialog"`, `aria-modal="true"`, `aria-label="Getting started"`. Focus moves to Next when the overlay opens. Before: no role, focus on `body`. After: dialog, focus on Next. | `mock-ux-review.spec.ts`; probe. |
| P2: disabled Export buttons give no reason (review) | A visible hint, "Export unlocks after you scan an object.", shows while the export actions are disabled. Each disabled control has `aria-describedby` pointing at it. | `mock-ux-review.spec.ts`; probe: 5 of 5 disabled controls point at the hint. |
| P2: small low-contrast text on the dark background (review: 10 px at 25–45% alpha) | Raised to 60% alpha. Panel: scan-flow steps, section labels, AI note, model status, "No objects yet", the XYZ readout. HUD: autosave, "Latest scan", its close ✕. History: empty state, and the Leaflet attribution and its links. Before: the lowest were 2.22:1 (AI note), 2.64:1 (attribution), 2.67:1 (section labels) and 3.08:1 (scan-flow steps). After: no text under 4.5:1 in the HUD, panel or history drawer (measured). | Probe, on each element's real background. |
| P3: the rail is a plain `div` with an `aria-label` (review) | `role="group"`, with the same label. | Markup. |
| P2: "Server uses all machine cores" (review: jargon) | "Runs on the scan server", shown in server mode. | Copy. |
| P3: "unknown size" in the model download line (review) | "size not reported". | `tests/unit/node/model_provisioning.test.ts` (9 pass). |

Not changed: the disabled controls keep their dimmed look (`.panel-btn-ghost:disabled`, documented in `index.html`). WCAG exempts inactive controls from the contrast rule.

### Still open

These need a product or design decision, or more work than a low-risk fix.

- **P0:** a place cannot be saved without coordinates, even when it has a name. Product decision.
- **P1:** taps before the app boots are dropped. Holding a tap until boot would be wrong: iOS only shows the motion permission prompt from a user gesture, so the request would run outside one.
- **P1:** the first-run status rows show "Status unavailable." when the server is down. Hide them or keep them? Product call.
- **P1:** the icon-only scanner rail buttons have no visible labels. Design call. They do have accessible names.
- **P2, verified:** the "Other ways" control shifts the start cards on boot. The editor card moves from 429.4 px to 446.7 px to 450.7 px over the first half second, once the cards above it render. Options: hold the cards until the capture choice is known (a blank start area for about half a second), or accept the shift. Owner decision.
- **P2:** the history map shows a CARTO "API key required" watermark. Check production, then decide the basemap key. Not changed.
- **P2:** the "Reflections" chip (`#quality-refl-badge`) needs wording the owner is happy with. Not changed.
- **P2:** "Menu" opens Review & Export. Kept on purpose: `src/main.ts` documents that the navigation-only controls, including `finish-scan-btn`, are deliberately left alone.
- **P2:** onboarding focus is not returned to the start button when the overlay closes. Not changed.
- **P3, verified:** the compass "N" is a 4-unit SVG label in a 30 px ring (about 3×5 px). It sits under the needle's tip when the phone faces north, so a bigger N needs a layout change to the ring. Not changed.
- **P3:** the compass "N" and the model line are the only other small items. Disabled Export buttons, the Leaflet links and the `Menu` label are covered above.

## Test coverage

### Counts and what runs

- Playwright: 37 spec files. Node: 33 test files. Deno: 47 test files. The test-call counts (339 Playwright, 499 Node, 709 Deno) are from the review's grep **(review)**.
- No coverage tooling exists: no c8, nyc, istanbul, or coverage config.
- `deno-ci.yml` and `docker-publish.yml` are `workflow_dispatch` only. Nothing runs on push or PR. The README said CI ran on every push and PR. That was wrong and is fixed.
- The pre-push hook runs `npm run verify`, not Playwright. It is enabled per clone with `git config core.hooksPath .githooks`, which `npm ci` also sets through its `prepare` script.
- The Playwright suites run only by hand.

### Fixed on this branch

- `scan_coherence.test.ts` (35 tests) was not run by `verify`. It now is.
- New suites, all in `verify` except the UX spec: icon contract (8), service-worker queue policy (5), mobile shell config (4), inference error classification (2), and a Playwright UX regression spec (9, three added in the follow-up).
- The model download copy now has its own test (9 node tests in `model_provisioning.test.ts` pass).
- Stale claims corrected: the README's CI trigger, the README's spec and node-suite counts, and the comment in `tests/server.spec.ts` that said "once per CI run".

### Open gaps, ranked

1. The phone's keyframe and clip uploads (`src/capture/keyframes.ts`, `POST /sessions/:id/keyframes`) are not asserted anywhere **(review)**.
2. The offline flush (`runQueueFlush` in `public/sw.js`: the retry statuses, the five-attempt drop and the 24-hour expiry) needs IndexedDB. The new policy suite pins the constants. The flush itself is untested.
3. The offline queue is tested end to end only for `/upload-scan`. The other queued routes are covered by the policy suite only **(review)**.
4. `POST /client-logs` has a rate limit and a 16 KB cap, and no test (`server/main.ts`) **(review)**.
5. The export-state tests are red or depend on the environment. `tests/known-failures.json` records the 2026-08-29 run **(review)**.
6. The live-feed (WebRTC) tests are red or gated. The server returns 404 to phone and viewer roles unless `VITE_ENABLE_WEBRTC_LIVE=true`, and no spec sets it **(review)**.
7. The mobile shell's config is covered. Native builds are not run anywhere in CI.
8. Two other suites were reported to have no runner in `verify`: `tests/unit/python/test_torch_device.py` and `subsystems/4d-capture` tests **(review, not checked here)**.

### Weak tests (review, not fixed)

- `tests/ar-scan.spec.ts:382` swallows an assertion with `.catch(() => {})`.
- `tests/ar-scan.spec.ts:102–104` checks that `sw.js` contains three strings, rather than behaviour.
- `tests/mock-ui-mobile.spec.ts` rewrites PNGs under `docs/ui-flow/mobile` on every run.
- Several 150-second timeouts (`mock-pin-edit`, `mock-rtc-robustness`, `mock-export-outcome`), and `retries: 1` in `playwright.config.ts`, mean a flake that passes on retry still exits 0.
- `tests/unit/node/viewport_zoom.test.ts` regex-matches source text, so dead markup passes.
- Hard-coded tailnet hostnames in `tests/ar-scan.spec.ts`, `tests/server.spec.ts`, `tests/project.spec.ts` and `tests/e2e-suite.spec.ts`. `npm test` cannot run elsewhere without `VITE_URL`.

## Verification on this branch

- Node suites, all passing: startup budget (11), FTUE status (9), app icons (8), service-worker queue (5), mobile shell config (4), inference errors (2), scan coherence (35), model provisioning (9).
- `tsc --noEmit` and `npm run typecheck:tests`: pass.
- Playwright, `chromium-mock`, UX regression spec: 9 of 9.
- Full `chromium-mock` suite on this branch: 43 passed, 30 failed, 2 flaky, 32 skipped, 15 did not run (15.2 min). Of the 30 failures, 28 call server routes that are not running here: `/infer` (9 tests), `/projects` (11 two-point calibration tests), the WebRTC relay (6 live-feed tests) and `/ingest-video` (2 upload tests). One is the desktop editor overview, which never found its scan list (cause not checked). The last is `mock-ui-mobile` '06 place picker', which also failed on origin/main in the earlier check. The two flaky tests (FTUE 'points accumulate' and the UX spec 'side panel takes the taps') failed on the first attempt, passed on retry, and pass when run alone. The server attribution comes from the error messages; the full suite has not been run on origin/main.
- Probe measurements (follow-up): before and after values are in the follow-up table. The probe was temporary and is not committed.
- Not run: the WebKit projects, and the live-server specs.

**Environment note.** On this Mac, Homebrew has `vips` 8.18.6 installed. sharp 0.34.5's install check then decides to build from source, which needs node-gyp, so `npm ci` exits 1 in its `install` step. This is the install failure the ci-local gate reported. `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci` makes sharp use the prebuilt binary from the lockfile. The fix is local to the environment; the repo is unchanged. The same failure leaves `node_modules` half-installed, which breaks Playwright with a misleading "two different versions of @playwright/test" error.

## Decisions for the owner

1. App icon: the Companion mark (this branch) or the scanner reticle (git history).
2. Place creation: require coordinates even when a name is given?
3. First-run status rows when the server is down: hide them, or keep "Status unavailable."?
4. CI: keep the gates manual-only, or run `verify` on push and PR?
5. Gimbal link: keep it hidden until a gimbal is configured?
6. "Other ways": hold the start cards until the capture choice is known, or accept the shift?
7. Compass "N": a bigger label needs a layout change to the 30 px ring. Do it now, or leave it?
8. "Reflections" chip: which wording?
9. CARTO watermark on the history map: check production, then decide the basemap key.
