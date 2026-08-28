/**
 * The one shared "get a live scan running" sequence for the browser specs.
 *
 * It exists because the sequence changed underneath every spec at once. Since
 * PR #205, tapping Scan opens the Place picker instead of starting AR directly
 * (src/main.ts calls requestPlaceSelection), so the old two-step goto → click
 * leaves the run parked on the sheet: #scan-stats stays empty, and the spec
 * times out on an assertion that never got the chance to be wrong. Sixteen
 * specs inlined that sequence and four learned the new step, which is exactly
 * the split a shared helper prevents happening again.
 */
import { expect, type Page } from '@playwright/test'

/**
 * Dismiss the Place picker that a Scan tap now opens.
 *
 * "Skip for now" is the proceed-without-a-Place path (the button formerly
 * labelled "Cancel"); AR starts from there. Split out from startArScan for the
 * callers that cannot use the whole sequence — they navigate differently, or
 * assert something between the boot and the tap — so those still share this
 * step rather than re-deriving it.
 *
 * Waits for the sheet rather than clicking straight through it: it renders
 * asynchronously (it reads the project store and waits on a geo fix), and under
 * a loaded worker that is well past Playwright's default click timeout. 30s
 * rather than the 20s that reads as generous: the first test in a cold run pays
 * Vite's transform cost on top, and was observed missing a 20s deadline with
 * the sheet never appearing at all, then passing on retry.
 */
export async function dismissPlacePicker(page: Page): Promise<void> {
  const skip = page.locator('#place-skip-btn')
  await expect(skip).toBeVisible({ timeout: 30_000 })
  await skip.click()
}

export interface StartArScanOptions {
  /** Where to boot. Defaults to the scripted 8th Wall mock engine. */
  url?: string
  /**
   * Register a dialog handler BEFORE navigating, and accept (true) or dismiss
   * (false) what it raises. A short mock scan lands at `needs-rescan`, so
   * anything that then exports raises the low-quality confirm; Playwright
   * dismisses dialogs by default — which is itself the cancel path — so callers
   * that care say which one they want. Omit to leave dialogs alone.
   */
  confirmLowQuality?: boolean
  /**
   * Wait for points to accumulate before returning (default true). Set false
   * for specs where AR is expected not to reach a scan — a denied motion
   * permission, a failing session — or that do their own best-effort wait.
   */
  waitForPoints?: boolean
}

/**
 * Boot the mock AR runtime and drive it to a live, point-accumulating scan.
 */
export async function startArScan(page: Page, options: StartArScanOptions = {}): Promise<void> {
  const { url = '/?mock=xr8', confirmLowQuality, waitForPoints = true } = options

  if (confirmLowQuality !== undefined) {
    page.on('dialog', (dialog) => {
      void (confirmLowQuality ? dialog.accept() : dialog.dismiss()).catch(() => {})
    })
  }

  await page.goto(url)

  // toBeEnabled, not toBeVisible: the button paints from static markup ~250ms
  // in, but ships disabled, and enablement is what marks its click handler as
  // live. Clicking on visibility used to land on nothing and be silently
  // dropped (that failed 3 runs out of 3).
  //
  // Enablement happens at the top of the boot, long before AR itself can start,
  // so this click still lands mid-boot — which is the point: it is the
  // regression test for that tap being honoured rather than lost.
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')

  await dismissPlacePicker(page)

  if (waitForPoints) {
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
  }
}
