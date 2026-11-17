/**
 * Upsert ownership, the iOS help copy, the runtime-switch names and the finish-button
 * wording (publish-readiness fix wave 5, package MAIN5, items MAIN5-3 to MAIN5-6).
 *
 * main.ts is one large DOM module, so these tests read its source the way the other
 * scanner wiring tests do. Each name starts "source shape:" because it claims no behaviour.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main5-ownership-copy-and-labels.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('source shape: MAIN5-3: detections are upserted only for a pending capture that the live session still holds', () => {
  const main = read('src/main.ts')
  const lookup = main.indexOf('const pendingRecord = store.getCapture(pendingCaptureId)')
  const guard = main.indexOf('if (isSameCapture(pendingRecord, storedCapture, store.sessionId)) {')
  const upsert = main.indexOf('await store.upsert(merged, thumbMap)', guard)
  assert.ok(lookup > 0 && guard > lookup, 'the record is looked up, then checked')
  assert.ok(upsert > guard, 'the upsert sits inside the ownership check')
  assert.doesNotMatch(main, /if \(store\.getCapture\(pendingCaptureId\)\) \{/, 'the existence-only check is gone')
})

test('source shape: MAIN5-4: the iOS help line tells the reader to use the main scanner, not to open this page in Safari', () => {
  const main = read('src/main.ts')
  assert.doesNotMatch(main, /open this page in Safari/, 'the page the reader is on is not named as the fix')
  assert.match(main, /'To capture live in Safari, use the main scanner, or install HelloXR\.'/, 'the plain line for iOS')
  assert.match(
    main,
    /el\.innerHTML = 'To capture live in Safari, use the main scanner, or install '/,
    'the same line on the start screen, which keeps the HelloXR link',
  )
})

test('source shape: MAIN5-5: both accessible names for the runtime switch contain the word Switch', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function updateXrModeLink(')
  const body = main.slice(start, main.indexOf('let _inferDialogTimer', start))
  const eightWall = body.indexOf('if (use8thWall) {')
  const otherMode = body.indexOf('} else {', eightWall)
  assert.ok(start > 0 && eightWall > 0 && otherMode > eightWall, 'both modes are in the function')
  assert.match(
    body.slice(eightWall, otherMode),
    /link\.setAttribute\('aria-label', 'Switch to WebXR scanner'\)/,
    'in 8th Wall mode the name is Switch to WebXR scanner',
  )
  assert.match(
    body.slice(otherMode),
    /link\.setAttribute\('aria-label', 'Switch to 8th Wall scanner'\)/,
    'in WebXR mode the name is Switch to 8th Wall scanner',
  )
})

test('source shape: MAIN5-6: the finish-scan comments say Details, not Menu', () => {
  const main = read('src/main.ts')
  assert.doesNotMatch(main, /Menu button opens side panel/)
  assert.doesNotMatch(main, /finish-scan-btn\/"Menu"/)
  assert.match(main, /Details button opens side panel/)
  assert.match(main, /finish-scan-btn\/"Details"/)
})
