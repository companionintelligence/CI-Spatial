/**
 * Frame generations: what it means to replace a Place's reference, and the words both halves use for it
 * (ADR 0011).
 *
 * A Place keeps one durable reference, its frame (`ProjectSpatialFrame`). A frame is immutable once it is
 * written: changing the reference is a new frame, a new generation with a new `frameId` that the capture client
 * mints (`newFrameId`), and the server keeps what the Place held before it in `Project.frameHistory`. A scan
 * names the generation it was measured against (`ScanCalibration.frameId`, surfaced as
 * `ScanManifest.calibrationFrameId`), so a scan of an earlier generation can be told from a scan of the current
 * one and listed as such instead of standing in the Place as if nothing had changed.
 *
 * This file is imported by the server (`server/place_frames.ts`, `server/wp-a-projects.ts`) and is meant for the
 * browser's replace flow as well, so it has no Deno or DOM reference (ADR 0002). It holds the rules that must be
 * the same on both sides: which writes are a new generation, what a replacing write has to say about itself, how
 * the history is kept, which scans are in a Place frame at all, and the shape of the answers the routes give.
 *
 * ## Unknown generations
 *
 * Every frame and scan written before ids existed has none. That is an unknown generation, and it reads as
 * neutral ("frame not recorded"): it is never a different frame. Only two known ids that differ say "previous
 * reference". Two frames that both have no id are told apart, when one is written over the other
 * (`classifyFrameWrite`), by their `createdAt` alone, which is how the server has always told two calibrations
 * apart, so a writer that predates ids keeps working against a Place that has none; and, when two Places are put
 * together (`sameFrameGeneration`), by their record, apart from the photos and names that go with the points.
 */
import type { FrameHistoryEntry, FrameReplaceReason, ProjectSpatialFrame } from './types.ts'
import { isFrameId, sameSpatialFrame } from './spatial-frame.ts'
import { newArRunId, type RunIdRandomSource } from '../shared/ar-run-id.ts'

// Compile-time checks, types only: the list of reasons is exactly the union the schema declares.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type MustBe<T extends true> = T

/**
 * The reasons a write may give for replacing a Place's frame, in the order the type declares them. `'reset'`
 * (the person wipes the reference and starts again) is deferred: nothing offers it yet.
 */
export const FRAME_REPLACE_REASONS = ['override', 'upgrade', 'merge'] as const satisfies readonly FrameReplaceReason[]
export type FrameReplaceReasonsMatchTheType = MustBe<Equal<(typeof FRAME_REPLACE_REASONS)[number], FrameReplaceReason>>

export function isFrameReplaceReason(value: unknown): value is FrameReplaceReason {
  return typeof value === 'string' && (FRAME_REPLACE_REASONS as readonly string[]).includes(value)
}

/**
 * How many replaced frames `Project.frameHistory` keeps: the newest, and the oldest drop off. **Adopted, not
 * measured (ADR 0005 rule 5):** the design's figure (D4, "history retention (20)"), enough to list every
 * generation a Place is likely to have had and small enough that a Place record stays a few KB. Revisit when a
 * Place is seen to have more generations than this with scans still on the oldest.
 */
export const FRAME_HISTORY_LIMIT = 20

/**
 * What a write that replaces a held frame says about itself: the id of the frame it replaces (null when that
 * frame has none: an unknown generation) and why. Sent as `replaces` in the body of
 * `PUT /projects/:id/spatial-frame`.
 */
export interface FrameReplaces {
  frameId: string | null
  reason: FrameReplaceReason
}

/**
 * The `replaces` of a write body, checked. An absent `frameId` is read as null, which is what a client
 * that holds a frame with no id means. Anything else that is not a frame id, a reason outside
 * `FRAME_REPLACE_REASONS`, or a value that is not an object is refused with the sentence to answer 400 with.
 */
export function parseFrameReplaces(value: unknown): { ok: true; replaces: FrameReplaces } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'replaces must be an object with the frameId it replaces and a reason' }
  }
  const { frameId, reason } = value as { frameId?: unknown; reason?: unknown }
  if (!isFrameReplaceReason(reason)) {
    return { ok: false, error: `replaces.reason must be ${FRAME_REPLACE_REASONS.join(', ')}` }
  }
  if (frameId !== undefined && frameId !== null && !isFrameId(frameId)) {
    return { ok: false, error: 'replaces.frameId must be the id of the frame being replaced, or null when it has none' }
  }
  return { ok: true, replaces: { frameId: frameId ?? null, reason } }
}

/** The id of a frame, or null when it has none or what it holds is not an id. An unknown generation. */
export function frameIdOf(frame: unknown): string | null {
  const id = (frame as { frameId?: unknown } | null | undefined)?.frameId
  return isFrameId(id) ? id : null
}

function createdAtOf(frame: unknown): string | null {
  const at = (frame as { createdAt?: unknown } | null | undefined)?.createdAt
  return typeof at === 'string' ? at : null
}

/**
 * What a write of `next` is, against the frame the Place holds (`held`, or none):
 *
 *  - `'first'`: the Place holds none.
 *  - `'same-generation'`: the held frame written again. The ids are the same, or neither has one and they
 *    share a `createdAt`: the one calibration, saved a second time in another form (its photo records
 *    attached). Not a replacement.
 *  - `'new-generation'`: another reference. The ids differ, and an absent id differs from a present one: a
 *    write that has an id cannot be told to be the same frame as one that has none, nor the other way round.
 *    This is the write that has to say what it replaces.
 *  - `'legacy-replacement'`: neither has an id and they differ in `createdAt`. Two calibrations with nothing to
 *    name them, which is what every writer did before ids: it stays allowed, and records nothing unless the
 *    writer says what it replaces.
 */
export type FrameWriteKind = 'first' | 'same-generation' | 'new-generation' | 'legacy-replacement'

export function classifyFrameWrite(held: unknown, next: unknown): FrameWriteKind {
  if (held === undefined || held === null) return 'first'
  const heldId = frameIdOf(held)
  const nextId = frameIdOf(next)
  if (heldId !== null || nextId !== null) return heldId === nextId ? 'same-generation' : 'new-generation'
  return createdAtOf(held) === createdAtOf(next) ? 'same-generation' : 'legacy-replacement'
}

/**
 * The parts of a frame that may change inside one generation: the photos and the names that go with the points
 * (`referencePhotos`, `pointLabels`, and a check point's `photo` and `label`). They are what a frame gains after
 * it is first saved, when the photos have been stored and their records attached, and none of them is an input
 * to the frame.
 */
const DISPLAY_KEYS = ['referencePhotos', 'pointLabels'] as const
const CHECK_POINT_DISPLAY_KEYS = ['photo', 'label'] as const

function withoutDisplayParts(frame: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(frame as Record<string, unknown>) }
  for (const key of DISPLAY_KEYS) delete copy[key]
  if (Array.isArray(copy['checkPoints'])) {
    copy['checkPoints'] = copy['checkPoints'].map((point: unknown) => {
      const stripped: Record<string, unknown> = { ...(point as Record<string, unknown>) }
      for (const key of CHECK_POINT_DISPLAY_KEYS) delete stripped[key]
      return stripped
    })
  }
  return copy
}

/**
 * Whether two frames are the same reference: every field the same except the photos and names that go with the
 * points. A frame id names one reference, so a write that reuses the id of the held frame must be this frame
 * again; anything else under the same id is a client that reused an id for a frame it changed.
 */
export function sameFrameReference(a: unknown, b: unknown): boolean {
  return sameSpatialFrame(withoutDisplayParts(a), withoutDisplayParts(b))
}

/**
 * Whether two frames are the same generation of a reference: both have the same id, or neither has one and they
 * are the same reference (`sameFrameReference`: the photos and names that go with the points are not compared). A
 * frame with an id never equals one without. Used where two Places are put together (a merge, a scan moved to
 * another Place): their scans are in one frame only when this is true.
 *
 * The photos are left out on purpose. A Place that takes the frame of another keeps a copy whose photo records
 * name the files of its own folder (`copyFramePhotos`), and a frame written before ids has nothing else to be
 * told by: comparing the whole record would call the copy another frame, and refuse the second scan of the
 * Place it was copied from.
 */
export function sameFrameGeneration(a: unknown, b: unknown): boolean {
  const idA = frameIdOf(a)
  const idB = frameIdOf(b)
  if (idA !== null || idB !== null) return idA === idB
  return sameFrameReference(a, b)
}

/**
 * The record `Project.frameHistory` keeps of a frame that has just been replaced, built from that frame.
 * `supersededAt` is the time of the write that replaced it. The frame may be one an older build wrote, of a
 * method this build no longer knows: the entry says what the frame says, and nothing is invented for what it
 * does not (no separation reads as null, no usable time as an empty text).
 */
export function frameHistoryEntry(replaced: unknown, reason: FrameReplaceReason, supersededAtMs: number): FrameHistoryEntry {
  const frame = (replaced ?? {}) as { method?: unknown; separationM?: unknown }
  return {
    frameId: frameIdOf(replaced),
    createdAt: createdAtOf(replaced) ?? '',
    method: (typeof frame.method === 'string' ? frame.method : '') as ProjectSpatialFrame['method'],
    separationM: typeof frame.separationM === 'number' && Number.isFinite(frame.separationM) ? frame.separationM : null,
    supersededAt: new Date(supersededAtMs).toISOString(),
    reason,
  }
}

/**
 * `history` with `entry` added at the end, keeping the newest `FRAME_HISTORY_LIMIT`. A stored value that is not
 * a list is read as an empty history rather than thrown on: the registry is a file people have edited.
 */
export function appendFrameHistory(history: unknown, entry: FrameHistoryEntry): FrameHistoryEntry[] {
  const kept = Array.isArray(history) ? (history as FrameHistoryEntry[]) : []
  return [...kept, entry].slice(-FRAME_HISTORY_LIMIT)
}

/** What names a frame in a history: its id, or when it has none the time it was made and its method. */
function historyKey(entry: FrameHistoryEntry): string {
  return entry.frameId !== null ? `id:${entry.frameId}` : `none:${entry.createdAt}:${entry.method}`
}

/**
 * `history` with the frames another Place held joined to it, for a Place that has taken in scans of those
 * frames (a merge, a scan moved in with the flag): so a scan of one of them can be described, and its photos
 * served, by the Place it is in now. A frame that is already described is described once (the row the history
 * has stays, whatever `entries` say of it). The result is oldest first by `supersededAt`, the way every history
 * is read, and keeps the newest `FRAME_HISTORY_LIMIT`.
 */
export function joinFrameHistory(history: unknown, entries: readonly FrameHistoryEntry[]): FrameHistoryEntry[] {
  const joined = Array.isArray(history) ? [...(history as FrameHistoryEntry[])] : []
  const described = new Set(joined.map(historyKey))
  for (const entry of entries) {
    const key = historyKey(entry)
    if (described.has(key)) continue
    described.add(key)
    joined.push(entry)
  }
  // `sort` is stable, and an ISO time orders as text: a row whose time is no time stays where it is among its neighbours.
  joined.sort((a, b) => (a.supersededAt < b.supersededAt ? -1 : a.supersededAt > b.supersededAt ? 1 : 0))
  return joined.slice(-FRAME_HISTORY_LIMIT)
}

/**
 * Whether a scan was measured in a Place frame: calibrated with the two-point method, which is the one tier
 * whose `sessionToProject` puts it in the frame of the Place as a generation (it can carry a `frameId`).
 * False for a scan that was never calibrated, for a one-point scan (its frame is the compass-aligned frame of
 * that one tap, with no generation), and for a known-distance scan (its matrix carries the camera solve's own
 * coordinates: it fixes a size, not where the scan stands in the Place). The scan list says "not in Place
 * frame" for these (D6), and Thing matching leaves them out (`server/thing_match.ts`), since a position that is
 * not in the Place frame cannot be compared with one that is.
 */
export function isInPlaceFrame(scan: { calibrationMethod?: unknown; calibrationStatus?: unknown }): boolean {
  return scan.calibrationMethod === 'two-point-ground' && scan.calibrationStatus !== 'uncalibrated'
}

/**
 * A fresh frame id, minted by the capture client for the frame it is about to write: a UUID, or on a page with
 * no `randomUUID` the time and random bytes, as an AR run's id is (`newArRunId`, which this is: the same
 * source of ids, the same fallback). Either shape is a valid frame id (`isFrameId`): letters, digits and
 * hyphens, well under the length limit.
 */
export function newFrameId(source?: RunIdRandomSource): string {
  return newArRunId(source)
}

// ── What the routes answer ───────────────────────────────────────────────────────────────────────

/**
 * Why `PUT /projects/:id/spatial-frame` answered 409 with the frame the Place holds, when the revision matched
 * and the write still could not be applied. The same body shape as the stale-revision conflict, with `code`
 * naming the reason, so a client that only knows that conflict adopts the held frame and shows the sentence.
 *
 *  - `'replaces-required'`: the write is another generation (or has no id where the held frame has one) and
 *    named nothing it replaces.
 *  - `'replaces-mismatch'`: it names a frame other than the one the Place holds.
 *  - `'frame-id-reused'`: it carries the id of the held frame on a frame that is not that frame.
 */
export type FrameWriteRefusalCode = 'replaces-required' | 'replaces-mismatch' | 'frame-id-reused'

/** The code `POST /projects/:id/merge` and `PATCH /projects/:id/scans/:scanId` answer 409 with. */
export const FRAME_MISMATCH_CODE = 'frame-mismatch'

/** What a frame is called in an answer about two Places or a Place and a scan: enough to tell them apart. */
export interface FrameSummary {
  frameId: string | null
  createdAt: string | null
  method: string | null
}

/**
 * The 409 body of a merge or a scan move that would put scans into a frame they were not measured in.
 * `error` is a sentence for a person, so a client that does not know `code` can still show it. Passing
 * `acceptFrameMismatch: true` in the request body does the move anyway.
 */
export interface FrameMismatchBody {
  code: typeof FRAME_MISMATCH_CODE
  error: string
  /** The frame of the Place the scans would join: null when it holds none. */
  target: FrameSummary | null
  /** The frame the scans were measured against: null when it is not known. */
  source: FrameSummary | null
  /** How many scans the request would move. */
  scans: number
}

/**
 * What a merge or a moved scan says, beside `ok`, when what was made of the scans (their patches, comments and finished
 * jobs: ADR 0011, decision 7) did not all arrive with them. Each field is present only when it is more than zero, and
 * the answer carries no `handOver` at all when both are, so a client that does not know it reads the answers it always did.
 *
 *  - `pending`: scans whose records have not reached the world of their new Place yet, because that world was busy or
 *    could not be read. They are still in the world they left, with every record, and are handed over by themselves as
 *    soon as that world allows it (and by the next read of the old one).
 *  - `placementsKept`: placements set by hand that stay in the world they were made in. A scan placed by the origin of
 *    its world (GPS or the grid) has no placement that means the same in another world, so what was set by hand against
 *    that origin is not carried; it is kept, not destroyed, and the scan sits where its own record puts it in its new Place.
 */
export interface HandOverReport {
  pending?: number
  placementsKept?: number
}

/**
 * How many of a Place's stored scans are in each frame, counted from the scans' own records. Every scan of the
 * Place is in exactly one of the three groups, so `scanCount` is their sum.
 */
export interface ScanFrameCounts {
  scanCount: number
  /** Two-point scans whose record names the frame they were measured against, by that frame's id. */
  scansByFrame: Record<string, number>
  /** Two-point scans whose record names none: an unknown generation. */
  unrecordedScans: number
  /** Scans that are not in a Place frame: never calibrated, one-point, known-distance (`isInPlaceFrame`). */
  notInFrameScans: number
}

/**
 * The answer of `GET /projects/:id/frame-status`: the Place's current frame and revision, how many scans are in
 * each frame, and the frames it held before.
 */
export interface FrameStatus extends ScanFrameCounts {
  projectId: string
  /** The Place's current frame, or null when it holds none. */
  frame: ProjectSpatialFrame | null
  /** The current frame's id: null when there is no frame or it has none. */
  frameId: string | null
  /** The frame revision (`placeFrameRevision`): 0 for a Place that was never calibrated. */
  revision: number
  /**
   * How many scans a replacement of the current frame would leave in a previous reference: the scans measured
   * against it. For a frame with an id that is `scansByFrame[frameId]`. For a two-point frame with none it is
   * `unrecordedScans`: the scans that predate ids are the ones that were measured against it, as far as
   * anything can say. For no frame, and for a one-point frame, it is 0.
   */
  scansOnCurrentFrame: number
  /** The frames the Place held before the current one, oldest first, at most `FRAME_HISTORY_LIMIT`. */
  history: FrameHistoryEntry[]
}

/** The path of a Place's frame status. */
export function frameStatusPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/frame-status`
}
