/**
 * WP-C / F68: WebGPU counts as available only when the browser gives an adapter.
 *
 * `navigator.gpu` on its own used to decide it. A browser can expose the object
 * with no usable adapter, and then the on-device path failed on every capture.
 * probeWebGPU() asks requestAdapter() under a short timeout and caches the answer.
 * src/main.ts awaits it before the side panel is built, and init() reuses it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-router-webgpu.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InferenceRouter } from '../../../src/inference/router.ts'

function setNavigator(value: unknown): void {
  // Node >=21 ships a read-only `navigator` global, so redefine the property.
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

test('F68: navigator.gpu present, requestAdapter resolves null: not WebGPU', async () => {
  setNavigator({ gpu: { requestAdapter: async () => null } })
  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.hasWebGPU, false)
})

test('F68: navigator.gpu present, requestAdapter rejects: not WebGPU', async () => {
  setNavigator({ gpu: { requestAdapter: async () => { throw new Error('blocklisted') } } })
  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.hasWebGPU, false)
})

test('F68: no navigator.gpu at all: not WebGPU', async () => {
  setNavigator({})
  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.hasWebGPU, false)
})

test('F68: navigator.gpu with an adapter: WebGPU', async () => {
  setNavigator({ gpu: { requestAdapter: async () => ({ limits: {} }) } })
  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.hasWebGPU, true)
})

test('F68: a requestAdapter that never answers counts as no adapter after the probe timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  setNavigator({ gpu: { requestAdapter: () => new Promise(() => {}) } })
  const router = new InferenceRouter()
  const probing = router.init()
  t.mock.timers.tick(2_000)
  await probing
  assert.equal(router.hasWebGPU, false)
})

test('C1-1: before probeWebGPU() has run, WebGPU is not claimed; after it, a WebGPU browser reads true with no init()', async () => {
  setNavigator({ gpu: { requestAdapter: async () => ({ limits: {} }) } })
  const router = new InferenceRouter()
  assert.equal(router.hasWebGPU, false, 'not claimed before the probe')
  assert.equal(await router.probeWebGPU(), true)
  assert.equal(router.hasWebGPU, true, 'the panel is built after this probe, so its toggle is enabled')
})

test('C1-1: an adapter request that resolves to nothing (undefined too) counts as no adapter', async () => {
  setNavigator({ gpu: { requestAdapter: async () => undefined } })
  const router = new InferenceRouter()
  assert.equal(await router.probeWebGPU(), false)
  assert.equal(router.hasWebGPU, false)
})

test('C1-1: probeWebGPU() asks the browser once, and init() reuses that answer', async () => {
  let asked = 0
  setNavigator({ gpu: { requestAdapter: async () => { asked++; return { limits: {} } } } })
  const router = new InferenceRouter()
  assert.equal(await router.probeWebGPU(), true)
  assert.equal(await router.probeWebGPU(), true)
  await router.init()
  assert.equal(router.hasWebGPU, true)
  assert.equal(asked, 1, 'one requestAdapter() call serves the panel and init() alike')
})
