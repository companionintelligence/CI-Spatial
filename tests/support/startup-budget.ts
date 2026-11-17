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
 * It matters here. The mock renders 119 words. The worst screen before the boot
 * line is 130: a room or a building on a phone that advertises WebXR without
 * having proven it, which is the XREAL Beam Pro this capture ladder was built
 * for, and which adds a twelve-word hedge on top of its recommendation. With
 * that phone's boot line (bootHelpWords()) it is 142, the ceiling itself.
 *
 * ## The boot-written help line
 *
 * `#ar-help` is written at boot, and it is counted here rather than left out.
 * The screen's own words are `total`, the boot line is `bootHelp`, and the
 * ceiling is held to `withBootHelp`, their sum. `total` keeps measuring the
 * screen as drawn, so the pinned counts keep their meaning.
 *
 * `bootHelpWords()` takes the longest text probeVerdict() can write for a device
 * class, and the longest line of main.ts's `showArHelp()` for the classes that
 * reach it. The insecure line is charged though the boot never writes it: main.ts
 * returns before the probe on an insecure page. `showArHelp()` is inline in main.ts
 * and imports nothing pure, so its lines are mirrored, and
 * `showArHelpLinesMissingFrom()` holds each one to
 * main.ts's source: an edit there fails a test instead of drifting past this.
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
  deviceFromProbe,
  resolveCapture,
  type CaptureControlId,
  type CaptureSubject,
  type DeviceCapture,
  type MethodPlan,
} from '../../src/capture/capture-intent.ts'
import { probeVerdict, type ProbeEnv } from '../../src/ar/preflight.ts'
import {
  SIGN_IN_FAILED,
  SIGNED_OUT,
  ftueRowText,
  ftueRows,
  type EngineStatus,
  type FtueSnapshot,
  type MemoryStatus,
  type ShellServer,
  type SignInStatus,
} from '../../src/ui/ftue-status.ts'

// ── The budget ──────────────────────────────────────────────────────────────

/**
 * Every word a first-run visitor reads before the camera opens: the onboarding
 * bodies plus the whole start screen.
 *
 * Brought back DOWN to 110 on 2026-08-30, against a measured worst case of
 * 103 — the design change the 155 was explicitly holding a place for.
 *
 * The history, because the number has moved twice and only the last move was
 * a fix. 120 was set in #205/#208 against a screen that showed two method
 * cards and asked nothing (~98 with onboarding). #223 changed what the screen
 * is — it asks "What are you capturing?" and then showed every method that can
 * run here — which cost +8 for the question and +25 for a third card, and took
 * the worst screen to 151. #226 re-baselined to 155 rather than trim, and said
 * why in this comment: no word on this screen is free, because each card's
 * second sentence carries what the path does NOT give you ("size is not
 * measured", "nothing catalogued"), which capture_intent.test.ts pins in
 * place. Cutting 31 words to fit meant retracting claims.
 *
 * It also named the honest alternative and predicted its size: put the
 * un-recommended methods one tap behind a disclosure control, worth ~50 words.
 * That is now built (`#start-alt-toggle`, renderCaptureChoice()), and the
 * prediction was good — the worst screen went 153 -> 103 and the mock 140 ->
 * 92. So the ceiling comes back down with it, as that comment said it should.
 *
 * 110 sits just above the worst case, the same rule the occlusion budget next
 * door follows. The seven words of slack are the point: an alternative card is
 * ~25 words, so nothing can quietly drift back onto this screen open.
 *
 * Raised to 142 when the first-run status rows landed. They sit on the second
 * onboarding step, so they are read before the camera, and their worst case is
 * 32 words (ftueStatusWordsMax()). The worst screen went 103 -> 135, and the
 * same seven words of slack went on top. That is a deliberate spend for the
 * rows the first-run screen now shows (Companion Memory, the model, sign-in),
 * not drift.
 *
 * Copy went to bullets on 2026-11-10: the worst screen dropped 135 -> 130.
 * The ceiling stays 142, so the slack grows by five words.
 *
 * The boot-written `#ar-help` line is counted too, as `withBootHelp` (see
 * bootHelpWords()). With it the worst screen is 142, on the native-advertised
 * page whose caveat is twelve words, so that screen has no slack left. The no-AR
 * screens for a place or a person reach 142 too, with their 14-word no-AR line.
 * A longer caveat has to come out of the copy; it cannot be paid for with this
 * ceiling.
 */
export const WORDS_BEFORE_CAMERA_MAX = 142

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
 * method cards, whose title, action and result renderCaptureChoice() writes, and
 * which wordsBeforeCamera() counts from the same table), and `<svg>`/`<style>`/`<script>`.
 *
 * Not counted: the `.start-path-status` line in the AR card. renderCaptureChoice()
 * never writes it. setStartButtonState() does, and CSS shows it only while the
 * start button is disabled. Its text is the label setStartButtonState() was given
 * (or "Not available on this device"), the "Preparing…" default from index.html,
 * or the "Still loading" line the inline script writes at 10 s.
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

/**
 * The disclosure holding the methods that were ranked and not chosen.
 *
 * Counted on its own rather than as chrome, because it is not always on the
 * screen: `renderCaptureChoice()` hides it when the recommendation is the only
 * runnable method, and a control that reveals nothing is worse than no
 * control. It ships `hidden`, so the chrome scan already skips it — naming it
 * in `skipIds` too is so that stops depending on an attribute in the markup
 * that exists for an unrelated reason.
 */
const DISCLOSURE_CONTROL = 'start-alt-toggle'

export interface StaticCopy {
  /** Brand, subject question, subject chips, editor card. */
  chrome: number
  /** The onboarding step bodies — `.onboard-desc`, what the spec counts. */
  onboarding: number
  /** `#start-alt-toggle`'s label, charged only to screens that show it. */
  disclosure: number
  /**
   * The first-run status rows, worst case over every answer the three endpoints
   * can give. Runtime-owned: computed from src/ui/ftue-status.ts, because the
   * markup ships `#ftue-status` empty (readStaticCopy checks that).
   */
  status: number
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
  const chromeText = staticVisibleText(html, 'start-screen', [...METHOD_CONTROLS, DISCLOSURE_CONTROL])
  const chrome = countWords(chromeText)
  if (chrome === 0) throw new Error('startup-budget: #start-screen scanned to no words at all')

  // Read out of its own subtree, not the chrome scan: the root's own `hidden`
  // is not applied by staticVisibleText, which is exactly what is wanted here
  // — the control ships hidden and is shown whenever anything is behind it.
  const disclosure = countWords(staticVisibleText(html, DISCLOSURE_CONTROL))
  if (disclosure === 0) throw new Error(`startup-budget: #${DISCLOSURE_CONTROL} scanned to no words at all`)

  const steps = html.match(/class="onboard-step\b/g)?.length ?? 0
  const descs = [...html.matchAll(/<div class="onboard-desc">([\s\S]*?)<\/div>/g)]
    .map((m) => decode((m[1] ?? '').replace(/<[^>]*>/g, ' ')))
  if (descs.length === 0) throw new Error('startup-budget: no .onboard-desc found in index.html')
  if (descs.length !== steps) {
    throw new Error(`startup-budget: ${steps} onboarding steps but ${descs.length} bodies — the scanner is missing copy`)
  }

  // The status rows are drawn at runtime, so the markup must ship the list empty,
  // on the second step, with nothing else in it. Static copy added there would be
  // counted by the browser spec and missed here.
  const list = html.match(/<ul id="ftue-status"[^>]*>([\s\S]*?)<\/ul>/)
  if (!list) throw new Error('startup-budget: no #ftue-status in index.html — the status rows are not on the first-run screen')
  if ((list[1] ?? '').trim() !== '') {
    throw new Error('startup-budget: #ftue-status ships static text — the rows are runtime-owned, so their copy belongs in src/ui/ftue-status.ts')
  }
  const at = html.indexOf('id="ftue-status"')
  if (!(html.indexOf('data-step="1"') < at && at < html.indexOf('id="onboard-next-btn"'))) {
    throw new Error('startup-budget: #ftue-status is not on the second onboarding step')
  }

  return {
    chrome,
    disclosure,
    onboarding: descs.reduce((a, d) => a + countWords(d), 0),
    status: ftueStatusWordsMax(),
    chromeText,
  }
}

/**
 * The status rows' worst case: the most words any combination of the three
 * endpoints' answers can put on the second onboarding step. Each endpoint's
 * possible answers are enumerated and the rows are the module's own, so this
 * number moves with the copy in src/ui/ftue-status.ts and nothing else.
 *
 * `shell` counts a native shell's screen instead, which adds its Server row
 * (no server set, set but silent, or set and answering). The host in that row
 * is one word, whatever it is. The browser's screen, and so every literal pinned
 * against it, is the default.
 */
export function ftueStatusWordsMax(shell = false): number {
  const memory: Array<MemoryStatus | typeof SIGNED_OUT | null> = [
    null,
    // Companion Memory's 401: the signed-out copy, which is shown while sign-in is on.
    SIGNED_OUT,
    { enabled: false },
    { enabled: true, reachable: false },
    { enabled: true, reachable: true },
    { enabled: true },
  ]
  const engine: Array<EngineStatus | null> = [
    null,
    ...(['loading', 'ready', 'failed'] as const).map((engineLoadState) => ({ model: 'Ollama/qwen3-vl:4b', engineLoadState })),
  ]
  const signIn: Array<SignInStatus | null> = [
    null,
    { enabled: false },
    { enabled: true },
    { enabled: true, signedIn: true },
    { enabled: true, problem: SIGN_IN_FAILED },
  ]
  const servers: Array<ShellServer | undefined> = shell
    ? [{ origin: null }, { origin: 'https://scan.example.ts.net:8443' }]
    : [undefined]
  let worst = 0
  for (const server of servers) for (const m of memory) for (const e of engine) for (const s of signIn) {
    const snap: FtueSnapshot = { memory: m, engine: e, signIn: s }
    worst = Math.max(worst, ftueRows(snap, server).reduce((a, row) => a + countWords(ftueRowText(row)), 0))
  }
  return worst
}

export interface ScreenWords {
  /**
   * Onboarding bodies + everything on the start screen as it first paints:
   * the chrome, the recommendation, the note, and the disclosure's own label.
   * The methods behind the disclosure are NOT in here — they are not on screen
   * until someone asks for them, which is the whole point of the control.
   * The boot-written #ar-help line is not in here either; it is `bootHelp`.
   */
  total: number
  /** The same screen with the disclosure open. What #223 shipped as `total`. */
  totalExpanded: number
  onboarding: number
  /** Static start-screen furniture. */
  chrome: number
  /** `#start-alt-toggle`'s label — 0 when there is nothing to disclose. */
  disclosure: number
  /**
   * One entry per method card the screen can draw, best first. The first is
   * the recommendation and is always on screen; the rest are one tap away.
   */
  cards: Array<{ control: CaptureControlId, method: string, words: number, text: string }>
  /** How many cards sit behind the disclosure. Zero means there is no control. */
  alternatives: number
  /** `#capture-note`, when the resolver has something to say. */
  note: number
  /**
   * The first-run status rows, worst case, on the second onboarding step. Counted
   * in `total`. The browser spec measures what they actually say and holds that
   * to this ceiling, not to equality, because the answers depend on the server.
   */
  status: number
  /**
   * The boot-written `#ar-help` line for this device class, worst case (see
   * bootHelpWords()). Not in `total`: the pinned counts measure the screen as it
   * is drawn, and this is added on top of that.
   */
  bootHelp: number
  /** `total` plus `bootHelp`: the number WORDS_BEFORE_CAMERA_MAX is held to. */
  withBootHelp: number
}

/**
 * What the screen says for one subject on one device.
 *
 * The card selection mirrors `renderCaptureChoice()` exactly, including the
 * rule that the first plan to claim a control keeps it — a video and a photo
 * set are the same tap, and counting both would invent words the screen never
 * shows.
 *
 * It also mirrors what that function puts ON the screen, which since the
 * disclosure landed is not the same as what it can draw: only the
 * recommendation is open, and `#start-alt-toggle` costs its own two words
 * whenever there is anything behind it. `totalExpanded` is the other state,
 * kept because the claim this budget rests on — that the overrun was the
 * un-recommended methods — is only checkable with both numbers in hand.
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
  const alternatives = cards.length - 1
  const disclosure = alternatives > 0 ? copy.disclosure : 0
  const fixed = copy.onboarding + copy.chrome + disclosure + note + copy.status
  const total = fixed + (cards[0]?.words ?? 0)
  const totalExpanded = fixed + cards.reduce((a, c) => a + c.words, 0)

  const bootHelp = bootHelpWords(device)

  return {
    total, totalExpanded, onboarding: copy.onboarding, chrome: copy.chrome,
    disclosure, cards, alternatives, note, status: copy.status,
    bootHelp, withBootHelp: total + bootHelp,
  }
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

// ── The boot-written help line ──────────────────────────────────────────────

/**
 * Every probe state the boot can hand to probeVerdict(): the four flags, all
 * sixteen combinations. Enumerated rather than listed, so a flag or a branch
 * added to the probe is swept without anyone adding a row here.
 */
export function allProbeEnvs(): ProbeEnv[] {
  const out: ProbeEnv[] = []
  for (const secureContext of [true, false]) {
    for (const xr8Loaded of [true, false]) {
      for (const webxrApi of [true, false]) {
        for (const immersiveArAdvertised of [true, false]) {
          out.push({ secureContext, xr8Loaded, webxrApi, immersiveArAdvertised })
        }
      }
    }
  }
  return out
}

function deviceKey(device: DeviceCapture): string {
  return String(device.secureContext) + '/' + device.nativeAr + '/' + device.browserAr
}

/** A readable name for a device class, for failure messages. */
function describeDevice(device: DeviceCapture): string {
  const page = device.secureContext ? 'secure page' : 'insecure page'
  const native = device.nativeAr === 'unknown'
    ? 'native advertised'
    : device.nativeAr === 'yes' ? 'native proven' : 'no native AR'
  const browser = device.browserAr === 'yes' ? 'in-browser engine loaded' : 'no in-browser engine'
  return page + ', ' + native + ', ' + browser
}

/** The device classes the probe can produce, each once. */
export function probeDevices(): DeviceCapture[] {
  const seen = new Map<string, DeviceCapture>()
  for (const env of allProbeEnvs()) {
    const device = deviceFromProbe(env)
    seen.set(deviceKey(device), device)
  }
  return [...seen.values()]
}

/**
 * The lines main.ts's showArHelp() can put in #ar-help on the no-runtime path.
 *
 * Mirrored, not imported: showArHelp() is inline in main.ts and imports nothing
 * pure. Each entry carries an anchor, a literal that must still appear in main.ts,
 * and showArHelpLinesMissingFrom() checks them. The desktop line's origin is a
 * placeholder: it is one whitespace-free token whatever the real origin is, so
 * the count does not depend on it.
 */
export const SHOW_AR_HELP_LINES: ReadonlyArray<{ line: string, anchor: string }> = [
  // Written when the reason has no next step of its own: one line per platform.
  { line: 'To capture live in Safari, use the main scanner, or install HelloXR.', anchor: 'To capture live in Safari, use the main scanner, or install HelloXR.' },
  { line: 'Live capture needs Chrome with Play Services for AR.', anchor: 'Live capture needs Chrome with Play Services for AR.' },
  { line: 'To capture live, open this on a phone: https://scanner.invalid', anchor: 'To capture live, open this on a phone:' },
  { line: 'The desktop app cannot capture. Scan on a phone.', anchor: 'The desktop app cannot capture. Scan on a phone.' },
  // The reasons that carry a next step: the step replaces the platform line.
  { line: 'Reload the page to try again', anchor: 'Reload the page to try again' },
  { line: 'Reload the page. If it keeps failing, the server may be down', anchor: 'Reload the page. If it keeps failing, the server may be down' },
]

function mainSource(): string {
  return readFileSync(REPO_ROOT + 'src/main.ts', 'utf8')
}

/** The lines whose anchor main.ts no longer carries. Empty while the mirror is current. */
export function showArHelpLinesMissingFrom(source: string = mainSource()): string[] {
  return SHOW_AR_HELP_LINES.filter((entry) => !source.includes(entry.anchor)).map((entry) => entry.line)
}

/** The most words showArHelp() can write into #ar-help. */
export function showArHelpWordsMax(): number {
  return Math.max(...SHOW_AR_HELP_LINES.map((entry) => countWords(entry.line)))
}

/**
 * The most words the boot can write into #ar-help for this device class.
 *
 * Two writers reach #ar-help at boot. They never both run in one boot, so the
 * answer is the longer of their texts, not a sum:
 *
 *   - applyPreflightToStartScreen() writes probeVerdict()'s detail when the
 *     verdict's caveat is set. Every probe state that maps onto this class is
 *     counted, not only the ones main.ts reaches today: createWebXRProvider() and
 *     isImmersiveARSupported() each ask the browser, and when their answers
 *     disagree the boot reaches the no-AR details, so the budget does not depend
 *     on which states happen to be reachable. The insecure page is the one class
 *     charged for a line the boot never writes: main.ts returns before the probe.
 *   - showArHelp() writes its line on the no-runtime path. That path needs the
 *     in-browser engine to have failed (browserAr 'no') on a secure page, because
 *     the insecure branch returns before it. It is counted for every such class,
 *     native-advertised ones included.
 */
export function bootHelpWords(device: DeviceCapture): number {
  let worst = 0
  for (const env of allProbeEnvs()) {
    if (deviceKey(deviceFromProbe(env)) !== deviceKey(device)) continue
    const verdict = probeVerdict(env)
    if (verdict.caveat) worst = Math.max(worst, countWords(verdict.detail))
  }
  if (device.secureContext && device.browserAr === 'no') {
    worst = Math.max(worst, showArHelpWordsMax())
  }
  return worst
}

/**
 * Every screen the boot can draw: each subject on each device class the probe
 * can produce, with the boot-written help line counted. Worst first, by the
 * number WORDS_BEFORE_CAMERA_MAX is held to.
 */
export function bootCases(copy: StaticCopy = readStaticCopy()): Case[] {
  const out: Case[] = []
  for (const subject of SUBJECTS) {
    for (const device of probeDevices()) {
      out.push({
        subject, deviceName: describeDevice(device), device,
        words: wordsBeforeCamera(subject, device, copy),
      })
    }
  }
  return out.sort((a, b) => b.words.withBootHelp - a.words.withBootHelp)
}
