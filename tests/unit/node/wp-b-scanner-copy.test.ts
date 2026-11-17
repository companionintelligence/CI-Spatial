/**
 * Scanner copy, sinks and labels (publish-readiness WP-B).
 *
 * Covers what a node run can check without a browser: the icon set, and the
 * source of the scanner modules for the rules a regression would break: server
 * text is drawn as text, scan labels are escaped where they are drawn, the
 * engine captions tell the truth about where photos go, and the destructive
 * controls are named and confirmed. The DOM behaviour itself is for a browser
 * spec; main.ts cannot be imported under node.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-b-scanner-copy.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { icon } from '../../../src/ui/icons.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('the trash glyph is a decorative inline svg from the icon set', () => {
  const svg = icon('trash', { size: '15px' })
  assert.match(svg, /^<svg /)
  assert.match(svg, /aria-hidden="true"/, 'the button names itself, so the glyph is hidden from assistive tech')
  assert.match(svg, /width="15px" height="15px"/)
  assert.ok((svg.match(/<path /g) ?? []).length >= 4, 'a lid, a handle, the bin and two lines inside it')
})

test('server output reaches the inference dialog as text, never as markup', () => {
  const main = read('src/main.ts')
  // Behaviour, not one template: no innerHTML template may interpolate the server's result.
  assert.doesNotMatch(main, /innerHTML\s*=\s*`[^`]*\$\{result\.result\}/)
  assert.match(main, /text\.textContent = result\.result/)
  assert.match(main, /body\.replaceChildren\(text\)/)
})

test('the area name and the popup address are escaped where they are drawn', () => {
  const main = read('src/main.ts')
  assert.match(main, /<span>\$\{escapeHtml\(areaHint\)\}<\/span>/)
  assert.doesNotMatch(main, /bindPopup\(`/, 'a popup is never built from a template string')
  assert.match(main, /popupText\.textContent = loc\.address \?\? loc\.filename/)
})

test('a reference photo is fetched through the API base, so the shell reaches the server', () => {
  const main = read('src/main.ts')
  assert.match(main, /const res = await fetch\(apiUrl\(photo\.url\)\)\.catch/)
  assert.doesNotMatch(main, /fetch\(photo\.url\)/)
})

test('the engine captions say where photos and scan data go', () => {
  const panel = read('src/ui/panel.ts')
  assert.doesNotMatch(panel, /no data leaves/i, 'every capture uploads scan data, so that promise was false')
  assert.match(panel, /'Sends photos to your Scan server for analysis\.'/)
  assert.match(panel, /'Detection runs on this phone\. Scan data still syncs to your Scan server\.'/)
})

test('the glyph buttons in the history drawer are named for the item they act on', () => {
  const history = read('src/ui/history.ts')
  assert.match(history, /setAttribute\('aria-label', `Load session from \$\{dateStr\}, \$\{what\}`\)/)
  assert.match(history, /setAttribute\('aria-label', `Delete session from \$\{dateStr\}, \$\{what\}`\)/)
  assert.match(history, /setAttribute\('aria-label', `\$\{isSelected \? 'Deselect' : 'Select'\} \$\{det\.label\}`\)/)
  assert.match(history, /icon\('trash', \{ size: '15px' \}\)/)
  assert.doesNotMatch(history, /textContent = '✕'/)
  assert.match(read('src/ui/panel.ts'), /setAttribute\('aria-label', `Edit \$\{det\.label\}`\)/)
})

test('deleting a session asks first, awaits the delete, and keeps the row when it fails', () => {
  const history = read('src/ui/history.ts')
  const confirmAt = history.indexOf('confirm(`Erase this session from this phone?')
  const deleteAt = history.indexOf('await this.store.deleteSession(s.sessionId)')
  const removeAt = history.indexOf('wrap.remove()', deleteAt)
  assert.ok(confirmAt > 0 && deleteAt > confirmAt, 'the confirm comes before the delete')
  assert.ok(removeAt > deleteAt, 'the row is removed only after the delete has resolved')
  assert.doesNotMatch(history, /setTimeout\(\(\) => wrap\.remove\(\)/, 'no fade-and-remove ahead of the delete')
  assert.match(history, /console\.error\('\[history\] delete failed', err\)[\s\S]*?header\.after\(note\)[\s\S]*?return\n\s+\}/, 'the delete failure keeps the row and says so')
  assert.match(history, /note\.setAttribute\('role', 'alert'\)/)
})

test('the export hint names the step that unlocks export: scanning an object', () => {
  const panel = read('src/ui/panel.ts')
  // Export enables once an object is detected, so the hint must not promise less or more.
  assert.match(panel, /exportHint\.textContent = '• Export unlocks after you scan an object'/)
  assert.doesNotMatch(panel, /Export unlocks after your first scan/)
})

test('Clear and deleting a session each name what is erased and what stays', () => {
  const panel = read('src/ui/panel.ts')
  assert.match(panel, /confirm\('Erase this scan from this phone\?[^']*Objects and photos go\.[^']*Copies already on the server stay\.'\)/)
  const history = read('src/ui/history.ts')
  assert.match(history, /Erase this session from this phone\? \$\{what\} and their photos go\. Copies already on the server stay\./)
})
