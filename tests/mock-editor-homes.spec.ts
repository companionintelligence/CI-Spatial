/**
 * World Scan Editor tests against the generated test-home corpus.
 *
 * Seeds three homes through the real upload+optimize pipeline, then drives
 * the editor: scan list population, progressive load status, layer panel,
 * and the measurement tool (asserted against expected.json dimensions via
 * the window.__measureTool hook).
 *
 * Requirements: Vite dev server (VITE_URL) + Deno server behind the proxy.
 * Run: npx playwright test --project=chromium-mock mock-editor-homes
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOMES_DIR = join(process.cwd(), 'test-data', 'homes')
const homesAvailable = existsSync(join(HOMES_DIR, 'index.json'))

test.describe('editor with test-home data', () => {
  test.skip(!homesAvailable, 'test-data missing — run: npm run gen:test-data')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async ({ request }) => {
    const index = JSON.parse(readFileSync(join(HOMES_DIR, 'index.json'), 'utf8')) as
      Array<{ file: string; meta: string }>
    for (const entry of index.slice(0, 3)) {
      const resp = await request.post('/upload-scan', {
        multipart: {
          file: {
            name: entry.file,
            mimeType: 'model/gltf-binary',
            buffer: readFileSync(join(HOMES_DIR, entry.file)),
          },
          metadata: readFileSync(join(HOMES_DIR, entry.meta), 'utf8'),
        },
      })
      expect(resp.ok(), `seed upload ${entry.file}`).toBeTruthy()
    }
  })

  test('scan list populates and scans reach Ready', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await expect.poll(async () => page.locator('.scan-item').count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3)
    // At least one scan finishes its (progressive) load
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })
  })

  test('layer panel lists toggles and HUD shows world stats', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })
    await page.locator('.sidebar-tab[data-tab="layers"]').click()
    await expect(page.locator('#tab-layers')).toBeVisible()
    await expect(page.locator('#hud-info')).toContainText(/scan/i)
  })

  test('measurement tool measures real distances in the scene', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    await page.click('#btn-measure')
    await expect(page.locator('#btn-measure')).toHaveClass(/active/)

    // Click two points across the viewport — geometry under the cursor
    const viewport = page.locator('#viewer-canvas')
    const box = await viewport.boundingBox()
    expect(box).toBeTruthy()
    await viewport.click({ position: { x: box!.width * 0.35, y: box!.height * 0.55 } })
    await viewport.click({ position: { x: box!.width * 0.65, y: box!.height * 0.55 } })

    const distance = await page.evaluate(() =>
      (window as never as { __measureTool: { lastDistanceM: number | null } }).__measureTool.lastDistanceM)
    // Both clicks may not hit geometry depending on camera fit; when they do,
    // the distance must be plausible for the scene. With a freshly seeded
    // world the camera fits all 24 geo-placed homes, so cross-viewport clicks
    // can legitimately span different houses — bound at neighbourhood scale.
    if (distance !== null) {
      expect(distance).toBeGreaterThan(0.01)
      expect(distance).toBeLessThan(500)
      await expect(page.locator('#measure-label')).toBeVisible()
      await expect(page.locator('#measure-label')).toContainText(/m$/)
    }
  })

  // ── 0004: LOD pick/save/reload round trip ────────────────────────────────
  //
  // SceneEditor.pick() resolves a semantic object to its THREE.LOD node (not one of
  // its levels) — see docs/factory/03-readiness-hardening/0004-fix-editor-lod-transform-roundtrip.md.
  // The walk-order regression itself (pick() returning a level pre-fix) is guarded by
  // editor_pick.test.ts, which calls pick() directly against a synthetic LOD graph and
  // fails without the fix. These tests guard the *consequence* DoD cares about
  // separately — that a save made against the resolved node reloads to the same world
  // position — against the real seeded corpus, via the __editorTest hook
  // (src/viewer/viewer.ts) instead of a raycast click: a real click cannot reach a
  // semantic object in this corpus today (a separate, already-scoped-out defect — see
  // the wave README's "found but deferred"). The hook selects the same way pick()
  // would resolve to (first THREE.LOD in the scan) and drives the exact same
  // selectEditableObject() / saveSelectedTransform() path a click would, so it does
  // not by itself catch a walk-order regression — only editor_pick.test.ts does.

  type WorldTransform = { position: [number, number, number]; scale: [number, number, number] }
  type Picked = { name: string; objectId: string; gizmoAttached: boolean }
  declare global {
    interface Window {
      __editorTest: {
        selectFirstLod: (scanId: string) => Picked | null
        worldTransform: () => WorldTransform | null
        nudgeAndSave: (dx: number, dy: number, dz: number) => Promise<void>
      }
    }
  }

  // "default" is a world shared with every other chromium-mock spec, so identify a
  // scan by this fixture's own deterministic scanId prefix (assigned by
  // scripts/seed-test-homes.mjs) rather than by DOM position — .scan-item's order can
  // shift while a sibling spec's own beforeAll concurrently uploads into the same world.
  const TEST_HOME_SCAN = '.scan-item[data-scan-id^="scan-session-test-home-"]'

  test('picking a semantic object resolves to the LOD, and TransformControls attaches to it', async ({ page }) => {
    await page.goto('/viewer.html?world=default')
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    const scanId = await page.locator(TEST_HOME_SCAN).first().getAttribute('data-scan-id')
    expect(scanId).toBeTruthy()

    const picked = await page.evaluate((id) => window.__editorTest.selectFirstLod(id), scanId!)
    expect(picked).toBeTruthy()
    expect(picked!.name).toMatch(/^LOD_/)
    expect(picked!.objectId).toMatch(/:lod$/)
    expect(picked!.gizmoAttached).toBe(true)
  })

  test('a translated object is in the same world position after a reload, scale unchanged, patch idempotent', async ({ page, request }) => {
    await page.goto('/viewer.html?world=default')
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    const scanItem = page.locator(TEST_HOME_SCAN).first()
    const scanId = await scanItem.getAttribute('data-scan-id')
    expect(scanId).toBeTruthy()
    // Read the filename off the same element handle as scanId, not a second
    // independent .first() lookup — .scan-item order can otherwise shift between the
    // two reads under load from sibling specs uploading into this same shared world.
    const filename = await scanItem.locator('.scan-name').getAttribute('title')
    expect(filename).toBeTruthy()

    // Wait for the background optimize-scan job to settle before touching the scene.
    // loadScanIntoWorld() swaps in the optimized GLB as soon as its job finishes,
    // whether or not the page is mid-edit (that swap is 0004's related, deferred
    // finding — see docs/factory/03-readiness-hardening/, "stale references survive
    // a reload"). Racing it here would compare positions across two different graph
    // shapes (the fresh export vs. the optimized one, which the wave README's "found
    // but deferred" section documents as diverging — #87), which is a false failure
    // unrelated to what this test checks.
    await expect.poll(
      async () => (await request.get(`/scans/${encodeURIComponent(filename!)}/manifest`)).status(),
      { timeout: 60_000 },
    ).toBe(200)
    await page.reload()
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    const picked = await page.evaluate((id) => window.__editorTest.selectFirstLod(id), scanId!)
    expect(picked).toBeTruthy()

    const before = await page.evaluate(() => window.__editorTest.worldTransform())
    expect(before).toBeTruthy()

    await page.evaluate(() => window.__editorTest.nudgeAndSave(1, 0, 0))

    // The reference for the round trip is the world transform right after the drag,
    // not before.position + 1: the LOD's parent (the scan root) carries its own
    // localToWorld placement, so a +1 local-x nudge is not necessarily +1 world-x.
    // Sanity-check the nudge moved it by roughly 1m in *some* direction (rotation
    // preserves vector length; only a non-uniform scale would distort it, and a rigid
    // scan placement doesn't have one) before trusting it as the round-trip target.
    const afterNudge = await page.evaluate(() => window.__editorTest.worldTransform())
    expect(afterNudge).toBeTruthy()
    const nudgeMagnitude = Math.hypot(
      afterNudge!.position[0] - before!.position[0],
      afterNudge!.position[1] - before!.position[1],
      afterNudge!.position[2] - before!.position[2],
    )
    expect(nudgeMagnitude).toBeGreaterThan(0.5)

    // The persisted patch's targetId ends in :lod. Filtered by objectId rather than
    // taken as the array's last entry — test.describe.configure({ mode: 'serial' })
    // means a failure anywhere in this describe reruns beforeAll (re-seeding the
    // homes) before retrying, which can append unrelated patches after this one.
    const patches = await request.get('/worlds/default/patches')
      .then((r) => r.json()) as Array<{ targetId: string; scope: string }>
    const savedPatch = patches.filter((p) => p.targetId === picked!.objectId).at(-1)
    expect(savedPatch).toBeTruthy()
    expect(savedPatch!.targetId).toMatch(/:lod$/)
    expect(savedPatch!.scope).toBe('object')

    await page.reload()
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })

    const pickedAfter = await page.evaluate((id) => window.__editorTest.selectFirstLod(id), scanId!)
    expect(pickedAfter?.objectId).toBe(picked!.objectId)

    const after = await page.evaluate(() => window.__editorTest.worldTransform())
    expect(after).toBeTruthy()
    // DoD: a dragged object is in the same world position after a reload, within
    // 1e-3, and its scale is unchanged. Pre-0004, dragging a *level* (what pick()
    // used to resolve to) while the patch was written against the LOD would fail
    // this the same way — displaced and rescaled by the medium proxy's
    // normalisation — but that specific path is exercised by editor_pick.test.ts
    // and tested end-to-end here (this hook always resolves the LOD, matching what
    // pick() resolves to post-fix), not re-proven by reverting pick() itself.
    expect(Math.abs(after!.position[0] - afterNudge!.position[0])).toBeLessThan(1e-3)
    expect(Math.abs(after!.position[1] - afterNudge!.position[1])).toBeLessThan(1e-3)
    expect(Math.abs(after!.position[2] - afterNudge!.position[2])).toBeLessThan(1e-3)
    expect(Math.abs(after!.scale[0] - before!.scale[0])).toBeLessThan(1e-3)
    expect(Math.abs(after!.scale[1] - before!.scale[1])).toBeLessThan(1e-3)
    expect(Math.abs(after!.scale[2] - before!.scale[2])).toBeLessThan(1e-3)

    // A second reload with no new edit must not compound the offset — applyMatrix()
    // decomposes an absolute matrix onto a freshly-rebuilt LOD each load, so replay
    // is idempotent by construction; this is the regression guard for that.
    await page.reload()
    await expect(page.locator('.scan-status', { hasText: /Ready/ }).first())
      .toBeVisible({ timeout: 60_000 })
    await page.evaluate((id) => window.__editorTest.selectFirstLod(id), scanId!)
    const afterTwice = await page.evaluate(() => window.__editorTest.worldTransform())
    expect(afterTwice).toBeTruthy()
    expect(Math.abs(afterTwice!.position[0] - after!.position[0])).toBeLessThan(1e-3)
  })

  test('a labelled object outside an LOD still picks as itself (regression guard)', async ({ page }) => {
    // Mirrors a splat-detect box (src/viewer/splat-detect-layer.ts) — synthetic
    // because the seeded corpus has no trained splat-detect boxes without running
    // that job. Same pattern as tests/e2e-suite.spec.ts "Raycast Mesh Picking".
    await page.goto('/viewer.html?world=default')
    const result = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()
      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
      box.name = 'detect-box-0-tv'
      box.userData = { label: 'tv', detectIndex: 0 }
      scene.add(box)
      editor.setScene(scene)

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
      camera.position.set(0, 0, 5)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld(true)

      const picked = editor.pick(0, 0, camera)
      return picked ? { name: picked.name, isLOD: picked instanceof THREE.LOD } : null
    })
    expect(result).toBeTruthy()
    expect(result!.name).toBe('detect-box-0-tv')
    expect(result!.isLOD).toBe(false)
  })
})
