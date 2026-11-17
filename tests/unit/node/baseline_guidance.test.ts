/**
 * Placement guidance (src/world/baseline-guidance.ts): where the calibration points should be, what their placement is
 * worth, and the words that say so.
 *
 * Until WP-04b the figure on screen was `sessionDisagreementM`, a closed form for two points fitted to the investigation's
 * Monte Carlo of two visits to one Place (a landmark and a heading marker tapped twice with 3 cm of noise, a point 5 m
 * out). It is gone: the figure is now `frameUncertaintyAt` (src/world/frame-fit.ts), the same prediction for any number
 * of points, which tests/unit/deno/frame_fit.test.ts holds to simulated visit pairs. This file holds the guidance to
 * three things:
 *
 *  - the figure is the fit's, said in the fit's words (`estimateSentence`, the sentence a verdict uses when it withholds
 *    "verified" for a weak shape), and it agrees with the investigation's table for two points to within what the two
 *    models differ by (a least-squares frame against a landmark-anchored one);
 *  - the sentences: what a first visit is told, what a return visit is told (the stored pair, and never to walk farther),
 *    what is said about the check point (where it is, whether the fit can use it, whether the shape can be checked), and that
 *    every figure is an estimate;
 *  - the adopted constants say so where they are defined (ADR 0005 rule 5).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/baseline_guidance.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RECOMMENDED_BASELINE_M,
  RECOMMENDED_CHECK_DISTANCE_M,
  RECOMMENDED_CHECK_OFFSET_M,
  TAP_SIGMA0_M,
  baselineGuidance,
  checkGeometry,
  checkPointGuidance,
  headingStepCopy,
  landmarkStepCopy,
  stepPrefix,
} from '../../../src/world/baseline-guidance.ts'
import { DUPLICATE_POINT_GAP_M, MIN_PERPENDICULAR_OFFSET_M, estimateSentence, frameUncertaintyAt } from '../../../src/world/frame-fit.ts'
import { MIN_POINT_SEPARATION_M } from '../../../src/world/geo.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const at = (x: number, z: number): Vec3 => ({ x, y: 0, z })
const pair = (baselineM: number): Vec3[] => [at(0, 0), at(0, baselineM)]

/** The sentence the fit's prediction gives for these points at the adopted tap noise, written the way a verdict writes it. */
const estimateOf = (points: Vec3[]): string => estimateSentence(frameUncertaintyAt(points, TAP_SIGMA0_M, 5)!.position95M)

// ── The figure is the fit's ──────────────────────────────────────────────────────────────────────────

test('the estimate on a first visit is the fit\'s prediction for the pair, in the fit\'s sentence', () => {
  for (const baseline of [1.0, 1.5, 2.0, 3.0, 3.4, 5.0]) {
    const { text } = baselineGuidance(baseline)
    assert.ok(text.includes(estimateOf(pair(baseline))), `${baseline} m: ${text}`)
  }
})

test('against the investigation\'s table for two points: the 95th percentile at 3 cm of tap noise, 5 m out, is 56, 28 and 20 cm for 1, 2 and 3 m', () => {
  // The simulation's table (a landmark-anchored frame, a point 60 degrees off the baseline) and the least-squares
  // prediction differ in what they model, and agree to within a few per cent: 57 against 56, 30 against 28, 21 against 20 cm.
  for (const [baseline, p95Cm] of [[1, 56], [2, 28], [3, 20]] as const) {
    const predicted = frameUncertaintyAt(pair(baseline), 0.03, 5)!.position95M * 100
    assert.ok(Math.abs(predicted / p95Cm - 1) < 0.1, `${baseline} m: predicted ${predicted.toFixed(1)} cm against ${p95Cm} cm`)
  }
})

test('what the walk is worth: the estimate falls with every metre of baseline, and by less each time', () => {
  const figure = (d: number) => frameUncertaintyAt(pair(d), TAP_SIGMA0_M, 5)!.position95M
  assert.ok(figure(3) / figure(1) < 0.4 && figure(3) / figure(1) > 0.3, `3 m is ${(figure(3) / figure(1)).toFixed(2)} of 1 m`)
  const gains = [1, 2, 3, 4, 5, 6].map((d) => figure(d) - figure(d + 1))
  assert.ok(gains.every((gain) => gain > 0))
  assert.ok(gains.every((gain, i) => i === 0 || gain < gains[i - 1]!))
})

test('the defaults are the adopted constants', () => {
  assert.equal(TAP_SIGMA0_M, 0.03)
  assert.equal(RECOMMENDED_BASELINE_M, 3)
  assert.equal(RECOMMENDED_CHECK_DISTANCE_M, 3)
  assert.equal(RECOMMENDED_CHECK_OFFSET_M, 2)
  assert.equal(baselineGuidance(2).text, baselineGuidance(2, null, TAP_SIGMA0_M).text)
})

test('the estimate scales with the tap noise it is given', () => {
  const noisy = frameUncertaintyAt(pair(3), 0.06, 5)!.position95M
  const quiet = frameUncertaintyAt(pair(3), 0.03, 5)!.position95M
  assert.ok(Math.abs(noisy / quiet - 2) < 1e-9, 'twice the noise, twice the figure')
  assert.ok(baselineGuidance(3, null, 0.06).text.includes(estimateSentence(noisy)))
})

// ── The words, for the pair ──────────────────────────────────────────────────────────────────────────

test('under the hard minimum the line is the one the modal always showed, and the pair cannot be committed', () => {
  assert.deepEqual(baselineGuidance(0.6), {
    state: 'short',
    text: '0.60 m apart — need at least 1.0 m. Walk further and tap again.',
  })
  assert.equal(MIN_POINT_SEPARATION_M, 1.0, 'the hard minimum is still 1.0 m (owner decision D2)')
  assert.equal(baselineGuidance(MIN_POINT_SEPARATION_M - 0.001).state, 'short')
  assert.equal(baselineGuidance(MIN_POINT_SEPARATION_M).state, 'ok')
  assert.equal(baselineGuidance(Number.NaN).state, 'short', 'a distance that is not a number is not far enough')
})

test('at the minimum the line says estimate, quotes the figure, and tells the person to walk 3 m or more', () => {
  const line = baselineGuidance(1.0)
  assert.equal(line.state, 'ok')
  assert.equal(
    line.text,
    '1.00 m apart. Estimate: two scans would place a spot 5 m away up to about 59.2 cm apart (95 of 100 times). 3 m or more is better.',
  )
})

test('past the recommended walk the advice goes and the estimate stays', () => {
  const line = baselineGuidance(3.4)
  assert.equal(line.state, 'ok')
  assert.equal(line.text, '3.40 m apart. Estimate: two scans would place a spot 5 m away up to about 18.5 cm apart (95 of 100 times).')
  assert.doesNotMatch(line.text, /better/)
  assert.match(baselineGuidance(RECOMMENDED_BASELINE_M - 0.01).text, /3 m or more is better/)
  assert.doesNotMatch(baselineGuidance(RECOMMENDED_BASELINE_M).text, /better/)
})

test('on a return visit the estimate is for the stored pair, which is the shape the visit has to reproduce', () => {
  // Walking 3 m against a stored 1 m pair: the visit is judged against, and must reproduce, the 1 m pair.
  assert.equal(
    baselineGuidance(3.0, 1.0).text,
    '3.00 m apart. Stored pair: 1.00 m. Estimate: two scans would place a spot 5 m away up to about 59.2 cm apart (95 of 100 times).',
  )
  assert.equal(baselineGuidance(3.0, null).text, baselineGuidance(3.0).text)
  assert.equal(
    baselineGuidance(3.0, 3.0).text,
    '3.00 m apart. Stored pair: 3.00 m. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
  )
})

test('on a return visit the line names the stored pair and never tells the person to walk farther', () => {
  // The commit turns away a pair whose length is more than the spacing tolerance from the stored one, and "Use anyway"
  // replaces the Place's frame, so "3 m or more is better" there sends a person who obeys it to the mismatch screen.
  for (const stored of [1.0, 1.2, 1.5, 2.0, 2.99, 3.0, 5.0]) {
    for (const separation of [1.0, 1.4, 2.0, 2.99, 3.0, 4.2]) {
      const { state, text } = baselineGuidance(separation, stored)
      assert.equal(state, 'ok')
      assert.match(text, new RegExp(`^${separation.toFixed(2).replace('.', '\\.')} m apart\\. Stored pair: ${stored.toFixed(2).replace('.', '\\.')} m\\. Estimate: `), `${separation} against ${stored}`)
      assert.doesNotMatch(text, /better|or more|walk|longer|further/i, `${separation} m against a stored ${stored} m`)
    }
  }
  assert.match(baselineGuidance(1.5).text, /3 m or more is better\.$/, 'the same walks on a first visit are still advised')
})

test('a stored pair that cannot be a length is not named, and the line is the first-visit one', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.equal(baselineGuidance(1.5, bad).text, baselineGuidance(1.5).text, `stored ${String(bad)}`)
    assert.doesNotMatch(baselineGuidance(1.5, bad).text, /Stored pair/)
  }
})

test('under the hard minimum a return visit gets the same short line, whatever is stored', () => {
  assert.deepEqual(baselineGuidance(0.6, 1.5), baselineGuidance(0.6))
  assert.deepEqual(baselineGuidance(MIN_POINT_SEPARATION_M - 0.001, 1.0), baselineGuidance(0.999))
})

test('every line that quotes a number is labelled an estimate, and none claims a verification', () => {
  for (const separation of [1.0, 1.5, 2.0, 2.99, 3.0, 4.0, 8.0]) {
    for (const stored of [undefined, null, 1.0, 3.5]) {
      const { state, text } = baselineGuidance(separation, stored)
      assert.equal(state, 'ok')
      assert.match(text, /\bEstimate: /, `${separation} m, stored ${String(stored)}`)
      assert.doesNotMatch(text, /verified|accurate to|exactly|guarantee/i)
      assert.doesNotMatch(text, /NaN|Infinity|undefined/)
    }
  }
})

test('the heading step says to walk 3 m or more and that longer is better, and no longer says 1.0 m', () => {
  const copy = headingStepCopy()
  assert.equal(
    copy,
    'Step 2 of 2 — walk 3 m or more from the landmark, then tap a second ground feature. Longer is more accurate; their direction sets the heading.',
  )
  assert.doesNotMatch(copy, /1\.0 m/)
  assert.equal(headingStepCopy(null), copy)
  assert.equal(headingStepCopy(undefined), copy)
})

test('on a return visit the heading step names last time\'s marker and its distance, and does not say to walk', () => {
  assert.equal(
    headingStepCopy(1.5),
    'Step 2 of 2 — tap the heading marker from last time, about 1.5 m from the landmark. Their direction sets the heading.',
  )
  assert.match(headingStepCopy(1.04), /about 1\.0 m from the landmark/)
  assert.match(headingStepCopy(3), /about 3\.0 m from the landmark/)
  for (const stored of [1.0, 1.5, 2.2, 3.0, 6.0]) {
    assert.doesNotMatch(headingStepCopy(stored), /walk|longer|or more|accurate/i, `stored ${stored}`)
  }
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(headingStepCopy(bad), headingStepCopy(), `stored ${String(bad)}`)
  }
})

// ── The check point ──────────────────────────────────────────────────────────────────────────────────

test('where a check point is: its distance from the landmark and from the line through the pair, on the floor', () => {
  const geometry = checkGeometry(at(1, 2), at(4, 2), at(2.5, 4.6))
  assert.ok(geometry)
  assert.ok(Math.abs(geometry.distanceM - Math.hypot(1.5, 2.6)) < 1e-12)
  assert.ok(Math.abs(geometry.offLineM - 2.6) < 1e-12, 'off the line, not along it')
  // The line is infinite: a point past the heading marker is as far off it as one beside it.
  assert.ok(Math.abs(checkGeometry(at(0, 0), at(0, 3), at(-2, 7))!.offLineM - 2) < 1e-12)
  // Heights are not used.
  assert.deepEqual(checkGeometry(at(0, 0), at(3, 0), { x: 1, y: 9, z: 2 }), checkGeometry(at(0, 0), at(3, 0), at(1, 2)))
  // Undefined without a line, or with a value that is not a number.
  assert.equal(checkGeometry(at(1, 1), at(1, 1), at(2, 2)), null)
  assert.equal(checkGeometry(at(0, 0), at(3, 0), at(Number.NaN, 2)), null)
})

test('a check point where the design asks for it says where it is and what the three points are worth, with no advice', () => {
  // 3.4 m from A, 2.5 m off the line, three sides of 3.5, 3.4 and 3.9 m: no other order fits as well.
  const line = checkPointGuidance(at(0, 0), at(0, 3.5), at(-2.5, 2.3))
  assert.equal(line.state, 'ok')
  assert.equal(
    line.text,
    `Point C: 3.4 m from A, 2.5 m off the A–B line. ${estimateOf([at(0, 0), at(0, 3.5), at(-2.5, 2.3)])}.`,
  )
  assert.doesNotMatch(line.text, /better|another order/)
})

test('a check point nearer than the design asks for is usable and says what is better', () => {
  const near = checkPointGuidance(at(0, 0), at(0, 3.5), at(-1.5, 1.2))
  assert.equal(near.state, 'ok')
  assert.match(near.text, /^Point C: 1\.9 m from A, 1\.5 m off the A–B line\. Estimate: .* At least 3 m from A and 2 m off the line is better\./)
  // Each limit on its own: far enough but too close to the line, and off the line but too near.
  assert.match(checkPointGuidance(at(0, 0), at(0, 3.5), at(-1, 3.4)).text, /is better\./)
  assert.match(checkPointGuidance(at(0, 0), at(0, 3.5), at(-2.4, 0.8)).text, /is better\./, 'off the line by 2.4 m but 2.5 m from A')
  assert.equal(RECOMMENDED_CHECK_DISTANCE_M, 3)
  assert.equal(RECOMMENDED_CHECK_OFFSET_M, 2)
})

test('a check point on top of another point, or almost on the line, cannot be used: the commit is not offered and the line says why', () => {
  const close = checkPointGuidance(at(0, 0), at(0, 3), at(-0.2, 0.2))
  assert.equal(close.state, 'short')
  assert.equal(close.text, 'Point C is only 28 cm from point A. Choose a feature at least 35 cm away.')
  assert.equal(DUPLICATE_POINT_GAP_M, 0.35)
  assert.match(checkPointGuidance(at(0, 0), at(0, 3), at(-0.1, 2.9)).text, /^Point C is only 14 cm from point B\./)

  const online = checkPointGuidance(at(0, 0), at(0, 3), at(-0.05, 1.5))
  assert.equal(online.state, 'short')
  assert.match(online.text, /^Point C: 1\.5 m from A, 5 cm off the A–B line\. The three points are almost on one line \(3 cm off it\): they need at least 20 cm\. Move point C to the side\.$/)
  assert.equal(MIN_PERPENDICULAR_OFFSET_M, 0.2)
})

test('a shape that fits itself in another order says so, and asks for a point that makes the three distances differ', () => {
  // An equilateral triangle: turned a third of the way round it is the same triangle, so a later visit cannot tell which point is which.
  const line = checkPointGuidance(at(0, 0), at(0, 3), at(-2.6, 1.5))
  assert.equal(line.state, 'ok', 'it can still be used: the visit is then provisional, not refused')
  assert.match(line.text, /These points also fit in another order, so a later visit could not check the order they are tapped in\. Move point C so the three distances differ\.$/)
  // An isosceles triangle is its own mirror image but is not turned onto itself: it can be checked. (Not one that is nearly
  // equilateral: 2.9, 2.9 and 3 m sides are within the 8 cm a visit is judged by, and are told apart no better.)
  assert.doesNotMatch(checkPointGuidance(at(0, 0), at(0, 3), at(-1.2, 1.5)).text, /another order/)
  assert.match(checkPointGuidance(at(0, 0), at(0, 3), at(-2.5, 1.5)).text, /another order/)
  assert.doesNotMatch(checkPointGuidance(at(0, 0), at(0, 3.5), at(-2.6, 1)).text, /another order/, 'a lopsided one certainly can')
})

test('every line about the check point that quotes a number is an estimate, and none claims a verification', () => {
  for (const check of [at(-2.5, 2.3), at(-1.5, 1.2), at(-2.6, 1.5), at(-3, 6), at(2, -2)]) {
    const { text } = checkPointGuidance(at(0, 0), at(0, 3.5), check)
    assert.match(text, /\bEstimate: /)
    assert.doesNotMatch(text, /verified|accurate to|exactly|guarantee|NaN|Infinity|undefined/i, text)
  }
})

test('a return visit re-taps the check point the Place stores: the line keeps where it is and the estimate of the stored shape, and gives no advice to move it', () => {
  // A small room: the stored check point is 1.6 m from A and 1.2 m off the line, nearer than the design asks for, and its three
  // distances (2, 1.6 and 1.3 m) are lopsided enough. A first visit is told to move it; a visit that must re-tap it is not.
  const stored = [at(0, 0), at(0, 2), at(1.2, 1.1)]
  const tapped = at(2.1, 0.5)                              // a tap that is not the stored point, so the two shapes differ
  assert.notEqual(estimateOf(stored), estimateOf([at(0, 0), at(0, 2), tapped]))
  const first = checkPointGuidance(at(0, 0), at(0, 2), tapped)
  assert.match(first.text, /At least 3 m from A and 2 m off the line is better\./, 'as a first visit is told')
  const returning = checkPointGuidance(at(0, 0), at(0, 2), tapped, TAP_SIGMA0_M, stored)
  assert.equal(returning.state, 'ok')
  assert.match(returning.text, /^Point C: 2\.2 m from A, 2\.1 m off the A–B line\. Estimate: /, 'where the tapped point is')
  assert.doesNotMatch(returning.text, /better|Move point C|another order|At least/, returning.text)
  assert.ok(returning.text.includes(estimateOf(stored)), 'the estimate is for the stored shape, the one the fit compares with')
  assert.ok(!returning.text.includes(estimateOf([at(0, 0), at(0, 2), tapped])), 'and not for the tapped one')
  // An absent or short list is a first visit's: it is told.
  assert.equal(checkPointGuidance(at(0, 0), at(0, 2), tapped, TAP_SIGMA0_M, null).text, first.text)
  assert.equal(checkPointGuidance(at(0, 0), at(0, 2), tapped, TAP_SIGMA0_M, stored.slice(0, 2)).text, first.text)
})

test('a return visit is not told that its shape fits in another order: the stored points are not the person\'s to choose', () => {
  // An equilateral triangle stored by a first visit. A later visit that re-taps it cannot move it, and the order remark is for choosing.
  const stored = [at(0, 0), at(0, 3), at(-2.6, 1.5)]
  assert.match(checkPointGuidance(at(0, 0), at(0, 3), at(-2.6, 1.5)).text, /another order/, 'told on a first visit')
  assert.doesNotMatch(checkPointGuidance(at(0, 0), at(0, 3), at(-2.6, 1.5), TAP_SIGMA0_M, stored).text, /another order|Move point C/)
})

test('a point the fit cannot use is said on a return visit as on a first: where it is, and that it cannot be used', () => {
  const stored = [at(0, 0), at(0, 3.5), at(-2.6, 1)]
  const online = checkPointGuidance(at(0, 0), at(0, 3), at(-0.05, 1.5), TAP_SIGMA0_M, stored)
  assert.equal(online.state, 'short')
  assert.equal(online.text, checkPointGuidance(at(0, 0), at(0, 3), at(-0.05, 1.5)).text)
  const close = checkPointGuidance(at(0, 0), at(0, 3), at(-0.2, 0.2), TAP_SIGMA0_M, stored)
  assert.equal(close.state, 'short')
  assert.equal(close.text, 'Point C is only 28 cm from point A. Choose a feature at least 35 cm away.')
})

test('the pair\'s line on a return visit to a Place that stores a check point quotes the estimate of the three stored points, not of the pair', () => {
  const stored = [at(0, 0), at(0, 3.5), at(-2.6, 1)]
  const withShape = baselineGuidance(3.5, 3.5, TAP_SIGMA0_M, stored)
  assert.equal(withShape.text, `3.50 m apart. Stored pair: 3.50 m. ${estimateOf(stored)}.`)
  assert.notEqual(withShape.text, baselineGuidance(3.5, 3.5).text, 'the pair alone predicts less accuracy than the three points')
  // Without a stored pair there is no shape to reproduce, so the list is not read: it is a first visit's line.
  assert.equal(baselineGuidance(3.5, null, TAP_SIGMA0_M, stored).text, baselineGuidance(3.5).text)
  assert.equal(baselineGuidance(3.5, 3.5, TAP_SIGMA0_M, [at(0, 0)]).text, baselineGuidance(3.5, 3.5).text, 'a list too short to be a shape is not one')
})

test('the steps count to what the visit asks for: "of 3" when the check point follows the heading marker, "of 2" when it does not, and "of 2" by default', () => {
  assert.equal(stepPrefix(2, 3), 'Step 2 of 3 — ')
  assert.equal(stepPrefix(3, 3, 'optional'), 'Step 3 of 3 (optional) — ')
  assert.match(landmarkStepCopy(), /^Step 1 of 2 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner\. This becomes the project's origin\.$/)
  assert.match(landmarkStepCopy(3), /^Step 1 of 3 — /)
  assert.match(headingStepCopy(null, 3), /^Step 2 of 3 — walk 3 m or more from the landmark/)
  assert.match(headingStepCopy(1.5, 3), /^Step 2 of 3 — tap the heading marker from last time, about 1\.5 m from the landmark\. Their direction sets the heading\.$/)
  assert.equal(headingStepCopy(1.5, 2), headingStepCopy(1.5))
})

// ── The file's own promises ──────────────────────────────────────────────────────────────────────────

test('each adopted constant says it is adopted and not measured, where it is defined (ADR 0005 rule 5)', () => {
  const source = readFileSync(join(ROOT, 'src/world/baseline-guidance.ts'), 'utf8')
  for (const name of ['TAP_SIGMA0_M', 'RECOMMENDED_BASELINE_M', 'RECOMMENDED_CHECK_DISTANCE_M', 'RECOMMENDED_CHECK_OFFSET_M']) {
    const where = source.indexOf(`export const ${name}`)
    assert.ok(where > 0, `${name} is exported`)
    const comment = source.slice(source.lastIndexOf('/**', where), where)
    assert.match(comment, /adopted[^.]*, not measured \(ADR 0005 rule 5\)|\*\*This is adopted, not measured \(ADR 0005 rule 5\)\.\*\*/i, `${name} carries the flag`)
  }
})

test('the file uses no Deno API and imports only browser-safe modules, so the browser may import it (ADR 0002)', () => {
  const source = readFileSync(join(ROOT, 'src/world/baseline-guidance.ts'), 'utf8')
  assert.doesNotMatch(source, /\bDeno\.[A-Za-z]/, 'no use of the Deno namespace')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  // frame-fit.ts owns the one adopted tap-noise figure (SIGMA0_M) and the prediction; this file re-exports the first as
  // TAP_SIGMA0_M, so the two cannot drift apart. All three modules are free of Deno and DOM references.
  assert.deepEqual(imports, ['./frame-fit.ts', './geo.ts', './types.ts'])
})
