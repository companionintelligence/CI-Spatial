/**
 * The solve over several sessions (server/colmap/colmap_poses.ts `runColmapJointPoses`, colmap_sessions.ts) and the
 * promise that one session solved alone is untouched by it.
 *
 * COLMAP is stubbed: `_spawn` records every command line and writes the model files a real run would, so what is
 * tested is what this repo owns. That is the layout COLMAP is given (one folder and one camera per session, each
 * camera started from its own keyframes' field of view), the matching it is asked for (the pairs the poses allow,
 * every pair only when the poses cannot tie a session and the image count is small, nothing when it is large), the
 * keys the poses come back under, and the answer to "which sessions joined". The real binary is exercised by
 * colmap_toy_sfm.test.ts behind COLMAP_E2E=1.
 *
 * The golden test at the top is the guard on the other side: `runColmapPoses` for one session was refactored to share
 * its command lines with the joint solve, and its output has to be what it was, byte for byte. Its expected values were
 * taken by running the driver as it stood before that change.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { relative } from '@std/path'

import { buildJointPosesJson, buildPosesJson, parseImagesBin } from '../../../server/colmap/colmap_model.ts'
import { locationOf, runColmapJointPoses } from '../../../server/colmap/colmap_joint.ts'
import { cameraCentres, listModels, measureSessionBaseline, runColmapPoses } from '../../../server/colmap/colmap_poses.ts'
import {
  cameraParamsArg,
  countSessionModels,
  deriveSessionCameraPrior,
  jointReaderArgs,
  PLACEHOLDER_FOV_Y_DEG,
  PLAUSIBLE_FOV_Y_DEG,
  planSessionFrames,
} from '../../../server/colmap/colmap_sessions.ts'
import { exhaustivePairCount, type MatchingPlan } from '../../../server/register/pair_list.ts'
import { frameKey, sessionCentres } from '../../../server/register/session_priors.ts'
import { sim3ToRowMajor } from '../../../server/register/sim3_chain.ts'
import { pairByFilename, sfmCentresFromPoses } from '../../../server/splat/splat_align.ts'
import { readKeyframes, readSolvedCamera, readSolvedPoses } from '../../../server/splat/splat_train_dataset.ts'
import {
  encodeCamerasBin,
  encodeImagesBin,
  encodePoints3DBin,
  jpegHeader,
  quatAboutY,
  type StubCamera,
  type StubImage,
} from './colmap_model_fixtures.ts'

type Spawn = NonNullable<Parameters<typeof runColmapJointPoses>[0]['_spawn']>

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Golden: one session, as it was ──────────────────────────────────────────

/** The command lines of the single-session solve, `<SESSION>` standing for its directory, as the driver ran them before it shared them. */
const GOLDEN_CALLS = [
  'feature_extractor --database_path <SESSION>/colmap-work/db.db --image_path <SESSION>/colmap-work/images ' +
  '--ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL --FeatureExtraction.type SIFT ' +
  '--FeatureExtraction.use_gpu 0 --SiftExtraction.max_image_size 1600',
  'exhaustive_matcher --database_path <SESSION>/colmap-work/db.db --FeatureMatching.type SIFT --FeatureMatching.use_gpu 0',
  'mapper --database_path <SESSION>/colmap-work/db.db --image_path <SESSION>/colmap-work/images ' +
  '--output_path <SESSION>/colmap-work/sparse --Mapper.init_min_num_inliers 25 --Mapper.abs_pose_min_num_inliers 12 ' +
  '--Mapper.min_num_matches 12 --Mapper.init_min_tri_angle 2 --Mapper.tri_min_angle 0.5',
  'mapper --database_path <SESSION>/colmap-work/db.db --image_path <SESSION>/colmap-work/images ' +
  '--input_path <SESSION>/colmap-work/sparse/0 --output_path <SESSION>/colmap-work/sparse_grown ' +
  '--Mapper.abs_pose_min_num_inliers 12 --Mapper.min_num_matches 12',
]

Deno.test('golden: one session is solved with one shared camera, flat images and the same files as before the joint solve', async () => {
  const dir = await Deno.makeTempDir()
  const sessionDir = `${dir}/sess-golden-single`
  await Deno.mkdir(sessionDir)
  try {
    const N = 8
    for (let i = 0; i < N; i++) {
      await Deno.writeFile(`${sessionDir}/kf-${String(i).padStart(5, '0')}.jpg`, new Uint8Array([0xff, 0xd8, i, 0x42]))
    }
    await Deno.writeTextFile(
      `${sessionDir}/keyframes.jsonl`,
      Array.from({ length: N }, (_, i) =>
        JSON.stringify({
          index: i,
          file: `kf-${String(i).padStart(5, '0')}.jpg`,
          timestamp: i * 1000,
          station: i < 4 ? 0 : 1,
          intrinsics: { fovYDeg: 63, aspect: 0.5625, width: 720, height: 1280 },
        })).join('\n') + '\n',
    )

    const calls: string[] = []
    const result = await runColmapPoses({
      sessionDir,
      colmapBin: Deno.execPath(),
      _spawn: async (_bin, args) => {
        calls.push(args.join(' ').split(sessionDir).join('<SESSION>'))
        if (args[0] === 'mapper') {
          const out = args[args.indexOf('--output_path') + 1]!
          const model = args.includes('--input_path') ? out : `${out}/0`
          await Deno.mkdir(model, { recursive: true })
          await Deno.writeFile(
            `${model}/images.bin`,
            encodeImagesBin(Array.from({ length: N }, (_, i) => ({
              id: i + 1,
              q: [0.9238795325112867, 0.0, 0.3826834323650898, 0.0],
              t: [i * 0.5, 0.1 * i, -1 + i * 0.25],
              cam: 1,
              name: `kf-${String(i).padStart(5, '0')}.jpg`,
            }))),
          )
          await Deno.writeFile(`${model}/cameras.bin`, encodeCamerasBin([{ id: 1, w: 720, h: 1280, params: [1200.5, 360, 640, 0.01] }]))
          await Deno.writeFile(`${model}/points3D.bin`, encodePoints3DBin(150))
        }
        return { code: 0, stderr: '' }
      },
    })

    assertEquals(result.status, 'ok')
    assertEquals(calls, GOLDEN_CALLS)

    // The files, by hash: a change to a single digit of a pose or a point changes them.
    const poses = await Deno.readTextFile(`${sessionDir}/colmap.poses.json`)
    assertEquals(poses.length, 3138)
    assertEquals(await sha256Hex(new TextEncoder().encode(poses)), '6e2b2fe96836a211b57cad1f00aae67de450f094b919ca4e8ab836eeb1eda854')
    assertEquals(
      await sha256Hex(await Deno.readFile(`${sessionDir}/colmap.point-cloud.ply`)),
      'e5e31a70e20cabffad8a2e81239d1ba03110d9903ddcb7994ef98f813ef1358c',
    )
    // ...and in the words that matter: bare filenames, the one solved camera, no folder prefix anywhere.
    const parsed = JSON.parse(poses) as { camera: Record<string, number>; frames: Array<{ file: string }> }
    assertEquals(parsed.frames.map((f) => f.file), Array.from({ length: N }, (_, i) => `kf-${String(i).padStart(5, '0')}.jpg`))
    assertEquals(parsed.camera, { fx: 1200.5, fy: 1200.5, cx: 360, cy: 640, width: 720, height: 1280 })

    const manifest = JSON.parse(await Deno.readTextFile(`${sessionDir}/colmap-poses.manifest.json`))
    delete manifest.createdAt
    delete manifest.timing
    assertEquals(manifest.sessionDir, sessionDir)
    manifest.sessionDir = '<SESSION>'
    assertEquals(typeof manifest.params.colmapBin, 'string')
    manifest.params.colmapBin = '<BIN>'
    assertEquals(manifest, {
      schemaVersion: 1,
      tool: 'colmap',
      status: 'ok',
      sessionDir: '<SESSION>',
      sessionId: 'sess-golden-single',
      params: { colmapBin: '<BIN>', featureType: 'SIFT', matcherType: 'SIFT', maxImageSize: 1600 },
      frameCount: 8,
      posesPath: 'colmap.poses.json',
      pointCloudPath: 'colmap.point-cloud.ply',
      registeredImages: 8,
      pointCount: 150,
      upAxis: [0, -1, 0],
      gravityAligned: true,
      quality: {
        registrationRatio: 1,
        degenerate: false,
        status: 'ready',
        reasons: [],
        baseline: { stationCount: 2, placedFrameCount: 8, minSeparation: 2.2716, maxSpread: 0.6349, separationRatio: 3.5777 },
        thresholds: { minRegistrationRatio: 0.6, minPoints3D: 100, minStationSeparationRatio: 1 },
      },
      inputFingerprint: 'a8bf9edff4f5c19ba768a586c221549ca30e5248ff324a09f4f1b30972fff582',
      reusedWorkspace: false,
    })

    // The workspace is the flat layout: images straight under images/, nothing per session.
    const listing = async (path: string) => {
      const names: string[] = []
      for await (const entry of Deno.readDir(path)) names.push(entry.name)
      return names.sort()
    }
    assertEquals(await listing(`${sessionDir}/colmap-work`), ['images', 'input.fingerprint', 'sparse', 'sparse_grown'])
    assertEquals(await listing(`${sessionDir}/colmap-work/images`), Array.from({ length: N }, (_, i) => `kf-${String(i).padStart(5, '0')}.jpg`))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('one session: the grow pass is seeded from the largest first-pass model, wherever COLMAP numbered it, and an empty first pass is an error', async () => {
  const dir = await Deno.makeTempDir()
  const sessionDir = `${dir}/sess-single-models`
  await Deno.mkdir(sessionDir)
  try {
    const N = 8
    for (let i = 0; i < N; i++) await Deno.writeFile(`${sessionDir}/${frameName(i)}`, new Uint8Array([0xff, 0xd8, i, 0x42]))
    const imagesOf = (names: number[]) => encodeImagesBin(names.map((n, k) => ({ id: k + 1, q: quatAboutY(k), t: [k * 0.5, 0, 0], cam: 1, name: frameName(n) })))
    const run = async (models: Record<string, number[]>) => {
      const calls: string[][] = []
      const result = await runColmapPoses({
        sessionDir,
        colmapBin: Deno.execPath(),
        _spawn: async (_bin, args) => {
          calls.push(args)
          if (args[0] === 'mapper' && !args.includes('--input_path')) {
            const out = args[args.indexOf('--output_path') + 1]!
            for (const [name, frames] of Object.entries(models)) {
              await Deno.mkdir(`${out}/${name}`, { recursive: true })
              await Deno.writeFile(`${out}/${name}/images.bin`, imagesOf(frames))
              await Deno.writeFile(`${out}/${name}/cameras.bin`, encodeCamerasBin([{ id: 1, w: 640, h: 480, params: [500, 320, 240, 0] }]))
              await Deno.writeFile(`${out}/${name}/points3D.bin`, encodePoints3DBin(120))
            }
          }
          return { code: 0, stderr: '' }
        },
      })
      return { result, calls }
    }
    // Model 0 has three frames, model 1 has six, model 2 registered nothing: the grow pass starts from 1.
    const sized = await run({ '0': [0, 1, 2], '1': [2, 3, 4, 5, 6, 7], '2': [] })
    const grow = sized.calls.filter((c) => c[0] === 'mapper')[1]!
    assertEquals(grow[grow.indexOf('--input_path') + 1], `${sessionDir}/colmap-work/sparse/1`)

    // Models that registered nothing are not models: the run says no image registered, and does not grow from an empty one.
    await Deno.remove(`${sessionDir}/colmap-work`, { recursive: true })
    const nothing = await run({ '0': [] })
    assertEquals(nothing.result.status, 'error')
    assert(nothing.result.manifest.error?.includes('registered no images'), nothing.result.manifest.error)
    assertEquals(nothing.calls.filter((c) => c[0] === 'mapper').length, 1, 'no grow pass from a model of nothing')
  } finally {
    await tidy(dir)
  }
})

// ─── Helpers for the joint tests ─────────────────────────────────────────────

const frameName = (i: number) => `kf-${String(i).padStart(5, '0')}.jpg`

interface SessionSpec {
  id: string
  frames: number
  size?: [number, number]
  /** Sizes by frame index, for a session that changed orientation. */
  sizeOf?: (i: number) => [number, number]
  fovYDeg?: number | null | ((i: number) => number | null)
  /** Place-frame pose of frame i (also written as the AR pose, so the identity calibration places it there). */
  pose?: (i: number) => { x: number; y: number; z: number; yawDeg: number } | null
  station?: (i: number) => number
  /** Leave frame i's line out of keyframes.jsonl. */
  unrecorded?: (i: number) => boolean
}

async function writeSession(parent: string, spec: SessionSpec): Promise<string> {
  const dir = `${parent}/${spec.id}`
  await Deno.mkdir(dir, { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < spec.frames; i++) {
    const [w, h] = spec.sizeOf ? spec.sizeOf(i) : (spec.size ?? [1280, 720])
    await Deno.writeFile(`${dir}/${frameName(i)}`, jpegHeader(w, h, i))
    if (spec.unrecorded?.(i)) continue
    const fov = typeof spec.fovYDeg === 'function' ? spec.fovYDeg(i) : spec.fovYDeg === undefined ? 63 : spec.fovYDeg
    const pose = spec.pose?.(i)
    const [rw, rh] = spec.sizeOf ? spec.sizeOf(i) : (spec.size ?? [1280, 720])
    lines.push(JSON.stringify({
      index: i,
      file: frameName(i),
      timestamp: i * 1000,
      epoch: 0,
      ...(pose
        ? {
          pose: {
            position: { x: pose.x, y: pose.y, z: pose.z },
            rotation: { x: 0, y: Math.sin((pose.yawDeg * Math.PI) / 360), z: 0, w: Math.cos((pose.yawDeg * Math.PI) / 360) },
          },
        }
        : {}),
      ...(fov === null ? {} : { intrinsics: { fovYDeg: fov, aspect: rw / rh, width: rw, height: rh } }),
      ...(spec.station ? { station: spec.station(i) } : {}),
    }))
  }
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, lines.join('\n') + (lines.length ? '\n' : ''))
  return dir
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A walk along +x, one frame every 0.3 m, camera looking along the pose's yaw (the identity calibration puts it there). */
const walk = (z: number, yawDeg = 0) => (i: number) => ({ x: i * 0.3, y: 1.5, z, yawDeg })

interface StubModels {
  /** Which first-pass model an image registers in (0, 1, ...), or null for none. */
  firstPass?: (name: string) => number | null
  /** Registers in the grown model. Default: the images of first-pass model 0. */
  grown?: (name: string) => boolean
  /** Per-session lens the stub reports, by session id. Default: f = 1000 + 10 * index. */
  focal?: (sessionId: string) => number
}

/** A stubbed COLMAP: records every call, and writes models for the mapper steps from the frames it finds. */
function stubColmap(models: StubModels = {}, failWhen?: (args: string[]) => string | null) {
  const calls: string[][] = []
  const spawn: Spawn = async (_bin, args) => {
    calls.push(args)
    const failure = failWhen?.(args)
    if (failure) return { code: 1, stderr: failure }
    if (args[0] === 'mapper') {
      const imagesDir = args[args.indexOf('--image_path') + 1]!
      const out = args[args.indexOf('--output_path') + 1]!
      const grow = args.includes('--input_path')
      const sessions: string[] = []
      for await (const entry of Deno.readDir(imagesDir)) if (entry.isDirectory) sessions.push(entry.name)
      sessions.sort()
      const names: string[] = []
      for (const id of sessions) {
        const files: string[] = []
        for await (const entry of Deno.readDir(`${imagesDir}/${id}`)) files.push(entry.name)
        files.sort()
        for (const f of files) names.push(`${id}/${f}`)
      }
      const camOf = (name: string) => sessions.indexOf(name.split('/')[0]!) + 1
      const cameras: StubCamera[] = sessions.map((id, k) => ({
        id: k + 1,
        w: 1280,
        h: 720,
        params: [models.focal ? models.focal(id) : 1000 + 10 * k, 640, 360, 0],
      }))
      const write = async (dir: string, chosen: string[]) => {
        await Deno.mkdir(dir, { recursive: true })
        const images: StubImage[] = chosen.map((name, i) => ({
          id: i + 1,
          q: quatAboutY(i * 3),
          t: [-i * 0.2, 0, 0],
          cam: camOf(name),
          name,
        }))
        await Deno.writeFile(`${dir}/images.bin`, encodeImagesBin(images))
        await Deno.writeFile(`${dir}/cameras.bin`, encodeCamerasBin(cameras))
        await Deno.writeFile(`${dir}/points3D.bin`, encodePoints3DBin(500, 0.4))
      }
      if (!grow) {
        const of = models.firstPass ?? (() => 0)
        const byModel = new Map<number, string[]>()
        for (const name of names) {
          const m = of(name)
          if (m !== null) byModel.set(m, [...(byModel.get(m) ?? []), name])
        }
        for (const [m, chosen] of byModel) await write(`${out}/${m}`, chosen)
      } else {
        const keep = models.grown ?? ((name: string) => (models.firstPass ?? (() => 0))(name) === 0)
        await write(out, names.filter(keep))
      }
    }
    return { code: 0, stderr: '' }
  }
  return { calls, spawn }
}

const tidy = async (dir: string) => await Deno.remove(dir, { recursive: true })

// ─── The layout and the cameras COLMAP is given ──────────────────────────────

Deno.test('a joint solve lays each session in its own folder and gives each folder its own camera, started from its own field of view', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, size: [1280, 720], fovYDeg: 62, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, size: [720, 1280], fovYDeg: 70, pose: walk(1) })
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [
        { sessionDir: a, placement: { sessionToProject: IDENTITY, epoch: 0 } },
        { sessionDir: b, placement: { sessionToProject: IDENTITY, epoch: 0 } },
      ],
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok', result.manifest.error ?? result.manifest.skippedReason)

    // Images are linked under images/<sessionId>/, nothing flat.
    for (const [id, n] of [['sess-aaaa', 6], ['sess-bbbb', 5]] as const) {
      const files: string[] = []
      for await (const entry of Deno.readDir(`${outDir}/colmap-work/images/${id}`)) files.push(entry.name)
      assertEquals(files.sort(), Array.from({ length: n }, (_, i) => frameName(i)))
    }
    assertEquals(await Deno.readTextFile(`${outDir}/colmap-work/lists/sess-bbbb.txt`), Array.from({ length: 5 }, (_, i) => `sess-bbbb/${frameName(i)}`).join('\n') + '\n')

    // One feature_extractor call per session, one camera per folder, each with its own prior.
    const extracts = stub.calls.filter((c) => c[0] === 'feature_extractor')
    assertEquals(extracts.length, 2)
    for (const call of extracts) {
      assert(call.includes('--ImageReader.single_camera_per_folder'), 'one camera per folder')
      assert(!call.includes('--ImageReader.single_camera'), 'never one shared camera across sessions')
      assertEquals(call[call.indexOf('--image_path') + 1], `${outDir}/colmap-work/images`)
    }
    const listOf = (call: string[]) => call[call.indexOf('--image_list_path') + 1]
    assertEquals(extracts.map(listOf), [`${outDir}/colmap-work/lists/sess-aaaa.txt`, `${outDir}/colmap-work/lists/sess-bbbb.txt`])
    // f = height / (2 tan(fovY / 2)): 720 / (2 tan 31 degrees) for the landscape session; 1280 / (2 tan 35 degrees) for the portrait one.
    const fA = 720 / (2 * Math.tan((62 * Math.PI) / 360))
    const fB = 1280 / (2 * Math.tan((70 * Math.PI) / 360))
    assertEquals(extracts[0]![extracts[0]!.indexOf('--ImageReader.camera_params') + 1], `${Number(fA.toFixed(4))},640,360,0`)
    assertEquals(extracts[1]![extracts[1]!.indexOf('--ImageReader.camera_params') + 1], `${Number(fB.toFixed(4))},360,640,0`)
    assert(Math.abs(fA - fB) > 100, 'the two phones really are described differently')
    // The shared options are the single-session ones.
    for (const call of extracts) {
      assertEquals(call[call.indexOf('--ImageReader.camera_model') + 1], 'SIMPLE_RADIAL')
      assert(call.includes('--FeatureExtraction.use_gpu') && call[call.indexOf('--FeatureExtraction.use_gpu') + 1] === '0', 'CPU only')
      assert(call.includes('--SiftExtraction.max_image_size') && call.includes('--FeatureExtraction.type'))
    }

    // The step order: features, matches, mapper, grow.
    assertEquals(stub.calls.map((c) => c[0]), ['feature_extractor', 'feature_extractor', 'matches_importer', 'mapper', 'mapper'])

    // The per-session report carries the prior.
    const [ra, rb] = result.sessions
    assertEquals(ra!.prior.source, 'keyframe-fov')
    assertEquals(ra!.prior.width, 1280)
    assertEquals(rb!.prior.height, 1280)
    assertEquals(result.manifest.mode, 'joint')
    assertEquals(result.manifest.gravityAligned, false)
  } finally {
    await tidy(dir)
  }
})

Deno.test('a session that reported no field of view is left to COLMAP\'s own default, not given a made-up prior', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, fovYDeg: null, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, fovYDeg: 65, pose: walk(1) })
    const stub = stubColmap()
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    const [first, second] = stub.calls.filter((c) => c[0] === 'feature_extractor')
    assert(!first!.includes('--ImageReader.camera_params'), 'no recorded field of view, no prior')
    assert(second!.includes('--ImageReader.camera_params'))
    assertEquals(result.sessions[0]!.prior.source, 'colmap-default')
    assertEquals(result.sessions[0]!.prior.params, null)
  } finally {
    await tidy(dir)
  }
})

Deno.test('a session whose frames come in two sizes keeps the size most of them have and reports the rest', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // A phone turned to landscape for frames 6 and 7: COLMAP refuses one camera with two image sizes.
    const a = await writeSession(`${dir}/sessions`, {
      id: 'sess-aaaa',
      frames: 8,
      sizeOf: (i) => (i >= 6 ? [1280, 720] : [720, 1280]),
      pose: walk(0),
    })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    const report = result.sessions[0]!
    assertEquals(report.offered, 6)
    assertEquals(report.skipped, [{ file: frameName(6), reason: 'size-mismatch' }, { file: frameName(7), reason: 'size-mismatch' }])
    assertEquals([report.prior.width, report.prior.height], [720, 1280])
    const files: string[] = []
    for await (const entry of Deno.readDir(`${outDir}/colmap-work/images/sess-aaaa`)) files.push(entry.name)
    assertEquals(files.sort(), Array.from({ length: 6 }, (_, i) => frameName(i)))
  } finally {
    await tidy(dir)
  }
})

Deno.test('an unreadable frame is left out and reported, and a frame with no keyframe record still goes to COLMAP', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0), unrecorded: (i) => i === 2 })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    await Deno.writeFile(`${a}/${frameName(4)}`, new Uint8Array([1, 2, 3])) // not a JPEG
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    assertEquals(result.sessions[0]!.skipped, [{ file: frameName(4), reason: 'unreadable' }])
    assertEquals(result.sessions[0]!.offered, 5)
    // The unrecorded frame 2 is among the images, and keeps its sequence neighbours in the pair list.
    const pairs = (await Deno.readTextFile(`${outDir}/colmap-work/pairs.txt`)).trim().split('\n')
    assert(pairs.some((line) => line.includes(`sess-aaaa/${frameName(2)}`)), 'frame 2 is matched')
  } finally {
    await tidy(dir)
  }
})

// ─── Matching ────────────────────────────────────────────────────────────────

Deno.test('posed sessions are matched through a pair list: sequence neighbours and the frames that can overlap', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 12, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 12, pose: walk(2) })
    const c = await writeSession(`${dir}/sessions`, { id: 'sess-cccc', frames: 12, pose: walk(0.5, 180) }) // facing the other way: no cross pair with a or b
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b, c].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    // c is isolated by the angle gate, so the planner falls back to every pair (36 images are within the limit).
    assertEquals(result.manifest.matching?.kind, 'exhaustive')
    assert(result.manifest.matching?.why?.includes('sess-cccc'), result.manifest.matching?.why)
    assertEquals(result.manifest.matching?.pairCount, exhaustivePairCount(36))
    assertEquals(stub.calls.map((call) => call[0]), [
      'feature_extractor', 'feature_extractor', 'feature_extractor', 'exhaustive_matcher', 'mapper', 'mapper',
    ])
    const matcher = stub.calls.find((call) => call[0] === 'exhaustive_matcher')!
    assert(!matcher.includes('--match_list_path'))

    // Without c, a and b are tied by the poses and are matched by their pair list.
    const stub2 = stubColmap()
    const outDir2 = `${dir}/joint2`
    const second = await runColmapJointPoses({
      outDir: outDir2,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub2.spawn,
    })
    assertEquals(second.manifest.matching?.kind, 'pairs')
    const importer = stub2.calls.find((call) => call[0] === 'matches_importer')!
    assertEquals(importer[importer.indexOf('--match_type') + 1], 'pairs')
    assertEquals(importer[importer.indexOf('--match_list_path') + 1], `${outDir2}/colmap-work/pairs.txt`)
    assert(!stub2.calls.some((call) => call[0] === 'exhaustive_matcher'))
    const lines = (await Deno.readTextFile(`${outDir2}/colmap-work/pairs.txt`)).trim().split('\n')
    assertEquals(lines.length, second.manifest.matching?.pairCount)
    assert(lines.length < exhaustivePairCount(24), 'fewer pairs than matching every image with every other')
    assert(lines.some((l) => l.startsWith('sess-aaaa/') && l.includes(' sess-bbbb/')), 'cross-session pairs are there')
    assert(lines.every((l) => /^sess-[a-z]+\/kf-\d{5}\.jpg sess-[a-z]+\/kf-\d{5}\.jpg$/.test(l)))
    assertEquals(lines, [...lines].sort(), 'sorted, so the same sessions give the same file')
  } finally {
    await tidy(dir)
  }
})

Deno.test('sessions with no Place poses are matched exhaustively when they are few, and not at all when they are many', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // Unplaced: no calibration passed, so no frame has a pose in the Place frame.
    const small1 = await writeSession(`${dir}/small`, { id: 'sess-aaaa', frames: 8 })
    const small2 = await writeSession(`${dir}/small`, { id: 'sess-bbbb', frames: 8 })
    const stub = stubColmap()
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint-small`,
      sessions: [{ sessionDir: small1 }, { sessionDir: small2 }],
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    assertEquals(result.manifest.matching?.kind, 'exhaustive')
    assertEquals(result.manifest.matching?.pairCount, 120)
    assert(stub.calls.some((call) => call[0] === 'exhaustive_matcher'))

    // 120 images across two unplaced sessions: more than exhaustive matching is allowed to take on.
    const big1 = await writeSession(`${dir}/big`, { id: 'sess-aaaa', frames: 60 })
    const big2 = await writeSession(`${dir}/big`, { id: 'sess-bbbb', frames: 60 })
    const stub2 = stubColmap()
    const refused = await runColmapJointPoses({
      outDir: `${dir}/joint-big`,
      sessions: [{ sessionDir: big1 }, { sessionDir: big2 }],
      colmapBin: Deno.execPath(),
      _spawn: stub2.spawn,
    })
    assertEquals(refused.status, 'skipped')
    assertEquals(stub2.calls.length, 0, 'nothing was run')
    assert(refused.manifest.skippedReason?.includes('up to 100 images'), refused.manifest.skippedReason)
    assert(refused.manifest.skippedReason?.includes('7,140'), refused.manifest.skippedReason)
    assert(refused.manifest.remediation?.includes('fewer keyframes'), refused.manifest.remediation)
    // Skipped, but the manifest is still written, saying why.
    const written = JSON.parse(await Deno.readTextFile(`${dir}/joint-big/colmap-joint.manifest.json`))
    assertEquals(written.status, 'skipped')
  } finally {
    await tidy(dir)
  }
})

Deno.test('a handed-in exhaustive plan is held to the same image limit as one made here', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 60 })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 60 })
    const stub = stubColmap()
    const plan: MatchingPlan = {
      kind: 'exhaustive',
      pairCount: exhaustivePairCount(120),
      why: 'handed in',
      stats: {
        imageCount: 120, sessionCount: 2, posedImages: 0, sequencePairs: 0, revisitPairs: 0, crossSessionPairs: 0,
        totalPairs: 0, exhaustivePairs: exhaustivePairCount(120), sessions: [], groups: [], isolatedSessions: [],
      },
    }
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [{ sessionDir: a }, { sessionDir: b }],
      matching: plan,
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'skipped')
    assertEquals(stub.calls.length, 0)
    assert(result.manifest.skippedReason?.includes('up to 100 images'), result.manifest.skippedReason)
  } finally {
    await tidy(dir)
  }
})

Deno.test('a matching plan can be handed in, and is what is run', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 4 })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 4 })
    const plan: MatchingPlan = {
      kind: 'pairs',
      pairs: [{ a: 'sess-aaaa/kf-00000.jpg', b: 'sess-bbbb/kf-00003.jpg', kind: 'cross-session' }],
      stats: {
        imageCount: 8, sessionCount: 2, posedImages: 0, sequencePairs: 0, revisitPairs: 0, crossSessionPairs: 1,
        totalPairs: 1, exhaustivePairs: 28, sessions: [], groups: [], isolatedSessions: [],
      },
    }
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [{ sessionDir: a }, { sessionDir: b }],
      matching: plan,
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    assertEquals(await Deno.readTextFile(`${outDir}/colmap-work/pairs.txt`), 'sess-aaaa/kf-00000.jpg sess-bbbb/kf-00003.jpg\n')
  } finally {
    await tidy(dir)
  }
})

// ─── What comes out, and which sessions joined ───────────────────────────────

Deno.test('the poses are keyed by the whole path, so two sessions\' first frames are two entries and pair with their own recorded centres', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, pose: walk(1) })
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    assertEquals(result.registeredImages, 12)

    const written = JSON.parse(await Deno.readTextFile(`${outDir}/colmap.poses.json`)) as {
      cameras: Record<string, { fx: number }>
      camera?: unknown
      frames: Array<{ file: string }>
    }
    assertEquals(written.camera, undefined, 'no single lens for a joint solve')
    assertEquals(Object.keys(written.cameras).sort(), ['sess-aaaa', 'sess-bbbb'])
    assertEquals(written.cameras['sess-aaaa']!.fx, 1000)
    assertEquals(written.cameras['sess-bbbb']!.fx, 1010)
    assertEquals(new Set(written.frames.map((f) => f.file)).size, 12, 'twelve distinct keys')
    assert(written.frames.every((f) => /^sess-[ab]{4}\/kf-\d{5}\.jpg$/.test(f.file)))

    // The reader the splat-align stage uses reads it back under those keys, a single-session camera reader finds none.
    const solved = await readSolvedPoses(outDir)
    assert(solved)
    assertEquals([...solved.keys()].sort()[0], 'sess-aaaa/kf-00000.jpg')
    assertEquals(await readSolvedCamera(outDir), null)

    // The solved centres and each session's recorded centres share their keys, so pairByFilename pairs frame for frame.
    const solverCentres = sfmCentresFromPoses(solved)
    for (const [id, dirOf] of [['sess-aaaa', a], ['sess-bbbb', b]] as const) {
      const recorded = sessionCentres(await readKeyframes(dirOf), id, 0)
      assertEquals(recorded.size, 6)
      const { files } = pairByFilename(solverCentres, recorded)
      assertEquals(files, Array.from({ length: 6 }, (_, i) => frameKey(id, frameName(i))))
    }
  } finally {
    await tidy(dir)
  }
})

Deno.test('a basename key would have collided; the joint key does not', () => {
  const images = [
    { imageId: 1, qvec: [1, 0, 0, 0] as [number, number, number, number], tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'sess-aaaa/kf-00000.jpg' },
    { imageId: 2, qvec: [1, 0, 0, 0] as [number, number, number, number], tvec: [1, 0, 0] as [number, number, number], cameraId: 2, name: 'sess-bbbb/kf-00000.jpg' },
  ]
  assertEquals(buildPosesJson(images).frames.map((f) => f.file), ['kf-00000.jpg', 'kf-00000.jpg'])
  assertEquals(buildJointPosesJson(images, {}).frames.map((f) => f.file), ['sess-aaaa/kf-00000.jpg', 'sess-bbbb/kf-00000.jpg'])
  assertEquals(cameraCentres(images).size, 1, 'the single-session key keeps one of the two')
  assertEquals(cameraCentres(images, { keepFolder: true }).size, 2)
})

Deno.test('a session COLMAP builds as a model of its own did not join, and the report says so', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, pose: walk(1) })
    const c = await writeSession(`${dir}/sessions`, { id: 'sess-cccc', frames: 4, pose: walk(2) })
    // a and b are one model; c is another; the grow pass attaches nothing; one frame of b registers nowhere.
    const stub = stubColmap({
      firstPass: (name) => (name === `sess-bbbb/${frameName(5)}` ? null : name.startsWith('sess-cccc') ? 1 : 0),
    })
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b, c].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok', 'COLMAP ran and produced a model; some sessions did not join it')
    const [ra, rb, rc] = result.sessions
    assertEquals([ra!.registered, ra!.inOtherModels, ra!.unregistered], [6, 0, 0])
    assertEquals([rb!.registered, rb!.inOtherModels, rb!.unregistered], [5, 0, 1])
    assertEquals([rc!.registered, rc!.inOtherModels, rc!.unregistered], [0, 4, 0])
    assertEquals(result.registeredImages, 11)

    const models = result.manifest.models!
    assertEquals(models.length, 2)
    assertEquals(models[0], { images: 11, bySession: { 'sess-aaaa': 6, 'sess-bbbb': 5, 'sess-cccc': 0 } })
    assertEquals(models[1], { images: 4, bySession: { 'sess-aaaa': 0, 'sess-bbbb': 0, 'sess-cccc': 4 } })
    assertEquals(rc!.solvedCamera, undefined, 'a session with nothing in the model has no solved lens')
    assertEquals(ra!.cameraIds, [1])
  } finally {
    await tidy(dir)
  }
})

Deno.test('the grow pass is seeded from the largest first-pass model, wherever COLMAP numbered it', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 4, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 7, pose: walk(1) })
    // The smaller session is model 0, the larger one model 1.
    const stub = stubColmap({ firstPass: (name) => (name.startsWith('sess-aaaa') ? 0 : 1), grown: (name) => name.startsWith('sess-bbbb') })
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    const grow = stub.calls.filter((c) => c[0] === 'mapper')[1]!
    assertEquals(grow[grow.indexOf('--input_path') + 1], `${outDir}/colmap-work/sparse/1`)
    assertEquals(result.manifest.models!.map((m) => m.images), [7, 4], 'largest first in the report')
    assertEquals(result.sessions.map((s) => [s.sessionId, s.registered, s.inOtherModels]), [['sess-aaaa', 0, 4], ['sess-bbbb', 7, 0]])
  } finally {
    await tidy(dir)
  }
})

Deno.test('first-pass models of one size: the grow pass starts from the first by directory name, whatever order they were made in', async () => {
  // The stub makes models in the order their frames first appear, so putting sess-aaaa in model 1 or in model 0 makes the
  // directories in the order 1, 0 or 0, 1. Whichever order a listing comes back in, the first by name is the seed.
  for (const aaaaIs of [1, 0] as const) {
    const dir = await Deno.makeTempDir()
    try {
      const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
      const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
      const stub = stubColmap({ firstPass: (name) => (name.startsWith('sess-aaaa') ? aaaaIs : 1 - aaaaIs), grown: () => true })
      const outDir = `${dir}/joint`
      const result = await runColmapJointPoses({
        outDir,
        sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
        colmapBin: Deno.execPath(),
        _spawn: stub.spawn,
      })
      assertEquals(result.status, 'ok')
      const grow = stub.calls.filter((c) => c[0] === 'mapper')[1]!
      assertEquals(grow[grow.indexOf('--input_path') + 1], `${outDir}/colmap-work/sparse/0`, `sess-aaaa in model ${aaaaIs}`)
    } finally {
      await tidy(dir)
    }
  }
})

Deno.test('each session reports the lens COLMAP fitted to it, and a session that joins through the grow pass counts as joined', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, pose: walk(1) })
    // First pass: b is a model of its own. The grow pass registers everything.
    const stub = stubColmap({
      firstPass: (name) => (name.startsWith('sess-bbbb') ? 1 : 0),
      grown: () => true,
      focal: (id) => (id === 'sess-aaaa' ? 1100.25 : 870.5),
    })
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    const [ra, rb] = result.sessions
    assertEquals(ra!.solvedCamera, { fx: 1100.25, fy: 1100.25, cx: 640, cy: 360, width: 1280, height: 720 })
    assertEquals(rb!.solvedCamera!.fx, 870.5)
    assertEquals([rb!.registered, rb!.inOtherModels], [6, 0], 'attached by the grow pass, so joined')
    assertEquals(result.manifest.models!.length, 2, 'the first pass is still on the record')
    assertEquals(result.manifest.pointCount, 500)
    assert(Math.abs((result.manifest.meanReprojectionErrorPx ?? 0) - 0.4) < 1e-9)
  } finally {
    await tidy(dir)
  }
})

// ─── Refusals and failures ───────────────────────────────────────────────────

Deno.test('a joint solve needs two distinct sessions, a session id for each and a work directory of its own', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const stub = stubColmap()
    const run = (sessions: string[], outDir = `${dir}/joint`) =>
      runColmapJointPoses({ outDir, sessions: sessions.map((sessionDir) => ({ sessionDir })), colmapBin: Deno.execPath(), _spawn: stub.spawn })

    const one = await run([a])
    assertEquals(one.status, 'error')
    assert(one.manifest.error?.includes('at least two'), one.manifest.error)

    const twice = await run([a, `${a}/`])
    assertEquals(twice.status, 'error')
    assert(twice.manifest.error?.includes('same directory'), twice.manifest.error)

    await Deno.mkdir(`${dir}/not-a-session`)
    const bad = await run([a, `${dir}/not-a-session`])
    assertEquals(bad.status, 'error')
    assert(bad.manifest.error?.includes('not-a-session'), bad.manifest.error)

    const inside = await run([a, b], `${a}/joint`)
    assertEquals(inside.status, 'error')
    assert(inside.manifest.error?.includes('outDir'), inside.manifest.error)
    const same = await run([a, b], b)
    assertEquals(same.status, 'error')

    assertEquals(stub.calls.length, 0)
    // Nothing was written into a session directory by the refused run.
    const names: string[] = []
    for await (const entry of Deno.readDir(a)) names.push(entry.name)
    assert(!names.includes('joint'), 'no work directory made inside a session')
  } finally {
    await tidy(dir)
  }
})

Deno.test('sessions are solved and reported in session-id order, whatever order they are listed in', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, pose: walk(1) })
    const run = async (order: string[]) => {
      const stub = stubColmap()
      const result = await runColmapJointPoses({
        outDir: `${dir}/joint`,
        sessions: order.map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
        colmapBin: Deno.execPath(),
        _spawn: stub.spawn,
      })
      return { stub, result }
    }
    const forward = await run([a, b])
    const backward = await run([b, a])
    const listOrder = (calls: string[][]) =>
      calls.filter((c) => c[0] === 'feature_extractor').map((c) => c[c.indexOf('--image_list_path') + 1]!.split('/').pop())
    assertEquals(listOrder(forward.stub.calls), ['sess-aaaa.txt', 'sess-bbbb.txt'])
    assertEquals(listOrder(backward.stub.calls), ['sess-aaaa.txt', 'sess-bbbb.txt'])
    assertEquals(backward.result.sessions.map((s) => s.sessionId), ['sess-aaaa', 'sess-bbbb'])
    assertEquals(backward.result.manifest.inputFingerprint, forward.result.manifest.inputFingerprint)
    assertEquals(backward.result.manifest.reusedWorkspace, true, 'the same sessions are the same solve')
    assertEquals(
      (await Deno.readTextFile(`${dir}/joint/colmap-work/pairs.txt`)).length > 0,
      true,
    )
  } finally {
    await tidy(dir)
  }
})

Deno.test('a session directory that does not exist is an error naming the session', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const stub = stubColmap()
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [{ sessionDir: a }, { sessionDir: `${dir}/sessions/sess-gone` }],
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'error')
    assert(result.manifest.error?.includes('sess-gone'), result.manifest.error)
    assertEquals(stub.calls.length, 0)
  } finally {
    await tidy(dir)
  }
})

Deno.test('too few frames, or only one session with any, is skipped with a capture hint', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5 })
    const empty = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 0 })
    const one = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [{ sessionDir: a }, { sessionDir: empty }],
      colmapBin: Deno.execPath(),
      _spawn: stubColmap().spawn,
    })
    assertEquals(one.status, 'skipped')
    assert(one.manifest.skippedReason?.includes('only 1 session'), one.manifest.skippedReason)

    const tiny1 = await writeSession(`${dir}/tiny`, { id: 'sess-cccc', frames: 1 })
    const tiny2 = await writeSession(`${dir}/tiny`, { id: 'sess-dddd', frames: 1 })
    const few = await runColmapJointPoses({
      outDir: `${dir}/joint2`,
      sessions: [{ sessionDir: tiny1 }, { sessionDir: tiny2 }],
      colmapBin: Deno.execPath(),
      _spawn: stubColmap().spawn,
    })
    assertEquals(few.status, 'skipped')
    assert(few.manifest.skippedReason?.includes('at least 3'), few.manifest.skippedReason)
    assert(few.manifest.remediation?.includes('parallax'))
  } finally {
    await tidy(dir)
  }
})

Deno.test('a missing COLMAP is a skip, as for one session', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [{ sessionDir: a }, { sessionDir: b }],
      colmapBin: `${dir}/no-such-colmap`,
    })
    assertEquals(result.status, 'skipped')
    assert(result.manifest.skippedReason?.includes('no-such-colmap'))
    assert(result.manifest.remediation?.includes('COLMAP_BIN'))
  } finally {
    await tidy(dir)
  }
})

Deno.test('a failing feature extraction names the session it failed on and stops there', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const stub = stubColmap({}, (args) =>
      args[0] === 'feature_extractor' && args.some((a) => a.endsWith('sess-bbbb.txt'))
        ? 'E Failed to parse options - unrecognised option\nE Could not use the same camera for all images'
        : null)
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'error')
    assertEquals(result.exitCode, 2)
    assert(result.manifest.error?.startsWith('feature_extractor(sess-bbbb) failed (exit 1)'), result.manifest.error)
    assert(result.manifest.error?.includes('Could not use the same camera'), 'COLMAP\'s own last words reach the manifest')
    assertEquals(stub.calls.map((call) => call[0]), ['feature_extractor', 'feature_extractor'], 'nothing after the failure')
  } finally {
    await tidy(dir)
  }
})

Deno.test('a mapper that registers nothing is the rotation-only error, not an empty model', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stubColmap({ firstPass: () => null }).spawn,
    })
    assertEquals(result.status, 'error')
    assert(result.manifest.error?.includes('rotation-only'), result.manifest.error)
    assert(result.manifest.remediation?.includes('walking'))
  } finally {
    await tidy(dir)
  }
})

// ─── The workspace is never one solve's answer for another's frames ──────────

Deno.test('a re-run over the same sessions reuses the workspace; a change to the frames, the pairs or a camera does not', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const mk = async (fov: number, bytesSalt = 0) => {
      const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, fovYDeg: fov, pose: walk(0) })
      const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, fovYDeg: 62, pose: walk(1) })
      if (bytesSalt) await Deno.writeFile(`${b}/${frameName(0)}`, jpegHeader(1280, 720, 200 + bytesSalt))
      return [a, b]
    }
    const run = async (dirs: string[], placements: number[][] = [IDENTITY, IDENTITY]) =>
      await runColmapJointPoses({
        outDir: `${dir}/joint`,
        sessions: dirs.map((sessionDir, i) => ({ sessionDir, placement: { sessionToProject: placements[i]!, epoch: 0 } })),
        colmapBin: Deno.execPath(),
        _spawn: stubColmap().spawn,
      })

    const dirs = await mk(62)
    const first = await run(dirs)
    assertEquals(first.manifest.reusedWorkspace, false)
    const again = await run(dirs)
    assertEquals(again.manifest.reusedWorkspace, true)
    assertEquals(again.manifest.inputFingerprint, first.manifest.inputFingerprint)

    // Different frame bytes, same names.
    await mk(62, 1)
    const changedFrames = await run(dirs)
    assertEquals(changedFrames.manifest.reusedWorkspace, false)
    assert(changedFrames.manifest.inputFingerprint !== first.manifest.inputFingerprint)

    // A different camera prior (the keyframes reported another field of view).
    await mk(75, 1)
    const changedCamera = await run(dirs)
    assertEquals(changedCamera.manifest.reusedWorkspace, false)

    // Both sessions shifted by the same amount in the Place frame: the same pairs from the same frames, nothing to redo.
    const shifted = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 0, 0, 1]
    const sameShift = await run(dirs, [shifted, shifted])
    assertEquals(sameShift.manifest.reusedWorkspace, true)

    // One session moved 1.8 m sideways: still tied by pairs, but a different list of them, so the matching differs and so does the answer.
    const sideways = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1.8, 1]
    const sameKind = await run(dirs, [IDENTITY, sideways])
    assertEquals(sameKind.manifest.matching?.kind, 'pairs')
    assertEquals(sameKind.manifest.reusedWorkspace, false)
    assert(
      sameKind.manifest.matching!.pairCount !== (await run(dirs, [IDENTITY, IDENTITY])).manifest.matching!.pairCount,
      'the two placements ask for different pairs',
    )

    // One session moved 40 m away from the other: no pair ties them any more, so the matching changes and so does the answer.
    const apart = await run(dirs, [IDENTITY, shifted])
    assertEquals(apart.manifest.matching?.kind, 'exhaustive')
    assertEquals(apart.manifest.reusedWorkspace, false)
  } finally {
    await tidy(dir)
  }
})

Deno.test('a re-run does not inherit the poses or the models of the run before it', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 6, pose: walk(1) })
    const outDir = `${dir}/joint`
    const run = (stub: ReturnType<typeof stubColmap>) =>
      runColmapJointPoses({
        outDir,
        sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
        colmapBin: Deno.execPath(),
        _spawn: stub.spawn,
      })

    // First run: two models (b did not join).
    const first = await run(stubColmap({ firstPass: (name) => (name.startsWith('sess-bbbb') ? 1 : 0) }))
    assertEquals(first.manifest.models!.length, 2)
    await Deno.stat(`${outDir}/colmap.poses.json`)

    // Second run over the same frames reuses the workspace; COLMAP now builds one model. The old `sparse/1` must not count.
    const second = await run(stubColmap())
    assertEquals(second.manifest.reusedWorkspace, true)
    assertEquals(second.manifest.models!.length, 1, 'only the models of this run')
    assertEquals(second.sessions.map((s) => s.inOtherModels), [0, 0])

    // Third run fails; the poses of the second must not be left lying about as if they were its own.
    const failed = await run(stubColmap({}, (args) => (args[0] === 'mapper' ? 'E mapper failed' : null)))
    assertEquals(failed.status, 'error')
    let stale = true
    try {
      await Deno.stat(`${outDir}/colmap.poses.json`)
    } catch {
      stale = false
    }
    assertEquals(stale, false, 'no colmap.poses.json after a failed run')
  } finally {
    await tidy(dir)
  }
})

// ─── Where the work goes ─────────────────────────────────────────────────────

Deno.test('locationOf says where a path really is: absolute, normalised, links resolved, the part not yet made kept as written', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const real = await Deno.realPath(dir)
    await Deno.mkdir(`${dir}/a/b`, { recursive: true })
    await Deno.symlink(`${dir}/a`, `${dir}/link`)
    assertEquals(await locationOf(`${dir}/a/b/`), `${real}/a/b`)
    assertEquals(await locationOf(`${dir}/a/./b/../b`), `${real}/a/b`)
    assertEquals(await locationOf(`${dir}/link/b`), `${real}/a/b`, 'through a symbolic link')
    assertEquals(await locationOf(`${dir}/link/new/deeper`), `${real}/a/new/deeper`, 'what does not exist yet, below what does')
    assertEquals(await locationOf(relative(Deno.cwd(), `${dir}/a`)), `${real}/a`, 'a relative spelling')
    assertEquals(await locationOf('/'), '/')
    assertEquals(await locationOf(`${dir}/not/made/../x`), `${real}/not/x`, 'a .. in a part not made yet is taken back up the path')
    // A `..` after a link: Deno reads it by the file system under -A and as text under a permission list, so the test asks
    // where Deno itself makes the directory and requires locationOf to name that place, in whichever mode this runs in.
    await Deno.mkdir(`${dir}/deep/er`, { recursive: true })
    await Deno.symlink(`${dir}/deep/er`, `${dir}/into-er`)
    const spelling = `${dir}/into-er/../made-here`
    const named = await locationOf(spelling)
    assert([`${real}/made-here`, `${real}/deep/made-here`].includes(named), named)
    await Deno.mkdir(spelling)
    assert((await Deno.stat(named)).isDirectory, `${named} is where it was made`)
  } finally {
    await tidy(dir)
  }
})

Deno.test('outDir may not be a session directory or inside one, however either is spelled, and may sit beside one', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    await Deno.symlink(a, `${dir}/link-to-a`)
    // A link named like a session, as a session directory reached through a link would be, and a link into a directory
    // inside a session.
    await Deno.mkdir(`${dir}/links`)
    await Deno.symlink(a, `${dir}/links/sess-aaaa`)
    await Deno.mkdir(`${a}/sub`)
    await Deno.symlink(`${a}/sub`, `${dir}/link-to-sub`)
    const stub = stubColmap()
    const run = (outDir: string, sessions = [a, b]) =>
      runColmapJointPoses({ outDir, sessions: sessions.map((sessionDir) => ({ sessionDir })), colmapBin: Deno.execPath(), _spawn: stub.spawn })

    const relativeA = relative(Deno.cwd(), a)
    const spellings = [
      a, `${a}/`, `${a}/joint`, `${a}//joint/`, `${a}/./joint/../joint/deeper`, `${dir}/sessions/../sessions/sess-aaaa/joint`,
      relativeA, `${relativeA}/joint`, // the one place, spelled from where the tests run
      `${dir}/link-to-a`, `${dir}/link-to-a/joint`, // through a symbolic link
    ]
    for (const outDir of spellings) {
      const refused = await run(outDir)
      assertEquals(refused.status, 'error', outDir)
      assert(refused.manifest.error?.includes('outDir') && refused.manifest.error.includes('sess-aaaa'), `${outDir}: ${refused.manifest.error}`)
    }
    // A session reached through a link that carries its id, the work directory through the real path.
    const viaLink = await run(`${a}/joint`, [`${dir}/links/sess-aaaa`, b])
    assertEquals(viaLink.status, 'error')
    assert(viaLink.manifest.error?.includes('outDir') && viaLink.manifest.error.includes('sess-aaaa'), viaLink.manifest.error)

    assertEquals(stub.calls.length, 0)
    const names: string[] = []
    for await (const entry of Deno.readDir(a)) names.push(entry.name)
    assert(!names.includes('joint') && !names.includes('colmap-joint.manifest.json') && !names.includes('colmap-work'), `written into a session: ${names}`)
    const inSub: string[] = []
    for await (const entry of Deno.readDir(`${a}/sub`)) inSub.push(entry.name)
    assertEquals(inSub, [])

    // Up from inside the session by way of the link to its sub-directory. Under -A that is the session's own joint/ and the
    // solve is refused; under a permission list Deno reads the `..` as text, which is beside the sessions' parent, and the
    // solve runs there. Either way the directory is judged where Deno makes it, and nothing is made inside the session.
    const asText = (await Deno.realPath(`${dir}/link-to-sub/..`)) === (await Deno.realPath(dir))
    const upFromLink = await run(`${dir}/link-to-sub/../joint`)
    assertEquals(upFromLink.status, asText ? 'ok' : 'error', upFromLink.manifest.error)
    for (const inside of [`${a}/joint`, `${a}/sub/joint`]) {
      assertEquals(await Deno.stat(inside).then(() => true, () => false), false, `${inside} was made`)
    }

    // A directory beside a session whose name begins with the session's is not inside it.
    const beside = await run(`${a}-work`)
    assertEquals(beside.status, 'ok', beside.manifest.error)
  } finally {
    await tidy(dir)
  }
})

// ─── Placements ──────────────────────────────────────────────────────────────

Deno.test('a placement that is not a column-major similarity is refused, naming the session, before anything is run or written', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const rowMajor = sim3ToRowMajor({ rotation: [[Math.cos(0.5), 0, Math.sin(0.5)], [0, 1, 0], [-Math.sin(0.5), 0, Math.cos(0.5)]], translation: [3, 0, -2], scale: 1 })
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [{ sessionDir: a, placement: { sessionToProject: IDENTITY, epoch: 0 } }, { sessionDir: b, placement: { sessionToProject: rowMajor, epoch: 0 } }],
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'error')
    assertEquals(result.exitCode, 2)
    assert(result.manifest.error?.includes('sess-bbbb') && result.manifest.error.includes('column-major') && result.manifest.error.includes('row-major'), result.manifest.error)
    assertEquals(stub.calls.length, 0)
    assertEquals(await Deno.stat(outDir).then(() => true, () => false), false, 'nothing was written')

    // No epoch means no frame is posed whatever the matrix is: not a placement to refuse.
    const noEpoch = await runColmapJointPoses({
      outDir,
      sessions: [{ sessionDir: a }, { sessionDir: b, placement: { sessionToProject: rowMajor, epoch: null } }],
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(noEpoch.status, 'ok')
  } finally {
    await tidy(dir)
  }
})

// ─── The pair list the driver hands COLMAP ───────────────────────────────────

Deno.test('sessions whose ids begin alike are told apart: a model\'s frames are counted under their own folder', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // sess-aaaa is a prefix of sess-aaaa-b. A match on the id without the slash would put the second's frames in the first.
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 6, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa-b', frames: 4, size: [640, 480], pose: walk(1) })
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stubColmap().spawn,
    })
    assertEquals(result.status, 'ok')
    const [first, second] = result.sessions
    assertEquals([first!.sessionId, first!.registered, first!.cameraIds], ['sess-aaaa', 6, [1]])
    assertEquals([second!.sessionId, second!.registered, second!.cameraIds], ['sess-aaaa-b', 4, [2]])
    assertEquals(result.manifest.models![0]!.bySession, { 'sess-aaaa': 6, 'sess-aaaa-b': 4 })
    assertEquals(second!.solvedCamera!.fx, 1010)
  } finally {
    await tidy(dir)
  }
})

Deno.test('a frame with no keyframe record keeps its place in capture order, so it is matched with its neighbours and not with the start', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // 30 frames, number 20 missing from keyframes.jsonl. Counted as the first frame it would pair with frames 0 to 10;
    // counted where its name puts it, with frames 10 to 30.
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 30, pose: walk(0), unrecorded: (i) => i === 20 })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const outDir = `${dir}/joint`
    const result = await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stubColmap().spawn,
    })
    assertEquals(result.status, 'ok')
    const lines = new Set((await Deno.readTextFile(`${outDir}/colmap-work/pairs.txt`)).trim().split('\n'))
    const pair = (i: number, j: number) => `sess-aaaa/${frameName(i)} sess-aaaa/${frameName(j)}`
    assert(lines.has(pair(19, 20)) && lines.has(pair(20, 21)) && lines.has(pair(20, 30 - 1)), 'its neighbours')
    assert(!lines.has(pair(1, 20)) && !lines.has(pair(0, 20)), 'and not the start of the session')
  } finally {
    await tidy(dir)
  }
})

Deno.test('two groups of sessions the poses cannot join are matched exhaustively, saying which, and the reference decides which group matters', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const sessions = [
      await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 10, pose: walk(0) }),
      await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 10, pose: walk(1) }),
      await writeSession(`${dir}/sessions`, { id: 'sess-cccc', frames: 10, pose: walk(40) }),
      await writeSession(`${dir}/sessions`, { id: 'sess-dddd', frames: 10, pose: walk(41) }),
    ]
    const run = async (pairOptions?: { referenceSessionId: string }) => {
      const outDir = `${dir}/joint-${pairOptions?.referenceSessionId ?? 'none'}`
      return await runColmapJointPoses({
        outDir,
        sessions: sessions.map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
        ...(pairOptions ? { pairOptions } : {}),
        colmapBin: Deno.execPath(),
        _spawn: stubColmap().spawn,
      })
    }
    const unnamed = await run()
    assertEquals(unnamed.manifest.matching?.kind, 'exhaustive')
    assertEquals(unnamed.manifest.matching?.pairCount, exhaustivePairCount(40))
    assertEquals(unnamed.manifest.matching?.why, 'The poses tie sess-cccc, sess-dddd to each other and not to sess-aaaa, sess-bbbb, so every pair is matched instead.')
    assertEquals(unnamed.manifest.pairStats?.groups, [['sess-aaaa', 'sess-bbbb'], ['sess-cccc', 'sess-dddd']])

    const named = await run({ referenceSessionId: 'sess-cccc' })
    assertEquals(named.manifest.matching?.why, 'The poses tie sess-aaaa, sess-bbbb to each other and not to sess-cccc, sess-dddd, so every pair is matched instead.')
  } finally {
    await tidy(dir)
  }
})

// ─── The field of view a camera starts from ──────────────────────────────────

Deno.test('a session whose every frame reports the placeholder 60 degrees has no prior, which says why', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, fovYDeg: PLACEHOLDER_FOV_Y_DEG, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, fovYDeg: 65, pose: walk(1) })
    const stub = stubColmap()
    const result = await runColmapJointPoses({
      outDir: `${dir}/joint`,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    assertEquals(result.status, 'ok')
    const [first, second] = stub.calls.filter((c) => c[0] === 'feature_extractor')
    assert(!first!.includes('--ImageReader.camera_params'), 'a placeholder is not passed to COLMAP as a lens')
    assert(second!.includes('--ImageReader.camera_params'))
    assertEquals(result.sessions[0]!.prior.source, 'colmap-default')
    assertEquals(result.sessions[0]!.prior.ignored, { placeholder: 5, implausible: 0 })
  } finally {
    await tidy(dir)
  }
})

Deno.test('a field of view outside the plausible range is left out of the prior, and counted', () => {
  assertEquals([PLAUSIBLE_FOV_Y_DEG.min, PLAUSIBLE_FOV_Y_DEG.max, PLACEHOLDER_FOV_Y_DEG], [20, 140, 60])
  const at = (fov: number, i = 0) => ({ index: i, file: `kf-${String(i).padStart(5, '0')}.jpg`, intrinsics: { fovYDeg: fov, width: 1280, height: 720 } })
  const size = { width: 1280, height: 720 }

  // Radians written as degrees, a field of view of 1 degree, and one of 175: all bugs, none a phone.
  for (const bad of [0.86, 1, 19.99, 140, 175, 359]) {
    const prior = deriveSessionCameraPrior('sess-aaaa', [at(bad)], size)
    assertEquals([prior.params, prior.source, prior.ignored], [null, 'colmap-default', { placeholder: 0, implausible: 1 }], `${bad} degrees`)
  }
  for (const good of [20.01, 45, 64.58, 90, 139.99]) {
    assertEquals(deriveSessionCameraPrior('sess-aaaa', [at(good)], size).source, 'keyframe-fov', `${good} degrees`)
  }

  // One stray among real ones is left out and the real ones make the prior.
  const mixed = deriveSessionCameraPrior('sess-aaaa', [at(1, 0), at(64, 1), at(64, 2), at(175, 3)], size)
  assertEquals([mixed.source, mixed.fovFrames, mixed.ignored], ['keyframe-fov', 2, { placeholder: 0, implausible: 2 }])
  assert(Math.abs(mixed.params![0] - 720 / (2 * Math.tan((64 * Math.PI) / 360))) < 1e-9)

  // The plausible range is on the lens at the size of the JPEG, whichever way it was reported: a focal length too long or too short is as much a bug.
  const huge = deriveSessionCameraPrior('sess-aaaa', [{ index: 0, file: 'kf-00000.jpg', intrinsics: { fx: 40_000, fy: 40_000, width: 1280, height: 720 } }], size)
  assertEquals([huge.params, huge.ignored.implausible], [null, 1])
  const sane = deriveSessionCameraPrior('sess-aaaa', [{ index: 0, file: 'kf-00000.jpg', intrinsics: { fx: 900, fy: 900, width: 1280, height: 720 } }], size)
  assertEquals([sane.params![0], sane.ignored], [900, { placeholder: 0, implausible: 0 }])

  // A recorded focal length is a measurement even when the field of view beside it is exactly 60.
  const measured = deriveSessionCameraPrior('sess-aaaa', [{ index: 0, file: 'kf-00000.jpg', intrinsics: { fovYDeg: 60, fy: 900, width: 1280, height: 720 } }], size)
  assertEquals([measured.source, measured.params![0]], ['keyframe-fov', 900])
  // The placeholder alone, on every frame, is not.
  assertEquals(deriveSessionCameraPrior('sess-aaaa', [at(60, 0), at(60, 1)], size).ignored, { placeholder: 2, implausible: 0 })
})

// ─── The models a mapper run leaves ──────────────────────────────────────────

Deno.test('listModels finds the model in the directory itself and in each sub-directory, with the image names each registered', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const write = async (path: string, names: string[]) => {
      await Deno.mkdir(path, { recursive: true })
      await Deno.writeFile(`${path}/images.bin`, encodeImagesBin(names.map((name, i) => ({ id: i + 1, q: quatAboutY(0), t: [0, 0, 0], cam: 1, name }))))
    }
    await write(`${dir}/sparse`, ['a/1.jpg'])
    await write(`${dir}/sparse/0`, ['a/1.jpg', 'a/2.jpg', 'b/1.jpg'])
    await write(`${dir}/sparse/1`, ['b/2.jpg', 'b/3.jpg', 'b/4.jpg', 'b/5.jpg'])
    await Deno.mkdir(`${dir}/sparse/empty`)
    await write(`${dir}/sparse/registered-nothing`, [])
    await Deno.mkdir(`${dir}/sparse/junk`)
    await Deno.writeFile(`${dir}/sparse/junk/images.bin`, new Uint8Array([1, 2, 3]))
    const found = (await listModels(`${dir}/sparse`)).sort((x, y) => (x.dir < y.dir ? -1 : 1))
    assertEquals(found.map((m) => [m.dir.slice(dir.length), m.count]), [['/sparse', 1], ['/sparse/0', 3], ['/sparse/1', 4]])
    assertEquals([...found[1]!.names].sort(), ['a/1.jpg', 'a/2.jpg', 'b/1.jpg'])
    assertEquals(await listModels(`${dir}/nowhere`), [])
  } finally {
    await tidy(dir)
  }
})

// ─── Cameras and the viewpoints that follow them ─────────────────────────────

Deno.test('a camera prior is the median focal length at the size of the JPEG that was uploaded', () => {
  const records = [
    { index: 0, file: 'kf-00000.jpg', intrinsics: { fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 } },
    { index: 1, file: 'kf-00001.jpg', intrinsics: { fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 } },
    { index: 2, file: 'kf-00002.jpg', intrinsics: { fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 } },
  ]
  const prior = deriveSessionCameraPrior('sess-aaaa', records, { width: 1280, height: 720 })
  assertEquals(prior.source, 'keyframe-fov')
  assertEquals(prior.fovFrames, 3)
  assertEquals(prior.focalSpreadPx, 0)
  const f = 720 / (2 * Math.tan((62 * Math.PI) / 360))
  assert(Math.abs(prior.params![0] - f) < 1e-9)
  assertEquals(prior.params!.slice(1), [640, 360, 0])
  assertEquals(cameraParamsArg(prior), `${Number(f.toFixed(4))},640,360,0`)

  // The JPEG is half the size the record described: the focal length and the centre follow it.
  const half = deriveSessionCameraPrior('sess-aaaa', records, { width: 640, height: 360 })
  assert(Math.abs(half.params![0] - f / 2) < 1e-9)
  assertEquals(half.params!.slice(1), [320, 180, 0])
})

Deno.test('a placeholder field of view on a few frames does not move the median, and shows in the spread', () => {
  const fov = [60, 60, 63, 63, 63, 63, 63, 63, 63]
  const records = fov.map((v, i) => ({ index: i, file: `kf-${String(i).padStart(5, '0')}.jpg`, intrinsics: { fovYDeg: v, width: 1280, height: 720 } }))
  const prior = deriveSessionCameraPrior('sess-aaaa', records, { width: 1280, height: 720 })
  const f63 = 720 / (2 * Math.tan((63 * Math.PI) / 360))
  const f60 = 720 / (2 * Math.tan((60 * Math.PI) / 360))
  assert(Math.abs(prior.params![0] - f63) < 1e-9, 'the median is the real lens')
  assert(Math.abs(prior.focalSpreadPx - (f60 - f63)) < 1e-9)
})

Deno.test('no field of view anywhere is no prior, not the 55 degrees deriveIntrinsics would make up', () => {
  const none = deriveSessionCameraPrior('sess-aaaa', [{ index: 0, file: 'kf-00000.jpg' }, { index: 1, file: 'kf-00001.jpg', intrinsics: {} }], { width: 1280, height: 720 })
  assertEquals(none.params, null)
  assertEquals(none.source, 'colmap-default')
  assertEquals(none.fovFrames, 0)
  assertEquals(cameraParamsArg(none), null)
  assertEquals(jointReaderArgs('/x/list.txt', none), ['--image_list_path', '/x/list.txt', '--ImageReader.single_camera_per_folder', '1'])
  // A recorded focal length counts as a report too.
  const withFocal = deriveSessionCameraPrior('sess-aaaa', [{ index: 0, file: 'kf-00000.jpg', intrinsics: { fx: 900, fy: 900, width: 1280, height: 720 } }], { width: 1280, height: 720 })
  assertEquals(withFocal.params![0], 900)
})

Deno.test('the size of a session\'s camera is the size most of its frames have, the same whatever the order', () => {
  const frames = [
    { file: 'a', width: 720, height: 1280 }, { file: 'b', width: 1280, height: 720 }, { file: 'c', width: 720, height: 1280 },
    { file: 'd', width: 1280, height: 720 }, { file: 'e', width: 640, height: 480 },
  ]
  const plan = planSessionFrames(frames)!
  // 2 against 2: the larger picture wins the tie by area (equal), then the wider one.
  assertEquals([plan.width, plan.height], [1280, 720])
  assertEquals(planSessionFrames([...frames].reverse())!.width, 1280)
  assertEquals(plan.skipped.map((s) => s.file).sort(), ['a', 'c', 'e'])
  assertEquals(plan.kept.map((f) => f.file), ['b', 'd'])
  assertEquals(planSessionFrames([]), null)
})

Deno.test('countSessionModels separates joined, another model and nowhere', () => {
  const offered = new Map([['sess-a', ['sess-a/1', 'sess-a/2', 'sess-a/3']], ['sess-b', ['sess-b/1', 'sess-b/2']]])
  const counts = countSessionModels(offered, new Set(['sess-a/1', 'sess-a/2']), [new Set(['sess-a/1', 'sess-a/2']), new Set(['sess-b/1'])])
  assertEquals(counts.get('sess-a'), { registered: 2, inOtherModels: 0, unregistered: 1 })
  assertEquals(counts.get('sess-b'), { registered: 0, inOtherModels: 1, unregistered: 1 })
})

Deno.test('the station baseline of a session in a joint solve is measured on its own frames, under its folder', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // A tripod session: two stations, three frames each, a metre and a half apart in the solve; another session beside it.
    const tripod = await writeSession(`${dir}/sessions`, {
      id: 'sess-tripod',
      frames: 6,
      station: (i) => (i < 3 ? 0 : 1),
    })
    const other = await writeSession(`${dir}/sessions`, { id: 'sess-other', frames: 3 })
    const images = (folder: string, xs: number[]) =>
      xs.map((x, i) => ({ imageId: i + 1, qvec: [1, 0, 0, 0] as [number, number, number, number], tvec: [-x, 0, 0] as [number, number, number], cameraId: 1, name: `${folder}/${frameName(i)}` }))
    const joint = [...images('sess-tripod', [0, 0.01, 0.02, 1.5, 1.51, 1.52]), ...images('sess-other', [50, 60, 70])]

    const measured = await measureSessionBaseline(tripod, joint, { folder: 'sess-tripod' })
    assert(measured, 'measured')
    assertEquals(measured.stationCount, 2)
    assertEquals(measured.placedFrameCount, 6, 'the other session\'s frames are not counted')
    assert(Math.abs(measured.minSeparation - 1.5) < 0.01, `${measured.minSeparation}`)

    // The same session solved alone, with bare filenames, measures the same thing.
    const alone = await measureSessionBaseline(tripod, images('', [0, 0.01, 0.02, 1.5, 1.51, 1.52]).map((img, i) => ({ ...img, name: frameName(i) })))
    assertEquals(alone, measured)

    // A session with no stations is not asked.
    assertEquals(await measureSessionBaseline(other, joint, { folder: 'sess-other' }), null)
  } finally {
    await tidy(dir)
  }
})

Deno.test('the first pass of the joint solve is the one `runColmapPoses` runs: same relaxed thresholds, same grow seed', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const a = await writeSession(`${dir}/sessions`, { id: 'sess-aaaa', frames: 5, pose: walk(0) })
    const b = await writeSession(`${dir}/sessions`, { id: 'sess-bbbb', frames: 5, pose: walk(1) })
    const stub = stubColmap()
    const outDir = `${dir}/joint`
    await runColmapJointPoses({
      outDir,
      sessions: [a, b].map((sessionDir) => ({ sessionDir, placement: { sessionToProject: IDENTITY, epoch: 0 } })),
      colmapBin: Deno.execPath(),
      _spawn: stub.spawn,
    })
    const [first, grow] = stub.calls.filter((c) => c[0] === 'mapper')
    assertEquals(first, [
      'mapper', '--database_path', `${outDir}/colmap-work/db.db`, '--image_path', `${outDir}/colmap-work/images`,
      '--output_path', `${outDir}/colmap-work/sparse`, '--Mapper.init_min_num_inliers', '25', '--Mapper.abs_pose_min_num_inliers', '12',
      '--Mapper.min_num_matches', '12', '--Mapper.init_min_tri_angle', '2', '--Mapper.tri_min_angle', '0.5',
    ])
    assertEquals(grow, [
      'mapper', '--database_path', `${outDir}/colmap-work/db.db`, '--image_path', `${outDir}/colmap-work/images`,
      '--input_path', `${outDir}/colmap-work/sparse/0`, '--output_path', `${outDir}/colmap-work/sparse_grown`,
      '--Mapper.abs_pose_min_num_inliers', '12', '--Mapper.min_num_matches', '12',
    ])
    // The parsed model is the grown one: its images carry the folder.
    const images = parseImagesBin(await Deno.readFile(`${outDir}/colmap-work/sparse_grown/images.bin`))
    assert(images.every((image) => image.name.includes('/')))
  } finally {
    await tidy(dir)
  }
})
