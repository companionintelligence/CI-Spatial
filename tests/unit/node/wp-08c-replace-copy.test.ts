/**
 * What the scanner says before it replaces a Place's reference (WP-08): ../../../src/ar/replace-copy.ts.
 *
 * Each sentence is held to what the code knows when it says it. The count comes from the server or it is not stated; a
 * scan that names no generation is never called a previous reference; the reason is the one the flow has (the pair did not
 * match, by how much, or the person chose to improve); and a typed word is asked for exactly when scans are tied to the
 * reference or nobody could count them.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-replace-copy.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPROVE_REFERENCE_LABEL,
  KEEP_REFERENCE_LABEL,
  REPLACE_CONFIRM_WORD,
  REPLACE_REFERENCE_LABEL,
  TYPED_CONFIRMATION_MIN_SCANS,
  replaceCopy,
  replaceNeedsTypedWord,
  typedWordMatches,
} from '../../../src/ar/replace-copy.ts'
import type { AffectedScans } from '../../../src/world/frame-replacement.ts'

const named = (count: number): AffectedScans => ({ kind: 'known', count, named: true })
const unnamed = (count: number): AffectedScans => ({ kind: 'known', count, named: false })
const unknown: AffectedScans = { kind: 'unknown' }

test('the labels say what the buttons do', () => {
  assert.equal(REPLACE_REFERENCE_LABEL, "Replace this Place's reference")
  assert.equal(IMPROVE_REFERENCE_LABEL, "Improve this Place's reference")
  assert.equal(KEEP_REFERENCE_LABEL, 'Keep the saved reference')
  assert.equal(replaceCopy({ reason: 'override', affected: { kind: 'known', count: 0, named: true } }).cancel, KEEP_REFERENCE_LABEL, 'the question\'s way out says the same as the improve\'s way back')
  assert.equal(REPLACE_CONFIRM_WORD, 'replace')
  assert.equal(TYPED_CONFIRMATION_MIN_SCANS, 1, 'the owner default: any tied scan makes the person type the word')
})

test('replacing after a mismatch says by how much the pair differed, and which way', () => {
  const further = replaceCopy({ reason: 'override', affected: named(0), residualM: 0.4 })
  assert.equal(further.title, "Replace this Place's reference?")
  assert.equal(further.reasonLine, 'The points you placed are 40 cm further apart than the recorded pair.')
  const closer = replaceCopy({ reason: 'override', affected: named(0), residualM: -0.304 })
  assert.equal(closer.reasonLine, 'The points you placed are 30 cm closer together than the recorded pair.')
  for (const residualM of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const copy = replaceCopy({ reason: 'override', affected: named(0), residualM })
    assert.equal(copy.reasonLine, 'The points you placed do not match the recorded pair.', `no figure for ${String(residualM)}`)
    assert.doesNotMatch(copy.reasonLine, /NaN|Infinity|undefined/)
  }
})

test('improving the reference says what the person will do, and is called improving', () => {
  const copy = replaceCopy({ reason: 'upgrade', affected: named(0) })
  assert.equal(copy.title, "Improve this Place's reference?")
  assert.equal(copy.reasonLine, 'You will place the markers again, as on a first visit. They become the new reference.')
  assert.equal(copy.confirm, 'Improve reference')
  assert.equal(replaceCopy({ reason: 'override', affected: named(0) }).confirm, 'Replace reference')
  assert.equal(copy.cancel, 'Keep the saved reference')
})

test('the count is the server\'s, and a scan that names no generation is not called a previous reference', () => {
  // The count is of the scans the server has stored, so a zero is not a claim about scans still waiting on a phone to upload.
  assert.equal(replaceCopy({ reason: 'override', affected: named(0) }).scanLine, 'No uploaded scan in this Place was made against it.')
  assert.equal(
    replaceCopy({ reason: 'override', affected: named(1) }).scanLine,
    '1 scan in this Place was made against it. It stays in the Place, listed as previous reference, and is not moved to match the new one.',
  )
  assert.equal(
    replaceCopy({ reason: 'override', affected: named(12) }).scanLine,
    '12 scans in this Place were made against it. They stay in the Place, listed as previous reference, and are not moved to match the new one.',
  )
  const legacyOne = replaceCopy({ reason: 'override', affected: unnamed(1) }).scanLine
  const legacyMany = replaceCopy({ reason: 'override', affected: unnamed(4) }).scanLine
  assert.equal(legacyOne, '1 scan in this Place does not say which reference it was made against. It stays as it is and is not moved to match the new one.')
  assert.equal(legacyMany, '4 scans in this Place do not say which reference they were made against. They stay as they are and are not moved to match the new one.')
  assert.doesNotMatch(legacyOne + legacyMany, /previous reference/, 'the editor cannot say which reference such a scan was made against, so neither does this')
  assert.equal(replaceCopy({ reason: 'override', affected: unnamed(0) }).scanLine, 'No uploaded scan in this Place was made against it.')
})

test('while the count is being read, and when it could not be, no number is claimed', () => {
  assert.equal(replaceCopy({ reason: 'override', affected: 'checking' }).scanLine, 'Checking which scans use it…')
  const failed = replaceCopy({ reason: 'override', affected: unknown }).scanLine
  assert.equal(failed, 'Could not check which scans were made against it. Any that were stay in this Place and are not moved to match the new one.')
  assert.doesNotMatch(failed, /\d/, 'no figure, and not "no scans"')
  assert.doesNotMatch(failed, /^No scan/)
})

test('a word has to be typed where scans are tied to the reference or could not be counted, and never before the count is in', () => {
  assert.equal(replaceNeedsTypedWord('checking'), false, 'the confirm button is off while checking, whatever the word')
  assert.equal(replaceNeedsTypedWord(named(0)), false)
  assert.equal(replaceNeedsTypedWord(unnamed(0)), false)
  assert.equal(replaceNeedsTypedWord(named(1)), true, 'any tied scan')
  assert.equal(replaceNeedsTypedWord(unnamed(1)), true)
  assert.equal(replaceNeedsTypedWord(unknown), true, 'not knowing is not "none"')
  assert.equal(replaceCopy({ reason: 'override', affected: named(2) }).typed, true)
  assert.equal(replaceCopy({ reason: 'override', affected: named(0) }).typed, false)
  assert.equal(replaceCopy({ reason: 'override', affected: named(2) }).typedLabel, 'Type replace to confirm.')
})

test('the typed word is matched without case or edge spaces, and not as a prefix', () => {
  for (const ok of ['replace', 'Replace', '  REPLACE  ', 'rePlace\n']) assert.equal(typedWordMatches(ok), true, JSON.stringify(ok))
  for (const no of ['', 'repl', 'replaced', 're place', 'replace it', 'rep1ace']) assert.equal(typedWordMatches(no), false, JSON.stringify(no))
})

test('an offline phone is told where the new reference goes, and an online one is told nothing', () => {
  const offline = replaceCopy({ reason: 'override', affected: unknown, offline: true })
  assert.equal(offline.offlineLine, 'No connection. The new reference is kept on this phone and sent when it is back online.')
  assert.equal(replaceCopy({ reason: 'override', affected: unknown, offline: false }).offlineLine, null)
  assert.equal(replaceCopy({ reason: 'override', affected: unknown }).offlineLine, null)
})
