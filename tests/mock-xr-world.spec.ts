/**
 * Headset world editor on the emulated Meta Quest 3 (iwer, injected through ?mock=webxr).
 *
 * Drives xr-world.html through an immersive-vr session: a controller ray picks a marker, the
 * thumbstick relabels it, and grip plus motion moves it. Each change is asserted as the body the
 * page POSTs to /worlds/:slug/patches, the endpoint the desktop editor writes to. The world API is
 * mocked with page.route; no Scan server is needed.
 *
 * Run against a Vite server started from this checkout:
 *   VITE_URL=https://127.0.0.1:5199 CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium \
 *     npx playwright test --project=chromium-mock mock-xr-world
 */
import { test, expect, type Page } from '@playwright/test'

const SLUG = 'headset-fixture'
const TOKEN = 'headset-test-token'

type Hand = 'left' | 'right'
type Vector = readonly [number, number, number]

interface CapturedPatch {
  url: string
  authorization: string | null
  body: Record<string, unknown>
}

/** The subset of iwer's XRDevice that the page's controllers are driven through. */
interface EmulatedController {
  position: { set(x: number, y: number, z: number): unknown }
  quaternion: { set(x: number, y: number, z: number, w: number): unknown }
  updateButtonValue(id: string, value: number): void
  updateAxes(id: string, x: number, y: number): void
}

/** One scan with no geometry (its GLB 404s here) and two Things: the chair is in the ray's path, the lamp is not. */
function worldFixture(): Record<string, unknown> {
  const thing = (thingId: string, canonicalLabel: string, position: { x: number; y: number; z: number }) => ({
    thingId,
    worldId: 'world-headset',
    projectId: null,
    areaId: null,
    canonicalLabel,
    representativeTargetId: `scan-a/${thingId}-node`,
    position,
    firstSeenScanId: 'scan-a',
    lastSeenScanId: 'scan-a',
    observationIds: [`obs-${thingId}`],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    origin: 'matcher',
  })
  const observation = (thingId: string, canonicalLabel: string, position: { x: number; y: number; z: number }) => ({
    observationId: `obs-${thingId}`,
    thingId,
    scanId: 'scan-a',
    projectId: null,
    areaId: null,
    sessionId: null,
    targetId: `scan-a/${thingId}-node`,
    label: canonicalLabel,
    canonicalLabel,
    confidence: 0.9,
    worldPos: position,
    observedAt: null,
    origin: 'matcher',
  })
  const chairAt = { x: 0, y: 1.2, z: -1.5 }
  const lampAt = { x: 1.5, y: 1.4, z: -1.5 }
  return {
    worldId: 'world-headset',
    name: 'Headset fixture',
    shareSlug: SLUG,
    projectId: null,
    originGeoPose: null,
    localFrame: null,
    scans: [{
      scanId: 'scan-a',
      projectId: null,
      sessionId: null,
      filename: 'scan-a.glb',
      name: 'Living room',
      glbUrl: '/scans/scan-a.glb',
      geoPose: null,
      localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      accuracyM: null,
      geoDistanceM: null,
      calibrationMethod: null,
      calibrationStatus: null,
      capturedAt: null,
      pointCount: null,
      detectionCount: null,
      layerIndex: [],
      status: 'ready',
    }],
    things: [thing('thing-chair', 'chair', chairAt), thing('thing-lamp', 'lamp', lampAt)],
    thingObservations: [observation('thing-chair', 'chair', chairAt), observation('thing-lamp', 'lamp', lampAt)],
    members: [],
    comments: [],
    jobs: [],
    editPatches: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

/**
 * Mocks the world API the page reads and writes. The POST answers like the server does: the saved
 * patch plus the world. With `refuseSaves`, every POST is refused, to test the revert path.
 */
async function mockWorldApi(page: Page, options: { refuseSaves?: boolean } = {}): Promise<CapturedPatch[]> {
  const captured: CapturedPatch[] = []
  await page.route('**/scans/**', (route) => route.fulfill({
    status: 404,
    contentType: 'text/plain',
    body: 'no geometry in this fixture',
  }))
  await page.route('**/worlds/**', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      captured.push({ url: request.url(), authorization: request.headers()['authorization'] ?? null, body })
      if (options.refuseSaves) {
        await route.fulfill({ status: 403, contentType: 'text/plain', body: 'editor role required' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          patch: { ...body, patchId: `patch-${captured.length}`, worldId: 'world-headset', createdAt: new Date().toISOString() },
          world: worldFixture(),
        }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(worldFixture()) })
  })
  return captured
}

async function aim(page: Page, hand: Hand, at: Vector): Promise<void> {
  await page.evaluate(([name, [x, y, z]]) => {
    const device = (window as unknown as { __iwerDevice?: { controllers: Record<string, EmulatedController> } }).__iwerDevice
    const controller = device?.controllers[name]
    if (!controller) throw new Error(`no emulated ${name} controller`)
    controller.position.set(x, y, z)
    controller.quaternion.set(0, 0, 0, 1)
  }, [hand, at] as const)
}

async function pressButton(page: Page, hand: Hand, id: 'trigger' | 'squeeze', value: 0 | 1): Promise<void> {
  await page.evaluate(([name, buttonId, pressed]) => {
    const device = (window as unknown as { __iwerDevice?: { controllers: Record<string, EmulatedController> } }).__iwerDevice
    const controller = device?.controllers[name]
    if (!controller) throw new Error(`no emulated ${name} controller`)
    controller.updateButtonValue(buttonId, pressed)
  }, [hand, id, value] as const)
}

async function tiltStick(page: Page, hand: Hand, y: number): Promise<void> {
  await page.evaluate(([name, stickY]) => {
    const device = (window as unknown as { __iwerDevice?: { controllers: Record<string, EmulatedController> } }).__iwerDevice
    const controller = device?.controllers[name]
    if (!controller) throw new Error(`no emulated ${name} controller`)
    controller.updateAxes('thumbstick', 0, stickY)
  }, [hand, y] as const)
}

/** Opens the editor with the emulator installed and enters the emulated headset session. */
async function enterVr(page: Page): Promise<void> {
  await page.goto(`/xr-world.html?world=${SLUG}&token=${TOKEN}&mock=webxr`)
  await expect(page.locator('#world-name')).toHaveText('Headset fixture', { timeout: 30_000 })
  await expect(page.locator('#enter-vr')).toBeEnabled({ timeout: 30_000 })
  await page.locator('#enter-vr').click()
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'vr', { timeout: 20_000 })
}

test.describe('headset world editor on the emulated Quest', () => {
  test.setTimeout(90_000)

  test('select a Thing, relabel it and move it, saving each change as a patch', async ({ page }) => {
    const captured = await mockWorldApi(page)
    await enterVr(page)

    // The ray starts 1 m in front of the chair marker at (0, 1.2, -1.5) and points down -Z.
    await aim(page, 'right', [0, 1.2, -0.5])
    await pressButton(page, 'right', 'trigger', 1)
    await expect(page.locator('body')).toHaveAttribute('data-selected', 'thing-chair')
    await pressButton(page, 'right', 'trigger', 0)

    // Thumbstick up: chair -> table.
    await tiltStick(page, 'right', -1)
    await expect.poll(() => captured.length).toBe(1)
    await tiltStick(page, 'right', 0)
    expect(captured[0].body).toEqual({
      scope: 'thing',
      scanId: 'scan-a',
      targetId: 'thing-chair',
      originTargetId: 'scan-a/thing-chair-node',
      label: 'table',
    })

    // Thumbstick down: table -> chair.
    await tiltStick(page, 'right', 1)
    await expect.poll(() => captured.length).toBe(2)
    await tiltStick(page, 'right', 0)
    expect(captured[1].body).toMatchObject({ scope: 'thing', targetId: 'thing-chair', label: 'chair' })

    // Grip with the ray where it is, then move the controller 0.2 m along x and release.
    await pressButton(page, 'right', 'squeeze', 1)
    await expect(page.locator('body')).toHaveAttribute('data-drag', 'active')
    await aim(page, 'right', [0.2, 1.2, -0.5])
    await pressButton(page, 'right', 'squeeze', 0)
    await expect.poll(() => captured.length).toBe(3)

    const move = captured[2].body as { transform?: { position?: { x: number; y: number; z: number } } } & Record<string, unknown>
    expect(move).not.toHaveProperty('label')
    expect(move).toMatchObject({ scope: 'thing', scanId: 'scan-a', targetId: 'thing-chair', originTargetId: 'scan-a/thing-chair-node' })
    expect(move.transform?.position?.x).toBeCloseTo(0.2, 3)
    expect(move.transform?.position?.y).toBeCloseTo(1.2, 3)
    expect(move.transform?.position?.z).toBeCloseTo(-1.5, 3)

    // Every save goes to the world's patch endpoint under the page's access token.
    for (const patch of captured) {
      const url = new URL(patch.url)
      expect(url.pathname).toBe(`/worlds/${SLUG}/patches`)
      expect(url.searchParams.get('token')).toBe(TOKEN)
      expect(patch.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  test('a refused save says so and reverts the change', async ({ page }) => {
    const captured = await mockWorldApi(page, { refuseSaves: true })
    await enterVr(page)

    await aim(page, 'right', [0, 1.2, -0.5])
    await pressButton(page, 'right', 'trigger', 1)
    await expect(page.locator('body')).toHaveAttribute('data-selected', 'thing-chair')
    await pressButton(page, 'right', 'trigger', 0)

    await tiltStick(page, 'right', -1)
    await expect.poll(() => captured.length).toBe(1)
    await tiltStick(page, 'right', 0)
    await expect(page.locator('#xr-status')).toContainText('Not saved, so the change was reverted')
    await expect(page.locator('#xr-status')).toHaveAttribute('data-tone', 'error')
  })

  test('without an immersive-vr session the page says so and stays read-only', async ({ page }) => {
    const captured = await mockWorldApi(page)
    await page.goto(`/xr-world.html?world=${SLUG}`)
    await expect(page.locator('#world-name')).toHaveText('Headset fixture', { timeout: 30_000 })
    await expect(page.locator('#xr-status')).toContainText(/WebXR is not available|cannot start an immersive VR session/)
    await expect(page.locator('#xr-status')).toHaveAttribute('data-tone', 'error')
    await expect(page.locator('#enter-vr')).toBeDisabled()
    expect(captured).toEqual([])
  })
})
