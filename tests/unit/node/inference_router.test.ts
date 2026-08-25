/**
 * InferenceRouter — capability gating and the on-device fallback policy.
 *
 * Wave 05 ticket 0004 (docs/factory/05-on-device-inference/
 * 0004-ungate-toggle-and-fallback-policy.md) replaces a build-time
 * `WEBGPU_INFERENCE_ENABLED` flag with a pure `navigator.gpu` capability
 * check, and replaces two silent server fallbacks (a stuck on-device
 * request, and a crashed worker's in-flight requests) with a typed
 * `WebGpuInferenceError` the caller must handle explicitly. These tests
 * stub the browser globals router.ts expects (`Worker`, `navigator`,
 * `FileReader`, `localStorage`) so that fallback logic — the actual bug
 * this ticket fixes — runs against the real router.ts, not a re-description
 * of it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/inference_router.test.ts
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { InferenceRouter, WebGpuInferenceError } from '../../../src/inference/router.ts'

// ─── Browser-global stubs ──────────────────────────────────────────────────
// router.ts assumes a browser: a Worker constructor, navigator.gpu for
// capability detection, FileReader for the blob → data URL conversion
// infer() does before posting to the worker, and localStorage for the
// persisted preference. None of these exist in Node by default.

type Listener = (evt: unknown) => void

class FakeWorker {
  static instances: FakeWorker[] = []
  private listeners: Record<string, Listener[]> = { message: [], error: [] }
  posted: unknown[] = []
  constructor(_url: unknown, _opts: unknown) {
    FakeWorker.instances.push(this)
  }
  addEventListener(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  terminate(): void {}
  /** Test helper: deliver a fake message/error event to every listener. */
  emit(type: 'message' | 'error', data: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(data)
  }
}

class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsDataURL(_blob: Blob): void {
    queueMicrotask(() => {
      this.result = 'data:image/jpeg;base64,ZmFrZQ=='
      this.onload?.()
    })
  }
}

class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
;(globalThis as unknown as { FileReader: unknown }).FileReader = FakeFileReader

function setGpuSupported(supported: boolean): void {
  // Node >=21 ships its own read-only `navigator` global (Node's
  // NavigatorConcurrentHardware, unrelated to a browser's), so a plain
  // assignment throws — redefine the property instead.
  Object.defineProperty(globalThis, 'navigator', {
    value: supported ? { gpu: {} } : {},
    configurable: true,
    writable: true,
  })
}

function frame(): Blob {
  return new Blob([new Uint8Array(8)], { type: 'image/jpeg' })
}

/**
 * infer()'s blob→dataURL conversion resolves through FakeFileReader's queued
 * microtask before the worker.postMessage() call happens, so a test that
 * needs to inspect what was posted has to let a few microtask turns pass
 * first. Several ticks rather than a hand-counted exact number, so this
 * doesn't silently start failing on an unrelated internal reshuffle.
 */
async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

// ─── Capability check ───────────────────────────────────────────────────────

test('hasWebGPU: a pure navigator.gpu check, not a build flag', () => {
  const router = new InferenceRouter()
  setGpuSupported(true)
  assert.equal(router.hasWebGPU, true)
  setGpuSupported(false)
  assert.equal(router.hasWebGPU, false)
})

// ─── Un-gating: the stored preference wave 04 preserved is honoured ────────

test('init: a pre-gate "webgpu" preference resolves to on-device on a capable device', async () => {
  setGpuSupported(true)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = new FakeStorage()
  ;(globalThis.localStorage as unknown as FakeStorage).setItem('infer-mode', 'webgpu')

  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.path, 'webgpu', 'the choice made before wave 04 gated the toggle is honoured now that it is lifted')
})

test('init: a stored "webgpu" preference still resolves to server without a WebGPU device', async () => {
  setGpuSupported(false)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = new FakeStorage()
  ;(globalThis.localStorage as unknown as FakeStorage).setItem('infer-mode', 'webgpu')

  const router = new InferenceRouter()
  await router.init()
  assert.equal(router.path, 'server', 'resolved at read time, never overwritten — the preference survives for a capable device later')
})

// ─── Fallback policy: no path silently sends an image to the server ───────

test('infer: a stuck on-device request rejects instead of silently falling back to the server', async () => {
  setGpuSupported(true)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = new FakeStorage()

  const router = new InferenceRouter()
  router.setMode('webgpu')
  assert.equal(router.path, 'webgpu')

  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = router.infer(frame())
    // infer()'s setTimeout() call is registered only after the blob→dataURL
    // conversion's queued microtask resolves — let that settle before
    // advancing the (mocked) clock, or there is no timer yet to fire.
    await flushMicrotasks()
    // Nothing has resolved the worker's 'infer' message, so the request is
    // stuck. WORKER_TIMEOUT_LOADING_MS applies before the model has reported
    // ready (150_000ms) — advance past it.
    mock.timers.tick(150_001)

    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof WebGpuInferenceError, `expected WebGpuInferenceError, got ${String(err)}`)
      assert.equal((err as InstanceType<typeof WebGpuInferenceError>).code, 'timeout')
      return true
    })
    // The defect this ticket fixes: router.path must still read 'webgpu' —
    // a silent per-request fallback used to leave this true while the image
    // had actually gone to the server, which is exactly the lie the panel's
    // "On-device — no data leaves your phone" copy must not tell.
    assert.equal(router.path, 'webgpu', 'a single stuck request must not flip the router to server behind the UI\'s back')
  } finally {
    mock.timers.reset()
  }
})

test('infer: a worker-reported error rejects with a typed, distinguishable code', async () => {
  setGpuSupported(true)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = new FakeStorage()

  const router = new InferenceRouter()
  router.setMode('webgpu')
  const worker = FakeWorker.instances.at(-1)!

  const pending = router.infer(frame())
  await flushMicrotasks()
  assert.equal(worker.posted.length, 1, 'infer() must have posted the request to the worker by now')
  const posted = worker.posted[0] as { id: string }
  worker.emit('message', {
    data: { type: 'error', id: posted.id, message: 'on-device model file not cached: onnx/decoder_q4.onnx' },
  })

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof WebGpuInferenceError)
    assert.equal((err as InstanceType<typeof WebGpuInferenceError>).code, 'not-provisioned')
    return true
  })
})

test('setMode: persists the preference and restores its original (pre-gate) meaning', () => {
  setGpuSupported(true)
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = new FakeStorage()
  const storage = globalThis.localStorage as unknown as FakeStorage

  const router = new InferenceRouter()
  router.setMode('webgpu')
  assert.equal(storage.getItem('infer-mode'), 'webgpu')
  router.setMode('server')
  assert.equal(storage.getItem('infer-mode'), 'server')
})
