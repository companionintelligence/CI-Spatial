/**
 * Evenly spaced picks from a list, in its original order. Generic: any caller
 * that must cover a whole run rather than only its opening items can use it.
 */

/**
 * Pick up to `limit` items spread evenly across `items`, in their original order.
 * The limit is floored to a whole number first, so 2.5 takes two. With two or more
 * slots the first and last are both included, so the sample covers the whole walk
 * and not only its opening frames, which is what taking the first N used to do. A
 * single slot takes the middle item. A list no longer than the limit comes back
 * whole, and a limit below one, after flooring, comes back empty.
 */
export function sampleEvenly<T>(items: readonly T[], limit: number): T[] {
  const slots = Math.floor(limit)
  const n = items.length
  // Written as "not at least one" so that NaN also comes back empty.
  if (!(slots >= 1)) return []
  if (n <= slots) return [...items]
  if (slots === 1) return [items[Math.floor((n - 1) / 2)]!]
  const picked: T[] = []
  for (let i = 0; i < slots; i++) {
    picked.push(items[Math.round((i * (n - 1)) / (slots - 1))]!)
  }
  return picked
}
