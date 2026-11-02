/**
 * The first-run status rows (src/ui/ftue-status.ts): what each state says, what
 * is read from each endpoint, and what can never reach the screen.
 *
 * Run: npm run test:ftue:status
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGN_IN_HREF,
  fetchFtueSnapshot,
  ftueRowText,
  ftueRows,
  type FtueSnapshot,
} from '../../../src/ui/ftue-status.ts'

const MODEL = 'Ollama/qwen3-vl:4b'

/** A fetch stand-in that answers each path with a canned status and body, and records what was asked. */
function fakeFetch(routes: Record<string, { status?: number, body: unknown } | 'throw'>) {
  const asked: string[] = []
  const fetchFn = ((input: string | URL | Request): Promise<Response> => {
    const path = String(input)
    asked.push(path)
    const route = routes[path]
    if (route === 'throw' || route === undefined) return Promise.reject(new TypeError('network down'))
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return Promise.resolve(new Response(text, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  return { fetchFn, asked }
}

test('memory: says not connected, and sends the reader to Companion Hub', () => {
  const [row] = ftueRows({ memory: { enabled: false }, engine: null, signIn: null })
  assert.equal(ftueRowText(row!), 'Companion Memory Not connected. Connect Companion Memory in Companion Hub.')
})

test('memory: connected, configured but unreachable, and unavailable are three different rows', () => {
  const text = (memory: FtueSnapshot['memory']) => ftueRowText(ftueRows({ memory, engine: null, signIn: null })[0]!)
  assert.equal(text({ enabled: true, reachable: true }), 'Companion Memory Connected.')
  assert.equal(text({ enabled: true }), 'Companion Memory Connected.', 'no probe result still reads as configured')
  assert.equal(text({ enabled: true, reachable: false }), 'Companion Memory Set up, but not reachable.')
  assert.equal(text(null), 'Companion Memory Status unavailable.')
})

test('model: names the model without the Ollama prefix, and says whether it loaded', () => {
  const text = (engineLoadState: 'loading' | 'ready' | 'failed') =>
    ftueRowText(ftueRows({ memory: null, engine: { model: MODEL, engineLoadState }, signIn: null })[1]!)
  assert.equal(text('ready'), 'Model qwen3-vl:4b loaded.')
  assert.equal(text('loading'), 'Model Loading qwen3-vl:4b.')
})

test('model: a model that did not load says scans run server-only and get no object labels', () => {
  const failed = ftueRowText(ftueRows({ memory: null, engine: { model: MODEL, engineLoadState: 'failed' }, signIn: null })[1]!)
  assert.match(failed, /did not load/)
  assert.match(failed, /server-only mode/)
  assert.match(failed, /object labels will not be produced/)
})

test('sign-in: on gives a same-origin control that returns to the scanner; off says so', () => {
  const on = ftueRows({ memory: null, engine: null, signIn: { enabled: true } })[2]!
  assert.deepEqual(on.link, { href: SIGN_IN_HREF, text: 'Sign in with Companion Account' })
  assert.equal(on.label, undefined, 'the control names itself')
  assert.ok(SIGN_IN_HREF.startsWith('/') && !SIGN_IN_HREF.startsWith('//'), 'same origin')
  assert.ok(SIGN_IN_HREF.endsWith('redirect=%2F'), 'returns to the scanner root')

  const off = ftueRowText(ftueRows({ memory: null, engine: null, signIn: { enabled: false } })[2]!)
  assert.equal(off, 'Sign-in Off on this install.')
  assert.equal(ftueRows({ memory: null, engine: null, signIn: null })[2]!.text, 'Status unavailable.')
})

test('every state of every row is free of addresses and secrets', () => {
  const memories: FtueSnapshot['memory'][] = [null, { enabled: false }, { enabled: true }, { enabled: true, reachable: false }]
  const engines: FtueSnapshot['engine'][] = [null, { model: MODEL, engineLoadState: 'loading' }, { model: MODEL, engineLoadState: 'ready' }, { model: MODEL, engineLoadState: 'failed' }]
  const signIns: FtueSnapshot['signIn'][] = [null, { enabled: false }, { enabled: true }]
  for (const memory of memories) for (const engine of engines) for (const signIn of signIns) {
    for (const row of ftueRows({ memory, engine, signIn })) {
      const shown = ftueRowText(row)
      assert.doesNotMatch(shown, /https?:|\/api|token|key/i, `"${shown}" must not show an address or a secret`)
    }
  }
})

test('fetch: reads the named fields only, so a URL or token in a reply cannot reach the screen', async () => {
  const { fetchFn, asked } = fakeFetch({
    '/memory/status': {
      body: { enabled: true, baseUrl: 'https://memory.example/api', sourceSystem: 'companion-scan', reachable: true },
    },
    '/health': { body: { status: 'ok', model: MODEL, modelReady: true, mode: 'ollama', engineLoadState: 'ready' } },
    '/authenticate/status': { body: { enabled: false, issuer: 'https://portal.example' } },
  })
  const snap = await fetchFtueSnapshot(fetchFn)

  assert.deepEqual(snap.memory, { enabled: true, reachable: true })
  assert.deepEqual(snap.engine, { model: MODEL, engineLoadState: 'ready' })
  assert.deepEqual(snap.signIn, { enabled: false })
  assert.equal(JSON.stringify(snap).includes('memory.example'), false, 'the configured address is never copied')
  assert.equal(JSON.stringify(snap).includes('portal.example'), false, 'the issuer is never copied')
  assert.deepEqual(asked.sort(), ['/authenticate/status', '/health', '/memory/status'], 'same-origin reads only')
})

test('fetch: a failure, a timeout-shaped throw, or a malformed reply becomes unavailable, never a throw', async () => {
  const { fetchFn } = fakeFetch({
    '/memory/status': { status: 500, body: { error: 'proxy' } },
    '/health': 'throw',
    '/authenticate/status': { body: 'not an object' },
  })
  const snap = await fetchFtueSnapshot(fetchFn)
  assert.deepEqual(snap, { memory: null, engine: null, signIn: null })
})

test('fetch: an engine state the screen does not know is unavailable, not guessed', async () => {
  const { fetchFn } = fakeFetch({
    '/memory/status': { body: { enabled: false } },
    '/health': { body: { model: MODEL, engineLoadState: 'warming' } },
    '/authenticate/status': { body: { enabled: true } },
  })
  const snap = await fetchFtueSnapshot(fetchFn)
  assert.equal(snap.engine, null)
  assert.deepEqual(snap.signIn, { enabled: true })
})
