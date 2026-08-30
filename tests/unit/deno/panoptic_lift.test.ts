/**
 * Panoptic-lift driver — the I/O, joining and bookkeeping half.
 *
 * The geometry and confidence policy are tested in
 * tests/unit/node/panoptic_lift.test.ts against the shared module; this file
 * covers what only the driver can get wrong: finding the segments, joining
 * frames to poses by filename, reading the pixel frame from the JPEG rather
 * than the metadata, reading a point cloud through the node hierarchy, and
 * writing a sidecar that says what could NOT be placed as clearly as what
 * could.
 *
 * The cloud arrives through the `_readCloud` seam, the same shape
 * panoptic_scan.ts's `_spawn` and splat_detect.ts's `_results` use, so every
 * path here runs with no GLB, no GPU and no model.
 *
 * Run: deno task test
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import { Document, Primitive } from '@gltf-transform/core'

import {
  collectPointPositions,
  MAX_ALIGN_RESIDUAL_M,
  runPanopticLift,
  type PanopticDetectionsSidecar,
} from '../../../server/panoptic/panoptic_lift.ts'
import { THING_MATCH_RADIUS_M } from '../../../server/thing_match.ts'
import { MIN_CONFIDENCE } from '../../../src/shared/panoptic_lift.ts'

/** 720x960 baseline JPEG header — enough for readJpegDimensions, no pixels. */
const JPEG_720x960 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
  0x03, 0xc0, // height 960
  0x02, 0xd0, // width 720
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])

/** The real lens from sess-a7e2f642: fovYDeg 64.577 over 960 px -> fl_y 759. */
const FOV_Y_DEG = 64.57746889193872
const FL = 960 / (2 * Math.tan((FOV_Y_DEG * Math.PI) / 180 / 2))

/** A slab of `n` points at depth `z` metres straight down -Z from the origin. */
function slab(z: number, n: number, spanM = 0.2): number[] {
  const out: number[] = []
  const side = Math.ceil(Math.sqrt(n))
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / Math.max(1, side - 1) - 0.5
    const gy = Math.floor(i / side) / Math.max(1, side - 1) - 0.5
    const j = ((i * 2654435761) % 1000) / 1000 - 0.5
    out.push(gx * spanM, gy * spanM, -(z + j * 0.04))
  }
  return out
}

interface FrameSpec {
  file: string
  /** Omit for a frame that carries no capture pose. */
  pose?: { position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number; w: number } }
  /** Omit to leave the image off disk. */
  image?: boolean
}

async function makeSession(
  tmp: string,
  frames: FrameSpec[],
  segments: Array<{
    file: string
    label: string
    isThing?: unknown
    score?: number
    areaPx?: number
    centroidPx?: [number, number]
    bboxPx?: unknown
    centroidOnMask?: unknown
  }>,
): Promise<string> {
  const sessionDir = `${tmp}/sess-lift-test`
  await Deno.mkdir(sessionDir, { recursive: true })

  const lines: string[] = []
  for (const [i, f] of frames.entries()) {
    if (f.image !== false) await Deno.writeFile(`${sessionDir}/${f.file}`, JPEG_720x960)
    lines.push(JSON.stringify({
      index: i,
      file: f.file,
      ...(f.pose ? { pose: { position: f.pose.position, rotation: f.pose.rotation ?? { x: 0, y: 0, z: 0, w: 1 } } } : {}),
      intrinsics: { fovYDeg: FOV_Y_DEG, aspect: 0.75, width: 720, height: 960 },
    }))
  }
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')

  const byFile = new Map<string, unknown[]>()
  for (const s of segments) {
    const list = byFile.get(s.file) ?? []
    list.push({
      label: s.label,
      // NOT `?? true`: `null` is exactly what the worker emits with no
      // thing-label list, and it must stay null so splitPanopticSegments
      // applies its unknown-counts-as-stuff rule.
      isThing: s.isThing === undefined ? true : s.isThing,
      score: s.score ?? 0.9,
      areaPx: s.areaPx ?? 20_000,
      centroidPx: s.centroidPx ?? [360, 480],
      // Only written when the case asks for them, so the default fixture is an
      // OLD segments file — which is the back-compat path, exercised by every
      // other test here rather than by one dedicated case.
      ...(s.bboxPx !== undefined ? { bboxPx: s.bboxPx } : {}),
      ...(s.centroidOnMask !== undefined ? { centroidOnMask: s.centroidOnMask } : {}),
    })
    byFile.set(s.file, list)
  }
  await Deno.writeTextFile(
    `${sessionDir}/panoptic.segments.json`,
    JSON.stringify({
      model: 'test',
      frames: [...byFile].map(([file, segs]) => ({ file, segments: segs })),
    }),
  )
  return sessionDir
}

const cloudSeam = (...parts: number[][]) => {
  const flat = parts.flat()
  return () => Promise.resolve({ positions: new Float32Array(flat), count: flat.length / 3 })
}

async function readSidecar(path: string): Promise<PanopticDetectionsSidecar> {
  return JSON.parse(await Deno.readTextFile(path)) as PanopticDetectionsSidecar
}

async function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: 'panoptic-lift-' })
  try {
    await fn(tmp)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
}

// ── preconditions are skips with a remediation, never crashes ───────────────

Deno.test('a session with no segments file is skipped, with the action that fixes it', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = `${tmp}/empty`
    await Deno.mkdir(sessionDir)
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      _readCloud: cloudSeam(slab(2, 40)),
    })
    assertEquals(m.status, 'skipped')
    assertStringIncludes(m.skippedReason ?? '', 'panoptic segments')
    // The contract every optional stage in this repo keeps: a skip names the
    // next action (server/colmap/colmap_poses.ts:132, splat_train.ts:168).
    assertStringIncludes(m.remediation ?? '', 'panoptic-scan')
  })
})

Deno.test('an unreadable point cloud is skipped, not an error', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      _readCloud: () => Promise.resolve(null),
    })
    assertEquals(m.status, 'skipped')
    assertEquals(m.segmentCount, 1)
    assertStringIncludes(m.skippedReason ?? '', 'no point cloud')
    assert((m.remediation ?? '').length > 0)
  })
})

Deno.test('a real but empty cloud is also a skip, and reports pointCount 0', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    const m = await runPanopticLift({ sessionDir, scanGlbPath: `${tmp}/s.glb`, _readCloud: cloudSeam() })
    assertEquals(m.status, 'skipped')
    assertEquals(m.pointCount, 0)
  })
})

Deno.test('a run that found no THINGS is ok with zero counts, not a skip', async () => {
  await withTmp(async (tmp) => {
    // Only stuff. The segmenter ran and this is an answer about the room —
    // distinct from "the segmenter did not run", which is the skip above.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'wall', isThing: false }, { file: 'kf-00000.jpg', label: 'floor', isThing: null }],
    )
    const m = await runPanopticLift({ sessionDir, scanGlbPath: `${tmp}/s.glb`, _readCloud: cloudSeam(slab(2, 40)) })
    assertEquals(m.status, 'ok')
    assertEquals(m.segmentCount, 0)
    assertEquals(m.confidentCount, 0)
    assertEquals(m.undeterminedCount, 0)
  })
})

// ── the three cases the brief names, through the whole driver ───────────────

Deno.test('a segment with a surface behind it lands a position, a confidence and a depth', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair', score: 0.94 }],
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      sessionId: 'sess-x',
      scanId: 'scan-x',
      _readCloud: cloudSeam(slab(2.0, 40)),
    })

    assertEquals(m.status, 'ok')
    assertEquals(m.segmentCount, 1)
    assertEquals(m.confidentCount, 1)
    assertEquals(m.undeterminedCount, 0)
    assertEquals(m.pointCount, 40)
    assert(typeof m.medianConfidence === 'number' && m.medianConfidence >= MIN_CONFIDENCE)

    const sidecar = await readSidecar(detectionsPath)
    assertEquals(sidecar.source, 'panoptic-lift')
    assertEquals(sidecar.scanId, 'scan-x')
    assertEquals(sidecar.detections.length, 1)
    const d = sidecar.detections[0]
    assertEquals(d.label, 'chair')
    assert(d.worldPos, 'expected a world position')
    // The camera is at the origin looking down -Z with the centroid dead
    // centre, so the answer is arithmetic: ~2 m down -Z.
    assert(Math.abs(d.worldPos.z + 2.0) < 0.05, `z was ${d.worldPos.z}`)
    assert(typeof d.confidence === 'number' && d.confidence >= MIN_CONFIDENCE)
    // segScore is the model's certainty about the LABEL; confidence is this
    // stage's certainty about the PLACE. Keeping both is the point.
    assertEquals(d.segScore, 0.94)
    assert(d.confidence !== d.segScore)
    assert(typeof d.depthM === 'number' && Math.abs(d.depthM - 2.0) < 0.05)
    assertEquals(d.reason, undefined)
  })
})

Deno.test('a segment with no usable depth is written with a null position and a reason', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'lamp' }],
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    // A cloud that exists but has nothing in this segment's cone: points well
    // off to the side. This is the ordinary case on a sparse scan.
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40).map((v, i) => (i % 3 === 0 ? v + 9 : v))),
    })

    assertEquals(m.status, 'ok')
    assertEquals(m.confidentCount, 0)
    assertEquals(m.undeterminedCount, 1)
    assertEquals(m.reasons?.['no-geometry'], 1)
    assertEquals(m.medianConfidence, undefined, 'no confident lifts means no median — never a 0')

    const sidecar = await readSidecar(detectionsPath)
    assertEquals(sidecar.detections.length, 1, 'the record exists — it is the audit trail')
    const d = sidecar.detections[0]
    assertEquals(d.label, 'lamp')
    assertEquals(d.worldPos, null)
    assertEquals(d.confidence, null)
    assertEquals(d.reason, 'no-geometry')
    // A null worldPos is what keeps it out of thing_match: detectionsFromMeta
    // (server/main.ts:2860) drops any entry without three finite numbers.
    assert(!('x' in (d.worldPos ?? {})))
  })
})

Deno.test('a frame with no capture pose is no-pose — never lifted against a solved pose', async () => {
  await withTmp(async (tmp) => {
    // Monocular SfM poses (colmap.poses.json / lingbot-map.poses.json) are in
    // an arbitrary frame at an unknown scale — the reason SplatAlignManifest
    // exists. Lifting against the capture-frame cloud with one would put
    // non-metric coordinates into a metric world. So: no fallback, by design.
    await Deno.writeTextFile(`${tmp}/decoy.json`, '{}')
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }, { file: 'kf-00001.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'desk' }, { file: 'kf-00001.jpg', label: 'desk' }],
    )
    await Deno.writeTextFile(
      `${sessionDir}/colmap.poses.json`,
      JSON.stringify({ frames: [{ file: 'kf-00000.jpg', cameraToWorld: [[1, 0, 0, 5], [0, 1, 0, 5], [0, 0, 1, 5]] }] }),
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })

    assertEquals(m.reasons?.['no-pose'], 1)
    const sidecar = await readSidecar(detectionsPath)
    const posed = sidecar.detections.find((d) => d.file === 'kf-00001.jpg')!
    const unposed = sidecar.detections.find((d) => d.file === 'kf-00000.jpg')!
    assert(posed.worldPos, 'the posed frame still lifts')
    assertEquals(unposed.worldPos, null)
    assertEquals(unposed.reason, 'no-pose')
  })
})

Deno.test('a frame whose image is missing cannot be lifted — the centroid has no pixel frame', async () => {
  await withTmp(async (tmp) => {
    // centroidPx is in the ACTUAL JPEG's pixels (the worker sizes its output
    // to image.height/width), and the recorded intrinsics drift from what
    // landed on disk. Without the file there is no frame to interpret them in.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } }, image: false }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })
    assertEquals(m.reasons?.['no-pose'], 1)
    assertEquals((await readSidecar(detectionsPath)).detections[0].worldPos, null)
  })
})

// ── the confidence boundary, end to end ─────────────────────────────────────

Deno.test('the confidence floor is what separates confidentCount from lowConfidenceCount', async () => {
  await withTmp(async (tmp) => {
    // Identical geometry for both segments; only the segmenter's own score
    // differs. Confidence is a product of four factors, so segScore scales it
    // linearly — which makes it the clean way to straddle the floor.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [
        { file: 'kf-00000.jpg', label: 'chair', score: 0.95 },
        { file: 'kf-00000.jpg', label: 'chair', score: 0.05 },
      ],
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })

    assertEquals(m.segmentCount, 2)
    assertEquals(m.confidentCount, 1)
    assertEquals(m.lowConfidenceCount, 1)
    assertEquals(m.undeterminedCount, 1, 'low-confidence counts as undetermined — it has no position')
    assertEquals(m.reasons?.['low-confidence'], 1)
    assertEquals(m.params.minConfidence, MIN_CONFIDENCE)

    const sidecar = await readSidecar(detectionsPath)
    const [strong, weak] = sidecar.detections
    assert(strong.worldPos && strong.confidence! >= MIN_CONFIDENCE)
    assertEquals(weak.worldPos, null)
    assertEquals(weak.confidence, null)
    assertEquals(weak.reason, 'low-confidence')
    // Rejected-at-0.19 and rejected-at-0.02 are different facts, and the
    // diagnostics have to be able to say which without a re-run.
    assert(typeof weak.depthM === 'number', 'the depth it would have used is still recorded')
    assert(typeof weak.clusterPoints === 'number')
  })
})

// ── the worker's optional mask fields ───────────────────────────────────────

Deno.test('a segment whose centroid is off its own mask is refused, with that reason', async () => {
  await withTmp(async (tmp) => {
    // Both segments see the same surface; only the flag differs. Measured on
    // sess-a7e2f642: 2 of 50, both 'bed', whose U-shaped masks put the centroid
    // in the notch — so the ray measures past the bed and would report a real
    // surface at the wrong place with full confidence.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [
        { file: 'kf-00000.jpg', label: 'bed', centroidOnMask: false },
        { file: 'kf-00000.jpg', label: 'chair', centroidOnMask: true },
      ],
    )
    const detectionsPath = `${tmp}/s.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/s.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })
    assertEquals(m.reasons?.['centroid-off-mask'], 1)
    assertEquals(m.confidentCount, 1)
    const [bed, chair] = (await readSidecar(detectionsPath)).detections
    assertEquals(bed.worldPos, null)
    assertEquals(bed.reason, 'centroid-off-mask')
    assert(chair.worldPos)
  })
})

Deno.test('a bbox tightens the cone for an elongated mask, and a bad one is ignored', async () => {
  await withTmp(async (tmp) => {
    // A 95 x 435 curtain: the area disc implies a 115 px radius, the inscribed
    // circle 48 px. Points 0.25 m off-axis at 2 m subtend 7.1 degrees — inside
    // the disc cone (8.6 degrees) and outside the inscribed one (3.6), so the
    // two footprints see measurably different clouds.
    const AREA = 95 * 435
    const mk = (bboxPx?: unknown) =>
      makeSession(
        tmp + (bboxPx ? '/a' : '/b'),
        [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
        [{ file: 'kf-00000.jpg', label: 'curtain', areaPx: AREA, ...(bboxPx !== undefined ? { bboxPx } : {}) }],
      )
    const cloud = cloudSeam(slab(2.0, 40, 0.1), slab(2.0, 40, 0.1).map((v, i) => (i % 3 === 0 ? v + 0.25 : v)))

    const run = async (dir: string, tag: string) => {
      const p = `${tmp}/${tag}.json`
      await runPanopticLift({ sessionDir: dir, scanGlbPath: `${tmp}/${tag}.glb`, detectionsPath: p, _readCloud: cloud })
      return (await readSidecar(p)).detections[0]
    }
    const wide = await run(await mk(undefined), 'wide')
    const tight = await run(await mk([0, 0, 94, 434]), 'tight')
    assert(typeof wide.conePoints === 'number' && typeof tight.conePoints === 'number')
    assert(tight.conePoints! < wide.conePoints!, `tight ${tight.conePoints} should be under wide ${wide.conePoints}`)

    // A malformed box must fall back to the area disc rather than narrow the
    // cone to nothing — a data defect must not masquerade as 'no-geometry'.
    const broken = await run(await mk([10, 10, 0, 0]), 'broken')
    assertEquals(broken.conePoints, wide.conePoints)
  })
})

// ── bookkeeping ─────────────────────────────────────────────────────────────

Deno.test('segmentIndex is per-frame and stable, so a re-lift updates rather than duplicates', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [
        { file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } },
        { file: 'kf-00001.jpg', pose: { position: { x: 0, y: 0, z: 0 } } },
      ],
      [
        { file: 'kf-00000.jpg', label: 'chair' },
        { file: 'kf-00000.jpg', label: 'desk' },
        { file: 'kf-00001.jpg', label: 'chair' },
      ],
    )
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const opts = {
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(2.0, 40)),
    }
    const first = await runPanopticLift(opts)
    const a = await readSidecar(detectionsPath)
    // Restarts at 0 for each frame — `<scanId>:panoptic:<file>:<index>` is the
    // natural key thing_match matches on (server/thing_match.ts:52-54), so it
    // must not drift with the position of the frame in the run.
    assertEquals(a.detections.map((d) => [d.file, d.segmentIndex]), [
      ['kf-00000.jpg', 0],
      ['kf-00000.jpg', 1],
      ['kf-00001.jpg', 0],
    ])

    const second = await runPanopticLift(opts)
    const b = await readSidecar(detectionsPath)
    assertEquals(first.confidentCount, second.confidentCount)
    // Whole-file overwrite, so a re-lift is idempotent — no merge, no race
    // against ingest's unawaited meta-sidecar write (server/main.ts:1930).
    assertEquals(
      a.detections.map((d) => ({ ...d })),
      b.detections.map((d) => ({ ...d })),
    )
  })
})

Deno.test('the manifest reasons account for every segment that got no position', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }, { file: 'kf-00001.jpg' }],
      [
        { file: 'kf-00000.jpg', label: 'chair' },
        { file: 'kf-00000.jpg', label: 'sofa', centroidPx: [40, 40] },
        { file: 'kf-00001.jpg', label: 'lamp' },
      ],
    )
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath: `${tmp}/s.panoptic.detections.json`,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })
    const summed = Object.values(m.reasons ?? {}).reduce((a, b) => a + b, 0)
    assertEquals(summed, m.undeterminedCount)
    assertEquals((m.confidentCount ?? 0) + (m.undeterminedCount ?? 0), m.segmentCount)
    // "6 things" and "44 objects seen but unplaceable" must not look alike —
    // the same distinction thingLabelsUsed exists for on the scan manifest.
    assert(m.undeterminedCount! > 0)
  })
})

// ── a run that placed nothing must say what to do about it ──────────────────

Deno.test('a video-ingest session lifts nothing, and the manifest says which fix applies', async () => {
  await withTmp(async (tmp) => {
    // The measured production state, reproduced: both video-ingest sessions on
    // disk (sess-video-20260830-033839, 32 frames; -054518, 48 frames) write
    // keyframes.jsonl records of {index, file, timestamp} and nothing else, so
    // recordHasPose is false for every frame and 0 of 29 / 0 of 38 thing
    // segments can be lifted. A tally of {'no-pose': 3} is true but reads like
    // a bug in the join; the remediation has to name the structural cause.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }, { file: 'kf-00001.jpg' }],
      [
        { file: 'kf-00000.jpg', label: 'chair' },
        { file: 'kf-00000.jpg', label: 'table' },
        { file: 'kf-00001.jpg', label: 'chair' },
      ],
    )
    await Deno.writeTextFile(
      `${sessionDir}/colmap.poses.json`,
      JSON.stringify({
        frames: [
          { file: 'kf-00000.jpg', cameraToWorld: [[1, 0, 0, 5], [0, 1, 0, 5], [0, 0, 1, 5]] },
          { file: 'kf-00001.jpg', cameraToWorld: [[1, 0, 0, 6], [0, 1, 0, 5], [0, 0, 1, 5]] },
        ],
      }),
    )
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath: `${tmp}/s.panoptic.detections.json`,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })

    assertEquals(m.status, 'ok', 'abstaining on everything is an answer, not a failure')
    assertEquals(m.confidentCount, 0)
    assertEquals(m.reasons?.['no-pose'], 3)
    assert(m.remediation, 'a run that placed nothing must say what would change that')
    // This session HAS solved poses, and the whole point is that they are not a
    // substitute. The sentence has to say why, or an operator wires them in.
    assertStringIncludes(m.remediation, 'scale')
  })
})

Deno.test('a run that placed something carries no remediation, however much it abstained', async () => {
  await withTmp(async (tmp) => {
    // Every scan has objects it cannot see. Appending advice to a working run
    // would train readers to ignore the field on the runs that need it.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }, { file: 'kf-00001.jpg' }],
      [
        { file: 'kf-00000.jpg', label: 'chair' },
        { file: 'kf-00001.jpg', label: 'lamp' },
      ],
    )
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath: `${tmp}/s.panoptic.detections.json`,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })
    assertEquals(m.confidentCount, 1)
    assert(m.undeterminedCount! > 0)
    assertEquals(m.remediation, undefined)
  })
})

Deno.test('a cloud outside the depth window is out-of-range, with the depth that proves it', async () => {
  await withTmp(async (tmp) => {
    // Measured on sess-video-20260830-033839 against its own COLMAP cloud and
    // poses: 23 of 29 segments came back 'no-geometry' while their cones held
    // 1-605 points each at 3.6-18.1 along the ray. "Too sparse" and "not in
    // metres" demand opposite fixes and must not share a reason.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    const detectionsPath = `${tmp}/s.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      // A dense, perfectly good surface — 12.0 units away. In metres that is
      // past MAX_DEPTH_M; in a scale-free SfM unit it may be the far wall.
      _readCloud: cloudSeam(slab(12.0, 200, 0.5)),
    })

    assertEquals(m.confidentCount, 0)
    assertEquals(m.reasons?.['out-of-range'], 1)
    assert(m.remediation)
    assertStringIncludes(m.remediation, 'metre')

    const sidecar = await readSidecar(detectionsPath)
    const rec = sidecar.detections[0]
    assertEquals(rec.worldPos, null)
    assertEquals(rec.reason, 'out-of-range')
    assertEquals(rec.conePoints, undefined, 'the windowed cone really was empty')
    assert(rec.nearestDepthM !== undefined && Math.abs(rec.nearestDepthM - 12.0) < 0.5, `got ${rec.nearestDepthM}`)
  })
})

Deno.test('the manifest lands on disk next to the scan', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/1787_room.glb`,
      _readCloud: cloudSeam(slab(2.0, 40)),
    })
    // Defaults derived from the GLB path, matching splat_detect's
    // <base>.interactions.json / <base>.splat-detect.manifest.json pairing.
    const written = JSON.parse(await Deno.readTextFile(`${tmp}/1787_room.panoptic-lift.manifest.json`))
    assertEquals(written.tool, 'panoptic-lift')
    assertEquals(written.detectionsPath, '1787_room.panoptic.detections.json')
    assertEquals(written.cloudSource, '1787_room.glb')
    assert(typeof written.timing.elapsedMs === 'number')
    await Deno.readTextFile(`${tmp}/1787_room.panoptic.detections.json`)
  })
})

// ── reading the cloud out of a glTF document ────────────────────────────────

Deno.test('point positions are read through the node hierarchy, not raw', async () => {
  // Measured motivation: in 1787789921923_home-00-studio-a.opt.glb the
  // `point-cloud` node carries scale 2.470 and translation (0, 1.300, 0),
  // because quantize() puts the dequantization on the node. Reading POSITION
  // raw would scale the entire cloud by 2.47 — silently, and plausibly.
  const doc = new Document()
  const buffer = doc.createBuffer()
  const acc = doc.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer)
  const prim = doc.createPrimitive().setMode(Primitive.Mode.POINTS).setAttribute('POSITION', acc)
  const mesh = doc.createMesh('point-cloud').addPrimitive(prim)
  const node = doc.createNode('point-cloud').setMesh(mesh).setScale([2, 2, 2]).setTranslation([0, 1.3, 0])
  const parent = doc.createNode('Room').addChild(node).setTranslation([10, 0, 0])
  doc.createScene().addChild(parent)

  const { positions, count } = collectPointPositions(doc)
  assertEquals(count, 2)
  // Float32 storage, so compare to tolerance rather than to a decimal literal.
  const expected = [12, 1.3, 0, 10, 3.3, 0]
  for (const [i, want] of expected.entries()) {
    assert(Math.abs(positions[i] - want) < 1e-6, `component ${i}: got ${positions[i]}, want ${want}`)
  }
})

Deno.test('only POINTS geometry is read — detection boxes are outputs, not evidence', async () => {
  // A scan GLB also carries a `camera-path` line strip and TRIANGLES for the
  // floor plane and each previous detection's box. Letting a detection box in
  // as "surface" would let this stage confirm its own earlier guesses.
  const doc = new Document()
  const buffer = doc.createBuffer()
  const mk = (mode: ReturnType<Primitive['getMode']>, name: string) => {
    const acc = doc.createAccessor().setType('VEC3').setArray(new Float32Array([5, 5, 5])).setBuffer(buffer)
    const prim = doc.createPrimitive().setMode(mode).setAttribute('POSITION', acc)
    return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim))
  }
  const scene = doc.createScene()
  scene.addChild(mk(Primitive.Mode.TRIANGLES, 'table_001'))
  scene.addChild(mk(Primitive.Mode.LINE_STRIP, 'camera-path'))
  const pts = doc.createAccessor().setType('VEC3').setArray(new Float32Array([1, 2, 3])).setBuffer(buffer)
  scene.addChild(
    doc.createNode('point-cloud').setMesh(
      doc.createMesh('pc').addPrimitive(doc.createPrimitive().setMode(Primitive.Mode.POINTS).setAttribute('POSITION', pts)),
    ),
  )

  const { positions, count } = collectPointPositions(doc)
  assertEquals(count, 1)
  assertEquals([...positions], [1, 2, 3])
})

Deno.test('a document with no POINTS geometry yields an empty cloud rather than throwing', async () => {
  const doc = new Document()
  doc.createScene()
  assertEquals(collectPointPositions(doc).count, 0)
})

// ── the metric frame: the only door a solved camera track gets through ──────
//
// The refusal these cases surround is the one that makes the whole stage
// correct, so both halves of it are pinned: a capture with no measured metric
// frame still abstains, and a capture WITH one places in real metres.
//
// The fixture is arithmetic end to end, which is the only way to tell "the
// transform was applied" from "the transform happened to be near identity".
// Solver frame: the camera sits at the solver origin with an identity OpenCV
// [R|t], which `openCvW2cToC2w` turns into a camera looking down world +Z. The
// slab sits at solver z = +12. The alignment is a pure 0.25 scale plus a
// (10, 1, -3) m offset, so:
//
//   camera centre  (0,0,0)  ->  (10, 1, -3) m
//   slab           (0,0,12) ->  (10, 1,  0) m,  3.0 m in front of the camera
//
// 12 solver units is deliberately outside MAX_DEPTH_M (5.0), so a run that
// forgot to carry the cloud through the transform cannot pass by accident —
// it comes back 'out-of-range'.
const ALIGN_SCALE = 0.25
const ALIGN_TRANSFORM = [
  ALIGN_SCALE, 0, 0, 10,
  0, ALIGN_SCALE, 0, 1,
  0, 0, ALIGN_SCALE, -3,
  0, 0, 0, 1,
]

/** The slab, mirrored to +Z: `slab` builds it down -Z for the capture cases. */
const solverSlab = (z: number, n: number) => slab(z, n).map((v, i) => (i % 3 === 2 ? -v : v))

/** An identity OpenCV world-to-camera — i.e. the camera at the solver origin. */
const IDENTITY_W2C = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]

/**
 * A row-major 4x4 applied to a point — the arithmetic a consumer of
 * `metricFrame.toScanFrame` does, written out here so the round-trip is
 * checked against the published numbers rather than against the driver's own
 * helper.
 */
function applyRowMajor4(
  m: number[],
  p: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  }
}

async function writeSolvedPoses(sessionDir: string, files: string[]): Promise<void> {
  await Deno.writeTextFile(
    `${sessionDir}/colmap.poses.json`,
    JSON.stringify({ frames: files.map((file) => ({ file, cameraToWorld: IDENTITY_W2C })) }),
  )
}

/** A `splat-align` sidecar, `status: 'ok'` unless the case says otherwise. */
function alignManifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    tool: 'umeyama',
    status: 'ok',
    createdAt: new Date().toISOString(),
    projectTransform: ALIGN_TRANSFORM,
    scale: ALIGN_SCALE,
    residualM: 0.02,
    correspondenceCount: 36,
    calibrationMethod: 'two-point-ground',
    params: { minCorrespondences: 4, maxResidualM: 0.25 },
    ...over,
  })
}

Deno.test('with no measured metric frame, a solved camera track still places nothing', async () => {
  await withTmp(async (tmp) => {
    // The refusal the header is about, stated on its own: every input for a
    // lift is present EXCEPT the one measurement that says what a metre is.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(solverSlab(12, 40)),
    })

    assertEquals(m.status, 'ok')
    assertEquals(m.confidentCount, 0)
    assertEquals(m.reasons?.['no-pose'], 1)
    const sidecar = await readSidecar(detectionsPath)
    assertEquals(sidecar.detections[0].worldPos, null)
    assertEquals(sidecar.detections[0].cameraSource, undefined)
    assertEquals(sidecar.metricFrame, undefined, 'no frame was used, so none is claimed')
    // The operator's next action is a measurement, not a re-capture — the
    // capture itself is fine.
    assertStringIncludes(m.remediation ?? '', 'known real-world distance')
    assertStringIncludes(m.remediation ?? '', 'scale')
  })
})

Deno.test('a verified metric frame places objects in real metres, and says how to get back to the scan\'s own frame', async () => {
  await withTmp(async (tmp) => {
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }],
      [{ file: 'kf-00000.jpg', label: 'chair', score: 0.94 }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
    await Deno.writeTextFile(`${tmp}/scan.splat-align.manifest.json`, alignManifest())

    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(solverSlab(12, 40)),
    })

    assertEquals(m.status, 'ok')
    assertEquals(m.confidentCount, 1)
    assertEquals(m.reasons?.['no-pose'], undefined)
    assertEquals(m.remediation, undefined)

    const sidecar = await readSidecar(detectionsPath)
    const d = sidecar.detections[0]
    assertEquals(d.cameraSource, 'solved')
    assert(d.worldPos, 'expected a world position')
    // The whole point of the gate: these are metres in the project's frame,
    // not solver units at the solver's origin. Both halves are asserted —
    // the 0.25 scale AND the (10, 1, -3) offset.
    assert(Math.abs(d.worldPos.x - 10) < 0.05, `x was ${d.worldPos.x}`)
    assert(Math.abs(d.worldPos.y - 1) < 0.05, `y was ${d.worldPos.y}`)
    assert(Math.abs(d.worldPos.z - 0) < 0.05, `z was ${d.worldPos.z}`)
    // 12 solver units became 3.0 m; untransformed it would have been outside
    // the 0.5-5.0 m window entirely.
    assert(typeof d.depthM === 'number' && Math.abs(d.depthM - 3.0) < 0.05, `depth was ${d.depthM}`)
    // Provenance, so the number can be checked later without re-deriving it.
    assertEquals(sidecar.metricFrame?.scale, ALIGN_SCALE)
    assertEquals(sidecar.metricFrame?.residualM, 0.02)
    assertEquals(sidecar.metricFrame?.source, 'scan.splat-align.manifest.json')

    // ── the contract, in numbers ────────────────────────────────────────────
    //
    // Those metres are NOT coordinates in the scan GLB, and until this field
    // existed nothing said so: the viewer hung its markers off the scan root —
    // the GLB's own frame — and used worldPos verbatim, so this very fixture
    // drew a marker at (10, 1, 0) for an object whose points are at (0, 0, 12).
    // 10.05 m away, in a 12-unit room. `toScanFrame` is the statement of the
    // relationship, and it is exact: 1/0.25 = 4 on the diagonal, and the
    // alignment's (10, 1, -3) carried back through it.
    assertEquals(sidecar.metricFrame?.toScanFrame, [
      4, 0, 0, -40,
      0, 4, 0, -4,
      0, 0, 4, 12,
      0, 0, 0, 1,
    ])
    // And it round-trips onto the geometry rather than merely being consistent
    // with itself: the position, carried back, lands on the slab the ray
    // actually hit — 40 points at solver z = +12, centred on (0, 0).
    const back = applyRowMajor4(sidecar.metricFrame!.toScanFrame, d.worldPos)
    assert(Math.abs(back.x) < 0.05, `x back in the scan's frame was ${back.x}`)
    assert(Math.abs(back.y) < 0.05, `y back in the scan's frame was ${back.y}`)
    assert(Math.abs(back.z - 12) < 0.05, `z back in the scan's frame was ${back.z}`)
  })
})

Deno.test('the frame declaration survives a rotated alignment — it is the inverse, not the transform again', async () => {
  await withTmp(async (tmp) => {
    // The fixture above cannot tell R from R-transpose, because its rotation is
    // the identity. Publishing `projectTransform`'s own rotation instead of its
    // inverse would pass every assertion there and put a marker on the wrong
    // side of the room here. So: a quarter turn about Y, which maps a solver
    // (x, y, z) to (z, y, -x).
    //
    //   slab           (0, 0, 12) -> 0.25*(12, 0, 0) + (10, 1, -3) = (13, 1, -3) m
    //   camera centre  (0, 0,  0) ->                                 (10, 1, -3) m
    //
    // — still 3.0 m in front of the camera, and still 12 units away in the
    // scan's own frame, which is what the round-trip below has to recover.
    const yaw = [
      0, 0, ALIGN_SCALE, 10,
      0, ALIGN_SCALE, 0, 1,
      -ALIGN_SCALE, 0, 0, -3,
      0, 0, 0, 1,
    ]
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }],
      [{ file: 'kf-00000.jpg', label: 'chair', score: 0.94 }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
    await Deno.writeTextFile(
      `${tmp}/scan.splat-align.manifest.json`,
      alignManifest({ projectTransform: yaw }),
    )

    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(solverSlab(12, 40)),
    })
    assertEquals(m.confidentCount, 1)

    const sidecar = await readSidecar(detectionsPath)
    const d = sidecar.detections[0]
    assert(d.worldPos, 'expected a world position')
    assert(Math.abs(d.worldPos.x - 13) < 0.05, `x was ${d.worldPos.x}`)
    assert(Math.abs(d.worldPos.y - 1) < 0.05, `y was ${d.worldPos.y}`)
    assert(Math.abs(d.worldPos.z + 3) < 0.05, `z was ${d.worldPos.z}`)

    // (1/s)·R-transpose, and the translation carried through it. Using R would
    // give the third row (-4, 0, 0) and land the round-trip at z = -12: the
    // right distance, the opposite direction, and nothing to see it by.
    assertEquals(sidecar.metricFrame?.toScanFrame, [
      0, 0, -4, -12,
      0, 4, 0, -4,
      4, 0, 0, -40,
      0, 0, 0, 1,
    ])
    const back = applyRowMajor4(sidecar.metricFrame!.toScanFrame, d.worldPos)
    assert(Math.abs(back.x) < 0.05, `x back in the scan's frame was ${back.x}`)
    assert(Math.abs(back.y) < 0.05, `y back in the scan's frame was ${back.y}`)
    assert(Math.abs(back.z - 12) < 0.05, `z back in the scan's frame was ${back.z}`)
  })
})

Deno.test('a tracked capture declares no frame, because its metres already ARE the scan\'s frame', async () => {
  await withTmp(async (tmp) => {
    // The other half of the contract, and the reason `metricFrame` can mean
    // "the frames differ" by its presence alone. A capture whose keyframes
    // carry a pose lifts against the cloud untransformed, so worldPos IS a
    // coordinate in the scan GLB — a consumer drawing it verbatim is right,
    // and one hunting for a transform would find none because there is none.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'chair', score: 0.94 }],
    )
    // The alignment is on disk and is deliberately ignored: this capture never
    // needed one, and applying it would move every position off the geometry.
    await Deno.writeTextFile(`${tmp}/scan.splat-align.manifest.json`, alignManifest())

    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      _readCloud: cloudSeam(slab(3, 40)),
    })
    assertEquals(m.confidentCount, 1)

    const sidecar = await readSidecar(detectionsPath)
    const d = sidecar.detections[0]
    assertEquals(sidecar.metricFrame, undefined, 'the frames are the same, so nothing is declared')
    assertEquals(d.cameraSource, undefined)
    assert(d.worldPos, 'expected a world position')
    // The slab sits at (0, 0, -3) in the cloud, i.e. in the GLB, and that is
    // exactly what the sidecar says — no scale, no offset, nothing to undo.
    assert(Math.abs(d.worldPos.x) < 0.05, `x was ${d.worldPos.x}`)
    assert(Math.abs(d.worldPos.y) < 0.05, `y was ${d.worldPos.y}`)
    assert(Math.abs(d.worldPos.z + 3) < 0.05, `z was ${d.worldPos.z}`)
  })
})

Deno.test('the session-dir alignment sidecar is found too, not only the one beside the scan', async () => {
  await withTmp(async (tmp) => {
    // splat_align writes beside the splat when there is one and into the
    // session dir when there is not; a capture with no trained splat is
    // exactly the capture this path serves, so both have to be read.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
    await Deno.writeTextFile(`${sessionDir}/splat-align.manifest.json`, alignManifest())
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath: `${tmp}/scan.panoptic.detections.json`,
      _readCloud: cloudSeam(solverSlab(12, 40)),
    })
    assertEquals(m.confidentCount, 1)
  })
})

Deno.test('an alignment that is unverified, too loose, or misshapen places nothing', async () => {
  // Each of these is a different way for the measurement to fail to be a
  // measurement, and every one of them has to land back on the honest refusal
  // — a wrong metric frame is worse than no metric frame, because every
  // position it produces looks real.
  const cases: Array<[string, string]> = [
    ['skipped', alignManifest({ status: 'skipped', skippedReason: 'no calibrated metric frame' })],
    ['no residual reported', alignManifest({ residualM: undefined })],
    // 0.20 m is a legitimate `status: 'ok'` for splat-align, whose own limit is
    // 0.25 m. It is still over a fifth of thing_match's 0.75 m fusion radius,
    // which is the budget this stage is willing to spend on the frame alone.
    ['residual over the placement bar', alignManifest({ residualM: 0.2 })],
    ['non-positive scale', alignManifest({ scale: 0 })],
    ['no transform', alignManifest({ projectTransform: undefined })],
    // A non-uniform scale has no single metres-per-unit, so nothing it moves
    // can be reported in metres.
    ['non-uniform 3x3', alignManifest({ projectTransform: [0.25, 0, 0, 10, 0, 0.4, 0, 1, 0, 0, 0.25, -3, 0, 0, 0, 1] })],
    // A reflection mirrors every ray while leaving all the lengths right.
    ['reflected 3x3', alignManifest({ projectTransform: [-0.25, 0, 0, 10, 0, 0.25, 0, 1, 0, 0, 0.25, -3, 0, 0, 0, 1] })],
    // A size, not a placement. `SplatAlignManifest.determined`'s own doc says a
    // consumer that puts one scan beside another must check heading and origin
    // first, and `thing_match` fusing these positions across scans at
    // THING_MATCH_RADIUS_M is exactly that consumer. Every length read off this
    // frame is real and every bearing in it is arbitrary, which is the shape of
    // answer that gets believed.
    ['a size-only frame', alignManifest({
      tool: 'known-distance',
      calibrationMethod: 'known-distance+solver-gravity',
      residualSource: 'viewpoint-scatter',
      determined: { scale: true, up: true, heading: false, origin: false },
    })],
    // The solve found no gravity, so the frame is tilted by an unknown angle —
    // every depth read off it is short or long by a factor nobody measured.
    ['an unknown up', alignManifest({ determined: { scale: true, up: false, heading: true, origin: true } })],
    // Absent `determined` is read as an older umeyama fit, which is what its
    // doc says one is. The known-distance driver always writes the block, so
    // one without it is malformed rather than old — and malformed is a refusal.
    ['a known-distance frame that recorded nothing about what it pinned down', alignManifest({ tool: 'known-distance' })],
  ]
  for (const [name, body] of cases) {
    await withTmp(async (tmp) => {
      const sessionDir = await makeSession(
        tmp,
        [{ file: 'kf-00000.jpg' }],
        [{ file: 'kf-00000.jpg', label: 'chair' }],
      )
      await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
      await Deno.writeTextFile(`${tmp}/scan.splat-align.manifest.json`, body)
      const detectionsPath = `${tmp}/scan.panoptic.detections.json`
      const m = await runPanopticLift({
        sessionDir,
        scanGlbPath: `${tmp}/scan.glb`,
        detectionsPath,
        _readCloud: cloudSeam(solverSlab(12, 40)),
      })
      assertEquals(m.confidentCount, 0, `${name}: nothing may be placed`)
      assertEquals(m.reasons?.['no-pose'], 1, `${name}: the honest reason is unchanged`)
      const sidecar = await readSidecar(detectionsPath)
      assertEquals(sidecar.metricFrame, undefined, `${name}: no frame may be claimed`)
      assert(m.remediation, `${name}: a run that placed nothing must say what would change that`)
    })
  }
})

Deno.test('a capture that was sized but never placed is not told to go and measure again', async () => {
  await withTmp(async (tmp) => {
    // The one refusal whose obvious advice is backwards. A `'known-distance'`
    // frame IS what measuring a distance produces, so "measure a distance" here
    // sends the operator round the same loop; what is missing is where the
    // capture sits in the room, which is the World Editor's two-point flow.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }],
      [{ file: 'kf-00000.jpg', label: 'chair' }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg'])
    await Deno.writeTextFile(
      `${tmp}/scan.splat-align.manifest.json`,
      alignManifest({
        tool: 'known-distance',
        determined: { scale: true, up: true, heading: false, origin: false },
      }),
    )
    const m = await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath: `${tmp}/scan.panoptic.detections.json`,
      _readCloud: cloudSeam(solverSlab(12, 40)),
    })

    assertEquals(m.confidentCount, 0)
    const remediation = m.remediation ?? ''
    assertStringIncludes(remediation, 'World Editor')
    assert(
      !/Measure this capture against one known real-world distance/.test(remediation),
      `the advice that produced this very frame must not be the advice out of it: ${remediation}`,
    )
  })
})

Deno.test('the residual bar is a fifth of the radius thing_match fuses at', () => {
  // Stated as a relationship, not as 0.15: the bar exists only because of that
  // radius, and if the radius ever moves the bar has to move with it.
  assertEquals(MAX_ALIGN_RESIDUAL_M, THING_MATCH_RADIUS_M / 5)
  assert(MAX_ALIGN_RESIDUAL_M < 0.25, 'tighter than splat-align\'s own same-camera-path check')
})

Deno.test('one tracked frame keeps the whole capture off solved cameras, alignment or not', async () => {
  await withTmp(async (tmp) => {
    // The invariant that survives the new door. A capture that tracked built
    // its cloud in the tracker's frame, so a solved camera — however well
    // measured — is a camera in a different space from the points it would be
    // cast against. The test is per capture, not per frame, and a verified
    // alignment does not change that.
    const sessionDir = await makeSession(
      tmp,
      [{ file: 'kf-00000.jpg' }, { file: 'kf-00001.jpg', pose: { position: { x: 0, y: 0, z: 0 } } }],
      [{ file: 'kf-00000.jpg', label: 'desk' }, { file: 'kf-00001.jpg', label: 'desk' }],
    )
    await writeSolvedPoses(sessionDir, ['kf-00000.jpg', 'kf-00001.jpg'])
    await Deno.writeTextFile(`${tmp}/scan.splat-align.manifest.json`, alignManifest())

    const detectionsPath = `${tmp}/scan.panoptic.detections.json`
    await runPanopticLift({
      sessionDir,
      scanGlbPath: `${tmp}/scan.glb`,
      detectionsPath,
      // A capture-frame cloud: down -Z from the tracked camera at the origin.
      _readCloud: cloudSeam(slab(2.0, 40)),
    })

    const sidecar = await readSidecar(detectionsPath)
    const tracked = sidecar.detections.find((d) => d.file === 'kf-00001.jpg')!
    const untracked = sidecar.detections.find((d) => d.file === 'kf-00000.jpg')!
    assert(tracked.worldPos, 'the tracked frame lifts against its own cloud, unchanged')
    assertEquals(tracked.cameraSource, undefined)
    assertEquals(untracked.worldPos, null)
    assertEquals(untracked.reason, 'no-pose')
    assertEquals(sidecar.metricFrame, undefined, 'no solved camera was used, so no frame is claimed')
  })
})
