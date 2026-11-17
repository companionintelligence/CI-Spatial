/**
 * Nothing in the repository describes the inside of the vendored 8th Wall engine.
 *
 * public/xr.js and public/xr-slam.js are Niantic's minified binary, under a licence that bars reverse engineering, and
 * counsel has not yet said whether reading them is allowed (docs/audits, owner decision D16; the spec's legal flag 2).
 * Until she does, what this repository says about the engine comes from its documentation (https://8thwall.org/docs/) and from
 * what a phone shows, and a comment, a test or a document that says how the engine works inside is reworded to the documented
 * behaviour or removed. This test is the sweep, kept: it fails when one comes back.
 *
 * Two rules, over every text file outside public/xr*.js, public/resources and docs/audits (dated records the sweep does not edit):
 *
 *  1. No word of the repository is one of the engine's internal identifiers. They are held here as hashes, on purpose: spelling
 *     them in a test would put them back in the repository. A failure prints the word and the file, so whoever introduced it
 *     sees it in their own text. To add one, hash it (the first 16 hex digits of its SHA-256), add the digits to the list below
 *     and write the word nowhere else.
 *  2. No sentence says it was read out of the engine: "read from public/xr.js", "in public/xr-slam.js", "the vendored engine's
 *     source". The phrases are generic, so they are spelled out.
 *
 * What the engine's file names may still appear in: licence notices, build and packaging scripts, and the line that says where a
 * chunk is loaded from. This test does not police those, only a claim about the engine's inner workings.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/engine_internals_quarantine.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(HERE), '../../..')

/** The first 16 hex digits of the SHA-256 of each forbidden identifier. */
const FORBIDDEN_IDENTIFIER_HASHES: ReadonlySet<string> = new Set([
  '850fa33ece6da72e',
  '814f78672581ab73',
  '878210db12979004',
  '5f3050c76e6da194',
  'a61baf8b1fca2175',
  '6eab521ac28bbb9d',
  '5eaa6ed280e955ba',
  '62dc243a67381573',
  '55aa673d93a9819c',
  '28ea3396d94e3693',
])

/** Sentences that give the engine's own files as the source of a behaviour. */
const READ_OUT_OF_THE_ENGINE: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: 'says it read, inspected or searched the engine files', pattern: /\b(?:read(?!\s*\()|reading|inspect(?:ed|ing)?|search(?:ed|ing)?|grep(?:ped)?)\b[^.\n]{0,40}\bpublic\/xr(?:-slam)?\.js\b/i },
  { rule: 'cites a named thing as living "in public/xr.js" or "in public/xr-slam.js"', pattern: /`[^`\n]+`\s+(?:is\s+)?in\s+(?:the\s+)?(?:vendored\s+)?public\/xr(?:-slam)?\.js\b/i },
  { rule: 'cites the contents of the slam chunk, "in public/xr-slam.js"', pattern: /\bin\s+(?:the\s+)?(?:vendored\s+)?public\/xr-slam\.js\b/i },
  { rule: 'cites the vendored engine\'s enum, source or internals', pattern: /\bvendored engine'?s?\s+(?:enum|source|code|internals)\b/i },
  { rule: 'cites the engine\'s source', pattern: /\bengine'?s\s+source\b/i },
  { rule: 'says something lives inside the engine files', pattern: /\b(?:inside|within)\s+(?:the\s+)?(?:vendored\s+)?`?public\/xr(?:-slam)?\.js\b/i },
  { rule: 'describes searching or reading a minified engine', pattern: /\bminified\s+(?:engine|bundle|xr)\b/i },
]

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.html', '.json', '.yml', '.yaml', '.txt', '.css', '.py', '.sh', '.swift', '.java', '.kt', '.rs', '.toml'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'www', 'build', 'target', '.gradle', 'Pods', 'DerivedData', '.turbo', 'coverage', 'test-results', 'playwright-report', 'scans'])
const MAX_BYTES = 3_000_000

/** Files and folders the rules are not applied to, as paths from the repository root with forward slashes. */
function isExempt(path: string): boolean {
  return (
    path === 'tests/unit/node/engine_internals_quarantine.test.ts' ||
    path === 'public/xr.js' ||
    path === 'public/xr-slam.js' ||
    path === 'public/xr-face.js' ||
    path.startsWith('public/resources/') ||
    path.startsWith('docs/audits/') ||
    path === 'package-lock.json' ||
    path.endsWith('/package-lock.json')
  )
}

/** Every text file under the repository root that the rules apply to. */
function* textFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    const path = relative(ROOT, full).split(sep).join('/')
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || isExempt(`${path}/`)) continue
      yield* textFiles(full)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot === -1 || !TEXT_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
      if (isExempt(path) || statSync(full).size > MAX_BYTES) continue
      yield full
    }
  }
}

const hashOf = (word: string): string => createHash('sha256').update(word).digest('hex').slice(0, 16)

test('no word of the repository is one of the engine\'s internal identifiers', () => {
  const found: string[] = []
  let scanned = 0
  for (const file of textFiles(ROOT)) {
    scanned++
    const seen = new Set<string>()
    for (const match of readFileSync(file, 'utf8').matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) {
      const word = match[0]
      if (seen.has(word)) continue
      seen.add(word)
      if (FORBIDDEN_IDENTIFIER_HASHES.has(hashOf(word))) found.push(`${relative(ROOT, file)}: ${word}`)
    }
  }
  assert.ok(scanned > 500, `the sweep found only ${scanned} text files: the walk is broken, and a clean result would mean nothing`)
  assert.deepEqual(found, [], 'these files name an internal identifier of the vendored engine; reword to the documented behaviour (https://8thwall.org/docs/) or remove it')
})

test('no sentence of the repository says it was read out of the engine', () => {
  const found: string[] = []
  for (const file of textFiles(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const { rule, pattern } of READ_OUT_OF_THE_ENGINE) {
        if (pattern.test(line)) found.push(`${relative(ROOT, file)}:${index + 1} ${rule}: ${line.trim().slice(0, 140)}`)
      }
    })
  }
  assert.deepEqual(found, [], 'reword these to the documented behaviour (https://8thwall.org/docs/), or to "not documented, to be logged on a device", or remove them')
})

test('the rules do catch what they are for', () => {
  const sample = 'Read from public/xr.js, not yet seen on a device: `Z()` in public/xr.js compares sizes. It lives in public/xr-slam.js, the vendored engine\'s source, a minified bundle, and ships unused inside `public/xr.js`.'
  const caught = READ_OUT_OF_THE_ENGINE.filter(({ pattern }) => pattern.test(sample)).length
  assert.equal(caught, READ_OUT_OF_THE_ENGINE.length, 'every phrase rule matches the kind of sentence it is written for')
  for (const innocent of ["const header = read('public/xr.js').slice(0, 2000)", 'Download from https://8th.io/xrjs and place in public/xr.js', 'The slam chunk the page preloads (public/xr-slam.js) is 5.5 MB']) {
    assert.equal(READ_OUT_OF_THE_ENGINE.some(({ pattern }) => pattern.test(innocent)), false, `a file name given as where something is, or a test reading a licence header, is not a claim: ${innocent}`)
  }
  assert.equal(FORBIDDEN_IDENTIFIER_HASHES.size, 10)
  assert.equal(hashOf('not an engine identifier at all'), hashOf('not an engine identifier at all'))
  assert.ok(!FORBIDDEN_IDENTIFIER_HASHES.has(hashOf('XrController')), 'XrController is documented API, not an internal')
  assert.ok(!FORBIDDEN_IDENTIFIER_HASHES.has(hashOf('onCanvasSizeChange')), 'the documented hooks are not forbidden')
})
