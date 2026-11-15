/**
 * The legal notices the native apps show (src/ui/legal-notices.ts). The XR Engine notice must be
 * the engine's own words, and carry what its licence asks for; the app's own notice must be the
 * Required Notice in LICENSE. The dialog itself is DOM and runs in the apps.
 *
 * Run: npm run test:legal-notices
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NOTICE, XR_ENGINE_NOTICE, legalSections } from '../../../src/ui/legal-notices.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

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
  assert.deepEqual(legalSections(false).map((s) => s.heading), [APP_NOTICE.name, 'Open-source software'])
})

test("the app's own notice is the Required Notice in LICENSE", () => {
  const licence = read('LICENSE')
  assert.match(licence, /Required Notice: Copyright LifeScope INC, DBA Companion Intelligence \(https:\/\/ci\.computer\)/)
  assert.equal(APP_NOTICE.copyright, 'Copyright LifeScope INC, DBA Companion Intelligence (https://ci.computer).')
  assert.match(licence, /PolyForm Noncommercial License 1\.0\.0/)
  assert.equal(APP_NOTICE.licenceUrl, 'https://polyformproject.org/licenses/noncommercial/1.0.0')
})
