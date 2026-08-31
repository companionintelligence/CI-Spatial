/**
 * The startup word budget, held where it will actually be read.
 *
 * `tests/mock-scanner-startup-budget.spec.ts` has asserted since #205 that a
 * first-run visitor reads at most 120 words before the camera opens. On
 * 2026-08-30 the real number was 140, and had been since #223 — the screen
 * grew a subject question and a third capture card, and nothing said so,
 * because GitHub CI runs no Playwright at all (.github/workflows/deno-ci.yml)
 * and the only gate that does run that spec is a local `npm run loop`.
 *
 * So the budget moved here, where `npm run verify` — and therefore the
 * pre-push hook — runs it with no browser, no Vite server and no seeded
 * corpus. The spec keeps its DOM measurement, and now checks it against this
 * model rather than against a literal, so the two cannot drift apart.
 *
 * The model is not a second copy of the screen: the static half is parsed out
 * of index.html and the card half comes from `resolveCapture()`, the same pure
 * function `renderCaptureChoice()` draws from. See tests/support/startup-budget.ts.
 *
 * Run: npm run test:startup:budget
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  METHOD_CARD_WORDS_MAX,
  MOCK_CASE,
  ONBOARDING_WORDS_MAX,
  START_SCREEN_CHROME_MAX,
  SUBJECTS,
  WORDS_BEFORE_CAMERA_MAX,
  allCases,
  countWords,
  readStaticCopy,
  staticVisibleText,
  wordsBeforeCamera,
} from '../../support/startup-budget.ts'

const where = (c: { subject: string, deviceName: string }) => `${c.subject} / ${c.deviceName}`

test('every screen this can draw stays under the word budget', () => {
  // The point of computing rather than sampling. A browser run measures one
  // combination; this is all 24. The mock renders 140 words and the worst real
  // screen is 151 — a room or a building on a phone that advertises WebXR
  // without having proven it, which is the exact device (XREAL Beam Pro) the
  // capture ladder was built for, and which pays an extra eleven-word hedge on
  // top of three cards. Re-baselining against the convenient sample is the
  // mistake the occlusion budget next door already documents.
  const cases = allCases()
  const worst = cases[0]!
  for (const c of cases) {
    assert.ok(
      c.words.total <= WORDS_BEFORE_CAMERA_MAX,
      `${where(c)}: ${c.words.total} words before the camera, budget ${WORDS_BEFORE_CAMERA_MAX}`
      + ` (onboarding ${c.words.onboarding} + chrome ${c.words.chrome}`
      + ` + cards ${c.words.cards.map((x) => x.words).join('+')} + note ${c.words.note})`,
    )
  }
  // Pinned, not just bounded: this repo's comments cite measured numbers, and
  // the constant's own reasoning names this screen and this total. If the copy
  // changed on purpose, re-measure, update this literal, and say in
  // WORDS_BEFORE_CAMERA_MAX why the new number is the right ceiling.
  assert.equal(
    worst.words.total, 151,
    `the worst screen is now ${where(worst)} at ${worst.words.total} words, not 151`,
  )
})

test('the overrun is the un-recommended methods, not the recommendation', () => {
  // This is the claim that says the fix is a design change and not a copy cut,
  // so it is checked rather than asserted in a comment: what the person is
  // actually being told to do — question, recommended card, hedge — still fits
  // the ORIGINAL 120-word ceiling on every screen. The words over it are the
  // two methods they were not recommended, sitting open instead of one tap
  // away (index.html's own comment at #start-upload-card still describes them
  // as hidden, and renderCaptureChoice()'s unused `alternatives` counter is
  // what is left of the control that would have done it).
  for (const c of allCases()) {
    const recommended = c.words.onboarding + c.words.chrome + (c.words.cards[0]?.words ?? 0) + c.words.note
    assert.ok(
      recommended <= 120,
      `${where(c)}: the recommendation alone is ${recommended} words — the overrun is no longer the alternatives`,
    )
  }
})

test('no single method card outgrows its card', () => {
  // A total budget can be met by a screen that balloons one card and starves
  // another. This is the one that keeps a card readable on a 375px phone.
  for (const c of allCases()) {
    for (const card of c.words.cards) {
      assert.ok(
        card.words <= METHOD_CARD_WORDS_MAX,
        `${where(c)} / ${card.method}: ${card.words} words on one card — "${card.text}"`,
      )
    }
  }
})

test('the static start-screen furniture stays furniture', () => {
  // The channel a browser sample notices least: prose added straight to
  // index.html arrives with no code change anywhere near the resolver, which
  // is how the subject question landed unmeasured.
  const { chrome, chromeText } = readStaticCopy()
  assert.ok(
    chrome <= START_SCREEN_CHROME_MAX,
    `#start-screen's own copy is ${chrome} words, budget ${START_SCREEN_CHROME_MAX}: "${chromeText.replace(/\s+/g, ' ').trim()}"`,
  )
})

test('onboarding stays two short steps', () => {
  assert.ok(
    readStaticCopy().onboarding <= ONBOARDING_WORDS_MAX,
    `onboarding bodies are ${readStaticCopy().onboarding} words, budget ${ONBOARDING_WORDS_MAX}`,
  )
})

test('the scanner reads the screen a browser paints, not a different one', () => {
  // A word budget's one unacceptable failure is under-counting: a scraper that
  // quietly stops finding elements makes the ceiling unreachable and the test
  // green forever. These pin both directions of that.
  const { chromeText } = readStaticCopy()

  // Everything static that IS on screen. Chrome rendered exactly this list on
  // 2026-08-30 at 375x812, in this order.
  for (const shown of [
    'Companion Intelligence', 'Spatial Memory', 'Private 4D Capture',
    'What are you capturing?', 'Room', 'Building', 'Object', 'Person',
    'Place Scan Editor', 'Open and edit the places already scanned.',
  ]) {
    assert.ok(chromeText.includes(shown), `#start-screen no longer scans to "${shown}" — the scanner is under-counting`)
  }

  // And nothing that is not. `Preparing…` is inside a method card, whose every
  // word renderCaptureChoice() rewrites; the other two ship `hidden` and would
  // be counted twice or wrongly if the subtree rules broke.
  for (const absent of ['Preparing', 'Processing started', 'size is not measured']) {
    assert.ok(!chromeText.includes(absent), `#start-screen scanned up "${absent}" — a skipped subtree is being counted`)
  }
})

test('the scanner hides what a browser hides, and nothing else', () => {
  // The rules, stated against markup small enough to check by eye. The
  // aria-hidden line is the one that was actually wrong: `\bhidden\b` matches
  // the tail of `aria-hidden`, every icon on this screen carries one, and
  // aria-hidden hides from the accessibility tree while the browser paints the
  // text as usual. A budget that skipped those subtrees would under-count, and
  // under-counting is the failure a ceiling cannot survive.
  const html = `<main id="root">
    <p>four plain words here</p>
    <p hidden>hidden from everyone</p>
    <p aria-hidden="true">painted so counted</p>
    <p data-hidden="true">also counted</p>
    <span class="icon" aria-hidden="true"><svg><title>muted</title></svg></span>
    <section id="runtime-owned">rewritten at runtime</section>
  </main>`
  const text = staticVisibleText(html, 'root', ['runtime-owned'])

  // 4 + 3 + 2: the plain line, the aria-hidden line, the data-hidden line.
  assert.equal(countWords(text), 9, `counted "${text.replace(/\s+/g, ' ').trim()}"`)
  assert.ok(text.includes('painted so counted'), 'aria-hidden is not display:none')
  assert.ok(text.includes('also counted'), 'data-hidden is not the hidden attribute')
  assert.ok(!text.includes('hidden from everyone'), 'the hidden attribute must hide the subtree')
  assert.ok(!text.includes('muted'), 'svg contents are not words on the screen')
  assert.ok(!text.includes('rewritten'), 'runtime-owned subtrees come from the resolver instead')
  assert.throws(() => staticVisibleText(html, 'not-here'), /no #not-here/, 'a missing root must fail loudly')
})

test('the mock screen is the one the Playwright spec measures', () => {
  // The anchor for the parity assertion in
  // tests/mock-scanner-startup-budget.spec.ts: `?mock=xr8` loads the
  // in-browser engine and nothing else, and `room` is preselected. Measured in
  // Chrome at 375x812 on 2026-08-30: 40 onboarding + 100 start screen = 140.
  const mock = wordsBeforeCamera(MOCK_CASE.subject, MOCK_CASE.device)
  assert.equal(mock.cards.length, 3, 'the mock screen shows a recommendation and two alternatives')
  assert.equal(mock.note, 0, 'a proven engine gets no hedge')
  // Pinned to a browser measurement, so it cannot go stale in silence. If the
  // copy changed on purpose, re-run the spec (npm run loop --only=ui) and put
  // the number it reports here.
  assert.equal(
    mock.total, 140,
    `the model now says ${mock.total}; Chrome said 140 on 2026-08-30 — re-measure before trusting either`,
  )
})

test('every subject has a screen', () => {
  // Cheap, and it is what makes the sweep above exhaustive rather than
  // whatever four subjects were current when it was written.
  assert.deepEqual(SUBJECTS, ['room', 'place', 'object', 'person'])
})
