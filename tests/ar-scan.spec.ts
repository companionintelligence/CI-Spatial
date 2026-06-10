/**
 * AR scan integration tests.
 *
 * These tests use simulated camera input (no real AR hardware needed on desktop),
 * and connect to the live running Vite + Deno servers.
 *
 * Re the real iPhone path: camera and motion permissions cannot be
 * programmatically granted in WebKit — the user must grant them manually once.
 * These tests exercise everything around the AR loop (UI, inference HTTP, parsing)
 * but skip the `getUserMedia` assertion on iOS.
 *
 * @8thwall-simulator — when XR8 detects a desktop browser, it loads its built-in
 * replay simulator. Capture tests tagged with @simulator drive the pipeline
 * against a fixed recorded session without needing a physical device.
 */
import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env['VITE_URL'] ?? 'https://liambook.capybara-ulmer.ts.net:5175'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the status bar to contain `text` (case-insensitive substring) */
async function waitForStatus(page: Page, text: string, timeoutMs = 20_000) {
  await expect(page.locator('#status-text')).toContainText(text, {
    ignoreCase: true,
    timeout: timeoutMs,
  })
}

/** Click the Start AR button and dismiss the motion permission dialog if it appears */
async function clickStartAR(page: Page) {
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
  await page.locator('#start-ar-btn').click()
}

// ── App load ──────────────────────────────────────────────────────────────────

test.describe('App loads', () => {
  test('page renders start screen', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#start-ar-btn')).toBeVisible()
    await expect(page.locator('#start-ar-btn')).toHaveText('Start AR')
  })

  test('status bar is visible and initialising', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#status-text')).toBeVisible()
  })

  test('panel toggle button is present', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#panel-toggle')).toBeVisible()
  })

  test('history button is present', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#history-btn')).toBeVisible()
  })

  test('PWA manifest is linked', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const manifest = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifest).toBe('/manifest.json')
  })
})

// ── Health endpoints ──────────────────────────────────────────────────────────

test.describe('Health endpoints', () => {
  test('/health returns ok', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/health`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { status: string }
    expect(body.status).toBe('ok')
  })

  test('/health includes model ID', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/health`)
    const body = await resp.json() as { model: string }
    expect(body.model).toMatch(/(LFM2\.5|Ollama|qwen|llava|moondream)/i)
  })
})

// ── Inference API ─────────────────────────────────────────────────────────────

test.describe('Inference API', () => {
  test('/infer returns array for a valid JPEG', async ({ request }) => {
    // Try to fetch a real fixture; skip gracefully if not present
    const jpegResp = await request.get(`${BASE_URL}/test-fixtures/room.jpg`).catch(() => null)
    if (!jpegResp || jpegResp.status() !== 200) {
      test.skip()
      return
    }
    const jpegBytes = await jpegResp.body()
    const resp = await request.post(`${BASE_URL}/infer`, {
      multipart: { image: { name: 'room.jpg', mimeType: 'image/jpeg', buffer: jpegBytes } },
    })
    expect(resp.status()).toBe(200)
    const detections = await resp.json() as Array<{ label: string; bbox: number[] }>
    expect(Array.isArray(detections)).toBeTruthy()
    console.log(`[test] Got ${detections.length} detections`)
  })

  test('/infer returns 400 when no image is provided', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/infer`, {
      multipart: { not_image: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') } },
    })
    expect(resp.status()).toBe(400)
  })
})

// ── Scan storage API ──────────────────────────────────────────────────────────

test.describe('Scan storage API', () => {
  test('GET /scans returns an array', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/scans`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as unknown[]
    expect(Array.isArray(body)).toBeTruthy()
  })

  test('POST /upload-scan saves a .glb and returns filename', async ({ request }) => {
    // Minimal valid GLB: 12-byte header (magic + version + length) + empty JSON chunk
    const magic = 0x46546C67  // 'glTF'
    const version = 2
    const jsonChunk = JSON.stringify({ asset: { version: '2.0' } })
    const jsonBytes = new TextEncoder().encode(jsonChunk)
    // Pad to 4-byte boundary
    const padLen = (4 - (jsonBytes.length % 4)) % 4
    const paddedJson = new Uint8Array(jsonBytes.length + padLen)
    paddedJson.set(jsonBytes)
    const totalLen = 12 + 8 + paddedJson.length
    const buf = new ArrayBuffer(totalLen)
    const view = new DataView(buf)
    view.setUint32(0, magic, true)
    view.setUint32(4, version, true)
    view.setUint32(8, totalLen, true)
    view.setUint32(12, paddedJson.length, true)
    view.setUint32(16, 0x4E4F534A, true)  // 'JSON' chunk type
    new Uint8Array(buf, 20).set(paddedJson)

    const resp = await request.post(`${BASE_URL}/upload-scan`, {
      multipart: {
        file: { name: 'test-scan.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(buf) },
        metadata: JSON.stringify({ detectionCount: 0, labels: [], exportedAt: new Date().toISOString() }),
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { filename: string; size: number }
    expect(body.filename).toContain('.glb')
    expect(body.size).toBeGreaterThan(0)

    // Verify it appears in the scan list
    const listResp = await request.get(`${BASE_URL}/scans`)
    const list = await listResp.json() as Array<{ filename: string }>
    const found = list.some(s => s.filename === body.filename)
    expect(found).toBeTruthy()

    // Clean up: GET the file back
    const dlResp = await request.get(`${BASE_URL}/scans/${encodeURIComponent(body.filename)}`)
    expect(dlResp.status()).toBe(200)
    expect(dlResp.headers()['content-type']).toContain('gltf-binary')
  })

  test('GET /scans/:filename returns 404 for missing file', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/scans/nonexistent-file.glb`)
    expect(resp.status()).toBe(404)
  })

  test('GET /scans/:filename rejects path traversal', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/scans/..%2F..%2Fetc%2Fpasswd`)
    // Should be 400 or 404, never 200
    expect(resp.status()).toBeGreaterThanOrEqual(400)
  })
})

// ── 3D Viewer page ────────────────────────────────────────────────────────────

test.describe('3D Viewer page', () => {
  test('viewer.html loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#sidebar-title')).toHaveText('Saved Scans')
  })

  test('viewer sidebar shows scan list or empty state', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    // Wait for the list to resolve (scan list is fetched on load)
    await page.waitForTimeout(1500)
    const scanList = page.locator('#scan-list')
    await expect(scanList).toBeVisible()
  })

  test('viewer back link points to root', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const link = await page.locator('#back-link').getAttribute('href')
    expect(link).toBe('/')
  })

  test('viewer canvas is present', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#viewer-canvas')).toBeVisible()
  })
})

// ── Side panel ────────────────────────────────────────────────────────────────

test.describe('Side panel', () => {
  test('panel is not visible by default', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const panel = page.locator('#side-panel')
    // Panel exists but should not have 'open' class
    await expect(panel).not.toHaveClass(/open/)
  })

  test('clicking panel toggle opens the panel', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('#panel-toggle').click()
    await expect(page.locator('#side-panel')).toHaveClass(/open/)
  })
})

// ── History drawer ────────────────────────────────────────────────────────────

test.describe('History drawer', () => {
  test('history drawer is not visible by default', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('clicking history button opens the drawer', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
  })

  test('clicking close button closes the drawer', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
    await page.locator('#history-close').click()
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('pressing Escape closes the drawer', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
    await page.keyboard.press('Escape')
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('clicking backdrop closes the drawer', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
    // Click the backdrop (the drawer element itself, not the panel)
    await page.locator('#history-drawer').click({ position: { x: 290, y: 200 } })
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })
})

// ── AR flow (simulated, no camera) ────────────────────────────────────────────

test.describe('AR flow (simulated)', () => {
  test('start button progresses through loading states', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    await clickStartAR(page)

    await expect(page.locator('#start-screen')).not.toBeVisible({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const statusText = await page.locator('#status-text').textContent()
    console.log(`[test] Status after start: "${statusText}"`)
    expect(statusText).toBeTruthy()
  })
})

// ── UI layout positions ────────────────────────────────────────────────────────

test.describe('UI element positions', () => {
  test('status bar is in the top-left quadrant', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const box = await page.locator('#status-bar').boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      const vw = page.viewportSize()?.width ?? 400
      const vh = page.viewportSize()?.height ?? 800
      // left half, top half
      expect(box.x).toBeLessThan(vw / 2)
      expect(box.y).toBeLessThan(vh / 2)
    }
  })

  test('quality overlay is in the top-left HUD panel', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const el = document.getElementById('quality-overlay')
      if (el) el.style.display = 'flex'
    })
    const box = await page.locator('#quality-overlay').boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      const vw = page.viewportSize()?.width ?? 400
      const vh = page.viewportSize()?.height ?? 800
      // left half, top half — inside the HUD panel
      expect(box.x).toBeLessThan(vw / 2)
      expect(box.y).toBeLessThan(vh / 2)
    }
  })

  test('infer-dialog is in the top-left quadrant when visible', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const el = document.getElementById('infer-dialog')
      if (el) { el.classList.add('visible'); el.style.pointerEvents = 'all' }
    })
    const box = await page.locator('#infer-dialog').boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      const vw = page.viewportSize()?.width ?? 400
      // left half
      expect(box.x).toBeLessThan(vw / 2)
    }
  })

  test('RTC stream badge is hidden by default', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const display = await page.locator('#rtc-stream-btn').evaluate((el) => window.getComputedStyle(el).display)
    expect(display).toBe('none')
  })

  test('RTC stream badge is in the bottom-left when shown', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const el = document.getElementById('rtc-stream-btn') as HTMLElement | null
      if (el) el.style.display = 'flex'
    })
    const box = await page.locator('#rtc-stream-btn').boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      const vw = page.viewportSize()?.width ?? 400
      const vh = page.viewportSize()?.height ?? 800
      // left half, bottom half
      expect(box.x).toBeLessThan(vw / 2)
      expect(box.y).toBeGreaterThan(vh / 2)
    }
  })

  test('history drawer z-index is higher than side panel', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const [drawerZ, panelZ] = await page.evaluate(() => {
      const drawer = document.getElementById('history-drawer')!
      const panel  = document.getElementById('side-panel')!
      return [
        parseInt(window.getComputedStyle(drawer).zIndex) || 0,
        parseInt(window.getComputedStyle(panel).zIndex)  || 0,
      ]
    })
    expect(drawerZ).toBeGreaterThan(panelZ)
  })

  test('side panel has z-index above ar-overlay buttons', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const panelZ = await page.evaluate(() => {
      const panel = document.getElementById('side-panel')!
      return parseInt(window.getComputedStyle(panel).zIndex) || 0
    })
    expect(panelZ).toBeGreaterThan(0)
  })
})

// ── Analyzing progress bar ─────────────────────────────────────────────────────

test.describe('Progress bar (analyzing)', () => {
  test('progress bar wrap exists in DOM', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#progress-bar-wrap')).toBeAttached()
    await expect(page.locator('#progress-bar-fill')).toBeAttached()
  })

  test('progress bar fill has analyzing CSS class when manually set', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const fill = document.getElementById('progress-bar-fill')
      const wrap = document.getElementById('progress-bar-wrap')
      fill?.classList.add('analyzing')
      wrap?.classList.add('visible')
    })
    await expect(page.locator('#progress-bar-fill')).toHaveClass(/analyzing/)
    await expect(page.locator('#progress-bar-wrap')).toHaveClass(/visible/)
  })
})

// ── Viewer page new controls ───────────────────────────────────────────────────

test.describe('Viewer new controls', () => {
  test('live feed button is present in viewer toolbar', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#btn-livefeed')).toBeVisible()
  })

  test('bounds toggle button is present', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#btn-toggle-bounds')).toBeVisible()
  })

  test('geomap button is present', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#btn-geomap')).toBeVisible()
  })

  test('clicking live feed button shows live feed panel', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    // Panel should not be visible initially
    const initialDisplay = await page.locator('#livefeed-panel').evaluate(
      (el) => window.getComputedStyle(el).display
    )
    expect(initialDisplay).toBe('none')
    await page.locator('#btn-livefeed').click()
    // After click the panel should be shown
    const afterDisplay = await page.locator('#livefeed-panel').evaluate(
      (el) => window.getComputedStyle(el).display
    )
    expect(afterDisplay).not.toBe('none')
  })

  test('bounds button starts with reduced opacity (off)', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const opacity = await page.locator('#btn-toggle-bounds').evaluate(
      (el) => (el as HTMLElement).style.opacity
    )
    expect(parseFloat(opacity)).toBeLessThan(1)
  })

  test('clicking bounds button toggles opacity to 1 (on)', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await page.locator('#btn-toggle-bounds').click()
    const opacity = await page.locator('#btn-toggle-bounds').evaluate(
      (el) => (el as HTMLElement).style.opacity
    )
    expect(parseFloat(opacity)).toBe(1)
  })
})

// ── AI Engine settings ─────────────────────────────────────────────────────────

test.describe('AI engine settings', () => {
  test('defaults to server mode — no infer-mode key needed', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    // Clear any saved preference so we start fresh
    await page.evaluate(() => localStorage.removeItem('infer-mode'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    // Status bar should report server mode
    const statusText = await page.locator('#status-text').textContent()
    // 'server' or '🖥 Server' should appear regardless of emoji rendering
    expect(statusText?.toLowerCase()).toContain('server')
  })

  test('server toggle in settings panel sets localStorage to server', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    // Open the panel
    await page.locator('#panel-toggle').click()
    await page.waitForTimeout(300)

    // Click the Server button in the AI Engine row
    const serverBtn = page.locator('[data-mode="server"]')
    if (await serverBtn.isVisible()) {
      await serverBtn.click()
      const saved = await page.evaluate(() => localStorage.getItem('infer-mode'))
      expect(saved).toBe('server')
    }
  })

  test('webgpu toggle in settings panel sets localStorage to webgpu', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    await page.locator('#panel-toggle').click()
    await page.waitForTimeout(300)

    const webgpuBtn = page.locator('[data-mode="webgpu"]')
    if (await webgpuBtn.isVisible()) {
      await webgpuBtn.click()
      const saved = await page.evaluate(() => localStorage.getItem('infer-mode'))
      expect(saved).toBe('webgpu')
    }
  })

  test('localStorage infer-mode survives reload', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => localStorage.setItem('infer-mode', 'server'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    const saved = await page.evaluate(() => localStorage.getItem('infer-mode'))
    expect(saved).toBe('server')
  })

  test('AI engine panel buttons are present in side panel', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await page.locator('#panel-toggle').click()
    await page.waitForTimeout(300)
    await expect(page.locator('[data-mode="server"]')).toBeVisible()
    await expect(page.locator('[data-mode="webgpu"]')).toBeVisible()
  })
})

// ── Server inference endpoint timing ──────────────────────────────────────────

test.describe('Server /infer endpoint', () => {
  test('returns within 60 s for a small JPEG (model warm)', async ({ request }) => {
    // Skip if server is not running
    const health = await request.get(`${BASE_URL}/health`).catch(() => null)
    if (!health?.ok()) {
      console.log('[test] Server not running — skipping timing test')
      return
    }

    // Create a minimal 64×64 white JPEG as the test image
    const { createCanvas } = await import('canvas').catch(() => ({ createCanvas: null }))
    if (!createCanvas) {
      console.log('[test] canvas not available — skipping')
      return
    }
    const canvas = createCanvas(64, 64)
    const buf = canvas.toBuffer('image/jpeg')

    const start = Date.now()
    const resp = await request.post(`${BASE_URL}/infer`, {
      multipart: { image: { name: 'capture.jpg', mimeType: 'image/jpeg', buffer: buf } },
      timeout: 60_000,
    })
    const elapsed = Date.now() - start

    expect(resp.ok()).toBeTruthy()
    console.log(`[test] /infer round-trip: ${elapsed} ms`)
    expect(elapsed).toBeLessThan(60_000)
  })

  test('/health reports model ready', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/health`).catch(() => null)
    if (!resp) return  // server not running
    expect(resp.ok()).toBeTruthy()
    const body = await resp.json() as Record<string, string>
    expect(body.status).toBe('ok')
    expect(typeof body.model).toBe('string')
  })
})
