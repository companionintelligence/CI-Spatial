/**
 * Video → Companion-Scan keyframe session ("walk through the house shooting
 * normal video, upload it, get a 3D map").
 *
 * Extracts scaled JPEG keyframes from an ordinary phone/camera video with
 * ffmpeg and lays them down as a capture session the existing pipeline
 * understands. The records carry NO pose — LingBot-Map estimates poses in a
 * later lingbot-map-reconstruct job, and splat_train_dataset.ts falls back to
 * lingbot-map.poses.json when keyframes are pose-less.
 *
 * Outputs (under <scans-dir>/sessions/<sessionId>/):
 *   kf-00000.jpg …            scaled keyframes (long edge capped, quality ~85)
 *   keyframes.jsonl           one record per frame: { index, file, timestamp }
 *   session.json              { sessionId, source: 'video-ingest', … }
 *
 * Usage:
 *   node scripts/ingest-video.mjs <video-path> [--session-id <id>] [--fps 2]
 *     [--max-frames 300] [--max-long-edge 1440] [--scans-dir <dir>]
 *
 * Prints JSON { sessionId, frameCount, sessionDir } on stdout as the LAST line
 * (the /ingest-video server route parses exactly that).
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: node scripts/ingest-video.mjs <video-path> [--session-id <id>] [--fps 2] [--max-frames 300] [--max-long-edge 1440] [--scans-dir <dir>]')
  process.exit(2)
}
const VIDEO = argv[0]
const args = parseArgs(argv.slice(1))

const ROOT = path.resolve(import.meta.dirname, '..')
const SCANS_DIR = args['scans-dir'] || process.env.SCANS_DIR || path.join(ROOT, 'scans')
const FPS = clampNumber(args.fps, 2, 0.1, 30)
const MAX_FRAMES = Math.floor(clampNumber(args['max-frames'], 300, 1, 2000))
const MAX_LONG_EDGE = Math.floor(clampNumber(args['max-long-edge'], 1440, 240, 8192))
// Must satisfy the server's SESSION_ID_RE (^(sess|session)-[a-z0-9-]+$).
const SESSION_ID_RE = /^(sess|session)-[a-z0-9-]+$/

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 2) out[list[i].replace(/^--/, '')] = list[i + 1]
  return out
}

function clampNumber(raw, fallback, min, max) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

async function defaultSessionId() {
  // sess-video-<yyyymmdd-hhmmss> derived from the video's mtime so re-ingesting
  // the same file is stable-ish; callers wanting uniqueness pass --session-id.
  const info = await stat(VIDEO)
  const iso = new Date(info.mtimeMs).toISOString() // 2026-07-04T12:34:56.789Z
  const stamp = iso.slice(0, 19).replace(/[T:]/g, '').replace(/-/g, '')
  return `sess-video-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`
}

async function main() {
  await stat(VIDEO) // fail fast with a clear ENOENT before touching ffmpeg
  const sessionId = args['session-id'] || await defaultSessionId()
  if (!SESSION_ID_RE.test(sessionId)) {
    console.error(`error: session id "${sessionId}" must match ${SESSION_ID_RE}`)
    process.exit(2)
  }
  const sessionDir = path.join(SCANS_DIR, 'sessions', sessionId)
  await mkdir(sessionDir, { recursive: true })

  // Sample at FPS and cap the LONG edge (portrait videos scale height, not
  // width); -2 keeps the other edge even for the JPEG encoder. min(...) never
  // upscales. -q:v 3 ≈ JPEG quality ~85.
  const vf = `fps=${FPS},scale='if(gt(iw,ih),min(${MAX_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_LONG_EDGE},ih))'`
  execFileSync('ffmpeg', [
    '-y',
    '-i', VIDEO,
    '-vf', vf,
    '-frames:v', String(MAX_FRAMES),
    '-start_number', '0',
    '-q:v', '3',
    path.join(sessionDir, 'kf-%05d.jpg'),
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  const frames = (await readdir(sessionDir)).filter((f) => /^kf-\d{5}\.jpg$/.test(f)).sort()
  if (frames.length === 0) {
    console.error('error: ffmpeg produced no keyframes (unreadable or zero-length video?)')
    process.exit(1)
  }

  // NO pose on the records — LingBot-Map estimates poses from RGB later.
  const jsonl = frames
    .map((file, i) => JSON.stringify({ index: i, file, timestamp: i / FPS }))
    .join('\n') + '\n'
  await writeFile(path.join(sessionDir, 'keyframes.jsonl'), jsonl)

  const record = {
    sessionId,
    source: 'video-ingest',
    sourceVideo: path.basename(VIDEO),
    frameCount: frames.length,
    fps: FPS,
    keyframeCount: frames.length,
    startedAt: new Date().toISOString(),
  }
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(record, null, 2))

  console.log(`[ingest-video] ${path.basename(VIDEO)} → ${frames.length} keyframes @ ${FPS}fps (long edge ≤ ${MAX_LONG_EDGE}px)`)
  // Contract: machine-readable summary as the LAST stdout line.
  console.log(JSON.stringify({ sessionId, frameCount: frames.length, sessionDir }))
}

main().catch((err) => {
  console.error('[ingest-video] failed:', err.message ?? err)
  process.exit(1)
})
