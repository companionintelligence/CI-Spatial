/**
 * Regression test for the loadScanIntoWorld() race between the initial
 * world load (loadWorldProject, one call per scan via Promise.allSettled)
 * and the optimize-scan job-completion reload (handleJobUpdate's 'done'
 * branch, in src/viewer/viewer.ts).
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
 * Each generation (initial load vs. job-completion reload) gets its own
 * artifact URLs, rather than both re-fetching the same LOD/optimized
 * filenames — GLTFLoader's shared FileLoader/Cache plumbing doesn't parse a
 * second load of the exact same URL reliably within one page, which isn't
 * what this test is trying to exercise. A real optimize-scan re-run isn't
 * guaranteed to reuse the same artifact filenames either.
 *
 * Target scan and fixture GLB both come from the world the server under test
 * is actually serving, fetched over the API — not from the repo's own
 * worlds/default.json and scans/ on disk. Those are the same thing only when
 * the test runs against the long-lived :8000 server; under `npm run test:box`
 * the server has its own isolated WORLDS_DIR (the 24 seeded homes), so a
 * target read off disk names a scan that world has never heard of, no
 * `.scan-item` for it ever renders, and the spec fails on its first locator
 * before exercising any of the behaviour it exists to check.
 *
 * The bug report reproduced the race via connection-pool contention among
 * ~260 concurrent scan loads, but this spec does not depend on that: it holds
 * the initial load's full-quality request open for 2.5s and does not fire the
 * job-completion event until that request is confirmed in flight. The
 * interleaving is forced by those mocks, so it holds at any world size.
 *
 * Run:
 *   API_URL=http://localhost:8000 VITE_URL=https://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-scan-load-dedup
 */
import { test, expect } from '@playwright/test'

const API_URL = process.env['API_URL'] ?? ''

test.skip(!API_URL, 'API_URL required — this test intercepts the real /worlds/default response')

interface WorldScan { scanId: string; filename: string; glbUrl: string }

test.describe('loadScanIntoWorld race between initial load and job-completion reload', () => {
  test.setTimeout(90_000)

  test('a job-completion reload is not clobbered by a slow/failing initial load', async ({ page, request }) => {
    page.on('pageerror', (err) => console.error('[page]', err))

    // Target: the middle scan of the world the server is actually serving.
    // Far enough in that, under real (unmocked) network conditions for the
    // other scans, its initial load is still plausibly in flight when the
    // job-completion event arrives. Its own GLB is never fetched — the
    // manifest below is mocked, so the load goes to the mocked artifact URLs
    // — so a world listing scans whose files are long gone is still fine.
    const worldResp = await request.get(`${API_URL}/worlds/default`)
    expect(worldResp.status(), 'GET /worlds/default').toBe(200)
    const scans = (await worldResp.json() as { scans: WorldScan[] }).scans
    test.skip(scans.length === 0, 'served world has no scans — seed it first (npm run gen:test-data)')
    const TARGET = scans[Math.floor(scans.length / 2)]!

    // A real, already-parseable GLB, used as the body of every mocked
    // response that should resolve successfully — so a successful load is
    // unambiguous in the assertions below. Any served scan's GLB will do;
    // take the first one that actually comes back, since a world routinely
    // lists more scans than SCANS_DIR still holds files for.
    let validGlb: Buffer | null = null
    for (const candidate of scans) {
      const resp = await request.get(`${API_URL}${candidate.glbUrl}`)
      if (!resp.ok()) continue
      const body = Buffer.from(await resp.body())
      if (body.byteLength > 0) { validGlb = body; break }
    }
    test.skip(!validGlb, 'no scan in the served world has a fetchable GLB — seed it first')
    const VALID_GLB = validGlb!

    // Optimize manifest: present on every fetch, with a preview LOD so each
    // load's first pass lands fast (flipping loaded=true, the condition
    // handleJobUpdate's reload is gated on) while its second (full-quality)
    // pass is what actually races the reload below. Each fetch gets its own
    // generation of artifact filenames (call1 = initial load, call2 =
    // job-completion reload).
    let manifestFetchCount = 0
    await page.route(`**/scans/${encodeURIComponent(TARGET.filename)}/manifest`, (route) => {
      manifestFetchCount += 1
      const gen = `call${manifestFetchCount}`
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artifacts: {
            optimized: { filename: `${TARGET.filename}.${gen}.opt.glb`, bytes: VALID_GLB.byteLength, draco: false, quantized: true },
            lods: [{ filename: `${TARGET.filename}.${gen}.lod0.glb`, bytes: 1024, points: 100, voxelM: 0.1 }],
          },
        }),
      })
    })
    // Every generation's preview LOD loads fast and succeeds.
    await page.route(`**/scans/${encodeURIComponent(TARGET.filename)}.call*.lod0.glb`, (route) =>
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: VALID_GLB }))

    let optRequestCount = 0
    // The full-quality ("optimized") artifact fetch: call1's (the initial
    // load's own full-quality pass) is held open and then fails, simulating
    // the exact failure named in the bug report ("Scan GLB has no scene
    // graph"). call2's (the job-completion reload's full-quality pass,
    // which must not start until call1 settles) succeeds immediately.
    await page.route(`**/scans/${encodeURIComponent(TARGET.filename)}.call*.opt.glb`, async (route) => {
      optRequestCount += 1
      const isFirstGeneration = route.request().url().includes('.call1.')
      if (isFirstGeneration) {
        await new Promise((r) => setTimeout(r, 2500))
        await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.alloc(0) })
      } else {
        await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: VALID_GLB })
      }
    })

    // Mock the /events WebSocket so the job-completion 'job-update' message
    // can be injected deterministically instead of depending on a real
    // optimize-scan job pipeline run. wsReady only resolves once the viewer
    // has actually opened the socket, so sendJobDone() below can't fire on
    // a connection that doesn't exist yet.
    let sendJobDone: (() => void) | null = null
    let resolveWsReady: (() => void) | null = null
    const wsReady = new Promise<void>((resolve) => { resolveWsReady = resolve })
    await page.routeWebSocket('**/events', (ws) => {
      sendJobDone = () => ws.send(JSON.stringify({
        type: 'job-update',
        job: { target: TARGET.filename, status: 'done', note: 'test artifacts ready' },
      }))
      resolveWsReady!()
    })

    await page.goto('/viewer.html?world=default')

    const statusChip = page.locator(`.scan-item[data-filename="${TARGET.filename}"] .scan-status`)
    await expect(statusChip).toBeVisible({ timeout: 30_000 })
    // Wait for the initial load's full-quality pass to actually be in
    // flight (preview already landed, loaded=true) before firing the
    // job-completion event, so the reload really does race an in-flight —
    // not yet finished — initial load.
    await expect.poll(() => optRequestCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

    await wsReady
    sendJobDone!()

    // The job-completion reload's own loadScanIntoWorld() call must not
    // start until the initial load's delayed full-quality request settles
    // (2.5s above). Give both loads time to fully resolve.
    await page.waitForTimeout(4000)

    // With the two loads properly serialized, the job-completion reload
    // (call2's full-quality request, succeeds) always finishes after the
    // initial load (call1's full-quality request, fails), so its outcome is
    // what's left on screen — never the stale "no scene graph" error.
    await expect(statusChip).not.toContainText('Error', { timeout: 5_000 })
    await expect(statusChip).toHaveText(/Ready - optimized/, { timeout: 5_000 })
    expect(optRequestCount).toBe(2)
  })
})
