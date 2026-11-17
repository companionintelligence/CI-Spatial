/**
 * The World Editor's stitching tools against a real server: move a scan by numbers, save, reload, reset
 * it to its calibrated placement, and take a save back. Also the marker and the leave guard for a move that
 * was never saved, the locked scan size, and the compare tint and see-through.
 *
 * Seeds one scan through the real upload route with a calibrated `projectTransform` (a test home's own
 * geometry and metadata, with a two-point calibration added), so the scan has a landmark to turn about and a
 * first placement to reset to. The scan is found by the filename the server answered the upload with, not
 * by its position in a world other specs share.
 *
 * The gizmo itself (a pointer drag on the proxy) is not driven here: a canvas drag on a three.js
 * gizmo is the part of this that depends on pixels. That the proxy turns the scan about the landmark, that a drag
 * snaps, and that the scale is locked are checked in tests/unit/node/stitch_session.test.ts with the same
 * events the real controls fire, and in tests/unit/node/stitch_real_gizmo.test.ts with three.js's own
 * TransformControls; what is checked here is the page: the fields, the buttons, the save and the server.
 *
 * Requirements: Vite dev server (VITE_URL) + Deno server behind the proxy, and test-data (npm run gen:test-data).
 * Run: npx playwright test --project=chromium-mock mock-editor-stitching
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { twoPointToProjectTransform } from '../src/world/geo'
import type { EditPatch, ScanManifest, WorldProject } from '../src/world/types'

const HOMES_DIR = join(process.cwd(), 'test-data', 'homes')
const homesAvailable = existsSync(join(HOMES_DIR, 'index.json'))

/** What window.__stitchTest.state() reports for the scan the gizmo is on (src/viewer/stitch-tools.ts, dev build with ?mock=editor). */
interface StitchState {
  scanId: string | null
  pivotKind: 'landmark' | 'centroid' | 'origin'
  pivotWorld: [number, number, number]
  matrix: number[]
  unsaved: boolean
  unsavedCount: number
  gizmoOnProxy: boolean
  tint: number | null
  ghost: boolean
  opacity: number | null
}

const CALIBRATED = twoPointToProjectTransform({ x: 1.5, y: 0, z: -0.4 }, { x: 3.1, y: 0, z: 1.9 })

test.describe('editor stitching tools', () => {
  test.skip(!homesAvailable, 'test-data missing — run: npm run gen:test-data')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  /** The filename the server gave the seeded scan. */
  let filename = ''

  /** Upload the test home with a two-point calibration whose transform is `transform`. */
  async function uploadHome(request: APIRequestContext, label: string, transform: number[]): Promise<{ filename: string; projectTransformRejected?: string }> {
    const index = JSON.parse(readFileSync(join(HOMES_DIR, 'index.json'), 'utf8')) as Array<{ file: string; meta: string }>
    const entry = index[0]
    expect(entry, 'the test-data has a home').toBeTruthy()
    const meta = JSON.parse(readFileSync(join(HOMES_DIR, entry!.meta), 'utf8')) as Record<string, unknown>
    const stamp = Date.now()
    const upload = await request.post('/upload-scan', {
      multipart: {
        file: {
          name: `${label}-${stamp}.glb`,
          mimeType: 'model/gltf-binary',
          buffer: readFileSync(join(HOMES_DIR, entry!.file)),
        },
        metadata: JSON.stringify({
          ...meta,
          sessionId: `session-${label}-${stamp}`,
          scanName: `${label} ${stamp}`,
          projectId: null,
          projectTransform: transform,
          calibrationMethod: 'two-point-ground',
          calibrationStatus: 'provisional',
          calibration: {
            method: 'two-point-ground',
            status: 'provisional',
            separationM: 1.9,
            residualM: 0,
            toleranceM: 0.15,
            anchorBearingDeg: null,
            calibratedAt: '2026-01-15T12:00:00.000Z',
            sessionToProject: transform,
          },
        }),
      },
    })
    expect(upload.ok(), 'seed upload: the server stores it whatever its transform is').toBeTruthy()
    return await upload.json() as { filename: string; projectTransformRejected?: string }
  }

  test.beforeAll(async ({ request }) => {
    const body = await uploadHome(request, 'stitch', CALIBRATED)
    expect(body.projectTransformRejected, 'the seeded transform is a valid one').toBeUndefined()
    filename = body.filename
  })

  const scanRow = async (request: APIRequestContext): Promise<ScanManifest> => {
    const world = await (await request.get('/worlds/default')).json() as WorldProject
    const row = world.scans.find((scan) => scan.filename === filename)
    expect(row, `the world has ${filename}`).toBeTruthy()
    return row!
  }

  const stitchState = (page: Page): Promise<StitchState | null> =>
    page.evaluate(() => (window as unknown as { __stitchTest: { state: () => StitchState | null } }).__stitchTest.state())

  /** Open the editor on the seeded scan, wait for it to load, select it and open the Edit tab. */
  async function openOnScan(page: Page): Promise<void> {
    await page.goto('/viewer.html?world=default&mock=editor')
    const item = page.locator(`.scan-item[data-filename="${filename}"]`)
    await expect(item.locator('.scan-status', { hasText: /Ready/ })).toBeVisible({ timeout: 60_000 })
    await item.click()
    await page.locator('.sidebar-tab[data-tab="edit"]').click()
    await expect(page.locator('#stitch-section')).toBeVisible()
  }

  /** Type into a field and leave it, the way a person does. */
  async function typeInto(page: Page, id: string, value: string): Promise<void> {
    const field = page.locator(`#${id}`)
    await field.fill(value)
    await field.press('Tab')
  }

  const leaveGuardAsks = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })

  test('selecting a scan stands the gizmo on its calibrated landmark and locks its size', async ({ page }) => {
    await openOnScan(page)
    await expect(page.locator('#stitch-pivot-note')).toHaveText('Turns around the calibrated landmark.')
    await expect(page.locator('#transform-scale')).toBeDisabled()
    await expect(page.locator('#stitch-reset')).toHaveText('Reset to calibrated')

    const state = await stitchState(page)
    expect(state).toBeTruthy()
    expect(state!.gizmoOnProxy).toBe(true)
    expect(state!.pivotKind).toBe('landmark')
    // A calibration sends the landmark to the Place's zero, so that is where the gizmo stands. The old gizmo stood on the
    // scan root's own origin, where the AR session started.
    for (const coordinate of state!.pivotWorld) expect(Math.abs(coordinate)).toBeLessThan(1e-6)
    expect(state!.unsaved).toBe(false)
    expect(await leaveGuardAsks(page)).toBe(false)
  })

  test('a move by numbers is flagged until it is saved, survives a reload, and resets to the calibrated placement', async ({ page, request }) => {
    const start = await scanRow(request)
    const calibrated = start.calibratedLocalToWorld
    expect(calibrated, 'the server stored the first placement').toBeTruthy()
    expect(calibrated).toEqual(CALIBRATED.map((entry) => entry + 0))

    await openOnScan(page)

    // Move: 7 cm along X, 3 degrees of turn.
    await typeInto(page, 'stitch-x', '7')
    await typeInto(page, 'stitch-yaw', '3')
    const moved = await stitchState(page)
    expect(moved!.unsaved).toBe(true)
    expect(moved!.pivotWorld[0]).toBeCloseTo(0.07, 6)
    expect(moved!.pivotWorld[2]).toBeCloseTo(0, 6)
    await expect(page.locator('#stitch-status')).toHaveText('Moved. Not saved yet.')
    await expect(page.locator(`.scan-item[data-filename="${filename}"]`)).toHaveClass(/scan-dirty/)
    expect(await leaveGuardAsks(page), 'the page asks before an unsaved move is thrown away').toBe(true)
    await expect(page.locator('#stitch-undo')).toBeDisabled()

    // Save, with the editor's own button.
    await page.locator('#edit-save-transform').click()
    await expect(page.locator('#edit-save-status')).toHaveText('Saved')
    await expect.poll(async () => (await stitchState(page))?.unsaved, { timeout: 15_000 }).toBe(false)
    await expect(page.locator(`.scan-item[data-filename="${filename}"]`)).not.toHaveClass(/scan-dirty/)
    expect(await leaveGuardAsks(page)).toBe(false)

    const saved = await scanRow(request)
    expect(saved.localToWorld).toEqual(moved!.matrix.map((entry) => entry + 0))
    expect(saved.calibratedLocalToWorld, 'a move never touches the first placement').toEqual(calibrated)
    const patches = await (await request.get('/worlds/default/patches')).json() as EditPatch[]
    const lastMove = patches.filter((patch) => patch.scope === 'scan' && patch.targetId === filename).at(-1)
    expect(lastMove?.transform?.matrix).toEqual(saved.localToWorld)

    // Reload: the scan is where it was saved, not where it was calibrated.
    await openOnScan(page)
    const reloaded = await stitchState(page)
    for (let i = 0; i < 16; i++) expect(reloaded!.matrix[i]).toBeCloseTo(saved.localToWorld[i]!, 6)
    expect(reloaded!.unsaved).toBe(false)

    // Reset to calibrated: an ordinary patch carrying the stored matrix.
    await expect(page.locator('#stitch-reset')).toBeEnabled()
    await page.locator('#stitch-reset').click()
    await expect.poll(async () => (await scanRow(request)).localToWorld, { timeout: 15_000 }).toEqual(calibrated)
    const afterReset = await stitchState(page)
    for (let i = 0; i < 16; i++) expect(afterReset!.matrix[i]).toBeCloseTo(calibrated![i]!, 6)
    expect(afterReset!.unsaved).toBe(false)
    await expect(page.locator('#stitch-reset')).toBeDisabled()
    const afterPatches = await (await request.get('/worlds/default/patches')).json() as EditPatch[]
    const resetPatch = afterPatches.filter((patch) => patch.scope === 'scan' && patch.targetId === filename).at(-1)
    expect(resetPatch?.transform?.matrix, 'the patch holds the stored matrix, bit for bit').toEqual(calibrated)
    expect(resetPatch?.revertsPatchId).toBeUndefined()
    expect((await scanRow(request)).calibratedLocalToWorld).toEqual(calibrated)

    // Undo the reset: the saved move comes back, and the undo is itself in the log.
    await expect(page.locator('#stitch-undo')).toBeEnabled()
    await page.locator('#stitch-undo').click()
    await expect(page.locator('#stitch-status')).toHaveText('Undone.')
    await expect.poll(async () => (await scanRow(request)).localToWorld, { timeout: 15_000 }).toEqual(saved.localToWorld)
    const undone = await stitchState(page)
    for (let i = 0; i < 16; i++) expect(undone!.matrix[i]).toBeCloseTo(saved.localToWorld[i]!, 6)
    const finalPatches = await (await request.get('/worlds/default/patches')).json() as EditPatch[]
    const undoRecord = finalPatches.at(-1)
    expect(undoRecord?.revertsPatchId).toBe(resetPatch?.patchId)

    // Leave the scan where it was first placed, for the next run.
    await page.locator('#stitch-reset').click()
    await expect.poll(async () => (await scanRow(request)).localToWorld, { timeout: 15_000 }).toEqual(calibrated)
  })

  test('discarding a move puts the scan back and takes the marker and the leave prompt away', async ({ page }) => {
    await openOnScan(page)
    await typeInto(page, 'stitch-z', '12')
    expect((await stitchState(page))!.unsaved).toBe(true)
    expect(await leaveGuardAsks(page)).toBe(true)
    await page.locator('#stitch-discard').click()
    expect((await stitchState(page))!.unsaved).toBe(false)
    await expect(page.locator('#stitch-z')).toHaveValue('0')
    await expect(page.locator(`.scan-item[data-filename="${filename}"]`)).not.toHaveClass(/scan-dirty/)
    expect(await leaveGuardAsks(page)).toBe(false)
  })

  test('the nudge buttons move by exactly 1 and 5 cm and turn by 0.5 and 2 degrees', async ({ page }) => {
    await openOnScan(page)
    const before = (await stitchState(page))!
    await page.locator('.stitch-nudges[data-axis="x"] button[data-step="5"]').click()
    await page.locator('.stitch-nudges[data-axis="x"] button[data-step="-1"]').click()
    await page.locator('.stitch-nudges[data-axis="z"] button[data-step="1"]').click()
    const after = (await stitchState(page))!
    expect(after.pivotWorld[0] - before.pivotWorld[0]).toBeCloseTo(0.04, 9)
    expect(after.pivotWorld[2] - before.pivotWorld[2]).toBeCloseTo(0.01, 9)
    await page.locator('.stitch-nudges[data-axis="yaw"] button[data-step="0.5"]').click()
    await expect(page.locator('#stitch-yaw')).toHaveValue('0.5')
    const turned = (await stitchState(page))!
    // Turning leaves the pivot where it was.
    expect(turned.pivotWorld[0]).toBeCloseTo(after.pivotWorld[0], 9)
    expect(turned.pivotWorld[2]).toBeCloseTo(after.pivotWorld[2], 9)
    await page.locator('#stitch-discard').click()
  })

  test('a scan\'s size is locked: Scale is off, and Fix size is the one way to change it, inside 0.5 to 2', async ({ page }) => {
    await openOnScan(page)
    await expect(page.locator('#transform-scale')).toBeDisabled()
    await page.locator('#stitch-size summary').click()
    await page.locator('#stitch-size-field').fill('3')
    await page.locator('#stitch-size-apply').click()
    await expect(page.locator('#stitch-status')).toHaveText('Size must stay between 0.5 and 2 times.')
    expect((await stitchState(page))!.unsaved).toBe(false)

    await page.locator('#stitch-size-field').fill('1.2')
    await page.locator('#stitch-size-apply').click()
    const grown = (await stitchState(page))!
    expect(Math.hypot(grown.matrix[0]!, grown.matrix[1]!, grown.matrix[2]!)).toBeCloseTo(1.2, 9)
    expect(grown.unsaved).toBe(true)
    await page.locator('#stitch-discard').click()
    const back = (await stitchState(page))!
    expect(Math.hypot(back.matrix[0]!, back.matrix[1]!, back.matrix[2]!)).toBeCloseTo(1, 9)
  })

  test('a tint and See through apply to the selected scan, show in the list, and come off cleanly', async ({ page }) => {
    await openOnScan(page)
    const item = page.locator(`.scan-item[data-filename="${filename}"]`)
    const plain = (await stitchState(page))!
    expect(plain.tint).toBeNull()
    expect(plain.ghost).toBe(false)

    await page.locator('#stitch-swatches button').nth(1).click()
    await expect(item).toHaveClass(/scan-tinted/)
    expect((await stitchState(page))!.tint).not.toBeNull()

    await page.locator('#stitch-ghost').check()
    const ghosted = (await stitchState(page))!
    expect(ghosted.ghost).toBe(true)
    expect(ghosted.opacity).toBeCloseTo((plain.opacity ?? 1) * 0.5, 6)

    await page.locator('#stitch-ghost').uncheck()
    await page.locator('#stitch-swatches button').first().click()
    await expect(item).not.toHaveClass(/scan-tinted/)
    const cleared = (await stitchState(page))!
    expect(cleared.tint).toBeNull()
    expect(cleared.ghost).toBe(false)
    expect(cleared.opacity).toBeCloseTo(plain.opacity ?? 1, 6)
  })

  test('a scan whose uploaded placement the server set aside is flagged in the list with the reason, and is the only one', async ({ page, request }) => {
    // The second axis leaned toward the first by 0.05 radians: the upload is stored, placed by GPS or the grid, and flagged.
    const skewed = [...CALIBRATED]
    for (let i = 0; i < 3; i++) skewed[4 + i] = Math.cos(0.05) * CALIBRATED[4 + i]! + Math.sin(0.05) * CALIBRATED[i]!
    const flaggedUpload = await uploadHome(request, 'stitch-skewed', skewed)
    expect(flaggedUpload.projectTransformRejected, 'the answer to the upload says why').toMatch(/skewed/)

    await page.goto('/viewer.html?world=default&mock=editor')
    const flagged = page.locator(`.scan-item[data-filename="${flaggedUpload.filename}"]`)
    await expect(flagged).toBeVisible({ timeout: 60_000 })
    await expect(flagged).toHaveClass(/scan-flagged/)
    await expect(flagged).toHaveAttribute('title', /skewed/)
    await expect(page.locator(`.scan-item[data-filename="${filename}"]`)).not.toHaveClass(/scan-flagged/)
  })

  test('Match to neighbour stays out of sight until a registration proposal is registered', async ({ page }) => {
    await openOnScan(page)
    await expect(page.locator('#stitch-match')).toBeHidden()
  })
})
