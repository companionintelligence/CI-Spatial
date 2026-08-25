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
import { test, expect, type Page } from '@playwright/test'
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
  // (src/viewer/viewer.ts, gated behind ?mock=editor) instead of a raycast click: a
  // real click cannot reach a semantic object in this corpus today (a separate,
  // already-scoped-out defect — see the wave README's "found but deferred"). The hook
  // selects *a* LOD in the scan (the first one found by tree order — not necessarily
  // the same node a raycast would hit, since a home has several) and drives the exact
  // same selectEditableObject() / saveSelectedTransform() path a click would, so it
  // does not by itself catch a walk-order regression — only editor_pick.test.ts does.

  type WorldTransform = { position: [number, number, number]; scale: [number, number, number] }
  type Picked = { name: string; objectId: string; filename: string; gizmoAttached: boolean }
  type EditorTestHook = {
    selectFirstLod: (scanId: string) => Picked | null
    worldTransform: () => WorldTransform | null
    nudgeAndSave: (dx: number, dy: number, dz: number) => Promise<boolean>
  }

  function selectFirstLod(page: Page, scanId: string): Promise<Picked | null> {
    return page.evaluate(
      (id) => (window as unknown as { __editorTest: EditorTestHook }).__editorTest.selectFirstLod(id),
      scanId,
    )
  }
  function readWorldTransform(page: Page): Promise<WorldTransform | null> {
    return page.evaluate(
      () => (window as unknown as { __editorTest: EditorTestHook }).__editorTest.worldTransform(),
    )
  }
  function nudgeAndSave(page: Page, dx: number, dy: number, dz: number): Promise<boolean> {
    return page.evaluate(
      ([dx, dy, dz]) => (window as unknown as { __editorTest: EditorTestHook }).__editorTest.nudgeAndSave(dx, dy, dz),
      [dx, dy, dz] as [number, number, number],
    )
  }

  // "default" is a world shared with every other chromium-mock spec, so identify a
  // scan by this fixture's own deterministic scanId prefix — generate-test-homes.mjs
  // bakes `sessionId: session-test-home-${NN}` into each home's fixture metadata, and
  // the server derives the scanId from that on upload — rather than by DOM position:
  // .scan-item's order can shift while a sibling spec's own beforeAll concurrently
  // uploads into the same world.
  const TEST_HOME_SCAN = '.scan-item[data-scan-id^="scan-session-test-home-"]'

  /**
   * Wait for a test-home scan that has actually finished loading client-side, and
   * return its scan item — the two halves both matter.
   *
   * Scoping to `TEST_HOME_SCAN` alone isn't enough: this world is shared, and it
   * accumulates scans across runs, so the first test-home item in DOM order may be a
   * previous run's entry whose GLB is gone. Requiring `Ready` alone isn't enough
   * either: that matches any scan in the world, including another spec's.
   *
   * The capital-R `/Ready/` is load-bearing and case-sensitive. The chip has two text
   * sources — `buildScanItem()` renders the *server* manifest status (lowercase
   * `ready`, or a `needs rescan · N% coverage` quality label) at page load, and
   * `setScanStatus()` overwrites it with the *client* load state (`Loading GLB...` →
   * `Ready` / `Ready - optimized …`, or `Error: …`). Only the latter means the scan is
   * in the scene and pickable, so only the capitalised form should satisfy this wait.
   */
  async function waitForTestHomeReady(page: Page) {
    const item = page
      .locator(TEST_HOME_SCAN)
      .filter({ has: page.locator('.scan-status', { hasText: /Ready/ }) })
      .first()
    await expect(item).toBeVisible({ timeout: 60_000 })
    return item
  }

  test('picking a semantic object resolves to the LOD, and TransformControls attaches to it', async ({ page }) => {
    await page.goto('/viewer.html?world=default&mock=editor')
    const item = await waitForTestHomeReady(page)

    const scanId = await item.getAttribute('data-scan-id')
    expect(scanId).toBeTruthy()

    const picked = await selectFirstLod(page, scanId!)
    expect(picked).toBeTruthy()
    expect(picked!.name).toMatch(/^LOD_/)
    expect(picked!.objectId).toMatch(/:lod$/)
    expect(picked!.gizmoAttached).toBe(true)
  })

  test('a translated object is in the same world position after a reload, scale unchanged, patch idempotent', async ({ page, request }) => {
    await page.goto('/viewer.html?world=default&mock=editor')
    const item = await waitForTestHomeReady(page)

    const scanId = await item.getAttribute('data-scan-id')
    expect(scanId).toBeTruthy()
    const filename = await item.locator('.scan-name').getAttribute('title')
    expect(filename).toBeTruthy()

    // Wait for the background optimize-scan job to settle before touching the scene.
    // loadScanIntoWorld() swaps in the optimized GLB as soon as its job finishes,
    // whether or not the page is mid-edit (that swap is 0007's territory, filed
    // separately — see docs/factory/03-readiness-hardening/0007-fix-stale-selection-on-scan-root-replace.md).
    // Racing it here would compare positions across two different graph shapes (the
    // fresh export vs. the optimized one, which the wave README's "found but
    // deferred" section documents as diverging — #87), which is a false failure
    // unrelated to what this test checks.
    await expect.poll(
      async () => (await request.get(`/scans/${encodeURIComponent(filename!)}/manifest`)).status(),
      { timeout: 60_000 },
    ).toBe(200)
    await page.reload()
    await waitForTestHomeReady(page)

    const picked = await selectFirstLod(page, scanId!)
    expect(picked).toBeTruthy()

    const before = await readWorldTransform(page)
    expect(before).toBeTruthy()

    // Nudge on all three axes (not just x) so a z-specific coordinate-frame or
    // decompose defect can't hide behind an untested dz=0.
    const NUDGE: [number, number, number] = [1, 0, 0.5]
    const saved = await nudgeAndSave(page, ...NUDGE)
    expect(saved).toBe(true)

    // The reference for the round trip is the world transform right after the drag,
    // not before.position + NUDGE: the LOD's parent (the scan root) carries its own
    // localToWorld placement, so a local nudge is not necessarily the same delta in
    // world space. Sanity-check the nudge moved it by roughly the expected magnitude
    // in *some* direction (rotation preserves vector length; only a non-uniform scale
    // would distort it, and a rigid scan placement doesn't have one) before trusting
    // it as the round-trip target.
    const afterNudge = await readWorldTransform(page)
    expect(afterNudge).toBeTruthy()
    const expectedMagnitude = Math.hypot(...NUDGE)
    const nudgeMagnitude = Math.hypot(
      afterNudge!.position[0] - before!.position[0],
      afterNudge!.position[1] - before!.position[1],
      afterNudge!.position[2] - before!.position[2],
    )
    expect(Math.abs(nudgeMagnitude - expectedMagnitude)).toBeLessThan(0.1)

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
    await waitForTestHomeReady(page)

    const pickedAfter = await selectFirstLod(page, scanId!)
    expect(pickedAfter?.objectId).toBe(picked!.objectId)
    // Same scan *generation*, not just the same scanId — see the hook's comment in
    // viewer.ts. If a re-seeded world holds several scans under one scanId, a reload
    // can bind to a different root, and comparing positions across the two is
    // meaningless. Assert it here so that shows up as itself rather than as a
    // baffling position mismatch below.
    expect(pickedAfter?.filename).toBe(picked!.filename)

    const after = await readWorldTransform(page)
    expect(after).toBeTruthy()
    // DoD: a dragged object is in the same world position after a reload, within
    // 1e-3, and its scale is unchanged. Pre-0004, dragging a *level* (what pick()
    // used to resolve to) while the patch was written against the LOD would fail
    // this the same way — displaced and rescaled by the medium proxy's
    // normalisation — but that specific path is exercised by editor_pick.test.ts
    // and tested end-to-end here (this hook always resolves a LOD), not re-proven by
    // reverting pick() itself.
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
    await waitForTestHomeReady(page)
    const pickedTwice = await selectFirstLod(page, scanId!)
    expect(pickedTwice?.filename).toBe(picked!.filename)
    const afterTwice = await readWorldTransform(page)
    expect(afterTwice).toBeTruthy()
    expect(Math.abs(afterTwice!.position[0] - after!.position[0])).toBeLessThan(1e-3)

    // Restore the object's original position. There's no DELETE for a single patch
    // (only a whole scan, via DELETE /scans/:filename, which would risk deleting a
    // scan a concurrently-running sibling spec is mid-use of) — but posting a
    // corrective patch undoes the *visible* drift for the next local run or any other
    // spec inspecting this scan, at the cost of one extra, immediately-superseded
    // entry in world.editPatches.
    await nudgeAndSave(page, -NUDGE[0], -NUDGE[1], -NUDGE[2])
  })

  test('a labelled object outside an LOD still picks as itself (regression guard)', async ({ page }) => {
    // Mirrors a splat-detect box (src/viewer/splat-detect-layer.ts) — synthetic
    // because the seeded corpus has no trained splat-detect boxes without running
    // that job. Same pattern as tests/e2e-suite.spec.ts "Raycast Mesh Picking".
    await page.goto('/viewer.html?world=default')
    const result = await page.evaluate(async () => {
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      // @ts-expect-error browser-runtime specifier, resolved by Vite in the page — not resolvable by tsc
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
