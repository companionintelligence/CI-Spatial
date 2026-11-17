/**
 * One scan, one frame, in the page (WP-09b): a frame shift after the Place calibration asks the person what to do,
 * Re-anchor ends the scan and calibrates the next one, and Check drift measures what a shift did.
 *
 * Driven headlessly against the scripted XR8 mock, no device and no SLAM binary. The mock's `?mockJumpAt=<tick>` puts the
 * scripted camera 1 m further along Z from that tick on, with tracking still NORMAL: the whole map moving under the camera,
 * which is what a relocalization looks like from inside the app and which nothing but the frame-epoch detector
 * (src/ar/frame-epoch.ts) can tell from walking. `XR8.jumpAt(tick)` is the same hook called from a script, and
 * `jumpAt(null)` takes the shift away again: another shift, the other way. `?mockFreeze=<tick>` pins the session before its
 * first frame, so every hit test answers the same until a script moves it: the geometry of a calibration is then exact, and
 * so is what Check drift finds after the shift (1 m).
 *
 * A pinned session cannot lock a floor, though: the floor is fitted again only when the map gains points (src/scene/pointcloud.ts),
 * and a pinned map gains none after its first harvest. A calibration there can go on only by "Place anchor without floor
 * check", and a commit that bypassed the floor check never writes the Place's frame (`mayWritePlaceFrame`, src/ar/ground-gate.ts).
 * So a test that needs the calibration to SET the Place's frame lets the floor lock while the mock walks
 * (`reachLandmarkStageOnLockedFloor`), and freezes it after that: where it is (`freezeInPlace`) when the calibration has to stay
 * in one frame, or by a seek (`holdStill`) in the test that wants a shift in it. A test that stores the Place's frame itself pins
 * the session from its first frame.
 *
 * What this covers that the unit tests cannot: the real page puts the pieces together. tests/unit/node/wp-09b-*.test.ts hold
 * the decisions, the closure maths, the sequence against the real store and the screen against a stand-in document; only a
 * browser shows that main.ts wires them, that the banner is where a thumb can reach it, that the calibration modal really
 * opens again in return-visit mode, that the old scan reaches the server with the sidecar it should have, and that a drift
 * check taken through the real tap path measures the shift that was put in.
 *
 * The uploads are read off the wire (`page.route` on /upload-scan, with the service worker blocked so the page makes the
 * request itself): the sidecar is what the server and the editor will see.
 *
 * Run: npx playwright test --project=chromium-mock mock-reanchor
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { ONBOARDING_KEY } from '../src/shared/storage-keys'

const CALIB = '#project-calibration'
const BANNER = '#reanchor-banner'
const CHECK = '#check-drift-btn'
const LAT = 33.51466
const LNG = -117.72159

// The service worker would make the upload itself, and `page.route` does not see a worker's requests.
test.use({ serviceWorkers: 'block' })

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => {
    window.localStorage.setItem(key, '1')
  }, ONBOARDING_KEY)
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: LAT, longitude: LNG })
})

/** A disposable Place: a stored frame left behind by one run would be what the next run is measured against. */
async function createPlace(request: APIRequestContext, label: string): Promise<{ id: string; name: string }> {
  const name = `zz-reanchor-${label}-${Date.now()}`
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

/**
 * Give a new Place the two-point frame a first visit leaves behind, so the next calibration is a return visit measured against
 * it. The pair is 2 m apart: what the mock's two floor taps (LANDMARK_AT and HEADING_AT) read.
 */
async function storeFrame(request: APIRequestContext, id: string): Promise<void> {
  const frame = {
    version: 1,
    createdAt: '2026-11-01T09:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 2 },
    separationM: 2,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  }
  const res = await request.put(`/projects/${id}/spatial-frame`, { data: { frame, expectedRevision: 0 } })
  expect(res.ok(), `PUT /projects/${id}/spatial-frame failed: ${res.status()}`).toBeTruthy()
}

/** Boot the mock AR session with `placeName` selected, so the calibration runs. */
async function startArWithPlace(page: Page, placeName: string, query: string): Promise<void> {
  await page.goto(`/?mock=xr8${query}`)
  await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
  await page.waitForFunction(
    () => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled,
    null,
    { timeout: 30_000 },
  )
  await page.click('#start-ar-btn')
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
 * Advance past the environment-scan gate, with the explicit override the flow offers once the floor wait expires. For a calibration
 * that writes nothing to the Place, or whose floor cannot lock (a frozen mock gains no points, which is what the floor's fit waits
 * for): the override is a floor-check bypass.
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
 * Advance past the environment-scan gate on a floor that locked, and never by the override. A commit that bypassed the floor check
 * never writes the Place's frame (`mayWritePlaceFrame`, src/ar/ground-gate.ts), so a calibration that has to SET the frame must not
 * press it: if the floor has not locked in a minute this fails here, on the stage, and not later on a Place with no frame.
 */
async function reachLandmarkStageOnLockedFloor(page: Page): Promise<void> {
  await expect(page.locator('#project-calibration-status')).toContainText(/place the landmark/i, { timeout: 60_000 })
}

/**
 * Wait until the mock has emitted `count` more frames. A frozen camera is the provider's only once a frame has gone by, and a clock
 * only guesses at that on a loaded machine, where the mock's 33 ms timer runs late. The frames are counted by a pipeline module of
 * this spec's own, added through the call the app uses (public/test-fixtures/xr8-mock.js runs its modules in the order they were
 * added, the app's first), so a frame counted here is one the provider has already taken.
 */
async function waitForMockFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((wanted) => new Promise<void>((resolve, reject) => {
    const xr8 = (window as unknown as Record<string, {
      addCameraPipelineModule(mod: { name: string; onUpdate(): void }): void
      removeCameraPipelineModule(name: string): void
    }>)['XR8']!
    const name = 'spec-frame-counter'
    let seen = 0
    const giveUp = setTimeout(() => {
      xr8.removeCameraPipelineModule(name)
      reject(new Error(`the mock emitted ${seen} of ${wanted} frames in 10 s`))
    }, 10_000)
    xr8.addCameraPipelineModule({
      name,
      onUpdate: () => {
        if (++seen < wanted) return
        clearTimeout(giveUp)
        xr8.removeCameraPipelineModule(name)
        resolve()
      },
    })
  }), count)
}

/**
 * Freeze the mock's scripted camera. A person holds the phone still while a tap is read, which is a burst of hits over about
 * half a second (src/ar/calibration-taps.ts); the mock's camera glides, and after a jump it is moving when the burst starts,
 * which the sampler reads as a hand that moved and refuses ('That spot did not read steadily'). Frozen, every frame of the
 * burst is the same.
 *
 * `freezeAt()` SEEKS the mock to tick 300 and holds it there (public/test-fixtures/xr8-mock.js), and the provider takes the
 * frozen pose from the next frame, up to one frame (33 ms) after the call. The step from the old tick to 300 is normally a step of
 * the camera that a hand cannot make in one frame, so the frame-epoch detector (src/ar/frame-epoch.ts) counts it as a shift of
 * its own, and a tap made inside that frame is read in the old pose, or across the step, which the sampler refuses
 * (`trackingWasDisturbed`, src/ar/tap-sampling.ts). So the helper waits for three frames before it returns, as freezeMock() does
 * in mock-two-point-calibration.spec.ts with a pause. The shift is no harm to the test that uses this: it is about a calibration
 * that ran across a shift, and this one comes before the first point is placed.
 */
async function holdStill(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8']!.freezeAt(300))
  await waitForMockFrames(page, 3)
}

/**
 * Freeze the mock's scripted camera where it is, with no step, for a calibration that has to stay in one frame.
 *
 * `holdStill()` seeks, and a seek inside a calibration that is running is a frame shift: this test's first scan would run across
 * a shift it did not put in. Pinning the session before its first frame is no way round it (see the header: its floor never
 * locks). So the camera is frozen after the floor has locked, at a tick where the mock's walk is at the camera's x now. The mock
 * cannot be asked which tick it is at, so this tries each tick of a full cycle of the walk (it repeats about every 471 ticks) and
 * keeps the one whose camera x is nearest: a hit test through the middle of the screen reports it, since the screen's x maps to
 * the world's as `(x - 0.5) * 4`. All of it is one call of the page's script, in which the mock emits no frame, so the app sees
 * the last seek only: a step of some millimetres in x and at most 6 cm in height, which is no shift. Waits for three frames, as
 * `holdStill()` does, for the provider to take the frozen pose.
 */
async function freezeInPlace(page: Page): Promise<void> {
  const gapM = await page.evaluate(() => {
    const xr8 = (window as unknown as Record<string, {
      freezeAt(n: number): number
      XrController: { hitTest(x: number, y: number): Array<{ position: { x: number } }> }
    }>)['XR8']!
    const cameraX = (): number => xr8.XrController.hitTest(0.5, 0.5)[0]!.position.x
    const now = cameraX()
    // From tick 12 on, the mock's tracking is NORMAL and a hit test answers; its walk repeats about every 471 ticks.
    let best = 12
    let bestGapM = Number.POSITIVE_INFINITY
    for (let tick = 12; tick <= 600; tick++) {
      xr8.freezeAt(tick)
      const gap = Math.abs(cameraX() - now)
      if (gap < bestGapM) {
        best = tick
        bestGapM = gap
      }
    }
    xr8.freezeAt(best)
    return bestGapM
  })
  expect(gapM, "some tick of the mock's walk is at the camera's x of now").toBeLessThan(0.05)
  await waitForMockFrames(page, 3)
}

/**
 * Tap the AR canvas at normalised coordinates. Clear of the calibration card, which sits centred along the bottom and takes
 * its own taps, and of the banner, which sits above the capture button.
 */
async function tapCanvas(page: Page, nx: number, ny: number): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('no AR canvas')
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny)
  await page.waitForTimeout(800)
}

/**
 * Two floor points the mock reads 1 m either side of the camera, so they are 2 m apart (over the 1 m the commit asks for)
 * and each is under 3 m from the camera (the farthest a drift check's tap is read from, src/ar/tap-sampling.ts).
 */
const LANDMARK_AT = { x: 0.25, y: 0.92 }
const HEADING_AT = { x: 0.75, y: 0.92 }

async function placeBothMarkers(page: Page): Promise<void> {
  await tapCanvas(page, LANDMARK_AT.x, LANDMARK_AT.y)
  await expect(page.locator('#project-calibration-confirm')).toBeVisible()
  await page.locator('#project-calibration-confirm').click()
  await tapCanvas(page, HEADING_AT.x, HEADING_AT.y)
  // A first calibration is offered a check point after the heading marker (stage 'check'), and "Use this alignment" is shown only
  // in the stage after it ('review'); the check-point button is the one that skips the step. A Place that stores a pair and no
  // check point (every return visit here) is not offered one, and is in review at once. Neither is up until the tap has been
  // read, so wait for whichever comes. Commit being shown is what says the step is over, and the check dot being the active
  // one is what says it is open: in review the same button offers to add a check point back, and pressing it then would open the step.
  const commit = page.locator('#project-calibration-commit')
  const skipCheck = page.locator('#project-calibration-check')
  const checkStepOpen = page.locator('#project-calibration-steps li[data-step=check][data-state=active]')
  await expect(async () => {
    if (await commit.isVisible()) return
    if ((await checkStepOpen.count()) > 0) await skipCheck.click()
    throw new Error('the heading marker is not placed yet, or the check-point step is still open')
  }).toPass({ timeout: 20_000 })
  // Commit is hidden in the check stage and enabled all the same, so a click on it there waits out the whole test: say it is shown.
  await expect(commit).toBeVisible()
  await expect(commit).toBeEnabled()
  await commit.click()
  await expect(page.locator(CALIB)).toHaveCount(0)
}

// ── What the page sends the server ──────────────────────────────────────────────────────────────────

type Sidecar = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** The `metadata` part of a multipart upload body: the sidecar the server stores, as text between the boundaries. */
function metadataFrom(body: string): Sidecar | null {
  const at = body.indexOf('name="metadata"')
  if (at < 0) return null
  const start = body.indexOf('\r\n\r\n', at)
  if (start < 0) return null
  const end = body.indexOf('\r\n--', start + 4)
  try {
    return JSON.parse(body.slice(start + 4, end < 0 ? undefined : end)) as Sidecar
  } catch {
    return null
  }
}

/** Every scan the page uploads from now on, its sidecar parsed. The request goes on to the real server. */
async function captureUploads(page: Page): Promise<Sidecar[]> {
  const uploads: Sidecar[] = []
  await page.route('**/upload-scan', async (route) => {
    const metadata = metadataFrom(route.request().postDataBuffer()?.toString('utf8') ?? '')
    if (metadata) uploads.push(metadata)
    await route.continue()
  })
  return uploads
}

interface EntrySummary {
  sessionId: string
  status: string
  scanFilename: string | null
  calibrationMethod: string | null
  calibrationStatus: string | null
  /** What the calibration was checked by: set only when a visit was compared with the Place's stored points (`ScanCalibration.checkedBy`). */
  calibrationCheckedBy: string | null
}

/** The Place's scan entries in the phone's own database, oldest first: the bookkeeping the export reads its calibration from. */
async function scanEntries(page: Page, projectId: string): Promise<EntrySummary[]> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('ci-xr-projects')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const rows = await new Promise<Array<Record<string, any>>>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const request = db.transaction('scans', 'readonly').objectStore('scans').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return rows
      .filter((row) => row['projectId'] === id)
      .sort((a, b) => a['capturedAt'] - b['capturedAt'])
      .map((row) => ({
        sessionId: row['sessionId'],
        status: row['status'],
        scanFilename: row['scanFilename'] ?? null,
        calibrationMethod: row['calibration']?.method ?? null,
        calibrationStatus: row['calibration']?.status ?? null,
        calibrationCheckedBy: row['calibration']?.checkedBy ?? null,
      }))
  }, projectId)
}

/** The mock engine's frame-shift hook, from a script. */
async function jumpAt(page: Page, tick: number | null): Promise<void> {
  await page.evaluate((target) => (window as unknown as { XR8: { jumpAt(t: number | null): void } }).XR8.jumpAt(target), tick)
}

const button = (page: Page, action: string) => page.locator(`${BANNER} button[data-action="${action}"]`)

test.describe('one scan, one frame', () => {
  test.setTimeout(240_000)

  test('a shift after the calibration asks; Re-anchor ends the scan and calibrates the next one; Check drift measures the next shift', async ({ page, request }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const place = await createPlace(request, 'flow')
    try {
      const uploads = await captureUploads(page)
      // This calibration is the one that sets the Place's frame, so its floor has to lock, and the mock has to walk for that. Frozen
      // after that, where it is: the calibration's geometry is then exact, and nothing shifts until the script says so.
      await startArWithPlace(page, place.name, '')
      await reachLandmarkStageOnLockedFloor(page)
      await freezeInPlace(page)
      await placeBothMarkers(page)
      await expect(async () => {
        const saved = (await (await request.get('/projects')).json() as { projects?: Array<Record<string, any>> } | Array<Record<string, any>>) // eslint-disable-line @typescript-eslint/no-explicit-any
        const projects = Array.isArray(saved) ? saved : (saved.projects ?? [])
        expect(projects.find((p) => p['projectId'] === place.id)?.['spatialFrame']?.method).toBe('two-point-ground')
      }).toPass({ timeout: 20_000 })

      // Calibrated, recording, and nothing has happened: nothing is asked, and Check drift is on offer.
      await expect(page.locator(BANNER)).toBeHidden()
      await expect(page.locator(CHECK)).toBeVisible()

      // ── The runtime's frame shifts by a metre ──────────────────────────────────────────────────
      // From tick 0 on: the mock is frozen at whatever tick its walk had got to, so the shift is on at once.
      await jumpAt(page, 0)
      await expect(page.locator(BANNER)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator(`${BANNER} .reanchor-text`)).toHaveText('Tracking was interrupted. Parts of this scan may be shifted.')
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('Recording is paused until you choose.')
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('inherits their error')
      // The inherited error is put as an estimate, in the sentence the calibration card uses for the same points (`estimateSentence`,
      // src/world/frame-fit.ts), with the figure worked from the saved points.
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText(
        /Estimate: two scans would place a spot \d+(\.\d+)? m away up to about \d+(\.\d+)? cm apart \(95 of 100 times\)\./,
      )
      await expect(page.locator(`${BANNER} button`)).toHaveText(['Re-anchor here', 'Keep going'])
      await expect(button(page, 'reanchor')).toHaveAttribute('data-primary', 'true')
      await expect(page.locator(CHECK)).toBeHidden()
      // The HUD says so as well, and a scan that is held is not shown as ready, whatever it holds so far.
      await expect(page.locator('#verdict-hint')).toContainText('Recording paused', { timeout: 10_000 })
      await expect(page.locator('#verdict-chip')).not.toHaveText(/Ready/)
      // Nothing is added to the scan while the choice is open: a capture is turned away in words.
      await page.click('#capture-btn')
      await expect(page.locator('#status-text')).toContainText('Choose Re-anchor or Keep going first')

      // ── Re-anchor here ─────────────────────────────────────────────────────────────────────────
      await button(page, 'reanchor').click()
      await page.locator(CALIB).waitFor({ state: 'attached', timeout: 60_000 })
      // The calibration opened again as a return visit: it is measured against the Place's saved points.
      await expect(page.locator('#project-calibration-title')).toHaveText('Align this scan to the project')
      await expect(page.locator(BANNER)).toBeHidden()

      // The scan that ended was saved through the export it already has, with the sidecar a scan in one epoch should carry.
      expect(uploads).toHaveLength(1)
      expect(uploads[0]!['frameEpochs']).toMatchObject({ baseEpoch: 0, calibrationEpoch: 0, currentEpoch: 1, mixedEpochs: false, jumpCount: 1 })
      expect(uploads[0]!['calibrationMethod']).toBe('two-point-ground')
      expect(uploads[0]!['qualitySummary'].frameShifts, 'ended at the interruption: nothing was recorded after it').toBe(0)

      await reachLandmarkStage(page)
      await placeBothMarkers(page)
      // The second scan is calibrated in the epoch the runtime moved to, and is watched as the first was.
      await expect(page.locator(BANNER)).toBeHidden()
      await expect(page.locator(CHECK)).toBeVisible()
      await expect(async () => {
        const entries = await scanEntries(page, place.id)
        expect(entries, 'a second entry').toHaveLength(2)
        expect(new Set(entries.map((entry) => entry.sessionId)).size, 'with a session of its own').toBe(2)
        // The first scan compared nothing (it set the Place's pair), so it has no `checkedBy`.
        expect(entries[0]).toMatchObject({ status: 'ready', calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional', calibrationCheckedBy: null })
        expect(entries[0]!.scanFilename).toBeTruthy()
        // The second was measured against that pair, as a return visit is: `checkedBy` says so. It tapped two points against a pair
        // with no check point, which compares the spacing and nothing else, and a distance check is never `'verified'` (only a fit of
        // three or more points is: `verifyTwoPoint`, src/world/frame-fit.ts), so it is `'provisional'` with `checkedBy: 'separation'`.
        // Its floor check was bypassed too (a frozen mock cannot lock a floor), which caps a commit at `'provisional'` by itself
        // (`committedStatus`, src/ar/ground-gate.ts).
        expect(entries[1]).toMatchObject({ calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional', calibrationCheckedBy: 'separation' })
      }).toPass({ timeout: 15_000 })

      // ── Another shift, the other way: Keep going, then Check drift ─────────────────────────────
      await jumpAt(page, null)
      await expect(page.locator(BANNER)).toBeVisible({ timeout: 20_000 })
      await button(page, 'keep').click()
      await expect(page.locator(BANNER)).toBeHidden()
      // Kept through: the scan carries on, and stays marked for review.
      await expect(page.locator('#verdict-chip')).not.toHaveText(/Ready/, { timeout: 10_000 })
      await expect(page.locator('#verdict-hint')).toContainText('Tracking was interrupted: parts may be shifted', { timeout: 10_000 })

      await page.locator(CHECK).click()
      await expect(page.locator(`${BANNER} .reanchor-text`)).toHaveText('Tap the landmark again')
      await tapCanvas(page, LANDMARK_AT.x, LANDMARK_AT.y)
      await expect(page.locator(`${BANNER} .reanchor-text`)).toHaveText('Tap the heading marker', { timeout: 15_000 })
      await tapCanvas(page, HEADING_AT.x, HEADING_AT.y)
      // The shift was a metre along Z and no turn, and that is what the re-taps found.
      await expect(page.locator(`${BANNER} .reanchor-text`)).toContainText('Re-tap landed 1.0 m from the stored landmark, heading turned 0.0°', { timeout: 15_000 })
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText("Past the check's limit")
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('If you tapped the same spots, the frame has moved since you set it.')
      await expect(page.locator(`${BANNER} button`)).toHaveText(['Re-anchor here', 'Keep going'])

      // ── Re-anchor from the check: the second scan ends with the check in its sidecar ───────────
      await button(page, 'reanchor').click()
      await page.locator(CALIB).waitFor({ state: 'attached', timeout: 60_000 })
      expect(uploads).toHaveLength(2)
      const second = uploads[1]!
      expect(second['frameEpochs'].calibrationEpoch).toBe(1)
      expect(second['frameEpochs'].closures).toHaveLength(1)
      const closure = second['frameEpochs'].closures[0]
      expect(closure.translationM).toBeCloseTo(1, 2)
      expect(closure.yawDeg).toBeCloseTo(0, 1)
      expect(closure.points).toBe(2)
      expect(closure.exceeded).toBe(true)
      expect(closure.limits.basis).toBe('adopted, not measured')
      expect(closure.taps).toHaveLength(2)
      expect(second['qualitySummary'].status).toBe('needs-review')
      expect(second['qualitySummary'].recommendations).toContain('A drift check found a gap: parts may be shifted')

      // The person may continue without calibrating the next scan: it has none, so nothing is offered for it.
      await page.locator('#project-calibration-skip').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      await expect(page.locator(CHECK)).toBeHidden()
      await expect(page.locator(BANNER)).toBeHidden()
      expect(pageErrors, 'the page threw nothing').toEqual([])
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('?mockJumpAt: a shift while a return visit was being calibrated is put to the person once it is calibrated, and Keep going leaves the scan marked for review', async ({ page, request }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const place = await createPlace(request, 'mockjump')
    try {
      await storeFrame(request, place.id)
      // Frozen from its first frame, so the geometry of the calibration is exact; the script moves it once.
      await startArWithPlace(page, place.name, '&mockFreeze=300')
      await reachLandmarkStage(page)
      await expect(page.locator('#project-calibration-title')).toHaveText('Align this scan to the project')
      // The runtime's frame moves while the points are not yet placed, so the calibration began in the epoch before it.
      await jumpAt(page, 300)
      await page.waitForTimeout(3_000)
      // The floor under the new epoch may need a moment: the stage is waited for again, as at the start.
      await reachLandmarkStage(page)
      await placeBothMarkers(page)

      // The shift came between the start of the flow and its commit, so it counts against the calibration: asked at once. The
      // Place's saved points are older than this calibration, so a re-anchor is measured against something else.
      await expect(page.locator(BANNER)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator(`${BANNER} .reanchor-text`)).toHaveText('Tracking was interrupted. Parts of this scan may be shifted.')
      await expect(page.locator(`${BANNER} button`)).toHaveText(['Re-anchor here', 'Keep going'])
      await expect(page.locator(CHECK)).toBeHidden()

      await button(page, 'keep').click()
      await expect(page.locator(BANNER)).toBeHidden()
      await expect(page.locator(CHECK)).toBeVisible()
      await expect(page.locator('#verdict-chip')).not.toHaveText(/Ready/, { timeout: 10_000 })
      await expect(page.locator('#verdict-hint')).toContainText('Tracking was interrupted: parts may be shifted', { timeout: 10_000 })
      expect(pageErrors, 'the page threw nothing').toEqual([])
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('?mockJumpAt: a first calibration that ran across a shift set the Place\'s saved points itself, so no re-anchor is offered against them', async ({ page, request }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const place = await createPlace(request, 'mockjump-first')
    try {
      // The scripted camera is a metre further along Z from tick 75 (2.5 s in), while the ground is still being mapped.
      await startArWithPlace(page, place.name, '&mockJumpAt=75')
      // This calibration sets the Place's frame (it is what is asserted below), so its floor has to lock: a commit that bypassed the
      // floor check writes none. The shift starts the floor's fit again in the new epoch (src/scene/pointcloud.ts), so the lock comes
      // some seconds after it; the override is not pressed.
      await reachLandmarkStageOnLockedFloor(page)
      // A first calibration compares nothing, so the moving camera does not matter to its outcome. The two taps are the
      // pair every other test here places: inside the range a tap is read from (src/ar/tap-sampling.ts), which 0.86 was not.
      await holdStill(page)
      await placeBothMarkers(page)

      // The shift came between the start of the flow and its commit, and this calibration made the saved points: they may be
      // shifted, and a re-anchor would be measured against them. The person is told and nothing is held.
      await expect(page.locator('#status-text')).toContainText('Tracking was interrupted while the points were set', { timeout: 20_000 })
      await expect(page.locator(BANNER)).toBeHidden()
      await expect(page.locator(CHECK)).toBeVisible()
      await expect(page.locator('#verdict-chip')).not.toHaveText(/Ready/, { timeout: 10_000 })
      await expect(page.locator('#verdict-hint')).toContainText('Tracking was interrupted: parts may be shifted', { timeout: 10_000 })
      expect(pageErrors, 'the page threw nothing').toEqual([])
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('without a calibration nothing is asked and nothing is offered', async ({ page }) => {
    // "Skip for now" in the Place picker: no Place, so no calibration and no frame to have moved from.
    await page.goto('/?mock=xr8&mockJumpAt=90')
    await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
    await page.click('#start-ar-btn')
    await page.locator('#place-skip-btn').click()
    await expect(page.locator('#scan-stats')).toHaveText(/\d+ pts/, { timeout: 30_000 })
    // The shift happens (the verdict says so: tests/mock-frame-epoch.spec.ts), and the person is not asked.
    await expect(page.locator('#verdict-hint')).toHaveText(/Tracking was interrupted: parts may be shifted/, { timeout: 20_000 })
    await expect(page.locator(BANNER)).toBeHidden()
    await expect(page.locator(CHECK)).toBeHidden()
  })
})
