/**
 * Inference engine — runs LFM2.5-VL-1.6B-ONNX locally.
 *
 * Supports two modes:
 * 1. "ollama" (default) — POSTs to local Ollama API (Metal/AMD accelerated, zero local deps)
 * 2. "onnx"             — runs via onnxruntime-node (loaded dynamically to avoid load errors)
 */
import { SPATIAL_DETECTION_PROMPT, parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'

// Re-export shared types
export type { RawDetection }

// Dynamic import placeholders for ONNX mode
let ort: any = null
let JimpClass: any = null

const MODEL_DIR = new URL(
  Deno.env.get('MODEL_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/onnx/',
  import.meta.url,
).pathname
const TOKENIZER_DIR = new URL(
  Deno.env.get('TOKENIZER_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/',
  import.meta.url,
).pathname

const MAX_NEW_TOKENS = 256
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

export class InferenceEngine {
  readonly modelId: string
  private mode: 'ollama' | 'onnx'
  
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
    this.mode = Deno.env.get('INFERENCE_MODE') === 'onnx' ? 'onnx' : 'ollama'
    this.ollamaUrl = Deno.env.get('OLLAMA_HOST') ?? 'http://localhost:11434'
    this.ollamaModel = Deno.env.get('OLLAMA_MODEL') ?? 'moondream:latest'
    this.modelId = this.mode === 'onnx' ? 'LiquidAI/LFM2.5-VL-1.6B-ONNX' : `Ollama/${this.ollamaModel}`
  }

  async load(): Promise<void> {
    if (this.mode === 'ollama') {
      console.log(`[engine] Initializing Ollama engine (model: "${this.ollamaModel}" at ${this.ollamaUrl})…`)
      try {
        const res = await fetch(`${this.ollamaUrl}/api/tags`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { models: Array<{ name: string }> }
        
        // Find if requested model is in active list
        const requestedBase = this.ollamaModel.split(':')[0]
        const hasModel = data.models.some(m => m.name === this.ollamaModel || m.name.startsWith(requestedBase + ':'))
        
        if (!hasModel) {
          // Fallback check to any pulled vision models
          const visionModels = ['moondream:latest', 'llava:7b', 'qwen3-vl:4b', 'qwen3.5:4b', 'qwen3.5:2b']
          let foundFallback = false
          for (const fallback of visionModels) {
            if (data.models.some(m => m.name === fallback || m.name.startsWith(fallback + ':'))) {
              console.warn(`[engine] Model "${this.ollamaModel}" not found in Ollama. Falling back to available model "${fallback}"`)
              this.ollamaModel = fallback
              foundFallback = true
              break
            }
          }
          if (!foundFallback && data.models.length > 0) {
            console.warn(`[engine] Model "${this.ollamaModel}" not found. Trying first available model: "${data.models[0].name}"`)
            this.ollamaModel = data.models[0].name
          }
        }
        console.log(`[engine] Ollama connected. Target model: ${this.ollamaModel}`)
      } catch (err) {
        console.error(`[engine] Failed to connect to Ollama:`, err.message)
        throw new Error(`Ollama is unreachable. Ensure Ollama is running at ${this.ollamaUrl}.`)
      }
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
    if (this.mode === 'ollama') {
      return this._inferOllama(imageBytes)
    }
    
    // ONNX serialisation queue
    const result = this._onnxQueue.then(() => this._inferOnnx(imageBytes))
    this._onnxQueue = result.catch(() => {})
    return result
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
      }
    }

    console.log(`[engine] Running Ollama inference (${this.ollamaModel})…`)
    const start = Date.now()
    const res = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

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
