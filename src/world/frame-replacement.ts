/**
 * What replacing a Place's reference means on the phone, and what the phone reads of the server's answers (WP-08, client
 * slice; the server's half is ADR 0011 and `src/world/frame-generations.ts`).
 *
 * A frame is immutable once written. Replacing a Place's frame is a new generation: a new `frameId`, minted here on the
 * phone when a calibration builds the frame, and a write that says which generation it replaces and why (`replaces`). The
 * server keeps what it replaced in `Project.frameHistory`. Every scan's calibration names the generation it was measured
 * against (`ScanCalibration.frameId`), so the editor can tell the scans of the current reference from the scans of an
 * earlier one.
 *
 * Pure, and imported by the browser (ADR 0002): no DOM, no Deno, no clock.
 *
 * ## One file for the phone, one for the server
 *
 * `src/world/frame-generations.ts` is the server slice's, and holds the rules both halves share: which write is a new
 * generation, how the history is kept, which scans are in a Place frame. This file is what only the phone does: it stamps a
 * finished calibration, offers the upgrade, and reads the two answers it asks for (`GET /projects/:id/frame-status` and the
 * refusal of a merge). It imports one thing from that file, `outsidePlaceFrameOf`, the statement a record makes that its scan is
 * in no frame, because the stamp and the server's counts must read it as one rule. The rest it does not import, because the two
 * slices were built apart. Three names are in both:
 * `newFrameId` and `frameIdOf` are the same function in each, and `FrameReplaces` the same shape. Where the two slices are put
 * together, the copies below are deleted and re-exported from there. `ReferenceStatus` is not that file's `FrameStatus`: that
 * is the body the server answers, and this is what the phone keeps of it.
 *
 * ## Unknown generations
 *
 * A frame written before ids existed has none, and neither has a scan calibrated against it. That is an unknown
 * generation: it reads as neutral and is never called a different frame. Only two known, different ids are different
 * frames. A one-point frame carries no id at all (the type has no field for it): a scan calibrated on that tier is not in a
 * Place frame generation.
 *
 * ## What the phone reads of the server
 *
 * Each reader below takes the body ADR 0011 gives (its "Interface for the client slice") and nothing else, and answers
 * null, or "not known", for anything it cannot read. A caller treats that as the cautious case and never as "none".
 */
import { newArRunId, type RunIdRandomSource } from '../shared/ar-run-id.ts'
import { outsidePlaceFrameOf } from './frame-generations.ts'
import { isFrameId, isFrameRevision } from './spatial-frame.ts'
import type { FrameReplaceReason, ProjectSpatialFrame, ScanCalibration } from './types.ts'

// ── Ids ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A fresh frame id: a UUID, or on a page with no `randomUUID` (an old webview) the time and random bytes, the way
 * `newArRunId` mints an AR-run id, which this reuses (ADR 0001). Both shapes are what `isFrameId` accepts, so the id is safe
 * in a URL, a file name and a local key (`<projectId>:<frameId>:<role>`).
 */
export function newFrameId(source?: RunIdRandomSource): string {
  return newArRunId(source)
}

/**
 * The generation a scan's calibration was measured against, or null when it names none: a one-point or known-distance
 * calibration, one with no id (made before ids existed), or no calibration.
 */
export function calibrationFrameIdOf(calibration: ScanCalibration | null | undefined): string | null {
  if (!calibration || calibration.method !== 'two-point-ground') return null
  return isFrameId(calibration.frameId) ? calibration.frameId : null
}

/**
 * The id of the generation a frame is, or null for an unknown one: no id, or one that is not an id. Read from any member,
 * because the server's validator accepts the field on both and a record from another build may carry it where this one never
 * writes it.
 */
export function frameIdOf(frame: ProjectSpatialFrame | null | undefined): string | null {
  if (!frame) return null
  const id = (frame as { frameId?: unknown }).frameId
  return isFrameId(id) ? id : null
}

// ── The write ────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a write says about the frame it replaces: the body field `replaces` of `PUT /projects/:id/spatial-frame`. `frameId`
 * is the id of the frame the SERVER holds and this write replaces, or null when that frame has none (a legacy one). The
 * server refuses the write unless it equals the id of the frame it holds, and records the replaced frame in
 * `Project.frameHistory` with this `reason`.
 */
export interface FrameReplaces {
  frameId: string | null
  reason: FrameReplaceReason
}

/** Whether `value` is a well formed `replaces`: what the pending-frame row is read back as, which a person's storage may have changed. */
export function isFrameReplaces(value: unknown): value is FrameReplaces {
  if (typeof value !== 'object' || value === null) return false
  const { frameId, reason } = value as { frameId?: unknown; reason?: unknown }
  return (frameId === null || isFrameId(frameId)) && (reason === 'override' || reason === 'upgrade' || reason === 'merge')
}

/** How a calibration reaches the Place's frame: as a first visit and a return visit do, or as an upgrade. */
export type GenerationMode = 'upgrade'

export interface GenerationInput {
  /**
   * The frame the Place held when the flow began, as the phone read it: the frame the calibration was compared with and the
   * one a changed frame replaces. Not the Place as it is when the flow ends, which a retry settling meanwhile may have changed.
   */
  held: ProjectSpatialFrame | null | undefined
  /** What the calibration flow produced. */
  calibration: ScanCalibration
  /** The Place's new frame, when the flow made one (a first calibration, an upgrade, a pair kept over a mismatch). */
  spatialFrame?: ProjectSpatialFrame
  /** `'upgrade'` when the person improved the reference: the flow ran as a first calibration. */
  mode?: GenerationMode
  /** The source of a new id. A test supplies its own. */
  mint?: () => string
}

export interface GenerationPlan {
  /** The calibration, naming the generation it was measured against when it has one. */
  calibration: ScanCalibration
  /** The frame to save, with its new id; absent when the Place's frame stands. */
  spatialFrame?: ProjectSpatialFrame
  /** Present when `spatialFrame` replaces a frame the Place holds. */
  replaces?: FrameReplaces
  /** The frame being replaced, as it was held: what the person is told was replaced. Absent with `replaces`. */
  superseded?: ProjectSpatialFrame
}

/** The calibration naming `frameId`. Only the two-point member has a generation to name. */
function naming(calibration: ScanCalibration, frameId: string | null): ScanCalibration {
  if (calibration.method !== 'two-point-ground' || frameId === null) return calibration
  return { ...calibration, frameId }
}

/**
 * Whether a calibration that came with no frame was measured against the frame the Place holds: the visit was compared with it and
 * matched. "No frame came back" is not that by itself. A commit whose floor check was bypassed writes none whatever else it is
 * (`mayWritePlaceFrame`, src/ar/ground-gate.ts), and then it may be a pair kept over a mismatch or "Improve this Place's
 * reference", which are in no frame: the commit says so on the record (`outsidePlaceFrame`). An improve run compares nothing with
 * the held frame (the modal runs it as a first calibration), so one that wrote no frame was not measured against it, record or no.
 */
function matchedHeldFrame(input: GenerationInput): boolean {
  return input.mode !== 'upgrade' && !outsidePlaceFrameOf(input.calibration)
}

/**
 * Stamps a finished calibration with the generation it belongs to, and works out what a changed frame replaces.
 *
 *  - The Place's frame stands (a return visit that matched): the calibration names the held frame's id, when it
 *    has one. A held frame with no id leaves it unnamed: an unknown generation.
 *  - No frame was written and the visit did not match the held one (the floor check was bypassed, so none could be written, and the
 *    pair was kept over a mismatch, or the person was improving the reference, or the Place held none): the scan is in no frame and
 *    claims none. Its calibration is returned as it is, unnamed, and says so itself (`outsidePlaceFrame`).
 *  - The flow made a two-point frame: it gets a new id, and the calibration names it. When the Place held a frame,
 *    the write replaces it, and the reason is `'upgrade'` when the person improved the reference or the held
 *    frame was a one-point one, and `'override'` otherwise: a pair kept over a mismatch.
 *  - The flow made a one-point frame (a Place with none): no id, no replacement.
 *
 * Nothing is changed in place: a frame is immutable, so the new frame is a copy and the held one is returned
 * untouched as `superseded`.
 *
 * `replaces` names what the phone held. When that frame is itself one the server never received, the write that sends this
 * one corrects it (`replacesAtServer`, ../project/frame-sync.ts): the plan has no way to know.
 */
export function planFrameGeneration(input: GenerationInput): GenerationPlan {
  const { held, calibration, spatialFrame } = input
  if (!spatialFrame) return { calibration: matchedHeldFrame(input) ? naming(calibration, frameIdOf(held)) : calibration }

  const frame: ProjectSpatialFrame = spatialFrame.method === 'two-point-ground'
    ? { ...spatialFrame, frameId: (input.mint ?? newFrameId)() }
    : spatialFrame
  const plan: GenerationPlan = { calibration: naming(calibration, frameIdOf(frame)), spatialFrame: frame }
  if (!held) return plan

  const reason: FrameReplaceReason = input.mode === 'upgrade' || held.method !== 'two-point-ground' ? 'upgrade' : 'override'
  return { ...plan, replaces: { frameId: frameIdOf(held), reason }, superseded: held }
}

// ── Offering the upgrade ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the first-calibration flow asks for a check point.
 *
 * "Improve this Place's reference" exists to give a two-point Place the check point it never had: a later visit
 * cannot add one to an existing frame, because it would be expressed through that visit's own two-point frame and
 * would freeze that visit's error into the reference. It runs the first-calibration flow as a new generation, so
 * it improves the reference only where that flow asks for the check point. It does (WP-04b: the step follows the
 * heading marker by default, `CHECK_POINT_DEFAULT_ON` in src/ar/constellation-flow.ts, and a test holds the two
 * together, because this module is below the flow and cannot import it).
 */
export const FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT = true

/**
 * Whether "Improve this Place's reference" is offered for the frame a Place holds: a two-point frame that has no
 * check point, and only when the flow it would run asks for one. A one-point frame is upgraded by the two-point
 * flow of an ordinary visit and a frame of a kind this build does not know is not offered it.
 */
export function improveOffered(
  held: ProjectSpatialFrame | null | undefined,
  asksForCheckPoint: boolean = FIRST_CALIBRATION_ASKS_FOR_CHECK_POINT,
): boolean {
  if (!asksForCheckPoint || !held || held.method !== 'two-point-ground') return false
  return !(held.checkPoints && held.checkPoints.length > 0)
}

// ── What the server says about a Place's frame ───────────────────────────────────────────────────────

/**
 * What the phone reads of `GET /projects/:id/frame-status`: the reference the server holds, and how many scans a replacement
 * would leave behind.
 */
export interface ReferenceStatus {
  /** Whether the Place holds a frame at all. */
  holdsFrame: boolean
  /** The id of the frame the Place holds, or null when it holds none or one with no id. */
  frameId: string | null
  /**
   * How many scans a replacement of the frame the Place holds would leave in a previous reference: the server's
   * `scansOnCurrentFrame`. For a frame with an id these are the scans that name it, and for a two-point frame with none the
   * scans that name no generation (made before ids existed), as far as anything can say. Null when the answer does not
   * give a count the phone can read, which is "not known" and never "none".
   */
  scansOnReference: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** An own property of `object`, so a frame id that is also the name of something every object inherits is still just a key. */
function ownCount(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
}

/**
 * How many scans a replacement would leave behind, when the answer has no `scansOnCurrentFrame` and the phone has to
 * work it out from the counts beside it: a frame with an id is the scans that name it (none of them: zero, when the
 * Place's frame is one no scan names), and a two-point frame with none is `unrecordedScans`. A one-point frame has no
 * generation for a scan to name, so none are. Null when the count the case needs is missing or not a count.
 */
function countFromParts(body: Record<string, unknown>, frame: Record<string, unknown>, frameId: string | null): number | null {
  if (frameId !== null) {
    const byFrame = body['scansByFrame']
    if (!isRecord(byFrame)) return null
    const named = ownCount(byFrame, frameId)
    if (named === undefined) return Object.values(byFrame).every(isCount) ? 0 : null
    return isCount(named) ? named : null
  }
  if (frame['method'] !== 'two-point-ground') return 0
  return isCount(body['unrecordedScans']) ? body['unrecordedScans'] : null
}

/**
 * A status body as the phone uses it, or null when it is not one: not an object, no revision, or no `frame` (an object, or
 * null for a Place that holds none). Whatever else is missing or unreadable is "not known" in the result, never zero.
 */
export function readFrameStatus(body: unknown): ReferenceStatus | null {
  if (!isRecord(body) || !isFrameRevision(body['revision'])) return null
  const frame = body['frame']
  if (frame === null) return { holdsFrame: false, frameId: null, scansOnReference: 0 }
  if (!isRecord(frame)) return null
  const frameId = isFrameId(frame['frameId']) ? frame['frameId'] : null
  const answered = body['scansOnCurrentFrame']
  return {
    holdsFrame: true,
    frameId,
    scansOnReference: isCount(answered) ? answered : countFromParts(body, frame, frameId),
  }
}

/** How many scans were made against the frame a Place holds: a count, or not known. */
export type AffectedScans =
  | {
      kind: 'known'
      count: number
      /** True when the count is of scans that name the held frame's id; false when that frame has none and these are the scans that name no generation. */
      named: boolean
    }
  | { kind: 'unknown' }

/**
 * The scans a replacement would leave behind. The held frame is the server's, from the same answer as the count: the
 * phone's own copy may be older. A Place with no frame has nothing to replace. Not known when the server's answer could not be
 * read, or has no count the phone can use.
 */
export function affectedScans(status: ReferenceStatus | null): AffectedScans {
  if (!status) return { kind: 'unknown' }
  if (!status.holdsFrame) return { kind: 'known', count: 0, named: false }
  if (status.scansOnReference === null) return { kind: 'unknown' }
  return { kind: 'known', count: status.scansOnReference, named: status.frameId !== null }
}

// ── A merge or a reassign the server refused ─────────────────────────────────────────────────────────

/** What a 409 `frame-mismatch` carries for a person: the server's sentence. */
export interface FrameMismatch {
  message: string
}

/**
 * A merge or a scan reassign across two different references is answered 409 `{ code: 'frame-mismatch', error, ... }`,
 * unless the request says `acceptFrameMismatch`. Null for any other answer, so a caller that gets one shows its own error.
 * `fallback` is the sentence when the server's body has none.
 */
export function readFrameMismatch(status: number, body: unknown, fallback: string): FrameMismatch | null {
  if (status !== 409 || !isRecord(body) || body['code'] !== 'frame-mismatch') return null
  const text = typeof body['error'] === 'string' ? body['error'] : ''
  return { message: text.trim() || fallback }
}
