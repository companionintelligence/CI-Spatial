/**
 * The seeded search that produced the tag family in `./dictionary.ts`.
 *
 * Not imported by the scanner: it exists so the family is reproducible rather than a table
 * nobody can account for. `tests/unit/node/fiducial_dictionary.test.ts` runs it and compares its
 * output to the frozen table.
 *
 * The search is greedy and random, not optimal: draw a word, keep it if it is far enough from
 * everything kept so far, and from the mirror images of everything kept so far and of itself. For
 * 25-bit words and a 4-way rotation, a minimum distance of 9 yields 35 to 38 ids in 6 million draws
 * with the mirror distance at 5 (measured with four seeds; 36 to 39 without the mirror constraint, so
 * it costs about one id), 10 yields about 22, 8 yields over 100. 32 ids at distance 9 is the largest
 * round family this search reaches comfortably, and a distance of 9 leaves room to correct up to
 * four bit errors while the detector accepts far fewer (see `DEFAULT_MAX_HAMMING` in
 * `./detector.ts`).
 */
import { mulberry32 } from '../../shared/test-homes.ts'
import { flipWord, popcount32, wordRotations } from './dictionary.ts'

export interface FamilyParams {
  name: string
  /** Data cells per side. */
  bits: number
  /** Words to find. The search throws if it cannot find this many within `maxDraws`. */
  count: number
  /** Required Hamming distance between any two (word, rotation) pairs, and between a word and its own rotations. */
  minDistance: number
  /** Required Hamming distance between the mirror image of a word (in any turn) and every word, itself included. */
  minMirrorDistance: number
  /** Fewest and most BLACK cells a word may have. Keeps a code from being nearly all one colour. */
  minOnes: number
  maxOnes: number
  seed: number
  maxDraws: number
}

/**
 * The parameters behind `CSCAN5_V1`.
 *
 * `minDistance`, `minMirrorDistance`, `minOnes` and `maxOnes` are design choices, not measurements: 9 is
 * the largest distance at which this search reaches 32 ids; 5 keeps a mirrored tag more than the
 * correctable 4 bits from every code; 7..18 black cells of 25 keeps every code visually balanced so no
 * tag is a nearly solid black or white block. `seed` is arbitrary.
 */
export const CSCAN5_V1_PARAMS: FamilyParams = {
  name: 'cscan-5x5-v1',
  bits: 5,
  count: 32,
  minDistance: 9,
  minMirrorDistance: 5,
  minOnes: 7,
  maxOnes: 18,
  seed: 0xc5ca4,
  maxDraws: 6_000_000,
}

export function searchFamily(params: FamilyParams): number[] {
  const { bits, count, minDistance, minMirrorDistance, minOnes, maxOnes, seed, maxDraws } = params
  const cells = bits * bits
  if (cells > 31) throw new Error('searchFamily draws 31-bit words at most')
  const rand = mulberry32(seed)
  const words: number[] = []
  const rotated: Array<[number, number, number, number]> = []

  for (let draw = 0; draw < maxDraws && words.length < count; draw++) {
    const word = Math.floor(rand() * 2 ** cells) >>> 0
    const ones = popcount32(word)
    if (ones < minOnes || ones > maxOnes) continue

    const mine = wordRotations(word, bits)
    const mirrored = wordRotations(flipWord(word, bits), bits)
    let ok = true
    for (let k = 1; k < 4 && ok; k++) if (popcount32(word ^ mine[k]!) < minDistance) ok = false
    // Its own mirror image, in any turn, must not be mistakable for it.
    for (let k = 0; k < 4 && ok; k++) if (popcount32(word ^ mirrored[k]!) < minMirrorDistance) ok = false
    for (let i = 0; i < words.length && ok; i++) {
      const other = rotated[i]!
      for (let k = 0; k < 4; k++) {
        if (popcount32(word ^ other[k]!) < minDistance || popcount32(mirrored[k]! ^ words[i]!) < minMirrorDistance) {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    words.push(word)
    rotated.push(mine)
  }
  if (words.length < count) {
    throw new Error(`${params.name}: found ${words.length} of ${count} words in ${maxDraws} draws`)
  }
  return words
}
