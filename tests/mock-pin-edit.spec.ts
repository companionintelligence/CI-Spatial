/**
 * Pin edit round-trip + startup-teardown regression tests.
 *
 * Covers two defects that the rest of the mock suite could not see, because no
 * spec asserted on the *value* a pin edit writes back, and none asserted that the
 * page raises no uncaught errors:
 *
 *   1. The inline edit form was built by interpolating the label into
 *      `value="${label}"`. A label containing a double quote — `Samsung 27"
 *      monitor` is an ordinary one — terminated the attribute, so reopening the
 *      form showed a truncated label and saving wrote the truncation back over
 *      the user's text, silently.
 *
 *   2. The `pagehide` teardown referenced the `broadcaster` const declared much
 *      further down, after `await runOnboarding()` and the AR provider start.
 *      Leaving the page during that window threw a TDZ ReferenceError as the
 *      handler's first statement, so the whole teardown — including the
 *      keyframe-session finalize — was skipped.
 *
 * Run: npx playwright test --project=chromium-mock mock-pin-edit
 */
import { test, expect } from '@playwright/test'

const EDIT_BTN = 'button[title="Edit label & description"]'

/** Drive the XR8 mock until at least one detection card exists in the panel. */
async function scanUntilDetection(page: import('@playwright/test').Page) {
  // ?mock=xr8 alone skips the onboarding overlay, so the scan flow is not gated.
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeVisible({ timeout: 20_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
  await page.waitForTimeout(1500)

  // Capture until the store has at least one object (the mock feed is deterministic,
  // but a capture can land before tracking reaches NORMAL).
  await expect.poll(async () => {
    await page.click('#capture-btn')
    await page.waitForTimeout(1500)
    return page.locator('#panel-toggle').getAttribute('data-count')
  }, { timeout: 60_000, message: 'expected at least one detection' })
    .toMatch(/[1-9]/)

  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
  await expect(page.locator('#side-panel [data-key]').first()).toBeVisible({ timeout: 10_000 })
}

test.describe('pin edit round-trip', () => {
  test.setTimeout(150_000)

  test('a label containing a double quote survives edit → save → reopen', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await scanUntilDetection(page)

    const card = page.locator('#side-panel [data-key]').first()
    await card.locator(EDIT_BTN).click()

    const TRICKY = 'Samsung 27" monitor & <desk>'
    const DESC = 'sits under the 45° "north" window & to the <left>'

    const input = card.locator('input[placeholder="Label"]')
    const textarea = card.locator('textarea[placeholder="Description"]')
    await input.waitFor({ state: 'visible', timeout: 10_000 })
    await input.fill(TRICKY)
    await textarea.fill(DESC)
    await card.locator('.edit-save').click()

    // The store notifies and the panel rebuilds the card. Reopen the form: it must
    // be repopulated with the full string, not a value truncated at the quote.
    await page.waitForTimeout(600)
    const reopened = page.locator('#side-panel [data-key]').first()
    await reopened.locator(EDIT_BTN).click()
    await expect(reopened.locator('input[placeholder="Label"]')).toHaveValue(TRICKY)
    await expect(reopened.locator('textarea[placeholder="Description"]')).toHaveValue(DESC)

    // ...and saving again must not degrade it (this is what silently overwrote
    // the real label with the truncation).
    await reopened.locator('.edit-save').click()
    await page.waitForTimeout(600)
    await page.locator('#side-panel [data-key]').first().locator(EDIT_BTN).click()
    await expect(page.locator('#side-panel [data-key]').first().locator('input[placeholder="Label"]'))
      .toHaveValue(TRICKY)

    expect(pageErrors, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([])
  })
})

test.describe('startup teardown', () => {
  test.setTimeout(90_000)

  test('leaving the page during onboarding raises no uncaught error', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    // ?onboarding=1 forces the overlay on even under the mock runtime. init() then
    // sits on `await runOnboarding()` — exactly the window in which the teardown
    // handler used to be inside the broadcaster const's temporal dead zone.
    await page.goto('/?mock=xr8&onboarding=1')
    await expect(page.locator('#onboarding-overlay')).toBeVisible({ timeout: 20_000 })

    // Navigate away while onboarding is still up → pagehide fires mid-init.
    await page.goto('/viewer.html')
    await page.waitForTimeout(1000)

    expect(
      pageErrors.filter((e) => /before initialization|is not defined/.test(e)),
      `teardown threw during startup: ${pageErrors.join(' | ')}`,
    ).toEqual([])
  })
})
