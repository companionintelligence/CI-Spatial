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
import type { Project, ProjectSpatialFrame } from '../src/world/types'

/**
 * The `'two-point-ground'` member of the frame union.
 *
 * Assertions below read `pointLabels`, `referencePhotos` and `separationM`,
 * none of which exist on the `'ground-tap-compass'` member — so they have to
 * narrow first, exactly as production code does. Deriving the type from the
 * union rather than restating its fields is what makes a schema change show up
 * here as a compile error instead of a silently-passing test.
 */
type TwoPointFrame = Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>

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
async function startArWithPlace(page: Page, placeName: string, query = ''): Promise<void> {
  await page.goto(`/?mock=xr8${query}`)
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

/** Names of every object in the mock's live AR scene. */
async function sceneObjectNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const xr8 = (window as unknown as Record<string, { Threejs?: { xrScene?: () => { scene?: unknown } } }>)['XR8']
    const scene = xr8?.Threejs?.xrScene?.()?.scene as { traverse?: (cb: (o: { name?: string }) => void) => void } | undefined
    if (!scene?.traverse) return []
    const names: string[] = []
    scene.traverse((o) => { if (o.name) names.push(o.name) })
    return names
  })
}

/**
 * Give a Place a stored two-point frame over the API, as though it had been
 * calibrated on some other device.
 *
 * `toleranceM` is a parameter because two of the tests below are about the
 * reference panel rather than the separation check, and a frame whose stored
 * `separationM` cannot match this mock's geometry would bounce them into the
 * mismatch stage before they reached the thing under test.
 */
async function storeFrame(
  request: APIRequestContext,
  id: string,
  frame: Record<string, unknown>,
): Promise<void> {
  const current = await (await request.get(`/projects/${id}`)).json()
  const res = await request.put(`/projects/${id}`, {
    data: {
      ...current,
      spatialFrame: {
        version: 1,
        createdAt: new Date().toISOString(),
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        anchorBearingDeg: null,
        ...frame,
      },
    },
  })
  expect(res.ok(), `PUT /projects/${id} failed: ${res.status()}`).toBeTruthy()
}

/** A 1x1 white JPEG — a real image without shipping a fixture file. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////' +
  '////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z',
  'base64',
)

/** Upload one reference photo directly, standing in for another device's capture. */
async function uploadPhoto(
  request: APIRequestContext,
  id: string,
  role: 'landmark' | 'headingMarker',
  tapPoint: { x: number; y: number },
): Promise<string> {
  const res = await request.post(`/projects/${id}/reference-photos`, {
    multipart: {
      image: { name: 'ref.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG },
      meta: JSON.stringify({
        role,
        tapPoint,
        pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        capturedAt: new Date().toISOString(),
      }),
    },
  })
  expect(res.ok(), `POST reference-photo ${role} failed: ${res.status()}`).toBeTruthy()
  return (await res.json()).url as string
}

/** The Place record as the server currently holds it, or undefined if it is gone. */
async function readPlace(request: APIRequestContext, id: string): Promise<Project | undefined> {
  const after = await (await request.get('/projects')).json() as Project[] | { projects: Project[] }
  const projects = Array.isArray(after) ? after : after.projects
  return projects.find((p) => p.projectId === id)
}

/**
 * The Place's stored two-point frame, or undefined when it has none — either
 * because nothing was committed or because it landed on the one-point tier.
 * Both are real outcomes a caller must distinguish, so neither is asserted here.
 */
function twoPointFrame(place: Project | undefined): TwoPointFrame | undefined {
  const frame = place?.spatialFrame
  return frame?.method === 'two-point-ground' ? frame : undefined
}

/**
 * Freeze the mock's pose, then place both markers at fixed screen coords.
 *
 * Frozen, the mock's screen-x → world-x map is exact and the separation is a
 * pure function of the two coordinates — which is what lets a second visit
 * reproduce the first one's `separationM` and actually reach the verified path.
 */
async function placeBothMarkers(page: Page, labels?: { a?: string; b?: string }): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
  await tapCanvas(page, 0.10, 0.92)
  await expect(page.locator('#project-calibration-confirm')).toBeVisible()
  if (labels?.a) await page.locator('#project-calibration-label-input').fill(labels.a)
  await page.locator('#project-calibration-confirm').click()
  await tapCanvas(page, 0.86, 0.92)
  if (labels?.b) await page.locator('#project-calibration-label-input').fill(labels.b)
  const commit = page.locator('#project-calibration-commit')
  await expect(commit).toBeEnabled()
  await commit.click()
  await expect(page.locator(CALIB)).toHaveCount(0)
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

  /**
   * Ticket 0007. `separationM` proves the two points were the right *distance*
   * apart, never that they were the *same two points* — and tapping the correct
   * pair in reverse order passes the check while rotating the frame exactly
   * 180°, reporting 'verified'. The photos and `pointLabels` asserted here are
   * the only mitigation; the residual cannot see the failure at all.
   */
  test('commits a reference photo and label for each marker, and keeps both markers in the scene', async ({ page, request }) => {
    const place = await createPlace(request, 'photos')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })

      // Both markers persist. Before this ticket `clearPlacement()` tore the
      // heading marker down at commit, so the one thing that fixes the frame's
      // rotation was invisible for the whole scan that followed.
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration anchor landmark')
      expect(names).toContain('calibration anchor heading')

      await expect(async () => {
        const frame = twoPointFrame(await readPlace(request, place.id))
        expect(frame, 'a two-point frame was persisted').toBeTruthy()

        // pointLabels existed in 0002's schema with nothing populating it.
        // Order is load-bearing: index 0 is the landmark, and that is the
        // order +Z is built from.
        expect(frame!.pointLabels).toEqual(['north door frame', 'radiator corner'])

        const photos = frame!.referencePhotos
        expect(photos, 'both photos, or neither').toBeTruthy()
        for (const role of ['landmark', 'headingMarker'] as const) {
          const photo = photos![role]
          expect(photo.url).toBe(`/projects/${place.id}/reference-photos/ref-${role}.jpg`)
          expect(photo.localKey).toBe(`${place.id}:${role}`)
          // The tap point is what turns a photo of a wall into a photo of a
          // *spot* on that wall.
          expect(photo.tapPoint.x).toBeGreaterThanOrEqual(0)
          expect(photo.tapPoint.x).toBeLessThanOrEqual(1)
          expect(photo.tapPoint.y).toBeGreaterThanOrEqual(0)
          expect(photo.tapPoint.y).toBeLessThanOrEqual(1)
          expect(photo.pose).toBeTruthy()
        }
      }).toPass({ timeout: 20_000 })

      // The bytes really are on the server, not just a URL in a record.
      const served = await request.get(`/projects/${place.id}/reference-photos/ref-landmark.jpg`)
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toContain('image/jpeg')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a return visit shows each stage its own photo, and draws the stored pair once the separation matches', async ({ page, request }) => {
    const place = await createPlace(request, 'return')
    try {
      // Visit 1 — establishes the frame and both photos.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })
      await expect(async () => {
        expect(twoPointFrame(await readPlace(request, place.id))?.referencePhotos).toBeTruthy()
      }).toPass({ timeout: 20_000 })

      // Visit 2 — same Place, fresh session.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      const figure = page.locator('#project-calibration-reference-figure')
      const title = page.locator('#project-calibration-reference-title')
      await expect(page.locator('#project-calibration-reference')).toBeVisible()
      // Which photo is which has to be unmistakable: order determines the
      // frame's rotation, so a swapped pair is a silent 180°.
      await expect(title).toContainText(/Point A/i)
      await expect(page.locator('#project-calibration-reference-label')).toContainText('north door frame')
      await expect(figure).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#project-calibration-reference-img')).toHaveJSProperty('complete', true)

      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()

      // Stage 2 shows point B's photo, not point A's.
      await expect(title).toContainText(/Point B/i)
      await expect(page.locator('#project-calibration-reference-label')).toContainText('radiator corner')

      await tapCanvas(page, 0.86, 0.92)
      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // Step 4 of the return-visit flow, and the only moment it is possible:
      // the stored points are project-space and tautological, so drawing them
      // needs the very transform calibration had not produced until now.
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration stored reference')
      expect(names).toContain('calibration anchor landmark')
      expect(names).toContain('calibration anchor heading')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a Place calibrated on another device loads its photos from the server, crosshaired on the recorded tap', async ({ page, request }) => {
    const place = await createPlace(request, 'seconddevice')
    try {
      // No local IndexedDB copy exists for this Place in this browser, so the
      // panel can only work through the server — which is the entire reason a
      // server copy is kept at all.
      const tapPoint = { x: 0.42, y: 0.71 }
      const landmarkUrl = await uploadPhoto(request, place.id, 'landmark', tapPoint)
      const headingUrl = await uploadPhoto(request, place.id, 'headingMarker', { x: 0.6, y: 0.4 })
      const capturedAt = new Date().toISOString()
      await storeFrame(request, place.id, {
        headingMarker: { x: 0, y: 0, z: 3.04 },
        separationM: 3.04,
        // Wide on purpose: this test is about the panel, not the separation
        // check, which the commit test above already covers.
        toleranceM: 25,
        pointLabels: ['north door frame', 'radiator corner'],
        referencePhotos: {
          landmark: { url: landmarkUrl, localKey: `${place.id}:landmark`, tapPoint, pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt },
          headingMarker: { url: headingUrl, localKey: `${place.id}:headingMarker`, tapPoint: { x: 0.6, y: 0.4 }, pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt },
        },
      })

      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      const img = page.locator('#project-calibration-reference-img')
      await expect(page.locator('#project-calibration-reference-figure')).toBeVisible({ timeout: 15_000 })
      await expect(img).toHaveJSProperty('complete', true)

      // The crosshair sits at the recorded tap, in pixels, over the photo as
      // rendered — the last step between a correctly-stored tap and a mark the
      // user acts on.
      const placed = await page.evaluate(() => {
        const image = document.getElementById('project-calibration-reference-img') as HTMLImageElement
        const cross = document.getElementById('project-calibration-reference-crosshair') as HTMLElement
        return { width: image.clientWidth, height: image.clientHeight, left: parseFloat(cross.style.left), top: parseFloat(cross.style.top) }
      })
      expect(placed.width).toBeGreaterThan(0)
      expect(placed.left).toBeCloseTo(tapPoint.x * placed.width, 1)
      expect(placed.top).toBeCloseTo(tapPoint.y * placed.height, 1)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a frame with no photos explains itself, and calibration still completes', async ({ page, request }) => {
    const place = await createPlace(request, 'nophotos')
    try {
      // Every Place calibrated before this ticket is in exactly this state.
      await storeFrame(request, place.id, {
        headingMarker: { x: 0, y: 0, z: 3.04 },
        separationM: 3.04,
        toleranceM: 25,
      })

      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      // An empty panel would read as "there is nothing to match", which on a
      // Place whose photo merely failed to upload is a lie.
      await expect(page.locator('#project-calibration-reference')).toBeVisible()
      await expect(page.locator('#project-calibration-reference-figure')).toBeHidden()
      await expect(page.locator('#project-calibration-reference-note'))
        .toContainText(/before reference photos existed/i)

      // And the photo is never a gate: this still commits.
      await placeBothMarkers(page)
      expect(await sceneObjectNames(page)).toContain('calibration anchor landmark')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('going offline mid-calibration still commits, keeps the bytes locally, and marks the URL pending', async ({ page, context, request }) => {
    const place = await createPlace(request, 'offline')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      // Real browser-level offline, not a page route: `/projects` is a
      // queueable prefix in `public/sw.js`, so the upload goes through the
      // service worker and page-level interception never sees it. Going
      // offline here exercises the path a user on a basement floor actually
      // takes — including the 202-with-no-URL the worker answers with, which
      // `isQueuedOffline` exists to stop callers reading as delivered.
      //
      // Offline starts only now: selecting the Place needs the network, the
      // calibration that follows does not.
      await context.setOffline(true)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })

      // The photo is an aid, never a gate — the calibration itself completed.
      expect(await sceneObjectNames(page)).toContain('calibration anchor landmark')
      expect(await sceneObjectNames(page)).toContain('calibration anchor heading')

      // The server is unreachable, so local storage is the only place the truth
      // can be checked — which is the point: this device keeps working.
      const local = await page.evaluate(async (projectId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('ci-xr-projects')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const project = await new Promise<Project | null>((resolve, reject) => {
          const req = db.transaction('projects', 'readonly').objectStore('projects').get(projectId)
          req.onsuccess = () => resolve((req.result ?? null) as Project | null)
          req.onerror = () => reject(req.error)
        })
        const photos = await new Promise<Array<{ role: string; blob: Blob }>>((resolve, reject) => {
          const req = db.transaction('referencePhotos', 'readonly')
            .objectStore('referencePhotos').index('byProject').getAll(projectId)
          req.onsuccess = () => resolve(req.result as Array<{ role: string; blob: Blob }>)
          req.onerror = () => reject(req.error)
        })
        db.close()
        return {
          frame: project?.spatialFrame ?? null,
          photos: photos.map((p) => ({ role: p.role, bytes: p.blob?.size ?? 0 })).sort((a, b) => a.role.localeCompare(b.role)),
        }
      }, place.id)

      const frame = local.frame
      expect(frame?.method).toBe('two-point-ground')
      const twoPoint = frame?.method === 'two-point-ground' ? frame : undefined
      expect(twoPoint!.pointLabels).toEqual(['north door frame', 'radiator corner'])

      const records = twoPoint!.referencePhotos
      expect(records, 'the frame still carries both photo records').toBeTruthy()
      for (const role of ['landmark', 'headingMarker'] as const) {
        // Pending, not delivered. Recording a URL here would make the next
        // device fetch a 404 and show an empty panel instead of saying so.
        expect(records![role].url, `${role} url is pending`).toBeNull()
        expect(records![role].localKey).toBe(`${place.id}:${role}`)
      }

      // And the bytes really are here, which is what makes the aid work offline
      // for the person who took the photo.
      expect(local.photos.map((p) => p.role)).toEqual(['headingMarker', 'landmark'])
      for (const p of local.photos) expect(p.bytes, `${p.role} blob has bytes`).toBeGreaterThan(0)
    } finally {
      await context.setOffline(false)
      await deletePlace(request, place.id)
    }
  })

  test('renders when the provider scene only exists a few frames after start', async ({ page, request }) => {
    const place = await createPlace(request, 'scenedelay')
    try {
      // The real engine's timing. `provider.start()` resolves as soon as it has
      // called XR8.run(); 8th Wall creates its Three.js scene on the first
      // frame, so getScene() returns null for a short window — and calibration
      // opens inside it.
      //
      // Capturing that null once disabled every visual in the flow for the
      // whole session: no floor grid to sweep toward, no marker decals, no
      // committed anchors. Each draw site just returned early, so it failed
      // silently and looked like AR was broken. The mock used to fire onStart
      // synchronously inside run(), which made it strictly more forgiving than
      // the device and is why no test caught this.
      await startArWithPlace(page, place.name, '&mockSceneDelay=6')

      await expect(async () => {
        expect(await sceneObjectNames(page)).toContain('calibration floor plane')
      }).toPass({ timeout: 30_000 })

      // And the rest of the flow still works, not just the grid.
      await reachLandmarkStage(page)
      await placeBothMarkers(page)
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration anchor landmark')
      expect(names).toContain('calibration anchor heading')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('shows a floor-plane overlay and removes it on exit', async ({ page, request }) => {
    const place = await createPlace(request, 'grid')
    try {
      await startArWithPlace(page, place.name)

      // The overlay makes the app's floor estimate visible. It was invisible
      // before, which is how a capture reached the point of rejecting genuine
      // floor taps while its idea of the floor sat ~2 m off.
      await expect(async () => {
        expect(await sceneObjectNames(page)).toContain('calibration floor plane')
      }).toPass({ timeout: 30_000 })

      await page.locator('#project-calibration-skip').click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // Every exit path clears the placement group, the grid included.
      const after = await sceneObjectNames(page)
      expect(after).not.toContain('calibration floor plane')
      expect(after).not.toContain('calibration placement')
    } finally {
      await deletePlace(request, place.id)
    }
  })
})
