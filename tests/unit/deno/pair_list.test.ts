/**
 * The pair-list builder (server/register/pair_list.ts): which image pairs a joint COLMAP solve matches.
 *
 * The inputs are synthetic walks: a session is a list of images with a camera centre and a viewing direction in the
 * Place frame, laid out the way a person walks (a straight run, a loop that comes back to its start). The gates the
 * builder applies (3 m, 60 degrees, a sequence window, per-image caps) are checked at their edges, and the grid it
 * searches through is checked against a brute-force reading of the same rule on random clouds, which is the check
 * that would catch a partner lost across a cell boundary.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import {
  buildPairList,
  CROSS_SESSION_MAX_ANGLE_DEG,
  CROSS_SESSION_MAX_DISTANCE_M,
  exhaustiveMatchingVerdict,
  exhaustivePairCount,
  formatMatchList,
  MAX_CROSS_PARTNERS_PER_SESSION,
  MAX_EXHAUSTIVE_IMAGES,
  MAX_PAIRS,
  MAX_REVISIT_PARTNERS,
  type PairImage,
  planMatching,
  SEQUENCE_WINDOW,
} from '../../../server/register/pair_list.ts'

type V3 = [number, number, number]

const name = (sessionId: string, i: number): string => `${sessionId}/kf-${String(i).padStart(5, '0')}.jpg`

/** Forward vector for a heading `deg` degrees from +z about +y. */
const heading = (deg: number): V3 => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)]

/** `n` images of one session; `at(i)` gives the pose in the Place frame or null for a frame with none. */
function session(
  sessionId: string,
  n: number,
  at: (i: number) => { position: V3; forward: V3 } | null,
): PairImage[] {
  return Array.from({ length: n }, (_, i) => {
    const pose = at(i)
    const image: PairImage = { name: name(sessionId, i), sessionId, index: i }
    if (pose) {
      image.position = pose.position
      image.forward = pose.forward
    }
    return image
  })
}

/** A straight walk along +x at z = `z`, one image every 0.3 m, looking along `forwardDeg` from +z. */
function corridor(sessionId: string, n: number, z: number, forwardDeg = 0) {
  return session(sessionId, n, (i) => ({ position: [i * 0.3, 1.5, z], forward: heading(forwardDeg) }))
}

function mustBuild(images: PairImage[], options = {}) {
  const result = buildPairList(images, options)
  assert(result.ok, `expected a pair list, got ${result.ok ? '' : result.message}`)
  return result
}

const key = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`)

// ─── Sequence neighbours ─────────────────────────────────────────────────────

Deno.test('a session with no poses is tied together by its sequence window and nothing else', () => {
  const images = session('sess-a', 25, () => null)
  const { pairs, stats } = mustBuild(images)

  const expected: string[] = []
  for (let i = 0; i < 25; i++) {
    for (let k = 1; k <= SEQUENCE_WINDOW && i + k < 25; k++) expected.push(key(name('sess-a', i), name('sess-a', i + k)))
  }
  assertEquals(pairs.map((p) => `${p.a} ${p.b}`), expected.sort())
  assertEquals(pairs.every((p) => p.kind === 'sequence'), true)
  // 24 + 23 + ... + 15 pairs at offsets 1..10.
  assertEquals(stats.sequencePairs, 195)
  assertEquals(stats.revisitPairs + stats.crossSessionPairs, 0)
  assertEquals(stats.posedImages, 0)
})

Deno.test('every pair is written once, in canonical order, whatever order the images arrived in', () => {
  const images = [...corridor('sess-b', 14, 0), ...corridor('sess-a', 14, 1)]
  const { pairs } = mustBuild(images)
  assert(pairs.every((p) => p.a < p.b), 'a sorts before b in every pair')
  const lines = pairs.map((p) => `${p.a} ${p.b}`)
  assertEquals(lines, [...lines].sort(), 'the list is sorted')
  assertEquals(new Set(lines).size, lines.length, 'no pair twice')

  // The same images in a seeded shuffle, and with the sessions reversed, give the same list.
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const shuffled = [...images].sort(() => next() - 0.5)
  assertEquals(mustBuild(shuffled).pairs, pairs)
  assertEquals(mustBuild([...images].reverse()).pairs, pairs)
})

// ─── The two gates ───────────────────────────────────────────────────────────

Deno.test('two sessions are paired within 3 m of each other and not beyond', () => {
  const near = mustBuild([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, CROSS_SESSION_MAX_DISTANCE_M)])
  assert(near.stats.crossSessionPairs > 0, 'exactly at the gate is inside it')
  // The same walk face to face with the other run, 3 mm past the gate: no image is near enough.
  const far = mustBuild([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, CROSS_SESSION_MAX_DISTANCE_M + 0.003)])
  assertEquals(far.stats.crossSessionPairs, 0)
  assertEquals(far.stats.isolatedSessions, ['sess-a', 'sess-b'])
})

Deno.test('two sessions are paired within 60 degrees of each other and not beyond', () => {
  const run = (deg: number) => mustBuild([...corridor('sess-a', 20, 0, 0), ...corridor('sess-b', 20, 1, deg)]).stats.crossSessionPairs
  assert(run(CROSS_SESSION_MAX_ANGLE_DEG - 0.1) > 0, 'just inside the angle gate')
  assertEquals(run(CROSS_SESSION_MAX_ANGLE_DEG + 0.1), 0, 'just outside it')
  assertEquals(run(180), 0, 'a session facing the other way sees none of it')
})

Deno.test('a gate can be tightened by option', () => {
  const images = [...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 2)]
  assert(mustBuild(images).stats.crossSessionPairs > 0)
  assertEquals(mustBuild(images, { maxDistanceM: 1.5 }).stats.crossSessionPairs, 0)
  assertEquals(mustBuild(images, { maxAngleDeg: 0.5 }).stats.crossSessionPairs > 0, true, 'parallel views pass any positive angle gate')
})

// ─── Partner caps ────────────────────────────────────────────────────────────

Deno.test('with one partner per session each image is paired with its nearest image of the other session', () => {
  const a = session('sess-a', 5, (i) => ({ position: [i, 1.5, 0], forward: heading(0) }))
  const b = session('sess-b', 5, (i) => ({ position: [i, 1.5, 1], forward: heading(0) }))
  const { pairs } = mustBuild([...a, ...b], { sequenceWindow: 0, maxRevisitPartners: 0, maxCrossPartnersPerSession: 1 })
  assertEquals(
    pairs.map((p) => `${p.a} ${p.b}`),
    [0, 1, 2, 3, 4].map((i) => key(name('sess-a', i), name('sess-b', i))).sort(),
    'the diagonal: one metre apart, where every other image is at least 1.41 m',
  )
  assertEquals(pairs.every((p) => p.kind === 'cross-session'), true)
})

Deno.test('the cap is per image and per other session, so a crowded session cannot starve a quieter one', () => {
  // One image at the origin; ten images of sess-b right beside it; one of sess-c a little farther out.
  const centre = session('sess-a', 1, () => ({ position: [0, 1.5, 0], forward: heading(0) }))
  const crowd = session('sess-b', 10, (i) => ({ position: [0.1 + i * 0.01, 1.5, 0], forward: heading(0) }))
  const lone = session('sess-c', 1, () => ({ position: [2, 1.5, 0], forward: heading(0) }))
  const { pairs, stats } = mustBuild([...centre, ...crowd, ...lone], {
    sequenceWindow: 0,
    maxRevisitPartners: 0,
    maxCrossPartnersPerSession: 2,
  })
  const aOf = (other: string) => pairs.some((p) => (p.a === name('sess-a', 0) || p.b === name('sess-a', 0)) && (p.a.startsWith(other) || p.b.startsWith(other)))
  assert(aOf('sess-c'), 'the lone image of the third session is still a partner of the first')
  assertEquals(stats.isolatedSessions, [])
})

Deno.test('partners are ranked by how much of both gates they use, not by distance alone', () => {
  // a1 has two candidates in sess-b: b1 is nearer but looks 50 degrees away, b2 is farther and looks the same way.
  // b1 and b2 each have a better partner of their own in sess-a, so the only way a1 is paired with either is by choosing it.
  const at = (x: number, y: number, deg: number) => ({ position: [x, 1.5, y] as V3, forward: heading(deg) })
  const a = [
    { name: name('sess-a', 0), sessionId: 'sess-a', index: 0, ...at(0, 0, 0) },
    { name: name('sess-a', 1), sessionId: 'sess-a', index: 1, ...at(1.0, 0.1, 50) },
    { name: name('sess-a', 2), sessionId: 'sess-a', index: 2, ...at(1.5, 0.1, 0) },
  ]
  const b = [
    { name: name('sess-b', 0), sessionId: 'sess-b', index: 0, ...at(1.0, 0, 50) },
    { name: name('sess-b', 1), sessionId: 'sess-b', index: 1, ...at(1.5, 0, 0) },
  ]
  const { pairs } = mustBuild([...a, ...b], { sequenceWindow: 0, maxRevisitPartners: 0, maxCrossPartnersPerSession: 1 })
  const have = new Set(pairs.map((p) => `${p.a} ${p.b}`))
  assert(have.has(key(name('sess-a', 0), name('sess-b', 1))), 'a1 chose the aligned partner (score 0.50 against 1.17)')
  assert(!have.has(key(name('sess-a', 0), name('sess-b', 0))), 'and not the nearer one that looks away')
  assertEquals(have.size, 3)
})

Deno.test('a pair list never exceeds the per-image caps times the images', () => {
  // Six dense sessions all looking at one spot: the worst case for the cap.
  const images: PairImage[] = []
  for (let s = 0; s < 6; s++) {
    images.push(...session(`sess-${s}`, 60, (i) => ({ position: [i * 0.01, 1.5, s * 0.05], forward: heading(i % 5) })))
  }
  const { stats } = mustBuild(images, { maxPairs: 1e9 })
  const bound = images.length * (SEQUENCE_WINDOW + MAX_REVISIT_PARTNERS + 5 * MAX_CROSS_PARTNERS_PER_SESSION)
  assert(stats.totalPairs <= bound, `${stats.totalPairs} pairs for ${images.length} images, bound ${bound}`)
  assert(stats.totalPairs < stats.exhaustivePairs / 5, 'far fewer pairs than matching everything')
})

// ─── Revisits ────────────────────────────────────────────────────────────────

/** A walk once round a circle of radius 4 m: the end comes back to the start. */
function loop(sessionId: string, n: number): PairImage[] {
  return session(sessionId, n, (i) => {
    const a = (i / n) * 2 * Math.PI
    // Tangent direction, so the views at the start and the end agree.
    return { position: [4 * Math.cos(a), 1.5, 4 * Math.sin(a)], forward: [-Math.sin(a), 0, Math.cos(a)] }
  })
}

Deno.test('a walk that comes back to where it began is paired with itself there, and nowhere else', () => {
  const { pairs, stats } = mustBuild(loop('sess-a', 60))
  const revisits = pairs.filter((p) => p.kind === 'revisit')
  assert(revisits.length > 0, 'the start and the end of the loop are neighbours in the room')
  assert(
    revisits.some((p) => p.a === name('sess-a', 0) && p.b === name('sess-a', 59)),
    'image 0 and image 59 are 0.4 m apart facing the same way',
  )
  // Nothing on the far side of the circle: it is 8 m away.
  assert(!pairs.some((p) => p.a === name('sess-a', 0) && p.b === name('sess-a', 30)))
  assertEquals(stats.crossSessionPairs, 0)

  assertEquals(mustBuild(loop('sess-a', 60), { maxRevisitPartners: 0 }).stats.revisitPairs, 0)
})

Deno.test('a walk that comes back alongside itself is paired with the way out, however many neighbours it has in capture order', () => {
  // Out along +x at z = 0 and back along -x at z = 0.3, a frame every 5 cm, both looking along +z (a sideways shuffle).
  // Each frame has ten neighbours in capture order closer than the way back, so a pair list that let those use up a
  // frame's revisit partners would never reach the other pass.
  const out = session('sess-a', 30, (i) => ({ position: [i * 0.05, 1.5, 0], forward: heading(0) }))
  const back = session('sess-a', 30, (i) => ({ position: [(29 - i) * 0.05, 1.5, 0.3], forward: heading(0) })).map((image) => ({
    ...image,
    name: name('sess-a', 30 + image.index),
    index: 30 + image.index,
  }))
  const { pairs } = mustBuild([...out, ...back])
  // Frame 5 is at x = 0.25 on the way out; frame 54 (index 30 + 24) is at x = 0.25 on the way back.
  assert(
    pairs.some((p) => p.kind === 'revisit' && p.a === name('sess-a', 5) && p.b === name('sess-a', 54)),
    'the frame at the same place on the other pass is a revisit partner',
  )
})

Deno.test('a frame at the edge of the sequence window does not use up a revisit partner the pair list already has', () => {
  // Out along +x every 5 cm, back along -x 52 cm to the side, both looking along +z. The frame ten places on along the
  // same pass is 50 cm away, nearer than the frame across from it on the way back (52 cm), and is already paired by the
  // sequence window: with one revisit partner each, a list that offered it as a candidate would spend the one slot on a
  // pair it has and never reach the other pass.
  const out = session('sess-a', 30, (i) => ({ position: [i * 0.05, 1.5, 0], forward: heading(0) }))
  const back = session('sess-a', 30, (i) => ({ position: [(29 - i) * 0.05, 1.5, 0.52], forward: heading(0) })).map((image) => ({
    ...image,
    name: name('sess-a', 30 + image.index),
    index: 30 + image.index,
  }))
  const { pairs } = mustBuild([...out, ...back], { maxRevisitPartners: 1 })
  assert(
    pairs.some((p) => p.kind === 'revisit' && p.a === name('sess-a', 5) && p.b === name('sess-a', 54)),
    'frame 5 is paired with the frame across from it on the way back',
  )
  assertEquals(pairs.find((p) => p.a === name('sess-a', 5) && p.b === name('sess-a', 15))?.kind, 'sequence', 'and the edge of the window is still a sequence pair')
})

// ─── The grid against a brute-force reading of the rule ──────────────────────

Deno.test('the gated pairs are exactly the pairs inside both gates, on random clouds', () => {
  // A seeded cloud of three sessions in a 12 x 3 x 12 m box, so partners often sit across cell boundaries.
  let seed = 20260116
  const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const images: PairImage[] = []
  for (const s of ['sess-a', 'sess-b', 'sess-c']) {
    images.push(...session(s, 40, () => {
      const yaw = next() * 360
      return { position: [next() * 12, next() * 3, next() * 12], forward: heading(yaw) }
    }))
  }
  const window = 3
  const result = mustBuild(images, {
    sequenceWindow: window,
    maxCrossPartnersPerSession: 1e9,
    maxRevisitPartners: 1e9,
    maxPairs: 1e9,
  })

  const expected = new Set<string>()
  const rank = (img: PairImage) => img.index
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const x = images[i]!
      const y = images[j]!
      const sameSession = x.sessionId === y.sessionId
      if (sameSession && Math.abs(rank(x) - rank(y)) <= window) {
        expected.add(key(x.name, y.name))
        continue
      }
      const d = Math.hypot(x.position![0] - y.position![0], x.position![1] - y.position![1], x.position![2] - y.position![2])
      const dot = x.forward![0] * y.forward![0] + x.forward![1] * y.forward![1] + x.forward![2] * y.forward![2]
      const angle = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI
      if (d <= CROSS_SESSION_MAX_DISTANCE_M && angle <= CROSS_SESSION_MAX_ANGLE_DEG) expected.add(key(x.name, y.name))
    }
  }
  const got = new Set(result.pairs.map((p) => `${p.a} ${p.b}`))
  assertEquals([...got].sort(), [...expected].sort())
  assert(expected.size > 100, `the cloud should be dense enough to mean something: ${expected.size} pairs`)
})

/** A small seeded generator, so the clouds are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Rule {
  window: number
  maxDistanceM: number
  maxAngleDeg: number
  capCross: number
  capRevisit: number
}

/**
 * The rule of the file header read straight, with no grid and no early exit: every posed image against every other. The
 * sequence window first, then for each posed image its candidates inside both gates and outside the window, best first
 * per other session (the share of each gate used, then the name), the first few of each kept. Written separately from
 * the builder, and with the caps in: the check above has them off, and a grid that scanned half its neighbouring cells
 * would lose partners the caps then replace with worse ones, which only a comparison with the caps on can see.
 */
function readTheRule(images: readonly PairImage[], rule: Rule): Array<{ a: string; b: string; kind: string }> {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const bySession = new Map<string, PairImage[]>()
  for (const image of images) bySession.set(image.sessionId, [...(bySession.get(image.sessionId) ?? []), image])
  const rank = new Map<string, number>()
  for (const list of bySession.values()) {
    list.sort((x, y) => x.index - y.index || text(x.name, y.name))
    list.forEach((image, r) => rank.set(image.name, r))
  }
  const found = new Map<string, { a: string; b: string; kind: string }>()
  const add = (x: PairImage, y: PairImage, kind: string) => {
    const [a, b] = text(x.name, y.name) < 0 ? [x.name, y.name] : [y.name, x.name]
    if (!found.has(`${a}\n${b}`)) found.set(`${a}\n${b}`, { a, b, kind })
  }
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length; i++) for (let k = 1; k <= rule.window && i + k < list.length; k++) add(list[i]!, list[i + k]!, 'sequence')
  }
  const posed = images.filter((image) => image.position && image.forward).sort((x, y) => text(x.name, y.name))
  for (const me of posed) {
    const candidates = new Map<string, Array<{ image: PairImage; score: number }>>()
    for (const you of posed) {
      if (you === me) continue
      const d = Math.hypot(me.position![0] - you.position![0], me.position![1] - you.position![1], me.position![2] - you.position![2])
      if (d > rule.maxDistanceM) continue
      const dot = me.forward![0] * you.forward![0] + me.forward![1] * you.forward![1] + me.forward![2] * you.forward![2]
      const length = Math.hypot(...me.forward!) * Math.hypot(...you.forward!)
      const angle = length > 0 ? (Math.acos(Math.min(1, Math.max(-1, dot / length))) * 180) / Math.PI : 180
      if (angle > rule.maxAngleDeg) continue
      if (you.sessionId === me.sessionId && Math.abs(rank.get(me.name)! - rank.get(you.name)!) <= rule.window) continue
      candidates.set(you.sessionId, [...(candidates.get(you.sessionId) ?? []), { image: you, score: d / rule.maxDistanceM + angle / rule.maxAngleDeg }])
    }
    for (const [sessionId, list] of candidates) {
      list.sort((x, y) => x.score - y.score || text(x.image.name, y.image.name))
      const own = sessionId === me.sessionId
      for (const { image } of list.slice(0, own ? rule.capRevisit : rule.capCross)) add(me, image, own ? 'revisit' : 'cross-session')
    }
  }
  return [...found.values()].sort((x, y) => text(x.a, y.a) || text(x.b, y.b))
}

/** Clouds of one to five sessions: loose, on a lattice, exactly on the 3 m gate and the cell borders, far from the origin, and at negative coordinates. */
function cloud(seed: number, kind: 'random' | 'lattice' | 'boundary' | 'far' | 'negative'): PairImage[] {
  const next = rng(seed)
  const images: PairImage[] = []
  const sessions = 1 + Math.floor(next() * 5)
  for (let s = 0; s < sessions; s++) {
    const count = 1 + Math.floor(next() * 40)
    for (let i = 0; i < count; i++) {
      const image: PairImage = { name: name(`sess-${s}`, i), sessionId: `sess-${s}`, index: next() < 0.15 ? Math.floor(next() * 5) : i }
      if (next() < 0.9) {
        if (kind === 'lattice') image.position = [Math.floor(next() * 6) * 1.5, 0, Math.floor(next() * 4) * 1.5]
        else if (kind === 'boundary') image.position = [Math.floor(next() * 5) * 3, Math.floor(next() * 2) * 3, Math.floor(next() * 3) * 3]
        else if (kind === 'far') image.position = [1e6 + next() * 8, 20 + next() * 3, -1e6 + next() * 8]
        else if (kind === 'negative') image.position = [-7 + next() * 8, -2 + next() * 3, -5 + next() * 8]
        else image.position = [next() * 9, next() * 3, next() * 9]
        const stepped = kind === 'lattice' || kind === 'boundary'
        const yaw = stepped ? Math.floor(next() * 12) * 30 : next() * 360
        const pitch = stepped ? 0 : (next() - 0.5) * 60
        const cp = Math.cos((pitch * Math.PI) / 180)
        image.forward = [Math.sin((yaw * Math.PI) / 180) * cp, Math.sin((pitch * Math.PI) / 180), -Math.cos((yaw * Math.PI) / 180) * cp]
        if (next() < 0.03) image.forward = [0, 0, 0]
      }
      images.push(image)
    }
  }
  return images
}

Deno.test('the whole list, caps and ties included, is what a straight reading of the rule gives, whatever order the images arrive in', () => {
  let compared = 0
  let cases = 0
  for (const kind of ['random', 'lattice', 'boundary', 'far', 'negative'] as const) {
    for (let seed = 1; seed <= 70; seed++) {
      const images = cloud(seed * 7 + kind.length, kind)
      if (images.length < 2) continue
      const options = {
        sequenceWindow: [10, 0, 3][seed % 3]!,
        maxCrossPartnersPerSession: seed % 4 === 0 ? 2 : 8,
        maxRevisitPartners: seed % 5 === 0 ? 1 : 4,
        maxPairs: 1_000_000,
      }
      const want = readTheRule(images, {
        window: options.sequenceWindow,
        maxDistanceM: CROSS_SESSION_MAX_DISTANCE_M,
        maxAngleDeg: CROSS_SESSION_MAX_ANGLE_DEG,
        capCross: options.maxCrossPartnersPerSession,
        capRevisit: options.maxRevisitPartners,
      })
      const got = mustBuild(images, options)
      assertEquals(got.pairs, want, `${kind} cloud ${seed}`)
      // The same images in another order, and the same list.
      const next = rng(seed + 999)
      const shuffled = [...images]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      assertEquals(mustBuild(shuffled, options).pairs, want, `${kind} cloud ${seed}, shuffled`)
      cases++
      compared += want.length
    }
  }
  assert(cases >= 300 && compared > 5000, `${cases} clouds, ${compared} pairs: enough to mean something`)
})

// ─── Frames without poses, and sessions nothing ties in ──────────────────────

Deno.test('a frame with no pose keeps its sequence neighbours and takes no part in the gates', () => {
  const a = corridor('sess-a', 20, 0)
  // Every other frame of sess-b has no pose.
  const b = session('sess-b', 20, (i) => (i % 2 === 0 ? { position: [i * 0.3, 1.5, 1], forward: heading(0) } : null))
  const { pairs, stats } = mustBuild([...a, ...b])
  assertEquals(stats.sessions.find((s) => s.sessionId === 'sess-b')!.posed, 10)
  const unposed = name('sess-b', 1)
  assert(pairs.some((p) => (p.a === unposed || p.b === unposed) && p.kind === 'sequence'))
  assert(!pairs.some((p) => (p.a === unposed || p.b === unposed) && p.kind !== 'sequence'), 'no cross pair for an unposed frame')
})

Deno.test('a session no pair ties to the others is reported, not hidden', () => {
  const images = [...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 1), ...corridor('sess-far', 20, 40)]
  const { stats } = mustBuild(images)
  assertEquals(stats.isolatedSessions, ['sess-far'])
  assertEquals(stats.sessions.find((s) => s.sessionId === 'sess-a')!.crossPartners, ['sess-b'])
  assertEquals(stats.sessions.find((s) => s.sessionId === 'sess-far')!.crossPartners, [])
})

Deno.test('one session has no cross-session partners to miss', () => {
  assertEquals(mustBuild(corridor('sess-a', 20, 0)).stats.isolatedSessions, [])
})

Deno.test('sessions are tied when they are connected, not only when each has a partner', () => {
  // a is beside b, b is beside c, a and c are 5 m apart: one group, so nothing is isolated.
  const images = [...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 2.5), ...corridor('sess-c', 20, 5)]
  const { stats } = mustBuild(images)
  assertEquals(stats.groups, [['sess-a', 'sess-b', 'sess-c']])
  assertEquals(stats.isolatedSessions, [])
  assertEquals(planMatching(images).kind, 'pairs')
})

Deno.test('two groups of sessions that no pair connects are not tied together, though every session has a partner', () => {
  // a and b are beside each other, c and d are beside each other, 40 m away: every session has a partner and the groups
  // cannot join. (80 images: few enough for the fallback to be allowed.)
  const images = [
    ...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 1),
    ...corridor('sess-c', 20, 40), ...corridor('sess-d', 20, 41),
  ]
  const { stats } = mustBuild(images)
  assertEquals(stats.groups, [['sess-a', 'sess-b'], ['sess-c', 'sess-d']], 'equal images: the first session id decides which group matters')
  assertEquals(stats.isolatedSessions, ['sess-c', 'sess-d'])
  assertEquals(stats.sessions.map((s) => s.crossPartners.length > 0), [true, true, true, true], 'each has a partner')

  const plan = planMatching(images)
  assert(plan.kind === 'exhaustive', `expected exhaustive, got ${plan.kind}`)
  assertEquals(plan.pairCount, 3160)
  assertEquals(plan.why, 'The poses tie sess-c, sess-d to each other and not to sess-a, sess-b, so every pair is matched instead.')

  // The reference decides which group matters: with sess-c named, it is sess-a and sess-b that are left out.
  const named = mustBuild(images, { referenceSessionId: 'sess-c' })
  assertEquals(named.stats.groups, [['sess-c', 'sess-d'], ['sess-a', 'sess-b']])
  assertEquals(named.stats.isolatedSessions, ['sess-a', 'sess-b'])
  assertEquals(mustBuild(images, { referenceSessionId: 'sess-nowhere' }).stats.groups[0], ['sess-a', 'sess-b'], 'a name that is not a session changes nothing')

  // Too many images to match every pair: refused, saying which groups the poses could not join.
  const many = [
    ...corridor('sess-a', 60, 0), ...corridor('sess-b', 60, 1),
    ...corridor('sess-c', 60, 40), ...corridor('sess-d', 60, 41),
  ]
  const refused = planMatching(many)
  assert(refused.kind === 'refused' && refused.reason === 'no-cross-session-overlap')
  assert(refused.message.includes('sess-c, sess-d to each other and not to sess-a, sess-b'), refused.message)
  assert(refused.message.includes('tie them to the others'), refused.message)
})

Deno.test('a reference that nothing is paired with is isolated, along with the sessions that are tied only to each other', () => {
  const images = [...corridor('sess-ref', 20, 0), ...corridor('sess-a', 20, 40), ...corridor('sess-b', 20, 41)]
  const { stats } = mustBuild(images, { referenceSessionId: 'sess-ref' })
  assertEquals(stats.groups, [['sess-ref'], ['sess-a', 'sess-b']])
  assertEquals(stats.isolatedSessions, ['sess-a', 'sess-b', 'sess-ref'])
  const plan = planMatching(images, { referenceSessionId: 'sess-ref' })
  assert(plan.kind === 'exhaustive')
  assertEquals(
    plan.why,
    "No frame of sess-ref is within 3 m and 60 degrees of another session's by its poses, and the poses tie sess-a, sess-b to each other and not to sess-ref, so every pair is matched instead.",
  )
})

// ─── Refusals ────────────────────────────────────────────────────────────────

Deno.test('a list is refused for fewer than two images, a repeated name, or a name a list line cannot carry', () => {
  const one = buildPairList([{ name: 'a/kf-00000.jpg', sessionId: 'a', index: 0 }])
  assert(!one.ok && one.reason === 'too-few-images')

  const twice = buildPairList([
    { name: 'a/kf-00000.jpg', sessionId: 'a', index: 0 },
    { name: 'a/kf-00000.jpg', sessionId: 'a', index: 1 },
  ])
  assert(!twice.ok && twice.reason === 'bad-image-name' && twice.message.includes('a/kf-00000.jpg'))

  const spaced = buildPairList([
    { name: 'a/kf 00000.jpg', sessionId: 'a', index: 0 },
    { name: 'a/kf-00001.jpg', sessionId: 'a', index: 1 },
  ])
  assert(!spaced.ok && spaced.reason === 'bad-image-name' && spaced.message.includes('whitespace'))
})

Deno.test('a list over the pair cap is refused with the numbers, not truncated', () => {
  const images = session('sess-a', 60, () => null)
  const result = buildPairList(images, { maxPairs: 100 })
  assert(!result.ok && result.reason === 'too-many-pairs')
  assert(result.message.includes('1,770'), `the message should say what matching everything would be: ${result.message}`)
  assert(result.message.includes('more than 100 pairs'), `and the limit it is held to: ${result.message}`)
  assert(buildPairList(images, { maxPairs: 100_000 }).ok)
})

/** Images whose poses count how often they are read, so a test can tell whether the search that needs them ran. */
function watched(sessionId: string, count: number, at: () => V3, reads: { n: number }): PairImage[] {
  return Array.from({ length: count }, (_, i) => ({
    name: name(sessionId, i),
    sessionId,
    index: i,
    get position(): V3 {
      reads.n++
      return at()
    },
    forward: heading(0),
  }))
}
Deno.test('a list already past the cap is refused before any pose is read', () => {
  // 40 images of one session are 345 sequence pairs, past a cap of 50: the answer is known without the gated search.
  const reads = { n: 0 }
  const result = buildPairList(watched('sess-a', 40, () => [0, 1.5, 0], reads), { maxPairs: 50 })
  assert(!result.ok && result.reason === 'too-many-pairs')
  assertEquals(reads.n, 0, 'no pose was read')
})

Deno.test('a crowd of sessions in one place is refused as soon as the pairs found pass the cap, not after the quadratic search', () => {
  // 200 sessions of 3 images, all at one spot: 600 images, 600 sequence pairs, and over 1,500 candidate partners for
  // each image. The cap of 1,000 is passed by the first image's partners, so the search must stop there.
  const reads = { n: 0 }
  const images = Array.from({ length: 200 }, (_, s) => watched(`sess-${String(s).padStart(3, '0')}`, 3, () => [0, 1.5, 0], reads)).flat()
  const result = buildPairList(images, { maxPairs: 1_000 })
  assert(!result.ok && result.reason === 'too-many-pairs')
  assert(reads.n < 30_000, `${reads.n} pose reads: a search over every image would be about 360,000`)
  // The same crowd under a cap it fits in is a list, so the stop is the cap and not the crowd.
  assert(buildPairList(images.slice(0, 12), { maxPairs: 1_000 }).ok)
})

Deno.test('the adopted constants are the numbers the docs quote', () => {
  assertEquals(
    [SEQUENCE_WINDOW, CROSS_SESSION_MAX_DISTANCE_M, CROSS_SESSION_MAX_ANGLE_DEG, MAX_CROSS_PARTNERS_PER_SESSION, MAX_REVISIT_PARTNERS, MAX_EXHAUSTIVE_IMAGES, MAX_PAIRS],
    [10, 3, 60, 8, 4, 100, 20_000],
  )
})

// ─── Exhaustive matching ─────────────────────────────────────────────────────

Deno.test('exhaustive matching is allowed up to 100 images and refused beyond, with the reason', () => {
  assertEquals(exhaustivePairCount(100), 4950)
  assertEquals(exhaustivePairCount(300), 44850)
  assertEquals(exhaustivePairCount(0), 0)
  assertEquals(exhaustivePairCount(1), 0)

  assertEquals(exhaustiveMatchingVerdict(MAX_EXHAUSTIVE_IMAGES), { allowed: true, pairCount: 4950 })
  const refused = exhaustiveMatchingVerdict(MAX_EXHAUSTIVE_IMAGES + 1)
  assert(!refused.allowed)
  assertEquals(refused.pairCount, 5050)
  assert(refused.reason.includes('101 images'), refused.reason)
  assert(refused.reason.includes('5,050'), refused.reason)
  assert(refused.reason.includes('up to 100 images'), refused.reason)
  assertEquals(exhaustiveMatchingVerdict(300).allowed, false)
  assertEquals(exhaustiveMatchingVerdict(8, 5).allowed, false, 'the limit is a parameter')
})

// ─── Choosing how to match ───────────────────────────────────────────────────

Deno.test('planMatching uses the pair list when every session is tied to another', () => {
  const plan = planMatching([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 1)])
  assertEquals(plan.kind, 'pairs')
  if (plan.kind === 'pairs') assert(plan.stats.crossSessionPairs > 0)
})

Deno.test('planMatching matches a single session by its pair list', () => {
  assertEquals(planMatching(corridor('sess-a', 30, 0)).kind, 'pairs')
})

Deno.test('planMatching falls back to exhaustive matching for a small set whose sessions the poses cannot tie', () => {
  // 40 images in two sessions 40 m apart: no pose ties them, and 40 images are 780 pairs.
  const plan = planMatching([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 40)])
  assert(plan.kind === 'exhaustive', `expected exhaustive, got ${plan.kind}`)
  assertEquals(plan.pairCount, 780)
  assert(plan.why.includes('sess-a, sess-b'), plan.why)
  assert(plan.why.includes('3 m') && plan.why.includes('60 degrees'), plan.why)
})

Deno.test('planMatching says when nothing places a session in the Place frame, which is not the same as being posed far away', () => {
  const unposed = planMatching([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 1), ...session('sess-c', 20, () => null)])
  assert(unposed.kind === 'exhaustive')
  assertEquals(unposed.why, 'Nothing places a frame of sess-c in the Place frame, so every pair is matched instead.')

  const both = planMatching([...corridor('sess-a', 20, 0), ...corridor('sess-b', 20, 40), ...session('sess-c', 20, () => null)])
  assert(both.kind === 'exhaustive')
  assertEquals(
    both.why,
    "Nothing places a frame of sess-c in the Place frame, and no frame of sess-a, sess-b is within 3 m and 60 degrees of another session's by its poses, so every pair is matched instead.",
  )
})

Deno.test('planMatching refuses a large set whose sessions the poses cannot tie, and says both reasons', () => {
  // 240 images: no pair ties the two sessions, and matching all 28,680 pairs is beyond the limit.
  const plan = planMatching([...corridor('sess-a', 120, 0), ...corridor('sess-b', 120, 40)])
  assert(plan.kind === 'refused', `expected a refusal, got ${plan.kind}`)
  assertEquals(plan.reason, 'no-cross-session-overlap')
  assert(plan.message.includes('sess-a, sess-b'), plan.message)
  assert(plan.message.includes('28,680'), plan.message)
  assert(plan.message.includes('up to 100 images'), plan.message)
  assert(plan.stats !== undefined && plan.stats.isolatedSessions.length === 2)
})

Deno.test('planMatching passes a refusal of the list itself straight through', () => {
  const plan = planMatching([{ name: 'a/kf-00000.jpg', sessionId: 'a', index: 0 }])
  assert(plan.kind === 'refused' && plan.reason === 'too-few-images')
})

// ─── The file COLMAP reads ───────────────────────────────────────────────────

Deno.test('the match list is one "name name" line per pair', () => {
  const { pairs } = mustBuild(corridor('sess-a', 4, 0))
  const text = formatMatchList(pairs)
  assertEquals(text.endsWith('\n'), true)
  const lines = text.trimEnd().split('\n')
  assertEquals(lines.length, pairs.length)
  for (const line of lines) assertEquals(line.split(' ').length, 2)
  assertEquals(lines[0], 'sess-a/kf-00000.jpg sess-a/kf-00001.jpg')
  assertEquals(formatMatchList([]), '')
})
