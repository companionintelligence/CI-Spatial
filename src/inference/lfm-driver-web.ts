/**
 * Browser implementation of the LFM2.5-VL driver port (./lfm-driver.ts) —
 * wave 05 ticket 0003
 * (docs/factory/05-on-device-inference/0003-webgpu-driver-runtime.md).
 *
 * This is the runtime-specific half the port exists to isolate, mirroring
 * server/lfm-driver-onnx.ts's role on the Deno side: session creation via
 * onnxruntime-web's WebGPU execution provider, JSON loads and image decode.
 * Everything else — the loop, the KV cache, the patchify maths — lives in
 * ./lfm-driver.ts and is not duplicated here (ticket 0003's Non-goals:
 * "Do not modify the driver module from 0001").
 *
 * Model bytes come from ticket 0002's IndexedDB cache
 * (./model-provisioning.ts's `getCachedModelFile`), never a fresh fetch —
 * ticket 0003's Pinned Conventions: "the cached weights | from ticket 0002
 * | consumed, not re-fetched." A cache miss throws rather than falling back
 * to the network; deciding what to do about an incomplete cache is ticket
 * 0004's fallback-policy job, not this port's.
 *
 * Each of the three ONNX graphs (embed_tokens_fp16.onnx, embed_images_fp16.onnx,
 * decoder_q4.onnx) references its weights through an external-data sidecar
 * (`<name>.onnx_data`) rather than embedding them inline — verified against
 * the actual downloaded files, not assumed: every initializer in all three
 * graphs resolves through `external_data`, none inline. That is how ticket
 * 0002's per-file cache entries map onto onnxruntime-web's model-loading
 * contract: the small `.onnx` graph loads from a `Uint8Array`, and its
 * sidecar is supplied via `SessionOptions.externalData` instead of a
 * second fetch (onnxruntime-web's `create(uri, …)` overload resolves
 * external data by fetching relative to the URI — irrelevant here, since
 * everything already lives in memory).
 */
import * as ort from 'onnxruntime-web/webgpu'
import type { LfmPort, LfmSession } from './lfm-driver'
import { getCachedModelFile } from './model-provisioning'

// Served locally by scripts/copy-ort-wasm.mjs (postinstall) into public/ort/
// — never onnxruntime-web's default remote asset resolution. See that
// script's header for why this can't reuse the ort-wasm-simd-threaded.jsep
// build @huggingface/transformers already drops in dist/assets/ (it floats
// on a different, dev-pinned onnxruntime-web version).
ort.env.wasm.wasmPaths = '/ort/'
// Already inside a Worker (src/inference/router.ts spawns this module with
// `new Worker(..., { type: 'module' })`) — don't proxy execution back to
// the main thread. Mirrors the original worker's identical intent for
// Transformers.js's env.backends.onnx.wasm.proxy.
ort.env.wasm.proxy = false
// No Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy headers are
// configured anywhere in this app (vite.config.ts, server/main.ts), so
// `crossOriginIsolated` is false and SharedArrayBuffer is unavailable.
// onnxruntime-web's threaded WASM build degrades to single-threaded
// automatically in that case, but pin it explicitly rather than lean on
// that silent auto-fallback.
ort.env.wasm.numThreads = 1

async function readCachedFile(path: string): Promise<Uint8Array> {
  const bytes = await getCachedModelFile(path)
  if (!bytes) {
    throw new Error(
      `on-device model file not cached: ${path} — provisionModel() must complete before on-device inference runs`,
    )
  }
  return bytes
}

/** Builds the browser `LfmPort`. Stateless beyond the module-scope `ort.env` configuration above. */
export function createWebGpuPort(): LfmPort {
  return {
    async createSession(name, opts): Promise<LfmSession> {
      const model = await readCachedFile(`onnx/${name}`)
      const dataPath = `${name}_data`
      const data = await readCachedFile(`onnx/${dataPath}`)
      return await ort.InferenceSession.create(model, {
        ...(opts as Record<string, unknown>),
        externalData: [{ path: dataPath, data }],
      })
    },
    async readJson(name) {
      const bytes = await readCachedFile(name)
      return JSON.parse(new TextDecoder('utf-8').decode(bytes))
    },
    async decodeImage(bytes, width, height) {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
      try {
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
        // Stretch to width×height, same non-aspect-preserving resize
        // server/lfm-driver-onnx.ts's Jimp `.resize({w,h})` performs — the
        // two ports must agree on this or the patchify maths in
        // ./lfm-driver.ts sees differently-shaped pixels on each runtime.
        ctx.drawImage(bitmap, 0, 0, width, height)
        const imageData = ctx.getImageData(0, 0, width, height)
        return { data: new Uint8Array(imageData.data.buffer), width, height }
      } finally {
        bitmap.close()
      }
    },
    Tensor: ort.Tensor,
  }
}
