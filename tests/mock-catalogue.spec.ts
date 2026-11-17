/**
 * Desktop catalogue on a mocked world: the Things tab and the Items tree.
 *
 * The world holds three Things seen across two scans, and one of them is already
 * relabelled. The spec types into the search box, picks a label and a scan,
 * relabels one row and clears another, then checks the rows that show and the
 * bodies posted to the patch endpoint.
 *
 * Every /worlds and /scans response is mocked. This covers the client only: a
 * real multi-scan place on a real scan set is not exercised here.
 *
 * Run: npx playwright test --project=chromium-mock mock-catalogue
 */
import { test, expect, type Page } from '@playwright/test'

const SLUG = 'default'
const WORLD_ID = 'world-catalogue'
const ORIGIN = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function scan(scanId: string, name: string, capturedAt: string) {
  return {
    scanId,
    projectId: 'proj-default',
    sessionId: `sess-${scanId}`,
    filename: `${scanId}.glb`,
    name,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: ORIGIN,
    localToWorld: IDENTITY,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt,
    pointCount: null,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
  }
}

function thing(thingId: string, label: string, observationIds: string[], firstSeen: string, lastSeen: string) {
  return {
    thingId,
    worldId: WORLD_ID,
    canonicalLabel: label,
    representativeTargetId: `${firstSeen}/${label}`,
    position: { x: 0, y: 0, z: 0 },
    firstSeenScanId: firstSeen,
    lastSeenScanId: lastSeen,
    observationIds,
    createdAt: '',
    updatedAt: '',
    origin: 'matcher',
  }
}

function observation(observationId: string, thingId: string, scanId: string, label: string, x: number, confidence: number) {
  return {
    observationId,
    thingId,
    scanId,
    sessionId: `sess-${scanId}`,
    targetId: `${scanId}/${label}`,
    label,
    canonicalLabel: label,
    confidence,
    worldPos: { x, y: 0.5, z: -1 },
    observedAt: null,
    origin: 'matcher',
  }
}

/** Three Things across two scans. The lamp already carries a user label from an earlier save. */
function initialWorld() {
  return {
    worldId: WORLD_ID,
    name: 'Catalogue test place',
    shareSlug: SLUG,
    projectId: 'proj-default',
    originGeoPose: ORIGIN,
    localFrame: { type: 'ENU_Y_UP', origin: ORIGIN, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [
      scan('scan-a', 'Living room', '2026-11-01T10:00:00.000Z'),
      scan('scan-b', 'Kitchen', '2026-11-02T10:00:00.000Z'),
    ],
    things: [
      thing('thing-chair', 'chair', ['obs-chair-a', 'obs-chair-b'], 'scan-a', 'scan-b'),
      thing('thing-lamp', 'lamp', ['obs-lamp-a'], 'scan-a', 'scan-a'),
      thing('thing-table', 'table', ['obs-table-b'], 'scan-b', 'scan-b'),
    ],
    thingObservations: [
      observation('obs-chair-a', 'thing-chair', 'scan-a', 'chair', 1, 0.91),
      observation('obs-chair-b', 'thing-chair', 'scan-b', 'chair', 1.2, 0.84),
      observation('obs-lamp-a', 'thing-lamp', 'scan-a', 'lamp', -2, 0.77),
      observation('obs-table-b', 'thing-table', 'scan-b', 'table', 0, 0.9),
    ],
    members: [],
    comments: [],
    jobs: [],
    editPatches: [{
      patchId: 'patch-seed-lamp',
      worldId: WORLD_ID,
      scanId: 'scan-a',
      targetId: 'thing-lamp',
      scope: 'thing',
      label: 'floor lamp',
      originTargetId: 'scan-a/lamp',
      actorId: 'local-editor',
      createdAt: '2026-11-03T09:00:00.000Z',
    }],
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-03T09:00:00.000Z',
  }
}

/**
 * Mock the world API. The patch endpoint keeps what was posted the way the
 * server does (an explicit null label stays null) and answers with the world,
 * so the page re-reads the same state the server would hold.
 */
async function mockCatalogueApi(page: Page, posts: Array<Record<string, unknown>>): Promise<void> {
  const world = initialWorld()
  // Typed loosely: the posted bodies are what the spec checks, not a patch schema.
  const editPatches: Array<Record<string, unknown>> = world.editPatches
  await page.route('**/worlds/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === `/worlds/${SLUG}` && request.method() === 'GET') {
      return route.fulfill({ json: world })
    }
    if (path === `/worlds/${SLUG}/patches` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      posts.push(body)
      const patch = {
        patchId: `patch-posted-${posts.length}`,
        worldId: WORLD_ID,
        scanId: body['scanId'],
        targetId: body['targetId'],
        scope: body['scope'],
        label: body['label'],
        originTargetId: body['originTargetId'],
        actorId: 'local-editor',
        createdAt: new Date().toISOString(),
      }
      editPatches.push(patch)
      return route.fulfill({ json: { ok: true, patch, world } })
    }
    if (path === `/worlds/${SLUG}/patches`) {
      return route.fulfill({ json: editPatches })
    }
    if (path === `/worlds/${SLUG}/share`) {
      return route.fulfill({ json: { worldId: WORLD_ID, shareSlug: SLUG, links: [] } })
    }
    // Jobs, comments and anything else the viewer polls: an empty list is a valid answer.
    return route.fulfill({ json: [] })
  })
  await page.route('**/scans/**', (route) => route.fulfill({ status: 404, json: { error: 'not in this mock' } }))
  await page.route('**/projects', (route) => route.fulfill({ json: [] }))
  await page.route('**/project-locations', (route) => route.fulfill({ json: [] }))
  await page.route('**/authenticate/whoami', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
}

test.describe('catalogue on a mocked world', () => {
  test.setTimeout(90_000)
  // The viewer registers /sw.js, and a service worker sends the patch POST past page.route,
  // so the mock would never see it. Block the worker, as the other mock specs do.
  test.use({ serviceWorkers: 'block' })

  test('search, label and scan filters, then relabel and clear, reach the rows and the patch bodies', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = []
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await mockCatalogueApi(page, posts)

    await page.goto('/viewer.html?world=default')
    await page.locator('.sidebar-tab[data-tab="things"]').click()

    const rowLabels = () => page.locator('#things-list .things-list-item strong').allTextContents()
    const summary = page.locator('#things-panel-summary')
    const row = (label: string) => page.locator('#things-list .things-list-row')
      .filter({ has: page.locator('.things-list-item strong', { hasText: new RegExp(`^${label}$`) }) })

    // Three rows, each showing its own label: the relabelled lamp shows "floor lamp", not its AI label.
    // The first render waits on a cold Vite compile of the viewer, so it gets the boot budget.
    await expect.poll(rowLabels, { timeout: 30_000 }).toEqual(['chair', 'floor lamp', 'table'])
    await expect(summary).toHaveText('3 identified things in the visible scan range.')
    await expect(row('floor lamp').locator('.things-list-item span')).toContainText('AI label: lamp')

    // Search reads the label the user set and the AI label, so "lamp" finds the relabelled lamp.
    await page.fill('#catalogue-search', 'lamp')
    await expect.poll(rowLabels).toEqual(['floor lamp'])
    await expect(summary).toHaveText('1 of 3 identified things match these filters.')
    await page.fill('#catalogue-search', 'zzz')
    await expect.poll(rowLabels).toEqual([])
    await expect(page.locator('.catalogue-empty')).toBeVisible()
    await page.fill('#catalogue-search', '')
    await expect.poll(rowLabels).toEqual(['chair', 'floor lamp', 'table'])

    // The label filter offers display labels only, and picks one row.
    const labelOptions = await page.locator('#catalogue-label-filter option').allTextContents()
    expect(labelOptions).toEqual(['All labels', 'chair', 'floor lamp', 'table'])
    await page.selectOption('#catalogue-label-filter', 'table')
    await expect.poll(rowLabels).toEqual(['table'])
    await page.selectOption('#catalogue-label-filter', '')

    // The scan filter keeps the things seen in that scan. The chair is seen in both scans.
    await page.selectOption('#catalogue-scan-filter', 'scan-b')
    await expect.poll(rowLabels).toEqual(['chair', 'table'])
    await page.selectOption('#catalogue-scan-filter', '')
    await expect.poll(rowLabels).toHaveLength(3)

    // The Items tree follows the filters while the Things tab is open...
    await page.fill('#catalogue-search', 'table')
    await expect.poll(() => page.locator('#items-list .scene-tree-thing > span').allTextContents()).toEqual(['table'])
    await page.fill('#catalogue-search', '')
    // ...and shows everything again on the Scans tab, where the controls are not.
    await page.fill('#catalogue-search', 'table')
    await page.locator('.sidebar-tab[data-tab="scans"]').click()
    await expect(page.locator('#items-list')).toContainText('floor lamp')
    await page.locator('.sidebar-tab[data-tab="things"]').click()
    await page.fill('#catalogue-search', '')

    // Relabel the chair from its own row. The save is a thing patch, and the row shows the new label.
    await row('chair').locator('.catalogue-relabel-input').fill('armchair')
    await row('chair').locator('.catalogue-relabel-save').click()
    await expect.poll(rowLabels).toEqual(['armchair', 'floor lamp', 'table'])
    await expect(row('armchair').locator('.things-list-item span')).toContainText('AI label: chair')
    expect(posts[0]).toEqual({
      scope: 'thing',
      targetId: 'thing-chair',
      scanId: 'scan-a',
      originTargetId: 'scan-a/chair',
      label: 'armchair',
    })

    // Clear the lamp's user label. The explicit null is posted, and the row goes back to the AI label.
    await row('floor lamp').locator('.catalogue-relabel-clear').click()
    await expect.poll(rowLabels).toEqual(['armchair', 'lamp', 'table'])
    await expect(row('lamp').locator('.catalogue-relabel-clear')).toBeDisabled()
    expect(posts[1]).toEqual({
      scope: 'thing',
      targetId: 'thing-lamp',
      scanId: 'scan-a',
      originTargetId: 'scan-a/lamp',
      label: null,
    })
    expect(posts).toHaveLength(2)
    await expect(page.locator('#items-list')).toContainText('armchair')

    // This mock has no GLB files, so the viewer's own load of each scan fails with a 404. That
    // failure is expected. Anything else thrown on the page is a regression.
    const unexpected = pageErrors.filter(error => !/\/scans\/scan-[ab]\.glb/.test(error))
    expect(unexpected).toEqual([])
  })
})
