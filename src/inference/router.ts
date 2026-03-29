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
}

export class InferenceRouter {
  private worker: Worker | null = null
  private useWorker = false
  private pending = new Map<string, PendingRequest>()
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
    this.worker = new Worker(new URL('./webgpu.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', this.handleWorkerMessage.bind(this))
    this.worker.addEventListener('error', (e) => console.error('[worker]', e))
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
      this.pending.set(id, { resolve, reject })
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
      this.onProgress?.(stage, pct)
      return
    }
    if (type === 'result') {
      const { id, detections } = evt.data as { type: 'result'; id: string; detections: RawDetection[] }
      this.pending.get(id)?.resolve(detections)
      this.pending.delete(id)
      return
    }
    if (type === 'error') {
      const { id, message } = evt.data as { type: 'error'; id: string; message: string }
      this.pending.get(id)?.reject(new Error(message))
      this.pending.delete(id)
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
