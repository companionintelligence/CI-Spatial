/**
 * Build a Companion-Scan keyframe session AND a trained-splat sidecar so the
 * splat-train integration test has something to serve, load, and screenshot.
 *
 * Why synthetic: the real trainer is Brush (a GPU binary) which can't run in
 * CI. The Deno driver's spawn surface is covered by splat_train.test.ts; what
 * the viewer test still needs is a *valid INRIA 3DGS .ply* on disk plus the
 * `<base>.splat-train.manifest.json` the world job writes. We synthesise both.
 * The data path (served .ply → SplatMesh) is identical to a real run.
 *
 * Outputs (under SCANS_DIR/):
 *   <base>.glb                        tiny placeholder scan (so /scans lists it)
 *   <base>.manifest.json              scan manifest linking to the session
 *   <base>.splat.ply                  synthetic valid 3DGS point cloud
 *   <base>.splat-train.manifest.json  status:ok manifest with gaussianCount
 *   sessions/<sessionId>/session.json
 *   sessions/<sessionId>/keyframes.jsonl
 *   sessions/<sessionId>/kf-00000.jpg …   (tiny solid JPEGs)
 *
 * Args (env or argv):
 *   --base <name>          scan base name (default splat-fixture)
 *   --session-id <id>      session id (default sess-fixture-splat)
 *   --gaussians <n>        number of gaussians in the .ply (default 2000)
 *   --frames <n>           number of keyframes (default 8)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const SCANS_DIR = process.env.SCANS_DIR || path.join(ROOT, 'scans')
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(SCANS_DIR, 'sessions')
const BASE = args.base || 'splat-fixture'
const SESSION_ID = args['session-id'] || 'sess-fixture-splat'
const GAUSSIANS = Number(args.gaussians || 2000)
const FRAMES = Number(args.frames || 8)
const SESSION_DIR = path.join(SESSIONS_DIR, SESSION_ID)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Write a minimal but valid INRIA 3DGS .ply (SH degree 0):
 *   x y z  nx ny nz  f_dc_0 f_dc_1 f_dc_2  opacity  scale_0..2  rot_0..3
 * all float32, binary_little_endian. This is the canonical property set the
 * SparkJS SplatMesh loader parses.
 */
function writeSplatPly(count) {
  const props = [
    'x', 'y', 'z',
    'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ]
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    ...props.map((p) => `property float ${p}`),
    'end_header\n',
  ].join('\n')
  const headerBytes = Buffer.from(header, 'ascii')
  const stride = props.length * 4
  const body = Buffer.alloc(count * stride)
  const rand = mulberry32(1337)
  // SH DC term for a mid-grey colour: (c - 0.5) / 0.28209479177387814
  const SH_C0 = 0.28209479177387814
  const dc = (c) => (c - 0.5) / SH_C0
  for (let i = 0; i < count; i++) {
    let off = i * stride
    // Points on the surface of a unit-ish room box.
    const side = i % 6
    let x, y, z
    switch (side) {
      case 0: x = -1 + rand() * 2; y = -1; z = -1 + rand() * 2; break
      case 1: x = -1 + rand() * 2; y = 1; z = -1 + rand() * 2; break
      case 2: x = -1; y = -1 + rand() * 2; z = -1 + rand() * 2; break
      case 3: x = 1; y = -1 + rand() * 2; z = -1 + rand() * 2; break
      case 4: x = -1 + rand() * 2; y = -1 + rand() * 2; z = -1; break
      default: x = -1 + rand() * 2; y = -1 + rand() * 2; z = 1; break
    }
    const writeF = (v) => { body.writeFloatLE(v, off); off += 4 }
    writeF(x); writeF(y); writeF(z)
    writeF(0); writeF(0); writeF(1) // normals (unused by the splat renderer)
    writeF(dc(0.4 + rand() * 0.4)) // f_dc_0
    writeF(dc(0.4 + rand() * 0.3)) // f_dc_1
    writeF(dc(0.3 + rand() * 0.4)) // f_dc_2
    writeF(4.0) // opacity logit → sigmoid(4) ≈ 0.98
    // scale is stored in log-space; exp(-3.5) ≈ 0.03 → small round splats
    writeF(-3.5); writeF(-3.5); writeF(-3.5)
    writeF(1); writeF(0); writeF(0); writeF(0) // identity rotation quaternion
  }
  return Buffer.concat([headerBytes, body])
}

/** A 1×1 white baseline JPEG (valid SOF0 so the dataset builder can read dims). */
function tinyJpeg() {
  // Precomputed minimal JPEG (1x1). Base64 of a valid baseline JPEG.
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////' +
      '////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAA' +
      'AAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64',
  )
}

/** Minimal binary glTF (.glb) — an empty but structurally valid asset. */
function tinyGlb() {
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'make-splat-fixture' },
    scenes: [{ nodes: [] }],
    scene: 0,
    nodes: [],
  }), 'utf8')
  const jsonPad = (4 - (json.length % 4)) % 4
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(jsonChunk.length, 0)
  chunkHeader.write('JSON', 4, 'ascii')
  return Buffer.concat([header, chunkHeader, jsonChunk])
}

async function main() {
  await mkdir(SCANS_DIR, { recursive: true })
  await mkdir(SESSION_DIR, { recursive: true })

  // Keyframe session (so a real splat-train run would have inputs).
  const jpeg = tinyJpeg()
  const lines = []
  for (let i = 0; i < FRAMES; i++) {
    const name = `kf-${String(i).padStart(5, '0')}.jpg`
    await writeFile(path.join(SESSION_DIR, name), jpeg)
    lines.push(JSON.stringify({
      index: i,
      file: name,
      timestamp: i * 0.5,
      pose: {
        position: { x: i * 0.1, y: 1.6, z: -i * 0.05 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      intrinsics: { width: 1, height: 1, fovYDeg: 55, sourceWidth: 1280, sourceHeight: 720 },
    }))
  }
  await writeFile(path.join(SESSION_DIR, 'keyframes.jsonl'), lines.join('\n') + '\n')
  await writeFile(path.join(SESSION_DIR, 'session.json'), JSON.stringify({
    sessionId: SESSION_ID,
    startedAt: new Date(0).toISOString(),
    finalizedAt: new Date(0).toISOString(),
    keyframeCount: FRAMES,
    glbFilename: `${BASE}.glb`,
  }, null, 2))

  // Scan .glb + manifest so /scans and the world list surface it.
  await writeFile(path.join(SCANS_DIR, `${BASE}.glb`), tinyGlb())
  await writeFile(path.join(SCANS_DIR, `${BASE}.manifest.json`), JSON.stringify({
    scanId: `scan-${BASE}`,
    sessionId: SESSION_ID,
    filename: `${BASE}.glb`,
    name: 'Splat fixture scan',
  }, null, 2))

  // The trained-splat sidecar + world-job manifest.
  const ply = writeSplatPly(GAUSSIANS)
  await writeFile(path.join(SCANS_DIR, `${BASE}.splat.ply`), ply)
  await writeFile(path.join(SCANS_DIR, `${BASE}.splat-train.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    tool: 'brush',
    status: 'ok',
    createdAt: new Date(0).toISOString(),
    sessionDir: SESSION_DIR,
    plyPath: `${BASE}.splat.ply`,
    gaussianCount: GAUSSIANS,
    frameCount: FRAMES,
    params: {
      brushBin: '(synthetic-fixture)',
      device: 'DiscreteGpu(1)',
      trainIters: 15000,
      shDegree: 2,
      maxResolution: 1280,
      evalEvery: 15000,
    },
    timing: { elapsedMs: 0 },
    sessionId: SESSION_ID,
    scanId: `scan-${BASE}`,
    note: 'Synthetic fixture — generated by scripts/make-splat-fixture.mjs for the integration test',
  }, null, 2))

  console.log(`[splat-fixture] wrote ${BASE}.splat.ply (${GAUSSIANS} gaussians) + manifest in ${SCANS_DIR}`)
  console.log(`[splat-fixture] session ${SESSION_ID} with ${FRAMES} keyframes`)

  // Splat-detect sidecars: a synthetic interactions.json (schema copied verbatim
  // from splat_analyzer's run_local.py — {objects:[{label,position,rotation,scale,
  // frames}], frame_annotations}) plus the <base>.splat-detect.manifest.json the
  // world job writes. Lets the toolbox spec render N labeled boxes offline.
  const detectObjects = [
    { label: 'sofa', position: { x: -0.6, y: -0.4, z: 0.2 }, scale: { x: 1.2, y: 0.8, z: 0.9 } },
    { label: 'table', position: { x: 0.4, y: -0.6, z: -0.3 }, scale: { x: 0.7, y: 0.5, z: 0.7 } },
    { label: 'lamp', position: { x: 0.8, y: 0.3, z: 0.6 }, scale: { x: 0.3, y: 0.9, z: 0.3 } },
  ].map((o, i) => ({
    label: o.label,
    position: o.position,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: o.scale,
    frames: [{ frame_idx: i, box: [0, 0, 100, 100], score: 0.5 }],
  }))
  await writeFile(path.join(SCANS_DIR, `${BASE}.interactions.json`), JSON.stringify({
    objects: detectObjects,
    frame_annotations: {},
  }, null, 2))
  await writeFile(path.join(SCANS_DIR, `${BASE}.splat-detect.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    tool: 'splat-analyzer',
    status: 'ok',
    createdAt: new Date(0).toISOString(),
    interactionsPath: `${BASE}.interactions.json`,
    objectCount: detectObjects.length,
    prompt: 'sofa, chair, table, tv, lamp',
    timing: { elapsedMs: 0 },
    sessionId: SESSION_ID,
    scanId: `scan-${BASE}`,
    note: 'Synthetic fixture — generated by scripts/make-splat-fixture.mjs for the toolbox test',
  }, null, 2))
  console.log(`[splat-fixture] wrote ${BASE}.interactions.json (${detectObjects.length} objects) + splat-detect manifest`)

  // Companion error-state fixture: a scan whose splat-train run FAILED, so the
  // viewer spec can assert the panel surfaces the error instead of a splat.
  const ERR_BASE = `${BASE}-err`
  await writeFile(path.join(SCANS_DIR, `${ERR_BASE}.glb`), tinyGlb())
  await writeFile(path.join(SCANS_DIR, `${ERR_BASE}.manifest.json`), JSON.stringify({
    scanId: `scan-${ERR_BASE}`,
    sessionId: SESSION_ID,
    filename: `${ERR_BASE}.glb`,
    name: 'Splat fixture scan (failed train)',
  }, null, 2))
  await writeFile(path.join(SCANS_DIR, `${ERR_BASE}.splat-train.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    tool: 'brush',
    status: 'error',
    createdAt: new Date(0).toISOString(),
    sessionDir: SESSION_DIR,
    error: 'brush exited 1',
    params: {
      brushBin: '(synthetic-fixture)',
      device: 'DiscreteGpu(1)',
      trainIters: 15000,
      shDegree: 2,
      maxResolution: 1280,
      evalEvery: 15000,
    },
    timing: { elapsedMs: 42 },
    sessionId: SESSION_ID,
    scanId: `scan-${ERR_BASE}`,
    note: 'Synthetic error fixture — generated by scripts/make-splat-fixture.mjs',
  }, null, 2))
  console.log(`[splat-fixture] wrote ${ERR_BASE} error-state fixture (no .ply)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
