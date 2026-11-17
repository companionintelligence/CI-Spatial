/**
 * The print sheet with the repo's REAL QR renderer: the byte-for-byte snapshots, the modules of the code
 * against the vendored encoder's, and the command line.
 *
 * Needs --experimental-transform-types: `src/ui/qr-code.ts` sits on the vendored Nayuki encoder, which uses a
 * TypeScript namespace that plain type-stripping cannot load. The geometry, the page choice, the printed
 * cells and the detector round trip are in `fiducial_print_sheet.test.ts`, which does not need the flag.
 *
 * Snapshots live in `tests/unit/node/fiducial-sheet/`. To rewrite them after an intended change:
 * `UPDATE_FIDUCIAL_SNAPSHOT=1 node --experimental-transform-types --no-warnings --test tests/unit/node/fiducial_print_sheet_qr.test.ts`
 * and read the diff: a snapshot that changes for no reason is a sheet that changed for no reason.
 *
 * Run: node --experimental-transform-types --no-warnings --test tests/unit/node/fiducial_print_sheet_qr.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSheet } from '../../../scripts/print-fiducial.mjs'
import { qrCodeSvg } from '../../../src/ui/qr-code.ts'
import { qrcodegen } from '../../../src/third-party/qrcodegen/qrcodegen.ts'
import { serializeTagPayload } from '../../../src/ar/fiducial/payload.ts'
import { parseSheet } from '../../support/fiducial-sheet.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const SNAPSHOTS = join(HERE, 'fiducial-sheet')
const SCRIPT = join(ROOT, 'scripts', 'print-fiducial.mjs')

function sheet(args: Partial<Parameters<typeof buildSheet>[0]> = {}) {
  return buildSheet({ tagId: 7, sizeMm: 120, placeId: 'place-kitchen-1', roomId: 'room-a', page: 'a4', qrSvg: qrCodeSvg, ...args })
}

function snapshotMatches(name: string, svg: string) {
  const file = join(SNAPSHOTS, name)
  if (process.env['UPDATE_FIDUCIAL_SNAPSHOT'] === '1') {
    writeFileSync(file, svg)
    return
  }
  assert.ok(existsSync(file), `${file} is missing: run once with UPDATE_FIDUCIAL_SNAPSHOT=1 and read it`)
  const expected = readFileSync(file, 'utf8')
  assert.equal(svg === expected, true, `${name} differs from its snapshot (first difference at byte ${[...svg].findIndex((c, i) => c !== expected[i])})`)
}

test('snapshot: a 120 mm tag on A4 and a 200 mm tag on A3 are byte-for-byte what was reviewed', () => {
  snapshotMatches('id7-120mm-a4.svg', sheet().svg)
  snapshotMatches('id23-200mm-a3.svg', sheet({ tagId: 23, sizeMm: 200, page: 'a3', placeId: 'place-hall-9', roomId: null }).svg)
})

test('the QR code encodes exactly the payload line', () => {
  const built = sheet()
  const p = parseSheet(built.svg)
  const text = serializeTagPayload(built.payload)
  // The drawn modules are the encoder's modules for that text (the encoder is called here directly, not through the sheet).
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM)
  const drawn = new Set<string>()
  for (const m of p.qr.svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) drawn.add(`${Number(m[1]) - 4},${Number(m[2]) - 4}`)
  const expected = new Set<string>()
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) expected.add(`${x},${y}`)
  assert.equal(drawn.size, expected.size)
  for (const m of expected) assert.ok(drawn.has(m), `module ${m} was not drawn`)
  // And it is printed at its stated size.
  assert.match(p.qr.svg, /width="36" height="36"/)
})

/** Every start tag has its end tag, in order, and no stray angle bracket is left in text or attributes. */
function assertBalanced(svg: string): void {
  const stack: string[] = []
  let last = 0
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    const between = svg.slice(last, m.index)
    assert.ok(!between.includes('<') && !between.includes('>'), `a raw angle bracket in text near byte ${m.index}`)
    last = m.index + m[0].length
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `</${m[2]}> closes the wrong element`)
    } else if (!m[4]) {
      stack.push(m[2]!)
    }
  }
  assert.deepEqual(stack, [], 'unclosed elements')
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>\n'))
}

test('every sheet in the snapshots is a well-formed document', () => {
  assertBalanced(readFileSync(join(SNAPSHOTS, 'id7-120mm-a4.svg'), 'utf8'))
  assertBalanced(readFileSync(join(SNAPSHOTS, 'id23-200mm-a3.svg'), 'utf8'))
})

test('the command line writes the same bytes as the builder, and says what to run when the QR renderer cannot load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiducial-sheet-'))
  try {
    const out = join(dir, 'm.svg')
    const args = ['--id', '7', '--size-mm', '120', '--place-id', 'place-kitchen-1', '--room-id', 'room-a', '--page', 'a4', '--out', out]
    execFileSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, ...args], { stdio: 'pipe' })
    assert.equal(readFileSync(out, 'utf8'), sheet().svg)

    const piped = execFileSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--id', '7', '--place-id', 'place-kitchen-1', '--room-id', 'room-a', '--size-mm', '120', '--page', 'a4'], { stdio: 'pipe' }).toString()
    assert.equal(piped, sheet().svg, 'standard output is the same sheet')

    const noFlag = spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { encoding: 'utf8' })
    assert.equal(noFlag.status, 2)
    assert.match(noFlag.stderr, /npm run print:fiducial/)

    const missing = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--id', '7'], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /--id and --place-id are required/)

    const tooBig = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--id', '7', '--place-id', 'p', '--size-mm', '400', '--page', 'a3'], { encoding: 'utf8' })
    assert.equal(tooBig.status, 2)
    assert.match(tooBig.stderr, /needs a page at least/)

    const help = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /usage: npm run print:fiducial/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the command line refuses a size no page holds, and prints the usage with both ways to run it', () => {
  const tooBig = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--id', '7', '--place-id', 'p', '--size-mm', '700'], { encoding: 'utf8' })
  assert.equal(tooBig.status, 2)
  assert.match(tooBig.stderr, /size must be from 40 to 600 mm/)
  const help = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', SCRIPT, '--help'], { encoding: 'utf8' })
  assert.match(help.stdout, /npm run print:fiducial/)
  assert.match(help.stdout, /node --experimental-transform-types --no-warnings scripts\/print-fiducial\.mjs/)
})
