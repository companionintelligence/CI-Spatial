/**
 * The Create New Place form with the on-screen keyboard up, on the two phone
 * sizes where it used to fail. Headless Chromium has no keyboard, so one is
 * simulated by shrinking the viewport to what is left above it: that is what
 * Android Chrome does to the layout (interactive-widget=resizes-content), and
 * src/ui/keyboard.ts makes iOS Safari match. The field being typed in and the
 * Save button must stay on screen. Before the fix, on a 360x640 phone the name
 * field was 5px under the keyboard and Save was below the fold.
 */
import { test, expect, type Page } from '@playwright/test'

const KEYBOARD_PX = 320

async function onScreen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel)?.getBoundingClientRect()
    return Boolean(box && box.top >= 0 && box.bottom <= window.innerHeight)
  }, selector)
}

// The first load in a worker compiles the app through Vite, which can take longer than 30 s while other
// specs share the machine. The waits below are for that cold start, not for the assertions under test.
async function openNewPlaceForm(page: Page): Promise<void> {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 60_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#place-skip-btn')).toBeVisible({ timeout: 60_000 })
  await page.click('#place-new-btn')
  await expect(page.locator('#place-new-popup')).toBeVisible({ timeout: 10_000 })
}

for (const [width, height] of [[360, 640], [375, 667]] as const) {
  test.describe(`new place form with the keyboard up at ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

    test('the field being typed in and Save stay on screen', async ({ page }) => {
      await openNewPlaceForm(page)
      await page.locator('#place-new-name').focus()
      await page.setViewportSize({ width, height: height - KEYBOARD_PX })

      // The popup is sized to the visible area, so the keyboard cannot cover it.
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--vv-h')))
        .toBe(`${height - KEYBOARD_PX}px`)
      await expect.poll(() => onScreen(page, '#place-new-name')).toBe(true)
      await expect.poll(() => onScreen(page, '#place-new-save')).toBe(true)
    })

    test('the fields scroll inside the form, and Save stays in its footer', async ({ page }) => {
      await openNewPlaceForm(page)
      await page.setViewportSize({ width, height: height - KEYBOARD_PX })
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--vv-h')))
        .toBe(`${height - KEYBOARD_PX}px`)

      const fields = await page.locator('#place-new-form .place-new-fields').evaluate((el) => ({
        overflowY: getComputedStyle(el).overflowY,
        scrollable: el.scrollHeight > el.clientHeight,
      }))
      expect(fields.overflowY).toBe('auto')
      // With the keyboard up the field list is shorter than its content, so it
      // scrolls on its own and the footer is not part of that scroll.
      expect(fields.scrollable).toBe(true)
      expect(await page.locator('#place-new-form .place-new-footer #place-new-save').count()).toBe(1)
    })
  })
}
