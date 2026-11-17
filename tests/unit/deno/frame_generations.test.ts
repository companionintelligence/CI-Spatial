/**
 * Frame generations (ADR 0009), the pure half: the rules that decide what replacing a Place's frame means
 * (src/world/frame-generations.ts), the server's decisions built on them (server/place_frames.ts) and the
 * compare-and-swap write that applies them (`applySpatialFrameWrite`, server/wp-a-projects.ts).
 *
 * The same rules over HTTP, with the real server, are in frame_generations_route.test.ts.
 *
 * What is pinned:
 *  - a write that replaces the held frame with another generation must say what it replaces and why; the server
 *    refuses one that does not (409, with the held frame, so a client that knows only the stale-revision conflict
 *    adopts it), one that names another frame, and an id reused for a different frame;
 *  - an accepted replacement appends the replaced frame to `Project.frameHistory`, in the same step as the frame,
 *    bounded to the newest 20, and a replay of it appends nothing;
 *  - what every writer did before ids (two calibrations with no ids) still works, and an unknown generation is
 *    never a different frame;
 *  - the scans of a Place are counted by frame from their sidecars, and the counts say how many a replacement
 *    would leave in a previous reference;
 *  - a merge or a moved scan across frames is a mismatch, and a Place with no frame takes the one the scans were
 *    measured against; a Place that takes in scans of another frame describes that frame in its history, once;
 *  - an id is never given to a second frame: not the held frame's, and not one the Place held before.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import {
  appendFrameHistory,
  classifyFrameWrite,
  FRAME_HISTORY_LIMIT,
  FRAME_REPLACE_REASONS,
  frameHistoryEntry,
  frameIdOf,
  frameStatusPath,
  isFrameReplaceReason,
  isInPlaceFrame,
  joinFrameHistory,
  newFrameId,
  parseFrameReplaces,
  sameFrameGeneration,
  sameFrameReference,
} from '../../../src/world/frame-generations.ts'
import { isFrameId } from '../../../src/world/spatial-frame.ts'
import {
  decideMergeFrames,
  decideReassignFrames,
  decideReplacement,
  frameStatusOf,
  framesBroughtByMerge,
  framesNamedByScans,
  knownFrameIds,
  mergeMismatchBody,
  reassignMismatchBody,
  summariseFrame,
  tallyScansByFrame,
} from '../../../server/place_frames.ts'
import { applySpatialFrameWrite } from '../../../server/wp-a-projects.ts'
import type { FrameHistoryEntry, Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

function frame(createdAt: string, separationM = 2, extra: Record<string, unknown> = {}): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...extra,
  } as ProjectSpatialFrame
}

const AT_A = '2026-11-16T08:00:00.000Z'
const AT_B = '2026-11-16T09:00:00.000Z'
const AT_C = '2026-11-16T10:00:00.000Z'

/** Frames with ids: generation A, B and C of one Place. */
const GEN_A = frame(AT_A, 2, { frameId: 'gen-a' })
const GEN_B = frame(AT_B, 3, { frameId: 'gen-b' })
const GEN_C = frame(AT_C, 4, { frameId: 'gen-c' })
/** Generation A again, as a client sends it once it has named its two points. */
const GEN_A_NAMED = frame(AT_A, 2, { frameId: 'gen-a', pointLabels: ['x', 'y'] })
/** A frame written before ids existed. */
const LEGACY_1 = frame(AT_A, 2)
const LEGACY_2 = frame(AT_B, 3)
const ONE_POINT = { version: 1, createdAt: AT_A, method: 'ground-tap-compass', anchorBearingDeg: 12 } as ProjectSpatialFrame

function place(extra: Partial<Project> = {}): Project {
  return {
    projectId: 'proj-1',
    name: 'Home',
    createdAt: 1,
    updatedAt: 1,
    floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [] }],
    ...extra,
  }
}

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function write(projects: Project[], body: Record<string, unknown>, now = NOW) {
  return applySpatialFrameWrite(projects, 'proj-1', body, now)
}

// ── The shared rules ─────────────────────────────────────────────────────────────────────────────

Deno.test('the reasons a write may give are override, upgrade and merge, and reset is deferred', () => {
  assertEquals([...FRAME_REPLACE_REASONS], ['override', 'upgrade', 'merge'])
  for (const reason of FRAME_REPLACE_REASONS) assertEquals(isFrameReplaceReason(reason), true)
  for (const other of ['reset', '', 'OVERRIDE', null, undefined, 1, {}]) assertEquals(isFrameReplaceReason(other), false, String(other))
})

Deno.test('`replaces` is an object with the id of the frame replaced (or null) and a known reason; an absent id is null', () => {
  assertEquals(parseFrameReplaces({ frameId: 'gen-a', reason: 'override' }), { ok: true, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals(parseFrameReplaces({ frameId: null, reason: 'upgrade' }), { ok: true, replaces: { frameId: null, reason: 'upgrade' } })
  assertEquals(parseFrameReplaces({ reason: 'merge' }), { ok: true, replaces: { frameId: null, reason: 'merge' } })
  const refused: Array<[string, unknown]> = [
    ['text', 'override'],
    ['an array', [{ frameId: 'a', reason: 'override' }]],
    ['null', null],
    ['no reason', { frameId: 'gen-a' }],
    ['a reason that is deferred', { frameId: 'gen-a', reason: 'reset' }],
    ['an id that is not safe in a path', { frameId: '../etc', reason: 'override' }],
    ['an id that is a number', { frameId: 4, reason: 'override' }],
    ['an id that is too long', { frameId: 'a'.repeat(65), reason: 'override' }],
  ]
  for (const [what, value] of refused) assertEquals(parseFrameReplaces(value).ok, false, what)
  assertEquals(
    (parseFrameReplaces({ frameId: 'gen-a', reason: 'reset' }) as { error: string }).error,
    'replaces.reason must be override, upgrade, merge',
  )
})

Deno.test('a frame id is read from a frame only when it is one: an unknown generation is null, never another frame', () => {
  assertEquals(frameIdOf(GEN_A), 'gen-a')
  for (const frameWithout of [LEGACY_1, ONE_POINT, null, undefined, 'banana', { frameId: 7 }, { frameId: '../x' }, { frameId: '' }]) {
    assertEquals(frameIdOf(frameWithout), null, JSON.stringify(frameWithout))
  }
})

Deno.test('what a write is, against the frame held: first, the same generation again, another generation, or two with no ids', () => {
  const table: Array<[string, unknown, unknown, string]> = [
    ['nothing held', null, GEN_A, 'first'],
    ['a stored undefined', undefined, GEN_A, 'first'],
    ['the held frame again, same id', GEN_A, { ...GEN_A, referencePhotos: undefined }, 'same-generation'],
    ['the held frame again, the id carried by both and the content changed', GEN_A, GEN_B, 'new-generation'],
    ['another id', GEN_A, { ...GEN_A, frameId: 'gen-x' }, 'new-generation'],
    ['a new id over a frame with none', LEGACY_1, GEN_A, 'new-generation'],
    ['no id over a frame that has one', GEN_A, LEGACY_2, 'new-generation'],
    ['no id on either, the same createdAt: the one calibration in another form', LEGACY_1, { ...LEGACY_1, pointLabels: ['a', 'b'] }, 'same-generation'],
    ['no id on either, another createdAt', LEGACY_1, LEGACY_2, 'legacy-replacement'],
    ['a one-point frame replaced by a two-point one that has an id', ONE_POINT, GEN_A, 'new-generation'],
    ['a one-point frame replaced by another one-point frame', ONE_POINT, { ...ONE_POINT, createdAt: AT_B }, 'legacy-replacement'],
  ]
  for (const [what, held, next, kind] of table) assertEquals(classifyFrameWrite(held, next), kind, what)
})

Deno.test('a frame is the same reference whatever photos and names it gained, and not when a point moved', () => {
  const photo = { url: null, localKey: 'k', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: AT_A }
  const withPoints = frame(AT_A, 2, { frameId: 'gen-a', checkPoints: [{ x: 1, y: 0, z: 1 }] })
  assertEquals(sameFrameReference(GEN_A, { ...GEN_A, referencePhotos: { landmark: photo, headingMarker: photo }, pointLabels: ['a', 'b'] }), true)
  assertEquals(
    sameFrameReference(withPoints, { ...withPoints, checkPoints: [{ x: 1, y: 0, z: 1, label: 'corner', photo }] }),
    true,
    'a check point may gain its label and photo',
  )
  assertEquals(sameFrameReference(withPoints, { ...withPoints, checkPoints: [{ x: 1.2, y: 0, z: 1 }] }), false, 'a check point that moved')
  assertEquals(sameFrameReference(withPoints, { ...withPoints, checkPoints: [] }), false, 'a check point that went')
  assertEquals(sameFrameReference(GEN_A, { ...GEN_A, headingMarker: { x: 0, y: 0, z: 2.5 } }), false, 'the heading marker moved')
  assertEquals(sameFrameReference(GEN_A, { ...GEN_A, createdAt: AT_B }), false, 'another time')
  assertEquals(sameFrameReference(GEN_A, { ...GEN_A, toleranceM: 0.3 }), false, 'a tolerance is part of the reference')
})

Deno.test('two frames are one generation when they share an id, or have none and are the same reference; an id never equals no id', () => {
  assertEquals(sameFrameGeneration(GEN_A, { ...GEN_A, pointLabels: ['x', 'y'] }), true, 'the same id, photos and names apart')
  assertEquals(sameFrameGeneration(GEN_A, GEN_B), false)
  assertEquals(sameFrameGeneration(GEN_A, LEGACY_1), false, 'an id never equals no id')
  assertEquals(sameFrameGeneration(LEGACY_1, { ...LEGACY_1 }), true)
  assertEquals(sameFrameGeneration(LEGACY_1, LEGACY_2), false)

  // Two frames with no id are the same generation when nothing but their photos and names differs: a copy of a frame names
  // the photo files of the Place it was copied to, and that is no reason to call it another frame.
  const record = (url: string | null) => ({ url, localKey: 'k', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: AT_A })
  const photographed = (owner: string | null) => ({
    ...LEGACY_1,
    referencePhotos: {
      landmark: record(owner && `/projects/${owner}/reference-photos/ref-landmark.jpg`),
      headingMarker: record(owner && `/projects/${owner}/reference-photos/ref-headingMarker.jpg`),
    },
    pointLabels: ['door', 'corner'],
  })
  assertEquals(sameFrameGeneration(photographed('proj-x'), photographed('proj-y')), true, 'a copy names its own photo files')
  assertEquals(sameFrameGeneration(photographed('proj-x'), photographed(null)), true, 'a photo that is not on the server is a null url')
  assertEquals(sameFrameGeneration(photographed('proj-x'), LEGACY_1), true, 'a frame that has photos and one that has none')
  assertEquals(sameFrameGeneration(photographed('proj-x'), { ...photographed('proj-y'), headingMarker: { x: 0, y: 0, z: 2.5 } }), false, 'a point that moved is another frame')
  assertEquals(sameFrameGeneration(photographed('proj-x'), { ...photographed('proj-y'), createdAt: AT_B }), false, 'another calibration')
})

Deno.test('the history entry says what the replaced frame says, and invents nothing for what an old frame does not', () => {
  assertEquals(frameHistoryEntry(GEN_A, 'override', NOW), {
    frameId: 'gen-a',
    createdAt: AT_A,
    method: 'two-point-ground',
    separationM: 2,
    supersededAt: '2026-11-17T12:00:00.000Z',
    reason: 'override',
  })
  assertEquals(frameHistoryEntry(ONE_POINT, 'upgrade', NOW), {
    frameId: null,
    createdAt: AT_A,
    method: 'ground-tap-compass',
    separationM: null,
    supersededAt: '2026-11-17T12:00:00.000Z',
    reason: 'upgrade',
  }, 'a one-point frame has no separation')
  const retired = { version: 1, method: 'raycast-reference-triangle', toleranceM: 0.3, createdAt: '2026-07-01T00:00:00.000Z' }
  assertEquals(frameHistoryEntry(retired, 'override', NOW).method, 'raycast-reference-triangle', 'the method an old build wrote')
  assertEquals(frameHistoryEntry('banana', 'override', NOW), {
    frameId: null,
    createdAt: '',
    method: '' as ProjectSpatialFrame['method'],
    separationM: null,
    supersededAt: '2026-11-17T12:00:00.000Z',
    reason: 'override',
  }, 'a frame that is not even an object')
})

Deno.test('the history keeps the newest 20 in order, and a stored value that is not a list is an empty history', () => {
  assertEquals(FRAME_HISTORY_LIMIT, 20)
  let history: FrameHistoryEntry[] = []
  for (let i = 0; i < 25; i++) history = appendFrameHistory(history, frameHistoryEntry(frame(AT_A, 2, { frameId: `gen-${i}` }), 'override', NOW + i))
  assertEquals(history.length, 20)
  assertEquals(history.map((entry) => entry.frameId), Array.from({ length: 20 }, (_, i) => `gen-${i + 5}`), 'the oldest five dropped, the order kept')
  for (const junk of [undefined, null, 'x', 4, { length: 3 }]) {
    assertEquals(appendFrameHistory(junk, history[0]!).length, 1, String(junk))
  }
})

Deno.test('frames another Place held join a history once each, oldest first, and the newest 20 are kept', () => {
  const row = (id: string | null, supersededAt: string, extra: Partial<FrameHistoryEntry> = {}): FrameHistoryEntry =>
    ({ frameId: id, createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt, reason: 'override', ...extra })
  const mine = [row('gen-a', AT_B), row('gen-c', AT_C)]
  // A frame already described is described once, by the row the history has; one that is new goes in by its time.
  const joined = joinFrameHistory(mine, [row('gen-a', AT_A, { reason: 'merge' }), row('gen-b', '2026-11-16T09:30:00.000Z'), row('gen-0', AT_A)])
  assertEquals(joined.map((entry) => [entry.frameId, entry.reason]), [['gen-0', 'override'], ['gen-a', 'override'], ['gen-b', 'override'], ['gen-c', 'override']])
  assertEquals(mine.length, 2, 'the history it was given is not changed')
  // A frame with no id is told apart by when it was made and how.
  const old = row(null, AT_A, { createdAt: '2026-11-01T00:00:00.000Z' })
  assertEquals(joinFrameHistory([old], [{ ...old }, { ...old, createdAt: '2026-11-02T00:00:00.000Z' }]).length, 2)
  // The bound keeps the newest.
  const many = Array.from({ length: 25 }, (_, i) => row(`gen-${i}`, `2026-11-16T10:${String(i).padStart(2, '0')}:00.000Z`))
  const bounded = joinFrameHistory([], many)
  assertEquals([bounded.length, bounded[0]!.frameId, bounded[19]!.frameId], [FRAME_HISTORY_LIMIT, 'gen-5', 'gen-24'])
  assertEquals(joinFrameHistory(undefined, [row('gen-a', AT_A)]).length, 1)
  assertEquals(joinFrameHistory('not a list', []), [], 'a stored value that is not a list is an empty history')
})

Deno.test('a scan is in the Place frame only when it was calibrated with the two-point method', () => {
  const table: Array<[unknown, unknown, boolean]> = [
    ['two-point-ground', 'verified', true],
    ['two-point-ground', 'provisional', true],
    ['two-point-ground', 'uncalibrated', false],
    ['ground-tap-compass', 'provisional', false],
    ['known-distance', 'provisional', false],
    [undefined, undefined, false],
    [undefined, 'uncalibrated', false],
    [null, 'provisional', false],
  ]
  for (const [calibrationMethod, calibrationStatus, expected] of table) {
    assertEquals(isInPlaceFrame({ calibrationMethod, calibrationStatus }), expected, `${calibrationMethod} ${calibrationStatus}`)
  }
})

Deno.test('a frame id the capture client mints is a frame id, in both shapes, and each is new', () => {
  const uuid = newFrameId()
  assert(isFrameId(uuid), uuid)
  assertEquals(uuid.length, 36, 'a UUID where the page has randomUUID')
  // A page without randomUUID: the time and random bytes, as an AR run's id is.
  const fallback = newFrameId({ getRandomValues: ((buffer: Uint8Array) => buffer.fill(0xab)) as Crypto['getRandomValues'] })
  assert(isFrameId(fallback), fallback)
  assert(fallback.length < 30 && !fallback.includes('.'), fallback)
  assertNotEquals(newFrameId(), newFrameId())
  assertEquals(frameStatusPath('proj-1700000000000'), '/projects/proj-1700000000000/frame-status')
  assertEquals(frameStatusPath('proj a/b?'), '/projects/proj%20a%2Fb%3F/frame-status', 'an id is one path segment whatever it holds')
})

// ── The replace rule, as the server applies it ───────────────────────────────────────────────────

Deno.test('an override makes a new generation: the replaced frame goes to the history, in the same step, with the writer\'s reason', () => {
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  const { result, save } = write(projects, { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals(result, { status: 200, body: { revision: 2, frame: GEN_B } })
  assertEquals(save, true)
  assertEquals(projects[0]!.spatialFrame, GEN_B)
  assertEquals(projects[0]!.spatialFrameRevision, 2)
  assertEquals(projects[0]!.frameHistory, [{
    frameId: 'gen-a',
    createdAt: AT_A,
    method: 'two-point-ground',
    separationM: 2,
    supersededAt: '2026-11-17T12:00:00.000Z',
    reason: 'override',
  }])
  assertEquals(projects[0]!.updatedAt, NOW)
})

Deno.test('a replacing write that says nothing about what it replaces is refused with the held frame, and changes nothing', () => {
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1, updatedAt: 77 })]
  const { result, save } = write(projects, { frame: GEN_B, expectedRevision: 1 })
  assertEquals(result.status, 409)
  const body = (result as { body: { error: string; code: string; current: unknown } }).body
  assertEquals(body.code, 'replaces-required')
  assertEquals(body.current, { frame: GEN_A, revision: 1 }, 'the same body as a stale revision, so a client that knows only that adopts it')
  assert(body.error.length > 0 && body.error.length < 140, 'a sentence a person can read')
  assertEquals(save, false)
  assertEquals(projects[0]!.spatialFrame, GEN_A)
  assertEquals(projects[0]!.spatialFrameRevision, 1)
  assertEquals(projects[0]!.frameHistory, undefined)
  assertEquals(projects[0]!.updatedAt, 77)
})

Deno.test('a replacing write that names another frame than the one held is refused: replaces.frameId must equal the stored one', () => {
  for (const named of ['gen-x', null]) {
    const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
    const { result, save } = write(projects, { frame: GEN_B, expectedRevision: 1, replaces: { frameId: named, reason: 'override' } })
    assertEquals(result.status, 409, String(named))
    assertEquals((result as { body: { code: string } }).body.code, 'replaces-mismatch')
    assertEquals(save, false)
    assertEquals(projects[0]!.spatialFrame, GEN_A)
    assertEquals(projects[0]!.frameHistory, undefined)
  }
})

Deno.test('the revision is judged first: a stale writer is told it lost, not that it left out a reason', () => {
  const projects = [place({ spatialFrame: GEN_B, spatialFrameRevision: 2 })]
  // A device that last read the Place at revision 1 and replaced generation A by C, with a correct-looking `replaces`.
  const stale = write(projects, { frame: GEN_C, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals(stale.result.status, 409)
  const body = (stale.result as { body: { code?: string; current: unknown } }).body
  assertEquals(body.code, undefined, 'a plain lost race, as before')
  assertEquals(body.current, { frame: GEN_B, revision: 2 })
  // Without `replaces` too: it is still the race that it lost.
  assertEquals(((write(projects, { frame: GEN_C, expectedRevision: 1 }).result) as { body: { code?: string } }).body.code, undefined)
  assertEquals(projects[0]!.frameHistory, undefined)
})

Deno.test('a replay of an accepted replacement is not a conflict and adds no second history row', () => {
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  const body = { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } }
  assertEquals(write(projects, body).result.status, 200)
  // The service worker's queue, or a retry after a reply that never came.
  const replay = write(projects, body, NOW + 5000)
  assertEquals(replay.result, { status: 200, body: { revision: 2, frame: GEN_B, unchanged: true } })
  assertEquals(replay.save, false)
  assertEquals(projects[0]!.frameHistory?.length, 1)
})

Deno.test('a frame that has an id replaces one that has none with `replaces.frameId` null, and the entry is of an unknown generation', () => {
  const projects = [place({ spatialFrame: LEGACY_1, spatialFrameRevision: 1 })]
  const refused = write(projects, { frame: GEN_A, expectedRevision: 1 })
  assertEquals((refused.result as { body: { code: string } }).body.code, 'replaces-required')
  const named = write(projects, { frame: GEN_A, expectedRevision: 1, replaces: { frameId: 'gen-zzz', reason: 'upgrade' } })
  assertEquals((named.result as { body: { code: string } }).body.code, 'replaces-mismatch', 'a frame with no id cannot be replaced by naming an id')
  const accepted = write(projects, { frame: GEN_A, expectedRevision: 1, replaces: { frameId: null, reason: 'upgrade' } })
  assertEquals(accepted.result, { status: 200, body: { revision: 2, frame: GEN_A } })
  assertEquals(projects[0]!.frameHistory, [{
    frameId: null,
    createdAt: AT_A,
    method: 'two-point-ground',
    separationM: 2,
    supersededAt: '2026-11-17T12:00:00.000Z',
    reason: 'upgrade',
  }])
  // An absent id is the same as null.
  const again = [place({ spatialFrame: LEGACY_1, spatialFrameRevision: 1 })]
  assertEquals(write(again, { frame: GEN_A, expectedRevision: 1, replaces: { reason: 'upgrade' } }).result.status, 200)
})

Deno.test('a one-point frame upgraded to a two-point frame with an id is a replacement, recorded as the one-point frame', () => {
  const projects = [place({ spatialFrame: ONE_POINT, spatialFrameRevision: 1 })]
  assertEquals(write(projects, { frame: GEN_A, expectedRevision: 1 }).result.status, 409)
  const accepted = write(projects, { frame: GEN_A, expectedRevision: 1, replaces: { frameId: null, reason: 'upgrade' } })
  assertEquals(accepted.result.status, 200)
  assertEquals(projects[0]!.frameHistory?.[0]?.method, 'ground-tap-compass')
  assertEquals(projects[0]!.frameHistory?.[0]?.separationM, null)
})

Deno.test('a frame with an id cannot be replaced by one with none unless the write says what it replaces', () => {
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  assertEquals((write(projects, { frame: LEGACY_2, expectedRevision: 1 }).result as { body: { code: string } }).body.code, 'replaces-required')
  assertEquals(projects[0]!.spatialFrame, GEN_A, 'a client that predates ids does not erase the generation')
  assertEquals(write(projects, { frame: LEGACY_2, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } }).result.status, 200)
  assertEquals(projects[0]!.frameHistory?.[0]?.frameId, 'gen-a')
})

Deno.test('two calibrations with no ids replace each other as they always did, and record nothing unless the writer says what it replaces', () => {
  const projects = [place({ spatialFrame: LEGACY_1, spatialFrameRevision: 1 })]
  assertEquals(write(projects, { frame: LEGACY_2, expectedRevision: 1 }).result, { status: 200, body: { revision: 2, frame: LEGACY_2 } })
  assertEquals(projects[0]!.frameHistory, undefined, 'nothing can name them, so nothing is recorded')
  const said = write(projects, { frame: frame(AT_C, 4), expectedRevision: 2, replaces: { frameId: null, reason: 'override' } })
  assertEquals(said.result.status, 200)
  assertEquals(projects[0]!.frameHistory?.length, 1, 'a writer that says what it replaces is recorded')
  const wrong = write(projects, { frame: frame('2026-11-16T11:00:00.000Z', 5), expectedRevision: 3, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals((wrong.result as { body: { code: string } }).body.code, 'replaces-mismatch', 'and is held to what it says')
})

Deno.test('the same frame written again with its photos attached is stored, counted, and not a replacement', () => {
  const photo = { url: '/projects/proj-1/frames/gen-a/ref-landmark.jpg', localKey: 'proj-1:gen-a:landmark', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: AT_A }
  const heading = { ...photo, url: '/projects/proj-1/frames/gen-a/ref-heading.jpg', localKey: 'proj-1:gen-a:heading' }
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  const richer = { ...GEN_A, referencePhotos: { landmark: photo, headingMarker: heading }, pointLabels: ['door', 'radiator'] }
  const { result } = write(projects, { frame: richer, expectedRevision: 1 })
  assertEquals(result.status, 200)
  assertEquals(projects[0]!.spatialFrameRevision, 2)
  assertEquals(projects[0]!.frameHistory, undefined)
  assertEquals((projects[0]!.spatialFrame as { referencePhotos?: unknown }).referencePhotos !== undefined, true)
})

Deno.test('an id names one reference: the id of the held frame on a frame that is not that frame is refused', () => {
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  const moved = { ...GEN_A, headingMarker: { x: 0, y: 0, z: 2.5 }, separationM: 2.5 }
  const { result, save } = write(projects, { frame: moved, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals(result.status, 409)
  assertEquals((result as { body: { code: string } }).body.code, 'frame-id-reused')
  assertEquals(save, false)
  assertEquals(projects[0]!.spatialFrame, GEN_A)
  assertEquals(projects[0]!.frameHistory, undefined)
})

Deno.test('an id names one reference for good: an id the Place held before is refused for another frame, with or without a `replaces`', () => {
  const afterOverride = () => [place({ spatialFrame: GEN_B, spatialFrameRevision: 2, frameHistory: [frameHistoryEntry(GEN_A, 'override', NOW)] })]
  // Another frame under generation A's id, which the history describes.
  const other = frame(AT_C, 4, { frameId: 'gen-a' })
  for (const replaces of [{ frameId: 'gen-b', reason: 'override' }, undefined, { frameId: 'gen-b', reason: 'merge' }]) {
    const projects = afterOverride()
    const { result, save } = write(projects, { frame: other, expectedRevision: 2, ...(replaces ? { replaces } : {}) })
    assertEquals(result.status, 409, JSON.stringify(replaces))
    assertEquals((result as { body: { code: string } }).body.code, 'frame-id-reused')
    assertEquals(save, false)
    assertEquals([projects[0]!.spatialFrame, projects[0]!.spatialFrameRevision, projects[0]!.frameHistory!.length], [GEN_B, 2, 1])
  }
  // The same id with the same frame is the replay of an old write, which the revision turns away, and not this.
  const stale = write(afterOverride(), { frame: GEN_A, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
  assertEquals((stale.result as { body: { code?: string } }).body.code, undefined, 'a stale revision is a lost race, as it was')
  // An id the Place never held is a new one, and a frame that has none can replace a frame the history knows nothing of.
  assertEquals(write(afterOverride(), { frame: GEN_C, expectedRevision: 2, replaces: { frameId: 'gen-b', reason: 'override' } }).result.status, 200)
  // Held frame with no id, written over by a frame that takes an id from the history: refused as well.
  const legacyHeld = [place({ spatialFrame: LEGACY_2, spatialFrameRevision: 2, frameHistory: [frameHistoryEntry(GEN_A, 'upgrade', NOW)] })]
  assertEquals((write(legacyHeld, { frame: other, expectedRevision: 2, replaces: { frameId: null, reason: 'upgrade' } }).result as { body: { code: string } }).body.code, 'frame-id-reused')
  // The decision alone, with the history it is told of.
  assertEquals(decideReplacement(GEN_B, other, { frameId: 'gen-b', reason: 'override' }, NOW, [frameHistoryEntry(GEN_A, 'override', NOW)]).ok, false)
  assertEquals(decideReplacement(GEN_B, other, { frameId: 'gen-b', reason: 'override' }, NOW).ok, true, 'a history it is not told of is none')
  assertEquals(decideReplacement(GEN_B, other, { frameId: 'gen-b', reason: 'override' }, NOW, 'not a list').ok, true)
})

Deno.test('a first write needs no `replaces`, and one that is sent is not an error', () => {
  const projects = [place({})]
  assertEquals(write(projects, { frame: GEN_A, expectedRevision: 0, replaces: { frameId: 'gen-q', reason: 'override' } }).result.status, 200)
  assertEquals(projects[0]!.frameHistory, undefined, 'nothing was replaced')
})

Deno.test('a `replaces` that is not well formed is a 400 before the Place is looked for, and null is no `replaces`', () => {
  const bad: unknown[] = ['override', [], 7, { frameId: 'gen-a' }, { frameId: 'gen-a', reason: 'reset' }, { frameId: '../x', reason: 'override' }]
  for (const replaces of bad) {
    const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
    const { result, save } = write(projects, { frame: GEN_B, expectedRevision: 1, replaces })
    assertEquals(result.status, 400, JSON.stringify(replaces))
    assertEquals(save, false)
  }
  assertEquals(applySpatialFrameWrite([], 'proj-404', { frame: GEN_B, expectedRevision: 0, replaces: 'x' }, NOW).result.status, 400, 'judged before the Place is looked for')
  const projects = [place({ spatialFrame: GEN_A, spatialFrameRevision: 1 })]
  assertEquals((write(projects, { frame: GEN_B, expectedRevision: 1, replaces: null }).result as { body: { code: string } }).body.code, 'replaces-required')
})

Deno.test('replacing over and over keeps the newest 20 rows, each the frame that was replaced, oldest first', () => {
  const projects = [place({})]
  let revision = 0
  let previous: string | null = null
  for (let i = 0; i < 25; i++) {
    const next = frame(`2026-11-16T${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00.000Z`, 2, { frameId: `gen-${i}` })
    const body: Record<string, unknown> = { frame: next, expectedRevision: revision }
    if (previous !== null) body['replaces'] = { frameId: previous, reason: i % 2 === 0 ? 'override' : 'upgrade' }
    const { result } = write(projects, body, NOW + i * 1000)
    assertEquals(result.status, 200, `write ${i}`)
    revision = (result as { body: { revision: number } }).body.revision
    previous = `gen-${i}`
  }
  const history = projects[0]!.frameHistory!
  assertEquals(history.length, 20)
  assertEquals(history[0]!.frameId, 'gen-4', 'generations 0 to 3 dropped off the front')
  assertEquals(history[19]!.frameId, 'gen-23', 'the last replaced frame is at the end')
  assertEquals((projects[0]!.spatialFrame as { frameId: string }).frameId, 'gen-24')
  assertEquals(history[19]!.supersededAt, new Date(NOW + 24 * 1000).toISOString())
})

Deno.test('the decision alone: what it appends, and that a `replaces` on a write that replaces nothing is ignored', () => {
  assertEquals(decideReplacement(GEN_A, GEN_A_NAMED, { frameId: 'gen-zzz', reason: 'override' }, NOW), { ok: true, entry: null })
  const decided = decideReplacement(GEN_A, GEN_B, { frameId: 'gen-a', reason: 'merge' }, NOW)
  assertEquals(decided.ok && decided.entry?.reason, 'merge')
  assertEquals(decideReplacement(GEN_A, GEN_B, null, NOW).ok, false)
})

// ── Counting a Place's scans by frame ────────────────────────────────────────────────────────────

/** The sidecar of a scan as the server holds it: the flat summaries and the nested record. */
function sidecar(method: string | null, status: string, calibration: Record<string, unknown> | null): Record<string, unknown> {
  return { projectId: 'proj-1', calibrationMethod: method, calibrationStatus: status, calibration }
}

const TWO_POINT = (frameId?: string) => sidecar('two-point-ground', 'verified', {
  method: 'two-point-ground',
  separationM: 2,
  residualM: 0,
  toleranceM: 0.15,
  calibratedAt: AT_A,
  ...(frameId ? { frameId } : {}),
})

Deno.test('a Place\'s scans are counted by the frame their sidecars name, and every scan is in exactly one group', () => {
  const metas = [
    TWO_POINT('gen-a'),
    TWO_POINT('gen-a'),
    TWO_POINT('gen-b'),
    TWO_POINT(),
    TWO_POINT(),
    TWO_POINT(),
    sidecar('ground-tap-compass', 'provisional', { method: 'ground-tap-compass', anchorBearingDeg: 3 }),
    sidecar(null, 'uncalibrated', null),
    { projectId: 'proj-1' },
    // A one-point record that carries a frame id is not read as in that frame: only a two-point record has one.
    sidecar('ground-tap-compass', 'provisional', { method: 'ground-tap-compass', frameId: 'gen-a' }),
  ]
  const counts = tallyScansByFrame(metas)
  assertEquals(counts, {
    scanCount: 10,
    scansByFrame: { 'gen-a': 2, 'gen-b': 1 },
    unrecordedScans: 3,
    notInFrameScans: 4,
  })
  assertEquals(Object.values(counts.scansByFrame).reduce((a, b) => a + b, 0) + counts.unrecordedScans + counts.notInFrameScans, counts.scanCount)
  assertEquals(tallyScansByFrame([]), { scanCount: 0, scansByFrame: {}, unrecordedScans: 0, notInFrameScans: 0 })
})

Deno.test('a frame id that reads like a prototype key is only a key', () => {
  const counts = tallyScansByFrame([TWO_POINT('__proto__'), TWO_POINT('__proto__')])
  assertEquals(Object.getPrototypeOf(counts.scansByFrame), Object.prototype)
  assertEquals(Object.hasOwn(counts.scansByFrame, '__proto__'), true)
  assertEquals(JSON.parse(JSON.stringify(counts)).scansByFrame['__proto__'], 2)
  const status = frameStatusOf(place({ spatialFrame: frame(AT_A, 2, { frameId: '__proto__' }) }), counts)
  assertEquals(status.scansOnCurrentFrame, 2)
  const other = frameStatusOf(place({ spatialFrame: frame(AT_A, 2, { frameId: 'toString' }) }), tallyScansByFrame([]))
  assertEquals(other.scansOnCurrentFrame, 0, 'an id that is a property of every object is not a count')
})

Deno.test('frame status: the frame, its revision, the counts, the scans a replacement would affect, and the history', () => {
  const history: FrameHistoryEntry[] = [frameHistoryEntry(GEN_A, 'override', NOW)]
  const counts = tallyScansByFrame([TWO_POINT('gen-a'), TWO_POINT('gen-b'), TWO_POINT('gen-b'), TWO_POINT(), sidecar(null, 'uncalibrated', null)])
  const status = frameStatusOf(place({ spatialFrame: GEN_B, spatialFrameRevision: 2, frameHistory: history }), counts)
  assertEquals(status, {
    projectId: 'proj-1',
    frame: GEN_B,
    frameId: 'gen-b',
    revision: 2,
    scanCount: 5,
    scansByFrame: { 'gen-a': 1, 'gen-b': 2 },
    unrecordedScans: 1,
    notInFrameScans: 1,
    scansOnCurrentFrame: 2,
    history,
  })

  // A Place with no frame: nothing to replace.
  const none = frameStatusOf(place({}), counts)
  assertEquals([none.frame, none.frameId, none.revision, none.scansOnCurrentFrame, none.history], [null, null, 0, 0, []])
  // A frame that predates ids: the scans that name no frame are the ones measured against it.
  const legacy = frameStatusOf(place({ spatialFrame: LEGACY_1, spatialFrameRevision: 1 }), counts)
  assertEquals([legacy.frameId, legacy.scansOnCurrentFrame], [null, 1])
  // A one-point frame: its scans are not in a Place frame generation at all.
  assertEquals(frameStatusOf(place({ spatialFrame: ONE_POINT, spatialFrameRevision: 1 }), counts).scansOnCurrentFrame, 0)
  // A stored null frame and a stored history that is not a list.
  const odd = frameStatusOf(place({ spatialFrame: null as unknown as undefined, frameHistory: 'x' as unknown as FrameHistoryEntry[] }), counts)
  assertEquals([odd.frame, odd.history], [null, []])
})

Deno.test('the ids of the frames a Place holds or held: the current frame and the history, and no other', () => {
  const ids = knownFrameIds(place({
    spatialFrame: GEN_B,
    frameHistory: [frameHistoryEntry(GEN_A, 'override', NOW), frameHistoryEntry(LEGACY_1, 'upgrade', NOW), { frameId: '../x' } as unknown as FrameHistoryEntry],
  }))
  assertEquals([...ids].sort(), ['gen-a', 'gen-b'])
  assertEquals(knownFrameIds(place({})).size, 0)
})

// ── A merge, and a scan moved to another Place ───────────────────────────────────────────────────

Deno.test('a merge: the same generation agrees, another is a mismatch, a source with no frame agrees, a target with none takes the source\'s', () => {
  const a = place({ projectId: 'proj-a', name: 'Home', spatialFrame: GEN_A })
  const b = place({ projectId: 'proj-b', name: 'Home (2)', spatialFrame: GEN_B })
  const bare = place({ projectId: 'proj-c', name: 'Shed' })
  assertEquals(decideMergeFrames(a, place({ projectId: 'proj-x', spatialFrame: GEN_A_NAMED })), { kind: 'agree' })
  assertEquals(decideMergeFrames(a, b), { kind: 'mismatch', target: summariseFrame(GEN_A)!, source: summariseFrame(GEN_B) })
  assertEquals(decideMergeFrames(a, bare), { kind: 'agree' })
  assertEquals(decideMergeFrames(bare, a), { kind: 'copy', frame: GEN_A })
  assertEquals(decideMergeFrames(bare, place({ projectId: 'proj-d' })), { kind: 'agree' })
  // Two frames written before ids: told apart by their record, not by the photo files it names.
  const legacyA = place({ projectId: 'proj-a', spatialFrame: LEGACY_1 })
  assertEquals(decideMergeFrames(legacyA, place({ projectId: 'proj-b', spatialFrame: { ...LEGACY_1 } })).kind, 'agree')
  const legacyPhotos = (owner: string) => {
    const photo = { url: `/projects/${owner}/reference-photos/ref-landmark.jpg`, localKey: 'k', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: AT_A }
    return { ...LEGACY_1, referencePhotos: { landmark: photo, headingMarker: { ...photo, url: null } } }
  }
  assertEquals(decideMergeFrames(place({ projectId: 'proj-y', spatialFrame: legacyPhotos('proj-y') }), place({ projectId: 'proj-x', spatialFrame: legacyPhotos('proj-x') })).kind, 'agree', 'the copy a Place took of a frame, and the frame')
  assertEquals(decideMergeFrames(legacyA, place({ projectId: 'proj-b', spatialFrame: LEGACY_2 })).kind, 'mismatch')
  // An id against none is never the same frame.
  assertEquals(decideMergeFrames(legacyA, a).kind, 'mismatch')
})

Deno.test('the mismatch answer: a code, a sentence, both frames and how many scans, and the names it quotes are bounded', () => {
  const target = place({ projectId: 'proj-a', name: 'Home', spatialFrame: GEN_A })
  const source = place({ projectId: 'proj-b', name: `Home ${'x'.repeat(200)}`, spatialFrame: GEN_B })
  const decision = decideMergeFrames(target, source)
  assert(decision.kind === 'mismatch')
  const body = mergeMismatchBody(decision, target, source, 4)
  assertEquals(body.code, 'frame-mismatch')
  assertEquals(body.scans, 4)
  assertEquals(body.target, { frameId: 'gen-a', createdAt: AT_A, method: 'two-point-ground' })
  assertEquals(body.source, { frameId: 'gen-b', createdAt: AT_B, method: 'two-point-ground' })
  assert(body.error.includes('"Home"'), body.error)
  assert(body.error.length < 260, 'a long name cannot bury the rest of the sentence')
  assert(!/frameId|acceptFrameMismatch|409|code/i.test(body.error), 'no jargon in a sentence a person reads')
  const scan = reassignMismatchBody(decision, target)
  assertEquals([scan.code, scan.scans], ['frame-mismatch', 1])
  assert(scan.error.includes('aligned separately') && scan.error.includes('"Home"'), scan.error)

  // A scan whose frame is not known (it predates ids, and its Place holds none to compare it with) is not said to be in another one.
  const unknown = decideReassignFrames({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' }, null, target)
  assert(unknown.kind === 'mismatch' && unknown.source === null)
  const unsure = reassignMismatchBody(unknown, target)
  assertEquals(unsure.source, null)
  assert(unsure.error.includes('does not say which frame') && !unsure.error.includes('aligned separately') && unsure.error.includes('"Home"'), unsure.error)
  assert(!/frameId|acceptFrameMismatch|409|code/i.test(unsure.error), 'no jargon in a sentence a person reads')
})

Deno.test('a scan moved to another Place: only a scan in a Place frame can disagree, and it agrees by naming the target\'s frame', () => {
  const from = place({ projectId: 'proj-a', spatialFrame: GEN_A })
  const target = place({ projectId: 'proj-b', spatialFrame: GEN_B })
  const twoPoint = (calibrationFrameId?: string) => ({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', ...(calibrationFrameId ? { calibrationFrameId } : {}) })

  // Scans that are not in a Place frame move freely.
  for (const free of [{}, { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, { calibrationMethod: 'two-point-ground', calibrationStatus: 'uncalibrated' }]) {
    assertEquals(decideReassignFrames(free, from, target), { kind: 'agree' }, JSON.stringify(free))
  }
  // Within its own Place: whatever generation it names, even one other than the Place holds, it is where it was.
  assertEquals(decideReassignFrames(twoPoint('gen-a'), from, from), { kind: 'agree' })
  assertEquals(decideReassignFrames(twoPoint('gen-b'), from, from), { kind: 'agree' }, 'a previous reference moved to another Area of its Place')
  assertEquals(decideReassignFrames(twoPoint(), from, from), { kind: 'agree' })
  // A scan that names the target's frame agrees, wherever it comes from.
  assertEquals(decideReassignFrames(twoPoint('gen-b'), from, target), { kind: 'agree' })
  assertEquals(decideReassignFrames(twoPoint('gen-b'), null, target), { kind: 'agree' })
  // A scan of another frame does not.
  assertEquals(decideReassignFrames(twoPoint('gen-a'), from, target), {
    kind: 'mismatch',
    target: summariseFrame(GEN_B)!,
    source: summariseFrame(GEN_A),
  })
  // A scan of a generation the source no longer holds: only its id is known.
  assertEquals(decideReassignFrames(twoPoint('gen-old'), from, target), {
    kind: 'mismatch',
    target: summariseFrame(GEN_B)!,
    source: { frameId: 'gen-old', createdAt: null, method: null },
  })
  // A scan that names no frame (it predates ids) agrees only when the Place it comes from holds the target's generation.
  const legacyFrom = place({ projectId: 'proj-a', spatialFrame: LEGACY_1 })
  assertEquals(decideReassignFrames(twoPoint(), legacyFrom, place({ projectId: 'proj-b', spatialFrame: { ...LEGACY_1 } })).kind, 'agree')
  assertEquals(decideReassignFrames(twoPoint(), legacyFrom, place({ projectId: 'proj-b', spatialFrame: LEGACY_2 })).kind, 'mismatch')
  // The copy a Place took of that frame names its own photo files, and is still the frame: the next scan of the source is not refused.
  const photographed = (owner: string) => ({ ...LEGACY_1, referencePhotos: { landmark: { url: `/projects/${owner}/reference-photos/ref-landmark.jpg`, localKey: 'k', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: AT_A }, headingMarker: null } }) as unknown as ProjectSpatialFrame
  assertEquals(
    decideReassignFrames(twoPoint(), place({ projectId: 'proj-a', spatialFrame: photographed('proj-a') }), place({ projectId: 'proj-b', spatialFrame: photographed('proj-b') })).kind,
    'agree',
  )
  assertEquals(decideReassignFrames(twoPoint(), null, target).kind, 'mismatch', 'nothing to compare it with')
})

Deno.test('a Place with no frame takes the frame the scan was measured against, when the source Place holds it', () => {
  const from = place({ projectId: 'proj-a', spatialFrame: GEN_A })
  const bare = place({ projectId: 'proj-b' })
  const twoPoint = (calibrationFrameId?: string) => ({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', ...(calibrationFrameId ? { calibrationFrameId } : {}) })
  assertEquals(decideReassignFrames(twoPoint('gen-a'), from, bare), { kind: 'copy', frame: GEN_A })
  assertEquals(decideReassignFrames(twoPoint('gen-old'), from, bare), { kind: 'agree' }, 'a frame the source no longer holds cannot be copied')
  assertEquals(decideReassignFrames(twoPoint('gen-a'), null, bare), { kind: 'agree' })
  // A scan that predates ids, from a Place whose frame predates them too.
  assertEquals(decideReassignFrames(twoPoint(), place({ projectId: 'proj-a', spatialFrame: LEGACY_1 }), bare), { kind: 'copy', frame: LEGACY_1 })
  assertEquals(decideReassignFrames(twoPoint(), from, bare), { kind: 'agree' }, 'but not a frame that has an id: the scan does not name it')
})

// ── The frames a move brings into a Place's history ──────────────────────────────────────────────

Deno.test('a merge brings in what the source held before, and its current frame when the merge is across frames: each described, none without an id', () => {
  const before = frameHistoryEntry(GEN_A, 'override', NOW - 1000)
  const noId = frameHistoryEntry(LEGACY_1, 'upgrade', NOW - 2000)
  const source = place({ projectId: 'proj-s', spatialFrame: GEN_B, frameHistory: [noId, before] })
  assertEquals(framesBroughtByMerge(source, false, NOW), [noId, before], 'the same generation: what it held before')
  const across = framesBroughtByMerge(source, true, NOW)
  assertEquals(across.length, 3)
  assertEquals(across[2], { frameId: 'gen-b', createdAt: AT_B, method: 'two-point-ground', separationM: 3, supersededAt: new Date(NOW).toISOString(), reason: 'merge' })
  // A current frame with no id has nothing to name it in a scan, and is not described; nor is a Place with none.
  assertEquals(framesBroughtByMerge(place({ spatialFrame: LEGACY_2 }), true, NOW), [])
  assertEquals(framesBroughtByMerge(place({}), true, NOW), [])
  assertEquals(framesBroughtByMerge(place({ frameHistory: 'x' as unknown as FrameHistoryEntry[] }), true, NOW), [], 'a stored history that is not a list holds none')
  assertEquals(source.frameHistory, [noId, before], 'the source is only read')
})

Deno.test('a moved scan brings the generations it names, as the Place it comes from describes them, and no others', () => {
  const before = frameHistoryEntry(GEN_A, 'override', NOW - 1000)
  const source = place({ projectId: 'proj-s', spatialFrame: GEN_B, frameHistory: [before, frameHistoryEntry(GEN_C, 'upgrade', NOW - 500)] })
  // One it held before is described as its history does; the one it holds now is described as superseded by the move.
  assertEquals(framesNamedByScans(source, new Set(['gen-a']), NOW), [before])
  const current = framesNamedByScans(source, new Set(['gen-b']), NOW)
  assertEquals([current[0]!.frameId, current[0]!.reason, current[0]!.supersededAt], ['gen-b', 'merge', new Date(NOW).toISOString()])
  assertEquals(framesNamedByScans(source, new Set(['gen-a', 'gen-b']), NOW).map((entry) => entry.frameId), ['gen-a', 'gen-b'])
  // An id the Place never had is not described: nothing is known of it. No Place, nothing.
  assertEquals(framesNamedByScans(source, new Set(['gen-nowhere']), NOW), [])
  assertEquals(framesNamedByScans(null, new Set(['gen-a']), NOW), [])
  assertEquals(framesNamedByScans(source, new Set(), NOW), [])
})
