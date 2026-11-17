/**
 * F101 (src/ui/ftue-status.ts): a 401 from Companion Memory means "sign in to check" while sign-in is on,
 * since the endpoint is session-guarded then. Any other failure, and a 401 with sign-in off, reads "Status unavailable.".
 * The rows must still fit the first-run word budget (tests/unit/node/startup_word_budget.test.ts).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e-ftue-status.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGN_IN_FAILED,
  fetchFtueSnapshot,
  ftueRowText,
  ftueRows,
  type FtueSnapshot,
} from '../../../src/ui/ftue-status.ts'

const MODEL = 'Ollama/qwen3-vl:4b'

/** A fetch stand-in that answers each path with a canned status and body. */
function fakeFetch(routes: Record<string, { status?: number, body: unknown } | 'throw'>): typeof fetch {
  return ((input: string | URL | Request): Promise<Response> => {
    const route = routes[String(input)]
    if (route === 'throw' || route === undefined) return Promise.reject(new TypeError('network down'))
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return Promise.resolve(new Response(text, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
}

test('a signed-out Companion Memory says to sign in, and is not a failure', async () => {
  const snap = await fetchFtueSnapshot(fakeFetch({
    '/memory/status': { status: 401, body: { error: 'Sign in with your Companion Account to use this Scan.' } },
    '/health': { body: { model: MODEL, engineLoadState: 'ready' } },
    '/authenticate/status': { body: { enabled: true } },
  }))
  assert.equal(snap.memory, 'signed-out')
  const rows = ftueRows(snap)
  assert.equal(rows.length, 3, 'a 401 is an answer, so the three-row screen stays')
  assert.equal(ftueRowText(rows[0]!), 'Companion Memory Sign in to check Companion Memory.')
})

test('a real failure of Companion Memory still says Status unavailable', async () => {
  const failures: Array<{ status?: number, body: unknown } | 'throw'> = [{ status: 500, body: { error: 'proxy' } }, 'throw']
  for (const memory of failures) {
    const snap = await fetchFtueSnapshot(fakeFetch({
      '/memory/status': memory,
      '/health': 'throw',
      '/authenticate/status': { body: { enabled: false } },
    }))
    assert.equal(snap.memory, null)
    assert.equal(ftueRowText(ftueRows(snap)[0]!), 'Companion Memory Status unavailable.')
  }
})

test('a 401 from the other two endpoints is no answer, as any failure is', async () => {
  const snap = await fetchFtueSnapshot(fakeFetch({
    '/memory/status': { body: { enabled: false } },
    '/health': { status: 401, body: { error: 'Sign in' } },
    '/authenticate/status': { status: 401, body: {} },
  }))
  assert.equal(snap.engine, null)
  assert.equal(snap.signIn, null)
  const rows = ftueRows(snap)
  assert.equal(ftueRowText(rows[1]!), 'Model Status unavailable.')
  assert.equal(ftueRowText(rows[2]!), 'Sign-in Status unavailable.')
})

test('the signed-out row shows no address or secret, and the rows still fit the first-run word budget', () => {
  const memories: FtueSnapshot['memory'][] = ['signed-out', { enabled: true, reachable: true }, null]
  const engines: FtueSnapshot['engine'][] = [
    null,
    { model: MODEL, engineLoadState: 'loading' },
    { model: MODEL, engineLoadState: 'failed' },
  ]
  const signIns: FtueSnapshot['signIn'][] = [
    null,
    { enabled: false },
    { enabled: true },
    { enabled: true, problem: SIGN_IN_FAILED },
  ]
  for (const memory of memories) for (const engine of engines) for (const signIn of signIns) {
    for (const row of ftueRows({ memory, engine, signIn })) {
      assert.doesNotMatch(ftueRowText(row), /https?:|\/api|token|key/i)
    }
  }

  // The signed-out combination: a signed-out memory, a failed model and the sign-in link, 30 words. The longest
  // combination is a not-connected memory with a failed model and the sign-in link, 32 words: the budget's pinned worst case.
  const worst = ftueRows({ memory: 'signed-out', engine: { model: MODEL, engineLoadState: 'failed' }, signIn: { enabled: true } })
  const words = worst.map(ftueRowText).join(' ').split(/\s+/).length
  assert.ok(words <= 32, `the rows cost ${words} words, and the first-run budget allows 32`)
})
