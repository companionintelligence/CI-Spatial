/**
 * What the calibration card says on a return visit to a Place that stores a two-point frame, and what its distance chip
 * and its photo hold say (WP-07).
 *
 * Pure, and Deno-free because the browser imports it (ADR 0002): the sentences sit here, beside the numbers they quote,
 * so each claim can be tested without a DOM and sits next to the reason it is true. `./project-calibration.ts` calls it
 * from the landmark and heading steps and `./return-visit-aids.ts` from the chip; `./reference-photo-flow.ts` asks it for
 * the hold. The style is `./alignment-status.ts`: short words, and nothing the code did not check.
 *
 * ## Why a return visit has its own copy
 *
 * The first-visit copy asks for something new ("tap the ground at a permanent feature you will recognise next visit") and
 * the heading step on a return visit used to say how far the stored marker was and nothing about which spot it was. A
 * person on a return visit is not choosing a feature. They are finding the same two again, and the Place already holds the
 * facts that help: a photo of each, the label they typed, and the distance between them. So the copy says to tap Point A
 * again, the same spot as the photo, and gives the distance Point B was from it.
 *
 * ## What the chip says, and what it does not
 *
 * The chip is the commit's own check, shown while the markers are placed instead of after the button is pressed: the
 * distance between the two markers, against the stored one, inside the spacing tolerance the commit applies
 * (`assessTwoPoint` in ./calibration-commit.ts, and tests/unit/node/wp-return-visit-copy.test.ts holds the two to each
 * other). That is all "pass" means. It does not compare direction or position: the right pair tapped in the other order, or
 * another pair the same distance apart, passes too (ADR 0005 rule 3). So a pass says the distance matched and, in the same
 * line, that direction was not checked, as the status line after the commit does.
 *
 * ## Which tolerance
 *
 * The commit's, and not the record's. A stored frame carries a `toleranceM` (the 15 cm of the build before, or the 16.8 cm a
 * later one wrote), but the commit no longer reads it: it applies `twoPointToleranceM` at the tap noise it judges by. A chip
 * that quoted the record would pass a pair the commit turns away, or fail one it accepts. So the caller hands the number in
 * (`returnVisitOf`'s second argument), and the words that quote an allowance quote that one. A caller that names none gets
 * what a commit with no tap noise of its own applies.
 *
 * "The same spot as the photo" is said only while the photo is on screen. A stored photo that failed to load, or that
 * was never saved, is "the same spot as last time", and the reference panel says which of those it is.
 *
 * ## The steps' counters
 *
 * "Step 1 of 3" is true only where the visit asks for three taps: a Place that stores a check point asks for it after the
 * heading marker (`stepsInVisit`, ./constellation-flow.ts). The two steps here take the count the modal counts to and
 * say it, so the words and the progress dots agree. Without one they say "of 2", as a visit with no check point does.
 */
import { MIN_POINT_SEPARATION_M } from '../world/geo.ts'
import { stepPrefix } from '../world/baseline-guidance.ts'
import { twoPointToleranceM } from '../world/frame-fit.ts'
import type { TwoPointFrame } from './calibration-commit.ts'
import type { ReferencePhotoRole } from './reference-photo.ts'

// ── What a return visit knows ────────────────────────────────────────────────────────────────────────

/** The facts of the stored pair that the copy quotes. */
export interface ReturnVisit {
  /** How far Point B was from Point A, when the record carries a length that is a number above 0. Null otherwise. */
  separationM: number | null
  /** The spacing a pair is accepted within, as the commit applies it (`twoPointToleranceM`): not the record's own. */
  toleranceM: number
}

/**
 * The stored pair as a return visit sees it, or null when the Place has no two-point frame (a first visit, or a frame of
 * another method, which is not a pair to find again).
 *
 * `toleranceM` is the spacing tolerance the commit applies: the caller that runs the commit says it (the modal passes
 * `twoPointToleranceM(commitOptions.sigmaHatM)`), because the chip must say pass exactly when the commit accepts. Without
 * one it is `twoPointToleranceM()`, what a commit at the adopted tap noise applies. The record's own `toleranceM` is not read.
 */
export function returnVisitOf(frame: TwoPointFrame | null | undefined, toleranceM?: number | null): ReturnVisit | null {
  if (!frame) return null
  const length = frame.separationM
  return {
    separationM: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null,
    toleranceM: toleranceM ?? twoPointToleranceM(),
  }
}

const spotOf = (photoShown: boolean): string => (photoShown ? 'the photo' : 'last time')

/**
 * Point A's step on a return visit. `photoShown`: the stored photo of Point A is on screen now. `totalSteps`: the taps the
 * visit asks for, 3 where the check point follows the heading marker (`stepsInVisit`), else 2.
 */
export function returnLandmarkCopy(photoShown: boolean, totalSteps: number = 2): string {
  return `${stepPrefix(1, totalSteps)}tap Point A again, the same spot as ${spotOf(photoShown)}. Point A is the project's origin.`
}

/**
 * Point B's step on a return visit: which spot, and how far from Point A it was, with the tolerance the pair is judged
 * by. Without a stored length it names the spot and quotes no number. The tolerance is quoted only where it is a figure.
 *
 * `ringShown`: the ring on the floor round Point A is drawn, at that same distance, so the sentence may point to it. The
 * ring is the stored points' own distance (`ringRadiiFromStoredPoints`) and this is the record's `separationM`; the caller
 * says it is drawn only when the two agree, so the words never point at a ring that is not there or is another size.
 * `totalSteps`: as for {@link returnLandmarkCopy}.
 */
export function returnHeadingCopy(visit: ReturnVisit, photoShown: boolean, ringShown = false, totalSteps: number = 2): string {
  const spot = `${stepPrefix(2, totalSteps)}tap Point B again, the same spot as ${spotOf(photoShown)}.`
  if (visit.separationM === null) return spot
  const allowed = Number.isFinite(visit.toleranceM) && visit.toleranceM >= 0 ? ` (allowed ±${visit.toleranceM.toFixed(2)} m)` : ''
  const ring = ringShown ? ' The ring on the floor marks that distance.' : ''
  return `${spot} Point B was ${visit.separationM.toFixed(2)} m from A${allowed}.${ring}`
}

// ── The distance chip ────────────────────────────────────────────────────────────────────────────────

export interface DistanceChip {
  /**
   * `'pass'`: inside the tolerance. `'fail'`: outside it, which is the mismatch screen if the person commits now (where the
   * commit compares the distance: a visit that re-taps a stored check point is judged by a fit, and has no chip).
   */
  state: 'pass' | 'fail'
  text: string
}

/** Whole centimetres, unsigned, as the mismatch screen and the status line report them. */
const centimetres = (metres: number): string => Math.abs(metres * 100).toFixed(0)

/**
 * A figure and its unit, held together: the chip is a short line that wraps, and "0" on one line with "cm off" on the next
 * reads as two figures. A no-break space (U+00A0) is a space to a person and to a screen reader.
 */
const cm = (figure: string): string => `${figure}\u00A0cm`

/**
 * The chip under the two markers: whether their distance is the stored one, inside the tolerance the commit applies
 * (`visit.toleranceM`, which the caller took from the commit: see "Which tolerance" above).
 *
 * Null when there is nothing to say: no stored length to compare with, a separation that is not a number, or one under
 * `MIN_POINT_SEPARATION_M`, which the separation line above already answers ("need at least 1.0 m"). The comparison is
 * the commit's: strictly more than the tolerance is a mismatch (`assessTwoPoint`), a residual equal to it passes. A
 * tolerance that is not a number is no tolerance, so everything passes (nothing is "more than" it); one below 0 fails
 * every pair and is not an allowance to print. The commit cannot be given either (`twoPointToleranceM` is a positive
 * number at any tap noise): they are what a caller that passes a bad one gets.
 *
 * The figures are whole centimetres, as the mismatch screen's are, and a failing chip prints the allowance beside the
 * gap. A gap a few millimetres over the allowance rounds to the allowance itself, and "15 cm further apart than stored.
 * Allowed: ±15 cm." would read as a pass that failed, so there the chip says it is just over and prints no gap.
 */
export function distanceChip(visit: ReturnVisit, separationM: number | null): DistanceChip | null {
  if (visit.separationM === null || separationM === null || !Number.isFinite(separationM)) return null
  if (!(separationM >= MIN_POINT_SEPARATION_M)) return null
  const residualM = separationM - visit.separationM
  if (Math.abs(residualM) > visit.toleranceM) {
    const further = residualM > 0
    const gap = centimetres(residualM)
    const allowed = Number.isFinite(visit.toleranceM) && visit.toleranceM >= 0 ? centimetres(visit.toleranceM) : null
    if (allowed !== null && Number(gap) <= Number(allowed)) {
      return { state: 'fail', text: `⚠ ${further ? 'Further apart' : 'Closer together'} than stored by just over the allowed ±${cm(allowed)}.` }
    }
    const limit = allowed === null ? '' : ` Allowed: ±${cm(allowed)}.`
    return { state: 'fail', text: `⚠ ${cm(gap)} ${further ? 'further apart' : 'closer together'} than stored.${limit}` }
  }
  return { state: 'pass', text: `✓ About as far apart as stored: ${cm(centimetres(residualM))} off. Direction is not checked.` }
}

/**
 * The card's status line in review while the chip fails, in place of "Ready to commit.": the line above the chip must not
 * say the opposite of it. It does not say what Commit does next; the mismatch screen that follows does.
 */
export const NOT_STORED_DISTANCE_STATUS = 'Not the stored distance yet.'

// ── The photo hold ───────────────────────────────────────────────────────────────────────────────────

/** Why a point has no photo that shows it: `'out-of-view'` is a frame without the point in it, `'failed'` is no usable frame. */
export interface PhotoProblem {
  role: ReferencePhotoRole
  kind: 'out-of-view' | 'failed'
}

const POINT_LETTER: Record<ReferencePhotoRole, string> = { landmark: 'A', headingMarker: 'B', check1: 'C', check2: 'D', check3: 'E' }

/** "Point B", or "Points A and B". Roles come in the order the points are placed. */
function namePoints(roles: readonly ReferencePhotoRole[]): string {
  const letters = roles.map((role) => POINT_LETTER[role])
  return roles.length === 1 ? `Point ${letters[0]}` : `Points ${letters.join(' and ')}`
}

/** What the sentence says to press when the caller does not know the button's name: it is the one the person just pressed. */
const SAME_BUTTON = 'the same button'

/**
 * What the commit says when it did not get a photo of every point, before it saves a frame without them. The alignment
 * is saved the way the person asked the second time they press: the photo is an aid, never a gate, and a frame keeps both
 * photos or neither (src/project/frame-sync.ts), so the last sentence says what is lost.
 *
 * `button` is what the button the person pressed is called on the card. A commit is pressed on the review screen as "Use
 * this alignment" and on the mismatch screen as "Use anyway", where the first is not on the card at all, so the sentence
 * takes the name from the card and never writes one of its own. Without a name it says "the same button".
 */
export function photoHoldText(problems: readonly PhotoProblem[], button?: string | null): string {
  const outOfView = problems.filter((p) => p.kind === 'out-of-view').map((p) => p.role)
  const failed = problems.filter((p) => p.kind === 'failed').map((p) => p.role)
  const press = button?.trim() || SAME_BUTTON
  const parts: string[] = []
  if (outOfView.length > 0) {
    const one = outOfView.length === 1
    parts.push(`${namePoints(outOfView)} ${one ? 'is' : 'are'} not in the camera view. Aim at ${one ? 'it' : 'them'}, then press ${press} again.`)
  }
  if (failed.length > 0) {
    parts.push(`The camera gave no photo of ${namePoints(failed)}. Press ${press} again to try once more.`)
  }
  parts.push('If a photo is still missing, the alignment is saved without reference photos.')
  return parts.join(' ')
}

// ── The Place picker's way out, and the two photos side by side ──────────────────────────────────────

/**
 * The way out of the mismatch screen for a person who is in the wrong Place: the stored pair is not here to be found, so
 * no tap will match it. The behaviour is the host's (`onWrongPlace`, WP-08): this is the button's name on the card.
 */
export const WRONG_PLACE_LABEL = 'Wrong Place? Choose another'

/** The heading of the panel that shows both stored photos while the pair is checked. */
export const COMPARE_HEAD = 'Last time'

/** What a slot of that panel says when it has no picture: nothing saved, still loading, or not loadable. `uploaded`: the record has a server path. */
export function compareNote(state: 'none' | 'loading' | 'failed', uploaded: boolean): string {
  if (state === 'none') return 'No photo saved'
  if (state === 'loading') return 'Loading…'
  return uploaded ? 'Photo could not be loaded' : 'Photo never finished uploading'
}
