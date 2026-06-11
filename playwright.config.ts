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
import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env['VITE_URL'] ?? 'https://liambook.capybara-ulmer.ts.net:5175'

export default defineConfig({
  testDir: './tests',
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
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },

    // ── Desktop Safari simulation (default, no device needed) ──────────────
    {
      name: 'webkit-desktop',
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/],
      use: {
        ...devices['Desktop Safari'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },

    // ── Mobile Safari simulation (no real device needed) ────────────────────
    {
      name: 'webkit-iphone15',
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/],
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
      testIgnore: [/api-.*\.spec\.ts/, /mock-.*\.spec\.ts/],
      use: {
        ...devices['iPhone 15'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },
  ],
})
