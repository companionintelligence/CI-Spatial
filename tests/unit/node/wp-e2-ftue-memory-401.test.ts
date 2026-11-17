/**
 * The Companion Memory row after a 401 (E3, src/ui/ftue-status.ts). The 401 asks for a sign-in only where
 * sign-in is on. Where it is off, or its reply cannot be read, the 401 is no answer and the row reads
 * "Status unavailable.". Fetch is a stand-in, so this runs in Node.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e2-ftue-memory-401.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchFtueSnapshot, ftueRowText, ftueRows } from '../../../src/ui/ftue-status.ts'

const MODEL = 'Ollama/qwen3-vl:4b'

type Reply = { status?: number, body: unknown } | 'throw'

/** A fetch stand-in that answers each path with a canned status and body. */
function fakeFetch(routes: Record<string, Reply>): typeof fetch {
  return ((input: string | URL | Request): Promise<Response> => {
    const route = routes[String(input)]
    if (route === 'throw' || route === undefined) return Promise.reject(new TypeError('network down'))
    return Promise.resolve(new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
}

const MEMORY_401: Reply = { status: 401, body: { error: 'Sign in with your Companion Account to use this Scan.' } }
const HEALTH_OK: Reply = { body: { model: MODEL, engineLoadState: 'ready' } }

const cases: Array<{ signIn: string, reply: Reply, asksForSignIn: boolean }> = [
  { signIn: 'sign-in is on', reply: { body: { enabled: true } }, asksForSignIn: true },
  { signIn: 'sign-in is off', reply: { body: { enabled: false } }, asksForSignIn: false },
  { signIn: 'the sign-in reply is a 401', reply: { status: 401, body: {} }, asksForSignIn: false },
  { signIn: 'the sign-in reply cannot be reached', reply: 'throw', asksForSignIn: false },
]

for (const { signIn, reply, asksForSignIn } of cases) {
  test(`a 401 from Companion Memory with ${signIn} ${asksForSignIn ? 'asks for a sign-in' : 'reads Status unavailable'}`, async () => {
    const snap = await fetchFtueSnapshot(fakeFetch({
      '/memory/status': MEMORY_401,
      '/health': HEALTH_OK,
      '/authenticate/status': reply,
    }))
    const row = ftueRows(snap)[0]!
    if (asksForSignIn) {
      assert.equal(snap.memory, 'signed-out')
      assert.equal(ftueRowText(row), 'Companion Memory Sign in to check Companion Memory.')
    } else {
      assert.equal(snap.memory, null)
      assert.equal(ftueRowText(row), 'Companion Memory Status unavailable.')
    }
  })
}
