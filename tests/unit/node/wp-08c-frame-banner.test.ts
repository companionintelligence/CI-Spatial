/**
 * What the editor says about which reference each scan was made against (WP-08): src/viewer/frame-banner.ts, and the readable
 * refusal when a merge or a reassign would mix two references (src/viewer/frame-mismatch.ts).
 *
 * The chip rules are held case by case against what the spec settles: only a different KNOWN id reads as "previous reference",
 * an unknown generation is neutral ("frame not recorded"), and uncalibrated and one-point scans are "not in Place frame"
 * (owner decision D6), and so is a two-point scan whose commit wrote no Place frame and matched none (a bypassed floor check:
 * `calibrationOutsidePlaceFrame`), which the chip reads through the predicate the server's counts ask, in a Place whose frame has an
 * id and in one whose frame has none. Where the Place's own record shows that a frame with no id was replaced, a scan with no id calibrated
 * before that is a previous reference: that is how the scans of a Place upgraded from a legacy frame are listed. The layer's
 * dimming is held on real three.js materials: it uses the compare tools' see-through style, leaves a scan those tools have
 * tinted alone, and takes off only what it put on.
 *
 * The DOM the page draws from these (the chip on a row, the banner, the layer's panel, the grouping) is read in a browser by
 * tests/mock-frame-banner.spec.ts.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-frame-banner.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import type { FrameHistoryEntry, ProjectSpatialFrame } from '../../../src/world/types.ts'
import { isInPlaceFrame } from './support/fake-frame-server.ts'
import { isInPlaceFrame as sharedIsInPlaceFrame } from '../../../src/world/frame-generations.ts'

// The editor's modules are written for the bundler (`'./compare-style'`). Node needs the extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
      if (missing && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const {
  NOT_IN_FRAME_TEXT,
  NOT_RECORDED_TEXT,
  NaturalOrder,
  PREVIOUS_REFERENCE_TEXT,
  applyPreviousReferenceDim,
  frameBannerLines,
  frameChipFor,
  listingOrder,
  summariseFrames,
} = await import('../../../src/viewer/frame-banner.ts')
const { PLAIN_STYLE, appliedStyle, applyCompareStyle, baseMaterial } = await import('../../../src/viewer/compare-style.ts')
const {
  ASSIGN_NEEDS_CONNECTION,
  FRAME_MISMATCH_FALLBACK,
  MERGE_NEEDS_CONNECTION,
  assignQuestion,
  frameMismatchMessage,
  mergeQuestion,
  sendUnlessReferencesDiffer,
} = await import('../../../src/viewer/frame-mismatch.ts')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const frame = (extra: Record<string, unknown> = {}): ProjectSpatialFrame => ({
  version: 1,
  createdAt: '2026-11-10T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...extra,
}) as ProjectSpatialFrame

const entry = (extra: Partial<FrameHistoryEntry> = {}): FrameHistoryEntry => ({
  frameId: 'frame-old',
  createdAt: '2026-10-01T00:00:00.000Z',
  method: 'two-point-ground',
  separationM: 2.5,
  supersededAt: '2026-11-03T12:00:00.000Z',
  reason: 'override',
  ...extra,
})

type Scan = Parameters<typeof frameChipFor>[0]
const twoPointScan = (extra: Partial<Scan> = {}): Scan => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'provisional',
  calibratedAt: '2026-11-16T09:30:00.000Z',
  ...extra,
})

const NOW = { spatialFrame: frame({ frameId: 'frame-now' }), frameHistory: [entry()] }

// ── Chips ────────────────────────────────────────────────────────────────────────────────────────────

test('a scan of the current reference has no chip, and a different known id is a previous reference', () => {
  assert.equal(frameChipFor(twoPointScan({ calibrationFrameId: 'frame-now' }), NOW), null)
  const chip = frameChipFor(twoPointScan({ calibrationFrameId: 'frame-old' }), NOW)
  assert.equal(chip?.kind, 'previous-reference')
  assert.equal(chip?.text, PREVIOUS_REFERENCE_TEXT)
  assert.equal(chip?.text, 'previous reference')
  assert.match(chip!.title, /earlier reference of this Place, not the current one/)
  assert.match(chip!.title, /That reference was replaced on 2026-11-03 \(UTC\)\./, 'the Place\'s own record says when, and the date is said to be UTC')
  const unrecorded = frameChipFor(twoPointScan({ calibrationFrameId: 'frame-never-seen' }), { spatialFrame: NOW.spatialFrame })
  assert.equal(unrecorded?.kind, 'previous-reference', 'a known id that is not the current one is another generation, with or without a history entry')
  assert.doesNotMatch(unrecorded!.title, /replaced on/, 'and no date is claimed that the record does not give')
  // An id the Place's record never listed (a scan carried in from another Place) is not called an earlier reference of this Place.
  assert.doesNotMatch(unrecorded!.title, /earlier reference of this Place/)
  assert.match(unrecorded!.title, /a reference other than this Place's current one, and the Place's record does not say it was ever the Place's own/)
  assert.match(unrecorded!.title, /may not line up with scans made against the current one/, 'the effect is still said')
})

test('a two-point scan with no id is neutral where the Place\'s frame has one, and says nothing where the Place\'s frame has none either', () => {
  const chip = frameChipFor(twoPointScan(), { spatialFrame: NOW.spatialFrame })
  assert.equal(chip?.kind, 'not-recorded')
  assert.equal(chip?.text, NOT_RECORDED_TEXT)
  assert.equal(chip?.text, 'frame not recorded')
  assert.doesNotMatch(chip!.title, /previous/)
  assert.equal(frameChipFor(twoPointScan(), { spatialFrame: frame() }), null, 'a legacy Place: every scan is unknown, so none is marked')
  assert.equal(frameChipFor(twoPointScan({ calibrationFrameId: 'frame-a' }), { spatialFrame: frame() }), null, 'a known id against a frame with no id is not "different": nothing is compared')
})

test('where the Place\'s record shows that a frame with no id was replaced, scans calibrated before it are previous references', () => {
  const upgraded = { spatialFrame: frame({ frameId: 'frame-now' }), frameHistory: [entry({ frameId: null, supersededAt: '2026-11-12T00:00:00.000Z' })] }
  const before = frameChipFor(twoPointScan({ calibratedAt: '2026-11-11T23:59:59.000Z' }), upgraded)
  assert.equal(before?.kind, 'previous-reference')
  assert.match(before!.title, /replaced on 2026-11-12/)
  assert.equal(frameChipFor(twoPointScan({ calibratedAt: '2026-11-12T00:00:01.000Z' }), upgraded)?.kind, 'not-recorded', 'after it, the time cannot say')
  assert.equal(frameChipFor(twoPointScan({ calibratedAt: null }), upgraded)?.kind, 'not-recorded', 'a scan with no time is not placed before anything')
  assert.equal(frameChipFor(twoPointScan({ calibratedAt: 'yesterday' }), upgraded)?.kind, 'not-recorded', 'and neither is a time that is not one')
  assert.equal(
    frameChipFor(twoPointScan({ calibratedAt: '2026-11-01T00:00:00.000Z' }), { spatialFrame: upgraded.spatialFrame, frameHistory: [entry({ frameId: 'frame-old', supersededAt: '2026-11-12T00:00:00.000Z' })] })?.kind,
    'not-recorded',
    'a replaced frame that had an id is found by id, never by time',
  )
  // The frame the scan names was replaced, and the Place's own frame has no id: still a replaced generation.
  const legacyNow = { spatialFrame: frame(), frameHistory: [entry({ frameId: 'frame-old' })] }
  assert.equal(frameChipFor(twoPointScan({ calibrationFrameId: 'frame-old' }), legacyNow)?.kind, 'previous-reference')
})

test('uncalibrated, one-point and known-distance scans are not in the Place frame, whatever else they carry', () => {
  const cases: Array<[string, Scan, RegExp]> = [
    ['no calibration at all', { calibrationMethod: undefined, calibrationStatus: undefined }, /not aligned to this Place's reference/],
    ['uncalibrated', { calibrationMethod: undefined, calibrationStatus: 'uncalibrated' }, /not aligned to this Place's reference/],
    ['uncalibrated with a method left over', { calibrationMethod: 'two-point-ground', calibrationStatus: 'uncalibrated', calibrationFrameId: 'frame-now' }, /not aligned/],
    ['one-point', { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, /one point and the compass.*only at the same spot/],
    ['one-point with an id that cannot be (a hand-edited sidecar)', { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', calibrationFrameId: 'frame-now' }, /one point and the compass/],
    ['known distance', { calibrationMethod: 'known-distance', calibrationStatus: 'provisional' }, /measured distance/],
    // A method this build does not know is only known not to be the two-point one: it is not said to be a measured distance.
    ['a method this build does not know', { calibrationMethod: 'something-new', calibrationStatus: 'provisional' } as Scan, /aligned another way than with the Place's two points/],
  ]
  for (const [what, scan, title] of cases) {
    for (const place of [NOW, { spatialFrame: frame() }]) {
      const chip = frameChipFor(scan, place)
      assert.equal(chip?.kind, 'not-in-frame', what)
      assert.equal(chip?.text, NOT_IN_FRAME_TEXT)
      assert.match(chip!.title, title, what)
    }
  }
  assert.equal(NOT_IN_FRAME_TEXT, 'not in Place frame')
  assert.doesNotMatch(frameChipFor({ calibrationMethod: 'something-new', calibrationStatus: 'provisional' } as Scan, NOW)!.title, /measured distance/)
})

test('a Place with no reference has no frame to be in or out of, so no scan gets a chip', () => {
  for (const place of [null, undefined, {}, { spatialFrame: null }]) {
    for (const scan of [twoPointScan({ calibrationFrameId: 'frame-old' }), twoPointScan(), { calibrationMethod: undefined, calibrationStatus: 'uncalibrated' } as Scan]) {
      assert.equal(frameChipFor(scan, place), null)
    }
  }
})

test('a scan is "not in Place frame" exactly when the server does not count it in a Place frame: the chip and the counts are one rule', () => {
  // A scan is listed in a Place whose frame has an id, or in one whose frame was written before ids: the rule is the same in both.
  const places = [
    ['a Place frame with an id', { spatialFrame: frame({ frameId: 'frame-now' }) }],
    ['a Place frame with no id', { spatialFrame: frame() }],
  ] as const
  const methods = [undefined, 'two-point-ground', 'ground-tap-compass', 'known-distance', 'something-new']
  const statuses = [undefined, 'verified', 'provisional', 'uncalibrated']
  // What a commit that wrote no Place frame and matched none leaves on its scan (`calibrationOutsidePlaceFrame`, server/calibration_fields.ts):
  // the key is there and `true`, or it is not there. A scan from before the key existed, and a scan that is in a frame, have none.
  let checked = 0
  for (const [placeName, place] of places) {
    for (const calibrationMethod of methods) {
      for (const calibrationStatus of statuses) {
        for (const calibrationFrameId of [undefined, 'frame-now', 'frame-other']) {
          for (const outside of [false, true]) {
            const facts = { calibrationMethod, calibrationStatus, ...(outside ? { calibrationOutsidePlaceFrame: true as const } : {}) }
            const scan = { ...facts, calibrationFrameId } as Scan
            const chip = frameChipFor(scan, place)
            const serverSaysIn = isInPlaceFrame(facts)
            const what = `${placeName} / ${String(calibrationMethod)} / ${String(calibrationStatus)} / ${String(calibrationFrameId)} / outside ${outside}`
            assert.equal(sharedIsInPlaceFrame(facts), serverSaysIn, `the stand-in is the shared predicate: ${what}`)
            assert.equal(chip?.kind === 'not-in-frame', !serverSaysIn, what)
            checked += 1
          }
        }
      }
    }
  }
  assert.equal(checked, 2 * 5 * 4 * 3 * 2, 'every combination was held to the rule')
})

test('a two-point scan whose commit wrote no Place frame and matched none is "not in Place frame", whatever the Place\'s frame and history say', () => {
  const outside = (extra: Partial<Scan> = {}): Scan => twoPointScan({ calibrationOutsidePlaceFrame: true, ...extra })
  // The scan's own explanation. It must not say what the neutral chip says (references were not numbered then: false of a scan made now),
  // and not that the reference was replaced: the scan was never measured against one.
  const TITLE = "This scan was placed by its own two points and was not matched to this Place's reference, so it is not in the Place frame."
  const replacedAfter = { spatialFrame: frame({ frameId: 'frame-now' }), frameHistory: [entry({ frameId: null, supersededAt: '2026-11-17T00:00:00.000Z' })] }
  const places: Array<[string, Parameters<typeof frameChipFor>[1]]> = [
    ['a Place whose frame has an id', NOW],
    ['a Place whose frame has none', { spatialFrame: frame() }],
    ['a Place that replaced a frame with no id after the scan was made', replacedAfter],
    ['a Place whose history lists the frame the scan names', { spatialFrame: frame({ frameId: 'frame-now' }), frameHistory: [entry({ frameId: 'frame-old' })] }],
  ]
  for (const [what, place] of places) {
    for (const calibrationFrameId of [undefined, 'frame-now', 'frame-old']) {
      const chip = frameChipFor(outside({ calibrationFrameId }), place)
      assert.equal(chip?.kind, 'not-in-frame', `${what}, scan names ${String(calibrationFrameId)}`)
      assert.equal(chip?.text, NOT_IN_FRAME_TEXT)
      assert.equal(chip?.title, TITLE)
    }
  }
  assert.doesNotMatch(TITLE, /numbered|previous|replaced/, 'the explanation is its own')

  // Only the statement itself counts: the boolean true. Anything else a hand-edited sidecar could carry reads as the record saying nothing.
  for (const value of [false, 'true', 1, null, {}]) {
    const chip = frameChipFor(twoPointScan({ calibrationOutsidePlaceFrame: value } as unknown as Partial<Scan>), NOW)
    assert.notEqual(chip?.kind, 'not-in-frame', `calibrationOutsidePlaceFrame: ${JSON.stringify(value)}`)
  }
  // A scan that is not in a frame for another reason keeps that reason's own words, marker or none.
  assert.match(frameChipFor({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', calibrationOutsidePlaceFrame: true } as Scan, NOW)!.title, /one point and the compass/)
  assert.match(frameChipFor({ calibrationMethod: undefined, calibrationStatus: 'uncalibrated', calibrationOutsidePlaceFrame: true } as Scan, NOW)!.title, /not aligned to this Place's reference/)
  // A Place with no reference has nothing to be in or out of, for this scan as for every other.
  for (const place of [null, undefined, {}, { spatialFrame: null }]) assert.equal(frameChipFor(outside(), place), null)
})

// ── The banner ───────────────────────────────────────────────────────────────────────────────────────

const SCANS: Scan[] = [
  twoPointScan({ calibrationFrameId: 'frame-now' }),
  twoPointScan({ calibrationFrameId: 'frame-old' }),
  twoPointScan({ calibrationFrameId: 'frame-old' }),
  twoPointScan(),
  { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' },
  { calibrationMethod: undefined, calibrationStatus: 'uncalibrated' },
]

test('the summary counts each kind, and the banner says only what the counts and the Place\'s record say', () => {
  const summary = summariseFrames(SCANS, NOW)
  assert.deepEqual(summary, { previous: 2, notInFrame: 2, notRecorded: 1 })
  assert.deepEqual(frameBannerLines(summary, NOW), [
    '2 scans were measured against a previous reference and may not line up with the current one.',
    'The reference was last replaced on 2026-11-03 (UTC), after the points did not match.',
    "2 scans are not in this Place's frame.",
    '1 scan does not say which reference it was made against.',
  ])
})

test('the summary counts a scan placed by its own pair with the scans that are not in the Place frame, and not with those that do not say which reference they were made against', () => {
  const summary = summariseFrames([...SCANS, twoPointScan({ calibrationOutsidePlaceFrame: true }), twoPointScan({ calibrationOutsidePlaceFrame: true, calibrationFrameId: 'frame-old' })], NOW)
  assert.deepEqual(summary, { previous: 2, notInFrame: 4, notRecorded: 1 })
  assert.deepEqual(frameBannerLines(summary, NOW).slice(-2), ["4 scans are not in this Place's frame.", '1 scan does not say which reference it was made against.'])
})

test('the banner is silent when there is nothing to say, and singular where there is one', () => {
  assert.deepEqual(frameBannerLines({ previous: 0, notInFrame: 0, notRecorded: 0 }, NOW), [])
  assert.deepEqual(frameBannerLines(summariseFrames([twoPointScan({ calibrationFrameId: 'frame-now' })], NOW), NOW), [])
  assert.deepEqual(frameBannerLines({ previous: 1, notInFrame: 1, notRecorded: 0 }, { spatialFrame: NOW.spatialFrame }), [
    '1 scan was measured against a previous reference and may not line up with the current one.',
    "1 scan is not in this Place's frame.",
  ], 'no replacement date where the Place records none')
  for (const reason of ['override', 'upgrade', 'merge'] as const) {
    const lines = frameBannerLines({ previous: 1, notInFrame: 0, notRecorded: 0 }, { spatialFrame: NOW.spatialFrame, frameHistory: [entry({ reason })] })
    assert.match(lines[1]!, /^The reference was last replaced on 2026-11-03 \(UTC\), (after the points did not match|to improve it|after two Places were merged)\.$/)
  }
  const unreadableDate = frameBannerLines({ previous: 1, notInFrame: 0, notRecorded: 0 }, { spatialFrame: NOW.spatialFrame, frameHistory: [entry({ supersededAt: 'later' })] })
  assert.equal(unreadableDate.length, 1, 'a date that is not one is not printed')
})

// ── The order of the list ────────────────────────────────────────────────────────────────────────────

const row = (id: string, element: object | undefined) => ({ id, element })

test('the order the list was built in is kept, a scan that arrives later goes to the front, and a removed one is forgotten', () => {
  const [a, b, c, d, e] = [{}, {}, {}, {}, {}]
  const order = new NaturalOrder<object>()
  order.see([row('a', a), row('b', b), row('c', c)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['a', 'b', 'c'])

  // The editor prepends what a refresh brings, one after another, so the last one is in front.
  order.see([row('a', a), row('b', b), row('c', c), row('d', d), row('e', e)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['e', 'd', 'a', 'b', 'c'])
  order.see([row('a', a), row('b', b), row('c', c), row('d', d), row('e', e)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['e', 'd', 'a', 'b', 'c'], 'seeing it again changes nothing')

  order.see([row('a', a), row('c', c), row('d', d), row('e', e)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['e', 'd', 'a', 'c'], 'a scan the world no longer lists is dropped')
  assert.equal(order.ordered().find((entry) => entry.id === 'a')?.element, a, 'and the rows are the ones it was given')
})

test('a list built again is numbered from the world\'s order again, whether it is another Place or the same scans in new rows', () => {
  const order = new NaturalOrder<object>()
  order.see([row('a', {}), row('b', {}), row('c', {})])
  order.see([row('c', {}), row('b', {}), row('x', {})])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['c', 'b', 'x'], 'new elements for every scan: a rebuilt list, in the world\'s order')
  // A scan with no row yet is not numbered, and does not make the others look new.
  const [p, q] = [{}, {}]
  order.see([row('p', p), row('q', q)])
  order.see([row('p', p), row('q', q), row('late', undefined)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['p', 'q'])
  const late = {}
  order.see([row('p', p), row('q', q), row('late', late)])
  assert.deepEqual(order.ordered().map((entry) => entry.id), ['late', 'p', 'q'], 'it is numbered when its row exists, in front')
  order.see([])
  assert.deepEqual(order.ordered(), [])
})

test('grouped, the previous-reference rows come after the rest with the heading between, each group in the order it was built in', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, element: id.toUpperCase() }))
  const previous = new Set(['b', 'd'])
  assert.deepEqual(listingOrder(rows, true, previous, 'HEADING'), ['A', 'C', 'E', 'HEADING', 'B', 'D'])
  assert.deepEqual(listingOrder(rows, false, previous, 'HEADING'), ['A', 'B', 'C', 'D', 'E'], 'ungrouped, the order it was built in and no heading')
  assert.deepEqual(listingOrder(rows, true, new Set<string>(), 'HEADING'), ['A', 'B', 'C', 'D', 'E', 'HEADING'])
})

// ── The layer: dimming on real materials ─────────────────────────────────────────────────────────────

function scanRoot(): { root: THREE.Group; meshes: THREE.Mesh[]; original: THREE.Material[] } {
  const root = new THREE.Group()
  const meshes = [new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x336699 })), new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0x993366 }))]
  meshes.forEach((mesh) => root.add(mesh))
  return { root, meshes, original: meshes.map((mesh) => mesh.material as THREE.Material) }
}

const opacities = (meshes: THREE.Mesh[]) => meshes.map((mesh) => (mesh.material as THREE.Material).opacity)

test('a scan of a previous reference is dimmed with the compare tools\' see-through, once, and put back when it is not to be', () => {
  const a = scanRoot()
  const dimmed = new Set<string>()
  const apply = (on: boolean) => applyPreviousReferenceDim([['a', a.root]], () => on, dimmed)

  apply(true)
  assert.deepEqual(opacities(a.meshes), [0.5, 0.5], 'half strength, which is what the stitching work package asked of see-through')
  assert.deepEqual(appliedStyle(a.root), { tint: null, ghost: true })
  assert.deepEqual([...dimmed], ['a'])
  const dimmedMaterials = a.meshes.map((mesh) => mesh.material)
  apply(true)
  assert.deepEqual(a.meshes.map((mesh) => mesh.material), dimmedMaterials, 'applied again it does not stack: the same copies')
  assert.deepEqual(opacities(a.meshes), [0.5, 0.5])

  apply(false)
  assert.deepEqual(a.meshes.map((mesh) => mesh.material), a.original, 'the materials the scan had are back, not copies of them')
  assert.deepEqual(appliedStyle(a.root), PLAIN_STYLE)
  assert.equal(dimmed.size, 0)
})

test('a scan the compare tools have tinted is left alone, and a scan they made see-through is never taken off here', () => {
  const tinted = scanRoot()
  applyCompareStyle(tinted.root, { tint: 0x4fc3f7, ghost: false })
  const tintedMaterials = tinted.meshes.map((mesh) => mesh.material)
  const dimmed = new Set<string>()
  applyPreviousReferenceDim([['tinted', tinted.root]], () => true, dimmed)
  assert.deepEqual(tinted.meshes.map((mesh) => mesh.material), tintedMaterials, 'styled on purpose by someone else')
  assert.equal(dimmed.has('tinted'), false)

  const theirs = scanRoot()
  applyCompareStyle(theirs.root, { tint: null, ghost: true })
  const theirMaterials = theirs.meshes.map((mesh) => mesh.material)
  applyPreviousReferenceDim([['theirs', theirs.root]], () => true, dimmed)
  assert.deepEqual(theirs.meshes.map((mesh) => mesh.material), theirMaterials, 'already see-through: nothing to do')
  assert.equal(dimmed.has('theirs'), false, 'and not claimed')
  applyPreviousReferenceDim([['theirs', theirs.root]], () => false, dimmed)
  assert.deepEqual(appliedStyle(theirs.root), { tint: null, ghost: true }, 'the layer going off does not undo their see-through')
})

test('a scan whose materials were replaced is dimmed again, and one that is gone is forgotten', () => {
  const a = scanRoot()
  const dimmed = new Set<string>()
  applyPreviousReferenceDim([['a', a.root]], () => true, dimmed)
  // The compare tools clear a style and put the plain materials back (a view mode does the same).
  applyCompareStyle(a.root, PLAIN_STYLE)
  assert.deepEqual(opacities(a.meshes), [1, 1])
  applyPreviousReferenceDim([['a', a.root]], () => true, dimmed)
  assert.deepEqual(opacities(a.meshes), [0.5, 0.5], 'dimmed again')
  applyPreviousReferenceDim([['a', undefined]], () => true, dimmed)
  assert.equal(dimmed.has('a'), false)
})

test('a scan that is not of a previous reference is not touched', () => {
  const a = scanRoot()
  const dimmed = new Set<string>()
  applyPreviousReferenceDim([['a', a.root]], () => false, dimmed)
  assert.deepEqual(a.meshes.map((mesh) => mesh.material), a.original)
  assert.equal(dimmed.size, 0)
})

test('the style a scan carries now is read from its materials, whoever applied it', () => {
  const none = scanRoot()
  assert.deepEqual(appliedStyle(none.root), PLAIN_STYLE)
  assert.deepEqual(appliedStyle(new THREE.Group()), PLAIN_STYLE, 'a scan with no materials carries none')

  const both = scanRoot()
  applyCompareStyle(both.root, { tint: 0x4fc3f7, ghost: true })
  assert.deepEqual(appliedStyle(both.root), { tint: 0x4fc3f7, ghost: true })

  const mixed = scanRoot()
  applyCompareStyle(mixed.meshes[0]!, { tint: null, ghost: true })
  assert.equal(appliedStyle(mixed.root), null, 'a scan with parts styled apart does not have one style')
  assert.equal(baseMaterial(mixed.meshes[0]!.material as THREE.Material), mixed.original[0], 'and nothing was lost')
})

// ── A merge or a reassign the server refused ─────────────────────────────────────────────────────────

const refusal = (body: unknown, status = 409) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('the server\'s sentence for a refused merge is read without using up the response', async () => {
  const response = refusal({ code: 'frame-mismatch', error: 'These Places have different references.' })
  assert.equal(await frameMismatchMessage(response), 'These Places have different references.')
  assert.deepEqual(await response.json(), { code: 'frame-mismatch', error: 'These Places have different references.' }, 'the caller can still read it')
  assert.equal(await frameMismatchMessage(refusal({ code: 'frame-mismatch' })), FRAME_MISMATCH_FALLBACK, 'a refusal with no sentence gets a readable one')
  assert.equal(await frameMismatchMessage(refusal({ error: 'project has scans', scanCount: 2 })), null)
  assert.equal(await frameMismatchMessage(refusal({ code: 'frame-mismatch' }, 400)), null)
  assert.equal(await frameMismatchMessage(new Response('<html>', { status: 409 })), null, 'a body that is not JSON is not this refusal')
  assert.match(FRAME_MISMATCH_FALLBACK, /different references/)
})

test('a refused request is sent again with `acceptFrameMismatch` only when the person says go on', async () => {
  const sent: boolean[] = []
  const answers = [refusal({ code: 'frame-mismatch', error: 'Different references.' }), refusal({ ok: true }, 200)]
  const send = (accept: boolean) => { sent.push(accept); return Promise.resolve(answers.shift()!) }
  const asked: string[] = []
  const yes = await sendUnlessReferencesDiffer(send, (message) => { asked.push(message); return true })
  assert.deepEqual(sent, [false, true])
  assert.deepEqual(asked, ['Different references.'], 'the person is shown the server\'s sentence')
  assert.equal(yes.status, 200, 'the answer that counts is the retry\'s')

  sent.length = 0
  const no = await sendUnlessReferencesDiffer(
    (accept) => { sent.push(accept); return Promise.resolve(refusal({ code: 'frame-mismatch', error: 'Different references.' })) },
    () => false,
  )
  assert.deepEqual(sent, [false], 'a no sends nothing more')
  assert.equal(no.status, 409, 'and the refusal stands')

  sent.length = 0
  const fine = await sendUnlessReferencesDiffer((accept) => { sent.push(accept); return Promise.resolve(refusal({ ok: true }, 200)) }, () => { throw new Error('asked about a request that was not refused') })
  assert.deepEqual(sent, [false])
  assert.equal(fine.status, 200)

  const other = await sendUnlessReferencesDiffer(() => Promise.resolve(refusal({ error: 'project has scans' })), () => { throw new Error('asked about another 409') })
  assert.equal(other.status, 409)
})

test('a request that never gets an answer is null, not an error nobody reads: the panel says it needs a connection', async () => {
  const down = () => Promise.reject(new TypeError('Failed to fetch'))
  assert.equal(await sendUnlessReferencesDiffer(down, () => { throw new Error('asked about a request that got no answer') }), null)

  // The one the person agreed to is the one that can fail: the first was refused, and they said go on.
  const sent: boolean[] = []
  const droppedOnRetry = await sendUnlessReferencesDiffer(
    (accept) => { sent.push(accept); return accept ? down() : Promise.resolve(refusal({ code: 'frame-mismatch', error: 'Different references.' })) },
    () => true,
  )
  assert.deepEqual(sent, [false, true])
  assert.equal(droppedOnRetry, null)

  // A broken question is not a missing network: it is not swallowed.
  await assert.rejects(
    sendUnlessReferencesDiffer(() => Promise.resolve(refusal({ code: 'frame-mismatch' })), () => { throw new Error('the dialog broke') }),
    /the dialog broke/,
  )
  assert.equal(MERGE_NEEDS_CONNECTION, 'Merging Places needs a connection')
  assert.equal(ASSIGN_NEEDS_CONNECTION, 'Moving a scan needs a connection')
})

test('what the Places panel asks after a refusal is the server\'s sentence, and then what going on does and does not do', () => {
  const sentence = 'These Places have different references.'
  assert.equal(
    mergeQuestion(sentence),
    `${sentence}\n\nMerge anyway? The scans of the merged Place are not moved to match this Place's reference.`,
  )
  assert.equal(
    assignQuestion(sentence),
    `${sentence}\n\nAssign anyway? The scan is not moved to match this Place's reference.`,
  )
  // The server's own words come first and unchanged, so a refusal it words differently is still read as it says it.
  assert.ok(mergeQuestion('Another sentence.').startsWith('Another sentence.\n\n'))
  assert.ok(assignQuestion('Another sentence.').startsWith('Another sentence.\n\n'))
})

// ── The wiring, read as text ─────────────────────────────────────────────────────────────────────────

test('source shape: the editor draws the layer from its scan list, refresh and layer visibility, and the Places panel asks before mixing references and does not queue', () => {
  const viewer = readFileSync(join(ROOT, 'src/viewer/viewer.ts'), 'utf8')
  assert.match(viewer, /import \{ createFrameReference \} from '\.\/frame-banner'/)
  assert.match(viewer, /const frameReference = createFrameReference\(\{\n\s+scans: \(\) => world\?\.scans \?\? \[\],\n\s+place: \(\) => currentProject,/)
  assert.match(viewer, /listEl\.appendChild\(item\)\n  \}\n  frameReference\.sync\(\)\n\}/, 'when the list is built')
  assert.match(viewer, /<\/div>`\n(?:\s+\/\/.*\n)?\s+frameReference\.sync\(\)\n\s+return\n\s+\}/, 'and when it is built with no scan in it, so the last Place\'s banner does not stay')
  assert.match(viewer, /styled: \(\) => frameReference\.apply\(\),/, 'and when the compare tools change a scan\'s style')
  const stitch = readFileSync(join(ROOT, 'src/viewer/stitch-tools.ts'), 'utf8')
  assert.match(stitch, /if \(loaded\?\.loaded\) applyCompareStyle\(loaded\.root, style\)\n\s+host\.styled\?\.\(\)/)
  assert.match(viewer, /escHtml,\n  \)\n(?:\s+\/\/.*\n)?\s+frameReference\.sync\(\)\n\}/, 'when the scans\' meta is redrawn, which the world refresh does')
  assert.match(viewer, /listEl\.prepend\(item\)[^]*?\n    \}\n    frameReference\.sync\(\)\n    updateHudInfo\(\)/, 'after a refresh brings new scans')
  assert.match(viewer, /stitch\?\.reapplyCompare\(\)\n  frameReference\.apply\(\)/, 'after the compare tools have reapplied theirs')

  const html = readFileSync(join(ROOT, 'viewer.html'), 'utf8')
  for (const id of ['frame-banner', 'frame-previous-toggle', 'frame-previous-status', 'frame-reference-section']) assert.match(html, new RegExp(`id="${id}"`), id)
  assert.match(html, /<input type="checkbox" id="frame-previous-toggle" class="layer-toggle" checked \/>/, 'on by default')
  assert.match(html, /<div id="frame-banner" class="frame-banner" role="status" hidden><\/div>/, 'the banner is a status: a screen reader is told when it changes')
  // A scan of a previous reference is set apart by its heading and a quieter name. The whole row is not dimmed: that left the chip and
  // the meta text below the contrast a small text needs, and overrode the timeline's own dimming of a scan outside the window.
  assert.doesNotMatch(html, /\.scan-item\.scan-previous-reference\s*\{[^}]*opacity/, 'no row opacity for a previous-reference scan')
  assert.match(html, /\.scan-item\.scan-previous-reference \.scan-name \{ color: rgba\(255,255,255,0\.7\); \}/, 'its name is quieter')

  const places = readFileSync(join(ROOT, 'src/viewer/places.ts'), 'utf8')
  assert.equal(places.split('sendUnlessReferencesDiffer(').length - 1, 2, 'the merge and the assign')
  assert.match(places, /\(message\) => confirm\(mergeQuestion\(message\)\),/, 'the merge asks with the merge question')
  assert.match(places, /\(message\) => confirm\(assignQuestion\(message\)\),/, 'and the move with the move question')
  assert.match(places, /if \(answer === null\) \{\n\s+alert\(MERGE_NEEDS_CONNECTION\)\n\s+return\n\s+\}/, 'a merge that got no answer says it needs a connection')
  assert.match(places, /if \(answer === null\) \{\n\s+alert\(ASSIGN_NEEDS_CONNECTION\)\n\s+return\n\s+\}/, 'and so does a move')
  assert.equal(places.split('...noQueueHeaders()').length - 1, 2, 'neither is queued: a refusal is for the person to read, and the worker would drop a queued one')
  assert.equal(places.split('...(acceptFrameMismatch ? { acceptFrameMismatch } : {})').length - 1, 2, 'the flag is in the body only on a retry the person agreed to')
})
