/**
 * The Scan server form's logic (src/ui/server-setting.ts): what a test of an address
 * finds, and the words for every answer and every refusal. The form itself is DOM and
 * is exercised in the shells; fetch is a stand-in here, so this runs in Node.
 *
 * Run: npm run test:server-setting
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CHECK_TEXT, PROBLEM_TEXT, checkMessage, checkServer } from '../../../src/ui/server-setting.ts'
import type { ServerAddressProblem } from '../../../src/shared/api-base.ts'

const ORIGIN = 'https://scan.example.ts.net'

/** A fetch that answers with `respond`, and records what it was asked and how. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const asked: Array<{ url: string, init: RequestInit | undefined }> = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), init })
    return await respond()
  }) as typeof fetch
  return { fetchFn, asked }
}

test('a Scan server is what answers /health with status ok and a model', async () => {
  const { fetchFn, asked } = fakeFetch(() => Response.json({ status: 'ok', model: 'Ollama/qwen3-vl:4b', engineLoadState: 'ready' }))
  assert.equal(await checkServer(ORIGIN, fetchFn), 'ok')
  assert.equal(asked[0]?.url, `${ORIGIN}/health`)
  assert.equal(asked[0]?.init?.credentials, 'omit', 'a test sends no cookie and no token to an address not yet saved')
})

test('anything else that answers is not a Scan server', async () => {
  const answers = [
    () => new Response('<!doctype html>', { status: 404 }),
    () => new Response('<!doctype html><title>Hub</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ status: 'ok' }),
    () => Response.json({ status: 'starting', model: 'x' }),
    () => Response.json({ error: 'nope' }, { status: 500 }),
  ]
  for (const answer of answers) {
    assert.equal(await checkServer(ORIGIN, fakeFetch(answer).fetchFn), 'not-scan')
  }
})

test('no answer at all, a timeout, and a refused origin are one answer', async () => {
  const thrown = fakeFetch(() => { throw new TypeError('Failed to fetch') })
  assert.equal(await checkServer(ORIGIN, thrown.fetchFn), 'no-answer')
  const aborted = fakeFetch(() => { throw new DOMException('timed out', 'TimeoutError') })
  assert.equal(await checkServer(ORIGIN, aborted.fetchFn), 'no-answer')
})

test('every refusal and every answer has words, and none of them shows a secret', () => {
  const problems: ServerAddressProblem[] = ['empty', 'not-a-url', 'not-https', 'has-path', 'has-credentials', 'own-origin']
  assert.deepEqual(Object.keys(PROBLEM_TEXT).sort(), [...problems].sort())
  for (const text of [...Object.values(PROBLEM_TEXT), ...Object.values(CHECK_TEXT)]) {
    assert.ok(text.length > 0)
    assert.doesNotMatch(text, /token|key|password:/i)
  }
  assert.match(PROBLEM_TEXT['not-https'], /https:\/\//)
})

test('a save says it saved, and then what the test found', () => {
  assert.equal(checkMessage('ok', false), 'A Scan server answered.')
  assert.equal(checkMessage('ok', true), 'Saved. A Scan server answered.')
  assert.equal(checkMessage('no-answer', true), `Saved. ${CHECK_TEXT['no-answer']}`)
})
