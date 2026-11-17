/**
 * The editor's alignment-check card, run against a stand-in DOM and real three.js.
 *
 * src/viewer/register-proposal.ts builds its card with `document.createElement` and
 * draws its preview with three.js objects. Neither needs a browser to run: the DOM
 * calls it makes (create, append, set text, listen for a click) are few, and
 * three.js builds scene graphs and matrices without a canvas. So the card is loaded
 * here against a tiny hand-written DOM and the real `three`, and driven the way a
 * person drives it: it is shown, previewed, applied, applied again.
 *
 * What this proves: which buttons each state gets, that the preview is the scan's
 * points where they are and where the proposal would put them (the matrix the
 * ghost carries is the correction on top of the scan's world matrix, the product a
 * transposed or reversed multiply would get wrong), that Apply writes one patch
 * through the editor's own writer and then moves the scan, that a second press and
 * a refusal write nothing, and that a preview does not outlive its Place.
 *
 * What it does not: that any of it paints. Colours, layout and the real click path
 * are for a browser. The rules Apply follows are tested without any DOM in
 * wp-15a-register-proposal.test.ts; this file checks the card calls them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15a-*.test.ts
 * `npm run verify` reaches it through `npm run test:wave`, which runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import type { EditPatch, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import {
  multiplyMat4,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  type PlaceRegisterResult,
  type RegisterPatchBody,
  type RegistrationProposal,
} from '../../../src/world/register-proposal.ts'

// ── A stand-in for the few DOM calls the card makes ─────────────────────────

class FakeElement {
  className = ''
  textContent = ''
  hidden = false
  disabled = false
  title = ''
  type = ''
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<() => void>>()
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: FakeElement[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  click(): void { if (!this.disabled) for (const listener of this.listeners.get('click') ?? []) listener() }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  buttons(): FakeElement[] { return this.descendants().filter((node) => node.tagName === 'button') }
  button(label: string): FakeElement | undefined { return this.buttons().find((node) => node.textContent === label) }
  text(): string { return this.descendants().map((node) => node.textContent).join('\n') }
}

const page = new Map<string, FakeElement>()
;(globalThis as unknown as { document: unknown }).document = {
  getElementById: (id: string) => page.get(id) ?? null,
  createElement: (tag: string) => new FakeElement(tag),
}
const section = new FakeElement('div')
section.hidden = true
const list = new FakeElement('div')
page.set('register-proposals-section', section)
page.set('register-proposals', list)

const { mountRegisterProposals } = await import('../../../src/viewer/register-proposal.ts')

// ── A world with a finished check in it ─────────────────────────────────────

const yawTranslation = (yaw: number, tx: number, ty: number, tz: number): number[] => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]
}
const IDENTITY = yawTranslation(0, 0, 0, 0)
const MOVING_PLACEMENT = yawTranslation(0.4, 12, 0.02, -3)
const CORRECTION = yawTranslation(-0.02, 0.18, 0.01, -0.07)

function proposed(overrides: Partial<RegistrationProposal> = {}): RegistrationProposal {
  return {
    status: 'proposed',
    transform: CORRECTION,
    overlapFraction: 0.91,
    inlierResidualM: 0.031,
    score: 0.86,
    boundedCorrection: { translationM: 0.19, yawDeg: -1.1, dyM: 0.004, maxShiftM: 0.34, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } },
    reason: null,
    details: {
      movingCells: 800, referenceCells: 900, movingMatchedFraction: 0.91, referenceMatchedFraction: 0.8, distinctiveness: 0.95, fit: 0.9,
      peakRatio: 0.2, nearBestReachM: 0.4, verticalChecked: true, searchedTranslationM: 2, searchedYawDeg: 25,
    },
    ...overrides,
  }
}

function scan(scanId: string, localToWorld: number[]): ScanManifest {
  return {
    scanId, projectId: 'proj-1', sessionId: null, filename: `${scanId}.glb`, name: scanId === 'scan-b' ? 'Second visit' : 'First visit',
    glbUrl: '', geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, localToWorld, accuracyM: null,
    geoDistanceM: null, capturedAt: null, pointCount: null, detectionCount: null, layerIndex: [], status: 'ready',
  }
}

function jobWith(proposal: RegistrationProposal, jobId = 'job-1'): WorldJob {
  const result: PlaceRegisterResult = {
    proposal,
    moving: { scanId: 'scan-b', filename: 'scan-b.glb', name: 'Second visit', localToWorld: MOVING_PLACEMENT },
    reference: { scanId: 'scan-a', filename: 'scan-a.glb', name: 'First visit', localToWorld: IDENTITY },
    comparisons: [],
    params: {},
    comparedAt: '2026-11-16T10:00:00.000Z',
    elapsedMs: 100,
  }
  return {
    jobId, worldId: 'world-1', type: 'place-register', status: 'completed', scanId: 'scan-b', capabilities: [],
    artifacts: [{ type: PLACE_REGISTER_PROPOSAL_ARTIFACT, label: 'check', metadata: JSON.parse(JSON.stringify(result)) }],
    createdAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:01.000Z',
  }
}

/** The editor: a world, the loaded scan roots, and a patch writer that behaves as the server's reply does. */
function editor(proposal: RegistrationProposal = proposed(), movingPlacement = MOVING_PLACEMENT) {
  const world = {
    worldId: 'world-1',
    scans: [scan('scan-b', movingPlacement), scan('scan-a', IDENTITY)],
    jobs: [jobWith(proposal)],
    editPatches: [] as EditPatch[],
  } as unknown as WorldProject

  const worldGroup = new THREE.Group()
  const root = new THREE.Group()
  new THREE.Matrix4().fromArray(movingPlacement).decompose(root.position, root.quaternion, root.scale)
  const cloud = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 2, -1, 1, 0.5], 3)))
  root.add(cloud)
  worldGroup.add(root)
  worldGroup.updateMatrixWorld(true)

  const log = { posts: [] as RegisterPatchBody[], moves: [] as Array<{ scanId: string; matrix: number[] }> }
  const host = {
    world: () => world,
    worldGroup: () => worldGroup,
    scanPoints: (scanId: string) => (scanId === 'scan-b' ? [cloud] : []),
    postPatch: async (body: RegisterPatchBody) => {
      log.posts.push(body)
      world.editPatches.push({
        patchId: `patch-${log.posts.length}`, worldId: world.worldId, scanId: body.scanId, targetId: body.targetId, scope: 'scan',
        transform: body.transform, provenance: body.provenance, createdAt: '2026-11-16T10:05:00.000Z',
      })
      world.scans.find((candidate) => candidate.scanId === body.scanId)!.localToWorld = body.transform.matrix
    },
    moveScan: (scanId: string, matrix: number[]) => log.moves.push({ scanId, matrix }),
  }
  const card = mountRegisterProposals(host)
  card.render()
  return { world, worldGroup, cloud, host, card, log }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const ghostGroup = (group: THREE.Group) => group.children.find((child) => child.name === 'alignment check preview') as THREE.Group | undefined

// ── The card by state ───────────────────────────────────────────────────────

test('a proposal gets a card with Show and Apply, and the section appears', () => {
  editor()
  assert.equal(section.hidden, false)
  assert.equal(list.children.length, 1)
  const text = list.text()
  assert.match(text, /Second visit/)
  assert.match(text, /Proposed move: 19 cm and a 1\.1° turn/)
  assert.match(text, /Compared with First visit\./)
  assert.match(text, /Nothing moves until you apply it\./)
  assert.ok(list.children[0]!.button('Show'))
  assert.ok(list.children[0]!.button('Apply'))
  assert.doesNotMatch(text, /aligned|verified/i)
})

test('a refusal is a card with its reason and no way to apply it', () => {
  editor(proposed({ status: 'refused', transform: null, reason: 'ambiguous', score: 0.1, overlapFraction: 0.5 }))
  const card = list.children[0]!
  assert.equal(card.buttons().length, 0)
  assert.match(card.text(), /No move proposed/)
  assert.match(card.text(), /The walls do not settle one position\./)
})

test('a scan that has moved since the check is not offered the old proposal', () => {
  editor(proposed(), yawTranslation(0.4, 12.2, 0.02, -3))
  const card = list.children[0]!
  assert.equal(card.buttons().length, 0)
  assert.match(card.text(), /has moved since the check/)
})

test('no world, or a world with no checks, hides the section', () => {
  const { world, card } = editor()
  world.jobs = []
  card.render()
  assert.equal(section.hidden, true)
  assert.equal(list.children.length, 0)
})

// ── The preview ─────────────────────────────────────────────────────────────

test('Show draws the scan twice: where it is, and where the proposal would put it', () => {
  const { worldGroup, cloud } = editor()
  list.children[0]!.button('Show')!.click()

  const group = ghostGroup(worldGroup)
  assert.ok(group, 'a preview group was added to the world group')
  assert.equal(group.children.length, 2)
  worldGroup.updateMatrixWorld(true)
  const [before, after] = group.children as THREE.Points[]

  // The same point cloud, not a copy of its data: removing the preview must free nothing the scan needs.
  assert.equal(before!.geometry, cloud.geometry)
  assert.equal(after!.geometry, cloud.geometry)

  const local = new THREE.Vector3(1, 0, 2)
  const now = local.clone().applyMatrix4(cloud.matrixWorld)
  assert.ok(local.clone().applyMatrix4(before!.matrixWorld).distanceTo(now) < 1e-9, 'before sits where the scan sits')
  const expected = now.clone().applyMatrix4(new THREE.Matrix4().fromArray(CORRECTION))
  assert.ok(local.clone().applyMatrix4(after!.matrixWorld).distanceTo(expected) < 1e-9, 'after is the correction applied in the Place frame')
  assert.ok(expected.distanceTo(now) > 0.1, 'and it is not the same place')

  // Pressing it again takes it away, and the button says what it will do.
  assert.ok(list.children[0]!.button('Hide'))
  list.children[0]!.button('Hide')!.click()
  assert.equal(ghostGroup(worldGroup), undefined)
  assert.ok(list.children[0]!.button('Show'))
})

test('Show on a scan that is not loaded says so instead of drawing nothing', () => {
  const { host, card } = editor()
  host.scanPoints = () => []
  card.render()
  list.children[0]!.button('Show')!.click()
  assert.match(list.children[0]!.text(), /Open this scan in the scene first/)
})

test('a preview does not outlive its Place', () => {
  const { world, worldGroup, card } = editor()
  list.children[0]!.button('Show')!.click()
  assert.ok(ghostGroup(worldGroup))
  world.worldId = 'world-2'
  card.render()
  assert.equal(ghostGroup(worldGroup), undefined)
})

// ── Apply ───────────────────────────────────────────────────────────────────

test('Apply writes the patch through the editor, moves the scan, clears the preview and reads "Applied"', async () => {
  const { worldGroup, log } = editor()
  list.children[0]!.button('Show')!.click()
  list.children[0]!.button('Apply')!.click()
  await settle()

  assert.equal(log.posts.length, 1)
  assert.deepEqual(log.posts[0]!.provenance, { source: 'place-register', jobId: 'job-1', score: 0.86, residualM: 0.031 })
  const expected = multiplyMat4(CORRECTION, MOVING_PLACEMENT)
  assert.deepEqual(log.posts[0]!.transform.matrix, expected)
  assert.equal(log.moves.length, 1)
  assert.equal(log.moves[0]!.scanId, 'scan-b')
  assert.deepEqual(log.moves[0]!.matrix, expected, 'the scan on screen goes where the patch puts it')
  assert.equal(ghostGroup(worldGroup), undefined, 'the preview is gone: the scan itself is there now')

  const card = list.children[0]!
  assert.equal(card.buttons().length, 0)
  assert.match(card.text(), /Applied/)
})

test('Apply pressed twice while the first is still travelling writes one patch', async () => {
  const { host, log, card } = editor()
  // A server that takes a moment, as a real one does: the patch is not in the world when the second press arrives.
  // And, as the editor's own save does, it redraws the panel as soon as the reply has changed the world.
  let drawnWhenSaved = ''
  const write = host.postPatch
  host.postPatch = async (body) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    await write(body)
    card.render()
    drawnWhenSaved = list.children[0]!.text()
  }
  const first = list.children[0]!.button('Apply')!
  first.click()

  // The card redrew itself: the button is now disabled and says what is happening.
  const redrawn = list.children[0]!.button('Apply')!
  assert.notEqual(redrawn, first)
  assert.equal(redrawn.disabled, true)
  assert.match(list.children[0]!.text(), /Applying\.\.\./)

  // A press on the old button (still in the page for a moment) and on the new one both write nothing more, and
  // neither clears the note or re-enables the button that the first press is waiting behind.
  first.click()
  redrawn.click()
  // One turn of the event loop: long enough for anything a second press set going to have finished, far shorter than
  // the 20 ms the first press is still waiting on the server.
  await settle()
  assert.match(list.children[0]!.text(), /Applying\.\.\./)
  assert.equal(list.children[0]!.button('Apply')!.disabled, true)
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  assert.equal(log.posts.length, 1)
  assert.equal(log.moves.length, 1)
  assert.match(list.children[0]!.text(), /Applied to this scan/)
  // The moment the patch is in the world the card says so, not "Applying..." with nothing left to apply.
  assert.match(drawnWhenSaved, /Applied to this scan/)
  assert.doesNotMatch(drawnWhenSaved, /Applying/)
})

test('Apply that the server refuses says so, moves nothing and can be tried again', async () => {
  const { host, log, world } = editor()
  let refuse = true
  const write = host.postPatch
  host.postPatch = async (body) => {
    if (refuse) {
      refuse = false
      // The shape postEditPatch throws for a refusal: the status, then the body.
      throw Object.assign(new Error('409 {"error":"This scan has moved since the check. Run it again."}'), { status: 409 })
    }
    await write(body)
  }
  list.children[0]!.button('Apply')!.click()
  await settle()
  assert.equal(log.moves.length, 0)
  assert.equal(world.editPatches.length, 0)
  assert.match(list.children[0]!.text(), /Could not apply: This scan has moved since the check\. Run it again\./)
  assert.doesNotMatch(list.children[0]!.text(), /409|\{"error"/, 'the server\'s sentence, not the JSON around it')
  assert.ok(list.children[0]!.button('Apply'), 'it is still offered')

  list.children[0]!.button('Apply')!.click()
  await settle()
  assert.equal(log.moves.length, 1)
})
