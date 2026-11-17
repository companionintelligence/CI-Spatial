/**
 * The tag family: what is frozen in `src/ar/fiducial/dictionary.ts` is what its seeded search
 * produces, the distance property it claims holds when measured from scratch, and `match` names
 * an id exactly when the grid is close enough to one.
 *
 * The distance check below is written without any of the module's own rotation or distance code:
 * it rebuilds each pattern as a grid, rotates the grid by moving cells, and counts differing cells.
 * A bug shared by the generator, `familyMinDistance` and `match` (a rotation that is not a rotation,
 * say) would otherwise agree with itself and pass.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_dictionary.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSCAN5_V1, createDictionary, familyMinMirrorDistance, flipWord, popcount32, rotateWordClockwise, wordRotations } from '../../../src/ar/fiducial/dictionary.ts'
import { CSCAN5_V1_PARAMS, searchFamily } from '../../../src/ar/fiducial/dictionary-search.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const BITS = 5

type Grid = number[][]

function toGrid(pattern: ArrayLike<number>): Grid {
  const g: Grid = []
  for (let r = 0; r < BITS; r++) g.push(Array.from({ length: BITS }, (_, c) => pattern[r * BITS + c]!))
  return g
}

/** A quarter turn clockwise: what was the left column, read bottom to top, becomes the top row. */
function turnClockwise(g: Grid): Grid {
  const out: Grid = []
  for (let r = 0; r < BITS; r++) out.push(Array.from({ length: BITS }, (_, c) => g[BITS - 1 - c]![r]!))
  return out
}

function differing(a: Grid, b: Grid): number {
  let n = 0
  for (let r = 0; r < BITS; r++) for (let c = 0; c < BITS; c++) if (a[r]![c] !== b[r]![c]) n++
  return n
}

function flat(g: Grid): number[] {
  return g.flat()
}

test('the frozen table is exactly what the seeded search produces', () => {
  const searched = searchFamily(CSCAN5_V1_PARAMS)
  assert.equal(searched.length, CSCAN5_V1.size)
  for (let id = 0; id < searched.length; id++) {
    const fromWord = new Uint8Array(25)
    for (let i = 0; i < 25; i++) fromWord[i] = (searched[id]! >>> i) & 1
    assert.deepEqual(Array.from(CSCAN5_V1.pattern(id)), Array.from(fromWord), `id ${id} drifted from the search's output`)
  }
})

test('the search is deterministic: same parameters, same words', () => {
  assert.deepEqual(searchFamily(CSCAN5_V1_PARAMS), searchFamily(CSCAN5_V1_PARAMS))
})

test('the family has at least 32 ids and a minimum distance of 9, measured here from scratch', () => {
  assert.ok(CSCAN5_V1.size >= 32, `${CSCAN5_V1.size} ids`)
  const grids = Array.from({ length: CSCAN5_V1.size }, (_, id) => toGrid(CSCAN5_V1.pattern(id)))
  let min = Infinity
  for (let a = 0; a < grids.length; a++) {
    let turned = grids[a]!
    // Distances between all four rotations of every pair (and of a pattern with its own other rotations).
    const rotations: Grid[] = []
    for (let k = 0; k < 4; k++) {
      rotations.push(turned)
      turned = turnClockwise(turned)
    }
    for (let b = a; b < grids.length; b++) {
      for (let k = 0; k < 4; k++) {
        if (a === b && k === 0) continue
        min = Math.min(min, differing(grids[b]!, rotations[k]!))
      }
    }
  }
  assert.equal(min, CSCAN5_V1.minDistance, 'the dictionary reports a distance it does not have')
  assert.ok(min >= 9, `minimum distance is ${min}`)
  assert.equal(CSCAN5_V1.maxCorrectableBits, Math.floor((min - 1) / 2))
})

/** A pattern mirrored left to right: reverse every row. */
function mirrorGrid(g: Grid): Grid {
  return g.map((row) => row.slice().reverse())
}

/** The table the first build of this family shipped with, before the search kept codes away from mirror images (`minMirrorDistance` 0 reproduces it from the same seed). */
const FIRST_BUILD_WORDS = [
  0x1ed33f4, 0x04b7483, 0x122836b, 0x13ec5cf, 0x150e350, 0x0d70cf4, 0x1a4e4da, 0x1a01ecd, 0x16497a8, 0x197bc12, 0x0826729, 0x00580be, 0x02ed2b3, 0x0b995c1, 0x060eeb9, 0x0f410e9,
  0x14dc861, 0x1d17dab, 0x1748c7b, 0x0e394ee, 0x1c2d55d, 0x00298f9, 0x1d370d8, 0x1db4fce, 0x0936abe, 0x1a0f264, 0x0134942, 0x1fdf8d3, 0x09ed405, 0x07fc4a8, 0x08a8653, 0x13da994,
]

test('no code can be taken for a mirror image: the mirror of every code, turned any way, is at least 5 bits from every code, itself included', () => {
  const grids = Array.from({ length: CSCAN5_V1.size }, (_, id) => toGrid(CSCAN5_V1.pattern(id)))
  let min = Infinity
  let closest = ''
  for (let a = 0; a < grids.length; a++) {
    let mirrored = mirrorGrid(grids[a]!)
    for (let k = 0; k < 4; k++) {
      for (let b = 0; b < grids.length; b++) {
        const d = differing(mirrored, grids[b]!)
        if (d < min) {
          min = d
          closest = `mirror of ${a} turned ${k} against ${b}`
        }
      }
      mirrored = turnClockwise(mirrored)
    }
  }
  assert.ok(min >= 5, `${closest} is only ${min} bits apart`)
  assert.equal(CSCAN5_V1.minMirrorDistance, min, 'the dictionary reports a mirror distance it does not have')
  // 5 is what makes a mirrored tag unreadable at every ceiling up to the correctable 4: a grid within 4 bits of two codes cannot be named.
  assert.ok(CSCAN5_V1.minMirrorDistance > CSCAN5_V1.maxCorrectableBits)
  // And a mirrored tag really is refused by the matcher, for every id and turn, at the largest ceiling.
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    let g = mirrorGrid(grids[id]!)
    for (let k = 0; k < 4; k++) {
      assert.equal(CSCAN5_V1.match(flat(g), CSCAN5_V1.maxCorrectableBits), null, `the mirror of ${id} turned ${k} was matched`)
      g = turnClockwise(g)
    }
  }
})

test('the first build\'s table had a code that was its own mirror image; the search that keeps codes from mirror images finds a different table of the same size and distance', () => {
  // The witness: id 19 of the first build is the same pattern as its mirror image turned, so in a mirror it read as itself with its corners the wrong way round.
  assert.equal(familyMinMirrorDistance(FIRST_BUILD_WORDS, BITS), 0)
  const firstBuild = FIRST_BUILD_WORDS[19]!
  assert.ok(wordRotations(flipWord(firstBuild, BITS), BITS).includes(firstBuild))
  // Without the constraint the same seed reproduces that table exactly: the constraint is what changed it.
  assert.deepEqual(searchFamily({ ...CSCAN5_V1_PARAMS, minMirrorDistance: 0 }), FIRST_BUILD_WORDS)
  const constrained = searchFamily(CSCAN5_V1_PARAMS)
  assert.notDeepEqual(constrained, FIRST_BUILD_WORDS)
  assert.equal(constrained.length, 32)
  // The first two codes were safe and are kept: the table only diverges where a code was not.
  assert.deepEqual(constrained.slice(0, 2), FIRST_BUILD_WORDS.slice(0, 2))
})

test('flipWord is a left-right mirror, and its own inverse', () => {
  const rand = mulberry32(17)
  for (let i = 0; i < 200; i++) {
    const word = Math.floor(rand() * 2 ** 25)
    const grid = toGrid(Array.from({ length: 25 }, (_, b) => (word >>> b) & 1))
    const flipped = flipWord(word, BITS)
    assert.deepEqual(Array.from({ length: 25 }, (_, b) => (flipped >>> b) & 1), flat(mirrorGrid(grid)))
    assert.equal(flipWord(flipped, BITS), word >>> 0)
  }
})

test('every code is balanced: between 7 and 18 of 25 cells black', () => {
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    const ones = Array.from(CSCAN5_V1.pattern(id)).reduce((s, v) => s + v, 0)
    assert.ok(ones >= 7 && ones <= 18, `id ${id} has ${ones} black cells`)
  }
})

test('the module rotation is a clockwise quarter turn of the grid, four of them are the identity', () => {
  const rand = mulberry32(5)
  for (let i = 0; i < 200; i++) {
    const word = Math.floor(rand() * 2 ** 25)
    const grid = toGrid(Array.from({ length: 25 }, (_, b) => (word >>> b) & 1))
    const turned = flat(turnClockwise(grid))
    const viaModule = rotateWordClockwise(word, BITS)
    assert.deepEqual(Array.from({ length: 25 }, (_, b) => (viaModule >>> b) & 1), turned)
    let w = word
    for (let k = 0; k < 4; k++) w = rotateWordClockwise(w, BITS)
    assert.equal(w, word >>> 0)
    const [r0, r1, r2, r3] = wordRotations(word, BITS)
    assert.equal(r0, word >>> 0)
    assert.equal(r1, viaModule)
    assert.equal(r2, rotateWordClockwise(r1, BITS))
    assert.equal(r3, rotateWordClockwise(r2, BITS))
  }
})

test('popcount32 counts set bits', () => {
  assert.equal(popcount32(0), 0)
  assert.equal(popcount32(0xffffffff), 32)
  assert.equal(popcount32(0x80000001), 2)
  for (const w of [0x1ed33f4, 0x04b7483, 0xdeadbeef, 0x12345678]) assert.equal(popcount32(w), (w >>> 0).toString(2).replace(/0/g, '').length)
})

test('match names the id and the rotation for every code turned any way, with up to four bits flipped', () => {
  const rand = mulberry32(11)
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    let grid = toGrid(CSCAN5_V1.pattern(id))
    for (let k = 0; k < 4; k++) {
      for (const flips of [0, 1, 2, 3, 4]) {
        const observed = flat(grid)
        const chosen = new Set<number>()
        while (chosen.size < flips) chosen.add(Math.floor(rand() * 25))
        for (const bit of chosen) observed[bit] = 1 - observed[bit]!
        const m = CSCAN5_V1.match(observed, 4)
        assert.ok(m, `id ${id} turned ${k} with ${flips} flips was not matched`)
        assert.deepEqual({ id: m.id, rotation: m.rotation, hamming: m.hamming }, { id, rotation: k, hamming: flips })
      }
      grid = turnClockwise(grid)
    }
  }
})

test('match gives nothing beyond the ceiling it was asked for, and nothing for a wrong-length grid', () => {
  const observed = flat(toGrid(CSCAN5_V1.pattern(3)))
  for (const bit of [0, 1, 2]) observed[bit] = 1 - observed[bit]!
  assert.equal(CSCAN5_V1.match(observed, 2), null)
  assert.equal(CSCAN5_V1.match(observed, 3)?.hamming, 3)
  assert.equal(CSCAN5_V1.match(observed.slice(0, 24), 4), null)
})

test('two ids both within reach of one grid is refused, not guessed', () => {
  // A grid 4 bits from id A that is 5 bits from id B (they are 9 apart at the closest).
  let pair: [number, number, number] | null = null
  for (let a = 0; a < CSCAN5_V1.size && !pair; a++) {
    for (let b = 0; b < CSCAN5_V1.size && !pair; b++) {
      if (a === b) continue
      const ga = flat(toGrid(CSCAN5_V1.pattern(a)))
      const gb = flat(toGrid(CSCAN5_V1.pattern(b)))
      const d = ga.reduce((s, v, i) => s + (v !== gb[i] ? 1 : 0), 0)
      if (d === 9) pair = [a, b, d]
    }
  }
  assert.ok(pair, 'the family has a pair at exactly its minimum distance, in the same orientation')
  const [a, b] = pair
  const ga = flat(toGrid(CSCAN5_V1.pattern(a)))
  const gb = flat(toGrid(CSCAN5_V1.pattern(b)))
  const differs = ga.map((v, i) => (v !== gb[i] ? i : -1)).filter((i) => i >= 0)
  const observed = ga.slice()
  for (const bit of differs.slice(0, 4)) observed[bit] = gb[bit]!
  // 4 from a, 5 from b. Within the correctable limit the answer is a:
  assert.equal(CSCAN5_V1.match(observed, 4)?.id, a)
  // Asked to accept 5, both a and b are in reach (and no other code is): refuse.
  assert.equal(CSCAN5_V1.match(observed, 5), null)
})

test('random grids are mistaken for a code about as often as the arithmetic says, and no oftener', () => {
  const rand = mulberry32(2024)
  const trials = 300_000
  const counts = { 0: 0, 1: 0, 2: 0 }
  const observed = new Uint8Array(25)
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < 25; i++) observed[i] = rand() < 0.5 ? 1 : 0
    for (const h of [0, 1, 2] as const) if (CSCAN5_V1.match(observed, h)) counts[h]++
  }
  // 32 ids x 4 rotations = 128 words; the Hamming ball of radius h holds 1, 26, 326 words of 2^25.
  const expected = (ball: number) => (trials * 128 * ball) / 2 ** 25
  assert.ok(counts[0] <= 3, `${counts[0]} exact matches in ${trials} random grids (expected ${expected(1).toFixed(2)})`)
  assert.ok(counts[1] <= expected(26) * 2.5 + 3, `${counts[1]} within 1 bit (expected ${expected(26).toFixed(1)})`)
  assert.ok(counts[2] <= expected(326) * 1.5 + 5, `${counts[2]} within 2 bits (expected ${expected(326).toFixed(0)})`)
  // The test must be able to fail: at two bits the rate is not negligible.
  assert.ok(counts[2] > 0, 'no random grid was ever within 2 bits: the sampling is not exercising match')
})

test('createDictionary refuses tables that are not usable families', () => {
  assert.throws(() => createDictionary('dup', 5, [0x1ed33f4, 0x1ed33f4]), /twice/)
  assert.throws(() => createDictionary('wide', 5, [0x1ed33f4, 1 << 25]), /not a 25-bit word/)
  assert.throws(() => createDictionary('big', 6, [1, 2]), /does not fit a 32-bit word/)
  assert.throws(() => createDictionary('one', 5, [0x1ed33f4]), /at least two ids/)
  // A pattern that is its own quarter turn (all cells black) cannot show which way up it is.
  assert.throws(() => createDictionary('sym', 5, [0x1ffffff, 0x1ed33f4]), /same pattern once rotated/)
})

test('pattern refuses an id that does not exist', () => {
  assert.throws(() => CSCAN5_V1.pattern(32), /no id 32/)
  assert.throws(() => CSCAN5_V1.pattern(-1), /no id -1/)
})
