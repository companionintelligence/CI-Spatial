/**
 * Which reference each scan was made against, in the World Editor (WP-08), on a mocked Place.
 *
 * Replacing a Place's reference moves nothing: the scans made against the old one stay where they were, on the same origin, and
 * look as coherent as the rest. So the editor has to say which scans they are. This drives the real editor against a mocked world
 * whose Place has replaced its reference twice, and reads what it draws:
 *
 *  - a chip on each scan row: "previous reference" for a scan that names another generation, or that has no id and was
 *    calibrated before the Place replaced a frame that had none; "not in Place frame" for an uncalibrated scan and a one-point one
 *    (owner decision D6); "frame not recorded", neutral, for a scan with no id that nothing dates; and nothing for a scan of the
 *    current reference;
 *  - a banner above the scan list that states the counts and when and why the reference was last replaced;
 *  - the Layers tab's "Previous reference" switch: on by default, it lists those scans apart under a heading and dims them in the
 *    scene; off, it puts both back. The scene is read through three.js's own devtools protocol, as tests/mock-anchor-layer.spec.ts
 *    reads it;
 *  - a Place with no reference has no frame to be in or out of, so none of it is drawn, and a Place with no scans shows none of the
 *    last Place's banner or layer when the editor is switched to it;
 *  - a reference replaced while the editor is open is picked up when the world refreshes.
 *
 * Every /worlds, /projects and /scans response is mocked, with a GLB that holds one triangle, so a scan has a material to dim.
 *
 * Run: npx playwright test --project=chromium-mock mock-frame-banner
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import type { FrameHistoryEntry, GeoPose, Project, ProjectSpatialFrame, ScanManifest, WorldProject } from '../src/world/types'

const SLUG = 'default'
const WORLD_ID = 'world-frame-banner'
const PROJECT_ID = 'proj-default'
const ORIGIN: GeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function scan(scanId: string, name: string, calibration: Partial<ScanManifest>): ScanManifest {
  return {
    scanId,
    projectId: PROJECT_ID,
    sessionId: `sess-${scanId}`,
    filename: `${scanId}.glb`,
    name,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: ORIGIN,
    localToWorld: IDENTITY,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: '2026-11-01T10:00:00.000Z',
    pointCount: null,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...calibration,
  }
}

const twoPoint = (extra: Partial<ScanManifest>): Partial<ScanManifest> => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'verified',
  calibrationSeparationM: 3,
  ...extra,
})

/**
 * Six scans, one per case the chips tell apart. The Place's current reference is `frame-now`; it replaced `frame-old` on
 * 2026-11-10, which had replaced a frame with no id on 2026-11-03.
 */
const SCANS: ScanManifest[] = [
  scan('scan-current', 'Current reference', twoPoint({ calibrationFrameId: 'frame-now', calibratedAt: '2026-11-14T10:00:00.000Z' })),
  scan('scan-previous', 'Before the replacement', twoPoint({ calibrationFrameId: 'frame-old', calibratedAt: '2026-11-05T10:00:00.000Z' })),
  scan('scan-before-ids', 'Made before ids existed', twoPoint({ calibratedAt: '2026-10-20T10:00:00.000Z' })),
  scan('scan-unrecorded', 'No id, nothing to date it', twoPoint({ calibratedAt: '2026-11-20T10:00:00.000Z' })),
  scan('scan-one-point', 'One point', { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }),
  scan('scan-uncalibrated', 'Uncalibrated', { calibrationStatus: 'uncalibrated' }),
]

const HISTORY: FrameHistoryEntry[] = [
  { frameId: null, createdAt: '2026-10-01T09:00:00.000Z', method: 'two-point-ground', separationM: 2.5, supersededAt: '2026-11-03T12:00:00.000Z', reason: 'upgrade' },
  { frameId: 'frame-old', createdAt: '2026-11-03T12:00:00.000Z', method: 'two-point-ground', separationM: 3, supersededAt: '2026-11-10T09:00:00.000Z', reason: 'override' },
]

function frame(frameId?: string): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 3 },
    separationM: 3,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...(frameId ? { frameId } : {}),
  }
}

const BARE_PROJECT: Project = { projectId: PROJECT_ID, name: 'Frame banner test place', createdAt: 0, updatedAt: 0, floors: [] }
const PROJECT: Project = { ...BARE_PROJECT, spatialFrame: frame('frame-now'), spatialFrameRevision: 3, frameHistory: HISTORY }

function worldOf(scans: ScanManifest[]): WorldProject {
  return {
    worldId: WORLD_ID,
    name: BARE_PROJECT.name,
    shareSlug: SLUG,
    projectId: PROJECT_ID,
    originGeoPose: ORIGIN,
    localFrame: { type: 'ENU_Y_UP', origin: ORIGIN, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans,
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches: [],
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
  }
}

/** A valid binary glTF whose scene is one triangle with the loader's default material: something a scan can be dimmed on. */
function triangleGlb(): Buffer {
  const positions = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4))
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }))
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + positions.length, 8)
  const jsonChunk = Buffer.alloc(8)
  jsonChunk.writeUInt32LE(paddedJson.length, 0)
  jsonChunk.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  const binChunk = Buffer.alloc(8)
  binChunk.writeUInt32LE(positions.length, 0)
  binChunk.writeUInt32LE(0x004e4942, 4) // 'BIN\0'
  return Buffer.concat([header, jsonChunk, paddedJson, binChunk, positions])
}

const EMPTY_PROJECT: Project = { projectId: 'proj-empty', name: 'A Place with no scans', createdAt: 0, updatedAt: 0, floors: [] }

type MockOptions = {
  /** What GET /projects answers with. A function, so a test can change the Place between two requests. */
  places?: () => Project[]
  /** Also answer for a second Place that has no scan, which the editor's Place switcher offers (`EMPTY_PROJECT`). */
  withEmptyPlace?: boolean
  /** Called for every GET /projects, so a test can tell that the editor has asked for the Places again. */
  onPlacesRequest?: () => void
  /** The world's scans. A function, so a test can add one between two requests. */
  scans?: () => ScanManifest[]
}

async function mockApi(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/worlds/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/worlds/${SLUG}` && route.request().method() === 'GET') return route.fulfill({ json: worldOf(options.scans?.() ?? SCANS) })
    return route.fulfill({ json: [] })
  })
  await page.route('**/scans/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.glb')) return route.fulfill({ body: triangleGlb(), contentType: 'model/gltf-binary' })
    return route.fulfill({ status: 404, json: { error: 'not in this mock' } })
  })
  await page.route('**/projects', (route) => {
    if (route.request().method() === 'GET') options.onPlacesRequest?.()
    return route.fulfill({ json: [...(options.places ?? (() => [PROJECT]))(), ...(options.withEmptyPlace ? [EMPTY_PROJECT] : [])] })
  })
  if (options.withEmptyPlace) {
    await page.route(`**/projects/${EMPTY_PROJECT.projectId}/world`, (route) => route.fulfill({ json: { ...worldOf([]), projectId: EMPTY_PROJECT.projectId, name: EMPTY_PROJECT.name } }))
  }
  await page.route('**/project-locations', (route) => route.fulfill({
    json: options.withEmptyPlace
      ? [PROJECT, EMPTY_PROJECT].map((place) => ({ projectId: place.projectId, name: place.name, lat: null, lng: null, address: null, capturedAt: null, scanCount: place.projectId === PROJECT_ID ? SCANS.length : 0 }))
      : [],
  }))
  await page.route('**/authenticate/whoami', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
}

async function mockEvents(page: Page): Promise<{ send: (message: object) => Promise<void> }> {
  const held: { socket: WebSocketRoute | null } = { socket: null }
  await page.routeWebSocket('**/events', (socket) => {
    held.socket = socket
  })
  return {
    async send(message) {
      await expect.poll(() => held.socket !== null, { message: 'the editor opened its /events socket' }).toBe(true)
      held.socket!.send(JSON.stringify(message))
    },
  }
}

/** Collect every Scene three.js constructs, through its devtools protocol. */
async function observeScenes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scenes: unknown[] = []
    const hook = new EventTarget()
    hook.addEventListener('observe', (event) => {
      const detail = (event as CustomEvent).detail as { isScene?: boolean } | null
      if (detail?.isScene) scenes.push(detail)
    })
    const w = window as unknown as Record<string, unknown>
    w['__THREE_DEVTOOLS__'] = hook
    w['__observedScenes'] = scenes
  })
}

/** The opacity of the first material under each scan's root in the live scene, by scan id. */
async function readOpacities(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    type Node3 = {
      name: string
      children: Node3[]
      userData: Record<string, unknown>
      material?: { opacity: number } | Array<{ opacity: number }>
      traverse(callback: (node: Node3) => void): void
    }
    const observed = (window as unknown as { __observedScenes?: Node3[] }).__observedScenes ?? []
    const scene = [...observed].reverse().find((s) => s.children.some((c) => c.name === 'World scan roots'))
    const found: Record<string, number> = {}
    if (!scene) return found
    const worldGroup = scene.children.find((c) => c.name === 'World scan roots')!
    for (const root of worldGroup.children) {
      const scanId = root.userData['scanId']
      if (typeof scanId !== 'string') continue
      root.traverse((node) => {
        if (scanId in found || !node.material) return
        const material = Array.isArray(node.material) ? node.material[0] : node.material
        if (material) found[scanId] = material.opacity
      })
    }
    return found
  })
}

async function openEditor(page: Page, pageErrors: string[], options: MockOptions = {}): Promise<void> {
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await observeScenes(page)
  await mockApi(page, options)
  await page.goto(`/viewer.html?world=${SLUG}`)
  await expect(page.locator('.scan-status', { hasText: /Ready/ })).toHaveCount((options.scans?.() ?? SCANS).length, { timeout: 60_000 })
}

/** What is in the scan list, top to bottom: a scan's id, or the heading's. */
const listed = (page: Page) =>
  page.locator('#scan-list > *').evaluateAll((children) => children.map((child) => (child as HTMLElement).dataset['scanId'] ?? child.id))

const row = (page: Page, scanId: string) => page.locator(`.scan-item[data-scan-id="${scanId}"]`)
const chipOf = (page: Page, scanId: string) => row(page, scanId).locator('.scan-frame-chip')

test.describe('which reference each scan was made against, in the editor', () => {
  test.setTimeout(120_000)
  // The viewer registers /sw.js, and a service worker sends fetches past page.route, so the mocks would never see them.
  test.use({ serviceWorkers: 'block' })

  test('each scan row says which reference it was made against, and the banner states the counts and the last replacement', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors)

    await expect(chipOf(page, 'scan-current')).toHaveCount(0)
    for (const scanId of ['scan-previous', 'scan-before-ids']) {
      await expect(chipOf(page, scanId), scanId).toHaveText('previous reference')
      await expect(chipOf(page, scanId), scanId).toHaveAttribute('data-kind', 'previous-reference')
    }
    // The one the Place's own record dates, and the one it names.
    await expect(chipOf(page, 'scan-before-ids')).toHaveAttribute('title', /replaced on 2026-11-03/)
    await expect(chipOf(page, 'scan-previous')).toHaveAttribute('title', /replaced on 2026-11-10/)
    for (const scanId of ['scan-one-point', 'scan-uncalibrated']) {
      await expect(chipOf(page, scanId), scanId).toHaveText('not in Place frame')
      await expect(chipOf(page, scanId), scanId).toHaveAttribute('data-kind', 'not-in-frame')
    }
    await expect(chipOf(page, 'scan-unrecorded')).toHaveText('frame not recorded')
    await expect(chipOf(page, 'scan-unrecorded')).toHaveAttribute('data-kind', 'not-recorded')
    await expect(chipOf(page, 'scan-unrecorded')).not.toHaveAttribute('title', /previous/)

    const banner = page.locator('#frame-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('2 scans were measured against a previous reference and may not line up with the current one.')
    await expect(banner).toContainText('The reference was last replaced on 2026-11-10 (UTC), after the points did not match.')
    await expect(banner).toContainText("2 scans are not in this Place's frame.")
    await expect(banner).toContainText('1 scan does not say which reference it was made against.')
    expect(pageErrors).toEqual([])
  })

  test('the Previous reference layer lists those scans apart under a heading and dims them, and one switch puts both back', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors)
    const previous = ['scan-previous', 'scan-before-ids']

    await page.locator('#tab-btn-layers').click()
    const toggle = page.locator('#frame-previous-toggle')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(page.locator('#frame-previous-status')).toHaveText('2 scans are from a previous reference.')

    // Listed apart: after every other scan, under a heading that counts them.
    await page.locator('#tab-btn-scans').click()
    const heading = page.locator('#scan-group-previous')
    await expect(heading).toHaveText('Previous reference (2)')
    const tops = async (scanIds: string[]) => Promise.all(scanIds.map(async (id) => (await row(page, id).boundingBox())!.y))
    const headingTop = (await heading.boundingBox())!.y
    const others = ['scan-current', 'scan-unrecorded', 'scan-one-point', 'scan-uncalibrated']
    for (const top of await tops(others)) expect(top, 'every other scan is above the heading').toBeLessThan(headingTop)
    for (const top of await tops(previous)) expect(top, 'and the previous-reference scans are below it').toBeGreaterThan(headingTop)
    for (const id of previous) await expect(row(page, id)).toHaveClass(/scan-previous-reference/)
    // The rows themselves are moved, so what a screen reader reads and the order the keyboard tabs in is the order on screen.
    expect(await listed(page)).toEqual(['scan-current', 'scan-unrecorded', 'scan-one-point', 'scan-uncalibrated', 'scan-group-previous', 'scan-previous', 'scan-before-ids'])
    await expect(heading).toHaveAttribute('role', 'heading')

    // Dimmed in the scene: half strength, and only those two.
    await expect.poll(() => readOpacities(page), { message: 'the previous-reference scans are see-through' }).toEqual({
      'scan-current': 1,
      'scan-previous': 0.5,
      'scan-before-ids': 0.5,
      'scan-unrecorded': 1,
      'scan-one-point': 1,
      'scan-uncalibrated': 1,
    })

    // One switch puts both back, and the list is in the order it was built in.
    await page.locator('#tab-btn-layers').click()
    await toggle.uncheck()
    await page.locator('#tab-btn-scans').click()
    await expect(heading).toHaveCount(0)
    for (const id of previous) await expect(row(page, id)).not.toHaveClass(/scan-previous-reference/)
    await expect.poll(() => readOpacities(page), { message: 'every scan is at full strength' }).toEqual({
      'scan-current': 1,
      'scan-previous': 1,
      'scan-before-ids': 1,
      'scan-unrecorded': 1,
      'scan-one-point': 1,
      'scan-uncalibrated': 1,
    })
    expect(await listed(page), 'the list is in the order it was built in').toEqual(SCANS.map((s) => s.scanId))
    // The chips are the words on the row, whether or not the layer is on.
    await expect(chipOf(page, 'scan-previous')).toHaveText('previous reference')

    await page.locator('#tab-btn-layers').click()
    await toggle.check()
    await expect.poll(async () => (await readOpacities(page))['scan-previous']).toBe(0.5)
    expect(pageErrors).toEqual([])
  })

  test('scans that arrive while the layer is on are listed in their place, and the list goes back to the order it was built in', async ({ page }) => {
    const pageErrors: string[] = []
    const scans = [...SCANS]
    const events = await mockEvents(page)
    await openEditor(page, pageErrors, { scans: () => scans })
    expect(await listed(page)).toEqual(['scan-current', 'scan-unrecorded', 'scan-one-point', 'scan-uncalibrated', 'scan-group-previous', 'scan-previous', 'scan-before-ids'])

    // A phone uploads two scans: one of the current reference and one still measured against the old one. The editor puts new
    // rows at the front of its list, one after another, and groups them again.
    scans.push(
      scan('scan-late', 'Late, current', twoPoint({ calibrationFrameId: 'frame-now', calibratedAt: '2026-11-21T10:00:00.000Z' })),
      scan('scan-late-old', 'Late, old reference', twoPoint({ calibrationFrameId: 'frame-old', calibratedAt: '2026-11-21T11:00:00.000Z' })),
    )
    await events.send({ type: 'scan-added', filename: 'late.glb', size: 4096 })
    await expect(row(page, 'scan-late-old')).toHaveCount(1)
    await expect(page.locator('#scan-group-previous')).toHaveText('Previous reference (3)')
    expect(await listed(page)).toEqual([
      'scan-late', 'scan-current', 'scan-unrecorded', 'scan-one-point', 'scan-uncalibrated',
      'scan-group-previous', 'scan-late-old', 'scan-previous', 'scan-before-ids',
    ])
    await expect(chipOf(page, 'scan-late-old')).toHaveText('previous reference')
    await expect(chipOf(page, 'scan-late')).toHaveCount(0)
    await expect.poll(async () => (await readOpacities(page))['scan-late-old'], { message: 'the new previous-reference scan is dimmed once it has loaded' }).toBe(0.5)

    // Off: every row where it would have been without the layer, the newest at the front.
    await page.locator('#tab-btn-layers').click()
    await page.locator('#frame-previous-toggle').uncheck()
    await page.locator('#tab-btn-scans').click()
    expect(await listed(page)).toEqual(['scan-late-old', 'scan-late', ...SCANS.map((s) => s.scanId)])
    expect(pageErrors).toEqual([])
  })

  test('a Place with no reference has no frame to be in or out of: no chip, no banner, and the layer says there is nothing to show', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors, { places: () => [BARE_PROJECT] })
    await expect(page.locator('.scan-frame-chip')).toHaveCount(0)
    await expect(page.locator('#frame-banner')).toBeHidden()
    await page.locator('#tab-btn-layers').click()
    await expect(page.locator('#frame-previous-toggle')).toBeDisabled()
    await expect(page.locator('#frame-previous-status')).toHaveText('No scan in this Place is from a previous reference.')
    expect(Object.values(await readOpacities(page)).every((opacity) => opacity === 1)).toBe(true)
    expect(pageErrors).toEqual([])
  })

  test('switching to a Place with no scans takes the last Place\'s banner, heading and layer count away with its scans', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors, { withEmptyPlace: true })
    await expect(page.locator('#frame-banner')).toBeVisible()
    await expect(page.locator('#scan-group-previous')).toHaveText('Previous reference (2)')
    await page.locator('#tab-btn-layers').click()
    await expect(page.locator('#frame-previous-status')).toHaveText('2 scans are from a previous reference.')

    // The switcher is behind the map drawer; its buttons are in the page all the same.
    await page.evaluate((name) => {
      const option = [...document.querySelectorAll<HTMLElement>('.project-switcher-option')].find((el) => (el.textContent ?? '').includes(name))
      if (!option) throw new Error(`no Place switcher entry for ${name}`)
      option.click()
    }, EMPTY_PROJECT.name)

    await page.locator('#tab-btn-scans').click()
    await expect(page.locator('#scan-list-empty')).toBeVisible()
    await expect(page.locator('#frame-banner'), 'what was said of the last Place\'s scans is not said of a Place with none').toBeHidden()
    await expect(page.locator('#scan-group-previous')).toHaveCount(0)
    await page.locator('#tab-btn-layers').click()
    await expect(page.locator('#frame-previous-toggle')).toBeDisabled()
    await expect(page.locator('#frame-previous-status')).toHaveText('No scan in this Place is from a previous reference.')
    expect(pageErrors).toEqual([])
  })

  test('a Place whose reference has no id says nothing about scans that have none, and a reference replaced under an open editor is picked up on refresh', async ({ page }) => {
    const pageErrors: string[] = []
    // The Place starts with a frame that has no id (every Place calibrated before this work): nothing can be compared.
    let place: Project = { ...BARE_PROJECT, spatialFrame: frame(), spatialFrameRevision: 1 }
    let placeRequests = 0
    const events = await mockEvents(page)
    await openEditor(page, pageErrors, { places: () => [place], onPlacesRequest: () => { placeRequests += 1 } })

    await expect(chipOf(page, 'scan-current')).toHaveCount(0)
    await expect(chipOf(page, 'scan-unrecorded'), 'a scan with no id in a legacy Place is not marked').toHaveCount(0)
    await expect(chipOf(page, 'scan-one-point')).toHaveText('not in Place frame')
    await expect(page.locator('#frame-banner')).toContainText("2 scans are not in this Place's frame.")
    await expect(page.locator('#frame-banner')).not.toContainText('previous reference')

    // A phone replaces the reference and uploads a scan: the scan arrives as the event the editor refreshes on, and the refresh
    // re-reads the Place.
    place = { ...BARE_PROJECT, spatialFrame: frame('frame-now'), spatialFrameRevision: 2, frameHistory: [HISTORY[1]!] }
    const asked = placeRequests
    await events.send({ type: 'scan-added', filename: 'phone-scan.glb', size: 4096 })
    await expect.poll(() => placeRequests, { message: 'the editor asked for the Places again', timeout: 15_000 }).toBeGreaterThan(asked)

    // The scan that names the replaced generation is now a previous reference, and the ones that name none are neutral.
    await expect(chipOf(page, 'scan-previous')).toHaveText('previous reference')
    await expect(chipOf(page, 'scan-current')).toHaveCount(0)
    await expect(chipOf(page, 'scan-before-ids')).toHaveText('frame not recorded')
    await expect(page.locator('#frame-banner')).toContainText('1 scan was measured against a previous reference and may not line up')
    await page.locator('#tab-btn-layers').click()
    await expect(page.locator('#frame-previous-status')).toHaveText('1 scan is from a previous reference.')
    await expect.poll(async () => (await readOpacities(page))['scan-previous']).toBe(0.5)
    expect(pageErrors).toEqual([])
  })
})
