/**
 * WebGPU inference worker.
 *
 * Runs LFM2.5-VL-1.6B-ONNX entirely on-device via the runtime-agnostic
 * driver (./lfm-driver.ts, wave 05 ticket 0001) against onnxruntime-web's
 * WebGPU execution provider (./lfm-driver-web.ts, wave 05 ticket 0003 —
 * docs/factory/05-on-device-inference/0003-webgpu-driver-runtime.md).
 *
 * Replaces the previous `pipeline('image-text-to-text', ...)` call, which
 * could never work: that string was never a registered Transformers.js
 * pipeline task in any released version (verified against 3.8.1 and
 * 4.2.0), and the pipeline() API has never been able to express this model
 * — see ticket 0003's "What this replaces". The env configuration, progress
 * protocol, message handler and parseDetections wiring that survive from
 * that version are unchanged; only model construction and generation
 * changed.
 *
 * Un-gated as of wave 05 ticket 0004
 * (docs/factory/05-on-device-inference/0004-ungate-toggle-and-fallback-policy.md)
 * — offered whenever `InferenceRouter.hasWebGPU` (src/inference/router.ts)
 * is true, which is now a pure device-capability check rather than a
 * build-time flag. That ticket also owns the fallback policy: a failure
 * here surfaces to the caller as a typed `WebGpuInferenceError` instead of
 * silently retrying through the server.
 *
 * Assumes ticket 0002's model-provisioning cache
 * (src/inference/model-provisioning.ts) is already fully populated; if it
 * isn't, ./lfm-driver-web.ts throws a clear error rather than silently
 * fetching from the network — see that file's header.
 *
 * Message protocol (main → worker):
 *   { type: 'infer', id: string, imageDataUrl: string }
 *
 * Message protocol (worker → main):
 *   { type: 'result', id: string, detections: RawDetection[] }
 *   { type: 'error',  id: string, message: string }
 *   { type: 'progress', stage: string, pct: number }   (during model load)
 *
 * Unchanged from before ticket 0003 — src/inference/router.ts:134-166 reads
 * these same three shapes.
 */
import { loadLfmDriver, runLfmDriver } from './lfm-driver'
import type { LfmDriverHandle } from './lfm-driver'
import { createWebGpuPort } from './lfm-driver-web'
import type { RawDetection } from './prompt'

// One port instance for the worker's lifetime — stateless beyond the
// module-scope `ort.env` configuration lfm-driver-web.ts sets, so reused
// across both loadLfmDriver (session/tokenizer setup) and every
// runLfmDriver call (patchify's decodeImage + Tensor construction).
const webGpuPort = createWebGpuPort()

// executionProviders: WebGPU only. The CPU/WASM path already exists as the
// server's inference path (src/inference/server.ts → the Deno API); the
// entire point of this worker is running on the phone's own GPU instead.
const SESSION_OPTS = {
  executionProviders: ['webgpu'],
  graphOptimizationLevel: 'all',
} as const

// ─── Driver loading (lazy, once) ────────────────────────────────────────────
let driverPromise: Promise<LfmDriverHandle> | null = null

function getOrLoadDriver(): Promise<LfmDriverHandle> {
  if (!driverPromise) {
    self.postMessage({ type: 'progress', stage: 'Loading model…', pct: 0 })
    driverPromise = loadLfmDriver(webGpuPort, SESSION_OPTS)
      .then((handle) => {
        self.postMessage({ type: 'progress', stage: 'Model ready', pct: 1 })
        return handle
      })
      .catch((err: unknown) => {
        // Don't cache a permanent failure — a later 'infer' (e.g. after the
        // user finishes provisioning) gets a fresh attempt.
        driverPromise = null
        throw err
      })
  }
  return driverPromise
}

// ─── Message handler ─────────────────────────────────────────────────────────
self.addEventListener('message', async (evt: MessageEvent<{ type: string; id: string; imageDataUrl: string }>) => {
  const { type, id, imageDataUrl } = evt.data
  if (type !== 'infer') return

  try {
    const handle = await getOrLoadDriver()

    // data: URL → bytes. fetch() supports the data: scheme directly, so this
    // never touches the network (same contract the old RawImage.fromURL
    // conversion had — worker input stays local).
    const imageBytes = new Uint8Array(await (await fetch(imageDataUrl)).arrayBuffer())

    const detections: RawDetection[] = await runLfmDriver(webGpuPort, handle, imageBytes)

    self.postMessage({ type: 'result', id, detections })
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err) })
  }
})
