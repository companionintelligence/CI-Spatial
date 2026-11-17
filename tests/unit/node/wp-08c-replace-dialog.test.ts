/**
 * The confirmation before a Place's reference is replaced (WP-08): ../../../src/ar/replace-reference.ts, run for real
 * against a stand-in for the part of the document it uses (./support/fake-dialog-dom.ts).
 *
 * What it holds the dialog to, which is what the work package asks of "Replace this Place's reference":
 *  - it opens over the modal's own card, hides that card while it is open and gives it back when it is answered;
 *  - it says it is checking, with the confirm button off, until the server's count is in;
 *  - it then says how many scans were made against the reference, from that count and no other;
 *  - where scans are tied to the reference, or the count could not be read, the confirm button stays off until the word
 *    is typed (the owner's default: any tied scan);
 *  - the safe answer is the promoted button, and focus goes back to the button that asked once the question is answered;
 *  - cancel, the Escape key and a second request while it is open are handled, and a late answer after it is gone is not an
 *    error.
 *
 * The words themselves are held by wp-08c-replace-copy.test.ts. Time and the network are the test's.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-replace-dialog.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { askToReplaceReference } from '../../../src/ar/replace-reference.ts'
import { readFrameStatus, type ReferenceStatus } from '../../../src/world/frame-replacement.ts'
import { installDialogDom, type FakeEl } from './support/fake-dialog-dom.ts'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const frame = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...extra,
})

/** A status as the server answers it for a Place whose reference has the id `frame-now`. */
const statusWith = (scans: number): ReferenceStatus =>
  readFrameStatus({ revision: 2, frame: frame({ frameId: 'frame-now' }), scansOnCurrentFrame: scans })!

/** Opens the dialog in a fresh stand-in document, and gives back what the test pokes at. */
function open(ask: Parameters<typeof askToReplaceReference>[1], fetchStatus: () => Promise<ReferenceStatus | null>, offline = false) {
  const dom = installDialogDom()
  const answer = askToReplaceReference(dom.host as unknown as HTMLElement, ask, { fetchStatus, offline: () => offline })
  const dialog = dom.dialogs[0]!
  const part = (id: string): FakeEl => dialog.parts.get(id)!
  const text = () => ({
    title: part('frame-replace-title').textContent,
    reason: part('frame-replace-reason').textContent,
    scans: part('frame-replace-scans').textContent,
  })
  return { ...dom, answer, dialog, part, text }
}

test('it opens over the modal\'s card, says it is checking, and keeps the confirm button off until the count is in', async () => {
  const status = deferred<ReferenceStatus | null>()
  const ui = open({ reason: 'override', residualM: 0.4 }, () => status.promise)
  try {
    assert.equal(ui.card.hidden, true, 'the modal\'s own card is put away')
    assert.equal(ui.host.children[0], ui.dialog, 'and the question is in the modal')
    assert.equal(ui.dialog.className, 'project-calibration-card', 'in the card\'s own style, so no page style was needed')
    assert.equal(ui.dialog.attrs.get('role'), 'alertdialog')
    assert.equal(ui.dialog.attrs.get('aria-modal'), 'true')
    assert.equal(ui.dialog.attrs.get('aria-describedby'), 'frame-replace-reason frame-replace-scans', 'what it asks is read out with it')
    assert.equal(ui.part('frame-replace-cancel').focused, true, 'focus starts on the safe answer, not on the button that replaces the reference')
    assert.deepEqual(ui.text(), {
      title: "Replace this Place's reference?",
      reason: 'The points you placed are 40 cm further apart than the recorded pair.',
      scans: 'Checking which scans use it…',
    })
    assert.equal(ui.part('frame-replace-confirm').disabled, true, 'nothing can be confirmed before the count is known')
    assert.equal(ui.part('frame-replace-typed-field').hidden, true)
    ui.part('frame-replace-confirm').click()
    await settle()
    assert.equal(ui.dialog.removed, false, 'a click on the disabled button does nothing')
    status.resolve(statusWith(0))
    await settle()
    ui.part('frame-replace-cancel').click()
    assert.equal(await ui.answer, false)
  } finally {
    ui.restore()
  }
})

test('no scan tied to the reference: it says so, asks for no word, and confirming answers true and gives the card back', async () => {
  const ui = open({ reason: 'override', residualM: -0.3 }, () => Promise.resolve(statusWith(0)))
  try {
    await settle()
    assert.equal(ui.text().scans, 'No uploaded scan in this Place was made against it.')
    assert.equal(ui.part('frame-replace-typed-field').hidden, true)
    assert.equal(ui.part('frame-replace-confirm').disabled, false)
    assert.equal(ui.part('frame-replace-confirm').textContent, 'Replace reference')
    ui.part('frame-replace-confirm').click()
    assert.equal(await ui.answer, true)
    assert.equal(ui.dialog.removed, true)
    assert.equal(ui.card.hidden, false, 'the card is back')
  } finally {
    ui.restore()
  }
})

test('scans tied to the reference: the count is the server\'s, and the word has to be typed before the button is live', async () => {
  const ui = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(statusWith(3)))
  try {
    await settle()
    assert.equal(
      ui.text().scans,
      '3 scans in this Place were made against it. They stay in the Place, listed as previous reference, and are not moved to match the new one.',
    )
    const typed = ui.part('frame-replace-typed')
    assert.equal(ui.part('frame-replace-typed-field').hidden, false)
    assert.equal(ui.part('frame-replace-typed-label').textContent, 'Type replace to confirm.')
    assert.equal(typed.focused, true, 'the field is ready to type in')
    assert.equal(ui.part('frame-replace-confirm').disabled, true)

    typed.type('repl')
    assert.equal(ui.part('frame-replace-confirm').disabled, true, 'a part of the word is not the word')
    typed.type('yes')
    assert.equal(ui.part('frame-replace-confirm').disabled, true)
    ui.part('frame-replace-confirm').click()
    await settle()
    assert.equal(ui.dialog.removed, false, 'a click on the disabled button, which a script can make, does nothing')

    typed.type('  Replace ')
    assert.equal(ui.part('frame-replace-confirm').disabled, false, 'the word, without case or edge spaces')
    typed.type('replac')
    assert.equal(ui.part('frame-replace-confirm').disabled, true, 'and off again when it is no longer the word')
    typed.type('REPLACE')
    ui.part('frame-replace-confirm').click()
    assert.equal(await ui.answer, true)
  } finally {
    ui.restore()
  }
})

test('a count that could not be read is not "none": the word is asked for, and no number is claimed', async () => {
  for (const fetchStatus of [() => Promise.resolve(null), () => Promise.reject(new Error('boom')), () => { throw new Error('sync') }]) {
    const ui = open({ reason: 'override', residualM: 0.4 }, fetchStatus as () => Promise<ReferenceStatus | null>)
    try {
      await settle()
      assert.equal(
        ui.text().scans,
        'Could not check which scans were made against it. Any that were stay in this Place and are not moved to match the new one.',
      )
      assert.equal(ui.part('frame-replace-typed-field').hidden, false)
      assert.equal(ui.part('frame-replace-confirm').disabled, true)
      ui.part('frame-replace-cancel').click()
      assert.equal(await ui.answer, false)
    } finally {
      ui.restore()
    }
  }
})

test('improving the reference asks in its own words, and a frame with no scan tied to it needs no word', async () => {
  const ui = open({ reason: 'upgrade' }, () => Promise.resolve(statusWith(0)))
  try {
    await settle()
    assert.equal(ui.text().title, "Improve this Place's reference?")
    assert.equal(ui.text().reason, 'You will place the markers again, as on a first visit. They become the new reference.')
    assert.equal(ui.part('frame-replace-confirm').textContent, 'Improve reference')
    assert.equal(ui.part('frame-replace-confirm').disabled, false)
    ui.part('frame-replace-confirm').click()
    assert.equal(await ui.answer, true)
  } finally {
    ui.restore()
  }
})

test('cancel, and the Escape key, keep the saved reference and give the card back', async () => {
  const first = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(statusWith(1)))
  try {
    await settle()
    assert.equal(first.part('frame-replace-cancel').textContent, 'Keep the saved reference')
    first.part('frame-replace-cancel').click()
    assert.equal(await first.answer, false)
    assert.equal(first.dialog.removed, true)
    assert.equal(first.card.hidden, false)
  } finally {
    first.restore()
  }

  const second = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(statusWith(1)))
  try {
    await settle()
    second.dialog.fire('keydown', { key: 'a' })
    await settle()
    assert.equal(second.dialog.removed, false, 'another key does nothing')
    second.dialog.fire('keydown', { key: 'Escape' })
    assert.equal(await second.answer, false)
    assert.equal(second.card.hidden, false)
  } finally {
    second.restore()
  }
})

test('the safe answer is the promoted button, and the one that replaces the reference is a plain link', () => {
  const ui = open({ reason: 'override', residualM: 0.4 }, () => new Promise(() => {}))
  try {
    assert.match(ui.part('frame-replace-cancel').className, /\bproject-calibration-link-promoted\b/)
    assert.doesNotMatch(ui.part('frame-replace-confirm').className, /promoted/, 'the destructive answer is not the one the eye is drawn to')
    assert.match(ui.part('frame-replace-confirm').className, /\bproject-calibration-link\b/, 'it is still a button of the card')
  } finally {
    ui.restore()
  }
})

test('focus goes back to the button that asked, once the question is answered either way and after the card is given back', async () => {
  for (const answer of ['confirm', 'cancel', 'escape'] as const) {
    const ui = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(statusWith(0)))
    try {
      await settle()
      assert.equal(ui.opener.focused, false, 'while the question is open, focus is in it')
      // Focus cannot go to a button inside a card that is still hidden, so the card has to be back by then.
      const cardWhenFocused: boolean[] = []
      ui.opener.focus = () => {
        ui.opener.focused = true
        cardWhenFocused.push(ui.card.hidden)
      }
      if (answer === 'confirm') ui.part('frame-replace-confirm').click()
      else if (answer === 'cancel') ui.part('frame-replace-cancel').click()
      else ui.dialog.fire('keydown', { key: 'Escape' })
      assert.equal(await ui.answer, answer === 'confirm', answer)
      assert.equal(ui.opener.focused, true, `${answer}: focus is where it was`)
      assert.deepEqual(cardWhenFocused, [false], `${answer}: put back once, after the card was given back`)
    } finally {
      ui.restore()
    }
  }
})

test('a question asked with nothing focused is answered all the same, and nothing is given focus', async () => {
  const dom = installDialogDom()
  try {
    ;(globalThis.document as unknown as { activeElement: unknown }).activeElement = null
    const answer = askToReplaceReference(dom.host as unknown as HTMLElement, { reason: 'override', residualM: 0.4 }, { fetchStatus: () => Promise.resolve(statusWith(0)), offline: () => false })
    await settle()
    dom.dialogs[0]!.parts.get('frame-replace-cancel')!.click()
    assert.equal(await answer, false)
    assert.equal(dom.opener.focused, false, 'nothing was focused, so nothing is given focus')
  } finally {
    dom.restore()
  }
})

test('a card that was already hidden stays hidden when the question is answered', async () => {
  const dom = installDialogDom()
  try {
    dom.card.hidden = true
    const answer = askToReplaceReference(dom.host as unknown as HTMLElement, { reason: 'override', residualM: 0.4 }, { fetchStatus: () => Promise.resolve(statusWith(0)), offline: () => false })
    await settle()
    dom.dialogs[0]!.parts.get('frame-replace-cancel')!.click()
    await answer
    assert.equal(dom.card.hidden, true)
  } finally {
    dom.restore()
  }
})

test('asking again while it is open is the same question, not a second dialog', async () => {
  const dom = installDialogDom()
  try {
    const ask = { reason: 'override', residualM: 0.4 } as const
    const deps = { fetchStatus: () => Promise.resolve(statusWith(0)), offline: () => false }
    const one = askToReplaceReference(dom.host as unknown as HTMLElement, ask, deps)
    const two = askToReplaceReference(dom.host as unknown as HTMLElement, ask, deps)
    assert.equal(one, two)
    assert.equal(dom.dialogs.length, 1)
    await settle()
    dom.dialogs[0]!.parts.get('frame-replace-cancel')!.click()
    assert.equal(await one, false)
    // And once answered, the next question is a new dialog.
    const three = askToReplaceReference(dom.host as unknown as HTMLElement, ask, deps)
    assert.notEqual(three, one)
    assert.equal(dom.dialogs.length, 2)
    await settle()
    dom.dialogs[1]!.parts.get('frame-replace-cancel')!.click()
    await three
  } finally {
    dom.restore()
  }
})

test('a count that arrives after the question was answered changes nothing and is not an error', async () => {
  const status = deferred<ReferenceStatus | null>()
  const ui = open({ reason: 'override', residualM: 0.4 }, () => status.promise)
  try {
    ui.part('frame-replace-cancel').click()
    assert.equal(await ui.answer, false)
    status.resolve(statusWith(5))
    await settle()
    assert.equal(ui.card.hidden, false, 'the card was given back once and is not touched again')
    assert.equal(ui.text().scans, 'Checking which scans use it…', 'the dialog that is gone is not redrawn')
  } finally {
    ui.restore()
  }
})

test('an offline phone is told where the new reference goes', async () => {
  const ui = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(null), true)
  try {
    await settle()
    const line = ui.part('frame-replace-offline')
    assert.equal(line.hidden, false)
    assert.equal(line.textContent, 'No connection. The new reference is kept on this phone and sent when it is back online.')
    ui.part('frame-replace-cancel').click()
    await ui.answer
  } finally {
    ui.restore()
  }
  const online = open({ reason: 'override', residualM: 0.4 }, () => Promise.resolve(statusWith(0)), false)
  try {
    await settle()
    assert.equal(online.part('frame-replace-offline').hidden, true)
    online.part('frame-replace-cancel').click()
    await online.answer
  } finally {
    online.restore()
  }
})
