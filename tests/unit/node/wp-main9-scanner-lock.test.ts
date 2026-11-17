/**
 * One writable scanner page per origin, read-only otherwise (publish-readiness wave 9,
 * package MAIN9, items MAIN9-1 to MAIN9-4).
 *
 * The role decision and the lock acquisition are pure (src/shared/scanner-lock.ts), so they
 * run here against a stub lock manager. main.ts is one large DOM module, so the wiring checks
 * read its source the way the other scanner tests do. Those names start "source shape:".
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-main9-scanner-lock.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCANNER_WRITER_LOCK,
  acquireScannerRole,
  decideScannerRole,
} from '../../../src/shared/scanner-lock.ts'
import type { LockManagerLike } from '../../../src/shared/scanner-lock.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/**
 * A stub lock manager that answers the way the browser does: the callback runs later, with a
 * lock when granted and with null when not. What the callback returned is recorded, so a test
 * can check whether the granted callback holds the lock by never settling.
 */
function stubLocks(granted: boolean) {
  const requests: Array<{ name: string; options: unknown }> = []
  const returned: unknown[] = []
  const locks: LockManagerLike = {
    request(name, options, callback) {
      requests.push({ name, options })
      return Promise.resolve().then(() => {
        const value = callback(granted ? { name } : null)
        returned.push(value)
        return value
      })
    },
  }
  return { navigator: { locks }, requests, returned }
}

// ── MAIN9-1: the pure decision ───────────────────────────────────────────────────

test('MAIN9-1: a granted lock makes the page the writer, and a lock held elsewhere makes it read-only', () => {
  assert.equal(decideScannerRole({ lockApiAvailable: true, lockGranted: true }), 'writer')
  assert.equal(decideScannerRole({ lockApiAvailable: true, lockGranted: false }), 'readOnly')
})

test('MAIN9-1: with no Web Locks API the page is the writer, as it was before this change', () => {
  assert.equal(decideScannerRole({ lockApiAvailable: false, lockGranted: false }), 'writer')
  assert.equal(decideScannerRole({ lockApiAvailable: false, lockGranted: true }), 'writer')
})

test('MAIN9-1: the lock is named companion-scanner-writer, the same name for every scanner page on the origin', () => {
  assert.equal(SCANNER_WRITER_LOCK, 'companion-scanner-writer')
})

// ── MAIN9-1: the acquisition, with a stub navigator ──────────────────────────────

test('MAIN9-1: the acquisition asks for the lock without waiting, and resolves writer when it is granted', async () => {
  const stub = stubLocks(true)
  assert.equal(await acquireScannerRole(stub.navigator), 'writer')
  assert.deepEqual(stub.requests, [{ name: 'companion-scanner-writer', options: { ifAvailable: true } }])
})

test('MAIN9-1: the acquisition resolves readOnly when the callback gets null, and the callback keeps nothing', async () => {
  const stub = stubLocks(false)
  assert.equal(await acquireScannerRole(stub.navigator), 'readOnly')
  assert.equal(stub.returned[0], undefined, 'the callback returns at once, so no lock is held')
})

test('MAIN9-1: a granted callback returns a promise that never settles, which holds the lock for the page life', async () => {
  const stub = stubLocks(true)
  assert.equal(await acquireScannerRole(stub.navigator), 'writer')
  const held = stub.returned[0]
  assert.ok(held instanceof Promise, 'the callback returns a promise')
  const outcome = await Promise.race([held, new Promise((resolve) => setTimeout(() => resolve('still held'), 30))])
  assert.equal(outcome, 'still held')
})

test('MAIN9-1: of two pages on one origin, the first is the writer and the second is read-only', async () => {
  const held = new Set<string>()
  const locks: LockManagerLike = {
    request(name, _options, callback) {
      const granted = !held.has(name)
      if (granted) held.add(name)
      return Promise.resolve().then(() => callback(granted ? { name } : null))
    },
  }
  assert.equal(await acquireScannerRole({ locks }), 'writer')
  assert.equal(await acquireScannerRole({ locks }), 'readOnly')
})

test('MAIN9-1: without navigator.locks the page is the writer, as before', async () => {
  assert.equal(await acquireScannerRole({}), 'writer')
  assert.equal(await acquireScannerRole({ locks: null }), 'writer')
  assert.equal(await acquireScannerRole(undefined), 'writer')
})

test('MAIN9-1: a request that throws or rejects is treated as no lock API, so the page stays the writer', async () => {
  const throwing: LockManagerLike = {
    request() {
      throw new Error('SecurityError')
    },
  }
  const rejecting: LockManagerLike = {
    request() {
      return Promise.reject(new Error('AbortError'))
    },
  }
  assert.equal(await acquireScannerRole({ locks: throwing }), 'writer')
  assert.equal(await acquireScannerRole({ locks: rejecting }), 'writer')
})

test('MAIN9-1: a request that settles without calling the callback resolves writer, so the boot never hangs', async () => {
  const silent: LockManagerLike = {
    request() {
      return Promise.resolve(undefined)
    },
  }
  assert.equal(await acquireScannerRole({ locks: silent }), 'writer')
})

// ── MAIN9-2: the wiring in main.ts ───────────────────────────────────────────────

test('source shape: MAIN9-2: main.ts awaits the lock decision before the store is constructed or opened', () => {
  const main = read('src/main.ts')
  const decided = main.indexOf('await acquireScannerRole(navigator)')
  const made = main.indexOf('new DetectionStore(')
  const opened = main.indexOf('await store.open()')
  assert.match(main, /import \{ acquireScannerRole \} from '\.\/shared\/scanner-lock\.ts'/, 'the helper is imported from the shared module')
  assert.ok(decided > 0, 'the decision is awaited in main')
  assert.ok(decided < made, 'the decision is awaited before the store is constructed')
  assert.ok(made < opened, 'the store is constructed before it is opened, as before')
})

test('source shape: MAIN9-2: a read-only page constructs the store with readOnly, and a writer constructs it as before', () => {
  const main = read('src/main.ts')
  assert.match(main, /const readOnlyScanner = scannerRole === 'readOnly'/)
  assert.match(main, /const store = readOnlyScanner \? new DetectionStore\(\{ readOnly: true \}\) : new DetectionStore\(\)/)
})

test('source shape: MAIN9-2: the read-only branch shows the notice, disables the capture controls with the same reason, and starts nothing', () => {
  const main = read('src/main.ts')
  assert.match(
    main,
    /const READ_ONLY_NOTICE = 'Scanner is open in another tab\. Close it, or reload this page, to capture here\.'/,
    'the notice, exactly as written',
  )
  const branchStart = main.indexOf('if (readOnlyScanner) {', main.indexOf('const READ_ONLY_NOTICE'))
  const branch = main.slice(branchStart, main.indexOf('await store.open()', branchStart))
  assert.ok(branchStart > 0, 'the read-only branch exists, after the notice is defined')
  assert.match(branch, /showReadOnlyNotice\(\)/, 'the notice goes into the status line')
  assert.match(branch, /disableCaptureControls\(READ_ONLY_NOTICE\)/, 'the existing disable, with the same reason')
  assert.doesNotMatch(
    branch,
    /kfStreamer|adoptServerSession|putCapture|saveSnapshot|queueAutoSave|\.start\(|RtcBroadcaster|broadcaster/,
    'the branch starts no session, no stream and no write',
  )
})

test('source shape: MAIN9-2: a read-only page opens no place picker, so no scan, upload or tripod sweep starts there', () => {
  const main = read('src/main.ts')
  assert.match(main, /requestPlaceSelection = readOnlyScanner \? showReadOnlyNotice : placePicker\.open/)
})

test('source shape: MAIN10-6: main awaits the role decision before the write paths are wired, so a read-only page wires them with the role known', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('async function main() {')
  assert.ok(start > 0, 'main is in main.ts')
  const decided = main.indexOf('await acquireScannerRole(navigator)', start)
  assert.ok(decided > start, 'the decision is awaited inside main')
  for (const [name, call] of [
    ['wireContentUpload', /^  wireContentUpload\(readOnlyScanner\)$/m],
    ['mountTripodCapture', /^  mountTripodCapture\(readOnlyScanner\)$/m],
  ] as const) {
    const at = main.slice(start).search(call)
    assert.ok(at >= 0, name + '() is called in main with the role')
    assert.ok(decided < start + at, 'the role decision is awaited before ' + name + '() is called')
  }
})

test('source shape: MAIN9-2: a read-only page runs no manual export, which would upload the scan', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('async function exportManualScan()')
  const gate = main.indexOf('if (readOnlyScanner) {', start)
  const upload = main.indexOf('exportToGLB(', start)
  assert.ok(start > 0, 'the export function is in main')
  assert.ok(gate > start && gate < upload, 'the read-only check comes before the export is run')
  assert.match(main.slice(gate, upload), /return \{ outcome: 'cancelled' \}/)
})

// ── MAIN9-3: a refused adoption runs no success callback ─────────────────────────

test('source shape: MAIN9-3: the success callback of adoptServerSession runs only when the call returned true', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('kfStreamer.onSessionId = (sessionId) => {')
  const body = main.slice(start, main.indexOf('currentSessionGlbFilename = undefined', start))
  const then = body.indexOf('store.adoptServerSession(sessionId).then((adopted) => {')
  const guard = body.indexOf('if (!adopted) return', then)
  const count = body.indexOf('captureCount = Math.max(captureCount', then)
  assert.ok(start > 0, 'the session-id hook is in main')
  assert.ok(then > 0, 'the adoption result is passed to the success callback')
  assert.ok(guard > then && guard < count, 'a refused adoption returns before the count and the session are updated')
})
