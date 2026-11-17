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

/**
 * Where the calibration taps land, as a share of the canvas width, along the row y = 0.92.
 *
 * The mock maps screen x to world x as `(x - 0.5) * 4.0` and puts the floor about 2.3 m ahead of a camera 1.5 m up, so a
 * tap is farther from the camera the farther it is from the middle, and the tap sampler reads no spot beyond
 * `TAP_RANGE_MAX_M` (3 m, src/ar/tap-sampling.ts): x 0.10 is 3.18 m away and 0.86 is 3.10 m. 0.28 and 0.72 are 2.89 m
 * away and 1.76 m apart, and clear of the card (x 0.35 to 0.65). The short pair is 0.40 m apart, which is more than
 * ANCHOR_RADIUS_M (the second tap places a marker and does not select the first) and under the 1.0 m minimum.
 */
const TAP_A = 0.28
const TAP_B = 0.72
const SHORT_A = 0.24
const SHORT_B = 0.34

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
  // The button is enabled before the page has its Places ready, and a press in that gap is dropped with a line that
  // says "Preparing projects…" behind the start screen (src/main.ts). On a loaded machine the gap is long enough to
  // hit, and the sheet below then never comes: press again until it is up. A press once the sheet is open does nothing.
  await expect(async () => {
    if (!(await page.locator('#place-nearby-btn').isVisible())) await page.click('#start-ar-btn', { timeout: 5_000 })
    await expect(page.locator('#place-nearby-btn')).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 120_000 })

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
  await holdStill(page)
}

/**
 * Freeze the mock's scripted camera. A person holds the phone still while a tap is read, which is a burst of hits over
 * about half a second (src/ar/calibration-taps.ts); the mock's camera glides at up to 0.5 m/s, which the sampler reads
 * as a hand that moved and refuses. Frozen, every frame of the burst is the same, and the separation of two taps is a
 * pure function of the two coordinates.
 */
async function holdStill(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
}

/**
 * Freeze the mock's pose, and let the provider read it before anything is tapped.
 *
 * The provider takes its pose from the last frame, which arrives up to a frame (33 ms) after `freezeAt()`. A tap made
 * inside that window reads the pose the mock had before the freeze, and the photo taken for it later comes from the
 * frozen pose, which the calibration then reads as a phone that has moved (WP-07): it projects the marker through the
 * lens, and this mock's hit points are not on the rays its lens casts. Waiting three frames makes a frozen mock the
 * phone that has not moved, which is what these tests mean by it.
 */
async function freezeMock(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
  await page.waitForTimeout(100)
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

/** What the mock's live AR scene holds under a name: where each object is, and how far out its vertices reach round it (a ring's radius). */
interface SceneMark {
  name: string
  x: number
  y: number
  z: number
  radius: number
}

async function sceneMarks(page: Page, name: string): Promise<SceneMark[]> {
  return page.evaluate((wanted) => {
    interface Node {
      name?: string
      position: { x: number; y: number; z: number }
      geometry?: { attributes?: { position?: { count: number; getX(i: number): number; getZ(i: number): number } } }
    }
    const xr8 = (window as unknown as Record<string, { Threejs?: { xrScene?: () => { scene?: unknown } } }>)['XR8']
    const scene = xr8?.Threejs?.xrScene?.()?.scene as { traverse?: (cb: (o: Node) => void) => void } | undefined
    const found: SceneMark[] = []
    scene?.traverse?.((o) => {
      if (o.name !== wanted) return
      const vertices = o.geometry?.attributes?.position
      let radius = 0
      for (let i = 0; vertices && i < vertices.count; i++) radius = Math.max(radius, Math.hypot(vertices.getX(i), vertices.getZ(i)))
      found.push({ name: wanted, x: o.position.x, y: o.position.y, z: o.position.z, radius })
    })
    return found
  }, name)
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
  await freezeMock(page)
  await tapCanvas(page, TAP_A, 0.92)
  await expect(page.locator('#project-calibration-confirm')).toBeVisible()
  if (labels?.a) await page.locator('#project-calibration-label-input').fill(labels.a)
  await page.locator('#project-calibration-confirm').click()
  await tapCanvas(page, TAP_B, 0.92)
  // A first calibration is offered a check point after the heading marker; a Place that stores a pair and no check point is not.
  // The check-point button is the one that skips the step, so a person who wants the pair presses it when it is there. Point B is
  // named in review, where the field names it, and not in the check-point step, where it names the check point.
  const skipCheck = page.locator('#project-calibration-check')
  if (await skipCheck.isVisible()) await skipCheck.click()
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

      // Freeze the mock's pose, as every test here that commits does. Its hit points are not on the rays a lens would
      // cast, so a camera that drifts between a tap and the photo leaves the marker out of the picture by the lens's
      // reckoning, and the commit then says so and waits for a second press (WP-07). A frozen pose is a phone that has not moved.
      await freezeMock(page)

      // Step 1 — the landmark. This tap has to reach the canvas listener
      // underneath the overlay; if the overlay swallowed it (the pointer-events
      // regression this wave fixed) nothing below would ever appear.
      await tapCanvas(page, TAP_A, 0.92)
      await expect(page.locator('#project-calibration-status')).toContainText(/landmark placed/i)
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()

      // A first visit may still continue with one point, and the button says what that costs (WP-02, D5).
      const onePoint = page.locator('#project-calibration-fallback')
      await expect(onePoint).toBeVisible()
      await expect(onePoint).toHaveText('Continue with one point (this scan will not line up with other scans)')

      await page.locator('#project-calibration-confirm').click()
      await expect(page.locator('#project-calibration-steps li[data-step=heading]')).toHaveAttribute('data-state', 'active')
      // The walk the step asks for is the recommended one; the hard minimum is only what the commit enforces.
      await expect(page.locator('#project-calibration-copy')).toContainText(/walk 3 m or more/i)

      // Step 2 — the heading marker, far enough to clear MIN_POINT_SEPARATION_M.
      await tapCanvas(page, TAP_B, 0.92)
      const separation = page.locator('#project-calibration-separation')
      await expect(separation).toBeVisible()
      await expect(separation).toHaveAttribute('data-state', 'ok')
      await expect(separation).toContainText(/m apart/i)
      // What the walk is worth is said, and said to be an estimate (ADR 0005 rule 5: its 3 cm tap noise is assumed).
      await expect(separation).toContainText(/estimate: two scans would place a spot 5 m away up to about \d+\.\d cm apart \(95 of 100 times\)/i)

      // The step after the heading marker offers a check point, and the commit waits for it to be answered: skip it here.
      await expect(page.locator('#project-calibration-steps li[data-step=check]')).toHaveAttribute('data-state', 'active')
      await expect(page.locator('#project-calibration-title')).toHaveText('Add a check point (recommended)')
      await expect(page.locator('#project-calibration-commit')).toBeHidden()
      await page.locator('#project-calibration-check').click()

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
      await freezeMock(page)

      await tapCanvas(page, SHORT_A, 0.92)
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()
      await page.locator('#project-calibration-confirm').click()
      // 0.4 m apart: beyond ANCHOR_RADIUS_M so this places a second marker
      // rather than selecting the first, yet still under the 1.0 m minimum the
      // commit gate demands.
      await tapCanvas(page, SHORT_B, 0.92)

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
  test('commits a reference photo and label for each marker, and keeps one origin decal in the scene', async ({ page, request }) => {
    const place = await createPlace(request, 'photos')
    // What the page sends: the photos' route is the server's, and a server built before ADR 0011 has none for a frame's photos, so
    // what this can say is where the page sends them and under what name, not what the server then serves.
    const posts: string[] = []
    page.on('request', (sent) => {
      if (sent.method() === 'POST') posts.push(new URL(sent.url()).pathname)
    })
    let frameId = ''
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })

      // One origin decal, not two rings: the crosshair sits on the landmark and
      // the arrow runs to the heading point, so the arrow is the baseline the user
      // drew. The floor it stands on is kept for the rest of the scan. The flow used
      // to take the grid down at commit and leave the origin floating.
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration origin')
      expect(names).toContain('origin crosshair')
      expect(names).toContain('origin heading arrow')
      expect(names).toContain('calibration floor plane')

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
          // WP-08: a frame has an id, and its photos are kept with it: the record names the frame's own photo path (the heading
          // marker's is `heading` there), and a phone keeps the blob under the id, so that a copy kept for an earlier generation
          // is never found by the record of a later one.
          expect(typeof frame!.frameId, 'the calibration gave the frame an id').toBe('string')
          frameId = frame!.frameId!
          expect(photo.url).toBe(`/projects/${place.id}/frames/${frame!.frameId}/ref-${role === 'headingMarker' ? 'heading' : role}.jpg`)
          expect(photo.localKey).toBe(`${place.id}:${frame!.frameId}:${role}`)
          // The tap point is what turns a photo of a wall into a photo of a
          // *spot* on that wall.
          expect(photo.tapPoint.x).toBeGreaterThanOrEqual(0)
          expect(photo.tapPoint.x).toBeLessThanOrEqual(1)
          expect(photo.tapPoint.y).toBeGreaterThanOrEqual(0)
          expect(photo.tapPoint.y).toBeLessThanOrEqual(1)
          expect(photo.pose).toBeTruthy()
        }
      }).toPass({ timeout: 20_000 })

      // The photos are sent, after the frame is saved, to the route that keeps that frame's photos, and never to the Place's own
      // route, which the server closes once the frame has an id. (Whether the server then serves them is the server slice's to
      // test: tests/unit/node/wp-08c-frame-sync.test.ts holds the page to the rules it will hold it to.)
      await expect(async () => {
        const toFrame = posts.filter((path) => path === `/projects/${place.id}/frames/${frameId}/reference-photos`)
        expect(toFrame.length, 'a photo of each marker was sent to the frame\'s route').toBeGreaterThanOrEqual(2)
      }).toPass({ timeout: 20_000 })
      expect(posts, 'and none to the Place\'s own route').not.toContain(`/projects/${place.id}/reference-photos`)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a return visit shows each stage its own photo, and draws the stored origin once the separation matches', async ({ page, request }) => {
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

      await freezeMock(page)
      await tapCanvas(page, TAP_A, 0.92)
      // This Place already has a two-point frame, so the one-point tier is not offered: a scan taken with it
      // would sit in another frame, rotated by the baseline's bearing (WP-02, D5).
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()
      await expect(page.locator('#project-calibration-fallback')).toBeHidden()
      await page.locator('#project-calibration-confirm').click()

      // Stage 2 shows point B's photo, not point A's.
      await expect(title).toContainText(/Point B/i)
      await expect(page.locator('#project-calibration-reference-label')).toContainText('radiator corner')
      // A return visit is told to tap Point B again and how far it was from Point A, and never to walk farther: a longer
      // pair is more than the tolerance off the stored one, which is the mismatch screen (WP-02, WP-07).
      const stepCopy = page.locator('#project-calibration-copy')
      await expect(stepCopy).toContainText(/tap Point B again, the same spot as (the photo|last time)\. Point B was \d+\.\d\d m from A \(allowed ±0\.17 m\)\./i)
      await expect(stepCopy).not.toContainText(/walk/i)

      await tapCanvas(page, TAP_B, 0.92)
      const returnSeparation = page.locator('#project-calibration-separation')
      await expect(returnSeparation).toContainText(/Stored pair: \d+\.\d\d m\./)
      await expect(returnSeparation).not.toContainText(/or more is better/i)
      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // Step 4 of the return-visit flow, and the only moment it is possible:
      // the stored points are project-space and tautological, so drawing them
      // needs the very transform calibration had not produced until now.
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration stored origin')
      expect(names).toContain('calibration origin')
      expect(names).toContain('origin heading arrow')
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
      expect(await sceneObjectNames(page)).toContain('calibration origin')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('going offline mid-calibration still commits, keeps the frame and the bytes locally, and records where the photos will be served from', async ({ page, context, request }) => {
    const place = await createPlace(request, 'offline')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      // Real browser-level offline, not a page route: `/projects` is a
      // queueable prefix in `public/sw.js`, so a write goes through the
      // service worker and page-level interception never sees it. Going
      // offline here exercises the path a user on a basement floor actually
      // takes. The frame is the page's own to keep (the worker is asked not to
      // queue it), so it fails at once and waits in IndexedDB; the photos wait
      // behind it, and are uploaded only once the server holds the frame.
      //
      // Offline starts only now: selecting the Place needs the network, the
      // calibration that follows does not.
      await context.setOffline(true)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })

      // The photo is an aid, never a gate — the calibration itself completed.
      expect(await sceneObjectNames(page)).toContain('calibration origin')
      expect(await sceneObjectNames(page)).toContain('origin heading arrow')

      // The server is unreachable, so local storage is the only place the truth
      // can be checked — which is the point: this device keeps working.
      //
      // Read until it is all there. The card closes when the calibration is committed; the page then writes the frame,
      // stores each photo's bytes, and only then patches the frame with their records, one write after another. Reading
      // once, the moment the card is gone, races that last write (a busy machine loses it: the frame is there, with no
      // photo records yet), so this waits for what it is about to assert on.
      const readLocal = () => page.evaluate(async (projectId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('ci-xr-projects')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        // The frame the server has not taken waits in `pendingFrame`, and not in the mirror of the Place: the mirror
        // holds only what the server has said.
        const waiting = await new Promise<{ frame: ProjectSpatialFrame; photos?: string[] } | null>((resolve, reject) => {
          const req = db.transaction('pendingFrame', 'readonly').objectStore('pendingFrame').get(projectId)
          req.onsuccess = () => resolve((req.result ?? null) as { frame: ProjectSpatialFrame; photos?: string[] } | null)
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
          frame: waiting?.frame ?? null,
          waitingForPhotos: waiting?.photos ?? [],
          photos: photos.map((p) => ({ role: p.role, bytes: p.blob?.size ?? 0 })).sort((a, b) => a.role.localeCompare(b.role)),
        }
      }, place.id)
      let local = await readLocal()
      await expect.poll(async () => {
        local = await readLocal()
        const written = local.frame?.method === 'two-point-ground' ? local.frame : undefined
        return JSON.stringify({ frame: !!written, photoRecords: !!written?.referencePhotos, photos: local.photos.map((p) => p.role) })
      }, { timeout: 20_000, message: 'the frame, with its photo records, and both photos are written to the phone' })
        .toBe(JSON.stringify({ frame: true, photoRecords: true, photos: ['headingMarker', 'landmark'] }))

      const frame = local.frame
      expect(frame?.method).toBe('two-point-ground')
      const twoPoint = frame?.method === 'two-point-ground' ? frame : undefined
      expect(twoPoint!.pointLabels).toEqual(['north door frame', 'radiator corner'])

      const records = twoPoint!.referencePhotos
      expect(records, 'the frame still carries both photo records').toBeTruthy()
      for (const role of ['landmark', 'headingMarker'] as const) {
        // The path is fixed by Place and role, so it is known before the photo is up. Until the page has uploaded
        // it the path answers 404, and the panel on another device says the photo could not be loaded: it does not
        // show an empty box. Nothing is uploaded while the frame is not saved, so no later calibration of another
        // phone can have its photos replaced by this one's.
        // A frame with an id (WP-08) keeps its photos with it, so the path is its own, and so is the key: the photos belong to this
        // generation of the reference.
        expect(typeof twoPoint!.frameId, 'the frame has an id').toBe('string')
        expect(records![role].url, `${role} url is the path it will be served from`).toBe(`/projects/${place.id}/frames/${twoPoint!.frameId}/ref-${role === 'headingMarker' ? 'heading' : role}.jpg`)
        expect(records![role].localKey).toBe(`${place.id}:${twoPoint!.frameId}:${role}`)
      }
      expect(local.waitingForPhotos, 'both photos wait for the frame to be saved').toEqual(['landmark', 'headingMarker'])

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
      // A device's timing. `provider.start()` resolves as soon as it has called
      // XR8.run(), and the Three.js scene is created in `onStart`, which the
      // documentation puts after the camera status changes
      // (https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule), so
      // getScene() returns null for a short window — and calibration opens
      // inside it.
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
      expect(names).toContain('calibration origin')
      expect(names).toContain('origin heading arrow')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  /**
   * WP-05b. A calibration tap is a burst of hits read as one measurement (src/ar/calibration-taps.ts), through the real
   * provider against the scripted mock: it adds a pipeline module for the burst and removes it again. `?tap=single` is
   * the one-hit arm that DX2 compares it with: it reads one hit, through the same gates, and runs no burst.
   */
  for (const arm of [
    { query: '', name: 'reads each tap as a burst of hits', bursts: 2 },
    { query: '&tap=single', name: 'reads one hit per tap with ?tap=single', bursts: 0 },
  ]) {
    test(`${arm.name}, and commits a two-point frame either way`, async ({ page, request }) => {
      const place = await createPlace(request, `tap${arm.bursts}`)
      try {
        await startArWithPlace(page, place.name, arm.query)
        await reachLandmarkStage(page)
        // Count the bursts the provider opens: each is a pipeline module named for it, added while the session runs.
        await page.evaluate(() => {
          const xr8 = (window as unknown as Record<string, { addCameraPipelineModule(mod: { name?: string }): void }>)['XR8']!
          const add = xr8.addCameraPipelineModule
          ;(window as unknown as Record<string, number>)['__tapBursts'] = 0
          xr8.addCameraPipelineModule = (mod) => {
            if (mod?.name?.startsWith('ci-tap-burst-')) (window as unknown as Record<string, number>)['__tapBursts']! += 1
            return add.call(xr8, mod)
          }
        })
        await placeBothMarkers(page)
        expect(await page.evaluate(() => (window as unknown as Record<string, number>)['__tapBursts'])).toBe(arm.bursts)

        await expect(async () => {
          const frame = twoPointFrame(await readPlace(request, place.id))
          expect(frame?.separationM).toBeGreaterThanOrEqual(1.0)
        }).toPass({ timeout: 15_000 })
      } finally {
        await deletePlace(request, place.id)
      }
    })
  }

  test('a spot too far away is refused with how far, tapping it again takes it and says so, and tapping the marker then selects it', async ({ page, request }) => {
    const place = await createPlace(request, 'toofar')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      const status = page.locator('#project-calibration-status')

      // x 0.10 is 3.18 m from the scripted camera: past the 3 m the sampler reads.
      await tapCanvas(page, 0.10, 0.92)
      await expect(status).toHaveText('That spot is 3.2 m away. Move closer and tap again. Or tap the same spot again to use it anyway.')
      await expect(page.locator('#project-calibration-confirm')).toBeHidden()

      // The same spot again is the person insisting: the hits land where the refused ones did, so the range limit is let
      // past, the landmark is placed, and the card says it was used anyway.
      await tapCanvas(page, 0.10, 0.92)
      await expect(page.locator('#project-calibration-confirm')).toBeVisible()
      await expect(status).toContainText(/landmark placed/i)
      await expect(page.locator('#project-calibration-tapnote')).toHaveText(/^Used anyway: that spot is 3\.\d\d m away, over the 3 m limit\.$/)
      // And the ring that showed the wait is gone.
      await expect(page.locator('#project-calibration-hold')).toBeHidden()

      // The landmark is still 3.2 m away. Tapping it only selects it: one hit and no limit, so nothing is refused.
      await tapCanvas(page, 0.10, 0.92)
      await expect(status).toContainText(/landmark selected/i)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  /**
   * WP-05b. The map moving under the markers between confirming the landmark and the commit. The scripted camera steps a
   * metre with tracking still NORMAL, which is what a relocalization looks like from inside the app (`XR8.jumpAt`, the
   * same hook mock-frame-epoch.spec.ts uses); the provider counts it as a frame shift.
   */
  test('a frame shift between the landmark and the commit sends the flow back to the landmark, and nothing is saved', async ({ page, request }) => {
    const place = await createPlace(request, 'shift')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)

      await tapCanvas(page, TAP_A, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, TAP_B, 0.92)
      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()

      await page.evaluate(() => (window as unknown as Record<string, { jumpAt(n: number): number }>)['XR8'].jumpAt(300))
      await page.waitForTimeout(500) // a few frames, for the provider to count it
      await commit.click()

      await expect(page.locator('#project-calibration-status')).toHaveText('Tracking was disturbed, tap the landmark again')
      await expect(page.locator('#project-calibration-steps li[data-step=landmark]')).toHaveAttribute('data-state', 'active')
      await expect(page.locator(CALIB)).toHaveCount(1)
      await expect(page.locator('#project-calibration-commit')).toBeHidden()
      expect(twoPointFrame(await readPlace(request, place.id)), 'nothing was saved for a pair placed in a frame that moved').toBeUndefined()

      // A pass made in the frame as it now is commits: it is watched from its own confirmation.
      await tapCanvas(page, TAP_A, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, TAP_B, 0.92)
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      await expect(async () => {
        expect(twoPointFrame(await readPlace(request, place.id))?.separationM).toBeGreaterThanOrEqual(1.0)
      }).toPass({ timeout: 15_000 })
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

  /**
   * WP-07. A return visit is finding the same two spots again, and is given what helps: words that name the spot and
   * the distance, a ring on the floor at that distance round the landmark, a chip that says whether the pair is the stored
   * distance apart, and both stored photos while it is checked.
   */
  test('a return visit asks for Point A and Point B again, with the stored distance, a ring on the floor at it, and a chip that says whether the pair matches', async ({ page, request }) => {
    const place = await createPlace(request, 'aids')
    try {
      // Visit 1 sets the frame, with both photos and both labels.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeBothMarkers(page, { a: 'north door frame', b: 'radiator corner' })
      let stored: TwoPointFrame | undefined
      await expect(async () => {
        stored = twoPointFrame(await readPlace(request, place.id))
        expect(stored?.referencePhotos, 'both photos were saved').toBeTruthy()
      }).toPass({ timeout: 20_000 })
      const separation = stored!.separationM

      // Visit 2: the same Place, a fresh session.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      const copy = page.locator('#project-calibration-copy')
      await expect(page.locator('#project-calibration-reference-figure')).toBeVisible({ timeout: 15_000 })
      await expect(copy).toContainText(/tap Point A again, the same spot as the photo/i)
      await expect(copy).not.toContainText(/permanent feature|recognise next visit/i)

      await freezeMock(page)
      await tapCanvas(page, 0.10, 0.92)
      expect(await sceneMarks(page, 'calibration distance ring'), 'no ring until the landmark is confirmed').toHaveLength(0)
      await page.locator('#project-calibration-confirm').click()

      // Point B's step names the distance it was, and the ring marks it on the floor, round the landmark.
      await expect(copy).toContainText(new RegExp(`tap Point B again, the same spot as (the photo|last time)\\. Point B was ${separation.toFixed(2)} m from A \\(allowed ±0\\.17 m\\)\\.`, 'i'))
      const rings = await sceneMarks(page, 'calibration distance ring')
      expect(rings).toHaveLength(1)
      expect(rings[0]!.radius).toBeCloseTo(separation, 3)
      const decals = await sceneMarks(page, 'calibration anchor')
      expect(decals.length, 'the landmark decal').toBeGreaterThan(0)
      expect([rings[0]!.x, rings[0]!.y, rings[0]!.z]).toEqual([decals[0]!.x, decals[0]!.y, decals[0]!.z])

      // Point B at the same pixel is the same distance from A: the chip passes, and says what it did not check.
      await tapCanvas(page, 0.86, 0.92)
      const chip = page.locator('#project-calibration-chip')
      await expect(chip).toBeVisible()
      await expect(chip).toHaveAttribute('data-state', 'pass')
      await expect(chip).toContainText(/about as far apart as stored/i)
      await expect(chip).toContainText(/direction is not checked/i)

      // Review shows both stored photos at once, each with its label, in place of the single-photo panel.
      await expect(page.locator('#project-calibration-compare')).toBeVisible()
      await expect(page.locator('#project-calibration-compare-figure-a')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#project-calibration-compare-figure-b')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#project-calibration-compare-label-a')).toContainText('north door frame')
      await expect(page.locator('#project-calibration-compare-label-b')).toContainText('radiator corner')
      await expect(page.locator('#project-calibration-reference')).toBeHidden()

      // Select B where it is, and put it 64 cm closer to A: the chip fails, which is what Commit would say.
      await tapCanvas(page, 0.86, 0.92)
      await tapCanvas(page, 0.70, 0.92)
      await expect(chip).toHaveAttribute('data-state', 'fail')
      await expect(chip).toContainText(/closer together than stored/i)

      await page.locator('#project-calibration-commit').click()
      await expect(page.locator('#project-calibration-title')).toHaveText('These markers do not match the stored pair')
      await expect(page.locator('#project-calibration-compare'), 'the photos stay for the mismatch screen').toBeVisible()
      expect(await sceneMarks(page, 'calibration distance ring'), 'and so does the ring').toHaveLength(1)

      // Re-placing the points takes the ring and the photos down with the markers.
      await page.locator('#project-calibration-replace').click()
      expect(await sceneMarks(page, 'calibration distance ring')).toHaveLength(0)
      await expect(page.locator('#project-calibration-compare')).toBeHidden()
    } finally {
      await deletePlace(request, place.id)
    }
  })

  /**
   * WP-07, and the symptom the owner reports as "No photo was saved". Moving the landmark after Confirm used to drop its
   * photo and take no other, so the commit had one photo, a frame keeps both or none, and the Place was saved with none.
   */
  test('a landmark moved after Confirm is photographed again, so the Place is saved with both photos and the landmark\'s crosshair is on where it was moved to', async ({ page, request }) => {
    const place = await createPlace(request, 'moved')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await freezeMock(page)
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.86, 0.92)

      // Select the landmark where it is, and put it somewhere else.
      await tapCanvas(page, 0.10, 0.92)
      await tapCanvas(page, 0.16, 0.92)

      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      let frame: TwoPointFrame | undefined
      await expect(async () => {
        frame = twoPointFrame(await readPlace(request, place.id))
        expect(frame?.referencePhotos, 'a photo of each point, or the frame keeps none').toBeTruthy()
      }).toPass({ timeout: 20_000 })

      // The phone has not moved (the mock is frozen), so each crosshair is the pixel its marker was tapped at, in the
      // photo's own coordinates: the camera frame is cover-cropped to fill the canvas. The landmark's is where it was
      // moved to, not where it was first tapped.
      const box = await page.locator('canvas').first().boundingBox()
      const frameSize = { width: 480, height: 360 }
      const scale = Math.max(box!.width / frameSize.width, box!.height / frameSize.height)
      const intoPhoto = (u: number, v: number) => ({
        x: (u * box!.width - (box!.width - frameSize.width * scale) / 2) / (frameSize.width * scale),
        y: (v * box!.height - (box!.height - frameSize.height * scale) / 2) / (frameSize.height * scale),
      })
      const landmark = frame!.referencePhotos!.landmark.tapPoint
      expect(landmark.x).toBeCloseTo(intoPhoto(0.16, 0.92).x, 2)
      expect(landmark.y).toBeCloseTo(intoPhoto(0.16, 0.92).y, 2)
      expect(Math.abs(landmark.x - intoPhoto(0.10, 0.92).x), 'not the spot it was first tapped at').toBeGreaterThan(0.01)
      const heading = frame!.referencePhotos!.headingMarker.tapPoint
      expect(heading.x).toBeCloseTo(intoPhoto(0.86, 0.92).x, 2)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('the floor grid stays on screen after the alignment is committed, beside the markers', async ({ page, request }) => {
    const place = await createPlace(request, 'keptgrid')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeBothMarkers(page)

      // Owner R10: the ground plane is for the whole scan. The flow's own group is gone; the grid is the scene's now.
      const names = await sceneObjectNames(page)
      expect(names).toContain('calibration floor plane')
      expect(names).toContain('calibration anchor landmark')
      expect(names).not.toContain('calibration placement')
      expect(await sceneMarks(page, 'calibration floor plane')).toHaveLength(1)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  /**
   * WP-07, on a phone. The stored photos sit in the top corner and the calibration card is anchored to the bottom, so on
   * a short screen the card is tall enough to reach them: the card hid the second photo's crosshair and both captions on
   * a 375 x 667 screen, and the whole panel on a 320 x 568 one. The panel now takes the room above the card and shrinks its
   * photos to it, and is left out when there is not enough. Where there is room it shows both photos with each crosshair
   * inside its picture, and where there is not it is not on screen: it is never under the card. It is measured on each draw,
   * so a screen that changes height (a toolbar that comes and goes, a phone turned) takes the panel away and brings it back.
   *
   * The card takes taps over most of a phone's width, so the taps here are at the two edges of the view, outside it.
   */
  test('on a phone screen the stored photos are above the calibration card, with their crosshairs in them, or are not shown: never under it', async ({ page, request }) => {
    const place = await createPlace(request, 'phone')
    try {
      const edgeTaps = async (): Promise<void> => {
        await freezeMock(page)
        await tapCanvas(page, 0.02, 0.92)
        await expect(page.locator('#project-calibration-confirm')).toBeVisible()
        await page.locator('#project-calibration-confirm').click()
        await tapCanvas(page, 0.98, 0.92)
      }

      // Visit 1 sets the frame at a small phone's size, with both photos.
      await page.setViewportSize({ width: 375, height: 667 })
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await edgeTaps()
      await page.locator('#project-calibration-label-input').fill('radiator corner')
      await expect(page.locator('#project-calibration-commit')).toBeEnabled()
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      await expect(async () => {
        expect(twoPointFrame(await readPlace(request, place.id))?.referencePhotos, 'both photos were saved').toBeTruthy()
      }).toPass({ timeout: 20_000 })

      // Visit 2 is checked in review at three screen heights, one after another in the one session.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await edgeTaps()
      await expect(page.locator('#project-calibration-chip')).toBeVisible()
      const panel = page.locator('#project-calibration-compare')
      const checkAt = async (size: { width: number; height: number }): Promise<boolean> => {
        const label = `${size.width}x${size.height}`
        await page.setViewportSize(size)
        // The panel is measured against the card on each 200 ms draw.
        await page.waitForTimeout(700)
        const card = await page.locator('.project-calibration-card').boundingBox()
        expect(card, `${label}: the card`).toBeTruthy()
        const shown = await panel.isVisible()
        if (shown) {
          const box = (await panel.boundingBox())!
          expect(box.y, `${label}: the panel is on screen`).toBeGreaterThanOrEqual(0)
          expect(box.y + box.height, `${label}: the panel ends above the card`).toBeLessThanOrEqual(card!.y)
          for (const key of ['a', 'b']) {
            const figure = (await page.locator(`#project-calibration-compare-figure-${key}`).boundingBox())!
            const cross = (await page.locator(`#project-calibration-compare-cross-${key}`).boundingBox())!
            expect(figure.y + figure.height, `${label}: photo ${key} ends above the card`).toBeLessThanOrEqual(card!.y)
            expect(cross.x, `${label}: crosshair ${key} is inside its photo`).toBeGreaterThanOrEqual(figure.x - 8)
            expect(cross.x + cross.width).toBeLessThanOrEqual(figure.x + figure.width + 8)
            expect(cross.y).toBeGreaterThanOrEqual(figure.y - 8)
            expect(cross.y + cross.height).toBeLessThanOrEqual(figure.y + figure.height + 8)
            const caption = (await page.locator(`#project-calibration-compare-label-${key}`).boundingBox())!
            expect(caption.y + caption.height, `${label}: caption ${key} ends above the card`).toBeLessThanOrEqual(card!.y)
          }
        }
        return shown
      }
      // 375 x 667 is a small phone (an iPhone SE without its browser bars), and it has room above the card for both photos.
      expect(await checkAt({ width: 375, height: 667 }), 'at 375 x 667 there is room above the card for the photos').toBe(true)
      // 360 x 640 may or may not: the invariant is all that is held there.
      await checkAt({ width: 360, height: 640 })
      // And the room comes back with the height: the panel is drawn again.
      expect(await checkAt({ width: 375, height: 667 }), 'back at 375 x 667 the photos are drawn again').toBe(true)
    } finally {
      await deletePlace(request, place.id)
    }
  })
})

/**
 * The check point (WP-04b): a third point after the heading marker, so that a later visit is checked by where its points are and
 * which way they face, and not only by how far apart two of them are.
 *
 * The mock's hit test maps a screen tap to the floor as `x = pose.x + (nx - 0.5) * 4` and `z = pose.z - 2.2 - (1 - ny) * 1.2`, and only
 * heights that are about the floor (`ny` above about 0.83) are accepted without a second tap. So every tap on the floor has nearly
 * the same `z`, and a third point 1 m off the line between the first two needs the camera to move: `XR8.jumpAt(0)` puts it 1 m
 * further along Z (the mock's frame-shift hook, which the scanner counts as a tracking shift and does not act on yet). The
 * mock is deterministic, so a second visit that taps the same pixels taps the same points, and its three points agree exactly.
 */
test.describe('check point', () => {
  test.setTimeout(240_000)

  /** Tap A and B (0.10 and 0.86 across, 3.04 m apart), then the check point at `cx` across, from a camera 1 m further along Z. */
  async function placeAbAndC(page: Page, cx: number, labels: { a?: string; c?: string } = {}): Promise<void> {
    await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
    await tapCanvas(page, 0.10, 0.92)
    await expect(page.locator('#project-calibration-confirm')).toBeVisible()
    if (labels.a) await page.locator('#project-calibration-label-input').fill(labels.a)
    await page.locator('#project-calibration-confirm').click()
    await tapCanvas(page, 0.86, 0.92)
    await expect(page.locator('#project-calibration-steps li[data-step=check]')).toHaveAttribute('data-state', 'active')
    // The step has no label field until its marker is down: a field here would name a point that is not there yet.
    await expect(page.locator('#project-calibration-label-field')).toBeHidden()
    await page.evaluate(() => (window as unknown as Record<string, { jumpAt(n: number): number }>)['XR8'].jumpAt(0))
    await tapCanvas(page, cx, 0.92)
    // The field then names the check point, the marker placed last: what is typed after a tap names the point just tapped.
    if (labels.c) await page.locator('#project-calibration-label-input').fill(labels.c)
  }

  /** The Place's frame once it carries a check point whose photo the server serves. */
  async function savedFrameWithCheckPoint(request: APIRequestContext, id: string): Promise<TwoPointFrame> {
    let frame: TwoPointFrame | undefined
    await expect(async () => {
      frame = twoPointFrame(await readPlace(request, id))
      expect(frame?.checkPoints?.[0]?.photo, 'the check point is saved with its photo record').toBeTruthy()
    }).toPass({ timeout: 30_000 })
    return frame!
  }

  test('a first calibration can add a check point: the step, its guidance, the stored point with its name, and its photo', async ({ page, request }) => {
    const place = await createPlace(request, 'checkpoint')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeAbAndC(page, 0.30, { a: 'north door frame', c: 'by the radiator' })

      // In review, with three markers: the check point is named, placed and judged by what the fit can do with it.
      await expect(page.locator('#project-calibration-title')).toHaveText('Check the alignment')
      await expect(page.locator('#project-calibration-steps li[data-step=check]')).toHaveAttribute('data-state', 'active')
      const separation = page.locator('#project-calibration-separation')
      await expect(separation).toContainText(/Point C: \d\.\d m from A, \d(\.\d)? m off the A–B line\./)
      await expect(separation).toContainText(/Estimate: two scans would place a spot 5 m away up to about \d+\.\d cm apart \(95 of 100 times\)\./)
      // A first calibration compares nothing, so there is no readout of a comparison.
      await expect(page.locator('#project-calibration-fit')).toBeHidden()
      await expect(page.locator('#project-calibration-check')).toHaveText('Remove the check point')

      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      expect(await sceneObjectNames(page)).toContain('calibration anchor check')

      const frame = await savedFrameWithCheckPoint(request, place.id)
      expect(frame.checkPoints).toHaveLength(1)
      const point = frame.checkPoints![0]!
      expect(point.label).toBe('by the radiator')
      // In the Place frame: a point off the line between the pair, at about the height of the landmark.
      expect(Math.abs(point.x)).toBeGreaterThan(0.5)
      expect(Math.abs(point.y)).toBeLessThan(0.1)
      expect(point.photo!.url).toBe(`/projects/${place.id}/reference-photos/ref-check1.jpg`)
      expect(point.photo!.localKey).toBe(`${place.id}:check1`)
      expect(frame.pointLabels).toEqual(['north door frame', ''])
      expect(frame.referencePhotos, 'the two markers keep their photos').toBeTruthy()
      await expect(async () => {
        const served = await request.get(`/projects/${place.id}/reference-photos/ref-check1.jpg`)
        expect(served.status()).toBe(200)
        expect(served.headers()['content-type']).toContain('image/jpeg')
      }).toPass({ timeout: 30_000 })
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a return visit re-taps the check point, reads the residuals in cm, draws the stored points beside the markers, and is verified when they agree', async ({ page, request }) => {
    const place = await createPlace(request, 'checkreturn')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeAbAndC(page, 0.30, { c: 'by the radiator' })
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      const stored = await savedFrameWithCheckPoint(request, place.id)

      // Visit 2 — the same three points tapped again.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.86, 0.92)

      // The step asks for last time's point, with its photo and its name in the reference panel.
      await expect(page.locator('#project-calibration-title')).toHaveText('Tap the check point from last time')
      await expect(page.locator('#project-calibration-copy')).toContainText(/Step 3 of 3 — tap point C, the check point from last time, about \d\.\d m from the landmark/)
      await expect(page.locator('#project-calibration-reference-title')).toContainText(/Point C/)
      await expect(page.locator('#project-calibration-reference-label')).toContainText('by the radiator')
      await expect(page.locator('#project-calibration-reference-figure')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#project-calibration-commit')).toBeHidden()
      await expect(page.locator('#project-calibration-check')).toHaveText('Skip the check point')

      await page.evaluate(() => (window as unknown as Record<string, { jumpAt(n: number): number }>)['XR8'].jumpAt(0))
      await tapCanvas(page, 0.30, 0.92)

      // The residuals, in the verdict's words: how many points, how far off on average and the limit, then the points one by one,
      // then what taps cannot see. The mock is exact, so every residual is a rounding.
      const readout = page.locator('#project-calibration-fit')
      await expect(readout).toBeVisible()
      await expect(readout).toContainText(/3 points are \d+\.\d cm off the stored ones on average \(limit 8\.4 cm\)\./)
      await expect(readout).toContainText(/A \d+\.\d cm · B \d+\.\d cm · C \d+\.\d cm/)
      await expect(readout).toContainText('Not checked: that these are the same physical spots. Compare with the photos.')
      await expect(readout).toHaveAttribute('data-state', /ok|warn/)
      // Styled as the page styles its other lines: one sentence to a line (the limit taps cannot see stays a line of its own) and the
      // verdict's colour, teal inside the limits and verifiable, amber inside them but not.
      await expect(readout).toHaveCSS('white-space', 'pre-line')
      await expect(readout).toHaveCSS('font-size', '12px')
      await expect(readout).toHaveCSS('color', /^rgb\((114, 221, 212|255, 200, 87)\)$/)

      const commit = page.locator('#project-calibration-commit')
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // The stored points are drawn where this visit puts them: a ring for each, and the markers are all still there.
      const names = await sceneObjectNames(page)
      expect(names.filter((name) => name === 'calibration stored reference')).toHaveLength(3)
      for (const name of ['calibration anchor landmark', 'calibration anchor heading', 'calibration anchor check']) expect(names).toContain(name)

      // A visit that matched leaves the Place's frame as it was: same record, same time.
      const after = twoPointFrame(await readPlace(request, place.id))
      expect(after?.createdAt).toBe(stored.createdAt)
      expect(after?.checkPoints).toEqual(stored.checkPoints)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a check point tapped a metre and more from where it was is a mismatch the card explains, and "Adjust a point" goes back to fix it', async ({ page, request }) => {
    const place = await createPlace(request, 'checkoff')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeAbAndC(page, 0.30)
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      const stored = await savedFrameWithCheckPoint(request, place.id)

      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      // The check point 0.4 m along the baseline from where it was: the pair is exactly right, so the distance between the two is as
      // stored, and only the third point can say so.
      await placeAbAndC(page, 0.20)
      const live = page.locator('#project-calibration-fit')
      await expect(live).toBeVisible()
      await expect(live).toHaveAttribute('data-state', 'mismatch')
      await expect(live).toHaveCSS('color', 'rgb(255, 155, 155)')
      // And the card does not call itself ready beside a readout that says the points do not match.
      await expect(page.locator('#project-calibration-status')).toHaveText('These points do not match the stored ones yet.')
      await page.locator('#project-calibration-commit').click()

      await expect(page.locator('#project-calibration-title')).toHaveText('These points do not match the stored ones')
      await expect(page.locator('#project-calibration-copy')).toContainText('They do not line up with the stored points.')
      await expect(live).toContainText(/3 points are \d+\.\d cm off the stored ones on average \(limit 8\.4 cm\)\./)
      await expect(live).toContainText(/The worst point is \d+\.\d cm off/)
      await expect(live).toContainText(/A \d+\.\d cm · B \d+\.\d cm · C \d+\.\d cm/)
      // The ways out: adjust a point, re-place them, keep them anyway, continue without. "Wrong Place?" is the host's to supply.
      for (const id of ['adjust', 'replace', 'override', 'skip']) await expect(page.locator(`#project-calibration-${id}`)).toBeVisible()
      await expect(page.locator('#project-calibration-wrong-place')).toBeHidden()
      await expect(page.locator('#project-calibration-commit')).toBeHidden()

      // Back to the markers: select the check point by tapping it, tap where it was, and the readout follows.
      await page.locator('#project-calibration-adjust').click()
      await expect(page.locator('#project-calibration-title')).toHaveText('Check the alignment')
      await tapCanvas(page, 0.20, 0.92)
      await expect(page.locator('#project-calibration-status')).toContainText(/Check point selected/i)
      await tapCanvas(page, 0.30, 0.92)
      await expect(live).not.toHaveAttribute('data-state', 'mismatch')
      await expect(live).toContainText(/3 points are \d+\.\d cm off the stored ones on average/)

      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      expect(twoPointFrame(await readPlace(request, place.id))?.createdAt, 'the Place\'s frame was not replaced').toBe(stored.createdAt)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('skipping the check point on a return visit says what is then checked, and commits a visit that is checked by distance', async ({ page, request }) => {
    const place = await createPlace(request, 'checkskip')
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeAbAndC(page, 0.30)
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      const stored = await savedFrameWithCheckPoint(request, place.id)

      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.86, 0.92)
      await expect(page.locator('#project-calibration-title')).toHaveText('Tap the check point from last time')
      await page.locator('#project-calibration-check').click()

      await expect(page.locator('#project-calibration-status')).toHaveText('Skipped. Only the distance between the two points will be checked.')
      await expect(page.locator('#project-calibration-fit')).toBeHidden()
      // The way back stays open: review offers last time's point again.
      await expect(page.locator('#project-calibration-check')).toHaveText('Tap the check point from last time')
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      expect((await sceneObjectNames(page)).filter((name) => name === 'calibration stored reference'), 'the pair, as it always was').toHaveLength(2)
      expect(twoPointFrame(await readPlace(request, place.id))?.checkPoints).toEqual(stored.checkPoints)
    } finally {
      await deletePlace(request, place.id)
    }
  })

  /**
   * How much of the camera view is left above the card at a phone's size, in px: the top edge of the card. The mock cannot be tapped
   * at a phone's size (its floor is the bottom of the screen, which is where the card sits), so the stage is reached at the desktop
   * size and the page is then made the phone's: the card's size is its content's and the width it is given, and both are the phone's.
   */
  async function uncoveredAt(page: Page, size: { width: number; height: number }): Promise<number> {
    await page.setViewportSize(size)
    await page.waitForTimeout(300)
    return page.evaluate(() => Math.round((document.querySelector('.project-calibration-card') as HTMLElement).getBoundingClientRect().top))
  }

  /**
   * What a person needs of the camera view to aim a tap at the floor: the strip above the card, which the check point's step must not
   * eat. Adopted, not measured (ADR 0005 rule 5): about a fifth of a 640 px phone, which the card left before the check point's step
   * and the readout were added, and which the review of the constellation flow asked it to keep. Revisit with a person's thumb on a phone.
   */
  const ENOUGH_CAMERA_VIEW_PX = 120
  const PHONES = [{ width: 360, height: 640 }, { width: 375, height: 667 }]

  test('on a small phone the card leaves the camera view above it to tap on, at the check step, in review and on the mismatch screen, and its title is never cut off', async ({ page, request }) => {
    const place = await createPlace(request, 'smallphone')
    const desktop = page.viewportSize() ?? { width: 1280, height: 720 }
    try {
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.86, 0.92)
      await expect(page.locator('#project-calibration-title')).toHaveText('Add a check point (recommended)')
      for (const phone of [...PHONES, { width: 320, height: 568 }]) {
        const top = await uncoveredAt(page, phone)
        expect(top, `the card's title is on the screen at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(0)
        if (phone.height >= 640) expect(top, `the check step at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(ENOUGH_CAMERA_VIEW_PX)
      }
      await page.setViewportSize(desktop)
      await page.evaluate(() => (window as unknown as Record<string, { jumpAt(n: number): number }>)['XR8'].jumpAt(0))
      await tapCanvas(page, 0.30, 0.92)
      await expect(page.locator('#project-calibration-title')).toHaveText('Check the alignment')
      await expect(page.locator('#project-calibration-label-field')).toBeVisible()
      for (const phone of [...PHONES, { width: 320, height: 568 }]) {
        const top = await uncoveredAt(page, phone)
        expect(top, `the card's title is on the screen at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(0)
        if (phone.height >= 640) expect(top, `review with the check point at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(ENOUGH_CAMERA_VIEW_PX)
      }
      await page.setViewportSize(desktop)
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      await savedFrameWithCheckPoint(request, place.id)

      // The return visit with the check point a long way off: the mismatch screen, which has the most words on it.
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await placeAbAndC(page, 0.20)
      const live = page.locator('#project-calibration-fit')
      await expect(live).toHaveAttribute('data-state', 'mismatch')
      for (const phone of [...PHONES, { width: 320, height: 568 }]) {
        const top = await uncoveredAt(page, phone)
        expect(top, `the card's title is on the screen at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(0)
        if (phone.height >= 640) expect(top, `the readout in review at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(ENOUGH_CAMERA_VIEW_PX)
      }
      await page.setViewportSize(desktop)
      await page.locator('#project-calibration-commit').click()
      await expect(page.locator('#project-calibration-title')).toHaveText('These points do not match the stored ones')
      for (const phone of [...PHONES, { width: 320, height: 568 }]) {
        const top = await uncoveredAt(page, phone)
        expect(top, `the card's title is on the screen at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(0)
        if (phone.height >= 640) expect(top, `the mismatch screen at ${phone.width}x${phone.height}`).toBeGreaterThanOrEqual(ENOUGH_CAMERA_VIEW_PX)
      }
    } finally {
      await page.setViewportSize(desktop).catch(() => {})
      await deletePlace(request, place.id)
    }
  })

  test('a Place with a pair and no check point is never offered one, and the check dot is not there', async ({ page, request }) => {
    const place = await createPlace(request, 'nocheck')
    try {
      await storeFrame(request, place.id, { headingMarker: { x: 0, y: 0, z: 3.04 }, separationM: 3.04, toleranceM: 25 })
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await expect(page.locator('#project-calibration-steps li[data-step=check]')).toBeHidden()
      await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
      await tapCanvas(page, 0.10, 0.92)
      await page.locator('#project-calibration-confirm').click()
      await tapCanvas(page, 0.86, 0.92)
      // Straight to review: nothing is added to an existing frame, because a check point would be taken through this visit's own pair.
      await expect(page.locator('#project-calibration-title')).toHaveText('Check the alignment')
      await expect(page.locator('#project-calibration-check')).toBeHidden()
      await expect(page.locator('#project-calibration-commit')).toBeEnabled()
    } finally {
      await deletePlace(request, place.id)
    }
  })
})
