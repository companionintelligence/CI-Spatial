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
import {
  assessSweepSeparation,
  clearSeparationCache,
  readSolvedSeparation,
  SAME_SPOT_RATIO,
  SOLVED_MOVED_RATIO,
} from '../../../server/capture/station_movement.ts'
import { frameFingerprint } from '../../../server/colmap/colmap_poses.ts'

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

// ─── Did the tripod actually move? ───────────────────────────────────────────
//
// The gate above counts stations the uploader *declared*. On 2026-08-30 a real
// rig swept the same six columns twice without the tripod moving, declared two
// stations, and was accepted here with only a "5 spots would be better"
// warning; the wrong 17 m-per-unit scale was stopped twenty minutes later by
// the known-distance tier alone. These tests cover the earlier signal.
//
// The thresholds are calibrated on those two runs (see station_movement.ts):
// two sweeps from one spot differed 6.6 grey levels where neighbouring photos
// of a single sweep differed 44.3 — ratio 0.15 — against 43.4 (ratio 0.98)
// after a real 1.8 m move.

/** A signature with a given texture; `seed` picks the view, `shade` the exposure. */
function signature(seed: number, shade = 0): number[] {
  return Array.from({ length: 64 }, (_, i) => {
    const v = 128 + 100 * Math.sin(seed * 7.13 + i * 1.37) + shade
    return Math.max(0, Math.min(255, v))
  })
}

Deno.test('summarizing JSONL alone claims nothing about movement', () => {
  const coverage = summarizeStationCoverage(jsonl([...dome(0, 6), ...dome(1, 6)]))
  assertEquals(coverage.movement.status, 'not-checked')
  assertEquals(coverage.movement.pairs, [])
  // And the verdict says so in words, rather than asserting the move happened.
  const assessment = assessStationCoverage(coverage)
  assertEquals(assessment.verdict, 'ready')
  assertStringIncludes(assessment.reason, 'Nothing here has checked')
})

Deno.test('two sweeps of the same view are spotted; two of different views are not', () => {
  const stationary = assessSweepSeparation([
    { station: 0, signatures: [0, 1, 2, 3].map(i => signature(i)) },
    // The same six views again, one exposure step brighter — a tripod that never moved.
    { station: 1, signatures: [0, 1, 2, 3].map(i => signature(i, 9)) },
  ])
  assertEquals(stationary.status, 'measured')
  assertEquals(stationary.pairs.length, 1)
  assertEquals(stationary.pairs[0].verdict, 'same-spot-suspected')
  assert(
    stationary.pairs[0].ratio < SAME_SPOT_RATIO,
    `expected a ratio under ${SAME_SPOT_RATIO}, got ${stationary.pairs[0].ratio}`,
  )

  const moved = assessSweepSeparation([
    { station: 0, signatures: [0, 1, 2, 3].map(i => signature(i)) },
    { station: 1, signatures: [10, 11, 12, 13].map(i => signature(i)) },
  ])
  assertEquals(moved.status, 'measured')
  assertEquals(moved.pairs[0].verdict, 'moved')
})

Deno.test('a scene with no contrast of its own is inconclusive, never an accusation', () => {
  // A blank wall: every frame nearly identical *within* a sweep too, so the
  // comparison between sweeps has no yardstick. Saying "you did not move" here
  // would strand an operator who did.
  const flat = assessSweepSeparation([
    { station: 0, signatures: [0, 1, 2].map(i => signature(i).map(v => 128 + (v - 128) * 0.02)) },
    { station: 1, signatures: [0, 1, 2].map(i => signature(i).map(v => 128 + (v - 128) * 0.02)) },
  ])
  assertEquals(flat.status, 'inconclusive')
  assertEquals(flat.pairs, [])
  assert(flat.note !== null)
  assertStringIncludes(flat.note, 'too plain')
})

Deno.test('one spot with photos is not compared with itself', () => {
  const alone = assessSweepSeparation([{ station: 0, signatures: [signature(1), signature(2)] }])
  assertEquals(alone.status, 'not-checked')
  assertEquals(alone.pairs, [])
})

Deno.test('a suspected single spot warns loudly but does not refuse the capture', () => {
  const coverage = summarizeStationCoverage(jsonl([...dome(0, 6), ...dome(1, 6)]))
  const assessment = assessStationCoverage({
    ...coverage,
    movement: {
      status: 'measured',
      pairs: [{ a: 0, b: 1, differenceLevels: 6.6, sceneContrastLevels: 44.3, ratio: 0.149, verdict: 'same-spot-suspected' }],
      sampledFrames: 12,
      note: null,
      remediation: null,
    },
  })
  // Not a refusal: this evidence is two runs in one room, and a wrong
  // accusation strands an operator who did move the tripod.
  assertEquals(assessment.ok, true)
  const joined = assessment.warnings.join(' | ')
  assertStringIncludes(joined, 'Spots 0 and 1 photographed almost the same view')
  assertStringIncludes(joined, '6.6 against 44.3')
  // And the accepted verdict does not go on to claim the move happened — it
  // says the doubt out loud, in the one sentence a caller is most likely to
  // show the operator.
  assert(
    !assessment.reason.includes('a visibly different view'),
    `a suspected single spot must not be described as having moved: ${assessment.reason}`,
  )
  assertStringIncludes(assessment.reason, 'the tripod may never have been moved')
})

Deno.test('a solve that measured the spots on top of each other refuses the capture', () => {
  const coverage = summarizeStationCoverage(jsonl([...dome(0, 6), ...dome(1, 6)]))
  // RUN A's own numbers: 0.106 between the two stations, 5.19 of scatter inside one.
  const assessment = assessStationCoverage({
    ...coverage,
    movement: {
      ...coverage.movement,
      solved: { known: true, moved: false, separation: 0.106, withinSpotSpread: 5.19, ratio: 0.02 },
    },
  })
  assertEquals(assessment.ok, false)
  assertEquals(assessment.verdict, 'stations-not-separated')
  assertStringIncludes(assessment.reason, '0.11 apart')
  assertStringIncludes(assessment.reason, '5.19')
  assert(assessment.remediation !== null)
  assertStringIncludes(assessment.remediation, 'couple of metres apart')

  // RUN B's: the same shape of evidence, the other way round.
  const good = assessStationCoverage({
    ...coverage,
    movement: {
      ...coverage.movement,
      solved: { known: true, moved: true, separation: 9.863, withinSpotSpread: 0.069, ratio: 143 },
    },
  })
  assertEquals(good.ok, true)
  assertStringIncludes(good.reason, 'the finished scan measured the camera really moving')
})

/**
 * Twelve keyframes with the given bodies, and the fingerprint the solve would
 * have published for them. Real files, because the guard being exercised reads
 * the photographs rather than any sidecar describing them.
 */
async function writeFrames(dir: string, bodies: string[]): Promise<string> {
  const names: string[] = []
  for (const [i, body] of bodies.entries()) {
    const name = `kf-${String(i).padStart(5, '0')}.jpg`
    await Deno.writeTextFile(`${dir}/${name}`, body)
    names.push(name)
  }
  return await frameFingerprint(dir, names)
}

/** A manifest exactly as colmap_poses.ts writes it, with the fingerprint of the frames it read. */
function solveManifest(fingerprint: string | null, quality: Record<string, unknown>, frameCount = 12): string {
  return JSON.stringify({
    tool: 'colmap',
    status: 'ok',
    frameCount,
    ...(fingerprint === null ? {} : { inputFingerprint: fingerprint }),
    quality,
  })
}

const RUN_A_QUALITY = {
  registrationRatio: 1,
  degenerate: true,
  status: 'needs-rescan',
  reasons: ['no-station-baseline'],
  // RUN A's own numbers: 0.106 between the two spots, 5.19 of scatter inside one.
  baseline: { stationCount: 2, placedFrameCount: 12, minSeparation: 0.106, maxSpread: 5.19, separationRatio: 0.0204 },
  thresholds: { minRegistrationRatio: 0.6, minPoints3D: 100, minStationSeparationRatio: 1 },
}

Deno.test('a solve verdict about a different set of photos is not evidence about these', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'station-movement-test-' })
  try {
    const runA = Array.from({ length: 12 }, (_, i) => `run-a photo ${i}`)
    const fingerprintA = await writeFrames(dir, runA)
    await Deno.writeTextFile(`${dir}/colmap-poses.manifest.json`, solveManifest(fingerprintA, RUN_A_QUALITY))

    // The manifest describes twelve photos; this session now holds eighteen.
    // The cheapest disagreement is still caught first.
    const stale = await readSolvedSeparation(dir, 18)
    assertEquals(stale.known, false)
    assertStringIncludes(stale.note ?? '', 'does not describe these photos')

    const fresh = await readSolvedSeparation(dir, 12)
    assertEquals(fresh.known, true)
    assertEquals(fresh.moved, false)
    assertEquals(fresh.separation, 0.106)
    assertEquals(fresh.withinSpotSpread, 5.19)
    // The bar the solve published is the bar used, so the two gates cannot
    // disagree about one number.
    assertEquals(fresh.threshold, 1)
    assertEquals(fresh.ratio! < SOLVED_MOVED_RATIO, true)

    // ── The collision that actually happened ─────────────────────────────────
    //
    // A second twelve-photo capture landed in the first one's session
    // directory. Every cheap key still matched — twelve frames both times, the
    // same `kf-*.jpg` names both times, and `keyframes.jsonl` describes the
    // frames by name so it need not have been rewritten at all. Only the
    // photographs changed, so only the photographs can catch it. Measured
    // 2026-08-30 on the two real dome captures: with the frames swapped and
    // nothing else touched, this reader handed back RUN A's geometry as a
    // verdict on RUN B's photographs, and the capture was refused in 67 ms
    // without the solver running.
    const fingerprintB = await writeFrames(dir, runA.map((_, i) => `run-b photo ${i}`))
    assert(fingerprintB !== fingerprintA, 'two different captures must not fingerprint alike')
    const swapped = await readSolvedSeparation(dir, 12)
    assertEquals(swapped.known, false)
    assertStringIncludes(swapped.note ?? '', 'changed after the last scan ran')

    // A single byte of a single photo is a different capture.
    await writeFrames(dir, runA.map((body, i) => (i === 7 ? `${body}!` : body)))
    assertEquals((await readSolvedSeparation(dir, 12)).known, false)

    // Back to the photographs the solve actually read, and the verdict is
    // evidence again — reuse across an UNCHANGED input stays legitimate.
    await writeFrames(dir, runA)
    assertEquals((await readSolvedSeparation(dir, 12)).known, true)

    // A manifest that does not record which photos it was computed from cannot
    // prove it describes these, so it is not believed — the same rule
    // runColmapPoses applies to an unfingerprinted colmap-work/.
    await Deno.writeTextFile(`${dir}/colmap-poses.manifest.json`, solveManifest(null, RUN_A_QUALITY))
    const unkeyed = await readSolvedSeparation(dir, 12)
    assertEquals(unkeyed.known, false)
    assertStringIncludes(unkeyed.note ?? '', 'does not record which photos')

    // RUN B's numbers through the same reader: measured, and moved.
    await Deno.writeTextFile(
      `${dir}/colmap-poses.manifest.json`,
      solveManifest(fingerprintA, {
        registrationRatio: 0.75,
        degenerate: false,
        status: 'ready',
        reasons: [],
        baseline: { stationCount: 2, placedFrameCount: 9, minSeparation: 9.863, maxSpread: 0.139, separationRatio: 70.9 },
        thresholds: { minRegistrationRatio: 0.6, minPoints3D: 100, minStationSeparationRatio: 1 },
      }),
    )
    const movedSolve = await readSolvedSeparation(dir, 12)
    assertEquals(movedSolve.known, true)
    assertEquals(movedSolve.moved, true)

    // A walkthrough solve has no spots to measure between, and says nothing
    // about a tripod rather than reassuring anyone about one.
    await Deno.writeTextFile(
      `${dir}/colmap-poses.manifest.json`,
      solveManifest(fingerprintA, { registrationRatio: 1, status: 'ready', reasons: [] }),
    )
    assertEquals((await readSolvedSeparation(dir, 12)).known, false)

    // A spot backed by a single camera has no scatter to compare against;
    // colmap_poses.ts publishes that as a null ratio, and null is not a verdict.
    await Deno.writeTextFile(
      `${dir}/colmap-poses.manifest.json`,
      solveManifest(fingerprintA, {
        baseline: { stationCount: 2, placedFrameCount: 2, minSeparation: 4, maxSpread: 0, separationRatio: null },
      }),
    )
    assertEquals((await readSolvedSeparation(dir, 12)).known, false)

    // And no solve at all is not a verdict either.
    await Deno.remove(`${dir}/colmap-poses.manifest.json`)
    assertEquals((await readSolvedSeparation(dir, 12)).known, false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('unreadable photos degrade to skipped, and say the check did not run', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'station-movement-test-' })
  try {
    clearSeparationCache()
    await Deno.writeTextFile(`${dir}/keyframes.jsonl`, jsonl([...dome(0, 6), ...dome(1, 6)]))
    // The keyframes name images that were never written — and, in other real
    // sessions, 10-byte placeholders that are not JPEGs at all.
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'not a jpeg')
    const coverage = await readStationCoverage(dir)
    assertEquals(coverage.movement.status, 'skipped')
    assertEquals(coverage.movement.remediation !== null, true)
    const assessment = assessStationCoverage(coverage)
    assertEquals(assessment.ok, true)
    assertStringIncludes(assessment.warnings.join(' | '), 'could not be checked')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// ─── Against the frames the real rig shot ────────────────────────────────────
//
// `DOME_REAL_DIR` (default /tmp/dome-real) holds the two 2026-08-30 runs:
// spot1-col{1..6} + spot2-col{1..6} is the pair shot without moving the tripod,
// spot1-col{1..6} + st2-col{1..6} the pair with a real 1.8 m move between them.
// They are photographs of someone's room, so they are not in the repo and this
// declares itself ignored rather than passing silently when they are absent.
const realDir = Deno.env.get('DOME_REAL_DIR') ?? '/tmp/dome-real'
const realFramesPresent = await (async () => {
  try {
    await Deno.stat(`${realDir}/spot1-col1.jpg`)
    await Deno.stat(`${realDir}/spot2-col1.jpg`)
    await Deno.stat(`${realDir}/st2-col1.jpg`)
    return true
  } catch {
    return false
  }
})()

/** A session directory holding two sweeps, laid out exactly as the ingest writes one. */
async function realSession(second: 'spot2' | 'st2'): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `dome-real-${second}-` })
  const frames: Array<Record<string, unknown>> = []
  let index = 0
  for (const [station, stem] of [[0, 'spot1'], [1, second]] as const) {
    for (let col = 1; col <= 6; col += 1) {
      const file = `kf-${String(index).padStart(5, '0')}.jpg`
      await Deno.copyFile(`${realDir}/${stem}-col${col}.jpg`, `${dir}/${file}`)
      frames.push({ index, file, station, pan: -75 + (col - 1) * 30 })
      index += 1
    }
  }
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify({ sessionId: 'sess-real', source: STATION_DOME_SOURCE }))
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, frames.map(f => JSON.stringify(f)).join('\n') + '\n')
  return dir
}

Deno.test({
  name: 'RUN A, the tripod that never moved, is caught from the photographs alone',
  ignore: !realFramesPresent,
  fn: async () => {
    clearSeparationCache()
    const dir = await realSession('spot2')
    try {
      const coverage = await readStationCoverage(dir)
      assertEquals(coverage.stations.length, 2)
      assertEquals(coverage.movement.status, 'measured')
      const pair = coverage.movement.pairs[0]
      assertEquals(pair.verdict, 'same-spot-suspected')
      assert(pair.ratio < SAME_SPOT_RATIO, `RUN A ratio was ${pair.ratio}`)
      const assessment = assessStationCoverage(coverage)
      assertStringIncludes(assessment.warnings.join(' | '), 'photographed almost the same view')
      assertStringIncludes(assessment.reason, 'may never have been moved')
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'RUN B, the tripod carried 1.8 m, is not accused of standing still',
  ignore: !realFramesPresent,
  fn: async () => {
    clearSeparationCache()
    const dir = await realSession('st2')
    try {
      const coverage = await readStationCoverage(dir)
      assertEquals(coverage.movement.status, 'measured')
      const pair = coverage.movement.pairs[0]
      assertEquals(pair.verdict, 'moved')
      assert(pair.ratio >= SAME_SPOT_RATIO, `RUN B ratio was ${pair.ratio}`)
      const assessment = assessStationCoverage(coverage)
      assertEquals(assessment.ok, true)
      assertEquals(
        assessment.warnings.some(w => w.includes('almost the same view')),
        false,
        `a capture that really moved must not be accused: ${JSON.stringify(assessment.warnings)}`,
      )
      // Reports what the photographs showed, and does not upgrade that to a
      // fact about the tripod — the pixel test is not proof, and the sentence
      // says which check would be (see assessStationCoverage).
      assertStringIncludes(assessment.reason, 'a visibly different view')
      assertStringIncludes(assessment.reason, 'The finished scan is what confirms it.')
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  // The measurement cache used to be keyed on `station:filename`. Every
  // twelve-photo capture names its frames `kf-00000.jpg`…`kf-00011.jpg`, so the
  // key matched across two entirely different captures and the finding was
  // reused across the change — the same reuse-across-a-change the solver's
  // `colmap-work/` had, one layer up. Measured 2026-08-30 by replacing RUN A's
  // frames with RUN B's and re-reading: the reader kept answering
  // `same-spot-suspected` about photographs that measure `moved` under a fresh
  // key. Same names, opposite verdicts, and the wrong one was the reassuring one.
  name: 'replacing a capture\'s photos in place is a different measurement, not a cache hit',
  ignore: !realFramesPresent,
  fn: async () => {
    clearSeparationCache()
    const dir = await realSession('spot2')
    try {
      const before = await readStationCoverage(dir)
      assertEquals(before.movement.pairs[0].verdict, 'same-spot-suspected')

      // RUN B's photographs, under RUN A's filenames, in RUN A's directory —
      // and nothing else touched. keyframes.jsonl still describes the frames by
      // name, so it is as correct after the swap as before it.
      for (let col = 1; col <= 6; col += 1) {
        await Deno.copyFile(`${realDir}/st2-col${col}.jpg`, `${dir}/kf-${String(col + 5).padStart(5, '0')}.jpg`)
      }

      const after = await readStationCoverage(dir)
      assertEquals(after.movement.status, 'measured')
      assertEquals(
        after.movement.pairs[0].verdict,
        'moved',
        `the photos on disk are RUN B's and measure as moved; got ${JSON.stringify(after.movement.pairs[0])}`,
      )
      assert(
        after.movement.pairs[0].differenceLevels !== before.movement.pairs[0].differenceLevels,
        'a changed capture must produce a changed measurement, not the previous one',
      )
      // And the capture is no longer accused of standing still.
      assertEquals(
        assessStationCoverage(after).warnings.some(w => w.includes('almost the same view')),
        false,
      )
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})
