/**
 * The native AR runtime (src/ar/native.ts) in the browser, with the ScanAR plugin stood in.
 *
 *   - A shell with a usable native session takes the native path: the scanner runs on the pose and
 *     points that session sends, and the page goes transparent so the native camera shows through.
 *   - A native session that cannot start hands over to the web runtime, which here is the scripted
 *     8th Wall mock (`?mock=xr8`), the same engine the 8th Wall specs use.
 *
 * The stand-in is installed before the page's scripts run (addInitScript), so main.ts sees a
 * Capacitor shell with a ScanAR plugin. It emits pose and points on a timer, as a session would.
 *
 * Run: npx playwright test --project=chromium-mock mock-native-ar
 */
import { test, expect, type Page } from '@playwright/test'
import { startArScan } from './support/start-scan'

interface FakeScanAROptions {
  /** A message to reject start() with, to exercise the fallback. Null starts the session. */
  failStart: string | null
}

/** Installs a Capacitor shell with a fake ScanAR plugin before any page script runs. */
async function installFakeScanAR(page: Page, options: FakeScanAROptions): Promise<void> {
  await page.addInitScript((opts: FakeScanAROptions) => {
    const w = window as unknown as Record<string, unknown>
    const counters = { started: 0, stopped: 0, captures: 0 }
    w.__scanAR = counters
    const listeners = new Map<string, Array<(e: unknown) => void>>()
    const emit = (name: string, data: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener(data)
    }
    const aspect = 0.75
    const contained = (): { x: number; y: number; width: number; height: number } => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      let width = vw
      let height = width / aspect
      if (height > vh) {
        height = vh
        width = height * aspect
      }
      return { x: (vw - width) / 2, y: (vh - height) / 2, width, height }
    }
    const perspective = (fovYDeg: number, a: number): number[] => {
      const t = Math.tan((fovYDeg * Math.PI) / 360)
      return [1 / (a * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0]
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    let poseTimer: ReturnType<typeof setInterval> | null = null
    let pointsTimer: ReturnType<typeof setInterval> | null = null

    const plugin = {
      async capabilities() {
        return { platform: 'android', engine: 'arcore', supported: true, depth: false }
      },
      async start() {
        if (opts.failStart) throw new Error(opts.failStart)
        counters.started += 1
        const rect = contained()
        poseTimer = setInterval(() => {
          emit('pose', {
            timestamp: performance.now() / 1000,
            transform: identity,
            projection: perspective(60, aspect),
            tracking: 'normal',
          })
        }, 33)
        pointsTimer = setInterval(() => {
          const points: number[] = []
          for (let i = 0; i < 30; i++) {
            points.push((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, -1 - Math.random() * 2)
          }
          emit('points', { timestamp: performance.now() / 1000, points })
        }, 200)
        return { rect, cameraAspect: aspect }
      },
      async stop() {
        counters.stopped += 1
        if (poseTimer) clearInterval(poseTimer)
        if (pointsTimer) clearInterval(pointsTimer)
        poseTimer = null
        pointsTimer = null
      },
      async captureFrame() {
        counters.captures += 1
        const canvas = document.createElement('canvas')
        canvas.width = 96
        canvas.height = 128
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.fillStyle = '#345'
          ctx.fillRect(0, 0, 96, 128)
        }
        return {
          timestamp: performance.now() / 1000,
          width: 96,
          height: 128,
          jpegBase64: canvas.toDataURL('image/jpeg').split(',')[1],
          transform: identity,
          projection: perspective(60, aspect),
        }
      },
      async hitTest() {
        return { hit: false }
      },
      async addListener(event: string, listener: (e: unknown) => void) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return {
          remove: async () => {
            listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener))
          },
        }
      },
    }

    w.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { ScanAR: plugin },
    }
  }, options)
}

test.describe('native AR runtime', () => {
  test.setTimeout(120_000)

  test('the scanner runs on the native session, and the page goes transparent while it runs', async ({ page }) => {
    await installFakeScanAR(page, { failStart: null })
    await startArScan(page, { url: '/?ar=native&mock=xr8' })

    const counters = await page.evaluate(() => (window as unknown as { __scanAR: { started: number; captures: number } }).__scanAR)
    expect(counters.started).toBeGreaterThanOrEqual(1)
    await expect(page.locator('html')).toHaveClass(/native-ar/)

    // The overlay canvas covers the native camera rect (contained, 3:4), not the whole screen.
    const canvasBox = await page.locator('#camerafeed').boundingBox()
    const viewport = page.viewportSize()
    expect(canvasBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    if (canvasBox && viewport) {
      expect(canvasBox.width / canvasBox.height).toBeCloseTo(0.75, 1)
      expect(canvasBox.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(canvasBox.height).toBeLessThanOrEqual(viewport.height + 1)
    }
  })

  test('a native session that cannot start hands over to the web runtime', async ({ page }) => {
    await installFakeScanAR(page, { failStart: 'ARCore session could not be created' })
    await startArScan(page, { url: '/?ar=native&mock=xr8' })

    const counters = await page.evaluate(() => (window as unknown as { __scanAR: { started: number } }).__scanAR)
    expect(counters.started).toBe(0)
    await expect(page.locator('html')).not.toHaveClass(/native-ar/)
    // Points still accumulate: the 8th Wall mock took over the session.
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
    await expect(page.locator('#place-skip-btn')).toBeHidden()
  })
})
