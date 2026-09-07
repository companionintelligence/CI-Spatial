/**
 * What comes back after the tab is thrown away — src/capture/tripod-persistence.ts.
 *
 * The defect this is about was measured on 2026-08-29: Chrome discarded the tab
 * while the tripod was being carried between spots, and a finished spot and its
 * 48 photos went with it, because the whole capture lived in one `let` in
 * main.ts. The sheet came back at the start screen with no sign anything had
 * happened.
 *
 * Two things are under test, and neither is the IndexedDB — that is glue, and
 * it is proved by reloading a real browser, not by asserting that a write was
 * called.
 *
 * THE FIRST is that a restore cannot claim more than it can deliver. The
 * spot count is built from the photos that actually came back, never from the
 * numbers written alongside them, because a capture that says three spots and
 * uploads two is this repo's recurring defect arriving through the last door
 * that was still open.
 *
 * THE SECOND is what is deliberately NOT restored: the sweep that was running.
 * It stopped halfway round an arc and nobody watched it finish, so banking it
 * would count a spot the operator never accepted — exactly what `endSweep`
 * refuses to do for an empty sweep. The copy has to say so out loud.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tripod_recovery.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOVERY_DISCARD_LABEL,
  RECOVERY_KEEP_LABEL,
  RECOVERY_LOST_SWEEP,
  agoText,
  newSpotKey,
  recoveryHeadline,
  restoreTripodCapture,
  tripodMetaOf,
  type TripodSpotRecord,
} from '../../../src/capture/tripod-persistence.ts'
import {
  MEASURE_AFTER_SPOTS,
  STATION_MAX,
  STATION_MIN,
  addPhotos,
  beginSweep,
  createStationCapture,
  endSweep,
  finishVerdict,
  measuredMetres,
  nextSpot,
  recordDistance,
  shouldAskDistance,
  sizeVerdict,
  totalPhotos,
  type StationCaptureState,
} from '../../../src/capture/station-capture.ts'

/** A photo, as far as anything here is concerned: a File with bytes in it. */
function photo(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: 'image/jpeg' })
}

function bank(id: string, count: number): TripodSpotRecord {
  return { id, files: Array.from({ length: count }, (_, i) => photo(`${id}-${i}.jpg`)) }
}

/** A capture with `n` finished spots of `photos` each, as the sheet builds one. */
function captured(n: number, photos = 12): StationCaptureState {
  let state = createStationCapture()
  for (let i = 0; i < n; i++) {
    if (i > 0) state = nextSpot(state)
    state = endSweep(addPhotos(beginSweep(state), photos))
  }
  return state
}

function keysFor(n: number): string[] {
  return Array.from({ length: n }, (_, i) => newSpotKey(1_700_000_000_000, i))
}

test('a capture written down comes back as the same capture', () => {
  const state = recordDistance(captured(3), 4.25)
  const keys = keysFor(3)
  const meta = tripodMetaOf(state, keys, 1_700_000_100_000)
  const back = restoreTripodCapture(meta, keys.map(k => bank(k, 12)))

  assert.ok(back, 'a whole capture did not come back at all')
  assert.equal(back!.state.spots.length, 3)
  assert.equal(totalPhotos(back!.state), 36)
  assert.equal(back!.spotFiles.length, 3)
  assert.deepEqual(back!.spotKeys, keys)
  assert.equal(measuredMetres(back!.state), 4.25)
  assert.equal(sizeVerdict(back!.state).trueToSize, true)
  assert.equal(finishVerdict(back!.state).ok, true)
  // 'move': the tripod is somewhere, these spots are finished, and the next
  // thing is to set it down again.
  assert.equal(back!.state.phase, 'move')
  assert.equal(back!.state.pending, 0)
  assert.equal(back!.savedAt, 1_700_000_100_000)
})

test('the sweep that was running is not written down and does not come back', () => {
  // The judgement call, held as a test so it cannot be quietly reversed: a
  // sweep interrupted partway photographed part of an arc, and nobody watched
  // it finish.
  const mid = addPhotos(beginSweep(nextSpot(captured(2))), 31)
  assert.equal(mid.pending, 31)
  const keys = keysFor(2)
  const meta = tripodMetaOf(mid, keys, 1_700_000_100_000)

  // Only the finished spots are named, so the 31 photos have nowhere to be.
  assert.deepEqual(meta.spotKeys, keys)
  const back = restoreTripodCapture(meta, keys.map(k => bank(k, 12)))
  assert.equal(back!.state.spots.length, 2)
  assert.equal(back!.state.pending, 0)
  assert.equal(totalPhotos(back!.state), 24)
  // And the operator is told, in the panel, before they act on any of it.
  assert.match(RECOVERY_LOST_SWEEP, /only spots you marked finished come back/)
})

test('a spot whose photos did not come back is not a spot', () => {
  // The failure that would otherwise be invisible: a record claiming 3 spots
  // whose middle photo record never landed. Restoring the claim without the
  // evidence puts a capture on screen that counts three and uploads two.
  const keys = keysFor(3)
  const meta = tripodMetaOf(captured(3), keys, 1_700_000_100_000)
  const back = restoreTripodCapture(meta, [bank(keys[0]!, 12), bank(keys[2]!, 12)])

  assert.equal(back!.state.spots.length, 2, 'a spot with no photos behind it was counted')
  assert.equal(totalPhotos(back!.state), 24)
  assert.deepEqual(back!.spotKeys, [keys[0], keys[2]])
  assert.equal(back!.spotFiles.flat().length, 24)
  // And the gate reads the real number: two spots cannot be sent.
  assert.equal(finishVerdict(back!.state).ok, false)
  assert.match(finishVerdict(back!.state).short, new RegExp(`2 of ${STATION_MIN} spots`))
})

test('the photo count comes from the photos, not from the number beside them', () => {
  const keys = keysFor(1)
  // A record that says twelve with four behind it — a write that was cut off
  // partway, which is exactly the state a discarded tab leaves behind.
  const meta = { ...tripodMetaOf(captured(1), keys, 1), spotKeys: keys }
  const back = restoreTripodCapture(meta, [bank(keys[0]!, 4)])
  assert.equal(back!.state.spots[0]!.photos, 4)
  assert.equal(totalPhotos(back!.state), 4)
})

test('a measurement whose spots did not all come back is asked for again', () => {
  // The length is between spot 1 and spot MEASURE_AFTER_SPOTS. If the set of
  // spots that came back is not the set it was measured across, it is a length
  // between a spot and a ghost — and a room at the wrong size is a perfectly
  // self-consistent room, so nothing downstream could ever notice.
  const keys = keysFor(3)
  const meta = tripodMetaOf(recordDistance(captured(3), 4.25), keys, 1)

  const whole = restoreTripodCapture(meta, keys.map(k => bank(k, 12)))
  assert.equal(measuredMetres(whole!.state), 4.25)

  const partial = restoreTripodCapture(meta, [bank(keys[1]!, 12), bank(keys[2]!, 12)])
  assert.equal(partial!.state.spots.length, 2)
  assert.equal(partial!.state.measurement, null, 'a length to a spot that never came back survived')
  assert.equal(sizeVerdict(partial!.state).trueToSize, false)
  assert.equal(shouldAskDistance(partial!.state), true, 'the question was not asked again')
})

test('a measurement is never restored onto fewer spots than it is about', () => {
  const keys = keysFor(MEASURE_AFTER_SPOTS)
  const meta = { ...tripodMetaOf(captured(MEASURE_AFTER_SPOTS), keys, 1), measurement: { kind: 'measured', fromSpot: 1, toSpot: 2, metres: 3 } }
  const back = restoreTripodCapture(meta, [bank(keys[0]!, 5)])
  assert.equal(back!.state.spots.length, 1)
  assert.equal(back!.state.measurement, null)
})

test('nothing usable is the same as nothing at all', () => {
  const keys = keysFor(2)
  const meta = tripodMetaOf(captured(2), keys, 1)
  assert.equal(restoreTripodCapture(meta, []), null, 'a capture with no photos was offered back')
  assert.equal(restoreTripodCapture(meta, [{ id: keys[0]!, files: [] }]), null)
  // A zero-byte file is not a photo. Chrome's encode can hand one over, and one
  // of those in a spot would be a spot with a photo that shows nothing.
  const empty = new File([], 'x.jpg', { type: 'image/jpeg' })
  assert.equal(restoreTripodCapture(meta, [{ id: keys[0]!, files: [empty] }]), null)
})

test('a record that is not a record is refused rather than half-believed', () => {
  for (const junk of [null, undefined, 0, 'meta', [], {}, { spotKeys: 'a' }, { spotKeys: null }]) {
    assert.equal(restoreTripodCapture(junk, [bank('spot-x', 4)]), null, `restored from ${JSON.stringify(junk)}`)
  }
  // Keys that are not keys are skipped, not crashed on.
  assert.equal(restoreTripodCapture({ spotKeys: [1, null, {}] }, [bank('spot-x', 4)]), null)
})

test('a restored capture is always aiming for at least the spots it already has', () => {
  // "Spot 6 of 5" reads as a bug on the one screen whose job is saying where
  // you are, and a target under the refusal threshold would read as a plan that
  // cannot be sent.
  const keys = keysFor(6)
  const meta = { ...tripodMetaOf(captured(6), keys, 1), target: 3 }
  const back = restoreTripodCapture(meta, keys.map(k => bank(k, 4)))
  assert.equal(back!.state.spots.length, 6)
  assert.ok(back!.state.target >= 6)
  assert.ok(back!.state.target <= STATION_MAX)

  const small = restoreTripodCapture({ ...tripodMetaOf(captured(1), keysFor(1), 1), target: 0 }, [bank(keysFor(1)[0]!, 3)])
  assert.ok(small!.state.target >= STATION_MIN)
})

test('spot keys are unique and stable, so discarding one is one delete', () => {
  const keys = [newSpotKey(1_700_000_000_000, 0), newSpotKey(1_700_000_000_000, 1), newSpotKey(1_700_000_009_999, 2)]
  assert.equal(new Set(keys).size, 3)
  for (const key of keys) assert.match(key, /^spot-[a-z0-9]+-[a-z0-9]+$/)
  // Never the reserved id: a spot record overwriting the meta record would be
  // a capture that erases its own shape.
  for (const key of keys) assert.notEqual(key, 'meta')
})

test('meta never names more spots than the capture has', () => {
  // Extra keys would send a restore looking for photos nothing wrote.
  const meta = tripodMetaOf(captured(2), keysFor(5), 1)
  assert.equal(meta.spotKeys.length, 2)
  assert.equal(meta.id, 'meta')
})

test('the recovery panel says what came back, how old it is, and how to refuse it', () => {
  const now = 1_700_000_000_000
  const line = recoveryHeadline(2, 63, now - 14 * 60_000, now)
  assert.match(line, /2 spots/)
  assert.match(line, /63 photos/)
  assert.match(line, /14 minutes ago/)
  assert.match(recoveryHeadline(1, 1, now - 1_000, now), /1 spot, 1 photo, from just now/)
  assert.match(recoveryHeadline(1, 1, now - 3 * 3_600_000, now), /3 hours ago/)
  assert.match(recoveryHeadline(1, 1, now - 50 * 3_600_000, now), /2 days ago/)
  assert.equal(agoText(Number.NaN, now), 'just now')

  // Both doors, in the panel: carrying on and throwing it away.
  assert.ok(RECOVERY_KEEP_LABEL.length > 0)
  assert.match(RECOVERY_DISCARD_LABEL, /start again/)
})

test('every sentence the recovery panel puts on screen is in the register the sheet uses', () => {
  const banned = [
    'indexeddb', 'database', 'object store', 'record', 'cache', 'storage', 'tab',
    'pose', 'slam', 'sfm', 'panoptic', 'splat', 'keyframe', 'ingest', 'job', 'blob',
  ]
  const lines = [
    RECOVERY_LOST_SWEEP,
    RECOVERY_KEEP_LABEL,
    RECOVERY_DISCARD_LABEL,
    recoveryHeadline(3, 40, 0, 60_000),
  ]
  for (const line of lines) {
    assert.ok(line.length > 0)
    for (const word of banned) {
      assert.ok(!line.toLowerCase().includes(word), `"${word}" appears in: ${line}`)
    }
  }
})
