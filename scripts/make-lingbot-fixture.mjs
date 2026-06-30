/**
 * Build a Companion-Scan keyframe session from a reference video AND emit
 * the three artifacts the LingBot-Map worker would have produced.
 *
 * Why the synthetic artifacts: the real Python worker needs torch + the
 * LingBot-Map checkpoint, so we can't run it in CI. The Deno server's
 * spawn surface is already covered by lingbot_map.test.ts; what we still
 * need is something the viewer can load and screenshot. So we synthesise
 * a procedural point cloud sized to the frame count and write the same
 * three sibling files the real worker would have written. End-to-end
 * pipeline shape stays identical; only the model's output is synthetic.
 *
 * Inputs (env or argv):
 *   --video <path>      defaults to tests/fixtures/lingbot-map/source.mp4
 *   --frames <n>        number of keyframes to extract (default 24)
 *   --session-id <id>   defaults to sess-fixture-lingbot
 *
 * Outputs (under SCANS_DIR/sessions/<id>/):
 *   session.json
 *   kf-NNNNN.jpg              extracted via ffmpeg
 *   keyframes.jsonl           one JSON record per keyframe
 *   lingbot-map.point-cloud.ply
 *   lingbot-map.poses.json
 *   lingbot-map.manifest.json
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const SCANS_DIR = process.env.SCANS_DIR || path.join(ROOT, 'scans')
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(SCANS_DIR, 'sessions')
const VIDEO = args.video || path.join(ROOT, 'tests', 'fixtures', 'lingbot-map', 'source.mp4')
const FRAMES = Number(args.frames || 24)
const SESSION_ID = args['session-id'] || 'sess-fixture-lingbot'
const SESSION_DIR = path.join(SESSIONS_DIR, SESSION_ID)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

async function ensureDirs() {
  await mkdir(SESSION_DIR, { recursive: true })
}

async function extractFrames() {
  try {
    await stat(VIDEO)
  } catch {
    console.error(`[fixture] video not found at ${VIDEO}. Run: npm run test:lingbot:fetch-video`)
    process.exit(2)
  }
  console.log(`[fixture] extracting ${FRAMES} frames from ${VIDEO}`)
  const pattern = path.join(SESSION_DIR, 'kf-%05d.jpg')
  execFileSync('ffmpeg', [
    '-y',
    '-i', VIDEO,
    '-vf', `select='not(mod(n\\,30))',scale=640:-2`,
    '-vsync', 'vfr',
    '-frames:v', String(FRAMES),
    '-start_number', '0',
    '-q:v', '4',
    pattern,
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
  const entries = (await readdir(SESSION_DIR)).filter((f) => /^kf-\d{5}\.jpg$/.test(f)).sort()
  return entries
}

function writeKeyframesJsonl(frames) {
  const lines = []
  for (let i = 0; i < frames.length; i++) {
    const t = i * 0.5
    lines.push(JSON.stringify({
      index: i,
      file: frames[i],
      timestamp: t,
      receivedAt: Date.now(),
      pose: {
        position: { x: i * 0.08, y: 1.6, z: -i * 0.05 },
        rotation: { x: 0, y: Math.sin(i * 0.1) * 0.2, z: 0, w: Math.cos(i * 0.1) * 0.2 + 0.8 },
      },
      intrinsics: { width: 640, height: 480, fovYDeg: 55, fx: 540, fy: 540, cx: 320, cy: 240 },
    }))
  }
  return lines.join('\n') + '\n'
}

function writeBinaryPly(points) {
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${points.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header\n',
  ].join('\n')
  const headerBytes = Buffer.from(header, 'ascii')
  const body = Buffer.alloc(points.length * 15)
  let off = 0
  for (const p of points) {
    body.writeFloatLE(p[0], off + 0)
    body.writeFloatLE(p[1], off + 4)
    body.writeFloatLE(p[2], off + 8)
    body.writeUInt8(p[3] & 0xff, off + 12)
    body.writeUInt8(p[4] & 0xff, off + 13)
    body.writeUInt8(p[5] & 0xff, off + 14)
    off += 15
  }
  return Buffer.concat([headerBytes, body])
}

function synthesisePoints(frameCount) {
  // Procedural "indoor room": floor + four walls + ceiling, sampled at
  // ~600 points per frame so the bigger fixture still loads quickly in the
  // viewer (~ 14k points for 24 frames).
  const points = []
  const perFrame = 600
  const rand = mulberry32(42)
  for (let f = 0; f < frameCount; f++) {
    for (let i = 0; i < perFrame; i++) {
      const side = (i * 7 + f) % 6
      let x, y, z
      switch (side) {
        case 0: x = -2 + rand() * 4; y = 0; z = -2 + rand() * 4; break
        case 1: x = -2 + rand() * 4; y = 2.5; z = -2 + rand() * 4; break
        case 2: x = -2; y = rand() * 2.5; z = -2 + rand() * 4; break
        case 3: x =  2; y = rand() * 2.5; z = -2 + rand() * 4; break
        case 4: x = -2 + rand() * 4; y = rand() * 2.5; z = -2; break
        default: x = -2 + rand() * 4; y = rand() * 2.5; z =  2; break
      }
      const r = Math.floor(120 + rand() * 100)
      const g = Math.floor(100 + rand() * 80)
      const b = Math.floor(80 + rand() * 120)
      points.push([x, y, z, r, g, b])
    }
  }
  return points
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

function buildPoses(frameCount) {
  const frames = []
  for (let i = 0; i < frameCount; i++) {
    const tx = i * 0.08
    const tz = -i * 0.05
    frames.push({
      index: i,
      file: `kf-${String(i).padStart(5, '0')}.jpg`,
      timestampMs: i * 500,
      captureIntrinsics: { width: 640, height: 480, fovYDeg: 55 },
      cameraToWorld: [
        [1, 0, 0, tx],
        [0, 1, 0, 1.6],
        [0, 0, 1, tz],
        [0, 0, 0, 1],
      ],
      intrinsicsMatrix: [
        [540, 0, 320],
        [0, 540, 240],
        [0, 0, 1],
      ],
    })
  }
  return { schemaVersion: 1, frames }
}

async function main() {
  await ensureDirs()
  const frames = await extractFrames()
  await writeFile(path.join(SESSION_DIR, 'session.json'), JSON.stringify({
    sessionId: SESSION_ID,
    startedAt: new Date(0).toISOString(),
    finalizedAt: new Date(0).toISOString(),
    keyframeCount: frames.length,
    pointCount: null,
    detectionCount: null,
    poseCount: frames.length,
    glbFilename: null,
  }, null, 2))
  await writeFile(path.join(SESSION_DIR, 'keyframes.jsonl'), writeKeyframesJsonl(frames))

  const points = synthesisePoints(frames.length)
  await writeFile(path.join(SESSION_DIR, 'lingbot-map.point-cloud.ply'), writeBinaryPly(points))
  await writeFile(path.join(SESSION_DIR, 'lingbot-map.poses.json'), JSON.stringify(buildPoses(frames.length), null, 2))
  await writeFile(path.join(SESSION_DIR, 'lingbot-map.manifest.json'), JSON.stringify({
    schemaVersion: 1,
    tool: 'lingbot-map',
    sessionDir: SESSION_DIR,
    createdAt: new Date(0).toISOString(),
    params: {
      modelPath: '(synthetic-fixture)',
      device: 'cpu',
      keyframeInterval: 1,
      maxFrames: 512,
      imageSize: 518,
      resolvedDevice: 'cpu',
    },
    frameCount: frames.length,
    totalCapturedFrames: frames.length,
    pointCount: points.length,
    elapsedMs: 0,
    status: 'ok',
    artifacts: {
      pointCloud: 'lingbot-map.point-cloud.ply',
      poses: 'lingbot-map.poses.json',
    },
    note: 'Synthetic fixture — generated by scripts/make-lingbot-fixture.mjs for the integration test',
  }, null, 2))

  console.log(`[fixture] wrote session at ${SESSION_DIR}`)
  console.log(`[fixture]   ${frames.length} keyframes`)
  console.log(`[fixture]   ${points.length} synthetic points`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
