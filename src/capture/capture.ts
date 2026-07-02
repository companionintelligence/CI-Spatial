/**
 * CaptureModule — triggered by the user pressing the capture button.
 *
 * On press it:
 *   1. Grabs the next camera frame from the AR provider
 *   2. Converts the raw RGBA pixels to a Blob (JPEG) for the inference router
 *   3. Returns { blob, pose, timestamp } to the caller
 */
import type { ARProvider } from '../ar/provider'

export interface CaptureResult {
  blob: Blob
  pose: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
  }
  timestamp: number
}

export interface CaptureModuleOptions {
  /** Frames are downscaled so the long edge is at most this (default 1280 px) */
  maxLongEdgePx?: number
  /** JPEG quality (default 0.8) */
  jpegQuality?: number
}

const DEFAULTS: Required<CaptureModuleOptions> = {
  maxLongEdgePx: 1280,
  jpegQuality: 0.8,
}

/** Re-encode once at this quality when the first pass exceeds the size cap */
const MAX_BLOB_BYTES = 1_500_000
const FALLBACK_QUALITY = 0.65

export class CaptureModule {
  private _opts: Required<CaptureModuleOptions>

  constructor(
    private readonly provider: ARProvider,
    opts: CaptureModuleOptions = {},
  ) {
    this._opts = { ...DEFAULTS, ...opts }
  }

  async capture(timeoutMs = 4000): Promise<CaptureResult> {
    const frame = await this.provider.captureFrame(timeoutMs)
    const { pixels, width, height, pose, timestamp } = frame

    // Build an ImageBitmap from the raw RGBA array, then draw to OffscreenCanvas
    // downscaled to maxLongEdgePx to encode as JPEG (small, good for VLM
    // inference — bboxes are normalized 0..1 so downstream is resolution-agnostic)
    // Copy into a plain ArrayBuffer to satisfy the ImageData constructor
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height)
    const bitmap = await createImageBitmap(imageData)

    const scale = Math.min(1, this._opts.maxLongEdgePx / Math.max(width, height))
    const w = Math.round(width * scale)
    const h = Math.round(height * scale)
    const oc = new OffscreenCanvas(w, h)
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    let blob = await oc.convertToBlob({ type: 'image/jpeg', quality: this._opts.jpegQuality })
    if (blob.size > MAX_BLOB_BYTES) {
      blob = await oc.convertToBlob({ type: 'image/jpeg', quality: FALLBACK_QUALITY })
    }

    return { blob, pose, timestamp }
  }

  /**
   * Convenience: capture a small thumbnail (max 256 px wide) and return a
   * data URL for embedding in userData / the detections panel.
   */
  async captureThumbnail(sourceBlob: Blob): Promise<string> {
    const bitmap = await createImageBitmap(sourceBlob)
    const scale = Math.min(1, 256 / bitmap.width)
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const oc = new OffscreenCanvas(w, h)
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const thumb = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(thumb)
    })
  }
}
