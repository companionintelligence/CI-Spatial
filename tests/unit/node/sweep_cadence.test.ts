/**
 * The tripod sweep's capture cadence — src/capture/sweep-cadence.ts.
 *
 * What is under test is a refusal and a guarantee, in that order.
 *
 * The refusal: a `<video>` fed by a camera that has stopped keeps reporting
 * `readyState >= 2` forever, and drawing it produces the same frozen picture
 * every time. Forty copies of one frame is a spot that LOOKS captured — the
 * tally climbs, the preview shows a picture, the operator walks to the next
 * spot — and reconstructs nothing. That is precisely the "reported success it
 * never earned" failure this path keeps having, so a frozen feed must be
 * incapable of banking a single frame.
 *
 * The guarantee: the gimbal dwells at least 800 ms at each position and nobody
 * is in the room to press anything, so the sample period has to be short
 * enough that every dwell window contains a sample instant whatever the phase
 * between the two clocks. That is an arithmetic property of the constants and
 * it is checked as one, at every offset.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/sweep_cadence.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_ON_LABEL,
  FRAME_LONG_EDGE,
  GIMBAL_MIN_DWELL_MS,
  SWEEP_FORCE_BANK_MS,
  SWEEP_MAX_FRAMES,
  SWEEP_MAX_MS,
  SWEEP_SAMPLE_MS,
  SWEEP_STALL_MS,
  SWEEP_STILL_WARN_MS,
  VIEW_NEW,
  VIEW_SETTLED,
  cameraRefusal,
  endCadence,
  frameFileName,
  frameSize,
  noteCaptured,
  startCadence,
  sweepCountLine,
  sweepEndNotice,
  sweepMotionNotice,
  tickCadence,
  viewDifference,
  viewStillMs,
  type CadenceState,
  type CameraTick,
} from '../../../src/capture/sweep-cadence.ts'

/**
 * Run the loop over a scripted camera, the way the page does.
 *
 * `frames` is the picture's own clock: index i is `video.currentTime` at tick
 * i, and repeating a value is exactly what a stalled feed looks like from the
 * page's side. Every 'capture' is banked, because the browser module banks
 * every frame it manages to encode.
 */
function run(
  frames: readonly number[],
  opts: { tickMs?: number, hiddenAt?: readonly number[], readyAt?: number } = {},
): { state: CadenceState, captures: number[] } {
  const tickMs = opts.tickMs ?? 100
  const readyAt = opts.readyAt ?? 0
  let state = startCadence(0)
  const captures: number[] = []
  for (let i = 0; i < frames.length; i++) {
    const nowMs = i * tickMs
    const ready = i >= readyAt
    const tick: CameraTick = {
      nowMs,
      readyState: ready ? 4 : 0,
      videoWidth: ready ? 1920 : 0,
      currentTime: frames[i]!,
      hidden: opts.hiddenAt?.includes(i) ?? false,
    }
    const out = tickCadence(state, tick)
    state = out.state
    if (out.action === 'end') break
    if (out.action === 'capture') {
      captures.push(nowMs)
      state = noteCaptured(state)
    }
  }
  return { state, captures }
}

/** A feed advancing normally: currentTime moves every tick. */
function moving(count: number, step = 0.033): number[] {
  return Array.from({ length: count }, (_, i) => Number(((i + 1) * step).toFixed(4)))
}

test('on the fallback clock, every gimbal dwell contains at least one sample instant', () => {
  // The path taken when the picture cannot be measured at all — `run` above
  // passes no motion, which is exactly what a canvas that will not read back
  // produces. There the cadence is the plain clock it always was: sampling
  // every SWEEP_SAMPLE_MS means the longest gap between samples is
  // SWEEP_SAMPLE_MS, so a dwell window strictly longer than that cannot fall
  // between two of them — checked at every 10 ms offset rather than asserted.
  assert.ok(
    SWEEP_SAMPLE_MS < GIMBAL_MIN_DWELL_MS,
    `sampling every ${SWEEP_SAMPLE_MS} ms cannot guarantee a photo of a ${GIMBAL_MIN_DWELL_MS} ms dwell`,
  )
  const { captures } = run(moving(400), { tickMs: 50 })
  for (let dwellStart = 0; dwellStart <= 5_000; dwellStart += 10) {
    const inside = captures.some(t => t >= dwellStart && t < dwellStart + GIMBAL_MIN_DWELL_MS)
    assert.ok(inside, `no photo taken during the dwell beginning at ${dwellStart} ms`)
  }
})

test('a live feed banks photos at the sample period, not at the tick rate', () => {
  const { captures } = run(moving(100), { tickMs: 100 })
  assert.ok(captures.length > 1)
  // Not the very first tick: the picture has to be watched to move once before
  // anything is banked, because one reading cannot tell a camera that has just
  // started from one that stopped a minute ago. One tick, not one sample.
  assert.equal(captures[0], 100)
  for (let i = 1; i < captures.length; i++) {
    assert.ok(
      captures[i]! - captures[i - 1]! >= SWEEP_SAMPLE_MS,
      `photos ${i - 1} and ${i} were ${captures[i]! - captures[i - 1]!} ms apart`,
    )
  }
})

test('a frozen picture banks nothing at all, and ends the sweep as stalled', () => {
  // The corpse case. currentTime never moves, so however long the loop runs
  // there is exactly one picture available and it has already been taken —
  // here, not even once, because the freeze predates the first sample.
  const { state, captures } = run(Array.from({ length: 200 }, () => 1.5), { tickMs: 100 })
  assert.equal(state.ended, 'stalled')
  assert.equal(state.captured, 0)
  assert.equal(captures.length, 0)
})

test('a feed that freezes mid-sweep keeps what it took and banks no duplicates', () => {
  const live = moving(20)
  const frozen = Array.from({ length: 60 }, () => live[live.length - 1]!)
  const { state, captures } = run([...live, ...frozen], { tickMs: 100 })
  assert.equal(state.ended, 'stalled')
  // Everything banked came from the live half — 100 ms, 800 ms, 1500 ms — all
  // before the feed stopped at 2000 ms.
  assert.ok(captures.length >= 2)
  for (const at of captures) assert.ok(at < live.length * 100, `a photo was taken at ${at} ms, after the feed froze`)
  assert.equal(state.captured, captures.length)
})

test('a brief freeze under the threshold is survived, not called a stall', () => {
  const stutterTicks = Math.floor((SWEEP_STALL_MS - 400) / 100)
  const frames = [...moving(6), ...Array.from({ length: stutterTicks }, () => 0.198), ...moving(30, 0.05)]
  const { state } = run(frames, { tickMs: 100 })
  assert.equal(state.ended, null, 'a stutter shorter than the threshold ended the sweep')
  assert.ok(state.captured > 0)
})

test('a backgrounded page banks nothing, ends nothing, and resumes', () => {
  // Android stops the feed when Chrome goes to the background. The frozen
  // currentTime that produces is not a broken camera, and ending a sweep
  // because someone pulled down a notification would lose the spot.
  const hiddenAt = Array.from({ length: 40 }, (_, i) => i + 5)
  const frames = [...moving(5), ...Array.from({ length: 40 }, () => 0.165), ...moving(30, 0.04)]
  const { state, captures } = run(frames, { tickMs: 100, hiddenAt })
  assert.equal(state.ended, null)
  const hiddenWindow = captures.filter(at => at >= 500 && at < 4500)
  assert.equal(hiddenWindow.length, 0, 'a photo was banked while the page was hidden')
  assert.ok(captures.some(at => at >= 4500), 'nothing was banked after the page came back')
})

test('a camera that is still warming up is waited for, not called stalled', () => {
  // readyState below 2 is nothing to draw, which is a different thing from a
  // feed that had frames and stopped. SWEEP_MAX_MS is what catches a camera
  // that never arrives.
  const frames = [...Array.from({ length: 20 }, () => 0), ...moving(30)]
  const { state, captures } = run(frames, { tickMs: 100, readyAt: 20 })
  assert.equal(state.ended, null)
  assert.ok(captures.every(at => at >= 2000))
  assert.ok(captures.length > 0)
})

test('the sweep stops on its own at the frame ceiling and at the time ceiling', () => {
  const full = run(moving(SWEEP_MAX_FRAMES * 10 + 50), { tickMs: 100 })
  assert.equal(full.state.ended, 'full')
  assert.equal(full.state.captured, SWEEP_MAX_FRAMES)

  // The time ceiling, reached with the frame ceiling out of the way: one photo
  // every three seconds cannot fill SWEEP_MAX_FRAMES inside SWEEP_MAX_MS.
  let state = startCadence(0)
  let action = 'wait'
  for (let nowMs = 0; nowMs <= SWEEP_MAX_MS + 1000; nowMs += 3000) {
    const out = tickCadence(state, { nowMs, readyState: 4, videoWidth: 1920, currentTime: nowMs / 1000 })
    state = out.state
    action = out.action
    if (action === 'capture') state = noteCaptured(state)
    if (action === 'end') break
  }
  assert.equal(state.ended, 'timeout')
  assert.ok(state.captured < SWEEP_MAX_FRAMES)
})

test('an ended cadence is inert — no late frame lands in a closed spot', () => {
  const state = endCadence(startCadence(0), 'stopped')
  const out = tickCadence(state, { nowMs: 5_000, readyState: 4, videoWidth: 1920, currentTime: 9 })
  assert.equal(out.action, 'end')
  assert.equal(out.state.captured, 0)
  assert.equal(out.state.ended, 'stopped')
})

test('the tally only moves for a frame that was actually banked', () => {
  // tickCadence deciding to take a photo is not a photo. The browser module
  // increments only after an encode produced bytes, and the count on screen is
  // this one — so a camera whose every encode failed reads zero, not forty.
  let state = startCadence(0)
  for (let i = 0; i < 40; i++) {
    const out = tickCadence(state, { nowMs: i * 800, readyState: 4, videoWidth: 1920, currentTime: i })
    state = out.state
  }
  assert.equal(state.captured, 0)
  assert.equal(sweepCountLine(state.captured), 'No photos yet — the camera is watching.')
})

test('frames come back at the camera aspect, capped at the reconstruction size', () => {
  assert.deepEqual(frameSize(1920, 1080), { width: 1920, height: 1080 })
  // Portrait, because a phone clamped to a gimbal may well be that way up.
  assert.deepEqual(frameSize(1080, 1920), { width: 1080, height: 1920 })
  // 4K down to the long edge, aspect intact.
  assert.deepEqual(frameSize(3840, 2160), { width: FRAME_LONG_EDGE, height: 1080 })
  // Never upscaled: invented detail is detail the reconstruction would trust.
  assert.deepEqual(frameSize(640, 480), { width: 640, height: 480 })
  for (const bad of [[0, 1080], [1920, 0], [Number.NaN, 1080], [-4, 4]] as const) {
    assert.equal(frameSize(bad[0], bad[1]), null, `frameSize(${bad[0]}, ${bad[1]}) should refuse`)
  }
})

test('frame names sort in the order they were taken and carry the spot', () => {
  const names = [frameFileName(1, 2), frameFileName(1, 10), frameFileName(2, 1)]
  assert.deepEqual(names, ['sweep-spot01-0002.jpg', 'sweep-spot01-0010.jpg', 'sweep-spot02-0001.jpg'])
  assert.deepEqual([...names].sort(), names)
  for (const name of names) assert.match(name, /^[a-z0-9-]+\.jpg$/)
})

test('every sentence this module puts on screen is in the register the sheet uses', () => {
  // Same banned vocabulary as station_capture.test.ts. Someone is standing in
  // their living room with a tripod; nothing here may name a browser API, a
  // reconstruction technique or an internal job.
  const banned = [
    'getusermedia', 'mediastream', 'canvas', 'blob', 'jpeg', 'codec', 'cadence',
    'slam', 'sfm', 'pose', 'panoptic', 'splat', 'keyframe', 'ingest', 'gaussian',
  ]
  const lines = [
    CAMERA_ON_LABEL,
    sweepCountLine(0),
    sweepCountLine(1),
    sweepCountLine(12),
    ...(['stalled', 'full', 'timeout'] as const).map(r => sweepEndNotice(r, 7)!),
    ...(['unsupported', 'denied', 'busy', 'failed'] as const).map(cameraRefusal),
  ]
  for (const line of lines) {
    assert.ok(line.length > 0)
    for (const word of banned) {
      assert.ok(!line.toLowerCase().includes(word), `"${word}" appears in: ${line}`)
    }
  }
})

test('a sweep the operator stopped says nothing; the three that stopped themselves say what to do', () => {
  assert.equal(sweepEndNotice('stopped', 9), null)
  for (const reason of ['stalled', 'full', 'timeout'] as const) {
    const line = sweepEndNotice(reason, 9)!
    // The count that survived is in every one of them: each of these ends a
    // sweep that has real photos in it, and the next decision is about those.
    assert.match(line, /\b9 photos\b/)
  }
  assert.match(sweepEndNotice('stalled', 1)!, /\b1 photo\b/)
})

test('every camera refusal leaves the import path standing', () => {
  // The degradation rule. A browser or a phone that will not hand over a
  // camera must not dead-end the capture: photos taken some other way still
  // finish it, and that is also how a half-finished capture is recovered.
  for (const cause of ['unsupported', 'denied', 'busy', 'failed'] as const) {
    assert.match(cameraRefusal(cause), /added below/, `${cause} does not point anywhere`)
  }
})


// ─── The picture-led cadence ─────────────────────────────────────────────────
//
// Measured on a real gimbal on 2026-08-29: 700 ms x 48 frames is 33.6 s of
// capture against a ten-position sweep that ran 60-90 s, so a spot's photos
// covered the first half of the arc and the far end of the room was never
// photographed. These are the tests that would have caught that, and they are
// written against the SHAPE of a sweep rather than against the constants, so
// re-tuning either knob cannot quietly reintroduce it.

/**
 * A stepped gimbal, as the page sees it: `positions` stops, `dwellMs` still at
 * each, `travelMs` moving between them, over the whole `durationMs`.
 *
 * Motion and novelty are what `sweep-camera.ts` computes from two small grids
 * of the picture — near zero while the gimbal is parked, large while it swings.
 */
function sweepRun(opts: {
  positions: number
  durationMs: number
  dwellMs: number
  tickMs?: number
  jamAfterMs?: number
}): { captures: number[], state: CadenceState, lastStillMs: number } {
  const tickMs = opts.tickMs ?? 120
  const cycle = opts.durationMs / opts.positions
  let state = startCadence(0)
  const captures: number[] = []
  let bankedAt = -1
  let lastStillMs = 0

  for (let nowMs = 0; nowMs <= opts.durationMs; nowMs += tickMs) {
    const jammed = opts.jamAfterMs !== undefined && nowMs >= opts.jamAfterMs
    const phase = nowMs % cycle
    const parked = jammed || phase < opts.dwellMs
    // Which stop the gimbal is at. A jam freezes it wherever it was.
    const position = jammed ? Math.floor(opts.jamAfterMs! / cycle) : Math.floor(nowMs / cycle)
    const tick: CameraTick = {
      nowMs,
      readyState: 4,
      videoWidth: 1920,
      // A live camera: currentTime always moves, jam or no jam. That is the
      // whole point — the stall guard cannot see a jammed gimbal.
      currentTime: Number((nowMs / 1000).toFixed(3)),
      motion: parked ? 0.002 : 0.31,
      // Against the last banked photo: a different stop looks different, the
      // same stop does not.
      novelty: bankedAt === position ? 0.004 : 0.27,
    }
    const out = tickCadence(state, tick)
    state = out.state
    lastStillMs = viewStillMs(state, nowMs)
    if (out.action === 'end') break
    if (out.action === 'capture') {
      captures.push(nowMs)
      state = noteCaptured(state)
      if (parked) bankedAt = position
    }
  }
  return { captures, state, lastStillMs }
}

test('a 90 s ten-position sweep is photographed end to end, not just the first third', () => {
  // The defect, stated as the thing it broke: the last position of the arc has
  // to have a photograph of it.
  const { captures, state } = sweepRun({ positions: 10, durationMs: 90_000, dwellMs: 900 })
  assert.equal(state.ended, null, `the sweep ended early as ${state.ended}`)
  const last = captures[captures.length - 1]!
  assert.ok(last > 85_000, `the last photo was taken at ${last} ms of a 90 s sweep`)

  // And spread, not clustered: every tenth of the sweep has a photo in it.
  for (let i = 0; i < 10; i++) {
    const from = i * 9_000
    assert.ok(
      captures.some(at => at >= from && at < from + 9_000),
      `no photo was taken between ${from} and ${from + 9_000} ms`,
    )
  }
  // The old numbers would have run out here: 48 frames at 700 ms is 33.6 s.
  assert.ok(captures.filter(at => at <= 33_600).length < 48, 'the budget was still being spent at the old rate')
})

test('each gimbal position is photographed, and a long dwell is not photographed forty times', () => {
  const positions = 12
  const { captures } = sweepRun({ positions, durationMs: 90_000, dwellMs: 1_500 })
  const cycle = 90_000 / positions
  for (let i = 0; i < positions; i++) {
    assert.ok(
      captures.some(at => at >= i * cycle && at < (i + 1) * cycle),
      `position ${i + 1} of ${positions} was never photographed`,
    )
  }
  // One sharp photo per stop plus the floor's insurance, nowhere near a photo
  // every 700 ms — which over 90 s would be 128.
  assert.ok(captures.length < 60, `${captures.length} photos from a twelve-position sweep`)
})

test('the floor keeps photographing even when the picture gate never opens', () => {
  // VIEW_SETTLED and VIEW_NEW are chosen numbers, not measured ones, so the
  // thing that has to be true is that being wrong about them cannot empty a
  // spot. Here both gates are shut for the whole sweep — the picture is always
  // moving and never novel — and the sweep is still photographed throughout.
  let state = startCadence(0)
  const captures: number[] = []
  for (let nowMs = 0; nowMs <= 60_000; nowMs += 120) {
    const out = tickCadence(state, {
      nowMs,
      readyState: 4,
      videoWidth: 1920,
      currentTime: nowMs / 1000,
      motion: 0.9,
      novelty: 0,
    })
    state = out.state
    if (out.action === 'end') break
    if (out.action === 'capture') {
      captures.push(nowMs)
      state = noteCaptured(state)
    }
  }
  assert.ok(captures.length >= 14, `only ${captures.length} photos in a minute with both gates shut`)
  for (let i = 1; i < captures.length; i++) {
    assert.ok(
      captures[i]! - captures[i - 1]! <= SWEEP_FORCE_BANK_MS + 200,
      `${captures[i]! - captures[i - 1]!} ms went by with no photo`,
    )
  }
  assert.ok(captures[captures.length - 1]! > 55_000, 'the far end of the sweep was not photographed')
})

test('a settled view that has not moved since the last photo is not photographed again', () => {
  // The frozen-feed failure in its other form: a gimbal parked on one wall
  // delivering a perfectly live picture. Between floor photos, nothing.
  let state = startCadence(0)
  let banks = 0
  for (let nowMs = 0; nowMs <= 3_600; nowMs += 120) {
    const out = tickCadence(state, {
      nowMs, readyState: 4, videoWidth: 1920, currentTime: nowMs / 1000,
      motion: 0, novelty: 0,
    })
    state = out.state
    if (out.action === 'capture') { banks++; state = noteCaptured(state) }
  }
  // One: the first, taken before anything could be compared to it. Nothing
  // after, because the view neither moved nor became new, and the four-second
  // floor has not come round.
  assert.equal(banks, 1, `${banks} photos of a view that never changed`)
})

test('a jammed gimbal is said out loud while the tally is still climbing', () => {
  // The 2026-08-29 run in one test: 48 photos of one wall and a screen that
  // said only "48 photos". The feed is healthy the whole time, so the stall
  // guard is right to stay quiet — this is the signal that is not.
  const { state, captures, lastStillMs } = sweepRun({
    positions: 10, durationMs: 90_000, dwellMs: 900, jamAfterMs: 30_000,
  })
  assert.equal(state.ended, null, 'a jam ended the sweep; it must not — the photos so far are good')
  assert.ok(captures.some(at => at > 60_000), 'photos stopped arriving, so the tally would not be climbing')
  assert.ok(lastStillMs > SWEEP_STILL_WARN_MS, `the view read as still for only ${lastStillMs} ms`)
  const notice = sweepMotionNotice(lastStillMs)
  assert.ok(notice, 'a gimbal jammed for a minute produced no warning')
  assert.match(notice!, /same wall/)
})

test('a sweep that is simply moving slowly is never accused of having stopped', () => {
  const { lastStillMs } = sweepRun({ positions: 6, durationMs: 90_000, dwellMs: 1_500 })
  assert.ok(lastStillMs < SWEEP_STILL_WARN_MS, `a 15 s dwell read as ${lastStillMs} ms still`)
  assert.equal(sweepMotionNotice(lastStillMs), null)
  // And nothing is claimed about a picture that was never measured.
  assert.equal(viewStillMs(startCadence(0), 999_999), 0)
  assert.equal(sweepMotionNotice(0), null)
  assert.equal(sweepMotionNotice(SWEEP_STILL_WARN_MS - 1), null)
})

test('an unmeasurable picture falls back to the clock rather than refusing', () => {
  // A canvas that will not read back hands over nulls. That must be a sweep
  // photographed on a timer — what this module was — and never a sweep that
  // takes no photographs.
  let state = startCadence(0)
  let banks = 0
  for (let nowMs = 0; nowMs <= 10_000; nowMs += 100) {
    const out = tickCadence(state, {
      nowMs, readyState: 4, videoWidth: 1920, currentTime: nowMs / 1000,
      motion: null, novelty: null,
    })
    state = out.state
    if (out.action === 'capture') { banks++; state = noteCaptured(state) }
  }
  assert.ok(banks >= 13, `${banks} photos in ten seconds on the fallback clock`)
})

test('two looks at the picture compare, and an incomparable pair says so', () => {
  const a = new Uint8Array([0, 0, 0, 0])
  const b = new Uint8Array([255, 255, 255, 255])
  assert.equal(viewDifference(a, a), 0)
  assert.equal(viewDifference(a, b), 1)
  assert.ok(Math.abs(viewDifference(a, new Uint8Array([0, 0, 0, 255]))! - 0.25) < 1e-9)
  // Null, not zero. A fabricated zero reads as a view that never moves, which
  // would accuse a healthy sweep of having jammed.
  assert.equal(viewDifference(null, b), null)
  assert.equal(viewDifference(a, null), null)
  assert.equal(viewDifference(a, new Uint8Array([1, 2, 3])), null)
  assert.equal(viewDifference(new Uint8Array(0), new Uint8Array(0)), null)
})

test('the thresholds and the ceilings still hold each other up', () => {
  assert.ok(VIEW_SETTLED < VIEW_NEW, 'a settled picture would also have to be a new one')
  assert.ok(SWEEP_FORCE_BANK_MS > SWEEP_SAMPLE_MS, 'the floor is tighter than the minimum gap')
  // The ceiling has to sit above what a legitimate full sweep reaches, or it
  // stops the sweep partway — which is the defect. The floor alone over the
  // whole window, plus one sharp photo at each of twenty positions.
  const floorFrames = Math.ceil(SWEEP_MAX_MS / SWEEP_FORCE_BANK_MS)
  assert.ok(
    SWEEP_MAX_FRAMES > floorFrames,
    `${SWEEP_MAX_FRAMES} frames cannot cover ${SWEEP_MAX_MS} ms even at the floor rate`,
  )
  // And the time ceiling has to clear the longest sweep measured, 90 s.
  assert.ok(SWEEP_MAX_MS > 90_000, 'the time ceiling ends a sweep that is running normally')
  assert.ok(SWEEP_STILL_WARN_MS > 1_500, 'an ordinary dwell would trip the jam warning')
})

test('the jam warning is in the register the sheet uses', () => {
  const line = sweepMotionNotice(SWEEP_STILL_WARN_MS + 5_000)!
  for (const word of ['gimbal', 'canvas', 'frame', 'pose', 'slam', 'cadence']) {
    assert.ok(!line.toLowerCase().includes(word), `"${word}" appears in: ${line}`)
  }
  assert.match(line, /\b25 seconds\b/)
})


test('a page that was in the background is not accused of having jammed', () => {
  // Measured 2026-08-30 in a background tab: the sheet came back saying "the
  // view has not moved for 73 seconds" about a sweep whose gimbal had been
  // turning until 31 seconds earlier. Android stops the feed when Chrome goes
  // away, so an unchanging picture there is the page being away, not a jam.
  let state = startCadence(0)
  const look = (nowMs: number, hidden: boolean, motion: number | null) => {
    const out = tickCadence(state, {
      nowMs, readyState: 4, videoWidth: 1920, currentTime: nowMs / 1000,
      hidden, motion, novelty: 0.3,
    })
    state = out.state
    if (out.action === 'capture') state = noteCaptured(state)
  }
  for (let t = 0; t < 3_000; t += 120) look(t, false, 0.3)
  // Away for two minutes. The camera reports nothing measurable while hidden.
  for (let t = 3_000; t < 123_000; t += 1_000) look(t, true, null)
  assert.equal(viewStillMs(state, 123_000), 0, 'a backgrounded page banked up a stillness clock')
  assert.equal(sweepMotionNotice(viewStillMs(state, 123_000)), null)
  // And on the way back the clock starts from the first look, not from before.
  look(123_120, false, 0.3)
  assert.ok(viewStillMs(state, 123_240) < 1_000)
})
