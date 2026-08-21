/**
 * WebGPU inference worker — UNREFERENCED. Nothing spawns this today.
 *
 * Gated off behind WEBGPU_INFERENCE_ENABLED (src/inference/router.ts) because it
 * cannot work as written, for two independent reasons:
 *
 *   1. It calls pipeline('image-text-to-text', ...), which is not a registered
 *      Transformers.js pipeline task in ANY released version. Verified against
 *      3.8.1 (50 tasks) and 4.2.0 (23 tasks) — the string appears only in JSDoc.
 *      Upgrading the dependency does not fix this; the pipeline() API has never
 *      been able to express this model.
 *   2. env.localModelPath points at /models/, which download_models.py populates
 *      and which is documented as an optional step — so the weights are usually
 *      absent anyway.
 *
 * Deliberately KEPT rather than deleted: the env configuration, progress
 * protocol, message handler, dtype choices and parseDetections wiring below are
 * all correct and are what wave 05 builds on. Only the model construction is
 * wrong. See docs/factory/05-on-device-inference/ — ticket 0003 replaces the
 * pipeline() call with the hand-rolled LFM2.5-VL driver on onnxruntime-web, and
 * ticket 0004 lifts the gate.
 *
 * Original intent follows.
 *
 * Runs LFM2.5-VL-1.6B-ONNX entirely on-device.
 *
 * Uses @huggingface/transformers (Transformers.js v3) which handles:
 *   - Tokenisation
 *   - Image pre-processing (resize, normalise, patch extraction)
 *   - ONNX session lifecycle with WebGPU execution provider
 *   - KV-cache management during greedy decoding
 *
 * Model files must be present at:
 *   public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/
 *     config.json
 *     tokenizer.json
 *     tokenizer_config.json
 *     preprocessor_config.json
 *     onnx/
 *       embed_tokens.onnx
 *       embed_images.onnx
 *       decoder_model.onnx  (+ optional .onnx_data shards)
 *
 * Download from: https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-ONNX
 *
 * Message protocol (main → worker):
 *   { type: 'infer', id: string, imageDataUrl: string }
 *
 * Message protocol (worker → main):
 *   { type: 'result', id: string, detections: RawDetection[] }
 *   { type: 'error',  id: string, message: string }
 *   { type: 'progress', stage: string, pct: number }   (during model load)
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — transformers@3 re-exports from .js files with no companion .d.ts
import { env, pipeline, RawImage } from '@huggingface/transformers'
import { SPATIAL_DETECTION_PROMPT, parseDetections } from './prompt'
import type { RawDetection } from './prompt'

// ─── Transformers.js configuration ──────────────────────────────────────────
// All model files are served from the Vite dev server / build output.
// Set allowRemoteModels = false so no HuggingFace Hub requests are made at
// runtime — everything must already be in public/models/.

env.allowLocalModels = true
env.localModelPath = '/models/'
env.allowRemoteModels = false

// Already inside a Worker — don't proxy ONNX WASM back to main thread.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false
}

// ─── Model loading (lazy, once) ─────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipeline = any
let pipelinePromise: Promise<AnyPipeline> | null = null

function getOrLoadPipeline(): Promise<AnyPipeline> {
  if (!pipelinePromise) {
    self.postMessage({ type: 'progress', stage: 'Loading model…', pct: 0 })

    const pipelineOpts = {
      device: 'webgpu',
      // Quantised weights: FP16 vision encoder + INT4 language decoder ≈ 1.5 GB
      dtype: {
        embed_tokens: 'fp16',
        embed_images: 'fp16',
        // LFM2.5-VL uses 'decoder' as the component key (not decoder_model_merged)
        decoder: 'q4',
      },
      progress_callback: (info: { status: string; progress?: number; file?: string }) => {
        if (info.status === 'progress' && info.progress != null) {
          self.postMessage({
            type: 'progress',
            stage: `Loading ${info.file ?? '…'}`,
            pct: info.progress / 100,
          })
        }
        if (info.status === 'ready') {
          self.postMessage({ type: 'progress', stage: 'Model ready', pct: 1 })
        }
      },
    }
    const call = pipeline as (task: string, model: string, opts: unknown) => Promise<AnyPipeline>
    pipelinePromise = call('image-text-to-text', 'LiquidAI/LFM2.5-VL-1.6B-ONNX', pipelineOpts)
  }
  return pipelinePromise
}

// ─── Message handler ─────────────────────────────────────────────────────────
self.addEventListener('message', async (evt: MessageEvent<{ type: string; id: string; imageDataUrl: string }>) => {
  const { type, id, imageDataUrl } = evt.data
  if (type !== 'infer') return

  try {
    const pipe = await getOrLoadPipeline()

    // Convert data URL → RawImage for Transformers.js
    const image = await RawImage.fromURL(imageDataUrl)

    // Run the model.  The pipeline returns an array of generation results.
    const outputs = (await pipe(image, {
      text: SPATIAL_DETECTION_PROMPT,
      max_new_tokens: 512,
      do_sample: false, // greedy — deterministic, faster
    })) as Array<{ generated_text: string }>

    const generatedText = outputs[0]?.generated_text ?? ''
    const detections: RawDetection[] = parseDetections(generatedText)

    self.postMessage({ type: 'result', id, detections })
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err) })
  }
})
