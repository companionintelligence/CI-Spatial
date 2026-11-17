/**
 * The return-visit aids against a card with a layout, and against one that cannot draw (WP-07): the room the photo panel
 * has above the calibration card, and what the aids do when something they draw fails or the flow has ended.
 * src/ar/return-visit-aids.ts, built here from hand-made parts so that the card's position can be set to any number a
 * phone's screen can have. wp-return-visit-aids.test.ts drives the whole modal; it has no layout, so it cannot say where
 * the card is.
 *
 * The panel is in the top corner and the card is anchored to the bottom. On a screen 667 px high the card, with the
 * distance chip, reaches 188 px from the top, and the panel (225 px tall) lay under it, with its captions and Point B's
 * crosshair hidden. The panel is now measured against the card on every draw: the photos shrink to the room above the
 * card, and under a size a photo is worth looking at the panel is left out. Beside the card it is as big as it was.
 * `docs` for the numbers: COMPARE_CHROME_PX and COMPARE_MIN_PHOTO_PX in the module, both adopted, not measured.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-return-visit-room.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import {
  COMPARE_CHROME_PX,
  COMPARE_MIN_PHOTO_PX,
  createReturnVisitAids,
  returnVisitMarkup,
  roomAboveCard,
  type Box,
  type ReturnVisitAids,
  type ReturnVisitView,
} from '../../../src/ar/return-visit-aids.ts'
import type { TwoPointFrame } from '../../../src/ar/calibration-commit.ts'
import type { CalibrationReferencePhoto } from '../../../src/world/types.ts'
import { storedPair } from './support/return-visit-driver.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// ── A card made of parts ─────────────────────────────────────────────────────────────────────────

/** What the aids use of an element, with a place on screen only when a test gives it one. */
class Part {
  hidden = false
  textContent: string | null = ''
  dataset: Record<string, string | undefined> = {}
  src = ''
  onload: ((event?: unknown) => void) | null = null
  clientWidth = 96
  clientHeight = 128
  offsetLeft = 0
  offsetTop = 0
  style: Record<string, string> = {}
  getBoundingClientRect?: () => Box
  at(box: Box): this {
    this.getBoundingClientRect = () => box
    return this
  }
}

/** The ids the aids look for: the panel's own, from its markup, and the chip the modal's template carries. */
const IDS = [...returnVisitMarkup().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!).concat('project-calibration-chip')

interface Card {
  parts: Map<string, Part>
  dialog: Part
  panel: Part
  root: { querySelector(selector: string): unknown }
}

function makeCard(without: readonly string[] = []): Card {
  const parts = new Map(IDS.filter((id) => !without.includes(id)).map((id) => [id, new Part()] as const))
  const dialog = new Part()
  return {
    parts,
    dialog,
    panel: parts.get('project-calibration-compare')!,
    root: { querySelector: (selector) => (selector === '.project-calibration-card' ? dialog : parts.get(selector.replace(/^#/, '')) ?? null) },
  }
}

/** A phone: the panel is at the top right, 212 px wide, and the card is at the bottom, as the stylesheet puts them. */
const PANEL: Box = { top: 12, right: 363, bottom: 237, left: 151 }
const phoneCard = (top: number): Box => ({ top, right: 359, bottom: top + 461, left: 16 })

const wait = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const PHOTO = 'data:image/png;base64,AAAA'
const review: ReturnVisitView = { stage: 'review', landmark: { x: 0, y: 0, z: 0 }, separationM: 3.2 }

interface AidsSetup {
  stored?: unknown
  /** What the host's loader answers: an async function wraps whatever it throws into a rejection. */
  load?: (photo: unknown) => Promise<string | null>
  /** A loader given as it is, to stand for one that throws before it returns a promise. */
  rawLoad?: (photo: CalibrationReferencePhoto) => Promise<string | null>
  placement?: THREE.Object3D
  /** Whether the modal's scene exists: `ready.scene` may be changed after the aids are made. */
  ready?: { scene: boolean }
}

function makeAids(card: Card, options: AidsSetup = {}): { aids: ReturnVisitAids; loads: unknown[] } {
  const loads: unknown[] = []
  const ready = options.ready ?? { scene: true }
  const aids = createReturnVisitAids({
    enabled: true,
    root: card.root,
    stored: (options.stored ?? storedPair({ separationM: 3.2, photos: true })) as TwoPointFrame,
    placement: options.placement ?? new THREE.Group(),
    ensureScene: () => ready.scene,
    loadReferencePhoto: options.rawLoad ?? (async (photo) => {
      loads.push(photo)
      return options.load ? options.load(photo) : PHOTO
    }),
    shownPhoto: () => null,
  })
  return { aids, loads }
}

const img = (card: Card, key: 'a' | 'b') => card.parts.get(`project-calibration-compare-img-${key}`)!

// ── The room above the card ──────────────────────────────────────────────────────────────────────

test('the room above the card is from the panel\'s top to the card\'s top, less a gap, and none is needed when the card is beside it', () => {
  assert.equal(roomAboveCard(phoneCard(188), PANEL), 188 - 12 - 8)
  assert.equal(roomAboveCard(phoneCard(12), PANEL), -8, 'a card as high as the panel leaves no room: a negative number')
  // A wide window: the card is centred and 390 px wide, the panel is in the corner. They never overlap, so there is no limit.
  const centred: Box = { top: 188, right: 835, bottom: 649, left: 445 }
  const corner: Box = { top: 12, right: 1268, bottom: 237, left: 1056 }
  assert.equal(roomAboveCard(centred, corner), null)
  // Touching edges are beside, not under: nothing overlaps.
  assert.equal(roomAboveCard({ top: 100, right: 400, bottom: 500, left: 151 - 100 }, { top: 12, right: 363, bottom: 237, left: 400 }), null)
  assert.equal(roomAboveCard({ top: 100, right: 151, bottom: 500, left: 0 }, PANEL), null)
  assert.equal(roomAboveCard({ top: 100, right: 152, bottom: 500, left: 0 }, PANEL), 100 - 12 - 8)
})

test('the panel\'s photos are held to the room above the card, less what the panel is made of besides them', async () => {
  const card = makeCard()
  card.dialog.at(phoneCard(188))
  card.panel.at(PANEL)
  const { aids } = makeAids(card)
  aids.render(review)
  await wait()
  assert.equal(card.panel.hidden, false)
  const room = 188 - 12 - 8
  assert.equal(img(card, 'a').style['maxHeight'], `${room - COMPARE_CHROME_PX}px`)
  assert.equal(img(card, 'b').style['maxHeight'], `${room - COMPARE_CHROME_PX}px`)
})

test('the room is measured on every draw: a card that grows takes room from the photos, and one that shrinks gives it back', async () => {
  const card = makeCard()
  card.panel.at(PANEL)
  card.dialog.at(phoneCard(260))
  const { aids } = makeAids(card)
  aids.render(review)
  await wait()
  assert.equal(img(card, 'a').style['maxHeight'], `${260 - 12 - 8 - COMPARE_CHROME_PX}px`)
  card.dialog.at(phoneCard(200))
  aids.render(review)
  assert.equal(img(card, 'a').style['maxHeight'], `${200 - 12 - 8 - COMPARE_CHROME_PX}px`)
  card.dialog.at(phoneCard(330))
  aids.render(review)
  assert.equal(img(card, 'a').style['maxHeight'], `${330 - 12 - 8 - COMPARE_CHROME_PX}px`)
})

test('the panel is shown from the room a chrome and a smallest photo need, and not below it: never under the card', async () => {
  const needed = COMPARE_CHROME_PX + COMPARE_MIN_PHOTO_PX
  for (const [room, shown] of [[needed, true], [needed + 1, true], [needed - 1, false], [needed - 40, false], [0, false], [-30, false]] as const) {
    const card = makeCard()
    card.panel.at(PANEL)
    card.dialog.at(phoneCard(12 + 8 + room))
    const { aids } = makeAids(card)
    aids.render(review)
    await wait()
    assert.equal(card.panel.hidden, !shown, `room ${room}`)
    if (shown) assert.equal(img(card, 'a').style['maxHeight'], `${room - COMPARE_CHROME_PX}px`, `room ${room}: the photo is no shorter than the least it is worth showing`)
  }
  // The photo it leaves is the least one.
  assert.ok(COMPARE_MIN_PHOTO_PX >= 60, 'a photo under 60 px is the crosshair and little else')
})

test('a panel with no room loads nothing, and when the room comes back it loads and shows both photos', async () => {
  const card = makeCard()
  card.panel.at(PANEL)
  card.dialog.at(phoneCard(100))
  const { aids, loads } = makeAids(card)
  aids.render(review)
  await wait()
  assert.equal(card.panel.hidden, true)
  assert.equal(loads.length, 0, 'photos nobody can see are not fetched')
  card.dialog.at(phoneCard(400))
  aids.render(review)
  await wait()
  assert.equal(card.panel.hidden, false)
  assert.equal(loads.length, 2)
  assert.equal(card.parts.get('project-calibration-compare-figure-a')!.hidden, false)
  assert.equal(card.parts.get('project-calibration-compare-figure-b')!.hidden, false)
})

test('a card with no layout to measure, or one beside the panel, leaves the photos at their size', async () => {
  const unmeasured = makeCard()
  const first = makeAids(unmeasured)
  first.aids.render(review)
  await wait()
  assert.equal(unmeasured.panel.hidden, false)
  assert.equal(img(unmeasured, 'a').style['maxHeight'], '')

  const wide = makeCard()
  wide.panel.at({ top: 12, right: 1268, bottom: 237, left: 1056 })
  wide.dialog.at({ top: 188, right: 835, bottom: 649, left: 445 })
  const second = makeAids(wide)
  second.aids.render(review)
  await wait()
  assert.equal(wide.panel.hidden, false)
  assert.equal(img(wide, 'a').style['maxHeight'], '')
})

test('the cap on the photos goes when the card is no longer under the panel: a window made wider gives them their size back', async () => {
  const card = makeCard()
  card.panel.at(PANEL)
  card.dialog.at(phoneCard(200))
  const { aids } = makeAids(card)
  aids.render(review)
  await wait()
  assert.equal(img(card, 'a').style['maxHeight'], `${200 - 12 - 8 - COMPARE_CHROME_PX}px`, 'held to the room above the card')
  // The window is made wider: the card is centred, and the panel is in the corner, beside it.
  card.panel.at({ top: 12, right: 1268, bottom: 237, left: 1056 })
  card.dialog.at({ top: 188, right: 835, bottom: 649, left: 445 })
  aids.render(review)
  assert.equal(card.panel.hidden, false)
  assert.equal(img(card, 'a').style['maxHeight'], '')
  assert.equal(img(card, 'b').style['maxHeight'], '')
})

test('the panel is not drawn outside review and the mismatch screen, however much room there is', () => {
  const card = makeCard()
  card.panel.at(PANEL)
  card.dialog.at(phoneCard(500))
  const { aids } = makeAids(card)
  for (const stage of ['ground', 'landmark', 'heading'] as const) {
    aids.render({ ...review, stage })
    assert.equal(card.panel.hidden, true, stage)
  }
  aids.render({ ...review, stage: 'mismatch' })
  assert.equal(card.panel.hidden, false)
})

test('the crosshair is placed from where the picture is in its figure, which is not the left edge when the picture is held narrower than the figure', async () => {
  const card = makeCard()
  const { aids } = makeAids(card)
  img(card, 'a').offsetLeft = 12
  img(card, 'a').offsetTop = 3
  aids.render(review)
  await wait()
  // The stored tap of Point A is (0.4, 0.3) on a 96 x 128 picture.
  const cross = card.parts.get('project-calibration-compare-cross-a')!
  assert.equal(cross.style['left'], `${12 + 0.4 * 96}px`)
  assert.equal(cross.style['top'], `${3 + 0.3 * 128}px`)
})

// ── What the aids do when something fails, or the flow has ended ─────────────────────────────────

test('an aid that cannot be drawn is said once on the console, and the others are still drawn', async () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    const card = makeCard()
    const { aids } = makeAids(card)
    aids.render(review)
    await wait()
    // The crosshair of Point A cannot be placed from now on.
    Object.defineProperty(card.parts.get('project-calibration-compare-cross-a')!.style, 'left', {
      set() {
        throw new Error('no layout')
      },
    })
    for (let i = 0; i < 3; i++) aids.render(review)
    assert.equal(warn.mock.callCount(), 1, 'said once, not on every draw')
    assert.match(String(warn.mock.calls[0]!.arguments[0]), /the stored photos could not be drawn/)
    assert.equal(card.parts.get('project-calibration-chip')!.dataset['state'], 'pass', 'the chip, drawn before it, is still there')
    assert.equal(aids.statusLine('Ready to commit.'), 'Ready to commit.')
  } finally {
    warn.mock.restore()
  }
})

test('after dispose a draw does nothing: no ring is put back in the placement group, and no photo is shown', async () => {
  const placement = new THREE.Group()
  const card = makeCard()
  const { aids } = makeAids(card, { placement })
  aids.render({ ...review, stage: 'heading' })
  assert.equal(placement.children.length, 1, 'the ring is drawn while the flow runs')
  aids.dispose()
  assert.equal(placement.children.length, 0, 'and goes with it')
  aids.render({ ...review, stage: 'heading' })
  aids.render(review)
  assert.equal(placement.children.length, 0, 'a draw after the flow has ended does not put it back')
  assert.equal(card.panel.hidden, true, 'nor does it show the panel: it is as the heading step left it')
  assert.equal(card.parts.get('project-calibration-chip')!.hidden, true, 'nor the chip')
})

test('the status line is the modal\'s own unless the chip fails, and the chip fails only in review for a pair that is not the stored distance', () => {
  const card = makeCard()
  const { aids } = makeAids(card)
  assert.equal(aids.statusLine('Tap the ground to place the heading marker.'), 'Tap the ground to place the heading marker.')
  aids.render({ ...review, separationM: 3.2 })
  assert.equal(aids.statusLine('Ready to commit.'), 'Ready to commit.')
  aids.render({ ...review, separationM: 3.7 })
  assert.equal(aids.statusLine('Ready to commit.'), 'Not the stored distance yet.')
  aids.render({ ...review, separationM: 3.7, stage: 'mismatch' })
  assert.equal(aids.statusLine('Not committed yet.'), 'Not committed yet.', 'the mismatch screen says it in words, and no chip is up')
  aids.render({ ...review, separationM: 0.5 })
  assert.equal(aids.statusLine('The markers are too close together to fix a reliable heading.'), 'The markers are too close together to fix a reliable heading.')
})

test('a loader that throws before it returns a promise is a loader that failed: the slot says so and the card goes on', async () => {
  const card = makeCard()
  const { aids } = makeAids(card, {
    rawLoad: () => {
      throw new Error('no storage')
    },
  })
  aids.render(review)
  await wait()
  assert.equal(card.parts.get('project-calibration-compare-figure-a')!.hidden, true)
  assert.equal(card.parts.get('project-calibration-compare-note-a')!.textContent, 'Photo could not be loaded')
  assert.equal(card.parts.get('project-calibration-compare-note-a')!.hidden, false)
})

test('the status line follows the chip whether or not the card has a chip element to draw it in', () => {
  const card = makeCard(['project-calibration-chip'])
  const { aids } = makeAids(card)
  aids.render({ ...review, separationM: 3.7 })
  assert.equal(aids.statusLine('Ready to commit.'), 'Not the stored distance yet.', 'the verdict is the same with nowhere to draw it')
  aids.render({ ...review, separationM: 3.2 })
  assert.equal(aids.statusLine('Ready to commit.'), 'Ready to commit.')
})

test('Point B\'s step points at the ring only while the ring is on the floor: with no scene there is none, and the step does not say there is', () => {
  const card = makeCard()
  const ready = { scene: false }
  const placement = new THREE.Group()
  const { aids } = makeAids(card, { ready, placement })
  const heading: ReturnVisitView = { stage: 'heading', landmark: { x: 0, y: 0, z: 0 }, separationM: null }
  aids.render(heading)
  assert.equal(placement.children.length, 0, 'the provider has no scene yet')
  assert.doesNotMatch(aids.headingCopy()!, /ring/)
  ready.scene = true
  aids.render(heading)
  assert.equal(placement.children.length, 1)
  assert.match(aids.headingCopy()!, /The ring on the floor marks that distance\.$/)
})

test('the ring is at the landmark\'s height, and follows the landmark when only its height changes', () => {
  const placement = new THREE.Group()
  const { aids } = makeAids(makeCard(), { placement })
  aids.render({ stage: 'heading', landmark: { x: 1, y: -1.4, z: 2 }, separationM: null })
  const ring = placement.children[0]!
  assert.deepEqual([ring.position.x, ring.position.y, ring.position.z], [1, -1.4, 2], 'on the floor the landmark is on, not on the session origin\'s plane')
  aids.render({ stage: 'review', landmark: { x: 1, y: -1.1, z: 2 }, separationM: 3.2 })
  assert.deepEqual([ring.position.x, ring.position.y, ring.position.z], [1, -1.1, 2], 'a landmark re-tapped at another height takes its ring with it')
  assert.equal(placement.children.length, 1, 'the same ring, moved')
})

// ── The markup and the stylesheet the aids rely on ───────────────────────────────────────────────

test('the panel\'s markup: each picture says which point it is of, and each crosshair is hidden from assistive technology', () => {
  const markup = returnVisitMarkup()
  const pictures = [...markup.matchAll(/<img\b[^>]*>/g)].map((match) => match[0])
  assert.equal(pictures.length, 2)
  for (const [index, picture] of pictures.entries()) {
    const point = index === 0 ? 'Point A' : 'Point B'
    assert.match(picture, new RegExp(`alt="${point} when it was placed, with a crosshair on the spot that was tapped"`), picture)
  }
  const crosshairs = [...markup.matchAll(/<span\b[^>]*project-calibration-crosshair[^>]*>/g)].map((match) => match[0])
  assert.equal(crosshairs.length, 2)
  for (const crosshair of crosshairs) assert.match(crosshair, /aria-hidden="true"/, crosshair)
  assert.match(markup, /^<div id="project-calibration-compare" class="project-calibration-reference" hidden>/, 'hidden until it is drawn')
})

/** The rule that styles `selector` in index.html, or null. The selectors asked for here are written once. */
function stylesheetRule(html: string, selector: string): string | null {
  const start = html.indexOf(`${selector} {`)
  if (start < 0) return null
  return html.slice(start, html.indexOf('}', start) + 1)
}

test('the stylesheet carries what the aids draw with: the failing chip, the two slots, a picture held to the room it is given, and a caption held to the three lines the panel\'s height assumes', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  assert.match(stylesheetRule(html, ".project-calibration-separation[data-state='fail']") ?? '', /background: rgba\(255,107,107,0\.12\);\s*color: #ff9b9b;/, 'a chip that fails is red, as a pair that is too short is')
  assert.match(stylesheetRule(html, '.project-calibration-compare-row') ?? '', /display: flex;/)
  assert.match(stylesheetRule(html, '.project-calibration-compare-slot') ?? '', /flex: 1 1 0;\s*min-width: 0;/)
  // `max-height` on the picture only keeps its proportions where the width is `auto`, and `max-width` stops it overflowing its slot.
  const picture = stylesheetRule(html, '.project-calibration-compare-slot .project-calibration-reference-figure img') ?? ''
  assert.match(picture, /width: auto;/)
  assert.match(picture, /max-width: 100%;/)
  assert.match(picture, /margin: 0 auto;/, 'centred, which the crosshair\'s offset assumes')
  // COMPARE_CHROME_PX allows three lines of caption at 9 px and a line height of 1.3.
  const caption = stylesheetRule(html, '.project-calibration-compare-caption') ?? ''
  assert.match(caption, /-webkit-line-clamp: 3;/)
  assert.match(caption, /font-size: 9px;/)
  assert.match(caption, /line-height: 1\.3;/)
})
