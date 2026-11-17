/**
 * Scanner copy, the AR-failure banner and the erase guard (publish-readiness fix
 * wave 4, package MAIN4).
 *
 * main.ts is one large DOM module, so these tests read its source the way the other
 * scanner wiring tests do. Each test names the review item it guards. Every test here
 * reads source text, so each name starts "source shape:" and claims no behaviour.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main4-scanner-copy-and-erase.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

test('source shape: MAIN4-1: the forced-WebXR headline is a few words, and the help line carries the iOS fix', () => {
  const main = read('src/main.ts')
  const reason = main.match(/const reason = forcedMode === 'webxr'\n\s+\? '([^']+)'/)
  assert.ok(reason, 'the forced-WebXR reason is one string literal')
  assert.equal(reason[1], 'WebXR is not available here')
  assert.ok(reason[1].length <= 30, 'the headline is a few words, at most 30 characters')
  assert.doesNotMatch(reason[1], /HelloXR|iOS/, 'the headline does not repeat the help line')
  assert.match(main, /To capture live in Safari, use the main scanner, or install /, 'the iOS help line still says how to fix it')
})

test('source shape: MAIN4-2: an AR-runtime failure shows its own banner title, not the permission one', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('const beginArSession = async () => {')
  assert.ok(start > 0, 'beginArSession is in main')
  const body = main.slice(start, main.indexOf('const startArPressed = new Promise', start))
  assert.match(body, /showPermissionBanner\(arRuntimeError, 'AR did not start'\)/, 'the banner says AR did not start')
  assert.doesNotMatch(body, /showPermissionBanner\(arRuntimeError\)/, 'the default permission title is not used for it')
})

test('source shape: MAIN4-2: the banner writes each reason line on its own line, without a raw bullet', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function showPermissionBanner(')
  assert.ok(start > 0, 'the banner helper exists')
  const body = main.slice(start, main.indexOf('function disableCaptureControls(', start))
  assert.doesNotMatch(body, /msgEl\.textContent = message/, 'the message is no longer written as one text run')
  assert.match(body, /message\.split\('\\n'\)/, 'the message is split into its lines')
  assert.match(body, /createElement\('br'\)/, 'each line after the first starts on a new line')
  assert.match(body, /line\.replace\(\/\^•\\s\*\/, ''\)/, 'a leading bullet marker is dropped')
})

test('source shape: MAIN4-3: the camera wait gets a neutral, held overlay line, and the pending return still leaves the banner alone', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function applyPreflightVerdict(')
  assert.ok(start > 0, 'applyPreflightVerdict is in main')
  const body = main.slice(start, main.indexOf('function shortName(', start))
  const pending = body.indexOf("if (verdict.outcome === 'warming-up') return")
  const wait = body.indexOf("overlay.setStatus(CAMERA_WAIT_HEADLINE, 'sticky')")
  assert.ok(pending > 0, 'the pending outcome still returns early')
  assert.ok(wait > 0 && wait < pending, 'the camera wait line is written before that return')
  const before = body.slice(0, pending)
  assert.match(before, /verdict\.outcome === 'warming-up' && verdict\.headline === CAMERA_WAIT_HEADLINE/, 'only the camera wait is matched')
  assert.doesNotMatch(before, /permission-error-banner|showPermissionBanner/, 'a pending verdict does not touch the banner')
  assert.doesNotMatch(before, /setStatus\('Starting AR/, 'the first-frame wait leaves the overlay alone')
  assert.match(main, /const CAMERA_WAIT_HEADLINE = 'Waiting for camera permission'/, 'the wait line copy is the neutral one')
  assert.match(
    read('src/ar/eighthwall.ts'),
    /headline: 'Waiting for camera permission'/,
    'the headline matches the one the camera verdict emits, so the match above keeps working',
  )
})

test('source shape: MAIN4-4: the erase takes its captures out of memory before its first await, and the upsert sits inside the capture guard', () => {
  const main = read('src/main.ts')
  const store = read('src/scene/store.ts')
  assert.match(store, /getCapture\(captureId: string\): CaptureRecord \| undefined \{/, 'the store can say whether a capture is still held')
  assert.match(
    store,
    /private async dropCapturesForSession\(sessionId: string\): Promise<void> \{(?:(?!await )[\s\S])*?this\.takeCaptures\(sessionId\)/,
    'an erase removes the capture records of the session it erases, before its first await',
  )
  assert.match(
    store,
    /private takeCaptures\(sessionId: string\): CaptureRecord\[\] \{[\s\S]*?rec\.sessionId !== sessionId[\s\S]*?this\._captures\.delete\(key\)/,
    'takeCaptures takes those records out of memory, matched by the sessionId each one holds',
  )
  const resolved = main.indexOf('await capture.captureDetectionThumbnail(blob, wd.bbox)')
  const guard = main.indexOf('if (isSameCapture(pendingRecord, storedCapture, store.sessionId)) {')
  const upsert = main.indexOf('await store.upsert(merged, thumbMap)')
  assert.ok(resolved > 0 && guard > resolved, 'the check runs after the detections are resolved')
  assert.ok(upsert > guard, 'the upsert sits inside the check')
  assert.ok(
    main.slice(guard, upsert).includes('const merged = mergeDetections(store.currentRunDetections(), worldDets)'),
    'the merge sits inside the same check, and merges into this run\'s detections (WP-02)',
  )
  assert.match(
    main.slice(resolved, guard),
    /const pendingRecord = store\.getCapture\(pendingCaptureId\)/,
    'the record is looked up just before the check, and the check requires it to be in the live session',
  )
})
