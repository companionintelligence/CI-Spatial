/**
 * Deno unit tests for the known-distance calibration tier.
 *
 * This tier hands a metric scale to a capture that has no AR poses to check it
 * against, which means it has the same invisible failure mode splat_align's
 * Umeyama fit has and one more besides: a wrong size renders identically to a
 * right one, and there is no second description of the camera path to catch it.
 * So these tests assert the arithmetic directly, and — the part that actually
 * settles it — against a real solved capture whose true camera positions are
 * known.
 *
 * The real one is `scans/sessions/sess-video-20260830-163024`: a five-station
 * capture of a synthetic room, 36/36 frames registered, rendered from these
 * exact camera positions in metres (Y up):
 *
 *   S1 [1.2,1.5,1.0]  S2 [4.6,1.5,1.2]  S3 [4.8,1.5,3.4]
 *   S4 [1.4,1.5,3.2]  S5 [3.0,1.5,2.2]
 *
 * Feeding the tier only the S1→S2 distance (3.405877 m) and then checking the
 * nine distances it was never told is the whole point: those are predictions,
 * not fits. `scans/` is gitignored, so that test declares itself ignored rather
 * than silently passing when the session is not on the box.
 *
 * The synthetic tests below cover what the real one cannot reach on demand —
 * the refusals — and pin the two matrix conventions against each other, since a
 * transposed affine 4x4 is the one error that produces a plausible wrong answer
 * instead of an exception.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  columnMajorScaleAbout,
  MIN_FRAMES_PER_VIEWPOINT,
  readSolveGravity,
  solveKnownDistanceFrame,
  viewpointsFromKeyframes,
} from '../../../server/capture/known_distance.ts'
import {
  applyColumnMajor,
  runSplatAlign,
  transpose4,
  umeyamaSimilarity,
  type Vec3Tuple,
} from '../../../server/splat/splat_align.ts'
import { readKeyframes, readSolvedPoses } from '../../../server/splat/splat_train_dataset.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Apply a **row-major** 4x4 — `SplatAlignManifest.projectTransform`'s convention. */
function applyRowMajor(m: number[], p: Vec3Tuple): Vec3Tuple {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ]
}

function dist(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function centreMap(entries: Array<[string, Vec3Tuple]>): Map<string, Vec3Tuple> {
  return new Map(entries)
}

/**
 * A minimal session the driver can read: station-labelled keyframes plus a
 * solved pose file. `cameraToWorld` holds an OpenCV WORLD-TO-CAMERA [R|t]
 * despite the key (see `openCvW2cToC2w`), so with R = I the centre is −t.
 */
async function writeStationSession(
  sessionDir: string,
  frames: Array<{ file: string; station: number | string | null; solved: Vec3Tuple }>,
  opts: { gravityAligned?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(sessionDir, { recursive: true })
  const jsonl = frames
    .map((f, i) => {
      const record: Record<string, unknown> = { index: i, file: f.file }
      if (f.station !== null) record.station = f.station
      return JSON.stringify(record)
    })
    .join('\n')
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, jsonl + '\n')
  await Deno.writeTextFile(
    `${sessionDir}/colmap.poses.json`,
    JSON.stringify({
      tool: 'colmap',
      frames: frames.map((f) => ({
        file: f.file,
        cameraToWorld: [
          [1, 0, 0, -f.solved[0]],
          [0, 1, 0, -f.solved[1]],
          [0, 0, 1, -f.solved[2]],
        ],
      })),
    }),
  )
  if (opts.gravityAligned !== undefined) {
    await Deno.writeTextFile(
      `${sessionDir}/colmap-poses.manifest.json`,
      JSON.stringify({ schemaVersion: 1, tool: 'colmap', status: 'ok', createdAt: '2026-08-30T00:00:00.000Z', gravityAligned: opts.gravityAligned }),
    )
  }
}

/** Two spots four solver units apart, four frames each, with a known scatter. */
function twoSpotCentres(scatter: number): { centres: Map<string, Vec3Tuple>; viewpoints: Array<{ id: string; files: string[] }> } {
  const entries: Array<[string, Vec3Tuple]> = []
  const viewpoints: Array<{ id: string; files: string[] }> = []
  const anchors: Vec3Tuple[] = [[0, 0, 0], [4, 0, 0]]
  anchors.forEach((anchor, s) => {
    const files: string[] = []
    // Four frames on the ±x/±z corners of a square of half-diagonal `scatter`,
    // so every frame is exactly `scatter` from the centroid and the RMS is too.
    const offsets: Vec3Tuple[] = [[scatter, 0, 0], [-scatter, 0, 0], [0, 0, scatter], [0, 0, -scatter]]
    offsets.forEach((o, i) => {
      const file = `kf-s${s}-${i}.jpg`
      files.push(file)
      entries.push([file, [anchor[0] + o[0], anchor[1] + o[1], anchor[2] + o[2]]])
    })
    viewpoints.push({ id: `station-${s}`, files })
  })
  return { centres: centreMap(entries), viewpoints }
}

// ─── Grouping ────────────────────────────────────────────────────────────────

Deno.test('viewpointsFromKeyframes groups by station and refuses to invent one', () => {
  const groups = viewpointsFromKeyframes([
    { index: 0, file: 'a.jpg', ...{ station: 1 } },
    { index: 1, file: 'b.jpg', ...{ station: 0 } },
    { index: 2, file: 'c.jpg', ...{ station: 1 } },
    // A float, a string, a negative and an absent field are all "the capture
    // tool wrote something else there" — coercing any of them would conjure a
    // spot out of a bug, so each is dropped.
    { index: 3, file: 'd.jpg', ...{ station: 1.5 } },
    { index: 4, file: 'e.jpg', ...{ station: '2' } },
    { index: 5, file: 'f.jpg', ...{ station: -1 } },
    { index: 6, file: 'g.jpg' },
  ])
  assertEquals(groups.map((g) => g.id), ['station-0', 'station-1'])
  assertEquals(groups[0].files, ['b.jpg'])
  assertEquals(groups[1].files, ['a.jpg', 'c.jpg'])
})

Deno.test('viewpointsFromKeyframes finds nothing in a walkthrough capture', () => {
  assertEquals(viewpointsFromKeyframes([{ index: 0, file: 'a.jpg' }, { index: 1, file: 'b.jpg' }]), [])
})

// ─── The frame ───────────────────────────────────────────────────────────────

Deno.test('one measured distance fixes the scale exactly and stays provisional', () => {
  const { centres, viewpoints } = twoSpotCentres(0.01)
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    measurements: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    gravityAligned: true,
  })
  assert(r.ok, r.ok ? '' : r.reason)
  // 2 m across 4 solver units.
  assert(Math.abs(r.scale - 0.5) < 1e-12, `scale ${r.scale}`)
  assertEquals(r.calibration.status, 'provisional')
  assertEquals(r.calibration.method, 'known-distance')
  assertEquals(r.calibration.gravityAligned, true)
  assertEquals(r.measurementCount, 1)
  assertEquals(r.frameCount, 8)
  // With one distance the cross-check would be 0 by construction, so the
  // published residual is the one thing actually measured: every frame sits
  // 0.01 solver units from its spot's centre, i.e. 0.005 m at this scale.
  assertEquals(r.residualSource, 'viewpoint-scatter')
  assert(Math.abs(r.residualM - 0.005) < 1e-12, `residual ${r.residualM}`)
  assert(Math.abs(r.viewpointScatterM - 0.005) < 1e-12)
})

Deno.test('a second agreeing distance is what reaches verified', () => {
  const centres = centreMap([
    ['a1', [0, 0, 0]], ['a2', [0, 0, 0]],
    ['b1', [4, 0, 0]], ['b2', [4, 0, 0]],
    ['c1', [4, 0, 3]], ['c2', [4, 0, 3]],
  ])
  const viewpoints = [
    { id: 'station-0', files: ['a1', 'a2'] },
    { id: 'station-1', files: ['b1', 'b2'] },
    { id: 'station-2', files: ['c1', 'c2'] },
  ]
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    // 4 and 3 solver units; at 0.5 m per unit that is 2 m and 1.5 m.
    measurements: [
      { from: 'station-0', to: 'station-1', metres: 2 },
      { from: 'station-1', to: 'station-2', metres: 1.5 },
    ],
    gravityAligned: true,
  })
  assert(r.ok, r.ok ? '' : r.reason)
  assert(Math.abs(r.scale - 0.5) < 1e-12, `scale ${r.scale}`)
  assertEquals(r.calibration.status, 'verified')
  assertEquals(r.residualSource, 'known-distance-cross-check')
  assert(r.residualM < 1e-12, `an exactly consistent pair must cross-check to 0, got ${r.residualM}`)
})

Deno.test('the same distance written twice is not a second measurement', () => {
  const centres = centreMap([
    ['a1', [0, 0, 0]], ['a2', [0, 0, 0]],
    ['b1', [4, 0, 0]], ['b2', [4, 0, 0]],
  ])
  const viewpoints = [
    { id: 'station-0', files: ['a1', 'a2'] },
    { id: 'station-1', files: ['b1', 'b2'] },
  ]
  // Once each way round — what a two-field form produces when the operator
  // enters the same tape reading twice. It is one constraint, and the
  // least-squares scale fits it exactly, so the cross-check would be 0 by
  // construction: the same zero the single-distance case refuses to publish.
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    measurements: [
      { from: 'station-0', to: 'station-1', metres: 2 },
      { from: 'station-1', to: 'station-0', metres: 2 },
    ],
    gravityAligned: true,
  })
  assert(r.ok, r.ok ? '' : r.reason)
  assertEquals(r.calibration.status, 'provisional')
  assertEquals(r.residualSource, 'viewpoint-scatter')
})

Deno.test('two readings of one pair that disagree are still refused, not averaged', () => {
  const centres = centreMap([
    ['a1', [0, 0, 0]], ['a2', [0, 0, 0]],
    ['b1', [4, 0, 0]], ['b2', [4, 0, 0]],
  ])
  // Not redundancy worth calling verified, but still a contradiction: a scale
  // that splits the difference matches neither reading.
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints: [{ id: 'station-0', files: ['a1', 'a2'] }, { id: 'station-1', files: ['b1', 'b2'] }],
    measurements: [
      { from: 'station-0', to: 'station-1', metres: 2 },
      { from: 'station-0', to: 'station-1', metres: 2.5 },
    ],
    gravityAligned: true,
  })
  assert(!r.ok, 'two contradictory readings of one pair must not produce a frame')
  assert(r.ok === false && r.reason.includes('disagree'), r.ok === false ? r.reason : '')
})

Deno.test('measured distances that disagree are refused, not averaged', () => {
  const centres = centreMap([
    ['a1', [0, 0, 0]], ['a2', [0, 0, 0]],
    ['b1', [4, 0, 0]], ['b2', [4, 0, 0]],
    ['c1', [4, 0, 3]], ['c2', [4, 0, 3]],
  ])
  const viewpoints = [
    { id: 'station-0', files: ['a1', 'a2'] },
    { id: 'station-1', files: ['b1', 'b2'] },
    { id: 'station-2', files: ['c1', 'c2'] },
  ]
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    // The second reading is a metre out. A least-squares scale would split the
    // difference and publish a size that matches neither.
    measurements: [
      { from: 'station-0', to: 'station-1', metres: 2 },
      { from: 'station-1', to: 'station-2', metres: 2.5 },
    ],
    gravityAligned: true,
  })
  assert(!r.ok, 'inconsistent measurements must not produce a frame')
  assert(r.ok === false && r.reason.includes('disagree'), r.ok === false ? r.reason : '')
})

Deno.test('frames that were not all shot from one spot are refused', () => {
  // Half a metre of scatter at a scale of 0.5 m/unit is a quarter-metre spread
  // around a spot the operator says is a tripod position: the grouping is wrong.
  const { centres, viewpoints } = twoSpotCentres(0.5)
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    measurements: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    gravityAligned: true,
  })
  assert(!r.ok, 'a scattered viewpoint must not produce a frame')
  assert(r.ok === false && r.reason.includes('land'), r.ok === false ? r.reason : '')
})

Deno.test('a viewpoint with too few solved frames has nothing to check it', () => {
  const centres = centreMap([['a1', [0, 0, 0]], ['b1', [4, 0, 0]], ['b2', [4, 0, 0]]])
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints: [{ id: 'station-0', files: ['a1'] }, { id: 'station-1', files: ['b1', 'b2'] }],
    measurements: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    gravityAligned: true,
  })
  assert(!r.ok, 'a single-frame viewpoint must be refused')
  assert(r.ok === false && r.reason.includes(`${MIN_FRAMES_PER_VIEWPOINT} are needed`), r.ok === false ? r.reason : '')
})

Deno.test('two spots the solve put in the same place cannot size anything', () => {
  const centres = centreMap([['a1', [1, 2, 3]], ['a2', [1, 2, 3]], ['b1', [1, 2, 3]], ['b2', [1, 2, 3]]])
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints: [{ id: 'station-0', files: ['a1', 'a2'] }, { id: 'station-1', files: ['b1', 'b2'] }],
    measurements: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    gravityAligned: true,
  })
  assert(!r.ok, 'a zero baseline must be refused rather than dividing by it')
  assert(r.ok === false && r.reason.includes('same place'), r.ok === false ? r.reason : '')
})

Deno.test('a measurement naming a spot the capture never placed is refused', () => {
  const { centres, viewpoints } = twoSpotCentres(0)
  const r = solveKnownDistanceFrame({
    centres,
    viewpoints,
    measurements: [{ from: 'station-0', to: 'station-9', metres: 2 }],
    gravityAligned: true,
  })
  assert(!r.ok)
  assert(r.ok === false && r.reason.includes('the spot labelled 9'), r.ok === false ? r.reason : '')
})

// ─── The two matrix conventions ──────────────────────────────────────────────

Deno.test('the calibration matrix is column-major and the manifest one is its transpose', () => {
  const scale = 0.25
  const anchor: Vec3Tuple = [4, 8, 16]
  const col = columnMajorScaleAbout(scale, anchor)
  // Column-major: translation at 12/13/14, which is where composeYUpTransform
  // writes it. Reading these off 3/7/11 instead is the silent misread.
  assertEquals([col[12], col[13], col[14]], [-1, -2, -4])
  assertEquals([col[3], col[7], col[11]], [0, 0, 0])

  const row = transpose4(col)
  assertEquals([row[3], row[7], row[11]], [-1, -2, -4])
  assertEquals([row[12], row[13], row[14]], [0, 0, 0])

  // Each convention applied with its own indexing must land on the same point,
  // and the anchor must land on the origin — that is what "anchored at the
  // first measured spot" means.
  const p: Vec3Tuple = [1, -2, 3]
  assertEquals(applyColumnMajor(col, p), applyRowMajor(row, p))
  assertEquals(applyColumnMajor(col, anchor), [0, 0, 0])
})

// ─── The driver ──────────────────────────────────────────────────────────────

Deno.test('runSplatAlign takes the known-distance tier and publishes what it determined', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-known-distance-ok`
  await writeStationSession(sessionDir, [
    { file: 'kf-00000.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00001.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00002.jpg', station: 1, solved: [4, 0, 0] },
    { file: 'kf-00003.jpg', station: 1, solved: [4, 0, 0] },
  ], { gravityAligned: true })

  try {
    const r = await runSplatAlign({
      sessionDir,
      knownDistances: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    })
    assertEquals(r.status, 'ok', r.manifest.skippedReason ?? r.manifest.error ?? '')
    assertEquals(r.manifest.tool, 'known-distance')
    assert(Math.abs(r.scale! - 0.5) < 1e-12, `scale ${r.scale}`)
    assertEquals(r.manifest.calibrationMethod, 'known-distance+solver-gravity')
    assertEquals(r.manifest.knownDistance, { measuredM: 2, solvedSeparation: 4, measurementCount: 1 })
    // The four booleans that keep this from being read as a placement.
    assertEquals(r.manifest.determined, { scale: true, up: true, heading: false, origin: false })
    assertEquals(r.calibration?.method, 'known-distance')
    assertEquals(r.calibration?.status, 'provisional')

    const written = JSON.parse(await Deno.readTextFile(`${sessionDir}/splat-align.manifest.json`))
    assertEquals(written.tool, 'known-distance')
    assertEquals(written.residualSource, 'viewpoint-scatter')
    // The gates the viewer and memory_push re-check on their own side must be
    // present and satisfied, or a fit that passed here is dropped there.
    assertEquals(written.params.minCorrespondences, 4)
    assertEquals(written.correspondenceCount, 4)
    assert(written.residualM <= written.params.maxResidualM)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('an unknown vertical is recorded as unknown, not assumed upright', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-known-distance-nogravity`
  // No colmap-poses.manifest.json at all: the LingBot-only case, where nothing
  // ever established which way is up.
  await writeStationSession(sessionDir, [
    { file: 'kf-00000.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00001.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00002.jpg', station: 1, solved: [4, 0, 0] },
    { file: 'kf-00003.jpg', station: 1, solved: [4, 0, 0] },
  ])
  try {
    assertEquals(await readSolveGravity(sessionDir), false)
    const r = await runSplatAlign({
      sessionDir,
      knownDistances: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    })
    assertEquals(r.status, 'ok', r.manifest.skippedReason ?? '')
    assertEquals(r.manifest.determined, { scale: true, up: false, heading: false, origin: false })
    assertEquals(r.manifest.calibrationMethod, 'known-distance')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a walkthrough capture is told what is unsupported, not half-sized', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-known-distance-walk`
  await writeStationSession(sessionDir, [
    { file: 'kf-00000.jpg', station: null, solved: [0, 0, 0] },
    { file: 'kf-00001.jpg', station: null, solved: [1, 0, 0] },
    { file: 'kf-00002.jpg', station: null, solved: [2, 0, 0] },
    { file: 'kf-00003.jpg', station: null, solved: [3, 0, 0] },
  ], { gravityAligned: true })
  try {
    const r = await runSplatAlign({
      sessionDir,
      knownDistances: [{ from: 'station-0', to: 'station-1', metres: 2 }],
    })
    assertEquals(r.status, 'skipped')
    assertEquals(r.scale, undefined, 'a skipped run must not publish a size')
    assert(r.manifest.skippedReason!.includes('which spot each frame was taken from'), r.manifest.skippedReason)
    assert(r.manifest.remediation!.length > 0)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a stored known-distance frame never falls through to the camera-path fit', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-known-distance-stored`
  await writeStationSession(sessionDir, [
    { file: 'kf-00000.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00001.jpg', station: 0, solved: [0, 0, 0] },
    { file: 'kf-00002.jpg', station: 1, solved: [4, 0, 0] },
    { file: 'kf-00003.jpg', station: 1, solved: [4, 0, 0] },
  ], { gravityAligned: true })
  const stored: ScanCalibration = {
    method: 'known-distance',
    sessionToProject: columnMajorScaleAbout(0.5, [0, 0, 0]),
    calibratedAt: '2026-08-30T00:00:00.000Z',
    status: 'provisional',
    separationM: 2,
    residualM: 0,
    toleranceM: 0.15,
    gravityAligned: true,
  }
  try {
    // Its sessionToProject carries solve coordinates, not AR-session ones, so
    // handing it to the fit would produce a confident wrong answer rather than
    // an error. It must skip and ask for the measurement instead.
    const r = await runSplatAlign({ sessionDir, calibration: stored })
    assertEquals(r.status, 'skipped')
    assertEquals(r.manifest.tool, 'known-distance')
    assertEquals(r.scale, undefined)
    assert(r.manifest.skippedReason!.includes('measured real-world distance'), r.manifest.skippedReason)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

// ─── Against the real five-station solve ─────────────────────────────────────

/**
 * The camera positions the fixture room was rendered from, in metres, Y up, in
 * station order. Ground truth: not measured from the reconstruction, known
 * before it existed.
 */
const TRUE_STATIONS: Vec3Tuple[] = [
  [1.2, 1.5, 1.0],
  [4.6, 1.5, 1.2],
  [4.8, 1.5, 3.4],
  [1.4, 1.5, 3.2],
  [3.0, 1.5, 2.2],
]

const FIXTURE_SESSION = 'scans/sessions/sess-video-20260830-163024'
const fixturePresent = await (async () => {
  try {
    await Deno.stat(`${FIXTURE_SESSION}/colmap.poses.json`)
    return true
  } catch {
    return false
  }
})()

/**
 * Rebuild the fixture as a station capture in a temp dir.
 *
 * The session on disk was ingested as a video, so its keyframes carry a
 * timestamp and no `station`. The five stations are uniform in time and the
 * mapping is stated in the capture's own provenance, so the label is derived
 * here — in the test, where a fixture property belongs — rather than in the
 * module, which must never guess which frames shared a spot.
 */
async function stagedStationCapture(root: string): Promise<string> {
  const sessionDir = `${root}/sess-known-distance-real`
  await Deno.mkdir(sessionDir, { recursive: true })
  const records = await readKeyframes(FIXTURE_SESSION)
  const maxT = Math.max(...records.map((r) => r.timestamp ?? 0))
  const jsonl = records
    .map((r) =>
      JSON.stringify({
        ...r,
        station: Math.min(TRUE_STATIONS.length - 1, Math.floor(((r.timestamp ?? 0) / maxT) * TRUE_STATIONS.length)),
      })
    )
    .join('\n')
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, jsonl + '\n')
  await Deno.copyFile(`${FIXTURE_SESSION}/colmap.poses.json`, `${sessionDir}/colmap.poses.json`)
  await Deno.copyFile(`${FIXTURE_SESSION}/colmap-poses.manifest.json`, `${sessionDir}/colmap-poses.manifest.json`)
  return sessionDir
}

/** Station centroids of the solved camera centres, in whatever frame `apply` maps into. */
async function stationCentroids(sessionDir: string, apply: (p: Vec3Tuple) => Vec3Tuple): Promise<Vec3Tuple[]> {
  const solved = (await readSolvedPoses(sessionDir))!
  const records = await readKeyframes(sessionDir)
  const sums = TRUE_STATIONS.map(() => [0, 0, 0, 0])
  for (const rec of records) {
    const m = solved.get(rec.file!)
    if (!m) continue
    const s = (rec as Record<string, unknown>)['station'] as number
    const p = apply([m[0][3], m[1][3], m[2][3]])
    sums[s][0] += p[0]
    sums[s][1] += p[1]
    sums[s][2] += p[2]
    sums[s][3] += 1
  }
  return sums.map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3]] as Vec3Tuple)
}

Deno.test({
  name: 'one measured distance sizes the real five-station capture, and predicts the nine it was never told',
  ignore: !fixturePresent,
  fn: async () => {
    const root = await Deno.makeTempDir()
    try {
      const sessionDir = await stagedStationCapture(root)
      const measuredM = dist(TRUE_STATIONS[0], TRUE_STATIONS[1]) // 3.405877 m

      const r = await runSplatAlign({
        sessionDir,
        knownDistances: [{ from: 'station-0', to: 'station-1', metres: measuredM }],
      })
      assertEquals(r.status, 'ok', r.manifest.skippedReason ?? r.manifest.error ?? '')
      assertEquals(r.manifest.tool, 'known-distance')
      // The 9 + 8 frames at the two spots the tape spanned — not all 36. The
      // count is the evidence behind the claim, and frames at spots nobody
      // measured between are not evidence for this size.
      assertEquals(r.correspondenceCount, 17)
      // The solve carried a gravity direction, so up is inherited rather than
      // guessed — and heading and origin are still declared undetermined.
      assertEquals(r.manifest.determined, { scale: true, up: true, heading: false, origin: false })

      // The independently measured figure for this session is 0.4798 m per
      // solver unit (a Umeyama fit of all 36 solved centres onto the true
      // station positions). One distance has to land on it.
      assert(Math.abs(r.scale! - 0.4798) < 1e-3, `scale ${r.scale} vs the measured 0.4798`)

      // Nine of these ten distances are predictions: the tier was told S1→S2
      // and nothing else. This is the assertion that would catch a wrong size.
      const centroids = await stationCentroids(sessionDir, (p) => applyRowMajor(r.projectTransform!, p))
      let worst = 0
      let sumSq = 0
      let pairs = 0
      for (let i = 0; i < TRUE_STATIONS.length; i++) {
        for (let j = i + 1; j < TRUE_STATIONS.length; j++) {
          const err = Math.abs(dist(centroids[i], centroids[j]) - dist(TRUE_STATIONS[i], TRUE_STATIONS[j]))
          worst = Math.max(worst, err)
          sumSq += err * err
          pairs += 1
        }
      }
      const rms = Math.sqrt(sumSq / pairs)
      assert(worst < 0.005, `worst inter-station distance error ${worst.toFixed(5)}m over ${pairs} pairs`)
      assert(rms < 0.002, `RMS inter-station distance error ${rms.toFixed(6)}m`)

      // And the shape itself. Heading and origin are free by design, so remove
      // them with a rigid fit onto truth and check what is left: the leftover
      // scale must be 1 (the tier already got the size right) and the residual
      // must be a few millimetres.
      const leftover = umeyamaSimilarity(centroids, TRUE_STATIONS)
      assert(Math.abs(leftover.scale - 1) < 1e-3, `leftover scale ${leftover.scale} — the published size is off by that factor`)
      assert(leftover.residualM < 0.005, `station RMSE against truth ${leftover.residualM.toFixed(6)}m`)

      // Published residual is the scatter of frames about their own spot, in
      // metres — a real measurement, and the only one one distance can offer.
      assertEquals(r.manifest.residualSource, 'viewpoint-scatter')
      assert(r.residualM! > 0, 'a real capture has non-zero scatter; a zero here means nothing was measured')
      assert(r.residualM! < 0.01, `viewpoint scatter ${r.residualM}m`)
      assertEquals(r.calibration?.status, 'provisional')
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'a second real distance cross-checks the first and reaches verified',
  ignore: !fixturePresent,
  fn: async () => {
    const root = await Deno.makeTempDir()
    try {
      const sessionDir = await stagedStationCapture(root)
      const r = await runSplatAlign({
        sessionDir,
        knownDistances: [
          { from: 'station-0', to: 'station-1', metres: dist(TRUE_STATIONS[0], TRUE_STATIONS[1]) },
          { from: 'station-2', to: 'station-3', metres: dist(TRUE_STATIONS[2], TRUE_STATIONS[3]) },
        ],
      })
      assertEquals(r.status, 'ok', r.manifest.skippedReason ?? '')
      assertEquals(r.manifest.residualSource, 'known-distance-cross-check')
      assertEquals(r.calibration?.status, 'verified')
      assertEquals(r.manifest.knownDistance?.measurementCount, 2)
      // Two real tape readings against one real solve: the disagreement is a
      // measurement, and it is sub-millimetre on this capture.
      assert(r.residualM! < 0.001, `cross-check residual ${r.residualM}m`)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'a wrong tape reading moves the size by exactly that factor — nothing here catches it',
  ignore: !fixturePresent,
  fn: async () => {
    const root = await Deno.makeTempDir()
    try {
      const sessionDir = await stagedStationCapture(root)
      const truthM = dist(TRUE_STATIONS[0], TRUE_STATIONS[1])
      const r = await runSplatAlign({
        sessionDir,
        // Metres read off a tape as feet: the classic operator error.
        knownDistances: [{ from: 'station-0', to: 'station-1', metres: truthM * 3.28084 }],
      })
      // It succeeds, and it is wrong by 3.28x. This is not a defect in the
      // tier — one distance is the only evidence there is, and no arithmetic
      // can audit its own single input. It is asserted so the claim
      // `status: 'provisional'` makes stays honest and stays tested: a single
      // reading is never `'verified'`, precisely because of this case.
      assertEquals(r.status, 'ok')
      assertEquals(r.calibration?.status, 'provisional')
      assert(Math.abs(r.scale! / 0.4798 - 3.28084) < 0.01, `scale ${r.scale} should be 3.28x the true 0.4798`)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
