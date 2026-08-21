/**
 * Photo set → Companion-Scan keyframe session(s) ("shot a burst of photos
 * around the room / dug a folder of house photos out of an archive").
 *
 * Takes a DIRECTORY of photos, orders them by capture time (EXIF
 * DateTimeOriginal via exif-parser when available, file mtime otherwise),
 * optionally clusters them into scenes (a gap > --cluster-gap-hours starts a
 * new session — archive folders often hold several visits), drops blurry
 * shots (same variance-of-Laplacian gate as ingest-video.mjs), and lays each
 * cluster down as a capture session the existing pipeline understands:
 *
 *   kf-00000.jpg …            scaled keyframes (long edge capped, quality ~85)
 *   keyframes.jsonl           one record per frame: { index, file, timestamp }
 *                             (timestamp = seconds since the cluster start; NO
 *                             pose — LingBot-Map estimates poses later)
 *   session.json              { sessionId, source: 'photo-ingest', … }
 *
 * The /ingest-photos server route calls this with --single-session (one
 * upload = one session); clustering is for box-side archive use.
 *
 * Usage:
 *   node scripts/ingest-photos.mjs <photos-dir> [--session-id <id>]
 *     [--scans-dir <dir>] [--sessions-dir <dir>] [--max-long-edge 1440]
 *     [--min-sharpness 60] [--cluster-gap-hours 2] [--single-session true]
 *
 * Prints one JSON line per session, then the LAST stdout line is the summary
 * the server route parses:
 *   { sessionId, frameCount, sessionDir, droppedBlurry, timesFrom, sessions: [...] }
 * (top-level sessionId/frameCount/sessionDir describe the FIRST session).
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { filterBlurryFrames } from './ingest-quality.mjs'

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: node scripts/ingest-photos.mjs <photos-dir> [--session-id <id>] [--scans-dir <dir>] [--sessions-dir <dir>] [--max-long-edge 1440] [--min-sharpness 60] [--cluster-gap-hours 2] [--single-session true]')
  process.exit(2)
}
const PHOTOS_DIR = argv[0]
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
const MAX_LONG_EDGE = Math.floor(clampNumber(args['max-long-edge'], 1440, 240, 8192))
const MIN_SHARPNESS = clampNumber(args['min-sharpness'] ?? process.env.INGEST_MIN_SHARPNESS, 60, 0, 100000)
const CLUSTER_GAP_HOURS = clampNumber(args['cluster-gap-hours'], 2, 0, 24 * 365)
const SINGLE_SESSION = args['single-session'] === 'true' || args['single-session'] === '1'
const SESSION_ID_RE = /^(sess|session)-[a-z0-9-]+$/
const PHOTO_RE = /\.(jpe?g|png)$/i

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

/**
 * Capture time (ms since epoch) from EXIF DateTimeOriginal, or null when the
 * photo has no (readable) EXIF. exif-parser is a transitive dependency of the
 * jimp devDependency; if it ever goes missing we fall back to mtime wholesale.
 */
async function exifCaptureTimeMs(filePath) {
  let ExifParser
  try {
    ExifParser = (await import('exif-parser')).default
  } catch {
    return null
  }
  try {
    // exif-parser only needs the header; 128KB covers any sane EXIF block.
    const buf = await readFile(filePath)
    const result = ExifParser.create(buf).parse()
    const t = result?.tags?.DateTimeOriginal ?? result?.tags?.CreateDate
    return typeof t === 'number' && t > 0 ? t * 1000 : null
  } catch {
    return null
  }
}

function stampFrom(ms) {
  const iso = new Date(ms).toISOString()
  const stamp = iso.slice(0, 19).replace(/[T:]/g, '').replace(/-/g, '')
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`
}

async function main() {
  const dirInfo = await stat(PHOTOS_DIR)
  if (!dirInfo.isDirectory()) {
    console.error(`error: ${PHOTOS_DIR} is not a directory`)
    process.exit(2)
  }

  // sharp is preferred for the resize/re-encode too (jimp fallback).
  let resizeToJpeg
  try {
    const sharp = (await import('sharp')).default
    resizeToJpeg = async (src, dest) => {
      await sharp(src)
        .rotate() // apply EXIF orientation so keyframes are upright
        .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(dest)
    }
  } catch {
    const { Jimp } = await import('jimp')
    resizeToJpeg = async (src, dest) => {
      const img = await Jimp.read(src)
      if (Math.max(img.width, img.height) > MAX_LONG_EDGE) {
        img.scaleToFit({ w: MAX_LONG_EDGE, h: MAX_LONG_EDGE })
      }
      await img.write(dest, { mime: 'image/jpeg' })
    }
  }

  const names = (await readdir(PHOTOS_DIR)).filter((f) => PHOTO_RE.test(f)).sort()
  if (names.length === 0) {
    console.error(`error: no photos (.jpg/.jpeg/.png) in ${PHOTOS_DIR}`)
    process.exit(1)
  }

  // Capture times: EXIF first; if ANY photo lacks EXIF we note the fallback.
  let timesFrom = 'exif'
  const photos = []
  for (const name of names) {
    const filePath = path.join(PHOTOS_DIR, name)
    const exifMs = await exifCaptureTimeMs(filePath)
    const info = await stat(filePath)
    if (exifMs === null) timesFrom = 'mtime'
    photos.push({ name, path: filePath, timeMs: exifMs ?? info.mtimeMs })
  }
  photos.sort((a, b) => a.timeMs - b.timeMs || a.name.localeCompare(b.name))
  if (timesFrom === 'mtime') {
    console.log('[ingest-photos] some photos carry no EXIF DateTimeOriginal — ordering by file mtime')
  }

  // Cluster by capture-time gap (archive use). --single-session (the server
  // route) and a 0 gap both collapse everything into one session.
  const clusters = []
  let current = []
  const gapMs = CLUSTER_GAP_HOURS * 3600 * 1000
  for (const photo of photos) {
    if (
      !SINGLE_SESSION && gapMs > 0 && current.length > 0 &&
      photo.timeMs - current[current.length - 1].timeMs > gapMs
    ) {
      clusters.push(current)
      current = []
    }
    current.push(photo)
  }
  clusters.push(current)
  if (clusters.length > 1) {
    console.log(`[ingest-photos] ${photos.length} photos → ${clusters.length} scenes (gap > ${CLUSTER_GAP_HOURS}h starts a new session)`)
  }

  const baseSessionId = args['session-id'] || `sess-photo-${stampFrom(clusters[0][0].timeMs)}`
  if (!SESSION_ID_RE.test(baseSessionId)) {
    console.error(`error: session id "${baseSessionId}" must match ${SESSION_ID_RE}`)
    process.exit(2)
  }

  const sessions = []
  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci]
    const sessionId = ci === 0 ? baseSessionId : `${baseSessionId}-p${ci + 1}`
    const sessionDir = path.join(SESSIONS_DIR, sessionId)
    await mkdir(sessionDir, { recursive: true })

    // Blur gate runs on the ORIGINALS (the metric downscales internally), so
    // we never spend a re-encode on a frame we are about to drop.
    const { keep, dropped } = await filterBlurryFrames(cluster.map((p) => p.path), MIN_SHARPNESS)
    const keepSet = new Set(keep)
    let survivors = cluster.filter((p) => keepSet.has(p.path))
    if (survivors.length === 0) {
      console.warn(`[ingest-photos] blur filter would drop ALL ${cluster.length} photos in ${sessionId} (min-sharpness ${MIN_SHARPNESS}) — keeping them`)
      survivors = [...cluster]
      dropped.length = 0
    }
    for (const { path: p, sharpness } of dropped) {
      console.log(`[ingest-photos] dropping blurry ${path.basename(p)} (sharpness ${sharpness.toFixed(1)} < ${MIN_SHARPNESS})`)
    }

    const t0 = survivors[0].timeMs
    const records = []
    for (let i = 0; i < survivors.length; i++) {
      const photo = survivors[i]
      const file = `kf-${String(i).padStart(5, '0')}.jpg`
      await resizeToJpeg(photo.path, path.join(sessionDir, file))
      // NO pose — LingBot-Map estimates poses from RGB later. timestamp is
      // seconds since the cluster start (mirrors the video arm's timeline).
      records.push(JSON.stringify({
        index: i,
        file,
        timestamp: (photo.timeMs - t0) / 1000,
        sourcePhoto: photo.name,
      }))
    }
    await writeFile(path.join(sessionDir, 'keyframes.jsonl'), records.join('\n') + '\n')

    const record = {
      sessionId,
      source: 'photo-ingest',
      photoCount: cluster.length,
      frameCount: survivors.length,
      keyframeCount: survivors.length,
      droppedBlurry: dropped.length,
      minSharpness: MIN_SHARPNESS,
      timesFrom,
      capturedAt: new Date(t0).toISOString(),
      startedAt: new Date().toISOString(),
    }
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(record, null, 2))

    console.log(`[ingest-photos] ${sessionId}: ${survivors.length} keyframes from ${cluster.length} photos (dropped ${dropped.length} blurry)`)
    sessions.push({ sessionId, frameCount: survivors.length, sessionDir, droppedBlurry: dropped.length })
  }

  // Contract: machine-readable summary as the LAST stdout line; the top-level
  // fields mirror ingest-video.mjs and describe the FIRST session (the only
  // one in --single-session/server mode).
  console.log(JSON.stringify({
    sessionId: sessions[0].sessionId,
    frameCount: sessions[0].frameCount,
    sessionDir: sessions[0].sessionDir,
    droppedBlurry: sessions[0].droppedBlurry,
    timesFrom,
    sessions,
  }))
}

main().catch((err) => {
  console.error('[ingest-photos] failed:', err.message ?? err)
  process.exit(1)
})
