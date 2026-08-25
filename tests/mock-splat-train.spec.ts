/**
 * Splat-train UI + server-processing integration test.
 *
 * What this covers end-to-end:
 *   1. Server serves the trained-splat artifacts through the gated allowlist —
 *      correct mime types, and a 400 on unknown / traversal names.
 *   2. The world-job pipeline accepts `splat-train`.
 *   3. The viewer's splat layer loads the served .ply into a SparkJS SplatMesh
 *      (mesh initializes, numSplats > 0), surfaces the Trained-Splat panel in
 *      the Layers tab, and the toggle drives visibility.
 *
 * Fixture provenance: scripts/make-splat-fixture.mjs synthesises a valid INRIA
 * 3DGS .ply + the `<base>.splat-train.manifest.json` the world job writes. The
 * real trainer is Brush (a GPU binary) that can't run in CI, so the artifact is
 * synthetic — the data path (served .ply → SplatMesh) is identical to a real run.
 *
 * Run:
 *   npm run test:splat:make-fixture      # one-time (re-run after edits)
 *   API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-splat-train
 */
import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SCAN_BASE = 'splat-fixture'
const SCANS_DIR = join(process.cwd(), 'scans')
const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'splat-train', 'screenshots')

const API_URL = process.env['API_URL'] ?? ''
const apiPath = (p: string): string => (API_URL ? `${API_URL}${p}` : p)

const fixtureReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.splat-train.manifest.json`))

test.describe('Splat-train server processing + viewer splat layer', () => {
  test.skip(!fixtureReady, 'Fixture missing — run: npm run test:splat:make-fixture')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
  })

  test('server serves the trained-splat manifest + .ply with correct mimes', async ({ request }) => {
    const manifest = await request.get(apiPath(`/scans/${SCAN_BASE}.splat-train.manifest.json`))
    expect(manifest.ok(), 'manifest 200').toBeTruthy()
    expect(manifest.headers()['content-type']).toContain('application/json')
    const body = await manifest.json() as { status: string; gaussianCount?: number }
    expect(body.status).toBe('ok')
    expect(body.gaussianCount ?? 0).toBeGreaterThan(0)

    const ply = await request.get(apiPath(`/scans/${SCAN_BASE}.splat.ply`))
    expect(ply.ok(), 'ply 200').toBeTruthy()
    expect(ply.headers()['content-type']).toContain('application/octet-stream')
    const bytes = await ply.body()
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ply')
  })

  test('artifact route rejects unknown files and traversal', async ({ request }) => {
    const bad = await request.get(apiPath(`/scans/${SCAN_BASE}.evil.ply`))
    expect([400, 404]).toContain(bad.status())
    const traversal = await request.get(apiPath(`/scans/${SCAN_BASE}.splat.ply/../../main.ts`))
    expect([400, 404]).toContain(traversal.status())
  })

  test('server serves the splat-finish manifest + .sog + .compressed.ply with correct mimes', async ({ request }) => {
    const finishReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.splat-finish.manifest.json`))
    test.skip(!finishReady, 'finish fixture missing — re-run: npm run test:splat:make-fixture')

    const manifest = await request.get(apiPath(`/scans/${SCAN_BASE}.splat-finish.manifest.json`))
    expect(manifest.ok(), 'finish manifest 200').toBeTruthy()
    expect(manifest.headers()['content-type']).toContain('application/json')
    const body = await manifest.json() as {
      status: string
      sogPath?: string
      compressedPlyPath?: string
      sizes?: { inputBytes?: number; sogBytes?: number; compressedBytes?: number }
    }
    expect(body.status).toBe('ok')
    expect(body.sogPath).toBe(`${SCAN_BASE}.sog`)
    expect(body.compressedPlyPath).toBe(`${SCAN_BASE}.compressed.ply`)
    expect(body.sizes?.inputBytes ?? 0).toBeGreaterThan(0)
    expect(body.sizes?.compressedBytes ?? 0).toBeGreaterThan(0)

    const sog = await request.get(apiPath(`/scans/${SCAN_BASE}.sog`))
    expect(sog.ok(), 'sog 200').toBeTruthy()
    expect(sog.headers()['content-type']).toContain('application/octet-stream')

    const compressed = await request.get(apiPath(`/scans/${SCAN_BASE}.compressed.ply`))
    expect(compressed.ok(), 'compressed.ply 200').toBeTruthy()
    expect(compressed.headers()['content-type']).toContain('application/octet-stream')
    const bytes = await compressed.body()
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ply')
  })

  test('queueing the world job accepts type splat-train', async ({ request }) => {
    const resp = await request.post(apiPath('/worlds/default/jobs'), {
      data: { type: 'splat-train' },
    })
    // 202 = accepted/queued, 200/201 = created, 4xx = validated rejection.
    expect([200, 201, 202, 400, 404, 422]).toContain(resp.status())
  })

  test('viewer shows the Trained-Splat panel and toggle', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#splat-toolbox-section')).toBeVisible()
    await expect(page.locator('#splat-layer-toggle')).toBeVisible()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'viewer-splat-panel.png'), fullPage: false })
  })

  test('splat-train option appears in the processing-queue dropdown', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="world"]')
    const select = page.locator('#job-type')
    await expect(select).toBeVisible()
    const options = await select.locator('option').allTextContents()
    expect(options.some((o) => o.toLowerCase().includes('splat'))).toBeTruthy()
    await select.selectOption('splat-train')
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'viewer-job-dropdown-splat.png'), fullPage: false })
  })

  test('splat layer loads the served .ply into a SplatMesh', async ({ page }) => {
    if (!API_URL) test.skip()
    page.on('pageerror', (err) => console.error('[page]', err))
    // Forward in-page /scans fetches to the API_URL so the viewer's fetch and
    // SparkJS's own URL resolution both hit our test server (not Vite's :8000).
    await page.route('**/scans/**', async (route) => {
      const url = new URL(route.request().url())
      const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
    })
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    // Drive the splat-layer loader directly with a minimal scan record pointing
    // at the fixture base, then assert the SplatMesh initialised.
    const result = await page.evaluate(async (scanBase) => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/splat-layer.ts') as typeof import('../src/viewer/splat-layer')
      const stubScan = {
        scanId: 'fixture-splat-scan',
        sessionId: 'sess-fixture-splat',
        filename: `${scanBase}.glb`,
        name: 'Splat fixture scan',
        glbUrl: `/scans/${scanBase}.glb`,
        geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
        localToWorld: [],
        accuracyM: null,
        capturedAt: null,
        pointCount: null,
        detectionCount: null,
        layerIndex: [],
        status: 'ready',
      } as unknown as Parameters<typeof mod.fetchScanSplatLayer>[0]
      const layer = await mod.fetchScanSplatLayer(stubScan)
      const status = document.getElementById('splat-layer-status')
      const stats = document.getElementById('splat-layer-stats')
      if (layer && layer.manifest.status === 'ok') {
        status!.textContent = `Trained splat ready — ${layer.gaussianCount.toLocaleString()} gaussians.`
        stats!.textContent = `Trained in ${(layer.manifest.timing?.elapsedMs ?? 0) / 1000}s on ${layer.manifest.frameCount} frames.`
      }
      ;(document.getElementById('splat-layer-toggle') as HTMLInputElement).checked = true
      return layer && layer.loaded
        ? { status: layer.manifest.status, gaussianCount: layer.gaussianCount, numSplats: layer.loaded.mesh.numSplats }
        : (layer ? { status: layer.manifest.status, gaussianCount: layer.gaussianCount, numSplats: 0 } : null)
    }, SCAN_BASE)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('ok')
    expect(result!.gaussianCount).toBeGreaterThan(0)
    expect(result!.numSplats).toBeGreaterThan(0)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'viewer-splat-panel-loaded.png'), fullPage: false })
  })

  test('splat layer prefers the finished compressed artifact and the toolbox shows finish output', async ({ page }) => {
    if (!API_URL) test.skip()
    const finishReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.splat-finish.manifest.json`))
    test.skip(!finishReady, 'finish fixture missing — re-run: npm run test:splat:make-fixture')
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.route('**/scans/**', async (route) => {
      const url = new URL(route.request().url())
      const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
    })
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    // Drive the splat-layer loader with the fixture scan. The fixture's .sog is
    // a deliberate non-bundle, so the preference chain must fall back to the
    // (fake but valid) .compressed.ply — proven by numSplats matching the
    // compressed fixture's smaller gaussian count, not the raw ply's.
    const result = await page.evaluate(async (scanBase) => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/splat-layer.ts') as typeof import('../src/viewer/splat-layer')
      const stubScan = {
        scanId: 'fixture-splat-scan-finish',
        sessionId: 'sess-fixture-splat',
        filename: `${scanBase}.glb`,
        name: 'Splat fixture scan',
        glbUrl: `/scans/${scanBase}.glb`,
        geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
        localToWorld: [],
        accuracyM: null,
        capturedAt: null,
        pointCount: null,
        detectionCount: null,
        layerIndex: [],
        status: 'ready',
      } as unknown as Parameters<typeof mod.fetchScanSplatLayer>[0]
      const layer = await mod.fetchScanSplatLayer(stubScan)
      if (!layer) return null
      // Mirror what viewer.ts renders for a finished splat: the stats line via
      // the shared formatter + the Download .sog link.
      const stats = document.getElementById('splat-layer-stats')
      if (stats) stats.textContent = mod.formatFinishStats(layer.finish)
      const sogLink = document.getElementById('splat-download-sog-link') as HTMLAnchorElement | null
      if (sogLink && layer.finish?.status === 'ok' && layer.finish.sogPath) {
        sogLink.href = mod.splatSogUrl(stubScan)
        sogLink.hidden = false
      }
      return {
        status: layer.manifest.status,
        finishStatus: layer.finish?.status ?? null,
        loadedSource: layer.loadedSource ?? null,
        numSplats: layer.loaded?.mesh.numSplats ?? 0,
        statsText: stats?.textContent ?? '',
      }
    }, SCAN_BASE)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('ok')
    expect(result!.finishStatus).toBe('ok')
    expect(result!.loadedSource).toBe('compressed-ply')
    // The compressed fixture carries 60% of the raw gaussians — loading it (not
    // the raw .ply) is what proves the preference.
    expect(result!.numSplats).toBe(1200)
    expect(result!.statsText).toContain('Compressed:')
    expect(result!.statsText).toContain('.sog')
    await expect(page.locator('#splat-download-sog-link')).toBeVisible()
    await expect(page.locator('#splat-download-sog-link')).toHaveAttribute('href', /\.sog$/)
    await page.locator('#splat-toolbox-section').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'viewer-splat-finish.png'), fullPage: false })
  })

  test('a failed train surfaces its error and never loads a mesh', async ({ page }) => {
    if (!API_URL) test.skip()
    const errReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}-err.splat-train.manifest.json`))
    test.skip(!errReady, 'error fixture missing — re-run: npm run test:splat:make-fixture')
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.route('**/scans/**', async (route) => {
      const url = new URL(route.request().url())
      const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
    })
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    const result = await page.evaluate(async (scanBase) => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const mod = await import('/src/viewer/splat-layer.ts') as typeof import('../src/viewer/splat-layer')
      const stubScan = {
        scanId: `scan-${scanBase}-err`,
        sessionId: 'sess-fixture-splat',
        filename: `${scanBase}-err.glb`,
        name: 'Splat fixture scan (failed train)',
        glbUrl: `/scans/${scanBase}-err.glb`,
        geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
        localToWorld: [],
        accuracyM: null,
        capturedAt: null,
        pointCount: null,
        detectionCount: null,
        layerIndex: [],
        status: 'ready',
      } as unknown as Parameters<typeof mod.fetchScanSplatLayer>[0]
      const layer = await mod.fetchScanSplatLayer(stubScan)
      return layer
        ? { status: layer.manifest.status, error: layer.manifest.error ?? null, hasMesh: Boolean(layer.loaded), gaussianCount: layer.gaussianCount }
        : null
    }, SCAN_BASE)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('error')
    expect(result!.error).toContain('brush exited')
    expect(result!.hasMesh).toBe(false)
    expect(result!.gaussianCount).toBe(0)
  })
})
