/**
 * Golden compatibility: every record the app writes today still validates, reads and round-trips through the
 * server's code unchanged after the S0 schema step. No field is dropped and none is invented.
 *
 * S0 adds optional fields to `ProjectSpatialFrame`, `ScanCalibration` and `ScanManifest`, and tightens
 * `validateSpatialFrame` for the frames that carry them. The one thing that must not happen is a Place or a
 * scan that was saved a day ago being refused, or read differently, by the build that follows. A frame the
 * server will not keep is a calibration that silently never reaches the Place (server/wp-a-projects.ts), and a
 * sidecar the server reads differently changes what the editor says about a scan. So this file holds the
 * schema to what the writers produce, in two ways:
 *
 *  1. LIVE. The writers run for real (./support/real-writers.ts): the calibration flow, the phone's frame upload
 *     and the scan export. What they return goes through `validateSpatialFrame`, the server's Place routes
 *     (`placeFromBody`, `applySpatialFrameWrite`) and `calibrationFromMeta`. These tests are about whatever
 *     the writers write at the time they run, so they keep holding when a later package gives a writer a new
 *     field: a frame must validate and come back as it went in, and a new manifest field must appear exactly when
 *     its source is on the record.
 *  2. FROZEN. tests/fixtures/place-frame/records-before-s0.json is what the writers wrote before S0, produced by
 *     the same harness and not edited by hand. A later writer will write more than that; these records are what
 *     is already on disk, in IndexedDB and in a service worker's queue, so they stay as they are and are
 *     compared with literal expectations.
 *
 * It needs no `deno` binary: the server modules it imports (`server/calibration_fields.ts`,
 * `server/wp-a-projects.ts`) reach `Deno` only inside functions this file does not call.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs, and `npm run verify` runs it), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-s0-golden.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adoptedFrameError,
  applySpatialFrameWrite,
  placeBodyError,
  placeFromBody,
} from '../../../server/wp-a-projects.ts'
import {
  asCalibrationMethod,
  calibrationEvidenceFromMeta,
  calibrationFromMeta,
  calibrationScaleFromMeta,
} from '../../../server/calibration_fields.ts'
import { retryPendingFrames, type FrameSyncEnv } from '../../../src/project/frame-sync.ts'
import { stampScale } from '../../../src/ar/engine-config.ts'
import { isPlaceFrameMethod, sameSpatialFrame, validateSpatialFrame } from '../../../src/world/spatial-frame.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'
import { opened } from './support/fake-indexeddb.ts'
import {
  runRealCalibration,
  realSidecar,
  sendFrameLikeThePhone,
  type FlowScenario,
} from './support/real-writers.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PLACE_ID = 'proj-1700000000000'
const NOW = 1_700_000_002_000

/** The Place a calibration is made in: no frame yet. */
const bareProject = (extra: Partial<Project> = {}): Project => ({
  projectId: PLACE_ID,
  name: 'Room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }],
  ...extra,
})

/** What crosses the wire is JSON: a field that is undefined does not arrive. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// ── What the manifest says about a scan, derived from the calibration record and nothing else ─────────

/** The six fields every manifest has, and the five that exist only when the record has their source. */
const ALWAYS = ['calibrationMethod', 'calibrationStatus', 'calibrationSeparationM', 'calibrationResidualM', 'calibrationToleranceM', 'calibratedAt']
const SOMETIMES = ['calibrationFrameId', 'calibrationCheckedBy', 'calibrationFitPointsUsed', 'calibrationFitRmsM', 'calibrationFitMaxM']

/**
 * Holds `calibrationFromMeta`'s answer for a sidecar to what the calibration record in it says. The six always-fields
 * are the record's own numbers (null where it has none). Each of the other five is on the manifest exactly when the
 * record has its source, and then holds the record's value: this is "none invented", and it does not depend on which
 * of them today's writers happen to produce.
 */
function assertManifestFollowsRecord(sidecar: Record<string, unknown>, calibration: ScanCalibration | null, label: string): void {
  const fields = calibrationFromMeta(sidecar) as Record<string, unknown>
  const record = (calibration ?? {}) as Record<string, unknown>
  const twoPoint = calibration?.method === 'two-point-ground'
  assert.deepEqual(
    Object.keys(fields).filter((key) => !ALWAYS.includes(key)).filter((key) => !SOMETIMES.includes(key)),
    [],
    `${label}: the manifest got a field this reader does not define`,
  )
  assert.equal(fields['calibrationMethod'], calibration?.method, `${label}: tier`)
  assert.equal(fields['calibrationStatus'], calibration?.status ?? 'uncalibrated', `${label}: status`)
  assert.equal(fields['calibrationSeparationM'], typeof record['separationM'] === 'number' ? record['separationM'] : null, `${label}: separation`)
  assert.equal(fields['calibrationResidualM'], typeof record['residualM'] === 'number' ? record['residualM'] : null, `${label}: residual`)
  assert.equal(fields['calibrationToleranceM'], typeof record['toleranceM'] === 'number' ? record['toleranceM'] : null, `${label}: tolerance`)
  assert.equal(fields['calibratedAt'], typeof record['calibratedAt'] === 'string' ? record['calibratedAt'] : null, `${label}: time`)

  const fit = (record['fit'] ?? {}) as Record<string, unknown>
  const source: Record<string, unknown> = {
    calibrationFrameId: twoPoint ? record['frameId'] : undefined,
    calibrationCheckedBy: twoPoint ? record['checkedBy'] : undefined,
    calibrationFitPointsUsed: twoPoint ? fit['pointsUsed'] : undefined,
    calibrationFitRmsM: twoPoint ? fit['rmsResidualM'] : undefined,
    calibrationFitMaxM: twoPoint ? fit['maxResidualM'] : undefined,
  }
  for (const key of SOMETIMES) {
    assert.equal(key in fields, source[key] !== undefined, `${label}: ${key} is on the manifest exactly when the record has it`)
    if (source[key] !== undefined) assert.equal(fields[key], source[key], `${label}: ${key} is the record's`)
  }

  // The five as the manifest builder lays them over a stored row: always keys, with the same values, so a refresh can clear one.
  const evidence = calibrationEvidenceFromMeta(sidecar) as Record<string, unknown>
  assert.deepEqual(Object.keys(evidence).sort(), [...SOMETIMES].sort(), `${label}: the five are keys whether or not the record has them`)
  for (const key of SOMETIMES) assert.equal(evidence[key], fields[key], `${label}: ${key} is the value calibrationFromMeta reads`)
  assert.deepEqual(JSON.parse(JSON.stringify({ ...fields, ...evidence })), JSON.parse(JSON.stringify(fields)), `${label}: and no key of them reaches the wire that the record does not have`)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1. LIVE: the writers, run now
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** A handful of sessions, as in calibration_bearing_flow.test.ts: a plain one, a turned and tilted one, a right turn, an about-face. */
const SETUPS: FlowScenario[] = [
  { psi: 0, turn: 0, down: 0, baselineBearing: 40 },
  { psi: 137, turn: 75, down: 60, baselineBearing: 123 },
  { psi: 300, turn: -120, down: 25, baselineBearing: 250 },
  { psi: 45, turn: 180, down: 60, baselineBearing: 5 },
]

interface Live {
  name: string
  scenario: FlowScenario
  calibration: ScanCalibration
  /** The Place frame the flow returned, when the frame changed. */
  frame?: ProjectSpatialFrame
  /** The same frame as the phone sends it, with the records of its reference photos. */
  sent?: ProjectSpatialFrame
}

const live: Live[] = []

async function run(name: string, scenario: FlowScenario): Promise<Live> {
  const result = await runRealCalibration(scenario)
  const entry: Live = { name, scenario, calibration: result.calibration, ...(result.spatialFrame ? { frame: result.spatialFrame } : {}) }
  if (result.spatialFrame && result.referencePhotos) {
    entry.sent = (await sendFrameLikeThePhone(bareProject(), result.spatialFrame, result.referencePhotos)).body.frame
  }
  live.push(entry)
  return entry
}

for (const setup of SETUPS) {
  const tag = `start ${setup.psi}, turned ${setup.turn}`
  await run(`first two-point calibration (${tag})`, { ...setup })
  await run(`first one-point calibration (${tag})`, { ...setup, tier: 'one-point' })
}
const first = await run('first two-point calibration, both points named, with photos', {
  labels: { landmark: 'north door frame', heading: 'radiator corner' },
  photos: true,
})
await run('first two-point calibration, no compass reading', { compass: 'none' })
await run('first two-point calibration, only point B named', { labels: { heading: 'sink' }, photos: true })
await run('two-point visit against the frame with photos, spacing 3 cm off', {
  stored: first.sent,
  baselineM: first.frame!.method === 'two-point-ground' ? first.frame!.separationM + 0.03 : 2.4,
})
const plainFirst = await run('first two-point calibration, plain', {})
await run('two-point visit against a plain frame, spacing 3 cm short', {
  stored: plainFirst.frame,
  baselineM: plainFirst.frame!.method === 'two-point-ground' ? plainFirst.frame!.separationM - 0.03 : 2.4,
})
await run('two-point visit kept after a mismatch ("Use anyway")', { stored: plainFirst.frame, baselineM: 3.6, override: true })
const onePointFirst = await run('first one-point calibration, plain', { tier: 'one-point' })
await run('one-point visit against a one-point Place', { tier: 'one-point', stored: onePointFirst.frame })

for (const entry of live) {
  const label = entry.name

  if (entry.frame) {
    test(`live: the frame from "${label}" is accepted and kept as it came`, () => {
      for (const sent of [entry.frame!, overTheWire(entry.frame!)]) {
        const check = validateSpatialFrame(sent, { projectId: PLACE_ID })
        assert.ok(check.ok, check.ok ? '' : check.error)
        assert.deepEqual(check.frame, sent, 'no field dropped, none invented')
        assert.ok(sameSpatialFrame(check.frame, sent))
      }
    })

    test(`live: the frame from "${label}" is stored by the whole-record PUT of a client that sends it with the Place`, () => {
      const body = overTheWire({ ...bareProject(), spatialFrame: entry.frame })
      assert.equal(placeBodyError(body, 'replace'), null)
      assert.equal(adoptedFrameError(body, bareProject(), PLACE_ID), null)
      const stored = placeFromBody(body, PLACE_ID, NOW, bareProject())
      assert.deepEqual(stored.spatialFrame, entry.frame)
      assert.equal(stored.spatialFrameRevision, 1)
    })

    test(`live: the frame from "${label}" is stored by the revision route, and written again it is not a conflict`, () => {
      const projects = [bareProject()]
      const body = overTheWire({ frame: entry.sent ?? entry.frame, expectedRevision: 0 })
      const written = applySpatialFrameWrite(projects, PLACE_ID, body, NOW)
      assert.equal(written.result.status, 200)
      assert.equal(written.save, true)
      assert.deepEqual(projects[0]!.spatialFrame, body.frame)
      const again = applySpatialFrameWrite(projects, PLACE_ID, body, NOW + 1)
      assert.equal(again.result.status, 200, 'a replay of a write the server already applied')
      assert.equal(again.save, false)
    })
  }

  test(`live: the sidecar of the scan from "${label}" reads as the record says, with no manifest field invented`, async () => {
    const sidecar = await realSidecar(entry.calibration)
    assert.equal(asCalibrationMethod(sidecar['calibrationMethod']), entry.calibration.method)
    assertManifestFollowsRecord(sidecar, entry.calibration, label)
  })
}

test('live: a scan that never calibrated reads as uncalibrated, with no tier and no field invented', async () => {
  const sidecar = await realSidecar(null)
  assert.equal(sidecar['calibrationMethod'], null)
  assertManifestFollowsRecord(sidecar, null, 'uncalibrated')
  const fields = calibrationFromMeta(sidecar)
  assert.equal(fields.calibrationMethod, undefined)
  assert.equal(fields.calibrationStatus, 'uncalibrated')
})

test('live: a calibration stamped with its unit by the scanner keeps reading as it did, and the unit is not a calibration field', async () => {
  const stamped = stampScale(plainFirst.calibration, { scaleMode: () => 'responsive-unconfigured', scaleKind: () => 'arbitrary' })
  const sidecar = await realSidecar(stamped)
  assertManifestFollowsRecord(sidecar, stamped, 'stamped')
  assert.deepEqual(calibrationScaleFromMeta(sidecar), { scaleMode: 'responsive-unconfigured', scaleKind: 'arbitrary' })
})

test('live: a frame the previous build left in IndexedDB is sent by this build and kept by the server, photos and all', async () => {
  // The row `persistProjectSpatialFrame` writes before it sends anything is what a phone that went offline holds: a
  // frame with its photo records, the revision it was made against, and 'pending'. The server is the real compare-and-swap.
  const named = live.find((entry) => entry.name.includes('both points named'))!
  const { store } = await opened()
  await store.putPendingFrame({
    projectId: PLACE_ID,
    frame: named.sent!,
    expectedRevision: 0,
    syncState: 'pending',
    recordedAt: 1_700_000_001_000,
    updatedAt: 1_700_000_001_000,
    attempts: 0,
  })
  const projects = [bareProject()]
  const env: FrameSyncEnv = {
    url: (path) => path,
    now: () => NOW,
    online: () => true,
    fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
      const reply = applySpatialFrameWrite(projects, PLACE_ID, JSON.parse(String(init?.body)), NOW)
      return new Response(JSON.stringify(reply.result.body), { status: reply.result.status, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  }
  const outcome = await retryPendingFrames(store, env, 'load')
  assert.equal(outcome.changed, true, 'the server took it')
  assert.deepEqual(projects[0]!.spatialFrame, named.sent)
  assert.equal(projects[0]!.spatialFrameRevision, 1)
})

test('live: every tier the phone\'s calibration flow writes is one the predicate calls a Place frame method', () => {
  assert.ok(live.length > 0)
  for (const entry of live) assert.equal(isPlaceFrameMethod(entry.calibration.method), true, entry.name)
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2. FROZEN: what the writers wrote before S0
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface Frozen {
  calibration?: ScanCalibration & Record<string, unknown>
  spatialFrame?: ProjectSpatialFrame
  storedFrame?: ProjectSpatialFrame
  putBody?: { frame: ProjectSpatialFrame; expectedRevision: number }
  uploads?: string[]
  sidecar: Record<string, unknown>
}

const FROZEN = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/place-frame/records-before-s0.json'), 'utf8')) as Record<string, Frozen>
const FROZEN_NAMES = Object.keys(FROZEN).filter((name) => name !== '_about')

test('frozen: the fixture holds every kind of record the writers made', () => {
  assert.deepEqual(FROZEN_NAMES.sort(), [
    'onePointAgainstOnePointPlace',
    'onePointFirst',
    'twoPointFirst',
    'twoPointFirstNamedWithPhotos',
    'twoPointFirstNoCompass',
    'twoPointReturnKeptAfterMismatch',
    'twoPointReturnVerified',
    'twoPointReturnVerifiedAgainstFrameWithPhotos',
    'twoPointScaleStamped',
    'uncalibrated',
  ])
})

test('frozen: none of the records has a field S0 added, so each is exactly a record from before it', () => {
  const added = ['frameId', 'checkPoints', 'checkedBy', 'fit', 'tap', 'calibrationFrameId', 'frameHistory', 'georeference', 'georefVersion']
  const seen = (value: unknown, found: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(value)) value.forEach((each) => seen(each, found))
    else if (value && typeof value === 'object') {
      for (const [key, each] of Object.entries(value)) {
        if (added.includes(key)) found.add(key)
        seen(each, found)
      }
    }
    return found
  }
  assert.deepEqual([...seen(FROZEN)], [])
})

for (const name of FROZEN_NAMES) {
  const record = FROZEN[name]!

  for (const [where, frame] of [['its frame', record.spatialFrame], ['the frame it was made against', record.storedFrame], ['the frame it sent', record.putBody?.frame]] as const) {
    if (!frame) continue
    test(`frozen: ${name}: ${where} validates and comes back unchanged`, () => {
      const check = validateSpatialFrame(frame, { projectId: PLACE_ID })
      assert.ok(check.ok, check.ok ? '' : check.error)
      assert.deepEqual(check.frame, frame)
      assert.ok(sameSpatialFrame(check.frame, frame))
    })
  }

  if (record.putBody) {
    test(`frozen: ${name}: the body the phone sent to the revision route is kept by the server as it came`, () => {
      const projects = [bareProject()]
      const written = applySpatialFrameWrite(projects, PLACE_ID, record.putBody, NOW)
      assert.equal(written.result.status, 200)
      assert.deepEqual(projects[0]!.spatialFrame, record.putBody!.frame)
    })

    test(`frozen: ${name}: the whole Place a client sends with that frame is stored by the whole-record PUT`, () => {
      const body = overTheWire({ ...bareProject(), spatialFrame: record.putBody!.frame })
      assert.equal(placeBodyError(body, 'replace'), null)
      assert.equal(adoptedFrameError(body, bareProject(), PLACE_ID), null)
      assert.deepEqual(placeFromBody(body, PLACE_ID, NOW, bareProject()).spatialFrame, record.putBody!.frame)
    })
  }

  if (record.storedFrame) {
    test(`frozen: ${name}: a Place already holding the frame it was made against keeps it through a whole-record PUT`, () => {
      const stored = bareProject({ spatialFrame: record.storedFrame, spatialFrameRevision: 3 })
      const place = placeFromBody(overTheWire({ ...stored, name: 'Renamed' }), PLACE_ID, NOW, stored)
      assert.deepEqual(place.spatialFrame, record.storedFrame)
      assert.equal(place.spatialFrameRevision, 3)
      assert.equal(place.name, 'Renamed')
    })
  }

  test(`frozen: ${name}: its sidecar reads as the record in it says, and has no field S0 invented`, () => {
    const calibration = (record.calibration ?? null) as ScanCalibration | null
    assertManifestFollowsRecord(record.sidecar, calibration, name)
    // And with literal expectations, so that this cannot pass by agreeing with its own derivation.
    const fields = calibrationFromMeta(record.sidecar) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(fields).sort(),
      [...ALWAYS].sort(),
      'a sidecar from before S0 yields the six fields it always did, and no others',
    )
  })
}

test('frozen: the sidecar of a first two-point calibration reads exactly as before: provisional, spacing 2.4 m, nothing compared', () => {
  const fields = calibrationFromMeta(FROZEN['twoPointFirst']!.sidecar)
  assert.equal(fields.calibrationMethod, 'two-point-ground')
  assert.equal(fields.calibrationStatus, 'provisional')
  assert.ok(Math.abs((fields.calibrationSeparationM ?? 0) - 2.4) < 1e-9)
  assert.equal(fields.calibrationResidualM, 0, 'a first calibration compared nothing, and says 0')
  assert.equal(fields.calibrationToleranceM, 0.15)
})

test('frozen: a visit kept after a mismatch still reads as the failed check it was', () => {
  const fields = calibrationFromMeta(FROZEN['twoPointReturnKeptAfterMismatch']!.sidecar)
  assert.equal(fields.calibrationStatus, 'provisional')
  assert.ok(Math.abs((fields.calibrationResidualM ?? 0) - 1.2) < 1e-9)
  assert.ok(Math.abs(fields.calibrationResidualM ?? 0) > (fields.calibrationToleranceM ?? 0), 'the editor tells it from a first calibration by this')
})

test('frozen: a verified visit reads with the residual it was verified at', () => {
  const fields = calibrationFromMeta(FROZEN['twoPointReturnVerified']!.sidecar)
  assert.equal(fields.calibrationStatus, 'verified')
  assert.ok(Math.abs((fields.calibrationResidualM ?? 0) - 0.03) < 1e-9)
})

test('frozen: the unit a scan was stamped with is read from the sidecar as it always was', () => {
  assert.deepEqual(calibrationScaleFromMeta(FROZEN['twoPointScaleStamped']!.sidecar), { scaleMode: 'responsive-unconfigured', scaleKind: 'arbitrary' })
  assert.deepEqual(calibrationScaleFromMeta(FROZEN['twoPointFirst']!.sidecar), {}, 'an unstamped scan has no unit to report')
})
