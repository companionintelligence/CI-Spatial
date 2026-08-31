/**
 * The tripod path's station loop — src/capture/station-capture.ts.
 *
 * Two things are under test and neither is a computation: the refusals, and
 * the copy. The refusals encode a measurement — one spot swept in place gave 3
 * of 17 usable photos and no room, five spots gave 36 of 36 — so "a capture
 * from one spot" and "a sweep that produced nothing" are the two shapes an
 * empty-but-successful result would take here, and both must be impossible to
 * reach by tapping. The copy is tested against the same banned vocabulary as
 * tests/unit/node/upload_expectation.test.ts, because this screen is read by
 * someone standing in their living room holding a tripod.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/station_capture.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTANCE_PROMPT,
  MEASURE_AFTER_SPOTS,
  SPREAD_HINT,
  STATION_MAX,
  STATION_MIN,
  STATION_RECOMMENDED,
  STATION_STATUS_MAX_CHARS,
  TRIPOD_PATH_SUMMARY,
  WHY_SEVERAL_SPOTS,
  DROP_SPOT_CANCEL_LABEL,
  DROP_SPOT_CONFIRM_LABEL,
  DROP_SPOT_LABEL,
  addPhotos,
  beginSweep,
  canDropSpots,
  clearDistance,
  createStationCapture,
  currentSpot,
  dropSpot,
  dropSpotConfirm,
  endSweep,
  finishCapture,
  finishVerdict,
  measuredMetres,
  nextSpot,
  recordDistance,
  shouldAskDistance,
  sizeVerdict,
  skipDistance,
  spotSummary,
  stationGuidance,
  stationStatusLine,
  totalPhotos,
  type StationCaptureState,
} from '../../../src/capture/station-capture.ts'

/** One complete spot: start, hand over `photos` photos, end the sweep. */
function sweep(state: StationCaptureState, photos: number): StationCaptureState {
  return endSweep(addPhotos(beginSweep(state), photos))
}

/** A capture with `n` finished spots, standing at 'move'. */
function withSpots(n: number, target = STATION_RECOMMENDED): StationCaptureState {
  let state = createStationCapture(target)
  for (let i = 0; i < n; i++) state = i === 0 ? sweep(state, 12) : sweep(nextSpot(state), 12)
  return state
}

// ── the refusals ─────────────────────────────────────────────────────────────

test('a single spot can never be finished, however many photos it took', () => {
  // The measurement this whole path is shaped around: a sweep from a fixed
  // tripod sees the room from one place, and 200 photos from one place rebuild
  // it no better than 17 did (3 of which were usable).
  const one = withSpots(1)
  assert.equal(one.spots.length, 1)
  const verdict = finishVerdict(one)
  assert.equal(verdict.ok, false)
  assert.equal(finishCapture(one).phase, 'move', 'finishing must not go through')
  // The refusal has to say why, or "you need three" is an arbitrary rule.
  assert.match(verdict.detail, /cannot be rebuilt/i)
  assert.match(verdict.detail, /moved between sweeps/i)
})

test('the refusal has a short form for the screen that already explains itself', () => {
  // The sheet shows WHY_SEVERAL_SPOTS at the top and this under the step, so
  // the long form there would be the same paragraph twice on one screen —
  // which is how a screen stops being read. The short form still carries the
  // count and the countdown, which are the parts that change.
  const short = finishVerdict(withSpots(1)).short
  assert.match(short, /1 of 3 spots/)
  assert.match(short, /2 more/)
  assert.ok(short.length < 90, `short form is ${short.length} chars`)
  assert.ok(!short.includes(WHY_SEVERAL_SPOTS))
  assert.match(finishVerdict(withSpots(3)).short, /ready to send/i)
})

test('the refusal counts down, so it is a next step and not a wall', () => {
  assert.match(finishVerdict(withSpots(0)).detail, new RegExp(`${STATION_MIN} more to go`))
  assert.match(finishVerdict(withSpots(1)).detail, /2 more to go/)
  assert.match(finishVerdict(withSpots(2)).detail, /1 more to go/)
})

test('the minimum is the measured one, and five is what is proposed', () => {
  assert.equal(STATION_MIN, 3)
  assert.equal(STATION_RECOMMENDED, 5)
  assert.equal(finishVerdict(withSpots(STATION_MIN)).ok, true)
  assert.equal(finishCapture(withSpots(STATION_MIN)).phase, 'done')
})

test('a sweep that produced no photos does not count as a spot', () => {
  // The failure mode that would otherwise be indistinguishable from success:
  // the operator sweeps, nothing is handed over, and the app asks them to move
  // the tripod as if the spot were captured.
  const empty = endSweep(beginSweep(createStationCapture()))
  assert.equal(empty.spots.length, 0)
  assert.equal(empty.phase, 'ready', 'must stay at the same spot, not advance to "move"')
  assert.equal(empty.lastSweepEmpty, true)
  assert.equal(currentSpot(empty), 1)

  const guidance = stationGuidance(empty)
  assert.equal(guidance.tone, 'warn')
  assert.match(guidance.headline, /no photos/i)
  assert.match(guidance.detail, /has not been captured/i)
  assert.match(guidance.primary ?? '', /again/i, 'the way out is to redo this spot')
})

test('an empty sweep followed by a real one counts once', () => {
  let state = endSweep(beginSweep(createStationCapture()))
  state = sweep(state, 9)
  assert.equal(state.spots.length, 1)
  assert.equal(state.lastSweepEmpty, false)
  assert.equal(totalPhotos(state), 9)
})

test('photos cannot be conjured out of a sweep that is not running', () => {
  const idle = createStationCapture()
  assert.equal(addPhotos(idle, 20).pending, 0)
  assert.equal(endSweep(idle).spots.length, 0)
  assert.equal(nextSpot(idle).phase, 'ready')
})

test('nonsense photo counts are ignored rather than believed', () => {
  const running = beginSweep(createStationCapture())
  assert.equal(addPhotos(running, 0).pending, 0)
  assert.equal(addPhotos(running, -5).pending, 0)
  assert.equal(addPhotos(running, Number.NaN).pending, 0)
  assert.equal(addPhotos(addPhotos(running, 3), 4).pending, 7, 'two batches at one spot add up')
})

test('the target is clamped to the range that has been measured', () => {
  assert.equal(createStationCapture(1).target, STATION_MIN)
  assert.equal(createStationCapture(99).target, STATION_MAX)
  assert.equal(createStationCapture(Number.NaN).target, STATION_RECOMMENDED)
  assert.equal(createStationCapture().target, STATION_RECOMMENDED)
})

// ── the loop, as someone carrying a tripod experiences it ────────────────────

test('every step says which spot it is on, out of how many', () => {
  let state = createStationCapture()
  assert.equal(stationGuidance(state).step, 'Spot 1 of 5')
  state = beginSweep(state)
  assert.equal(stationGuidance(state).step, 'Spot 1 of 5')
  state = endSweep(addPhotos(state, 14))
  assert.equal(stationGuidance(state).step, 'Spot 1 of 5', 'still spot 1 until the tripod moves')
  state = nextSpot(state)
  assert.equal(stationGuidance(state).step, 'Spot 2 of 5')
})

test('finishing a sweep tells the operator to pick the tripod up, and where to put it', () => {
  const g = stationGuidance(withSpots(2))
  assert.match(g.headline, /pick the tripod up/i)
  assert.ok(g.detail.includes(SPREAD_HINT), 'the "not in a line" rule belongs where they carry it')
  assert.match(g.primary ?? '', /next spot/i)
})

test('the first screen places the tripod; the later ones do not repeat the lesson', () => {
  const first = stationGuidance(createStationCapture())
  assert.match(first.headline, /sees most of the room/i)
  const later = stationGuidance(nextSpot(withSpots(2)))
  assert.match(later.headline, /new spot/i)
  assert.match(later.detail, /2 spots captured so far/i, 'progress is stated, not implied')
})

test('a sweep in progress says to leave it alone and nothing else', () => {
  const g = stationGuidance(beginSweep(createStationCapture()))
  assert.match(g.headline, /leave it alone/i)
  assert.match(g.primary ?? '', /finished/i)
})

test('reaching the planned count is an end, not a dead stop', () => {
  const all = withSpots(STATION_RECOMMENDED)
  const g = stationGuidance(all)
  assert.match(g.headline, /All 5 spots done/)
  assert.equal(finishVerdict(all).ok, true)
  // Adding a sixth must not produce "Spot 6 of 5" — the one screen whose job
  // is saying where you are cannot contradict itself.
  const sixth = nextSpot(all)
  assert.equal(stationGuidance(sixth).step, 'Spot 6 of 6')
})

test('the ceiling stops offering another spot rather than silently ignoring the tap', () => {
  const full = withSpots(STATION_MAX, STATION_MAX)
  assert.equal(stationGuidance(full).primary, null)
  assert.match(stationGuidance(full).detail, new RegExp(`${STATION_MAX} spots is as far`))
})

test('the finished capture reports what was actually gathered', () => {
  let state = withSpots(3)
  state = finishCapture(state)
  assert.equal(state.phase, 'done')
  const g = stationGuidance(state)
  assert.equal(g.step, '3 spots captured')
  assert.match(g.detail, /36 photos from 3 spots/)
})

// ── the status line, which shares #status-row with the quality chip ──────────

test('every status line fits the one line it has', () => {
  const states: StationCaptureState[] = []
  for (let target = STATION_MIN; target <= STATION_MAX; target++) {
    let state = createStationCapture(target)
    states.push(state, beginSweep(state), endSweep(beginSweep(state)))
    for (let n = 1; n <= target; n++) {
      state = n === 1 ? sweep(state, 11) : sweep(nextSpot(state), 11)
      states.push(state, nextSpot(state), finishCapture(state))
    }
  }
  for (const state of states) {
    const line = stationStatusLine(state)
    assert.ok(
      line.length <= STATION_STATUS_MAX_CHARS,
      `"${line}" is ${line.length} chars, budget ${STATION_STATUS_MAX_CHARS}`,
    )
    assert.ok(line.trim().length > 0)
  }
})

test('the status line distinguishes ready, sweeping, move and retry', () => {
  const fresh = createStationCapture()
  assert.equal(stationStatusLine(fresh), 'Spot 1/5 — ready')
  assert.equal(stationStatusLine(beginSweep(fresh)), 'Spot 1/5 — sweeping')
  assert.equal(stationStatusLine(endSweep(beginSweep(fresh))), 'Spot 1/5 — retry')
  assert.equal(stationStatusLine(withSpots(1)), 'Spot 1/5 — move on')
  assert.equal(stationStatusLine(finishCapture(withSpots(3))), '3 spots sent')
})

// ── the register ────────────────────────────────────────────────────────────

test('the path summary says what it is for without explaining how it works', () => {
  // The two claims that justify a third card on the start screen, both
  // measured: no AR runtime is involved, and the live scanner does not start
  // on the test phone.
  assert.match(TRIPOD_PATH_SUMMARY, /No AR/i)
  assert.match(TRIPOD_PATH_SUMMARY, /live scanner cannot/i)
  // It used to assert `/true to size/`, pinning a claim this path cannot make:
  // a capture with no AR runtime reconstructs an exact similarity of the room
  // at an arbitrary size until a known length calibrates it, which is the
  // entire reason server/capture/known_distance.ts exists. The card one tap
  // away says "Size is not measured", and capture_intent.test.ts's
  // 'only the live paths claim real-world size' holds it to that — so this
  // string is held to the same rule rather than to its opposite.
  assert.doesNotMatch(
    TRIPOD_PATH_SUMMARY,
    /true size|true to size|to scale|actual size|in met(re|er)s|life-?size/i,
    'the summary must not promise a real-world size this path does not measure',
  )
  assert.match(TRIPOD_PATH_SUMMARY, /unmeasured|not measured/i, 'and must say so where the promise would be made')
})

test('the spread rule is one sentence and says what "spread" means', () => {
  assert.equal(SPREAD_HINT.split('.').filter(part => part.trim()).length, 1)
  assert.match(SPREAD_HINT, /straight line/i)
})

test('no copy prints implementation vocabulary at the user', () => {
  // The same list tests/unit/node/upload_expectation.test.ts holds the upload
  // copy to, plus this path's own temptations: it is the one capture that
  // exists because of how reconstruction works, so it is the one most likely
  // to start explaining it.
  const banned = [
    'pose', 'SfM', 'COLMAP', 'parallax', 'VIO', 'SLAM', 'keyframe', 'segment',
    'pipeline', 'job', 'metric scale', 'panoptic', 'splat', 'no-pose',
    'photogrammetry', 'baseline', 'registered', 'degenerate', 'station', 'dome',
  ]
  const strings: string[] = [
    TRIPOD_PATH_SUMMARY, WHY_SEVERAL_SPOTS, SPREAD_HINT,
    DROP_SPOT_LABEL, DROP_SPOT_CONFIRM_LABEL, DROP_SPOT_CANCEL_LABEL,
    spotSummary(0, 1), spotSummary(4, 24), dropSpotConfirm(1, 24),
  ]
  const walk = (state: StationCaptureState) => {
    const g = stationGuidance(state)
    const v = finishVerdict(state)
    strings.push(g.step, g.headline, g.detail, g.primary ?? '', stationStatusLine(state), v.headline, v.detail, v.short)
  }
  for (let target = STATION_MIN; target <= STATION_MAX; target++) {
    let state = createStationCapture(target)
    walk(state)
    walk(beginSweep(state))
    walk(endSweep(beginSweep(state)))
    for (let n = 1; n <= target; n++) {
      state = n === 1 ? sweep(state, 11) : sweep(nextSpot(state), 11)
      walk(state)
      walk(nextSpot(state))
      walk(finishCapture(state))
    }
  }
  for (const copy of strings) {
    for (const term of banned) {
      assert.doesNotMatch(copy, new RegExp(term, 'i'), `copy must not say "${term}": ${copy}`)
    }
  }
})

// ── the one measured length ─────────────────────────────────────────────────
//
// A tripod capture reconstructs a room that is an exact similarity of the real
// one and has no idea how big it is. One measured distance between two of the
// spots is what fixes that, and it is the only thing on this path that can.
// These tests hold two properties: it is asked for at the one moment measuring
// it is free, and skipping it is an outcome rather than an error.

test('the measurement is asked for at the first pause after the second spot', () => {
  // Not before — two spots have to exist for there to be a distance between
  // them — and not at the end, when the spots are no longer marked by anything
  // and finding them means walking back across the room.
  assert.equal(shouldAskDistance(createStationCapture()), false)
  assert.equal(shouldAskDistance(withSpots(1)), false, 'one spot is not a pair')
  assert.equal(MEASURE_AFTER_SPOTS, 2)
  assert.equal(shouldAskDistance(withSpots(2)), true)
  assert.equal(shouldAskDistance(beginSweep(nextSpot(withSpots(2)))), false, 'never during a sweep')
})

test('a saved measurement is what makes this capture true to size, and it says so', () => {
  const measured = recordDistance(withSpots(2), 3.4)
  assert.equal(measuredMetres(measured), 3.4)
  assert.equal(shouldAskDistance(measured), false, 'answered once is answered')

  const size = sizeVerdict(measured)
  assert.equal(size.trueToSize, true)
  assert.match(size.detail, /3 m 40 cm/, 'the number is restated with its unit, never bare')
  assert.match(size.detail, /spot 1 to spot 2/i, 'and names which two spots it is between')

  // The claim exists only where it is earned: the same capture without the
  // measurement must not make it.
  const unmeasured = sizeVerdict(skipDistance(withSpots(2)))
  assert.equal(unmeasured.trueToSize, false)
  assert.match(unmeasured.detail, /not been measured|nothing has been measured/i)
})

test('skipping the measurement is a complete answer, and the capture is still good', () => {
  // The first-class outcome. A capture with no measurement is a good capture of
  // the shape of a room — it must not be refused, blocked, or asked again.
  const skipped = skipDistance(withSpots(2))
  assert.equal(shouldAskDistance(skipped), false)
  assert.equal(measuredMetres(skipped), null)
  const sent = finishCapture(sweep(nextSpot(skipped), 12))
  assert.equal(sent.phase, 'done', 'a skipped measurement cannot block sending')
  assert.equal(sizeVerdict(sent).trueToSize, false)
})

test('a skipped measurement can be re-opened, and a saved one cannot be lost silently', () => {
  const skipped = skipDistance(withSpots(2))
  assert.equal(shouldAskDistance(clearDistance(skipped)), true, 'the way back from a skip')
  // Skipping after saving must not throw the number away — the only way to
  // replace a reading is to deliberately re-open the question.
  const measured = recordDistance(withSpots(2), 3.4)
  assert.equal(measuredMetres(skipDistance(measured)), 3.4)
  assert.equal(measuredMetres(clearDistance(measured)), null)
})

test('a measurement that is not a measurement never reaches the capture', () => {
  // A stored zero or NaN would travel with the photos and be indistinguishable
  // from a real reading, which is the exact shape of "reporting success it did
  // not earn" on this path.
  const two = withSpots(2)
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(measuredMetres(recordDistance(two, bad)), null, `${bad} was stored`)
  }
  assert.equal(measuredMetres(recordDistance(withSpots(1), 3.4)), null, 'nothing to measure between yet')
})

test('the measurement survives the rest of the capture', () => {
  let state = recordDistance(withSpots(2), 3.4)
  state = sweep(nextSpot(state), 12)
  state = finishCapture(state)
  assert.equal(state.phase, 'done')
  assert.equal(measuredMetres(state), 3.4, 'the number must reach the send')
  assert.equal(sizeVerdict(state).trueToSize, true)
})

test('the measurement copy makes the unit unmissable and never prints machinery', () => {
  // A reading in feet is accepted by the arithmetic and is wrong by 3.28x with
  // nothing downstream able to notice, so the size of the mistake is stated
  // where the mistake would be made.
  assert.match(DISTANCE_PROMPT.unitNote, /metres/i)
  assert.match(DISTANCE_PROMPT.unitNote, /feet/i)
  assert.match(DISTANCE_PROMPT.unitNote, /three times/i)
  assert.match(DISTANCE_PROMPT.question, /spot 1 and spot 2/i)
  assert.match(DISTANCE_PROMPT.skip, /skip/i)

  const banned = [
    'pose', 'SfM', 'COLMAP', 'parallax', 'VIO', 'SLAM', 'keyframe', 'segment',
    'pipeline', 'job', 'metric scale', 'panoptic', 'splat', 'photogrammetry',
    'baseline', 'registered', 'degenerate', 'station', 'dome', 'calibrat',
  ]
  const copy = [
    ...Object.values(DISTANCE_PROMPT),
    ...[sizeVerdict(recordDistance(withSpots(2), 3.4)), sizeVerdict(skipDistance(withSpots(2)))]
      .flatMap(size => [size.headline, size.detail]),
  ]
  for (const line of copy) {
    for (const term of banned) {
      assert.doesNotMatch(line, new RegExp(term, 'i'), `copy must not say "${term}": ${line}`)
    }
  }
})

test('the path summary now says how a size can be had, without promising one', () => {
  // It must still refuse the claim capture_intent.test.ts refuses for this
  // method, while naming the one thing that would change the answer.
  assert.doesNotMatch(TRIPOD_PATH_SUMMARY, /true size|true to size|to scale|actual size|in met(re|er)s|life-?size/i)
  assert.match(TRIPOD_PATH_SUMMARY, /unmeasured|not measured/i)
  assert.match(TRIPOD_PATH_SUMMARY, /measure one distance/i)
})


// ─── Throwing one spot away ──────────────────────────────────────────────────
//
// Measured on 2026-08-29: a sweep banked 48 frames of a jammed, stationary
// gimbal and the only ways out were "Add more" and starting the whole capture
// over — so a spot that photographed one wall was cheaper to send than to fix.
// What these hold is that removing one keeps every claim on the screen true.

test('a discarded spot takes its photos out of every count on the screen', () => {
  const before = withSpots(4)
  assert.equal(before.spots.length, 4)
  assert.equal(totalPhotos(before), 48)
  const after = dropSpot(before, 1)
  assert.equal(after.spots.length, 3)
  assert.equal(totalPhotos(after), 36)
  assert.match(stationGuidance(after).step, /of \d+$/)
  assert.equal(finishVerdict(after).ok, true)
  assert.match(finishVerdict(after).short, /36 photos from 3 spots/)
})

test('dropping below the minimum makes the capture refuse to send again', () => {
  // The gate is not re-implemented anywhere; it simply reads a smaller list.
  // That is the whole reason discarding is a state transition and not a splice
  // in the sheet.
  const three = withSpots(3)
  assert.equal(finishVerdict(three).ok, true)
  const two = dropSpot(three, 0)
  assert.equal(finishVerdict(two).ok, false)
  assert.match(finishVerdict(two).short, new RegExp(`2 of ${STATION_MIN} spots`))
  assert.match(finishVerdict(two).short, /1 more before this can be sent/)
  // And the capture cannot be finished through the back door either.
  assert.equal(finishCapture(two).phase, 'move')
})

test('discarding the spot you are standing at puts you back at it, not on to the next', () => {
  const state = withSpots(2)
  assert.equal(state.phase, 'move')
  const after = dropSpot(state, 1)
  assert.equal(after.phase, 'ready', 'offered to move a tripod that has not been picked up')
  assert.equal(after.lastSweepEmpty, false, 'blamed the camera for a spot the operator threw away')
  assert.equal(currentSpot(after), 2)
  assert.match(stationGuidance(after).primary ?? '', /sweep/i)
})

test('discarding an earlier spot leaves the tripod where it is', () => {
  const state = withSpots(3)
  const after = dropSpot(state, 0)
  assert.equal(after.phase, 'move')
  assert.equal(after.spots.length, 2)
})

test('a measurement about a spot that no longer exists is asked for again', () => {
  // The length is between spot 1 and spot 2. Throw either away and it is a
  // length between a spot and a ghost — and nothing downstream could tell,
  // because a room at the wrong size is a perfectly self-consistent room.
  let state = recordDistance(withSpots(2), 3.4)
  assert.equal(measuredMetres(state), 3.4)
  state = endSweep(addPhotos(beginSweep(nextSpot(state)), 6))
  assert.equal(measuredMetres(state), 3.4)

  const droppedFirst = dropSpot(state, 0)
  assert.equal(droppedFirst.measurement, null, 'a length to a spot that was thrown away survived')
  assert.equal(sizeVerdict(droppedFirst).trueToSize, false)
  assert.equal(shouldAskDistance(droppedFirst), true, 'the question was not asked again')

  // The third spot was never part of the measurement, so dropping it changes
  // nothing about the size.
  const droppedThird = dropSpot(state, 2)
  assert.equal(measuredMetres(droppedThird), 3.4)
  assert.equal(sizeVerdict(droppedThird).trueToSize, true)
})

test('a sweep in progress and a sent capture are both untouchable', () => {
  const sweeping = addPhotos(beginSweep(nextSpot(withSpots(2))), 5)
  assert.equal(sweeping.phase, 'sweeping')
  assert.deepEqual(dropSpot(sweeping, 0), sweeping, 'a spot was removed while photos were still arriving')
  assert.equal(canDropSpots(sweeping), false)

  const sent = finishCapture(withSpots(3))
  assert.equal(sent.phase, 'done')
  assert.deepEqual(dropSpot(sent, 0), sent, 'a spot was removed from a capture that has already gone')
  assert.equal(canDropSpots(sent), false)
})

test('an index that is not a spot changes nothing at all', () => {
  const state = withSpots(3)
  for (const bad of [-1, 3, 99, 1.5, Number.NaN]) {
    assert.deepEqual(dropSpot(state, bad), state, `dropSpot(state, ${bad}) changed the capture`)
  }
})

test('the confirmation names the photos that are about to be lost', () => {
  assert.match(dropSpotConfirm(1, 24), /spot 2/)
  assert.match(dropSpotConfirm(1, 24), /24 photos/)
  assert.match(dropSpotConfirm(0, 1), /1 photo\b/)
  assert.match(dropSpotConfirm(0, 1), /cannot be got back/)
  assert.equal(spotSummary(0, 1), 'Spot 1 — 1 photo')
  assert.equal(spotSummary(4, 24), 'Spot 5 — 24 photos')
})

test('every spot can be thrown away, and the capture is then simply empty', () => {
  let state = withSpots(3)
  while (state.spots.length > 0) state = dropSpot(state, 0)
  assert.equal(totalPhotos(state), 0)
  assert.equal(finishVerdict(state).ok, false)
  assert.match(finishVerdict(state).headline, /No spots captured yet/)
  assert.equal(canDropSpots(state), false)
  assert.equal(state.phase, 'ready')
  assert.ok(state.target >= STATION_MIN)
})
