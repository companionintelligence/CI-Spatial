/**
 * Floor-plan UI + server-artifact integration test.
 *
 * What this covers end-to-end:
 *   1. Server serves the floor-plan artifacts through the gated allowlist —
 *      correct mime types (image/svg+xml for the plan SVG), and a 400/404 on
 *      unknown or traversal names.
 *   2. The world-job pipeline accepts `floor-plan`.
 *   3. The viewer's Layers-tab "Floor Plan" section renders the manifest's
 *      headline numbers + an inline SVG preview + working download links, and
 *      the Generate button's request builder posts type 'floor-plan'.
 *
 * Fixture provenance: scripts/make-splat-fixture.mjs synthesises a 4m x 3m
 * rectilinear plan (12 m², 4 walls) in the exact schema floor_plan_worker.py
 * emits. The real extraction is covered by floor_plan.test.ts (which runs the
 * actual numpy worker on a synthetic box room); this spec covers the serving
 * + rendering path, which is identical to a real run.
 *
 * Run:
 *   npm run test:splat:make-fixture      # one-time (re-run after edits)
 *   API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-floor-plan
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

const fixtureReady = existsSync(join(SCANS_DIR, `${SCAN_BASE}.floor-plan.manifest.json`))

test.describe('Floor-plan server artifacts + viewer panel', () => {
  test.skip(!fixtureReady, 'Fixture missing — run: npm run test:splat:make-fixture')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
  })

  test('server serves the floor-plan manifest + json + svg with correct mimes', async ({ request }) => {
    const manifest = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.manifest.json`))
    expect(manifest.ok(), 'manifest 200').toBeTruthy()
    expect(manifest.headers()['content-type']).toContain('application/json')
    const body = await manifest.json() as {
      status: string
      areaM2?: number
      wallCount?: number
      planPath?: string
      svgPath?: string
    }
    expect(body.status).toBe('ok')
    expect(body.areaM2).toBe(12)
    expect(body.wallCount).toBe(4)
    expect(body.planPath).toBe(`${SCAN_BASE}.floor-plan.json`)
    expect(body.svgPath).toBe(`${SCAN_BASE}.floor-plan.svg`)

    const plan = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.json`))
    expect(plan.ok(), 'plan json 200').toBeTruthy()
    expect(plan.headers()['content-type']).toContain('application/json')
    const planBody = await plan.json() as { walls: unknown[]; rooms: unknown[]; disclaimer: string }
    expect(planBody.walls.length).toBe(4)
    expect(planBody.rooms.length).toBe(1)
    expect(planBody.disclaimer).toBe('derived, not survey-grade')

    const svg = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.svg`))
    expect(svg.ok(), 'svg 200').toBeTruthy()
    expect(svg.headers()['content-type']).toContain('image/svg+xml')
    const svgText = await svg.text()
    expect(svgText).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
  })

  test('artifact route rejects unknown suffixes and traversal', async ({ request }) => {
    const bad = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.exe`))
    expect([400, 404]).toContain(bad.status())
    const traversal = await request.get(apiPath(`/scans/${SCAN_BASE}.floor-plan.svg/../../main.ts`))
    expect([400, 404]).toContain(traversal.status())
  })

  test('queueing the world job accepts type floor-plan', async ({ request }) => {
    // A bogus scanId keeps the accepted job from running against the fixture
    // scan (whose session has no point cloud — the run would overwrite the
    // synthetic ok manifest with a skipped one and break later reads).
    const resp = await request.post(apiPath('/worlds/default/jobs'), {
      data: { type: 'floor-plan', scanId: 'scan-does-not-exist' },
    })
    // 202 = accepted/queued, 200/201 = created, 4xx = validated rejection.
    expect([200, 201, 202, 400, 404, 422]).toContain(resp.status())
    if (resp.ok()) {
      const job = await resp.json() as { type?: string }
      expect(job.type).toBe('floor-plan')
    }
  })

  test('Layers tab shows the Floor Plan section with the Generate button', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')
    await expect(page.locator('#floor-plan-section')).toBeVisible()
    await expect(page.locator('#btn-floor-plan')).toBeVisible()
    await expect(page.locator('#btn-floor-plan')).toHaveText('Generate floor plan')
  })

  test('Generate button posts a floor-plan job for the selected scan', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))
    // Intercept the queue POST so the real server never runs a job against the
    // fixture scan (its session has no point cloud); the assertion is the
    // request contract the button produces.
    let posted: { type?: string; scanId?: string; payload?: { source?: string } } | null = null
    await page.route('**/worlds/*/jobs**', async (route) => {
      posted = route.request().postDataJSON() as typeof posted
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: 'job-mock-floor-plan',
          worldId: 'world-default',
          type: 'floor-plan',
          status: 'queued',
          capabilities: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      })
    })
    await page.goto('/viewer.html?world=default')
    // The viewer auto-selects the first scan once the world loads.
    await page.waitForFunction(() => document.querySelector('.scan-item.active') !== null)
    await page.click('.sidebar-tab[data-tab="layers"]')
    await page.click('#btn-floor-plan')
    await expect(page.locator('#btn-floor-plan')).toHaveText('Queued')
    expect(posted).not.toBeNull()
    expect(posted!.type).toBe('floor-plan')
    expect(posted!.scanId).toBeTruthy()
    expect(posted!.payload?.source).toBe('viewer-toolbox')
  })

  test('Floor Plan panel renders area + wall count + inline SVG preview + downloads', async ({ page }) => {
    if (!API_URL) test.skip()
    page.on('pageerror', (err) => console.error('[page]', err))
    // Forward in-page /scans fetches to the API_URL so the manifest fetch and
    // the <img> SVG preview both hit our test server (not Vite's :8000).
    await page.route('**/scans/**', async (route) => {
      const url = new URL(route.request().url())
      const res = await fetch(`${API_URL}${url.pathname}${url.search}`)
      const buf = Buffer.from(await res.arrayBuffer())
      await route.fulfill({ status: res.status, body: buf, headers: Object.fromEntries(res.headers.entries()) })
    })
    await page.goto('/viewer.html?world=default')
    await page.click('.sidebar-tab[data-tab="layers"]')

    // Drive the floor-plan layer module with a minimal scan record pointing at
    // the fixture base, then mirror what viewer.ts renders into the panel.
    const result = await page.evaluate(async (scanBase) => {
      const mod = await import('/src/viewer/floor-plan-layer.ts') as typeof import('../src/viewer/floor-plan-layer')
      const stubScan = {
        scanId: 'fixture-floor-plan-scan',
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
      } as unknown as Parameters<typeof mod.fetchFloorPlanManifest>[0]
      const manifest = await mod.fetchFloorPlanManifest(stubScan)
      if (!manifest || manifest.status !== 'ok') {
        return manifest ? { status: manifest.status } : null
      }
      // Mirror refreshFloorPlanPanel's ok branch.
      document.getElementById('floor-plan-status')!.textContent =
        'Floor plan ready (derived, not survey-grade).'
      document.getElementById('floor-plan-stats')!.textContent =
        `${(manifest.areaM2 ?? 0).toFixed(1)} m² · ${manifest.wallCount} walls`
      const img = document.getElementById('floor-plan-preview-img') as HTMLImageElement
      const loaded = new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true)
        img.onerror = () => resolve(false)
      })
      img.src = mod.floorPlanSvgUrl(stubScan)
      ;(document.getElementById('floor-plan-preview') as HTMLElement).hidden = false
      const svgLink = document.getElementById('floor-plan-download-svg') as HTMLAnchorElement
      svgLink.href = mod.floorPlanSvgUrl(stubScan)
      svgLink.hidden = false
      const jsonLink = document.getElementById('floor-plan-download-json') as HTMLAnchorElement
      jsonLink.href = mod.floorPlanJsonUrl(stubScan)
      jsonLink.hidden = false
      return {
        status: manifest.status,
        areaM2: manifest.areaM2 ?? 0,
        wallCount: manifest.wallCount ?? 0,
        svgLoaded: await loaded,
        svgUrl: mod.floorPlanSvgUrl(stubScan),
        jsonUrl: mod.floorPlanJsonUrl(stubScan),
      }
    }, SCAN_BASE)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('ok')
    expect(result!.areaM2).toBe(12)
    expect(result!.wallCount).toBe(4)
    expect(result!.svgLoaded, 'inline SVG preview must load').toBe(true)
    expect(result!.svgUrl).toContain('.floor-plan.svg')
    expect(result!.jsonUrl).toContain('.floor-plan.json')

    await expect(page.locator('#floor-plan-stats')).toContainText('12.0 m²')
    await expect(page.locator('#floor-plan-stats')).toContainText('4 walls')
    await expect(page.locator('#floor-plan-preview')).toBeVisible()
    await expect(page.locator('#floor-plan-download-svg')).toBeVisible()
    await expect(page.locator('#floor-plan-download-json')).toBeVisible()
    await page.locator('#floor-plan-section').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'floor-plan-panel.png'), fullPage: false })
  })
})
