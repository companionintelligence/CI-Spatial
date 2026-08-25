/**
 * Desktop world-editor UI/UX flow screenshots (viewer.html).
 *
 * Drives the desktop editor through every structuring/processing surface and
 * writes documentation screenshots into ../docs/product/ui-flow/desktop/. These illustrate
 * ../docs/product/UX_FLOW.md Phases 2-4 (Structure / Process / Export-Share).
 *
 * Runs under the chromium-mock project. Needs Vite + mock-Deno up with a seeded
 * default world (npm run gen:test-data && SERVER_URL=<api> npm run seed:test-data):
 *   VITE_URL=https://localhost:5174 API_URL=http://localhost:8100 \
 *     npx playwright test --project=chromium-mock mock-ui-desktop
 */
import { test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SHOTS = join(process.cwd(), 'docs', 'ui-flow', 'desktop')

test.use({ viewport: { width: 1440, height: 900 } })

async function openEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/viewer.html?world=default')
  await page.locator('#viewer-canvas').waitFor({ state: 'visible', timeout: 30_000 })
  // Wait for the world to populate the scan list, then let GLBs stream + camera fit.
  await page.waitForFunction(() => document.querySelectorAll('.scan-item').length > 0,
    { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(3500)
}

async function tab(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.click(`.sidebar-tab[data-tab="${name}"]`)
  await page.waitForTimeout(500)
}

test.describe('desktop editor flow screenshots', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true })
  })

  test('01 editor overview', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await openEditor(page)
    await page.screenshot({ path: join(SHOTS, '01-editor-overview.png') })
  })

  test('02 Scans tab', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'scans')
    await page.screenshot({ path: join(SHOTS, '02-scans-tab.png') })
  })

  test('03 World tab (stats, share links, queue)', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'world')
    await page.screenshot({ path: join(SHOTS, '03-world-tab.png') })
  })

  test('04 Layers tab', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'layers')
    await page.screenshot({ path: join(SHOTS, '04-layers-tab.png') })
  })

  test('05 Splat Toolbox', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'layers')
    await page.locator('#splat-toolbox-section').scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, '05-splat-toolbox.png') })
  })

  test('06 Edit tab (empty + selected)', async ({ page }) => {
    await openEditor(page)
    await tab(page, 'edit')
    await page.screenshot({ path: join(SHOTS, '06-edit-tab-empty.png') })
    // Select the first scan → editor attaches the gizmo + shows transform/tag UI.
    await tab(page, 'scans')
    const first = page.locator('.scan-item').first()
    if (await first.count()) {
      await first.click()
      await page.waitForTimeout(1000)
      await tab(page, 'edit')
      await page.screenshot({ path: join(SHOTS, '06-edit-tab-selected.png') })
    }
  })

  test('07 render modes (points, semantic)', async ({ page }) => {
    await openEditor(page)
    await page.click('#mode-points').catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, '07-render-points.png') })
    await page.click('#mode-semantic').catch(() => {})
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, '08-render-semantic.png') })
    await page.click('#mode-solid').catch(() => {})
  })

  test('09 Measure tool', async ({ page }) => {
    await openEditor(page)
    await page.click('#btn-measure').catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, '09-measure.png') })
  })

  test('10 Geomap drawer', async ({ page }) => {
    await openEditor(page)
    await page.click('#btn-geomap').catch(() => {})
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, '10-geomap.png') })
  })
})
