/**
 * Two-point ground calibration flow (wave 09 ticket 0004), driven headlessly
 * against the scripted XR8 mock — no device, camera or SLAM binary.
 *
 * What this covers that the unit tests cannot: the staged flow is a DOM state
 * machine. `tests/unit/deno/anchor_calibration.test.ts` proves the frame math
 * (origin, forward axis, yaw-invariance, rigidity); only a real document can
 * prove the stages are ordered, that a tap reaches the canvas listener beneath
 * the overlay, and that the overlay always unmounts.
 *
 * Note on assertions: `#status-text` is the live scanner status and is
 * overwritten within a second or two by the pose loop, so it is never asserted
 * here. Committed state is checked where it is durable — the Place's
 * `spatialFrame` over the API.
 *
 * Run: npx playwright test --project=chromium-mock mock-two-point-calibration
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { ONBOARDING_KEY } from '../src/shared/storage-keys'

const CALIB = '#project-calibration'
const LAT = 33.51466
const LNG = -117.72159

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => {
    window.localStorage.setItem(key, '1')
  }, ONBOARDING_KEY)
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: LAT, longitude: LNG })
})

/**
 * A disposable Place, created per test that commits a frame.
 *
 * Committing writes `spatialFrame` back to the Place, so reusing a shared
 * fixture would leave a stored two-point reference behind and the *next* run
 * would be measured against it — landing in the mismatch stage whenever the
 * mock's pose drift moved the separation past tolerance. A fresh Place keeps
 * each run a genuine first calibration.
 */
async function createPlace(request: APIRequestContext, label: string): Promise<{ id: string; name: string }> {
  const name = `zz-calib-${label}-${Date.now()}`
  const res = await request.post('/projects', {
    data: { name, placeType: 'room', geoPose: { lat: LAT, lng: LNG, altitudeM: null, bearing: null, accuracyM: 5 } },
  })
  expect(res.ok(), `POST /projects failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  return { id: body.project?.projectId ?? body.projectId, name }
}

async function deletePlace(request: APIRequestContext, id: string | null): Promise<void> {
  if (id) await request.delete(`/projects/${id}`).catch(() => {})
}

/** Boot the mock AR session with `placeName` selected, so calibration runs. */
async function startArWithPlace(page: Page, placeName: string): Promise<void> {
  await page.goto('/?mock=xr8')
  await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
  await page.waitForFunction(
    () => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled,
    null,
    { timeout: 30_000 },
  )
  await page.click('#start-ar-btn')

  // Wave 09 gates AR behind the Scanner Location sheet: with no Place picked
  // there is no `selectedProject`, and calibration is skipped entirely.
  await page.locator('#place-nearby-btn').click()
  await expect(async () => {
    const picked = await page.evaluate((wanted) => {
      const row = Array.from(document.querySelectorAll('button,li,[role=button]'))
        .find((el) => (el.textContent ?? '').includes(wanted))
      if (!row) return false
      ;(row as HTMLElement).click()
      return true
    }, placeName)
    expect(picked, `nearby list has no row for ${placeName}`).toBeTruthy()
  }).toPass({ timeout: 20_000 })

  await page.locator('#place-continue-btn').click()
  await page.locator(CALIB).waitFor({ state: 'attached', timeout: 30_000 })
}

/**
 * Advance past the environment-scan gate. Prefers a genuine ground lock, and
 * falls back to the explicit override the flow offers once the floor wait
 * expires — the mock's synthetic point cloud is not guaranteed to settle one.
 */
async function reachLandmarkStage(page: Page): Promise<void> {
  const status = page.locator('#project-calibration-status')
  await expect(async () => {
    const text = (await status.textContent()) ?? ''
    if (/place the landmark/i.test(text)) return
    const override = page.locator('#project-calibration-skip-ground')
    if (await override.isVisible().catch(() => false)) await override.click()
    throw new Error(`still on the ground stage: ${text}`)
  }).toPass({ timeout: 60_000 })
}

/**
 * Tap the AR canvas at normalised coordinates, as a real placement tap would.
 *
 * Two constraints on every coordinate passed here, both learned the hard way:
 *
 * 1. **Stay clear of the calibration card.** It is centred along the bottom
 *    (max-width 390px, so roughly x 0.35–0.65 at a 1280px viewport) and takes
 *    pointer events, by design. A tap there hits the card, not the canvas, and
 *    silently places nothing.
 * 2. **Keep intentional pairs more than ANCHOR_RADIUS_M (0.35 m) apart.** The
 *    mock maps screen x to world x as `(x - 0.5) * 4.0`, so Δx of 0.0875 is
 *    ~0.35 m. Closer than that and the second tap *selects* the first marker
 *    instead of placing a new one — which is the intended tap-near behaviour,
 *    not a failure.
 */
async function tapCanvas(page: Page, nx: number, ny: number): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('no AR canvas')
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny)
  await page.waitForTimeout(800)
}

test.describe('two-point calibration', () => {
  test.setTimeout(180_000)

  test('opens on the ground stage, and a tap cannot skip ahead of it', async ({ page, request }) => {
    const place = await createPlace(request, 'stages')
    try {
      await startArWithPlace(page, place.name)

      // Stage order is the safety property: nothing may be placed against an
      // unestablished ground plane.
      await expect(page.locator('#project-calibration-steps li[data-step=ground]')).toHaveAttribute('data-state', 'active')
      await expect(page.locator('#project-calibration-steps li[data-step=landmark]')).toHaveAttribute('data-state', 'todo')
      await expect(page.locator('#project-calibration-status'))
        .toContainText(/scanning the environment|still mapping the floor|waiting for stable AR tracking/i)

      // A tap during the ground stage must place nothing. Deliberately to the
      // left of the card, so this genuinely exercises the stage guard rather
      // than passing because the card swallowed the click.
      await tapCanvas(page, 0.15, 0.92)
      await expect(page.locator('#project-calibration-separation')).toBeHidden()
      await expect(page.locator('#project-calibration-confirm')).toBeHidden()
      await expect(page.locator('#project-calibration-status'))
        .toContainText(/scanning the environment|still mapping the floor|waiting for stable AR tracking/i)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('skipping unmounts the overlay and lets scanning proceed uncalibrated', async ({ page, request }) => {
    const place = await createPlace(request, 'skip')
    try {
      await startArWithPlace(page, place.name)
      await page.locator('#project-calibration-skip').click()

      await expect(page.locator(CALIB)).toHaveCount(0)
      // Scanning continues regardless — calibration is not a prerequisite.
      await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 20_000 })

      // Nothing was committed, so the Place keeps no frame.
      const after = await (await request.get('/projects')).json()
      const saved = (after.projects ?? after).find((p: { projectId: string }) => p.projectId === place.id)
      expect(saved?.spatialFrame ?? null).toBeNull()
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('places both markers, reports the separation, and persists a two-point frame', async ({ page, request }) => {
    const place = await createPlace(request, 'commit')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      // Step 1 — the landmark. This tap has to reach the canvas listener
      // underneath the overlay; if the overlay swallowed it (the pointer-events
      // regression this wave fixed) nothing below would ever appear.
      await tapCanvas(page, 0.28, 0.92)
      await expect(page.locator('#project-calibration-status')).toContainText(/landmark placed/i)
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()

      await page.locator('#project-calibration-confirm').click()
      await expect(page.locator('#project-calibration-steps li[data-step=heading]')).toHaveAttribute('data-state', 'active')

      // Step 2 — the heading marker, far enough to clear MIN_POINT_SEPARATION_M.
      await tapCanvas(page, 0.86, 0.92)
      const separation = page.locator('#project-calibration-separation')
      await expect(separation).toBeVisible()
      await expect(separation).toHaveAttribute('data-state', 'ok')
      await expect(separation).toContainText(/m apart/i)

      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeVisible()
      await expect(commit).toBeEnabled()
      await commit.click()

      // Every exit path unmounts the overlay and tears down its decals.
      await expect(page.locator(CALIB)).toHaveCount(0)

      // The durable half: a changed frame is persisted through PUT /projects/:id.
      await expect(async () => {
        const after = await (await request.get('/projects')).json()
        const saved = (after.projects ?? after).find((p: { projectId: string }) => p.projectId === place.id)
        expect(saved?.spatialFrame?.method).toBe('two-point-ground')
        expect(saved?.spatialFrame?.separationM).toBeGreaterThanOrEqual(1.0)
        // Heading came from geometry, so the frame stands with or without a compass.
        expect(saved?.spatialFrame?.headingMarker?.z).toBeCloseTo(saved.spatialFrame.separationM, 5)
        expect(saved?.spatialFrame?.landmark).toEqual({ x: 0, y: 0, z: 0 })
      }).toPass({ timeout: 15_000 })
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a baseline shorter than the minimum cannot be committed', async ({ page, request }) => {
    const place = await createPlace(request, 'short')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      // Freeze the mock's pose first. Without this the camera keeps moving
      // between taps, and since the mock derives world x from
      // `pose.x + (screenX - 0.5) * 4`, the drift swamps the narrow window this
      // test needs — a separation above ANCHOR_RADIUS_M (so the second tap
      // places rather than selects) but below MIN_POINT_SEPARATION_M. Frozen,
      // the gap is exactly (Δx * 4) m.
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))

      await tapCanvas(page, 0.10, 0.92)
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()
      await page.locator('#project-calibration-confirm').click()
      // ~0.6 m apart: comfortably beyond ANCHOR_RADIUS_M so this places a second
      // marker rather than selecting the first, yet still under the 1.0 m
      // minimum the commit gate demands.
      await tapCanvas(page, 0.25, 0.92)

      const separation = page.locator('#project-calibration-separation')
      await expect(separation).toBeVisible()
      await expect(separation).toHaveAttribute('data-state', 'short')
      await expect(separation).toContainText(/need at least/i)
      await expect(page.locator('#project-calibration-commit')).toBeDisabled()
    } finally {
      await deletePlace(request, place.id)
    }
  })
})
