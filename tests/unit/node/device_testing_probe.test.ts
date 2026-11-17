/**
 * docs/testing/DEVICE_TESTING.md, Procedures 2 to 4, and the probe line they read.
 *
 * The three procedures are only as good as the instrument they send a person to. A document that names a
 * field the line does not log sends someone to read a column that is not there, and a field the document
 * forgets to explain gets read wrong. So:
 *
 *  - the document's example line, and its table of fields, are held equal to the keys src/capture/probe-log.ts
 *    writes (in both directions);
 *  - every `line.<name>` the procedures tell a person to read is a field the line logs, and each procedure reads
 *    the fields its question needs;
 *  - the command the document gives for collecting the lines is run against a log file written the way the relay
 *    writes one, including two phones at once and a line that went missing;
 *  - what the document says each field MEANS is held to the code that writes it: the pitch and yaw conventions, the
 *    Place frame, which column of the compass pair holds still while turning on the spot, the null of a counter a
 *    runtime does not have;
 *  - the short baseline of Procedure 2 clears the scanner's own minimum with room to spare;
 *  - the numbers the decision rules state agree with each other, and with the experiments they come from
 *    (DX1 units, DX2 probe point, DX3 compass).
 *
 * That the procedures are followable is for a person with a phone. These tests hold what a person cannot check
 * afterwards.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/device_testing_probe.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROBE_KEYS,
  PROBE_LINE_PREFIX,
  buildProbeRecord,
  cameraPitchDeg,
  formatProbeLine,
  installProbeLog,
  type ProbeLogDeps,
  type ProbeReading,
} from '../../../src/capture/probe-log.ts'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import { FrameEpochTracker, describeTracking } from '../../../src/ar/frame-epoch.ts'
import { asScaleMode } from '../../../src/world/scale-mode.ts'
import {
  IOS_COMPASS_SIGMA_FLOOR_DEG,
  MIN_AXIS_HORIZONTAL,
  axisHeadingsFromAttitude,
  compassReadingFromEvent,
  headingFromAttitude,
  rawOrientationOf,
  screenTurnDeg,
} from '../../../src/geo/compass-heading.ts'
import {
  BEARING_CONVENTION,
  LEGACY_BEARING_CONVENTION,
  MIN_POINT_SEPARATION_M,
  cameraYawInSessionDeg,
  compassSpinTerms,
  formatCompassSpin,
  sessionFrameBearingDeg,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DOC = readFileSync(join(ROOT, 'docs/testing/DEVICE_TESTING.md'), 'utf8')

/** The text of one section: from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n${heading}\n`)
  assert.ok(start !== -1, `DEVICE_TESTING.md has no section "${heading}"`)
  const level = heading.match(/^#+/)![0].length
  const rest = DOC.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

const KEYS: readonly string[] = PROBE_KEYS

// ── The line the document shows and the table it gives ───────────────────────────────────────

test("the document's example line parses and has exactly the keys the code writes, in order", () => {
  const probe = section('### The probe line')
  const example = probe.match(/^\[probe\] (\{.*\})$/m)
  assert.ok(example, 'the probe section shows an example line')
  const record = JSON.parse(example[1]!) as Record<string, unknown>
  assert.deepEqual(Object.keys(record), [...PROBE_KEYS])
  assert.equal(record['v'], 1)
  assert.match(probe, /invented example of the shape, not a measurement/, 'an example is not passed off as data')
})

test("the document's table of fields names every key the line has, and no other", () => {
  const table = section('### The probe line').split('\n').filter((row) => /^\| `/.test(row))
  const named = table.flatMap((row) => [...row.split('|')[1]!.matchAll(/`([A-Za-z0-9]+)`/g)].map((m) => m[1]!))
  assert.deepEqual([...named].sort(), [...PROBE_KEYS].sort())
  assert.equal(new Set(named).size, named.length, 'a key is explained once')
})

test('the example in the document is what the code would write for a reading of that shape', () => {
  const example = JSON.parse(section('### The probe line').match(/^\[probe\] (\{.*\})$/m)![1]!) as Record<string, unknown>
  const calibration: ScanCalibration = {
    method: 'two-point-ground', sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], separationM: 2.003,
    residualM: 0, toleranceM: 0.15, anchorBearingDeg: null, calibratedAt: '2026-11-01T10:00:00.000Z', status: 'provisional',
  }
  // The compass columns go through the code that makes them: an Android event whose angles are the ones in the example,
  // so the example's B is what the app would work out from its own raw numbers, and not a number that merely fits.
  const event = { absolute: true, alpha: 148.6, beta: 37.6, gamma: 0 } as unknown as DeviceOrientationEvent
  const compass = compassReadingFromEvent(event)
  assert.ok(compass !== null && compass !== undefined)
  const written = JSON.parse(formatProbeLine(buildProbeRecord({
    n: 1, runtime: '8thwall', scaleMode: 'responsive-unconfigured', calibration, hit: { position: { x: 1.302, y: -1.289, z: 0.512 }, distance: 2.31 },
    pose: { position: { x: 0, y: 0.203, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, tap: { x: 0.512, y: 0.731 },
    trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED', poseJumps: 0, bearing: compass.headingDeg, screenAngle: 0, firstPose: { position: { x: 0, y: 1.25, z: 0 } },
    compassSample: { raw: rawOrientationOf(event), reading: compass },
  })).slice(PROBE_LINE_PREFIX.length)) as Record<string, unknown>
  for (const key of ['v', 'n', 'rt', 'scale', 'method', 'status', 'sepM', 'resM', 'hit', 'rng', 'camY', 'tx', 'ty', 'trk', 'why', 'jumps', 'B', 'scr', 'y0', 'hx', 'hy', 'hz',
    'ax', 'alpha', 'beta', 'gamma', 'abs', 'wkHead', 'wkAcc', 'turn']) {
    assert.deepEqual(example[key], written[key], `the example's ${key} is not what the code writes for that reading`)
  }
})

test('the document says when `chk` and the fit fields are null, and that is what the code writes for each kind of visit', () => {
  const calibration = (over: Record<string, unknown>): ScanCalibration => ({
    method: 'two-point-ground', sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], separationM: 2, residualM: 0,
    toleranceM: 0.168, anchorBearingDeg: null, calibratedAt: '2026-11-01T10:00:00.000Z', status: 'provisional', ...over,
  }) as ScanCalibration
  const logged = (c: ScanCalibration) => {
    const r = buildProbeRecord({
      n: 1, runtime: '8thwall', scaleMode: null, calibration: c, hit: { position: { x: 1, y: 0, z: 1 }, distance: 2 },
      pose: { position: { x: 0, y: 0.2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, tap: { x: 0.5, y: 0.7 },
      trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED', poseJumps: 0, bearing: 10, screenAngle: 0, firstPose: { position: { x: 0, y: 1, z: 0 } },
    })
    return [r.chk, r.fitN, r.fitRms, r.fitRes]
  }
  // What the code writes: nothing is checked on a first calibration; a pair is checked by distance and has no fit; points that could
  // not be fitted at all name the constellation and have no fit either.
  assert.deepEqual(logged(calibration({})), [null, null, null, null], 'a first calibration')
  assert.deepEqual(logged(calibration({ checkedBy: 'separation' })), ['separation', null, null, null], 'a pair')
  assert.deepEqual(logged(calibration({ checkedBy: 'constellation' })), ['constellation', null, null, null], 'points that could not be fitted')

  // What the document says of it, in the paragraph that says what `null` means: `chk` is null on a first calibration only, and the fit
  // fields are null on a visit with no fit, which is a pair or points that could not be fitted.
  const probe = section('### The probe line').replace(/\s+/g, ' ')
  assert.match(probe, /`line\.chk` is `null` on a Place's first calibration, which compared nothing/)
  assert.match(probe, /`line\.fitN`, `line\.fitRms` and `line\.fitRes` are `null` there and on any visit with no fit: one that tapped two points \(`chk` is then `separation`\) and one whose points could not be fitted at all/)
  assert.doesNotMatch(probe, /`line\.chk`, `line\.fitN`, `line\.fitRms` and `line\.fitRes` are `null`/, 'chk is not null wherever the fit fields are')
})

// ── The procedures read only fields the line has ─────────────────────────────────────────────

test('every `line.<field>` the document mentions is a field the line logs', () => {
  const mentioned = [...DOC.matchAll(/`line\.([A-Za-z0-9]+)`/g)].map((m) => m[1]!)
  assert.ok(mentioned.length > 30, 'the procedures name the fields they read')
  for (const field of mentioned) assert.ok(KEYS.includes(field), `the document tells a person to read line.${field}, which the line does not log`)
})

test('each procedure reads the fields its question needs', () => {
  const needs: Record<string, string[]> = {
    '### Procedure 2 — probe-point protocol (DX2)': ['n', 'px', 'pz', 'rng', 'pitch', 'sepM', 'hit', 'trk'],
    '### Procedure 3 — units tape test (DX1)': ['sepM', 'y0', 'rt', 'scale'],
    '### Procedure 4 — compass sign, handedness and offset (DX3)': ['B', 'yaw', 'Bplus', 'Bminus', 'pitch', 'scr', 'ax', 'turn', 'alpha', 'beta', 'gamma', 'abs', 'wkHead', 'wkAcc'],
  }
  for (const [heading, fields] of Object.entries(needs)) {
    const text = section(heading)
    for (const field of fields) assert.ok(text.includes(`\`line.${field}\``), `${heading} never reads line.${field}`)
  }
})

test('the raw orientation sample is in the line under its own names, and the AR quaternion, which is not, is not claimed', () => {
  // DX3 as first written asked for alpha/beta/gamma, webkitCompassAccuracy and the pose quaternion, and the line had
  // none of them: it would not fit the relay's cut. The orientation sample is in the line now (the relay's cut was
  // raised to make room, and probe_log.test.ts holds it under the server's), so DX3 reads it from there. The AR
  // pose quaternion still is not in the line: yaw and pitch are, and no procedure may tell a person to read the quaternion.
  for (const name of ['alpha', 'beta', 'gamma', 'abs', 'wkHead', 'wkAcc', 'ax', 'turn']) {
    assert.ok(KEYS.includes(name), `${name} is no longer a key: the procedures read it`)
  }
  for (const name of ['quaternion', 'webkitCompassAccuracy', 'webkitCompassHeading']) {
    assert.ok(!KEYS.includes(name), `${name} is a key now: the table has to name it`)
    assert.doesNotMatch(DOC, new RegExp(`line\\.${name}\\b`), `a procedure reads line.${name}, which the line does not have under that name`)
  }
})

test('what the table says of the compass columns is what the code does: magnetic, paired with the pose, the three axis words, invalid means negative, an iPhone has no absolute flag', () => {
  assert.match(fieldRow('B'), /\*\*magnetic\*\* north/)
  assert.match(fieldRow('B'), /no declination is applied/)
  // B is what the calibration is given: the compass paired with the pose (GeoTracker.pairedCompass), not the bare heading.
  assert.match(fieldRow('B'), /`GeoTracker\.pairedCompass`/)
  // Android's B is where the camera points, from alpha, beta and gamma: not `360 - alpha`, which is the top edge's.
  assert.match(fieldRow('B'), /on Android the direction the back camera points, worked out from `alpha`, `beta` and `gamma`/)
  assert.doesNotMatch(fieldRow('B'), /360 [−-] alpha/)
  assert.doesNotMatch(DOC, /`360 [−-] alpha` on Android/)
  for (const axis of ['camera', 'top', 'unknown']) assert.ok(fieldRow('ax').includes(`\`${axis}\``), `the ax row does not name ${axis}`)
  // The three words are the ones the code can write: a camera, a top edge and an iPhone.
  const words = new Set(
    [{ absolute: true, alpha: 10, beta: 90, gamma: 0 }, { absolute: true, alpha: 10, beta: 0, gamma: 0 }, { webkitCompassHeading: 10 }]
      .map((e) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent)?.axis),
  )
  assert.deepEqual([...words].sort(), ['camera', 'top', 'unknown'])
  // A heading under ?compass=alpha says `unknown`, as the ax row says.
  assert.equal(compassReadingFromEvent({ absolute: true, alpha: 10, beta: 90, gamma: 0 } as unknown as DeviceOrientationEvent, 'alpha')?.axis, 'unknown')
  assert.match(fieldRow('ax'), /any heading under `\?compass=alpha`/)
  // A negative accuracy is iOS saying the heading is invalid, and then there is no B.
  assert.match(fieldRow('wkHead'), /negative means iOS says the heading is invalid/)
  assert.equal(compassReadingFromEvent({ webkitCompassHeading: 10, webkitCompassAccuracy: -1 } as unknown as DeviceOrientationEvent), null)
  // The camera is used within 60 degrees of level, which is where half of it is horizontal.
  assert.ok(Math.abs((Math.acos(MIN_AXIS_HORIZONTAL) * 180) / Math.PI - 60) < 1e-9)
  assert.match(fieldRow('ax'), /more than 60° up or down/)
  assert.match(fieldRow('B'), /more than 60° up or down/)
  // An iPhone's event has no `absolute` property, so the flag is null there and not 0, and the table says so.
  assert.match(fieldRow('abs'), /`null` when the event has no such property, which is every event on an iPhone/)
  assert.doesNotMatch(fieldRow('abs'), /an iPhone's are 0/)
  assert.equal(rawOrientationOf({ webkitCompassHeading: 10, alpha: 1, beta: 2, gamma: 3 } as unknown as DeviceOrientationEvent).absolute, null)
  assert.equal(buildProbeRecord({ ...READING, compassSample: { raw: rawOrientationOf({ webkitCompassHeading: 10, alpha: 1, beta: 2, gamma: 3 } as unknown as DeviceOrientationEvent), reading: null } }).abs, null)
  // The turn row names the function that makes the column.
  assert.match(fieldRow('turn'), /`screenTurnDeg` in `src\/geo\/compass-heading\.ts`/)
  assert.equal(typeof screenTurnDeg, 'function')
  assert.match(fieldRow('turn'), /`null` when gravity cannot be read in the screen's plane/)
})

test('the spin test and the survey say which axis the compass follows, which north it is from, and what the bench shows', () => {
  const spin = section('#### B2 step 4: the compass spin test').replace(/\s+/g, ' ')
  assert.doesNotMatch(spin, /the compass reports the phone's own axis/, 'that was true of 360 - alpha and is not true of the camera axis')
  assert.match(spin, /On Android `B` is where the camera points: its own bearing while the camera is within 60° of level \(`via camera`\)/)
  assert.match(spin, /`line\.turn`/)
  const survey = section('### Procedure 4 — compass sign, handedness and offset (DX3)').replace(/\s+/g, ' ')
  assert.match(survey, /on Android the direction the camera points, worked out from `alpha`, `beta` and `gamma`/)
  assert.doesNotMatch(survey, /`alpha` on Android, as `src\/geo\/geo-tracker\.ts` reads them/)
  assert.match(survey, /Every bearing it shows is from magnetic north/)
  assert.match(survey, /held upright and its back camera pointing at the mark/)
  // The earlier heading can be run on the same phone, and the document says how and what its lines will say.
  assert.match(survey, /do the list a third time with `&compass=alpha` added to the address: its lines say `line\.ax` `unknown`/)
})

test('the readout line the spin test describes is the one the code writes: the same fields in the same order, and the four words `via` can say', () => {
  const spin = section('#### B2 step 4: the compass spin test').replace(/\s+/g, ' ')
  assert.ok(spin.includes('`compass B · yaw Y · B+yaw S · B-yaw D · rule R · via V`'), 'the document shows the line with its via')
  const terms = compassSpinTerms(90, aboutY(-90))
  for (const via of ['camera', 'top', 'platform', 'withheld']) {
    const line = formatCompassSpin(terms, BEARING_CONVENTION, via)
    assert.ok(/^compass \d+ · yaw -?\d+ · B\+yaw \d+ · B-yaw \d+ · rule 2 · via \w+$/.test(line), line)
    assert.ok(line.endsWith(` · via ${via}`))
    assert.ok(spin.includes(`\`${via}\``), `the document does not say what via ${via} is`)
  }
  assert.equal(formatCompassSpin(null, BEARING_CONVENTION, 'withheld'), 'compass none · rule 2 · via withheld', 'a reading that is withheld reads none, with the reason')
  assert.match(spin, /the line then reads `compass none`/)
  assert.match(spin, /`&compass=alpha`/)
})

test("Procedure 4 names the function and the floor the iPhone comparison uses, and they are what the code has", () => {
  const text = section('### Procedure 4 — compass sign, handedness and offset (DX3)').replace(/\s+/g, ' ')
  // The recipe's two candidates come from a function that gives each axis its own bearing, not from the one that picks an axis.
  assert.match(text, /`axisHeadingsFromAttitude\(line\.alpha, line\.beta, line\.gamma\)` in `src\/geo\/compass-heading\.ts`/)
  assert.match(text, /It is not `headingFromAttitude`, which picks one axis/)
  assert.match(text, /`IOS_COMPASS_SIGMA_FLOOR_DEG` in `src\/geo\/compass-heading\.ts`/)
  assert.match(text, /at least 25° of uncertainty/)
  assert.equal(IOS_COMPASS_SIGMA_FLOOR_DEG, 25)
  // Where the rule has fallen back to the top edge (landscape, the camera 70 degrees down), it gives the top edge for BOTH
  // candidates, which is why the recipe cannot use it; the helper gives the camera its own bearing there.
  assert.deepEqual(headingFromAttitude(100, 0, 20), { headingDeg: 260, axis: 'top' })
  const both = axisHeadingsFromAttitude(100, 0, 20)!
  assert.ok(Math.abs(both.camera.headingDeg! - 170) < 1e-9, `the camera faces ${both.camera.headingDeg}`)
  assert.ok(Math.abs(both.top.headingDeg! - 260) < 1e-9)
  // The recipe subtracts the top edge's bearing, 360 - alpha, which is what the helper gives for it, and says to leave out an axis that is nearly vertical.
  assert.match(text, /`top\.headingDeg`, which is `360 − line\.alpha` when `line\.beta` is between −90 and 90/)
  assert.equal(axisHeadingsFromAttitude(100, 20, 0)!.top.headingDeg, 260)
  assert.match(text, /where its `horizontal` is under 0\.5/)
})

// ── Collecting ───────────────────────────────────────────────────────────────────────────────

/** One probe line, as the phone writes it, for tap `n`. */
function probeLine(n: number, over: Partial<ProbeReading> = {}): string {
  return formatProbeLine(buildProbeRecord({
    n, runtime: 'webxr', scaleMode: 'webxr-metric', calibration: undefined, hit: null,
    pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, tap: { x: 0.5, y: 0.5 },
    trackingStatus: 'NORMAL', trackingReason: null, poseJumps: 0, bearing: null, screenAngle: null, firstPose: null,
    ...over,
  }))
}

/** The script between the single quotes of the document's `node -e '...'`: run with this node and no shell, so the shell's only job (stripping the quotes) is not needed. */
function collectionScript(): string {
  const script = section('### The probe line').match(/```bash\nnode -e '([^'\n]+)'\n```/)?.[1]
  assert.ok(script, 'the probe section gives a node one-liner')
  return script
}

/** Runs the collection command in a directory whose scans/client-logs.jsonl holds `rows`, and returns what it prints. */
function collect(rows: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'probe-doc-'))
  try {
    mkdirSync(join(dir, 'scans'))
    writeFileSync(join(dir, 'scans', 'client-logs.jsonl'), rows.join('\n'))
    return execFileSync(process.execPath, ['-e', collectionScript()], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The shape the server writes (server/wp-a-client-logs.ts ClientLogRecord), one JSON object per line. */
const logRow = (msg: unknown, ts: number, ip = '100.64.0.1', ua = 'Phone A') =>
  JSON.stringify({ ts, level: 'warn', msg, stack: undefined, url: '/', ua, ip })

const iso = (ms: number) => new Date(ms).toISOString()
const json = (line: string) => line.slice(PROBE_LINE_PREFIX.length)

test('the collection command prints the probe lines of a client-logs file, and only those', () => {
  const probeA = probeLine(1)
  const probeB = probeLine(2)
  const out = collect([
    logRow('[8thwall] trackingStatus: NORMAL', 1_000),
    logRow(probeA, 2_000),
    'not json at all',
    logRow(undefined, 2_500),
    logRow(probeB, 3_000),
    logRow('[probe-ish] but not a probe line', 4_000),
    '',
  ])
  assert.deepEqual(out, [
    `${iso(2_000)} 100.64.0.1 ${json(probeA)}`,
    `${iso(3_000)} 100.64.0.1 ${json(probeB)}`,
  ])
  assert.equal(JSON.parse(out[1]!.split(' ').slice(2).join(' '))['n'], 2, 'what it prints is the JSON of the line')
})

test("the collection command's first column is the phone's clock as an ISO time, not the time the server received the line", () => {
  // `ts` in the log is the entry's own time (server/wp-a-client-logs.ts keeps the one the phone sent), so a document that
  // says "the time each line arrived" sends a person to compare it with the box's clock and find them different.
  const [line] = collect([logRow(probeLine(1), 1_730_455_200_123)])
  assert.ok(line!.startsWith('2024-11-01T10:00:00.123Z '), line)
  const claims = section('### The probe line')
  assert.match(claims, /on the phone's own\s+clock/)
  assert.doesNotMatch(claims, /time each line arrived/)
})

test('the collection command tells two phones apart, and says GAP where a phone\'s line is missing', () => {
  const out = collect([
    // Phone A: 1, 2, then 3 is lost and 4 arrives, then a new page.
    logRow(probeLine(1), 1_000, '100.64.0.1', 'Phone A'),
    logRow(probeLine(1), 1_100, '100.64.0.2', 'Phone B'),
    logRow(probeLine(2), 2_000, '100.64.0.1', 'Phone A'),
    logRow(probeLine(2), 2_100, '100.64.0.2', 'Phone B'),
    logRow(probeLine(4), 4_000, '100.64.0.1', 'Phone A'),
    logRow(probeLine(1), 5_000, '100.64.0.1', 'Phone A'),
    logRow(probeLine(2), 6_000, '100.64.0.1', 'Phone A'),
    // Phone B's first line is the second tap of a page: its first was lost.
    logRow(probeLine(2), 7_000, '100.64.0.2', 'Phone B'),
  ])
  const gaps = out.map((row) => (/ GAP \{/.test(row) ? 'GAP' : 'ok'))
  assert.deepEqual(gaps, ['ok', 'ok', 'ok', 'ok', 'GAP', 'ok', 'ok', 'GAP'], out.join('\n'))
  assert.ok(out[0]!.includes(' 100.64.0.1 ') && out[1]!.includes(' 100.64.0.2 '), 'the address is the second column')
  assert.match(out[4]!, /^\S+ 100\.64\.0\.1 GAP \{"v":1,"n":4,/, 'the marker sits in front of the line it belongs to, and the line is still the line')
  assert.equal(JSON.parse(out[4]!.replace(/^\S+ \S+ GAP /, ''))['n'], 4)
})

test('the collection command does not mistake a repeated or reset n for a gap', () => {
  const out = collect([
    logRow(probeLine(1), 1_000), logRow(probeLine(2), 2_000), logRow(probeLine(3), 3_000),
    logRow(probeLine(1), 4_000), // a new page
    logRow(probeLine(2), 5_000),
  ])
  assert.equal(out.filter((row) => row.includes(' GAP ')).length, 0, out.join('\n'))
})

test('the document tells the person to look for gaps and to run that session again, and names why a line goes missing', () => {
  const probe = section('### The probe line')
  assert.match(probe, /\*\*Check for gaps\.\*\*/)
  assert.match(probe, /`GAP`/)
  assert.match(probe, /Do not fill one by hand: run that session again/)
  assert.match(probe, /keeps the last 50 messages and sends a batch\s+every 3 s/)
})

test("the numbers the document gives about the relay are the relay's own, and the wait it asks for is longer than the flush", () => {
  const relay = readFileSync(join(ROOT, 'src/debug/remote-log.ts'), 'utf8')
  const buffered = Number(/const MAX_BUFFERED = (\d+)/.exec(relay)?.[1])
  const flushMs = Number(/const FLUSH_INTERVAL_MS = ([\d_]+)/.exec(relay)?.[1]?.replace(/_/g, ''))
  assert.ok(buffered > 0 && flushMs > 0, 'src/debug/remote-log.ts no longer has MAX_BUFFERED or FLUSH_INTERVAL_MS: the document must be checked against what replaced them')
  const probe = section('### The probe line').replace(/\s+/g, ' ')
  assert.ok(probe.includes(`keeps the last ${buffered} messages and sends a batch every ${flushMs / 1000} s`), `the document no longer says the relay keeps ${buffered} messages and sends a batch every ${flushMs / 1000} s`)
  const wait = Number(/wait (\w+) seconds after your last tap/i.exec(probe)?.[1] === 'five' ? 5 : NaN)
  assert.ok(wait * 1000 > flushMs, `${wait} s is not longer than the ${flushMs} ms flush, so the last line could still be on the phone when the tab closes`)
})

test('the document says to arm the relay as well as the probe, and the commands carry both', () => {
  const probe = section('### The probe line')
  assert.match(probe, /npm run qr -- "\?debug=remote,probe"/)
  assert.match(probe, /npm run qr -- "webxr\.html\?debug=remote,probe"/)
  assert.match(probe, /Without `remote` they stay in the phone's console/)
  assert.match(probe, /wait five seconds after your last tap/i, 'the relay flushes every 3 s: a tab closed at once can lose the last line')
})

// ── The experiments, as the investigation set them ───────────────────────────────────────────

test('Procedure 2 sets the marks, the repeats and the pass rule of DX2', () => {
  const text = section('### Procedure 2 — probe-point protocol (DX2)')
  assert.match(text, /\*\*A\*\* \| The landmark/)
  assert.match(text, /\*\*B\*\* \| 2 m from A\. Moved to 1\.2 m and to 4 m for the repeats/)
  assert.match(text, /\*\*C\*\* \| About 4 m from A and about 2\.5 m off the A–B line/)
  assert.match(text, /\*\*D\*\* \| About 6 m from A/)
  assert.match(text, /five sessions each, on each of iPhone Safari \(8th\s+Wall\), Android Chrome \(8th Wall\) and Android Chrome through `webxr\.html`/)
  assert.match(text, /probe D only/, 'the three-point repeat probes D')
  assert.match(text, /largest of the five errors at D is \*\*15 cm or less\*\*/)
  assert.match(text, /30\.5 cm/, 'the product target the pass rule is compared with')
  // The button was "Use anyway" until WP-08 renamed it, because it replaces the Place's one saved reference and now says so.
  assert.match(text, /\*\*Do not choose "Replace this Place's reference"\*\*/, 'it would rewrite the Place frame the next session is judged against')
})

test("Procedure 2's own numbers agree: the ground truth needs the five distances it lists, and the 95th percentile of five is the largest", () => {
  const text = section('### Procedure 2 — probe-point protocol (DX2)')
  assert.match(text, /\*\*A–B, A–C, B–C, A–D and B–D\*\*/)
  // The formula it gives is trilateration: check it recovers a point from the two distances it asks for.
  const s = 2
  const truth = { x: 2.5, z: 3.1 }
  const dA = Math.hypot(truth.x, truth.z)
  const dB = Math.hypot(truth.x, truth.z - s)
  const zTrue = (dA ** 2 - dB ** 2 + s ** 2) / (2 * s)
  const xTrue = Math.sqrt(dA ** 2 - zTrue ** 2)
  assert.ok(Math.abs(zTrue - truth.z) < 1e-12 && Math.abs(xTrue - truth.x) < 1e-12)
  assert.match(text, /`z_true = \(dA² − dB² \+ s²\) \/ \(2s\)` and `x_true = √\(dA² − z_true²\)`/)
  // Nearest rank: ceil(0.95 * 5) = 5, the largest.
  assert.equal(Math.ceil(0.95 * 5), 5)
})

/** The standard normal distribution function (Abramowitz and Stegun 7.1.26 for erf: good to 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

test("Procedure 2's short baseline clears the scanner's own minimum: a 1.2 m pair is all but never blocked, and a 1.0 m pair would be blocked half the time", () => {
  const text = section('### Procedure 2 — probe-point protocol (DX2)')
  const short = Number(/Moved to ([\d.]+) m and to (\d+) m for the repeats/.exec(text)?.[1])
  assert.ok(short > 0, 'the marks table names the short baseline')
  // The scanner disables "Use this alignment" under MIN_POINT_SEPARATION_M (project-calibration.ts). Two independent taps,
  // each with per-axis noise sigma, differ along the baseline by sigma * sqrt(2). 3 cm is the noise src/world/geo.ts's
  // comment on MIN_POINT_SEPARATION_M assumes; 5 cm is the worse case the investigation also ran. Neither is measured:
  // the numbers only say how much room the short baseline leaves if they are about right.
  const blocked = (baselineM: number, sigmaM: number): number => normalCdf((MIN_POINT_SEPARATION_M - baselineM) / (sigmaM * Math.SQRT2))
  assert.ok(blocked(short, 0.03) < 0.01, `a ${short} m baseline is blocked in ${(blocked(short, 0.03) * 100).toFixed(1)}% of sessions at 3 cm noise`)
  assert.ok(blocked(short, 0.05) < 0.01, `a ${short} m baseline is blocked in ${(blocked(short, 0.05) * 100).toFixed(1)}% of sessions at 5 cm noise`)
  assert.ok(Math.abs(blocked(MIN_POINT_SEPARATION_M, 0.03) - 0.5) < 1e-6, 'at exactly the minimum it is half, whatever the noise: the reason the document gives')
  assert.ok(short > MIN_POINT_SEPARATION_M, 'the baseline the document sets is above the minimum the scanner enforces')
  // The document says so in words a person reading step 3 will find.
  assert.match(text, /\*\*Why the short baseline is 1\.2 m and not 1 m\.\*\*/)
  assert.match(text, /MIN_POINT_SEPARATION_M/)
  assert.match(text, /about half of all sessions, whatever the tap noise is/)
})

test('Procedure 2 says what to do when the scanner will not accept the pair, and does not let a blocked session be tapped through', () => {
  const text = section('### Procedure 2 — probe-point protocol (DX2)')
  const flat = text.replace(/\s+/g, ' ')
  assert.match(flat, /the markers are too close together, the session is \*\*blocked\*\*/)
  assert.match(flat, /Do not walk further or tap again until the button comes on, because that measures a longer baseline than the one you taped/)
  assert.match(flat, /A blocked session is not one of the five: run another, and count the blocked ones for each baseline/)
  assert.match(flat, /Sessions blocked as too close together: ______ of ______ started/, 'the results record how often it happened')
  // The words the scanner really shows, so the document names the state the person will see.
  const card = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')
  assert.ok(card.includes('The markers are too close together to fix a reliable heading.'), 'the card no longer says this: the document names a state that is not there')
  assert.ok(card.includes("show(commitBtn, stage === 'review')") && card.includes('commitBtn.disabled = !farEnough'), 'the commit button is still disabled under the minimum')
})

// ── What the document says each field means, held to the code ────────────────────────────────

/** The table row for a field of the line. */
function fieldRow(key: string): string {
  const table = section('### The probe line').split('\n').filter((row) => /^\| `/.test(row))
  const found = table.find((row) => row.split('|')[1]!.includes(`\`${key}\``))
  assert.ok(found, `the table has no row for ${key}`)
  return found
}

type Quat = { x: number; y: number; z: number; w: number }
const aboutX = (deg: number): Quat => ({ x: Math.sin((deg * Math.PI) / 360), y: 0, z: 0, w: Math.cos((deg * Math.PI) / 360) })
const aboutY = (deg: number): Quat => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) })
/** The direction a camera at this rotation looks along: its own -Z. */
const forward = ({ x, y, z, w }: Quat) => ({ x: -2 * (x * z + w * y), y: -2 * (y * z - w * x), z: -(1 - 2 * (x * x + y * y)) })

const READING: ProbeReading = {
  n: 1, runtime: '8thwall', scaleMode: null, calibration: undefined, hit: null,
  pose: { position: { x: 0, y: 1.3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, tap: { x: 0.5, y: 0.5 },
  trackingStatus: 'NORMAL', trackingReason: null, poseJumps: 0, bearing: 100, screenAngle: 0, firstPose: null,
}

test("`pitch` means what the table says: 0 level, -90 straight down, positive looking up", () => {
  assert.match(fieldRow('pitch'), /0 level, −90 straight down, positive looks up/)
  const down = aboutX(-90)
  assert.ok(forward(down).y < -0.999, 'a camera at this rotation looks straight down')
  assert.ok(Math.abs(cameraPitchDeg(down)! + 90) < 1e-9, 'and the line writes -90 for it')
  assert.ok(Math.abs(cameraPitchDeg({ x: 0, y: 0, z: 0, w: 1 })!) < 1e-9, 'level is 0')
  assert.ok(Math.abs(cameraPitchDeg(aboutX(30))! - 30) < 1e-9 && forward(aboutX(30)).y > 0, 'looking up is positive')
  assert.equal(buildProbeRecord({ ...READING, pose: { position: { x: 0, y: 1, z: 0 }, rotation: down } }).pitch, -90, 'in the line itself')
})

test('`yaw` means what the table says: 0 faces session +Z and 90 faces session +X', () => {
  assert.match(fieldRow('yaw'), /0 is session \+Z, 90 is session \+X/)
  const facingZ = aboutY(180)
  const facingX = aboutY(-90)
  assert.ok(forward(facingZ).z > 0.999 && Math.abs(forward(facingZ).x) < 1e-9, 'this rotation faces +Z')
  assert.ok(forward(facingX).x > 0.999 && Math.abs(forward(facingX).z) < 1e-9, 'this one faces +X')
  assert.equal(buildProbeRecord({ ...READING, pose: { ...READING.pose, rotation: facingZ } }).yaw, 0)
  assert.equal(buildProbeRecord({ ...READING, pose: { ...READING.pose, rotation: facingX } }).yaw, 90)
})

test('`px`, `py`, `pz` mean what the table says: the origin is the landmark, +Z is towards the heading marker, +Y is up', () => {
  assert.match(fieldRow('px'), /origin at the landmark, \+Z towards the heading marker, \+Y up/)
  const landmark = { x: 1.5, y: -1.2, z: -0.4 }
  const marker = { x: 3.1, y: -1.2, z: 1.9 }
  const calibration: ScanCalibration = {
    method: 'two-point-ground', sessionToProject: twoPointToProjectTransform(landmark, marker), separationM: twoPointSeparationM(landmark, marker),
    residualM: 0, toleranceM: 0.15, anchorBearingDeg: null, calibratedAt: '2026-11-01T10:00:00.000Z', status: 'provisional',
  }
  const at = (position: { x: number; y: number; z: number }) => buildProbeRecord({ ...READING, calibration, hit: { position, distance: 2 } })
  assert.deepEqual([at(landmark).px, at(landmark).py, at(landmark).pz], [0, 0, 0], 'the landmark is the origin')
  const toMarker = at(marker)
  assert.deepEqual([toMarker.px, toMarker.py], [0, 0])
  assert.ok(Math.abs(toMarker.pz! - calibration.separationM) < 1e-3, 'the heading marker is on +Z, at the separation')
  assert.equal(at({ ...landmark, y: landmark.y + 1 }).py, 1, '+Y is up')
})

test("`rt` names the two runtimes the scanner passes, and `B + yaw` is what sessionFrameBearingDeg computes (`B - yaw` is the earlier rule)", () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  const call = main.slice(main.indexOf('installProbeLog({'), main.indexOf('})', main.indexOf('installProbeLog({')))
  const runtimes = [...(/runtime: use8thWall \? '([a-z0-9]+)' : '([a-z0-9]+)'/.exec(call) ?? []).slice(1)]
  assert.equal(runtimes.length, 2, 'main.ts passes one of two runtime words')
  for (const runtime of runtimes) assert.ok(fieldRow('rt').includes(`\`${runtime}\``), `the table's rt row does not name \`${runtime}\``)
  // Bplus is the compass bearing plus the camera yaw, which is what geo.ts's sessionFrameBearingDeg returns under the
  // current rule; Bminus is what it returned under the earlier one, which ?bearing=1 still selects.
  assert.match(fieldRow('Bplus'), /`sessionFrameBearingDeg`/)
  assert.match(fieldRow('Bminus'), /earlier rule/)
  for (const [bearing, rotation] of [[100, aboutY(-90)], [10, aboutY(-30)], [359, aboutY(170)], [0, aboutX(-40)]] as const) {
    const record = buildProbeRecord({ ...READING, bearing, pose: { ...READING.pose, rotation } })
    const fromGeo = sessionFrameBearingDeg(bearing, rotation)!
    const fromLegacy = sessionFrameBearingDeg(bearing, rotation, LEGACY_BEARING_CONVENTION)!
    assert.ok(Math.abs(((record.Bplus! - fromGeo + 540) % 360) - 180) < 0.11, `B + yaw is ${record.Bplus}, sessionFrameBearingDeg says ${fromGeo}`)
    assert.ok(Math.abs(((record.Bminus! - fromLegacy + 540) % 360) - 180) < 0.11, `B - yaw is ${record.Bminus}, the earlier rule says ${fromLegacy}`)
  }
})

/**
 * One probe line, as a provider produces it: a tap on a stand-in canvas, read back through the probe's own listeners. The provider
 * is the real object. It has no session, so the wrapper says it is tracking and gives it a pose; everything the line reads from
 * `getTrackingDiagnostics` and `scaleMode` is the provider's own.
 */
async function lineFrom(real: object, runtime: string): Promise<Record<string, unknown>> {
  const listeners = new Map<string, (event: unknown) => void>()
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: () => {},
  }
  const provider = Object.assign(Object.create(real), {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  })
  const lines: string[] = []
  const deps = {
    canvas, provider, runtime, hitTest: () => null, calibration: () => null, bearing: () => null, firstPose: () => null,
    emit: (line: string) => lines.push(line), screenAngle: () => 0,
  } as unknown as ProbeLogDeps
  const stop = installProbeLog(deps, '?debug=probe')
  assert.equal(typeof stop, 'function')
  listeners.get('pointerdown')!({ clientX: 50, clientY: 50, pointerType: 'mouse' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(lines.length, 1, 'one tap is one line')
  return JSON.parse(lines[0]!.slice(PROBE_LINE_PREFIX.length)) as Record<string, unknown>
}

test('both runtimes the line is written for count frame shifts and name a scale mode, so neither field is null on either, as the document says; a provider with neither logs null', async () => {
  const globals = globalThis as Record<string, unknown>
  const before = { document: globals['document'], window: globals['window'], self: globals['self'] }
  globals['document'] = { body: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({}), querySelector: () => null }
  globals['window'] = { location: { search: '' }, innerWidth: 360, innerHeight: 640, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} }
  globals['self'] = { requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
  try {
    const webxr = await lineFrom(new WebXRProvider(), 'webxr')
    const eighthwall = await lineFrom(new EighthWallProvider(), '8thwall')
    const bare = await lineFrom({ trackingStatus: () => 'NORMAL' }, 'webxr')
    assert.equal(webxr['jumps'], 0, 'the WebXR provider keeps a count: a number, not the null the document used to promise')
    assert.equal(eighthwall['jumps'], 0)
    assert.equal(webxr['scale'], 'webxr-metric')
    assert.equal(eighthwall['scale'], 'responsive-unconfigured', 'what a page that names no scale gets')
    assert.deepEqual([bare['jumps'], bare['scale']], [null, null], 'a provider with no count and no scale mode is the only one with a null')
    // What the document shows and says is what those two lines are.
    const probe = section('### The probe line')
    const example = JSON.parse(probe.match(/^\[probe\] (\{.*\})$/m)![1]!) as Record<string, unknown>
    assert.equal(example['rt'], '8thwall')
    assert.deepEqual([example['scale'], example['jumps']], [eighthwall['scale'], eighthwall['jumps']], 'the example line is what the real 8th Wall provider writes before any tap')
    const flat = probe.replace(/\s+/g, ' ')
    assert.ok(flat.includes('`line.scale` is `null` only for a provider that names no scale mode, and `line.jumps` only for one that keeps no count of frame shifts. Both runtimes the line is written for (8th Wall and WebXR) name a scale mode and keep a count, so on either a `line.jumps` of 0 means none counted.'))
    assert.match(fieldRow('jumps'), /Both runtimes count, so 0 is "none counted"\. `null` only for a provider that keeps no count/)
    assert.doesNotMatch(probe, /null` on (?:the )?WebXR|keeps no count of frame shifts, and `line\.px`|until the build can say which scale mode/)
    // The scale strings the table names are modes the build writes, and it names the two runtimes' own.
    const named = [...fieldRow('scale').matchAll(/`((?:responsive|absolute|webxr|native)-[A-Za-z]+(?::[0-9.]+|:<n>)?)`/g)].map((m) => m[1]!.replace(':<n>', ':1.5'))
    assert.deepEqual(named.map((mode) => asScaleMode(mode)), named, 'every string in the scale row is a scale mode')
    assert.ok(named.includes(webxr['scale'] as string) && named.includes(eighthwall['scale'] as string))
    assert.equal(named.length, 6)
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
})

test('what `jumps` counts is what the table says: a measured jump or a reset is a frame shift, and a resume with no measured step is an interruption the card shows apart', () => {
  const tracker = new FrameEpochTracker()
  const pose = { position: { x: 0, y: 1.3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  tracker.observe({ tMs: 0, pose, status: 'NORMAL' })
  tracker.observe({ tMs: 33, pose, status: 'NORMAL' })
  assert.ok(tracker.noteResume(1_000, 5_000))
  const resumed = tracker.diagnostics()
  assert.deepEqual([resumed.poseJumps, resumed.epoch], [0, 1], 'a resume starts an epoch and counts no jump')
  assert.match(describeTracking(resumed).text, /tracking interrupted 1 time/)
  assert.doesNotMatch(describeTracking(resumed).text, /frame shift/)
  tracker.observe({ tMs: 1_033, pose, status: 'NORMAL' })
  assert.ok(tracker.noteReset(2_000, null))
  const reset = tracker.diagnostics()
  assert.equal(reset.poseJumps, 1, 'a reset is counted')
  assert.match(describeTracking(reset).text, /1 frame shift/)
  assert.equal(buildProbeRecord({ ...READING, poseJumps: reset.poseJumps }).jumps, 1)
  const row = fieldRow('jumps').replace(/\s+/g, ' ')
  assert.ok(row.includes('measured pose jumps and the resets the runtime reports (the same count as the calibration card\'s "frame shifts")'))
  assert.ok(row.includes('A recovery or a resume that came with no measured step is not in it: the card shows those as "tracking interrupted", and the line does not carry them.'))
  assert.equal(buildProbeRecord({ ...READING, poseJumps: null }).jumps, null)
  assert.equal(buildProbeRecord({ ...READING, poseJumps: 0 }).jumps, 0, 'a counter that reads 0 is a 0')
})

test('the document\'s sign convention for turning on the spot is the one the arithmetic gives: the SUM holds still and the DIFFERENCE moves by twice the turn', () => {
  // A person turning right by t degrees raises the compass bearing by t. In a right-handed session frame a right turn is a
  // rotation about +Y by -t, which lowers the camera yaw by t. This derives which column holds still from the code, and
  // then holds the document's wording to that: the pass rule names the right column for each half, and the introduction
  // says the sum is the one that should hold still.
  const START = 40
  const lineAfterTurning = (turn: number) => buildProbeRecord({ ...READING, bearing: (START + turn) % 360, pose: { ...READING.pose, rotation: aboutY(-turn) } })
  const gap = (a: number, b: number) => Math.abs((((a - b + 180) % 360) + 360) % 360 - 180)
  const holdsStill = (['Bplus', 'Bminus'] as const).filter((column) =>
    [90, 180, 270].every((turn) => gap(lineAfterTurning(turn)[column]!, lineAfterTurning(0)[column]!) < 0.2))
  const moves = (['Bplus', 'Bminus'] as const).filter((column) =>
    [90, 180, 270].every((turn) => gap(lineAfterTurning(turn)[column]!, lineAfterTurning(0)[column]! + 2 * turn) < 0.2))
  assert.deepEqual(holdsStill, ['Bplus'])
  assert.deepEqual(moves, ['Bminus'])

  const text = section('### Procedure 4 — compass sign, handedness and offset (DX3)').replace(/\s+/g, ' ')
  const stillColumn = /- `line\.(\w+)` should be within \*\*5°\*\* of its value at T0\./.exec(text)?.[1]
  const movingColumn = /- `line\.(\w+)` should be within \*\*5°\*\* of its value at T0 \*\*plus 2 × \*t\*\*/.exec(text)?.[1]
  assert.equal(stillColumn, holdsStill[0], 'the pass rule names the wrong column as the one that holds still')
  assert.equal(movingColumn, moves[0], 'the pass rule names the wrong column as the one that moves by twice the turn')
  const word = /it is the \*\*(\w+)\*\* that should hold still while turning on the spot, and the (\w+) that should move by twice the turn/.exec(text)
  assert.deepEqual([word?.[1], word?.[2]], ['sum', 'difference'], 'the introduction states the sign convention the arithmetic gives')
  // And the document's account of the code under test: sessionFrameBearingDeg adds the yaw (the earlier rule subtracted it).
  assert.match(text, /`sessionFrameBearingDeg` in `src\/world\/geo\.ts` joins a compass bearing and a camera yaw, and it \*\*adds\*\* the yaw/)
  assert.ok(Math.abs(sessionFrameBearingDeg(100, aboutY(-90))! - 190) < 1e-9, 'adds: 100 + 90')
  assert.ok(Math.abs(sessionFrameBearingDeg(100, aboutY(-90), LEGACY_BEARING_CONVENTION)! - 10) < 1e-9, 'the earlier rule subtracted: 100 - 90')
  assert.ok(Math.abs(cameraYawInSessionDeg(aboutY(-90)) - 90) < 1e-9)
})

test('Procedure 3 sets the tape, the heights, the run count and the decision rule of DX1', () => {
  const text = section('### Procedure 3 — units tape test (DX1)')
  assert.match(text, /\*\*3\.000 m\*\*/)
  assert.match(text, /\*\*5 runs at each of three start heights, 1\.0 m, 1\.3\s+m and 1\.6 m, on each runtime\*\*/)
  assert.match(text, /iPhone Safari \(8th Wall\), Android Chrome\s+\(8th Wall\), and Android Chrome through `webxr\.html`/)
  assert.match(text, /\?scale=absolute/)
  assert.match(text, /time from \*\*Start AR\*\*/)
  // 3% and 2% and 5% of the 3.000 m tape, as the decision rule writes them in metres.
  const tape = 3
  assert.equal(+(tape * (1 - 0.03)).toFixed(3), 2.91)
  assert.equal(+(tape * (1 + 0.03)).toFixed(3), 3.09)
  assert.equal(+(tape * 0.02).toFixed(3), 0.06)
  assert.equal(+(tape * 0.05).toFixed(3), 0.15)
  // Wrapped lines are one line to a reader, so the rule is read with its whitespace folded.
  const flat = text.replace(/\s+/g, ' ')
  for (const stated of ['within 3% of the tape (between 2.910 and 3.090 m)', 'under 2% (under 0.060 m)', 'over 5% (over 0.150 m)']) {
    assert.ok(flat.includes(stated), `the decision rule no longer says "${stated}"`)
  }
  assert.match(text, /Anything in between\*\* is not a decision/)
})

test('Procedure 4 sets the postures, the turns and the pass rule of DX3, and points the survey at the existing compass bench', () => {
  const text = section('### Procedure 4 — compass sign, handedness and offset (DX3)')
  for (const turn of ['+90', '−90', '180']) assert.ok(text.includes(turn), `the table of turns lacks ${turn}`)
  assert.match(text, /tilted down about 60°/)
  assert.match(text, /in landscape/)
  assert.match(text, /within \*\*5°\*\* of its value at T0 \*\*plus 2 × \*t\*\*/)
  assert.match(text, /\/compass-bench\.html/)
  assert.match(text, /\*\*three\*\* spots in the building/)
  assert.match(text, /about 50 m apart/)
  assert.match(text, /not a pass or fail/)
  assert.match(text, /write it down as the finding, not as a pass/)
})

test('the old Procedure 2 is gone and nothing in the document still sends a person to it', () => {
  assert.doesNotMatch(DOC, /cross-session calibration repeatability/)
  assert.doesNotMatch(DOC, /Not runnable yet/)
  assert.doesNotMatch(DOC, /Confirm it with the real Procedure 2 once 0004 ships/)
  assert.equal(DOC.match(/^### Procedure 2 /gm)?.length, 1, 'one Procedure 2')
})
