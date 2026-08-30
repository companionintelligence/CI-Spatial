/**
 * The one measured length, and the wire that carries a tripod capture.
 *
 * Two things are under test, and both are about a claim that would otherwise be
 * wrong quietly:
 *
 *  1. `src/capture/spot-distance.ts` — the unit hazard. A distance given in
 *     feet is accepted by the arithmetic and is wrong by exactly 3.28x, and
 *     nothing downstream can detect it from a single reading: a room 3.28x too
 *     big is a perfectly self-consistent room. The defences are structural (two
 *     boxes, each carrying its unit, and no selector to get wrong) and the feet
 *     echo, which is the only one that can actually catch the case. Both are
 *     asserted here because neither has a runtime symptom.
 *
 *  2. `src/capture/station-upload.ts` — the seam. Tripod Scan handed its photos
 *     to the ordinary photo uploader as one flat set with no record of which
 *     spot each came from; the server's refusal of a one-spot capture, its
 *     per-spot grouping and its known-distance sizing all key off exactly that,
 *     and were unreachable for any capture the app made itself. The fix is two
 *     extra fields on the upload that already happens, and the tests below hold
 *     the property whose absence was invisible: the spot numbers line up with
 *     the files, positionally, and a skipped measurement sends nothing rather
 *     than something empty.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/spot_distance.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPOT_DISTANCE_MAX_M,
  SPOT_DISTANCE_MIN_M,
  formatSpotDistance,
  readSpotDistance,
  spotDistanceEcho,
  spotDistanceInFeet,
  type SpotDistanceOk,
} from '../../../src/capture/spot-distance.ts'
import {
  VIEWPOINT_PREFIX,
  filesFor,
  knownDistancesFor,
  planStationFrames,
  stationsFor,
  viewpointId,
} from '../../../src/capture/station-upload.ts'

/** The accepted reading, or a failure naming what came back instead. */
function accept(metres: string, centimetres: string): SpotDistanceOk {
  const reading = readSpotDistance(metres, centimetres)
  assert.equal(reading.ok, true, `"${metres} m ${centimetres} cm" was refused: ${reading.ok ? '' : reading.reason}`)
  return reading as SpotDistanceOk
}

function refuse(metres: string, centimetres: string): string {
  const reading = readSpotDistance(metres, centimetres)
  assert.equal(reading.ok, false, `"${metres} m ${centimetres} cm" was accepted`)
  return reading.ok ? '' : reading.reason
}

// ── the unit hazard ─────────────────────────────────────────────────────────

test('every accepted reading is echoed back in feet, which is the only way a feet reading is caught', () => {
  // The whole defence. Someone who measured 11 ft and typed it into the metres
  // box is told the number they entered is about 36 ft — a mismatch they can
  // settle by looking down at the tape. No range check can do this: 11 m is an
  // ordinary distance across a room, and 3.28x is a plausible room.
  const asMetres = accept('11', '0')
  assert.match(asMetres.inFeet, /about 36 ft/)
  assert.match(spotDistanceEcho(asMetres), /36 ft/)
  assert.match(spotDistanceEcho(asMetres), /feet/i, 'the echo must name the unit that would be wrong')

  // And the correct entry of the same measurement reads back as what the tape
  // says, so the check is only alarming when something is actually wrong.
  const asFeetCorrectly = accept('3', '35')
  assert.match(asFeetCorrectly.inFeet, /about 11 ft 0 in|about 11 ft/)
})

test('the reading is never restated as a bare number', () => {
  // A bare "3.4" on screen is a number with no unit, which is the state this
  // entry exists to make impossible.
  assert.equal(formatSpotDistance(3.4), '3 m 40 cm')
  assert.equal(formatSpotDistance(3), '3 m')
  assert.equal(formatSpotDistance(0.4), '40 cm')
  for (const metres of [0.5, 1, 2.75, 11, 24.99]) {
    assert.match(formatSpotDistance(metres), /\d+\s(m|cm)/, `${metres} lost its unit`)
  }
})

test('feet and inches are converted, not approximated away', () => {
  // 1 ft is 0.3048 m exactly, by definition.
  assert.equal(spotDistanceInFeet(0.3048), 'about 1 ft')
  assert.equal(spotDistanceInFeet(3.405877), 'about 11 ft 2 in')
  assert.match(spotDistanceInFeet(0.2), /^about \d+ in$/, 'under a foot reads in inches, not "0 ft"')
})

test('centimetres above 99 are restated rather than swallowed or refused blankly', () => {
  // "340" off a tape is not a wrong length, it is the right length in the wrong
  // box — and this refusal is the only moment the two-box shape gets taught.
  const reason = refuse('0', '340')
  assert.match(reason, /3 m 40 cm/, 'the refusal must convert it for them')
  assert.match(reason, /99/)
})

test('a reading with no unit at all cannot be produced', () => {
  // There is no unit field to leave unset: the boxes ARE the units. The only
  // states are "nothing typed" and "a number of metres and centimetres".
  const empty = readSpotDistance('', '')
  assert.equal(empty.ok, false)
  assert.equal(empty.ok === false && empty.empty, true, 'nothing typed is a prompt, not an error')
  assert.equal(accept('0', '75').metres, 0.75, 'centimetres alone are a complete reading')
  assert.equal(accept('4', '').metres, 4, 'metres alone are a complete reading')
})

test('nonsense never becomes a measurement', () => {
  for (const [m, cm] of [['abc', ''], ['3', 'x'], ['-2', '0'], ['3,4', '0'], ['1e3', '0']]) {
    assert.equal(readSpotDistance(m!, cm!).ok, false, `"${m}" / "${cm}" was accepted`)
  }
  assert.match(refuse('0', '10'), /closer than one step/i)
  assert.match(refuse('40', '0'), /further apart than a room/i)
  // The band is a typo guard, and it says so — it must not be mistaken for the
  // thing that catches feet, which it cannot do.
  assert.equal(readSpotDistance(String(SPOT_DISTANCE_MIN_M), '0').ok, true)
  assert.equal(readSpotDistance(String(SPOT_DISTANCE_MAX_M), '0').ok, true)
})

test('a saved reading is rounded to the centimetre and never beyond it', () => {
  // A tape reads to the centimetre. Carrying more digits than were measured
  // would be a precision this number does not have.
  assert.equal(accept('3', '40').metres, 3.4)
  assert.equal(accept('3.404', '0').metres, 3.4)
})

// ── what goes on the wire ───────────────────────────────────────────────────

test('every photo goes up with the spot it was taken from, in the same order', () => {
  // The field the whole server-side tripod path keys off, and it is matched to
  // the files POSITIONALLY — so the two lists have to come from one sequence.
  // Assembling them separately is the one way this can go wrong quietly: every
  // photo would still be labelled, and every label would be someone else's.
  const spotFiles = [[photo('a'), photo('b')], [photo('c')], [photo('d'), photo('e')]]
  const frames = planStationFrames(spotFiles)
  assert.deepEqual(stationsFor(frames), [0, 0, 1, 2, 2])
  assert.deepEqual(filesFor(frames).map(file => file.name), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'])
  assert.equal(stationsFor(frames).length, filesFor(frames).length, 'one spot number per file, always')
  for (const spot of stationsFor(frames)) {
    assert.equal(Number.isInteger(spot) && spot >= 0, true, 'a non-integer spot is dropped by the server')
  }
})

test('the measured length names the two spots the person was asked about', () => {
  // The ids must be the ones the server derives from the per-photo spot number
  // — `station-0` is the first spot — or the measurement refers to nothing.
  assert.equal(viewpointId(0), `${VIEWPOINT_PREFIX}0`)
  const measured = knownDistancesFor({ kind: 'measured', fromSpot: 1, toSpot: 2, metres: 3.4 }, 5)
  assert.deepEqual(measured, [{ from: 'station-0', to: 'station-1', metres: 3.4 }])
})

test('skipping sends nothing rather than something empty', () => {
  // A capture with no measurement is a good capture with no size. It must not
  // arrive carrying a zero, a NaN, or a reference to a spot that never existed
  // — each of which would be read downstream as a real measured length.
  assert.deepEqual(knownDistancesFor({ kind: 'skipped' }, 5), [])
  assert.deepEqual(knownDistancesFor(null, 5), [])
  assert.deepEqual(knownDistancesFor({ kind: 'measured', fromSpot: 1, toSpot: 2, metres: 3.4 }, 1), [],
    'a spot that was never captured cannot be measured against')
  assert.deepEqual(knownDistancesFor({ kind: 'measured', fromSpot: 1, toSpot: 1, metres: 3.4 }, 3), [])
  assert.deepEqual(knownDistancesFor({ kind: 'measured', fromSpot: 1, toSpot: 2, metres: 0 }, 3), [])
  assert.deepEqual(knownDistancesFor({ kind: 'measured', fromSpot: 1, toSpot: 2, metres: Number.NaN }, 3), [])
})

test('an empty spot cannot shift every later spot number by one', () => {
  // It should be unreachable — the state machine refuses a sweep that produced
  // nothing — but if it ever were reached, silently renumbering the room is a
  // worse failure than the empty spot itself.
  const frames = planStationFrames([[photo('a')], [], [photo('b')]])
  assert.deepEqual(stationsFor(frames), [0, 2], 'the surviving spots keep their own numbers')
})

// ── the register ────────────────────────────────────────────────────────────

test('nothing shown to the operator prints implementation vocabulary', () => {
  // The same list tests/unit/node/station_capture.test.ts holds this path's
  // copy to. `station` is wire vocabulary here — it is the form field and the
  // viewpoint id — and it must never reach a sentence someone reads.
  const banned = [
    'pose', 'SfM', 'COLMAP', 'parallax', 'VIO', 'SLAM', 'keyframe', 'segment',
    'pipeline', 'job', 'metric scale', 'panoptic', 'splat', 'photogrammetry',
    'baseline', 'registered', 'degenerate', 'station', 'dome', 'session',
  ]
  const copy: string[] = [formatSpotDistance(3.4), spotDistanceInFeet(3.4), spotDistanceEcho(accept('3', '40'))]
  for (const [m, cm] of [['', ''], ['abc', ''], ['0', '340'], ['0', '10'], ['40', '0'], ['3', '0.5']]) {
    const reading = readSpotDistance(m!, cm!)
    if (!reading.ok) copy.push(reading.reason)
  }
  for (const line of copy) {
    for (const term of banned) {
      assert.doesNotMatch(line, new RegExp(term, 'i'), `copy must not say "${term}": ${line}`)
    }
  }
})

// ── helpers ─────────────────────────────────────────────────────────────────

function photo(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], `${name}.jpg`, { type: 'image/jpeg', lastModified: 1_700_000_000_000 })
}
