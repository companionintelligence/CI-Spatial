/**
 * Regression test for the loadScanIntoWorld() race between the initial
 * world load (loadWorldProject, one call per scan via Promise.allSettled)
 * and the optimize-scan job-completion reload (handleJobUpdate's 'done'
 * branch, viewer.ts:2664-2671).
 *
 * Both call loadScanIntoWorld() for the same scanId. Before the fix, they
 * raced: whichever one finished last won the ".scan-status" chip, so a slow
 * or failing initial load could resolve after the job-completion reload had
 * already shown the correct status and clobber it. viewer.ts now queues a
 * second loadScanIntoWorld() call behind any already in-flight call for the
 * same scanId (enqueueScanLoad), so the caller that fires later also always
 * finishes later.
 *
 * handleJobUpdate() only reloads once the scan's *first* pass (preview LOD,
 * if the optimize manifest offers one) has already landed — that's what
 * flips loadedScans.get(scanId).loaded to true, the guard it checks. So to
 * actually catch the initial load still in flight, this test's mocked
 * optimize manifest includes a fast preview LOD: the initial load's preview
 * stage lands quickly (loaded=true), then its full-quality stage is held
 * open — exactly the window in which a real optimize-scan job completing
 * would fire handleJobUpdate's reload.
 *
 * Runs against the real worlds/default.json (250+ scans, not an isolated
 * fixture) per the bug report: the race needs the initial load's ~260
 * concurrent requests to still be contending for the browser's connection
 * pool when the job-completion event lands.
 *
 * Run:
 *   API_URL=http://localhost:8000 VITE_URL=https://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-scan-load-dedup
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const API_URL = process.env['API_URL'] ?? ''
const world = JSON.parse(
  readFileSync(join(process.cwd(), 'worlds', 'default.json'), 'utf8'),
) as { scans: Array<{ scanId: string; filename: string; glbUrl: string }> }

test.skip(world.scans.length < 50, 'worlds/default.json fixture is too small to reproduce the race')
test.skip(!API_URL, 'API_URL required — this test intercepts the real /worlds/default response')

// A scan far enough into the list that, under real (unmocked) network
// conditions for the other 249+ scans' 404s, its initial load is still
// plausibly in flight when the job-completion event arrives.
const TARGET = world.scans[Math.floor(world.scans.length / 2)]!
const LOD_FILENAME = `${TARGET.filename}.lod0.glb`
const OPT_FILENAME = `${TARGET.filename}.opt.glb`

// A real, already-parseable GLB from the seeded corpus, used for every
// response that should resolve successfully — so a successful load is
// unambiguous in the assertions below.
const VALID_GLB = readFileSync(join(process.cwd(), 'scans', '1786840029324_home-00-studio-a.glb'))

test.describe('loadScanIntoWorld race between initial load and job-completion reload', () => {
  test.setTimeout(90_000)

  test('a job-completion reload is not clobbered by a slow/failing initial load', async ({ page }) => {
    page.on('pageerror', (err) => console.error('[page]', err))

    // Optimize manifest: present on every fetch, with a preview LOD so the
    // initial load's first pass lands fast (flipping loaded=true, the
    // condition handleJobUpdate's reload is gated on) while its second
    // (full-quality) pass is what actually races the reload below.
    await page.route(`**/scans/${encodeURIComponent(TARGET.filename)}/manifest`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artifacts: {
            optimized: { filename: OPT_FILENAME, bytes: VALID_GLB.byteLength, draco: false, quantized: true },
            lods: [{ filename: LOD_FILENAME, bytes: 1024, points: 100, voxelM: 0.1 }],
          },
        }),
      }))
    await page.route(`**/scans/${encodeURIComponent(LOD_FILENAME)}`, (route) =>
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: VALID_GLB }))

    let optRequestCount = 0
    // The full-quality ("optimized") artifact fetch: the FIRST request (the
    // initial load's own full-quality pass) is held open and then fails,
    // simulating the exact failure named in the bug report ("Scan GLB has
    // no scene graph"). The SECOND request (the job-completion reload's
    // full-quality pass, which must not start until the first settles)
    // succeeds immediately.
    await page.route(`**/scans/${encodeURIComponent(OPT_FILENAME)}`, async (route) => {
      optRequestCount += 1
      if (optRequestCount === 1) {
        await new Promise((r) => setTimeout(r, 2500))
        await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.alloc(0) })
      } else {
        await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: VALID_GLB })
      }
    })

    // Mock the /events WebSocket so the job-completion 'job-update' message
    // can be injected deterministically instead of depending on a real
    // optimize-scan job pipeline run.
    let sendJobDone: (() => void) | null = null
    await page.routeWebSocket('**/events', (ws) => {
      sendJobDone = () => ws.send(JSON.stringify({
        type: 'job-update',
        job: { target: TARGET.filename, status: 'done', note: 'test artifacts ready' },
      }))
    })

    await page.goto('/viewer.html?world=default')

    const statusChip = page.locator(`.scan-item[data-filename="${TARGET.filename}"] .scan-status`)
    await expect(statusChip).toBeVisible({ timeout: 30_000 })
    // Wait for the initial load's full-quality pass to actually be in
    // flight (preview already landed, loaded=true) before firing the
    // job-completion event, so the reload really does race an in-flight —
    // not yet finished — initial load.
    await expect.poll(() => optRequestCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

    sendJobDone!()

    // The job-completion reload's own loadScanIntoWorld() call must not
    // start until the initial load's delayed full-quality request settles
    // (2.5s above). Give both loads time to fully resolve.
    await page.waitForTimeout(4000)

    // With the two loads properly serialized, the job-completion reload
    // (second full-quality request, succeeds) always finishes after the
    // initial load (first full-quality request, fails), so its outcome is
    // what's left on screen — never the stale "no scene graph" error.
    await expect(statusChip).not.toContainText('Error', { timeout: 5_000 })
    await expect(statusChip).toHaveText(/Ready - optimized/, { timeout: 5_000 })
    expect(optRequestCount).toBe(2)
  })
})
