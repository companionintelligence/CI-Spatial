/**
 * WP-17a: the design constraint that a runtime anchor never silently changes the Place frame, enforced instead of only
 * written down.
 *
 * The constraint (docs of src/ar/anchors.ts, WP-17 design part 2): a scan carries one sessionToProject, and points recorded
 * before a correction sit in the old frame, so nothing may recompute that matrix from where a runtime anchor is now. A
 * correction is a frame discontinuity, which the epoch mechanism answers by finishing the scan and calibrating the next one
 * afresh. Nothing in a unit test drives project-calibration.ts (it is a DOM flow, covered only by a browser spec), so a
 * change that built the frame from an anchor pose would compile and pass every unit test. This test reads the sources
 * instead: the code that can read an anchor's pose is src/ar/anchors.ts and nothing else.
 *
 * If you meant to read a pose elsewhere (a diagnostic such as how far a pair of markers drifted between two taps), add the file
 * to POSE_READERS with the reason. The frame itself must still be computed from the taps.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17a-anchor-guard.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The modules allowed to read where an anchor is, each with the reason. */
const POSE_READERS: Record<string, string> = {
  'src/ar/anchors.ts': 'the capability itself: it reads the runtime and reports through events',
}

/**
 * The names that read an anchor's pose or its displacement: the capability's two readers, and the two members of the WebXR
 * API they sit on. Placing an anchor (createAnchor, tryCreateAnchor) and hearing about it (onMoved, onLost) are not reading
 * a pose, so they are not here.
 */
const POSE_READING_NAMES = /\b(?:anchorPose|anchorDisplacement|anchorSpace|trackedAnchors)\b/g

/** Source with its comments removed. String literals are kept whole and skipped, so a `//` inside one is not a comment. */
function withoutComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (found) => (/^["'`]/.test(found) ? found : ''))
}

/** The names in `source` that read an anchor's pose, one entry per occurrence. Comments do not count. */
function poseReads(source: string): string[] {
  return [...withoutComments(source).matchAll(POSE_READING_NAMES)].map((m) => m[0])
}

function typeScriptUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return typeScriptUnder(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

test('only src/ar/anchors.ts reads where a runtime anchor is: no other module can be building the Place frame from one', () => {
  const readers: string[] = []
  for (const path of typeScriptUnder(join(ROOT, 'src'))) {
    const name = relative(ROOT, path)
    if (name in POSE_READERS) continue
    const reads = poseReads(readFileSync(path, 'utf8'))
    if (reads.length > 0) readers.push(`${name} reads ${[...new Set(reads)].join(', ')}`)
  }
  assert.deepEqual(
    readers,
    [],
    'A runtime anchor must not set the Place frame (src/ar/anchors.ts header, WP-17 design part 2): sessionToProject comes from the taps, and an anchor that moves is a frame discontinuity for the epoch mechanism. If the read is a diagnostic, add the module to POSE_READERS in this test with the reason.',
  )
  for (const [name, why] of Object.entries(POSE_READERS)) {
    assert.ok(why.length > 0, `${name} says why it may read a pose`)
    assert.ok(poseReads(readFileSync(join(ROOT, name), 'utf8')).length > 0, `${name} is listed as a pose reader but reads none: remove it from the list`)
  }
})

test('the check itself sees the ways a frame could be built from an anchor, and ignores the words in comments', () => {
  const bad = [
    'const landmark = provider.anchors?.anchorPose(handle)?.position ?? tapped',
    'const d = anchors.anchorDisplacement(h)',
    'frame.getPose(anchor.anchorSpace, refSpace)',
    'for (const a of frame.trackedAnchors) read(a)',
    'sessionToProject: twoPointToProjectTransform(((options.provider as any).anchors?.anchorPose?.(h)?.position) ?? landmark, headingMarker),',
  ]
  for (const source of bad) assert.ok(poseReads(source).length > 0, source)

  const fine = [
    '// the anchorPose of the landmark is not used here',
    '/* trackedAnchors anchorSpace anchorDisplacement */',
    "const text = 'a // not a comment'; const x = anchorPose",
    'void tryCreateAnchor(provider, hit)',
    'anchors.onMoved((event) => epoch.noteShift(event.total))',
    'anchors.onLost(() => epoch.noteShift(null))',
  ]
  assert.deepEqual(poseReads(fine[0]), [])
  assert.deepEqual(poseReads(fine[1]), [])
  assert.deepEqual(poseReads(fine[2]), ['anchorPose'], 'a string that holds `//` is a string, so what follows it is still code')
  assert.deepEqual(poseReads("const warn = 'anchorPose is gone'"), ['anchorPose'], 'a name in a string is still reported: the check errs towards asking')
  assert.deepEqual(poseReads(fine[3]), [])
  assert.deepEqual(poseReads(fine[4]), [])
  assert.deepEqual(poseReads(fine[5]), [])
})

test('the code that turns taps into the frame does not mention a runtime anchor at all, apart from asking for one after the marker is down', () => {
  for (const file of ['src/world/geo.ts', 'src/ar/project-calibration.ts', 'src/ar/calibration-commit.ts']) {
    const code = withoutComments(readFileSync(join(ROOT, file), 'utf8'))
    const imports = [...code.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*'([^']*anchors(?:\.ts)?)'/g)]
    for (const [, , names] of imports) {
      const taken = names.split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean)
      assert.deepEqual(
        taken.filter((n) => n !== 'tryCreateAnchor' && n !== 'AnchorHandle'),
        [],
        `${file} takes only tryCreateAnchor (and the handle type) from the anchors module`,
      )
    }
    assert.doesNotMatch(code, /\.anchors\b/, `${file} goes through tryCreateAnchor(provider, ...), not provider.anchors`)
  }
})
