/**
 * The transport seam: does a station index and a tape reading survive the trip
 * from the capture to the job that uses them?
 *
 * The tier itself is exercised in known_distance.test.ts, against the real
 * five-station solve. This file covers the part that made all of that
 * unreachable in the running app: the station label dying inside the photo
 * ingest, and a measurement having nowhere to live between the room and the
 * alignment job. Both are pure functions over a session directory, so they are
 * tested the same way — build a session on disk, run the thing, read it back.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import {
  applyStationLabels,
  assessStationCoverage,
  readStationCoverage,
  summarizeStationCoverage,
} from '../../../server/capture/station_dome.ts'
import {
  KNOWN_DISTANCES_FIELD,
  parseDistanceMeasurements,
  readKnownDistances,
  viewpointsFromKeyframes,
  writeKnownDistances,
} from '../../../server/capture/known_distance.ts'
import { readKeyframes } from '../../../server/splat/splat_train_dataset.ts'

async function withSession(
  fn: (dir: string) => Promise<void>,
  seed?: { keyframes?: string; session?: Record<string, unknown> },
): Promise<void> {
  const root = await Deno.makeTempDir()
  const dir = `${root}/sess-station-test`
  await Deno.mkdir(dir, { recursive: true })
  if (seed?.keyframes !== undefined) await Deno.writeTextFile(`${dir}/keyframes.jsonl`, seed.keyframes)
  await Deno.writeTextFile(
    `${dir}/session.json`,
    JSON.stringify(seed?.session ?? { sessionId: 'sess-station-test' }, null, 2),
  )
  try {
    await fn(dir)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

/** What `scripts/ingest-photos.mjs` writes: renamed, re-ordered, blur-dropped. */
const INGESTED = [
  { index: 0, file: 'kf-00000.jpg', timestamp: 0, sourcePhoto: '0002-c.jpg' },
  { index: 1, file: 'kf-00001.jpg', timestamp: 0.5, sourcePhoto: '0000-a.jpg' },
  { index: 2, file: 'kf-00002.jpg', timestamp: 1, sourcePhoto: '0003-d.jpg' },
].map((r) => JSON.stringify(r)).join('\n') + '\n'

// ─── Station labels across the photo ingest ─────────────────────────────────

Deno.test('station labels follow the photo, not its position in the upload', async () => {
  await withSession(async (dir) => {
    // The upload order was a, b, c, d at spots 0, 0, 1, 1. `b` was dropped as
    // blurry and the rest came back in EXIF order — so matching by position
    // would put kf-00000 (which is `c`, spot 1) at spot 0.
    const result = await applyStationLabels(
      dir,
      new Map([['0000-a.jpg', 0], ['0001-b.jpg', 0], ['0002-c.jpg', 1], ['0003-d.jpg', 1]]),
    )
    assertEquals(result, { labelled: 3, unlabelled: 0 })

    const records = await readKeyframes(dir)
    assertEquals(
      records.map((r) => [r.file, (r as Record<string, unknown>)['station']]),
      [['kf-00000.jpg', 1], ['kf-00001.jpg', 0], ['kf-00002.jpg', 1]],
    )
    // Everything the ingest wrote is still there.
    assertEquals((records[0] as Record<string, unknown>)['timestamp'], 0)
    assertEquals((records[0] as Record<string, unknown>)['sourcePhoto'], '0002-c.jpg')
  }, { keyframes: INGESTED })
})

Deno.test('a labelled ingest is what viewpointsFromKeyframes can group — the seam that was broken', async () => {
  await withSession(async (dir) => {
    // Before: the frames are on disk and the tier has nothing to attach a
    // distance to. This is exactly the state the app shipped in.
    assertEquals(viewpointsFromKeyframes(await readKeyframes(dir)), [])

    await applyStationLabels(dir, new Map([['0000-a.jpg', 0], ['0002-c.jpg', 1], ['0003-d.jpg', 1]]))

    assertEquals(viewpointsFromKeyframes(await readKeyframes(dir)), [
      { id: 'station-0', files: ['kf-00001.jpg'] },
      { id: 'station-1', files: ['kf-00000.jpg', 'kf-00002.jpg'] },
    ])
  }, { keyframes: INGESTED })
})

Deno.test('a frame the ingest dropped is counted, not invented', async () => {
  await withSession(async (dir) => {
    const result = await applyStationLabels(dir, new Map([['0000-a.jpg', 0]]))
    assertEquals(result, { labelled: 1, unlabelled: 2 })
    const stations = (await readKeyframes(dir)).map((r) => (r as Record<string, unknown>)['station'])
    assertEquals(stations, [undefined, 0, undefined])
  }, { keyframes: INGESTED })
})

Deno.test('an unreadable keyframe line survives labelling untouched', async () => {
  const damaged = `${JSON.stringify({ index: 0, file: 'kf-00000.jpg', sourcePhoto: '0000-a.jpg' })}\nnot json\n`
  await withSession(async (dir) => {
    await applyStationLabels(dir, new Map([['0000-a.jpg', 3]]))
    const raw = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
    assert(raw.includes('not json'), 'the unreadable line was destroyed')
    assertEquals(summarizeStationCoverage(raw).malformedLines, 1)
    assertEquals(summarizeStationCoverage(raw).stations, [{ station: 3, frameCount: 1, panSpreadDeg: null }])
  }, { keyframes: damaged })
})

// ─── The gate, reached the way an app capture reaches it ────────────────────

Deno.test('one spot is refused however many photos it holds', async () => {
  await withSession(async (dir) => {
    await applyStationLabels(dir, new Map([['0000-a.jpg', 0], ['0002-c.jpg', 0], ['0003-d.jpg', 0]]))
    const assessment = assessStationCoverage(await readStationCoverage(dir))
    assertEquals(assessment.ok, false)
    assertEquals(assessment.verdict, 'single-station')
    assert(assessment.remediation, 'a refusal with nothing to do about it is not a refusal')
  }, { keyframes: INGESTED })
})

Deno.test('photos that never carried a spot number are refused as unlabelled, not silently reconstructed', async () => {
  await withSession(async (dir) => {
    await applyStationLabels(dir, new Map())
    const assessment = assessStationCoverage(await readStationCoverage(dir))
    assertEquals(assessment.ok, false)
    assertEquals(assessment.verdict, 'unlabelled')
  }, { keyframes: INGESTED })
})

// ─── Measurements: validation ───────────────────────────────────────────────

Deno.test('an unmeasured capture parses as measured-by-nothing, not as an error', () => {
  assertEquals(parseDistanceMeasurements(undefined), { ok: true, measurements: [] })
  assertEquals(parseDistanceMeasurements(null), { ok: true, measurements: [] })
  assertEquals(parseDistanceMeasurements([]), { ok: true, measurements: [] })
})

Deno.test('a measurement that would size a capture wrongly is refused at the door', () => {
  const cases: unknown[] = [
    'station-0 to station-1 is 3.4m',
    [{ from: 'station-0', to: 'station-1', metres: '3.4' }],
    [{ from: 'station-0', to: 'station-1' }],
    [{ from: 'station-0', to: 'station-0', metres: 3.4 }],
    [{ from: 'station-0', to: 'station-1', metres: 0 }],
    [{ from: 'station-0', to: 'station-1', metres: -3.4 }],
    [{ from: 'station-0', to: 'station-1', metres: Number.NaN }],
    [{ from: '', to: 'station-1', metres: 3.4 }],
    [null],
  ]
  for (const raw of cases) {
    const parsed = parseDistanceMeasurements(raw)
    assertEquals(parsed.ok, false, `accepted ${JSON.stringify(raw)}`)
    assert(!parsed.ok && parsed.error.length > 0)
  }
})

Deno.test('a well-formed measurement keeps exactly its three fields', () => {
  const parsed = parseDistanceMeasurements([
    { from: 'station-0', to: 'station-1', metres: 3.405877, note: 'along the wall' },
  ])
  assert(parsed.ok)
  assertEquals(parsed.measurements, [{ from: 'station-0', to: 'station-1', metres: 3.405877 }])
})

// ─── Measurements: persistence ──────────────────────────────────────────────

Deno.test('a measurement recorded against a session is what the job reads back', async () => {
  await withSession(async (dir) => {
    assertEquals(await readKnownDistances(dir), [])
    await writeKnownDistances(dir, [{ from: 'station-0', to: 'station-1', metres: 3.405877 }])
    assertEquals(await readKnownDistances(dir), [{ from: 'station-0', to: 'station-1', metres: 3.405877 }])

    // The rest of the session record is untouched, which is what lets the
    // finalization routes keep rewriting it as `{...record, ...}`.
    const record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`))
    assertEquals(record.sessionId, 'sess-station-test')
    assertEquals(record.source, 'station-dome')
  }, { session: { sessionId: 'sess-station-test', source: 'station-dome' } })
})

Deno.test('re-measuring replaces the reading rather than adding a second one', async () => {
  await withSession(async (dir) => {
    await writeKnownDistances(dir, [{ from: 'station-0', to: 'station-1', metres: 3.4 }])
    await writeKnownDistances(dir, [{ from: 'station-0', to: 'station-1', metres: 3.405877 }])
    assertEquals(await readKnownDistances(dir), [{ from: 'station-0', to: 'station-1', metres: 3.405877 }])
  })
})

Deno.test('a stored measurement that is not a measurement reads as none', async () => {
  await withSession(async (dir) => {
    // A skip with the tier's own remediation is a better thing to put in front
    // of an operator than a parse error from a file they have never seen.
    assertEquals(await readKnownDistances(dir), [])
  }, { session: { sessionId: 'sess-station-test', [KNOWN_DISTANCES_FIELD]: [{ from: 'a', to: 'b' }] } })
})

Deno.test('measuring against a session that does not exist fails rather than writing one', async () => {
  const root = await Deno.makeTempDir()
  try {
    await assertRejects(() => writeKnownDistances(`${root}/nope`, [{ from: 'a', to: 'b', metres: 1 }]))
    assertEquals(await readKnownDistances(`${root}/nope`), [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
