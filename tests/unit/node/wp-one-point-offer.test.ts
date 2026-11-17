/**
 * The one-point tier is not offered on a Place that already has a two-point frame, and says what it costs
 * where it is (WP-02, owner decision D5).
 *
 * The two tiers do not share a frame: a two-point frame's +Z runs along that Place's baseline, a one-point
 * frame's along true north, and the server places a scan from either without asking which made it. So a
 * one-point scan on a two-point Place is rotated against the others by the baseline's compass bearing
 * (src/ar/one-point-offer.ts has the whole argument). "Use one point instead (less accurate)" was offered on
 * every return visit and said nothing of that. It is now hidden where it would do that, and elsewhere it says
 * "this scan will not line up with other scans".
 *
 * The decision is a pure function and is run here for every combination. It is an allow-list (a Place with no
 * frame, or with a one-point frame), so a stored frame of a kind this build does not know is not offered the
 * tier, and the modal asks the same rule when the button is clicked. The modal itself is run, against a
 * stand-in document, in wp-calibration-modal.test.ts, which is where "the button is hidden on a Place with a
 * two-point frame" is shown to be true of what the person sees. The tests below that read the modal's source
 * are named "source shape:" and claim no behaviour: they pin that the modal draws the shared label and asks the
 * shared decision, so a change that routes round either shows here by name.
 *
 * What is not here: the compass-null refusal in commitSinglePoint belongs to package WP-10, which rewrites that
 * function, and this file says nothing about its body.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-one-point-offer.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ONE_POINT_LABEL,
  onePointOffered,
  type CalibrationStage,
  type OnePointOfferInput,
} from '../../../src/ar/one-point-offer.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const offer = (stage: CalibrationStage, hasLandmark: boolean, storedMethod: OnePointOfferInput['storedMethod']) =>
  onePointOffered({ stage, hasLandmark, storedMethod })

test('a Place with a two-point frame is never offered the one-point tier, at any stage', () => {
  for (const stage of ['ground', 'landmark', 'heading', 'review', 'mismatch'] as const) {
    for (const hasLandmark of [false, true]) {
      assert.equal(offer(stage, hasLandmark, 'two-point-ground'), false, `${stage}, landmark ${hasLandmark}`)
    }
  }
})

test('a first visit is offered it from the moment a landmark is placed, and only while placing', () => {
  assert.equal(offer('landmark', true, null), true)
  assert.equal(offer('heading', true, null), true)
  assert.equal(offer('review', true, null), true)
  assert.equal(offer('landmark', false, null), false, 'nothing to continue with before the landmark is tapped')
  assert.equal(offer('ground', true, null), false, 'not before the floor is established')
  assert.equal(offer('ground', false, null), false)
  assert.equal(offer('mismatch', true, null), false, 'not while a pair is being compared with a stored one')
})

test('a Place whose frame is itself one-point is offered it as a first visit is', () => {
  // The claim on the label is as true there: two one-point scans meet only where the same spot is tapped.
  for (const stage of ['landmark', 'heading', 'review'] as const) {
    assert.equal(offer(stage, true, 'ground-tap-compass'), true, stage)
  }
  assert.equal(offer('landmark', false, 'ground-tap-compass'), false)
  assert.equal(offer('mismatch', true, 'ground-tap-compass'), false)
  assert.equal(offer('ground', true, 'ground-tap-compass'), false)
})

test('a stored frame of a kind this build does not know is not offered it: the rule is an allow-list', () => {
  // A tier a later package adds, a record the server holds that is not one of ours, a frame with no method at all.
  // Nothing here can say a one-point scan lines up with a frame of a kind it has not seen, so the answer is to hide.
  for (const unknown of ['three-point-ground', 'known-distance', 'banana', '', undefined, 42]) {
    for (const stage of ['landmark', 'heading', 'review'] as const) {
      assert.equal(offer(stage, true, unknown as unknown as OnePointOfferInput['storedMethod']), false, `${stage}, method ${String(unknown)}`)
    }
  }
})

test('the only stored states offered it are no frame and a one-point frame', () => {
  const methods: Array<OnePointOfferInput['storedMethod']> = [null, 'ground-tap-compass', 'two-point-ground']
  const offered = methods.filter((method) => offer('review', true, method))
  assert.deepEqual(offered, [null, 'ground-tap-compass'])
})

test('the label says what the scan will not do, and no longer says only "less accurate"', () => {
  assert.equal(ONE_POINT_LABEL, 'Continue with one point (this scan will not line up with other scans)')
  assert.match(ONE_POINT_LABEL, /will not line up with other scans/)
  assert.doesNotMatch(ONE_POINT_LABEL, /less accurate|verified|aligned/i)
})

test('nothing in the app or its specs still carries the retired label', () => {
  const stale: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = join(dir, name)
      if (statSync(join(ROOT, path)).isDirectory()) walk(path)
      else if (/\.(ts|html)$/.test(name) && /Use one point instead/.test(read(path))) stale.push(path)
    }
  }
  walk('src')
  walk('tests')
  assert.deepEqual(stale.filter((path) => path !== 'tests/unit/node/wp-one-point-offer.test.ts'), [])
  assert.doesNotMatch(read('index.html'), /Use one point instead/)
})

// ── Source shape: the modal ────────────────────────────────────────────────────────────────────────

test('source shape: the modal draws the shared label on its button and shows the button by the shared decision', () => {
  const modal = read('src/ar/project-calibration.ts')
  assert.match(modal, /import \{ ONE_POINT_LABEL, onePointOffered \} from '\.\/one-point-offer'/)
  assert.match(
    modal,
    /<button id="project-calibration-fallback" type="button" class="project-calibration-link" hidden>\$\{ONE_POINT_LABEL\}<\/button>/,
    'the label is the constant, not a second copy of the sentence',
  )
  assert.match(modal, /show\(fallbackBtn, onePointOfferNow\(\)\)/, 'visibility is the decision')
  // WP-08: a modal that runs as an upgrade (a first calibration over a reference it is about to replace) never offers
  // the one-point tier, which would replace a two-point reference with a weaker one. That guard comes first; after it
  // the decision is fed exactly what it always was.
  assert.match(
    modal,
    /function onePointOfferNow\(\): boolean \{\n(?:\s+\/\/.*\n)*\s+if \(isUpgrade\(options\.generation\)\) return false\n\s+return onePointOffered\(\{\n\s+stage,\n\s+hasLandmark: !!points\.landmark,\n\s+storedMethod: existingFrame \? existingFrame\.method : null,\n\s+\}\)\n\s+\}/,
    'fed the method of the stored frame, and null only when there is no stored frame: a frame with no method is not "no frame"; an upgrade is refused first',
  )
  assert.match(
    modal,
    /fallbackBtn\.addEventListener\('click', \(\) => \{\n(?:\s+\/\/.*\n)*\s+if \(onePointOfferNow\(\)\) commitSinglePoint\(\)\n\s+\}\)/,
    'and a click is accepted by the same decision',
  )
  assert.equal(modal.split('onePointOffered(').length - 1, 1, 'one place decides')
  assert.equal(modal.split('commitSinglePoint()').length - 1, 2, 'the function is declared once and called once, behind the decision')
})

test('source shape: the hard minimum still gates the commit, and the heading step and separation line come from the guidance', () => {
  const modal = read('src/ar/project-calibration.ts')
  assert.match(modal, /if \(separationM < MIN_POINT_SEPARATION_M\) \{\n\s+renderStage\(\)\n\s+return\n\s+\}/, 'a pair under 1.0 m still cannot be committed (owner decision D2)')
  assert.match(modal, /const farEnough = sep !== null && sep >= MIN_POINT_SEPARATION_M/)
  assert.match(modal, /copy\.textContent = aids\.headingCopy\(\) \?\? headingStepCopy\(storedTwoPoint\?\.separationM, visitSteps\)/, 'the stored pair\'s length is what a return visit is told: by the return-visit aids, and by the guidance when they are off, counted to the taps the visit asks for')
  // The pair's line is baselineGuidance, and once there is a check point its own line replaces it (WP-04b, checkPointGuidance). The
  // stored pair's length goes in, and on a return visit to a Place that stores a check point so do its points, for the shape the
  // visit has to reproduce.
  assert.match(modal, /const guidance = markerGuidance\(\)\n\s+\?\? baselineGuidance\(sep, storedTwoPoint\?\.separationM, commitOptions\.sigmaHatM, stage === 'check' \? comparedPoints\(storedTwoPoint\) : null\)\n\s+separationEl\.dataset\.state = guidance\.state\n\s+separationEl\.textContent = guidance\.text/)
  assert.doesNotMatch(modal, /a longer baseline is more accurate still/)
  assert.doesNotMatch(modal, /walk \$\{MIN_POINT_SEPARATION_M/, 'the step no longer tells the person to walk the hard minimum')
})
