/**
 * The device documents, held to the code they send a person to (merge-integrity review of the combined branch).
 *
 * Two lines of work were merged by hand, and the prose each wrote was true for its own tree. The checklist for the origin decal
 * quoted a status line and a button label that this branch's copy module had replaced; the device kit, the AR support matrix and
 * NOTICE.md named the `ArSession` plugin as what the shells run, after the shells took the other branch's `ScanAR`; the atlas
 * lost this branch's account of the reference photos. Nothing failed, because no test read those pages. This one does.
 *
 * It holds a document to the code in three ways, and none of them copies a string out of the document:
 *
 *  - A string a row quotes (a status line, a button, a scene object) is read from the module that owns it, or from the markup
 *    of the card that draws it, and the row must contain it. A row that quotes text no source file contains is stale.
 *  - A claim about what the build does is computed by running the build: the sentence `alignmentStatusText` makes of a record,
 *    the parts `buildOriginDecal` draws, the verdict `verifyTwoPoint` gives a distance.
 *  - A claim about what is registered, or about what asks Google Play for ARCore, is read from the shells' own sources.
 *
 * What a row means for a person with a phone is not held here. That is what the phone is for.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-docs-device-claims.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { FLOOR_CHECK_BYPASSED_TEXT, NO_ALIGNMENT_TEXT, NORTH_TICK_NOTE, alignmentStatusText } from '../../../src/ar/alignment-status.ts'
import { GHOST_NAME } from '../../../src/ar/constellation-ghosts.ts'
import { SKIP_CHECK_LABEL } from '../../../src/ar/constellation-copy.ts'
import { ONE_POINT_LABEL } from '../../../src/ar/one-point-offer.ts'
import { REANCHOR_LABEL, interruptionText } from '../../../src/ar/reanchor-copy.ts'
import { RECORD_UNVERIFIED_LABEL, REPLACE_REFERENCE_LABEL } from '../../../src/ar/replace-copy.ts'
import { WRONG_PLACE_LABEL } from '../../../src/ar/return-visit-copy.ts'
import { returnAidsEnabled } from '../../../src/ar/return-visit-aids.ts'
import { STATUS_HOLD_MS } from '../../../src/ui/status-line.ts'
import { originDecalPlan } from '../../../src/world/geo.ts'
import { NOT_CHECKED_SPOTS, verifyTwoPoint } from '../../../src/world/frame-fit.ts'
import { COMMITTED_ORIGIN_NAME, STORED_ORIGIN_NAME, buildOriginDecal } from '../../../src/world/origin-decal.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')
const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** Every .ts file under `dir`, as a path from the repo root. */
function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...tsFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** Source with its comments taken out, so that a sentence only a comment holds is not mistaken for one a screen shows. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/ .*$/gm, '')
}

/** Every source file of the app and the page that holds its markup, comments and all: what a retired string must be absent from. */
const PRODUCT_WITH_COMMENTS = [...tsFiles('src'), 'index.html'].map((path) => read(path)).join('\n')
/** What the product says to a person: the same with the comments out. A quoted screen has to be found here, and not only in a comment. */
const PRODUCT = [...tsFiles('src')].map((path) => withoutComments(read(path))).concat(read('index.html')).join('\n')
/** The same with every template expression (`${...}`) turned into one marker, so a sentence a source file builds can be searched for. */
const PRODUCT_TEMPLATES = PRODUCT.replace(/\$\{[^}]*\}/g, '\u0001')

/** The text of a section: from its heading line to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`)
  assert.ok(start !== -1, `no section "${heading}"`)
  const level = heading.match(/^#+/)![0].length
  const rest = text.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

/** Table rows and paragraphs and list items of a text, one string each, so a claim and its qualifier can be required in the same place. */
function chunksOf(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) out.push(current.join(' '))
    current = []
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') flush()
    else if (line.startsWith('|') || /^\s*([-*]|\d+\.)\s/.test(line)) {
      flush()
      current = [line.trim()]
    } else current.push(line.trim())
  }
  flush()
  return out
}

const DEVICE_TESTING = read('docs/testing/DEVICE_TESTING.md')
const A_ORIGIN = section(DEVICE_TESTING, '### A-origin — calibrated origin: ground plane, decal, return visit')
const B2 = section(DEVICE_TESTING, '### B2 — calibration anchor decal (WebXR renderer verification)')

/** The rows of the A-origin table, by their id (`O7`). */
const ROWS = new Map<string, string>()
for (const line of A_ORIGIN.split('\n')) {
  const id = /^\| (O\d+) \|/.exec(line)?.[1]
  if (id) ROWS.set(id, line)
}
const row = (id: string): string => {
  const found = ROWS.get(id)
  assert.ok(found, `the A-origin table has no row ${id}`)
  return flat(found)
}

/** The label of a button on the calibration card, from the card's own markup (`id="project-calibration-<name>"`), with the constants it names resolved. */
const CARD = read('src/ar/project-calibration.ts')
const CONSTANT_LABELS: Record<string, string> = { ONE_POINT_LABEL, REPLACE_REFERENCE_LABEL, WRONG_PLACE_LABEL }
function cardLabel(name: string): string {
  const match = new RegExp(`<button id="project-calibration-${name}"[^>]*>([^<]*)</button>`).exec(CARD)
  assert.ok(match, `the card has no button project-calibration-${name}`)
  const text = match[1]!.trim()
  const constant = /^\$\{([A-Z_]+)\}$/.exec(text)?.[1]
  if (!constant) return text
  assert.ok(constant in CONSTANT_LABELS, `the label of ${name} is the constant ${constant}, which this test does not know`)
  return CONSTANT_LABELS[constant]!
}

/** A number of the card's own constants, read from its source (`const NAME = 20_000`). */
function cardMilliseconds(name: string): number {
  const value = new RegExp(`const ${name} = ([0-9_]+)`).exec(CARD)?.[1]
  assert.ok(value, `project-calibration.ts has no constant ${name}`)
  return Number(value.replaceAll('_', ''))
}

// ── What a row quotes is what the build prints ───────────────────────────────

/**
 * Whether a quoted string is one the build prints. A trailing ellipsis or full stop is the quoter's; an `N`, or any number, stands
 * for a figure the build fills in, and each sentence between figures must be in the source. Source text that a template builds is searched with
 * its expressions as markers, so a figure in the middle of a sentence does not hide it.
 */
function printedByBuild(quoted: string): boolean {
  const body = quoted.replace(/[….\s]+$/, '').trim().replace(/\b\d+(\.\d+)?\b/g, 'N')
  // A screen's sentence is often put together from sentences the source holds apart ("Tracking was interrupted." and the sentence
  // after it), so each sentence between two figures is searched for on its own.
  const sentences = body.split(/\bN\b/).flatMap((part) => part.split(/(?<=[.!?])\s+/)).map((part) => part.replace(/[….\s]+$/, '').trim()).filter((part) => part.length > 0)
  return sentences.every((part) => PRODUCT.includes(part) || PRODUCT_TEMPLATES.includes(part))
}

/** The double-quoted strings of a text that are more than one word: the ones that quote a screen. */
function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((match) => (match[1] ?? match[2])!).filter((quoted) => /\s/.test(quoted.trim()))
}

test('A-origin: every status line and label a row quotes is one the build prints', () => {
  assert.ok(ROWS.size >= 13, 'the A-origin table has its rows')
  const stale: string[] = []
  for (const [id, line] of ROWS) {
    for (const quoted of quotedStrings(line)) if (!printedByBuild(quoted)) stale.push(`${id}: "${quoted}"`)
  }
  assert.deepEqual(stale, [], `quoted text that no source file contains, so no screen can show it: ${stale.join('; ')}`)
})

test('A-origin: every bold name in a row is a control or a label the build has', () => {
  const missing: string[] = []
  for (const [id, line] of ROWS) {
    for (const [, bold] of line.matchAll(/\*\*([^*]+)\*\*/g)) if (!PRODUCT.includes(bold!)) missing.push(`${id}: **${bold}**`)
  }
  assert.deepEqual(missing, [], `bold text is the name of a control or a label, and these are in no source file: ${missing.join('; ')}`)
})

test('the retired strings are in no device document, and the scene names a document gives are objects the build draws', () => {
  // The first two are what the checklist said before the branches were merged, and the last two the markers the origin decal replaced.
  // They are known only as strings here: that they are gone is shown by the build (no source file contains them).
  // The first is assembled from two pieces: wp-one-point-offer.test.ts fails on any test file that spells the retired label out.
  const retired = ['Use one point' + ' instead', 'Heading unverified —', 'calibration anchor landmark', 'calibration anchor heading']
  for (const gone of retired) assert.ok(!PRODUCT_WITH_COMMENTS.includes(gone), `the premise is gone: a source file still says "${gone}"`)
  const documents = ['docs/testing/DEVICE_TESTING.md', 'docs/testing/DEVICE_TEST_KIT.md', 'docs/factory/12-origin-calibration-v1/README.md', 'docs/factory/atlas.html']
  for (const path of documents) {
    const text = flat(read(path))
    for (const gone of retired) assert.ok(!text.includes(gone), `${path} still says "${gone}"`)
  }
  // A scene object a row or the checklist names (`calibration origin`, `origin heading arrow`) must be one the build adds.
  const named = [...new Set([...flat(A_ORIGIN + B2).matchAll(/`((?:calibration|origin) [a-z ]+)`/g)].map((match) => match[1]!))]
  assert.ok(named.length >= 3, 'the checklist names the scene objects it looks for')
  for (const name of named) assert.ok(PRODUCT.includes(`'${name}'`) || PRODUCT.includes(`'${name.replace(/^calibration /, '')}'`) || PRODUCT.includes(name), `no source file names a scene object "${name}"`)
})

// ── The rows, one by one ─────────────────────────────────────────────────────

test('O2 and B2 row 1: they say how the origin is committed, and name every part of the decal the build draws', () => {
  // The parts come from building the decal: the group's own names, as a person would call them.
  const plan = originDecalPlan({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, 10)
  const decal = buildOriginDecal(plan, 'committed')
  // Only what is drawn (the line objects) counts as a part: the two groups that turn the arrow and the tick are not marks.
  const words: string[] = []
  decal.traverse((object: THREE.Object3D) => {
    if ((object as THREE.LineSegments).isLineSegments) words.push(object.name.replace(/^origin /, '').replace(/^heading /, ''))
  })
  assert.deepEqual([...words].sort(), ['arrow', 'crosshair', 'north tick', 'ring'], 'the decal draws a ring, a crosshair, an arrow and a north tick')
  const b2 = flat(B2.split('\n').find((line) => line.startsWith('| 1 |')) ?? '')
  assert.ok(b2, 'B2 has a row 1')
  for (const part of words) assert.ok(b2.includes(part), `B2 row 1 does not name the decal's ${part}`)
  assert.ok(b2.includes(COMMITTED_ORIGIN_NAME), `B2 row 1 does not name the scene object ${COMMITTED_ORIGIN_NAME}`)

  // First calibration: Confirm landmark, the heading point, the check-point step, and only then Commit.
  const o2 = row('O2')
  for (const control of [cardLabel('confirm'), SKIP_CHECK_LABEL, cardLabel('commit')]) assert.ok(o2.includes(control), `O2 does not tell a person to press ${control}`)
  assert.ok(o2.indexOf(SKIP_CHECK_LABEL) < o2.indexOf(cardLabel('commit')), 'O2 puts the check-point step before the commit, as the card does')
  assert.ok(o2.includes('calibration anchor check'), 'O2 says what a placed check point leaves in the scene')
})

test('O4: the row names the note under the status line that says the tick is session-local, and when it is absent', () => {
  const o4 = row('O4')
  assert.ok(o4.includes(NORTH_TICK_NOTE), `O4 does not quote the status note "${NORTH_TICK_NOTE}"`)
  assert.ok(o4.includes(`${STATUS_HOLD_MS / 1000} s`), `O4 does not say how long the status line holds (${STATUS_HOLD_MS / 1000} s)`)
  assert.match(o4, /magnetic/, 'the tick is the compass\'s north, which is magnetic: no declination is applied')
})

test('O5 and O6: the grid goes with the scan, and the recorded height is the datum the decal and the kept grid stand at', () => {
  assert.match(row('O5'), /re-anchor/i, 'a re-anchor ends the scan and takes the grid down with it')
  const o6 = row('O6')
  assert.match(o6, /datum/, 'calibrationGroundY is the landmark\'s datum')
  assert.doesNotMatch(o6, /height the floor grid was drawn at/, 'the grid is drawn at the landmark\'s own tap while the points are placed, and the datum is not that height')
})

test('O7: the status a return visit prints is the one the build makes of the record, for each of the two kinds of Place', () => {
  const record = (patch: Record<string, unknown>): ScanCalibration => ({
    method: 'two-point-ground',
    sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    calibratedAt: '2026-11-17T00:00:00.000Z',
    separationM: 2.04,
    residualM: 0.04,
    toleranceM: 0.1,
    status: 'provisional',
    ...patch,
  } as unknown as ScanCalibration)
  // A Place whose frame was made with Skip the check point: the return visit compares one distance.
  const distance = alignmentStatusText(record({ checkedBy: 'separation' })).split('\n')
  // A Place whose frame has a check point: three points are fitted.
  const fitted = alignmentStatusText(record({
    status: 'verified',
    checkedBy: 'constellation',
    fit: { pointsUsed: 3, rmsResidualM: 0.03, maxResidualM: 0.05, perPoint: [] },
  })).split('\n')
  const o7 = row('O7')
  assert.ok(o7.includes(distance[0]!), `O7 does not quote "${distance[0]}", what a visit that compared a distance prints`)
  assert.ok(o7.includes(distance[1]!.replace(/^• /, '').replace(/[\d.]+ cm/, 'N cm')), 'O7 does not quote the line that gives the distance off the stored one')
  assert.ok(o7.includes(fitted[0]!.replace(/[\d.]+ cm/, 'N cm')), `O7 does not quote "${fitted[0]}", what a visit that fitted three points prints`)
  assert.ok(o7.includes(NOT_CHECKED_SPOTS), 'O7 does not quote what a fit says it did not check')
  assert.match(o7, /Skip the check point/, 'O7 says which Place each reading is for: the one whose frame was made with the check point skipped')
  assert.ok(o7.includes(STORED_ORIGIN_NAME) || /stored origin/.test(o7), 'O7 names the stored origin')
  assert.ok(o7.includes(GHOST_NAME), `O7 does not name the rings of the stored points (${GHOST_NAME})`)
})

test('O8 and O10: the buttons and the gate message are the build\'s, and the row says which of them rewrites the Place', () => {
  const o8 = row('O8')
  assert.ok(o8.includes(REPLACE_REFERENCE_LABEL), `O8 does not name the button "${REPLACE_REFERENCE_LABEL}"`)
  assert.ok(o8.includes(cardLabel('replace')), 'O8 does not name Re-place points')
  assert.match(o8, /scratch/i, 'O8 rewrites the Place\'s reference, so it says to use another Place or run it last')
  const o10 = row('O10')
  assert.ok(o10.includes('Aim at the floor, or tap the same height again to use it anyway'), 'O10 does not quote what the card says when a tap is off the floor')
  assert.ok(o10.includes(FLOOR_CHECK_BYPASSED_TEXT), 'an off-floor tap accepted by a same-height retry is a floor-check bypass, and its commit prints that line')
})

test('O9 and O11: the button and the status are the build\'s, and a re-anchor leaves nothing of the earlier calibration', () => {
  const skip = cardLabel('skip')
  const o9 = row('O9')
  assert.ok(o9.includes(skip), `O9 does not name ${skip}`)
  assert.ok(o9.includes(REANCHOR_LABEL), `O9 does not take the leg that begins with ${REANCHOR_LABEL}`)
  assert.ok(o9.includes(interruptionText(1)), `O9 does not quote the prompt that offers it: "${interruptionText(1)}"`)
  assert.ok(row('O11').includes(skip), `O11 does not name ${skip}`)
  const o11 = row('O11')
  for (const line of NO_ALIGNMENT_TEXT.split('\n')) {
    const text = line.replace(/^[⚠•]\s*/, '')
    assert.ok(o11.includes(text), `O11 does not quote "${text}", which the build prints for a scan with no calibration`)
  }
  assert.ok(o11.includes(`${STATUS_HOLD_MS / 1000} s`), 'O11 does not say how long the status line holds')
})

test('O12: the bypass is reached the way the card allows, and the one-point button is the build\'s and is offered where the build offers it', () => {
  const o12 = row('O12')
  assert.ok(o12.includes(cardLabel('skip-ground')), `O12 does not name ${cardLabel('skip-ground')}`)
  assert.ok(o12.includes(FLOOR_CHECK_BYPASSED_TEXT), 'O12 does not quote the bypass line')
  assert.ok(o12.includes(`${cardMilliseconds('GROUND_WAIT_TIMEOUT_MS') / 1000} s`), 'the button appears only after the floor has not locked for GROUND_WAIT_TIMEOUT_MS: O12 does not say how long')
  assert.ok(o12.includes(ONE_POINT_LABEL), `O12 does not quote the one-point button "${ONE_POINT_LABEL}"`)
  assert.match(o12, /not offered|only/i, 'the one-point button is offered on a Place with no frame or a one-point frame only: O12 says where it is not')
  assert.ok(o12.includes(RECORD_UNVERIFIED_LABEL) || /not in Place frame/.test(o12), 'a bypassed commit leaves its scan outside the Place frame')
})

test('O13: the needle and its label are the HUD\'s, and the row says when it is hidden again', () => {
  const o13 = row('O13')
  assert.ok(read('src/main.ts').includes('`frame heading ${'), 'the HUD writes "frame heading <n>°" under the compass')
  assert.ok(o13.includes('frame heading'), 'O13 does not name the needle\'s label')
  for (const when of [/one-point/, /Continue uncalibrated/, /Re-anchor/i, /lost a conflict|conflict/]) assert.match(o13, when, `O13 does not say the needle is hidden after ${when}`)
})

test('the rows run O1 to O13 without a gap, and the documents that count them agree', () => {
  const ids = [...ROWS.keys()].map((id) => Number(id.slice(1)))
  assert.deepEqual(ids, ids.map((_, index) => index + 1), 'the A-origin rows are numbered in order from O1')
  const last = ids.at(-1)!
  const wave = read('docs/factory/12-origin-calibration-v1/README.md')
  assert.equal(wave.match(/A-origin \(O1 to O(\d+)\)/)?.[1], String(last), `the wave README counts the checklist as O1 to O${last}`)
  const ticket = read('docs/factory/12-origin-calibration-v1/0001-origin-decal-and-persisted-ground-height.md')
  assert.equal(ticket.match(/A-origin O1 to O(\d+) run on an iPhone/)?.[1], String(last), `the ticket's definition of done counts the checklist as O1 to O${last}`)
})

test('the ticket\'s acceptance criteria and definition of done quote only text the build prints', () => {
  const ticket = read('docs/factory/12-origin-calibration-v1/0001-origin-decal-and-persisted-ground-height.md')
  const criteria = [section(ticket, '## Definition of Done'), section(ticket, '## Acceptance Criteria')].join('\n')
  const stale = quotedStrings(criteria).filter((quoted) => !printedByBuild(quoted))
  assert.deepEqual(stale, [], `the ticket's pass conditions quote text no screen shows: ${stale.join('; ')}`)
})

test('the Place state each row needs is said: first pass, the return visit, and the rows that rewrite or bypass', () => {
  const intro = flat(A_ORIGIN.split('\n| # |')[0]!)
  assert.match(intro, /scratch Place/, 'the checklist says which rows need a scratch Place')
  assert.match(intro, /Skip the check point/, 'the checklist says how the first pass is committed, because O7 depends on it')
})

test('the mismatch screen and the bypass: the documents that name "Replace this Place\'s reference" say what the same button reads under a bypass', () => {
  const doc = flat(DEVICE_TESTING)
  assert.ok(doc.includes(`"${RECORD_UNVERIFIED_LABEL}"`) || doc.includes(`**${RECORD_UNVERIFIED_LABEL}**`), `DEVICE_TESTING.md never says the button reads ${RECORD_UNVERIFIED_LABEL} when the floor check was bypassed`)
  for (const heading of ['### Procedure 2 — probe-point protocol (DX2)', '### Procedure 3 — units tape test (DX1)']) {
    const text = flat(section(DEVICE_TESTING, heading))
    if (text.includes(REPLACE_REFERENCE_LABEL)) assert.ok(text.includes(RECORD_UNVERIFIED_LABEL), `${heading} names ${REPLACE_REFERENCE_LABEL} and not what it reads under a bypass`)
  }
  // The override button was called "Use anyway" until WP-08. Its label now is the constant, and no button of the card reads it.
  const labels = [...CARD.matchAll(/<button id="project-calibration-[a-z-]+"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]!.trim())
  assert.ok(labels.length >= 10 && !labels.includes('Use anyway'), 'the card has a button called Use anyway: the premise is gone')
  assert.doesNotMatch(flat(DEVICE_TESTING), /\*\*Use anyway\*\*/, 'DEVICE_TESTING.md names a button "Use anyway", which the card does not have')
})

// ── Comments that point at a constant ────────────────────────────────────────

test('a comment in src that names a constant and the file it lives in names the file that declares it', () => {
  // `POSE_JUMP_THRESHOLD_M` "in eighthwall.ts" was read by two comments after the constant had moved, and after it was gone. A reader was
  // sent to a file with no such name. The rule is the one the native package holds its own files to, for every file of src.
  const sources = tsFiles('src')
  // A module that re-exports a name (`export { MAX_FIT_POINTS }`, as frame-fit.ts does) is a file the name can be reached in.
  const declares = (path: string, name: string): boolean =>
    new RegExp(`(?:const|let|function|class|type|interface|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(read(path))
  const named = (text: string): Array<[file: string, name: string]> => [
    ...[...text.matchAll(/((?:[\w.-]+\/)*[\w-]+\.ts)[ \t]+`([A-Z][A-Z0-9_]{3,})`/g)].map((m): [string, string] => [m[1]!, m[2]!]),
    ...[...text.matchAll(/`([A-Z][A-Z0-9_]{3,})`[ \t]+(?:in|of|from)[ \t]+((?:[\w.-]+\/)*[\w-]+\.ts)/g)].map((m): [string, string] => [m[2]!, m[1]!]),
  ]
  const wrong: string[] = []
  let checked = 0
  for (const source of sources) {
    for (const [file, name] of named(read(source))) {
      const tail = file.replace(/^(\.{1,2}\/)+/, '')
      const candidates = sources.filter((path) => path === tail || path.endsWith(`/${tail}`))
      if (existsSync(join(ROOT, tail))) candidates.push(tail)
      checked += 1
      if (!candidates.some((path) => declares(path, name))) wrong.push(`${source} says ${name} is in ${file}`)
    }
  }
  assert.ok(checked >= 4, `the scan found only ${checked} such comments: the pattern no longer reads the source`)
  assert.deepEqual(wrong, [])
})

// ── The shells: what is registered, and what asks Google Play for ARCore ─────

/** The plugin classes the shells register, from the shells' own sources. */
function registeredPlugins(): { android: string[]; ios: string[]; xcodeTarget: string[] } {
  const android = [...read('mobile/android/app/src/main/java/com/companionintelligence/scan/MainActivity.java').matchAll(/registerPlugin\(\s*(\w+)\.class\s*\)/g)].map((match) => match[1]!)
  const ios = [...read('mobile/ios/App/App/ScanBridgeViewController.swift').matchAll(/registerPluginInstance\(\s*(\w+)\(\)\s*\)/g)].map((match) => match[1]!)
  const xcodeTarget = [...new Set([...read('mobile/ios/App/App.xcodeproj/project.pbxproj').matchAll(/(\w+Plugin)\.swift in Sources/g)].map((match) => match[1]!))]
  return { android, ios, xcodeTarget }
}
const plugins = registeredPlugins()
const arSessionRegistered = [...plugins.android, ...plugins.ios, ...plugins.xcodeTarget].includes('ArSessionPlugin')

test('the shells register ScanAR, and ArSession only where this test says it is not', () => {
  assert.deepEqual(plugins.android, ['ScanARPlugin'], 'the Android shell registers one plugin')
  assert.deepEqual(plugins.ios, ['ScanARPlugin'], 'the iOS shell registers one plugin')
  assert.ok(plugins.xcodeTarget.includes('ScanARPlugin'), 'the iOS target compiles ScanARPlugin.swift')
  // If this fails, the owner has registered ArSession: every document below that says it is unregistered must change.
  assert.equal(arSessionRegistered, false, 'ArSession is registered: the documents say it is not')
})

test('a document that names the ArSession plugin says in the same place that it is unregistered', () => {
  assert.equal(arSessionRegistered, false, 'the premise is gone: ArSession is registered')
  const unregistered = /unregistered|not registered|registered by neither|registers neither/i
  const bad: string[] = []
  for (const path of ['docs/testing/DEVICE_TEST_KIT.md', 'docs/operations/AR_DEVICE_SUPPORT.md', 'NOTICE.md', 'mobile/README.md', 'README.md', 'docs/operations/PRIVACY.md']) {
    for (const chunk of chunksOf(read(path))) if (/ArSession/.test(chunk) && !unregistered.test(chunk)) bad.push(`${path}: ${flat(chunk).slice(0, 90)}…`)
  }
  assert.deepEqual(bad, [], `these name the ArSession plugin as though a shell ran it:\n${bad.join('\n')}`)
})

test('the device kit and the AR support matrix name the plugin the shells run, and say native is tried first', () => {
  const kit = read('docs/testing/DEVICE_TEST_KIT.md')
  assert.ok(kit.includes('ScanAR'), 'the kit never names ScanAR')
  assert.ok(kit.includes('ScanAR.capabilities()'), 'the kit does not tell a tester to read ScanAR.capabilities() in the shell console')
  const shells = flat(section(kit, '## AR in the shells'))
  assert.match(shells, /native/i)
  assert.match(shells, /8th Wall/)
  assert.match(shells, /WebXR/)
  assert.match(read('src/main.ts'), /createNativeARProvider\(\{\s*fallback:\s*createWebRuntimeProvider\s*\}\)/, 'the premise is gone: the scanner no longer starts on the native runtime first')
  const matrix = read('docs/operations/AR_DEVICE_SUPPORT.md')
  assert.ok(matrix.includes('ScanAR'), 'the AR support matrix never names ScanAR')
  assert.ok(matrix.includes('src/ar/native.ts'), 'the matrix does not point at the provider the shells run')
})

test('NOTICE.md names ScanAR and does not say Google Play installs ARCore for the app: no registered plugin asks it to', () => {
  const asksPlayToInstall = /requestInstall/.test(read('mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java'))
  assert.equal(asksPlayToInstall, false, 'the premise is gone: the registered Android plugin asks Google Play to install ARCore')
  const notice = flat(read('NOTICE.md'))
  assert.ok(notice.includes('`ScanAR`'), 'NOTICE.md never names the plugin that calls ARCore and ARKit')
  assert.doesNotMatch(notice, /installs or updates when an AR session starts/, 'NOTICE.md says Google Play installs ARCore when a session starts')
})

test('the console lines the device documents tell a tester to look for are lines the native provider writes', () => {
  // `[native-ar] ...` is the provider's own log prefix. What a document quotes up to its first placeholder or colon must be in the source.
  const native = withoutComments(read('src/ar/native.ts'))
  const quoted = [...(DEVICE_TESTING + read('docs/testing/DEVICE_TEST_KIT.md')).matchAll(/`(\[native-ar\][^`]*)`/g)].map((match) => match[1]!)
  assert.ok(quoted.length >= 3, `the documents quote ${quoted.length} native-ar console lines: Checklist D and the kit say what to look for`)
  const missing = quoted.filter((line) => !native.includes(line.split(/<|:/)[0]!.trim()))
  assert.deepEqual(missing, [], `these console lines are not written by src/ar/native.ts: ${missing.join('; ')}`)
})

// ── The one version of ARCore ────────────────────────────────────────────────

test('the Android app declares ARCore once, from the version the notices name', () => {
  const gradle = read('mobile/android/app/build.gradle')
  const declarations = gradle.match(/implementation\s+"com\.google\.ar:core:[^"]*"/g) ?? []
  assert.deepEqual(declarations, ['implementation "com.google.ar:core:$arcoreVersion"'], 'one declaration, with its version in variables.gradle')
  const version = /arcoreVersion\s*=\s*'([^']+)'/.exec(read('mobile/android/variables.gradle'))?.[1]
  assert.ok(version, 'variables.gradle has arcoreVersion')
  for (const path of ['NOTICE.md', 'THIRD_PARTY.md']) assert.ok(read(path).includes(version), `${path} names ARCore ${version}`)
})

// ── PRIVACY.md and the privacy manifest ──────────────────────────────────────

test('PRIVACY.md does not say the privacy manifest is unwritten while the iOS target ships a draft of it', () => {
  const manifest = 'mobile/ios/App/App/PrivacyInfo.xcprivacy'
  assert.ok(existsSync(join(ROOT, manifest)), 'the premise is gone: there is no draft manifest')
  assert.match(read('mobile/ios/App/App.xcodeproj/project.pbxproj'), /PrivacyInfo\.xcprivacy in Resources/, 'the Xcode project ships the manifest')
  const privacy = flat(read('docs/operations/PRIVACY.md'))
  assert.doesNotMatch(privacy, /PrivacyInfo\.xcprivacy` and its required-reason declarations are not written yet/)
  assert.match(privacy, /PrivacyInfo\.xcprivacy` is drafted/, 'PRIVACY.md says what mobile/README.md says: the manifest is drafted')
})

// ── The atlas ────────────────────────────────────────────────────────────────

const ATLAS = read('docs/factory/atlas.html')
/** The Project calibration card, to the end of its diffs. */
const CALIBRATION_CARD = ATLAS.slice(ATLAS.indexOf('<h4>Project calibration (spatial frame)</h4>'), ATLAS.indexOf('<h4>SLAM drift &amp; repeatability measurement</h4>'))

test('the atlas says what the build says a distance check is worth, and what verified is', () => {
  // The build's own verdict for a distance well inside the tolerance.
  const verdict = verifyTwoPoint({ separationM: 2.0, storedSeparationM: 2.01, sigmaHatM: null })
  assert.notEqual(verdict.status, 'verified', 'the premise is gone: a distance inside the tolerance is verified')
  assert.equal(verdict.status, 'provisional')
  assert.ok(CALIBRATION_CARD.length > 1000, 'the atlas has the calibration card')
  assert.doesNotMatch(flat(CALIBRATION_CARD), /within <code class="v">toleranceM<\/code> reports <code class="v">'verified'<\/code>/, 'the card says a distance inside the tolerance reports verified')
  assert.match(flat(CALIBRATION_CARD), /provisional/, 'the card says a distance check is provisional')
  assert.match(flat(CALIBRATION_CARD), /three or more points|3 or more points/, 'the card says verified is a fit of three or more points')
  const row = flat(ATLAS.slice(ATLAS.indexOf('<td class="name">ScanCalibration</td>'), ATLAS.indexOf('<td class="name">CaptureResult</td>')))
  assert.doesNotMatch(row, /has <strong>no current producer<\/strong>/, 'the ScanCalibration row says verified has no producer')
  assert.doesNotMatch(row, /regains a producer: a measured two-point separation residual within tolerance/, 'the ScanCalibration row says a two-point distance regains verified')
})

test('the atlas card keeps the reference-photo and return-visit-aid account this branch wrote, as far as the build still does it', () => {
  const card = flat(CALIBRATION_CARD)
  // What the build does, from its own sources: the aids exist and `?returnaids=off` turns them off.
  assert.equal(returnAidsEnabled('?returnaids=off'), false)
  assert.equal(returnAidsEnabled(''), true)
  assert.ok(card.includes('returnaids=off'), 'the card never says ?returnaids=off turns the aids off')
  assert.ok(card.includes(WRONG_PLACE_LABEL), `the card never names the exit "${WRONG_PLACE_LABEL}"`)
  assert.match(card, /Point A/, 'the card does not say the return visit asks for Point A and Point B by name')
  assert.match(card, /projected through the capture pose/, 'the card does not say where the crosshair goes once the phone has moved')
  // The photos are taken at the tap for the heading marker and the check point, and at Confirm for the landmark.
  assert.match(CARD, /Not at Commit|not at Commit/i)
  assert.doesNotMatch(card, /captured <em>at commit<\/em>, crosshaired at the recorded tap/, 'the card says the photos are taken at commit and crosshaired at the recorded tap')
  assert.match(card, /at Confirm/, 'the card does not say the landmark is photographed at Confirm')
  // A frame with an id keeps its photos under the frame (ADR 0011), and the phone sends them there.
  assert.match(read('src/project/frame-sync.ts'), /frames\/\$\{encodeURIComponent\(frameId\)\}\/reference-photos/)
  assert.ok(card.includes('/frames/:frameId/reference-photos'), 'the card says the photos go to /projects/:id/reference-photos for every frame')
})

test('the atlas says a re-anchor and a skip take the kept floor grid down, and the origin decal is named as the scene names it', () => {
  const card = flat(CALIBRATION_CARD)
  assert.ok(card.includes(COMMITTED_ORIGIN_NAME) || card.includes('origin decal'), 'the card never names the origin decal')
  assert.match(card, /re-anchor|Continue uncalibrated/i, 'the card never says what takes the kept grid down')
})
