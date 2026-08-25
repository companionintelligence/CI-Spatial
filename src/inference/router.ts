/**
 * Inference router — selects server or WebGPU path.
 *
 * Server path (default):
 *   POSTs the image to the Deno inference server (localhost:8000, proxied by Vite).
 *   Faster in practice since the server runs multi-threaded ONNX on all machine cores.
 *
 * WebGPU path (opt-in via settings):
 *   Spawns a Web Worker running LFM2.5-VL-1.6B-ONNX on-device
 *   (./lfm-driver-web.ts, wave 05 ticket 0003), gated only by the browser's
 *   actual WebGPU support — see `hasWebGPU` below. Wave 04 ticket 0004
 *   gated this behind a build-time flag while the driver could not run at
 *   all; wave 05 ticket 0004
 *   (docs/factory/05-on-device-inference/0004-ungate-toggle-and-fallback-policy.md)
 *   lifts that gate now that it genuinely does, and replaces this file's
 *   fallback logic — both branches used to fall back to the server
 *   *silently*, which contradicts the panel's "On-device — no data leaves
 *   your phone" claim the moment it happens on a path that actually runs.
 *   Failure is now reported to the caller as a typed WebGpuInferenceError
 *   instead: no image crosses the network on a capture the UI says stayed
 *   on-device.
 *
 * User preference persists in localStorage key 'infer-mode' ('server' | 'webgpu').
 * A stored 'webgpu' is resolved to server at read time (never overwritten)
 * when `hasWebGPU` is false, so a user who opted in on a capable device still
 * gets it back if they open the app somewhere that cannot run it.
 * Both paths expose the same async interface:
 *   router.infer(blob) → Promise<RawDetection[]>
 */
// Explicit .ts extensions on these two: see src/scene/store.ts's identical
// note — tests/unit/node/inference_router.test.ts imports this module
// directly, and Node's ESM loader needs the real specifier, not Vite's
// bundler resolution. RawDetection stays extension-less below; it's
// type-only, so it's erased before Node's loader ever sees it.
import { inferViaServer } from './server.ts'
import type { RawDetection } from './prompt'
import { INFER_MODE_KEY } from '../shared/storage-keys.ts'

export type InferMode = 'server' | 'webgpu'

type ProgressCallback = (stage: string, pct: number) => void
type ModeChangeCallback = (mode: InferMode) => void

interface PendingRequest {
  resolve: (detections: RawDetection[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type WebGpuInferenceErrorCode = 'timeout' | 'not-provisioned' | 'worker-error'

/**
 * Typed failure from the on-device path, with a stable code so the HUD
 * (src/main.ts's capture catch block) can tell the user specifically what
 * happened instead of a generic "capture failed".
 *
 * Never caught here and turned into a server request on the caller's
 * behalf — see this file's header and
 * docs/factory/05-on-device-inference/0004-ungate-toggle-and-fallback-policy.md's
 * "the naive fix is actively harmful". A capture that fails on-device fails;
 * the image is never sent anywhere the UI didn't say it would go.
 */
export class WebGpuInferenceError extends Error {
  code: WebGpuInferenceErrorCode

  constructor(message: string, code: WebGpuInferenceErrorCode) {
    super(message)
    this.name = 'WebGpuInferenceError'
    this.code = code
  }
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

  /**
   * True if this browser exposes a WebGPU adapter.
   *
   * This is a device-capability check, not a feature flag — every route into
   * the worker funnels through this getter (init(), setMode(), the panel's
   * toggle state, and the HUD failure copy in main.ts), so a device that
   * cannot run the on-device path never gets offered it, and never silently
   * re-gains it later (docs/factory/05-on-device-inference/
   * 0004-ungate-toggle-and-fallback-policy.md's Non-goals).
   */
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

    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(INFER_MODE_KEY) as InferMode | null : null
    const wantsWebGPU = saved === 'webgpu' && this.hasWebGPU
    this.useWorker = wantsWebGPU

    if (this.useWorker) this._spawnWorker()
  }

  /**
   * Switch inference mode at runtime and persist the choice.
   * Spawns the WebGPU worker on first switch to 'webgpu'.
   */
  setMode(mode: InferMode): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INFER_MODE_KEY, mode)
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
   * Worker crashed or failed to load — reject in-flight requests and revert
   * *future* captures to the server path. The requests that were in flight
   * are rejected, not silently reissued to the server: whatever image they
   * carried never leaves the device. Does not touch the saved localStorage
   * preference, so the user's WebGPU choice survives a reload — only the
   * live `useWorker`/`path` state (and the panel it drives, via
   * `onModeChange`) reverts, so the UI stops claiming a capability that just
   * broke instead of quietly using the server while still showing "WebGPU".
   */
  private _onWorkerFailure(err: unknown): void {
    console.error('[worker]', err)
    const message = err instanceof ErrorEvent && err.message ? err.message : 'WebGPU worker failed'
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new WebGpuInferenceError(message, 'worker-error'))
    }
    this.pending.clear()
    this.worker?.terminate()
    this.worker = null
    this.useWorker = false
    this.modelReady = false
    this.onModeChange?.('server')
    this.onProgress?.('On-device inference crashed — switched to Server', 1)
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
        // On-device inference genuinely works now (wave 05 ticket 0003), so a
        // request stuck this long is a real failure to report — not a reason
        // to quietly hand the same image to the server while the UI still
        // says "On-device — no data leaves your phone" for this capture. See
        // docs/factory/05-on-device-inference/0004-ungate-toggle-and-fallback-policy.md.
        // The worker itself stays alive; only this one request fails, and the
        // caller (src/main.ts) decides what the user sees and whether the
        // frame is kept.
        this.pending.delete(id)
        reject(new WebGpuInferenceError('On-device inference timed out', 'timeout'))
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
        // lfm-driver-web.ts's readCachedFile() throws this exact substring
        // (see its header) when ticket 0002's provisioning cache is missing
        // the requested file — the one on-device failure the user can fix
        // from the panel rather than by retrying or switching engines.
        const code: WebGpuInferenceErrorCode = message.includes('not cached') ? 'not-provisioned' : 'worker-error'
        entry.reject(new WebGpuInferenceError(message, code))
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
