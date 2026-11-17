/**
 * Calibration anchors in the World Editor, on a mocked Place.
 *
 * Three things the editor got wrong, and which the pure maths in
 * tests/unit/node/anchor_placement.test.ts cannot see because all three live in the
 * wiring between the maths and the scene:
 *
 *  1. WHERE. A scan root is placed by `scan.localToWorld`, the session-to-project
 *     transform M, so a child of the root is positioned in the AR *session*
 *     frame. The decal and the red pins were drawn at root-local (0,0,0) and
 *     (0,0,d), the session origin, which M sends to its own translation. Wherever
 *     the landmark was not tapped at the session origin, a perfect calibration
 *     showed as a gap against the white pins. They belong at inverse(M) applied to
 *     project zero and to (0,0,d), which is the landmark and the heading marker as
 *     tapped.
 *  2. WHETHER. The white pins (the Place's stored frame) were in no layer, so the
 *     Calibration anchors switch, off by default, hid the red decal and pins and
 *     left the white ones alone on screen.
 *  3. WHEN. The editor reads the Place's frame when it loads, and again when the
 *     world refreshes (`refreshWorldScans`): it re-read the Place, but only the load
 *     redrew the white pins. A frame stored by a phone while the editor was open
 *     (a first calibration, or one the person replaced with "Use anyway") showed
 *     only after a reload. The refresh is driven here by the same server event that
 *     drives it for real: `scan-added`, delivered on a mocked /events socket.
 *
 * Five scans share one Place whose stored frame is the two-point pair from
 * tests/unit/deno/anchor_calibration.test.ts: a perfect re-measure, the same
 * pair seen from a session that started facing another way and elsewhere, a
 * re-measure 8 cm long, a one-point calibration, and an uncalibrated scan. The
 * matrices are the repo's own builders, not stand-ins.
 *
 * The scene is read through three.js's own devtools protocol: when
 * `window.__THREE_DEVTOOLS__` exists, `new Scene()` dispatches an `observe` event
 * carrying the scene. That needs no hook in the app, and none of the app's test
 * hooks (`__editorTest`, `__measureTool`) expose scene objects. If a future three
 * drops the protocol the spec fails at "the viewer's scene was observed" rather
 * than passing on nothing.
 *
 * Every /worlds, /projects and /scans response is mocked, with a GLB that is a
 * valid but empty glTF scene. This covers the client only: a real calibrated scan
 * from a real server is not exercised here. In particular each scan's
 * `calibrationMethod` is written into the mocked manifest, so this spec cannot
 * tell whether a real server hands the viewer the `'two-point-ground'` tier
 * (asCalibrationMethod in server/calibration_fields.ts decides that, and
 * tests/unit/deno/calibration_fields.test.ts pins it); the red pins depend on it.
 *
 * Run: npx playwright test --project=chromium-mock mock-anchor-layer
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import {
  anchorToProjectTransform,
  composeYUpTransform,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../src/world/geo'
import type { GeoPose, Project, ProjectSpatialFrame, ScanManifest, Vec3, WorldProject } from '../src/world/types'

const SLUG = 'default'
const WORLD_ID = 'world-anchor-layer'
const PROJECT_ID = 'proj-default'
const ORIGIN: GeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

/** The pair tests/unit/deno/anchor_calibration.test.ts uses, in the first session's own frame. */
const LANDMARK: Vec3 = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER: Vec3 = { x: 3.1, y: -1.2, z: 1.9 }
/** What the Place stored: the landmark at project zero, the marker on +Z at this distance. */
const STORED_SEPARATION_M = twoPointSeparationM(LANDMARK, HEADING_MARKER)
/** How much longer the third scan's re-measure came out. */
const RESIDUAL_M = 0.08

function yaw(p: Vec3, degrees: number): Vec3 {
  const t = (degrees * Math.PI) / 180
  return { x: Math.cos(t) * p.x + Math.sin(t) * p.z, y: p.y, z: -Math.sin(t) * p.x + Math.cos(t) * p.z }
}

function shift(p: Vec3, by: Vec3): Vec3 {
  return { x: p.x + by.x, y: p.y + by.y, z: p.z + by.z }
}

/** The same physical pair, as a session that started facing 90 degrees away and 4 m off would measure it. */
const ROTATED_OFFSET: Vec3 = { x: 4, y: 0.3, z: -2.5 }
const ROTATED_LANDMARK = shift(yaw(LANDMARK, 90), ROTATED_OFFSET)
const ROTATED_HEADING = shift(yaw(HEADING_MARKER, 90), ROTATED_OFFSET)

/** The heading marker re-tapped RESIDUAL_M further along the same line, in the first session's frame. */
const LONG_HEADING: Vec3 = {
  x: LANDMARK.x + ((HEADING_MARKER.x - LANDMARK.x) * (STORED_SEPARATION_M + RESIDUAL_M)) / STORED_SEPARATION_M,
  y: HEADING_MARKER.y,
  z: LANDMARK.z + ((HEADING_MARKER.z - LANDMARK.z) * (STORED_SEPARATION_M + RESIDUAL_M)) / STORED_SEPARATION_M,
}

const ONE_POINT_TAP: Vec3 = { x: -2.2, y: -0.9, z: 1.6 }

type Pt = [number, number, number]

function pt(p: Vec3): Pt {
  return [p.x, p.y, p.z]
}

function scan(
  scanId: string,
  name: string,
  localToWorld: number[],
  calibration: Pick<ScanManifest, 'calibrationMethod' | 'calibrationStatus' | 'calibrationSeparationM'>,
): ScanManifest {
  return {
    scanId,
    projectId: PROJECT_ID,
    sessionId: `sess-${scanId}`,
    filename: `${scanId}.glb`,
    name,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: ORIGIN,
    localToWorld,
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

const SCANS: ScanManifest[] = [
  scan('scan-perfect', 'Perfect re-measure', twoPointToProjectTransform(LANDMARK, HEADING_MARKER), {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibrationSeparationM: STORED_SEPARATION_M,
  }),
  scan('scan-rotated', 'Other session', twoPointToProjectTransform(ROTATED_LANDMARK, ROTATED_HEADING), {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibrationSeparationM: STORED_SEPARATION_M,
  }),
  scan('scan-long', 'Long re-measure', twoPointToProjectTransform(LANDMARK, LONG_HEADING), {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibrationSeparationM: twoPointSeparationM(LANDMARK, LONG_HEADING),
  }),
  scan('scan-one-point', 'One-point', anchorToProjectTransform(ONE_POINT_TAP, 40), {
    calibrationMethod: 'ground-tap-compass',
    calibrationStatus: 'provisional',
    calibrationSeparationM: null,
  }),
  scan('scan-uncalibrated', 'GPS only', composeYUpTransform({ x: 6, y: 0, z: 6 }, 15, 1), {
    calibrationStatus: 'uncalibrated',
  }),
]

/** A Place that nothing has calibrated yet: no stored frame. */
const UNCALIBRATED_PROJECT: Project = {
  projectId: PROJECT_ID,
  name: 'Anchor layer test place',
  createdAt: 0,
  updatedAt: 0,
  floors: [],
}

/** The Place's stored two-point frame, `separationM` metres from the landmark to the heading marker. */
function storedFrame(separationM: number): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt: '2026-11-01T09:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  }
}

const PROJECT: Project = { ...UNCALIBRATED_PROJECT, spatialFrame: storedFrame(STORED_SEPARATION_M) }

const WORLD: WorldProject = {
  worldId: WORLD_ID,
  name: 'Anchor layer test place',
  shareSlug: SLUG,
  projectId: PROJECT_ID,
  originGeoPose: ORIGIN,
  localFrame: { type: 'ENU_Y_UP', origin: ORIGIN, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
  scans: SCANS,
  things: [],
  thingObservations: [],
  members: [],
  comments: [],
  jobs: [],
  editPatches: [],
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
}

/** A valid binary glTF whose scene has no nodes: enough for the viewer to build a scan root around. */
function emptyGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(padded.length, 0)
  chunk.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([header, chunk, padded])
}

type MockOptions = {
  /** What GET /projects answers with. A function, so a test can change the Place between two requests. */
  places?: () => Project[]
  /** Called for every GET /projects, so a test can tell that the editor has asked for the Places again. */
  onPlacesRequest?: () => void
}

async function mockApi(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/worlds/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/worlds/${SLUG}` && route.request().method() === 'GET') return route.fulfill({ json: WORLD })
    // Jobs, comments, patches and anything else the viewer polls: an empty list is a valid answer.
    return route.fulfill({ json: [] })
  })
  await page.route('**/scans/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.glb')) return route.fulfill({ body: emptyGlb(), contentType: 'model/gltf-binary' })
    // The optimization manifest: none, so the viewer loads the plain GLB.
    return route.fulfill({ status: 404, json: { error: 'not in this mock' } })
  })
  await page.route('**/projects', (route) => {
    if (route.request().method() === 'GET') options.onPlacesRequest?.()
    return route.fulfill({ json: (options.places ?? (() => [PROJECT]))() })
  })
  await page.route('**/project-locations', (route) => route.fulfill({ json: [] }))
  await page.route('**/authenticate/whoami', (route) => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
}

/**
 * Take over the editor's /events socket, so a test can deliver the server events it refreshes on. Nothing is
 * connected to a server: the page sees an open socket, and only what `send` hands it arrives. Register this
 * before the page navigates.
 */
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

type Seen = { local: Pt; world: Pt; shown: boolean }
type ScanAnchors = { decal: Seen | null; actualLandmark: Seen | null; actualHeading: Seen | null }
type Anchors = {
  scans: Record<string, ScanAnchors>
  /**
   * The Place's stored pins, or null when no such group is in the scene. `groups` counts them: a redraw must
   * replace the group, not stack a second one beside it.
   */
  expected: { group: boolean; groups: number; landmark: Seen | null; heading: Seen | null } | null
}

/** Read where the anchor decals and pins are, and whether each is actually drawn. */
async function readAnchors(page: Page): Promise<Anchors | null> {
  return page.evaluate(() => {
    type V3 = { x: number; y: number; z: number }
    type Node3 = {
      name: string
      visible: boolean
      parent: Node3 | null
      children: Node3[]
      position: V3
      userData: Record<string, unknown>
      getWorldPosition(target: V3): V3
      updateMatrixWorld(force?: boolean): void
    }
    const observed = (window as unknown as { __observedScenes?: Node3[] }).__observedScenes ?? []
    // A Place switch builds a new scene, so the live one is the last to have a world group.
    const scene = [...observed].reverse().find((s) => s.children.some((c) => c.name === 'World scan roots'))
    if (!scene) return null
    const worldGroup = scene.children.find((c) => c.name === 'World scan roots')!
    scene.updateMatrixWorld(true)

    // Drawn means the node and every ancestor up to the scene is visible.
    const drawn = (node: Node3 | null): boolean => {
      for (let n = node; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const seen = (node: Node3 | undefined): Seen | null => {
      if (!node) return null
      const Vec = node.position.constructor as new () => V3
      const world = node.getWorldPosition(new Vec())
      return {
        local: [node.position.x, node.position.y, node.position.z],
        world: [world.x, world.y, world.z],
        shown: drawn(node),
      }
    }

    const scans: Record<string, ScanAnchors> = {}
    for (const root of worldGroup.children) {
      const scanId = root.userData['scanId']
      if (typeof scanId !== 'string') continue
      const child = (prefix: string) => root.children.find((c) => c.name.startsWith(prefix))
      scans[scanId] = {
        decal: seen(child('calibration anchor')),
        actualLandmark: seen(child('actual landmark')),
        actualHeading: seen(child('actual heading marker')),
      }
    }

    const expectedGroups = worldGroup.children.filter((c) => c.name === 'expected calibration pins')
    const expectedGroup = expectedGroups[0]
    const expected = expectedGroup
      ? {
          group: drawn(expectedGroup),
          groups: expectedGroups.length,
          landmark: seen(expectedGroup.children.find((c) => c.name === 'expected landmark')),
          heading: seen(expectedGroup.children.find((c) => c.name === 'expected heading marker')),
        }
      : null
    return { scans, expected }
  })
}

function gap(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** The anchors, once the viewer has built the scene and every scan root. */
async function loadedAnchors(page: Page): Promise<Anchors> {
  await expect(page.locator('.scan-status', { hasText: /Ready/ })).toHaveCount(SCANS.length, { timeout: 60_000 })
  await expect.poll(async () => {
    const anchors = await readAnchors(page)
    return anchors === null ? -1 : Object.keys(anchors.scans).length
  }, { message: "the viewer's scene was observed, with every scan root in it", timeout: 15_000 }).toBe(SCANS.length)
  return (await readAnchors(page))!
}

/** Flip the Views menu's Calibration anchors switch, as a user would. */
async function setAnchorsLayer(page: Page, on: boolean): Promise<void> {
  const menu = page.locator('#view-menu')
  if (!(await menu.evaluate((el) => (el as HTMLDetailsElement).open))) await menu.locator('summary').click()
  const toggle = page.locator('#view-toggle-anchors')
  if (on) await toggle.check()
  else await toggle.uncheck()
}

async function openEditor(page: Page, pageErrors: string[], options: MockOptions = {}): Promise<void> {
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await observeScenes(page)
  await mockApi(page, options)
  await page.goto(`/viewer.html?world=${SLUG}`)
}

test.describe('calibration anchors on a mocked Place', () => {
  test.setTimeout(120_000)
  // The viewer registers /sw.js, and a service worker sends fetches past page.route,
  // so the mocks would never see them. Block the worker, as the other mock specs do.
  test.use({ serviceWorkers: 'block' })

  test('the decal and the red pins sit on the landmark and heading marker that were tapped', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors)
    await loadedAnchors(page)
    await setAnchorsLayer(page, true)
    // Poll rather than read once: the toggle's change handler runs in the page, and
    // `shown` is the thing being waited on, so a stale read must not fail the test.
    await expect.poll(async () => (await readAnchors(page))?.scans['scan-perfect']?.decal?.shown).toBe(true)
    const anchors = (await readAnchors(page))!

    const tolerance = 1e-6
    const origin: Pt = [0, 0, 0]
    const calibrated: Array<{ id: string; landmark: Vec3; heading: Vec3 | null; headingWorldZ: number | null }> = [
      { id: 'scan-perfect', landmark: LANDMARK, heading: HEADING_MARKER, headingWorldZ: STORED_SEPARATION_M },
      { id: 'scan-rotated', landmark: ROTATED_LANDMARK, heading: ROTATED_HEADING, headingWorldZ: STORED_SEPARATION_M },
      { id: 'scan-long', landmark: LANDMARK, heading: LONG_HEADING, headingWorldZ: STORED_SEPARATION_M + RESIDUAL_M },
      { id: 'scan-one-point', landmark: ONE_POINT_TAP, heading: null, headingWorldZ: null },
    ]
    for (const { id, landmark, heading, headingWorldZ } of calibrated) {
      const a = anchors.scans[id]!
      // The decal is on the landmark as the session tapped it — in the root's own
      // coordinates, not at its origin — and that is project zero in the world.
      expect(a.decal, `${id}: decal`).not.toBeNull()
      expect(gap(a.decal!.local, pt(landmark)), `${id}: decal, root-local`).toBeLessThan(tolerance)
      expect(gap(a.decal!.world, origin), `${id}: decal, world`).toBeLessThan(tolerance)
      expect(a.decal!.shown, `${id}: decal is drawn once the layer is on`).toBe(true)

      if (!heading || headingWorldZ === null) {
        expect(a.actualLandmark, `${id}: no red pins off the two-point tier`).toBeNull()
        expect(a.actualHeading, `${id}: no red pins off the two-point tier`).toBeNull()
        continue
      }
      expect(gap(a.actualLandmark!.local, pt(landmark)), `${id}: red landmark, root-local`).toBeLessThan(tolerance)
      expect(gap(a.actualLandmark!.world, origin), `${id}: red landmark, world`).toBeLessThan(tolerance)
      expect(gap(a.actualHeading!.local, pt(heading)), `${id}: red heading marker, root-local`).toBeLessThan(tolerance)
      expect(gap(a.actualHeading!.world, [0, 0, headingWorldZ]), `${id}: red heading marker, world`).toBeLessThan(tolerance)
      expect(a.actualLandmark!.shown && a.actualHeading!.shown, `${id}: red pins are drawn once the layer is on`).toBe(true)
    }

    // An uncalibrated scan's origin is wherever tracking booted: no decal, no pins.
    const gps = anchors.scans['scan-uncalibrated']!
    expect([gps.decal, gps.actualLandmark, gps.actualHeading]).toEqual([null, null, null])

    // The white pins are the stored frame, drawn straight into project space.
    expect(anchors.expected, 'the Place has a stored two-point frame').not.toBeNull()
    expect(gap(anchors.expected!.landmark!.world, origin), 'white landmark').toBeLessThan(tolerance)
    expect(gap(anchors.expected!.heading!.world, [0, 0, STORED_SEPARATION_M]), 'white heading marker').toBeLessThan(tolerance)

    // A perfect calibration leaves nothing between red and white. A re-measure that
    // came out 8 cm long leaves exactly 8 cm, on the heading marker, along +Z.
    const white = anchors.expected!
    for (const id of ['scan-perfect', 'scan-rotated']) {
      const a = anchors.scans[id]!
      expect(gap(a.actualLandmark!.world, white.landmark!.world), `${id}: landmark gap`).toBeLessThan(tolerance)
      expect(gap(a.actualHeading!.world, white.heading!.world), `${id}: heading gap`).toBeLessThan(tolerance)
    }
    const long = anchors.scans['scan-long']!
    expect(gap(long.actualLandmark!.world, white.landmark!.world), 'long: landmark gap').toBeLessThan(tolerance)
    expect(gap(long.actualHeading!.world, white.heading!.world), 'long: heading gap').toBeCloseTo(RESIDUAL_M, 6)
    expect(long.actualHeading!.world[2] - white.heading!.world[2], 'long: signed along +Z').toBeCloseTo(RESIDUAL_M, 6)

    // No page error is expected: the empty GLB is a valid scene with nothing in it.
    expect(pageErrors).toEqual([])
  })

  test('one Calibration anchors switch hides and shows the red decal and pins and the white pins together', async ({ page }) => {
    const pageErrors: string[] = []
    await openEditor(page, pageErrors)
    const initial = await loadedAnchors(page)

    const everyAnchor = (anchors: Anchors): Array<[string, Seen | null]> => {
      const rows: Array<[string, Seen | null]> = []
      for (const [id, a] of Object.entries(anchors.scans)) {
        rows.push([`${id} decal`, a.decal], [`${id} red landmark`, a.actualLandmark], [`${id} red heading marker`, a.actualHeading])
      }
      rows.push(['white landmark', anchors.expected?.landmark ?? null], ['white heading marker', anchors.expected?.heading ?? null])
      return rows.filter((row): row is [string, Seen] => row[1] !== null)
    }
    const shownByName = (anchors: Anchors) => Object.fromEntries(everyAnchor(anchors).map(([name, s]) => [name, s!.shown]))
    const allShown = (anchors: Anchors, expected: boolean) =>
      everyAnchor(anchors).every(([, s]) => s!.shown === expected)

    // The layer is off by default. The red decal and pins have always honoured that;
    // the white pins stood on screen alone, with nothing to be compared against.
    expect(everyAnchor(initial).length, 'three red anchors on each of three scans, one on the fourth, two white').toBe(3 * 3 + 1 + 2)
    expect(shownByName(initial), 'off by default: red and white alike').toEqual(
      Object.fromEntries(everyAnchor(initial).map(([name]) => [name, false])),
    )
    expect(initial.expected!.group, 'the white group itself is hidden').toBe(false)
    await expect(page.locator('#view-toggle-anchors')).not.toBeChecked()

    await setAnchorsLayer(page, true)
    await expect.poll(async () => allShown((await readAnchors(page))!, true), { message: 'switched on: red and white alike' }).toBe(true)
    expect((await readAnchors(page))!.expected!.group, 'the white group is shown').toBe(true)

    await setAnchorsLayer(page, false)
    await expect.poll(async () => allShown((await readAnchors(page))!, false), { message: 'switched off again: red and white alike' }).toBe(true)
    expect((await readAnchors(page))!.expected!.group, 'the white group is hidden again').toBe(false)

    // The other layers keep working while the anchors are off: the white group
    // must not have taken scan roots down with it.
    expect(Object.keys((await readAnchors(page))!.scans)).toHaveLength(SCANS.length)
    expect(pageErrors).toEqual([])
  })

  test('a frame stored while the editor is open is drawn when the world refreshes, and redrawn when it is replaced', async ({ page }) => {
    const pageErrors: string[] = []
    // The Place starts with no stored frame. A phone then calibrates it, which changes the Place the server holds
    // under the open editor, and uploads its scan. That upload is the `scan-added` event the editor refreshes on,
    // and the refresh is what re-reads the Place: the server sends no event for a stored frame itself.
    let place: Project = UNCALIBRATED_PROJECT
    let placeRequests = 0
    const events = await mockEvents(page)
    await openEditor(page, pageErrors, { places: () => [place], onPlacesRequest: () => { placeRequests += 1 } })
    const loaded = await loadedAnchors(page)
    expect(loaded.expected, 'nothing is stored yet, so there are no white pins to draw').toBeNull()

    /** The Place changes on the server, then its scan arrives; resolves once the editor has asked for the Places again. */
    const storeAndRefresh = async (next: Project): Promise<void> => {
      place = next
      const asked = placeRequests
      await events.send({ type: 'scan-added', filename: 'phone-scan.glb', size: 4096 })
      await expect.poll(() => placeRequests, {
        message: 'the editor refreshed the world and asked for the Places again',
        timeout: 15_000,
      }).toBeGreaterThan(asked)
    }
    const tolerance = 1e-6
    const origin: Pt = [0, 0, 0]

    // 1. A first calibration. No scan is new (the mocked world still lists the same five), so the refresh has no
    //    scan to load and returns early: the redraw has to come before that return.
    await storeAndRefresh(PROJECT)
    await expect.poll(async () => (await readAnchors(page))?.expected?.groups ?? 0, {
      message: 'the stored frame is drawn as white pins, with no reload',
      timeout: 10_000,
    }).toBe(1)
    const first = (await readAnchors(page))!.expected!
    expect(gap(first.landmark!.world, origin), 'white landmark, at project zero').toBeLessThan(tolerance)
    expect(gap(first.heading!.world, [0, 0, STORED_SEPARATION_M]), 'white heading marker, on +Z at the stored separation').toBeLessThan(tolerance)
    // They are in the Calibration anchors layer like the ones drawn at load, so they arrive hidden while it is off.
    expect(first.group, 'the layer is off by default, so the white pins that arrived late are hidden').toBe(false)
    await setAnchorsLayer(page, true)
    await expect.poll(async () => {
      const white = (await readAnchors(page))?.expected
      return white !== undefined && white !== null && white.landmark!.shown && white.heading!.shown
    }, { message: 'switched on, the white pins that arrived after the load are shown' }).toBe(true)

    // 2. The person overrode a mismatch ("Use anyway"): the new pair replaces the stored one, 0.4 m longer.
    const replacedSeparationM = STORED_SEPARATION_M + 0.4
    await storeAndRefresh({ ...UNCALIBRATED_PROJECT, spatialFrame: storedFrame(replacedSeparationM) })
    await expect.poll(async () => (await readAnchors(page))?.expected?.heading?.world[2] ?? Number.NaN, {
      message: 'the replaced frame moves the white heading pin',
      timeout: 10_000,
    }).toBeCloseTo(replacedSeparationM, 6)
    const second = (await readAnchors(page))!.expected!
    expect(second.groups, 'the redraw replaced the group instead of stacking a second one').toBe(1)
    expect(gap(second.landmark!.world, origin), 'white landmark, still at project zero').toBeLessThan(tolerance)
    expect(second.landmark!.shown && second.heading!.shown, 'the layer is on, so the redrawn pins are shown').toBe(true)

    // Every scan root is still there after both refreshes.
    expect(Object.keys((await readAnchors(page))!.scans)).toHaveLength(SCANS.length)
    expect(pageErrors).toEqual([])
  })
})
