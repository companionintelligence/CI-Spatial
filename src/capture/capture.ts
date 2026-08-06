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
    return blobToDataUrl(thumb)
  }

  /**
   * Per-detection thumbnail: the frame cropped to one object's bounding box.
   *
   * The review panel gives every object a 44 px square next to its name, and
   * until now every square in the list was the *same* whole-frame thumbnail —
   * so a scan of a room showed the identical wide shot beside "sofa", "tv" and
   * "table", which tells the reader nothing and looks like the list failed to
   * load its images. Cropping to the box the detector actually returned makes
   * the square do its job.
   *
   * `bbox` is normalised [x0,y0,x1,y1] as produced by the VLM contract in
   * src/inference/prompt.ts. The crop is padded by 8% of the box on each side
   * (a box clipped exactly to a chair's silhouette reads as an abstract texture;
   * a little of its surroundings makes it recognisable) and squared off, so the
   * thumbnails in the list share one aspect ratio.
   */
  async captureDetectionThumbnail(
    sourceBlob: Blob,
    bbox: [number, number, number, number],
  ): Promise<string> {
    const bitmap = await createImageBitmap(sourceBlob)
    try {
      const iw = bitmap.width
      const ih = bitmap.height
      const [nx0, ny0, nx1, ny1] = bbox
      const bw = Math.max(0, nx1 - nx0) * iw
      const bh = Math.max(0, ny1 - ny0) * ih
      // A degenerate box would crop to nothing; fall back to the whole frame
      // rather than emit a 1 px sliver.
      const side = Math.max(bw, bh) * 1.16
      if (!Number.isFinite(side) || side < 8) return await this.captureThumbnail(sourceBlob)

      const cx = ((nx0 + nx1) / 2) * iw
      const cy = ((ny0 + ny1) / 2) * ih
      const half = Math.min(side / 2, iw / 2, ih / 2)
      const sx = Math.round(Math.min(Math.max(cx - half, 0), iw - half * 2))
      const sy = Math.round(Math.min(Math.max(cy - half, 0), ih - half * 2))
      const s = Math.round(half * 2)

      const out = Math.min(256, s)
      const oc = new OffscreenCanvas(out, out)
      const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, sx, sy, s, s, 0, 0, out, out)
      const thumb = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      return await blobToDataUrl(thumb)
    } finally {
      bitmap.close()
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
