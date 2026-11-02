/**
 * How the server inference client names a failed /infer call (src/inference/server.ts).
 * A 502 is the Vite proxy failing to reach the server, which the person reads as
 * "Server unreachable", so it must come out as a network failure, not a generic
 * HTTP error.
 *
 * Run: npm run test:inference-errors
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inferViaServer } from '../../../src/inference/server.ts'

/** Answers every /infer request with the same status and body, and counts the attempts. */
function stubFetch(status: number, body: string) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(body, { status })
  }) as typeof fetch
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = original },
  }
}

test('a 502 from the proxy is a network failure: retried, then reported as unreachable', async () => {
  const stub = stubFetch(502, 'Bad Gateway')
  try {
    await assert.rejects(inferViaServer(new Blob(['frame'], { type: 'image/jpeg' })), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'network')
      assert.equal((error as { status?: number }).status, 502)
      return true
    })
    assert.equal(stub.calls(), 3, 'three attempts, as for the other transient failures')
  } finally {
    stub.restore()
  }
})

test('other failure statuses keep their own code and are not retried', async () => {
  const stub = stubFetch(400, JSON.stringify({ error: 'bad frame' }))
  try {
    await assert.rejects(inferViaServer(new Blob(['frame'], { type: 'image/jpeg' })), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'http')
      return true
    })
    assert.equal(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})
