/**
 * FTUE (first-time user experience) test — the two-path start screen.
 *
 * Verifies the redesigned #start-screen presents both capture paths as
 * equal, distinct choices, and that each path works:
 *   - "Scan a room"    → #start-ar-btn starts live AR (?mock=xr8 → points
 *                         accumulate in #scan-stats)
 *   - "Upload a video" → the #start-upload-card label opens the hidden
 *                         #upload-video-input; a chosen file POSTs to the REAL
 *                         /ingest-video route on the isolated mock server (a
 *                         tiny fake blob — never a real video). We assert the
 *                         request reaches the route (a non-404 response) rather
 *                         than intercepting it.
 *   - onboarding overlay shows once, then not again (localStorage)
 *
 * Mobile iPhone-15 viewport, chromium-mock project.
 *
 * Run: npx playwright test --project=chromium-mock mock-ftue
 */
import { test, expect } from '@playwright/test'
import { ONBOARDING_KEY } from '../src/shared/storage-keys'

// iPhone-15-ish viewport on the chromium-mock browser (a webkit device
// descriptor can't be used under the chromium project, so set the metrics
// explicitly), matching mock-ui-mobile.spec.ts.
test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

test.describe('FTUE two-path start screen', () => {
  test.setTimeout(90_000)

  test('both capture paths are visible and distinct', async ({ page }) => {
    await page.goto('/?mock=xr8')

    const scan = page.locator('#start-ar-btn')
    const upload = page.locator('#start-upload-card')

    await expect(scan).toBeVisible({ timeout: 15_000 })
    await expect(upload).toBeVisible()

    // Distinct copy: each card names its path and its one-line subtext.
    await expect(scan).toContainText('Scan a room')
    await expect(scan).toContainText('walk the room')
    await expect(upload).toContainText('Upload a video')
    await expect(upload).toContainText('no AR needed')

    // Both cards clear a comfortable tap target (≥56px).
    const scanBox = await scan.boundingBox()
    const uploadBox = await upload.boundingBox()
    expect(scanBox!.height).toBeGreaterThanOrEqual(56)
    expect(uploadBox!.height).toBeGreaterThanOrEqual(56)

    // The file input exists, is scoped to video, and the upload card is its label.
    const input = page.locator('#upload-video-input')
    await expect(input).toHaveAttribute('type', 'file')
    await expect(input).toHaveAttribute('accept', 'video/*')
    await expect(upload).toHaveAttribute('for', 'upload-video-input')

    // #start-ar-btn stays a <button> — required for the iOS motion-permission
    // request to fire from a real user gesture.
    expect(await scan.evaluate((el) => el.tagName)).toBe('BUTTON')
  })

  test('Scan path starts live AR and points accumulate', async ({ page }) => {
    await page.goto('/?mock=xr8')
    // Wait for data-ready, not for visibility: #start-ar-btn is in the static
    // markup and paints ~250ms before main() has wired its click handler, so a
    // visibility-triggered click used to land on nothing and be silently
    // dropped (this test failed 3 runs out of 3 that way).
    //
    // data-ready is set at the top of the boot, long before AR itself can
    // start — so this click still lands in the middle of the async boot and
    // is the regression test for that tap being honoured rather than lost.
    await expect(page.locator('#start-ar-btn[data-ready="1"]')).toBeVisible({ timeout: 15_000 })
    await page.click('#start-ar-btn')

    // Start screen dismisses and the mock SLAM engine accumulates points.
    await expect(page.locator('#start-screen')).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 20_000 })
    const pts = await page.locator('#scan-stats').textContent()
    expect(parseInt(pts ?? '0', 10)).toBeGreaterThan(0)
  })

  test('Upload path POSTs the picked video to the real /ingest-video route', async ({ page }) => {
    // Watch the network for the real POST — no interception. Against the
    // isolated mock server the tiny fake blob fails ffmpeg extraction and the
    // route returns 500, which still proves the request reached the real route
    // (a non-404). The point is the wiring, not a successful reconstruction.
    let ingestStatus: number | null = null
    page.on('response', (resp) => {
      if (resp.url().endsWith('/ingest-video') && resp.request().method() === 'POST') {
        ingestStatus = resp.status()
      }
    })

    await page.goto('/?mock=xr8')
    await expect(page.locator('#upload-video-input')).toBeAttached({ timeout: 15_000 })

    // Feed a tiny fake blob through the hidden file input.
    await page.setInputFiles('#upload-video-input', {
      name: 'walkthrough.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from('fake-video-bytes'),
    })

    // The real route answers (any non-404 status proves the POST landed there).
    await expect.poll(() => ingestStatus, { timeout: 20_000 }).not.toBeNull()
    expect(ingestStatus).not.toBe(404)

    // wireVideoUpload reflects a terminal state in the progress line (either an
    // "Uploaded…" success or an "Upload failed (…)" line for the fake blob).
    await expect(page.locator('#upload-video-progress'))
      .toHaveText(/Upload(ed|\s+failed)/i, { timeout: 20_000 })
  })

  test('onboarding shows once, then not again', async ({ page }) => {
    const overlay = page.locator('#onboarding-overlay')

    // First visit (onboarding forced on under the mock runtime): overlay shows.
    await page.goto('/?mock=xr8&onboarding=1')
    await expect(overlay).toBeVisible({ timeout: 15_000 })

    // Step through every step — the button reads "Get Started" on the last one,
    // so drive by label rather than a hardcoded count. The count already went
    // 3 → 5 once (fd6d459) and silently broke this test.
    const nextBtn = page.locator('#onboard-next-btn')
    for (let i = 0; i < 10 && await overlay.isVisible(); i++) {
      const isLast = (await nextBtn.textContent())?.trim() === 'Get Started'
      await nextBtn.click()
      if (isLast) break
    }
    await expect(overlay).toBeHidden({ timeout: 5_000 })

    const flag = await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY)
    expect(flag).toBe('1')

    // Reload with the same forced-on flag: because localStorage records the
    // completion, onboarding must NOT reappear.
    await page.goto('/?mock=xr8&onboarding=1')
    await expect(page.locator('#start-ar-btn')).toBeVisible({ timeout: 15_000 })
    await expect(overlay).toBeHidden()
  })
})
