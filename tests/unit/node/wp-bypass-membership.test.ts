/**
 * What a commit whose floor check was bypassed may claim about the Place's frame, and what every reader makes of it
 * (ADR 0011 decision 3, ADR 0005 rule 3; the ground gate of #269, src/ar/ground-gate.ts).
 *
 * A commit whose floor check was bypassed ("Place anchor without floor check", or an off-floor tap accepted by a retry) writes
 * no Place frame (`mayWritePlaceFrame`). Before the fix these tests go with, the planner (`planFrameGeneration`) read "no frame
 * came back" as "the visit matched the held frame" and named the held frame's id on the scan, for a pair kept over a mismatch and
 * for "Improve this Place's reference". The server then counted every such scan, and a first visit that wrote no frame, as in the
 * Place frame: under that id or as an unknown generation, in Thing matching, and in what the replace dialog says a replacement
 * strands. Their `sessionToProject` is their own pair's, and nothing had measured them in the Place frame.
 *
 * The rule these tests hold the writer and the readers to, written from the ADR and not from the code:
 *
 *  - A scan is in the Place frame when its commit WROTE the frame (its own pair is the frame) or was COMPARED with the frame
 *    the Place holds and kept no mismatch (its matrix is the comparison's). A scan that did neither is placed by its own pair
 *    alone and is in no Place frame: it claims no generation, and every reader counts it with the scans that are not in one
 *    (never calibrated, one-point, known-distance: `notInFrameScans`), leaves it out of Thing matching, and lets it move
 *    between Places freely, as any scan with no frame to disagree about.
 *  - A visit that matched a frame stays in it, bypassed or not: provisional, and named by the frame's id when the frame has one.
 *    A frame with no id (every Place written before ids) cannot be named, so such a visit is an unknown generation, which is
 *    neutral and still in the frame: the marker is not "bypassed and unnamed", it is the commit's own statement.
 *
 * The table is written out by hand from that rule. Each row then goes through the real writer (`assessTwoPoint`,
 * `buildTwoPointCommit`, `planFrameGeneration`), the real exporter (`exportToGLB`, which writes the sidecar a phone uploads) and
 * the real server readers (`calibrationFromMeta`, `tallyScansByFrame`, `frameStatusOf`, `scanTakesPartInThingMatching`,
 * `decideReassignFrames`), and the editor's chip (`frameChipFor`, src/viewer/frame-banner.ts) reads the manifest the server hands it,
 * so a writer and a reader that disagree cannot both pass.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-bypass-membership.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { assessTwoPoint, buildTwoPointCommit, resolveCommitOptions, type TwoPointFrame } from '../../../src/ar/calibration-commit.ts'
import { leavesScanOutsidePlaceFrame, mayWritePlaceFrame } from '../../../src/ar/ground-gate.ts'
import { calibrationFrameIdOf, frameIdOf, planFrameGeneration, type GenerationPlan } from '../../../src/world/frame-replacement.ts'
import { isInPlaceFrame } from '../../../src/world/frame-generations.ts'
import { calibrationFromMeta } from '../../../server/calibration_fields.ts'
import { decideReassignFrames, frameStatusOf, tallyScansByFrame } from '../../../server/place_frames.ts'
import { scanTakesPartInThingMatching } from '../../../server/thing_match.ts'
import { FakeFrameServer, twoPointScan, type ScanFacts } from './support/fake-frame-server.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { ScanEntry } from '../../../src/project/project-store.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'

// The editor's chip (src/viewer/frame-banner.ts) is written for the bundler (`'./compare-style'`): Node needs the extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
      if (missing && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const { frameChipFor } = await import('../../../src/viewer/frame-banner.ts')

// ── The exporter, as the sidecar test under Node runs it ─────────────────────────────────────────────

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = buf
        this.onloadend?.()
      },
      (err) => this.onerror?.(err),
    )
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader

let lastMetadata: Record<string, unknown> | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const metadata = (init?.body as FormData | undefined)?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as Record<string, unknown>
  return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const pointCloud = {
  count: 2,
  toFloat32Array: () => new Float32Array([0, 0, 0, 0.1, 0.05, -0.1]),
  boundingBox: () => ({ min: { x: 0, y: 0, z: -0.1 }, max: { x: 0.1, y: 0.05, z: 0 } }),
  estimateFloorY: () => 0,
} as unknown as PointCloud

/** The sidecar a phone uploads for one scan carrying `calibration`. */
async function sidecarFor(calibration: ScanCalibration): Promise<Record<string, unknown>> {
  const scanEntry: ScanEntry = { scanId: 'scan-1', projectId: 'place-1', sessionId: 'sess-1', name: 'scan', status: 'draft', capturedAt: Date.now(), calibration }
  const store = { sessionId: 'sess-1', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore
  lastMetadata = null
  await exportToGLB({ store, pointCloud, poseHistory: [], scanEntry }, { download: false, upload: true })
  assert.ok(lastMetadata, 'the export did not reach the upload path')
  return JSON.parse(JSON.stringify(lastMetadata)) as Record<string, unknown>
}

// ── The cases, from the rule ─────────────────────────────────────────────────────────────────────────

const DEFAULTS = resolveCommitOptions({ hitTest: async () => null })
const CALIBRATED_AT = '2026-11-17T09:00:00.000Z'

/** What the Place held when the flow began: no frame, a frame with an id, or a frame written before ids. */
type Held = 'none' | 'g1' | 'legacy'

interface Row {
  name: string
  /** The floor check was bypassed: the skip button, or an off-floor tap accepted by a retry. */
  bypassed: boolean
  held: Held
  /** "Improve this Place's reference": the flow runs as a first calibration over a Place that holds a frame. */
  improve?: boolean
  /** Metres between the two points. The held frame's pair is 3 m, and the spacing tolerance is 16.8 cm. */
  apart: number
  /** "Replace this Place's reference" pressed on the mismatch screen. */
  override: boolean
  expect: {
    /** The commit wrote the Place's frame. */
    frameWritten: boolean
    /** The scan is in the Place frame, by the rule above. */
    inPlaceFrame: boolean
    /** The generation the scan names: the frame it wrote (`'new'`), the frame it matched (`'g1'`), or none. */
    names: 'new' | 'g1' | 'none'
    replaces: { frameId: string | null; reason: 'override' | 'upgrade' } | null
  }
}

const ROWS: Row[] = [
  {
    name: 'a first visit with the floor checked writes the frame and is in it',
    bypassed: false, held: 'none', apart: 3, override: false,
    expect: { frameWritten: true, inPlaceFrame: true, names: 'new', replaces: null },
  },
  {
    name: 'a first visit with the floor check bypassed writes no frame and is in no frame',
    bypassed: true, held: 'none', apart: 3, override: false,
    expect: { frameWritten: false, inPlaceFrame: false, names: 'none', replaces: null },
  },
  {
    name: 'a return visit that matched, floor checked, is in the frame it matched',
    bypassed: false, held: 'g1', apart: 3.05, override: false,
    expect: { frameWritten: false, inPlaceFrame: true, names: 'g1', replaces: null },
  },
  {
    name: 'a return visit that matched with the floor check bypassed is still in the frame it matched, provisionally',
    bypassed: true, held: 'g1', apart: 3.05, override: false,
    expect: { frameWritten: false, inPlaceFrame: true, names: 'g1', replaces: null },
  },
  {
    name: 'a bypassed visit that matched a frame with no id is an unknown generation, which is neutral: still in the frame',
    bypassed: true, held: 'legacy', apart: 3.05, override: false,
    expect: { frameWritten: false, inPlaceFrame: true, names: 'none', replaces: null },
  },
  {
    name: 'a pair kept over a mismatch, floor checked, replaces the frame and is in the new one',
    bypassed: false, held: 'g1', apart: 3.4, override: true,
    expect: { frameWritten: true, inPlaceFrame: true, names: 'new', replaces: { frameId: 'g1', reason: 'override' } },
  },
  {
    name: 'a pair kept over a mismatch with the floor check bypassed replaces nothing, and is in no frame',
    bypassed: true, held: 'g1', apart: 3.4, override: true,
    expect: { frameWritten: false, inPlaceFrame: false, names: 'none', replaces: null },
  },
  {
    name: 'the same over a frame with no id is in no frame either: the marker is not about ids',
    bypassed: true, held: 'legacy', apart: 3.4, override: true,
    expect: { frameWritten: false, inPlaceFrame: false, names: 'none', replaces: null },
  },
  {
    name: 'improving the reference, floor checked, replaces it for the reason upgrade',
    bypassed: false, held: 'g1', improve: true, apart: 3.2, override: false,
    expect: { frameWritten: true, inPlaceFrame: true, names: 'new', replaces: { frameId: 'g1', reason: 'upgrade' } },
  },
  {
    name: 'improving the reference with the floor check bypassed improves nothing, and the scan is in no frame',
    bypassed: true, held: 'g1', improve: true, apart: 3.2, override: false,
    expect: { frameWritten: false, inPlaceFrame: false, names: 'none', replaces: null },
  },
]

const frameOf = (held: Exclude<Held, 'none'>): ProjectSpatialFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  ...(held === 'g1' ? { frameId: 'g1' } : {}),
}) as ProjectSpatialFrame

interface Outcome {
  row: Row
  held: ProjectSpatialFrame | undefined
  built: ReturnType<typeof buildTwoPointCommit>
  plan: GenerationPlan
}

/** One commit, written by the real writer. The modal's own stored frame is the held one unless the person is improving it. */
function commitRow(row: Row): Outcome {
  const held = row.held === 'none' ? undefined : frameOf(row.held)
  const stored = held && !row.improve && held.method === 'two-point-ground' ? held : null
  const landmark = { x: 0, y: -1.2, z: 0 }
  const headingMarker = { x: row.apart, y: -1.2, z: 0 }
  const verdict = assessTwoPoint({ landmark, headingMarker, stored, override: row.override, floorCheckBypassed: row.bypassed }, DEFAULTS)
  assert.equal(verdict.kind, 'accepted', `${row.name}: the commit is accepted`)
  if (verdict.kind !== 'accepted') throw new Error('unreachable')
  const built = buildTwoPointCommit(verdict, {
    landmark,
    headingMarker,
    frameBearingDeg: 12,
    bearingConvention: 2,
    pointLabels: undefined,
    calibratedAt: CALIBRATED_AT,
    floorCheckBypassed: row.bypassed,
  })
  const plan = planFrameGeneration({
    held,
    calibration: built.calibration,
    spatialFrame: built.spatialFrame,
    mode: row.improve ? 'upgrade' : undefined,
    mint: () => 'g-new',
  })
  return { row, held, built, plan }
}

const namedBy = (names: Row['expect']['names']): string | null => (names === 'new' ? 'g-new' : names === 'g1' ? 'g1' : null)

// ── 0. The rule on its own ───────────────────────────────────────────────────────────────────────────

test('rule: a commit leaves its scan in no frame exactly when it wrote none and matched none', () => {
  // Written out from the rule, not from the function: in the frame it wrote, or in the frame it was compared with and kept no
  // mismatch over; in none otherwise.
  const table: Array<[{ frameWritten: boolean; comparedWithStored: boolean; override: boolean }, boolean, string]> = [
    [{ frameWritten: true, comparedWithStored: false, override: false }, false, 'a first calibration wrote the frame'],
    [{ frameWritten: true, comparedWithStored: false, override: true }, false, 'a frame written over nothing'],
    [{ frameWritten: true, comparedWithStored: true, override: true }, false, 'a pair kept over a mismatch wrote the frame that replaces it'],
    [{ frameWritten: true, comparedWithStored: true, override: false }, false, 'a frame written is the frame the scan is in whatever else is true'],
    [{ frameWritten: false, comparedWithStored: true, override: false }, false, 'a visit that matched is in the frame it matched'],
    [{ frameWritten: false, comparedWithStored: true, override: true }, true, 'a pair kept over a mismatch that wrote nothing was compared and failed'],
    [{ frameWritten: false, comparedWithStored: false, override: false }, true, 'a first visit or an improve run that wrote nothing was compared with nothing'],
    [{ frameWritten: false, comparedWithStored: false, override: true }, true, 'and an override of nothing is no match either'],
  ]
  for (const [input, outside, why] of table) assert.equal(leavesScanOutsidePlaceFrame(input), outside, why)
})

test('rule: without a bypass a commit that wrote no frame always matched, so only a bypass can leave a scan in no frame', () => {
  // `mayWritePlaceFrame` writes a frame for every commit that is not bypassed unless it matched the stored one, and a commit with a
  // stored frame has always been compared with it: the two together are why the stamp could once read "no frame" as "matched".
  for (const hasStoredFrame of [false, true]) {
    for (const override of [false, true]) {
      const frameWritten = mayWritePlaceFrame({ floorCheckBypassed: false, hasStoredFrame, override })
      const outside = leavesScanOutsidePlaceFrame({ frameWritten, comparedWithStored: hasStoredFrame, override })
      assert.equal(outside, false, `not bypassed, stored ${hasStoredFrame}, override ${override}`)
    }
  }
  for (const hasStoredFrame of [false, true]) {
    for (const override of [false, true]) {
      const frameWritten = mayWritePlaceFrame({ floorCheckBypassed: true, hasStoredFrame, override })
      const outside = leavesScanOutsidePlaceFrame({ frameWritten, comparedWithStored: hasStoredFrame, override })
      assert.equal(outside, !hasStoredFrame || override, `bypassed, stored ${hasStoredFrame}, override ${override}: in the frame only a matched visit is`)
    }
  }
})

// ── 1. The writer ────────────────────────────────────────────────────────────────────────────────────

for (const row of ROWS) {
  test(`writer: ${row.name}`, () => {
    const { built, plan } = commitRow(row)
    assert.equal(built.spatialFrame !== undefined, row.expect.frameWritten, 'the Place frame is written exactly when the commit may write it')
    assert.equal(plan.spatialFrame !== undefined, row.expect.frameWritten)
    assert.equal(calibrationFrameIdOf(plan.calibration), namedBy(row.expect.names), 'the generation the scan names')
    assert.equal(frameIdOf(plan.spatialFrame), row.expect.names === 'new' ? 'g-new' : null)
    assert.deepEqual(plan.replaces ?? null, row.expect.replaces, 'what the write says it replaces')
    // A calibration says it is in no frame only when it is in none, and says nothing at all when it is in one.
    const said = (plan.calibration as { outsidePlaceFrame?: unknown }).outsidePlaceFrame
    assert.equal(said, row.expect.inPlaceFrame ? undefined : true, 'the record\'s own statement, written only when it is true')
    assert.equal(plan.calibration.floorCheckBypassed, row.bypassed, 'and what happened to the floor check is recorded as it always was')
  })
}

test('writer: the record keeps the layout of a stored record, with the statement beside the flag it follows', () => {
  const outside = commitRow(ROWS[1]!).built.calibration
  assert.deepEqual(Object.keys(outside), [
    'method', 'sessionToProject', 'separationM', 'residualM', 'toleranceM', 'anchorBearingDeg', 'projectBearingDeg', 'bearingConvention',
    'groundY', 'floorCheckBypassed', 'outsidePlaceFrame', 'calibratedAt', 'status',
  ])
  const inside = commitRow(ROWS[0]!).built.calibration
  assert.equal('outsidePlaceFrame' in inside, false, 'a record that is in the frame has no such key: the records every earlier build wrote are what they were')
})

test('writer: what the planner would otherwise take for "the visit matched" is not read from a missing frame', () => {
  const held = frameOf('g1')
  const bare = (extra: Record<string, unknown> = {}): ScanCalibration => ({
    method: 'two-point-ground',
    sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    calibratedAt: CALIBRATED_AT,
    status: 'provisional',
    separationM: 3.4,
    residualM: 0.4,
    toleranceM: 0.168,
    anchorBearingDeg: null,
    floorCheckBypassed: true,
    ...extra,
  }) as ScanCalibration
  assert.equal(calibrationFrameIdOf(planFrameGeneration({ held, calibration: bare({ outsidePlaceFrame: true }) }).calibration), null, 'a record that says it is in no frame names none')
  assert.equal(calibrationFrameIdOf(planFrameGeneration({ held, calibration: bare() }).calibration), 'g1', 'and one that does not is a visit that matched, as it always was')
  assert.equal(
    calibrationFrameIdOf(planFrameGeneration({ held, calibration: bare(), mode: 'upgrade' }).calibration),
    null,
    'an improve run was compared with nothing, so when it wrote no frame it was not measured against the held one, marker or none',
  )
})

// ── 1b. Three points ─────────────────────────────────────────────────────────────────────────────────

/**
 * The Place holds a pair and a check point, so a visit of three taps is compared with a fit of three points and not by the pair's
 * spacing. The visit's session is the Place's frame turned a quarter about the vertical and shifted (`session`), so the matched
 * visit's three taps are the stored three, and the failed one has the check point a metre further along the baseline than it was stored.
 */
const STORED_CHECK = { x: -2.6, y: 0.02, z: 1 }
const session = (p: { x: number; y: number; z: number }) => ({ x: p.z + 4, y: -1.2 + p.y, z: -p.x + 1 })
const heldWithCheck = (): TwoPointFrame =>
  ({ ...frameOf('g1'), headingMarker: { x: 0, y: 0, z: 3.5 }, separationM: 3.5, checkPoints: [{ ...STORED_CHECK, label: 'radiator' }] }) as TwoPointFrame

function commitThree(input: { checkPointZ: number; bypassed: boolean; override: boolean }) {
  const held = heldWithCheck()
  const taps = {
    landmark: session({ x: 0, y: 0, z: 0 }),
    headingMarker: session({ x: 0, y: 0, z: 3.5 }),
    checkPoint: session({ ...STORED_CHECK, z: input.checkPointZ }),
  }
  const verdict = assessTwoPoint({ ...taps, stored: held, override: input.override, floorCheckBypassed: input.bypassed }, DEFAULTS)
  assert.equal(verdict.kind, 'accepted', 'the commit is accepted')
  if (verdict.kind !== 'accepted') throw new Error('unreachable')
  const built = buildTwoPointCommit(verdict, {
    ...taps,
    frameBearingDeg: 12,
    bearingConvention: 2,
    pointLabels: undefined,
    calibratedAt: CALIBRATED_AT,
    floorCheckBypassed: input.bypassed,
  })
  const plan = planFrameGeneration({ held, calibration: built.calibration, spatialFrame: built.spatialFrame, mint: () => 'g-new' })
  return { held, verdict, built, plan }
}

test('writer: three points kept over a failed fit with the floor check bypassed are in no frame, and name none, as a pair is', async () => {
  const kept = commitThree({ checkPointZ: STORED_CHECK.z + 1, bypassed: true, override: true })
  assert.equal(kept.verdict.comparison?.checkedBy, 'constellation', 'a fit of three points compared it, and it did not match')
  assert.equal(kept.built.spatialFrame, undefined, 'the floor was not checked, so the Place frame is not written')
  assert.equal(kept.plan.spatialFrame, undefined)
  assert.equal(kept.plan.replaces, undefined, 'and nothing is replaced')
  assert.equal(calibrationFrameIdOf(kept.plan.calibration), null, 'the visit was compared with g1 and failed: it was not measured against it')
  assert.equal((kept.plan.calibration as { outsidePlaceFrame?: unknown }).outsidePlaceFrame, true)
  assert.equal(kept.plan.calibration.status, 'provisional')

  // Every reader says the same of it, from the sidecar the phone uploads.
  const manifest = calibrationFromMeta(await sidecarFor(kept.plan.calibration))
  assert.equal(isInPlaceFrame(manifest), false)
  assert.equal(scanTakesPartInThingMatching(manifest), false)
  assert.equal(frameChipFor(manifest, { spatialFrame: heldWithCheck() })?.kind, 'not-in-frame')

  // The same three points with the floor checked replace the reference, in the frame they write.
  const replaced = commitThree({ checkPointZ: STORED_CHECK.z + 1, bypassed: false, override: true })
  assert.ok(replaced.plan.spatialFrame, 'the replacement writes the frame')
  assert.equal(calibrationFrameIdOf(replaced.plan.calibration), 'g-new')
  assert.equal('outsidePlaceFrame' in replaced.plan.calibration, false)

  // And three points that matched, with the floor check bypassed, are in the frame they matched, provisionally.
  const matched = commitThree({ checkPointZ: STORED_CHECK.z, bypassed: true, override: false })
  assert.equal(matched.verdict.status, 'provisional', 'a bypassed commit is never verified')
  assert.equal(matched.plan.spatialFrame, undefined)
  assert.equal(calibrationFrameIdOf(matched.plan.calibration), 'g1')
  assert.equal('outsidePlaceFrame' in matched.plan.calibration, false)
})

// ── 2. The sidecar, and the server's readers ─────────────────────────────────────────────────────────

/** The Place as the server holds it once this commit has been saved. */
const placeAfter = (outcome: Outcome): Project =>
  ({ projectId: 'place-1', name: 'Kitchen', spatialFrame: outcome.plan.spatialFrame ?? outcome.held, spatialFrameRevision: 3 }) as unknown as Project

for (const row of ROWS) {
  test(`readers: ${row.name}`, async () => {
    const outcome = commitRow(row)
    const meta = await sidecarFor(outcome.plan.calibration)
    const manifest = calibrationFromMeta(meta)

    assert.equal(isInPlaceFrame(manifest), row.expect.inPlaceFrame, 'the one predicate the counts and Thing matching share')
    assert.equal(scanTakesPartInThingMatching(manifest), row.expect.inPlaceFrame, 'Thing matching takes only a scan measured in the Place frame (owner decision D6)')

    const counts = tallyScansByFrame([meta])
    const id = namedBy(row.expect.names)
    assert.deepEqual(
      counts,
      row.expect.inPlaceFrame
        ? { scanCount: 1, scansByFrame: id === null ? {} : { [id]: 1 }, unrecordedScans: id === null ? 1 : 0, notInFrameScans: 0 }
        : { scanCount: 1, scansByFrame: {}, unrecordedScans: 0, notInFrameScans: 1 },
      'the status counts it where it is: under its generation, as an unknown one, or with the scans that are not in a frame',
    )

    // What a replacement of the frame the Place holds would leave behind: the scans that were measured against it.
    const status = frameStatusOf(placeAfter(outcome), counts)
    assert.equal(status.scansOnCurrentFrame, row.expect.inPlaceFrame ? 1 : 0, 'a scan that is in no frame is not one a replacement strands')

    // A scan that is in no frame has nothing to disagree with a Place about, and moves freely; one that is in a frame, named or not,
    // is held to it: its Place's frame is not the one the other Place holds.
    const elsewhere = { projectId: 'place-2', name: 'Garage', spatialFrame: { ...frameOf('g1'), frameId: 'g-other' }, spatialFrameRevision: 1 } as unknown as Project
    const move = decideReassignFrames(manifest, placeAfter(outcome), elsewhere)
    assert.equal(move.kind, row.expect.inPlaceFrame ? 'mismatch' : 'agree', 'moved into a Place that holds another frame')
  })
}

for (const row of ROWS) {
  test(`readers, the editor's chip: ${row.name}`, async () => {
    const outcome = commitRow(row)
    const manifest = calibrationFromMeta(await sidecarFor(outcome.plan.calibration))
    assert.equal(isInPlaceFrame(manifest), row.expect.inPlaceFrame)

    // The scan, listed in a Place that holds a frame: one with an id (the frame the scan may have been measured against, or written
    // later, as a first visit's Place is once a floor-checked visit writes it) and one written before ids. A Place with no frame has
    // no chips at all, for any scan.
    const places = [
      ['a Place frame with an id', { spatialFrame: frameOf('g1') }],
      ['a Place frame with no id', { spatialFrame: frameOf('legacy') }],
    ] as const
    for (const [what, place] of places) {
      const chip = frameChipFor(manifest, place)
      assert.equal(chip?.kind === 'not-in-frame', !row.expect.inPlaceFrame, `${what}: "not in Place frame" exactly when the server counts the scan in no frame`)
      if (!row.expect.inPlaceFrame) {
        assert.doesNotMatch(chip!.title, /before references were numbered|previous|replaced/, `${what}: a scan made now is not one from before ids, and was never measured against a reference`)
      }
    }
  })
}

test('readers: two first visits that bypassed the floor check, tapped in different places, are not matched as one frame', async () => {
  // The reviewer's scenario: a room whose floor never locks. Each visit placed its own pair and wrote no frame, so their
  // matrices are unrelated and the server must not treat their positions as comparable.
  const first = commitRow(ROWS[1]!)
  const second = commitRow({ ...ROWS[1]!, apart: 3.7 })
  const metas = [await sidecarFor(first.plan.calibration), await sidecarFor(second.plan.calibration)]
  assert.deepEqual(tallyScansByFrame(metas), { scanCount: 2, scansByFrame: {}, unrecordedScans: 0, notInFrameScans: 2 })
  assert.deepEqual(metas.map((meta) => scanTakesPartInThingMatching(calibrationFromMeta(meta))), [false, false])
})

test('readers: a sidecar a build wrote before this marker existed reads exactly as it did: an unknown generation, neutral, in the frame', () => {
  // main's #269 build recorded the bypass and nothing else: no id and no statement about the frame. What it left cannot be told from a
  // visit that matched a frame with no id, and is read the neutral way (ADR 0011 decision 3), not guessed at.
  const meta = {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'provisional',
    calibration: {
      method: 'two-point-ground',
      sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      separationM: 3,
      residualM: 0,
      toleranceM: 0.168,
      anchorBearingDeg: null,
      calibratedAt: CALIBRATED_AT,
      status: 'provisional',
      groundY: -1.2,
      floorCheckBypassed: true,
    },
  }
  const manifest = calibrationFromMeta(meta)
  assert.equal('calibrationOutsidePlaceFrame' in manifest, false)
  assert.equal(isInPlaceFrame(manifest), true)
  assert.deepEqual(tallyScansByFrame([meta]), { scanCount: 1, scansByFrame: {}, unrecordedScans: 1, notInFrameScans: 0 })
})

test('readers: the stand-in server the phone\'s tests use counts a scan that is in no frame as the real tally does', () => {
  // The stand-in (./support/fake-frame-server.ts) is a second, hand-written copy of the server's counting. It is held to the real
  // one over the same scans, so a test that reads a status from it is reading what the server would say.
  const outside: ScanFacts = { calibrationMethod: 'two-point-ground', calibrationStatus: 'provisional', calibrationOutsidePlaceFrame: true }
  const scans: ScanFacts[] = [
    twoPointScan('g1'),
    twoPointScan('g1'),
    twoPointScan('g0'),
    twoPointScan(),
    outside,
    outside,
    { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' },
    { calibrationStatus: 'uncalibrated' },
  ]
  const metas = scans.map((scan): Record<string, unknown> => ({
    calibrationMethod: scan.calibrationMethod ?? null,
    calibrationStatus: scan.calibrationStatus ?? 'uncalibrated',
    ...(scan.calibrationFrameId ? { calibrationFrameId: scan.calibrationFrameId } : {}),
    calibration: scan.calibrationMethod === 'two-point-ground'
      ? { method: 'two-point-ground', ...(scan.calibrationOutsidePlaceFrame ? { outsidePlaceFrame: true } : {}) }
      : null,
  }))
  const held = frameOf('g1')
  const standIn = new FakeFrameServer({ frame: held, scans }).statusBody()
  const real = frameStatusOf({ projectId: 'proj-1', spatialFrame: held, spatialFrameRevision: 1 } as unknown as Project, tallyScansByFrame(metas))
  for (const key of ['scanCount', 'scansByFrame', 'unrecordedScans', 'notInFrameScans', 'scansOnCurrentFrame'] as const) {
    assert.deepEqual(standIn[key], real[key], key)
  }
  assert.deepEqual(real.scansByFrame, { g1: 2, g0: 1 })
  assert.equal(real.unrecordedScans, 1)
  assert.equal(real.notInFrameScans, 4, 'the two that are in no frame are counted with the one-point and the uncalibrated')
  assert.equal(real.scansOnCurrentFrame, 2)
})
