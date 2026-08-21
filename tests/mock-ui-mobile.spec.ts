/**
 * Mobile UI/UX flow screenshots (scanner, index.html).
 *
 * Drives the phone scanner through every everyday-user state in the mock 8th
 * Wall runtime (?mock=xr8, INFERENCE_MODE=mock) and writes documentation
 * screenshots into docs/ui-flow/mobile/. These illustrate docs/UX_FLOW.md
 * Phases 0-1 (Install/FTUE + Scan a room).
 *
 * Runs under the chromium-mock project (matches /mock-.*\.spec\.ts/). Needs the
 * Vite + mock-Deno servers up:
 *   PORT=8100 INFERENCE_MODE=mock deno run ... main.ts
 *   TAILSCALE_HOSTNAME=localhost API_TARGET=http://localhost:8100 npx vite --host
 *   VITE_URL=https://localhost:5174 API_URL=http://localhost:8100 \
 *     npx playwright test --project=chromium-mock mock-ui-mobile
 */
import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SHOTS = join(process.cwd(), 'docs', 'ui-flow', 'mobile')

// iPhone-15-ish viewport on the chromium-mock browser (a webkit device
// descriptor can't be used under the chromium project, so set the metrics
// explicitly). deviceScaleFactor 2 keeps the PNGs a reasonable size.
test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

test.describe('mobile scanner flow screenshots', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true })
  })

  test('01 start screen', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // ?mock skips onboarding, so this is the clean start screen.
    // Wait for *enabled*, not merely visible: #start-ar-btn paints disabled
    // with a "Preparing…" line until boot attaches its click handler, and the
    // documentation shot should show the ready state a user can actually tap.
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('#upload-video-btn')).toBeVisible()
    await page.screenshot({ path: join(SHOTS, '01-start-screen.png') })
  })

  test('02-06 onboarding overlay (5 steps)', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // Load with the mock runtime present (no page errors) but force the
    // onboarding overlay the everyday first-time user sees. Driving it via the
    // real markup keeps the styling authentic; we set active step/dot directly
    // so the shot is deterministic regardless of the first-run localStorage gate.
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })

    for (const step of [0, 1, 2, 3, 4]) {
      await page.evaluate((i) => {
        const ob = document.getElementById('onboarding-overlay')
        if (!ob) return
        ob.classList.add('visible')
        ob.querySelectorAll<HTMLElement>('.onboard-step').forEach((s, idx) =>
          s.classList.toggle('active', idx === i))
        ob.querySelectorAll<HTMLElement>('.onboard-dot').forEach((d, idx) =>
          d.classList.toggle('active', idx === i))
        const next = document.getElementById('onboard-next-btn')
        if (next) next.textContent = i === 4 ? 'Get Started' : 'Next'
      }, step)
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(SHOTS, `0${step + 2}-onboarding-step-${step + 1}.png`) })
    }
  })

  test('05 live scanning HUD (tracking)', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')

    // Wait for the scripted SLAM mock to accumulate points / lock tracking.
    await page.waitForFunction(() => {
      const s = document.getElementById('scan-stats')
      const status = document.getElementById('status-text')?.textContent ?? ''
      return (/[1-9]\d*/.test(s?.textContent ?? '')) || /track|capture/i.test(status)
    }, { timeout: 30_000 }).catch(() => { /* best-effort: screenshot whatever rendered */ })
    await page.waitForTimeout(1500) // let the quality overlay populate
    await expect(page.locator('#capture-btn')).toBeVisible()
    await page.screenshot({ path: join(SHOTS, '05-scanning-hud.png') })
  })

  test('06 capture + latest-scan dialog', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await page.waitForFunction(() => /[1-9]\d*/.test(document.getElementById('scan-stats')?.textContent ?? ''),
      { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await page.click('#capture-btn')
    // The "Latest scan" dialog auto-shows on a resolved capture.
    await page.locator('#infer-dialog').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, '06-capture-dialog.png') })
  })

  test('07 detections side panel', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await page.waitForFunction(() => /[1-9]\d*/.test(document.getElementById('scan-stats')?.textContent ?? ''),
      { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(1000)
    // Capture twice so the panel has object cards.
    await page.click('#capture-btn'); await page.waitForTimeout(1500)
    await page.click('#capture-btn'); await page.waitForTimeout(1500)
    await page.click('#panel-toggle')
    await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, '07-detections-panel.png') })
  })

  test('08 history drawer', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await page.waitForTimeout(2500)
    await page.click('#history-btn')
    await page.locator('#history-drawer').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, '08-history-drawer.png') })
  })

  test('09 walkthrough-video upload path', async ({ page }) => {
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
    await page.locator('#upload-video-open').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, '09-video-upload.png') })
  })
})
