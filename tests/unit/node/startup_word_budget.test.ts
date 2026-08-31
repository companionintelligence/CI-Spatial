/**
 * Words before the camera, on every screen — not just the one a mock can reach.
 *
 * tests/mock-scanner-startup-budget.spec.ts measures what Chromium actually
 * paints under `?mock=xr8`. That is one device (a browser where the in-page
 * engine loads and nothing else is claimed) out of the 72 subject x device
 * combinations `resolveCapture()` is total over, and it is not the expensive
 * one. The expensive one is the phone this whole flow was built for — an XREAL
 * Beam Pro, which advertises a live capture it cannot run — because that screen
 * pays an 11-word hedge on top of everything else, and no mock reaches it.
 *
 * So this test computes the same total the browser measures, from the two
 * places the words actually come from:
 *
 *   - the resolver (src/capture/capture-intent.ts) for the method copy, which
 *     is where the card text is really written — the markup only carries the
 *     first paint, and `renderCaptureChoice()` overwrites it;
 *   - index.html for the static chrome that has no TypeScript source: the
 *     brand block, the subject question, the disclosure's label and the editor
 *     card.
 *
 * The arithmetic is checked against a real browser rather than trusted: the
 * pinned totals below are the numbers Playwright measured on the same build
 * (92 under the mock), so if this model of the screen ever stops matching the
 * screen, the two suites disagree out loud.
 *
 * Run: node --experimental-strip-types --test tests/unit/node/startup_word_budget.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  resolveCapture,
  type Availability,
  type CaptureControlId,
  type CaptureSubject,
  type DeviceCapture,
  type MethodPlan,
} from '../../../src/capture/capture-intent.ts'
import { WORDS_BEFORE_CAMERA_MAX, countWords } from '../../support/startup-budget.ts'

const SUBJECTS: CaptureSubject[] = ['room', 'place', 'object', 'person']
const AVAILABILITIES: Availability[] = ['yes', 'no', 'unknown']

/** Every shape of device this can be handed: 3 x 3 x 2 = 18, as next door. */
function allDevices(): DeviceCapture[] {
  const out: DeviceCapture[] = []
  for (const secureContext of [true, false]) {
    for (const nativeAr of AVAILABILITIES) {
      for (const browserAr of AVAILABILITIES) out.push({ secureContext, nativeAr, browserAr })
    }
  }
  return out
}

const describe = (subject: CaptureSubject, device: DeviceCapture) =>
  `${subject} / secure=${device.secureContext} native=${device.nativeAr} browser=${device.browserAr}`

// ── Reading the static chrome out of index.html ──────────────────────────────

const html = stripComments(
  readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8'),
)

/** Comments are not on screen, and this file's are longer than its markup. */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * The rendered text of one element, by id.
 *
 * Deliberately only ever pointed at elements whose whole subtree is on screen
 * whenever the element is — the brand block, the question, the editor card,
 * the disclosure. It is NOT pointed at `#start-ar-btn`, whose subtree carries
 * a `.start-path-status` line that CSS shows only while the button is
 * disabled: counting it here would charge the budget for a word the ready
 * screen does not show. The card copy comes from the resolver instead, which
 * is where it is really written.
 */
function textOfId(id: string): string {
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\sid="${id}"[^>]*>`)
  const found = open.exec(html)
  assert.ok(found, `#${id} is not in index.html — this test is measuring a screen that moved`)
  const tag = found[1]
  const start = found.index + found[0].length
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g')
  tags.lastIndex = start
  let depth = 1
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (m[1] === '/') {
      depth -= 1
      if (depth === 0) return stripTags(html.slice(start, m.index))
    } else if (m[2] !== '/') {
      depth += 1
    }
  }
  throw new Error(`#${id} is never closed in index.html`)
}

/** Elements sharing a class, for the onboarding bodies. Flat divs, no nesting. */
function textOfClass(className: string): string[] {
  const re = new RegExp(`<div\\b[^>]*\\sclass="${className}"[^>]*>([\\s\\S]*?)</div>`, 'g')
  const out: string[] = []
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(stripTags(m[1]))
  assert.ok(out.length > 0, `.${className} is not in index.html`)
  return out
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The two onboarding bodies, which the budget counts alongside the screen. */
const ONBOARDING_WORDS = textOfClass('onboard-desc').reduce((a, t) => a + countWords(t), 0)

/**
 * Everything on `#start-screen` that is not a capture card: the brand block,
 * the subject question and its four chips, the disclosure's own label, and the
 * editor card — which stays open behind the disclosure like the recommendation
 * does, because "the places already scanned" is not one of the ways to capture
 * a new one.
 */
const CHROME_WORDS = countWords(textOfId('start-brand'))
  + countWords(textOfId('capture-intent'))
  + countWords(textOfId('start-editor-card'))

/** The disclosure, charged only to the screens that actually show one. */
const TOGGLE_WORDS = countWords(textOfId('start-alt-toggle'))

// ── The screen, as words ─────────────────────────────────────────────────────

const cardWords = (plan: MethodPlan) =>
  countWords(plan.title) + countWords(plan.action) + countWords(plan.result)

interface Screen {
  /** What a first-run visitor reads before the camera, list collapsed. */
  collapsed: number
  /** The same screen with the disclosure open — what shipped before it existed. */
  expanded: number
  /** How many methods sit behind the disclosure. Zero means there is none. */
  alternatives: number
}

/**
 * Model one start screen, the way `renderCaptureChoice()` draws it.
 *
 * The one subtlety it has to reproduce: a video and a photo set are the same
 * control, so the first plan to claim `#start-upload-card` keeps it and the
 * second is never a second card. Counting plans instead of controls would
 * invent a card the screen does not have.
 */
function screenFor(subject: CaptureSubject, device: DeviceCapture): Screen {
  const rec = resolveCapture(subject, device)
  const byControl = new Map<CaptureControlId, MethodPlan>()
  for (const plan of [rec.best, ...rec.alternatives]) {
    if (!byControl.has(plan.control)) byControl.set(plan.control, plan)
  }
  const alternatives = byControl.size - 1
  const note = countWords(rec.note ?? '')
  const chrome = ONBOARDING_WORDS + CHROME_WORDS + (alternatives > 0 ? TOGGLE_WORDS : 0) + note
  const alternativeWords = [...byControl.entries()]
    .filter(([control]) => control !== rec.best.control)
    .reduce((a, [, plan]) => a + cardWords(plan), 0)
  return {
    collapsed: chrome + cardWords(rec.best),
    expanded: chrome + cardWords(rec.best) + alternativeWords,
    alternatives,
  }
}

// ── The tests ────────────────────────────────────────────────────────────────

test('the model of the screen agrees with what a browser measured', () => {
  // The pinned numbers are Playwright's, from mock-scanner-startup-budget on
  // the build that landed the disclosure. Everything below is arithmetic over
  // the resolver and index.html; this is the one assertion that ties that
  // arithmetic to a screen a browser actually painted, so a drift between the
  // model and the markup fails here rather than silently making every other
  // number in this file meaningless.
  assert.equal(ONBOARDING_WORDS, 40, 'onboarding bodies (Playwright measured 40)')
  assert.equal(CHROME_WORDS, 25, 'brand + question + editor card (measured 7 + 8 + 10)')
  assert.equal(TOGGLE_WORDS, 2, 'the disclosure label is two words, and is charged like any other')

  // The mock: an in-page engine that loaded, nothing else claimed. This is the
  // exact screen the Playwright spec walks.
  const mock = screenFor('room', { secureContext: true, nativeAr: 'no', browserAr: 'yes' })
  assert.equal(mock.collapsed, 92, 'words before the camera under ?mock=xr8 (Playwright measured 92)')
  assert.equal(mock.expanded, 142, 'the same screen with both alternatives open')
})

test('the overrun is the un-recommended methods, not the recommendation', () => {
  // The finding that put the alternatives behind a disclosure instead of
  // taking a knife to the copy. Two claims, and the second is the load-bearing
  // one: every screen fits when only the recommendation is on it, and the
  // screens that do NOT fit are exactly the ones showing methods nobody was
  // recommended. Cutting words from the cards would therefore have been
  // cutting the wrong thing — and the only words left to cut are the clauses
  // capture_intent.test.ts pins ("size is not measured", "nothing
  // catalogued"), which is how a word budget turns into a screen that lies.
  let overran = 0
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const screen = screenFor(subject, device)
      const where = describe(subject, device)
      assert.ok(
        screen.collapsed <= WORDS_BEFORE_CAMERA_MAX,
        `${where}: the recommendation alone is ${screen.collapsed} words, over the ${WORDS_BEFORE_CAMERA_MAX} budget`,
      )
      if (screen.expanded > WORDS_BEFORE_CAMERA_MAX) {
        overran += 1
        assert.ok(
          screen.alternatives > 0,
          `${where}: over budget with nothing un-recommended on screen — the copy is the problem after all`,
        )
      }
    }
  }
  assert.ok(overran > 0, 'nothing overran even with every method open — this test is proving nothing')
})

test('the worst screen is the phone this flow was built for, and it fits', () => {
  // Room or building on a device that advertises a live capture it has not
  // been seen to run — the XREAL Beam Pro, whose browser answers
  // isSessionSupported('immersive-ar') with true and nothing behind it. It is
  // the most expensive screen because it is the only one that pays the hedge
  // ("If this does not start, the other ways here still work.") on top of a
  // full-length recommendation, and no mock can reach it.
  let worst = { total: -1, where: '', open: -1 }
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const screen = screenFor(subject, device)
      if (screen.collapsed > worst.total) {
        worst = { total: screen.collapsed, where: describe(subject, device), open: screen.expanded }
      }
    }
  }
  assert.equal(worst.total, 103, `the worst screen before the camera (${worst.where})`)
  // What it was when every runnable method shipped open. The budget was
  // re-baselined to 155 to accommodate this screen rather than fixed; 153 is
  // that same screen plus the disclosure's own two words.
  assert.equal(worst.open, 153, 'the same screen with every method open, which is what overran')
  assert.ok(
    worst.total <= WORDS_BEFORE_CAMERA_MAX,
    `the worst screen must fit the budget, not the budget the worst screen`,
  )
  // Headroom, so a cosmetic edit does not trip this and a real regression
  // does. The alternatives are ~25 words each: putting one back on screen
  // unconditionally must fail.
  assert.ok(
    worst.total + 25 > WORDS_BEFORE_CAMERA_MAX,
    'the budget is loose enough to let a whole card back in without failing',
  )
})

test('a screen with nothing to disclose is not charged for a disclosure', () => {
  // `renderCaptureChoice()` hides the control when there is nothing behind it,
  // so those screens must not be paying two words for a button nobody sees —
  // and there has to be at least one such screen, or the branch is dead code.
  let found = 0
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const screen = screenFor(subject, device)
      if (screen.alternatives > 0) continue
      found += 1
      assert.equal(
        screen.collapsed,
        screen.expanded,
        `${describe(subject, device)}: nothing to open, so opening it must change nothing`,
      )
    }
  }
  assert.ok(found > 0, 'no screen has a single runnable method — the hidden-toggle branch is unreachable')
})
