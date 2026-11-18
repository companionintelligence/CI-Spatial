/**
 * What stays on screen after a calibration, and what goes when the calibration it describes does not hold any more.
 *
 * The ticket (docs/factory/12-origin-calibration-v1/0001-origin-decal-and-persisted-ground-height.md, and its README)
 * keeps ONE thing up for the whole scan: the floor grid (owner decision R10), dimmed, "re-committing replaces it, so it
 * never stacks". It is the ground and not a claim about the calibration, so a calibration dropped with the scan still
 * going (a Place frame that lost a conflict) leaves it. It is kept FOR A SCAN, though, and goes with the scan: the
 * ticket's acceptance criterion is "Given a skip, then no `calibration origin` and no `calibration floor plane`
 * remain" (DEVICE_TESTING O9: "The floor grid is removed with the flow"), and a re-anchor begins a scan in another
 * frame, where the old grid would stand at session coordinates the shift moved.
 * Everything else a commit draws is a claim about the calibration: the origin decal and its north tick,
 * the stored origin beside it on a return visit, the check point's marker, the rings and gap lines where the Place's
 * stored points land, and the HUD's frame-heading needle and label. The ticket says the needle "stays hidden after a
 * one-point commit, a skip, or a commit with no compass fix", and re-anchor's contract
 * (src/ar/reanchor-host.ts) says the new scan "has none [no calibration] until the next step makes one".
 *
 * Until now only a later commit by the SAME names replaced anything, and nothing took anything down:
 *
 *  - after "Re-anchor", then "Continue uncalibrated", the old origin, check marker, ghost rings and floor grid were still
 *    drawn at the old frame's session coordinates (and while the next flow ran, the old grid stood beside that flow's
 *    own), and the HUD still read "frame heading N" beside a status line saying there is no alignment (the same after a
 *    Place frame that lost a conflict, which drops the calibration too, but not the grid: the scan is the same one);
 *  - each return-visit commit ADDED its ghost rings and gap lines to the ones the commit before it had left;
 *  - a commit with no check point left the check marker an earlier commit had drawn.
 *
 * The scene is the provider's, created once, and every flow here is run into ONE scene the way a re-anchor runs the
 * modal again on it. What a later commit must leave is checked against the only oracle that needs no opinion about
 * which objects exist: the scene a fresh page would hold after that commit alone.
 *
 * The HUD needle is main.ts's, and main.ts runs a whole app when it is loaded, so its functions (the needle, and the one
 * that takes a calibration's drawings down) are read out of the source, stripped of their types and run against a
 * stand-in document and the real scene code, and the places that drop a calibration are held to the rule by reading
 * the source, as tests/unit/node/wp-09b-wiring.test.ts does for the rest of the page.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/origin_lifecycle.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { buildAnchorMarker } from '../../../src/world/anchor-marker.ts'
import { originDecalPlan } from '../../../src/world/geo.ts'
import { buildOriginDecal } from '../../../src/world/origin-decal.ts'
import { drawStoredConstellation, GHOST_GAP_NAME, GHOST_NAME } from '../../../src/ar/constellation-ghosts.ts'
import type { GhostPoint } from '../../../src/ar/constellation-flow.ts'
import {
  calibrateFirst,
  constellation,
  countAnywhere,
  countNamed,
  namesIn,
  nudge,
  revisit,
  startFlow,
  withdrawCalibrationDrawings,
  type Enu,
  type Spots,
} from './origin_rig.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MAIN = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')

const LANDMARK_AT: Enu = { east: 1.5, north: -2, up: -1.2 }
const SPOTS: Spots = constellation(LANDMARK_AT, 70, 2.4)
/** The same spots, as a return visit's three taps land on them: a few centimetres off, so the fit has residuals to draw. */
const RETAPPED: Spots = {
  landmark: nudge(SPOTS.landmark, 0.03, -0.02),
  marker: nudge(SPOTS.marker, -0.04, 0.05),
  check: nudge(SPOTS.check, 0.02, 0.04),
}
/** A second session that started facing somewhere else: a return visit never shares the first one's frame. */
const FIRST = { psi: 20, turn: 10, down: 30 }
const SECOND = { psi: 215, turn: -35, down: 20 }

const FLOOR = 'calibration floor plane'
const ORIGIN = 'calibration origin'
const STORED_ORIGIN = 'calibration stored origin'
const CHECK_MARKER = 'calibration anchor check'

/** What a scene holds, ordered, so two scenes can be compared as sets of names. */
const sortedNames = (scene: THREE.Object3D): string[] => [...namesIn(scene)].sort()

// ── What takes a calibration's drawings down ─────────────────────────────────

/** A scene holding everything a return-visit commit leaves, and a flow that is still running beside it. */
function sceneAfterACommit() {
  const scene = new THREE.Scene()
  const plan = originDecalPlan({ x: 1, y: -1.2, z: -2 }, { x: 3, y: -1.2, z: 1 }, 40)
  const grid = new THREE.GridHelper(10, 20)
  grid.name = FLOOR
  const check = buildAnchorMarker(null)
  check.name = CHECK_MARKER
  scene.add(grid, buildOriginDecal(plan, 'committed'), buildOriginDecal(plan, 'stored'), check)
  const ghosts: GhostPoint[] = [
    { role: 'landmark', tap: { x: 1, y: -1.2, z: -2 }, ghost: { x: 1.03, y: -1.2, z: -2 }, residualM: 0.03 },
    { role: 'heading', tap: { x: 3, y: -1.2, z: 1 }, ghost: { x: 3, y: -1.2, z: 1.05 }, residualM: 0.05 },
  ]
  drawStoredConstellation(scene, ghosts)
  // The flow's own layer, which belongs to a flow that is running and is not a calibration's: its group, and its own ghosts and grid.
  const placement = new THREE.Group()
  placement.name = 'calibration placement'
  const live = new THREE.Group()
  drawStoredConstellation(live, ghosts)
  const liveGrid = new THREE.GridHelper(10, 20)
  liveGrid.name = FLOOR
  placement.add(live, liveGrid)
  scene.add(placement)
  return { scene, placement, live, liveGrid }
}

test('withdrawing a calibration takes down its origin, stored origin, check marker and ghosts, and keeps the floor grid', () => {
  const { scene } = sceneAfterACommit()
  assert.deepEqual(
    sortedNames(scene),
    [CHECK_MARKER, FLOOR, GHOST_GAP_NAME, GHOST_GAP_NAME, GHOST_NAME, GHOST_NAME, ORIGIN, STORED_ORIGIN, 'calibration placement'].sort(),
    'the scene holds what a commit leaves',
  )
  withdrawCalibrationDrawings(scene)
  assert.deepEqual(sortedNames(scene), [FLOOR, 'calibration placement'].sort(), 'the ground stays (owner R10), and a flow that is running is not touched')
  withdrawCalibrationDrawings(scene, { floor: false })
  assert.deepEqual(sortedNames(scene), [FLOOR, 'calibration placement'].sort(), 'asking for the grid to stay is the same as not asking')
})

test('withdrawing with the floor takes the kept grid down too, and a running flow\'s own grid is not that grid', () => {
  const { scene, placement, liveGrid } = sceneAfterACommit()
  assert.equal(countAnywhere(scene, FLOOR), 2, 'the kept grid, and the grid of the flow that is running beside it')
  withdrawCalibrationDrawings(scene, { floor: true })
  assert.deepEqual(namesIn(scene), ['calibration placement'], 'nothing a commit left is still there')
  assert.equal(liveGrid.parent, placement, 'the flow\'s own grid, under its placement group, is still in it')
  assert.equal(countAnywhere(scene, FLOOR), 1, 'and it is the only grid left')
})

test('withdrawing leaves a running flow\'s own ghosts and grid alone, and frees what it removes', () => {
  for (const { options, gridGoes } of [{ options: {}, gridGoes: false }, { options: { floor: true }, gridGoes: true }]) {
    const { scene, placement, live, liveGrid } = sceneAfterACommit()
    let geometries = 0
    let freed = 0
    for (const child of scene.children) {
      if (child.name === 'calibration placement') continue
      // The kept grid is freed only when the call asks for it to go.
      if (child.name === FLOOR && !gridGoes) continue
      child.traverse((node) => {
        const geometry = (node as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
        if (!geometry) return
        geometries++
        geometry.addEventListener('dispose', () => freed++)
      })
    }
    assert.ok(geometries >= 10, `the commit's drawings hold geometry to free (${geometries})`)
    withdrawCalibrationDrawings(scene, options)
    assert.equal(freed, geometries, `every geometry of what was taken down is freed (${JSON.stringify(options)})`)
    assert.equal(placement.parent, scene)
    assert.equal(live.children.length, 4, 'the flow\'s own two rings and two gap lines are still there')
    assert.equal(liveGrid.parent, placement)
  }
})

test('withdrawing from no scene, or an empty one, does nothing', () => {
  for (const options of [{}, { floor: true }]) {
    withdrawCalibrationDrawings(null, options)
    withdrawCalibrationDrawings(undefined, options)
    const scene = new THREE.Scene()
    withdrawCalibrationDrawings(scene, options)
    assert.deepEqual(namesIn(scene), [])
    withdrawCalibrationDrawings(scene, options)
    assert.deepEqual(namesIn(scene), [])
  }
})

// ── A later commit replaces everything the earlier one drew ──────────────────

test('ghost rings and gap lines do not stack: a second return-visit commit leaves the rings of that commit alone', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  assert.equal(countNamed(scene, GHOST_NAME), 0, 'a first calibration has no stored points to draw')

  await revisit(t, { ...SECOND, scene }, frame, RETAPPED)
  const afterOne = { rings: countNamed(scene, GHOST_NAME), gaps: countNamed(scene, GHOST_GAP_NAME) }
  assert.equal(afterOne.rings, 3, 'a ring where each of the Place\'s three points lands')
  assert.ok(afterOne.gaps >= 1, 'and a line to each ring the person missed by a millimetre or more')

  await revisit(t, { ...FIRST, psi: 301, scene }, frame, RETAPPED)
  assert.deepEqual({ rings: countNamed(scene, GHOST_NAME), gaps: countNamed(scene, GHOST_GAP_NAME) }, afterOne, 'the rings of the earlier commit are gone, not beside the new ones')
})

test('a commit with no check point does not keep the check marker an earlier commit drew', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  assert.equal(countNamed(scene, CHECK_MARKER), 1, 'the first calibration marks where its check point went')

  // The return visit the person re-anchors into: it asks for the check point by itself, and they skip it.
  await revisit(t, { ...SECOND, scene }, frame, RETAPPED, { skipCheck: true })
  assert.equal(countNamed(scene, CHECK_MARKER), 0, 'this commit took no check point, so no marker of one stands on the floor')
})

test('after any number of commits the scene is what the last one alone would draw', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  await revisit(t, { ...SECOND, scene }, frame, RETAPPED)
  await revisit(t, { ...FIRST, psi: 301, scene }, frame, RETAPPED, { skipCheck: true })
  await revisit(t, { ...SECOND, psi: 88, scene }, frame, RETAPPED)

  // The scene a page that had made only that last commit would hold.
  const fresh = new THREE.Scene()
  await revisit(t, { ...SECOND, psi: 88, scene: fresh }, frame, RETAPPED)
  assert.deepEqual(sortedNames(scene), sortedNames(fresh))
  assert.equal(countNamed(scene, GHOST_NAME), 3)
  assert.equal(countNamed(scene, STORED_ORIGIN), 1)
  assert.equal(countNamed(scene, ORIGIN), 1)
  assert.equal(countNamed(scene, FLOOR), 1, 'the grid, replaced and not stacked: the ticket\'s "re-committing replaces it"')
})

test('a one-point commit after a return visit takes the return visit\'s stored points, stored origin and check marker down with it', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  await revisit(t, { ...SECOND, scene }, frame, RETAPPED)
  assert.equal(countNamed(scene, STORED_ORIGIN), 1)

  const one = await startFlow(t, { ...FIRST, psi: 140, scene })
  await one.tap(one.physical(LANDMARK_AT))
  one.press('project-calibration-fallback')
  const result = await one.finish()
  assert.equal(result?.calibration.method, 'ground-tap-compass')
  assert.deepEqual(sortedNames(scene), [FLOOR, ORIGIN], 'one origin on the ground and the grid under it: the earlier commit\'s other drawings describe a frame that is not this one')
})

test('a withdrawn calibration leaves only the floor grid, and the next commit draws everything again', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  await revisit(t, { ...SECOND, scene }, frame, RETAPPED)
  const drawn = sortedNames(scene)
  assert.ok(drawn.length > 3)

  withdrawCalibrationDrawings(scene)
  assert.deepEqual(namesIn(scene), [FLOOR])

  await revisit(t, { ...FIRST, psi: 301, scene }, frame, RETAPPED)
  assert.deepEqual(sortedNames(scene), drawn)
})

// ── The HUD needle ───────────────────────────────────────────────────────────

/** The source of a function of main.ts, from its signature to the line that closes it at the same indent. */
function mainFunction(signature: string, indent = ''): string {
  const start = MAIN.indexOf(signature)
  assert.ok(start >= 0, `main.ts has no \`${signature}\``)
  const end = MAIN.indexOf(`\n${indent}}\n`, start)
  assert.ok(end > start, `\`${signature}\` has no end at its indent`)
  return MAIN.slice(start, end + 2 + indent.length)
}

/** The needle function as the browser runs it: main.ts's own source, its types erased, over a document of the test's. */
function needleOver(document: { getElementById(id: string): FakeNode | null }): (bearingDeg: number | null) => void {
  const source = stripTypeScriptTypes(mainFunction('function setFrameHeadingNeedle('))
  return new Function('document', `${source}\nreturn setFrameHeadingNeedle`)(document) as (bearingDeg: number | null) => void
}

interface FakeNode { style: Record<string, string>; textContent: string }

/** The two HUD nodes as index.html leaves them: hidden, until a frame heading is shown. */
function hud() {
  const nodes: Record<string, FakeNode> = {
    'compass-frame-needle': { style: { display: 'none', transform: '' }, textContent: '' },
    'geo-frame': { style: { display: 'none' }, textContent: '' },
  }
  return { nodes, needle: needleOver({ getElementById: (id: string) => nodes[id] ?? null }) }
}

test('the frame-heading needle turns clockwise by the bearing, as the device needle does, and says it in degrees', () => {
  const { nodes, needle } = hud()
  needle(235)
  assert.equal(nodes['compass-frame-needle']!.style['display'], '')
  assert.equal(nodes['compass-frame-needle']!.style['transform'], 'rotate(235deg)')
  assert.equal(nodes['geo-frame']!.style['display'], '')
  assert.equal(nodes['geo-frame']!.textContent, 'frame heading 235°')
})

test('the frame-heading needle is hidden by no bearing, and shown again by the next', () => {
  const { nodes, needle } = hud()
  needle(10)
  needle(null)
  assert.equal(nodes['compass-frame-needle']!.style['display'], 'none')
  assert.equal(nodes['geo-frame']!.style['display'], 'none')
  needle(95)
  assert.equal(nodes['compass-frame-needle']!.style['display'], '')
  assert.equal(nodes['geo-frame']!.textContent, 'frame heading 95°')
})

test('a bearing that rounds up to 360 reads 0, as the compass readout beside it does', () => {
  const { nodes, needle } = hud()
  needle(359.6)
  assert.equal(nodes['geo-frame']!.textContent, 'frame heading 0°')
  needle(359.4)
  assert.equal(nodes['geo-frame']!.textContent, 'frame heading 359°')
})

test('the frame-heading needle copes with a page that has no HUD nodes', () => {
  const needle = needleOver({ getElementById: () => null })
  needle(10)
  needle(null)
})

// ── Where the page drops a calibration ───────────────────────────────────────

/** What follows `from` in main.ts up to the brace that closes the block `from` is in: the rest of that block. */
function restOfBlock(from: number): string {
  let depth = 0
  for (let i = from; i < MAIN.length; i++) {
    const c = MAIN[i]
    if (c === '{') depth++
    else if (c === '}' && --depth < 0) return MAIN.slice(from, i)
  }
  return MAIN.slice(from)
}

/**
 * The three places main.ts takes a calibration's drawings down, each named by a line that comes just before the call and
 * that is in main.ts once: a Place frame that lost a conflict, the re-anchor host's `clearCalibration`, and a calibration
 * flow that ends with no calibration.
 */
const DROP_SITES = {
  conflict: `overlay.setStatus(FRAME_CONFLICT_TEXT, 'sticky')`,
  reanchor: 'clearCalibration: () => {',
  skip: `overlay.setStatus(alignmentStatusText(null), 'sticky')`,
} as const
type DropSite = keyof typeof DROP_SITES

/** The block of main.ts that follows `anchor`: up to the brace that closes the block the anchor is in. */
function blockAfter(anchor: string): string {
  const at = MAIN.indexOf(anchor)
  assert.ok(at >= 0, `main.ts has no \`${anchor}\``)
  assert.equal(MAIN.indexOf(anchor, at + anchor.length), -1, `\`${anchor}\` is in main.ts once`)
  return restOfBlock(at + anchor.length)
}

/** What main.ts passes to `dropCalibrationDrawings` at a site: no argument is no option, as it is to the function underneath. */
function dropOptionsAt(site: DropSite): { floor: boolean } {
  const call = /dropCalibrationDrawings\(((?:\{[^}]*\})?)\)/.exec(blockAfter(DROP_SITES[site]))
  assert.ok(call, `main.ts takes the calibration's drawings down at the ${site} site, in the block that follows \`${DROP_SITES[site]}\``)
  return call[1] === '' ? { floor: false } : (new Function(`return (${call[1]})`)() as { floor: boolean })
}

/**
 * `dropCalibrationDrawings` as the browser runs it: main.ts's own source, its types erased, over the real scene code, a
 * needle that writes down what it is told, and a provider of the test's.
 */
function dropOver(provider: { getScene?: () => THREE.Object3D | null }, needle: (bearingDeg: number | null) => void = () => {}) {
  const source = stripTypeScriptTypes(mainFunction('  function dropCalibrationDrawings(', '  '))
  return new Function('setFrameHeadingNeedle', 'withdrawCalibrationDrawings', 'provider', `${source}\nreturn dropCalibrationDrawings`)(
    needle,
    withdrawCalibrationDrawings,
    provider,
  ) as (options: { floor: boolean }) => void
}

test('the page takes down what a calibration drew wherever it drops the calibration', () => {
  const drops = [...MAIN.matchAll(/sessionCalibration = undefined\n/g)]
  assert.ok(drops.length >= 2, 'a frame that lost its conflict drops it, and so does the re-anchor host\'s clearCalibration')
  for (const drop of drops) {
    assert.match(
      restOfBlock(drop.index! + drop[0].length),
      /dropCalibrationDrawings\(\{ floor: (true|false) \}\)/,
      `the calibration dropped at offset ${drop.index} is followed, in the same block, by taking its drawings down, and by saying whether the grid goes`,
    )
  }
})

test('the floor grid goes where the scan goes with the calibration, and stays where only the calibration goes', () => {
  assert.deepEqual(dropOptionsAt('conflict'), { floor: false }, 'a Place frame that lost a conflict: the scan is the same one, in the session frame it was')
  assert.deepEqual(dropOptionsAt('reanchor'), { floor: true }, 'a re-anchor begins a scan in another frame, which has no calibration until the next flow makes one')
  assert.deepEqual(dropOptionsAt('skip'), { floor: true }, 'a flow that ends with no calibration is a skip, and a skip leaves no calibration floor plane (ticket 0001)')
})

test('a calibration flow that ends with a calibration shows the needle for it, and one that ends with none takes the one before down', () => {
  const body = mainFunction('  async function calibrateScan(): Promise<boolean> {', '  ')
  // The branch that made a calibration shows or hides the needle for the bearing the new calibration came with.
  assert.match(body, /setFrameHeadingNeedle\(calibration\.originBearingDeg \?\? null\)/)
  // The branch that made none: the drop is the one at the `skip` site, which sits inside this function.
  assert.ok(body.includes(DROP_SITES.skip), 'the branch for a flow that made no calibration is in calibrateScan')
  assert.match(blockAfter(DROP_SITES.skip), /dropCalibrationDrawings\(/)
  assert.match(MAIN, /import \{ withdrawCalibrationDrawings \} from '\.\/ar\/project-calibration'/)
})

// ── What taking a calibration's drawings down leaves, as the page does it ─────

const floorPlanes = (scene: THREE.Object3D): number => countAnywhere(scene, FLOOR)

test('taking a calibration\'s drawings down hides the needle and clears the scene; the floor grid goes when asked', async (t) => {
  for (const floor of [false, true]) {
    const scene = new THREE.Scene()
    await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
    const told: Array<number | null> = []
    dropOver({ getScene: () => scene }, (bearingDeg) => told.push(bearingDeg))({ floor })
    assert.deepEqual(told, [null], `floor ${floor}: the HUD is told there is no frame heading`)
    assert.deepEqual(namesIn(scene), floor ? [] : [FLOOR], `floor ${floor}: the origin and the check marker are down${floor ? ', and so is the ground' : ', and the ground stays'}`)
  }
})

test('taking a calibration\'s drawings down copes with a provider that has no scene yet', () => {
  for (const provider of [{}, { getScene: () => null }]) {
    const told: Array<number | null> = []
    dropOver(provider, (bearingDeg) => told.push(bearingDeg))({ floor: true })
    assert.deepEqual(told, [null], 'the needle is hidden all the same')
  }
})

test('a Place frame that lost a conflict takes the calibration\'s drawings down and leaves the scan\'s floor grid', async (t) => {
  const scene = new THREE.Scene()
  await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  const told: Array<number | null> = []
  dropOver({ getScene: () => scene }, (bearingDeg) => told.push(bearingDeg))(dropOptionsAt('conflict'))
  assert.deepEqual(told, [null])
  assert.deepEqual(namesIn(scene), [FLOOR], 'the scan goes on in the frame it was in, on the ground it keeps')
})

test('re-anchor, then Continue uncalibrated: the new scan has no calibration, so nothing of the old one is left on the floor, the grid included', async (t) => {
  const scene = new THREE.Scene()
  await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  assert.deepEqual(sortedNames(scene), [CHECK_MARKER, FLOOR, ORIGIN].sort(), 'the first calibration leaves its origin, its check marker and the ground')
  const oldGrid = scene.getObjectByName(FLOOR)!
  const told: Array<number | null> = []
  const drop = dropOver({ getScene: () => scene }, (bearingDeg) => told.push(bearingDeg))

  // The re-anchor begins a scan in another frame: the page forgets the calibration before the next flow opens.
  drop(dropOptionsAt('reanchor'))
  assert.deepEqual(told, [null], 'the HUD is told there is no frame heading')
  assert.equal(floorPlanes(scene), 0, 'the old scan\'s grid is not left standing for the next flow to draw its own beside')

  // The next flow runs: its own grid, under its placement group, is the only one on the floor.
  const flow = await startFlow(t, { ...SECOND, scene })
  await flow.placeLandmark(flow.physical(SPOTS.landmark))
  assert.equal(floorPlanes(scene), 1, 'the flow\'s own grid, and not the old scan\'s beside it')
  assert.notEqual(scene.getObjectByName(FLOOR), oldGrid)

  // "Continue uncalibrated", and the page's branch for a flow that made no calibration.
  flow.press('project-calibration-skip')
  assert.equal(await flow.finish(), null)
  drop(dropOptionsAt('skip'))

  // What a scan that never had a calibration holds: the scene of a page whose first flow was skipped.
  const fresh = new THREE.Scene()
  const skipped = await startFlow(t, { ...SECOND, scene: fresh })
  await skipped.placeLandmark(skipped.physical(SPOTS.landmark))
  skipped.press('project-calibration-skip')
  assert.equal(await skipped.finish(), null)
  dropOver({ getScene: () => fresh })(dropOptionsAt('skip'))

  assert.equal(floorPlanes(fresh), 0, 'a skip leaves no calibration floor plane (ticket 0001)')
  assert.deepEqual(sortedNames(scene), sortedNames(fresh), 'and a skip after a re-anchor leaves the scene a first skip does')
  assert.equal(floorPlanes(scene), 0)
  assert.deepEqual(namesIn(scene), [])
})

test('a flow that ends with no calibration leaves no floor plane of an earlier one, whatever did or did not clear the calibration before it', async (t) => {
  const scene = new THREE.Scene()
  await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  assert.equal(floorPlanes(scene), 1, 'the first calibration keeps the ground')

  // No `clearCalibration` first: the flow's own end is what is held to the ticket's "Given a skip, then ... no calibration floor plane remain".
  const flow = await startFlow(t, { ...SECOND, scene })
  await flow.placeLandmark(flow.physical(SPOTS.landmark))
  flow.press('project-calibration-skip')
  assert.equal(await flow.finish(), null)
  dropOver({ getScene: () => scene })(dropOptionsAt('skip'))

  assert.equal(floorPlanes(scene), 0)
  assert.deepEqual(namesIn(scene), [])
})

test('re-anchor, then a commit: one grid, in the new scan\'s frame, and none of the old scan\'s', async (t) => {
  const scene = new THREE.Scene()
  const { frame } = await calibrateFirst(t, { ...FIRST, scene }, SPOTS)
  const oldGrid = scene.getObjectByName(FLOOR)!
  dropOver({ getScene: () => scene })(dropOptionsAt('reanchor'))

  const { flow } = await revisit(t, { ...SECOND, scene }, frame, RETAPPED)
  assert.equal(floorPlanes(scene), 1, 'the grid the commit keeps, replacing nothing and stacking on nothing')
  const grid = scene.getObjectByName(FLOOR)!
  assert.notEqual(grid, oldGrid)
  // It is centred on the landmark this scan tapped, which the physical model says where it is in this session, and not on the old scan's.
  const landmark = flow.physical(RETAPPED.landmark)
  const oldLandmark = oldGrid.position
  assert.ok(Math.hypot(landmark.x - oldLandmark.x, landmark.z - oldLandmark.z) > 1, 'the two sessions are in different frames, which is what the check below can tell apart')
  assert.ok(Math.abs(grid.position.x - landmark.x) < 1e-9 && Math.abs(grid.position.z - landmark.z) < 1e-9, `the grid is at ${grid.position.x}, ${grid.position.z}, the landmark at ${landmark.x}, ${landmark.z}`)
  assert.equal(floorPlanes(scene), 1)
})
