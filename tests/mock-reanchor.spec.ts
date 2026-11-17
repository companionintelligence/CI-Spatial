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

/** Advance past the environment-scan gate, with the explicit override the flow offers once the floor wait expires. */
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
 * Freeze the mock's scripted camera. A person holds the phone still while a tap is read, which is a burst of hits over about
 * half a second (src/ar/calibration-taps.ts); the mock's camera glides, and after a jump it is moving when the burst starts,
 * which the sampler reads as a hand that moved and refuses ('That spot did not read steadily'). Frozen, every frame of the
 * burst is the same. The frame shift the jump made has already been counted by then.
 */
async function holdStill(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8']!.freezeAt(300))
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
  const commit = page.locator('#project-calibration-commit')
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
      // Frozen from its first frame: the calibration's geometry is exact, and nothing shifts until the script says so.
      await startArWithPlace(page, place.name, '&mockFreeze=300')
      await reachLandmarkStage(page)
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
      await jumpAt(page, 300)
      await expect(page.locator(BANNER)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator(`${BANNER} .reanchor-text`)).toHaveText('Tracking was interrupted. Parts of this scan may be shifted.')
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('Recording is paused until you choose.')
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('inherits their error')
      await expect(page.locator(`${BANNER} .reanchor-detail`)).toContainText('(an estimate)')
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
        expect(entries[0]).toMatchObject({ status: 'ready', calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional' })
        expect(entries[0]!.scanFilename).toBeTruthy()
        expect(entries[1]).toMatchObject({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' })
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
      await reachLandmarkStage(page)
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
