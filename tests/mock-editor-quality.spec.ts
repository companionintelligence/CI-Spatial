/**
 * Map-quality headline tests for the World Scan Editor's Layers tab.
 *
 * Covers the per-scan quality tier badge (Preview → Reconstructed → Photoreal)
 * and the "Improving your scan — …" processing line:
 *   1. computeQualityTier maps artifact presence to the right tier (pure unit).
 *   2. A plain seeded scan (GLB only, no session) reads Preview.
 *   3. The splat-fixture scan (trained-splat manifest present) reads Photoreal.
 *   4. The processing line appears when a quality-relevant job is queued.
 *
 * Seeding: plain scans come through the real upload pipeline (like
 * mock-editor-homes); the Photoreal scan is the synthetic splat fixture from
 * scripts/make-splat-fixture.mjs (valid 3DGS .ply + status:ok train manifest).
 * /scans fetches are forwarded to API_URL so the viewer's manifest reads (and
 * SparkJS's own URL resolution) hit the test server, mirroring mock-splat-train.
 *
 * Run:
 *   npm run gen:test-data                 # once, for the plain homes
 *   npm run test:splat:make-fixture       # once, for the Photoreal fixture
 *   API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-editor-quality
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SCAN_BASE = 'splat-fixture'
const SCANS_DIR = join(process.cwd(), 'scans')
const HOMES_DIR = join(process.cwd(), 'test-data', 'homes')
const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'splat-train', 'screenshots')

const API_URL = process.env['API_URL'] ?? ''
const apiPath = (p: string): string => (API_URL ? `${API_URL}${p}` : p)

const fixtureReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.splat-train.manifest.json`))
const homesAvailable = existsSync(join(HOMES_DIR, 'index.json'))

// Forward in-page /scans + /sessions fetches to the API server so the viewer's
// manifest reads resolve against the seeded corpus.
async function routeArtifacts(page: import('@playwright/test').Page): Promise<void> {
  if (!API_URL) return
  await page.route('**/scans/**', async (route) => {
    const url = new URL(route.request().url())
    const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
  })
  await page.route('**/sessions/**', async (route) => {
    const url = new URL(route.request().url())
    const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
  })
}

test.describe('map-quality headline', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async ({ request }) => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
    if (!homesAvailable) return
    const index = JSON.parse(readFileSync(join(HOMES_DIR, 'index.json'), 'utf8')) as
      Array<{ file: string; meta: string }>
    for (const entry of index.slice(0, 2)) {
      const resp = await request.post(apiPath('/upload-scan'), {
        multipart: {
          file: {
            name: entry.file,
            mimeType: 'model/gltf-binary',
            buffer: readFileSync(join(HOMES_DIR, entry.file)),
          },
          metadata: readFileSync(join(HOMES_DIR, entry.meta), 'utf8'),
        },
      })
      expect(resp.ok(), `seed upload ${entry.file}`).toBeTruthy()
    }
  })

  // ── Pure tier mapping (no browser state) ──────────────────────────────────
  test('computeQualityTier maps artifacts to the right tier', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    const result = await page.evaluate(async () => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/quality-tier.ts') as
        typeof import('../src/viewer/quality-tier')
      return {
        preview: mod.computeQualityTier({ reconstructedOk: false, splatOk: false }),
        reconstructed: mod.computeQualityTier({ reconstructedOk: true, splatOk: false }),
        photoreal: mod.computeQualityTier({ reconstructedOk: true, splatOk: true }),
        // splat wins even if reconstruction step was skipped
        photorealNoRecon: mod.computeQualityTier({ reconstructedOk: false, splatOk: true }),
        train: mod.jobProcessingLabel('splat-train'),
        recon: mod.jobProcessingLabel('lingbot-map-reconstruct'),
        detect: mod.jobProcessingLabel('splat-detect'),
      }
    })
    expect(result.preview.tier).toBe('preview')
    expect(result.preview.nextStep).toContain('Reconstructed')
    expect(result.reconstructed.tier).toBe('reconstructed')
    expect(result.reconstructed.nextStep).toContain('Photoreal')
    expect(result.photoreal.tier).toBe('photoreal')
    expect(result.photoreal.nextStep).toBeNull()
    expect(result.photorealNoRecon.tier).toBe('photoreal')
    expect(result.train).toBe('training splat')
    expect(result.recon).toBe('reconstructing')
    expect(result.detect).toBe('detecting objects')
  })

  test('a plain scan reads Preview', async ({ page }) => {
    test.skip(!homesAvailable, 'test-data missing — run: npm run gen:test-data')
    page.on('pageerror', (err) => console.error('[page]', err))
    await routeArtifacts(page)
    await page.goto('/viewer.html?world=default')
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    // Select a plain (non-fixture) scan on the Scans tab, then read the badge
    // on the Layers tab. (The scan list lives in the Scans panel; the quality
    // panel refreshes on selection regardless of which tab is showing.)
    const plain = page.locator('.scan-item', { hasText: 'Studio Apartment' }).first()
    await plain.click()
    await page.click('.sidebar-tab[data-tab="layers"]')
    const current = page.locator('#quality-stepper .quality-step.current .quality-step-label')
    await expect(current).toHaveText('Preview', { timeout: 15_000 })
    await expect(page.locator('#quality-next')).toContainText('Reconstructed')
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'editor-quality-preview.png'), fullPage: false })
  })

  test('the splat-fixture scan reads Photoreal', async ({ page }) => {
    test.skip(!fixtureReady, 'fixture missing — run: npm run test:splat:make-fixture')
    test.skip(!API_URL, 'API_URL required to route fixture artifacts')
    page.on('pageerror', (err) => console.error('[page]', err))
    await routeArtifacts(page)
    await page.goto('/viewer.html?world=default')

    const fixture = page.locator('.scan-item', { hasText: 'splat-fixture' }).first()
    await expect(fixture).toBeVisible({ timeout: 30_000 })
    await fixture.click()
    await page.click('.sidebar-tab[data-tab="layers"]')
    const current = page.locator('#quality-stepper .quality-step.current .quality-step-label')
    await expect(current).toHaveText('Photoreal', { timeout: 20_000 })
    // Photoreal is the top tier — no next-step nudge.
    await expect(page.locator('#quality-next')).toBeHidden()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'editor-quality-photoreal.png'), fullPage: false })
  })

  test('the processing line appears when a quality job is queued', async ({ page }) => {
    test.skip(!fixtureReady, 'fixture missing — run: npm run test:splat:make-fixture')
    test.skip(!API_URL, 'API_URL required to route fixture artifacts')
    page.on('pageerror', (err) => console.error('[page]', err))
    await routeArtifacts(page)
    await page.goto('/viewer.html?world=default')

    // Select on the (default-active) Scans tab, then read the headline on Layers.
    const fixture = page.locator('.scan-item', { hasText: 'splat-fixture' }).first()
    await expect(fixture).toBeVisible({ timeout: 30_000 })
    await fixture.click()
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#quality-stepper .quality-step.current')).toBeVisible({ timeout: 20_000 })

    // Inject a queued job for the selected scan and re-render the world panel;
    // the processing line reads world.jobs, so this exercises the real path
    // without waiting on a GPU trainer.
    await page.evaluate(() => {
      const w = window as unknown as {
        __quality?: { injectJob: (type: string, scanId: string | null) => void }
      }
      w.__quality?.injectJob('splat-train', null)
    })
    await expect(page.locator('#quality-processing')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#quality-processing-text')).toContainText('training splat')
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'editor-quality-processing.png'), fullPage: false })
  })
})
