/**
 * Regression test for a real-device failure caught 2026-08-26 on an XREAL
 * companion device.
 *
 * `navigator.xr.isSessionSupported('immersive-ar')` answered true — the
 * WebXR *API* is present — but `requestSession('immersive-ar', ...)`
 * rejected with "The specified session configuration is not supported",
 * because the device has no ARCore installed to actually back a session.
 * isSessionSupported() only promises the API exists, never that a backing AR
 * service does.
 *
 * The permission banner already reported this correctly. The bug was that
 * capture-btn / stream-btn / auto-capture-btn / person-capture-btn are wired
 * up in section 4 of main(), before provider.start() ever runs, and stayed
 * fully interactive after it failed. Tapping "Stream keyframes" opened a real
 * server session and flipped the status to "Streaming keyframes — walk the
 * room" — confident, active-looking UI with no scanner.start() behind it, so
 * no frame would ever arrive to correct it. The session sat open forever
 * with keyframeCount: 0.
 *
 * Run: npx playwright test --project=chromium-mock mock-webxr-session-failure
 */
import { test, expect } from '@playwright/test'

test.describe('WebXR session-start failure', () => {
  test.setTimeout(60_000)

  test('a requestSession rejection disables the capture rail instead of leaving it live', async ({ page }) => {
    // Stubs navigator.xr to reproduce the exact real-device shape: the API
    // exists and claims support, but starting a session fails. Installed via
    // addInitScript so it exists before any of the page's own scripts run —
    // in particular before main()'s support probe.
    await page.addInitScript(() => {
      const fakeXR = {
        isSessionSupported: async () => true,
        requestSession: async () => {
          throw new DOMException(
            'The specified session configuration is not supported.',
            'NotSupportedError',
          )
        },
      }
      Object.defineProperty(navigator, 'xr', { value: fakeXR, configurable: true })
    })

    // ?ar=webxr forces the native path (skips 8th Wall / xr.js entirely),
    // matching the real device — this app has no WebXR-scanner fallback to
    // 8th Wall once forced, so the failure has nowhere else to go but here.
    // &onboarding=0 skips the first-run tutorial, which otherwise intercepts
    // the very first click (skipOnboarding is keyed on ?mock= normally, and
    // this test deliberately does not set ?mock= — it stubs navigator.xr
    // itself instead of using the iwer/xr8 mock hooks).
    await page.goto('/?ar=webxr&onboarding=0')

    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.locator('#start-ar-btn').click()

    const placeSkip = page.locator('#place-skip-btn')
    await expect(placeSkip).toBeVisible({ timeout: 15_000 })
    await placeSkip.click()

    // The banner must explain the failure and offer the way out, and must not
    // claim a camera-permission problem this device never had.
    //
    // It used to assert the raw exception text ("session configuration is not
    // supported") appeared on screen. That was the bug, not the contract: a
    // person who cannot run AR was handed a WebXR internals string, no retry,
    // and no route to Upload Content — the one path their device CAN do. The
    // raw message still goes to console.error for whoever is debugging; what
    // reaches the screen is now a consequence plus a next step. Asserting the
    // exception text here would re-require the defect.
    const banner = page.locator('#permission-error-msg')
    await expect(banner).toContainText('AR could not start', { timeout: 15_000 })
    await expect(banner, 'the banner must point at the path this device can still use')
      .toContainText('Upload Content')
    await expect(banner, 'this device never hit a permission prompt — do not claim one')
      .not.toContainText(/permission|denied|blocked/i)

    // The capture rail must be disabled — not merely present in the DOM,
    // which the old bug's buttons always were.
    for (const id of ['capture-btn', 'stream-btn', 'auto-capture-btn', 'person-capture-btn']) {
      await expect(page.locator(`#${id}`), `#${id} must be disabled after a failed AR start`)
        .toBeDisabled({ timeout: 5_000 })
    }

    // The regression itself: a disabled <button> suppresses click events —
    // including scripted ones — so this proves the handler cannot fire, not
    // just that the button looks disabled.
    await page.locator('#stream-btn').click({ force: true }).catch(() => {})
    await expect(page.locator('#status-text')).not.toContainText('Streaming keyframes', { timeout: 3_000 })

    // Navigation controls are deliberately left alone — they don't imply a
    // live session and stay useful (e.g. Export, History) after a failure.
    await expect(page.locator('#viewer-link')).toBeVisible()
    await expect(page.locator('#finish-scan-btn')).toBeEnabled()
  })
})
