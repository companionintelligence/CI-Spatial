/**
 * Inference engine — runs LFM2.5-VL-1.6B-ONNX locally.
 *
 * Supports three modes (INFERENCE_MODE env):
 * 1. "ollama" (default) — POSTs to local Ollama API (Metal/AMD accelerated, zero local deps)
 * 2. "onnx"             — runs via onnxruntime-node (loaded dynamically to avoid load errors)
 * 3. "mock"             — deterministic colour-blob detector for tests/CI; recognises the
 *                         shared CV palette colours (test-data/cv images, xr8-mock feed)
 */
import { SPATIAL_DETECTION_PROMPT, parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt.ts'
import { classifyPixel, paletteColorNameFor } from '../src/shared/cv-palette.ts'
import { DEFAULT_MODEL_TAG } from '../src/shared/model-catalog.ts'
import { normalizeOllamaHost } from '../src/shared/ollama-host.ts'
import { resolveOllamaModel } from '../src/shared/ollama-model.ts'
import { loadLfmDriver, runLfmDriver } from '../src/inference/lfm-driver.ts'
import type { LfmDriverHandle, LfmPort } from '../src/inference/lfm-driver.ts'
import { createDenoOnnxPort } from './lfm-driver-onnx.ts'

// Re-export shared types
export type { RawDetection }

// Dynamic import placeholder for the mock engine's Jimp use — the ONNX path's
// own Jimp/onnxruntime-node imports live behind the driver port (see load()).
let JimpClass: any = null

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
  private driverPort: LfmPort | null = null
  private driverHandle: LfmDriverHandle | null = null
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

    // Dynamic imports — kept dynamic (not moved into lfm-driver-onnx.ts) so a
    // load error in either package is only ever hit when INFERENCE_MODE=onnx,
    // exactly as before the extraction.
    const ort = await import('onnxruntime-node')
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

    this.driverPort = createDenoOnnxPort(ort, JimpClass)
    this.driverHandle = await loadLfmDriver(this.driverPort, opts)

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
    if (!this.driverPort || !this.driverHandle) {
      throw new Error('Engine not loaded — call load() first')
    }
    return await runLfmDriver(this.driverPort, this.driverHandle, imageBytes)
  }
}
