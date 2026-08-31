/**
 * Words before the camera — the start screen's budget, computed without a
 * browser.
 *
 * `tests/mock-scanner-startup-budget.spec.ts` measures this by rendering the
 * page and reading `innerText`. That is the ground truth and it stays, but it
 * only runs where a browser and a Vite server do: GitHub CI never runs
 * Playwright at all (.github/workflows/deno-ci.yml installs with `deno install`
 * and runs no browser), so the assertion was dark everywhere except a local
 * `npm run loop`. It went 20 words over in #223 and nothing said so.
 *
 * Everything the start screen says is knowable statically, so this module
 * computes the same number from source:
 *
 *   - the static chrome (brand, the subject question, the subject chips, the
 *     editor card) is parsed out of index.html, so new prose added there is
 *     counted rather than missed;
 *   - the method cards are written at runtime by `renderCaptureChoice()` from
 *     `resolveCapture()` (src/capture/capture-intent.ts), which is pure, so
 *     their words come from the same table the screen draws from;
 *   - the onboarding steps are static in index.html.
 *
 * That buys the thing a single browser sample cannot: the count for EVERY
 * subject x device, not just the one combination the mock happens to render.
 * It matters here — the mock renders 140 words, and the worst real case is 151
 * (a room or a building on a phone that advertises WebXR without having proven
 * it, which is the XREAL Beam Pro this capture ladder was built for, and which
 * adds an eleven-word hedge on top of three cards).
 *
 * ## What this does NOT count
 *
 * `#ar-help` — the one or two sentences main.ts writes when no live path
 * exists at all ("To capture live, open this page in Safari, or install
 * HelloXR", 11 words). Its text is built inline in `showArHelp()` from the user
 * agent, not from a pure module, and mirroring those strings here would let
 * them drift silently. Excluding it is safe for the ceiling: the devices that
 * show it are the ones with no live rung, which top out at 123 words here, so
 * even with the sentence added they land ~17 short of the 151 that sets the
 * budget. If a live-capable device ever grows an `#ar-help`, that assumption is
 * void and this needs revisiting.
 *
 * The Playwright spec is what proves this model matches the DOM: it renders the
 * page and asserts the browser's own count equals `wordsBeforeCamera()` for the
 * combination it renders. Model and reality cannot drift apart silently in
 * either direction — verified both ways on 2026-08-30 by perturbing index.html:
 * five words added to the static chrome moved browser and model together
 * (100 -> 105 each), and five words added INSIDE a method card — the one place
 * this model is deliberately blind, because those subtrees are runtime-owned —
 * moved only the browser, and the spec failed naming both numbers. That blind
 * spot is the reason the spec keeps measuring rather than being deleted.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SUBJECT_CHOICES,
  resolveCapture,
  type CaptureControlId,
  type CaptureSubject,
  type DeviceCapture,
  type MethodPlan,
} from '../../src/capture/capture-intent.ts'

// ── The budget ──────────────────────────────────────────────────────────────

/**
 * Every word a first-run visitor reads before the camera opens: the onboarding
 * bodies plus the whole start screen.
 *
 * Re-baselined 2026-08-30 from 120, against a measured worst case of 151.
 *
 * The 120 was set in #205/#208 against a screen that showed two method cards
 * and asked nothing (measured ~98 with onboarding). #223 changed what the
 * screen is: it asks "What are you capturing?" and then shows every method
 * that can actually run here, recommended one first, because the person is no
 * longer expected to know whether their phone can run a live capture. That is
 * +8 words of question and +25 for a third card that is a real capture path
 * (a tripod sweep) rather than a repackaging of an old one.
 *
 * It is a re-baseline and not a trim because no word on this screen is free:
 * each card's second sentence carries what the path does NOT give you ("size
 * is not measured", "nothing catalogued"), which is the truthfulness
 * commitment wave 04 bought and which tests/unit/node/capture_intent.test.ts
 * pins in place. Cutting 31 words to fit the old ceiling means retracting
 * claims, and the honest alternative — putting the un-recommended methods one
 * tap behind a disclosure control, which index.html's own comments still
 * describe and which `renderCaptureChoice()`'s dead `alternatives` counter is
 * the stub of — is a design change and belongs in its own ticket. Finishing it
 * would take ~50 words off this screen and this ceiling should come back down
 * with it.
 *
 * The slack is deliberately thin (4 words). The screen is at its limit: the
 * next thing added to it is a decision, not a drift.
 */
export const WORDS_BEFORE_CAMERA_MAX = 155

/**
 * One method card — title, what you do, what you get. Measured worst: 26.
 *
 * The total above can be met by a screen that balloons one card and starves
 * another, so the per-card ceiling is what actually keeps a card readable.
 */
export const METHOD_CARD_WORDS_MAX = 30

/**
 * The static start-screen furniture: brand, question, subject chips, editor
 * card. Measured: 25.
 *
 * Separate from the total because it is the channel a browser sample is worst
 * at noticing — prose added straight to index.html arrives with no code change
 * anywhere near the resolver.
 */
export const START_SCREEN_CHROME_MAX = 28

/** Onboarding bodies. Measured: 40. Same ceiling the Playwright spec holds. */
export const ONBOARDING_WORDS_MAX = 60

// ── Counting ────────────────────────────────────────────────────────────────

/**
 * Words in rendered text, ignoring collapsed whitespace.
 *
 * Identical to the spec's browser-side counter, deliberately — including that
 * a bare em dash counts as a word. Two counters that "obviously" agree are how
 * the parity assertion would end up comparing nothing.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function indexHtml(): string {
  return readFileSync(`${REPO_ROOT}index.html`, 'utf8')
}

/**
 * Elements with no closing tag, so they never open a subtree. The SVG shapes
 * are in here for the same reason the HTML ones are: the start screen's icons
 * are inline `<path>`/`<circle>`/`<rect>`, and treating one as a container
 * would swallow the rest of the card.
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop',
])

/** Subtrees that carry no words a person reads, whatever is inside them. */
const MUTE_TAGS = new Set(['svg', 'style', 'script'])

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
}

function decode(text: string): string {
  return text.replace(/&[a-zA-Z#0-9]+;/g, (e) => ENTITIES[e] ?? e)
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return m ? (m[2] ?? m[3] ?? '') : null
}

/**
 * The text a browser would render inside `#<rootId>`, from source alone.
 *
 * Skips three things, and each omission is a claim the parity assertion in the
 * Playwright spec has to survive: subtrees carrying the `hidden` attribute
 * (the runtime slots — `#capture-note`, `#ar-help`, `#upload-video-open` — and
 * the two method cards that ship hidden), subtrees named in `skipIds` (the
 * method cards, whose every word including the `.start-path-status` line is
 * rewritten by `renderCaptureChoice()`), and `<svg>`/`<style>`/`<script>`.
 *
 * A tag-stack walk rather than a regex per element: `hidden` has to hide a
 * subtree, not a tag, and getting that wrong under-counts, which is the one
 * failure mode a budget must not have.
 */
export function staticVisibleText(html: string, rootId: string, skipIds: string[] = []): string {
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  const stack: string[] = []
  let rootDepth = -1
  let skipDepth = -1
  let cursor = 0
  let out = ''
  let found = false

  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (rootDepth >= 0 && skipDepth < 0) out += ` ${decode(html.slice(cursor, m.index))} `
    cursor = token.lastIndex
    if (m[0].startsWith('<!--')) continue

    const [, closing, rawName, attrs, selfClosed] = m
    const name = (rawName ?? '').toLowerCase()

    if (closing) {
      // Pop to the matching open tag; unbalanced markup pops nothing rather
      // than unwinding the whole document.
      const at = stack.lastIndexOf(name)
      if (at < 0) continue
      stack.length = at
      if (skipDepth >= 0 && stack.length <= skipDepth) skipDepth = -1
      if (rootDepth >= 0 && stack.length <= rootDepth) break
      continue
    }

    if (VOID_TAGS.has(name) || selfClosed === '/') continue

    stack.push(name)
    const depth = stack.length - 1
    const id = attr(attrs ?? '', 'id')
    if (rootDepth < 0 && id === rootId) {
      rootDepth = depth
      found = true
      continue
    }
    if (rootDepth < 0 || skipDepth >= 0) continue
    // Anchored on whitespace, not a word boundary: `\bhidden\b` also matches
    // the tail of `aria-hidden="true"`, which every icon span on this screen
    // carries and which a browser still PAINTS — it hides from the
    // accessibility tree, not from innerText. That reading would have skipped
    // whole subtrees and under-counted, which is the one way a budget fails
    // silently.
    const hidden = /(?:^|\s)hidden(?=\s|=|$)/i.test(attrs ?? '')
    if (hidden || MUTE_TAGS.has(name) || (id !== null && skipIds.includes(id))) skipDepth = depth
  }

  if (!found) throw new Error(`startup-budget: no #${rootId} in index.html — the scanner is reading the wrong markup`)
  return out
}

// ── The screen ──────────────────────────────────────────────────────────────

/** The controls `renderCaptureChoice()` owns. Same ids, no new ones (ADR 0001). */
const METHOD_CONTROLS: CaptureControlId[] = ['start-ar-btn', 'start-tripod-card', 'start-upload-card']

export interface StaticCopy {
  /** Brand, subject question, subject chips, editor card. */
  chrome: number
  /** The onboarding step bodies — `.onboard-desc`, what the spec counts. */
  onboarding: number
  /** For failure messages: the chrome, as it reads. */
  chromeText: string
}

/**
 * Read the parts of the screen that are literals in index.html.
 *
 * Throws rather than returning zero when the markup it expects is gone — a
 * scraper that silently finds nothing turns a budget into a test that always
 * passes.
 */
export function readStaticCopy(html: string = indexHtml()): StaticCopy {
  const chromeText = staticVisibleText(html, 'start-screen', METHOD_CONTROLS)
  const chrome = countWords(chromeText)
  if (chrome === 0) throw new Error('startup-budget: #start-screen scanned to no words at all')

  const steps = html.match(/class="onboard-step\b/g)?.length ?? 0
  const descs = [...html.matchAll(/<div class="onboard-desc">([\s\S]*?)<\/div>/g)]
    .map((m) => decode((m[1] ?? '').replace(/<[^>]*>/g, ' ')))
  if (descs.length === 0) throw new Error('startup-budget: no .onboard-desc found in index.html')
  if (descs.length !== steps) {
    throw new Error(`startup-budget: ${steps} onboarding steps but ${descs.length} bodies — the scanner is missing copy`)
  }

  return { chrome, onboarding: descs.reduce((a, d) => a + countWords(d), 0), chromeText }
}

export interface ScreenWords {
  /** Onboarding bodies + everything on the start screen. */
  total: number
  onboarding: number
  /** Static start-screen furniture. */
  chrome: number
  /** One entry per method card actually drawn, best first. */
  cards: Array<{ control: CaptureControlId, method: string, words: number, text: string }>
  /** `#capture-note`, when the resolver has something to say. */
  note: number
}

/**
 * What the screen says for one subject on one device.
 *
 * The card selection mirrors `renderCaptureChoice()` exactly, including the
 * rule that the first plan to claim a control keeps it — a video and a photo
 * set are the same tap, and counting both would invent words the screen never
 * shows.
 */
export function wordsBeforeCamera(
  subject: CaptureSubject,
  device: DeviceCapture,
  copy: StaticCopy = readStaticCopy(),
): ScreenWords {
  const rec = resolveCapture(subject, device)
  const byControl = new Map<CaptureControlId, MethodPlan>()
  for (const plan of [rec.best, ...rec.alternatives]) {
    if (!byControl.has(plan.control)) byControl.set(plan.control, plan)
  }

  const cards = [...byControl.entries()].map(([control, plan]) => {
    const text = `${plan.title} ${plan.action} ${plan.result}`
    return { control, method: plan.method, words: countWords(text), text }
  })
  const note = rec.note ? countWords(rec.note) : 0
  const total = copy.onboarding + copy.chrome + cards.reduce((a, c) => a + c.words, 0) + note

  return { total, onboarding: copy.onboarding, chrome: copy.chrome, cards, note }
}

/** Every subject the screen offers. */
export const SUBJECTS: CaptureSubject[] = SUBJECT_CHOICES.map((c) => c.subject)

/**
 * The device shapes the start screen is actually drawn for, named.
 *
 * Not the 18-way combinatorial sweep capture_intent.test.ts runs — that one is
 * asking whether any device dead-ends. This is asking how many words each real
 * screen shows, so it lists the states a phone is genuinely in, including the
 * one that costs the most: WebXR advertised but never proven, which is what a
 * Beam Pro reports and what earns the hedge line.
 */
export const DEVICE_SHAPES: ReadonlyArray<{ name: string, device: DeviceCapture }> = [
  { name: 'native proven', device: { secureContext: true, nativeAr: 'yes', browserAr: 'no' } },
  { name: 'native advertised, unproven', device: { secureContext: true, nativeAr: 'unknown', browserAr: 'no' } },
  { name: 'in-browser engine loaded (the mock)', device: { secureContext: true, nativeAr: 'no', browserAr: 'yes' } },
  { name: 'native advertised + in-browser loaded', device: { secureContext: true, nativeAr: 'unknown', browserAr: 'yes' } },
  { name: 'no live capture at all', device: { secureContext: true, nativeAr: 'no', browserAr: 'no' } },
  { name: 'insecure page', device: { secureContext: false, nativeAr: 'unknown', browserAr: 'yes' } },
]

export interface Case { subject: CaptureSubject, deviceName: string, device: DeviceCapture, words: ScreenWords }

/** Every screen this can draw, worst (most words) first. */
export function allCases(copy: StaticCopy = readStaticCopy()): Case[] {
  const out: Case[] = []
  for (const subject of SUBJECTS) {
    for (const { name, device } of DEVICE_SHAPES) {
      out.push({ subject, deviceName: name, device, words: wordsBeforeCamera(subject, device, copy) })
    }
  }
  return out.sort((a, b) => b.words.total - a.words.total)
}

/**
 * What the mock renders: subject `room` (preselected) on a device where only
 * the in-browser engine loaded (`?mock=xr8`). The combination the Playwright
 * spec measures, and the anchor the two counts are compared at.
 */
export const MOCK_CASE = {
  subject: 'room' as CaptureSubject,
  device: { secureContext: true, nativeAr: 'no', browserAr: 'yes' } as DeviceCapture,
}
