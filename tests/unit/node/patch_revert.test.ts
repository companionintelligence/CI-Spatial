/**
 * What the editor asks of the undo route and what it does with the answer (src/viewer/patch-revert.ts).
 *
 * viewer.ts hands the module how to send, how to read a refusal and where to put the world, so these tests give it
 * ordinary replies and watch what it asks and what it keeps. The route itself is in tests/unit/deno/patch_routes.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/patch_revert.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'
import { OFFLINE_UNDO_SENTENCE, requestRevert, type RevertEnvironment } from '../../../src/viewer/patch-revert.ts'
import { plainServerError } from '../../../src/viewer/transform-tools.ts'
import type { WorldProject } from '../../../src/world/types.ts'

const world = { worldId: 'world-a', scans: [], editPatches: [] } as unknown as WorldProject

function environment(reply: Response, over: Partial<RevertEnvironment> = {}): { env: RevertEnvironment; asked: string[]; taken: WorldProject[]; refusals: number[] } {
  const asked: string[] = []
  const taken: WorldProject[] = []
  const refusals: number[] = []
  const env: RevertEnvironment = {
    post: async (body) => {
      asked.push(body)
      return reply
    },
    // The viewer's httpError(): the status and the server's own text, with the status on the error.
    refused: async (response) => {
      refusals.push(response.status)
      return Object.assign(new Error(`${response.status} ${await response.text()}`), { status: response.status })
    },
    stillCurrent: () => true,
    take: (answered) => {
      taken.push(answered)
    },
    ...over,
  }
  return { env, asked, taken, refusals }
}

const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init })

test('it asks for the scan and for the move the person saw as the last one, and keeps the world that comes back', async () => {
  const { env, asked, taken } = environment(json({ ok: true, world }))
  await requestRevert(env, 'scan-a', 'patch-7')
  assert.deepEqual(asked.map((body) => JSON.parse(body)), [{ scanId: 'scan-a', patchId: 'patch-7' }])
  assert.deepEqual(taken, [world])
})

test('a refused undo becomes the viewer\'s error, with the server\'s sentence in it, and no world is taken', async () => {
  const sentence = 'This scan was changed after you opened it. Reload the Place and try again.'
  const { env, taken, refusals } = environment(json({ error: sentence }, { status: 409 }))
  await assert.rejects(() => requestRevert(env, 'scan-a', 'patch-7'), (error: Error & { status?: number }) => {
    assert.equal(error.status, 409)
    assert.equal(plainServerError(error, 'fallback'), sentence)
    return true
  })
  assert.deepEqual(refusals, [409])
  assert.deepEqual(taken, [])
})

test('an undo the service worker only queued is not an undo that happened: it says so, in the shape of a refusal, and takes no world', async () => {
  const queued = new Response(JSON.stringify({ queued: true }), { status: 202, headers: { [QUEUED_OFFLINE_HEADER]: '1' } })
  assert.equal(queued.ok, true, 'the reply the service worker makes counts as ok, which is why it has to be looked for')
  const { env, taken, refusals } = environment(queued)
  await assert.rejects(() => requestRevert(env, 'scan-a', 'patch-7'), (error: Error & { status?: number }) => {
    assert.equal(error.status, 202)
    assert.equal(plainServerError(error, 'fallback'), OFFLINE_UNDO_SENTENCE)
    return true
  })
  assert.deepEqual(taken, [])
  assert.deepEqual(refusals, [], 'it is not read as a refusal by the server')
  assert.match(OFFLINE_UNDO_SENTENCE, /offline/)
})

test('a world that arrives after the Place on screen changed is not taken, and it is not an error', async () => {
  const { env, taken } = environment(json({ ok: true, world }), { stillCurrent: () => false })
  await requestRevert(env, 'scan-a', 'patch-7')
  assert.deepEqual(taken, [])
})

test('a request that never reached the server throws what fetch threw, and takes nothing', async () => {
  const { env, taken } = environment(json({}), { post: () => Promise.reject(new TypeError('network down')) })
  await assert.rejects(() => requestRevert(env, 'scan-a', 'patch-7'), /network down/)
  assert.deepEqual(taken, [])
})
