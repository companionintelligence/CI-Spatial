/**
 * Shared frame-quality helpers for the ingest scripts (video + photos).
 *
 * Sharpness = variance of the 3x3 Laplacian response on a grayscale,
 * downscaled copy of the frame (long edge ≤ 640px). Downscaling keeps the
 * metric resolution-independent — the same threshold works for a 4K video
 * frame and a 12MP photo — and keeps the pure-JS convolution fast. This is
 * the classic "variance of Laplacian" blur detector, no OpenCV required.
 *
 * Decoding prefers sharp (native, a transitive dependency of
 * @huggingface/transformers so it is always installed with this repo) and
 * falls back to jimp (pure JS, a direct devDependency) when sharp's native
 * binary is unavailable on the host.
 */

/** Long edge used for the sharpness measurement (keeps thresholds stable). */
export const SHARPNESS_LONG_EDGE = 640

let decoderPromise = null

/** Lazily resolve the grayscale decoder backend: sharp first, jimp fallback. */
function getDecoder() {
  decoderPromise ??= (async () => {
    try {
      const sharp = (await import('sharp')).default
      return {
        name: 'sharp',
        /** @returns {Promise<{data: Uint8Array, width: number, height: number}>} */
        async decodeGray(path, longEdge) {
          const { data, info } = await sharp(path)
            .rotate() // honour EXIF orientation before measuring
            .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true })
          return { data, width: info.width, height: info.height }
        },
      }
    } catch {
      const { Jimp } = await import('jimp')
      return {
        name: 'jimp',
        async decodeGray(path, longEdge) {
          const img = await Jimp.read(path)
          if (Math.max(img.width, img.height) > longEdge) {
            img.scaleToFit({ w: longEdge, h: longEdge })
          }
          img.greyscale()
          const { data, width, height } = img.bitmap // RGBA
          const gray = new Uint8Array(width * height)
          for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]
          return { data: gray, width, height }
        },
      }
    }
  })()
  return decoderPromise
}

/** Name of the decoder backend in use ('sharp' | 'jimp') — for logs/session.json. */
export async function decoderName() {
  return (await getDecoder()).name
}

/**
 * Variance of the 3x3 Laplacian response over the interior pixels of a
 * grayscale image. Higher = sharper; blurred frames collapse toward 0.
 * @param {{data: Uint8Array, width: number, height: number}} gray
 */
export function laplacianVariance({ data, width, height }) {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  const n = (width - 2) * (height - 2)
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      // Kernel: [0 1 0; 1 -4 1; 0 1 0]
      const v = data[i - width] + data[i + width] + data[i - 1] + data[i + 1] - 4 * data[i]
      sum += v
      sumSq += v * v
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

/**
 * Measure the sharpness (variance of Laplacian) of an image file.
 * @param {string} path
 * @returns {Promise<number>}
 */
export async function frameSharpness(path) {
  const decoder = await getDecoder()
  const gray = await decoder.decodeGray(path, SHARPNESS_LONG_EDGE)
  return laplacianVariance(gray)
}

/**
 * Measure every frame and split into keepers/dropped by `minSharpness`.
 * A threshold of 0 (or negative) disables the filter entirely.
 * @param {string[]} paths absolute frame paths
 * @param {number} minSharpness
 * @returns {Promise<{keep: string[], dropped: Array<{path: string, sharpness: number}>}>}
 */
export async function filterBlurryFrames(paths, minSharpness) {
  if (!(minSharpness > 0)) return { keep: [...paths], dropped: [] }
  const keep = []
  const dropped = []
  for (const path of paths) {
    let sharpness
    try {
      sharpness = await frameSharpness(path)
    } catch {
      // Unreadable frame — keep it rather than silently shrinking the session;
      // downstream stages already tolerate (and report) bad frames.
      keep.push(path)
      continue
    }
    if (sharpness < minSharpness) dropped.push({ path, sharpness })
    else keep.push(path)
  }
  return { keep, dropped }
}
