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
  runPanopticLift,
  type PanopticDetectionsSidecar,
} from '../../../server/panoptic/panoptic_lift.ts'
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
