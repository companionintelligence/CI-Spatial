/**
 * Binary-little-endian PLY parser specialised for the layout the LingBot-Map
 * worker emits:
 *
 *   property float x
 *   property float y
 *   property float z
 *   property uchar red    (optional)
 *   property uchar green  (optional)
 *   property uchar blue   (optional)
 *
 * Kept runtime-agnostic (no Deno / DOM globals) so both the Deno server's GLB
 * builder and the browser viewer can import it.
 */

export interface ParsedPLY {
  xyz: Float32Array
  rgb: Uint8Array | null
  count: number
}

export function parseLingBotMapPLY(bytes: Uint8Array): ParsedPLY {
  const headerEnd = findHeaderEnd(bytes)
  if (headerEnd < 0) throw new Error('PLY: missing end_header')
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd))
  const lines = header.split(/\r?\n/)
  if (lines[0] !== 'ply') throw new Error('PLY: missing magic')
  const format = lines.find((l) => l.startsWith('format '))
  if (!format || !format.includes('binary_little_endian')) {
    throw new Error('PLY: only binary_little_endian is supported')
  }
  let count = 0
  const properties: string[] = []
  for (const line of lines) {
    const m = line.match(/^element vertex (\d+)$/)
    if (m) count = Number(m[1])
    const p = line.match(/^property (float|uchar) (\w+)$/)
    if (p) properties.push(`${p[1]}:${p[2]}`)
  }
  const expected = ['float:x', 'float:y', 'float:z']
  for (let i = 0; i < expected.length; i++) {
    if (properties[i] !== expected[i]) {
      throw new Error(`PLY: expected XYZ floats first, got ${properties.slice(0, 3).join(',')}`)
    }
  }
  const hasRGB = properties[3] === 'uchar:red' &&
    properties[4] === 'uchar:green' &&
    properties[5] === 'uchar:blue'
  const stride = hasRGB ? 15 : 12

  const xyz = new Float32Array(count * 3)
  const rgb = hasRGB ? new Uint8Array(count * 3) : null
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + headerEnd,
    bytes.byteLength - headerEnd,
  )
  for (let i = 0; i < count; i++) {
    const off = i * stride
    xyz[i * 3 + 0] = view.getFloat32(off + 0, true)
    xyz[i * 3 + 1] = view.getFloat32(off + 4, true)
    xyz[i * 3 + 2] = view.getFloat32(off + 8, true)
    if (hasRGB && rgb) {
      rgb[i * 3 + 0] = view.getUint8(off + 12)
      rgb[i * 3 + 1] = view.getUint8(off + 13)
      rgb[i * 3 + 2] = view.getUint8(off + 14)
    }
  }
  return { xyz, rgb, count }
}

function findHeaderEnd(bytes: Uint8Array): number {
  const needle = new TextEncoder().encode('end_header\n')
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return i + needle.length
  }
  return -1
}
