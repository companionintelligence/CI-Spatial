/**
 * Download a small Creative Commons reference clip for the LingBot-Map
 * integration test.
 *
 * Default source — Big Buck Bunny 360p (CC-BY 3.0, Blender Foundation,
 *   https://peach.blender.org).
 *   This is NOT an indoor walk so the reconstruction won't be physically
 *   meaningful, but it is a publicly hosted, license-clear, sub-10MB clip
 *   that exercises the full server → worker → viewer pipeline end-to-end.
 *
 * For a more realistic reconstruction, override SOURCE_URL with a CC0 indoor
 * walkthrough (e.g. one of the LingBot-Map example scenes) and set FRAMES
 * higher.
 *
 * Usage:
 *   node scripts/fetch-lingbot-test-video.mjs
 *   SOURCE_URL=https://example.org/walk.mp4 FRAMES=120 node scripts/fetch-lingbot-test-video.mjs
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'lingbot-map')
const VIDEO_PATH = path.join(OUT_DIR, 'source.mp4')
const LICENSE_PATH = path.join(OUT_DIR, 'LICENSE.txt')

const DEFAULT_URL = 'https://download.blender.org/demo/movies/BBB/bbb_sunflower_native_60fps_normal.mp4'
const FALLBACK_URL = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm'
const SOURCE_URL = process.env.SOURCE_URL || DEFAULT_URL

const LICENSE_TEXT = `Big Buck Bunny
(c) 2008 Blender Foundation | www.bigbuckbunny.org
Licensed under Creative Commons Attribution 3.0 (CC-BY 3.0).
Source: ${SOURCE_URL}

This file is fetched as a reference clip for the LingBot-Map integration
test. It is not redistributed by this repository.
`

async function alreadyHave() {
  try {
    const s = await stat(VIDEO_PATH)
    return s.size > 1024 * 1024
  } catch {
    return false
  }
}

async function fetchToBuffer(url) {
  console.log(`[fetch] GET ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  console.log(`[fetch] received ${(buf.byteLength / (1024 * 1024)).toFixed(1)} MB`)
  return buf
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  if (await alreadyHave()) {
    console.log(`[fetch] already cached at ${VIDEO_PATH} — skipping download`)
    return
  }
  let bytes
  try {
    bytes = await fetchToBuffer(SOURCE_URL)
  } catch (e) {
    console.warn(`[fetch] primary URL failed (${e.message}); trying fallback`)
    bytes = await fetchToBuffer(FALLBACK_URL)
  }
  await writeFile(VIDEO_PATH, bytes)
  await writeFile(LICENSE_PATH, LICENSE_TEXT)
  console.log(`[fetch] wrote ${VIDEO_PATH}`)
  console.log(`[fetch] wrote ${LICENSE_PATH}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
