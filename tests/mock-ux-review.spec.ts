/**
 * Regression tests for the first-run and scanner fixes from the UI review
 * (docs/audits/2026-11-02-companion-scan-review.md). Each one failed before its
 * fix: a blank new-place save said nothing under its own button, Back did not
 * exist, the side panel's top corner sat under the help button, the gimbal link
 * was visible to every visitor, and the first-run copy named a button that the
 * phone never shows.
 */
import { test, expect } from '@playwright/test'
import { startArScan } from './support/start-scan'

test('the gimbal link stays hidden for visitors', async ({ page }) => {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#gimbal-link')).toHaveAttribute('hidden', '')
  await expect(page.locator('#gimbal-link')).toBeHidden()
})

test('the Place Scan Editor card is named by what it shows', async ({ page }) => {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-editor-card')).toHaveAttribute('aria-label', /^Place Scan Editor\./)
})

test('the first-run copy names the prompt the phone shows', async ({ page }) => {
  await page.goto('/?mock=xr8&onboarding=1')
  const copy = page.locator('.onboard-step[data-step="0"] .onboard-desc')
  await expect(copy).toContainText('Your phone asks when you start.')
  await expect(copy).not.toContainText('Tap Allow')
})

test('Back leaves the Place picker without starting a scan', async ({ page }) => {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#place-back-btn')).toBeVisible({ timeout: 30_000 })
  await page.click('#place-back-btn')
  await expect(page.locator('#place-sheet')).toBeHidden()
  // AR never started, so the start screen is still up.
  await expect(page.locator('#start-ar-btn')).toBeVisible()
})

test('a blank new-place save explains itself under the Save button', async ({ page }) => {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#place-skip-btn')).toBeVisible({ timeout: 30_000 })
  await page.click('#place-new-btn')
  await expect(page.locator('#place-new-popup')).toBeVisible({ timeout: 10_000 })
  await page.click('#place-new-save')
  await expect(page.locator('#place-new-status')).toHaveText(/Enter a project name|Could not save this place/)
})

test('the side panel takes the taps in its own top corner, not the help button beneath it', async ({ page }) => {
  await startArScan(page, { waitForPoints: false })
  await page.click('#panel-toggle')
  const panel = page.locator('#side-panel')
  await expect(panel).toHaveClass(/open/, { timeout: 10_000 })
  // The panel slides in over 0.3s. Measure only once it has landed on screen.
  await expect.poll(() => panel.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth + 0.5)).toBe(true)
  const ownCorner = await panel.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return Boolean(document.elementFromPoint(box.right - 24, box.top + 24)?.closest('#side-panel'))
  })
  expect(ownCorner).toBe(true)
})
