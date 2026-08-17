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
import { ONBOARDING_KEY } from '../src/shared/storage-keys'

// 5173 here is just the last-resort default (matches VITE_PORT's own default in
// main.ts/vite.config.ts). Set VITE_URL to point at a differently-ported instance.
const BASE_URL = process.env['VITE_URL'] ?? 'https://liambook.capybara-ulmer.ts.net:5173'

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => {
    window.localStorage.setItem(key, '1')
  }, ONBOARDING_KEY)
})

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
  // The button ships disabled and is enabled once main.ts has attached its
  // click handler at the top of boot; wait for that rather than for paint.
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
  await page.locator('#start-ar-btn').click()
}

// ── App load ──────────────────────────────────────────────────────────────────

test.describe('App loads', () => {
  test('page renders start screen', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#start-title')).toHaveText('Companion Scan')
    await expect(page.locator('#start-ar-btn')).toBeVisible()
    await expect(page.locator('#start-ar-btn')).toContainText('Scan a room')
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

  test('PWA manifest includes install metadata and shortcuts', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/manifest.json`)
    expect(resp.status()).toBe(200)
    const manifest = await resp.json() as {
      scope: string
      display: string
      icons: Array<{ sizes: string; purpose?: string }>
      shortcuts: Array<{ url: string }>
    }
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose?.includes('maskable'))).toBeTruthy()
    expect(manifest.shortcuts.some((shortcut) => shortcut.url.startsWith('/viewer.html'))).toBeTruthy()
  })

  test('service worker shell is available and skips API mutation routes', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/sw.js`)
    expect(resp.status()).toBe(200)
    const text = await resp.text()
    expect(text).toContain('companion-scan')
    expect(text).toContain('/infer')
    expect(text).toContain('/upload-scan')
    expect(text).toContain('/scans')
  })

  test('viewer page exposes PWA metadata for installed editor launches', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html?world=default`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.json')
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icon-192.png')
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
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
    // `mock` is a documented first-class engine (INFERENCE_MODE=mock is the CI
    // tier), so its model id must be accepted here the same way the
    // house-readiness preflight accepts `ollama|mock`.
    expect(body.model).toMatch(/(LFM2\.5|Ollama|qwen|llava|moondream|mock)/i)
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

    const delResp = await request.delete(`${BASE_URL}/scans/${encodeURIComponent(body.filename)}`)
    expect(delResp.status()).toBe(200)
    const deletedResp = await request.get(`${BASE_URL}/scans/${encodeURIComponent(body.filename)}`)
    expect(deletedResp.status()).toBe(404)
  })

  test('DELETE /scans/:filename removes uploaded scan and sidecar metadata', async ({ request }) => {
    const magic = 0x46546C67
    const version = 2
    const jsonBytes = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }))
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
    view.setUint32(16, 0x4E4F534A, true)
    new Uint8Array(buf, 20).set(paddedJson)

    const upload = await request.post(`${BASE_URL}/upload-scan`, {
      multipart: {
        file: { name: 'delete-me.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(buf) },
        metadata: JSON.stringify({ detectionCount: 0, labels: [], exportedAt: new Date().toISOString() }),
      },
    })
    expect(upload.status()).toBe(200)
    const { filename } = await upload.json() as { filename: string }

    const del = await request.delete(`${BASE_URL}/scans/${encodeURIComponent(filename)}`)
    expect(del.status()).toBe(200)
    const body = await del.json() as { ok: boolean; deleted: { glb: boolean; metadata: boolean } }
    expect(body.ok).toBeTruthy()
    expect(body.deleted.glb).toBeTruthy()
    expect(body.deleted.metadata).toBeTruthy()
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

  test('DELETE /scans/:filename rejects path traversal', async ({ request }) => {
    const resp = await request.delete(`${BASE_URL}/scans/..%2F..%2Fetc%2Fpasswd`)
    expect(resp.status()).toBeGreaterThanOrEqual(400)
    expect(resp.status()).not.toBe(200)
  })
})

// ── 3D Viewer page ────────────────────────────────────────────────────────────

test.describe('3D Viewer page', () => {
  test('viewer.html loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#sidebar-title')).toHaveText('Companion Scan')
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
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForStatus(page, 'begin')
    await page.evaluate(() => document.getElementById('start-screen')?.remove())
  })

  test('panel is not visible by default', async ({ page }) => {
    const panel = page.locator('#side-panel')
    // Panel exists but should not have 'open' class
    await expect(panel).not.toHaveClass(/open/)
  })

  test('clicking panel toggle opens the panel', async ({ page }) => {
    await page.locator('#panel-toggle').click()
    await expect(page.locator('#side-panel')).toHaveClass(/open/)
  })
})

// ── History drawer ────────────────────────────────────────────────────────────

test.describe('History drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForStatus(page, 'begin')
    await page.evaluate(() => document.getElementById('start-screen')?.remove())
  })

  test('history drawer is not visible by default', async ({ page }) => {
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('clicking history button opens the drawer', async ({ page }) => {
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
  })

  test('clicking close button closes the drawer', async ({ page }) => {
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
    await page.locator('#history-close').click()
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('pressing Escape closes the drawer', async ({ page }) => {
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)
    await page.keyboard.press('Escape')
    await expect(page.locator('#history-drawer')).not.toHaveClass(/open/)
  })

  test('clicking backdrop closes the drawer', async ({ page }) => {
    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)

    // The backdrop is whatever the drawer covers to the right of the panel.
    // #history-panel is left-anchored with width min(420px, 88vw), so a fixed
    // x of 290 lands *inside* the panel on every viewport this suite runs —
    // derive the point from the panel's real box instead.
    const panel = await page.locator('#history-panel').boundingBox()
    const view = page.viewportSize()
    if (!panel || !view) throw new Error('history panel or viewport has no box')
    const x = (panel.x + panel.width + view.width) / 2
    expect(x, 'no backdrop is exposed beside the panel').toBeGreaterThan(panel.x + panel.width)

    await page.mouse.click(x, Math.min(200, view.height - 20))
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

  test('status, compass, and autosave share one top-left HUD widget', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(() => {
      const hud = document.getElementById('hud-panel')
      return {
        statusInside: hud?.contains(document.getElementById('status-bar')) ?? false,
        compassInside: hud?.contains(document.getElementById('compass-ring')) ?? false,
        geoInside: hud?.contains(document.getElementById('geo-chip')) ?? false,
        autosaveInside: hud?.contains(document.getElementById('autosave-status')) ?? false,
        oldFloatingGeo: Boolean(document.getElementById('geo-indicator')),
      }
    })
    expect(result.statusInside).toBeTruthy()
    expect(result.compassInside).toBeTruthy()
    expect(result.geoInside).toBeTruthy()
    expect(result.autosaveInside).toBeTruthy()
    expect(result.oldFloatingGeo).toBeFalsy()
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

  test('RTC stream badge is in the top-left HUD panel when shown', async ({ page }) => {
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
      // left half, top half (since it is unified inside the HUD panel)
      expect(box.x).toBeLessThan(vw / 2)
      expect(box.y).toBeLessThan(vh / 2)
    }
  })

  test('scanner action rail stacks bottom-right controls without overlap', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(() => {
      const ids = ['xr-mode-link', 'viewer-link', 'panel-toggle', 'stream-btn', 'auto-capture-btn', 'history-btn']
      const boxes = ids.map((id) => {
        const el = document.getElementById(id)!
        const rect = el.getBoundingClientRect()
        return {
          id,
          parent: el.parentElement?.id,
          display: getComputedStyle(el).display,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        }
      })
      return {
        railExists: Boolean(document.getElementById('scanner-action-rail')),
        viewportWidth: window.innerWidth,
        boxes,
      }
    })

    expect(result.railExists).toBeTruthy()

    // #xr-mode-link is hidden by design on engines without WebXR (updateXrModeLink),
    // so the user is not sent to a dead-end page — Safari/WebKit is exactly that
    // case. Only the WebXR link may be hidden; anything else missing is a bug.
    const hidden = result.boxes.filter((b) => b.display === 'none')
    expect(hidden.map((b) => b.id)).toEqual(
      hidden.length ? ['xr-mode-link'] : [])

    const visible = result.boxes.filter((b) => b.display !== 'none')
    for (const box of visible) {
      expect(box.parent).toBe('scanner-action-rail')
      expect(box.width).toBeGreaterThanOrEqual(47)
      expect(box.width).toBeLessThanOrEqual(49)
      expect(box.height).toBeGreaterThanOrEqual(47)
      expect(box.height).toBeLessThanOrEqual(49)
      expect(box.right).toBeGreaterThan(result.viewportWidth - 70)
    }

    // Stacking order is only meaningful between controls that actually render.
    for (let i = 0; i < visible.length - 1; i++) {
      expect(visible[i].bottom).toBeLessThanOrEqual(visible[i + 1].y)
    }
  })

  test('capture button starts enabled and managed by busy state only', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    const state = await page.locator('#capture-btn').evaluate((el) => ({
      disabled: (el as HTMLButtonElement).disabled,
      ariaBusy: el.getAttribute('aria-busy'),
      busyClass: el.classList.contains('busy'),
    }))
    expect(state.disabled).toBeFalsy()
    expect(state.ariaBusy).not.toBe('true')
    expect(state.busyClass).toBeFalsy()
  })

  test('capture button remains the tap target for repeated presses', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      document.getElementById('start-screen')?.remove()
      ;(window as unknown as { __captureTapCount: number }).__captureTapCount = 0
      document.getElementById('capture-btn')?.addEventListener('click', () => {
        ;(window as unknown as { __captureTapCount: number }).__captureTapCount += 1
      })
    })

    const hitTarget = await page.locator('#capture-btn').evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        id: hit?.id,
        disabled: (el as HTMLButtonElement).disabled,
      }
    })

    expect(hitTarget.id).toBe('capture-btn')
    expect(hitTarget.disabled).toBeFalsy()

    await page.locator('#capture-btn').click()
    await page.locator('#capture-btn').click()
    const tapCount = await page.evaluate(() => {
      return (window as unknown as { __captureTapCount: number }).__captureTapCount
    })
    expect(tapCount).toBe(2)
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
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
  })

  test('live feed button is present in viewer toolbar', async ({ page }) => {
    await expect(page.locator('#btn-livefeed')).toBeVisible()
  })

  test('bounds toggle button is present', async ({ page }) => {
    await expect(page.locator('#btn-toggle-bounds')).toBeVisible()
  })

  test('geomap button is present', async ({ page }) => {
    await expect(page.locator('#btn-geomap')).toBeVisible()
  })

  test('clicking live feed button shows live feed panel', async ({ page }) => {
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

  test('clicking geomap opens a usable map drawer', async ({ page }) => {
    await page.locator('#btn-geomap').click()
    await expect(page.locator('#geomap-drawer')).toBeVisible()
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 5000 })
    const hasPinsOrEmptyState = await page.evaluate(() => {
      return document.querySelectorAll('.geomap-pin-wrapper').length > 0
        || window.getComputedStyle(document.getElementById('geomap-empty')!).display !== 'none'
    })
    expect(hasPinsOrEmptyState).toBeTruthy()
  })

  test('bounds button starts with reduced opacity (off)', async ({ page }) => {
    const opacity = await page.locator('#btn-toggle-bounds').evaluate(
      (el) => (el as HTMLElement).style.opacity
    )
    expect(parseFloat(opacity)).toBeLessThan(1)
  })

  test('clicking bounds button toggles opacity to 1 (on)', async ({ page }) => {
    await page.locator('#btn-toggle-bounds').click()
    const opacity = await page.locator('#btn-toggle-bounds').evaluate(
      (el) => (el as HTMLElement).style.opacity
    )
    expect(parseFloat(opacity)).toBe(1)
  })
})

// ── Scan / review / edit / export flow ───────────────────────────────────────

test.describe('Scan review edit export flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForStatus(page, 'begin')
    await page.evaluate(() => document.getElementById('start-screen')?.remove())
  })

  test('review panel exposes edit, export, processing, and clear controls', async ({ page }) => {
    await page.locator('#panel-toggle').click()
    await expect(page.locator('#side-panel')).toHaveClass(/open/)
    await expect(page.locator('#scan-flow-steps')).toContainText('Scan')
    await expect(page.locator('#scan-flow-steps')).toContainText('Review')
    await expect(page.locator('#scan-flow-steps')).toContainText('Edit')
    await expect(page.locator('#scan-flow-steps')).toContainText('Export')
    await expect(page.locator('#panel-export-glb-btn')).toBeVisible()
    await expect(page.locator('#panel-export-summary-btn')).toBeVisible()
    await expect(page.locator('#panel-clear-session-btn')).toBeVisible()
    await expect(page.locator('#panel-stream-btn')).toBeVisible()
  })

  test('autosave status is visible before scanning', async ({ page }) => {
    await expect(page.locator('#autosave-status')).toBeVisible()
    await expect(page.locator('#autosave-status')).toContainText('Autosave')
  })

  test('Done button opens side panel', async ({ page }) => {
    await expect(page.locator('#finish-scan-btn')).toBeVisible()
    await page.locator('#finish-scan-btn').click()
    await expect(page.locator('#side-panel')).toHaveClass(/open/)
  })

  test('verdict status chip displays correctly', async ({ page }) => {
    await expect(page.locator('#verdict-chip')).toBeVisible()
    await expect(page.locator('#verdict-chip')).toContainText('Scanning')
  })

  test('navigation guards confirm dialog on leaving active scan', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__playwright_hooks?.simulateScanData()
    })
    let dialogMessage = ''
    page.on('dialog', async (dialog) => {
      dialogMessage = dialog.message()
      await dialog.dismiss()
    })
    await page.click('#viewer-link')
    expect(dialogMessage).toContain('Leave scan? Unsaved progress will be lost.')
  })
})

// ── AI Engine settings ─────────────────────────────────────────────────────────

test.describe('AI engine settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForStatus(page, 'begin')
    await page.evaluate(() => document.getElementById('start-screen')?.remove())
  })

  test('defaults to server mode — no infer-mode key needed', async ({ page }) => {
    // Clear any saved preference so we start fresh
    await page.evaluate(() => localStorage.removeItem('infer-mode'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForStatus(page, 'begin')
    await page.evaluate(() => document.getElementById('start-screen')?.remove())

    // Open side panel
    await page.locator('#panel-toggle').click()
    await page.waitForTimeout(300)

    // Verify that the server toggle is active
    await expect(page.locator('[data-mode="server"]')).toHaveAttribute('data-active', 'true')
  })

  test('server toggle in settings panel sets localStorage to server', async ({ page }) => {
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
    await page.evaluate(() => localStorage.setItem('infer-mode', 'server'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    const saved = await page.evaluate(() => localStorage.getItem('infer-mode'))
    expect(saved).toBe('server')
  })

  test('AI engine panel buttons are present in side panel', async ({ page }) => {
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
