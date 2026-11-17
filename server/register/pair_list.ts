/**
 * Which image pairs a joint COLMAP solve should match: the pair list for
 * `colmap matches_importer --match_type pairs`, built from the AR poses the keyframes already carry.
 *
 * ## Why not match everything
 *
 * `exhaustive_matcher` compares every image with every other: n(n-1)/2 pairs, so 300 keyframes are 44,850
 * pairs. A Place's worth of sessions is that many keyframes and more (the audit's W4-4 counts about twenty short
 * sessions to a room), and the research estimate for that many pairs of SIFT matching on CPU is half an hour to
 * two hours (R2 section 4; an inference from an assumed throughput, not a measurement). Most of those pairs
 * cannot match: two frames facing opposite walls share nothing. The AR poses already say which frames could.
 *
 * ## What the list holds
 *
 *  - **sequence**: each image with the next {@link SEQUENCE_WINDOW} images of its own session, in capture order.
 *    Consecutive keyframes overlap by construction (the streamer takes one every 0.3 m or 20 degrees), and this
 *    is what ties one session together.
 *  - **revisit**: images of one session that are far apart in capture order but close in the Place frame: the
 *    walk came back. The same distance and angle gates as the next kind, a smaller partner cap.
 *  - **cross-session**: images of different sessions within {@link CROSS_SESSION_MAX_DISTANCE_M} and
 *    {@link CROSS_SESSION_MAX_ANGLE_DEG} of each other in the Place frame. This is what ties two sessions to each
 *    other, and the only reason the list needs poses: each session's poses reach the Place frame through its own
 *    calibration, so the gates are loose (the calibration errors this package exists to measure are decimetres).
 *
 * `spatial_matcher` is deliberately not used for the third kind. Whether it reads anything but GPS priors is
 * unverified (R2, section 5), and its default window is a hundred metres.
 *
 * ## What it cannot do
 *
 * The gates trust each session's frame. A session whose calibration is wrong by more than the gates (a one-point
 * frame turned by the baseline's bearing, a frame that moved after calibration) has frames that overlap another
 * session's in the room and not in the Place frame, so no pair is found. {@link buildPairList} reports such a
 * session in `stats.isolatedSessions` rather than hiding it, and {@link planMatching} then falls back to
 * exhaustive matching when the image count allows it and refuses, with the reason, when it does not.
 *
 * "Tied" means connected, not merely paired: two sessions that are paired with each other and with nobody else are one
 * group, and a solve has to join every session to the reference, not to some other session. The groups the pairs make
 * are in `stats.groups`, the one that matters first (the group of the named `referenceSessionId`, else the largest),
 * and every session outside it is isolated.
 *
 * Pure: no Deno API, no file access. Deterministic: the same images give the same pairs in the same order, whatever
 * order the images arrive in.
 */

/** A point or direction in the Place frame, as the `[x, y, z]` tuple splat_align.ts uses. */
export type PairVec3 = readonly [number, number, number]

/** One image a pair list can name. */
export interface PairImage {
  /** The name COLMAP knows the image by: its path under `--image_path`, `<sessionId>/kf-00012.jpg`. No whitespace. */
  name: string
  /** The session, which is also the camera: every image of a session shares one. */
  sessionId: string
  /** Capture order within the session (the keyframe's `index`). */
  index: number
  /** The camera centre in the Place frame, metres. Absent when the frame has no pose in that frame. */
  position?: PairVec3
  /** The unit viewing direction in the Place frame. Absent with `position`: a frame is posed with both or neither. */
  forward?: PairVec3
}

export type PairKind = 'sequence' | 'revisit' | 'cross-session'

/** One pair to match. `a` sorts before `b` by plain string comparison, so a pair has one spelling. */
export interface ImagePair {
  a: string
  b: string
  kind: PairKind
}

// ─── Adopted constants ───────────────────────────────────────────────────────

/**
 * How many following images of its own session each image is matched with.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The number is COLMAP's own default for
 * `--SequentialMatching.overlap` (10, read from `colmap sequential_matcher -h` on 3.13.0). **Revisit when** DX9
 * shows sessions that do not hold together (raise it) or matching time dominates (lower it).
 */
export const SEQUENCE_WINDOW = 10

/**
 * Two frames of different sessions are candidates for a match when their camera centres are at most this far
 * apart in the Place frame, metres. From the package brief (R2 section 5), where it is a starting value.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 shows true overlaps outside it, or the
 * calibration error between sessions (DX2) turns out larger than the gate can absorb.
 */
export const CROSS_SESSION_MAX_DISTANCE_M = 3

/**
 * ...and the angle between their viewing directions is at most this, degrees. Same source and same status as
 * {@link CROSS_SESSION_MAX_DISTANCE_M}.
 */
export const CROSS_SESSION_MAX_ANGLE_DEG = 60

/**
 * Most partners an image gets in each other session, best first by closeness (see {@link pairScore}).
 *
 * **Adopted, not measured (ADR 0005 rule 5).** A handful of strong pairs is what ties two sessions together; more
 * costs matching time without adding connections. **Revisit when** DX9 shows sessions that fail to join with this
 * many, or the pair count is the cost.
 */
export const MAX_CROSS_PARTNERS_PER_SESSION = 8

/**
 * Most revisit partners an image gets in its own session, beyond the sequence window.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** Smaller than the cross-session cap because a revisit only has to
 * close a loop, not join two sessions. **Revisit when** DX9 shows loop-closure drift in a single session.
 */
export const MAX_REVISIT_PARTNERS = 4

/**
 * Exhaustive matching is allowed up to this many images and refused beyond it: "about 100" in the package brief.
 * 100 images are 4,950 pairs; 300 are 44,850.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** One datum from this box, on synthetic images: 54 images
 * (1,431 pairs, about 1,200 SIFT features each) matched in 21 s wall on a 32-thread CPU. Real keyframes carry up to
 * 8,192 features and brute-force matching of one pair grows with the square of that, so the datum is not a figure to
 * scale from: at the cost per pair measured for {@link MAX_PAIRS}, 100 images (4,950 pairs) would be minutes at
 * 2,000 features and most of an hour at 8,192, against the two hours COLMAP is given per step (`COLMAP_TIMEOUT_MS`).
 * **Revisit when** DX9 gives the time per pair on real keyframes.
 */
export const MAX_EXHAUSTIVE_IMAGES = 100

/**
 * The most pairs a list may hold before {@link buildPairList} refuses it and asks for fewer images.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** Under half of what exhaustive matching of 300 keyframes would be (44,850).
 * Whether that is a time COLMAP finishes in depends on features per frame, and no real keyframe has been counted. Two
 * measurements on this box (CPU, 32 threads, other work running), both on rendered rooms: 378 pairs of images with about
 * 1,100 SIFT features (at most 1,824) matched in 9.7 s, 26 ms a pair (the finishing pass of the package); 378 pairs at
 * about 1,750 features in 11.3 s, 30 ms a pair (the review of the package). The cost per pair barely moved across that
 * range, so how it grows with the feature count (up to 8,192 on a real keyframe) is not established. At 30 ms a pair
 * 20,000 pairs are 10 minutes; if the cost grew with the square of the features, 8,192-feature frames would take hours
 * and pass the two hours a step is given (`COLMAP_TIMEOUT_MS`).
 * **Revisit when** DX9 gives the time per pair on real keyframes, and set this from it and `COLMAP_TIMEOUT_MS`.
 */
export const MAX_PAIRS = 20_000

export interface PairListOptions {
  sequenceWindow?: number
  maxDistanceM?: number
  maxAngleDeg?: number
  maxCrossPartnersPerSession?: number
  maxRevisitPartners?: number
  maxPairs?: number
  /**
   * The session every other one is registered to. The sessions the list must tie together are then the ones tied to
   * it, and the rest are isolated. Without it the largest group of tied sessions is the one that matters.
   */
  referenceSessionId?: string
}

interface ResolvedOptions {
  sequenceWindow: number
  maxDistanceM: number
  maxAngleDeg: number
  maxCrossPartnersPerSession: number
  maxRevisitPartners: number
  maxPairs: number
  referenceSessionId: string | null
}

function wholeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveOptions(options: PairListOptions): ResolvedOptions {
  return {
    sequenceWindow: wholeOr(options.sequenceWindow, SEQUENCE_WINDOW),
    maxDistanceM: positiveOr(options.maxDistanceM, CROSS_SESSION_MAX_DISTANCE_M),
    maxAngleDeg: positiveOr(options.maxAngleDeg, CROSS_SESSION_MAX_ANGLE_DEG),
    maxCrossPartnersPerSession: wholeOr(options.maxCrossPartnersPerSession, MAX_CROSS_PARTNERS_PER_SESSION),
    maxRevisitPartners: wholeOr(options.maxRevisitPartners, MAX_REVISIT_PARTNERS),
    maxPairs: wholeOr(options.maxPairs, MAX_PAIRS),
    referenceSessionId: typeof options.referenceSessionId === 'string' ? options.referenceSessionId : null,
  }
}

// ─── The result ──────────────────────────────────────────────────────────────

export interface PairListSessionStats {
  sessionId: string
  images: number
  /** Images with a pose in the Place frame: the only ones the gates can place. */
  posed: number
  /** The other sessions this session has at least one pair with, sorted. */
  crossPartners: string[]
}

export interface PairListStats {
  imageCount: number
  sessionCount: number
  posedImages: number
  sequencePairs: number
  revisitPairs: number
  crossSessionPairs: number
  totalPairs: number
  /** n(n-1)/2: what exhaustive matching of these images would be, for comparison. */
  exhaustivePairs: number
  sessions: PairListSessionStats[]
  /**
   * The groups of sessions the cross-session pairs tie together, each sorted by session id. The group that matters
   * comes first: the one holding the named reference session, else the one with the most images (the first
   * session id breaks a tie). A session no pair ties to another is a group of its own.
   */
  groups: string[][]
  /**
   * Sessions the list does not tie to the group that matters, when there are at least two sessions: no pair joins them
   * to it, because their frames are posed too far from its frames, or not posed at all. The group's own sessions are
   * listed too when it is a single session, which is tied to nothing. Sorted.
   */
  isolatedSessions: string[]
}

export type PairListRefusal = 'too-few-images' | 'bad-image-name' | 'too-many-pairs'

export type PairListResult =
  | { ok: true; pairs: ImagePair[]; stats: PairListStats }
  | { ok: false; reason: PairListRefusal; message: string }

/** n(n-1)/2 as a plain number. */
export function exhaustivePairCount(imageCount: number): number {
  const n = Math.max(0, Math.floor(imageCount))
  return (n * (n - 1)) / 2
}

export type ExhaustiveVerdict =
  | { allowed: true; pairCount: number }
  | { allowed: false; pairCount: number; reason: string }

/**
 * Whether matching every image with every other is acceptable for `imageCount` images, and when it is not, why in a
 * sentence a person can act on. The limit is {@link MAX_EXHAUSTIVE_IMAGES}.
 */
export function exhaustiveMatchingVerdict(
  imageCount: number,
  maxImages: number = MAX_EXHAUSTIVE_IMAGES,
): ExhaustiveVerdict {
  const pairCount = exhaustivePairCount(imageCount)
  if (imageCount <= maxImages) return { allowed: true, pairCount }
  const limitPairs = exhaustivePairCount(maxImages)
  return {
    allowed: false,
    pairCount,
    reason: `${imageCount} images would be ${pairCount.toLocaleString('en-US')} pairs to match one by one, ` +
      `and exhaustive matching is only used up to ${maxImages} images (${limitPairs.toLocaleString('en-US')} pairs). ` +
      'Use fewer keyframes per session, or give the frames Place poses so only the pairs that can overlap are matched.',
  }
}

// ─── Geometry ────────────────────────────────────────────────────────────────

function isPosed(image: PairImage): image is PairImage & { position: PairVec3; forward: PairVec3 } {
  const { position, forward } = image
  return position !== undefined && forward !== undefined &&
    position.every(Number.isFinite) && forward.every(Number.isFinite)
}

function distance(a: PairVec3, b: PairVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function angleDeg(a: PairVec3, b: PairVec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const lengths = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])
  if (!(lengths > 0)) return 180
  return (Math.acos(Math.min(1, Math.max(-1, dot / lengths))) * 180) / Math.PI
}

/**
 * How close two posed frames are, as one number to rank partners by: the share of the distance gate used plus the
 * share of the angle gate used. 0 is the same place looking the same way; 2 is at both limits.
 */
export function pairScore(distanceM: number, angle: number, maxDistanceM: number, maxAngleDeg: number): number {
  return distanceM / maxDistanceM + angle / maxAngleDeg
}

/** Plain code-unit comparison: the same answer on every machine, which `localeCompare` is not. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function cellKey(position: PairVec3, cell: number): string {
  return `${Math.floor(position[0] / cell)},${Math.floor(position[1] / cell)},${Math.floor(position[2] / cell)}`
}

// ─── The builder ─────────────────────────────────────────────────────────────

/**
 * The pair list for these images. See the file header for what it holds and why.
 *
 * Refuses (`ok: false`, with the reason in words) when there are fewer than two images, when two images share a
 * name or a name holds whitespace (the list is one `name name` pair per line, so such a name cannot be written), or
 * when the list would pass {@link MAX_PAIRS}, which is known, and refused, as soon as the pairs found so far pass it. It
 * does not refuse a session that no pair ties to the others: that is `stats.isolatedSessions`, and what to do about it
 * is {@link planMatching}'s call.
 */
export function buildPairList(images: readonly PairImage[], options: PairListOptions = {}): PairListResult {
  const o = resolveOptions(options)
  if (images.length < 2) {
    return { ok: false, reason: 'too-few-images', message: `${images.length} image(s) cannot make a pair.` }
  }
  const seen = new Set<string>()
  for (const image of images) {
    if (image.name === '' || /\s/.test(image.name)) {
      return {
        ok: false,
        reason: 'bad-image-name',
        message: `The image name "${image.name}" is empty or holds whitespace, which a pair list line cannot carry.`,
      }
    }
    if (seen.has(image.name)) {
      return { ok: false, reason: 'bad-image-name', message: `Two images are both named "${image.name}".` }
    }
    seen.add(image.name)
  }

  // Each session's images in capture order; the position in that order is the image's rank.
  const bySession = new Map<string, PairImage[]>()
  for (const image of images) {
    const list = bySession.get(image.sessionId)
    if (list) list.push(image)
    else bySession.set(image.sessionId, [image])
  }
  const sessionIds = [...bySession.keys()].sort(compareText)
  const rankOf = new Map<string, number>()
  for (const id of sessionIds) {
    const list = bySession.get(id)!
    list.sort((x, y) => x.index - y.index || compareText(x.name, y.name))
    list.forEach((image, rank) => rankOf.set(image.name, rank))
  }

  const found = new Map<string, ImagePair>()
  const add = (x: PairImage, y: PairImage, kind: PairKind): void => {
    const [a, b] = compareText(x.name, y.name) < 0 ? [x.name, y.name] : [y.name, x.name]
    const key = `${a}\n${b}`
    // The same pair reached from both of its images is one pair. Sequence pairs go in first and the gated search
    // skips the sequence window, so a pair never has two kinds.
    if (!found.has(key)) found.set(key, { a, b, kind })
  }

  // A pair is only ever added, so the count so far is a lower bound on the final count and a list that is already past
  // the cap is refused at once, without the search that would only add to it. The sequence pairs alone are about ten
  // to an image, so a pile of images is refused here, in milliseconds, and the gated search below, which is quadratic
  // in a crowded cell, never runs on one.
  const tooMany = (): PairListResult => ({
    ok: false,
    reason: 'too-many-pairs',
    message: `${images.length} images would need more than ${o.maxPairs.toLocaleString('en-US')} pairs matched ` +
      `(matching every image with every other would be ${exhaustivePairCount(images.length).toLocaleString('en-US')}), ` +
      `and a pair list is held to ${o.maxPairs.toLocaleString('en-US')}. Use fewer keyframes per session.`,
  })

  for (const id of sessionIds) {
    const list = bySession.get(id)!
    for (let i = 0; i < list.length; i++) {
      for (let k = 1; k <= o.sequenceWindow && i + k < list.length; k++) add(list[i]!, list[i + k]!, 'sequence')
    }
  }
  if (found.size > o.maxPairs) return tooMany()

  // Pose-gated pairs, through a grid with one cell per distance gate: a partner is in the 27 cells round an image.
  const posed = images.filter(isPosed).sort((x, y) => compareText(x.name, y.name))
  const grid = new Map<string, number[]>()
  posed.forEach((image, at) => {
    const key = cellKey(image.position, o.maxDistanceM)
    const cell = grid.get(key)
    if (cell) cell.push(at)
    else grid.set(key, [at])
  })
  for (let at = 0; at < posed.length; at++) {
    const me = posed[at]!
    const cx = Math.floor(me.position[0] / o.maxDistanceM)
    const cy = Math.floor(me.position[1] / o.maxDistanceM)
    const cz = Math.floor(me.position[2] / o.maxDistanceM)
    const bySessionCandidates = new Map<string, Array<{ image: PairImage; score: number }>>()
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!cell) continue
          for (const other of cell) {
            if (other === at) continue
            const you = posed[other]!
            const d = distance(me.position, you.position)
            if (d > o.maxDistanceM) continue
            const a = angleDeg(me.forward, you.forward)
            if (a > o.maxAngleDeg) continue
            if (you.sessionId === me.sessionId) {
              // Inside the sequence window the pair is already there.
              if (Math.abs(rankOf.get(me.name)! - rankOf.get(you.name)!) <= o.sequenceWindow) continue
            }
            const list = bySessionCandidates.get(you.sessionId)
            const entry = { image: you, score: pairScore(d, a, o.maxDistanceM, o.maxAngleDeg) }
            if (list) list.push(entry)
            else bySessionCandidates.set(you.sessionId, [entry])
          }
        }
      }
    }
    for (const [sessionId, candidates] of bySessionCandidates) {
      candidates.sort((x, y) => x.score - y.score || compareText(x.image.name, y.image.name))
      const own = sessionId === me.sessionId
      const cap = own ? o.maxRevisitPartners : o.maxCrossPartnersPerSession
      for (const { image } of candidates.slice(0, cap)) add(me, image, own ? 'revisit' : 'cross-session')
    }
    if (found.size > o.maxPairs) return tooMany()
  }

  const pairs = [...found.values()].sort((x, y) => compareText(x.a, y.a) || compareText(x.b, y.b))
  const exhaustivePairs = exhaustivePairCount(images.length)

  const sessionOf = new Map<string, string>()
  for (const image of images) sessionOf.set(image.name, image.sessionId)
  const partners = new Map<string, Set<string>>(sessionIds.map((id) => [id, new Set<string>()]))
  let sequencePairs = 0
  let revisitPairs = 0
  let crossSessionPairs = 0
  for (const pair of pairs) {
    if (pair.kind === 'sequence') sequencePairs++
    else if (pair.kind === 'revisit') revisitPairs++
    else {
      crossSessionPairs++
      const sa = sessionOf.get(pair.a)!
      const sb = sessionOf.get(pair.b)!
      partners.get(sa)!.add(sb)
      partners.get(sb)!.add(sa)
    }
  }
  const sessions: PairListSessionStats[] = sessionIds.map((id) => {
    const list = bySession.get(id)!
    return {
      sessionId: id,
      images: list.length,
      posed: list.filter(isPosed).length,
      crossPartners: [...partners.get(id)!].sort(compareText),
    }
  })
  const groups = tiedGroups(sessions, o.referenceSessionId)
  return {
    ok: true,
    pairs,
    stats: {
      imageCount: images.length,
      sessionCount: sessionIds.length,
      posedImages: posed.length,
      sequencePairs,
      revisitPairs,
      crossSessionPairs,
      totalPairs: pairs.length,
      exhaustivePairs,
      sessions,
      groups,
      isolatedSessions: isolatedFrom(groups),
    },
  }
}

/**
 * The groups of sessions the cross-session pairs tie together (the connected components of "has a pair with"), each
 * sorted by id, the group that matters first: the one holding `referenceSessionId` when it names a session here, else
 * the one with the most images, the first session id breaking a tie. The rest follow in the same order.
 */
function tiedGroups(sessions: readonly PairListSessionStats[], referenceSessionId: string | null): string[][] {
  const parent = new Map<string, string>(sessions.map((s) => [s.sessionId, s.sessionId]))
  const root = (id: string): string => {
    let at = id
    while (parent.get(at) !== at) at = parent.get(at)!
    return at
  }
  for (const session of sessions) {
    for (const other of session.crossPartners) {
      const a = root(session.sessionId)
      const b = root(other)
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
    }
  }
  const members = new Map<string, string[]>()
  for (const session of sessions) {
    const key = root(session.sessionId)
    const list = members.get(key)
    if (list) list.push(session.sessionId)
    else members.set(key, [session.sessionId])
  }
  const imagesOf = new Map(sessions.map((s) => [s.sessionId, s.images]))
  const weight = (group: string[]) => group.reduce((n, id) => n + (imagesOf.get(id) ?? 0), 0)
  const groups = [...members.values()].map((group) => group.sort(compareText))
  groups.sort((x, y) => {
    const xHasReference = referenceSessionId !== null && x.includes(referenceSessionId)
    const yHasReference = referenceSessionId !== null && y.includes(referenceSessionId)
    if (xHasReference !== yHasReference) return xHasReference ? -1 : 1
    return weight(y) - weight(x) || compareText(x[0]!, y[0]!)
  })
  return groups
}

/** The sessions {@link PairListStats.isolatedSessions} means: those outside the first group, and it too when it is one session alone. */
function isolatedFrom(groups: readonly string[][]): string[] {
  const sessionCount = groups.reduce((n, group) => n + group.length, 0)
  if (sessionCount < 2) return []
  const [main, ...rest] = groups
  return [...(main!.length === 1 ? main! : []), ...rest.flat()].sort(compareText)
}

/** The text `--match_list_path` reads: one `name name` pair per line. Empty for no pairs. */
export function formatMatchList(pairs: readonly Pick<ImagePair, 'a' | 'b'>[]): string {
  return pairs.map((pair) => `${pair.a} ${pair.b}\n`).join('')
}

// ─── Choosing how to match ───────────────────────────────────────────────────

export type MatchingRefusal = PairListRefusal | 'no-cross-session-overlap'

export type MatchingPlan =
  /** Match these pairs only. */
  | { kind: 'pairs'; pairs: ImagePair[]; stats: PairListStats }
  /** Match every image with every other; `why` says why the pair list was not enough. */
  | { kind: 'exhaustive'; pairCount: number; why: string; stats: PairListStats }
  /** Match nothing: the reason is in `message`. `stats` is absent when the list could not be built. */
  | { kind: 'refused'; reason: MatchingRefusal; message: string; stats?: PairListStats }

/**
 * How a solve over these images should match them.
 *
 * Pairs when the list ties every session to the group that matters ({@link PairListStats.groups}); otherwise
 * exhaustive matching when the image count allows it ({@link exhaustiveMatchingVerdict}); otherwise a refusal that says
 * both things: which sessions the poses could not tie to the others, and why matching everything is not an option. A
 * single session needs no cross-session pair.
 */
export function planMatching(images: readonly PairImage[], options: PairListOptions = {}): MatchingPlan {
  const built = buildPairList(images, options)
  if (!built.ok) return { kind: 'refused', reason: built.reason, message: built.message }
  const { stats } = built
  if (stats.isolatedSessions.length === 0) return { kind: 'pairs', pairs: built.pairs, stats }

  const { maxDistanceM, maxAngleDeg } = resolveOptions(options)
  // Say which it is. A session with no frame posed in the Place frame at all (no calibration, or none in the epoch the
  // calibration holds for) has nothing to gate on: not the same as being posed far from the others, and not the same as
  // being tied to some sessions and not to the ones that matter.
  const posedOf = new Map(stats.sessions.map((session) => [session.sessionId, session.posed]))
  const partnersOf = new Map(stats.sessions.map((session) => [session.sessionId, session.crossPartners.length]))
  const unposed = stats.isolatedSessions.filter((id) => posedOf.get(id) === 0)
  const apart = stats.isolatedSessions.filter((id) => posedOf.get(id) !== 0 && partnersOf.get(id) === 0)
  const [main = [], ...others] = stats.groups
  const cut = others.filter((group) => group.length > 1)
  const causes = [
    ...(unposed.length > 0 ? [`nothing places a frame of ${unposed.join(', ')} in the Place frame`] : []),
    ...(apart.length > 0
      ? [`no frame of ${apart.join(', ')} is within ${maxDistanceM} m and ${maxAngleDeg} degrees of another session's by its poses`]
      : []),
    ...cut.map((group) => `the poses tie ${group.join(', ')} to each other and not to ${main.join(', ')}`),
  ]
  const nothingNear = causes.join(', and ').replace(/^./, (c) => c.toUpperCase())
  const verdict = exhaustiveMatchingVerdict(stats.imageCount)
  if (verdict.allowed) {
    return {
      kind: 'exhaustive',
      pairCount: verdict.pairCount,
      why: `${nothingNear}, so every pair is matched instead.`,
      stats,
    }
  }
  return {
    kind: 'refused',
    reason: 'no-cross-session-overlap',
    message: `${nothingNear}, so no pair would tie ${stats.isolatedSessions.length === 1 ? 'it' : 'them'} to the others. ${verdict.reason}`,
    stats,
  }
}
