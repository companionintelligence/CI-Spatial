/**
 * What the editor's scan list says about how a scan was calibrated, and what it must not say.
 *
 * src/viewer/scan-calibration-chip.ts replaces the phone's GPS accuracy ("accuracy 4.0m") on the scan list
 * with the tier, the status and the residual of the scan's own calibration. The copy is a claim, so each
 * claim is held to what the data behind it proves (see that file's header, which follows
 * src/ar/alignment-status.ts):
 *
 *  - a two-point "verified" compared ONE number, the spacing of the tapped pair against the stored pair, so
 *    the chip prints that figure as a spacing (a bare "2 cm off" reads as the points landing within 2 cm of
 *    the stored ones, which nothing measures) and says direction and position were not checked;
 *  - a "verified" with no residual to show is not a match to tick;
 *  - a first calibration compared nothing, and says so, and prints no residual of 0 as if it were a measurement;
 *  - a pair kept past a failed check is a warning, with the figure;
 *  - the one-point tier can never be verified and never says so, whatever an old record carried;
 *  - a number that does not exist prints no figure: never "NaN cm off".
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/scan_calibration_chip.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  redrawScanMeta,
  scanCalibrationChip,
  scanMetaHtmlFor,
  scanMetaMarkup,
  trackingNote,
  type ChipScan,
  type ScanCalibrationChip,
} from '../../../src/viewer/scan-calibration-chip.ts'
import { NOT_CHECKED_METRES, NOT_CHECKED_SPOTS, twoPointToleranceM } from '../../../src/world/frame-fit.ts'
import type { ProjectSpatialFrame, ScanCalibration, ScanManifest } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const CALIBRATED_AT = '2026-11-01T10:00:00.000Z'

const twoPoint = (over: Partial<ChipScan> = {}): ChipScan => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'verified',
  calibrationResidualM: 0.022,
  calibrationToleranceM: 0.15,
  calibratedAt: CALIBRATED_AT,
  ...over,
})

function chipOf(scan: ChipScan, place?: ProjectSpatialFrame['method'] | null): ScanCalibrationChip {
  const chip = scanCalibrationChip(scan, place)
  assert.ok(chip, `expected a chip for ${JSON.stringify(scan)}`)
  return chip
}

// Every member of the unions, listed so a new one cannot be forgotten: adding a tier to ScanCalibration stops
// this file compiling until it is listed, and then the loop below fails until the chip names it.
const EVERY_METHOD: Record<ScanCalibration['method'], true> = {
  'two-point-ground': true,
  'ground-tap-compass': true,
  'known-distance': true,
}
const METHODS = Object.keys(EVERY_METHOD) as ScanCalibration['method'][]

// ── Two-point ────────────────────────────────────────────────────────────────────────────────

test('two-point verified: the tier, the status and the spacing figure, and direction and position are said not to be checked', () => {
  const chip = chipOf(twoPoint())
  assert.equal(chip.text, 'two-point · verified · spacing 2 cm off')
  assert.equal(chip.note, 'Direction and position not checked')
  assert.equal(chip.frameWarning, null)
  assert.equal(chip.tone, 'plain')
})

test('two-point verified: the visible lines name the quantity that was compared, not only the tooltip', () => {
  // The scanner's own line says "Points about as far apart as stored" for the same reason (alignment-status.ts): a bare
  // figure reads as the tapped points landing within that distance of the stored ones, and a tooltip is not on a touch screen.
  const chip = chipOf(twoPoint())
  assert.match(chip.text, /\bspacing\b/)
  assert.match(chip.note ?? '', /direction/i)
  assert.match(chip.note ?? '', /position/i, 'a pair shifted along the floor at the same spacing passes the check, so position is not checked either')
  assert.doesNotMatch(chip.text, /^\S+ · \S+ · \d+ cm off$/, 'never the bare figure')
})

test('two-point verified: the figure is unsigned whole centimetres, as the scanner reports it', () => {
  assert.equal(chipOf(twoPoint({ calibrationResidualM: -0.049 })).text, 'two-point · verified · spacing 5 cm off')
  assert.equal(chipOf(twoPoint({ calibrationResidualM: 0.004 })).text, 'two-point · verified · spacing 0 cm off')
  assert.equal(chipOf(twoPoint({ calibrationResidualM: 0.1449 })).text, 'two-point · verified · spacing 14 cm off')
})

test("two-point verified: the explanation says what was compared and what was not, with the record's own tolerance and time", () => {
  const { title } = chipOf(twoPoint())
  assert.match(title, /spacing between them was 2 cm off the spacing of this Place's stored pair, inside the 15 cm tolerance/)
  assert.match(title, /Neither which way they pointed nor where they were was checked/)
  assert.match(title, /Calibrated 2026-11-01 10:00 UTC\./)
})

test('two-point verified: it never says the alignment, the frame or the Place was verified or aligned', () => {
  // The same restraint as alignment-status.ts, whose test asserts /align/i never appears in the verified line.
  const chip = chipOf(twoPoint())
  for (const text of [chip.text, chip.note ?? '', chip.title]) {
    assert.doesNotMatch(text, /align/i, text)
    assert.doesNotMatch(text, /verified (the )?(alignment|frame|place)/i, text)
  }
})

test('two-point verified with no residual to show: the frame is set and nothing was compared', () => {
  for (const residual of [undefined, null, NaN, Infinity, '0.02' as unknown as number]) {
    const chip = chipOf(twoPoint({ calibrationResidualM: residual }))
    assert.equal(chip.text, 'two-point · frame set', `residual ${String(residual)}`)
    assert.equal(chip.note, 'Spacing, direction and position not checked')
    assert.doesNotMatch(chip.text, /verified|cm/, 'no match to tick and no figure that does not exist')
    assert.doesNotMatch(chip.title, /verified|cm off/)
  }
})

test("two-point provisional on a Place's first calibration: not compared, and a residual of 0 is not printed as a measurement", () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0 }))
  assert.equal(chip.text, 'two-point · provisional')
  assert.equal(chip.note, 'Not compared with an earlier pair')
  assert.doesNotMatch(chip.text, /cm/)
  assert.equal(chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: null })).text, 'two-point · provisional')
})

test('two-point provisional past the tolerance is the pair that was kept after a mismatch, and it warns with the figure', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: -0.2 }))
  assert.equal(chip.text, 'two-point · provisional · spacing 20 cm off')
  assert.equal(chip.note, 'Kept after a mismatch; earlier scans may not line up')
  assert.equal(chip.tone, 'warn')
  assert.match(chip.title, /past the 15 cm tolerance, and it was kept/)
  // The comparison is strict, as commitTwoPoint's is: exactly at the tolerance is not a failed check.
  const atTolerance = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.15, calibrationToleranceM: 0.15 }))
  assert.equal(atTolerance.tone, 'plain')
  assert.equal(atTolerance.text, 'two-point · provisional · spacing 15 cm off')
})

test('two-point provisional with a figure but no failed check shows the figure and claims nothing further', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.05 }))
  assert.equal(chip.text, 'two-point · provisional · spacing 5 cm off')
  assert.equal(chip.note, null)
  assert.equal(chip.tone, 'plain')
})

test('two-point with a residual past a tolerance that is missing is not called a mismatch', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.4, calibrationToleranceM: null }))
  assert.equal(chip.tone, 'plain')
  assert.equal(chip.note, null)
})

test('two-point with no status word in the record names the tier and claims nothing more', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: undefined }))
  assert.equal(chip.text, 'two-point')
  assert.equal(chip.note, null)
})

// ── One-point and known-distance ─────────────────────────────────────────────────────────────

test('one-point: always provisional, and aligns only at the same spot', () => {
  const chip = chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', calibratedAt: CALIBRATED_AT })
  assert.equal(chip.text, 'one-point · provisional')
  assert.equal(chip.note, 'Aligns only at the same spot')
  assert.match(chip.title, /cannot be checked against another visit/)
})

test('one-point never says verified, even for a record written before there was a check behind the word', () => {
  const old = chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'verified' })
  assert.equal(old.text, 'one-point · provisional')
  for (const text of [old.text, old.note ?? '', old.title]) assert.doesNotMatch(text, /verified/i)
  // And it prints no figure it does not have.
  assert.doesNotMatch(chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', calibrationResidualM: 0.3 }).text, /cm/, 'a one-point record has no residual; a stray one is not shown')
})

test('known distance: sized from a measured distance, heading not set, and no figure whose meaning the manifest does not carry', () => {
  // No writer puts this tier in the sidecar's flat summary today (see the chip module's header), so no scan list reaches
  // this branch yet; the function is total over the tier union, and this is what it says when one does. The record's
  // residual is the spread of one of two different things and the manifest does not say which, so it is not printed.
  const chip = chipOf({ calibrationMethod: 'known-distance', calibrationStatus: 'provisional', calibrationResidualM: 0.02, calibratedAt: CALIBRATED_AT })
  assert.equal(chip.text, 'known distance · provisional')
  assert.equal(chip.note, 'Sized from a measured distance; heading not set')
  assert.doesNotMatch(`${chip.text} ${chip.title}`, /\d+ cm/)
  assert.equal(chipOf({ calibrationMethod: 'known-distance', calibrationStatus: 'verified' }).text, 'known distance · verified')
})

test('every tier the manifest names gets a chip, and a name of its own', () => {
  const seen = new Set<string>()
  for (const method of METHODS) {
    const chip = chipOf({ calibrationMethod: method, calibrationStatus: 'provisional', calibrationResidualM: 0, calibrationToleranceM: 0.15 })
    seen.add(chip.text.split(' · ')[0]!)
  }
  assert.equal(seen.size, METHODS.length, `two tiers share a name: ${[...seen].join(', ')}`)
})

// ── No chip ──────────────────────────────────────────────────────────────────────────────────

test('a scan with no calibration has no chip, so the list keeps the GPS text it always had', () => {
  assert.equal(scanCalibrationChip({}), null)
  assert.equal(scanCalibrationChip({ calibrationStatus: 'uncalibrated' }), null)
  assert.equal(scanCalibrationChip({ calibrationMethod: 'two-point-ground', calibrationStatus: 'uncalibrated' }), null)
  assert.equal(scanCalibrationChip({ calibrationStatus: 'verified' }), null, 'a status with no tier names nothing')
  assert.equal(scanCalibrationChip({ calibrationMethod: undefined, calibrationStatus: 'provisional' }), null)
})

test("a scan whose only calibration record is the one splat-align wrote has no chip: the manifest carries no tier for it, and the list keeps the GPS text", () => {
  // The manifest fields tests/unit/deno/scan_manifest_calibration.test.ts shows calibrationFromMeta yields for that sidecar:
  // no tier, the flat 'uncalibrated', and no measurements. That scan is placed by GPS or the grid, so it is not told
  // it was calibrated.
  const fromSplatAlignOnly: ChipScan & { accuracyM: number } = {
    calibrationMethod: undefined,
    calibrationStatus: 'uncalibrated',
    calibrationResidualM: null,
    calibrationToleranceM: null,
    calibratedAt: null,
    accuracyM: 4,
  }
  assert.equal(scanCalibrationChip(fromSplatAlignOnly), null)
  assert.equal(scanMetaMarkup(fromSplatAlignOnly, 'Nov 12', 'two-point-ground', mark), '<div class="scan-meta">«Nov 12» · «accuracy 4.0m»</div>')
})

// ── A scan in another frame ──────────────────────────────────────────────────────────────────

test("a scan whose tier differs from the Place's stored frame is said to be in a different frame", () => {
  const oneInTwo = chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, 'two-point-ground')
  assert.equal(oneInTwo.frameWarning, 'Different frame from this Place')
  assert.match(oneInTwo.title, /one-point method and this Place's frame was made with the two-point method/)
  const twoInOne = chipOf(twoPoint(), 'ground-tap-compass')
  assert.equal(twoInOne.frameWarning, 'Different frame from this Place')
  assert.match(twoInOne.title, /two-point method and this Place's frame was made with the one-point method/)
  const known = chipOf({ calibrationMethod: 'known-distance', calibrationStatus: 'provisional' }, 'two-point-ground')
  assert.equal(known.frameWarning, 'Different frame from this Place')
})

test('the same tier as the Place, or a Place with no stored frame, is not a different frame', () => {
  assert.equal(chipOf(twoPoint(), 'two-point-ground').frameWarning, null)
  assert.equal(chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, 'ground-tap-compass').frameWarning, null)
  assert.equal(chipOf(twoPoint(), undefined).frameWarning, null)
  assert.equal(chipOf(twoPoint(), null).frameWarning, null)
})

test("a Place whose frame was made with a method this editor has no name for is still a different frame, and the words say so", () => {
  // PUT /projects/:id stores a spatialFrame without validating it, and a Place file can come from a newer build.
  for (const unknown of ['banana', 'three-point', 'constructor', '__proto__', 'toString']) {
    const chip = chipOf(twoPoint(), unknown as ProjectSpatialFrame['method'])
    assert.equal(chip.frameWarning, 'Different frame from this Place', unknown)
    assert.match(chip.title, /this Place's frame was made with a method this editor does not know\./, unknown)
    assert.doesNotMatch(chip.title, /undefined/, unknown)
  }
  // Something that is not a method name at all names no frame.
  for (const notAName of ['', 0, 7, {}, [], true]) {
    assert.equal(chipOf(twoPoint(), notAName as unknown as ProjectSpatialFrame['method']).frameWarning, null, JSON.stringify(notAName))
  }
})

test('the frame warning says only that the tiers differ, not how far apart the frames are', () => {
  const chip = chipOf({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' }, 'two-point-ground')
  assert.doesNotMatch(`${chip.frameWarning} ${chip.title}`, /\d+(\.\d+)?\s*(m|cm|°|deg)/i, 'the data does not hold a distance or an angle')
})

// ── Numbers that do not exist ────────────────────────────────────────────────────────────────

test('whatever the record holds, no chip prints NaN, Infinity, undefined or null', () => {
  const junk: unknown[] = [undefined, null, NaN, Infinity, -Infinity, '', 'x', '0.02', true, {}, [], 0, -0, 1e308, -0.3]
  const statuses: Array<ChipScan['calibrationStatus']> = ['verified', 'provisional', 'uncalibrated', undefined]
  const places: Array<ProjectSpatialFrame['method'] | undefined> = [undefined, 'two-point-ground', 'ground-tap-compass']
  let combinations = 0
  for (const method of METHODS) {
    for (const status of statuses) {
      for (const residual of junk) {
        for (const tolerance of junk) {
          for (const place of places) {
            const chip = scanCalibrationChip({
              calibrationMethod: method,
              calibrationStatus: status,
              calibrationResidualM: residual as number,
              calibrationToleranceM: tolerance as number,
              // Cycled through the same junk, so every kind of bad time meets every combination above without a random draw.
              calibratedAt: junk[combinations++ % junk.length] as string,
            }, place)
            if (!chip) continue
            for (const text of [chip.text, chip.note ?? '', chip.frameWarning ?? '', chip.title]) {
              assert.doesNotMatch(text, /NaN|Infinity|undefined|null|\[object/, `${method} ${status} ${String(residual)} ${String(tolerance)}: ${text}`)
            }
          }
        }
      }
    }
  }
  assert.ok(combinations > 1000, 'the matrix ran')
})

test('a calibration time that is not an ISO date-time is left out of the explanation, including one that only happens to parse', () => {
  for (const calibratedAt of [undefined, null, '', 'yesterday', 'not a date', '1', '2001', 'Nov 1 2026', '2026-11-01', '2026-13-01T10:00:00.000Z']) {
    assert.doesNotMatch(chipOf(twoPoint({ calibratedAt })).title, /Calibrated/, String(calibratedAt))
  }
  assert.match(chipOf(twoPoint({ calibratedAt: '2026-11-09T23:59:59.999Z' })).title, /Calibrated 2026-11-09 23:59 UTC\./)
  assert.match(chipOf(twoPoint({ calibratedAt: '2026-11-09T23:59:59+01:00' })).title, /Calibrated 2026-11-09 22:59 UTC\./, 'an offset is turned into UTC, which is what the line says')
})

// ── The list markup ──────────────────────────────────────────────────────────────────────────

const mark = (text: string) => `«${text}»`

test('the list keeps the GPS accuracy text for a scan with no calibration, and "manual align" with no fix', () => {
  assert.equal(
    scanMetaMarkup({ calibrationStatus: 'uncalibrated', accuracyM: 4 }, 'Nov 12, 10:00', undefined, mark),
    '<div class="scan-meta">«Nov 12, 10:00» · «accuracy 4.0m»</div>',
  )
  assert.equal(
    scanMetaMarkup({ accuracyM: null }, 'Unknown date', undefined, mark),
    '<div class="scan-meta">«Unknown date» · «manual align»</div>',
  )
})

test('the list shows the chip in place of the GPS accuracy for a calibrated scan, even one that has a GPS fix', () => {
  const html = scanMetaMarkup({ ...twoPoint(), accuracyM: 4 }, 'Nov 12, 10:00', 'two-point-ground', mark)
  assert.match(html, /<div class="scan-meta" title="«[^»]+»">«Nov 12, 10:00» · «two-point · verified · spacing 2 cm off»<\/div>/)
  assert.doesNotMatch(html, /accuracy 4\.0m|manual align/)
  assert.match(html, /<div class="scan-calibration-note" data-tone="plain">«Direction and position not checked»<\/div>/)
  assert.doesNotMatch(html, /Different frame/)
})

test('the caveat and the frame warning are visible lines, not only a tooltip, and the warning is flagged', () => {
  const html = scanMetaMarkup({ calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', accuracyM: null }, 'Nov 12, 10:00', 'two-point-ground', mark)
  assert.match(html, /<div class="scan-calibration-note" data-tone="plain">«Aligns only at the same spot»<\/div>/)
  assert.match(html, /<div class="scan-calibration-note" data-tone="warn">«Different frame from this Place»<\/div>/)
  const kept = scanMetaMarkup({ ...twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.2 }), accuracyM: null }, 'Nov 12, 10:00', 'two-point-ground', mark)
  assert.match(kept, /data-tone="warn">«Kept after a mismatch/)
})

test('every piece of text in the list markup goes through the escape the viewer gives it, the tooltip included', () => {
  const scan = { ...twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.2 }), accuracyM: null }
  const chip = chipOf(scan, 'ground-tap-compass')
  const html = scanMetaMarkup(scan, 'Nov 12', 'ground-tap-compass', mark)
  assert.ok(html.includes(`title="${mark(chip.title)}"`), 'the tooltip')
  assert.ok(html.includes(mark(chip.text)), 'the chip text')
  assert.ok(html.includes(mark(chip.note!)), 'the caveat')
  assert.ok(html.includes(mark(chip.frameWarning!)), 'the frame warning')
  // With a real escape nothing the chip wrote can end an attribute or open a tag: only the three divs are markup.
  const real = scanMetaMarkup(scan, 'Nov 12', 'ground-tap-compass', (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  assert.equal(real.match(/</g)?.length, 6, 'three opening and three closing div tags, and no other angle bracket')
})

// ── The scan list's lines, as the editor draws them, and redrawn ─────────────────────────────

const real = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

test('the date line is the locale time of the capture, and "Unknown date" when the scan has none or one that does not parse', () => {
  const when = '2026-11-12T10:00:00.000Z'
  const label = new Date(when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  assert.notEqual(label, 'Invalid Date')
  assert.equal(
    scanMetaHtmlFor({ capturedAt: when, accuracyM: 4 }, undefined, mark),
    `<div class="scan-meta">«${label}» · «accuracy 4.0m»</div>`,
  )
  for (const capturedAt of [null, '', 'not a date']) {
    assert.equal(
      scanMetaHtmlFor({ capturedAt, accuracyM: null }, undefined, mark),
      '<div class="scan-meta">«Unknown date» · «manual align»</div>',
      String(capturedAt),
    )
  }
})

test('a calibrated scan is drawn with the chip, compared with the Place frame it is given', () => {
  const scan = { ...twoPoint(), capturedAt: null, accuracyM: 4 }
  assert.match(scanMetaHtmlFor(scan, 'two-point-ground', mark), /«Unknown date» · «two-point · verified · spacing 2 cm off»/)
  assert.doesNotMatch(scanMetaHtmlFor(scan, 'two-point-ground', mark), /Different frame/)
  assert.match(scanMetaHtmlFor(scan, 'ground-tap-compass', mark), /«Different frame from this Place»/)
})

test('redrawing replaces the lines of every listed scan that has a row, and only those', () => {
  const rows = new Map<string, { innerHTML: string }>([['scan-a', { innerHTML: 'old a' }], ['scan-b', { innerHTML: 'old b' }]])
  const scans = [
    { ...twoPoint(), scanId: 'scan-a', capturedAt: null, accuracyM: null },
    { calibrationMethod: 'ground-tap-compass' as const, calibrationStatus: 'provisional' as const, scanId: 'scan-b', capturedAt: null, accuracyM: null },
    { ...twoPoint(), scanId: 'scan-without-a-row', capturedAt: null, accuracyM: null },
  ]
  const asked: string[] = []
  redrawScanMeta(scans, (scanId) => { asked.push(scanId); return rows.get(scanId) }, 'two-point-ground', mark)
  assert.deepEqual(asked, ['scan-a', 'scan-b', 'scan-without-a-row'], 'every listed scan is looked up')
  assert.match(rows.get('scan-a')!.innerHTML, /«two-point · verified · spacing 2 cm off»/)
  assert.doesNotMatch(rows.get('scan-a')!.innerHTML, /Different frame/)
  assert.match(rows.get('scan-b')!.innerHTML, /«one-point · provisional»/)
  assert.match(rows.get('scan-b')!.innerHTML, /«Different frame from this Place»/, 'the Place frame it is compared with is the one the redraw is given')
  // A Place whose frame changed under an open editor: the same rows, drawn again against the new frame.
  redrawScanMeta(scans, (scanId) => rows.get(scanId), 'ground-tap-compass', mark)
  assert.match(rows.get('scan-a')!.innerHTML, /«Different frame from this Place»/)
  assert.doesNotMatch(rows.get('scan-b')!.innerHTML, /Different frame/)
})

test('redrawing with no scans, or none with a row, changes nothing and does not throw', () => {
  const row = { innerHTML: 'kept' }
  assert.doesNotThrow(() => redrawScanMeta([], () => row, undefined, mark))
  assert.doesNotThrow(() => redrawScanMeta([{ ...twoPoint(), scanId: 'x', capturedAt: null, accuracyM: null }], () => null, undefined, mark))
  assert.doesNotThrow(() => redrawScanMeta([{ ...twoPoint(), scanId: 'x', capturedAt: null, accuracyM: null }], () => undefined, undefined, mark))
  assert.equal(row.innerHTML, 'kept')
})

test('the date label and the GPS text are escaped as well: nothing the list writes is trusted as markup', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  for (const scan of [{ accuracyM: 4 }, { ...twoPoint(), accuracyM: 4 }]) {
    const html = scanMetaMarkup(scan, hostile, undefined, real)
    assert.doesNotMatch(html, /<img/, html)
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the label is there, as text')
  }
  assert.ok(scanMetaMarkup({ accuracyM: 4 }, 'Nov 12', undefined, mark).includes('«accuracy 4.0m»'), 'the GPS text goes through the escape too')
  assert.ok(scanMetaMarkup({ accuracyM: null }, 'Nov 12', undefined, mark).includes('«manual align»'))
})

test('a record that is not markup cannot become markup: with the real escape only the three divs are tags', () => {
  const hostile = { ...twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.2 }), capturedAt: null, accuracyM: null }
  const html = scanMetaHtmlFor(hostile, '"><script>x</script>' as ProjectSpatialFrame['method'], real)
  assert.equal(html.match(/</g)?.length, 6, html)
  assert.doesNotMatch(html, /<script|"><|onerror/i)
})

// ── The wiring in viewer.ts and viewer.html ──────────────────────────────────────────────────

test('source shape: the scan list draws its meta lines with the chip module and the Place frame, and redraws them on refresh', () => {
  const viewer = read('src/viewer/viewer.ts')
  assert.match(viewer, /import \{ redrawScanMeta, scanMetaHtmlFor \} from '\.\/scan-calibration-chip'/)
  const build = viewer.slice(viewer.indexOf('function buildScanItem('), viewer.indexOf('\n}\n', viewer.indexOf('function buildScanItem(')))
  assert.match(build, /<div class="scan-meta-block">\$\{scanMetaHtmlFor\(scan, currentProject\?\.spatialFrame\?\.method, escHtml\)\}<\/div>/, "compared with the Place's stored frame, escaped with the viewer's own escape")
  const refresh = viewer.slice(viewer.indexOf('function refreshScanMeta('), viewer.indexOf('\n}\n', viewer.indexOf('function refreshScanMeta(')))
  assert.match(refresh, /redrawScanMeta\(\s*world\?\.scans \?\? \[\],\s*scanId => scanItems\.get\(scanId\)\?\.querySelector\('\.scan-meta-block'\),\s*currentProject\?\.spatialFrame\?\.method,\s*escHtml,\s*\)/)
  // The element it looks for is the one the row builds: a redraw that looks for another finds nothing and changes nothing.
  assert.equal(/querySelector\('\.([a-z-]+)'\)/.exec(refresh)?.[1], /<div class="([a-z-]+)">\$\{scanMetaHtmlFor/.exec(build)?.[1])
  const afterRefresh = viewer.slice(viewer.indexOf('async function refreshWorldScans'))
  assert.ok(afterRefresh.indexOf('refreshScanMeta()') > 0 && afterRefresh.indexOf('refreshScanMeta()') < afterRefresh.indexOf('const fresh ='), 'a refresh that learns a new Place frame redraws the lines before it adds new scans')
  assert.doesNotMatch(viewer, /accuracy \$\{scan\.accuracyM/, 'the GPS text is built in one place, the chip module')
})

test('every class the list markup writes has a rule in viewer.html, and the warning tone has its own', () => {
  const html = read('viewer.html')
  const markup = scanMetaHtmlFor({ ...twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.2 }), capturedAt: null, accuracyM: null }, 'ground-tap-compass', real)
  const classes = new Set([...markup.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)))
  assert.ok(classes.has('scan-meta') && classes.has('scan-calibration-note'), 'the markup writes the classes this test is about')
  // A rule for the class on its own, not only one that qualifies it (`.name[data-tone="warn"]` is not the base rule).
  for (const name of classes) assert.match(html, new RegExp(`(^|[\\s,>}])\\.${name}\\s*[{,]`, 'm'), `viewer.html has no rule for .${name}`)
  assert.match(html, /\.scan-calibration-note\[data-tone="warn"\]\s*\{[^}]*color:/, 'the warning is coloured as well as worded')
  assert.match(markup, /data-tone="warn"/)
})

// ── Tracking interrupted (WP-09b) ────────────────────────────────────────────────────────────

/** A scan's quality summary with only the two fields the line reads; the rest of the record is not what is under test. */
const summary = (fields: { frameShifts?: unknown; mixedEpochs?: unknown }): Pick<ChipScan, 'qualitySummary'> =>
  ({ qualitySummary: { coverageScore: 0.9, status: 'needs-review', ...fields } as unknown as ChipScan['qualitySummary'] })

test('a scan that was interrupted says how many times, in the words "Tracking interrupted N times"', () => {
  assert.equal(trackingNote(summary({ frameShifts: 3 }))?.line, 'Tracking interrupted 3 times')
  assert.equal(trackingNote(summary({ frameShifts: 1 }))?.line, 'Tracking interrupted 1 time')
  assert.equal(trackingNote(summary({ frameShifts: 12 }))?.line, 'Tracking interrupted 12 times')
})

test('a scan with nothing to say gets no line: no count, none, or a count that is not a whole number of at least one', () => {
  assert.equal(trackingNote({}), null, 'no summary at all (a scan from before summaries)')
  assert.equal(trackingNote({ qualitySummary: null }), null)
  assert.equal(trackingNote(summary({})), null, 'a summary from before interruptions were counted says nothing: not "no interruptions"')
  for (const frameShifts of [0, -2, Number.NaN, Infinity, '3', null, 0.9]) {
    assert.equal(trackingNote(summary({ frameShifts })), null, String(frameShifts))
  }
  assert.equal(trackingNote(summary({ frameShifts: 2.8 }))?.line, 'Tracking interrupted 2 times', 'a fraction is floored to the whole count')
})

test('a cloud that spans more than one stretch of tracking says its parts may not line up, and not that they do not', () => {
  const note = trackingNote(summary({ frameShifts: 2, mixedEpochs: true }))
  assert.equal(note?.line, 'Tracking interrupted 2 times')
  assert.equal(note?.note, 'Points from before and after may not line up')
  assert.equal(trackingNote(summary({ frameShifts: 2, mixedEpochs: false }))?.note, null)
  assert.equal(trackingNote(summary({ frameShifts: 2 }))?.note, null, 'absent is not true')
  assert.equal(trackingNote(summary({ frameShifts: 2, mixedEpochs: 'yes' }))?.note, null, 'only the boolean true')
})

test('a mixed cloud with no count still gets its note, and no count line', () => {
  const note = trackingNote(summary({ mixedEpochs: true }))
  assert.equal(note?.line, null)
  assert.equal(note?.note, 'Points from before and after may not line up')
})

test('the explanation counts interruptions and says in so many words that it does not measure how far anything moved', () => {
  const { title } = trackingNote(summary({ frameShifts: 2, mixedEpochs: true }))!
  assert.match(title, /lost tracking, reported that its origin moved, or was resumed 2 times while this scan was recorded/)
  assert.match(title, /Parts of the scan may be shifted against each other\./)
  assert.match(title, /does not measure how far anything moved/)
  assert.match(title, /The point cloud holds points from more than one stretch of tracking\./)
  assert.match(trackingNote(summary({ frameShifts: 1 }))!.title, /1 time while this scan/)
  assert.doesNotMatch(title, /verified|aligned|misaligned|broken|wrong/i, 'it is a count of interruptions, and the words keep to that')
})

test('the list draws the tracking lines beside the chip of a calibrated scan, after its own lines', () => {
  const scan = { ...twoPoint(), ...summary({ frameShifts: 2, mixedEpochs: true }), accuracyM: null }
  const html = scanMetaMarkup(scan, 'Nov 12', 'two-point-ground', mark)
  const calibration = html.indexOf('«Direction and position not checked»')
  const interrupted = html.indexOf('«Tracking interrupted 2 times»')
  const mixed = html.indexOf('«Points from before and after may not line up»')
  assert.ok(calibration > 0 && interrupted > calibration && mixed > interrupted, html)
  assert.match(html, /<div class="scan-calibration-note" data-tone="warn" title="«The AR runtime lost tracking[^»]+»">«Tracking interrupted 2 times»<\/div>/)
  assert.match(html, /<div class="scan-calibration-note" data-tone="warn" title="«[^»]+»">«Points from before and after may not line up»<\/div>/)
})

test('a scan that was never calibrated keeps its GPS text and gets the tracking lines under it', () => {
  const html = scanMetaMarkup({ calibrationStatus: 'uncalibrated', accuracyM: 4, ...summary({ frameShifts: 1 }) }, 'Nov 12', undefined, mark)
  assert.match(html, /^<div class="scan-meta">«Nov 12» · «accuracy 4\.0m»<\/div>/)
  assert.match(html, /«Tracking interrupted 1 time»<\/div>$/)
  assert.doesNotMatch(html, /manual align|two-point|one-point/)
})

test('a scan with no interruption to report is drawn exactly as it was before: the same markup, byte for byte', () => {
  for (const scan of [
    { calibrationStatus: 'uncalibrated' as const, accuracyM: 4 },
    { ...twoPoint(), accuracyM: 4 },
    { ...twoPoint(), ...summary({ frameShifts: 0, mixedEpochs: false }), accuracyM: 4 },
    { ...twoPoint(), ...summary({}), accuracyM: 4 },
  ]) {
    const without = { ...scan }
    delete (without as { qualitySummary?: unknown }).qualitySummary
    assert.equal(scanMetaMarkup(scan, 'Nov 12', 'two-point-ground', mark), scanMetaMarkup(without, 'Nov 12', 'two-point-ground', mark))
  }
})

test('the tracking lines go through the escape, tooltip included, and with the real one only divs are tags', () => {
  const scan = { ...twoPoint(), ...summary({ frameShifts: 2, mixedEpochs: true }), accuracyM: null }
  const note = trackingNote(scan)!
  const html = scanMetaMarkup(scan, 'Nov 12', 'two-point-ground', mark)
  assert.ok(html.includes(`title="${mark(note.title)}"`), 'the tooltip')
  assert.ok(html.includes(mark(note.line!)))
  assert.ok(html.includes(mark(note.note!)))
  const escaped = scanMetaMarkup(scan, 'Nov 12', 'two-point-ground', real)
  assert.equal(escaped.match(/</g)?.length, 8, 'four divs opened and closed (the date line, the caveat, the two tracking lines), and no other angle bracket')
})

test('the redraw carries the tracking lines too, so a scan whose summary changes is drawn again with them', () => {
  const rows = new Map<string, { innerHTML: string }>([['scan-a', { innerHTML: 'old' }]])
  redrawScanMeta([{ ...twoPoint(), ...summary({ frameShifts: 4 }), scanId: 'scan-a', capturedAt: null, accuracyM: null }], (id) => rows.get(id), 'two-point-ground', mark)
  assert.match(rows.get('scan-a')!.innerHTML, /«Tracking interrupted 4 times»/)
})

test('source shape: the tracking line is built from the manifest\'s own quality summary in the one chip module, and the viewer needs no new field', () => {
  const chip = read('src/viewer/scan-calibration-chip.ts')
  assert.match(chip, /scan\.qualitySummary\?\.frameShifts/)
  assert.match(chip, /scan\.qualitySummary\?\.mixedEpochs === true/)
  assert.doesNotMatch(read('src/viewer/viewer.ts'), /Tracking interrupted/, 'the words live in one place')
})

// ── Three or more points fitted, and a pair checked by spacing (WP-04b) ──────────────────────────────

/** The spacing tolerance a verdict applies at the adopted tap noise, which a scan records as its `toleranceM`. */
const TOLERANCE_M = twoPointToleranceM(0.03)

const fitted = (over: Partial<ChipScan> = {}): ChipScan =>
  twoPoint({
    calibrationStatus: 'verified',
    calibrationResidualM: 0.012,
    calibrationToleranceM: TOLERANCE_M,
    calibrationCheckedBy: 'constellation',
    calibrationFitPointsUsed: 3,
    calibrationFitRmsM: 0.032,
    calibrationFitMaxM: 0.04,
    ...over,
  })

test('a fit that was verified: the points and how far off, and the one thing it cannot see, on a visible line', () => {
  const chip = chipOf(fitted())
  assert.equal(chip.text, 'two-point · verified · 3 points 3.2 cm off')
  assert.equal(chip.note, 'Same physical spots not checked')
  assert.equal(chip.tone, 'plain')
  assert.match(chip.title, /3 floor points fitted to this Place's stored ones: 3\.2 cm off on average/)
  assert.match(chip.title, /positions, which way they face and their heights were compared/)
  assert.ok(chip.title.includes(NOT_CHECKED_SPOTS))
  assert.doesNotMatch(`${chip.text} ${chip.note} ${chip.title}`, /alignment (is|was) verified|Place (is|was) verified|frame (is|was) verified/i)
})

test('on a phone whose units are not metres the chip says so beside the centimetres, on its visible line and in its title', () => {
  for (const kind of ['arbitrary', 'estimated-metric'] as const) {
    const sizes = NOT_CHECKED_METRES[kind]
    const verified = chipOf(fitted({ scaleKind: kind }))
    assert.equal(verified.text, 'two-point · verified · 3 points 3.2 cm off', kind)
    assert.equal(verified.note, 'Same physical spots and sizes in metres not checked', kind)
    assert.ok(verified.title.includes(NOT_CHECKED_SPOTS) && verified.title.includes(sizes), kind)
    assert.ok(chipOf(fitted({ calibrationStatus: 'provisional', scaleKind: kind })).title.includes(sizes), kind)
    const kept = chipOf(fitted({ calibrationStatus: 'provisional', calibrationFitRmsM: 0.25, calibrationFitMaxM: 0.31, scaleKind: kind }))
    assert.equal(kept.note, 'Kept after a mismatch; earlier scans may not line up', 'the warning stays the visible line')
    assert.ok(kept.title.includes(sizes), kind)
  }
  // Metres from the runtime and a record that does not say add nothing.
  for (const scaleKind of ['metric', undefined] as const) {
    const plain = chipOf(fitted({ scaleKind }))
    assert.equal(plain.note, 'Same physical spots not checked')
    assert.doesNotMatch(plain.title, /sizes in metres/)
  }
})

test('a fit that agreed but could not be relied on is provisional and says so', () => {
  const chip = chipOf(fitted({ calibrationStatus: 'provisional' }))
  assert.equal(chip.text, 'two-point · provisional · 3 points 3.2 cm off')
  assert.equal(chip.note, 'Not verified: the check could not be relied on')
  assert.equal(chip.tone, 'plain')
})

test('a fit that failed and was kept is a warning that earlier scans may not line up', () => {
  const chip = chipOf(fitted({ calibrationStatus: 'provisional', calibrationFitRmsM: 0.25, calibrationFitMaxM: 0.31 }))
  assert.equal(chip.text, 'two-point · provisional · 3 points 25.0 cm off')
  assert.equal(chip.note, 'Kept after a mismatch; earlier scans may not line up')
  assert.equal(chip.tone, 'warn')
  // The gate comes from the tolerance the record carries: without one nothing can be called a failure.
  assert.equal(chipOf(fitted({ calibrationStatus: 'provisional', calibrationFitRmsM: 0.25, calibrationToleranceM: null })).tone, 'plain')
})

test('a visit that tapped two points was checked by spacing and nothing else, and the chip says what was not checked', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.03, calibrationToleranceM: TOLERANCE_M, calibrationCheckedBy: 'separation' }))
  assert.equal(chip.text, 'two-point · provisional · spacing 3 cm off')
  assert.equal(chip.note, 'Direction and position not checked')
  assert.match(chip.title, /spacing between them was 3 cm off the spacing of this Place's stored pair/)
  // Exactly 0 cm off is a comparison that matched exactly, not the first calibration's "nothing to compare".
  assert.equal(chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0, calibrationCheckedBy: 'separation' })).text, 'two-point · provisional · spacing 0 cm off')
  assert.equal(chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0 })).note, 'Not compared with an earlier pair', 'with no check named it is still the first calibration')
})

test('a pair kept past a failed spacing is still the warning, whatever check is named', () => {
  const chip = chipOf(twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0.4, calibrationToleranceM: TOLERANCE_M, calibrationCheckedBy: 'separation' }))
  assert.equal(chip.tone, 'warn')
  assert.equal(chip.note, 'Kept after a mismatch; earlier scans may not line up')
})

test('points that could not be fitted at all and were kept are a warning, with no figure, never "not compared with an earlier pair"', () => {
  // What the flow writes for a mirrored check point or the pair in the other order: checked by the constellation, provisional, no fit.
  const kept = twoPoint({ calibrationStatus: 'provisional', calibrationResidualM: 0, calibrationToleranceM: TOLERANCE_M, calibrationCheckedBy: 'constellation' })
  const chip = chipOf(kept)
  assert.equal(chip.text, 'two-point · provisional · points did not match')
  assert.equal(chip.note, 'Kept after a mismatch; earlier scans may not line up')
  assert.equal(chip.tone, 'warn')
  assert.match(chip.title, /did not match this Place's stored ones, and were kept\. Earlier scans were made against the frame it replaced\./)
  assert.doesNotMatch(`${chip.text} ${chip.note} ${chip.title}`, /Not compared|NaN|undefined|\d cm/)
  // Only that combination: a fit that is there is the fit's chip, and a verified or spacing-checked record is not a kept mismatch.
  assert.match(chipOf(fitted({ calibrationStatus: 'provisional', calibrationFitRmsM: 0.25, calibrationFitMaxM: 0.31 })).text, /3 points 25\.0 cm off/)
  assert.doesNotMatch(chipOf({ ...kept, calibrationStatus: 'verified' }).text, /did not match/)
  assert.doesNotMatch(chipOf({ ...kept, calibrationCheckedBy: 'separation' }).text, /did not match/)
  assert.doesNotMatch(chipOf({ ...kept, calibrationCheckedBy: undefined }).text, /did not match/)
  // And the markup the list draws carries the warning on its own visible line, in the warning tone.
  const markup = scanMetaHtmlFor({ ...kept, capturedAt: null, accuracyM: null }, 'two-point-ground', real)
  assert.match(markup, /<div class="scan-calibration-note" data-tone="warn">Kept after a mismatch; earlier scans may not line up<\/div>/)
})

test('a record that names a fit and carries no figure for it is otherwise read as any other, and prints no figure it does not have', () => {
  const chip = chipOf(fitted({ calibrationFitRmsM: undefined }))
  assert.equal(chip.text, 'two-point · verified · spacing 1 cm off', 'what the residual says: the legacy reading')
  assert.doesNotMatch(chipOf(fitted({ calibrationFitRmsM: Number.NaN })).text, /NaN|undefined/)
  assert.doesNotMatch(chipOf(fitted({ calibrationFitPointsUsed: undefined })).text, /points|undefined/)
})

test('the one-point tier never shows a fit, even from a record that claims one (ADR 0005 rule 3)', () => {
  const chip = chipOf({ ...fitted(), calibrationMethod: 'ground-tap-compass' })
  assert.doesNotMatch(`${chip.text} ${chip.note} ${chip.title}`, /points .* cm off|fitted/)
})
