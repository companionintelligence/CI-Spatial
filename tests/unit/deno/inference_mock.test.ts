/**
 * Unit tests for the mock engine's derived fields.
 *
 * Both of these exist because a constant reached a committed product screenshot:
 * the review panel showed "sofa 95% / tv 95% / table 95%", three identical
 * numbers that told the reader the confidence column was decorative.
 *
 *   deno test --allow-read inference_mock.test.ts
 */
import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { blobConfidence, describeMockBlob } from '../../../inference.ts'

Deno.test('blobConfidence: a solidly filled box scores near the ceiling', () => {
  // 4x4 cells, all 16 matched → fill 1.0
  assertAlmostEquals(blobConfidence(16, 0, 0, 3, 3), 0.96, 1e-9)
})

Deno.test('blobConfidence: a ragged silhouette scores lower but not zero', () => {
  // 4x4 cells, half matched → fill 0.5
  assertAlmostEquals(blobConfidence(8, 0, 0, 3, 3), 0.78, 1e-9)
  // Nothing matched still floors at the base, never 0 %.
  assertAlmostEquals(blobConfidence(0, 0, 0, 3, 3), 0.61, 1e-9)
})

Deno.test('blobConfidence: two differently shaped blobs do not report the same number', () => {
  const solid = blobConfidence(16, 0, 0, 3, 3)
  const ragged = blobConfidence(9, 0, 0, 3, 3)
  assertEquals(solid === ragged, false)
})

Deno.test('blobConfidence: rounds to two places so Math.round(c * 100) is stable', () => {
  for (let count = 0; count <= 16; count++) {
    const c = blobConfidence(count, 0, 0, 3, 3)
    assertEquals(Number.isInteger(Math.round(c * 100)), true)
    assertEquals(c, Math.round(c * 100) / 100)
  }
})

Deno.test('blobConfidence: a degenerate box does not divide by zero', () => {
  assertEquals(Number.isFinite(blobConfidence(0, 2, 2, 2, 2)), true)
})

Deno.test('describeMockBlob: still a human phrase, not a sample count', () => {
  const phrase = describeMockBlob('sofa', [0.3, 0.4, 0.7, 0.75])
  assertEquals(phrase.includes('sample'), false)
  assertEquals(phrase.includes('mock'), false)
  assertEquals(phrase.endsWith('centre of frame'), true)
})
