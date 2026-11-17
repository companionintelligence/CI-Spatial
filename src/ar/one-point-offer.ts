/**
 * When the calibration modal offers the one-point tier, and what it says it is.
 *
 * Pure, so the decision can be tested without the modal's DOM; `./project-calibration.ts` shows
 * or hides its button from `onePointOffered` and draws `ONE_POINT_LABEL` on it.
 *
 * ## Why a Place that has a two-point frame is not offered it
 *
 * The two tiers do not share a frame. A two-point frame has its +Z along the line from the landmark to the
 * heading marker, which is whichever way that visit's baseline happened to lie. A one-point frame has its
 * +Z along north as the compass gives it (magnetic north: no declination is applied), and its origin wherever
 * the single tap landed.
 * Both are stored as `sessionToProject` and the server places a scan from it without asking which tier made
 * it (`anchorToProjectTransform` and `twoPointToProjectTransform` in `src/world/geo.ts` build them). So a
 * one-point scan in a two-point Place is rotated about the landmark, against the others, by the compass
 * bearing of that Place's baseline: not at all for a baseline due north, a quarter turn for east, a half
 * turn for south, with a perfect compass. Nothing converts between the two, and the stored
 * `anchorBearingDeg` is the bearing of the +Z axis of the session that made the frame, not of the baseline.
 *
 * So the button is not offered there. A person who cannot place a second point still has "Continue
 * uncalibrated", which is honest about what it is. (Owner decision D5, recommended option: hide the button.
 * The alternative, converting through a stored project bearing, needs the compass work of package WP-10, and
 * even then leaves the origin wrong unless the tap is the stored landmark.) The one condition that
 * says so is the last line of `onePointOffered`.
 *
 * That line is an allow-list, on purpose. The button is offered only to a Place with no frame yet or with a
 * one-point frame, the two cases below. A frame whose method this build does not recognise (a tier a later
 * package adds, or a record that is not one of ours) is not offered it: nothing here can say a one-point scan
 * lines up with a frame of a kind it has not seen, and the safe answer to an unknown kind is to hide.
 *
 * Where it is still offered, the Place is new or its frame is itself a one-point one, and in both a
 * one-point scan lines up with the others only if the same spot is tapped, and at the compass's accuracy.
 * The label says that.
 *
 * Hiding is checked twice. `./project-calibration.ts` shows or hides the button from this decision on every
 * redraw, and asks it again when the button is clicked, so a click that reaches a hidden button (a script, or
 * a later caller of the click handler) is refused by the same rule and not only by the paint.
 */
import type { ProjectSpatialFrame } from '../world/types'

/** The stages of the modal, as `./project-calibration.ts` names them. `'check'` is the optional step after the heading marker (./constellation-flow.ts). */
export type CalibrationStage = 'ground' | 'landmark' | 'heading' | 'check' | 'review' | 'mismatch'

/**
 * What the button says. "Continue", because it is what the person does when a second point is not
 * practical, and the parenthesis is the claim the code can stand behind: with one point and a compass
 * the scan is not in the frame the other scans are in.
 */
export const ONE_POINT_LABEL = 'Continue with one point (this scan will not line up with other scans)'

export interface OnePointOfferInput {
  stage: CalibrationStage
  /** Whether the landmark has been tapped yet: there is nothing to continue with before. */
  hasLandmark: boolean
  /**
   * The method of the Place's stored frame, or null for a Place with none (a first visit). A stored frame
   * is never null here, even when its method is missing or unknown: that is a frame of a kind not offered it.
   */
  storedMethod: ProjectSpatialFrame['method'] | null
}

/** Whether the one-point button is offered now, and whether a click on it is accepted. */
export function onePointOffered(input: OnePointOfferInput): boolean {
  // Before the floor is established, nothing can be placed; in the mismatch stage the choice in front of
  // the person is between the stored pair and a new one, and a third tier is not part of it.
  if (input.stage === 'ground' || input.stage === 'mismatch') return false
  if (!input.hasLandmark) return false
  return input.storedMethod === null || input.storedMethod === 'ground-tap-compass'
}
