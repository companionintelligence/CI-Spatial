# Companion Scan review: UI, UX, icons, loading and test coverage (2026-11-02)

## Scope and method

- Covers the web app (`index.html`, `src/main.ts`, `src/ui`, `src/inference`), the service worker (`public/sw.js`), and the Capacitor shell (`mobile/`).
- Base: `origin/main` at `c7e5dec`, with this branch on top.
- UI: a review in Chromium at 390×844 (iPhone user agent) and 1280×800, against the dev server, using the mock AR runtime (`?mock=xr8`) and the real start path. No real iPhone or Safari was used, so iOS behaviour is unverified.
- Coverage: a read of the suites plus grep counts. The repo has no coverage tooling, so there are no coverage percentages.
- Items marked **(review)** come from the review's own reading and were not re-checked here. Everything else was checked against the code or the test run.

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

### UI fixes from the review

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

### Still open

These need a product or design decision, or more work than a low-risk fix.

- **P0:** a place cannot be saved without coordinates, even when it has a name. Product decision.
- **P1:** taps before the app boots are dropped. The button stays disabled until boot, and only the timeout message is new. Queuing early taps is not a low-risk change.
- **P1:** the first-run status rows show "Status unavailable." when the server is down. Hide them or keep them? This is a product call, since the rows were built on purpose.
- **P1:** the icon-only scanner rail buttons have no visible labels. Design call.
- **P1:** some rail buttons and panel rows are below 44 px. Needs a layout check.
- **P2:** small, low-contrast text in the HUD and panel (10 px at 25–45% alpha; section labels as low as 2.2:1) **(review)**. Needs a contrast pass across the tokens.
- **P2:** onboarding is not announced as a dialog and does not move focus **(review)**.
- **P2:** the "Other ways" control pushes the start cards down about 17 px on boot **(review)**.
- **P2:** the history map shows a CARTO "API key required" watermark. Check production before changing it **(review)**.
- **P2:** jargon: the "Reflections" chip, "Server uses all machine cores", and "Menu" opening Review & Export **(review)**.
- **P3:** the rail's `aria-label` is on a plain `div`; the compass "N" is tiny; the model line says "unknown size"; disabled Export buttons give no reason **(review)**.

## Test coverage

### Counts and what runs

- Playwright: 37 spec files. Node: 33 test files. Deno: 47 test files. The test-call counts (339 Playwright, 499 Node, 709 Deno) are from the review's grep **(review)**.
- No coverage tooling exists: no c8, nyc, istanbul, or coverage config.
- `deno-ci.yml` and `docker-publish.yml` are `workflow_dispatch` only. Nothing runs on push or PR. The README said CI ran on every push and PR. That was wrong and is fixed.
- The pre-push hook runs `npm run verify`, not Playwright. It is enabled per clone with `git config core.hooksPath .githooks`.
- The Playwright suites run only by hand.

### Fixed on this branch

- `scan_coherence.test.ts` (35 tests) was not run by `verify`. It now is.
- New suites, all in `verify` except the UX spec: icon contract (8), service-worker queue policy (5), mobile shell config (4), inference error classification (2), and a Playwright UX regression spec (6).
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

- Node suites, all passing: startup budget (11), FTUE status (9), app icons (8), service-worker queue (5), mobile shell config (4), inference errors (2), scan coherence (35).
- Playwright, `chromium-mock`: the UX regression spec passes 6 of 6. `mock-ftue`, `mock-scanner-startup-budget` and `mock-ui-mobile` pass 17 of 19.
- The other two failures, `mock-ftue` "Upload path POSTs the picked video…" and `mock-ui-mobile` "06 place picker with a place selected", fail identically on the untouched `origin/main` snapshot in this environment. Port 8000 is held by a stray process that answers 404, and no Deno API is running, so they are environmental.
- Not run: the full Playwright suite, the WebKit projects, and the live-server specs.
- `npm run verify` passes on this branch (exit 0), with all 36 node suites reporting zero failures, including the new ones.

## Decisions for the owner

1. App icon: the Companion mark (this branch) or the scanner reticle (git history).
2. Place creation: require coordinates even when a name is given?
3. First-run status rows when the server is down: hide them, or keep "Status unavailable."?
4. CI: keep the gates manual-only, or run `verify` on push and PR?
5. Gimbal link: keep it hidden until a gimbal is configured?
