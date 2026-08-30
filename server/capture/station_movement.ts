/**
 * Did the tripod actually move between the spots the operator says it did?
 *
 * `station_dome.ts` counts the `station` index the capture tool *declared*.
 * Nothing checked it, and on 2026-08-30 that gap was demonstrated on real
 * hardware: a gimbal swept the same six columns twice from a tripod that was
 * never moved, the upload declared two stations, and the capture was accepted
 * with a soft "5 spots would be better" warning. The only thing that later
 * refused it was the known-distance tier's scatter check — one deep check
 * catching what an early gate waved through, twenty minutes after the operator
 * left the room.
 *
 * This module supplies the earlier signal, from the only evidence that exists
 * at upload time (the photographs) and, once a solve has run, from the solve's
 * own published verdict.
 *
 * ── The photographic check, and why a ratio rather than a threshold ─────────
 *
 * Two sweeps from one spot are the same photographs twice. Measured on the two
 * real runs (18 frames, `/tmp/dome-real`, 32x32 mean-removed greyscale, mean
 * absolute difference in grey levels, each frame matched to its nearest
 * neighbour in the other sweep):
 *
 *   neighbouring photos WITHIN one sweep      44.3   ← the room's own contrast
 *   RUN A  two sweeps, tripod NOT moved        6.6   ratio 0.15
 *   RUN B  two sweeps, tripod moved 1.8 m     43.4   ratio 0.98
 *
 * The absolute numbers are a property of that room's texture and that camera's
 * exposure; the *ratio* is not. Dividing by the difference between neighbouring
 * photos of the same sweep makes the room calibrate the test: a scene with
 * little contrast produces small numbers on both sides of the division. That is
 * why {@link SAME_SPOT_RATIO} is a ratio, and why a scene whose own frames
 * barely differ ({@link MIN_SCENE_CONTRAST_LEVELS}) is reported as
 * *inconclusive* instead of being accused.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 *
 * It does not refuse a capture. A false "you did not move" is worse than a
 * missed one — it strands an operator who did move, with no way round the gate
 * — and this threshold is calibrated on two runs in one room. The finding is
 * published as a measurement with its numbers attached, and `station_dome.ts`
 * turns it into a warning the operator can act on while still holding the
 * tripod. The refusal is reserved for the solve's own verdict below, which is
 * geometry rather than pixels.
 *
 * Per ADR 0001 this adds no new transport and no new file: it reads the frames
 * the keyframe route already wrote, keyed by the `station` index that route
 * already carries, and the solve verdict out of the manifest the solve already
 * publishes.
 */

// The shape read back here is the one `colmap_poses.ts` declares and writes,
// rather than a second description of it that could drift (ADR 0001).
//
// `frameFingerprint` is imported for value, not type, and deliberately: it is
// the *definition* of what a manifest's `inputFingerprint` means, so the only
// way to check a published fingerprint is to recompute it with the same
// function. A second hash of the same frames written here would be a second
// definition, free to drift from the one that produced the number it is being
// compared against — which is the ADR 0001 failure this repo has already had
// twice. `colmap_poses.ts` imports nothing from this module or `station_dome`,
// so there is no cycle.
import { frameFingerprint, type StationBaseline } from '../colmap/colmap_poses.ts'

/** Edge of the square greyscale thumbnail every frame is reduced to. */
export const SIGNATURE_EDGE = 32

/**
 * Below this ratio the two sweeps are reported as looking like one spot.
 *
 * Measured: 0.15 for the un-moved pair, 0.98 for the 1.8 m pair — this sits
 * 2.3x above the first and 2.8x below the second. It is a midpoint between two
 * measurements, not a tuned constant, and two runs in one room is the whole of
 * the evidence behind it. That is precisely why the finding warns and never
 * refuses.
 */
export const SAME_SPOT_RATIO = 0.35

/**
 * A sweep whose own neighbouring photos differ by less than this has no
 * contrast to judge against — a blank wall, a dark room, a lens cap. The
 * honest answer there is "cannot tell", never "you did not move". The real
 * sweeps measured 44.3; this is a floor far below them, not a target.
 */
export const MIN_SCENE_CONTRAST_LEVELS = 6

/**
 * Decoding budget for one session. JPEG decode dominates the cost (~130 ms per
 * 1600px photo on the test box), and `readStationCoverage` is reachable from a
 * route that may be polled during a capture, so the work is bounded up front
 * rather than left to grow with the capture. Frames are sampled evenly across
 * each station's sweep, so a bigger dome is sampled more sparsely rather than
 * costing more.
 */
export const MAX_SAMPLED_FRAMES = 24

/** Stations beyond this are not sampled; comparing the first few is enough to catch a stationary rig. */
export const MAX_SAMPLED_STATIONS = 6

/** Fewer frames than this at a station and there is nothing to compare it with. */
export const MIN_FRAMES_TO_COMPARE = 2

export type SweepSeparationStatus =
  /** Compared, with a verdict for every pair of spots. */
  | 'measured'
  /** Ran, but the scene cannot support a verdict — reported, never held against the capture. */
  | 'inconclusive'
  /** Could not run: photos unreadable, or no image decoder available. */
  | 'skipped'
  /** Not attempted — fewer than two spots, or coverage summarized from JSONL alone. */
  | 'not-checked'

export interface StationPairSeparation {
  a: number
  b: number
  /**
   * Median difference, in grey levels, between each frame of one sweep and the
   * most similar frame of the other. Nearest-neighbour rather than positional
   * so it needs no matching pan grid between the two sweeps.
   */
  differenceLevels: number
  /** Median difference between neighbouring photos inside a single sweep — the room's own yardstick. */
  sceneContrastLevels: number
  /** differenceLevels ÷ sceneContrastLevels. */
  ratio: number
  verdict: 'moved' | 'same-spot-suspected'
}

export interface SweepSeparation {
  status: SweepSeparationStatus
  /** Pairs that were compared. Empty unless status is 'measured'. */
  pairs: StationPairSeparation[]
  /** Photos decoded for the comparison. */
  sampledFrames: number
  /** Why the check could not produce a verdict. Null when it did. */
  note: string | null
  /** What would make it possible. Set whenever status is 'skipped'. */
  remediation: string | null
  /** Present when a solve has already measured the spots — geometry outranks pixels. */
  solved?: SolvedSeparation
}

/** Nothing was compared, and nothing is claimed. The default everywhere. */
export const UNCHECKED_SEPARATION: SweepSeparation = {
  status: 'not-checked',
  pairs: [],
  sampledFrames: 0,
  note: null,
  remediation: null,
}

// ─── The photographic check ──────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Mean absolute difference between two signatures, in grey levels.
 *
 * Mismatched lengths are `NaN` rather than a partial comparison: two
 * signatures of different sizes are not comparable, and returning a number for
 * them would be a measurement that measured nothing.
 */
export function signatureDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return NaN
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * Reduce raw greyscale samples to a comparable signature by removing their
 * mean.
 *
 * The camera runs its own auto-exposure, so the second sweep of the same view
 * can be uniformly brighter than the first. Left in, that brightness step would
 * read as "the view changed" — the direction that hides a stationary tripod.
 * Removing the mean costs almost nothing on the real runs (43.4 vs 48.0 grey
 * levels on the moved pair, 6.6 either way on the un-moved one) and closes that
 * hole.
 */
export function normalizeSignature(samples: number[]): number[] {
  if (samples.length === 0) return []
  let sum = 0
  for (const v of samples) sum += v
  const mean = sum / samples.length
  return samples.map((v) => v - mean)
}

export interface StationSignatures {
  station: number
  /** In capture order — consecutive entries are neighbouring shots of one sweep. */
  signatures: number[][]
}

/**
 * The verdict, given signatures. Pure, so the thresholds are testable without
 * a JPEG decoder anywhere near them.
 */
export function assessSweepSeparation(stations: StationSignatures[]): SweepSeparation {
  const usable = stations.filter((s) => s.signatures.length > 0)
  const sampledFrames = usable.reduce((n, s) => n + s.signatures.length, 0)

  if (usable.length < 2) {
    return {
      ...UNCHECKED_SEPARATION,
      sampledFrames,
      note: 'fewer than two spots had readable photos, so there was nothing to compare',
    }
  }

  // The room's own yardstick: how different two neighbouring shots of a single
  // sweep are. Pooled across spots so one thin sweep cannot set it alone.
  const neighbourDistances: number[] = []
  for (const s of usable) {
    for (let i = 1; i < s.signatures.length; i += 1) {
      const d = signatureDistance(s.signatures[i - 1], s.signatures[i])
      if (Number.isFinite(d)) neighbourDistances.push(d)
    }
  }
  const sceneContrastLevels = median(neighbourDistances)

  if (!Number.isFinite(sceneContrastLevels) || neighbourDistances.length === 0) {
    return {
      ...UNCHECKED_SEPARATION,
      status: 'inconclusive',
      sampledFrames,
      note:
        `no spot contributed ${MIN_FRAMES_TO_COMPARE} comparable photos, so there is nothing to ` +
        'measure the difference between spots against',
    }
  }

  if (sceneContrastLevels < MIN_SCENE_CONTRAST_LEVELS) {
    return {
      ...UNCHECKED_SEPARATION,
      status: 'inconclusive',
      sampledFrames,
      note:
        `the photos within a single sweep differ by only ${sceneContrastLevels.toFixed(1)} of 255 ` +
        'brightness levels, so this scene is too plain to tell one viewpoint from another',
    }
  }

  const pairs: StationPairSeparation[] = []
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const left = usable[i]
      const right = usable[j]
      // Nearest-neighbour, both ways round: every frame of each sweep against
      // the most similar frame of the other. Positional pairing would need the
      // two sweeps to share a pan grid, which nothing guarantees.
      const nearest: number[] = []
      for (const sig of left.signatures) {
        const d = Math.min(...right.signatures.map((other) => signatureDistance(sig, other)))
        if (Number.isFinite(d)) nearest.push(d)
      }
      for (const sig of right.signatures) {
        const d = Math.min(...left.signatures.map((other) => signatureDistance(sig, other)))
        if (Number.isFinite(d)) nearest.push(d)
      }
      if (nearest.length === 0) continue
      const differenceLevels = median(nearest)
      const ratio = differenceLevels / sceneContrastLevels
      pairs.push({
        a: left.station,
        b: right.station,
        differenceLevels: round1(differenceLevels),
        sceneContrastLevels: round1(sceneContrastLevels),
        ratio: Math.round(ratio * 1000) / 1000,
        verdict: ratio < SAME_SPOT_RATIO ? 'same-spot-suspected' : 'moved',
      })
    }
  }

  if (pairs.length === 0) {
    return {
      ...UNCHECKED_SEPARATION,
      status: 'inconclusive',
      sampledFrames,
      note: 'no two spots produced comparable photos',
    }
  }

  return { status: 'measured', pairs, sampledFrames, note: null, remediation: null }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Greyscale signature of one encoded image, or null when it cannot be decoded.
 *
 * The decoder is imported dynamically and its failure is a null, not a throw:
 * an image library that will not load must degrade this check to `skipped`,
 * never take a capture down with it.
 */
export async function frameSignature(bytes: Uint8Array): Promise<number[] | null> {
  const Jimp = await loadJimp()
  if (!Jimp) return null
  try {
    // `fromBuffer`, not `read`: Jimp 1.x's `read` treats a Uint8Array as a URL
    // and fails with "Could not load Buffer from URL". The buffer is copied
    // only when the array is a view onto a larger one, which Deno.readFile's
    // never is.
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
    const img = await Jimp.fromBuffer(buffer)
    img.greyscale().resize({ w: SIGNATURE_EDGE, h: SIGNATURE_EDGE })
    const samples: number[] = []
    const data = img.bitmap.data
    for (let i = 0; i < SIGNATURE_EDGE * SIGNATURE_EDGE; i += 1) samples.push(data[i * 4])
    return normalizeSignature(samples)
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
type JimpModule = { fromBuffer: (input: ArrayBufferLike) => Promise<any> }
let jimpCache: JimpModule | null | undefined

async function loadJimp(): Promise<JimpModule | null> {
  if (jimpCache !== undefined) return jimpCache
  try {
    const mod = await import('jimp')
    jimpCache = (mod as unknown as { Jimp: JimpModule }).Jimp ?? null
  } catch {
    jimpCache = null
  }
  return jimpCache
}

/** Evenly spaced picks, keeping the first and last so the sweep's extremes are represented. */
export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return []
  if (items.length <= limit) return [...items]
  const out: T[] = []
  for (let i = 0; i < limit; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (limit - 1))])
  }
  return out
}

interface CacheEntry {
  /** Content hash of the photographs the finding was measured from. See {@link measureSweepSeparation}. */
  key: string
  value: SweepSeparation
}
const measurementCache = new Map<string, CacheEntry>()

/** Cached findings kept at once. Each is a few hundred bytes; this is hygiene, not a limit anyone reaches. */
const MAX_CACHED_SESSIONS = 200

/** Test seam: forget every cached measurement. */
export function clearSeparationCache(): void {
  measurementCache.clear()
}

/**
 * Measure a session's spots against each other from the photos on disk.
 *
 * Bounded ({@link MAX_SAMPLED_FRAMES}) and cached, because the coverage read
 * this hangs off is reachable from a pollable route: a poll whose sampled
 * photographs are byte-for-byte what was measured last time reuses the finding
 * instead of decoding them again. The cache key is those bytes, never their
 * filenames — see the comment at the key itself for the capture that proved
 * why.
 */
export async function measureSweepSeparation(
  sessionPath: string,
  filesByStation: Map<number, string[]>,
): Promise<SweepSeparation> {
  const stationList = [...filesByStation.entries()]
    .filter(([, files]) => files.length > 0)
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_SAMPLED_STATIONS)

  if (stationList.length < 2) {
    return { ...UNCHECKED_SEPARATION, note: 'only one spot has photos, so there is nothing to compare it with' }
  }

  const perStation = Math.max(MIN_FRAMES_TO_COMPARE, Math.floor(MAX_SAMPLED_FRAMES / stationList.length))
  const sampled = stationList.map(([station, files]) => ({ station, files: sampleEvenly(files, perStation) }))

  // ── The cache is keyed on the photographs, not on their names ─────────────
  //
  // Keying on `station:filename` was the same mistake, one layer up, as the
  // solver's reuse of `colmap-work/`: `kf-00000.jpg`…`kf-00011.jpg` is what
  // every 12-photo capture is called, so the key matched across two entirely
  // different captures and the finding was reused across the change. Measured
  // 2026-08-30 by replacing a solved session's `kf-*.jpg` with a second
  // capture's: this function kept answering `differenceLevels 6, ratio 0.135,
  // same-spot-suspected` about photographs whose own measurement, taken under a
  // fresh key, is `43.5, ratio 0.873, moved`. Same names, opposite verdicts.
  //
  // So the bytes are read first and hashed, and the *hash* is the key. The read
  // is not the cost this cache exists to avoid — JPEG decode is (~130 ms a
  // photo against ~1 ms to read and hash one) — so a poll on unchanged frames
  // still skips the expensive half, and a poll on changed frames can no longer
  // skip anything. The elapsed-time short circuit goes with it: a key that is
  // exact needs no grace period, and a grace period is precisely what would
  // hand back the previous capture's answer for the first 5 s of the next one.
  const read: Array<{ station: number; bytes: (Uint8Array | null)[] }> = []
  const keyParts: string[] = []
  for (const s of sampled) {
    const bytes: (Uint8Array | null)[] = []
    for (const file of s.files) {
      try {
        const b = await Deno.readFile(`${sessionPath}/${file}`)
        bytes.push(b)
        keyParts.push(`${s.station}:${file}:${b.byteLength}:${await sha256Hex(b)}`)
      } catch {
        bytes.push(null)
        keyParts.push(`${s.station}:${file}:missing`)
      }
    }
    read.push({ station: s.station, bytes })
  }
  const key = keyParts.join('|')
  const cached = measurementCache.get(sessionPath)
  if (cached && cached.key === key) return cached.value

  const stations: StationSignatures[] = []
  let unreadable = 0
  for (const s of read) {
    const signatures: number[][] = []
    for (const bytes of s.bytes) {
      if (!bytes) {
        unreadable += 1
        continue
      }
      const sig = await frameSignature(bytes)
      if (sig) signatures.push(sig)
      else unreadable += 1
    }
    stations.push({ station: s.station, signatures })
  }

  let value = assessSweepSeparation(stations)
  if (value.sampledFrames === 0) {
    value = {
      ...UNCHECKED_SEPARATION,
      status: 'skipped',
      note: `none of the ${unreadable} sampled photo(s) could be read as an image`,
      remediation:
        'Whether the camera really moved between spots cannot be checked from these photos; the scan will ' +
        'still run, and the result will say whether the spots came out apart.',
    }
  }
  // Bounded: one small entry per session, oldest evicted first, so a
  // long-running server that has seen thousands of captures does not keep a
  // finding for every one of them.
  if (measurementCache.size >= MAX_CACHED_SESSIONS) {
    const oldest = measurementCache.keys().next()
    if (!oldest.done) measurementCache.delete(oldest.value)
  }
  measurementCache.set(sessionPath, { key, value })
  return value
}


// ─── The solve's own verdict ─────────────────────────────────────────────────

export interface SolvedSeparation {
  /** False when no solve has reported on this exact set of frames. */
  known: boolean
  /** Only when known. */
  moved?: boolean
  /** Smallest gap the solve put between two spots, in its own units. */
  separation?: number
  /** Largest scatter of one spot's frames about that spot, same units. */
  withinSpotSpread?: number
  /** separation ÷ spread. Measured: 0.020 un-moved, 70.9 after a 1.8 m move. */
  ratio?: number
  /** What the solve judged that ratio against. */
  threshold?: number
  /** Why nothing is known — no solve, a stale one, or one that could not measure this. */
  note?: string
}

/**
 * Fallback bar for `separationRatio`, used only if a manifest carries a
 * baseline without the thresholds beside it.
 *
 * It is deliberately the same number as `colmap_poses.ts`'s
 * `DEFAULT_MIN_STATION_SEPARATION_RATIO`, and for the same reason: at a ratio
 * of 1 the gap between two spots is the size of the slop within one spot, so
 * below it the solve cannot tell the spots apart from noise. The two real runs
 * sit at 0.020 and 70.9. The published threshold is preferred whenever it is
 * there, so this never silently disagrees with the gate that produced the
 * measurement.
 */
export const SOLVED_MOVED_RATIO = 1

/** The code `colmap_poses.ts` files a spots-did-not-separate verdict under. */
const NO_BASELINE_REASON = 'no-station-baseline'

/**
 * Read what the camera solve published about the spots.
 *
 * This is the single point of coupling to the solve, and it reads exactly what
 * the solve writes: `colmap-poses.manifest.json`'s `quality.baseline`
 * ({@link StationBaseline} — `minSeparation`, `maxSpread`, `separationRatio`),
 * judged against the `minStationSeparationRatio` published beside it, and the
 * `no-station-baseline` reason code when the solve has already made the call.
 * The geometry is measured there, once, by the module that has the camera
 * centres; nothing is re-derived here (ADR 0001).
 *
 * Absent, unmeasurable (`separationRatio: null`, which is what a spot backed by
 * a single camera gives) or stale, the answer is `known: false` — so a session
 * with no solve yet is simply left to the photographic check, and nothing here
 * claims a verdict it does not have (ADR 0005 rule 3).
 *
 * The staleness guard exists because it has already bitten: on 2026-08-30 a
 * second capture landed in the first one's session directory and a re-run
 * returned the first one's answer byte for byte. A manifest describing a
 * different number of frames than the session now holds is not evidence about
 * these frames, so it is discarded rather than believed.
 */
export async function readSolvedSeparation(
  sessionPath: string,
  currentFrameCount: number,
): Promise<SolvedSeparation> {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await Deno.readTextFile(`${sessionPath}/colmap-poses.manifest.json`))
  } catch {
    return { known: false, note: 'no camera solve has run on this capture yet' }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { known: false, note: 'the solve wrote no readable result' }
  }

  const frameCount = manifest['frameCount']
  if (typeof frameCount === 'number' && frameCount !== currentFrameCount) {
    return {
      known: false,
      note:
        `the last scan result covers ${frameCount} photo(s) and this capture now holds ` +
        `${currentFrameCount}, so it does not describe these photos`,
    }
  }

  // ── Does this result describe the photographs that are here now? ──────────
  //
  // A frame count is not enough on its own, and the case that proves it is the
  // one that happened: two 12-photo captures landed in the same session
  // directory, so the counts matched exactly while the photographs did not.
  //
  // The question is answered by the photographs, because every cheaper key has
  // now been measured failing on this exact pair of captures. Filenames:
  // `kf-00000.jpg`…`kf-00011.jpg` both times. Frame count: 12 both times.
  // Sidecar mtimes: replacing a solved session's `kf-*.jpg` with a second
  // capture's leaves `keyframes.jsonl` untouched, so an mtime comparison
  // against it reported "fresh" and this function handed RUN A's geometry
  // (0.3275 apart, 3.9282 spread) back as a verdict on RUN B's photographs —
  // which then *refused* a good capture in 67 ms without COLMAP running at all.
  // A guard that watches a sidecar is not watching the photographs.
  //
  // `inputFingerprint` is the solve's own hash of the exact frames it read, so
  // recomputing it is the one key that changes precisely when the input does.
  // A manifest without one cannot prove it describes these photos, and so is
  // not believed — the same rule `runColmapPoses` applies to an unfingerprinted
  // `colmap-work/`. Being unable to answer costs nothing: the photographic
  // check above still has its say, and nothing here claims a verdict it does
  // not have (ADR 0005 rule 3).
  const publishedFingerprint = manifest['inputFingerprint']
  if (typeof publishedFingerprint !== 'string' || publishedFingerprint.length === 0) {
    return {
      known: false,
      note: 'the last scan result does not record which photos it was computed from, so it cannot be trusted here',
    }
  }
  let actual: string
  try {
    actual = await fingerprintSessionFrames(sessionPath)
  } catch {
    return { known: false, note: 'the photos in this capture could not be read to check the last scan result against them' }
  }
  if (actual !== publishedFingerprint) {
    return {
      known: false,
      note: 'the photos in this capture changed after the last scan ran, so that result is not about them',
    }
  }

  const quality = asObject(manifest['quality'])
  const baseline = asObject(quality?.['baseline']) as unknown as Partial<StationBaseline> | null
  const ratio = typeof baseline?.separationRatio === 'number' && Number.isFinite(baseline.separationRatio)
    ? baseline.separationRatio
    : null
  if (ratio === null) {
    return { known: false, note: 'the scan result does not say how far apart the spots came out' }
  }

  const thresholds = asObject(quality?.['thresholds'])
  const published = thresholds?.['minStationSeparationRatio']
  const threshold = typeof published === 'number' && Number.isFinite(published) ? published : SOLVED_MOVED_RATIO

  // The solve's own reason code wins when it is there: it is the same
  // measurement, already judged, and two gates that disagree about one number
  // are worse than one gate.
  const reasons = quality?.['reasons']
  const calledIt = Array.isArray(reasons) && reasons.includes(NO_BASELINE_REASON)

  return {
    known: true,
    moved: !calledIt && ratio >= threshold,
    separation: typeof baseline?.minSeparation === 'number' ? baseline.minSeparation : undefined,
    withinSpotSpread: typeof baseline?.maxSpread === 'number' ? baseline.maxSpread : undefined,
    ratio,
    threshold,
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * The name every keyframe COLMAP is fed carries. Kept identical to
 * `colmap_poses.ts`'s `KEYFRAME_RE`, because the fingerprint being recomputed
 * has to cover the same file set the solve hashed or the comparison is
 * meaningless.
 */
const KEYFRAME_RE = /^kf-\d+\.jpg$/

/** The solve's fingerprint of a session's keyframes, recomputed from disk. Throws if they cannot be read. */
async function fingerprintSessionFrames(sessionPath: string): Promise<string> {
  const names: string[] = []
  for await (const entry of Deno.readDir(sessionPath)) {
    if (entry.isFile && KEYFRAME_RE.test(entry.name)) names.push(entry.name)
  }
  return await frameFingerprint(sessionPath, names)
}

/** Hex SHA-256 of one photograph, for the measurement cache's content key. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
