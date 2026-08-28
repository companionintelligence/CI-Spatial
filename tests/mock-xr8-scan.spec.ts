/**
 * Headless 8th Wall scan-flow test — drives the full AR pipeline with the
 * scripted XR8 mock (public/test-fixtures/xr8-mock.js) instead of the real
 * SLAM binary, no device or camera required:
 *
 *   pose stream → point-cloud accumulation → frame capture →
 *   /infer (mock colour-blob engine) → spatial resolve → detection store
 *
 * Requirements:
 *   - Vite dev server (VITE_URL)
 *   - Deno server with INFERENCE_MODE=mock behind the Vite proxy
 *
 * Run: npx playwright test --project=chromium-mock mock-xr8-scan
 */
import { test, expect } from '@playwright/test'
import { startArScan } from './support/start-scan'

test.describe('XR8 mock scan flow', () => {
  test.setTimeout(90_000)

  test('boots the mock engine and accumulates SLAM points', async ({ page }) => {
    // Mock dispatches xrloaded → provider starts → points accumulate, which is
    // where startArScan leaves off.
    await startArScan(page)
    const first = await page.locator('#scan-stats').textContent()
    await page.waitForTimeout(2500)
    const later = await page.locator('#scan-stats').textContent()
    expect(parseInt(later ?? '0', 10)).toBeGreaterThan(parseInt(first ?? '0', 10))
  })

  test('capture → mock inference → detections land in the store', async ({ page }) => {
    await startArScan(page)

    // Give tracking a moment to reach NORMAL, then capture
    await page.waitForTimeout(1500)
    await page.click('#capture-btn')

    // The mock camera feed shows sofa/tv/table/plant in palette colours —
    // the mock engine must detect at least one of them.
    await expect
      .poll(async () => {
        const status = await page.locator('#status-text').textContent() ?? ''
        const panelCount = await page.locator('#panel-toggle').getAttribute('data-count') ?? ''
        return /object/.test(status) || /[1-9]/.test(panelCount)
      }, { timeout: 45_000, message: 'expected detections after capture' })
      .toBeTruthy()
  })
})
