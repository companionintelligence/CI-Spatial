/**
 * The Export button must report what actually happened.
 *
 * Regression: `exportManualScan()` caught its own errors and returned
 * `undefined`, so `SidePanel`'s `await this.onExport()` never threw and the
 * button read **"Exported"** for every path through it — a failed upload, a
 * cancelled export, and a genuine success were indistinguishable on screen.
 * The button's own "Export failed" branch was unreachable code.
 *
 * Since #92 there is a fourth case: an upload queued by the service worker is
 * not a failure, but it was being reported as "server sync failed" — which
 * teaches people to distrust a message that is usually wrong.
 *
 * Each test drives one outcome by routing `/upload-scan`, then reads the
 * button label. Routing (rather than real offline) keeps the outcome exact.
 *
 * Run: npx playwright test --project=chromium-mock mock-export-outcome
 */
import { test, expect, type Page } from '@playwright/test'
import { QUEUED_OFFLINE_HEADER } from '../src/shared/offline-queue'
import { startArScan } from './support/start-scan'
import { requireUsableInferenceEngine } from './support/inference-engine'

test.use({
  // No service worker for this spec. Since the cert flag landed (#95) the
  // worker actually installs in chromium-mock, and /upload-scan is one of its
  // queueable prefixes — so the SW, not the page, issues the request.
  // `page.route` does not intercept service-worker-initiated requests, so the
  // routes below silently stopped firing and these tests started asserting
  // against the real server (which accepts the upload, hence "Exported").
  // These tests are about how the app maps an upload result to a label; the
  // worker is an unrelated intermediary, so block it and keep them exact.
  serviceWorkers: 'block',
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

/**
 * Scan until there is something worth exporting, then open the panel.
 *
 * A short mock scan lands at `needs-rescan`, so exporting raises the
 * low-quality confirm. Playwright dismisses dialogs by default — which is
 * itself the cancel path — so callers say which one they want.
 */
async function scanThenOpenPanel(page: Page, confirmLowQuality = true): Promise<void> {
  // The poll below waits 45 s for a detection that a server with no vision
  // engine can never produce. Say so in a second instead. See ./support/inference-engine.
  await requireUsableInferenceEngine()
  // The handler has to be registered before the navigation, so it is passed in
  // rather than attached here.
  await startArScan(page, { confirmLowQuality })
  await page.waitForTimeout(1_200)
  await page.click('#capture-btn')
  await expect
    .poll(async () => Number(await page.locator('#panel-toggle').getAttribute('data-count') ?? '0'),
      { timeout: 45_000 })
    .toBeGreaterThan(0)
  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
}

/** Click Export and return the label the button settles on. */
async function exportAndReadLabel(page: Page): Promise<string> {
  const btn = page.locator('#panel-export-glb-btn')
  await btn.click()
  // "Exporting..." is transient; wait for it to resolve to a verdict.
  await expect
    .poll(async () => await btn.textContent(), { timeout: 45_000 })
    .not.toMatch(/Exporting/)
  return (await btn.textContent()) ?? ''
}

test.describe('export outcome reporting', () => {
  test.setTimeout(150_000)

  test('a server rejection does not read as success', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({ status: 500, body: 'nope' }))
    await scanThenOpenPanel(page)

    const label = await exportAndReadLabel(page)
    expect(label, 'a rejected upload must not report "Exported"').not.toBe('Exported')
    expect(label).toContain('Saved on device')
    await expect(page.locator('#status-text')).toContainText('server sync failed')

    // The scan never reached the server, so the "View in 3D" link must stay down.
    await expect(page.locator('#export-view-link')).toBeHidden()
  })

  test('a queued-offline upload reads as queued, not failed', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({
      status: 202,
      headers: { 'Content-Type': 'application/json', [QUEUED_OFFLINE_HEADER]: '1' },
      body: JSON.stringify({ ok: false, queuedOffline: true, queueId: 'q1' }),
    }))
    await scanThenOpenPanel(page)

    const label = await exportAndReadLabel(page)
    expect(label).toContain('will sync')
    await expect(page.locator('#status-text')).toContainText('will sync when back online')
    await expect(page.locator('#status-text')).not.toContainText('failed')
  })

  test('a real upload still reports success and reveals the editor link', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ filename: 'room-scan-test.glb' }),
    }))
    await scanThenOpenPanel(page)

    expect(await exportAndReadLabel(page)).toBe('Exported')
    await expect(page.locator('#export-view-link')).toBeVisible()
  })

  test('backing out of the low-quality confirm reads as cancelled, not exported', async ({ page }) => {
    // Nothing is written on this path. It reported "Exported" before, which is
    // the same lie as a failed upload wearing a success label.
    await scanThenOpenPanel(page, false)

    const label = await exportAndReadLabel(page)
    expect(label).toBe('Cancelled')
    await expect(page.locator('#status-text')).toContainText('Export cancelled')
    await expect(page.locator('#export-view-link')).toBeHidden()
  })
})
