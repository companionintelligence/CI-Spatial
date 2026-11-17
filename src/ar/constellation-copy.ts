/**
 * The words the constellation flow adds to the calibration card (WP-04b): the check-point step, the readout of how
 * this visit's points sit against the stored ones, and the mismatch screen for them.
 *
 * Pure and Deno-free (ADR 0002), so the sentences can be tested without a DOM and the owner can read every one in one
 * place. The shell (./project-calibration.ts) draws them and decides nothing here.
 *
 * ## What may be said
 *
 * Only what the code measured (ADR 0005 rule 3), in short plain words, in the style of ./alignment-status.ts. The
 * sentences about a comparison are the verdict's own (`ConstellationVerdict.reasons`, src/world/frame-fit.ts, whose
 * header table says what each status may claim): this file puts them on the card and adds nothing to them. It never
 * says the Place, the frame or the alignment is verified, and a comparison that passed still ends by naming what a
 * comparison of taps cannot see: that the points are the same physical spots, and, on a phone whose units are not
 * metres, that sizes in metres were not checked.
 *
 * Where a sentence quotes a figure it is the one the verdict used (`formatCm`), so the card and the status line that
 * follows it cannot disagree by a rounding.
 *
 * ## Adopted wording
 *
 * The steps ask for a check point "at least 3 m from A and 2 m off the line" because the design brief does
 * (`RECOMMENDED_CHECK_DISTANCE_M`, `RECOMMENDED_CHECK_OFFSET_M` in ../world/baseline-guidance.ts, adopted, not
 * measured: ADR 0005 rule 5). They are taken from there so the words and the guidance beside them cannot differ.
 */
import { NOT_CHECKED_METRES, NOT_CHECKED_SPOTS, formatCm } from '../world/frame-fit.ts'
import { RECOMMENDED_CHECK_DISTANCE_M, RECOMMENDED_CHECK_OFFSET_M, stepPrefix } from '../world/baseline-guidance.ts'

/** The markers the card places, by the id the shell uses. */
export type MarkerName = 'landmark' | 'heading' | 'check'

// ── The check-point step ─────────────────────────────────────────────────────────────────────────────

/**
 * The label of the fourth progress dot. It names the point as the guidance and the label field do ("Point C"): "Check" read
 * as the review that follows, which is titled "Check the alignment".
 */
export const CHECK_STEP_LABEL = 'Point C'

/** The step's title on a first calibration: the check point is optional, and recommended. */
export const CHECK_STAGE_TITLE = 'Add a check point (recommended)'

/** The step's title on a return visit to a Place that stores a check point: the visit re-taps it. */
export const CHECK_RETURN_TITLE = 'Tap the check point from last time'

/**
 * What the step asks for. `storedDistanceM` is how far the stored check point is from the landmark on a return visit,
 * and `null` on a first calibration. Neither says the check point will make the next scan line up, and neither says what a
 * check of three taps cannot know (that the points are the same physical spots: the readout says that): they say what the
 * fit does with it, which is compare the shape the three points make. `totalSteps` is what the earlier steps' counters count
 * to (`stepsInVisit`, ./constellation-flow.ts): 3 means this is the third step and is numbered as one, anything else leaves the
 * step unnumbered, because the steps before it say "of 2".
 */
export function checkStageCopy(storedDistanceM: number | null, totalSteps?: number): string {
  const numbered = totalSteps === 3
  if (storedDistanceM !== null && Number.isFinite(storedDistanceM) && storedDistanceM > 0) {
    return `${numbered ? `${stepPrefix(3, 3)}tap` : 'Tap'} point C, the check point from last time, about ` +
      `${storedDistanceM.toFixed(1)} m from the landmark. ` +
      'It lets this visit compare the shape the three points make, not only the distance between two.'
  }
  return `${numbered ? `${stepPrefix(3, 3, 'optional')}tap` : 'Optional. Tap'} a third ground feature at least ` +
    `${RECOMMENDED_CHECK_DISTANCE_M} m from point A and ${RECOMMENDED_CHECK_OFFSET_M} m off the line from A to B. ` +
    'Later visits can then compare the shape the three points make, not only the distance between two.'
}

/** The status line of the step, until the check point is tapped. */
export const CHECK_STATUS = 'Tap the ground to place the check point.'

/**
 * The card for the check-point step: its title, what it asks for and its status line. `stored` is the Place's stored check
 * point on a return visit (in the Place frame, whose origin is the landmark), or null on a first calibration.
 */
export function checkStageCard(
  stored: { x: number; z: number } | null,
  totalSteps?: number,
): { title: string; copy: string; status: string } {
  return {
    title: stored ? CHECK_RETURN_TITLE : CHECK_STAGE_TITLE,
    copy: checkStageCopy(stored ? Math.hypot(stored.x, stored.z) : null, totalSteps),
    status: CHECK_STATUS,
  }
}

/** The review step's status while the check marker sits where the fit cannot use it (the guidance line says why). */
export const CHECK_BLOCKED_STATUS = 'The check point cannot be used where it is. Move it or remove it.'

/** What the person is told after skipping the check point on a return visit: what the visit will and will not check. */
export const CHECK_SKIPPED_RETURN = 'Skipped. Only the distance between the two points will be checked.'

/** The one button for the check point, by what it does now: skip it, add it, or take it away. */
export const SKIP_CHECK_LABEL = 'Skip the check point'
export const ADD_CHECK_LABEL = 'Add a check point (recommended)'
export const REMOVE_CHECK_LABEL = 'Remove the check point'

/**
 * The review step's status while the markers placed so far do not match the stored ones (the readout under it says how). The card
 * is not "ready to commit": committing turns them back to the mismatch screen, where they can be kept or replaced.
 */
export const REVIEW_MISMATCH_STATUS = 'These points do not match the stored ones yet.'

/** The review step's instruction, with and without a check point to adjust. */
export const REVIEW_COPY = 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.'
export const REVIEW_COPY_WITH_CHECK =
  'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.'

/** The review step's instruction for the markers placed: two, or three with a check point. */
export function reviewCopy(hasCheck: boolean): string {
  return hasCheck ? REVIEW_COPY_WITH_CHECK : REVIEW_COPY
}

/** What a marker is called when it is selected for moving. */
export function markerName(id: MarkerName): string {
  return id === 'landmark' ? 'Landmark' : id === 'heading' ? 'Heading marker' : 'Check point'
}

/** The caption of the label field, naming the marker it is for. */
export function labelCaption(id: MarkerName): string {
  return id === 'landmark' ? 'Name point A (optional)' : id === 'heading' ? 'Name point B (optional)' : 'Name point C (optional)'
}

/**
 * What the reference panel says when the stored point has no photo. The two markers keep the sentences they have had;
 * the check point's photo is optional, so its sentence does not claim the Place predates photos.
 */
export function noPhotoNote(id: MarkerName, hasLabel: boolean): string {
  if (hasLabel) return 'No photo was saved for this point — go by the description above.'
  if (id === 'check') return 'No photo was saved for this point. Place it on the same physical feature as last time.'
  return 'This Place was aligned before reference photos existed, so there is nothing to match against. Place this marker on the same physical feature as last time.'
}

// ── The readout: how these points sit against the stored ones ────────────────────────────────────────

/** What the readout needs of a verdict: `ConstellationVerdict` satisfies it. */
export interface ReadoutVerdict {
  status: 'verified' | 'provisional' | 'mismatch'
  reasons: readonly string[]
  withheld?: readonly string[]
}

/** What the readout needs of a fit: the horizontal residual of each point, in the order the points were taken. */
export interface ReadoutFit {
  perPoint: readonly { residualM: number }[]
}

const POINT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

/** The most reasons a mismatch lists: the verdict can run to a few more, and the card is not a report. */
const MAX_READOUT_REASONS = 6

/** `A 2.1 cm · B 3.4 cm · C 4.0 cm`: how far each point landed from its stored one. Empty when there is nothing to say. */
export function perPointLine(fit: ReadoutFit | null | undefined): string {
  if (!fit) return ''
  return fit.perPoint
    .map((point, index) => `${POINT_LETTERS[index] ?? index + 1} ${formatCm(point.residualM)} cm`)
    .join(' · ')
}

export interface Readout {
  text: string
  /** `'ok'`: within the limits and nothing in the way of verifying; `'warn'`: within them but not verifiable; `'mismatch'`: beyond them. */
  state: 'ok' | 'warn' | 'mismatch'
}

/**
 * The lines under the markers once three or more points can be compared with the stored ones, one per line.
 *
 * Within the limits: the verdict's first sentence (how far off the points are on average, and the limit), the points one
 * by one, why the check is not verified when it is not, and the limits every comparison of taps has (the same physical
 * spots are not checked; nor, on a phone whose units are not metres, are sizes in metres). Beyond them:
 * every sentence the verdict gave, and the points one by one. Null when there is no verdict to read.
 */
export function fitReadout(verdict: ReadoutVerdict | null | undefined, fit: ReadoutFit | null | undefined): Readout | null {
  if (!verdict || verdict.reasons.length === 0) return null
  const points = perPointLine(fit)
  if (verdict.status === 'mismatch') {
    return {
      text: [...verdict.reasons.slice(0, MAX_READOUT_REASONS), ...(points ? [points] : [])].join('\n'),
      state: 'mismatch',
    }
  }
  const lines = [verdict.reasons[0]!, ...(points ? [points] : [])]
  const withheld = verdict.withheld ?? []
  if (verdict.status === 'provisional' && withheld.length > 0) lines.push(`Not verified: ${withheld.join(' ')}`)
  lines.push(NOT_CHECKED_SPOTS)
  // What a phone's units do and do not prove is a limit of the same kind, and the verdict names it when the phone says its units
  // are not metres: without it the centimetres above would read as centimetres.
  for (const limit of Object.values(NOT_CHECKED_METRES)) if (verdict.reasons.includes(limit)) lines.push(limit)
  return { text: lines.join('\n'), state: verdict.status === 'verified' ? 'ok' : 'warn' }
}

/**
 * The readout for a visit whose check point was tapped and could not be compared, because the stored points cannot serve as a
 * reference: the reason (the fit's own sentence) and what is compared instead.
 */
export function uncomparedReadout(reason: string): Readout {
  return { text: `${reason}\nOnly the distance between the two points is compared.`, state: 'warn' }
}

// ── The mismatch screen for three or more points ─────────────────────────────────────────────────────

export const MISMATCH_TITLE_POINTS = 'These points do not match the stored ones'

/**
 * The mismatch screen's sentence for a comparison of positions. The reasons (how far off, which way, whether two
 * points look swapped) are in the readout under it; this says what can be done.
 */
export const MISMATCH_COPY_POINTS =
  'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.'

/** The mismatch screen's way back to the markers: move one of them and see the readout change. */
export const ADJUST_POINT_LABEL = 'Adjust a point'

/**
 * The mismatch screen's way out to another Place: one name, which the return-visit copy owns (./return-visit-copy.ts) and
 * this module hands on to the cards that print it.
 */
export { WRONG_PLACE_LABEL } from './return-visit-copy.ts'
