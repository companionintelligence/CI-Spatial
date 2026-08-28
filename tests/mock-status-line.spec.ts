/**
 * The HUD status line must stay readable during a scan.
 *
 * Regression: the room scanner ticks every 750 ms (`RoomScanner`'s
 * DEFAULT_INTERVAL_MS) and each tick called `updateVerdictUI()`, which wrote
 * its top quality recommendation straight into `#status-text`. A
 * recommendation is essentially always present — zero streamed keyframes alone
 * pushes one, and any recommendation forces the verdict to `needs-review`,
 * which is self-sustaining — so the status line was permanently pinned to a
 * nag, and every transient message was erased within one tick: the typed
 * inference-error ladder, "Camera access denied", "Export failed", "Scan
 * exported & synced ✓".
 *
 * The recommendation now lives in `#verdict-hint`, its own line. These tests
 * pin both halves: the guidance still reaches the user, and it no longer
 * competes for the line that reports events.
 *
 * Run: npx playwright test --project=chromium-mock mock-status-line
 */
import { test, expect } from '@playwright/test'
import { startArScan } from './support/start-scan'

// Two scanner ticks plus headroom — long enough that a per-tick writer would
// certainly have clobbered anything we put in the status line.
const TWO_TICKS_MS = 2_000

/** The recommendations quality-monitor.ts can produce for a short mock scan. */
const RECOMMENDATION = /Collect more tracking points|Sweep the room more slowly|Stream RGB keyframes|Rescan sparse|Add light|Move slower|reflective/i

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

test.describe('HUD status line during a scan', () => {
  test.setTimeout(90_000)

  async function startScanning(page: import('@playwright/test').Page) {
    // Points accumulating (startArScan's default wait) means the scanner tick
    // is running, which is the thing under test.
    await startArScan(page)
  }

  test('quality guidance goes to its own line, not the status line', async ({ page }) => {
    await startScanning(page)

    // Let several ticks run, so the verdict has settled into needs-review.
    await page.waitForTimeout(TWO_TICKS_MS)

    const hint = page.locator('#verdict-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toHaveText(RECOMMENDATION)

    // The status line must not be carrying the same guidance.
    await expect(page.locator('#status-text')).not.toHaveText(RECOMMENDATION)
  })

  test('a transient status message survives the scanner tick', async ({ page }) => {
    await startScanning(page)
    await page.waitForTimeout(TWO_TICKS_MS)

    // Stand in for any real transient message — a capture error, a denied
    // permission, an export result. Before the fix this was gone in <750ms.
    const marker = 'Camera access denied — check browser settings'
    await page.evaluate((text) => {
      const el = document.getElementById('status-text')
      if (el) el.textContent = text
    }, marker)

    await page.waitForTimeout(TWO_TICKS_MS)
    await expect(page.locator('#status-text')).toHaveText(marker)
  })

  test('the guidance line is not rewritten on every tick', async ({ page }) => {
    await startScanning(page)
    await page.waitForTimeout(TWO_TICKS_MS)

    // #verdict-hint is aria-live, so an unconditional per-tick write would
    // re-announce the same sentence twice a second to a screen reader. Count
    // mutations rather than trusting the implementation.
    await expect(page.locator('#verdict-hint')).toBeVisible()

    const mutations = await page.evaluate(async () => {
      const target = document.getElementById('verdict-hint')
      if (!target) return Number.MAX_SAFE_INTEGER   // missing element must fail, not pass
      let count = 0
      const observer = new MutationObserver((records) => { count += records.length })
      observer.observe(target, { childList: true, characterData: true, subtree: true, attributes: true })
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      observer.disconnect()
      return count
    })

    expect(mutations, 'a settled verdict should not touch the DOM on every tick').toBeLessThanOrEqual(1)
  })
})
