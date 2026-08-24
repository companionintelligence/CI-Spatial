/**
 * Inference engine — runs LFM2.5-VL-1.6B-ONNX locally.
 *
 * Supports three modes (INFERENCE_MODE env):
 * 1. "ollama" (default) — POSTs to local Ollama API (Metal/AMD accelerated, zero local deps)
 * 2. "onnx"             — runs via onnxruntime-node (loaded dynamically to avoid load errors)
 * 3. "mock"             — deterministic colour-blob detector for tests/CI; recognises the
 *                         shared CV palette colours (test-data/cv images, xr8-mock feed)
 */
import { fromFileUrl } from '@std/path'
import { SPATIAL_DETECTION_PROMPT, parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'
import { classifyPixel, paletteColorNameFor } from './src/shared/cv-palette.ts'
import { DEFAULT_MODEL_TAG } from './src/shared/model-catalog.ts'
import { normalizeOllamaHost } from './src/shared/ollama-host.ts'
import { resolveOllamaModel } from './src/shared/ollama-model.ts'

// Re-export shared types
export type { RawDetection }

// Dynamic import placeholders for ONNX mode
let ort: any = null
let JimpClass: any = null

// fromFileUrl, not `.pathname`: the latter yields "/C:/…" on Windows, which
// onnxruntime/Jimp then fail to open.
const MODEL_DIR = fromFileUrl(new URL(
  Deno.env.get('MODEL_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/onnx/',
  import.meta.url,
))
const TOKENIZER_DIR = fromFileUrl(new URL(
  Deno.env.get('TOKENIZER_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/',
  import.meta.url,
))

const MAX_NEW_TOKENS = 256

// Ollama otherwise uses the model's full context window (262144 for qwen3-vl:4b),
// which reserves ~44 GB of KV cache, overflows a 24 GB GPU and forces a 50/50
// CPU split — 100+ s per capture instead of ~20 s. Captures reach us downscaled
// to a 1280 px long edge (~1.2k vision tokens), so this is ample headroom.
const DEFAULT_NUM_CTX = 8192
// Upper bound, because the low end was never the danger: this constant exists
// to stop a 262144-token window reserving ~44 GB of KV cache, and 262144 is the
// most natural wrong value to supply — it is what `ollama show` prints.
const MAX_NUM_CTX = 131072
const OLLAMA_NUM_CTX = (() => {
  const raw = Deno.env.get('OLLAMA_NUM_CTX')
  if (raw == null || raw.trim() === '') return DEFAULT_NUM_CTX
  const n = Number(raw)
  // Number('') is 0 and Number('abc') is NaN; JSON.stringify turns NaN into
  // null, so an unvalidated value reaches Ollama as num_ctx: null or 0.
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`[engine] Ignoring invalid OLLAMA_NUM_CTX "${raw}" — using ${DEFAULT_NUM_CTX}`)
    return DEFAULT_NUM_CTX
  }
  if (n > MAX_NUM_CTX) {
    console.warn(
      `[engine] OLLAMA_NUM_CTX ${n} exceeds the ${MAX_NUM_CTX} cap — clamping. ` +
        'A window this large reserves tens of GB of KV cache and spills onto CPU.',
    )
    return MAX_NUM_CTX
  }
  return n
})()

const NUM_THREADS = (() => { try { return Math.max(1, navigator?.hardwareConcurrency ?? 4) } catch { return 4 } })()

// ─── ONNX prompt token IDs ───────────────────────────────────────────────────
const IMAGE_TOKEN_ID = 396
const IMAGE_START_ID = 498
const IMAGE_END_ID = 499
const EOS_ID = 7
const NUM_IMAGE_TOKENS = 256
const HIDDEN = 2048
const VOCAB_SIZE = 65536

const PREFIX_IDS = [1, 6, 6423, 708, IMAGE_START_ID]
const SUFFIX_IDS = [
  IMAGE_END_ID,
  4083, 938, 768, 15252, 2932, 29432, 523, 8700, 53111, 1033, 4646, 810, 6620, 916, 16811, 30915,
  768, 26444, 6947, 523, 3253, 1312, 3304, 523, 33609, 1334, 568, 38685, 3283, 6881, 997, 44528,
  1878, 997, 3119, 1974, 6881, 1607, 597, 526, 18447, 526, 20689, 527, 18447, 527, 5086, 997,
  14268, 3030, 6881, 730, 525, 523, 9763, 521, 997, 19522, 6881, 997, 6501, 771, 35098, 12377,
  521, 10800, 511, 602, 2848, 15090, 794, 5428, 4396, 938, 730, 525, 1408, 526, 4381, 2851, 811,
  4646, 15586, 523, 6659, 1973, 8427, 2932, 1010, 1011, 2130, 523, 51935, 730, 898, 7007, 523,
  7, 708, 6, 64015, 708,
]
const PROMPT_LEN = PREFIX_IDS.length + NUM_IMAGE_TOKENS + SUFFIX_IDS.length

const CONV_LAYER_INDICES = [0, 1, 3, 4, 6, 7, 9, 11, 13, 15]
const ATTN_LAYER_INDICES = [2, 5, 8, 10, 12, 14]

// Helper to safely convert array buffer to base64 in Deno without stack overflows
function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Short natural-language description for one mock detection.
 *
 * The real engines fill `description` with a human phrase under 7 words
 * (prompt.ts SPATIAL_DETECTION_PROMPT — e.g. "small fern, white pot"), and the
 * UI renders that string verbatim into the Latest-scan readout (src/main.ts
 * ~1060) and the review panel (src/ui/panel.ts:314). The mock used to emit
 * `mock colour-blob detection (N samples)` there, so any screenshot of the mock
 * stage — including the product-video captures — showed engine debug output
 * where the product shows a description.
 *
 * Everything in the phrase is measured, not invented: `colorName` is the palette
 * entry the blob's pixels actually matched, and the size and position words come
 * from the blob's own bbox. Deterministic for a given bbox, which the committed
 * captures rely on.
 */
/**
 * Confidence for one mock blob: how solidly it fills its own bounding box.
 *
 * `count` sampled grid cells matched the palette colour; the box spans
 * `(maxX-minX+1) x (maxY-minY+1)` cells. The ratio is mapped into 0.61–0.96 —
 * a colour-blob detector has no business claiming better than that, and a
 * floor keeps a ragged silhouette from reading as a failed detection when it
 * is in fact the object. Rounded to two places so the UI's `Math.round(c*100)`
 * is stable.
 */
export function blobConfidence(
  count: number,
  minX: number, minY: number, maxX: number, maxY: number,
): number {
  const cells = (maxX - minX + 1) * (maxY - minY + 1)
  const fill = cells > 0 ? Math.min(1, count / cells) : 0
  return Math.round((0.61 + 0.35 * fill) * 100) / 100
}

export function describeMockBlob(
  label: string,
  bbox: [number, number, number, number],
): string {
  const [x0, y0, x1, y1] = bbox
  // Thresholds are fractions of frame AREA, calibrated against furniture seen
  // across a room: a sofa filling a quarter of the width and a sixth of the
  // height is ~4%, a side table ~1.5%, a pot plant well under 1%.
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const size = area >= 0.03 ? 'large' : area >= 0.012 ? 'mid-sized' : 'small'

  const centreX = (x0 + x1) / 2
  const place = centreX < 0.34 ? 'left of frame' : centreX > 0.66 ? 'right of frame' : 'centre of frame'

  const colour = paletteColorNameFor(label)
  // "large orange sofa, left of frame" — 6 words, inside the 7-word contract.
  return colour ? `${size} ${colour} ${label}, ${place}` : `${size} ${label}, ${place}`
}

export class InferenceEngine {
  /**
   * Which model is actually in use, for /health and logs.
   *
   * A getter, not a constructor-assigned field: in ollama mode init() may
   * substitute a different tag when the requested one is not pulled, and a
   * field captured before init() would leave /health naming a model nothing
   * is running. Reporting the requested name as though it were the live one
   * is the same defect the presence check above had.
   */
  get modelId(): string {
    return this._mode === 'onnx'
      ? 'LiquidAI/LFM2.5-VL-1.6B-ONNX'
      : this._mode === 'mock'
      ? 'mock/color-blob-v1'
      : `Ollama/${this.ollamaModel}`
  }
  private _mode: 'ollama' | 'onnx' | 'mock'
  private _lastInferMs: number | null = null
  private _lastInferAt: number | null = null

  // Ollama configuration
  private ollamaUrl: string
  private ollamaModel: string

  // ONNX sessions
  private embedTokensSession: any = null
  private embedImagesSession: any = null
  private decoderSession: any = null
  private idToVocabStr: Map<number, string> = new Map()
  private _onnxQueue: Promise<unknown> = Promise.resolve()

  constructor() {
    const requested = Deno.env.get('INFERENCE_MODE')
    this._mode = requested === 'onnx' ? 'onnx' : requested === 'mock' ? 'mock' : 'ollama'
    this.ollamaUrl = normalizeOllamaHost(Deno.env.get('OLLAMA_HOST'))
    this.ollamaModel = Deno.env.get('OLLAMA_MODEL') ?? DEFAULT_MODEL_TAG
  }

  /** Resolved inference mode (INFERENCE_MODE env). */
  get mode(): 'ollama' | 'onnx' | 'mock' {
    return this._mode
  }

  /** Wall time of the most recent successful infer() in ms, or null. */
  get lastInferMs(): number | null {
    return this._lastInferMs
  }

  /** Epoch ms timestamp of the most recent successful infer(), or null. */
  get lastInferAt(): number | null {
    return this._lastInferAt
  }

  async load(): Promise<void> {
    if (this._mode === 'mock') {
      const jimpMod = await import('jimp')
      JimpClass = jimpMod.Jimp
      console.log('[engine] Mock colour-blob engine ready (INFERENCE_MODE=mock)')
      return
    }

    if (this._mode === 'ollama') {
      console.log(`[engine] Initializing Ollama engine (model: "${this.ollamaModel}" at ${this.ollamaUrl})…`)
      // Only the reachability check belongs in this try. Anything thrown here
      // is reported as "Ollama is unreachable", so a model-selection failure
      // inside it would be misattributed to the network — the same defect this
      // pass fixed in the AR start handler.
      let installed: string[]
      try {
        const res = await fetch(`${this.ollamaUrl}/api/tags`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { models: Array<{ name: string }> }
        installed = data.models.map(m => m.name)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[engine] Failed to connect to Ollama:`, message)
        throw new Error(`Ollama is unreachable. Ensure Ollama is running at ${this.ollamaUrl}.`)
      }

      // Which model will actually run? resolveOllamaModel() is a pure function
      // in src/shared/ollama-model.ts so this decision is covered by
      // ollama_model.test.ts — the loose base-name check it replaced was a
      // one-line predicate no test could reach, and it made /health report
      // ready for a model that 404'd on every capture.
      const choice = resolveOllamaModel(this.ollamaModel, installed)
      if (!choice) {
        // Reachable but empty is a real, distinct state, and naming the pull
        // command is the whole of the fix.
        throw new Error(`Ollama is running but has no models pulled. Run: ollama pull ${this.ollamaModel}`)
      }
      if (choice.reason !== 'exact') {
        console.warn(
          `[engine] Model "${this.ollamaModel}" is not pulled. Using "${choice.model}" instead ` +
          `(${choice.reason}) — run \`ollama pull ${this.ollamaModel}\` to use the requested one.`,
        )
      }
      this.ollamaModel = choice.model
      console.log(`[engine] Ollama connected. Target model: ${this.ollamaModel}`)
      return
    }

    // ONNX mode
    console.log(`[engine] Loading local ONNX model sessions (${NUM_THREADS} threads)…`)
    
    // Dynamic imports
    ort = await import('onnxruntime-node')
    const jimpMod = await import('jimp')
    JimpClass = jimpMod.Jimp

    const opts: any = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: NUM_THREADS,
      interOpNumThreads: Math.max(1, Math.floor(NUM_THREADS / 2)),
      executionMode: 'parallel',
      logSeverityLevel: 3,
    }

    const [et, ei, dec] = await Promise.all([
      ort.InferenceSession.create(`${MODEL_DIR}embed_tokens_fp16.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_DIR}embed_images_fp16.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_DIR}decoder_q4.onnx`, opts),
    ])
    this.embedTokensSession = et
    this.embedImagesSession = ei
    this.decoderSession = dec

    const tokJson = JSON.parse(await Deno.readTextFile(`${TOKENIZER_DIR}tokenizer.json`)) as {
      model: { vocab: Record<string, number> }
      added_tokens: Array<{ id: number; content: string }>
    }
    for (const [str, id] of Object.entries(tokJson.model.vocab)) {
      this.idToVocabStr.set(id, str)
    }
    for (const { id, content } of tokJson.added_tokens) {
      this.idToVocabStr.set(id, content)
    }

    console.log('[engine] Local ONNX sessions loaded successfully')
  }

  async infer(imageBytes: Uint8Array): Promise<RawDetection[]> {
    const started = Date.now()
    const detections = await this._inferDispatch(imageBytes)
    this._lastInferMs = Date.now() - started
    this._lastInferAt = Date.now()
    return detections
  }

  private _inferDispatch(imageBytes: Uint8Array): Promise<RawDetection[]> {
    if (this._mode === 'mock') {
      return this._inferMock(imageBytes)
    }
    if (this._mode === 'ollama') {
      return this._inferOllama(imageBytes)
    }

    // ONNX serialisation queue
    const result = this._onnxQueue.then(() => this._inferOnnx(imageBytes))
    this._onnxQueue = result.catch(() => {})
    return result
  }

  /**
   * Mock engine: detects solid CV-palette colour blobs via grid sampling +
   * union-find connected components.  Deterministic and model-free, so the
   * full capture → infer → resolve pipeline is testable in CI.  Pairs with
   * scripts/generate-cv-images.mjs and the xr8-mock camera feed.
   */
  private async _inferMock(imageBytes: Uint8Array): Promise<RawDetection[]> {
    // Jimp dispatches on input type — a raw Uint8Array is treated as a URL
    const { Buffer } = await import('node:buffer')
    const image = await JimpClass.read(Buffer.from(imageBytes))
    const { width, height, data } = image.bitmap as { width: number; height: number; data: Uint8Array }

    const step = Math.max(2, Math.floor(Math.min(width, height) / 160))
    const cols = Math.floor(width / step)
    const rows = Math.floor(height / step)

    // Classify a sampled grid against the palette
    const labels = new Array<string | null>(cols * rows).fill(null)
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const i = ((gy * step) * width + gx * step) * 4
        labels[gy * cols + gx] = classifyPixel(data[i], data[i + 1], data[i + 2])
      }
    }

    // Union-find over the 4-neighbourhood of same-label cells
    const parent = new Int32Array(cols * rows).fill(-1)
    const find = (a: number): number => {
      let r = a
      while (parent[r] !== r) r = parent[r]
      while (parent[a] !== r) { const next = parent[a]; parent[a] = r; a = next }
      return r
    }
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const idx = gy * cols + gx
        if (!labels[idx]) continue
        if (parent[idx] === -1) parent[idx] = idx
        if (gx > 0 && labels[idx - 1] === labels[idx]) {
          const a = find(idx), b = find(idx - 1)
          if (a !== b) parent[a] = b
        }
        if (gy > 0 && labels[idx - cols] === labels[idx]) {
          const a = find(idx), b = find(idx - cols)
          if (a !== b) parent[a] = b
        }
      }
    }

    // Cluster bounds → detections
    interface MockBlob { label: string; minX: number; minY: number; maxX: number; maxY: number; count: number }
    const blobs = new Map<number, MockBlob>()
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const idx = gy * cols + gx
        const label = labels[idx]
        if (!label) continue
        const r = find(idx)
        let blob = blobs.get(r)
        if (!blob) {
          blob = { label, minX: gx, minY: gy, maxX: gx, maxY: gy, count: 0 }
          blobs.set(r, blob)
        }
        blob.count++
        if (gx < blob.minX) blob.minX = gx
        if (gx > blob.maxX) blob.maxX = gx
        if (gy < blob.minY) blob.minY = gy
        if (gy > blob.maxY) blob.maxY = gy
      }
    }

    const minSamples = 20
    const detections: RawDetection[] = []
    for (const blob of blobs.values()) {
      if (blob.count < minSamples) continue
      const bbox: [number, number, number, number] = [
        (blob.minX * step) / width,
        (blob.minY * step) / height,
        ((blob.maxX + 1) * step) / width,
        ((blob.maxY + 1) * step) / height,
      ]
      detections.push({
        label: blob.label,
        // A measurement, not a constant. Every mock detection used to report
        // exactly 0.95, so the review panel showed "sofa 95% / tv 95% / table
        // 95%" — three identical numbers, which is the tell that a confidence
        // column is decorative. Fill ratio is the honest signal this detector
        // has: how solidly the blob's own bounding box is filled by cells that
        // matched its palette colour. A clean rectangular object approaches 1;
        // an L-shaped or partly-occluded one falls away. Deterministic for a
        // given frame, which the committed captures rely on.
        confidence: blobConfidence(blob.count, blob.minX, blob.minY, blob.maxX, blob.maxY),
        // A description, not a sample count — see describeMockBlob. The blob's
        // sample count stays available on the console line below for debugging.
        description: describeMockBlob(blob.label, bbox),
        bbox,
      })
    }
    detections.sort((a, b) =>
      (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]))
    console.log(
      `[engine] mock detections: ${
        detections.map(d => d.label).join(', ') || '(none)'
      }${blobs.size ? ` (blob samples: ${[...blobs.values()].filter(b => b.count >= minSamples).map(b => `${b.label}=${b.count}`).join(' ')})` : ''}`,
    )
    return detections
  }

  private async _inferOllama(imageBytes: Uint8Array): Promise<RawDetection[]> {
    const base64Image = arrayBufferToBase64(imageBytes)

    const payload = {
      model: this.ollamaModel,
      prompt: SPATIAL_DETECTION_PROMPT,
      images: [base64Image],
      stream: false,
      options: {
        temperature: 0.1,
        num_ctx: OLLAMA_NUM_CTX,
      }
    }

    console.log(`[engine] Running Ollama inference (${this.ollamaModel})…`)
    const start = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(55_000),
      })
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Ollama inference timed out after 55s (model: ${this.ollamaModel})`)
      }
      throw err
    }

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as { response: string }
    const elapsed = ((Date.now() - start) / 1000).toFixed(2)
    console.log(`[engine] Ollama inference finished in ${elapsed}s`)
    console.log(`[engine] Model output:`, data.response)

    return parseDetections(data.response)
  }

  private async _inferOnnx(imageBytes: Uint8Array): Promise<RawDetection[]> {
    if (!this.embedTokensSession || !this.embedImagesSession || !this.decoderSession) {
      throw new Error('Engine not loaded — call load() first')
    }

    const [imgResult, prefixOut, suffixOut] = await Promise.all([
      patchifyImage(imageBytes).then(({ pixelValues, pixelAttentionMask, spatialShapes }) =>
        this.embedImagesSession!.run({ pixel_values: pixelValues, pixel_attention_mask: pixelAttentionMask, spatial_shapes: spatialShapes })
      ),
      this.embedTokensSession!.run({ input_ids: bigintTokenIds(PREFIX_IDS) }),
      this.embedTokensSession!.run({ input_ids: bigintTokenIds(SUFFIX_IDS) }),
    ])
    const imageFeatures = imgResult['image_features']   // [256, 2048]
    const prefixEmbeds  = prefixOut['inputs_embeds']    // [1, 5, 2048]
    const suffixEmbeds  = suffixOut['inputs_embeds']    // [1, 103, 2048]

    const combinedData = new Float32Array(PROMPT_LEN * HIDDEN)
    combinedData.set(prefixEmbeds.data as Float32Array, 0)
    combinedData.set(imageFeatures.data as Float32Array, PREFIX_IDS.length * HIDDEN)
    combinedData.set(suffixEmbeds.data as Float32Array, (PREFIX_IDS.length + NUM_IMAGE_TOKENS) * HIDDEN)
    const inputsEmbeds = new ort.Tensor('float32', combinedData, [1, PROMPT_LEN, HIDDEN])

    let pastConv: Record<string, any> = {}
    for (const i of CONV_LAYER_INDICES) {
      pastConv[`past_conv.${i}`] = new ort.Tensor('float32', new Float32Array(1 * 2048 * 3), [1, 2048, 3])
    }
    let pastKV: Record<string, any> = {}
    for (const i of ATTN_LAYER_INDICES) {
      pastKV[`past_key_values.${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
      pastKV[`past_key_values.${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
    }

    const prefillMask = new ort.Tensor('int64', new BigInt64Array(PROMPT_LEN).fill(1n), [1, PROMPT_LEN])
    const prefillOut = await this.decoderSession!.run({
      inputs_embeds: inputsEmbeds,
      attention_mask: prefillMask,
      ...pastConv,
      ...pastKV,
    })

    const prefillLogitsData = prefillOut['logits'].data as Float32Array
    const firstToken = argmax(prefillLogitsData.subarray(prefillLogitsData.length - VOCAB_SIZE))

    for (const i of CONV_LAYER_INDICES) pastConv[`past_conv.${i}`] = prefillOut[`present_conv.${i}`]
    for (const i of ATTN_LAYER_INDICES) {
      pastKV[`past_key_values.${i}.key`] = prefillOut[`present.${i}.key`]
      pastKV[`past_key_values.${i}.value`] = prefillOut[`present.${i}.value`]
    }

    const generatedIds: number[] = [firstToken]
    let totalSeqLen = PROMPT_LEN + 1

    for (let step = 0; step < MAX_NEW_TOKENS - 1; step++) {
      const lastId = generatedIds[generatedIds.length - 1]
      if (lastId === EOS_ID) break

      const tokenInput = new ort.Tensor('int64', BigInt64Array.from([BigInt(lastId)]), [1, 1])
      const tokenEmbeds = ((await this.embedTokensSession!.run({ input_ids: tokenInput }))['inputs_embeds'])

      const attnMask = new ort.Tensor('int64', new BigInt64Array(totalSeqLen).fill(1n), [1, totalSeqLen])
      const decOut = await this.decoderSession!.run({
        inputs_embeds: tokenEmbeds,
        attention_mask: attnMask,
        ...pastConv,
        ...pastKV,
      })

      for (const i of CONV_LAYER_INDICES) pastConv[`past_conv.${i}`] = decOut[`present_conv.${i}`]
      for (const i of ATTN_LAYER_INDICES) {
        pastKV[`past_key_values.${i}.key`] = decOut[`present.${i}.key`]
        pastKV[`past_key_values.${i}.value`] = decOut[`present.${i}.value`]
      }

      const nextId = argmax((decOut['logits'].data as Float32Array).subarray(0, VOCAB_SIZE))
      generatedIds.push(nextId)
      totalSeqLen++
    }

    const generatedText = this.decodeIds(generatedIds)
    console.log('[engine] Generated:', generatedText.slice(0, 200))
    return parseDetections(generatedText)
  }

  private decodeIds(ids: number[]): string {
    const parts: string[] = []
    for (const id of ids) {
      if (id === EOS_ID) break
      const tokStr = this.idToVocabStr.get(id)
      if (!tokStr) continue
      if ((tokStr.startsWith('<|') && tokStr.endsWith('|>')) || (tokStr.startsWith('<') && tokStr.endsWith('>'))) continue
      parts.push(decodeTokenString(tokStr))
    }
    return parts.join('')
  }
}

// ─── GPT2 Byte Decode Table Helpers ──────────────────────────────────────────
function buildByteDecodeTable(): Map<string, number> {
  const table = new Map<string, number>()
  const normal: number[] = []
  for (let b = 0x21; b <= 0x7e; b++) normal.push(b)
  for (let b = 0xa1; b <= 0xac; b++) normal.push(b)
  for (let b = 0xae; b <= 0xff; b++) normal.push(b)
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!normal.includes(b)) {
      table.set(String.fromCodePoint(256 + n), b)
      n++
    } else {
      table.set(String.fromCodePoint(b), b)
    }
  }
  return table
}

const BYTE_DECODE = buildByteDecodeTable()

function decodeTokenString(tok: string): string {
  const bytes: number[] = []
  for (const ch of tok) {
    const b = BYTE_DECODE.get(ch)
    if (b !== undefined) bytes.push(b)
    else bytes.push(...new TextEncoder().encode(ch))
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
}

// ─── ONNX Image patchification ───────────────────────────────────────────────
async function patchifyImage(imageBytes: Uint8Array): Promise<{
  pixelValues: any
  pixelAttentionMask: any
  spatialShapes: any
}> {
  const SIZE = 512
  const PATCH = 16
  const NP = SIZE / PATCH
  const NUM_PATCHES = NP * NP

  const image = await JimpClass.fromBuffer(imageBytes.buffer as ArrayBuffer)
  image.resize({ w: SIZE, h: SIZE })
  const rgba = new Uint8Array(image.bitmap.data.buffer)

  const pixelData = new Float32Array(NUM_PATCHES * PATCH * PATCH * 3)

  for (let pk = 0; pk < NP; pk++) {
    for (let pl = 0; pl < NP; pl++) {
      const patchBase = (pk * NP + pl) * PATCH * PATCH * 3
      for (let pr = 0; pr < PATCH; pr++) {
        for (let pc = 0; pc < PATCH; pc++) {
          const imgRgbaIdx = ((pk * PATCH + pr) * SIZE + (pl * PATCH + pc)) * 4
          const patchPixelBase = patchBase + (pr * PATCH + pc) * 3
          pixelData[patchPixelBase]     = rgba[imgRgbaIdx]     / 127.5 - 1.0
          pixelData[patchPixelBase + 1] = rgba[imgRgbaIdx + 1] / 127.5 - 1.0
          pixelData[patchPixelBase + 2] = rgba[imgRgbaIdx + 2] / 127.5 - 1.0
        }
      }
    }
  }

  return {
    pixelValues: new ort.Tensor('float32', pixelData, [1, NUM_PATCHES, PATCH * PATCH * 3]),
    pixelAttentionMask: new ort.Tensor('int64', new BigInt64Array(NUM_PATCHES).fill(1n), [1, NUM_PATCHES]),
    spatialShapes: new ort.Tensor('int64', BigInt64Array.from([BigInt(NP), BigInt(NP)]), [1, 2]),
  }
}

function bigintTokenIds(ids: number[]): any {
  return new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
}

function argmax(arr: Float32Array): number {
  let best = 0
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i
  }
  return best
}
