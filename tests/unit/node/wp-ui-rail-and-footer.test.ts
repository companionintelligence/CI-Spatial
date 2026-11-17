/**
 * The scanner rail, the Details button and the side-panel footer icons (publish-readiness fix wave 4,
 * UI-2 to UI-5 and UI-7).
 *
 * The rail controls each carry one visible caption, and each accessible name contains that word. The
 * bottom button reads Details with the layers icon, and below 380 px the word is hidden. Each footer
 * action keeps its text and gains an icon from the icon set. Clear resets the live scan right after its
 * erase starts. panel.ts builds the footer at run time, so those checks read its source and run the
 * icon helper directly. The DOM itself is for a browser spec, which this package does not run.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-ui-rail-and-footer.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { icon, iconLabel } from '../../../src/ui/icons.ts'
import type { IconName } from '../../../src/ui/icons.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const html = read('index.html')
const panel = read('src/ui/panel.ts')

/** The scanner rail's markup, from its opening tag up to the side panel that follows it. */
const rail = html.slice(html.indexOf('<div id="scanner-action-rail"'), html.indexOf('<div id="side-panel">'))

/** A rail control's opening tag, and everything inside it up to its closing tag. */
function railControl(id: string): { open: string, inner: string } {
  const found = rail.match(new RegExp('<(a|button)\\b([^>]*\\sid="' + id + '"[^>]*)>([\\s\\S]*?)</\\1>'))
  assert.ok(found, '#' + id + ' is in the scanner rail')
  return { open: found[2] ?? '', inner: found[3] ?? '' }
}

/** Every rail control, with the one-word caption it must show. */
const RAIL: Array<[id: string, caption: string]> = [
  ['xr-mode-link', 'Switch'],
  ['viewer-link', '3D'],
  ['gimbal-link', 'Gimbal'],
  ['panel-toggle', 'Objects'],
  ['stream-btn', 'Stream'],
  ['auto-capture-btn', 'Auto'],
  ['person-capture-btn', 'Person'],
  ['history-btn', 'History'],
]

test('every rail control has an aria-label and one visible caption', () => {
  for (const [id, caption] of RAIL) {
    const { open, inner } = railControl(id)
    assert.match(open, /\saria-label="[^"]+"/, '#' + id + ' keeps its aria-label')
    const captions = inner.match(/<span class="rail-caption"[^>]*>[^<]*<\/span>/g) ?? []
    assert.equal(captions.length, 1, '#' + id + ' has exactly one caption')
    assert.equal(captions[0]?.replace(/<[^>]+>/g, ''), caption, '#' + id + ' is captioned ' + caption)
    assert.doesNotMatch(captions[0] ?? '', /\shidden\b|display:\s*none/, 'the caption on #' + id + ' is not hidden')
  }
})

test('each rail control name contains its visible caption word (WCAG 2.5.3)', () => {
  for (const [id, caption] of RAIL) {
    const name = railControl(id).open.match(/\saria-label="([^"]+)"/)?.[1] ?? ''
    assert.ok(name.includes(caption), '#' + id + ' is named "' + name + '", which has its caption ' + caption)
  }
})

test('the rail names and tooltips keep their wording, with the caption words added', () => {
  // src/main.ts sets the xr-mode-link name to the runtime it switches to; both names contain Switch.
  assert.match(railControl('xr-mode-link').open, /aria-label="Switch AR runtime" title="Switch to WebXR scanner/)
  assert.match(railControl('viewer-link').open, /aria-label="Open 3D Viewer" title="Desktop 3D Viewer"/)
  assert.match(railControl('gimbal-link').open, /aria-label="Open Gimbal Control"/)
  assert.match(railControl('panel-toggle').open, /aria-label="Objects: detections" data-count=""/)
  assert.match(railControl('stream-btn').open, /aria-label="Stream: keyframes to server" title="Stream keyframes to server"/)
  assert.match(railControl('auto-capture-btn').open, /aria-label="Auto: auto-capture" title="Enable auto-capture"/)
  assert.match(railControl('person-capture-btn').open, /aria-label="Person: record a person" title="Record a person \(4D capture\)"/)
  assert.match(railControl('history-btn').open, /aria-label="History: session history"/)
})

test('the captions are styled once in the stylesheet, at 10 px on one line, inside 48 px controls', () => {
  assert.doesNotMatch(rail, /rail-caption"[^>]*style=/, 'no caption carries its own inline style')
  const caption = html.match(/#scanner-action-rail \.rail-caption \{([^}]*)\}/)
  assert.ok(caption, 'the caption rule is in the stylesheet block')
  assert.match(caption[1] ?? '', /font-size:\s*10px;/)
  assert.match(caption[1] ?? '', /white-space:\s*nowrap;/, 'one line, no wrapping')
  assert.match(caption[1] ?? '', /position:\s*absolute;/, 'placed absolutely, so the rail is not widened')
  const controls = html.match(/#scanner-action-rail > button,\s*#scanner-action-rail > a \{([^}]*)\}/)
  assert.ok(controls, 'the rail controls have their own rule')
  assert.match(controls[1] ?? '', /width:\s*48px;/, 'a 48 px hit area across')
  assert.match(controls[1] ?? '', /height:\s*48px;/, 'a 48 px hit area down')
  const railRule = html.match(/#scanner-action-rail \{([^}]*)\}/)
  assert.match(railRule[1] ?? '', /gap:\s*14px;/, 'the gap leaves room for a caption under each control')
})

/** The declarations in the stylesheet rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = html.indexOf(selector + ' {')
  assert.ok(start >= 0, selector + ' has its own rule in the stylesheet')
  return html.slice(start, html.indexOf('}', start))
}

/** The value one rule body sets for `property`, or undefined when it does not set it. */
function declaration(body: string, property: string): string | undefined {
  return body.match(new RegExp('(?:^|[\\s{;])' + property + ':\\s*([^;]+);'))?.[1]?.trim()
}

test('the Person control is the same glass circle as its rail siblings, and its count sits where theirs does', () => {
  const sibling = ruleBody('#auto-capture-btn')
  const person = ruleBody('#person-capture-btn')
  for (const property of ['background', 'border', 'color', 'width', 'height', 'border-radius', 'font-size', 'display', 'backdrop-filter', 'box-shadow']) {
    assert.ok(declaration(sibling, property), '#auto-capture-btn sets ' + property)
    assert.equal(declaration(person, property), declaration(sibling, property), '#person-capture-btn keeps the ' + property + ' of its siblings')
  }
  const count = ruleBody('#person-capture-count')
  assert.equal(declaration(count, 'position'), 'absolute')
  assert.equal(declaration(count, 'top'), '-4px')
  assert.equal(declaration(count, 'right'), '-4px')
  assert.equal(declaration(count, 'display'), 'none', 'the count stays hidden until the control is recording')
  assert.ok(html.includes('#person-capture-btn.active #person-capture-count {'), 'the count shows while the control is recording')
  assert.match(rail, /<span id="person-capture-count"><\/span>/, 'the count hook is kept')
})

test('below 380 px the Details word is hidden, and the layers icon keeps the button name', () => {
  const narrow = html.match(/@media \(max-width: 380px\) \{([\s\S]*?)\n      \}/)
  assert.ok(narrow, 'the narrow-phone rules are in the stylesheet')
  assert.match(narrow[1] ?? '', /\.finish-btn > span \{\s*display: none;\s*\}/, 'the visible word is hidden on narrow phones')
  assert.doesNotMatch(narrow[1] ?? '', /\.finish-btn svg/, 'the layers icon is left as it is')
  assert.match(html, /<button id="finish-scan-btn" class="finish-btn" aria-label="Scan details">/, 'the button keeps its scan-details name')
})

test('the Menu button is Details, with the layers icon and a scan-details name', () => {
  const found = html.match(/<button id="finish-scan-btn"([^>]*)>([\s\S]*?)<\/button>/)
  assert.ok(found, 'the finish button is in the markup')
  const attrs = found[1] ?? ''
  const inner = found[2] ?? ''
  assert.match(attrs, /\saria-label="Scan details"/, 'the name says what the button opens')
  assert.equal(inner.replace(/<[^>]+>/g, '').trim(), 'Details', 'the visible label is Details')
  assert.ok(inner.includes(icon('layers', { size: '16px' })), 'the icon is the layers glyph from src/ui/icons.ts')
  assert.doesNotMatch(html, /id="finish-scan-btn"[^>]*>Menu</, 'Menu is no longer the button text')
})

test('each footer action keeps its text and gains an icon from the set', () => {
  const actions: Array<[name: IconName, text: string]> = [
    ['box', 'Export GLB'],
    ['text-lines', 'Export Summary'],
    ['trash', 'Clear session'],
    ['save', 'Download'],
    ['broadcast', 'Start Live Stream'],
  ]
  // iconLabel() draws its glyph with icon(), the one function that writes the set's markup.
  assert.match(read('src/ui/icons.ts'), /icon\(name, options\)\}<span>/, 'iconLabel draws its glyph with icon()')
  for (const [name, text] of actions) {
    assert.ok(panel.includes("iconLabel('" + name + "', '" + text + "'"), text + ' is built with its icon')
    const markup = iconLabel(name, text, { size: '15px' })
    assert.equal(markup.replace(/<[^>]+>/g, ''), text, text + ' keeps its visible text')
    // The glyph is the decorative 15 px svg with its paths, drawn ahead of the label.
    assert.match(markup, /^<span [^>]*><svg width="15px" height="15px" [^>]*aria-hidden="true"[^>]*>(?:<(?:path|circle|rect|line|polyline|polygon)\b[^>]*\/>)+<\/svg><span>/, text + ' draws its icon from the set, ahead of the label')
  }
})

test('the temporary export labels stay text only, and the timers put the icon back', () => {
  for (const label of ["exportBtn.textContent = 'Exporting...'", 'EXPORT_LABELS[outcome]', 'EXPORT_LABELS.failed']) {
    assert.ok(panel.includes(label), 'the temporary label is unchanged: ' + label)
  }
  // Creation plus the two timers that return from a temporary label.
  assert.equal(panel.split('innerHTML = exportGlbLabel').length - 1, 3, 'every return to the resting label restores the icon')
})

test('Clear resets the live scan right after its erase starts, not after the erase settles', () => {
  const start = panel.indexOf("clearBtn.addEventListener('click'")
  assert.ok(start > 0, 'the Clear handler exists')
  const handler = panel.slice(start, panel.indexOf('this.footer.appendChild(clearBtn)', start))
  const erasingAt = handler.indexOf('const erasing = this.store.clear()')
  const resetAt = handler.indexOf('this.onScanReset?.(erased)')
  const awaitAt = handler.indexOf('await erasing')
  assert.ok(erasingAt >= 0, 'the erase starts in the Clear handler')
  assert.ok(erasingAt < resetAt && resetAt < awaitAt, 'the reset runs after the synchronous start and before the await')
  const catchAt = handler.indexOf('erasing.catch(')
  assert.ok(catchAt > erasingAt && catchAt < resetAt, 'the erase has a handler before the reset, so a throwing reset cannot leave it unhandled')
  assert.equal(handler.indexOf('finally'), -1, 'the reset does not wait in a finally block')
  assert.match(handler, /Could not erase this scan from this phone\. Try again\./, 'a failed erase still says so')
})

test('the Download button shows the save icon for the download state', () => {
  assert.ok(panel.includes("modelBtn.innerHTML = iconLabel('save', 'Download'"), 'the model button starts with the icon')
  assert.ok(panel.includes("this._modelActionBtn.innerHTML = iconLabel('save', 'Download'"), 'the download state keeps it')
})
