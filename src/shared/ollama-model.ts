/**
 * Which Ollama model will actually run, given what is pulled.
 *
 * Its own DOM-free, fetch-free module so the decision is testable. It was not
 * before, and the bug it now guards was a one-line predicate that nothing
 * could reach: `inference.ts` decided model presence with
 *
 *     data.models.some(m => m.name.startsWith(requestedBase + ':'))
 *
 * so a box holding `qwen3-vl:2b` and `qwen3-vl:8b` reported the *absent*
 * `qwen3-vl:4b` as present. The fallback that exists for exactly that case was
 * skipped by its own check, `/health` served `modelReady: true`, and every
 * capture failed with `model 'qwen3-vl:4b' not found`.
 */

import { DEFAULT_MODEL_TAG } from './model-catalog.ts'

/**
 * Vision models worth falling back to, best first, when nothing shares the
 * requested model's base name. Order is preference, not availability.
 */
const KNOWN_VISION_MODELS = [DEFAULT_MODEL_TAG, 'qwen3.5:4b', 'qwen3.5:2b', 'llava:7b', 'moondream:latest']

/** Ollama treats a bare name as `:latest`; compare like it does. */
export function withTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`
}

export interface OllamaModelChoice {
  /** The tag to actually send to Ollama. */
  model: string
  /**
   * How it was chosen. `'exact'` means the requested model is pulled;
   * everything else means it is not, and the caller must say so rather than
   * reporting readiness for a model that will 404.
   */
  reason: 'exact' | 'same-base' | 'known-vision' | 'first-available'
}

/**
 * Resolve `requested` against the tags Ollama reports as pulled.
 *
 * Returns `null` when nothing is pulled at all — the caller should fail the
 * engine load rather than report `ready`.
 *
 * Preference order after an exact miss: another tag of the same model (closest
 * substitute, and what the old loose check was reaching for), then a known
 * vision model, then whatever is there. Every one of those is a *substitution*
 * and is labelled as such.
 */
export function resolveOllamaModel(
  requested: string,
  availableNames: readonly string[],
): OllamaModelChoice | null {
  const available = availableNames.map(withTag)
  const want = withTag(requested)

  if (available.includes(want)) return { model: want, reason: 'exact' }

  const base = want.split(':')[0]
  const sameBase = available.find((name) => name.split(':')[0] === base)
  if (sameBase) return { model: sameBase, reason: 'same-base' }

  const knownVision = KNOWN_VISION_MODELS.map(withTag).find((name) => available.includes(name))
  if (knownVision) return { model: knownVision, reason: 'known-vision' }

  if (available.length > 0) return { model: available[0], reason: 'first-available' }
  return null
}
