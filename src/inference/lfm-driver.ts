/**
 * LFM2.5-VL-1.6B-ONNX inference driver — runtime-agnostic.
 *
 * This is the 3-stage (embed_tokens / embed_images / decoder) autoregressive
 * loop with its manually managed KV cache, plus the patchify maths that turns
 * a decoded image into the model's `pixel_values` input. It imports nothing
 * from `Deno`, `onnxruntime-node`, or Jimp — every runtime-specific operation
 * (session creation, tokenizer JSON load, image decode, tensor construction)
 * goes through the four-member `LfmPort` a caller supplies.
 *
 * Extracted from the Deno server's inference.ts (see
 * docs/factory/05-on-device-inference/0001-extract-lfm-driver-runtime-port.md)
 * so the loop is written once and shared by both the server
 * (server/lfm-driver-onnx.ts, onnxruntime-node) and, per ticket 0003, the
 * browser (onnxruntime-web). Per ADR 0001, this is the reuse the wave exists
 * for — reimplementing the loop for a second runtime is exactly the kind of
 * duplication that ADR forbids, and here it would show up as subtly wrong
 * detections rather than a type error.
 *
 * The loop itself, the KV-cache threading and the patchify maths are moved
 * verbatim from inference.ts — this file changes nothing about *how* the
 * model runs, only *where* the runtime-specific calls are made.
 */
import { parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'

// ─── The port: everything a runtime must supply ─────────────────────────────

/**
 * One loaded ONNX inference session. Both onnxruntime-node and
 * onnxruntime-web expose this same `run()` shape at the 1.21 major, which is
 * what lets a single port abstract over both — see ticket 0001's open
 * question on tensor/session compatibility.
 */
export interface LfmSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(feeds: Record<string, any>): Promise<Record<string, any>>
}

/**
 * The four runtime-specific operations the driver needs. Stateless functions
 * on a single object, not a class with implementations — decided 2026-08-18,
 * see ticket 0001's open questions: four members is too little to justify an
 * interface-plus-implementations ceremony.
 */
export interface LfmPort {
  /** Create (and fully load) an inference session for a model file, e.g. `'decoder_q4.onnx'`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSession(name: string, opts: any): Promise<LfmSession>
  /** Read and JSON-parse a file that lives alongside the model, e.g. `'tokenizer.json'`. */
  readJson(name: string): Promise<unknown>
  /** Decode image bytes into raw interleaved RGBA pixels, resized to `width`x`height`. */
  decodeImage(bytes: Uint8Array, width: number, height: number): Promise<{ data: Uint8Array; width: number; height: number }>
  /** The runtime's `ort.Tensor` constructor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => any
}

// ─── ONNX prompt token IDs ───────────────────────────────────────────────────
const IMAGE_TOKEN_ID = 396
const IMAGE_START_ID = 498
const IMAGE_END_ID = 499
const EOS_ID = 7
const NUM_IMAGE_TOKENS = 256
const HIDDEN = 2048
const VOCAB_SIZE = 65536
const MAX_NEW_TOKENS = 256

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

// ─── Driver handle: sessions + tokenizer, loaded once ───────────────────────

export interface LfmDriverHandle {
  embedTokensSession: LfmSession
  embedImagesSession: LfmSession
  decoderSession: LfmSession
  idToVocabStr: Map<number, string>
}

/**
 * Create the three ONNX sessions and load the tokenizer vocab. Call once at
 * startup; the returned handle is reused across every `runLfmDriver` call.
 *
 * `sessionOpts` is opaque to the driver — it is forwarded verbatim to
 * `port.createSession`, since session-tuning options (thread counts,
 * execution providers) are runtime-specific and the driver has no business
 * interpreting them.
 */
export async function loadLfmDriver(port: LfmPort, sessionOpts: unknown): Promise<LfmDriverHandle> {
  const [embedTokensSession, embedImagesSession, decoderSession] = await Promise.all([
    port.createSession('embed_tokens_fp16.onnx', sessionOpts),
    port.createSession('embed_images_fp16.onnx', sessionOpts),
    port.createSession('decoder_q4.onnx', sessionOpts),
  ])

  const tokJson = await port.readJson('tokenizer.json') as {
    model: { vocab: Record<string, number> }
    added_tokens: Array<{ id: number; content: string }>
  }
  const idToVocabStr = new Map<number, string>()
  for (const [str, id] of Object.entries(tokJson.model.vocab)) {
    idToVocabStr.set(id, str)
  }
  for (const { id, content } of tokJson.added_tokens) {
    idToVocabStr.set(id, content)
  }

  return { embedTokensSession, embedImagesSession, decoderSession, idToVocabStr }
}

/**
 * Run one detection pass: patchify the image, prefill the prompt + image
 * embeddings, then greedily decode until EOS or `MAX_NEW_TOKENS`, threading
 * the KV cache (`past_conv.N` / `past_key_values.N.key/value` in,
 * `present_conv.N` / `present.N.key/value` out) by hand at every step.
 *
 * Moved verbatim from inference.ts's `_inferOnnx` — this is the subtlest
 * code in the repo (see ticket 0001's Non-goals) and is not "improved" while
 * moving, only relocated behind the port.
 */
export async function runLfmDriver(
  port: LfmPort,
  handle: LfmDriverHandle,
  imageBytes: Uint8Array,
): Promise<RawDetection[]> {
  const { embedTokensSession, embedImagesSession, decoderSession, idToVocabStr } = handle

  const [imgResult, prefixOut, suffixOut] = await Promise.all([
    patchifyImage(port, imageBytes).then(({ pixelValues, pixelAttentionMask, spatialShapes }) =>
      embedImagesSession.run({ pixel_values: pixelValues, pixel_attention_mask: pixelAttentionMask, spatial_shapes: spatialShapes })
    ),
    embedTokensSession.run({ input_ids: bigintTokenIds(port, PREFIX_IDS) }),
    embedTokensSession.run({ input_ids: bigintTokenIds(port, SUFFIX_IDS) }),
  ])
  const imageFeatures = imgResult['image_features']   // [256, 2048]
  const prefixEmbeds  = prefixOut['inputs_embeds']    // [1, 5, 2048]
  const suffixEmbeds  = suffixOut['inputs_embeds']    // [1, 103, 2048]

  const combinedData = new Float32Array(PROMPT_LEN * HIDDEN)
  combinedData.set(prefixEmbeds.data as Float32Array, 0)
  combinedData.set(imageFeatures.data as Float32Array, PREFIX_IDS.length * HIDDEN)
  combinedData.set(suffixEmbeds.data as Float32Array, (PREFIX_IDS.length + NUM_IMAGE_TOKENS) * HIDDEN)
  const inputsEmbeds = new port.Tensor('float32', combinedData, [1, PROMPT_LEN, HIDDEN])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pastConv: Record<string, any> = {}
  for (const i of CONV_LAYER_INDICES) {
    pastConv[`past_conv.${i}`] = new port.Tensor('float32', new Float32Array(1 * 2048 * 3), [1, 2048, 3])
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pastKV: Record<string, any> = {}
  for (const i of ATTN_LAYER_INDICES) {
    pastKV[`past_key_values.${i}.key`] = new port.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
    pastKV[`past_key_values.${i}.value`] = new port.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])
  }

  const prefillMask = new port.Tensor('int64', new BigInt64Array(PROMPT_LEN).fill(1n), [1, PROMPT_LEN])
  const prefillOut = await decoderSession.run({
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

    const tokenInput = new port.Tensor('int64', BigInt64Array.from([BigInt(lastId)]), [1, 1])
    const tokenEmbeds = ((await embedTokensSession.run({ input_ids: tokenInput }))['inputs_embeds'])

    const attnMask = new port.Tensor('int64', new BigInt64Array(totalSeqLen).fill(1n), [1, totalSeqLen])
    const decOut = await decoderSession.run({
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

  const generatedText = decodeIds(idToVocabStr, generatedIds)
  console.log('[engine] Generated:', generatedText.slice(0, 200))
  return parseDetections(generatedText)
}

function decodeIds(idToVocabStr: Map<number, string>, ids: number[]): string {
  const parts: string[] = []
  for (const id of ids) {
    if (id === EOS_ID) break
    const tokStr = idToVocabStr.get(id)
    if (!tokStr) continue
    if ((tokStr.startsWith('<|') && tokStr.endsWith('|>')) || (tokStr.startsWith('<') && tokStr.endsWith('>'))) continue
    parts.push(decodeTokenString(tokStr))
  }
  return parts.join('')
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
async function patchifyImage(port: LfmPort, imageBytes: Uint8Array): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pixelValues: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pixelAttentionMask: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spatialShapes: any
}> {
  const SIZE = 512
  const PATCH = 16
  const NP = SIZE / PATCH
  const NUM_PATCHES = NP * NP

  const { data: rgba } = await port.decodeImage(imageBytes, SIZE, SIZE)

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
    pixelValues: new port.Tensor('float32', pixelData, [1, NUM_PATCHES, PATCH * PATCH * 3]),
    pixelAttentionMask: new port.Tensor('int64', new BigInt64Array(NUM_PATCHES).fill(1n), [1, NUM_PATCHES]),
    spatialShapes: new port.Tensor('int64', BigInt64Array.from([BigInt(NP), BigInt(NP)]), [1, 2]),
  }
}

function bigintTokenIds(port: LfmPort, ids: number[]) {
  return new port.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
}

function argmax(arr: Float32Array): number {
  let best = 0
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i
  }
  return best
}

// IMAGE_TOKEN_ID is part of the model's prompt-token contract (moved
// verbatim from inference.ts alongside IMAGE_START_ID/IMAGE_END_ID); it is
// not read anywhere in this loop, same as before the extraction.
export { IMAGE_TOKEN_ID }
