/**
 * Procedural test-home definitions — 24 deterministic home layouts used to
 * generate scan GLBs, CV test images, and editor/E2E fixtures.
 *
 * Everything is seeded (mulberry32), so regenerating produces byte-identical
 * layouts: tests can assert against test-data/homes/expected.json.
 *
 * Runtime-agnostic: imported by Node scripts (type stripping) and tooling.
 */
import { paletteColorFor } from './cv-palette.ts'

// Intentionally NOT part of the RawDetection -> WorldDetection -> StoredDetection
// lineage (ADR 0001): this is synthetic ground-truth data for generating deterministic
// test fixtures, not a VLM detection — do not unify it with WorldDetection.
export interface FurnitureItem {
  label: string
  /** Box centre in room space, metres.  y is the centre height. */
  position: [number, number, number]
  /** Box size [w, h, d] in metres */
  size: [number, number, number]
  confidence: number
  rgb: [number, number, number]
}

export interface TestHome {
  index: number
  slug: string
  name: string
  /** Interior dimensions [width(x), height(y), depth(z)] in metres */
  dims: [number, number, number]
  furniture: FurnitureItem[]
  /** Approximate scan point count target */
  pointTarget: number
  geo: { lat: number; lng: number; bearing: number; address: string }
}

/** Deterministic PRNG — same sequence on every run */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Archetype {
  slug: string
  name: string
  dims: [number, number, number]
  /** Furniture labels this room type may contain (sampled in order) */
  catalog: Array<{ label: string; size: [number, number, number]; count: [number, number] }>
  pointTarget: number
}

const ARCHETYPES: Archetype[] = [
  { slug: 'studio', name: 'Studio Apartment', dims: [4.2, 2.6, 5.0], pointTarget: 16000, catalog: [
    { label: 'bed', size: [1.5, 0.55, 2.0], count: [1, 1] },
    { label: 'table', size: [1.1, 0.75, 0.7], count: [1, 1] },
    { label: 'chair', size: [0.5, 0.9, 0.5], count: [1, 2] },
    { label: 'shelf', size: [0.9, 1.8, 0.3], count: [1, 1] },
    { label: 'lamp', size: [0.3, 1.5, 0.3], count: [1, 1] },
  ] },
  { slug: 'one-bed', name: 'One-Bedroom', dims: [3.6, 2.5, 4.2], pointTarget: 14000, catalog: [
    { label: 'bed', size: [1.6, 0.55, 2.1], count: [1, 1] },
    { label: 'shelf', size: [1.0, 2.0, 0.35], count: [1, 2] },
    { label: 'lamp', size: [0.3, 1.4, 0.3], count: [1, 2] },
    { label: 'chair', size: [0.5, 0.9, 0.5], count: [0, 1] },
  ] },
  { slug: 'living-room', name: 'Living Room', dims: [5.5, 2.7, 6.2], pointTarget: 22000, catalog: [
    { label: 'sofa', size: [2.2, 0.85, 0.95], count: [1, 2] },
    { label: 'tv', size: [1.4, 0.8, 0.1], count: [1, 1] },
    { label: 'table', size: [1.2, 0.45, 0.7], count: [1, 1] },
    { label: 'plant', size: [0.5, 1.3, 0.5], count: [1, 2] },
    { label: 'shelf', size: [1.6, 2.0, 0.35], count: [0, 1] },
  ] },
  { slug: 'kitchen', name: 'Kitchen', dims: [3.8, 2.5, 4.6], pointTarget: 15000, catalog: [
    { label: 'table', size: [1.4, 0.75, 0.9], count: [1, 1] },
    { label: 'chair', size: [0.48, 0.9, 0.48], count: [2, 4] },
    { label: 'shelf', size: [1.2, 1.9, 0.4], count: [1, 2] },
  ] },
  { slug: 'office', name: 'Home Office', dims: [3.4, 2.5, 3.8], pointTarget: 12000, catalog: [
    { label: 'table', size: [1.5, 0.74, 0.8], count: [1, 1] },
    { label: 'chair', size: [0.55, 1.05, 0.55], count: [1, 2] },
    { label: 'shelf', size: [0.9, 2.0, 0.35], count: [1, 2] },
    { label: 'lamp', size: [0.25, 0.5, 0.25], count: [1, 1] },
    { label: 'plant', size: [0.4, 1.0, 0.4], count: [0, 1] },
  ] },
  { slug: 'dining-room', name: 'Dining Room', dims: [4.4, 2.7, 5.0], pointTarget: 17000, catalog: [
    { label: 'table', size: [1.9, 0.76, 1.1], count: [1, 1] },
    { label: 'chair', size: [0.5, 0.95, 0.5], count: [4, 6] },
    { label: 'shelf', size: [1.5, 1.1, 0.45], count: [1, 1] },
    { label: 'plant', size: [0.45, 1.2, 0.45], count: [0, 1] },
  ] },
  { slug: 'kids-room', name: 'Kids Room', dims: [3.2, 2.4, 3.6], pointTarget: 11000, catalog: [
    { label: 'bed', size: [1.0, 0.5, 1.8], count: [1, 2] },
    { label: 'shelf', size: [0.8, 1.4, 0.3], count: [1, 1] },
    { label: 'table', size: [0.9, 0.55, 0.6], count: [1, 1] },
    { label: 'chair', size: [0.4, 0.65, 0.4], count: [1, 2] },
  ] },
  { slug: 'media-room', name: 'Media Room', dims: [4.8, 2.6, 5.4], pointTarget: 18000, catalog: [
    { label: 'sofa', size: [2.6, 0.9, 1.0], count: [1, 2] },
    { label: 'tv', size: [1.8, 1.0, 0.12], count: [1, 1] },
    { label: 'shelf', size: [1.2, 1.6, 0.4], count: [1, 2] },
    { label: 'lamp', size: [0.3, 1.5, 0.3], count: [0, 2] },
  ] },
]

/** Variant suffixes give 3 distinct homes per archetype → 24 total */
const VARIANTS = ['A', 'B', 'C']

const BASE_LAT = 37.7745
const BASE_LNG = -122.4189

export const TEST_HOME_COUNT = ARCHETYPES.length * VARIANTS.length

/** Build all 24 deterministic homes */
export function buildTestHomes(): TestHome[] {
  const homes: TestHome[] = []
  let index = 0
  for (const archetype of ARCHETYPES) {
    for (const variant of VARIANTS) {
      homes.push(buildHome(archetype, variant, index++))
    }
  }
  return homes
}

function buildHome(archetype: Archetype, variant: string, index: number): TestHome {
  const rand = mulberry32(0xC1A0 + index * 7919)
  // Vary the footprint ±12% per variant
  const scale = 0.88 + rand() * 0.24
  const dims: [number, number, number] = [
    round2(archetype.dims[0] * scale),
    round2(archetype.dims[1]),
    round2(archetype.dims[2] * (0.88 + rand() * 0.24)),
  ]

  const furniture: FurnitureItem[] = []
  const placed: Array<{ x: number; z: number; w: number; d: number }> = []

  for (const entry of archetype.catalog) {
    const count = entry.count[0] + Math.floor(rand() * (entry.count[1] - entry.count[0] + 1))
    for (let i = 0; i < count; i++) {
      const size: [number, number, number] = [
        round2(entry.size[0] * (0.92 + rand() * 0.16)),
        round2(entry.size[1] * (0.92 + rand() * 0.16)),
        round2(entry.size[2] * (0.92 + rand() * 0.16)),
      ]
      const spot = findSpot(rand, dims, size, placed)
      if (!spot) continue
      placed.push({ x: spot[0], z: spot[2], w: size[0], d: size[2] })
      furniture.push({
        label: entry.label,
        position: [spot[0], round2(size[1] / 2), spot[2]],
        size,
        confidence: round2(0.72 + rand() * 0.25),
        rgb: paletteColorFor(entry.label),
      })
    }
  }

  return {
    index,
    slug: `${archetype.slug}-${variant.toLowerCase()}`,
    name: `${archetype.name} ${variant}`,
    dims,
    furniture,
    pointTarget: archetype.pointTarget,
    geo: {
      lat: round6(BASE_LAT + (index % 6) * 0.0011 + rand() * 0.0002),
      lng: round6(BASE_LNG + Math.floor(index / 6) * 0.0013 + rand() * 0.0002),
      bearing: Math.round(rand() * 360),
      address: `${100 + index} Test Home ${archetype.name} ${variant}`,
    },
  }
}

/** Find a non-overlapping floor position with wall clearance (rejection sampling) */
function findSpot(
  rand: () => number,
  dims: [number, number, number],
  size: [number, number, number],
  placed: Array<{ x: number; z: number; w: number; d: number }>,
): [number, number, number] | null {
  const margin = 0.15
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = round2((rand() - 0.5) * (dims[0] - size[0] - margin * 2))
    const z = round2((rand() - 0.5) * (dims[2] - size[2] - margin * 2))
    const overlaps = placed.some((p) =>
      Math.abs(p.x - x) < (p.w + size[0]) / 2 + 0.1 &&
      Math.abs(p.z - z) < (p.d + size[2]) / 2 + 0.1)
    if (!overlaps) return [x, 0, z]
  }
  return null
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round6(n: number): number { return Math.round(n * 1e6) / 1e6 }
