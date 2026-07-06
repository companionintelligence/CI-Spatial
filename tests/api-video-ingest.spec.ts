/**
 * Video-ingest smoke — runs scripts/ingest-video.mjs on the smallest real video
 * in $SPATIAL_TEST_DATA and asserts it lays down a valid pose-less capture
 * session (keyframes + jsonl + session.json source==='video-ingest').
 *
 * Gated: skips unless SPATIAL_TEST_DATA points at a dir of .mp4 clips, e.g.
 *   SPATIAL_TEST_DATA=~/devel/SpatialTestData npm run test:house
 * (belongs to the `api` project via the api-*.spec.ts naming.)
 *
 * Writes into an isolated temp scans dir OUTSIDE the repo tree (the box's
 * inotify watches choke on churn inside the checkout).
 *
 * SPATIAL_E2E follow-up (out of scope here): the *full* GPU chain —
 * ingest → lingbot-map-reconstruct (pose estimation) → splat-train (Brush) →
 * splat-detect (OWLv2) — needs both GPUs and minutes per room; drive it from the
 * house protocol (docs/HOUSE_VALIDATION.md Phase 3), not this fast gate.
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = process.env['SPATIAL_TEST_DATA']
const INGEST = join(process.cwd(), 'scripts', 'ingest-video.mjs')

function smallestMp4(dir: string): string | null {
  let best: { file: string; size: number } | null = null
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.mp4')) continue
    const size = statSync(join(dir, f)).size
    if (!best || size < best.size) best = { file: join(dir, f), size }
  }
  return best?.file ?? null
}

test.describe('video ingest → capture session', () => {
  test.skip(!DATA_DIR || !existsSync(DATA_DIR), 'set SPATIAL_TEST_DATA to a dir of .mp4 clips')
  test.setTimeout(120_000)

  test('smallest clip yields ≥8 keyframes and a video-ingest session', () => {
    const video = smallestMp4(DATA_DIR!)
    expect(video, `no .mp4 in ${DATA_DIR}`).toBeTruthy()

    // Isolated scans dir outside the repo tree (inotify safety on this box).
    const scansDir = mkdtempSync(join(tmpdir(), 'cscan-video-ingest-'))
    try {
      const out = execFileSync('node', [
        INGEST, video!,
        '--session-id', 'sess-video-ingest-test',
        '--fps', '2',
        '--scans-dir', scansDir,
      ], { encoding: 'utf8' })

      // Contract: last stdout line is JSON { sessionId, frameCount, sessionDir }.
      const lastLine = out.trim().split('\n').at(-1)!
      const summary = JSON.parse(lastLine) as { sessionId: string; frameCount: number; sessionDir: string }
      expect(summary.sessionId).toBe('sess-video-ingest-test')
      expect(summary.frameCount, 'at least 8 keyframes').toBeGreaterThanOrEqual(8)

      const dir = summary.sessionDir
      // keyframes.jsonl parses, one record per frame, records have NO pose.
      const jsonl = readFileSync(join(dir, 'keyframes.jsonl'), 'utf8').trim().split('\n')
      expect(jsonl.length).toBe(summary.frameCount)
      const first = JSON.parse(jsonl[0]) as Record<string, unknown>
      expect(first).toMatchObject({ index: 0 })
      expect(first.file).toMatch(/^kf-\d{5}\.jpg$/)
      expect('pose' in first, 'video-ingest records carry no pose').toBe(false)

      // session.json marks the source so splat_train_dataset's pose fallback fires.
      const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as { source: string; frameCount: number }
      expect(session.source).toBe('video-ingest')
      expect(session.frameCount).toBe(summary.frameCount)

      // The keyframe images actually exist on disk.
      const jpgs = readdirSync(dir).filter((f) => /^kf-\d{5}\.jpg$/.test(f))
      expect(jpgs.length).toBe(summary.frameCount)
    } finally {
      rmSync(scansDir, { recursive: true, force: true })
    }
  })

  test('adaptive fps: a short clip with no --fps yields ≥40 frames (minus blur drops)', () => {
    const video = smallestMp4(DATA_DIR!)
    expect(video, `no .mp4 in ${DATA_DIR}`).toBeTruthy()

    const scansDir = mkdtempSync(join(tmpdir(), 'cscan-video-adaptive-'))
    try {
      // NO --fps: the script probes the duration and adapts. The smallest
      // SpatialTestData clip is ~6.2s → ceil(40/6.2) = 7fps → ~44 raw frames.
      // The blur gate may trim a few, so assert the 80%-of-target floor.
      const out = execFileSync('node', [
        INGEST, video!,
        '--session-id', 'sess-video-adaptive-test',
        '--scans-dir', scansDir,
      ], { encoding: 'utf8' })

      const lastLine = out.trim().split('\n').at(-1)!
      const summary = JSON.parse(lastLine) as {
        sessionId: string; frameCount: number; sessionDir: string; droppedBlurry: number; fps: number
      }
      expect(summary.fps, 'adaptive fps must exceed the old 2fps default for a short clip').toBeGreaterThan(2)
      expect(summary.fps, 'adaptive fps is capped').toBeLessThanOrEqual(10)
      expect(summary.frameCount, '≥ 80% of the 40-frame target after the blur gate').toBeGreaterThanOrEqual(32)
      expect(summary.droppedBlurry).toBeGreaterThanOrEqual(0)

      // session.json records the quality-gate provenance.
      const session = JSON.parse(readFileSync(join(summary.sessionDir, 'session.json'), 'utf8')) as {
        fps: number; droppedBlurry: number; minSharpness: number; durationSeconds: number | null
      }
      expect(session.fps).toBe(summary.fps)
      expect(session.droppedBlurry).toBe(summary.droppedBlurry)
      expect(session.minSharpness).toBeGreaterThan(0)
      expect(session.durationSeconds ?? 0).toBeGreaterThan(0)

      // Surviving keyframes are contiguous from kf-00000 and match the jsonl.
      const jpgs = readdirSync(summary.sessionDir).filter((f) => /^kf-\d{5}\.jpg$/.test(f)).sort()
      expect(jpgs.length).toBe(summary.frameCount)
      expect(jpgs[0]).toBe('kf-00000.jpg')
      expect(jpgs.at(-1)).toBe(`kf-${String(summary.frameCount - 1).padStart(5, '0')}.jpg`)
      const jsonl = readFileSync(join(summary.sessionDir, 'keyframes.jsonl'), 'utf8').trim().split('\n')
      expect(jsonl.length).toBe(summary.frameCount)
      const records = jsonl.map((l) => JSON.parse(l) as { index: number; file: string })
      records.forEach((r, i) => {
        expect(r.index).toBe(i)
        expect(r.file).toBe(jpgs[i])
      })
    } finally {
      rmSync(scansDir, { recursive: true, force: true })
    }
  })

  test('explicit --fps still overrides the adaptive default', () => {
    const video = smallestMp4(DATA_DIR!)
    expect(video, `no .mp4 in ${DATA_DIR}`).toBeTruthy()

    const scansDir = mkdtempSync(join(tmpdir(), 'cscan-video-fpsoverride-'))
    try {
      const out = execFileSync('node', [
        INGEST, video!,
        '--session-id', 'sess-video-fps-override',
        '--fps', '2',
        '--scans-dir', scansDir,
      ], { encoding: 'utf8' })
      const summary = JSON.parse(out.trim().split('\n').at(-1)!) as { fps: number; frameCount: number }
      expect(summary.fps).toBe(2)
      // ~6.2s at 2fps ≈ 13 raw frames — far below the adaptive count.
      expect(summary.frameCount).toBeLessThan(32)
    } finally {
      rmSync(scansDir, { recursive: true, force: true })
    }
  })
})
