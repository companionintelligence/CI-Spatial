/**
 * The editor's alignment-check card is wired to the page it draws into.
 *
 * `src/viewer/register-proposal.ts` finds its section and list by element id, and
 * `src/viewer/viewer.ts` hands it the editor's world and calls it whenever the job
 * list is drawn. Neither file can be imported here (three.js and the DOM), so, like
 * the other wiring checks in this directory, these read the sources. They are named
 * "source shape:" and claim no behaviour: that the card paints, and that Apply
 * moves a scan in a browser, is for a browser. What they do hold is the part a
 * rename silently breaks: an id the module looks up that the page no longer has, a
 * job type the dropdown cannot queue, a render call that went missing.
 *
 * The rules Apply follows are tested for real in wp-15a-register-proposal.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15a-*.test.ts
 * `npm run verify` reaches it through `npm run test:wave`, which runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('source shape: every element id the card looks up is in viewer.html', () => {
  const card = read('src/viewer/register-proposal.ts')
  const page = read('viewer.html')
  const ids = [...card.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]!)
  assert.deepEqual(ids.sort(), ['register-proposals', 'register-proposals-section'])
  for (const id of ids) assert.match(page, new RegExp(`id="${id}"`), `viewer.html has no #${id}`)
  assert.match(page, /id="register-proposals-section"[^>]*\bhidden\b/, 'the section stays hidden until there is a check to show')
})

test('source shape: the card styles stand beside the existing rules and do not split one of them', () => {
  const page = read('viewer.html')
  // The button rule is one selector list. A new rule written into the middle of it silently restyles the Copy button.
  assert.match(page, /\.copy-link-btn,\s*\.job-btn,\s*\.transform-btn \{/)
  for (const selector of ['.register-card', '.register-headline', '.register-actions']) {
    assert.match(page, new RegExp(`^\\s*${selector.replace('.', '\\.')}[ {:]`, 'm'), `no rule for ${selector}`)
  }
})

test('source shape: the editor draws the cards with the job list, and hands them its own patch writer', () => {
  const viewer = read('src/viewer/viewer.ts')
  assert.match(viewer, /import \{ mountRegisterProposals, type RegisterProposals \} from '\.\/register-proposal'/)
  const render = viewer.slice(viewer.indexOf('function renderWorldPanel()'))
  assert.match(render.slice(0, render.indexOf('\n}\n')), /registerProposals \?\?= mountRegisterProposals\(registerProposalHost\)\n\s+registerProposals\.render\(\)/)
  assert.match(viewer, /postPatch: \(body: Parameters<typeof postEditPatch>\[0\]\) => postEditPatch\(body\)/, 'Apply writes through the same save as the Edit gizmo')
  assert.match(viewer, /moveScan: \(scanId: string, matrix: number\[\]\) => \{[\s\S]*?applyMatrix\(loaded\.root, matrix\)/)
})

test('source shape: the Advanced queue can queue the job, and Prepare still does not queue it for the person', () => {
  const page = read('viewer.html')
  assert.match(page, /<option value="place-register">/)
  const viewer = read('src/viewer/viewer.ts')
  const guided = viewer.slice(viewer.indexOf('const GUIDED_WORKFLOWS'), viewer.indexOf('async function queueGuidedWorkflow'))
  assert.doesNotMatch(guided, /place-register/, 'an alignment check is proposed on upload or asked for; no guided step runs it behind a click on Prepare')
})

test('source shape: the server dispatches the job type, lists it for the jobs route and queues it when a scan joins a Place', () => {
  const server = read('server/main.ts')
  assert.match(server, /if \(job\.type === 'place-register'\) \{\s+await _runPlaceRegisterJob\(slug, jobId\)\s+return\s+\}/)
  assert.match(server, /const WORLD_JOB_TYPES = new Set<WorldJobType>\(\[[\s\S]*?'place-register',[\s\S]*?\]\)/)
  assert.match(server, /void queuePlaceRegisterOnJoin\(filename, typeof metaRaw === 'string' \? metaRaw : null\)/)
  assert.match(server, /const guard = guardRegistrationPatch\(world, body\)/)
  // No branch sets a scan aligned on this job's account: `applyCompletedJobToWorld` has no case for it.
  const apply = server.slice(server.indexOf('function applyCompletedJobToWorld'), server.indexOf('function jobResultFor'))
  assert.doesNotMatch(apply, /place-register/)
})
