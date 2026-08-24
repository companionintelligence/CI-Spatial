/**
 * Which Ollama model actually runs (src/shared/ollama-model.ts).
 *
 * This file exists because of a live defect, not for coverage. `inference.ts`
 * decided model presence with `name.startsWith(requestedBase + ':')`, so a box
 * holding `qwen3-vl:2b` and `qwen3-vl:8b` reported the absent `qwen3-vl:4b`
 * as present. The fallback that exists for exactly that case was skipped by
 * its own check, `/health` served `modelReady: true`, and every capture failed
 * with `model 'qwen3-vl:4b' not found`. The first test below is that box.
 */

import { assertEquals } from 'jsr:@std/assert'
import { resolveOllamaModel, withTag } from './src/shared/ollama-model.ts'

/** The exact model list from the machine where this was found, 2026-08-23. */
const FOUND_ON = [
  'minicpm-v4.6:latest',
  'qwen3-vl:2b',
  'qwen3-vl:8b',
  'moondream:latest',
  'qwen3.8:27b',
]

Deno.test('a sibling tag is not the requested model — the regression this file exists for', () => {
  const choice = resolveOllamaModel('qwen3-vl:4b', FOUND_ON)
  // The bug: qwen3-vl:2b satisfied a startsWith('qwen3-vl:') check, so this
  // returned 'exact' for a model that was never pulled.
  assertEquals(choice?.reason, 'same-base')
  assertEquals(choice?.model, 'qwen3-vl:2b')
})

Deno.test('an exactly-pulled model is used as requested', () => {
  assertEquals(resolveOllamaModel('qwen3-vl:8b', FOUND_ON), { model: 'qwen3-vl:8b', reason: 'exact' })
})

Deno.test('a bare name means :latest, as Ollama treats it', () => {
  assertEquals(withTag('moondream'), 'moondream:latest')
  assertEquals(withTag('qwen3-vl:2b'), 'qwen3-vl:2b')
  // Requested bare, pulled tagged.
  assertEquals(resolveOllamaModel('moondream', FOUND_ON)?.reason, 'exact')
  // Requested tagged, pulled bare.
  assertEquals(resolveOllamaModel('llava:latest', ['llava'])?.reason, 'exact')
})

Deno.test('same-base is preferred over an unrelated known vision model', () => {
  const choice = resolveOllamaModel('qwen3-vl:4b', ['moondream:latest', 'qwen3-vl:8b'])
  assertEquals(choice, { model: 'qwen3-vl:8b', reason: 'same-base' })
})

Deno.test('a known vision model is used when nothing shares the base name', () => {
  const choice = resolveOllamaModel('qwen3-vl:4b', ['llama3:8b', 'moondream:latest'])
  assertEquals(choice, { model: 'moondream:latest', reason: 'known-vision' })
})

Deno.test('anything pulled beats nothing, but is labelled as the guess it is', () => {
  const choice = resolveOllamaModel('qwen3-vl:4b', ['some-random-model:1b'])
  assertEquals(choice, { model: 'some-random-model:1b', reason: 'first-available' })
})

Deno.test('no models pulled returns null, so the caller can fail rather than report ready', () => {
  assertEquals(resolveOllamaModel('qwen3-vl:4b', []), null)
})

Deno.test('every non-exact outcome is distinguishable from exact', () => {
  // The caller keys its warning — and, transitively, whether /health names a
  // substituted model — off `reason !== 'exact'`. If a substitution could ever
  // report 'exact', the original bug is back in a different shape.
  for (const available of [FOUND_ON, ['moondream:latest'], ['x:1b'], ['qwen3-vl:8b']]) {
    const choice = resolveOllamaModel('qwen3-vl:4b', available)
    assertEquals(choice?.reason === 'exact', false)
    assertEquals(available.map(withTag).includes(choice!.model), true)
  }
})
