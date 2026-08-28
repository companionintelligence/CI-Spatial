/**
 * Text filter for the editor's object labels.
 *
 * Split from viewer.ts so the matching rules can be tested without a WebGL
 * context, a loaded world, or a browser — viewer.ts is ~4000 lines of scene
 * wiring and none of it is needed to decide whether "chair 79%" matches "chair".
 *
 * Syntax, in the order a reader discovers it:
 *
 *   chair                keep labels containing "chair"
 *   chair, desk          keep labels containing either (terms are OR-ed)
 *   -wall                hide labels containing "wall"
 *   chair -swivel        keep chairs, except swivel ones
 *
 * Exclusions win over inclusions, which is what makes the panoptic case work:
 * a scan segmented into 150 ADE20K classes is mostly room surface, and
 * `-wall -floor -ceiling` is the fastest way to see only the furniture. A rule
 * where inclusions won would make that combination silently useless.
 *
 * Matching is case-insensitive substring, not whole-word: detection labels
 * arrive as rendered text like "swivel chair 95%", so requiring a whole-word or
 * exact match would mean typing the confidence.
 */

export interface ObjectFilter {
  /** Terms a label must contain at least one of. Empty means "no restriction". */
  include: string[]
  /** Terms that hide a label outright. */
  exclude: string[]
  /** True when the filter admits everything, so callers can skip work entirely. */
  isEmpty: boolean
}

/**
 * Parse a filter string.
 *
 * Terms separate on commas AND whitespace, so "chair, desk" and "chair desk"
 * behave the same — the comma is a habit people bring from tag inputs, and
 * punishing it would be a papercut. A bare "-" is not a term.
 */
export function parseObjectFilter(raw: string | null | undefined): ObjectFilter {
  const include: string[] = []
  const exclude: string[] = []
  for (const token of (raw ?? '').split(/[\s,]+/)) {
    const t = token.trim().toLowerCase()
    if (!t) continue
    if (t.startsWith('-')) {
      const body = t.slice(1)
      if (body) exclude.push(body)
    } else {
      include.push(t)
    }
  }
  return { include, exclude, isEmpty: include.length === 0 && exclude.length === 0 }
}

/** Whether a label survives the filter. */
export function matchesObjectFilter(text: string, filter: ObjectFilter): boolean {
  if (filter.isEmpty) return true
  const hay = text.toLowerCase()
  // Exclusions first and unconditionally: "chair -swivel" must drop a swivel
  // chair even though it satisfies the inclusion.
  if (filter.exclude.some((t) => hay.includes(t))) return false
  if (filter.include.length === 0) return true
  return filter.include.some((t) => hay.includes(t))
}
