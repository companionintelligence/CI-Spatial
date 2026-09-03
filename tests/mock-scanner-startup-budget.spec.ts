/**
 * Scanner startup budget — the first-run path, held to measured limits.
 *
 * The startup had drifted into five full-screen tutorial steps (139 words of
 * copy naming SLAM, VLM, Gaussian Splats and GLB) in front of a start screen,
 * in front of a mandatory Place picker whose only non-creating button was
 * labelled "Cancel". Nothing failed, so nothing caught it — the one spec that
 * covered this screen (mock-ftue) had been red since #128 and CI never runs
 * Playwright at all.
 *
 * These are budgets, not pixel snapshots: they say "the camera stays the
 * subject and the words stay few" without freezing the design. Each ceiling
 * sits just above the measured value at the time of writing, so a real
 * regression trips it and a cosmetic tweak does not.
 *
 * The word budget is no longer held here. It went 20 words over in #223 and
 * stayed over, because this file only runs where a browser and a Vite server
 * do — GitHub CI runs no Playwright at all, so the only thing that ever
 * executed the assertion was a local `npm run loop`. It now lives in
 * tests/unit/node/startup_word_budget.test.ts, which computes the same number
 * from index.html and `resolveCapture()` for every subject x device and runs
 * in `npm run verify`, hence on every push.
 *
 * What is left here is the half a model cannot have: this measures the DOM a
 * browser actually paints, and asserts it against the model rather than
 * against a literal. If the scanner in tests/support/startup-budget.ts ever
 * reads the markup differently from the way Chrome renders it, this is what
 * says so.
 *
 * It also guards the shape that makes the number possible. The un-recommended
 * methods are behind `#start-alt-toggle`, and a ceiling met by deleting the
 * second sentence off every card would pass just as well while retracting the
 * "size is not measured" clause capture_intent.test.ts exists to keep on
 * screen — so the disclosure, and the keyboard path into it, are asserted here
 * rather than inferred from a small total.
 *
 * Run: npx playwright test --project=chromium-mock mock-scanner-startup-budget
 */
import { test, expect, type Page } from '@playwright/test'
import {
  MOCK_CASE,
  WORDS_BEFORE_CAMERA_MAX,
  wordsBeforeCamera,
} from './support/startup-budget.ts'

test.use({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

/** Words in an element's rendered text, ignoring collapsed whitespace. */
async function wordCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return 0
    return (el.innerText || '').trim().split(/\s+/).filter(Boolean).length
  }, selector)
}

/**
 * Fraction of the viewport painted over by UI, as a percentage.
 *
 * Deliberately NOT elementFromPoint: the HUD is `pointer-events: none`, so a
 * hit-test walks straight through it and reports the camera as unobstructed
 * (measured 6.8% that way, against 23.6% actually painted). This rasterises
 * the union of every visible element that paints a background — which is what
 * "UI over the camera" means to someone holding the phone.
 */
async function occlusionPct(page: Page): Promise<number> {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight, S = 8
    const painted: DOMRect[] = []
    const walk = (n: Element) => {
      for (const e of Array.from(n.children)) {
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
        const r = e.getBoundingClientRect()
        if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) {
          walk(e)
          continue
        }
        const m = (cs.backgroundColor || '').match(/rgba?\(([^)]+)\)/)
        const parts = m ? m[1].split(',') : []
        const alpha = m ? (parts[3] !== undefined ? parseFloat(parts[3]) : 1) : 0
        if (alpha > 0.05 || cs.backdropFilter !== 'none') painted.push(r)
        walk(e)
      }
    }
    walk(document.body)

    const grid = new Set<string>()
    for (const r of painted) {
      const x0 = Math.max(0, r.left), x1 = Math.min(W, r.right)
      const y0 = Math.max(0, r.top), y1 = Math.min(H, r.bottom)
      for (let y = Math.floor(y0 / S) * S + S / 2; y < y1; y += S) {
        for (let x = Math.floor(x0 / S) * S + S / 2; x < x1; x += S) {
          if (x < x0 || y < y0) continue
          grid.add(`${x},${y}`)
        }
      }
    }
    return (grid.size / (Math.ceil(W / S) * Math.ceil(H / S))) * 100
  })
}

test.describe('scanner startup budget', () => {
  test.setTimeout(90_000)

  test('onboarding is short, plain, and jargon-free', async ({ page }) => {
    await page.goto('/?mock=xr8&onboarding=1')
    await expect(page.locator('#onboarding-overlay')).toBeVisible({ timeout: 15_000 })

    // Two steps. This is the only thing between a first-run visitor and the
    // camera; it went 3 → 5 once without anyone noticing.
    await expect(page.locator('.onboard-step')).toHaveCount(2)
    // The dots are the progress affordance — a mismatch silently lies about
    // how much is left, which is exactly what a five-dot/five-step wall did.
    await expect(page.locator('.onboard-dot')).toHaveCount(2)

    const words = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.onboard-desc'))
        .reduce((a, e) => a + ((e as HTMLElement).textContent || '').trim().split(/\s+/).filter(Boolean).length, 0))
    expect(words, 'total onboarding body words (was 139)').toBeLessThanOrEqual(60)

    // Implementation vocabulary belongs in the repo, not on a first-run screen.
    const copy = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.onboard-title, .onboard-desc'))
        .map(e => (e as HTMLElement).textContent || '').join(' '))
    for (const term of ['SLAM', 'VLM', 'Gaussian', 'GLB', 'keyframe', 'pipeline']) {
      expect(copy, `onboarding copy must not say "${term}"`).not.toMatch(new RegExp(term, 'i'))
    }
  })

  test('reaching the camera takes three taps and stays under a word budget', async ({ page }) => {
    await page.goto('/?mock=xr8&onboarding=1')
    await expect(page.locator('#onboarding-overlay')).toBeVisible({ timeout: 15_000 })

    const onboardingWords = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.onboard-desc'))
        .reduce((a, e) => a + ((e as HTMLElement).textContent || '').trim().split(/\s+/).filter(Boolean).length, 0))
    const startWords = await wordCount(page, '#start-screen')

    // `?mock=xr8` loads the in-browser engine and nothing else, and `room` is
    // preselected — the one screen out of 24 this run renders. Parity first,
    // because a budget met by a model that has stopped seeing half the screen
    // is worse than no budget: the numbers must agree before either is trusted.
    const model = wordsBeforeCamera(MOCK_CASE.subject, MOCK_CASE.device)
    expect(onboardingWords, 'onboarding words: browser vs tests/support/startup-budget.ts')
      .toBe(model.onboarding)
    expect(startWords, 'start-screen words: browser vs tests/support/startup-budget.ts')
      .toBe(model.total - model.onboarding)

    // Was 197, then 120, then 155, and 110 since the disclosure landed — see
    // the reasoning on WORDS_BEFORE_CAMERA_MAX. Held here too so the ceiling is
    // checked against a real render and not only against the model.
    expect(onboardingWords + startWords, 'words shown before the camera')
      .toBeLessThanOrEqual(WORDS_BEFORE_CAMERA_MAX)

    // The un-recommended methods are behind #start-alt-toggle, which is what
    // brought that total back under the ceiling — so assert the disclosure is
    // doing the work, not that the number happens to be small. Without this,
    // deleting the second sentence off every card would pass the line above
    // while removing the "size is not measured" clause that
    // tests/unit/node/capture_intent.test.ts exists to keep on screen.
    const toggle = page.locator('#start-alt-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // The recommendation is never behind it, and neither is the editor card.
    await expect(page.locator('#start-paths [data-recommended="true"]')).toBeVisible()
    await expect(page.locator('#start-editor-card')).toBeVisible()
    await expect(page.locator('#start-upload-card')).toBeHidden()
    await expect(page.locator('#start-tripod-card')).toBeHidden()

    // Keyboard, because "one tap away" has to be one key away too. Focus the
    // control and press Enter: the methods appear, and the next Tab walks into
    // them rather than past them — which is the whole reason
    // renderCaptureChoice() reorders the cards instead of setting CSS `order`.
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#start-tripod-card')).toBeVisible()
    await expect(page.locator('#start-upload-card')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.locator('#start-tripod-card')).toBeFocused()

    // Closed again, so the taps below start from the screen this test measured.
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Tap 1 — skip the tutorial.
    await page.locator('#onboard-skip').click()
    // Tap 2 — choose the scan path.
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.locator('#start-ar-btn').click()

    // Tap 3 — proceed without a Place. The label must read as "carry on", not
    // as "abandon": with no saved Places and no GPS fix, this and "Create New
    // Place Project" are the only choices, and a first-run visitor who reads
    // this one as Cancel has no way to the camera that does not involve
    // filling in a form they did not ask for.
    const skip = page.locator('#place-skip-btn')
    await expect(skip).toBeVisible({ timeout: 15_000 })
    await expect(skip).not.toHaveText(/^cancel$/i)
    await skip.click()

    await expect(page.locator('#start-screen')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 25_000 })
  })

  test('the camera stays the subject once scanning', async ({ page }) => {
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.locator('#start-ar-btn').click()
    // Wait for the sheet rather than clicking straight through it: the Place
    // modal renders asynchronously (it reads the project store and waits on a
    // geo fix), and under a loaded worker that is well past Playwright's
    // default click timeout. Clicking blind passed alone and failed in the
    // full-suite run.
    const skip = page.locator('#place-skip-btn')
    await expect(skip).toBeVisible({ timeout: 20_000 })
    await skip.click()
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })

    // No fix yet under mocks: the chip must be hidden, not showing "Locating…"
    // / "Compass waiting" as if stuck. Asserted BEFORE the chip is populated
    // below — order matters, these two assertions describe opposite states.
    await expect(page.locator('#geo-chip')).toBeHidden()

    // The steady-state status must fit #status-row (~211px, about 25
    // characters) on one line. "Tracking — tap to capture" wrapped, leaving
    // "capture" dangling under the quality chip.
    // Poll rather than sample once: setStatus() also carries transient notices
    // (e.g. "Point cloud thinned to save memory"), so a single read can catch
    // one mid-flight and fail on copy that is allowed to be long.
    await expect.poll(
      async () => ((await page.locator('#status-text').textContent()) ?? '').trim().length,
      { timeout: 20_000, message: 'steady-state status copy must fit #status-row on one line' },
    ).toBeLessThanOrEqual(28)

    // Now measure the WORST case, not the convenient one. Under mocks there is
    // never a GPS fix, so the HUD is at its smallest — which is exactly what
    // made the desktop number (21.4%) look comfortable while a real phone with
    // a fix measured 32.3% on the same build. Populate the chip the way
    // updateGeoIndicator() does on hardware and hold the budget against that.
    await page.evaluate(() => {
      const chip = document.getElementById('geo-chip')
      const address = document.getElementById('geo-address')
      if (!chip || !address) return
      address.textContent = '30902 Club House Drive, Laguna Niguel, California 92677'
      chip.style.display = 'flex'
    })

    const pct = await occlusionPct(page)
    expect(pct, 'viewport painted over by UI, geo chip populated (device measured 32.3 before)')
      .toBeLessThanOrEqual(25)
  })
})
