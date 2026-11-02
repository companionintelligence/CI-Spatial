/**
 * The service worker's offline queue policy (public/sw.js): which writes are
 * queued, how many are kept and for how long, which replay failures keep a body,
 * and what the installed app can show without a network.
 *
 * The IndexedDB flush itself needs a browser, so tests/mock-offline-queue.spec.ts
 * covers it end to end. This file pins the rules the flush applies.
 *
 * Run: npm run test:sw-queue
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Runs public/sw.js as a classic script in a sandbox with a stub service worker
 * scope. Its top level only registers event listeners and sets constants, so no
 * event fires here, and the rules are read straight from the context.
 */
function loadServiceWorker(): vm.Context {
  const context = vm.createContext({
    self: { addEventListener() {} },
    Request,
    Response,
    URL,
    Headers,
  })
  vm.runInContext(readFileSync(join(ROOT, 'public/sw.js'), 'utf8'), context, { filename: 'public/sw.js' })
  return context
}

const sw = loadServiceWorker()
const read = <T>(expression: string) => vm.runInContext(expression, sw) as T
const isQueueableWrite = read<(request: Request, url: URL) => boolean>('isQueueableWrite')

function queued(method: string, path: string) {
  const url = new URL(`https://scan.test${path}`)
  return isQueueableWrite(new Request(url, { method }), url)
}

test('the queue keeps at most 24 writes, for a day, and replays each one at most five times', () => {
  assert.equal(read<number>('MAX_QUEUE_ITEMS'), 24)
  assert.equal(read<number>('MAX_QUEUE_AGE_MS'), 24 * 60 * 60 * 1000)
  assert.equal(read<number>('MAX_FLUSH_ATTEMPTS'), 5)
})

test('a replay that fails with 401, 403, 408 or 429 keeps the body; other statuses under 500 drop it', () => {
  assert.deepEqual([...read<number[]>('RETRIABLE_FLUSH_STATUSES')], [401, 403, 408, 429])
})

test('writes to the scan routes are queued, and reads and inference never are', () => {
  assert.equal(queued('POST', '/upload-scan'), true)
  assert.equal(queued('PUT', '/worlds/default/pins'), true)
  assert.equal(queued('PATCH', '/projects/p1'), true)
  assert.equal(queued('POST', '/sessions/s1/keyframes'), true)
  assert.equal(queued('GET', '/upload-scan'), false, 'a read has nothing to replay')
  assert.equal(queued('POST', '/infer'), false, 'the caller is waiting for the answer')
})

test('the queue matches whole path segments, so a longer route is not swept in', () => {
  assert.equal(queued('POST', '/upload-scanner'), false)
  assert.equal(queued('POST', '/worldsX/pins'), false)
})

test('every icon in the manifest is precached, so the installed app shows it offline', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public/manifest.json'), 'utf8')) as { icons: Array<{ src: string }> }
  const shell = [...read<string[]>('APP_SHELL')]
  for (const icon of manifest.icons) assert.ok(shell.includes(icon.src), `${icon.src} is not in APP_SHELL`)
  assert.ok(shell.includes('/apple-touch-icon.png'), 'iOS fetches the apple touch icon when the app is added to the home screen')
})
