/**
 * Catalogue rules for the desktop Things tab and Items tree: what a row is
 * called, and which rows survive the search, label and scan filters.
 *
 * No DOM here, so the rules can be tested without a browser. viewer.ts builds
 * the items from the scene and the resolved patches. A relabel is a patch, so
 * an item's user label comes from the same resolution the 3D view uses
 * (src/shared/thing_tags.ts), and a clear makes the row fall back to its AI label.
 *
 * Run: npm run test:catalogue-filter
 */
import { matchesObjectFilter, parseObjectFilter } from './object-filter.ts'

/** One catalogue row: a Thing, or an object no Thing claims, and the scans it was seen in. */
export interface CatalogueItem {
  /** Stable row key: a Thing id, or the object id of an unmatched detection. */
  id: string
  /** The label the reconstruction produced. */
  aiLabel: string
  /** The user's relabel, or null when none is set. */
  userLabel: string | null
  /** Every scan this item was seen in. */
  scanIds: readonly string[]
}

export interface CatalogueFilter {
  /** Search text in the editor's filter syntax: terms are OR-ed, and `-term` hides a match. */
  query?: string
  /** Keep only items seen in this scan. Empty or absent keeps every scan. */
  scanId?: string
  /** Keep only items whose display label is this one, ignoring case. Empty or absent keeps every label. */
  label?: string
}

/** The user label when one is set, otherwise the AI label. */
export function displayLabel(item: Pick<CatalogueItem, 'aiLabel' | 'userLabel'>): string {
  const userLabel = item.userLabel?.trim() ?? ''
  return userLabel || item.aiLabel.trim()
}

/**
 * The distinct display labels, sorted. Labels that differ only in case count
 * once. A label that was replaced by a relabel is not offered, because no row
 * shows it any more.
 */
export function labelOptions(items: readonly CatalogueItem[]): string[] {
  const firstSpelling = new Map<string, string>()
  for (const item of items) {
    const label = displayLabel(item)
    if (!label) continue
    const key = labelKey(label)
    if (!firstSpelling.has(key)) firstSpelling.set(key, label)
  }
  return [...firstSpelling.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * The items that pass every filter, in their original order. Returns a new array.
 *
 * The search reads both labels, so "chair" still finds an item relabelled
 * "armchair", and "-desk" hides an item whose AI label is "desk" even when the
 * user has renamed it. Both labels are joined with a space, which no search
 * term can contain, so a term never matches across the join.
 */
export function filterCatalogue(items: readonly CatalogueItem[], filter: CatalogueFilter = {}): CatalogueItem[] {
  const search = parseObjectFilter(filter.query)
  const label = labelKey(filter.label ?? '')
  const scanId = filter.scanId ?? ''
  return items.filter((item) => {
    if (scanId && !item.scanIds.includes(scanId)) return false
    if (label && labelKey(displayLabel(item)) !== label) return false
    return matchesObjectFilter(`${displayLabel(item)} ${item.aiLabel}`, search)
  })
}

function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase()
}
