/**
 * Motion/orientation permission denial must be visible.
 *
 * Regression: the banner fired only from a `catch`. But iOS's
 * `DeviceOrientationEvent.requestPermission()` **resolves** with the string
 * `'denied'` — it rejects only when called outside a user gesture. The
 * resolved values were awaited and discarded, so a user who tapped
 * "Don't Allow" got no banner and landed in a session that never tracks,
 * staring at "Move camera to initialise tracking…" with nothing to explain it.
 * `docs/UX_FLOW.md` §3.2 item 3 was written to kill exactly this path; the
 * banner and its copy were already correct, only the trigger was wrong.
 *
 * Headless Chromium has `DeviceOrientationEvent` but not `requestPermission`
 * (that is iOS Safari only), so each test installs the API it wants via
 * `addInitScript` before the app's module runs.
 *
 * Run: npx playwright test --project=chromium-mock mock-motion-permission
 */
import { test, expect, type Page } from '@playwright/test'

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

/** Install an iOS-style permission API that answers with `outcome`. */
async function stubPermissionApi(page: Page, outcome: 'granted' | 'denied' | 'reject'): Promise<void> {
  await page.addInitScript((result) => {
    const respond = () => result === 'reject'
      ? Promise.reject(new Error('requestPermission requires a user gesture'))
      : Promise.resolve(result)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DeviceOrientationEvent as any).requestPermission = respond
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DeviceMotionEvent as any).requestPermission = respond
  }, outcome)
}

async function startAR(page: Page): Promise<void> {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')
}

test.describe('motion permission', () => {
  test.setTimeout(90_000)

  test('a denial the user taps is surfaced, not swallowed', async ({ page }) => {
    await stubPermissionApi(page, 'denied')
    await startAR(page)

    const banner = page.locator('#permission-error-banner')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#permission-error-msg')).toContainText('Motion & Orientation')
  })

  test('a rejected request is surfaced too', async ({ page }) => {
    // The other failure mode: the promise rejects rather than resolving
    // 'denied'. The user is equally without motion access, so they get the
    // same guidance — this is the path the old catch-only code did cover.
    await stubPermissionApi(page, 'reject')
    await startAR(page)

    await expect(page.locator('#permission-error-banner')).toBeVisible({ timeout: 15_000 })
  })

  test('granting shows no banner', async ({ page }) => {
    await stubPermissionApi(page, 'granted')
    await startAR(page)

    // Give the scan a moment to get going — a banner that appears late would
    // be just as wrong as one that never appears.
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
    await expect(page.locator('#permission-error-banner')).toBeHidden()
  })

  test('a platform without the API shows no banner', async ({ page }) => {
    // Android and desktop have no requestPermission at all. There is nothing
    // to grant, so nothing to warn about — the filter that drops the absent
    // calls is what keeps this quiet.
    await startAR(page)

    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
    await expect(page.locator('#permission-error-banner')).toBeHidden()
  })
})
