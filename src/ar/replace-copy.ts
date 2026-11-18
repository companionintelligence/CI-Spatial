/**
 * What the scanner says when a Place's reference is about to be replaced, and the labels of the buttons that start a
 * replacement (WP-08).
 *
 * Pure, so the words can be tested without a DOM, and each claim sits beside the reason it is true. Same style as
 * ./alignment-status.ts: short plain words, and nothing the code did not check.
 *
 * ## What the confirmation claims
 *
 * The button used to say "Use anyway", which did not say that it replaces the Place's one saved reference, and
 * nothing told the person that the scans already made were measured against the reference being replaced. Now:
 *
 *  - It says which reference is replaced and why. The reason is a fact the flow knows: the pair the person placed
 *    did not match the recorded pair (and by how much), or they chose to improve the reference.
 *  - It says how many scans were made against it, only from the server's count (`affectedScans`). When the count
 *    could not be read it says so and claims no number, and no claim that any scan is or is not affected. The count
 *    is of the scans the server has stored: a scan still waiting on a phone to be uploaded is not in it, so a zero is
 *    worded as "no uploaded scan" and not as "no scan".
 *  - What it says happens to those scans is what the code does: they stay in the Place, the editor lists them as
 *    "previous reference" (src/viewer/frame-banner.ts), and nothing moves them to match the new reference. A scan
 *    that names no generation is not promised that: the editor calls it a previous reference only where the Place's own
 *    history shows the frame it was calibrated against was replaced, and otherwise cannot tell which reference it was
 *    made against, so the line says it stays as it is.
 *  - Where scans are tied to the reference, or the count is not known, the person types a word. A tapped
 *    "Replace" is one tap away from a tap meant for something else; a typed word is not.
 */
import type { AffectedScans } from '../world/frame-replacement.ts'

/** The mismatch screen's way to keep the pair the person placed: it replaces the Place's reference, unless the floor check was bypassed. */
export const REPLACE_REFERENCE_LABEL = "Replace this Place's reference"

/**
 * The same button when keeping the pair replaces nothing: the floor check was bypassed, so no frame is written (`mayWritePlaceFrame`,
 * ./ground-gate.ts) and the Place keeps the reference it has. The pair is kept with the scan, provisional, and the scan is in no Place
 * frame. The words are the mismatch card's own ("record this pair as unverified": `mismatchCopy`, `MISMATCH_COPY_POINTS`), and they name
 * neither a reference nor a replacement, which is what the question that goes with {@link REPLACE_REFERENCE_LABEL} is about.
 */
export const RECORD_UNVERIFIED_LABEL = 'Record as unverified'

/** The way to start a new reference for a Place whose two-point reference has no check point. */
export const IMPROVE_REFERENCE_LABEL = "Improve this Place's reference"

/** The way back from an improve, or out of the question about replacing: the reference the Place has stays as it is. */
export const KEEP_REFERENCE_LABEL = 'Keep the saved reference'

/** The word that confirms a replacement where scans are tied to the reference. Compared without case or edge spaces. */
export const REPLACE_CONFIRM_WORD = 'replace'

/**
 * How many tied scans make the person type the word. 1 is the owner's default (D4): any scan tied to the reference being
 * replaced. Adopted, not measured (ADR 0005 rule 5): it is a policy and not a measurement, and the owner can change it. A count
 * that could not be read always needs the word, whatever this says. It is the one place the policy is stated: raising it lets a
 * replacement that leaves only a few scans behind go with a tap.
 */
export const TYPED_CONFIRMATION_MIN_SCANS = 1

/** Why the reference is being replaced, as the flow knows it. */
export type ReplaceReason = 'override' | 'upgrade'

export interface ReplaceCopyInput {
  reason: ReplaceReason
  /** `'checking'` while the count is being read. */
  affected: AffectedScans | 'checking'
  /** The pair's spacing as placed minus the recorded one, in metres, for `'override'`. Not a number: no figure is claimed. */
  residualM?: number
  /** Whether the browser knows it is offline. */
  offline?: boolean
}

export interface ReplaceCopy {
  title: string
  reasonLine: string
  /** What happens to the scans made against the reference, or that they are still being counted. */
  scanLine: string
  /** Where the new reference goes while the phone is offline. Null when it is online. */
  offlineLine: string | null
  /** Whether the person has to type {@link REPLACE_CONFIRM_WORD}. Never while the count is being read. */
  typed: boolean
  typedLabel: string
  confirm: string
  cancel: string
}

/** Whole centimetres, unsigned, as the mismatch screen reports them. Null for a number that does not exist. */
function centimetres(metres: number | undefined): string | null {
  if (typeof metres !== 'number' || !Number.isFinite(metres)) return null
  return Math.abs(metres * 100).toFixed(0)
}

function reasonLine(input: ReplaceCopyInput): string {
  if (input.reason === 'upgrade') return 'You will place the markers again, as on a first visit. They become the new reference.'
  const off = centimetres(input.residualM)
  if (off === null || input.residualM === undefined) return 'The points you placed do not match the recorded pair.'
  const direction = input.residualM > 0 ? 'further apart' : 'closer together'
  return `The points you placed are ${off} cm ${direction} than the recorded pair.`
}

function scanLine(affected: AffectedScans | 'checking'): string {
  if (affected === 'checking') return 'Checking which scans use it…'
  if (affected.kind === 'unknown') {
    return 'Could not check which scans were made against it. Any that were stay in this Place and are not moved to match the new one.'
  }
  const { count, named } = affected
  if (count === 0) return 'No uploaded scan in this Place was made against it.'
  if (named) {
    return count === 1
      ? '1 scan in this Place was made against it. It stays in the Place, listed as previous reference, and is not moved to match the new one.'
      : `${count} scans in this Place were made against it. They stay in the Place, listed as previous reference, and are not moved to match the new one.`
  }
  return count === 1
    ? '1 scan in this Place does not say which reference it was made against. It stays as it is and is not moved to match the new one.'
    : `${count} scans in this Place do not say which reference they were made against. They stay as they are and are not moved to match the new one.`
}

/**
 * Whether the person has to type the word: scans are tied to the reference, or nobody could count them. It fails closed: the word
 * is asked for unless the count is a whole number below the threshold, so a count that is not one (an object, `NaN`) never
 * lets a tap replace a reference that may have scans tied to it.
 */
export function replaceNeedsTypedWord(affected: AffectedScans | 'checking'): boolean {
  if (affected === 'checking') return false
  if (affected.kind === 'unknown') return true
  return !(Number.isSafeInteger(affected.count) && affected.count >= 0 && affected.count < TYPED_CONFIRMATION_MIN_SCANS)
}

/** Whether what the person typed is the word. */
export function typedWordMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === REPLACE_CONFIRM_WORD
}

/** The confirmation's words for one replacement. */
export function replaceCopy(input: ReplaceCopyInput): ReplaceCopy {
  return {
    title: input.reason === 'upgrade' ? IMPROVE_REFERENCE_LABEL + '?' : REPLACE_REFERENCE_LABEL + '?',
    reasonLine: reasonLine(input),
    scanLine: scanLine(input.affected),
    offlineLine: input.offline ? 'No connection. The new reference is kept on this phone and sent when it is back online.' : null,
    typed: replaceNeedsTypedWord(input.affected),
    typedLabel: `Type ${REPLACE_CONFIRM_WORD} to confirm.`,
    confirm: input.reason === 'upgrade' ? 'Improve reference' : 'Replace reference',
    cancel: KEEP_REFERENCE_LABEL,
  }
}
