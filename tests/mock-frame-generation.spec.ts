/**
 * Replacing a Place's reference, in the scanner (WP-08), driven headlessly against the scripted XR8 mock: no device, camera or
 * SLAM binary, and a real Deno server for the Place and its frame.
 *
 * What it covers that the Node tests (tests/unit/node/wp-08c-*.test.ts) cannot: the pieces drawn in a real document and wired in
 * src/main.ts. A mismatch on a return visit offers "Replace this Place's reference" and not "Use anyway". Pressing it opens a
 * confirmation over the card that says how many scans were made against the reference, from the server's
 * `GET /projects/:id/frame-status`, and asks for a typed word while any are. The frame write that follows carries `replaces`
 * and a new `frameId`.
 *
 * `GET /projects/:id/frame-status` is built by the server slice of the same package, so it is answered here by the test, with the
 * body ADR 0009 gives it (`FrameStatus`), which the stand-in server of tests/unit/node/support/fake-frame-server.ts builds from
 * the scans a test gives it. The PUT to `/projects/:id/spatial-frame` goes on to the real server, which stores the frame it is sent.
 *
 * Not covered here:
 *  - "Wrong Place? Choose another". Its button is the return-visit package's (WP-07), so it is not on the card in a tree without
 *    that package; this package answers its `onWrongPlace` hook with the Place picker (src/ar/calibration-run.ts), which the Node
 *    tests drive with a scripted modal (wp-08c-replace-flow.test.ts).
 *  - "Improve this Place's reference". It is switched off until the first-calibration flow asks for a check point
 *    (FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT in src/world/frame-replacement.ts), so the button is not in this build; the Node
 *    tests drive it with the switch on.
 *
 * Run: npx playwright test --project=chromium-mock mock-frame-generation
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { ONBOARDING_KEY } from '../src/shared/storage-keys'
import type { Project, ProjectSpatialFrame } from '../src/world/types'
import { FakeFrameServer, twoPointScan, type ScanFacts } from './unit/node/support/fake-frame-server'

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

// The page's own requests are what these tests read and answer, and a service worker sends its fetches past page.route.
test.use({ serviceWorkers: 'block' })

async function createPlace(request: APIRequestContext, label: string): Promise<{ id: string; name: string }> {
  const name = `zz-gen-${label}-${Date.now()}`
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
 * Give a Place a stored two-point frame over the API, as though another device had calibrated it, with the id the editor will
 * tell its scans apart by. 6 m, which the mock's frozen 3.04 m pair cannot match: every return visit meets the mismatch screen.
 */
async function storeReference(request: APIRequestContext, id: string, frameId: string | null): Promise<void> {
  const current = await (await request.get(`/projects/${id}`)).json()
  const res = await request.put(`/projects/${id}`, {
    data: {
      ...current,
      spatialFrame: {
        version: 1,
        createdAt: new Date().toISOString(),
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 6 },
        separationM: 6,
        toleranceM: 0.15,
        anchorBearingDeg: null,
        ...(frameId ? { frameId } : {}),
      },
    },
  })
  expect(res.ok(), `PUT /projects/${id} failed: ${res.status()}`).toBeTruthy()
}

async function readPlace(request: APIRequestContext, id: string): Promise<Project | undefined> {
  const after = await (await request.get('/projects')).json() as Project[] | { projects: Project[] }
  return (Array.isArray(after) ? after : after.projects).find((p) => p.projectId === id)
}

/** What the server slice answers for a Place whose reference is `frame` and which has `scans`: ADR 0009's `FrameStatus`. */
function statusBody(projectId: string, frame: ProjectSpatialFrame | undefined, scans: ScanFacts[]) {
  return new FakeFrameServer({ projectId, frame: frame ?? null, revision: frame ? 1 : 0, scans }).statusBody()
}

/** Answer frame-status for one Place. `answer` is called per request, so a test can count them. */
async function answerFrameStatus(page: Page, projectId: string, answer: () => { status: number; body: unknown }): Promise<{ requests: () => number }> {
  let count = 0
  await page.route(`**/projects/${projectId}/frame-status`, (route) => {
    count += 1
    const { status, body } = answer()
    return route.fulfill({ status, json: body })
  })
  return { requests: () => count }
}

/** The bodies of every frame write the page sends, which then go on to the real server. */
async function recordFrameWrites(page: Page): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/projects/*/spatial-frame', (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.continue()
  })
  return bodies
}

async function openScanner(page: Page, query = ''): Promise<void> {
  await page.goto(`/?mock=xr8${query}`)
  await page.locator('#start-ar-btn').waitFor({ state: 'attached', timeout: 30_000 })
  await page.waitForFunction(
    () => !(document.getElementById('start-ar-btn') as HTMLButtonElement | null)?.disabled,
    null,
    { timeout: 30_000 },
  )
  await page.click('#start-ar-btn')
}

/** In the Place sheet: pick `placeName` from the nearby list and go on with it. */
async function chooseInSheet(page: Page, placeName: string): Promise<void> {
  await page.locator('#place-nearby-btn').click()
  await expect(async () => {
    const picked = await page.evaluate((wanted) => {
      const row = Array.from(document.querySelectorAll('#place-nearby-list button'))
        .find((el) => (el.textContent ?? '').includes(wanted))
      if (!row) return false
      ;(row as HTMLElement).click()
      return true
    }, placeName)
    expect(picked, `nearby list has no row for ${placeName}`).toBeTruthy()
  }).toPass({ timeout: 20_000 })
  await page.locator('#place-continue-btn').click()
}

async function startArWithPlace(page: Page, placeName: string): Promise<void> {
  await openScanner(page)
  await chooseInSheet(page, placeName)
  await page.locator(CALIB).waitFor({ state: 'attached', timeout: 30_000 })
}

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

async function tapCanvas(page: Page, nx: number, ny: number): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('no AR canvas')
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny)
  await page.waitForTimeout(800)
}

/** Freeze the mock's pose, then place both markers 3.04 m apart and commit: a return visit to a 6 m reference lands on the mismatch screen. */
async function placePairAndCommit(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Record<string, { freezeAt(n: number): number }>)['XR8'].freezeAt(300))
  await tapCanvas(page, 0.10, 0.92)
  await expect(page.locator('#project-calibration-confirm')).toBeVisible()
  await page.locator('#project-calibration-confirm').click()
  await tapCanvas(page, 0.86, 0.92)
  const commit = page.locator('#project-calibration-commit')
  await expect(commit).toBeEnabled()
  await commit.click()
}

async function reachMismatch(page: Page): Promise<void> {
  await reachLandmarkStage(page)
  await placePairAndCommit(page)
  await expect(page.locator('#project-calibration-title')).toHaveText(/do not match/i)
}

test.describe('replacing a Place\'s reference', () => {
  test.setTimeout(180_000)

  test('the way out of a mismatch is "Replace this Place\'s reference", which says how many scans use it, asks for a word, and sends what it replaces', async ({ page, request }) => {
    const place = await createPlace(request, 'replace')
    try {
      await storeReference(request, place.id, 'frame-held-1')
      const stored = (await readPlace(request, place.id))!.spatialFrame!
      const status = await answerFrameStatus(page, place.id, () => ({
        status: 200,
        body: statusBody(place.id, stored, [twoPointScan('frame-held-1'), twoPointScan('frame-held-1'), twoPointScan('frame-held-1'), twoPointScan()]),
      }))
      const writes = await recordFrameWrites(page)

      await startArWithPlace(page, place.name)
      await reachMismatch(page)

      // The way to keep the pair, in the words the work package asks for. "Use anyway" is gone.
      const override = page.locator('#project-calibration-override')
      await expect(override).toBeVisible()
      await expect(override).toHaveText("Replace this Place's reference")
      await expect(page.locator('#project-calibration-improve')).toBeHidden()
      await expect(page.locator(CALIB)).not.toContainText('Use anyway')

      await override.click()
      const dialog = page.locator('[role=alertdialog]')
      await expect(dialog).toBeVisible()
      await expect(page.locator('#frame-replace-title')).toHaveText("Replace this Place's reference?")
      await expect(page.locator('#frame-replace-reason')).toHaveText(/^The points you placed are \d+ cm closer together than the recorded pair\.$/)
      // The count is the one the server gave for the reference the Place holds, and no scan is called previous that cannot be.
      await expect(page.locator('#frame-replace-scans')).toHaveText(
        '3 scans in this Place were made against it. They stay in the Place, listed as previous reference, and are not moved to match the new one.',
      )
      expect(status.requests()).toBe(1)
      // The modal's own card is put away while the question is open: its title is in that card, and the mismatch screen's buttons are
      // hidden on that screen anyway, so only the card's own title says the card itself is not showing.
      await expect(page.locator('#project-calibration-title')).toBeHidden()

      // Scans are tied to it, so a word has to be typed.
      const confirm = page.locator('#frame-replace-confirm')
      await expect(page.locator('#frame-replace-typed-label')).toHaveText('Type replace to confirm.')
      await expect(confirm).toBeDisabled()
      await page.locator('#frame-replace-typed').fill('nope')
      await expect(confirm).toBeDisabled()
      expect(writes, 'nothing is written before the question is answered').toEqual([])
      await page.locator('#frame-replace-typed').fill(' Replace ')
      await expect(confirm).toBeEnabled()
      await confirm.click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // The write names the frame it replaces and why, and the new frame is a new generation.
      await expect.poll(() => writes.length, { message: 'the page sent the frame' }).toBe(1)
      const body = writes[0]!
      expect(body['replaces']).toEqual({ frameId: 'frame-held-1', reason: 'override' })
      expect(body['expectedRevision']).toBe(1)
      const sent = body['frame'] as { frameId?: string; method: string; separationM: number }
      expect(sent.method).toBe('two-point-ground')
      expect(typeof sent.frameId).toBe('string')
      expect(sent.frameId).not.toBe('frame-held-1')
      expect(sent.separationM).toBeGreaterThanOrEqual(1)
      expect(sent.separationM, 'the pair that was kept, not the one it replaced').toBeLessThan(5)

      // The server kept what it was sent, id included.
      await expect(async () => {
        const saved = (await readPlace(request, place.id))?.spatialFrame
        expect(saved?.method === 'two-point-ground' && saved.frameId).toBe(sent.frameId)
      }).toPass({ timeout: 15_000 })
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a reference no scan is tied to is replaced without a typed word', async ({ page, request }) => {
    const place = await createPlace(request, 'noscans')
    try {
      await storeReference(request, place.id, null)
      const stored = (await readPlace(request, place.id))!.spatialFrame!
      // Scans that are not in a Place frame, and one that names another generation, are not tied to this reference.
      const elsewhere: ScanFacts[] = [{ calibrationStatus: 'uncalibrated' }, { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, twoPointScan('frame-other')]
      await answerFrameStatus(page, place.id, () => ({ status: 200, body: statusBody(place.id, stored, elsewhere) }))
      const writes = await recordFrameWrites(page)

      await startArWithPlace(page, place.name)
      await reachMismatch(page)
      await page.locator('#project-calibration-override').click()

      await expect(page.locator('#frame-replace-scans')).toHaveText('No uploaded scan in this Place was made against it.')
      await expect(page.locator('#frame-replace-typed-field')).toBeHidden()
      await page.locator('#frame-replace-confirm').click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // A legacy frame has no id to name: the write says so, and does not leave the field off.
      await expect.poll(() => writes.length).toBe(1)
      expect(writes[0]!['replaces']).toEqual({ frameId: null, reason: 'override' })
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a reference with no id, which is every Place that exists today, counts the scans that name none, from the field the server counts them in', async ({ page, request }) => {
    const place = await createPlace(request, 'legacy')
    try {
      await storeReference(request, place.id, null)
      const stored = (await readPlace(request, place.id))!.spatialFrame!
      const body = statusBody(place.id, stored, [twoPointScan(), twoPointScan(), twoPointScan('frame-aaa'), { calibrationStatus: 'uncalibrated' }])
      // The server's own account: none of them is under a frame id, and what a replacement leaves is the two that name none.
      expect(body['scansByFrame']).toEqual({ 'frame-aaa': 1 })
      expect(body['unrecordedScans']).toBe(2)
      expect(body['scansOnCurrentFrame']).toBe(2)
      await answerFrameStatus(page, place.id, () => ({ status: 200, body }))
      const writes = await recordFrameWrites(page)

      await startArWithPlace(page, place.name)
      await reachMismatch(page)
      await page.locator('#project-calibration-override').click()

      await expect(page.locator('#frame-replace-scans')).toHaveText(
        '2 scans in this Place do not say which reference they were made against. They stay as they are and are not moved to match the new one.',
      )
      await expect(page.locator('#frame-replace-typed-field'), 'scans are tied to it, so the word is asked for').toBeVisible()
      await expect(page.locator('#frame-replace-confirm')).toBeDisabled()
      await page.locator('#frame-replace-typed').fill('replace')
      await page.locator('#frame-replace-confirm').click()
      await expect(page.locator(CALIB)).toHaveCount(0)
      await expect.poll(() => writes.length).toBe(1)
      expect(writes[0]!['replaces'], 'a frame with no id is named by null').toEqual({ frameId: null, reason: 'override' })
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('a count that cannot be read is not "no scans": the card says so and still asks for the word; cancelling keeps the saved reference', async ({ page, request }) => {
    const place = await createPlace(request, 'nocount')
    try {
      await storeReference(request, place.id, 'frame-held-2')
      // An older server has no such route.
      await answerFrameStatus(page, place.id, () => ({ status: 404, body: { error: 'Not found' } }))
      const writes = await recordFrameWrites(page)

      await startArWithPlace(page, place.name)
      await reachMismatch(page)
      await page.locator('#project-calibration-override').click()

      await expect(page.locator('#frame-replace-scans')).toHaveText(
        'Could not check which scans were made against it. Any that were stay in this Place and are not moved to match the new one.',
      )
      await expect(page.locator('#frame-replace-typed-field')).toBeVisible()
      await expect(page.locator('#frame-replace-confirm')).toBeDisabled()

      await page.locator('#frame-replace-cancel').click()
      // The mismatch card is back, nothing was committed, and the Place keeps its reference.
      await expect(page.locator('#frame-replace-title')).toHaveCount(0)
      await expect(page.locator('#project-calibration-title')).toHaveText(/do not match/i)
      await expect(page.locator('#project-calibration-override')).toBeVisible()
      // Focus is back on the button that asked, and not left on the page body where it falls when the question is removed.
      await expect(page.locator('#project-calibration-override')).toBeFocused()
      expect(writes).toEqual([])
      const kept = (await readPlace(request, place.id))?.spatialFrame
      expect(kept?.method === 'two-point-ground' && kept.frameId).toBe('frame-held-2')
    } finally {
      await deletePlace(request, place.id)
    }
  })

  test('on a phone with no connection the card says where the new reference goes, and the replacement waits on the phone with what it replaces', async ({ page, context, request }) => {
    const place = await createPlace(request, 'offline')
    try {
      await storeReference(request, place.id, 'frame-held-3')
      await startArWithPlace(page, place.name)
      await reachLandmarkStage(page)
      await context.setOffline(true)
      await placePairAndCommit(page)
      await expect(page.locator('#project-calibration-title')).toHaveText(/do not match/i)
      await page.locator('#project-calibration-override').click()

      // Offline, the count cannot be had, and the card says both things.
      await expect(page.locator('#frame-replace-offline')).toHaveText('No connection. The new reference is kept on this phone and sent when it is back online.')
      await expect(page.locator('#frame-replace-scans')).toContainText('Could not check which scans were made against it.')
      await page.locator('#frame-replace-typed').fill('replace')
      await page.locator('#frame-replace-confirm').click()
      await expect(page.locator(CALIB)).toHaveCount(0)

      // The replacement waits as the page's own row, which says what it replaces.
      const waiting = await page.evaluate(async (projectId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('ci-xr-projects')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const row = await new Promise<{ replaces?: unknown; syncState?: string; expectedRevision?: number } | null>((resolve, reject) => {
          const req = db.transaction('pendingFrame', 'readonly').objectStore('pendingFrame').get(projectId)
          req.onsuccess = () => resolve((req.result ?? null) as { replaces?: unknown; syncState?: string; expectedRevision?: number } | null)
          req.onerror = () => reject(req.error)
        })
        db.close()
        return row
      }, place.id)
      expect(waiting?.replaces).toEqual({ frameId: 'frame-held-3', reason: 'override' })
      expect(waiting?.expectedRevision).toBe(1)
      const unchanged = (await readPlace(request, place.id))?.spatialFrame
      expect(unchanged?.method === 'two-point-ground' && unchanged.frameId, 'the server still holds the reference that was replaced').toBe('frame-held-3')
    } finally {
      await context.setOffline(false)
      await deletePlace(request, place.id)
    }
  })
})
