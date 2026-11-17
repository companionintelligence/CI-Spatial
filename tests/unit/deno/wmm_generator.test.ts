/**
 * scripts/gen-wmm-coefficients.mjs: the generator behind src/world/wmm2025-coefficients.ts.
 *
 * The generator is what makes the claim in that module's header checkable: the SHA-256 recorded there is that of the
 * file the rows were read from, and the generator refuses any text it cannot render back to the identical bytes
 * (`renderCof(parseCof(text)) === text`), so the hash and the rows cannot disagree. These tests hold that to account:
 *
 *   - the writing parser takes exactly NOAA's fixed-width layout and names the line of anything else, in every way a
 *     file of this kind goes wrong (a dropped row, rows out of order, Windows line endings, a drifted column, a model
 *     and an epoch that disagree, a zonal row with an h term);
 *   - the module it writes is the same bytes every time, carries the hash, the epoch, the validity and the NOAA notice,
 *     refuses an origin that would end the header comment, and the committed module is that generator's output, not a
 *     hand-edited copy;
 *   - `--check` is the way to settle whether NOAA's own file has the rows this repository has, so it reads the file the
 *     way a download may come (Windows line endings, a byte-order mark, other column widths, a -0.0 printed as 0.0),
 *     says so and exits 0 when the rows are the same, 1 when a row or the model differs, and 2 when it cannot tell.
 *
 * Marked "WMM2025 only" are the lines that are known answers of this one file: the swap to WMM2030 replaces them (the
 * header of src/world/declination.ts lists the steps).
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { WMM_COEFFICIENTS, WMM_EPOCH, WMM_FILE_DATE, WMM_MODEL_NAME, WMM_SOURCE_SHA256, WMM_VALID_UNTIL } from '../../../src/world/declination.ts'
import { COF_ROWS, modelOfModule, parseCof, parseCofLoose, renderCof, renderModule, rowsOfModule, sha256Hex } from '../../../scripts/gen-wmm-coefficients.mjs'

const cofOf = (rows: ReadonlyArray<readonly number[]> = WMM_COEFFICIENTS) =>
  renderCof({ epoch: WMM_EPOCH, modelName: WMM_MODEL_NAME, fileDate: WMM_FILE_DATE, rows })
const COF = cofOf()
const bytes = (text: string) => new TextEncoder().encode(text)
const lines = () => COF.split('\n')
const repo = (path: string) => decodeURIComponent(new URL(`../../../${path}`, import.meta.url).pathname)
/** The generated module's file name, which the generator takes from the model: wmm2025-coefficients.ts. */
const MODULE_NAME = `wmm${WMM_MODEL_NAME.slice(-4)}-coefficients.ts`
/** A model that is not the shipped one: five years on. */
const NEXT = { epoch: WMM_EPOCH + 5, modelName: `WMM-${WMM_EPOCH + 5}` }
/** The shipped rows under another model's header. */
const COF_OF_NEXT = renderCof({ ...NEXT, fileDate: WMM_FILE_DATE, rows: WMM_COEFFICIENTS })
/** A line of a row with the last digit of its second number (h) one more: a coefficient a digit off. */
const bumped = (line: string) => line.replace(/^(\s*\d+\s+\d+\s+-?\d+\.\d\s+-?\d+\.)(\d)/, (_, head: string, digit: string) => `${head}${(Number(digit) + 1) % 10}`)

Deno.test('the shipped rows render to NOAA\'s layout and parse back to the same rows, negative zeros and all', () => {
  const parsed = parseCof(COF)
  assertEquals([parsed.epoch, parsed.modelName, parsed.fileDate], [WMM_EPOCH, WMM_MODEL_NAME, WMM_FILE_DATE])
  assertEquals(parsed.rows.length, COF_ROWS)
  parsed.rows.forEach((row: number[], i: number) => {
    WMM_COEFFICIENTS[i].forEach((value, k) => assert(Object.is(value, row[k]), `row ${i + 1}, column ${k}: ${row[k]} against ${value}`))
  })
  // The file has negative zeros ("-0.0" rates); a parser that lost the sign would still look right and fail the hash.
  assert(parsed.rows.flat().filter((v: number) => Object.is(v, -0)).length >= 20)
  assertEquals(renderCof(parsed), COF)
  assertEquals(sha256Hex(bytes(COF)), WMM_SOURCE_SHA256)
  // WMM2025 only: the layout itself, from the first lines of NOAA's file.
  assertEquals(lines()[0], '    2025.0            WMM-2025     11/13/2024')
  assertEquals(lines()[1], '  1  0  -29351.8       0.0       12.0        0.0')
  assertEquals(lines()[2], '  1  1   -1410.8    4545.4        9.7      -21.5')
  assertEquals(lines().slice(-3), ['9'.repeat(48), '9'.repeat(48), ''])
})

Deno.test('a file that is not exactly that layout is refused, naming what is wrong', () => {
  const edit = (change: (l: string[]) => string[]) => change(lines()).join('\n')
  const refused: Array<[string, string, RegExp]> = [
    ['Windows line endings', COF.replace(/\n/g, '\r\n'), /CR characters/],
    ['no final newline', COF.slice(0, -1), /does not end with a newline/],
    ['an empty file', '', /line 1 is not a WMM header/],
    ['a dropped row', edit((l) => l.filter((_, i) => i !== 40)), /line 41 is row \(\d+, \d+\) where \(\d+, \d+\) belongs/],
    ['rows out of order', edit((l) => { [l[5], l[6]] = [l[6], l[5]]; return l }), /line 6 is row \(3, 0\) where \(2, 2\) belongs/],
    ['an extra row', edit((l) => [...l.slice(0, 91), l[90], ...l.slice(91)]), /two lines of 48 nines/],
    ['one terminator', edit((l) => l.filter((_, i) => i !== 92)), /two lines of 48 nines/],
    ['a short terminator', edit((l) => l.map((x, i) => (i === 92 ? '9'.repeat(47) : x))), /two lines of 48 nines/],
    ['no header', edit((l) => l.slice(1)), /line 1 is not a WMM header/],
    ['a header that is not a header', edit((l) => ['WMM 2025', ...l.slice(1)]), /line 1 is not a WMM header/],
    ['a model and an epoch that disagree', edit((l) => [`${WMM_EPOCH.toFixed(1).padStart(10)}${NEXT.modelName.padStart(20)}${WMM_FILE_DATE.padStart(15)}`, ...l.slice(1)]), new RegExp(`names ${NEXT.modelName} but its epoch is ${WMM_EPOCH}\\.0`)],
    ['a value that is not a number', edit((l) => { l[11] = l[11].replace(/\d\.\d/, 'x.x'); return l }), /line 12 is not a coefficient row/],
    ['two decimals', edit((l) => { l[3] = l[3].replace(/(-?\d+\.\d)/, '$10'); return l }), /line 4 is not a coefficient row/],
    ['an h term on a zonal row', edit((l) => { l[1] = l[1].replace(/^(\s*\d+\s+0\s+-?\d+\.\d\s+)0\.0/, '$11.0'); return l }), /line 2: a zonal row \(m = 0\) has no h term/],
    ['a column that has drifted', edit((l) => { l[7] = l[7].replace(/^( *\d+ +\d+ +-?\d+\.\d)/, '$1 '); return l }), /fixed-width layout \(line 8\)/],
    ['an indent where NOAA has none', edit((l) => l.map((x, i) => (i === 9 ? ` ${x}` : x))), /fixed-width layout \(line 10\)/],
    ['trailing space', edit((l) => l.map((x, i) => (i === 7 ? `${x} ` : x))), /line 8 is not a coefficient row/],
  ]
  for (const [what, text, message] of refused) {
    const error = assertThrows(() => parseCof(text), Error, '', what)
    assertMatch(error.message, message, what)
  }
  assertThrows(() => parseCof(undefined as unknown as string), Error, 'as text')
})

/** The shipped file in the other shapes a download may come in: every one is the same model and the same numbers. */
function shapes(): Array<[string, string]> {
  const spaced = lines().map((line, i) => (i >= 1 && i <= COF_ROWS ? line.trim().split(/\s+/).join(i % 2 ? ' ' : '\t') : line))
  return [
    ['LF, as NOAA writes it', COF],
    ['Windows line endings', COF.replace(/\n/g, '\r\n')],
    ['old Mac line endings', COF.replace(/\n/g, '\r')],
    ['a byte-order mark', `\uFEFF${COF}`],
    ['blank lines at the end and the start', `\n\n${COF}\n\n`],
    ['no final newline', COF.slice(0, -1)],
    ['trailing spaces', lines().map((line) => (line ? `${line}   ` : line)).join('\n')],
    ['single spaces and tabs for the columns', spaced.join('\n')],
    ['one line of nines of another length', COF.replace(`${'9'.repeat(48)}\n${'9'.repeat(48)}\n`, `${'9'.repeat(10)}\n`)],
    ['more decimals', lines().map((line, i) => (i === 1 ? line.replace(/(-?\d+\.\d)/, '$10') : line)).join('\n')],
    ['a -0.0 printed as 0.0', COF.replace('-0.0', ' 0.0')],
  ]
}

Deno.test('the loose reader gives the same rows from the file in any of the shapes a download comes in', () => {
  for (const [what, text] of shapes()) {
    const parsed = parseCofLoose(text)
    assertEquals([parsed.epoch, parsed.modelName, parsed.fileDate], [WMM_EPOCH, WMM_MODEL_NAME, WMM_FILE_DATE], what)
    assertEquals(parsed.rows.length, COF_ROWS, what)
    // `===`, not Object.is: a -0.0 and a 0.0 are the same coefficient.
    parsed.rows.forEach((row: number[], i: number) => WMM_COEFFICIENTS[i].forEach((value, k) => assert(value === row[k], `${what}: row ${i + 1}, column ${k}: ${row[k]} against ${value}`)))
  }
  // The reader that writing uses stays strict: it takes NOAA's layout, in which a -0.0 may be printed either way, and no other shape.
  const strictAccepts = shapes().filter(([, text]) => { try { parseCof(text); return true } catch { return false } }).map(([what]) => what)
  assertEquals(strictAccepts, ['LF, as NOAA writes it', 'a -0.0 printed as 0.0'])
})

Deno.test('the loose reader still refuses what is not the model, naming the line', () => {
  const edit = (change: (l: string[]) => string[]) => change(lines()).join('\n')
  const refused: Array<[string, string, RegExp]> = [
    ['an empty file', '', /line 1 is not a WMM header/],
    ['a header that is not a header', edit((l) => ['WMM 2025', ...l.slice(1)]), /line 1 is not a WMM header/],
    ['a model and an epoch that disagree', edit((l) => [`${WMM_EPOCH.toFixed(1).padStart(10)}${NEXT.modelName.padStart(20)}${WMM_FILE_DATE.padStart(15)}`, ...l.slice(1)]), new RegExp(`names ${NEXT.modelName} but its epoch is ${WMM_EPOCH}\\.0`)],
    ['a dropped row', edit((l) => l.filter((_, i) => i !== 40)), /line 41 is row \(\d+, \d+\) where \(\d+, \d+\) belongs/],
    ['rows out of order', edit((l) => { [l[5], l[6]] = [l[6], l[5]]; return l }), /line 6 is row \(3, 0\) where \(2, 2\) belongs/],
    ['a file that stops in the rows', lines().slice(0, 50).join('\n'), /the file ends before row \(\d+, \d+\)/],
    ['a value that is not a number', edit((l) => { l[11] = l[11].replace(/\d\.\d/, 'x.x'); return l }), /line 12 is not a coefficient row/],
    ['an h term on a zonal row', edit((l) => { l[1] = l[1].replace(/^(\s*\d+\s+0\s+-?\d+\.\d\s+)0\.0/, '$11.0'); return l }), /line 2: a zonal row \(m = 0\) has no h term/],
    ['no terminator', lines().slice(0, 91).join('\n'), /must end with a line of nines/],
    ['a row after the 90th', edit((l) => [...l.slice(0, 91), l[90], ...l.slice(91)]), /must end with a line of nines/],
    ['something after the terminator', `${COF}more\n`, /must end with a line of nines/],
  ]
  for (const [what, text, message] of refused) {
    const error = assertThrows(() => parseCofLoose(text), Error, '', what)
    assertMatch(error.message, message, what)
  }
  assertThrows(() => parseCofLoose(undefined as unknown as string), Error, 'as text')
  // A line number is the line of the original file, blank lines included.
  assertMatch(assertThrows(() => parseCofLoose(`\n\n${edit((l) => { l[11] = l[11].replace(/\d\.\d/, 'x.x'); return l })}`), Error).message, /line 14 is not a coefficient row/)
})

Deno.test('the module it writes is the same bytes every time, and says where the numbers came from, which model, and the NOAA notice', () => {
  const cof = parseCof(COF)
  const make = (origin: string | null) => renderModule({ cof, sha256: WMM_SOURCE_SHA256, origin })
  assertEquals(make('a mirror'), make('a mirror'))
  assertNotEquals(make('a mirror'), make('another'))
  const source = make('a copy of the file from a mirror, which is not NOAA\'s own download')
  assert(source.includes(`export const WMM_SOURCE_SHA256 = '${WMM_SOURCE_SHA256}'`))
  assert(source.includes(`export const WMM_EPOCH = ${WMM_EPOCH}\n`) && source.includes(`export const WMM_VALID_UNTIL = ${WMM_VALID_UNTIL}\n`))
  assert(source.includes(`export const WMM_MODEL_NAME = '${WMM_MODEL_NAME}'`) && source.includes(`export const WMM_FILE_DATE = '${WMM_FILE_DATE}'`))
  assert(!source.includes('RELEASE_DATE'), 'the file date is not called a release date')
  assert(source.includes('Where the file came from: a copy of the file from a mirror'))
  assert(!make(null).includes('Where the file came from'))
  // WMM2025 only:
  assert(source.includes('Valid from 2025.0 to 2030.0') && source.includes('From 2030-01-01 on a date is outside the model'))
  assert(source.includes('from a file dated 11/13/2024 (the date on the file\'s header line, which is not the date NOAA released the model)'))
  // The notice runs over several lines of the header: read as words.
  const header = source.split('*/')[0].replace(/^\s*\/?\*+\/?/gm, '').replace(/\s+/g, ' ')
  assert(header.includes('17 U.S.C. 403') && header.includes('public domain') && header.includes('not subject to copyright protection'))
  assert(header.includes('consist predominantly of') && header.includes('as 17 U.S.C. 403 requires') && header.includes('https://www.ncei.noaa.gov/products/world-magnetic-model'))
  assertEquals(rowsOfModule(source)?.length, 90)
  assertEquals(source.split('\n').filter((l) => /^ {2}\[\d+, \d+, /.test(l)).length, 90)
  // A long origin wraps inside the header comment and breaks nothing.
  const wrapped = make('word '.repeat(80))
  const originLines = wrapped.split('\n').filter((l) => l.includes('word'))
  assert(originLines.length > 3 && originLines.every((l) => l.length <= 110), 'a long origin wraps over several lines of the header')
  assertEquals(rowsOfModule(wrapped)?.length, 90)
})

Deno.test('an origin that would end the header comment is refused: its text would otherwise run as code', () => {
  const cof = parseCof(COF)
  for (const origin of ['copy from https://example.org/a/*/WMM.COF by hand', '*/ export const WMM_EPOCH = 1999 /*', 'a */']) {
    const error = assertThrows(() => renderModule({ cof, sha256: WMM_SOURCE_SHA256, origin }), Error, "'*/'", origin)
    assertMatch(error.message, /--origin cannot contain/)
  }
  // The same words with the star left out are fine, and so is a star on its own.
  const source = renderModule({ cof, sha256: WMM_SOURCE_SHA256, origin: 'copy from https://example.org/a/WMM.COF, a * b, and a / b' })
  assert(source.includes('copy from https://example.org/a/WMM.COF, a * b, and a / b'))
  assert(source.slice(0, source.indexOf('*/')).includes('Browser-safe on purpose'), 'the header comment runs to its last line, so the origin did not end it')
})

Deno.test('rowsOfModule and modelOfModule read a module back, and say no when it is not one', () => {
  const source = renderModule({ cof: parseCof(COF), sha256: WMM_SOURCE_SHA256, origin: null })
  const rows = rowsOfModule(source)
  assert(rows !== null)
  assertEquals(rows.length, 90)
  assertEquals(rows[0], [1, 0, -29351.8, 0, 12, 0])
  assertEquals(rowsOfModule(source.replace('  [1, 0, -29351.8, 0.0, 12.0, 0.0],\n', '')), null)
  assertEquals(modelOfModule(source), { modelName: WMM_MODEL_NAME, epoch: WMM_EPOCH })
  assertEquals(modelOfModule(source.replace(/^export const WMM_EPOCH = .*$/m, '')), null)
  assertEquals(modelOfModule(source.replace(/^export const WMM_MODEL_NAME = .*$/m, '')), null)
  assertEquals(modelOfModule('export const nothing = 1\n'), null)
})

Deno.test('the committed module is the generator\'s output: its code is exactly what renderModule writes for these rows', () => {
  const committed = Deno.readTextFileSync(repo(`src/world/wmm${WMM_MODEL_NAME.slice(-4)}-coefficients.ts`))
  const fresh = renderModule({ cof: parseCof(COF), sha256: WMM_SOURCE_SHA256, origin: null })
  // Only the header comment has the origin text; everything after it is code, and must not have been edited by hand.
  const code = (text: string) => text.slice(text.indexOf('*/') + 2)
  assertEquals(code(committed), code(fresh))
  assert(committed.includes('Where the file came from:'), 'the committed header says where the file came from')
  assertEquals(rowsOfModule(committed)?.length, 90)
  assertEquals(modelOfModule(committed), { modelName: WMM_MODEL_NAME, epoch: WMM_EPOCH })
})

/** Runs the generator under Deno's own Node layer, so it needs no Node on the machine. */
function generator(args: string[]): { code: number; stdout: string; stderr: string } {
  const out = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-read', '--allow-write', repo('scripts/gen-wmm-coefficients.mjs'), ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync()
  const text = (b: Uint8Array) => new TextDecoder().decode(b)
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) }
}

Deno.test('the command line writes the module, and --check says whether a file has the rows the repository has', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'wmm-gen-' })
  try {
    const cof = `${dir}/WMM.COF`
    const out = `${dir}/${MODULE_NAME}`
    Deno.writeTextFileSync(cof, COF)

    const written = generator([cof, '--out', out, '--origin', 'a test file'])
    assertEquals(written.code, 0, written.stderr)
    assertMatch(written.stdout, new RegExp(`${WMM_MODEL_NAME} epoch ${WMM_EPOCH}\\.0: 90 rows`))
    const wanted = renderModule({ cof: parseCof(COF), sha256: sha256Hex(bytes(COF)), origin: 'a test file' })
    assertEquals(Deno.readTextFileSync(out), wanted)

    // The same file again: identical model, rows and bytes.
    const same = generator([cof, '--out', out, '--check'])
    assertEquals(same.code, 0, same.stderr)
    assertMatch(same.stdout, /model identical to/)
    assertMatch(same.stdout, /rows identical to/)
    assertMatch(same.stdout, /file bytes identical to the file the module records/)

    // A file whose bytes differ but whose rows are the same (here a different file date): the rows still match, and
    // the report says the bytes do not, which is what NOAA's own download may turn out to be.
    const other = `${dir}/other.COF`
    Deno.writeTextFileSync(other, COF.replace(WMM_FILE_DATE, '12/17/2024'))
    const bytesDiffer = generator([other, '--out', out, '--check'])
    assertEquals(bytesDiffer.code, 0, bytesDiffer.stderr)
    assertMatch(bytesDiffer.stdout, /rows identical to/)
    assertMatch(bytesDiffer.stdout, /file bytes differ from the file the module records/)

    // One coefficient a digit off: exit 1, and it names the row.
    const wrong = lines().map((line, i) => (i === 2 ? bumped(line) : line)).join('\n')
    assertNotEquals(wrong, COF)
    Deno.writeTextFileSync(other, wrong)
    const differs = generator([other, '--out', out, '--check'])
    assertEquals(differs.code, 1)
    assertMatch(differs.stdout, /rows DIFFER \(1, first at n=1 m=1\)/)
    // --check never writes.
    assertEquals(Deno.readTextFileSync(out), wanted)
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('--check reads the file however it was saved: Windows line endings, a byte-order mark, other widths, a -0.0 printed as 0.0', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'wmm-gen-' })
  try {
    const cof = `${dir}/WMM.COF`
    const out = `${dir}/${MODULE_NAME}`
    Deno.writeTextFileSync(cof, COF)
    assertEquals(generator([cof, '--out', out]).code, 0)
    const other = `${dir}/other.COF`
    // Each shape is read in-process by the test above; these go through the command line, the way someone checks a download.
    const viaCommandLine = ['LF, as NOAA writes it', 'Windows line endings', 'a byte-order mark', 'blank lines at the end and the start',
      'single spaces and tabs for the columns', 'a -0.0 printed as 0.0']
    for (const [what, text] of shapes().filter(([name]) => viaCommandLine.includes(name))) {
      Deno.writeTextFileSync(other, text)
      const ran = generator([other, '--out', out, '--check'])
      assertEquals(ran.code, 0, `${what}: ${ran.stderr}${ran.stdout}`)
      assertMatch(ran.stdout, /rows identical to/, what)
      assertMatch(ran.stdout, new RegExp(`file bytes ${text === COF ? 'identical to' : 'differ from'} the file the module records`), what)
    }
    // A real difference in a file of one of those shapes is still a difference.
    Deno.writeTextFileSync(other, lines().map((line, i) => (i === 34 ? bumped(line) : line)).join('\r\n'))
    const differs = generator([other, '--out', out, '--check'])
    assertEquals(differs.code, 1, differs.stderr)
    assertMatch(differs.stdout, /rows DIFFER \(1, first at n=7 m=6\)/)
    // A file of the same rows that says it is another model is another model: exit 1, with the module's model named.
    Deno.writeTextFileSync(other, COF_OF_NEXT)
    const otherModel = generator([other, '--out', out, '--check'])
    assertEquals(otherModel.code, 1, otherModel.stderr)
    assertMatch(otherModel.stdout, new RegExp(`model DIFFERS \\(the module holds ${WMM_MODEL_NAME}, epoch ${WMM_EPOCH}\\.0\\)`))
    assertMatch(otherModel.stdout, /rows identical to/)
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('the command line says why it cannot answer, with exit 2 and nothing written: a bad file, a missing file or module, a bad option, a bad origin', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'wmm-gen-' })
  try {
    const cof = `${dir}/WMM.COF`
    const out = `${dir}/${MODULE_NAME}`
    Deno.writeTextFileSync(cof, COF)
    assertEquals(generator([cof, '--out', out]).code, 0)
    const before = Deno.readTextFileSync(out)
    const refused = (args: string[], message: RegExp, what: string) => {
      const ran = generator(args)
      assertEquals(ran.code, 2, `${what}: ${ran.stdout}${ran.stderr}`)
      assertMatch(ran.stderr, message, what)
      assertEquals(ran.stdout.includes('DIFFER'), false, `${what}: a refusal is not a difference`)
    }
    refused([`${dir}/missing.COF`], /ENOENT|no such file|os error 2/i, 'a file that is not there')
    refused([cof, '--bogus'], /unknown option --bogus/, 'an unknown option')
    refused([], /usage: node scripts\/gen-wmm-coefficients\.mjs/, 'no file')
    refused([cof, '--origin'], /--origin needs a value/, 'an option with no value')
    refused([cof, 'two.COF'], /one input file only/, 'two files')
    const bad = `${dir}/bad.COF`
    Deno.writeTextFileSync(bad, lines().map((line, i) => (i === 2 ? line.replace(/(-?\d+\.\d)/, '$1x') : line)).join('\n'))
    refused([bad, '--out', out, '--check'], /line 3 is not a coefficient row/, 'a file that is not a coefficient file, checked')
    refused([bad, '--out', `${dir}/never.ts`], /line 3 is not a coefficient row/, 'the same, written')
    Deno.writeTextFileSync(bad, COF.replace(/\n/g, '\r\n'))
    refused([bad, '--out', `${dir}/never.ts`], /CR characters/, 'Windows line endings, written: the hash must be that of the text parsed')
    refused([cof, '--out', `${dir}/never.ts`, '--origin', 'see https://example.org/*/WMM.COF'], /--origin cannot contain '\*\/'/, 'an origin that ends the comment')
    refused([cof, '--out', `${dir}/missing-module.ts`, '--check'], /missing-module\.ts does not exist: nothing to check against/, 'a module that is not there')
    Deno.writeTextFileSync(`${dir}/not-a-module.ts`, 'export const nothing = 1\n')
    refused([cof, '--out', `${dir}/not-a-module.ts`, '--check'], /is not a generated coefficient module/, 'a module that is not one')
    // Without --out a check looks for the module named after the file's model, in this repository: a model with none says so.
    Deno.writeTextFileSync(bad, renderCof({ epoch: 2099, modelName: 'WMM-2099', fileDate: WMM_FILE_DATE, rows: WMM_COEFFICIENTS }))
    refused([bad, '--check'], /wmm2099-coefficients\.ts does not exist: nothing to check against/, 'a model with no module')
    assertEquals(Deno.readTextFileSync(out), before)
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), ['WMM.COF', 'bad.COF', 'not-a-module.ts', MODULE_NAME])
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})
