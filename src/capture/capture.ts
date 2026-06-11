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

export class CaptureModule {
  constructor(private readonly provider: ARProvider) {}

  async capture(timeoutMs = 4000): Promise<CaptureResult> {
    const frame = await this.provider.captureFrame(timeoutMs)
    const { pixels, width, height, pose, timestamp } = frame

    // Build an ImageBitmap from the raw RGBA array, then draw to OffscreenCanvas
    // to encode as JPEG (small, good for VLM inference)
    // Copy into a plain ArrayBuffer to satisfy the ImageData constructor
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height)
    const bitmap = await createImageBitmap(imageData)

    const oc = new OffscreenCanvas(width, height)
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 })

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
