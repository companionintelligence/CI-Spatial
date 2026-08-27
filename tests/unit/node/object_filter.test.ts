/**
 * Editor object-label filter.
 *
 * The label strings below are verbatim from real captures — the viewer renders
 * "swivel chair 95%", not "swivel chair" — which is why matching is substring
 * rather than exact.
 *
 * Run: npm run test:object:filter
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesObjectFilter, parseObjectFilter } from '../../../src/viewer/object-filter.ts'

const keeps = (raw: string, text: string) => matchesObjectFilter(text, parseObjectFilter(raw))

test('an empty filter admits everything', () => {
  for (const raw of ['', '   ', ',', null as unknown as string, undefined as unknown as string]) {
    assert.equal(parseObjectFilter(raw).isEmpty, true)
    assert.equal(keeps(raw, 'chair 79%'), true)
  }
})

test('matches a substring of the rendered label, confidence included', () => {
  assert.equal(keeps('chair', 'swivel chair 95%'), true)
  assert.equal(keeps('CHAIR', 'swivel chair 95%'), true)
  assert.equal(keeps('chair', 'desk 97%'), false)
})

test('terms are OR-ed, and split on commas or whitespace alike', () => {
  for (const raw of ['chair, desk', 'chair desk', 'chair,desk', ' chair ,  desk ']) {
    assert.equal(keeps(raw, 'desk 97%'), true, raw)
    assert.equal(keeps(raw, 'chair 79%'), true, raw)
    assert.equal(keeps(raw, 'wall 100%'), false, raw)
  }
})

test('a leading dash excludes — the panoptic case', () => {
  // A panoptic scan is mostly room surface, so hiding it is the common request.
  const raw = '-wall -floor -ceiling'
  assert.equal(keeps(raw, 'wall 100%'), false)
  assert.equal(keeps(raw, 'floor 100%'), false)
  assert.equal(keeps(raw, 'ceiling 100%'), false)
  assert.equal(keeps(raw, 'cabinet 96%'), true)
})

test('exclusions beat inclusions', () => {
  // If inclusions won, "chair -swivel" would silently keep swivel chairs and
  // the combination would be useless.
  assert.equal(keeps('chair -swivel', 'swivel chair 95%'), false)
  assert.equal(keeps('chair -swivel', 'chair 79%'), true)
})

test('exclusion-only filters keep everything else', () => {
  assert.equal(parseObjectFilter('-wall').include.length, 0)
  assert.equal(keeps('-wall', 'desk 97%'), true)
  assert.equal(keeps('-wall', 'wall 100%'), false)
})

test('a bare dash is not a term', () => {
  // Otherwise typing "-" mid-edit would blank the scene.
  assert.equal(parseObjectFilter('-').isEmpty, true)
  assert.equal(keeps('-', 'chair 79%'), true)
})

test('partial words match, so typing filters live as you go', () => {
  for (const partial of ['c', 'ca', 'cab', 'cabinet']) {
    assert.equal(keeps(partial, 'cabinet 96%'), true, partial)
  }
})
