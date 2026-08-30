/**
 * The scan auditor's two blind spots, pinned.
 *
 * `scripts/audit-scan-glb.mjs` used to answer one question — is this GLB structurally sound —
 * and it answered it with a number it had not earned. Both halves are covered here:
 *
 *  1. `pointCloudBounds`. The old extent measurement read POSITION with `getArray()` and ignored
 *     the node transform, so every KHR_mesh_quantization artifact in scans/ reported a ~65534 m
 *     extent and tripped the drift warning: 295 false positives out of 405 readable GLBs on the
 *     2026-08-30 sweep. The fixture below is built so the right answer is arithmetic (a unit cube
 *     of normalized int16, on a node scaled by 4 and shifted by 10) rather than something read
 *     back out of the implementation.
 *
 *  2. `coherenceFindings`. A scan is a GLB plus a spread of independently-written manifests, and
 *     nothing checked that the set agreed with itself. Every case here is a way for the artifacts
 *     to describe a success that did not happen — the defect this repo keeps producing.
 *
 * The abstention cases matter as much as the findings. A checker that manufactures findings is
 * worse than no checker, and this one did: reading `worldPos` as an array made it report a lift
 * that had placed 6 objects as having placed 0. `placedWorldPosIsAnObject` pins that.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/scan_coherence.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Accessor, Document, Primitive } from '@gltf-transform/core'

import {
  CLOUD_SCALE_DISAGREEMENT,
  coherenceFindings,
  COLLAPSED_EXTENT,
  extentFindings,
  extentUnits,
  pointCloudBounds,
  ROOM_EXTENT_SANITY_M,
} from '../../../scripts/audit-scan-glb.mjs'

const errors = (found: { severity: string; message: string }[]) => found.filter((f) => f.severity === 'error')
const messages = (found: { severity: string; message: string }[]) => found.map((f) => f.message).join('\n')

// ── pointCloudBounds ────────────────────────────────────────────────────────

/**
 * A cloud whose true world bounds are known by construction.
 *
 * Positions are normalized int16 — what `quantize()` emits — spanning the full +/-32767 range, so
 * dequantization takes them to +/-1. The node then scales by 4 and translates by (10, 0, 0), so
 * the world cube is 8 units on a side, centred at (10, 0, 0). Reading raw would give 65534.
 */
function quantizedCubeDoc(scale = 4, tx = 10) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const corners = [
    [-32767, -32767, -32767], [32767, -32767, -32767], [-32767, 32767, -32767], [32767, 32767, -32767],
    [-32767, -32767, 32767], [32767, -32767, 32767], [-32767, 32767, 32767], [32767, 32767, 32767],
  ].flat()
  const position = doc.createAccessor()
    .setType(Accessor.Type.VEC3)
    .setArray(new Int16Array(corners))
    .setNormalized(true)
    .setBuffer(buffer)
  const prim = doc.createPrimitive().setMode(Primitive.Mode.POINTS).setAttribute('POSITION', position)
  const mesh = doc.createMesh('point-cloud').addPrimitive(prim)
  const node = doc.createNode('point-cloud')
    .setMesh(mesh)
    .setScale([scale, scale, scale])
    .setTranslation([tx, 0, 0])
  doc.createScene().addChild(node)
  return doc
}

test('pointCloudBounds denormalizes a quantized accessor instead of reading raw integers', () => {
  const bounds = pointCloudBounds(quantizedCubeDoc())
  assert.equal(bounds.count, 8)
  // 2 (the normalized span) x 4 (the node scale) = 8, on every axis. Raw would be 65534.
  for (const axis of bounds.size!) assert.ok(Math.abs(axis - 8) < 1e-3, `axis was ${axis}, expected 8`)
})

test('pointCloudBounds applies the node translation the optimize pass parks the offset in', () => {
  const bounds = pointCloudBounds(quantizedCubeDoc(4, 10))
  assert.ok(Math.abs(bounds.min![0] - 6) < 1e-3, `min.x was ${bounds.min![0]}, expected 6`)
  assert.ok(Math.abs(bounds.max![0] - 14) < 1e-3, `max.x was ${bounds.max![0]}, expected 14`)
})

test('pointCloudBounds counts non-finite positions rather than folding them into the bounds', () => {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const position = doc.createAccessor()
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 1, 1, 1, NaN, 0, 0]))
    .setBuffer(buffer)
  const prim = doc.createPrimitive().setMode(Primitive.Mode.POINTS).setAttribute('POSITION', position)
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)))
  const bounds = pointCloudBounds(doc)
  assert.equal(bounds.nonFinite, 1)
  assert.equal(bounds.count, 2)
  assert.deepEqual(bounds.size, [1, 1, 1])
})

// ── extent verdicts ─────────────────────────────────────────────────────────

test('a room-sized metric cloud draws no extent finding at all', () => {
  assert.deepEqual(extentFindings([5.9, 2.5, 5.8], 'm', 4853), [])
})

test('a metric cloud larger than a room is called drift', () => {
  const found = extentFindings([ROOM_EXTENT_SANITY_M + 1, 5, 5], 'm', 1000)
  assert.equal(found.length, 1)
  assert.match(found[0].message, /larger than a room/)
})

test('the drift threshold is not applied to scale-free structure-from-motion units', () => {
  // A COLMAP cloud has no metres in it, so "bigger than 30 m" is not a statement about anything.
  assert.deepEqual(extentFindings([60, 40, 50], 'sfm', 12430), [])
})

test('a collapsed metric cloud is an error, however many points it claims', () => {
  const found = extentFindings([0.037, 0.0364, 0.0367], 'm', 2436672)
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /collapsed/)
  assert.match(messages(found), /2,436,672/)
})

test('a collapsed scale-free cloud is a warning, not a false metric claim', () => {
  const found = extentFindings([COLLAPSED_EXTENT / 2, COLLAPSED_EXTENT / 2, COLLAPSED_EXTENT / 2], 'sfm', 5000)
  assert.equal(errors(found).length, 0)
  assert.equal(found.length, 1)
})

test('an empty cloud produces no extent verdict — "no points" is the geometry check\'s finding', () => {
  assert.deepEqual(extentFindings([0, 0, 0], 'm', 0), [])
})

test('extentUnits reports sfm exactly when a pose solve claims to have written this GLB', () => {
  const base = { glbBase: 'sess-video-20260830-054518' }
  assert.equal(extentUnits({
    ...base,
    sidecars: { 'colmap-poses': { json: { glbPath: '/abs/scans/sess-video-20260830-054518.glb' } } },
  }), 'sfm')
  // A solve that wrote a DIFFERENT GLB says nothing about this one's units.
  assert.equal(extentUnits({
    ...base,
    sidecars: { 'colmap-poses': { json: { glbPath: '/abs/scans/some-other-scan.glb' } } },
  }), 'm')
  assert.equal(extentUnits({ ...base, sidecars: {} }), 'm')
})

// ── coherenceFindings ───────────────────────────────────────────────────────

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    glbBase: 'scan-a',
    sessionId: 'sess-a',
    pointVertices: 12430,
    detectionsInGlb: 0,
    sidecars: {},
    files: {},
    detectionsSidecar: null,
    ...overrides,
  }
}

function sidecar(key: string, json: Record<string, unknown>, baseDir = '/scans') {
  return { [key]: { path: `${baseDir}/${key}.json`, json, baseDir } }
}

test('a healthy set of manifests reports nothing', () => {
  const found = coherenceFindings(ctx({
    sidecars: {
      ...sidecar('colmap-poses', {
        status: 'ok', sessionId: 'sess-a', registeredImages: 48, frameCount: 48, pointCount: 12430,
        posesPath: 'colmap.poses.json', glbPath: '/scans/scan-a.glb',
        quality: { status: 'ready', degenerate: false, registrationRatio: 1 },
      }, '/scans/sessions/sess-a'),
      ...sidecar('splat-train', { status: 'ok', sessionId: 'sess-a', gaussianCount: 253021, plyPath: 'scan-a.splat.ply' }),
      ...sidecar('splat-align', { status: 'ok', sessionId: 'sess-a', scale: 1.4, residualM: 0.02 }),
      ...sidecar('splat-finish', { status: 'ok', sessionId: 'sess-a', gaussianCount: 253021, sogPath: 'scan-a.sog' }),
    },
    files: {
      '/scans/sessions/sess-a/colmap.poses.json': { exists: true, bytes: 24486 },
      '/scans/scan-a.splat.ply': { exists: true, bytes: 38460283 },
      '/scans/scan-a.sog': { exists: true, bytes: 4856555 },
    },
  }))
  assert.deepEqual(found, [], messages(found))
})

test('a stage that reports ok and did not write its output is an error', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('splat-train', { status: 'ok', gaussianCount: 253021, plyPath: 'scan-a.splat.ply' }),
    files: {},
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /does not exist/)
})

test('a zero-byte output is as false as a missing one', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('splat-finish', { status: 'ok', gaussianCount: 10, sogPath: 'scan-a.sog' }),
    files: { '/scans/scan-a.sog': { exists: true, bytes: 0 } },
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /zero bytes/)
})

test('an ok with a zero principal count is an empty result presented as a success', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('lingbot-map', { status: 'ok', pointCount: 0 }, '/scans/sessions/sess-a'),
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /pointCount=0/)
})

test('a splat trained on a solve the quality gate rejected is an error, not a success', () => {
  // Measured precedent: sess-a7e2f642 registered 3 of 17 frames, the gate called it degenerate,
  // and a splat was trained on it anyway and reported ok.
  const found = coherenceFindings(ctx({
    sidecars: {
      ...sidecar('colmap-poses', {
        status: 'ok', registeredImages: 3, frameCount: 17,
        quality: { status: 'needs-rescan', degenerate: true, registrationRatio: 3 / 17 },
      }, '/scans/sessions/sess-a'),
      ...sidecar('splat-train', { status: 'ok', gaussianCount: 92216 }),
    },
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /poses the pipeline itself does not trust/)
  assert.match(messages(found), /18% of frames registered/)
})

test('a partial registration is reported even when the gate passed it', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('colmap-poses', {
      status: 'ok', registeredImages: 40, frameCount: 48, pointCount: 12430,
      quality: { status: 'ready', degenerate: false, registrationRatio: 40 / 48 },
    }, '/scans/sessions/sess-a'),
  }))
  assert.equal(errors(found).length, 0)
  assert.match(messages(found), /registered 40 of 48 frames/)
})

test('a GLB holding a different point count than the solve wrote is from another run', () => {
  const found = coherenceFindings(ctx({
    pointVertices: 9362,
    sidecars: sidecar('colmap-poses', {
      status: 'ok', registeredImages: 48, frameCount: 48, pointCount: 12430, glbPath: '/scans/scan-a.glb',
      quality: { status: 'ready', degenerate: false },
    }, '/scans/sessions/sess-a'),
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /different run/)
})

test('gaussian counts that change between training and compression are two different splats', () => {
  const found = coherenceFindings(ctx({
    sidecars: {
      ...sidecar('splat-train', { status: 'ok', gaussianCount: 253021 }),
      ...sidecar('splat-finish', { status: 'ok', gaussianCount: 246838 }),
    },
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /not the same splat/)
})

test('a manifest naming a different session than the GLB is an error', () => {
  const found = coherenceFindings(ctx({
    sessionId: 'sess-a',
    sidecars: sidecar('splat-train', { status: 'ok', sessionId: 'sess-b', gaussianCount: 10 }),
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /names session "sess-b"/)
})

test('optional tooling that skipped without a remediation is flagged, not accepted', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('lingbot-map', { status: 'skipped' }, '/scans/sessions/sess-a'),
  }))
  assert.equal(errors(found).length, 0)
  assert.match(messages(found), /no remediation/)
})

test('a skip WITH a remediation is a clean degradation and draws nothing', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('lingbot-map', {
      status: 'skipped',
      skippedReason: 'no model at /home/liam/models/lingbot-map/lingbot-map.pt',
      remediation: 'Download the checkpoint, or leave it unset to use COLMAP.',
    }, '/scans/sessions/sess-a'),
  }))
  assert.deepEqual(found, [], messages(found))
})

test('segments that were found and never lifted are reported as unreachable', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic', { status: 'ok', framesSegmented: 48, thingCount: 38 }, '/scans/sessions/sess-a'),
  }))
  assert.equal(errors(found).length, 0)
  assert.match(messages(found), /38 object segments .* never lifted/s)
})

test('a segmenter run with no thing-label list is not evidence of an empty room', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic', {
      status: 'ok', framesSegmented: 48, thingCount: 0, thingLabelsUsed: false,
    }, '/scans/sessions/sess-a'),
  }))
  assert.match(messages(found), /not asked/)
})

test('lift counts that do not partition the segment set are an error', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 50, confidentCount: 6, undeterminedCount: 40,
      reasons: { unsupported: 40 },
    }),
  }))
  assert.match(messages(found), /do not partition/)
})

test('lift reasons that do not sum to the unplaced count are an error', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 50, confidentCount: 6, undeterminedCount: 44,
      reasons: { unsupported: 33, 'depth-ambiguous': 4 },
    }),
  }))
  assert.match(messages(found), /sum to 37 but 44/)
})

test('low-confidence counted as a third bucket rather than a subset is an error', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 50, confidentCount: 6, undeterminedCount: 44,
      lowConfidenceCount: 45, reasons: { unsupported: 44 },
    }),
  }))
  assert.match(messages(found), /subset of unplaced/)
})

test('the real sess-a7e2f642 lift manifest satisfies every count invariant', () => {
  // Copied verbatim from scans/1787816555017_…panoptic-lift.manifest.json: 6 + 44 = 50, and the
  // four reasons sum to 44 with low-confidence (5) inside them. If a future policy change breaks
  // this arithmetic, the manifest stops describing a run that happened.
  const reasons = { unsupported: 33, 'depth-ambiguous': 4, 'low-confidence': 5, 'no-geometry': 2 }
  const detections = [
    ...Array.from({ length: 6 }, (_, i) => ({ label: 'bag', confidence: 0.3, worldPos: { x: i, y: 1.8, z: -0.6 } })),
    ...Object.entries(reasons).flatMap(([reason, n]) =>
      Array.from({ length: n }, () => ({ label: 'x', confidence: null, worldPos: null, reason }))),
  ]
  const found = coherenceFindings(ctx({
    pointVertices: 5330,
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 50, confidentCount: 6, lowConfidenceCount: 5, undeterminedCount: 44,
      pointCount: 5330, reasons,
    }),
    detectionsSidecar: { path: '/scans/scan-a.panoptic.detections.json', json: { detections } },
  }))
  assert.equal(detections.length, 50)
  assert.equal(errors(found).length, 0, messages(found))
})

test('a lift that placed nothing says so, whatever its status field claims', () => {
  const found = coherenceFindings(ctx({
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 38, confidentCount: 0, undeterminedCount: 38,
      reasons: { 'no-pose': 38 },
    }),
  }))
  assert.match(messages(found), /places nothing/)
})

test('placedWorldPosIsAnObject: a lift sidecar with Vec3 positions is not read as empty', () => {
  // worldPos is `{x, y, z}` (src/shared/panoptic_lift.ts:65), never a 3-array. Reading it as an
  // array reported the sess-a7e2f642 lift — 6 real placements — as having placed 0.
  const found = coherenceFindings(ctx({
    pointVertices: 5330,
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 2, confidentCount: 1, undeterminedCount: 1,
      pointCount: 5330, reasons: { unsupported: 1 },
    }),
    detectionsSidecar: {
      path: '/scans/scan-a.panoptic.detections.json',
      json: {
        detections: [
          { label: 'bag', confidence: 0.31, worldPos: { x: -0.13, y: 1.86, z: -0.62 } },
          { label: 'monitor', confidence: null, worldPos: null, reason: 'unsupported' },
        ],
      },
    },
  }))
  assert.equal(errors(found).length, 0, messages(found))
})

test('a lift claiming placements its sidecar does not carry is an error', () => {
  const found = coherenceFindings(ctx({
    pointVertices: 100,
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 2, confidentCount: 2, undeterminedCount: 0, pointCount: 100, reasons: {},
    }),
    detectionsSidecar: {
      path: '/scans/scan-a.panoptic.detections.json',
      json: { detections: [{ label: 'bag', confidence: null, worldPos: null, reason: 'unsupported' }, { label: 'x', worldPos: null, reason: 'no-geometry' }] },
    },
  }))
  assert.match(messages(found), /claims 2 placed objects but its sidecar carries 0/)
})

test('a record with a position and no confidence is a placement with nothing behind it', () => {
  const found = coherenceFindings(ctx({
    pointVertices: 100,
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 1, confidentCount: 1, undeterminedCount: 0, pointCount: 100, reasons: {},
    }),
    detectionsSidecar: {
      path: '/scans/scan-a.panoptic.detections.json',
      json: { detections: [{ label: 'bag', worldPos: { x: 1, y: 2, z: 3 } }] },
    },
  }))
  assert.match(messages(found), /position with no confidence/)
})

test('a lift that ran against a different cloud than the GLB holds is flagged', () => {
  const found = coherenceFindings(ctx({
    pointVertices: 12430,
    sidecars: sidecar('panoptic-lift', {
      status: 'ok', segmentCount: 1, confidentCount: 0, undeterminedCount: 1,
      reasons: { 'no-pose': 1 }, pointCount: 5330,
    }),
  }))
  assert.match(messages(found), /ran against a different artifact/)
})

test('two clouds of one session at wildly different scales cannot both be the room', () => {
  const found = coherenceFindings(ctx({
    extent: [20.7, 10.8, 17.4],
    siblingCloud: { name: 'scan-a.lingbot.glb', extent: [0.037, 0.0364, 0.0367] },
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /scale disagreement/)
})

test('two clouds within the tolerance are left alone', () => {
  const found = coherenceFindings(ctx({
    extent: [20.7, 10.8, 17.4],
    siblingCloud: { name: 'scan-a.lingbot.glb', extent: [20.7 / (CLOUD_SCALE_DISAGREEMENT / 2), 5, 5] },
  }))
  assert.deepEqual(found, [], messages(found))
})

test('a manifest that exists but does not parse is an error, not a silently absent stage', () => {
  const found = coherenceFindings(ctx({
    sidecars: { 'splat-train': { path: '/scans/scan-a.splat-train.manifest.json', json: null, unreadable: true, baseDir: '/scans' } },
  }))
  assert.equal(errors(found).length, 1)
  assert.match(messages(found), /not readable JSON/)
})
