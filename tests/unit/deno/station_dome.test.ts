/**
 * Deno unit tests for the station-dome capture gate.
 *
 * The assertion that matters most is the refusal: a one-station capture is
 * geometrically incapable of reconstruction (measured on a real COLMAP run:
 * 3 of 17 images registered), and this module is the only thing standing
 * between such a capture and a twenty-minute solve that cannot converge. The
 * pan-spread helper is tested across the ±180 wrap because the OM6's reachable
 * pan (+82° … 180° … -100°) crosses it on every real sweep.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import {
  assessStationCoverage,
  isStationDomeSession,
  MEASURED_GOOD_STATIONS,
  MIN_FRAMES_PER_STATION,
  MIN_STATIONS,
  panSpreadDegrees,
  readStationCoverage,
  stationCaptureBlockReason,
  STATION_DOME_SOURCE,
  summarizeStationCoverage,
} from '../../../server/capture/station_dome.ts'

/** keyframes.jsonl exactly as POST /sessions/:id/keyframes writes it. */
function jsonl(frames: Array<Record<string, unknown>>): string {
  return frames
    .map((meta, i) => JSON.stringify({
      index: i,
      file: `kf-${String(i).padStart(5, '0')}.jpg`,
      bytes: 12345,
      receivedAt: 1756400000000 + i,
      ...meta,
    }))
    .join('\n') + '\n'
}

/** A dome: `frames` shots spread across the OM6's measured 150° of pan. */
function dome(station: number, frames: number, startPan = -75): Array<Record<string, unknown>> {
  return Array.from({ length: frames }, (_, i) => ({
    station,
    pan: startPan + (150 * i) / Math.max(1, frames - 1),
    tilt: i % 2 === 0 ? -10 : 10,
  }))
}

Deno.test('summarize reads the station index the keyframe route wrote through', () => {
  const coverage = summarizeStationCoverage(jsonl([...dome(0, 6), ...dome(1, 8)]))
  assertEquals(coverage.frameCount, 14)
  assertEquals(coverage.labelledFrameCount, 14)
  assertEquals(coverage.framesWithoutStation, 0)
  assertEquals(coverage.malformedLines, 0)
  assertEquals(coverage.stations.map(s => s.station), [0, 1])
  assertEquals(coverage.stations.map(s => s.frameCount), [6, 8])
})

Deno.test('summarize counts unreadable lines rather than dropping them silently', () => {
  const coverage = summarizeStationCoverage(
    jsonl(dome(0, 4)) + 'not json at all\n' + '[1,2,3]\n' + jsonl(dome(1, 4)),
  )
  assertEquals(coverage.malformedLines, 2)
  assertEquals(coverage.frameCount, 8)
})

Deno.test('a non-integer station is not a station index', () => {
  const coverage = summarizeStationCoverage(jsonl([
    { station: 0 },
    { station: '1' },
    { station: 1.5 },
    { station: -1 },
    { pan: 12 },
  ]))
  assertEquals(coverage.stations.map(s => s.station), [0])
  assertEquals(coverage.framesWithoutStation, 4)
})

Deno.test('one station is refused: pure rotation cannot be reconstructed', () => {
  // 40 photos from one spot is still one spot. Frame count must not rescue it.
  const assessment = assessStationCoverage(summarizeStationCoverage(jsonl(dome(0, 40))))
  assertEquals(assessment.ok, false)
  assertEquals(assessment.verdict, 'single-station')
  assert(assessment.remediation !== null)
  assertStringIncludes(assessment.remediation, 'Move the tripod')
  // The refusal names the measurement it rests on — and it must be THIS rig's
  // own measurement. 3-of-17 is a handheld near-in-place run (ADR 0007); quoting
  // it beside "on this rig" would attribute another setup's result to the gimbal.
  assertStringIncludes(assessment.reason, '4 of 9')
  assertStringIncludes(assessment.reason, 'this rig')
})

Deno.test('two stations is accepted as the minimum that can work, with a warning', () => {
  const assessment = assessStationCoverage(summarizeStationCoverage(jsonl([...dome(0, 8), ...dome(1, 8)])))
  assertEquals(assessment.ok, true)
  assertEquals(assessment.verdict, 'ready')
  assertEquals(MIN_STATIONS, 2)
  assert(
    assessment.warnings.some(w => w.includes(`${MEASURED_GOOD_STATIONS} spread around the room`)),
    `expected a "fewer than the measured-good layout" warning, got ${JSON.stringify(assessment.warnings)}`,
  )
})

Deno.test('the measured-good five-station capture passes clean', () => {
  const frames = [0, 1, 2, 3, 4].flatMap(station => dome(station, 8))
  const assessment = assessStationCoverage(summarizeStationCoverage(jsonl(frames)))
  assertEquals(assessment.ok, true)
  assertEquals(assessment.verdict, 'ready')
  assertEquals(assessment.warnings, [])
  assertEquals(assessment.coverage.stations.length, MEASURED_GOOD_STATIONS)
  assertEquals(assessment.coverage.frameCount, 40)
})

Deno.test('an empty session and an unlabelled one are refused with different reasons', () => {
  const empty = assessStationCoverage(summarizeStationCoverage(''))
  assertEquals(empty.ok, false)
  assertEquals(empty.verdict, 'empty')

  // A walkthrough session posted to this route: frames, but no station on any.
  const unlabelled = assessStationCoverage(summarizeStationCoverage(jsonl([{ pan: 1 }, { pan: 2 }, { pan: 3 }])))
  assertEquals(unlabelled.ok, false)
  assertEquals(unlabelled.verdict, 'unlabelled')
  assert(unlabelled.remediation !== null)
  assertStringIncludes(unlabelled.remediation, '`station`')
})

Deno.test('thin stations, unpanned stations and unlabelled frames warn without blocking', () => {
  const frames = [
    ...dome(0, 8),
    ...dome(1, 8),
    ...dome(2, MIN_FRAMES_PER_STATION - 1),
    // Station 3 never moved: every shot at the same pan.
    ...Array.from({ length: 6 }, () => ({ station: 3, pan: 40 })),
    { pan: 5 },
  ]
  const assessment = assessStationCoverage(summarizeStationCoverage(jsonl(frames)))
  assertEquals(assessment.ok, true)
  const joined = assessment.warnings.join(' | ')
  assertStringIncludes(joined, `Spot(s) 2 have fewer than ${MIN_FRAMES_PER_STATION} photos`)
  assertStringIncludes(joined, 'Spot(s) 3 took every photo pointing the same way')
  assertStringIncludes(joined, 'without a station number')
})

Deno.test('pan spread is measured across the ±180 wrap the OM6 sweeps through', () => {
  assertEquals(panSpreadDegrees([]), null)
  assertEquals(panSpreadDegrees([90]), 0)
  assertEquals(panSpreadDegrees([-75, 0, 75]), 150)
  // A real OM6 sweep: +105 … 180 … -105 is a 150° arc, not a 210° one.
  assertEquals(panSpreadDegrees([105, 150, 180, -150, -105]), 150)
})

Deno.test('the job preflight blocks a degenerate station capture and nothing else', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'station-dome-test-' })
  try {
    // A walkthrough session: not a station capture, so no opinion at all.
    await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify({ sessionId: 'sess-x', source: 'video-ingest' }))
    await Deno.writeTextFile(`${dir}/keyframes.jsonl`, jsonl([{ pan: 1 }, { pan: 2 }]))
    assertEquals(await stationCaptureBlockReason(dir), null)

    // The same frames, declared as a station capture: blocked.
    await Deno.writeTextFile(
      `${dir}/session.json`,
      JSON.stringify({ sessionId: 'sess-x', source: STATION_DOME_SOURCE }),
    )
    const blocked = await stationCaptureBlockReason(dir)
    assert(blocked !== null, 'expected an unlabelled station capture to be blocked')
    assertStringIncludes(blocked, 'station number')

    // Two real domes: allowed through.
    await Deno.writeTextFile(`${dir}/keyframes.jsonl`, jsonl([...dome(0, 8), ...dome(1, 8)]))
    assertEquals(await stationCaptureBlockReason(dir), null)

    // One dome: blocked, with the tripod instruction.
    await Deno.writeTextFile(`${dir}/keyframes.jsonl`, jsonl(dome(0, 17)))
    const single = await stationCaptureBlockReason(dir)
    assert(single !== null)
    assertStringIncludes(single, 'Move the tripod')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a missing keyframes.jsonl reads as empty, not as a throw', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'station-dome-test-' })
  try {
    const coverage = await readStationCoverage(dir)
    assertEquals(coverage.frameCount, 0)
    assertEquals(assessStationCoverage(coverage).verdict, 'empty')
    // No session.json either — nothing to block, and nothing to throw over.
    assertEquals(await stationCaptureBlockReason(dir), null)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('isStationDomeSession only recognises the recorded source', () => {
  assert(isStationDomeSession({ source: STATION_DOME_SOURCE }))
  assert(!isStationDomeSession({ source: 'photo-ingest' }))
  assert(!isStationDomeSession(null))
  assert(!isStationDomeSession('station-dome'))
})
