/**
 * Playwright configuration for CI XR Scan.
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
    // ── Desktop Safari simulation (default, no device needed) ──────────────
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },

    // ── Mobile Safari simulation (no real device needed) ────────────────────
    {
      name: 'webkit-iphone15',
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
      use: {
        ...devices['iPhone 15'],
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
      },
    },
  ],
})
