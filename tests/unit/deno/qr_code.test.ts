/**
 * Unit tests for the share-link QR renderer (`src/ui/qr-code.ts`).
 *
 * Two things are worth pinning here and nothing else really is:
 *
 *   1. **The SVG says what the encoder said.** The renderer walks
 *      `getModule(x, y)` and emits one path command per dark module, so a
 *      transposed loop or an off-by-one quiet zone would still produce a
 *      plausible-looking square of noise that no phone can read. Comparing the
 *      drawn command count and every individual coordinate against a fresh
 *      encode is the cheap way to catch that without a decoder.
 *   2. **The colours do not follow the theme.** Everything else in this app is
 *      dark-on-dark CI teal; a QR must not be. If someone "fixes" the plate to
 *      use a palette variable, this fails.
 *
 *   deno test --allow-read tests/unit/deno/qr_code.test.ts
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1'
import { qrCodeSvg } from '../../../src/ui/qr-code.ts'
import { qrcodegen } from '../../../src/third-party/qrcodegen/qrcodegen.ts'

/** A realistic scanner share link: base + slug + a `scanner-<uuid>` token. */
const SCANNER_LINK =
  'https://beta-1.capybara-ulmer.ts.net:5173/scanner.html?world=default&token=scanner-3f2b1c9a-77de-4d21-9a6e-1b0c5d4e8f77'

/** The quiet zone the renderer adds on every side, in modules. */
const QUIET_ZONE = 4

function drawnModules(svg: string): Set<string> {
  const out = new Set<string>()
  for (const match of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) out.add(`${match[1]},${match[2]}`)
  return out
}

Deno.test('qrCodeSvg: every drawn module matches the encoder, quiet zone included', () => {
  const qr = qrcodegen.QrCode.encodeText(SCANNER_LINK, qrcodegen.QrCode.Ecc.MEDIUM)
  const drawn = drawnModules(qrCodeSvg(SCANNER_LINK))

  const expected = new Set<string>()
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) expected.add(`${x + QUIET_ZONE},${y + QUIET_ZONE}`)
    }
  }

  assert(expected.size > 0, 'the fixture link should encode to a non-empty symbol')
  assertEquals(drawn.size, expected.size)
  for (const key of expected) assert(drawn.has(key), `module ${key} was not drawn`)
})

Deno.test('qrCodeSvg: the viewBox is the symbol plus a quiet zone on all four sides', () => {
  const qr = qrcodegen.QrCode.encodeText(SCANNER_LINK, qrcodegen.QrCode.Ecc.MEDIUM)
  const span = qr.size + QUIET_ZONE * 2
  const svg = qrCodeSvg(SCANNER_LINK, { size: 240 })

  assert(svg.includes(`viewBox="0 0 ${span} ${span}"`), svg.slice(0, 160))
  assert(svg.includes('width="240" height="240"'))
  // Nothing may be drawn inside the quiet zone.
  for (const key of drawnModules(svg)) {
    const [x, y] = key.split(',').map(Number) as [number, number]
    assert(x >= QUIET_ZONE && y >= QUIET_ZONE && x < span - QUIET_ZONE && y < span - QUIET_ZONE, `module ${key} sits in the quiet zone`)
  }
})

Deno.test('qrCodeSvg: the plate stays light and the modules stay dark', () => {
  // Fixed hex, not a CSS variable, and identical at every option combination —
  // scanners need dark-on-light and this app's theme must not reach the data.
  for (const level of ['L', 'M', 'Q', 'H'] as const) {
    const svg = qrCodeSvg(SCANNER_LINK, { level, size: 120 })
    assert(svg.includes('fill="#ffffff"'), `plate colour missing at level ${level}`)
    assert(svg.includes('fill="#111111"'), `module colour missing at level ${level}`)
    assert(!svg.includes('var('), `level ${level} leaked a CSS variable into the symbol`)
    assert(!/#(0f717a|abd4d8|72ddd4)/i.test(svg), `level ${level} painted CI teal on the symbol`)
  }
})

Deno.test('qrCodeSvg: a higher correction level buys redundancy with a bigger symbol', () => {
  const low = qrcodegen.QrCode.encodeText(SCANNER_LINK, qrcodegen.QrCode.Ecc.LOW).size
  const high = qrcodegen.QrCode.encodeText(SCANNER_LINK, qrcodegen.QrCode.Ecc.HIGH).size
  assert(high > low, `expected H (${high}) to need more modules than L (${low})`)
  assertNotEquals(qrCodeSvg(SCANNER_LINK, { level: 'L' }), qrCodeSvg(SCANNER_LINK, { level: 'H' }))
})

Deno.test('qrCodeSvg: the accessible label is escaped, not interpolated raw', () => {
  const svg = qrCodeSvg(SCANNER_LINK, { label: 'Scanner "link" & <b>role</b>' })
  assert(svg.includes('aria-label="Scanner &quot;link&quot; &amp; &lt;b&gt;role&lt;/b&gt;"'))
  assert(!svg.includes('<b>'))
})

Deno.test('qrCodeSvg: an unencodable payload throws rather than rendering a truncated symbol', () => {
  assertThrows(() => qrCodeSvg('x'.repeat(4000)))
})
