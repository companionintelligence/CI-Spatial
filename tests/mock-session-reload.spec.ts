/**
 * A scan must survive a page reload.
 *
 * Regression: `DetectionStore.loadLatestSession()` existed and was called from
 * nowhere — a repo-wide search returned exactly one hit, its own definition.
 * Boot constructed a fresh store with a new `session-${Date.now()}` id and
 * moved on, so a reload dropped every pin from the panel and the 3D view, and
 * the only way back was opening the history drawer by hand.
 *
 * Restoring the detections is only half of it. The store also has to adopt the
 * restored session's *id*, or the next write lands under a fresh one and the
 * reload forks into a stale original plus a duplicate. These tests assert
 * against IndexedDB rather than the UI, because that fork is invisible on
 * screen — both records render the same until you look at what was stored.
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

async function bootComplete(page: Page): Promise<void> {
  await expect(page.locator('#start-ar-btn')).toBeEnabled({ timeout: 30_000 })
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

  test('detections come back after a reload', async ({ page }) => {
    await scanAndCapture(page)
    const before = await page.locator('#panel-toggle').getAttribute('data-count')

    await page.reload()
    await bootComplete(page)

    // The panel renders from the store at mount, so the count is back before
    // the user touches anything — no history-drawer archaeology required.
    await expect(page.locator('#panel-toggle')).toHaveAttribute('data-count', before ?? '')
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
  // Resume used to skip empty sessions, so clearing the current scan made the
  // next boot fall through to the previous one — handing back a scan the user
  // had just deliberately thrown away.
  await scanAndCapture(page)

  await page.click('#panel-toggle')
  await page.locator('#side-panel').waitFor({ state: 'visible', timeout: 10_000 })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.click('#panel-clear-session-btn')
  // Wait on the *persisted* state, not the panel: clear() notifies listeners
  // before awaiting its write, so the UI reads empty while the record on disk
  // is still the full one.
  await expect
    .poll(async () => (await storedSessions(page))[0]?.count ?? -1,
      { timeout: 15_000, message: 'clear() should have persisted an empty session' })
    .toBe(0)

  await page.reload()
  await bootComplete(page)

  // data-count is blank rather than "0" when the panel is empty, so compare
  // numerically — the point is that nothing came back, not how it is spelled.
  await expect
    .poll(async () => Number(await page.locator('#panel-toggle').getAttribute('data-count') ?? '0'),
      { timeout: 10_000, message: 'a cleared session must not resurrect an older scan' })
    .toBe(0)
})
