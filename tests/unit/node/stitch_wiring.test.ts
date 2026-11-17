/**
 * The hook sites of the stitching tools in the hub files (src/viewer/viewer.ts, server/main.ts).
 *
 * viewer.ts runs its DOM code when it is imported and server/main.ts starts the server, so neither can be
 * loaded by a test. The behaviour behind each hook is tested where it lives (stitch_session, stitch_tools_dom,
 * transform_tools; patch_validate, scan_store and patch_routes on the Deno side). What none of those can see is a hook
 * that was lost: the hub files are merged from several packages, and a dropped one-line call leaves every
 * module test green and the editor back to turning a scan about a point nobody can see. These checks read the
 * source and pin each call site, scoped to the function it sits in, in the style of wp-v3-viewer-guards.
 *
 * They pin what a hook is (a call, and which side of another call it sits on) and not how the lines around it are
 * laid out, so a package that adds a comment, a blank line or a statement beside a hook, or renames a local, does
 * not break them; the checks that read a name out of the source take it from there and do not hard-code it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/stitch_wiring.test.ts
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const viewer = read('src/viewer/viewer.ts')
const server = read('server/main.ts')

/** One top-level function, from its declaration to the closing brace at column 0. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  assert.notEqual(start, -1, name + ' is declared')
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, name + ' closes at column 0')
  return source.slice(start, end)
}

/** Where `needle` first appears in `text`, failing the test if it does not. */
function at(text: string, needle: string | RegExp, what: string): number {
  const index = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle)
  assert.notEqual(index, -1, what)
  return index
}

/** `before` is called, and `after` is called later in the same text. */
function inOrder(text: string, before: string | RegExp, after: string | RegExp, what: string): void {
  assert.ok(at(text, before, `${what}: the first call is there`) < at(text, after, `${what}: the second call is there`), what)
}

// ─── The editor ──────────────────────────────────────────────────────────────

test('every place that hands the gizmo a target goes through the pivot proxy, and none talks to the controls directly', () => {
  assert.match(fn(viewer, 'selectScan'), /attachTransformTarget\(loaded\.root\)/)
  assert.match(fn(viewer, 'selectScan'), /detachTransformTarget\(\)/)
  assert.match(fn(viewer, 'selectEditableObject'), /attachTransformTarget\(obj\)/)
  assert.match(fn(viewer, 'clearSelection'), /detachTransformTarget\(\)/)
  assert.match(fn(viewer, 'attachTransformTarget'), /if \(stitch\) stitch\.attach\(target\)\s+else transformControls\?\.attach\(target\)/)
  // The only direct attach calls left are the fallback inside that function and the test hook's own assertion.
  const direct = viewer.split('\n').filter((line) => /transformControls\?*\.attach\(/.test(line))
  assert.equal(direct.length, 1, 'transformControls.attach( appears once, in attachTransformTarget: ' + direct.join(' | '))
})

test('a rebuilt scan root is adopted after its stored patches are applied and before the scan is registered, with the root it replaces (in or out of the scene: the tools take either)', () => {
  const integrate = fn(viewer, 'integrateScanRoot')
  const adopt = /stitch\?\.adopt\(root, previous\?\.root \?\? null\)/
  inOrder(integrate, 'applyStoredPatches(root, scan)', adopt, 'adopt follows applyStoredPatches')
  inOrder(integrate, adopt, 'loadedScans.set(scan.scanId', 'adopt comes before the loaded-scan entry is replaced')
})

test('a saved transform tells the tools what was posted, and a patch reply refreshes them', () => {
  const save = fn(viewer, 'saveSelectedTransform')
  const posted = /const (\w+) = serializeTransform\(target\)/.exec(save)?.[1]
  assert.ok(posted, 'the transform that is posted is read once, into a name')
  assert.match(save, new RegExp(`transform: ?${posted}\\b|\\n\\s+${posted},\\n`), 'and that same transform is what is posted')
  inOrder(save, 'await postEditPatch(', new RegExp(`stitch\\?\\.markSaved\\(target, ${posted}\\?\\.matrix\\)`), 'markSaved names what was posted, after the post')
  const edit = fn(viewer, 'postEditPatch')
  inOrder(edit, 'world = scopeWorldToActiveProject(payload.world)', 'stitch?.refresh()', 'a patch reply refreshes the tools')
  inOrder(fn(viewer, 'refreshWorldScans'), 'renderThingsPanel()', 'stitch?.refresh()', 'a refreshed world refreshes the tools')
  inOrder(fn(viewer, 'loadWorldProject'), 'buildScanList(scopedWorld.scans)', 'stitch?.refresh()', 'a loaded world marks its scan list')
})

test('a Place switch resets the tools, a view change re-applies compare styles, and Scale is refused for a scan', () => {
  const scene = fn(viewer, 'initWorldScene')
  inOrder(scene, 'transformControls.detach()', 'stitch?.reset()', 'the old gizmo is detached before the tools forget their scans')
  inOrder(scene, 'stitch?.reset()', 'editor.setScene(scene)', 'and the tools are reset before the editor is given the new scene')
  assert.match(fn(viewer, 'applyLayerVisibility'), /stitch\?\.reapplyCompare\(\)/)
  const mode = fn(viewer, 'setTransformMode')
  assert.match(mode, /if \(mode === 'scale' && stitch\?\.blocksScale\(\)\) return/)
  inOrder(mode, "stitch?.blocksScale()", 'transformControls?.setMode(mode)', 'the refusal comes before the mode is set')
})

test('the tools are built after the renderer and before the first world load, with the editor\'s own functions', () => {
  const boot = viewer.slice(viewer.indexOf('\ninitRenderer()\n'))
  inOrder(boot, 'initRenderer()', 'initStitchTools()', 'built after the renderer')
  inOrder(boot, 'initStitchTools()', 'void loadWorldProject()', 'and before the world is loaded')
  const init = fn(viewer, 'initStitchTools')
  for (const wanted of ['applyMatrix,', 'save: (key, edit) => editSaves.save(key, edit)', 'postPlacement: postEditPatch', 'revert: postPatchRevert', 'setTransformMode,']) {
    assert.ok(init.includes(wanted), 'the host hands over ' + wanted)
  }
})

test('what the viewer hands the tools is what the tools read: the scene, the world, the loaded scans, the gizmo and every event it fires', () => {
  const init = fn(viewer, 'initStitchTools')
  const handed: Array<[string, RegExp]> = [
    ['the gizmo\'s object', /get object\(\) \{ return controls\.object \}/],
    ['the gizmo\'s mode', /get mode\(\) \{ return controls\.mode \}/],
    ['attach', /attach: \(object\) => controls\.attach\(object\)/],
    ['detach', /detach: \(\) => controls\.detach\(\)/],
    ['the rotation snap', /setRotationSnap: \(radians\) => controls\.setRotationSnap\(radians\)/],
    ['every event type, dragging-changed among them', /addEventListener: \(type, listener\) => controls\.addEventListener\(type, /],
    ['the scene', /scene: \(\) => scene,/],
    ['the world', /world: \(\) => world,/],
    ['a loaded scan', /loadedScan: \(scanId\) => loadedScans\.get\(scanId\),/],
    ['the loaded scan ids', /loadedScanIds: \(\) => \[\.\.\.loadedScans\.keys\(\)\],/],
    ['the scan an object belongs to', /scanIdOf: \(object\) => scanForObject\(object\)\?\.manifest\.scanId \?\? null,/],
    ['a change refreshes the readout and the HUD', /changed: \(\) => \{[^}]*updateTransformReadout\(\)[^}]*updateWorldHud\(\)[^}]*\}/],
  ]
  for (const [what, pattern] of handed) assert.match(init, pattern, what)
})

test('the undo goes through the module that asks for it: the Place\'s own route, the viewer\'s refusal, the Place guard, and the world kept and refreshed', () => {
  const revert = fn(viewer, 'postPatchRevert')
  assert.match(revert, /requestRevert\(\{/)
  assert.match(revert, /\/patches\/revert/)
  assert.match(revert, /encodeURIComponent\(world\.shareSlug\)/)
  assert.match(revert, /refused: httpError/)
  assert.match(revert, /stillCurrent: \(\) => gen === worldGen/)
  assert.match(revert, /world = scopeWorldToActiveProject\(answered\)/)
  inOrder(revert, 'world = scopeWorldToActiveProject(answered)', 'stitch?.refresh()', 'a kept world refreshes the tools')
  assert.match(revert, /\}, scanId, patchId\)/, 'and it is asked about the scan and the move it was given')
  assert.doesNotMatch(viewer, /isQueuedOffline/, 'the queued-offline check is in patch-revert.ts, where a test reaches it')
})

test('the anchor ring is placed from the first placement, so it follows the landmark after a move', () => {
  assert.match(fn(viewer, 'addAnchorMarker'), /sessionAnchorPositions\(\s*scan\.calibratedLocalToWorld \?\? scan\.localToWorld,/)
})

test('a patch for an object that is the scan root is not replayed as a move of the scan', () => {
  assert.match(fn(viewer, 'applyStoredPatches'), /patch\.transform\?\.matrix && target !== root\) applyMatrix\(target, patch\.transform\.matrix\)/)
})

test('the leave guard the editor already had is untouched: the tools add a second listener of their own', () => {
  const start = viewer.indexOf("window.addEventListener('beforeunload'")
  assert.notEqual(start, -1)
  const end = viewer.indexOf('\n})\n', start)
  assert.ok(!viewer.slice(start, end).includes('stitch'), 'the existing guard is not changed')
  assert.equal(viewer.split("addEventListener('beforeunload'").length - 1, 1, 'and viewer.ts adds only that one')
  assert.match(read('src/viewer/stitch-tools.ts'), /window\.addEventListener\('beforeunload'/)
})

// ─── The server ──────────────────────────────────────────────────────────────

const patchesRoute = server.slice(server.indexOf("app.post('/worlds/:slug/patches', async"), server.indexOf("app.post('/worlds/:slug/patches/revert'"))
const revertRoute = (() => {
  const start = server.indexOf("app.post('/worlds/:slug/patches/revert'")
  return server.slice(start, server.indexOf('// ── Place review comments', start))
})()

test('a patch body is capped, read as an object and checked before the world is touched, and the check cannot be skipped by scope', () => {
  assert.notEqual(patchesRoute.length, 0)
  inOrder(patchesRoute, 'denyUnlessWorldRole(c, authWorld', 'readTextCapped(c.req.raw, PLACE_JSON_MAX_BYTES)', 'the role is checked before the body is read')
  assert.match(patchesRoute, /if \(text === null\) return c\.json\(\{.*\}, 413\)/)
  assert.match(patchesRoute, /parseJsonObject\(text\)/)
  const check = /const problem = patchProblem\(\{ scope, targetId, transform: body\.transform \}, authWorld\.scans\)/
  inOrder(patchesRoute, check, 'await updateWorld(', 'the patch is checked before the world is changed')
  assert.match(patchesRoute, /if \(problem\) return c\.json\(\{ error: problem \}, 400\)/)
  assert.doesNotMatch(patchesRoute.slice(0, patchesRoute.indexOf('patchProblem(')), /scope === 'scan'/, 'no scope is let past before the check')
})

test('a patch stores only the transform parts it knows, refuses a move of a node named like a scan, and answers a client view', () => {
  assert.match(patchesRoute, /transform: cleanTransform\(body\.transform\)/)
  assert.doesNotMatch(patchesRoute, /transform: body\.transform,/, 'the request\'s own transform is never stored whole')
  assert.match(patchesRoute, /patchProblem\(\{ scope, targetId, transform: body\.transform \}, authWorld\.scans\)/, 'the scans the names are checked against are the Place\'s own')
  assert.match(patchesRoute, /world: redactWorldForClient\(world, requestToken\(c\)\)/)
  assert.doesNotMatch(patchesRoute, /return c\.json\(\{ ok: true, patch, world \}\)/, 'the raw world, with every member\'s token, is not the answer')
})

test('an upload\'s transform is set aside and flagged, never refused: no 4xx on the path that writes the sidecar', () => {
  const route = server.slice(server.indexOf("app.post('/upload-scan'"), server.indexOf('/** True for pipeline-derived artifacts'))
  const sanitise = /sanitiseUploadMetadata\(metaRaw\)/
  assert.match(route, sanitise)
  inOrder(route, sanitise, 'storeUploadedScan(', 'the metadata is sanitised before anything is stored')
  assert.match(route, /sidecar: sanitised\?\.metadata \?\? null/, 'what is stored beside the scan is the sanitised text')
  assert.doesNotMatch(route.slice(route.indexOf('sanitiseUploadMetadata')), /c\.json\([^)]*,\s*4\d\d\)/, 'no 4xx after the sidecar is sanitised')
  assert.match(route, /projectTransformRejected \? \{ projectTransformRejected \} : \{\}/)
  assert.doesNotMatch(route, /Deno\.open\(|writeTextFile\(/, 'the route does not write scan files itself: scan_store.ts does, in an order a reader cannot catch half made')
})

test('the scans a world lists are .glb files, which is what makes a scan that is still being written invisible', () => {
  const list = fn(server, 'listStoredScans')
  assert.match(list, /entry\.isFile \|\| !entry\.name\.endsWith\('\.glb'\)/)
  assert.match(read('server/world/scan_store.ts'), /PART_SUFFIX = '\.part'/)
})

test('a sidecar that is JSON but not an object is read as an empty one', () => {
  const meta = fn(server, 'readScanMeta')
  assert.match(meta, /typeof parsed === 'object' && !Array\.isArray\(parsed\)/)
  inOrder(meta, 'JSON.parse(', 'sessionForScan(', 'the sidecar is checked before anything reads a field off it')
})

test('the first placement is stamped when a world is built and on every read, ahead of any patch', () => {
  const synth = fn(server, 'synthesizeWorld')
  inOrder(synth, /stampFirstSightPlacements\(world, \(\) => undefined\)/, 'await writeWorldUnlocked(world)', 'a new world is stamped before it is written')
  const refresh = fn(server, 'refreshWorldScans')
  const stamp = /stampFirstSightPlacements\(world, \(filename\) => storedByFilename\.get\(filename\)\?\.meta\['projectTransform'\]\)/
  assert.match(refresh, stamp)
  // After the additions, so a scan first seen in this read is stamped in it, and before the world is written.
  inOrder(refresh, 'additions.map', stamp, 'stamped after the additions')
  inOrder(refresh, stamp, 'await writeWorldUnlocked(world)', 'and before the write')
  assert.match(fn(server, 'scanManifestFromStored'), /\.\.\.rejectedTransformField\(scan\.meta\)/)
})

test('the undo route is an editor action inside the world lock, reads its request strictly, and records itself like any patch', () => {
  assert.match(revertRoute, /denyUnlessWorldRole\(c, authWorld, 'editor'\)/)
  inOrder(revertRoute, 'denyUnlessWorldRole(', 'readTextCapped(c.req.raw, PLACE_JSON_MAX_BYTES)', 'the role is checked before the body is read')
  assert.match(revertRoute, /const request = parseRevertRequest\(text\)/)
  assert.match(revertRoute, /if \(!request\.ok\) return c\.json\(\{ error: request\.message \}, 400\)/)
  inOrder(revertRoute, 'parseRevertRequest(', 'await updateWorld(', 'the request is read before the world is changed')
  assert.match(revertRoute, /planRevert\(world, \{ scanId: request\.scanId, patchId: request\.patchId \}\)/)
  assert.match(revertRoute, /throw new PlacementRefused\(plan\.status, plan\.message\)/)
  inOrder(revertRoute, 'world.editPatches.push(patch)', 'applyPatchToWorld(world, patch)', 'the undo is recorded and then applied')
  assert.match(revertRoute, /redactWorldForClient\(world, requestToken\(c\)\)/)
  assert.match(revertRoute, /error instanceof PlacementRefused\) return c\.json\(\{ error: error\.message \}, error\.status\)/)
})

test('the one-line gates the viewer and the server import are the shared, Deno-free modules (ADR 0002)', () => {
  for (const file of ['src/world/scan-placement.ts', 'src/viewer/transform-tools.ts', 'src/viewer/stitch-session.ts', 'src/viewer/compare-style.ts', 'src/viewer/stitch-tools.ts', 'server/world/patch_validate.ts']) {
    assert.doesNotMatch(read(file), /\bDeno\./, file + ' has no Deno reference')
  }
  assert.match(read('server/world/patch_validate.ts'), /from '\.\.\/\.\.\/src\/world\/scan-placement\.ts'/)
  assert.doesNotMatch(read('src/viewer/stitch-tools.ts'), /from '\.\.\/\.\.\/server/, 'the editor does not import from the server tree')
})
