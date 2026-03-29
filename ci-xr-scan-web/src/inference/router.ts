/**
 * Inference router — feature-detects at startup and picks the right path.
 *
 * WebGPU path (Android Chrome 121+, desktop):
 *   Spawns a Web Worker that runs LFM2.5-VL-1.6B-ONNX on-device.
 *   Zero data-exfiltration: the image never leaves the device.
 *
 * Server path (iOS, older Android, fallback):
 *   POSTs the image to the Deno inference server over Tailscale.
 *
 * Both paths expose the same async interface:
 *   router.infer(blob) → Promise<RawDetection[]>
 */
import { inferViaServer } from './server'
import type { RawDetection } from './prompt'

type ProgressCallback = (stage: string, pct: number) => void

interface PendingRequest {
  resolve: (detections: RawDetection[]) => void
  reject: (err: Error) => void
}

export class InferenceRouter {
  private worker: Worker | null = null
  private useWorker = false
  private pending = new Map<string, PendingRequest>()
  private onProgress: ProgressCallback | null = null

  /** Call once at startup — determines path and pre-warms the worker if able */
  async init(onProgress?: ProgressCallback): Promise<void> {
    this.onProgress = onProgress ?? null
    // iOS Safari 17+ exposes navigator.gpu but running a 1.5 GB ONNX model on
    // device is impractical (OOM, load time). Always use the server path on iOS.
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)
    this.useWorker = !isIOS && typeof navigator !== 'undefined' && 'gpu' in navigator

    if (this.useWorker) {
      this.worker = new Worker(new URL('./webgpu.worker.ts', import.meta.url), { type: 'module' })
      this.worker.addEventListener('message', this.handleWorkerMessage.bind(this))
      this.worker.addEventListener('error', (e) => console.error('[worker]', e))
    }
  }

  get path(): 'webgpu' | 'server' {
    return this.useWorker ? 'webgpu' : 'server'
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
