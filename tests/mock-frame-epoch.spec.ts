/**
 * A frame shift partway through a scan is noticed, and the scan stops reading ready (WP-09).
 *
 * The mock engine's `?mockJumpAt=<tick>` puts the scripted camera 1 m further along Z from that
 * tick on, with tracking still NORMAL: the whole map moving under the camera, which is what a
 * relocalization looks like from inside the app, and which nothing but the frame-epoch detector
 * (src/ar/frame-epoch.ts) can tell from walking. Before it, such a scan went on reading ready.
 * What the detector decides, and at what sizes, is tested without a browser in
 * tests/unit/node/frame_epoch*.test.ts, and the hook in tests/unit/node/xr8_mock_jump.test.ts;
 * this is the one smoke that the page puts them together.
 *
 * Run: npx playwright test --project=chromium-mock mock-frame-epoch
 */
import { test, expect } from '@playwright/test'
import { startArScan } from './support/start-scan'

const SHIFT_HINT = /Tracking was interrupted: parts may be shifted/

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

test.describe('a frame shift during a scan', () => {
  test.setTimeout(90_000)

  test('the verdict says tracking was interrupted once the mock camera jumps, and the scan is not ready', async ({ page }) => {
    // The mock ticks at 30 fps: tick 90 is three seconds after the session starts, well after
    // tracking is NORMAL (tick 12) and the walk has given the detector steps to compare with.
    await startArScan(page, { url: '/?mock=xr8&mockJumpAt=90' })
    await expect(page.locator('#verdict-hint')).toHaveText(SHIFT_HINT, { timeout: 20_000 })
    await expect(page.locator('#verdict-chip')).not.toHaveText(/Ready/)
  })

  test('the same scan without the jump never says so', async ({ page }) => {
    await startArScan(page)
    // Long enough for the jump above to have happened and been shown, twice over.
    await page.waitForTimeout(8_000)
    await expect(page.locator('#verdict-hint')).not.toHaveText(SHIFT_HINT)
  })
})
