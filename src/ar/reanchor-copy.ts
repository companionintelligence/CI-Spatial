/**
 * What the scanner tells the person when the runtime's frame may have moved under a scan, and when they ask it to
 * check (WP-09b).
 *
 * Pure, and kept out of the flow and the banner so the words can be tested without a DOM and each claim sits beside
 * the reason it is true. The style is src/ar/alignment-status.ts: short plain words, and nothing the code did not
 * measure (ADR 0005 rule 3).
 *
 * ## What a prompt may say
 *
 * A discontinuity is the runtime telling the app that tracking was lost and came back, that its origin moved, or that
 * the camera stepped farther than a hand can (src/ar/frame-epoch.ts). It is not proof that the frame moved, so the
 * prompt says tracking was interrupted and that parts of the scan MAY be shifted, as the quality verdict's own line
 * does (src/capture/quality-monitor.ts), and never that the scan is wrong, misaligned or broken.
 *
 * ## What re-anchoring costs, and the figure that says so
 *
 * A re-anchor sets the next scan against the Place's saved points. Those points are taps (two, or three where the Place has a
 * check point), a frame that has not been compared with a second visit, so whatever error that frame has is inherited by
 * everything set against it, and the person is told so. The figure is the one the calibration card quotes for the same
 * points a moment later (`estimateSentence`, ../world/frame-fit.ts), from the same `frameUncertaintyAt` at the adopted
 * 3 cm tap noise (ADR 0005 rule 5): how far apart two scans set against the points may land `WORKING_RADIUS_M` from them,
 * 95 times in 100. It is the whole difference between two scans and not the share one frame contributes: a re-anchor
 * produces exactly two scans of one Place, so that is the figure about the outcome, and two figures for one set of points
 * seconds apart would be read as a disagreement. It is labelled an estimate.
 *
 * ## What the person is told they will be asked, and what skipping costs
 *
 * Re-anchor does not finish when the old scan is saved: the next scan is set against the Place's frame by tapping the
 * saved points again, which needs the person to be where they are. The choice says so before it is
 * made, and says what skipping the taps leaves: a scan that is not set against the Place's frame at all.
 *
 * ## While recording is held
 *
 * Nothing is added to the scan while the choice is open (./reanchor-flow.ts), and that is what a person walking on
 * would not know. The prompt says it in its own words, and the HUD says it too (`RECORDING_HELD_HINT`), because the
 * HUD's own "Not recording" line follows the runtime's tracking and not this hold.
 *
 * ## What a closure result may say
 *
 * The numbers are measurements of the check just made (src/ar/closure.ts): where the re-tap landed against the stored
 * landmark, how far the baseline turned, how far the camera walked. The limit it was judged by is named with its
 * figures, because "past the limit" with no figure is a verdict nobody can read. What the result means depends on the
 * person having tapped the same spots, which nothing here can check, so it says so: "if you tapped the same spots".
 */
import { SIGMA0_M, WORKING_RADIUS_M, estimateSentence, frameUncertaintyAt } from '../world/frame-fit.ts'
import type { ProjectSpatialFrame, ScanQualitySummary, Vec3 } from '../world/types.ts'
import { CLOSURE_YAW_FLOOR_DEG, type FrameClosureRecord } from './closure.ts'
import { storedPoints } from './constellation-flow.ts'
import { tapRefusalText, type TapRefusal } from './tap-sampling.ts'

// ── Labels ──────────────────────────────────────────────────────────────────

export const REANCHOR_LABEL = 'Re-anchor here'
export const KEEP_GOING_LABEL = 'Keep going'
export const CHECK_DRIFT_LABEL = 'Check drift'
export const CANCEL_LABEL = 'Cancel'
export const SKIP_HEADING_LABEL = 'Skip heading'
export const DONE_LABEL = 'OK'

/** The hover and assistive-technology name of the Check drift control, which the visible word alone does not explain. */
export const CHECK_DRIFT_TITLE = 'Tap the landmark again to see how far this scan has moved from where you set it'

// ── The interruption prompt ─────────────────────────────────────────────────

/**
 * The first line of the prompt: what the runtime did, as many times as it did it since the scan began, and that parts
 * of the scan may be shifted. "May", because a recovery or a resume is suspect and not measured.
 */
export function interruptionText(shifts: number): string {
  const count = Number.isFinite(shifts) ? Math.max(1, Math.floor(shifts)) : 1
  const times = count === 1 ? 'Tracking was interrupted.' : `Tracking was interrupted ${count} times.`
  return `${times} Parts of this scan may be shifted.`
}

/**
 * The points a Place's saved frame was made from, in the Place frame: the landmark, the heading marker and any check
 * point. The two-point pair by its length when the record's own points are damaged (a record from before the points were
 * kept). Null when the frame is not a two-point one or has no usable shape.
 */
export function savedPoints(frame: ProjectSpatialFrame | null | undefined): Vec3[] | null {
  if (frame?.method !== 'two-point-ground') return null
  const length = frame.separationM
  // A record whose own length is not a length is not one a figure is worked from.
  if (typeof length !== 'number' || !Number.isFinite(length) || !(length > 0)) return null
  return storedPoints(frame) ?? [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: length }]
}

/**
 * About how far apart, in metres, two scans set against the Place's saved points may land `WORKING_RADIUS_M` from them
 * (95 times in 100): the error of the saved points, which a scan set against them inherits, and the error of the taps that
 * set the scan. The figure the calibration card quotes for the same points. Null when the frame is not a two-point one or
 * its points have no usable shape.
 */
export function scanDisagreementM(frame: ProjectSpatialFrame | null | undefined): number | null {
  const points = savedPoints(frame)
  if (!points) return null
  return frameUncertaintyAt(points, SIGMA0_M, WORKING_RADIUS_M)?.position95M ?? null
}

/** How the saved points are named: by how many taps made them. */
function tapsPhrase(count: number): string {
  return count === 2 ? 'two taps' : count === 3 ? 'three taps' : `${count} taps`
}

/**
 * A distance for the person: whole centimetres below a metre, a metre to one place from there. A distance that rounds to
 * 100 cm is a metre, so the line never reads "100 cm" beside "1.0 m".
 */
export function describeDistance(metres: number): string {
  const abs = Math.abs(metres)
  const cm = Math.round(abs * 100)
  return cm >= 100 ? `${abs.toFixed(1)} m` : `${cm} cm`
}

/**
 * What a re-anchor does, what it asks of the person next, what skipping that costs, what it inherits, and what the other
 * choice leaves. The inherited error is an estimate and says so.
 */
export function reanchorDetail(frame: ProjectSpatialFrame | null | undefined): string {
  const off = scanDisagreementM(frame)
  const taps = tapsPhrase(savedPoints(frame)?.length ?? 2)
  const inherited = off === null
    ? `The saved points came from ${taps}, so the new scan inherits their error.`
    : `The saved points came from ${taps}, so the new scan inherits their error. ${estimateSentence(off)}.`
  return `Re-anchor saves this scan, then asks you to tap the saved points again to start a new one. Skip that and the new scan is not set against the Place's frame. ${inherited} Keep going leaves this scan marked for review.`
}

/** Said first in the prompt that holds recording: nothing is being added until the person chooses. */
export const RECORDING_PAUSED_TEXT = 'Recording is paused until you choose.'

/** The second part of the interruption prompt: that recording is paused, then what each choice does. */
export function interruptionDetail(frame: ProjectSpatialFrame | null | undefined): string {
  return `${RECORDING_PAUSED_TEXT} ${reanchorDetail(frame)}`
}

/**
 * What the HUD's hint line says while the choice is open, in the form of its own "Not recording" line. The runtime's
 * tracking has usually recovered by then, so without this the HUD would say nothing while nothing was being recorded.
 */
export const RECORDING_HELD_HINT = '⚠ Recording paused\n• Choose Re-anchor or Keep going'

/** The same while the scan is being saved: there are no buttons to point at yet. */
export const RECORDING_SAVING_HINT = '⚠ Recording paused\n• Saving this scan'

/**
 * The verdict the HUD's chip shows. A scan whose recording is held is not ready, whatever it holds so far: nothing is
 * being added to it and the choice about its frame is open. The scan's own verdict (the sidecar's, the editor's) is not
 * this one, and does not change.
 */
export function displayedStatus(status: ScanQualitySummary['status'], held: boolean): ScanQualitySummary['status'] {
  return held && status === 'ready' ? 'needs-review' : status
}

/**
 * The status lines when a re-anchor cannot be offered, in the style of ./alignment-status.ts. The scan is marked for
 * review by the quality verdict whatever the person does, so that is what they say is the consequence. Each says why
 * there is nothing to re-anchor to, because the two are different facts: a Place with no frame, and a frame that is one
 * point, which cannot be tapped again and compared.
 */
export const NO_FRAME_WARNING = '⚠ Tracking was interrupted\n• No saved frame to re-anchor to. Scan marked for review'
export const ONE_POINT_FRAME_WARNING = '⚠ Tracking was interrupted\n• Saved frame is one point: nothing to re-anchor to. Scan marked for review'

/** The status line for the frame a re-anchor cannot be offered against: none at all, or one point. */
export function cannotReanchorWarning(frame: ProjectSpatialFrame | null | undefined): string {
  return frame?.method === 'ground-tap-compass' ? ONE_POINT_FRAME_WARNING : NO_FRAME_WARNING
}

/**
 * The status line when the calibration that made the Place's saved points ran across the interruption: the pair was
 * tapped on both sides of it, so re-anchoring to it would be measured against the very thing being warned of.
 */
export const FRAME_SET_ACROSS_SHIFT_WARNING = '⚠ Tracking was interrupted while the points were set\n• The saved points may be shifted. Scan marked for review'

/** The status line when the person asked for a split in advance (`?autosplit=1`) and the scan is being ended. */
export const AUTOSPLIT_NOTICE = '⚠ Tracking was interrupted\n• Starting a new scan'

// ── Re-anchoring ────────────────────────────────────────────────────────────

export const SAVING_TEXT = 'Saving this scan…'

/** The status line when a capture is asked for while the choice about the scan's frame is open: nothing is added until it is made. */
export const CAPTURE_HELD_TEXT = 'Choose Re-anchor or Keep going first'

/** Said when the scan could not be saved, and so nothing was ended: the person can try again or keep going. */
export const SAVE_FAILED_TEXT = 'Could not save this scan, so it was not ended. Try Re-anchor again, or keep going.'

/** Said when saving did not answer in time. It may still be on its way, so it does not say it failed; nothing was ended. */
export const SAVE_SLOW_TEXT = 'Saving is taking too long, so this scan was not ended. Try Re-anchor again, or keep going.'

// ── Checking drift ──────────────────────────────────────────────────────────

/** The label of the stored point, in quotes, for the line that asks for the tap. Empty when there is none. */
function labelled(label: string | null | undefined): string {
  const text = typeof label === 'string' ? label.trim() : ''
  return text ? ` “${text}”` : ''
}

export function tapLandmarkText(label?: string | null): string {
  return `Tap the landmark again${labelled(label)}`
}

export const TAP_LANDMARK_DETAIL = 'Aim at the spot you chose as Point A, hold still, and tap it.'

export function tapHeadingText(label?: string | null): string {
  return `Tap the heading marker${labelled(label)}`
}

/** The second line of the heading prompt: how far it is, when the stored pair says so, and that it may be skipped. */
export function tapHeadingDetail(storedSeparationM?: number | null): string {
  const far = typeof storedSeparationM === 'number' && Number.isFinite(storedSeparationM) && storedSeparationM > 0
    ? `about ${storedSeparationM.toFixed(1)} m from the landmark`
    : 'the second spot you chose'
  return `Point B, ${far}. Skip it to check the landmark alone: the turn is then not measured.`
}

export const READING_TAP_TEXT = 'Reading that spot…'

/** The line under the prompt when a tap was refused: what `sampleTap` found, in its own words. */
export function refusedTapDetail(refusal: TapRefusal): string {
  return tapRefusalText(refusal)
}

export const CHECK_UNAVAILABLE_TEXT = 'Check drift needs this scan to be calibrated against the Place first.'
export const CHECK_FAILED_TEXT = 'That check could not be worked out. Try again.'

/** A signed whole-centimetre height: "6 cm higher", "3 cm lower", or null when it rounds to nothing. */
function heightClause(dyM: number): string | null {
  const cm = Math.round(Math.abs(dyM) * 100)
  if (cm < 1) return null
  return `${cm} cm ${dyM > 0 ? 'higher' : 'lower'}`
}

/** The walk, as a figure for a person: about N m, or under a metre. */
function walkedClause(pathLengthM: number): string {
  if (!Number.isFinite(pathLengthM) || pathLengthM < 1) return 'less than 1 m of walking'
  return `about ${Math.round(pathLengthM)} m of walking`
}

/**
 * What the check measured, as one sentence. Every figure is the record's own. The heading is left out when it was not
 * tapped, and the height when it rounds to nothing.
 */
export function closureMeasurementText(record: FrameClosureRecord): string {
  const parts = [`Re-tap landed ${describeDistance(record.translationM)} from the stored landmark`]
  const height = heightClause(record.dyM)
  if (height) parts.push(height)
  if (record.yawDeg !== null) parts.push(`heading turned ${Math.abs(record.yawDeg).toFixed(1)}°`)
  return `${parts.join(', ')}, after ${walkedClause(record.pathLengthM)}.`
}

/** The limit the check was judged by, with its figures: "17 cm and 4.7°". */
function limitsClause(record: FrameClosureRecord): string {
  const distance = describeDistance(record.limits.translationM)
  return record.limits.yawDeg === null ? distance : `${distance} and ${record.limits.yawDeg.toFixed(1)}°`
}

/**
 * How far a turn of `yawDeg` about the landmark moves something `WORKING_RADIUS_M` from it, in metres: the chord, which
 * is what the arc is for a turn that small. The figure that says what a limit on the turn lets through.
 */
export function turnMovesAtRadiusM(yawDeg: number): number {
  return 2 * WORKING_RADIUS_M * Math.sin((Math.abs(yawDeg) * Math.PI) / 360)
}

/**
 * Said with a result inside the limits when the limit on the turn is wider than the product's own accuracy asks for: a
 * turn as large as the limit still moves things `WORKING_RADIUS_M` from the landmark by more than `ACCURACY_TARGET_M`,
 * so "within the limit" must not be read as "no turn". The figure is the arithmetic of the limit, not a measurement.
 */
export function wideLimitNote(yawLimitDeg: number): string {
  return `A turn that small can still move something ${WORKING_RADIUS_M} m from the landmark by about ${describeDistance(turnMovesAtRadiusM(yawLimitDeg))}.`
}

/**
 * What the measurement means, and only as much as it can: over the limit, the frame has moved IF the same spots were
 * tapped, which the code cannot know; within it, the check found nothing past its limit, which is not a claim that
 * nothing moved (the limit is the noise of a re-tap, and a shift of every tap by the same amount is invisible to it).
 * A turn is read from the direction between two points, so the closer they are the wider the limit on it (the closure's
 * own limit says how much): when that limit is wider than the least turn the check ever proposes a re-anchor for, the
 * verdict says what a turn as large as the limit would do, which is the one thing a result inside a wide limit cannot
 * say by itself.
 */
export function closureVerdictText(record: FrameClosureRecord): string {
  const limit = limitsClause(record)
  if (record.exceeded) {
    return `Past the check's limit (${limit}). If you tapped the same spots, the frame has moved since you set it.`
  }
  const yawLimit = record.limits.yawDeg
  const wide = yawLimit !== null && yawLimit > CLOSURE_YAW_FLOOR_DEG
  return `Within the check's limit (${limit}).${wide ? ` ${wideLimitNote(yawLimit)}` : ''}`
}
