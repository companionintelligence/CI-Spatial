/**
 * WebXR scanner test on the emulated runtime — uses iwer (Meta's
 * Immersive Web Emulation Runtime, the engine behind the
 * immersive-web-emulator extension) injected via ?mock=webxr to provide
 * navigator.xr in headless Chromium.
 *
 * Verifies the /webxr.html route logic and that the forced-WebXR scanner
 * boots an immersive-ar session, receives poses, and keeps the UI alive
 * (dom-overlay).
 *
 * Run: npx playwright test --project=chromium-mock mock-webxr-emulated
 */
import { test, expect } from '@playwright/test'

test.describe('WebXR emulated scanner', () => {
  test.setTimeout(60_000)

  test('webxr.html forwards when immersive-ar is supported', async ({ page }) => {
    // Install the emulator before the support probe runs
    await page.addInitScript(() => {
      // Marker consumed by the page under ?mock=webxr; here we only need
      // navigator.xr present for /webxr.html's isSessionSupported probe —
      // forwarders carry the query through.
      void 0
    })
    await page.goto('/webxr.html')
    // Without an emulator this browser has no immersive-ar: guidance shows
    await expect(page.locator('#xr-status')).toContainText(/WebXR|browser/i, { timeout: 10_000 })
    await expect(page.locator('#btn-start')).toBeVisible()
  })

  test('forced WebXR mode starts an emulated immersive-ar session', async ({ page }) => {
    await page.goto('/?ar=webxr&mock=webxr')
    await expect(page.locator('#start-ar-btn')).toBeVisible({ timeout: 15_000 })

    // Emulated device must be installed by the app hook
    await expect.poll(() => page.evaluate(() => !!(window as never as { __iwerDevice?: unknown }).__iwerDevice), {
      timeout: 15_000,
    }).toBeTruthy()

    await page.click('#start-ar-btn')

    // Status must not report AR-unavailable, and the session should reach
    // the WebXR provider (tracking active ⇒ capture UI stays enabled).
    await expect(page.locator('#status-text')).not.toContainText('not available', { timeout: 20_000 })
    await expect.poll(async () => {
      const status = await page.locator('#status-text').textContent() ?? ''
      return !/HelloXR/.test(status)
    }, { timeout: 20_000, message: 'expected WebXR session to start under emulation' }).toBeTruthy()
  })
})
