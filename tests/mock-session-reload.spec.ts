/**
 * A scan's record must survive a page reload, and what it holds must not be taken for the new page's.
 *
 * Regression: `DetectionStore.loadLatestSession()` existed and was called from
 * nowhere — a repo-wide search returned exactly one hit, its own definition.
 * Boot constructed a fresh store with a new `session-${Date.now()}` id and
 * moved on, so a reload dropped every pin and the only way back was opening
 * the history drawer by hand.
 *
 * Restoring the detections is only half of it. The store also has to adopt the
 * restored session's *id*, or the next write lands under a fresh one and the
 * reload forks into a stale original plus a duplicate. These tests assert
 * against IndexedDB rather than the UI, because that fork is invisible on
 * screen — both records render the same until you look at what was stored.
 *
 * The other half (WP-02). A position is only meaningful in the SLAM frame that
 * produced it, and a reload starts a new frame. Resuming used to put the old
 * detections straight into the new scan: the pins sat at wrong places and the
 * next autosave exported them under the new run's calibration. Now the record
 * is resumed as before and each detection keeps the id of the AR run that
 * placed it (`arRunId`); the panel, the pins and every export read only the
 * detections of the run this page started, and the earlier run's stay in the
 * history drawer, labelled. So "the count comes back after a reload" is no
 * longer true, on purpose, and the tests below say what is true instead.
 *
 * Run: npx playwright test --project=chromium-mock mock-session-reload
 */
import { test, expect, type Page } from '@playwright/test'
import { startArScan } from './support/start-scan'
import { requireUsableInferenceEngine } from './support/inference-engine'

// The database name is load-bearing and deliberately not renameable — see the
// "Do not rename" table in CLAUDE.md. Reading it here doubles as a check that
// it hasn't drifted.
const DB_NAME = 'ci-xr-scan'

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

/** Everything IndexedDB holds, straight from the source of truth. */
async function storedSessions(page: Page): Promise<Array<{ sessionId: string; count: number }>> {
  return await page.evaluate((dbName) => new Promise<Array<{ sessionId: string; count: number }>>((resolve) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => resolve([])
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) return resolve([])
      const all = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
      all.onerror = () => resolve([])
      all.onsuccess = () => resolve(
        (all.result as Array<{ sessionId: string; detections: unknown[] }>)
          .map((r) => ({ sessionId: r.sessionId, count: r.detections.length })),
      )
    }
  }), DB_NAME)
}

/**
 * Write a session row the way an earlier build wrote it: one detection, and no AR run on it. Its start time is
 * 1, so any session this page writes afterwards is the newer one.
 */
async function seedOlderSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(({ dbName, id }) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put({
        sessionId: id,
        startedAt: 1,
        detections: [['sofa:0.0,0.0,0.0', {
          label: 'sofa',
          confidence: 0.9,
          description: 'an old sofa',
          bbox: [0, 0, 1, 1],
          worldPos: { x: 0, y: 0, z: 0 },
          worldRot: { x: 0, y: 0, z: 0, w: 1 },
          captureTimestamp: 1,
        }]],
      })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), { dbName: DB_NAME, id: sessionId })
}

async function bootComplete(page: Page): Promise<void> {
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
}

/** The window property the upload recorder below writes to, so the spec can read it back. */
interface RecordedUploads {
  __uploadMetadata?: string[]
}

/**
 * Record the `metadata` field of every scan upload the page makes, on every page load.
 *
 * Wraps `fetch` in the page rather than reading the request in Playwright: an upload is multipart with a GLB
 * in it, and the request's body is not reliably readable from outside for a form that carries a Blob. The
 * wrapper sees the FormData before it is sent, and passes the call on untouched.
 */
async function recordUploadMetadata(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: string[] = []
    ;(window as unknown as RecordedUploads).__uploadMetadata = recorded
    const send = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (target.includes('/upload-scan') && init?.body instanceof FormData) {
        const metadata = init.body.get('metadata')
        if (typeof metadata === 'string') recorded.push(metadata)
      }
      return send(input, init)
    }
  })
}

/** `detectionCount` of each scan upload this page load has made, oldest first. */
async function uploadedDetectionCounts(page: Page): Promise<number[]> {
  const recorded = await page.evaluate(() => (window as unknown as RecordedUploads).__uploadMetadata ?? [])
  return recorded.map((metadata) => Number((JSON.parse(metadata) as { detectionCount?: number }).detectionCount ?? -1))
}

/** Scan until at least one detection has landed in the store. */
async function scanAndCapture(page: Page): Promise<void> {
  // The poll below waits 45 s for a detection that a server with no vision
  // engine can never produce. Say so in a second instead. See ./support/inference-engine.
  await requireUsableInferenceEngine()
  await startArScan(page)
  await page.waitForTimeout(1_500)   // let tracking reach NORMAL before capturing
  await page.click('#capture-btn')

  await expect
    .poll(async () => Number(await page.locator('#panel-toggle').getAttribute('data-count') ?? '0'),
      { timeout: 45_000, message: 'expected a detection to reach the store' })
    .toBeGreaterThan(0)
}

test.describe('scan persistence across a reload', () => {
  test.setTimeout(120_000)

  test('objects from before a reload are kept in the history drawer, and are not shown or exportable', async ({ page }) => {
    await scanAndCapture(page)
    const [original] = await storedSessions(page)
    expect(original, 'a capture should have persisted a session').toBeTruthy()

    // A new page load is a new AR run.
    await startArScan(page)

    // The record is back, but none of it is in this run's view: nothing is counted and no pin is drawn.
    expect(await page.locator('#panel-toggle').getAttribute('data-count'), 'the panel counts this run only').toBe('')
    await expect(page.locator('.ar-pin-wrap'), 'an earlier run\'s object has no pin in this run\'s view').toHaveCount(0)
    await page.click('#panel-toggle')
    await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
    await expect(page.locator('#panel-export-glb-btn'), 'nothing of this run to export, so nothing is exported').toBeDisabled()
    await expect(page.locator('#panel-export-hint')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()

    // They are in the history drawer, and it says why they are not in the view.
    await page.click('#history-btn')
    const card = page.locator('#history-body [data-session-id]').first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator(':scope > div').first().click()
    await expect(page.locator('#history-body')).toContainText('previous run, different frame', { timeout: 10_000 })

    // Nothing was lost on the way: the same session still holds every detection it held.
    const [after] = await storedSessions(page)
    expect(after?.sessionId).toBe(original!.sessionId)
    expect(after?.count).toBe(original!.count)
  })

  test('a scan taken after a reload exports only what that scan found', async ({ page }) => {
    await recordUploadMetadata(page)

    await scanAndCapture(page)
    const [first] = await storedSessions(page)
    expect(first, 'a capture should have persisted a session').toBeTruthy()

    // The second run: a new page load, a new capture, in the same stored session.
    await scanAndCapture(page)
    const thisRun = Number(await page.locator('#panel-toggle').getAttribute('data-count') ?? '0')
    expect(thisRun).toBeGreaterThan(0)

    // The record holds both runs' objects: this run's merge did not touch, overwrite or absorb the earlier ones.
    await expect
      .poll(async () => (await storedSessions(page))[0]?.count ?? 0,
        { timeout: 15_000, message: 'the record should hold the earlier run\'s objects and this run\'s' })
      .toBe(first!.count + thisRun)

    // The upload (autosave runs a moment after a capture) describes this run's objects alone.
    await expect
      .poll(async () => (await uploadedDetectionCounts(page)).at(-1),
        { timeout: 30_000, message: 'the autosave upload should carry this run\'s detections only' })
      .toBe(thisRun)
  })

  test('a reload continues the session rather than forking it', async ({ page }) => {
    await scanAndCapture(page)
    const [original] = await storedSessions(page)
    expect(original, 'a capture should have persisted a session').toBeTruthy()

    await page.reload()
    await bootComplete(page)
    await page.reload()
    await bootComplete(page)

    const sessions = await storedSessions(page)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.sessionId, 'the resumed session must keep its id').toBe(original!.sessionId)
    expect(sessions[0]!.count, 'no detections lost on the way through').toBe(original!.count)
  })

  test('a page load that captures nothing stores no session', async ({ page }) => {
    // Boot used to persist an empty record on every load, so the history
    // drawer filled with "0 objects" rows that buried the real scans.
    await page.goto('/?mock=xr8')
    await bootComplete(page)
    await page.reload()
    await bootComplete(page)

    expect(await storedSessions(page)).toHaveLength(0)
  })
})

test('clearing a session does not resurrect an older scan on reload', async ({ page }) => {
  // Resume used to skip empty sessions, so clearing the current scan made the next boot fall through to the previous
  // one — handing back a scan the user had just deliberately thrown away. Nothing is drawn or counted after a reload
  // now, whichever session was resumed, so the badge cannot show it. What shows it is where the next capture lands:
  // in the cleared session when that is the one resumed, and in the older one when the resume fell through to it.
  test.setTimeout(120_000)
  await scanAndCapture(page)
  const [current] = await storedSessions(page)
  expect(current, 'a capture should have persisted a session').toBeTruthy()
  await seedOlderSession(page, 'local-older-scan')

  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.click('#panel-clear-session-btn')
  // Wait on the *persisted* state, not the panel: clear() notifies listeners
  // before awaiting its write, so the UI reads empty while the record on disk
  // is still the full one.
  await expect
    .poll(async () => (await storedSessions(page)).find((s) => s.sessionId === current!.sessionId)?.count ?? -1,
      { timeout: 15_000, message: 'clear() should have persisted an empty session' })
    .toBe(0)

  // The next page load resumes the cleared session, the newest, though it is empty. Its capture lands there.
  await scanAndCapture(page)
  await expect
    .poll(async () => (await storedSessions(page)).find((s) => s.sessionId === current!.sessionId)?.count ?? 0,
      { timeout: 15_000, message: 'the next scan should be written into the cleared session' })
    .toBeGreaterThan(0)
  const older = (await storedSessions(page)).find((s) => s.sessionId === 'local-older-scan')
  expect(older?.count, 'the older scan was neither resumed nor written to').toBe(1)
})
