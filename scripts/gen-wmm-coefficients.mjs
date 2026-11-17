#!/usr/bin/env node
/**
 * Generates src/world/wmm<year>-coefficients.ts from a World Magnetic Model coefficient file (WMM.COF).
 *
 *   node scripts/gen-wmm-coefficients.mjs <WMM.COF> [--out <file>] [--origin <text>]
 *   node scripts/gen-wmm-coefficients.mjs <WMM.COF> --check [--out <module>]
 *
 * The generated module holds the 90 rows (degree and order 12: n = 1..12, m = 0..n, each with g, h and
 * their annual rates), the model's epoch and validity, and the SHA-256 of the file they came from, so
 * a reader can tell which file the numbers are. Nothing is downloaded: the file is an argument.
 * NOAA's own download sits behind a survey page, so the file that was used may be a copy of it. Say
 * where it came from with --origin; its words go into the generated header as they are (the line breaks
 * are the header's), and it may not contain the characters that end a comment.
 *
 * Writing takes only the fixed-width layout NOAA's file has, with LF line endings, and refuses anything
 * else. Parsing and rendering are exact inverses: `renderCof(parseCof(text)) === text` for every text it
 * accepts, which is what lets tests/unit/deno/declination.test.ts rebuild the source file from the rows in
 * the repository and check its SHA-256 against the one recorded here. A claim that the table is that file
 * is then a measurement, not a comment.
 *
 * `--check` compares the rows of a file with the module already in the repository (the one named after
 * the file's model, or the one `--out` names) and exits 0 when they are the same model and the same
 * numbers, whatever the bytes of the file were: Windows line endings, a byte-order mark, other column
 * widths, blank lines, and a `-0.0` where this repository has `0.0` are all read as the same rows (the
 * report says whether the bytes are the file the module records). Use it on NOAA's own download to
 * settle whether the table here is NOAA's table. It writes nothing.
 *
 * Exit status: 0 done (with --check: the same model and rows); 1 with --check only: they differ; 2 the
 * command could not give an answer (a file that is not a WMM coefficient file, a missing file, a bad
 * option), with the reason on stderr.
 *
 * To move to a new model (WMM2030 is due before 2030-01-01): see the header of src/world/declination.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Rows in a WMM coefficient file: degree and order 12, n = 1..12 and m = 0..n, 2 + 3 + ... + 13. */
export const COF_ROWS = 90
/** The highest degree and order the model carries. */
export const COF_MAX_DEGREE = 12
/**
 * Years a WMM release is valid for from its epoch: NOAA publishes each model for 2025.0 to 2030.0 and
 * says WMM2025 "expires on December 31, 2029" (https://www.ncei.noaa.gov/products/world-magnetic-model).
 * The file itself does not say. Adopted from NOAA's statement, not measured (ADR 0005 rule 5).
 */
export const MODEL_VALID_YEARS = 5

const TERMINATOR = '9'.repeat(48)

/** One number as the file writes it: one decimal, and a minus sign on a negative zero as well. */
const fixed = (value) => (Object.is(value, -0) ? '-0.0' : value.toFixed(1))

/**
 * The text of a coefficient file for these rows, in NOAA's layout: a header line, one fixed-width line
 * per row, and two lines of nines to end. `rows` are [n, m, g, h, gDot, hDot]. `fileDate` is the date on
 * the file's header line (mm/dd/yyyy): the file's own date, which is not the date NOAA released the model.
 */
export function renderCof({ epoch, modelName, fileDate, rows }) {
  const lines = [`${epoch.toFixed(1).padStart(10)}${modelName.padStart(20)}${fileDate.padStart(15)}`]
  for (const [n, m, g, h, gDot, hDot] of rows) {
    lines.push(
      `${String(n).padStart(3)}${String(m).padStart(3)}${fixed(g).padStart(10)}${fixed(h).padStart(10)}${fixed(gDot).padStart(11)}${fixed(hDot).padStart(11)}`,
    )
  }
  lines.push(TERMINATOR, TERMINATOR)
  return `${lines.join('\n')}\n`
}

const HEADER = /^ *(\d{4}\.0) +(WMM-(\d{4})) +(\d{2}\/\d{2}\/\d{4})$/
const DATA = /^ *(\d+) +(\d+) +(-?\d+\.\d) +(-?\d+\.\d) +(-?\d+\.\d) +(-?\d+\.\d)$/

/**
 * Reads a coefficient file's text. Throws, naming the line, unless it is exactly what `renderCof`
 * writes for the rows it holds: header, the 90 rows in order, two terminator lines, LF endings.
 * Returns { epoch, modelName, fileDate, rows }.
 */
export function parseCof(text) {
  if (typeof text !== 'string') throw new Error('the coefficient file must be read as text')
  if (text.includes('\r')) {
    throw new Error('the file has CR characters (Windows line endings). Convert it to LF and say so in --origin: the recorded SHA-256 must be that of the text that was parsed')
  }
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('the file does not end with a newline')
  lines.pop()
  const header = HEADER.exec(lines[0] ?? '')
  if (!header) throw new Error(`line 1 is not a WMM header such as "    2025.0            WMM-2025     11/13/2024": ${JSON.stringify(lines[0])}`)
  const epoch = Number(header[1])
  if (Number(header[3]) !== epoch) throw new Error(`line 1 names ${header[2]} but its epoch is ${header[1]}`)
  const rows = []
  let at = 1
  for (let n = 1; n <= COF_MAX_DEGREE; n++) {
    for (let m = 0; m <= n; m++, at++) {
      const found = DATA.exec(lines[at] ?? '')
      if (!found) throw new Error(`line ${at + 1} is not a coefficient row: ${JSON.stringify(lines[at])}`)
      const [fileN, fileM, g, h, gDot, hDot] = found.slice(1).map(Number)
      if (fileN !== n || fileM !== m) throw new Error(`line ${at + 1} is row (${fileN}, ${fileM}) where (${n}, ${m}) belongs`)
      if (m === 0 && (h !== 0 || hDot !== 0)) throw new Error(`line ${at + 1}: a zonal row (m = 0) has no h term, but this one has h = ${h}, hDot = ${hDot}`)
      // Number() reads "-0.0" as -0 and "0.0" as 0, so the sign of a negative zero survives.
      rows.push([n, m, g, h, gDot, hDot])
    }
  }
  if (rows.length !== COF_ROWS) throw new Error(`expected ${COF_ROWS} rows, read ${rows.length}`)
  if (lines.slice(at).join('\n') !== `${TERMINATOR}\n${TERMINATOR}`) {
    throw new Error(`after row ${COF_ROWS} the file must end with two lines of 48 nines; it has: ${JSON.stringify(lines.slice(at))}`)
  }
  const parsed = { epoch, modelName: header[2], fileDate: header[4], rows }
  const again = renderCof(parsed)
  if (again !== text) {
    const expected = again.split('\n')
    const first = expected.findIndex((line, i) => line !== lines[i])
    throw new Error(`the file is not in NOAA's fixed-width layout (line ${first + 1}): ${JSON.stringify(lines[first])}, expected ${JSON.stringify(expected[first])}`)
  }
  return parsed
}

const LOOSE_HEADER = /^(\d{4}\.0)\s+(WMM-(\d{4}))\s+(\d{2}\/\d{2}\/\d{4})$/
const LOOSE_ROW = /^(\d+)\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)$/

/**
 * Reads a coefficient file's model and rows without insisting on NOAA's layout, for `--check`, which compares
 * numbers: any line endings (LF, CRLF or CR), a byte-order mark, any indent and column widths, trailing
 * spaces, blank lines. It insists on what makes the file the model: the header, rows 1..12 by 0..n in order
 * with no h term on a zonal row, and at least one terminator line of nines after them. Throws, naming the
 * line, when it is not that. Returns { epoch, modelName, fileDate, rows }; a `-0.0` reads as -0, which
 * `===` takes for 0.
 */
export function parseCofLoose(text) {
  if (typeof text !== 'string') throw new Error('the coefficient file must be read as text')
  // trim() also drops a byte-order mark (U+FEFF is white space to JavaScript), so one at the start of the file is no part of the header.
  const lines = text.split(/\r\n|\n|\r/)
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => line !== '')
  const header = LOOSE_HEADER.exec(lines[0]?.[1] ?? '')
  if (!header) throw new Error(`line ${lines[0]?.[0] ?? 1} is not a WMM header such as "2025.0 WMM-2025 11/13/2024": ${JSON.stringify(lines[0]?.[1])}`)
  const epoch = Number(header[1])
  if (Number(header[3]) !== epoch) throw new Error(`line ${lines[0][0]} names ${header[2]} but its epoch is ${header[1]}`)
  const rows = []
  let at = 1
  for (let n = 1; n <= COF_MAX_DEGREE; n++) {
    for (let m = 0; m <= n; m++, at++) {
      if (at >= lines.length) throw new Error(`the file ends before row (${n}, ${m}): it has ${lines.length - 1} lines after the header`)
      const [lineNumber, line] = lines[at]
      const found = LOOSE_ROW.exec(line)
      if (!found) throw new Error(`line ${lineNumber} is not a coefficient row: ${JSON.stringify(line)}`)
      const [fileN, fileM, g, h, gDot, hDot] = found.slice(1).map(Number)
      if (fileN !== n || fileM !== m) throw new Error(`line ${lineNumber} is row (${fileN}, ${fileM}) where (${n}, ${m}) belongs`)
      if (m === 0 && (h !== 0 || hDot !== 0)) throw new Error(`line ${lineNumber}: a zonal row (m = 0) has no h term, but this one has h = ${h}, hDot = ${hDot}`)
      rows.push([n, m, g, h, gDot, hDot])
    }
  }
  const rest = lines.slice(at)
  if (rest.length === 0 || !rest.every(([, line]) => /^9+$/.test(line))) {
    throw new Error(`after row ${COF_ROWS} the file must end with a line of nines; it has: ${JSON.stringify(rest.map(([, line]) => line))}`)
  }
  return { epoch, modelName: header[2], fileDate: header[4], rows }
}

/** Lowercase hex SHA-256 of the bytes. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * What the generated module's header says about where the file came from, wrapped to the header's width.
 * The text goes into a block comment, so it may not hold the characters that end one.
 */
function originLines(origin) {
  if (!origin) return []
  if (origin.includes('*/')) {
    throw new Error("--origin cannot contain '*/': the text goes into the header comment of the generated module, and that would end the comment. Leave the star out, or name the folder instead of a pattern")
  }
  const lines = []
  let line = ' * Where the file came from:'
  for (const word of origin.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > 104) {
      lines.push(line)
      line = ` *   ${word}`
    } else line += ` ${word}`
  }
  lines.push(line)
  return lines
}

/**
 * The TypeScript source of the generated module. Deterministic: the same file and origin give the same
 * bytes, so a regeneration that changes nothing leaves no diff.
 */
export function renderModule({ cof, sha256, origin }) {
  const year = cof.modelName.slice(-4)
  const validUntil = cof.epoch + MODEL_VALID_YEARS
  const rowLines = cof.rows.map(
    ([n, m, g, h, gDot, hDot]) => `  [${n}, ${m}, ${fixed(g)}, ${fixed(h)}, ${fixed(gDot)}, ${fixed(hDot)}],`,
  )
  return [
    '/**',
    ' * GENERATED by scripts/gen-wmm-coefficients.mjs. Do not edit by hand: run the generator again.',
    ' *',
    ` * World Magnetic Model ${cof.modelName}: the ${cof.rows.length} coefficient rows (degree and order ${COF_MAX_DEGREE}, n = 1..${COF_MAX_DEGREE}, m = 0..n), epoch ${cof.epoch.toFixed(1)},`,
    ` * from a file dated ${cof.fileDate} (the date on the file's header line, which is not the date NOAA released the model).`,
    ` * Valid from ${cof.epoch.toFixed(1)} to ${validUntil.toFixed(1)}: a WMM is valid for five years from its epoch, and NOAA's page for the model gives the`,
    ` * date it expires. From ${validUntil}-01-01 on a date is outside the model, and src/world/declination.ts refuses it.`,
    ' *',
    ` * SHA-256 of the coefficient file these rows were read from: ${sha256}`,
    ...originLines(origin),
    ' * The rows render back to that file byte for byte (renderCof in the generator); the declination test',
    ' * does so and compares the hash, so the table cannot drift from the file without a test failing.',
    ' *',
    ' * Notice (17 U.S.C. 403): Companion Scan includes the coefficients of the World Magnetic Model, which the U.S.',
    " * National Geospatial-Intelligence Agency and the U.K. Defence Geographic Centre produce and NOAA's National Centers",
    ' * for Environmental Information (NCEI) distributes. NCEI says the WMM source code is in the public domain and not',
    ' * licensed or under copyright, and that, as 17 U.S.C. 403 requires, third parties whose copyrighted works consist',
    " * predominantly of the model's U.S. Government material must give notice that identifies that material and states",
    ' * that it is not subject to copyright protection. This is that notice, given for these coefficients whatever their',
    ' * share of the work: they are U.S. Government material and are not subject to copyright protection.',
    ' * Source: https://www.ncei.noaa.gov/products/world-magnetic-model',
    ' *',
    ' * Browser-safe on purpose (ADR 0002): data only, no Deno or DOM references.',
    ' */',
    '',
    '/** One coefficient row: degree n, order m, then g and h in nT at the epoch and their rates gDot and hDot in nT per year. */',
    'export type WmmCoefficientRow = readonly [n: number, m: number, g: number, h: number, gDot: number, hDot: number]',
    '',
    `export const WMM_MODEL_NAME = '${cof.modelName}'`,
    "/** The date on the coefficient file's header line, mm/dd/yyyy: the file's own date, not the date NOAA released the model. */",
    `export const WMM_FILE_DATE = '${cof.fileDate}'`,
    '/** The decimal year the g and h values are for; the rates apply from here. */',
    `export const WMM_EPOCH = ${cof.epoch}`,
    '/** The first decimal year the model is not valid for. */',
    `export const WMM_VALID_UNTIL = ${validUntil}`,
    '/** SHA-256 of the coefficient file the rows were read from, lowercase hex. */',
    `export const WMM_SOURCE_SHA256 = '${sha256}'`,
    '',
    `const ROWS: WmmCoefficientRow[] = [`,
    ...rowLines,
    ']',
    'for (const row of ROWS) Object.freeze(row)',
    '',
    `/** The ${year} coefficients, frozen: no caller can change what every later call reads. */`,
    'export const WMM_COEFFICIENTS: readonly WmmCoefficientRow[] = Object.freeze(ROWS)',
    '',
  ].join('\n')
}

/** The rows of a generated module, read back from its text, or null when there are not 90 of them. */
export function rowsOfModule(source) {
  const rows = [...source.matchAll(/^ {2}\[(\d+), (\d+), (-?\d+\.\d), (-?\d+\.\d), (-?\d+\.\d), (-?\d+\.\d)\],$/gm)].map((found) => found.slice(1).map(Number))
  return rows.length === COF_ROWS ? rows : null
}

/** The model name and epoch a generated module declares, or null when it declares neither. */
export function modelOfModule(source) {
  const modelName = /^export const WMM_MODEL_NAME = '([^']+)'$/m.exec(source)?.[1]
  const epoch = /^export const WMM_EPOCH = (\d+(?:\.\d+)?)$/m.exec(source)?.[1]
  return modelName && epoch ? { modelName, epoch: Number(epoch) } : null
}

function usage() {
  return 'usage: node scripts/gen-wmm-coefficients.mjs <WMM.COF> [--out <file>] [--origin <text>] | <WMM.COF> --check [--out <module>]'
}

function parseArgs(argv) {
  const args = { input: null, out: null, origin: null, check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') args.check = true
    else if (arg === '--out' || arg === '--origin') {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value\n${usage()}`)
      args[arg.slice(2)] = value
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${usage()}`)
    else if (args.input === null) args.input = arg
    else throw new Error(`one input file only\n${usage()}`)
  }
  if (args.input === null) throw new Error(usage())
  return args
}

/** The module a model's coefficients are written to, unless --out says otherwise. */
function moduleFor(modelName) {
  return join(root, 'src', 'world', `wmm${modelName.slice(-4)}-coefficients.ts`)
}

function check(args, bytes) {
  const cof = parseCofLoose(bytes.toString('utf8'))
  const out = resolve(args.out ?? moduleFor(cof.modelName))
  if (!existsSync(out)) throw new Error(`${out} does not exist: nothing to check against`)
  const existing = readFileSync(out, 'utf8')
  const existingRows = rowsOfModule(existing)
  const existingModel = modelOfModule(existing)
  if (!existingRows || !existingModel) throw new Error(`${out} is not a generated coefficient module: it does not hold ${COF_ROWS} rows and a model name and epoch`)
  const sameModel = existingModel.modelName === cof.modelName && existingModel.epoch === cof.epoch
  // `!==` on numbers: a -0.0 and a 0.0 are the same coefficient.
  const different = cof.rows.filter((row, i) => row.some((value, k) => value !== existingRows[i][k]))
  const sha256 = sha256Hex(bytes)
  const sameBytes = existing.includes(`'${sha256}'`)
  console.log(`[wmm] ${args.input}: ${cof.rows.length} rows, ${cof.modelName} (epoch ${cof.epoch.toFixed(1)}), SHA-256 ${sha256}`)
  console.log(`[wmm] model ${sameModel ? 'identical to' : `DIFFERS (the module holds ${existingModel.modelName}, epoch ${existingModel.epoch.toFixed(1)}) from`} ${out}`)
  console.log(`[wmm] rows ${different.length === 0 ? 'identical to' : `DIFFER (${different.length}, first at n=${different[0][0]} m=${different[0][1]}) from`} ${out}`)
  console.log(`[wmm] file bytes ${sameBytes ? 'identical to' : 'differ from'} the file the module records`)
  process.exitCode = sameModel && different.length === 0 ? 0 : 1
}

function main(argv) {
  const args = parseArgs(argv)
  const bytes = readFileSync(args.input)
  if (args.check) return check(args, bytes)
  const cof = parseCof(bytes.toString('utf8'))
  const out = resolve(args.out ?? moduleFor(cof.modelName))
  const sha256 = sha256Hex(bytes)
  writeFileSync(out, renderModule({ cof, sha256, origin: args.origin }))
  console.log(`[wmm] ${cof.modelName} epoch ${cof.epoch.toFixed(1)}: ${cof.rows.length} rows from ${args.input} (SHA-256 ${sha256}) -> ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[wmm] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 2
  }
}
