/**
 * Playwright configuration for Companion Scan.
 *
 * Desktop webkit: simulates Safari on macOS, fast iteration.
 * iphone-usb: same engine, iPhone 15 UA, served over Tailscale URL so the
 *   real network path (cert, CORS, proxy) is exercised.
 *
 * NOTE: Playwright cannot drive a real iPhone Safari browser directly.
 * Apple's Remote Web Inspector protocol (ios-webkit-debug-proxy) is
 * incompatible with Playwright's WS control protocol.
 *
 * For live console log streaming from the real device:
 *   /opt/homebrew/bin/ios_webkit_debug_proxy -F &      # start bridge
 *   curl http://localhost:9222/json                    # find tab WS URL
 *   node scripts/iwdp-console.mjs ws://localhost:9222/devtools/page/2
 */
import fs from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Same variable name/default as main.ts and vite.config.ts (see docs/foundation-updates/0002
// for the hostname precedent this follows). Only this default-URL construction reads it —
// individual specs derive their target from VITE_URL when set (the established override).
const VITE_PORT = process.env['VITE_PORT'] ?? '5173'

// Mirrors vite.config.ts's resolveHostname() — env, then a cert file in the repo
// root, then the historical default. It has to: the URL this config hands the
// browser must be the one Vite is actually serving, and a hostname hardcoded to
// one developer's machine resolves nowhere else, so page.goto() fails with
// ERR_SSL_PROTOCOL_ERROR before a single assertion runs. The `tailscale status`
// probe vite.config.ts does between those two steps is deliberately not copied:
// this file is imported for every `playwright test` invocation, including
// --list, and a 3s subprocess timeout per run is not worth it when the cert
// file it would agree with is sitting right there.
function resolveHostname(): string {
  const fromEnv = process.env['TAILSCALE_HOSTNAME'] ?? process.env['VITE_HOSTNAME']
  if (fromEnv) return fromEnv
  try {
    const crt = fs.readdirSync(process.cwd()).find((f) => f.endsWith('.ts.net.crt'))
    if (crt) return crt.replace(/\.crt$/, '')
  } catch { /* unreadable cwd — fall through */ }
  return 'liambook.capybara-ulmer.ts.net'
}

const BASE_URL = process.env['VITE_URL'] ?? `https://${resolveHostname()}:${VITE_PORT}`

// Escape hatch for hosts where `npx playwright install` is unsupported but a
// compatible Chromium build already exists in the cache, e.g.
// CHROMIUM_EXECUTABLE_PATH=~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome
const chromiumExecutable = process.env['CHROMIUM_EXECUTABLE_PATH']
  ? { executablePath: process.env['CHROMIUM_EXECUTABLE_PATH'] }
  : {}

export default defineConfig({
  testDir: './tests',
  // tests/unit/ holds Deno unit tests (`deno task test`), not Playwright specs.
  // Playwright's default testMatch is **/*.@(spec|test).[jt]s, which matches
  // *.test.ts, so without an explicit ignore the runner tries to import all 32
  // and dies on `jsr:` specifiers. Note this top-level value is only a default:
  // a project that sets its own testIgnore REPLACES it rather than merging, so
  // the three browser projects below repeat /unit\// in their own arrays. Both
  // are needed.
  testIgnore: '**/unit/**',
  timeout: 60_000,
  retries: 1,

  projects: [
    // ── API-only tests (request fixture — no browser binary required) ───────
    // Targets the Deno server directly; pair with INFERENCE_MODE=mock and
    // the generated corpus (npm run gen:test-data).
    {
      name: 'api',
      testMatch: /api-.*\.spec\.ts/,
      use: {
        baseURL: process.env['API_URL'] ?? 'http://localhost:8000',
      },
    },

    // ── Headless Chromium with mocked AR runtimes ────────────────────────────
    //   mock-xr8-*:   scripted 8th Wall engine (public/test-fixtures/xr8-mock.js)
    //   mock-webxr-*: iwer emulation runtime (Meta immersive-web-emulator)
    //   mock-editor-*: World Scan Editor against generated test homes
    {
      name: 'chromium-mock',
      testMatch: /mock-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
        permissions: ['camera'],
        launchOptions: {
          ...chromiumExecutable,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            // The dev server's cert is self-signed. `ignoreHTTPSErrors` covers
            // page and fetch requests, but Chromium enforces a valid
            // certificate for the service-worker script fetch separately — so
            // registration failed with "An SSL certificate error occurred when
            // fetching the script" and navigator.serviceWorker.controller
            // stayed null forever. Every offline/PWA behaviour was therefore
            // untestable: the worker was never installed to test against.
            '--ignore-certificate-errors',
          ],
        },
      },
    },

    // ── Desktop Safari simulation (default, no device needed) ──────────────
    {
      name: 'webkit-desktop',
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/, /unit\//],
      use: {
        ...devices['Desktop Safari'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },

    // ── Mobile Safari simulation (no real device needed) ────────────────────
    {
      name: 'webkit-iphone15',
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/, /unit\//],
      use: {
        ...devices['iPhone 15'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },

    // ── iPhone UA + live Tailscale URL (npm run test:iphone) ────────────────
    // Exercises real network path (cert, proxy, CORS) with iPhone 15 UA.
    // Requires Vite + Deno servers running. No USB connection needed here.
    {
      name: 'iphone-usb',
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/, /unit\//],
      use: {
        ...devices['iPhone 15'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },
  ],
})
