/**
 * A scan's sidecar is rewritten whole by a rename, never in place (server/main.ts `writeJsonAtomic`).
 *
 * Why this is held by a test: a write in place truncates the file first, and a world read that lands in that gap sees an
 * empty sidecar. `readScanMeta` reads an unparseable sidecar as `{}`, so the scan reads as filed under no Place, the world
 * refresh evicts it, and the eviction takes its patches, comments and jobs with it. The verifier of the frame-identity
 * package reproduced exactly that with a 15 ms gap, and showed the same gap passes with a temporary file and a rename.
 * The behaviour itself is run by tests/unit/deno/frame_generations_route.test.ts (the scan sent back and forth between two
 * Places while their worlds are read); this file keeps the writers from going back to the shape that loses records.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08s-sidecar-atomic.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../../../server/main.ts', import.meta.url), 'utf8')

test('the atomic writer writes a temporary file beside the target and renames it over, and cleans up when it fails', () => {
  const start = main.indexOf('async function writeJsonAtomic(')
  assert.ok(start > 0, 'server/main.ts has writeJsonAtomic')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert.match(body, /const tmp = `\$\{path\}\.\$\{crypto\.randomUUID\(\)\}\.tmp`/, 'a temporary name beside the target, unique per write, not ending in .json')
  assert.match(body, /await Deno\.writeTextFile\(tmp, /)
  assert.match(body, /await Deno\.rename\(tmp, path\)/, 'the rename is the one step a reader can see')
  assert.match(body, /await Deno\.remove\(tmp\)\.catch\(\(\) => \{\}\)/, 'a failed write leaves no temporary file behind')
  assert.match(body, /throw err/, 'and the failure is still the caller\'s')
})

test('every place that rewrites a scan sidecar goes through it', () => {
  // The four writers: the ingest metadata, the splat alignment's calibration, a scan reassigned to another Place, and a merge.
  assert.equal(main.split('writeJsonAtomic(').length - 1, 5, 'the definition and four uses')
  assert.doesNotMatch(main, /Deno\.writeTextFile\(scanMetaPath\(/, 'no sidecar is written in place through scanMetaPath')
  assert.doesNotMatch(main, /Deno\.writeTextFile\((metaPath|path), JSON\.stringify\(meta/, 'nor through a path read from the scan directory')
})

test('a merge takes the frames\' photos before it removes the merged Place\'s folder, and a refused merge removes nothing', () => {
  const merge = main.slice(main.indexOf("const merged = await mutateProjects<{ target: ProjectRecord | null; alreadyMerged?: boolean; photosFailed?: boolean; mismatch?: FrameMismatchBody }>"))
  const frames = merge.indexOf('placeMoves.mergeFrames(')
  const refused = merge.indexOf('if (mismatch) return')
  const removal = merge.indexOf('removePlaceMedia(PROJECT_MEDIA_DIR, sourceProjectId)')
  assert.ok(frames > 0 && refused > frames && removal > refused, 'mergeFrames (which copies the photos), then the refusal, then the removal')
})
