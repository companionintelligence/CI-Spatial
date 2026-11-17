/**
 * What replacing a Place's reference means on the phone (WP-08): ../../../src/world/frame-replacement.ts.
 *
 * A Place's frame is replaced by a new generation, not edited. These tests hold the pure part of that to what the spec
 * settles: a new frame gets a client-minted id, the calibration names the generation it was measured against, a frame that
 * replaces one the Place holds says which and why, an unknown (legacy) generation is neutral and never "different", and what
 * the server answers is read in one place and read cautiously: a status the phone cannot understand is "could not check",
 * never "no scans".
 *
 * The status body is the one ADR 0011 gives (`FrameStatus`), and the tests read bodies a stand-in for that server builds from
 * scans (./support/fake-frame-server.ts), so the reader is held to the real field names and not to the ones its author
 * assumed.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-frame-replacement.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT,
  affectedScans,
  calibrationFrameIdOf,
  frameIdOf,
  improveOffered,
  isFrameReplaces,
  newFrameId,
  planFrameGeneration,
  readFrameMismatch,
  readFrameStatus,
} from '../../../src/world/frame-replacement.ts'
import { CHECK_POINT_DEFAULT_ON } from '../../../src/ar/constellation-flow.ts'
import { replaceNeedsTypedWord } from '../../../src/ar/replace-copy.ts'
import { isFrameId } from '../../../src/world/spatial-frame.ts'
import type { ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'
import { FakeFrameServer, twoPointScan, type ScanFacts } from './support/fake-frame-server.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const twoPoint = (separationM: number, extra: Record<string, unknown> = {}): ProjectSpatialFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...extra,
}) as ProjectSpatialFrame

const onePoint: ProjectSpatialFrame = { version: 1, createdAt: '2026-10-01T00:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 }

const twoPointCalibration = (extra: Record<string, unknown> = {}): ScanCalibration => ({
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  calibratedAt: '2026-11-16T09:30:00.000Z',
  status: 'provisional',
  separationM: 3,
  residualM: 0,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...extra,
}) as ScanCalibration

const onePointCalibration: ScanCalibration = {
  method: 'ground-tap-compass',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  calibratedAt: '2026-11-16T09:30:00.000Z',
  status: 'provisional',
  anchorBearingDeg: 12,
}

const mint = (id: string) => () => id

// ── Ids ──────────────────────────────────────────────────────────────────────────────────────────────

test('a new frame id is a UUID where the page has one, and is a safe id where it has not', () => {
  const withUuid = newFrameId({ randomUUID: () => '3b241101-e2bb-4255-8caf-4136c566a962' })
  assert.equal(withUuid, '3b241101-e2bb-4255-8caf-4136c566a962')
  // An old webview: no randomUUID, and maybe no getRandomValues either. The time and random bytes, which `isFrameId` accepts.
  const withBytes = newFrameId({ getRandomValues: ((array: Uint8Array) => array.fill(0xab)) as Crypto['getRandomValues'] })
  assert.match(withBytes, /^[0-9a-z]+-abababababababab$/)
  const withNothing = newFrameId({})
  for (const id of [withUuid, withBytes, withNothing, newFrameId()]) assert.ok(isFrameId(id), `${id} is a frame id`)
  assert.notEqual(newFrameId(), newFrameId(), 'two calibrations never share an id')
})

test('the generation of a frame: its id, or none for an unknown one', () => {
  assert.equal(frameIdOf(twoPoint(3, { frameId: 'frame-a' })), 'frame-a')
  assert.equal(frameIdOf(twoPoint(3)), null, 'a frame written before ids existed')
  assert.equal(frameIdOf(twoPoint(3, { frameId: 'a b/c' })), null, 'a value that cannot be an id is not one')
  assert.equal(frameIdOf(twoPoint(3, { frameId: 7 })), null)
  assert.equal(frameIdOf(onePoint), null, 'the one-point member carries none')
  assert.equal(frameIdOf(undefined), null)
  assert.equal(frameIdOf(null), null)
})

test('the generation a calibration names: only a two-point one has any', () => {
  assert.equal(calibrationFrameIdOf(twoPointCalibration({ frameId: 'frame-a' })), 'frame-a')
  assert.equal(calibrationFrameIdOf(twoPointCalibration()), null)
  assert.equal(calibrationFrameIdOf(twoPointCalibration({ frameId: '../x' })), null)
  assert.equal(calibrationFrameIdOf({ ...onePointCalibration, frameId: 'frame-a' } as unknown as ScanCalibration), null, 'a one-point record never names one')
  assert.equal(calibrationFrameIdOf(undefined), null)
  assert.equal(calibrationFrameIdOf(null), null)
})

// ── Stamping a calibration ───────────────────────────────────────────────────────────────────────────

test('a first calibration: the new frame has an id, the calibration names it, and nothing is replaced', () => {
  const frame = twoPoint(3)
  const plan = planFrameGeneration({ held: undefined, calibration: twoPointCalibration(), spatialFrame: frame, mint: mint('frame-1') })
  assert.equal(frameIdOf(plan.spatialFrame), 'frame-1')
  assert.equal(calibrationFrameIdOf(plan.calibration), 'frame-1', 'the scan names the generation it created')
  assert.equal(plan.replaces, undefined)
  assert.equal(plan.superseded, undefined)
  assert.equal('frameId' in frame, false, 'the frame the flow made is not changed: a frame is immutable')
})

test('a return visit that matched keeps the Place frame, and its calibration names that frame', () => {
  const held = twoPoint(3, { frameId: 'frame-held' })
  const plan = planFrameGeneration({ held, calibration: twoPointCalibration({ status: 'verified' }), mint: mint('never') })
  assert.equal(plan.spatialFrame, undefined, 'no frame is written')
  assert.equal(plan.replaces, undefined)
  assert.equal(calibrationFrameIdOf(plan.calibration), 'frame-held')
})

test('a return visit to a frame with no id leaves the calibration unnamed: an unknown generation is neutral', () => {
  const calibration = twoPointCalibration({ status: 'verified' })
  const plan = planFrameGeneration({ held: twoPoint(3), calibration })
  assert.deepEqual(plan.calibration, calibration)
  assert.equal('frameId' in plan.calibration, false)
})

test('a pair kept over a mismatch is a new generation that replaces the held one, for the reason override', () => {
  const held = twoPoint(3, { frameId: 'frame-held' })
  const heldBefore = structuredClone(held)
  const plan = planFrameGeneration({
    held,
    calibration: twoPointCalibration({ residualM: 0.4, toleranceM: 0.15 }),
    spatialFrame: twoPoint(3.4),
    mint: mint('frame-new'),
  })
  assert.equal(frameIdOf(plan.spatialFrame), 'frame-new')
  assert.equal(calibrationFrameIdOf(plan.calibration), 'frame-new')
  assert.deepEqual(plan.replaces, { frameId: 'frame-held', reason: 'override' })
  assert.equal(plan.superseded, held, 'the superseded frame is the one the Place held, as it was')
  assert.deepEqual(held, heldBefore, 'and it was not changed')
})

test('replacing a frame that has no id names none: the replaced generation is unknown', () => {
  const plan = planFrameGeneration({ held: twoPoint(3), calibration: twoPointCalibration(), spatialFrame: twoPoint(3.4), mint: mint('frame-new') })
  assert.deepEqual(plan.replaces, { frameId: null, reason: 'override' })
})

test('improving the reference is an upgrade, and so is a one-point frame replaced by a two-point one', () => {
  const upgraded = planFrameGeneration({
    held: twoPoint(3, { frameId: 'frame-held' }),
    calibration: twoPointCalibration(),
    spatialFrame: twoPoint(3.05),
    mode: 'upgrade',
    mint: mint('frame-new'),
  })
  assert.deepEqual(upgraded.replaces, { frameId: 'frame-held', reason: 'upgrade' })

  const fromOnePoint = planFrameGeneration({ held: onePoint, calibration: twoPointCalibration(), spatialFrame: twoPoint(3), mint: mint('frame-new') })
  assert.deepEqual(fromOnePoint.replaces, { frameId: null, reason: 'upgrade' })
  assert.equal(fromOnePoint.superseded, onePoint)
})

test('a one-point frame carries no id, and a one-point calibration names none', () => {
  const frame: ProjectSpatialFrame = { ...onePoint }
  const plan = planFrameGeneration({ held: undefined, calibration: onePointCalibration, spatialFrame: frame, mint: mint('never') })
  assert.deepEqual(plan.spatialFrame, frame)
  assert.equal('frameId' in (plan.spatialFrame as object), false)
  assert.deepEqual(plan.calibration, onePointCalibration)
  assert.equal(plan.replaces, undefined)
})

test('the plan does not change what it is given', () => {
  const held = Object.freeze(twoPoint(3, { frameId: 'frame-held' }))
  const calibration = Object.freeze(twoPointCalibration())
  const spatialFrame = Object.freeze(twoPoint(3.4))
  assert.doesNotThrow(() => planFrameGeneration({ held, calibration, spatialFrame, mint: mint('frame-new') }))
})

test('what the write says about the frame it replaces is a generation or none, and one of three reasons', () => {
  assert.equal(isFrameReplaces({ frameId: 'frame-a', reason: 'override' }), true)
  assert.equal(isFrameReplaces({ frameId: null, reason: 'upgrade' }), true)
  assert.equal(isFrameReplaces({ frameId: 'frame-a', reason: 'merge' }), true)
  assert.equal(isFrameReplaces({ frameId: 'frame-a', reason: 'reset' }), false, 'reset is deferred')
  assert.equal(isFrameReplaces({ frameId: 'a b', reason: 'override' }), false)
  assert.equal(isFrameReplaces({ reason: 'override' }), false)
  assert.equal(isFrameReplaces(null), false)
})

// ── Improving a reference ────────────────────────────────────────────────────────────────────────────

test('"Improve this Place\'s reference" is offered because the first-calibration flow asks for a check point, and only for a two-point frame without one', () => {
  assert.equal(FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT, CHECK_POINT_DEFAULT_ON, 'the switch is the flow\'s own: the check-point step is what the upgrade gives')
  assert.equal(FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT, true, 'and the flow asks for one by default (WP-04b)')
  assert.equal(improveOffered(twoPoint(3)), true, 'so a two-point Place without a check point is offered it')
  assert.equal(improveOffered(twoPoint(3), false), false, 'and nothing is offered where the flow would not ask for one')

  assert.equal(improveOffered(twoPoint(3), true), true)
  assert.equal(improveOffered(twoPoint(3, { checkPoints: [] }), true), true, 'an empty list is no check point')
  assert.equal(improveOffered(twoPoint(3, { checkPoints: [{ x: 1, y: 0, z: 2 }] }), true), false, 'a frame that has one has nothing to improve')
  assert.equal(improveOffered(onePoint, true), false, 'a one-point frame is upgraded by an ordinary two-point visit')
  assert.equal(improveOffered(undefined, true), false)
  assert.equal(improveOffered({ ...twoPoint(3), method: 'something-new' } as unknown as ProjectSpatialFrame, true), false, 'a frame of a kind this build does not know')
})

// ── What the server says about a Place's frame ───────────────────────────────────────────────────────

/** What the stand-in server answers `GET /projects/:id/frame-status` with, for a Place that holds `frame` and has `scans`. */
const statusOf = (frame: ProjectSpatialFrame | null, scans: ScanFacts[], revision = 2): Record<string, unknown> =>
  JSON.parse(JSON.stringify(new FakeFrameServer({ frame, scans, revision }).statusBody()))

const NOT_IN_FRAME: ScanFacts[] = [
  { calibrationStatus: 'uncalibrated' },
  { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' },
  { calibrationMethod: 'known-distance', calibrationStatus: 'provisional' },
]

test('a frame with an id: the scans that name it are what a replacement leaves behind', () => {
  const frame = twoPoint(3, { frameId: 'frame-now' })
  const body = statusOf(frame, [twoPointScan('frame-now'), twoPointScan('frame-now'), twoPointScan('frame-now'), twoPointScan('frame-old'), twoPointScan(), ...NOT_IN_FRAME])
  assert.equal(body['scansOnCurrentFrame'], 3, 'the server counts it for us')
  assert.deepEqual(readFrameStatus(body), { holdsFrame: true, frameId: 'frame-now', scansOnReference: 3 })
  assert.deepEqual(affectedScans(readFrameStatus(body)), { kind: 'known', count: 3, named: true })

  const none = statusOf(frame, [twoPointScan('frame-old'), twoPointScan()])
  assert.deepEqual(affectedScans(readFrameStatus(none)), { kind: 'known', count: 0, named: true }, 'a frame no scan names has no scans tied to it')
})

test('a frame with no id, which is every Place that exists today: the scans that name none are counted, from the field the server counts them in', () => {
  const legacy = twoPoint(3)
  const body = statusOf(legacy, [twoPointScan(), twoPointScan(), twoPointScan(), twoPointScan('frame-aaa'), twoPointScan('frame-bbb'), ...NOT_IN_FRAME])
  assert.equal(body['frameId'], null)
  assert.equal(body['unrecordedScans'], 3)
  assert.deepEqual(body['scansByFrame'], { 'frame-aaa': 1, 'frame-bbb': 1 }, 'real ids only: the scans that name none are not in it')
  assert.deepEqual(affectedScans(readFrameStatus(body)), { kind: 'known', count: 3, named: false })

  assert.deepEqual(affectedScans(readFrameStatus(statusOf(legacy, [twoPointScan('frame-aaa'), ...NOT_IN_FRAME]))), { kind: 'known', count: 0, named: false }, 'none name none: none')
})

test('a Place with no frame, and one with a one-point frame, have no scans tied to the reference', () => {
  assert.deepEqual(affectedScans(readFrameStatus(statusOf(null, [twoPointScan(), ...NOT_IN_FRAME], 0))), { kind: 'known', count: 0, named: false })
  const onePointStatus = statusOf(onePoint, [twoPointScan(), ...NOT_IN_FRAME])
  assert.equal(onePointStatus['scansOnCurrentFrame'], 0, 'a one-point scan names no generation, so none is tied to the frame')
  assert.deepEqual(affectedScans(readFrameStatus(onePointStatus)), { kind: 'known', count: 0, named: false })
})

test('the count the server gives for a replacement is used as it is; without it the phone works it out from the parts, the same way', () => {
  const given = { ...statusOf(twoPoint(3, { frameId: 'frame-now' }), [twoPointScan('frame-now')]), scansOnCurrentFrame: 9 }
  assert.deepEqual(affectedScans(readFrameStatus(given)), { kind: 'known', count: 9, named: true }, 'its own answer to this question')

  for (const [what, frame, scans] of [
    ['a frame with an id', twoPoint(3, { frameId: 'frame-now' }), [twoPointScan('frame-now'), twoPointScan('frame-now'), twoPointScan()]],
    ['a frame with none', twoPoint(3), [twoPointScan(), twoPointScan('frame-aaa')]],
    ['a one-point frame', onePoint, [twoPointScan()]],
    ['no frame', null, [twoPointScan()]],
  ] as const) {
    const body = statusOf(frame, [...scans])
    const answered = readFrameStatus(body)
    const { scansOnCurrentFrame: _dropped, ...withoutIt } = body
    assert.deepEqual(readFrameStatus(withoutIt), answered, `${what}: the parts say what the server's count says`)
  }
})

test('a frame id that is also a name every object has is still just an id', () => {
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const body = { revision: 2, frame: twoPoint(3, { frameId: id }), scansByFrame: {}, unrecordedScans: 4 }
    assert.deepEqual(affectedScans(readFrameStatus(body)), { kind: 'known', count: 0, named: true }, `${id}: no scan names it, and the answer is a number`)
  }
  const named = JSON.parse('{"revision": 2, "frame": {"method": "two-point-ground", "frameId": "__proto__"}, "scansByFrame": {"__proto__": 3}}')
  assert.deepEqual(affectedScans(readFrameStatus(named)), { kind: 'known', count: 3, named: true }, 'and a key of that name, once the server has counted one, is read')
  const trap = JSON.parse('{"revision": 2, "frame": {"method": "two-point-ground", "frameId": "toString"}, "scansByFrame": {"toString": "many"}}')
  assert.deepEqual(affectedScans(readFrameStatus(trap)), { kind: 'unknown' }, 'a count that is not a number is not read as one')
})

test('a status that cannot be read is never "no scans"', () => {
  const frame = twoPoint(3, { frameId: 'frame-now' })
  const ok = { revision: 2, frame, scansOnCurrentFrame: 2 }
  assert.deepEqual(affectedScans(readFrameStatus(ok)), { kind: 'known', count: 2, named: true })

  for (const [what, body] of [
    ['not an object', 'banana'],
    ['an array', []],
    ['null', null],
    ['no revision', { ...ok, revision: undefined }],
    ['a revision that is not a count', { ...ok, revision: -1 }],
    ['no frame field at all', { revision: 2, scansOnCurrentFrame: 0 }],
    ['a frame that is not an object', { ...ok, frame: 'frame-now' }],
  ] as const) {
    assert.equal(readFrameStatus(body), null, what)
    assert.deepEqual(affectedScans(readFrameStatus(body)), { kind: 'unknown' }, `${what}: could not check`)
  }

  for (const [what, body] of [
    ['a count that is not a number', { ...ok, scansOnCurrentFrame: 'two' }],
    ['a negative count', { ...ok, scansOnCurrentFrame: -1 }],
    ['a fractional count', { ...ok, scansOnCurrentFrame: 1.5 }],
    ['no count and no parts', { revision: 2, frame }],
    ['parts that are not counts', { revision: 2, frame, scansByFrame: { 'frame-now': 'three' } }],
    ['a map with a count that is not one, beside a frame no scan names', { revision: 2, frame, scansByFrame: { 'frame-old': -2 } }],
    ['a map that is not an object', { revision: 2, frame, scansByFrame: [] }],
    ['a legacy frame and no count of the scans that name none', { revision: 2, frame: twoPoint(3), scansByFrame: {} }],
    ['a legacy frame and a count of them that is not one', { revision: 2, frame: twoPoint(3), unrecordedScans: 'some' }],
  ] as const) {
    assert.deepEqual(affectedScans(readFrameStatus(body)), { kind: 'unknown' }, `${what}: not known, which is not none`)
  }
})

test('the word has to be typed unless the count is a whole number below the threshold: a count that is not one never lets a tap replace a reference', () => {
  assert.equal(replaceNeedsTypedWord({ kind: 'known', count: 0, named: true }), false)
  assert.equal(replaceNeedsTypedWord({ kind: 'known', count: 1, named: true }), true)
  assert.equal(replaceNeedsTypedWord({ kind: 'unknown' }), true)
  assert.equal(replaceNeedsTypedWord('checking'), false, 'the button is off while the count is read')
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Object, {}, 'zero'] as unknown[]) {
    assert.equal(replaceNeedsTypedWord({ kind: 'known', count: count as number, named: true }), true, `${String(count)} is not a count of none`)
  }
})

// ── A merge or a reassign the server refused ─────────────────────────────────────────────────────────

test('the frame-mismatch refusal is read for its sentence, and nothing else is', () => {
  const fallback = 'different references'
  assert.deepEqual(readFrameMismatch(409, { code: 'frame-mismatch', error: 'The two Places have different references.' }, fallback), { message: 'The two Places have different references.' })
  assert.deepEqual(readFrameMismatch(409, { code: 'frame-mismatch' }, fallback), { message: fallback }, 'a refusal with no sentence gets ours, readable')
  assert.deepEqual(readFrameMismatch(409, { code: 'frame-mismatch', error: '   ' }, fallback), { message: fallback })
  assert.equal(readFrameMismatch(409, { error: 'project has scans', scanCount: 2 }, fallback), null, 'another 409 is not this one')
  assert.equal(readFrameMismatch(200, { code: 'frame-mismatch' }, fallback), null)
  assert.equal(readFrameMismatch(409, 'frame-mismatch', fallback), null)
  assert.equal(readFrameMismatch(409, null, fallback), null)
})
