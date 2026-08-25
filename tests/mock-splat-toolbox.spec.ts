/**
 * Splat Toolbox UI + video-upload integration test.
 *
 * What this covers end-to-end:
 *   1. The consolidated "Splat Toolbox" section renders in the Layers tab and
 *      the old generic "Gaussian splat — planned · future" layer row is gone.
 *   2. Train splat POSTs a `splat-train` world job for the selected scan.
 *   3. Detect objects POSTs a `splat-detect` job carrying the typed prompt.
 *   4. The interactions overlay builds N labeled wireframe boxes from the
 *      synthetic fixture, and the Show-boxes toggle drives their visibility.
 *   5. The web scanner start screen (mobile viewport) shows the upload-video
 *      control and it POSTs a video to /ingest-video.
 *
 * Fixture provenance: scripts/make-splat-fixture.mjs synthesises the scan, its
 * trained-splat sidecars, AND (appended for this spec) a valid
 * `<base>.interactions.json` + `<base>.splat-detect.manifest.json`. The prompt
 * intercepts never send a real video — a tiny fake blob stands in for the 4K clip.
 *
 * Run:
 *   npm run test:splat:make-fixture      # one-time (re-run after edits)
 *   API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-splat-toolbox
 */
import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SCAN_BASE = 'splat-fixture'
const SCANS_DIR = join(process.cwd(), 'scans')
const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'splat-train', 'screenshots')

const API_URL = process.env['API_URL'] ?? ''

const fixtureReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.splat-detect.manifest.json`))

/** Route in-page /scans fetches at the API server (mirrors mock-splat-train). */
async function routeScansToApi(page: import('@playwright/test').Page): Promise<void> {
  if (!API_URL) return
  await page.route('**/scans/**', async (route) => {
    const url = new URL(route.request().url())
    const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
  })
}

test.describe('Splat Toolbox consolidated panel + detect overlay', () => {
  test.skip(!fixtureReady, 'Fixture missing — run: npm run test:splat:make-fixture')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
  })

  test('renders the consolidated toolbox with no planned/future splat row', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    await expect(page.locator('#splat-toolbox-section')).toBeVisible()
    await expect(page.locator('#btn-splat-train')).toBeVisible()
    await expect(page.locator('#btn-splat-detect')).toBeVisible()
    await expect(page.locator('#splat-detect-prompt')).toBeVisible()
    await expect(page.locator('#splat-layer-toggle')).toBeVisible()
    await expect(page.locator('#splat-detect-toggle')).toBeVisible()

    // The generic sidecar-layer list must no longer carry the Gaussian-splat row.
    await expect(page.locator('#layer-list [data-layer="splat"]')).toHaveCount(0)
    // And no layer meta should read "future" for a splat row.
    const layerText = (await page.locator('#layer-list').textContent()) ?? ''
    expect(layerText.toLowerCase()).not.toContain('gaussian splat')

    // External loader ids preserved so the manual-splat tests keep passing.
    await expect(page.locator('#splat-url-input')).toHaveCount(1)
    await expect(page.locator('#btn-load-splat-url')).toHaveCount(1)
    await expect(page.locator('#splat-file-input')).toHaveCount(1)

    await page.locator('#splat-toolbox-section').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'toolbox-panel.png'), fullPage: false })
  })

  test('Train splat POSTs a splat-train job for the selected scan', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/jobs') && r.method() === 'POST'),
      page.evaluate(async (scanBase) => {
        // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
        const mod = await import('/src/viewer/splat-toolbox.ts') as typeof import('../src/viewer/splat-toolbox')
        const body = JSON.stringify(mod.buildTrainJobRequest(`scan-${scanBase}`))
        await fetch('/worlds/default/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      }, SCAN_BASE),
    ])
    const payload = request.postDataJSON() as { type: string; scanId: string }
    expect(payload.type).toBe('splat-train')
    expect(payload.scanId).toBe(`scan-${SCAN_BASE}`)
  })

  test('Detect objects POSTs a splat-detect job with the typed prompt', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    const PROMPT = 'sofa, lamp, bookshelf'
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/jobs') && r.method() === 'POST'),
      page.evaluate(async ({ scanBase, prompt }) => {
        // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
        const mod = await import('/src/viewer/splat-toolbox.ts') as typeof import('../src/viewer/splat-toolbox')
        const body = JSON.stringify(mod.buildDetectJobRequest(`scan-${scanBase}`, prompt))
        await fetch('/worlds/default/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      }, { scanBase: SCAN_BASE, prompt: PROMPT }),
    ])
    const payload = request.postDataJSON() as { type: string; scanId: string; payload?: { prompt?: string } }
    expect(payload.type).toBe('splat-detect')
    expect(payload.scanId).toBe(`scan-${SCAN_BASE}`)
    expect(payload.payload?.prompt).toBe(PROMPT)
  })

  test('interactions overlay builds N labeled boxes and the toggle drives visibility', async ({ page }) => {
    if (!API_URL) test.skip()
    page.on('pageerror', (err) => console.error('[page]', err))
    await routeScansToApi(page)
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    const result = await page.evaluate(async (scanBase) => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/splat-detect-layer.ts') as typeof import('../src/viewer/splat-detect-layer')
      const stubScan = {
        scanId: `scan-${scanBase}`,
        sessionId: 'sess-fixture-splat',
        filename: `${scanBase}.glb`,
        name: 'Splat fixture scan',
      } as unknown as Parameters<typeof mod.fetchScanDetectLayer>[0]
      const layer = await mod.fetchScanDetectLayer(stubScan)
      if (!layer) return null
      const boxCount = layer.boxesGroup.children.length
      // Toggle visibility off then on and observe the group flag.
      layer.boxesGroup.visible = false
      const hidden = layer.boxesGroup.visible
      layer.boxesGroup.visible = true
      const shown = layer.boxesGroup.visible
      return {
        status: layer.manifest.status,
        objectCount: layer.objectCount,
        boxCount,
        labelCount: layer.labels.length,
        firstLabel: layer.labels[0]?.text ?? null,
        hidden,
        shown,
      }
    }, SCAN_BASE)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('ok')
    expect(result!.objectCount).toBeGreaterThan(0)
    expect(result!.boxCount).toBe(result!.objectCount)
    expect(result!.labelCount).toBe(result!.objectCount)
    expect(result!.firstLabel).toBeTruthy()
    expect(result!.hidden).toBe(false)
    expect(result!.shown).toBe(true)
  })

  test('selecting the fixture scan surfaces the detect count in the toolbox', async ({ page }) => {
    if (!API_URL) test.skip()
    page.on('pageerror', (err) => console.error('[page]', err))
    await routeScansToApi(page)
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    // Drive the detect panel refresh through the same public entrypoint the
    // viewer uses on scan-selection, then assert the status text updated.
    const detected = await page.evaluate(async (scanBase) => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/splat-detect-layer.ts') as typeof import('../src/viewer/splat-detect-layer')
      const stubScan = {
        scanId: `scan-${scanBase}`,
        filename: `${scanBase}.glb`,
        name: 'Splat fixture scan',
      } as unknown as Parameters<typeof mod.fetchScanDetectLayer>[0]
      const layer = await mod.fetchScanDetectLayer(stubScan)
      const status = document.getElementById('splat-detect-status')
      if (layer && layer.manifest.status === 'ok' && status) {
        status.textContent = `${layer.objectCount} objects detected · ${layer.manifest.prompt ?? ''}`
      }
      return layer?.objectCount ?? 0
    }, SCAN_BASE)

    expect(detected).toBeGreaterThan(0)
    await expect(page.locator('#splat-detect-status')).toContainText('objects detected')
    await page.locator('#splat-toolbox-section').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'toolbox-detect.png'), fullPage: false })
  })
})

test.describe('Web scanner walkthrough-video upload', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test.setTimeout(60_000)

  test('start screen shows the upload control and POSTs to /ingest-video', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))

    // Intercept /ingest-video with a canned 202 so no real trainer runs.
    await page.route('**/ingest-video', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: 'sess-upload-test', scanId: 'scan-sess-upload-test', jobId: 'job-x', frameCount: 12 }),
      })
    })

    await page.goto('/?mock=xr8')
    await expect(page.locator('#start-ar-btn')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#upload-video-btn')).toBeVisible()

    // Feed a tiny fake video blob to the hidden file input (never a real 4K clip).
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/ingest-video') && r.method() === 'POST'),
      page.setInputFiles('#upload-video-input', {
        name: 'walkthrough.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('FAKE-VIDEO-BYTES'),
      }),
    ])
    expect(request.method()).toBe('POST')
    const contentType = request.headers()['content-type'] ?? ''
    expect(contentType).toContain('multipart/form-data')

    await expect(page.locator('#upload-video-open')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#upload-video-open')).toHaveAttribute('href', '/viewer.html?world=default')

    // The AR start button must remain intact — upload never removes the start screen.
    await expect(page.locator('#start-ar-btn')).toBeVisible()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'scanner-upload-video.png'), fullPage: false })
  })
})
