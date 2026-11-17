/**
 * The legal notices the native apps show (src/ui/legal-notices.ts). The XR Engine notice must be
 * the engine's own words, and carry what its licence asks for; the app's own notice must be the
 * Required Notice in LICENSE. The Android app, and only it, also shows the disclosure Google asks
 * of an app that uses ARCore, in the words THIRD-PARTY-NOTICES.txt carries
 * (scripts/native/third-party-notices.mjs). The dialog itself is DOM and runs in the apps; the last
 * tests draw it into a small stand-in for the document, which shows what each shell is given and
 * that the links are real ones.
 *
 * Run: npm run test:legal-notices
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NOTICE, ARCORE_NOTICE, XR_ENGINE_NOTICE, legalSections, openLegalNotices } from '../../../src/ui/legal-notices.ts'
import { ARCORE_NOTICE as NOTICES_FILE_ARCORE_NOTICE } from '../../../scripts/native/third-party-notices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** The sentence an app that uses ARCore shows (https://developers.google.com/ar/develop/privacy-requirements), as this app words it. */
const ARCORE_SENTENCE = 'This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy.'
/** The ARCore section's three links, in the order it shows them. */
const ARCORE_LINKS = [
  { text: 'Google Play Services for AR', href: 'https://play.google.com/store/apps/details?id=com.google.ar.core' },
  { text: 'Google Privacy Policy', href: 'https://policies.google.com/privacy' },
  { text: 'ARCore Additional Terms of Service', href: 'https://developers.google.com/ar/develop/terms' },
]
/** The heading of the section that lists the rest of the software, which is not all open source. */
const THIRD_PARTY = 'Third-party software'

test('the engine notice is word for word the header Niantic ships at the top of xr.js', () => {
  const header = read('public/xr.js').slice(0, 2000)
  assert.ok(header.includes(XR_ENGINE_NOTICE.creator), 'names Niantic Spatial as the creator')
  assert.ok(header.includes(XR_ENGINE_NOTICE.copyright), 'the copyright notice, year and all')
  assert.ok(header.includes('XR ENGINE LICENSE AGREEMENT'))
})

test('the engine section carries what section 1.3.2 of the Agreement asks for', () => {
  const engine = legalSections(true).find((section) => section.heading === XR_ENGINE_NOTICE.name)
  assert.ok(engine, 'an app that bundles the engine shows its notice')
  const text = engine.paragraphs.join(' ')
  assert.match(text, /developed by Niantic Spatial, Inc\./, 'the creator')
  assert.match(text, /Copyright © \d{4} Niantic Spatial, Inc\./, 'a copyright notice')
  assert.match(text, /licensed under the XR Engine License Agreement/, 'the Agreement it is licensed under')
  assert.match(text, /without warranties[\s\S]*disclaimer of warranties/, 'the disclaimer of warranties')
  assert.match(text, /not made, sponsored or endorsed by Niantic Spatial/, 'no claim of endorsement (1.3.3)')
  assert.deepEqual(engine.links, [{ text: 'XR Engine License Agreement', href: 'https://github.com/8thwall/engine/blob/main/LICENSE' }])
})

test('the desktop app, whose bundle leaves the engine out, shows no engine notice', () => {
  assert.equal(legalSections(false).some((section) => section.heading === XR_ENGINE_NOTICE.name), false)
  assert.deepEqual(legalSections(false).map((s) => s.heading), [APP_NOTICE.name, THIRD_PARTY])
})

test("the app's own notice is the Required Notice in LICENSE", () => {
  const licence = read('LICENSE')
  assert.match(licence, /Required Notice: Copyright LifeScope INC, DBA Companion Intelligence \(https:\/\/ci\.computer\)/)
  assert.equal(APP_NOTICE.copyright, 'Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer).')
  assert.match(licence, /PolyForm Noncommercial License 1\.0\.0/)
  assert.equal(APP_NOTICE.licenceUrl, 'https://polyformproject.org/licenses/noncommercial/1.0.0')
})

// ── ARCore: the Android app runs it, and tells people so ───────────────────────────────────────

test('the Android app shows the ARCore disclosure: the sentence, the terms the SDK is under, and three links', () => {
  const withSentence = legalSections(true, true).filter((section) => section.paragraphs.includes(ARCORE_SENTENCE))
  assert.equal(withSentence.length, 1, 'one section carries the sentence, word for word')
  const [arcore] = withSentence
  assert.equal(arcore!.heading, ARCORE_NOTICE.name)
  assert.match(arcore!.heading, /ARCore/, 'a person looking for it finds it by name')
  assert.match(arcore!.paragraphs.join(' '), /The ARCore SDK is licensed under the ARCore Additional Terms of Service, not under the licence of this app\./,
    "the SDK is under Google's terms and not this app's licence")
  assert.deepEqual(arcore!.links, ARCORE_LINKS, 'exactly these three links, in this order')
  for (const { href } of arcore!.links) assert.equal(new URL(href).protocol, 'https:', href)
})

test('each build shows its own sections in order, and ARCore only where it runs', () => {
  const headings = (engineBundled: boolean, arcoreBundled?: boolean) => legalSections(engineBundled, arcoreBundled).map((s) => s.heading)
  assert.deepEqual(headings(true, true), [APP_NOTICE.name, ARCORE_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY],
    "Android: ARCore ahead of the engine, whose five paragraphs fill a phone's first screen and would push Google's sentence below the fold")
  assert.deepEqual(headings(true), [APP_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY], 'iOS: the engine, and no ARCore unless the build says so')
  assert.deepEqual(headings(true, false), [APP_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY])
  assert.deepEqual(headings(false), [APP_NOTICE.name, THIRD_PARTY], 'desktop: neither')
  assert.deepEqual(headings(false, false), [APP_NOTICE.name, THIRD_PARTY])
})

test('the iOS and desktop apps do not run ARCore, so nothing they show mentions it', () => {
  const builds: Array<[string, ReturnType<typeof legalSections>]> = [
    ['iOS', legalSections(true)],
    ['iOS, ARCore off', legalSections(true, false)],
    ['desktop', legalSections(false)],
    ['desktop, ARCore off', legalSections(false, false)],
  ]
  for (const [name, sections] of builds) {
    assert.doesNotMatch(JSON.stringify(sections), /ARCore|Google Play Services|play\.google\.com|developers\.google\.com\/ar/i, name)
  }
})

test("the ARCore notice in the Android app's THIRD-PARTY-NOTICES.txt is the one the app shows", () => {
  const file: unknown = NOTICES_FILE_ARCORE_NOTICE
  assert.equal(typeof file, 'string', 'scripts/native/third-party-notices.mjs exports the text it prints for ARCore')
  const printed = file as string
  assert.equal(ARCORE_NOTICE.disclosure, ARCORE_SENTENCE)
  assert.ok(printed.includes(ARCORE_NOTICE.disclosure), 'the sentence, word for word')
  // A text file has no links, so it prints each one as its name and its address, and the address ends where the
  // file ends it: at a line break, a space or a comma. A longer address in the file is another address.
  assert.deepEqual(ARCORE_NOTICE.links, ARCORE_LINKS)
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const { text, href } of ARCORE_NOTICE.links) {
    assert.match(printed, new RegExp(`${escaped(text)}[:,] ${escaped(href)}(?=[\\s,]|$)`), `${text}, with its address ${href}`)
  }
  // The line about the terms is worded for the page and for the file, so the pin is on what both must say.
  for (const part of ['is licensed under the ARCore Additional Terms of Service', 'not under the licence of this app']) {
    assert.ok(ARCORE_NOTICE.licence.includes(part), `the app says: ${part}`)
    assert.ok(printed.includes(part), `the notices file says: ${part}`)
  }
})

test('nothing the view says calls the software it lists open source: ARCore and the XR Engine are proprietary', () => {
  assert.equal(THIRD_PARTY, legalSections(false).at(-1)!.heading)
  for (const [name, sections] of [['Android', legalSections(true, true)], ['iOS', legalSections(true)], ['desktop', legalSections(false)]] as const) {
    assert.doesNotMatch(JSON.stringify(sections), /open[- ]source/i, name)
  }
  assert.match(legalSections(false).at(-1)!.paragraphs.join(' '), /third-party software/)
})

// ── The dialog, drawn into a stand-in for the document ─────────────────────────────────────────

/** What the dialog uses of an element: a tag, attributes, text, and children. */
class FakeElement {
  tag: string
  children: FakeElement[] = []
  attributes = new Map<string, string>()
  className = ''
  textContent = ''
  href = ''
  target = ''
  rel = ''
  constructor(tag: string) { this.tag = tag }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(): void {}
  showModal(): void {}
  remove(): void {}
  /** This element and every element under it, in document order. */
  all(): FakeElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

type DialogShell = 'android' | 'ios' | 'tauri' | 'browser'

/**
 * Draws the dialog as a page in `shell` would, with the globals those pages have (a document, and the
 * bridge Capacitor injects into each app, or Tauri's internals), and puts every global back afterwards.
 */
function draw(shell: DialogShell, ...flags: Parameters<typeof openLegalNotices>): FakeElement {
  const g = globalThis as unknown as Record<string, unknown>
  const names = ['document', 'Capacitor', '__TAURI_INTERNALS__']
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  put('document', {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: () => null,
    head: new FakeElement('head'),
    body: new FakeElement('body'),
  })
  if (shell === 'android' || shell === 'ios') put('Capacitor', { isNativePlatform: () => true, getPlatform: () => shell })
  else delete g['Capacitor']
  if (shell === 'tauri') put('__TAURI_INTERNALS__', {})
  else delete g['__TAURI_INTERNALS__']
  try {
    return openLegalNotices(...flags) as unknown as FakeElement
  } finally {
    names.forEach((name, i) => {
      const had = saved[i]
      if (had) Object.defineProperty(globalThis, name, had)
      else delete g[name]
    })
  }
}

/** The sections the dialog draws: each is a block whose first child is its heading. */
const blocks = (dialog: FakeElement) => dialog.all().filter((el) => el.className === 'cs-notice')
const headingOf = (block: FakeElement) => block.children[0]!.textContent
const anchorsIn = (el: FakeElement) => el.all().filter((child) => child.tag === 'a')

test('each shell is drawn the sections it runs: ARCore in the Android app alone', () => {
  const shown = (shell: DialogShell) => blocks(draw(shell)).map(headingOf)
  assert.deepEqual(shown('android'), [APP_NOTICE.name, ARCORE_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY])
  assert.deepEqual(shown('ios'), [APP_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY], 'iOS is a Capacitor shell too, and runs ARKit')
  assert.deepEqual(shown('tauri'), [APP_NOTICE.name, THIRD_PARTY], 'the desktop app leaves the engine out and has no AR')
  assert.deepEqual(shown('browser'), [APP_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY], 'outside a shell: the engine as before, and no ARCore')
})

test('the Android dialog draws the ARCore sentence in view, and its three links as real links that leave the app', () => {
  const dialog = draw('android')
  const arcore = blocks(dialog).find((block) => headingOf(block) === ARCORE_NOTICE.name)
  assert.ok(arcore, 'the section is in the dialog as it opens, not behind a button')
  assert.ok(arcore.all().some((el) => el.tag === 'p' && el.textContent === ARCORE_SENTENCE), 'the sentence, word for word, as a paragraph')
  const anchors = anchorsIn(arcore)
  assert.deepEqual(anchors.map((a) => ({ text: a.textContent, href: a.href })), ARCORE_LINKS)
  for (const a of anchors) {
    assert.equal(a.target, '_blank', `${a.href} opens outside the dialog`)
    assert.equal(a.rel, 'noopener noreferrer')
  }
})

test('the dialog keeps what it had: its title, the engine and licence links, and the two buttons that show the licences', () => {
  const dialog = draw('android')
  assert.equal(dialog.all().find((el) => el.tag === 'h2')?.textContent, 'Legal notices')
  const app = blocks(dialog).find((block) => headingOf(block) === APP_NOTICE.name)
  const engine = blocks(dialog).find((block) => headingOf(block) === XR_ENGINE_NOTICE.name)
  assert.deepEqual(anchorsIn(app!).map((a) => a.href), [APP_NOTICE.licenceUrl])
  assert.deepEqual(anchorsIn(engine!).map((a) => a.href), [XR_ENGINE_NOTICE.licenceUrl])
  const buttons = dialog.all().filter((el) => el.tag === 'button' && el.className.includes('cs-btn-quiet')).map((el) => el.textContent)
  assert.deepEqual(buttons, ['Show third-party licences', 'Show the Companion Scan licence'])
})

test('the two flags override what the shell says, in both directions', () => {
  assert.deepEqual(blocks(draw('browser', true, true)).map(headingOf), [APP_NOTICE.name, ARCORE_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY])
  assert.deepEqual(blocks(draw('android', false, false)).map(headingOf), [APP_NOTICE.name, THIRD_PARTY])
  assert.deepEqual(blocks(draw('tauri', true)).map(headingOf), [APP_NOTICE.name, XR_ENGINE_NOTICE.name, THIRD_PARTY], 'one flag given: the other still follows the shell')
})

test('nothing in the drawn dialog, buttons included, calls the software it lists open source', () => {
  for (const shell of ['android', 'ios', 'tauri'] as const) {
    const words = draw(shell).all().map((el) => el.textContent).join('\n')
    assert.match(words, /Third-party software/, shell)
    assert.doesNotMatch(words, /open[- ]source/i, shell)
  }
})
