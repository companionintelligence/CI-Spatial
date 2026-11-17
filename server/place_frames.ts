/**
 * The server's decisions about a Place's frame generations (ADR 0011): whether a write may replace the frame
 * the Place holds, what a merge or a moved scan does when the frames differ, how a Place's scans are counted
 * by frame, and the sentences the answers carry.
 *
 * Pure, with no Deno API and no file access, for the reason `server/calibration_fields.ts` is its own module:
 * `server/main.ts` cannot be imported by a test without starting the server. `applySpatialFrameWrite`
 * (server/wp-a-projects.ts) and the routes in `server/main.ts` call these; tests/unit/deno/frame_generations.test.ts
 * holds them. The rules every writer shares (which write is another generation, the history's bound, which
 * scans are in a Place frame) are in src/world/frame-generations.ts, which the browser imports too.
 */
import type { FrameHistoryEntry, Project, ProjectSpatialFrame } from '../src/world/types.ts'
import {
  classifyFrameWrite,
  FRAME_MISMATCH_CODE,
  frameHistoryEntry,
  frameIdOf,
  type FrameMismatchBody,
  type FrameReplaces,
  type FrameStatus,
  type FrameSummary,
  type FrameWriteRefusalCode,
  isInPlaceFrame,
  sameFrameGeneration,
  sameFrameReference,
  type ScanFrameCounts,
} from '../src/world/frame-generations.ts'
import { isFrameId, placeFrameRevision } from '../src/world/spatial-frame.ts'
import { calibrationFromMeta } from './calibration_fields.ts'

/** The frame a Place holds, or null. A stored `null` is none. */
export function heldFrame(place: Pick<Project, 'spatialFrame'> | null | undefined): ProjectSpatialFrame | null {
  const frame = place?.spatialFrame
  return frame === undefined || frame === null ? null : frame
}

/** The ids of the frames a history describes. A stored value that is not a list describes none. */
function historyFrameIds(history: unknown): Set<string> {
  const ids = new Set<string>()
  for (const entry of Array.isArray(history) ? history : []) {
    const id = (entry as { frameId?: unknown } | null)?.frameId
    if (isFrameId(id)) ids.add(id)
  }
  return ids
}

/** The ids of the frames a Place holds or held: the current frame's, and the history's. */
export function knownFrameIds(place: Pick<Project, 'spatialFrame' | 'frameHistory'>): Set<string> {
  const ids = historyFrameIds(place.frameHistory)
  const current = frameIdOf(heldFrame(place))
  if (current !== null) ids.add(current)
  return ids
}

// ── The replace rule ─────────────────────────────────────────────────────────────────────────────

export type ReplacementDecision =
  | { ok: true; entry: FrameHistoryEntry | null }
  | { ok: false; code: FrameWriteRefusalCode; error: string }

const REFUSALS: Record<FrameWriteRefusalCode, string> = {
  'replaces-required': 'This Place already has a saved reference, so a new one has to say which it replaces and why.',
  'replaces-mismatch': 'The reference this write replaces is not the one this Place holds now.',
  'frame-id-reused': 'A reference id names one reference. This write gives an id this Place has already used to a different one.',
}

function refuse(code: FrameWriteRefusalCode): ReplacementDecision {
  return { ok: false, code, error: REFUSALS[code] }
}

/**
 * Whether `next` may be stored over the frame `held`, once the revision has matched, and the history entry to
 * append when it replaces one. The Place holds a frame: a first write has nothing to decide.
 *
 *  - The same generation written again (see `classifyFrameWrite`) is stored, and records nothing, as long as the
 *    frame is the same reference. Under a frame id that is held, anything else is `'frame-id-reused'`.
 *  - Another generation must not take an id the Place has used before: `history`, the frames it held, names them,
 *    and an id that is in it is `'frame-id-reused'`. Scans measured against the earlier frame carry that id, and under
 *    this one they would read as scans of the current frame.
 *  - Another generation must carry `replaces`: without it `'replaces-required'`, and with a `replaces.frameId`
 *    that is not the held frame's id (null for a frame that has none) `'replaces-mismatch'`. A write that
 *    passes appends the replaced frame to the history, with the writer's reason.
 *  - Two calibrations that neither have an id are what every writer sent before ids existed, and are stored as
 *    they always were; when the writer does say what it replaces, that is checked and recorded like any other.
 *
 * A `replaces` on a write that replaces nothing is ignored.
 */
export function decideReplacement(
  held: ProjectSpatialFrame,
  next: ProjectSpatialFrame,
  replaces: FrameReplaces | null,
  nowMs: number,
  history: unknown = [],
): ReplacementDecision {
  const kind = classifyFrameWrite(held, next)
  if (kind === 'same-generation') {
    if (frameIdOf(held) !== null && !sameFrameReference(held, next)) return refuse('frame-id-reused')
    return { ok: true, entry: null }
  }
  if (kind === 'first') return { ok: true, entry: null }
  const nextId = frameIdOf(next)
  if (nextId !== null && historyFrameIds(history).has(nextId)) return refuse('frame-id-reused')
  if (replaces === null) return kind === 'legacy-replacement' ? { ok: true, entry: null } : refuse('replaces-required')
  if (replaces.frameId !== frameIdOf(held)) return refuse('replaces-mismatch')
  return { ok: true, entry: frameHistoryEntry(held, replaces.reason, nowMs) }
}

// ── Counting a Place's scans by frame ────────────────────────────────────────────────────────────

/**
 * How a Place's scans split by the frame they were measured against, from their sidecars (the metadata the
 * server stores for each scan, with the session record merged in: what `listStoredScans` returns). Each is read
 * as the scan list reads it (`calibrationFromMeta`), so the counts and the chips agree.
 */
export function tallyScansByFrame(metas: ReadonlyArray<Record<string, unknown>>): ScanFrameCounts {
  const byFrame = new Map<string, number>()
  let unrecordedScans = 0
  let notInFrameScans = 0
  for (const meta of metas) {
    const calibration = calibrationFromMeta(meta)
    if (!isInPlaceFrame(calibration)) {
      notInFrameScans += 1
    } else if (calibration.calibrationFrameId === undefined) {
      unrecordedScans += 1
    } else {
      byFrame.set(calibration.calibrationFrameId, (byFrame.get(calibration.calibrationFrameId) ?? 0) + 1)
    }
  }
  // Built with fromEntries, so an id that reads as a prototype key is still just a key.
  return { scanCount: metas.length, scansByFrame: Object.fromEntries(byFrame), unrecordedScans, notInFrameScans }
}

/** What `GET /projects/:id/frame-status` answers for a Place, given the counts of its scans. */
export function frameStatusOf(place: Project, counts: ScanFrameCounts): FrameStatus {
  const frame = heldFrame(place)
  const frameId = frameIdOf(frame)
  let scansOnCurrentFrame = 0
  if (frame !== null && frameId !== null) {
    scansOnCurrentFrame = Object.hasOwn(counts.scansByFrame, frameId) ? counts.scansByFrame[frameId]! : 0
  } else if (frame !== null && frame.method === 'two-point-ground') {
    scansOnCurrentFrame = counts.unrecordedScans
  }
  return {
    projectId: place.projectId,
    frame,
    frameId,
    revision: placeFrameRevision(place),
    ...counts,
    scansOnCurrentFrame,
    history: Array.isArray(place.frameHistory) ? place.frameHistory : [],
  }
}

// ── Merge and a moved scan ───────────────────────────────────────────────────────────────────────

/**
 * What putting scans into a Place does about frames.
 *
 *  - `'agree'`: nothing to reconcile: the scans are in no frame, the Place they come from holds none, or both
 *    hold the same generation.
 *  - `'copy'`: the Place they join holds no frame, and the scans are measured against `frame`, so the Place takes
 *    it: its revision goes up by one, and its photos are copied (`copyFramePhotos`, server/project_media.ts).
 *  - `'mismatch'`: the Place holds a frame the scans were not measured against. The request is refused with 409
 *    unless it says `acceptFrameMismatch`.
 */
export type FrameMoveDecision =
  | { kind: 'agree' }
  | { kind: 'copy'; frame: ProjectSpatialFrame }
  | { kind: 'mismatch'; target: FrameSummary; source: FrameSummary | null }

/** A frame as an answer names it. */
export function summariseFrame(frame: ProjectSpatialFrame | null): FrameSummary | null {
  if (frame === null) return null
  const createdAt = (frame as { createdAt?: unknown }).createdAt
  const method = (frame as { method?: unknown }).method
  return {
    frameId: frameIdOf(frame),
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    method: typeof method === 'string' ? method : null,
  }
}

/** Merging `source` into `target`: the scans of `source` come with the frame `source` holds. */
export function decideMergeFrames(target: Project, source: Project): FrameMoveDecision {
  const sourceFrame = heldFrame(source)
  if (sourceFrame === null) return { kind: 'agree' }
  const targetFrame = heldFrame(target)
  if (targetFrame === null) return { kind: 'copy', frame: sourceFrame }
  if (sameFrameGeneration(targetFrame, sourceFrame)) return { kind: 'agree' }
  return { kind: 'mismatch', target: summariseFrame(targetFrame)!, source: summariseFrame(sourceFrame) }
}

/** What a stored scan says about the frame it was measured against: the fields `decideReassignFrames` reads. */
export interface ScanFrameFacts {
  /** `ScanManifest.calibrationMethod`. */
  calibrationMethod?: unknown
  /** `ScanManifest.calibrationStatus`. */
  calibrationStatus?: unknown
  /** `ScanManifest.calibrationFrameId`: absent for an unknown generation. */
  calibrationFrameId?: string
}

/**
 * Moving one scan into `target`, from the Place it is filed under now (`from`, null when that Place is gone or the
 * scan has none). Only a scan in a Place frame (`isInPlaceFrame`) has a frame to disagree about: the others are
 * placed by GPS or the grid, and move freely.
 *
 * When the target holds a frame, the scan agrees with it if it names that frame's id; a scan that names none (it
 * predates ids) agrees when the Place it comes from holds the same generation as the target, which is the only
 * thing left to compare. When the target holds none, there is nothing to disagree with, and it takes the frame
 * the scan was measured against when the source Place holds it.
 */
export function decideReassignFrames(scan: ScanFrameFacts, from: Project | null, target: Project): FrameMoveDecision {
  if (!isInPlaceFrame(scan)) return { kind: 'agree' }
  if (from !== null && from.projectId === target.projectId) return { kind: 'agree' }
  const scanFrameId = scan.calibrationFrameId ?? null
  const fromFrame = heldFrame(from)
  const targetFrame = heldFrame(target)
  if (targetFrame === null) {
    if (fromFrame !== null && frameIdOf(fromFrame) === scanFrameId) return { kind: 'copy', frame: fromFrame }
    return { kind: 'agree' }
  }
  const agrees = scanFrameId !== null
    ? frameIdOf(targetFrame) === scanFrameId
    : fromFrame !== null && sameFrameGeneration(fromFrame, targetFrame)
  if (agrees) return { kind: 'agree' }
  // What the scan was measured against: the frame the Place it comes from holds, when that is the one it names
  // (or it names none), and otherwise just the id it names.
  const onFromFrame = fromFrame !== null && (scanFrameId === null || frameIdOf(fromFrame) === scanFrameId)
  const source = onFromFrame
    ? summariseFrame(fromFrame)
    : scanFrameId === null ? null : { frameId: scanFrameId, createdAt: null, method: null }
  return { kind: 'mismatch', target: summariseFrame(targetFrame)!, source }
}

/** The frames in a Place's history, as a list: a stored value that is not one holds none. */
function historyOf(place: Pick<Project, 'frameHistory'>): FrameHistoryEntry[] {
  return Array.isArray(place.frameHistory) ? place.frameHistory : []
}

/**
 * The frames a merge brings into the history of the Place it merges into, from the Place that goes: everything it held
 * before its current frame, and, when the merge is across frames (`includeCurrent`), the current one, superseded now by the
 * merge (`reason: 'merge'`). A frame with no id has nothing to name it in a scan, and is not described. The target's
 * history decides which of them are new (`joinFrameHistory`).
 */
export function framesBroughtByMerge(source: Project, includeCurrent: boolean, nowMs: number): FrameHistoryEntry[] {
  const entries = [...historyOf(source)]
  const current = heldFrame(source)
  if (includeCurrent && current !== null && frameIdOf(current) !== null) entries.push(frameHistoryEntry(current, 'merge', nowMs))
  return entries
}

/**
 * The frames a moved scan brings with it: the generations it names (`frameIds`), as the Place it comes from describes
 * them. A frame that Place holds now is described as superseded now, by the move (`reason: 'merge'`: the Place the scan
 * is in has taken in scans of a reference it does not hold). One it held before is described as its history does. An
 * id that Place has never had is not described: nothing is known of it.
 */
export function framesNamedByScans(source: Project | null, frameIds: ReadonlySet<string>, nowMs: number): FrameHistoryEntry[] {
  if (source === null) return []
  const entries: FrameHistoryEntry[] = []
  const current = heldFrame(source)
  for (const id of frameIds) {
    if (current !== null && frameIdOf(current) === id) {
      entries.push(frameHistoryEntry(current, 'merge', nowMs))
      continue
    }
    const before = historyOf(source).find((entry) => entry?.frameId === id)
    if (before) entries.push(before)
  }
  return entries
}

/** Longest a Place name is quoted in a sentence. **Adopted, not measured (ADR 0005 rule 5):** the New Place form stops a name at 80. */
const NAME_LIMIT = 80

/** A Place's name as a sentence quotes it: short enough that a long one cannot bury the rest. */
function quoted(name: string): string {
  const text = name.trim()
  return `"${text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT - 1)}…` : text}"`
}

/** The 409 body of a merge across frames. */
export function mergeMismatchBody(
  decision: Extract<FrameMoveDecision, { kind: 'mismatch' }>,
  target: Pick<Project, 'name'>,
  source: Pick<Project, 'name'>,
  scans: number,
): FrameMismatchBody {
  return {
    code: FRAME_MISMATCH_CODE,
    error: `${quoted(source.name)} and ${quoted(target.name)} were aligned separately, so their scans are not in the same frame. `
      + 'Merging them anyway puts the scans together without lining them up.',
    target: decision.target,
    source: decision.source,
    scans,
  }
}

/**
 * The 409 body of a scan moved across frames. The sentence says what was compared: when the frame the scan was measured
 * against is known (`decision.source`) it differs from the Place's, and when it is not known (a scan from before frame ids,
 * from a Place that holds no frame to compare it with) nothing says it is the same.
 */
export function reassignMismatchBody(
  decision: Extract<FrameMoveDecision, { kind: 'mismatch' }>,
  target: Pick<Project, 'name'>,
): FrameMismatchBody {
  const error = decision.source === null
    ? `This scan does not say which frame it was aligned in, so it may not be in the same frame as the scans in ${quoted(target.name)}. `
      + 'Moving it anyway puts it there without lining it up.'
    : `This scan was aligned separately from ${quoted(target.name)}, so it is not in the same frame as the scans there. `
      + 'Moving it anyway puts it there without lining it up.'
  return { code: FRAME_MISMATCH_CODE, error, target: decision.target, source: decision.source, scans: 1 }
}
