/**
 * Mobile UI/UX flow screenshots (scanner, index.html).
 *
 * Drives the phone scanner through every everyday-user state in the mock 8th
 * Wall runtime (?mock=xr8) and writes documentation screenshots into
 * ../docs/ui-flow/mobile/, indexed by ../docs/ui-flow/README.md. These
 * illustrate ../docs/product/UX_FLOW.md Phases 0-1 (Install/FTUE + Scan a room).
 *
 * These are a visual *baseline*, not assertions about how a screen should look:
 * every wait below is best-effort, and a screen that renders badly is supposed
 * to be photographed badly rather than skipped. The one thing a shot must not
 * be is blank, so each test asserts the element it exists to show is on screen
 * before the shutter, and the run writes measurements.json for the geometry a
 * PNG cannot state — panel heights against the fold, which is what settles a
 * "does not fit on screen" report that a screenshot alone only illustrates.
 *
 * The real phone available for this work (a XREAL Beam Pro) has no ARCore and
 * its 8th Wall pipeline never emits a camera frame, so on-device AR capture
 * cannot produce these. The mock engine is not a convenience here, it is the
 * only path.
 *
 * Runs under the chromium-mock project (matches /mock-.*\.spec\.ts/). Needs the
 * Vite + Deno servers up (npm start), and --workers=1: these share server-side
 * session state with the other mock specs.
 *   PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
 *     npx playwright test --project=chromium-mock mock-ui-mobile --workers=1
 */
import { test, expect, type Page } from '@playwright/test'
import { QUEUED_OFFLINE_HEADER } from '../src/shared/offline-queue'
import { startArScan, dismissPlacePicker } from './support/start-scan'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SHOTS = join(process.cwd(), 'docs', 'ui-flow', 'mobile')

/**
 * Geometry a screenshot cannot state on its own — how far a panel overflows
 * the phone, which is the whole question for the Create New Place form.
 * Written once at the end of the run so the README can cite numbers.
 */
const measurements: Record<string, unknown> = {}

// iPhone-15-ish viewport on the chromium-mock browser (a webkit device
// descriptor can't be used under the chromium project, so set the metrics
// explicitly). deviceScaleFactor 2 keeps the PNGs a reasonable size.
const PHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
} as const

test.use(PHONE)

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, name) })

/**
 * Does the Create New Place form fit the phone it is on?
 *
 * A user reported it does not. The screenshots show what is on screen; this
 * says by how much, at whichever viewport the calling test is using, so the
 * two viewports below can be compared without eyeballing pixels.
 */
async function measureNewPlaceForm(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const panel = document.querySelector('#place-new-popup .place-popup-panel')
    const save = document.getElementById('place-new-save')
    if (!panel) return null
    const p = panel.getBoundingClientRect()
    const s = save?.getBoundingClientRect()
    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      panelHeight: Math.round(p.height),
      panelScrollHeight: Math.round(panel.scrollHeight),
      panelTop: Math.round(p.top),
      panelBottom: Math.round(p.bottom),
      saveButtonBottom: s ? Math.round(s.bottom) : null,
      // The user-visible symptom: is the primary action reachable without
      // scrolling, and does the panel spill past either edge of the phone?
      saveButtonBelowFold: s ? s.bottom > window.innerHeight : null,
      panelOverflowsViewport: p.bottom > window.innerHeight || p.top < 0,
      panelScrollsInternally: panel.scrollHeight > Math.ceil(p.height) + 1,
    }
  })
}

/** Tap Scan and wait for the Place sheet the tap opens (it does not start AR). */
async function openPlacePicker(page: Page): Promise<void> {
  await page.goto('/?mock=xr8')
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.click('#start-ar-btn')
  await expect(page.locator('#place-skip-btn')).toBeVisible({ timeout: 30_000 })
}

test.describe('mobile scanner flow screenshots', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(150_000)

  test.beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true })
  })

  test('01 FTUE onboarding, every step', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // ?onboarding=1 forces the overlay the first-time user sees; the plain
    // ?mock=xr8 boot skips it. Stepping it with the real Next button (rather
    // than toggling .active by hand) is what makes these shots the actual
    // screens — including whichever step is last, since the count went 3 → 5
    // once already and a hardcoded loop would silently miss the new ones.
    await page.goto('/?mock=xr8&onboarding=1')
    const overlay = page.locator('#onboarding-overlay')
    await expect(overlay).toBeVisible({ timeout: 30_000 })

    const next = page.locator('#onboard-next-btn')
    let steps = 0
    for (let i = 0; i < 12 && await overlay.isVisible(); i++) {
      steps = i + 1
      await page.waitForTimeout(250)
      await shot(page, `01-ftue-step-${steps}.png`)
      const isLast = (await next.textContent())?.trim() === 'Get Started'
      await next.click()
      if (isLast) break
    }
    measurements['ftueSteps'] = steps
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })

  test('02 start screen', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // ?mock skips onboarding, so this is the clean start screen.
    // Wait for *enabled*, not merely visible: #start-ar-btn paints disabled
    // with a "Preparing…" line until boot attaches its click handler, and the
    // documentation shot should show the ready state a user can actually tap.
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('#start-upload-card')).toBeVisible()
    await expect(page.locator('#start-editor-card')).toBeVisible()
    await shot(page, '02-start-screen.png')

    // Does the three-card stack fit the phone? Recorded rather than asserted —
    // this file photographs the layout, the layout work decides what to do.
    measurements['startScreen'] = await page.evaluate(() => {
      const paths = document.getElementById('start-paths')
      const rect = paths?.getBoundingClientRect()
      return {
        viewportHeight: window.innerHeight,
        pathsBottom: rect ? Math.round(rect.bottom) : null,
        overflowsViewport: rect ? rect.bottom > window.innerHeight : null,
      }
    })
  })

  test('03 place picker sheet', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openPlacePicker(page)
    await page.waitForTimeout(400)
    await shot(page, '03-place-picker.png')

    // The sheet is the other candidate for the reported "doesn't fit" — it
    // stacks a location card, two nav rows, an expandable Areas section and
    // two actions. Measured for the same reason as the form below.
    measurements['placeSheetPanel'] = await page.evaluate(() => {
      const panel = document.querySelector('#place-sheet .place-sheet-panel')
      const skip = document.getElementById('place-skip-btn')
      if (!panel) return null
      const p = panel.getBoundingClientRect()
      const s = skip?.getBoundingClientRect()
      return {
        viewportHeight: window.innerHeight,
        panelHeight: Math.round(p.height),
        panelScrollHeight: Math.round(panel.scrollHeight),
        panelTop: Math.round(p.top),
        panelBottom: Math.round(p.bottom),
        lastActionBottom: s ? Math.round(s.bottom) : null,
        lastActionBelowFold: s ? s.bottom > window.innerHeight : null,
        panelOverflowsViewport: p.bottom > window.innerHeight || p.top < 0,
      }
    })
  })

  test('04 place picker, full saved-place list', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openPlacePicker(page)
    await page.click('#place-nearby-btn')
    await expect(page.locator('#place-nearby-popup')).toBeVisible({ timeout: 10_000 })
    // Headless Chromium has no geolocation fix, so "within 100 m" is empty and
    // the sheet falls back to the explicit "Show all N saved places" control.
    // That is the state most first-run users indoors actually get, so shoot it
    // before expanding rather than only after.
    await page.waitForTimeout(400)
    await shot(page, '04-place-picker-nearby-empty.png')

    const showAll = page.locator('#place-nearby-list button', { hasText: /^Show all/ })
    if (await showAll.count() > 0) {
      await showAll.first().click()
      await page.waitForTimeout(400)
      await shot(page, '05-place-picker-all-places.png')
    }
  })

  test('06 place picker with a place selected, and its areas', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openPlacePicker(page)
    await page.click('#place-nearby-btn')
    await expect(page.locator('#place-nearby-popup')).toBeVisible({ timeout: 10_000 })
    const showAll = page.locator('#place-nearby-list button', { hasText: /^Show all/ })
    if (await showAll.count() > 0) await showAll.first().click()

    // Picks an existing project rather than POSTing a new one: these specs run
    // against the shared dev server, and a screenshot run should not leave
    // fixtures behind for the next reader of the Places list.
    const option = page.locator('#place-nearby-list .place-option').first()
    await expect(option).toBeVisible({ timeout: 10_000 })
    await option.click()
    await expect(page.locator('#place-continue-btn')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await shot(page, '06-place-picker-selected.png')

    // The Areas section is disabled until a place is selected, so this is the
    // only route to the "Add an area" form.
    await page.click('#place-areas summary')
    await page.locator('#place-area-new-btn').click().catch(() => { /* section may render without it */ })
    await page.waitForTimeout(400)
    await shot(page, '07-place-picker-areas.png')
  })

  test('08 Create New Place Project form', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openPlacePicker(page)
    await page.click('#place-new-btn')
    const popup = page.locator('#place-new-popup')
    await expect(popup).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#place-new-save')).toBeAttached()
    await page.waitForTimeout(400)

    // Two shots on purpose. The viewport one is what the phone shows — if the
    // Save button is off the bottom, that is the bug a user reported and it
    // belongs in the record uncropped and unscrolled. The element one captures
    // the panel's full box (Playwright stitches past the viewport), so the two
    // together say both "here is what fits" and "here is what there was".
    await shot(page, '08-place-new-form-viewport.png')
    await page.locator('#place-new-popup .place-popup-panel')
      .screenshot({ path: join(SHOTS, '09-place-new-form-full.png') })

    measurements['placeNewForm@393x852'] = await measureNewPlaceForm(page)
  })

  test('10 live scanning HUD (tracking)', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // waitForPoints: false — these are documentation shots, and each does its
    // own best-effort wait for whatever it needs to render below.
    await startArScan(page, { waitForPoints: false })

    // The HUD before the mock SLAM has locked on: "Move camera to initialise
    // tracking…", zero points, empty coverage. It is a real screen a user sees
    // for several seconds and it looks nothing like the tracking one.
    await expect(page.locator('#capture-btn')).toBeVisible({ timeout: 20_000 })
    await shot(page, '10-scanning-hud-initialising.png')

    // Wait for the scripted SLAM mock to accumulate points / lock tracking.
    await page.waitForFunction(() => {
      const s = document.getElementById('scan-stats')
      const status = document.getElementById('status-text')?.textContent ?? ''
      return (/[1-9]\d*/.test(s?.textContent ?? '')) || /track|capture/i.test(status)
    }, { timeout: 30_000 }).catch(() => { /* best-effort: screenshot whatever rendered */ })
    await page.waitForTimeout(1500) // let the quality overlay populate
    await shot(page, '11-scanning-hud-tracking.png')

    // Coverage/quality guidance sits in its own overlay; crop it so the
    // wording is legible at 1:1 in the docs rather than 12px tall in a phone
    // frame. Best-effort — if it has not populated, the full HUD above is the
    // honest record of that.
    await page.locator('#quality-overlay')
      .screenshot({ path: join(SHOTS, '12-quality-guidance.png') })
      .catch(() => { /* overlay not up: the HUD shots already show that */ })
  })

  test('13 capture + latest-scan dialog', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // waitForPoints: false — these are documentation shots, and each does its
    // own best-effort wait for whatever it needs to render below.
    await startArScan(page, { waitForPoints: false })
    await page.waitForFunction(() => /[1-9]\d*/.test(document.getElementById('scan-stats')?.textContent ?? ''),
      { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await page.click('#capture-btn')
    // The "Latest scan" dialog auto-shows on a resolved capture.
    await page.locator('#infer-dialog').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, '13-capture-dialog.png')
  })

  test('14 detections side panel, empty', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // waitForPoints: false — these are documentation shots, and each does its
    // own best-effort wait for whatever it needs to render below.
    await startArScan(page, { waitForPoints: false })
    await page.waitForFunction(() => /[1-9]\d*/.test(document.getElementById('scan-stats')?.textContent ?? ''),
      { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(1000)

    // The empty panel is where the "No objects yet" copy and the greyed-out
    // export actions live, and it is the first thing a curious user opens. The
    // populated one needs a stubbed /infer, so it lives in the group below.
    await page.click('#panel-toggle')
    await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, '14-detections-panel-empty.png')
  })

  test('16 history drawer', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // waitForPoints: false — these are documentation shots, and each does its
    // own best-effort wait for whatever it needs to render below.
    await startArScan(page, { waitForPoints: false })
    await page.waitForTimeout(2500)
    await page.click('#history-btn')
    await page.locator('#history-drawer').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(600)
    await shot(page, '16-history-drawer.png')
  })

  test('21 motion-permission denial banner', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // Headless Chromium has DeviceOrientationEvent but not requestPermission
    // (iOS Safari only), so install the iOS-shaped API and have it answer
    // 'denied' — the same stub mock-motion-permission.spec.ts uses. This is
    // the one error state reachable without breaking the server for the other
    // specs sharing it.
    await page.addInitScript(() => {
      const respond = () => Promise.resolve('denied')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(DeviceOrientationEvent as any).requestPermission = respond
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(DeviceMotionEvent as any).requestPermission = respond
    })
    await startArScan(page, { waitForPoints: false })
    await expect(page.locator('#permission-error-banner')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(400)
    await shot(page, '21-permission-denied-banner.png')
  })

  test('22 walkthrough-video upload path', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.route('**/ingest-video', async (route) => {
      await route.fulfill({
        status: 202, contentType: 'application/json',
        body: JSON.stringify({ sessionId: 'sess-doc', scanId: 'scan-sess-doc', jobId: 'job-x', frameCount: 12 }),
      })
    })
    await page.goto('/?mock=xr8')
    await expect(page.locator('#upload-video-btn')).toBeVisible({ timeout: 20_000 })
    await page.setInputFiles('#upload-video-input', {
      name: 'walkthrough.mp4', mimeType: 'video/mp4', buffer: Buffer.from('FAKE-VIDEO-BYTES'),
    })
    // Choosing a file opens the Place sheet before the upload starts, the same
    // gate the Scan path goes through.
    await dismissPlacePicker(page).catch(() => { /* older build: no gate */ })
    await page.locator('#upload-video-open').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, '22-video-upload.png')
  })
})

/**
 * The panel with objects in it, and every export result state.
 *
 * Separate describe for two reasons.
 *
 * The service worker has to be blocked: since the cert flag landed (#95) the
 * worker actually installs under chromium-mock and /upload-scan is one of its
 * queueable prefixes, so page.route() would stop intercepting and every shot
 * would show whatever the real server said. The point of this group is one
 * screenshot per outcome, so the outcome has to be exact. Same reasoning as
 * mock-export-outcome.spec.ts, which asserts the labels these photograph.
 *
 * And /infer is stubbed, because the dev server these run against answers with
 * the real Ollama engine (`/health` reports mode "ollama"), not the mock the
 * spec headers assume — and the real VLM finds nothing in the mock runtime's
 * synthetic frame, so the panel stays empty and there is nothing to export.
 * Stubbing the response client-side is what INFERENCE_MODE=mock does on the
 * server; it just does not need the server restarted out from under the other
 * specs sharing it.
 */
test.describe('mobile detections and export result states', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  test.use({ ...PHONE, serviceWorkers: 'block' })

  /**
   * Two centred, high-confidence detections in the RawDetection shape
   * src/inference/prompt.ts declares. Centred because the client raycasts each
   * bbox centre into the point cloud to place the object — a box over empty
   * screen resolves to nothing and never reaches the panel.
   */
  const STUB_DETECTIONS = [
    { label: 'chair', bbox: [0.32, 0.34, 0.62, 0.74], confidence: 0.93, description: 'wooden dining chair' },
    { label: 'table', bbox: [0.18, 0.46, 0.86, 0.88], confidence: 0.88, description: 'light oak table' },
  ]

  async function stubInference(page: Page): Promise<void> {
    await page.route('**/infer', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STUB_DETECTIONS),
    }))
  }

  /** Scan until there is something worth exporting, then open the panel. */
  async function scanThenOpenPanel(page: Page, confirmLowQuality = true): Promise<void> {
    await stubInference(page)
    // A short mock scan lands at `needs-rescan`, so exporting raises the
    // low-quality confirm; the handler must be registered before navigation,
    // so it is passed into startArScan rather than attached here.
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

  test('15 detections side panel, populated', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await scanThenOpenPanel(page)
    await page.waitForTimeout(600)
    await shot(page, '15-detections-panel.png')
  })

  /** Click Export and wait for the button to settle on a verdict label. */
  async function exportAndSettle(page: Page): Promise<void> {
    const btn = page.locator('#panel-export-glb-btn')
    await btn.click()
    // "Exporting..." is transient; the verdict is the screen worth shooting.
    await expect
      .poll(async () => await btn.textContent(), { timeout: 45_000 })
      .not.toMatch(/Exporting/)
  }

  test('17 export succeeded', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ filename: 'room-scan-doc.glb' }),
    }))
    await scanThenOpenPanel(page)
    await exportAndSettle(page)
    await expect(page.locator('#export-view-link')).toBeVisible({ timeout: 10_000 })
    await shot(page, '17-export-succeeded.png')
  })

  test('18 export saved on device, server sync failed', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({ status: 500, body: 'nope' }))
    await scanThenOpenPanel(page)
    await exportAndSettle(page)
    await shot(page, '18-export-server-rejected.png')
  })

  test('19 export queued offline', async ({ page }) => {
    await page.route('**/upload-scan', (route) => route.fulfill({
      status: 202,
      headers: { 'Content-Type': 'application/json', [QUEUED_OFFLINE_HEADER]: '1' },
      body: JSON.stringify({ ok: false, queuedOffline: true, queueId: 'q1' }),
    }))
    await scanThenOpenPanel(page)
    await exportAndSettle(page)
    await shot(page, '19-export-queued-offline.png')
  })

  test('20 export cancelled at the low-quality confirm', async ({ page }) => {
    // Dismissing the confirm is the cancel path; nothing is written.
    await scanThenOpenPanel(page, false)
    await exportAndSettle(page)
    await shot(page, '20-export-cancelled.png')
  })
})

/**
 * The same two sheets on the smallest phone still in circulation.
 *
 * The "Create New Place Project form does not fit on screen" report does not
 * reproduce at 393x852 — measurements.json shows the panel ending 243 px above
 * the fold there. Rather than close the report on one viewport, shoot it again
 * at iPhone-SE metrics (375x667), which is 185 px shorter and the shape most
 * likely to have been the reporter's. Whatever these show is the answer: if it
 * fits here too, the report is about something else (a keyboard-shrunk visual
 * viewport, or a build older than this tree) and that is worth knowing.
 */
test.describe('small-phone place sheets (iPhone SE metrics)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  test.use({ ...PHONE, viewport: { width: 375, height: 667 } })

  test.afterAll(async () => {
    await writeFile(join(SHOTS, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  })

  test('23 place sheet and new-place form at 375x667', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openPlacePicker(page)
    await page.waitForTimeout(400)
    await shot(page, '23-place-picker-small.png')

    await page.click('#place-new-btn')
    await expect(page.locator('#place-new-popup')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#place-new-save')).toBeAttached()
    await page.waitForTimeout(400)
    await shot(page, '24-place-new-form-small-viewport.png')
    measurements['placeNewForm@375x667'] = await measureNewPlaceForm(page)

    // Focus alone changes nothing (recorded, not shot — the PNG came out
    // byte-identical to the one above).
    await page.locator('#place-new-name').focus()
    await page.waitForTimeout(300)
    measurements['placeNewForm@375x667+focus'] = await measureNewPlaceForm(page)

    // The state the form is *actually* filled in on a phone: keyboard up. iOS
    // Safari's soft keyboard leaves roughly 340 px of visual viewport on an SE,
    // and headless Chromium has no keyboard to raise — so the height is set
    // directly. That is a simulation and is labelled as one, but it is the only
    // way to test the geometry the reporter was probably looking at, and the
    // popup is centred in the viewport, so shrinking the viewport is exactly
    // what the keyboard does to it.
    await page.setViewportSize({ width: 375, height: 340 })
    await page.waitForTimeout(400)
    await shot(page, '25-place-new-form-keyboard-sim.png')
    measurements['placeNewForm@375x340 (keyboard simulated)'] = await measureNewPlaceForm(page)
  })
})
