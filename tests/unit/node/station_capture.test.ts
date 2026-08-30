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
  SPREAD_HINT,
  STATION_MAX,
  STATION_MIN,
  STATION_RECOMMENDED,
  STATION_STATUS_MAX_CHARS,
  TRIPOD_PATH_SUMMARY,
  WHY_SEVERAL_SPOTS,
  addPhotos,
  beginSweep,
  createStationCapture,
  currentSpot,
  endSweep,
  finishCapture,
  finishVerdict,
  nextSpot,
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
  const strings: string[] = [TRIPOD_PATH_SUMMARY, WHY_SEVERAL_SPOTS, SPREAD_HINT]
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
