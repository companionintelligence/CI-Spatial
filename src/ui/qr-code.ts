/**
 * QR renderer — Project Nayuki's encoder (vendored at
 * `src/third-party/qrcodegen/`) drawn as one inline SVG path.
 *
 * Inline SVG rather than a canvas or an image request, for the same reasons
 * `icons.ts` gives: nothing to resolve at build time, and the symbol stays
 * crisp at whatever size the caller asks for. One `<path>` holding every dark
 * module keeps the DOM to two nodes even for a version-10 symbol.
 */
// Extension-ful, following the `src/shared/provenance.ts` convention: this
// module is imported by a Deno unit test as well as by Vite, and Deno resolves
// specifiers literally.
import { qrcodegen } from '../third-party/qrcodegen/qrcodegen.ts'

/** Error-correction level, spelled the way the spec spells it. */
export type QrEccLevel = 'L' | 'M' | 'Q' | 'H'

const ECC: Record<QrEccLevel, qrcodegen.QrCode.Ecc> = {
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
}

/**
 * Scanner contrast beats brand, so these two are fixed hex rather than palette
 * variables and they do NOT flip with the theme. Decoders expect dark modules
 * on a light ground; an inverted or teal-tinted symbol costs decode rate on
 * exactly the cheap phone cameras this feature exists for. CI teal belongs on
 * the frame, border and caption around this SVG — never on the data modules.
 */
const PLATE_COLOR = '#ffffff'
const MODULE_COLOR = '#111111'

/** Quiet zone, in modules. Four is the spec minimum; less hurts acquisition. */
const QUIET_ZONE = 4

export interface QrCodeOptions {
  /** Rendered edge length in CSS pixels. Default 200. */
  size?: number
  /** Default 'M'. Raise it when anything occludes the symbol. */
  level?: QrEccLevel
  /** Accessible name for the symbol. Default 'QR code'. */
  label?: string
}

/**
 * Encode `value` and return a standalone `<svg>` string, ready to assign to
 * `innerHTML`. Throws (from the encoder) if the text does not fit version 40 at
 * the requested error-correction level.
 */
export function qrCodeSvg(value: string, options: QrCodeOptions = {}): string {
  const size = options.size ?? 200
  const label = options.label ?? 'QR code'
  const qr = qrcodegen.QrCode.encodeText(value, ECC[options.level ?? 'M'])
  const span = qr.size + QUIET_ZONE * 2

  let modules = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) modules += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}" `
    + `shape-rendering="crispEdges" role="img" aria-label="${escAttr(label)}">`
    + `<rect width="${span}" height="${span}" fill="${PLATE_COLOR}"/>`
    + `<path d="${modules}" fill="${MODULE_COLOR}"/>`
    + '</svg>'
}

function escAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
