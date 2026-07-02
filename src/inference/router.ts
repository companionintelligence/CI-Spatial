/**
 * Inference router — selects server or WebGPU path.
 *
 * Server path (default):
 *   POSTs the image to the Deno inference server (localhost:8000, proxied by Vite).
 *   Faster in practice since the server runs multi-threaded ONNX on all machine cores.
 *
 * WebGPU path (opt-in via settings):
 *   Spawns a Web Worker with LFM2.5-VL-1.6B-ONNX on-device.
 *   Only available on Chrome 121+ / Safari TP with WebGPU support.
 *
 * User preference persists in localStorage key 'infer-mode' ('server' | 'webgpu').
 * Both paths expose the same async interface:
 *   router.infer(blob) → Promise<RawDetection[]>
 */
import { inferViaServer } from './server'
import type { RawDetection } from './prompt'

export type InferMode = 'server' | 'webgpu'

type ProgressCallback = (stage: string, pct: number) => void
type ModeChangeCallback = (mode: InferMode) => void

interface PendingRequest {
  resolve: (detections: RawDetection[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Worker request budgets: generous while the model is still downloading/compiling,
// tight once it has reported ready (progress pct === 1).
const WORKER_TIMEOUT_LOADING_MS = 150_000
const WORKER_TIMEOUT_READY_MS = 45_000

export class InferenceRouter {
  private worker: Worker | null = null
  private useWorker = false
  private pending = new Map<string, PendingRequest>()
  private modelReady = false
  private onProgress: ProgressCallback | null = null
  private onModeChange: ModeChangeCallback | null = null

  /** True if the browser has a WebGPU adapter exposed. */
  get hasWebGPU(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator
  }

  /** Currently active inference path. */
  get path(): InferMode {
    return this.useWorker ? 'webgpu' : 'server'
  }

  /**
   * Call once at startup.
   * Defaults to server-side inference; switches to WebGPU only if the user
   * previously saved that preference and the browser supports it.
   */
  async init(onProgress?: ProgressCallback, onModeChange?: ModeChangeCallback): Promise<void> {
    this.onProgress = onProgress ?? null
    this.onModeChange = onModeChange ?? null

    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('infer-mode') as InferMode | null : null
    const wantsWebGPU = saved === 'webgpu' && this.hasWebGPU
    this.useWorker = wantsWebGPU

    if (this.useWorker) this._spawnWorker()
  }

  /**
   * Switch inference mode at runtime and persist the choice.
   * Spawns the WebGPU worker on first switch to 'webgpu'.
   */
  setMode(mode: InferMode): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem('infer-mode', mode)
    const want = mode === 'webgpu' && this.hasWebGPU
    if (want === this.useWorker) return
    this.useWorker = want
    if (this.useWorker && !this.worker) this._spawnWorker()
    this.onModeChange?.(this.path)
  }

  private _spawnWorker(): void {
    this.modelReady = false
    this.worker = new Worker(new URL('./webgpu.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', this.handleWorkerMessage.bind(this))
    this.worker.addEventListener('error', (e) => this._onWorkerFailure(e))
  }

  /**
   * Worker crashed or failed to load — reject in-flight requests and fall back
   * to server inference. Does not touch the saved localStorage preference, so
   * the user's WebGPU choice survives a reload.
   */
  private _onWorkerFailure(err: unknown): void {
    console.error('[worker]', err)
    const message = err instanceof ErrorEvent && err.message ? err.message : 'WebGPU worker failed'
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
    }
    this.pending.clear()
    this.worker?.terminate()
    this.worker = null
    this.useWorker = false
    this.modelReady = false
    this.onModeChange?.('server')
    this.onProgress?.('WebGPU failed — using server', 1)
  }

  async infer(imageBlob: Blob): Promise<RawDetection[]> {
    if (!this.useWorker) {
      return inferViaServer(imageBlob)
    }

    // Convert blob → data URL to send to the worker
    // (Workers can't receive Blobs directly via postMessage in all browsers)
    const dataUrl = await blobToDataUrl(imageBlob)
    const id = crypto.randomUUID()

    return new Promise<RawDetection[]>((resolve, reject) => {
      const timeoutMs = this.modelReady ? WORKER_TIMEOUT_READY_MS : WORKER_TIMEOUT_LOADING_MS
      const timer = setTimeout(() => {
        // Worker is stuck on this request — fall back to the server for this
        // call only; the worker itself stays alive.
        this.pending.delete(id)
        inferViaServer(imageBlob).then(resolve, reject)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ type: 'infer', id, imageDataUrl: dataUrl })
    })
  }

  private handleWorkerMessage(
    evt: MessageEvent<
      | { type: 'result'; id: string; detections: RawDetection[] }
      | { type: 'error'; id: string; message: string }
      | { type: 'progress'; stage: string; pct: number }
    >,
  ): void {
    const { type } = evt.data
    if (type === 'progress') {
      const { stage, pct } = evt.data as { type: 'progress'; stage: string; pct: number }
      if (pct === 1) this.modelReady = true
      this.onProgress?.(stage, pct)
      return
    }
    if (type === 'result') {
      const { id, detections } = evt.data as { type: 'result'; id: string; detections: RawDetection[] }
      const entry = this.pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        entry.resolve(detections)
        this.pending.delete(id)
      }
      return
    }
    if (type === 'error') {
      const { id, message } = evt.data as { type: 'error'; id: string; message: string }
      const entry = this.pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        entry.reject(new Error(message))
        this.pending.delete(id)
      }
    }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
