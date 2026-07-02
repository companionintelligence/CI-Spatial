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
  timeout: ReturnType<typeof setTimeout>
}

const WEBGPU_FIRST_REQUEST_TIMEOUT_MS = 150_000
const WEBGPU_REQUEST_TIMEOUT_MS = 45_000

export class InferenceRouter {
  private worker: Worker | null = null
  private useWorker = false
  private pending = new Map<string, PendingRequest>()
  private onProgress: ProgressCallback | null = null
  private onModeChange: ModeChangeCallback | null = null
  private workerReady = false

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
    this.workerReady = false
    this.worker = new Worker(new URL('./webgpu.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', this.handleWorkerMessage.bind(this))
    this.worker.addEventListener('error', (e) => this._handleWorkerFailure(e.message || 'WebGPU worker failed'))
    this.worker.addEventListener('messageerror', () => this._handleWorkerFailure('WebGPU worker sent an unreadable message'))
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
      const timeoutMs = this.workerReady ? WEBGPU_REQUEST_TIMEOUT_MS : WEBGPU_FIRST_REQUEST_TIMEOUT_MS
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('WebGPU inference timed out'))
        this._fallbackToServer('WebGPU timed out - using server')
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
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
      if (pct >= 1 || /ready/i.test(stage)) this.workerReady = true
      this.onProgress?.(stage, pct)
      return
    }
    if (type === 'result') {
      const { id, detections } = evt.data as { type: 'result'; id: string; detections: RawDetection[] }
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timeout)
        pending.resolve(detections)
        this.pending.delete(id)
      }
      return
    }
    if (type === 'error') {
      const { id, message } = evt.data as { type: 'error'; id: string; message: string }
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(message))
        this.pending.delete(id)
      }
    }
  }

  private _handleWorkerFailure(message: string): void {
    console.error('[worker]', message)
    this._fallbackToServer(`WebGPU failed - using server`)
  }

  private _fallbackToServer(message: string): void {
    this._rejectAllPending(new Error(message))
    this.worker?.terminate()
    this.worker = null
    this.workerReady = false
    this.useWorker = false
    if (typeof localStorage !== 'undefined') localStorage.setItem('infer-mode', 'server')
    this.onProgress?.(message, 0)
    this.onModeChange?.('server')
  }

  private _rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
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
