/**
 * Inference engine — runs LFM2.5-VL-1.6B-ONNX via onnxruntime-node.
 *
 * Model files must be present at:
 *   server/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/
 *     onnx/embed_tokens_fp16.onnx     (fp16, + .onnx_data shard)
 *     onnx/embed_images_fp16.onnx     (+ .onnx_data shard)
 *     onnx/decoder_q4.onnx            (+ .onnx_data shard)
 *
 * Download from: https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-ONNX
 *
 * The same JSON shape is returned as the WebGPU worker so both paths
 * are interchangeable from the client's perspective.
 */
import * as ort from 'onnxruntime-node'
import { Jimp } from 'jimp'
import { parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'

// Re-export shared types used by main.ts
export type { RawDetection }

const MODEL_DIR = new URL(
  Deno.env.get('MODEL_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/onnx/',
  import.meta.url,
).pathname
const TOKENIZER_DIR = new URL(
  Deno.env.get('TOKENIZER_DIR') ?? './public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/',
  import.meta.url,
).pathname

// Max new tokens to generate. Each object ~100 chars ≈ 80 tokens; 8 objects ≈ 640 tokens.
const MAX_NEW_TOKENS = 1024

// ─── Prompt token IDs (pre-computed offline for the fixed detection prompt) ───
// Full prompt: <bos><im_start>user\n<image_start><image×256><image_end>{PROMPT}<im_end>\n<im_start>assistant\n
//   PREFIX_IDS: [1, 6, 6423, 708, 498]  — BOS, im_start, "user", "\n", image_start
//   IMAGE token id 396 repeated 256 times (replaced by embed_images output)
//   SUFFIX_IDS: [499, ...prompt tokens..., 7, 708, 6, 64015, 708]  — image_end, prompt body, im_end, \n, im_start, "assistant", \n
// Image token layout: single 512×512 → 1 tile, (512/16/2)² = 256 tokens
const IMAGE_TOKEN_ID = 396
const IMAGE_START_ID = 498
const IMAGE_END_ID = 499
const EOS_ID = 7          // <|im_end|>
const NUM_IMAGE_TOKENS = 256
const HIDDEN = 2048
const VOCAB_SIZE = 65536

// Pre-tokenized prefix (BOS → im_start → "user" → "\n" → image_start)
const PREFIX_IDS = [1, 6, 6423, 708, IMAGE_START_ID]
// Pre-tokenized suffix (image_end → prompt body → im_end → "\n" → im_start → "assistant" → "\n")
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
const PROMPT_LEN = PREFIX_IDS.length + NUM_IMAGE_TOKENS + SUFFIX_IDS.length // 364

// Decoder layer indices for KV cache and Mamba conv states
const CONV_LAYER_INDICES = [0, 1, 3, 4, 6, 7, 9, 11, 13, 15]
const ATTN_LAYER_INDICES = [2, 5, 8, 10, 12, 14]

// ─── GPT2 byte-level decode helpers ──────────────────────────────────────────

function buildByteDecodeTable(): Map<string, number> {
  // Map unicode char used in GPT2 vocab strings back to their original byte values
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

export class InferenceEngine {
  readonly modelId = 'LiquidAI/LFM2.5-VL-1.6B-ONNX'

  private embedTokensSession: ort.InferenceSession | null = null
  private embedImagesSession: ort.InferenceSession | null = null
  private decoderSession: ort.InferenceSession | null = null
  private idToVocabStr: Map<number, string> = new Map()

  async load(): Promise<void> {
    console.log('[engine] Loading model sessions…')
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    }

    const [et, ei, dec] = await Promise.all([
      ort.InferenceSession.create(`${MODEL_DIR}embed_tokens_fp16.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_DIR}embed_images_fp16.onnx`, opts),
      ort.InferenceSession.create(`${MODEL_DIR}decoder_q4.onnx`, opts),
    ])
    this.embedTokensSession = et
    this.embedImagesSession = ei
    this.decoderSession = dec

    // Build reverse vocab for decoding generated token IDs
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

    console.log('[engine] Model ready')
  }

  async infer(imageBytes: Uint8Array): Promise<RawDetection[]> {
    if (!this.embedTokensSession || !this.embedImagesSession || !this.decoderSession) {
      throw new Error('Engine not loaded — call load() first')
    }

    // ── 1. Patchify image → embed_images inputs ──────────────────────────────
    const { pixelValues, pixelAttentionMask, spatialShapes } = await patchifyImage(imageBytes)

    const imgOut = await this.embedImagesSession.run({
      pixel_values: pixelValues,
      pixel_attention_mask: pixelAttentionMask,
      spatial_shapes: spatialShapes,
    })
    // image_features: [256, 2048] — no batch dimension
    const imageFeatures = imgOut['image_features'] as ort.Tensor

    // ── 2. Embed prompt prefix and suffix tokens ───────────────────────────────
    const prefixTensor = bigintTokenIds(PREFIX_IDS)
    const suffixTensor = bigintTokenIds(SUFFIX_IDS)

    const [prefixOut, suffixOut] = await Promise.all([
      this.embedTokensSession.run({ input_ids: prefixTensor }),
      this.embedTokensSession.run({ input_ids: suffixTensor }),
    ])
    const prefixEmbeds = prefixOut['inputs_embeds'] as ort.Tensor  // [1, 5, 2048]
    const suffixEmbeds = suffixOut['inputs_embeds'] as ort.Tensor  // [1, 103, 2048]

    // ── 3. Splice image features into the embedding sequence ──────────────────
    // Final layout: [prefix(5), image_features(256), suffix(103)] → [1, 364, 2048]
    const combinedData = new Float32Array(PROMPT_LEN * HIDDEN)
    combinedData.set(prefixEmbeds.data as Float32Array, 0)
    combinedData.set(imageFeatures.data as Float32Array, PREFIX_IDS.length * HIDDEN)
    combinedData.set(suffixEmbeds.data as Float32Array, (PREFIX_IDS.length + NUM_IMAGE_TOKENS) * HIDDEN)
    const inputsEmbeds = new ort.Tensor('float32', combinedData, [1, PROMPT_LEN, HIDDEN])

    // ── 4. Initialize Mamba conv states (zeros) and KV cache (empty) ──────────
    let pastConv: Record<string, ort.Tensor> = {}
    for (const i of CONV_LAYER_INDICES) {
      pastConv[`past_conv.${i}`] = new ort.Tensor('float32', new Float32Array(1 * 2048 * 3), [1, 2048, 3])
    }
    let pastKV: Record<string, ort.Tensor> = {}
    for (const i of ATTN_LAYER_INDICES) {
      pastKV[`past_key_values.${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
      pastKV[`past_key_values.${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
    }

    // ── 5. Prefill: process all prompt tokens at once ─────────────────────────
    console.log('[engine] Prefill…')
    const prefillMask = new ort.Tensor('int64', new BigInt64Array(PROMPT_LEN).fill(1n), [1, PROMPT_LEN])
    const prefillOut = await this.decoderSession.run({
      inputs_embeds: inputsEmbeds,
      attention_mask: prefillMask,
      ...pastConv,
      ...pastKV,
    })

    // Extract first generated token from prefill logits [1, 364, 65536]
    const prefillLogitsData = prefillOut['logits'].data as Float32Array
    const firstToken = argmax(prefillLogitsData.subarray(prefillLogitsData.length - VOCAB_SIZE))

    // Update KV cache from prefill outputs
    for (const i of CONV_LAYER_INDICES) pastConv[`past_conv.${i}`] = prefillOut[`present_conv.${i}`] as ort.Tensor
    for (const i of ATTN_LAYER_INDICES) {
      pastKV[`past_key_values.${i}.key`] = prefillOut[`present.${i}.key`] as ort.Tensor
      pastKV[`past_key_values.${i}.value`] = prefillOut[`present.${i}.value`] as ort.Tensor
    }

    // ── 6. Autoregressive decode loop (one token at a time) ───────────────────
    console.log('[engine] Decoding…')
    const generatedIds: number[] = [firstToken]
    let totalSeqLen = PROMPT_LEN + 1

    for (let step = 0; step < MAX_NEW_TOKENS - 1; step++) {
      const lastId = generatedIds[generatedIds.length - 1]
      if (lastId === EOS_ID) break

      const tokenInput = new ort.Tensor('int64', BigInt64Array.from([BigInt(lastId)]), [1, 1])
      const tokenEmbeds = ((await this.embedTokensSession.run({ input_ids: tokenInput }))['inputs_embeds']) as ort.Tensor

      const attnMask = new ort.Tensor('int64', new BigInt64Array(totalSeqLen).fill(1n), [1, totalSeqLen])
      const decOut = await this.decoderSession.run({
        inputs_embeds: tokenEmbeds,
        attention_mask: attnMask,
        ...pastConv,
        ...pastKV,
      })

      for (const i of CONV_LAYER_INDICES) pastConv[`past_conv.${i}`] = decOut[`present_conv.${i}`] as ort.Tensor
      for (const i of ATTN_LAYER_INDICES) {
        pastKV[`past_key_values.${i}.key`] = decOut[`present.${i}.key`] as ort.Tensor
        pastKV[`past_key_values.${i}.value`] = decOut[`present.${i}.value`] as ort.Tensor
      }

      const nextId = argmax((decOut['logits'].data as Float32Array).subarray(0, VOCAB_SIZE))
      generatedIds.push(nextId)
      totalSeqLen++
    }

    // ── 7. Decode token IDs to text ──────────────────────────────────────────
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
      // Skip all special tokens wrapped in <| ... |> or < ... >
      if ((tokStr.startsWith('<|') && tokStr.endsWith('|>')) || (tokStr.startsWith('<') && tokStr.endsWith('>'))) continue
      parts.push(decodeTokenString(tokStr))
    }
    return parts.join('')
  }
}

// ─── Image patchification ────────────────────────────────────────────────────
//
// embed_images ONNX inputs:
//   pixel_values:       [1, 1024, 768]  float32  — (32×32 patches, 16×16×3 HWC per patch)
//   pixel_attention_mask: [1, 1024]     int64    — all ones for a real image (no padding)
//   spatial_shapes:     [1, 2]          int64    — [[32, 32]] (num_patches H, num_patches W)

async function patchifyImage(imageBytes: Uint8Array): Promise<{
  pixelValues: ort.Tensor
  pixelAttentionMask: ort.Tensor
  spatialShapes: ort.Tensor
}> {
  const SIZE = 512       // target image size in pixels
  const PATCH = 16       // patch size in pixels
  const NP = SIZE / PATCH // patches per side = 32
  const NUM_PATCHES = NP * NP // 1024

  const image = await Jimp.fromBuffer(imageBytes.buffer as ArrayBuffer)
  image.resize({ w: SIZE, h: SIZE })
  const rgba = new Uint8Array(image.bitmap.data.buffer)

  // Build pixel_values in patch-major, HWC-within-patch order.
  // This matches what Lfm2VlImageProcessorFast.convert_image_to_patches produces:
  //   reshape(C, nph, ph, npw, pw) → permute(0, nph, npw, ph, pw, C) → reshape(nph×npw, ph×pw×C)
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

// ─── Utilities ────────────────────────────────────────────────────────────────

function bigintTokenIds(ids: number[]): ort.Tensor {
  return new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
}

function argmax(arr: Float32Array | Float32Array): number {
  let best = 0
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i
  }
  return best
}
