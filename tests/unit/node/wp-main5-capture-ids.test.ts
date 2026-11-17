/**
 * Capture numbering after a reload, a load or an adoption (publish-readiness fix wave 5,
 * package MAIN5, item MAIN5-2).
 *
 * A capture's record id is its session id, then `-c`, then its index, and putCapture()
 * replaces whatever record already holds that id. A session that comes back live must
 * therefore count on from its highest stored index. highestCaptureIndex is that rule.
 * The source checks confirm main.ts applies it where a session becomes live.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main5-capture-ids.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { highestCaptureIndex } from '../../../src/shared/capture-index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const SESSION = 'sess-0a1b2c3d-0000-4000-8000-000000000001'
const OTHER = 'sess-0a1b2c3d-0000-4000-8000-000000000002'

/** A stored capture as the store holds it: its id, its session and its index. */
function stored(sessionId: string, captureIndex: number, captureId = sessionId + '-c' + captureIndex) {
  return { captureId, sessionId, captureIndex }
}

test('no stored captures gives 0, so the first capture of the session is number 1', () => {
  assert.equal(highestCaptureIndex([], SESSION), 0)
})

test('stored captures 1 and 3 give 3, so the next capture is number 4', () => {
  assert.equal(highestCaptureIndex([stored(SESSION, 1), stored(SESSION, 3)], SESSION), 3)
})

test('the order the captures come back in does not change the answer', () => {
  assert.equal(highestCaptureIndex([stored(SESSION, 3), stored(SESSION, 1), stored(SESSION, 2)], SESSION), 3)
})

test('captures of another session are ignored, however high their index', () => {
  assert.equal(highestCaptureIndex([stored(SESSION, 2), stored(OTHER, 9)], SESSION), 2)
  assert.equal(highestCaptureIndex([stored(OTHER, 9)], SESSION), 0)
})

test('with no live session the answer is 0, whatever is stored', () => {
  assert.equal(highestCaptureIndex([stored('', 5)], ''), 0)
  assert.equal(highestCaptureIndex([stored(SESSION, 5)], ''), 0)
})

test('a capture re-keyed by adoption counts for the session it moved to, under its old id', () => {
  // adoptServerSession moves the record to the new session id and keeps its captureId.
  const adopted = stored(SESSION, 4, 'local-7f3e-c4')
  assert.equal(highestCaptureIndex([adopted], SESSION), 4)
})

test('after a reload the next capture id is never one that is already stored', () => {
  const restored = [stored(SESSION, 1), stored(SESSION, 2), stored(SESSION, 3)]
  const nextId = SESSION + '-c' + (highestCaptureIndex(restored, SESSION) + 1)
  assert.equal(restored.some((rec) => rec.captureId === nextId), false)
})

test('source shape: main.ts starts captureCount from the stored session, after the resume', () => {
  const main = read('src/main.ts')
  const resumed = main.indexOf('await store.resumeLatestSession()')
  const declared = main.indexOf('let captureCount = highestCaptureIndex(store.captures.values(), store.sessionId)')
  assert.ok(resumed > 0, 'the stored session is resumed in main')
  assert.ok(declared > resumed, 'the count is read after the resume, so it sees the restored captures')
  assert.doesNotMatch(main, /let captureCount = 0/, 'the count no longer starts at 0 on every load')
  assert.match(main, /import \{[^}]*\bhighestCaptureIndex\b[^}]*\} from '\.\/shared\/capture-index\.ts'/)
})

test('source shape: a reset brings the count onto the session now live, after a load or a delete', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('function resetScanner(detectionCount: number): void {')
  const end = main.indexOf('await router.probeWebGPU()', start)
  assert.ok(start > 0 && end > start, 'resetScanner is in main, before the panel is built')
  assert.match(
    main.slice(start, end),
    /followCaptureSession\(\)/,
    'the count follows the session the store now holds',
  )
  const follow = main.indexOf('function followCaptureSession(): void {')
  assert.ok(follow > 0, 'followCaptureSession is in main')
  const body = main.slice(follow, main.indexOf('\n  }\n', follow))
  assert.match(
    body,
    /captureCount = captureCountFor\(live, captureCountSession, captureCount, store\.captures\.values\(\), leftCaptureCount\)/,
    'the value comes from the rule for the same session or a different one',
  )
  assert.match(
    body,
    /if \(live !== captureCountSession\) leftCaptureCount\.set\(captureCountSession, captureCount\)/,
    'the count a session is left at is kept, so a session loaded back resumes from it',
  )
})

test('source shape: an adopted server session raises the count to what it holds, and never lowers it', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('kfStreamer.onSessionId = (sessionId) => {')
  assert.ok(start > 0, 'the session-id hook is in main')
  const body = main.slice(start, main.indexOf('// A tap during a start or stop', start))
  assert.match(body, /store\.adoptServerSession\(sessionId\)\.then\(\(adopted\) => \{/, 'the count is read once the adoption has run')
  assert.match(
    body,
    /captureCount = Math\.max\(captureCount, highestCaptureIndex\(store\.captures\.values\(\), store\.sessionId\)\)/,
    'the count only rises here',
  )
})
