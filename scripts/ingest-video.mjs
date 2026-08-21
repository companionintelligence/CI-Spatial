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
 * Quality upgrades:
 *   ADAPTIVE FPS — when --fps is not given, the sample rate adapts to the clip
 *   length (probed via ffprobe): max(2, ceil(40 / durationSeconds)), capped at
 *   10. Short clips still yield ≥40 frames — enough parallax for LingBot-Map +
 *   Brush — while long walkthroughs keep the economical 2fps default.
 *   BLUR FILTER — after extraction, each frame's sharpness (variance of the
 *   3x3 Laplacian on downscaled grayscale — see ingest-quality.mjs) is
 *   measured and frames below --min-sharpness (default 60, env
 *   INGEST_MIN_SHARPNESS, 0 disables) are dropped. Survivors are re-indexed so
 *   kf-NNNNN.jpg stays contiguous and keyframes.jsonl matches; the dropped
 *   count is recorded as `droppedBlurry`.
 *
 * Outputs (under <sessions-dir>/<sessionId>/, default <scans-dir>/sessions/):
 *   kf-00000.jpg …            scaled keyframes (long edge capped, quality ~85)
 *   keyframes.jsonl           one record per frame: { index, file, timestamp }
 *   session.json              { sessionId, source: 'video-ingest', … }
 *
 * Usage:
 *   node scripts/ingest-video.mjs <video-path> [--session-id <id>] [--fps 2]
 *     [--max-frames 300] [--max-long-edge 1440] [--min-sharpness 60]
 *     [--scans-dir <dir>] [--sessions-dir <dir>]
 *
 * Prints JSON { sessionId, frameCount, sessionDir, droppedBlurry, fps } on
 * stdout as the LAST line (the /ingest-video server route parses exactly that).
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { filterBlurryFrames } from './ingest-quality.mjs'

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: node scripts/ingest-video.mjs <video-path> [--session-id <id>] [--fps 2] [--max-frames 300] [--max-long-edge 1440] [--min-sharpness 60] [--scans-dir <dir>] [--sessions-dir <dir>]')
  process.exit(2)
}
const VIDEO = argv[0]
const args = parseArgs(argv.slice(1))

const ROOT = path.resolve(import.meta.dirname, '..')
const SCANS_DIR = args['scans-dir'] || process.env.SCANS_DIR || path.join(ROOT, 'scans')
// Must match main.ts's own SESSIONS_DIR resolution exactly (`Deno.env.get('SESSIONS_DIR')
// ?? \`${SCANS_DIR}/sessions\``) — main.ts is where keyframePreflight/resolveSessionDirFor
// look for what this script writes. Deployments that set SESSIONS_DIR independently of
// SCANS_DIR (.env.example documents this as supported) need this script to land keyframes
// in the same place, or the auto-enqueued lingbot-map-reconstruct job fails with
// "requires RGB keyframe observations" even though the keyframes were captured fine —
// they were just written to the wrong directory.
const SESSIONS_DIR = args['sessions-dir'] || process.env.SESSIONS_DIR || path.join(SCANS_DIR, 'sessions')
const MAX_FRAMES = Math.floor(clampNumber(args['max-frames'], 300, 1, 2000))
const MAX_LONG_EDGE = Math.floor(clampNumber(args['max-long-edge'], 1440, 240, 8192))
// Blur gate: frames below this variance-of-Laplacian are dropped. 0 disables.
const MIN_SHARPNESS = clampNumber(args['min-sharpness'] ?? process.env.INGEST_MIN_SHARPNESS, 60, 0, 100000)
// Adaptive default targets at least this many frames from short clips.
const TARGET_MIN_FRAMES = 40
const ADAPTIVE_FPS_CAP = 10
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

/** Clip duration in seconds via ffprobe, or null when unprobeable. */
function probeDurationSeconds(video) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      video,
    ], { encoding: 'utf8' }).trim()
    const seconds = Number(out)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
  } catch {
    return null
  }
}

/**
 * Pick the sample rate: an explicit --fps always wins; otherwise adapt to the
 * clip so short videos still produce ≥ TARGET_MIN_FRAMES frames, capped at
 * ADAPTIVE_FPS_CAP so a 3-second clip doesn't explode into near-duplicates.
 */
function resolveFps(explicitFps, durationSeconds) {
  if (explicitFps !== undefined) return clampNumber(explicitFps, 2, 0.1, 30)
  if (!durationSeconds) return 2
  return Math.min(ADAPTIVE_FPS_CAP, Math.max(2, Math.ceil(TARGET_MIN_FRAMES / durationSeconds)))
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
  const sessionDir = path.join(SESSIONS_DIR, sessionId)
  await mkdir(sessionDir, { recursive: true })

  const durationSeconds = probeDurationSeconds(VIDEO)
  const FPS = resolveFps(args.fps, durationSeconds)
  if (args.fps === undefined && durationSeconds) {
    console.log(`[ingest-video] adaptive fps: ${durationSeconds.toFixed(1)}s clip → ${FPS}fps (target ≥${TARGET_MIN_FRAMES} frames)`)
  }

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

  const extracted = (await readdir(sessionDir)).filter((f) => /^kf-\d{5}\.jpg$/.test(f)).sort()
  if (extracted.length === 0) {
    console.error('error: ffmpeg produced no keyframes (unreadable or zero-length video?)')
    process.exit(1)
  }

  // Blur filter: measure each extracted frame, drop the blurry ones, then
  // re-index the survivors so kf-NNNNN.jpg stays contiguous from 0.
  const { keep, dropped } = await filterBlurryFrames(
    extracted.map((f) => path.join(sessionDir, f)),
    MIN_SHARPNESS,
  )
  if (dropped.length === extracted.length) {
    // Never drop the whole session — keep everything and report 0 dropped so a
    // uniformly-soft clip still reaches reconstruction.
    console.warn(`[ingest-video] blur filter would drop ALL ${extracted.length} frames (min-sharpness ${MIN_SHARPNESS}) — keeping them`)
    keep.push(...dropped.map((d) => d.path))
    keep.sort()
    dropped.length = 0
  }
  for (const { path: p, sharpness } of dropped) {
    console.log(`[ingest-video] dropping blurry ${path.basename(p)} (sharpness ${sharpness.toFixed(1)} < ${MIN_SHARPNESS})`)
    await unlink(p)
  }

  // Survivors keep their capture timestamp (original index / FPS) but are
  // renamed to a contiguous kf-00000… sequence. Renames go in ascending order
  // and only ever move a file to a lower index, so nothing is clobbered.
  const survivors = keep
    .map((p) => path.basename(p))
    .sort()
    .map((file) => ({ file, originalIndex: Number(file.slice(3, 8)) }))
  const records = []
  for (let i = 0; i < survivors.length; i++) {
    const { file, originalIndex } = survivors[i]
    const target = `kf-${String(i).padStart(5, '0')}.jpg`
    if (file !== target) {
      await rename(path.join(sessionDir, file), path.join(sessionDir, target))
    }
    // NO pose on the records — LingBot-Map estimates poses from RGB later.
    records.push(JSON.stringify({ index: i, file: target, timestamp: originalIndex / FPS }))
  }
  await writeFile(path.join(sessionDir, 'keyframes.jsonl'), records.join('\n') + '\n')

  const frameCount = survivors.length
  const record = {
    sessionId,
    source: 'video-ingest',
    sourceVideo: path.basename(VIDEO),
    frameCount,
    fps: FPS,
    keyframeCount: frameCount,
    durationSeconds: durationSeconds ?? null,
    droppedBlurry: dropped.length,
    minSharpness: MIN_SHARPNESS,
    startedAt: new Date().toISOString(),
  }
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(record, null, 2))

  console.log(`[ingest-video] ${path.basename(VIDEO)} → ${frameCount} keyframes @ ${FPS}fps (long edge ≤ ${MAX_LONG_EDGE}px, dropped ${dropped.length} blurry)`)
  // Contract: machine-readable summary as the LAST stdout line.
  console.log(JSON.stringify({ sessionId, frameCount, sessionDir, droppedBlurry: dropped.length, fps: FPS }))
}

main().catch((err) => {
  console.error('[ingest-video] failed:', err.message ?? err)
  process.exit(1)
})
