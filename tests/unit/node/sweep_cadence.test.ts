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
  SWEEP_MAX_FRAMES,
  SWEEP_MAX_MS,
  SWEEP_SAMPLE_MS,
  SWEEP_STALL_MS,
  cameraRefusal,
  endCadence,
  frameFileName,
  frameSize,
  noteCaptured,
  startCadence,
  sweepCountLine,
  sweepEndNotice,
  tickCadence,
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

test('every gimbal dwell contains at least one sample instant, at any clock offset', () => {
  // The whole reason a cadence can replace a per-position tap. Sampling every
  // SWEEP_SAMPLE_MS means the longest gap between samples is SWEEP_SAMPLE_MS,
  // so a dwell window strictly longer than that cannot fall between two of
  // them — checked here at every 10 ms offset rather than asserted.
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
