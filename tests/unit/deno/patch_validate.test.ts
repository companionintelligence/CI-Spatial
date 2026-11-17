/**
 * What the Scan server will take as a scan's placement (server/world/patch_validate.ts and the rules in
 * src/world/scan-placement.ts), and how a move is taken back.
 *
 * The routes themselves are exercised in patch_routes.test.ts, which starts the real server. These
 * are the rules underneath, on their own, so each one has a case that says what it does.
 *
 * The matrices are the real ones: twoPointToProjectTransform for a calibrated scan and
 * composeYUpTransform for one placed by GPS or the grid.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { composeYUpTransform, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import {
  PLACEMENT_SCALE_MAX,
  PLACEMENT_SCALE_MIN,
  PLACEMENT_TOLERANCE,
  buildRevertPatch,
  checkPlacementMatrix,
  checkTransformMatrix,
  liveScanPlacementPatches,
  normaliseZeros,
  planRevert,
  stampFirstSightPlacements,
} from '../../../src/world/scan-placement.ts'
import {
  MAX_CHECKED_METADATA_CHARS,
  PlacementRefused,
  cleanTransform,
  namesAScanRoot,
  parseJsonObject,
  parseRevertRequest,
  patchProblem,
  patchTransformProblem,
  rejectedTransformField,
  rejectedTransformMessage,
  sanitiseUploadMetadata,
} from '../../../server/world/patch_validate.ts'
import type { EditPatch, ScanManifest, WorldProject } from '../../../src/world/types.ts'
import { rotatedBy } from './placement_fixtures.ts'

const calibrated = (): number[] => twoPointToProjectTransform({ x: 1.5, y: 0, z: -0.4 }, { x: 3.1, y: 0, z: 1.9 })
const gps = (): number[] => composeYUpTransform({ x: 12.5, y: 0, z: -48.25 }, 211)

/** `matrix` scaled: every axis of the 3x3 block multiplied by `k`. */
function scaled(matrix: number[], k: number): number[] {
  const out = [...matrix]
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) out[i] = out[i]! * k
  return out
}

/** `matrix` with its second axis leaned toward its first by `theta` radians: still unit length, no longer at a right angle. */
function skewedBy(matrix: number[], theta: number): number[] {
  const out = [...matrix]
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  for (let i = 0; i < 3; i++) out[4 + i] = c * matrix[4 + i]! + s * matrix[i]!
  return out
}

function rejectionOf(value: unknown): string {
  const check = checkPlacementMatrix(value)
  assert(!check.ok, 'expected the matrix to be refused')
  return check.reason
}

// ─── The placement check ─────────────────────────────────────────────────────

Deno.test('a rigid placement is accepted: a calibration, a GPS placement, the identity, and every size from 0.5 to 2', () => {
  for (const matrix of [calibrated(), gps(), composeYUpTransform({ x: 0, y: 0, z: 0 }, 0)]) {
    const check = checkPlacementMatrix(matrix)
    assert(check.ok, JSON.stringify(matrix))
    assert(Math.abs(check.scale - 1) < 1e-12)
  }
  for (const size of [PLACEMENT_SCALE_MIN, 0.8, 1.3, PLACEMENT_SCALE_MAX]) {
    assert(checkPlacementMatrix(scaled(calibrated(), size)).ok, `size ${size}`)
  }
  assertEquals([PLACEMENT_SCALE_MIN, PLACEMENT_SCALE_MAX], [0.5, 2])
})

Deno.test('a matrix with a NaN or an infinity is refused, and so is one that went through JSON, where NaN becomes null', () => {
  const withNaN = calibrated()
  withNaN[12] = Number.NaN
  assertEquals(rejectionOf(withNaN), 'not-finite')
  const withInfinity = calibrated()
  withInfinity[0] = Number.POSITIVE_INFINITY
  assertEquals(rejectionOf(withInfinity), 'not-finite')
  assertEquals(rejectionOf(JSON.parse(JSON.stringify(withNaN))), 'not-finite')

  const text = checkPlacementMatrix(withNaN)
  assert(!text.ok)
  assertStringIncludes(text.message, 'number 13')
  // Numbers as strings and holes in a sparse array are not numbers either.
  assertEquals(rejectionOf(calibrated().map(String)), 'not-finite')
  const sparse = new Array(16)
  sparse[0] = 1
  assertEquals(rejectionOf(sparse), 'not-finite')
})

Deno.test('a short or long matrix, and anything that is not a list, is refused with the length in the message', () => {
  const short = checkPlacementMatrix(calibrated().slice(0, 15))
  assert(!short.ok)
  assertEquals(short.reason, 'wrong-length')
  assertStringIncludes(short.message, '16 numbers, not 15')
  assertEquals(rejectionOf([...calibrated(), 0]), 'wrong-length')
  assertEquals(rejectionOf([]), 'wrong-length')
  for (const notAList of [undefined, null, 'x', 3, {}, { length: 16 }, true]) assertEquals(rejectionOf(notAList), 'not-a-list')
})

Deno.test('a matrix that is not rigid is refused: skewed, stretched along one axis, mirrored, or not affine', () => {
  assertEquals(rejectionOf(skewedBy(calibrated(), 0.01)), 'skewed')

  const stretched = calibrated()
  stretched[0] *= 1.1
  stretched[1] *= 1.1
  stretched[2] *= 1.1
  assertEquals(rejectionOf(stretched), 'stretched')

  const mirrored = calibrated()
  for (const i of [8, 9, 10]) mirrored[i] = -mirrored[i]!
  assertEquals(rejectionOf(mirrored), 'mirrored')

  const projective = calibrated()
  projective[3] = 0.001
  assertEquals(rejectionOf(projective), 'not-affine')
  const lastRow = calibrated()
  lastRow[15] = 2
  assertEquals(rejectionOf(lastRow), 'not-affine')
})

Deno.test('the tolerance is stated: an axis 1e-7 off square passes, one 1e-5 off does not', () => {
  assert(checkPlacementMatrix(skewedBy(calibrated(), 1e-7)).ok)
  assertEquals(rejectionOf(skewedBy(calibrated(), 1e-5)), 'skewed')
  // Lengths are held to the same figure: 1e-7 of stretch passes, 1e-5 does not.
  const nearly = scaled(calibrated(), 1 + 1e-7)
  assert(checkPlacementMatrix(nearly).ok)
  const uneven = calibrated()
  for (const i of [0, 1, 2]) uneven[i] = uneven[i]! * (1 + 1e-5)
  assertEquals(rejectionOf(uneven), 'stretched')
})

Deno.test('the ends of the size range are inside it, however the scan is turned: exactly 0.5 and exactly 2 pass', () => {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  let pastTheEndInDoubles = 0
  for (const size of [PLACEMENT_SCALE_MIN, PLACEMENT_SCALE_MAX]) {
    for (let i = 0; i < 3000; i++) {
      const matrix = rotatedBy(next, size)
      const mean = (Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!) + Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!) + Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!)) / 3
      // Without slack a share of these would be refused: a size of 2 that went through a rotation is 2.0000000000000004 now and then.
      if (mean > PLACEMENT_SCALE_MAX || mean < PLACEMENT_SCALE_MIN) pastTheEndInDoubles++
      const check = checkPlacementMatrix(matrix)
      assert(check.ok, `size ${size}, rotation ${i}: ${check.ok ? '' : check.message}`)
    }
  }
  assert(pastTheEndInDoubles > 100, `the sweep reaches doubles just past an end (${pastTheEndInDoubles} did), so it can tell slack from none`)
  // The slack is the stated tolerance and no more: a size a visible step past an end is still refused.
  for (const size of [2.0001, 0.4999]) assertEquals(rejectionOf(scaled(calibrated(), size)), 'scale-range', `size ${size}`)
  assert(checkPlacementMatrix(scaled(calibrated(), 2 * (1 + PLACEMENT_TOLERANCE / 2))).ok)
  assert(checkPlacementMatrix(scaled(calibrated(), 0.5 * (1 - PLACEMENT_TOLERANCE / 2))).ok)
})

Deno.test('every pair of axes is held at a right angle and every axis at the same length, not only the first of each', () => {
  const lean = (matrix: number[], axis: number, toward: number, theta: number): number[] => {
    const out = [...matrix]
    for (let i = 0; i < 3; i++) out[axis * 4 + i] = Math.cos(theta) * matrix[axis * 4 + i]! + Math.sin(theta) * matrix[toward * 4 + i]!
    return out
  }
  for (const [axis, toward] of [[1, 0], [2, 0], [2, 1], [0, 1], [0, 2], [1, 2]] as const) {
    assertEquals(rejectionOf(lean(calibrated(), axis, toward, 0.02)), 'skewed', `axis ${axis} leaned toward axis ${toward}`)
  }
  const along = (axis: number, factor: number): number[] => {
    const out = calibrated()
    for (let i = 0; i < 3; i++) out[axis * 4 + i] = out[axis * 4 + i]! * factor
    return out
  }
  for (const axis of [0, 1, 2]) assertEquals(rejectionOf(along(axis, 1.1)), 'stretched', `axis ${axis} stretched`)
  // The mean of the three lengths is 1 here, and the first axis is on it, so the first axis alone would not give it away.
  assertEquals(rejectionOf(along(2, 0.9).map((entry, i) => (i >= 4 && i < 8 ? entry * 1.1 : entry))), 'stretched')
})

Deno.test('the tolerance is relative to the size of the scan: the same slip passes at one size and not at another', () => {
  // Axis 1 leaned toward axis 0 by theta: their dot product is size squared times sin(theta), held to size squared times the tolerance.
  const leaned = (size: number, theta: number): number[] => {
    const out = scaled(calibrated(), size)
    for (let i = 0; i < 3; i++) out[4 + i] = Math.cos(theta) * out[4 + i]! + Math.sin(theta) * out[i]!
    return out
  }
  assert(checkPlacementMatrix(leaned(2, 5e-7)).ok, 'half the tolerance at twice the size is inside it')
  assertEquals(rejectionOf(leaned(0.5, 2e-6)), 'skewed', 'twice the tolerance at half the size is outside it')
  // One axis longer than the others by a share of its own length: its slip is held to the tolerance times the mean length.
  const longer = (size: number, extra: number): number[] => {
    const out = scaled(calibrated(), size)
    for (let i = 0; i < 3; i++) out[i] = out[i]! * (1 + extra)
    return out
  }
  assert(checkPlacementMatrix(longer(2, 1.2e-6)).ok, 'a share of 1.2e-6 of a size of 2 is inside the tolerance')
  assertEquals(rejectionOf(longer(0.5, 1.8e-6)), 'stretched', 'a share of 1.8e-6 of a size of 0.5 is outside it')
})

Deno.test('a size outside 0.5 to 2 is refused with the size it saw, and a matrix of nothing is refused', () => {
  for (const size of [0.49, 0.1, 2.01, 5]) {
    const check = checkPlacementMatrix(scaled(calibrated(), size))
    assert(!check.ok, `size ${size}`)
    assertEquals(check.reason, 'scale-range')
    assertStringIncludes(check.message, 'between 0.5 and 2 times')
    assertStringIncludes(check.message, String(size))
  }
  assertEquals(rejectionOf(scaled(calibrated(), 0)), 'scale-range')
  assertEquals(rejectionOf(new Array(16).fill(0)), 'not-affine', 'all zeros has no 1 in the last row either')
})

Deno.test('an object transform may be resized along one axis or skewed, but not flattened or malformed', () => {
  const stretched = calibrated()
  stretched[0] *= 2.5
  stretched[1] *= 2.5
  stretched[2] *= 2.5
  assert(checkTransformMatrix(stretched).ok)
  const skewed = calibrated()
  skewed[4] += 0.3
  assert(checkTransformMatrix(skewed).ok)
  assert(checkTransformMatrix(scaled(calibrated(), 7)).ok)

  const flat = calibrated()
  for (const i of [4, 5, 6]) flat[i] = 0
  const refused = checkTransformMatrix(flat)
  assert(!refused.ok)
  assertEquals(refused.reason, 'degenerate')
  const withNaN = calibrated()
  withNaN[5] = Number.NaN
  assert(!checkTransformMatrix(withNaN).ok)
  assert(!checkTransformMatrix(calibrated().slice(0, 12)).ok)
})

Deno.test('an object matrix is flat when its volume is nothing next to its axes, at any size: a hair of depth is flat, a sliver is not', () => {
  const withDepth = (depth: number, size = 1): number[] => {
    const out = [...calibrated()]
    // The third axis stands up from the plane of the first two by `depth` of its own length.
    out[8] = size
    out[9] = 0
    out[10] = size * depth
    out[0] = size
    out[1] = 0
    out[2] = 0
    out[4] = 0
    out[5] = size
    out[6] = 0
    return out
  }
  const flat = checkTransformMatrix(withDepth(1e-12))
  assert(!flat.ok)
  assertEquals(flat.reason, 'degenerate')
  assert(checkTransformMatrix(withDepth(1e-4)).ok, 'a sliver a ten-thousandth deep is still an object')
  assert(checkTransformMatrix(withDepth(1e-6)).ok)
  assert(!checkTransformMatrix(withDepth(1e-12, 50)).ok, 'the same at any size')
  assert(!checkTransformMatrix(withDepth(1e-12, 0.01)).ok)
  assert(checkTransformMatrix(withDepth(1e-4, 50)).ok)
})

// ─── The patch body ──────────────────────────────────────────────────────────

Deno.test('a scan patch with a NaN, a short or a non-rigid matrix has a problem to report, and a rigid one has none', () => {
  const withNaN = calibrated()
  withNaN[14] = Number.NaN
  const skewed = calibrated()
  skewed[1] += 0.2
  for (const matrix of [withNaN, calibrated().slice(0, 15), skewed, scaled(calibrated(), 3)]) {
    const problem = patchTransformProblem('scan', { matrix })
    assert(problem !== null, JSON.stringify(matrix))
    assert(problem.length > 0)
  }
  assertEquals(patchTransformProblem('scan', { matrix: calibrated() }), null)
  assertEquals(patchTransformProblem('scan', { matrix: gps(), position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }), null)
})

Deno.test('an object patch keeps its freedom to resize, a thing patch needs real numbers in its position, and no transform is nothing to check', () => {
  const stretched = calibrated()
  stretched[0] *= 2.5
  stretched[1] *= 2.5
  stretched[2] *= 2.5
  assertEquals(patchTransformProblem('object', { matrix: stretched }), null)
  assert(patchTransformProblem('object', { matrix: calibrated().slice(0, 15) }) !== null)

  assertEquals(patchTransformProblem('thing', { position: { x: 1, y: 2, z: 3 } }), null)
  assertStringIncludes(patchTransformProblem('thing', { position: { x: 1, y: null, z: 3 } })!, 'position must be 3 real numbers')
  assertStringIncludes(patchTransformProblem('thing', { position: null })!, 'position')
  assertStringIncludes(patchTransformProblem('object', { rotation: { x: 0, y: 0, z: 0 } })!, 'rotation must be 4 real numbers')
  assertStringIncludes(patchTransformProblem('object', { scale: { x: 1, y: 1, z: Number.NaN } })!, 'scale')

  for (const none of [undefined, null]) assertEquals(patchTransformProblem('scan', none), null)
  assertEquals(patchTransformProblem('object', {}), null)
  assertEquals(patchTransformProblem('scan', 'not an object'), 'The transform must be an object.')
  assertEquals(patchTransformProblem('scan', [1, 2, 3]), 'The transform must be an object.')
})

Deno.test('a matrix that is null is not "no matrix": it is refused, for a scan and for an object', () => {
  for (const scope of ['scan', 'object'] as const) {
    assert(patchTransformProblem(scope, { matrix: null }) !== null, scope)
    assertEquals(patchTransformProblem(scope, { matrix: undefined }), null, 'an absent matrix is nothing to check')
  }
})

Deno.test('what a patch stores of its transform is the matrix, the position, the rotation and the size, and nothing a request added', () => {
  const matrix = gps()
  const request = {
    matrix,
    position: { x: 1, y: 2, z: 3, note: 'x'.repeat(100_000) },
    rotation: { x: 0, y: 0, z: 0, w: 1, extra: [1, 2, 3] },
    scale: { x: 1, y: 1, z: 1, anything: { deep: true } },
    stowaway: 'y'.repeat(100_000),
  }
  const stored = cleanTransform(request)!
  assertEquals(stored, { matrix, position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } })
  assert(JSON.stringify(stored).length < 1000, 'a patch is the size of its matrix however much a request carried')
  assert(stored.matrix !== matrix, 'a copy, not the request\'s own list')
  assertEquals(cleanTransform({ position: { x: 1, y: 2, z: 3 } }), { position: { x: 1, y: 2, z: 3 } }, 'only the parts that are there')
  assertEquals(cleanTransform({}), {})
  for (const nothing of [undefined, null, 'x', 3, [1, 2, 3], true]) assertEquals(cleanTransform(nothing), undefined)
})

Deno.test('a name the editor resolves to a whole scan is a scan\'s id, its filename or its name, and nothing else', () => {
  const scans = [
    { scanId: 'scan-a', filename: '17_a.glb', name: 'Kitchen' },
    { scanId: 'scan-b', filename: '18_b.glb', name: '' },
  ]
  for (const named of ['scan-a', '17_a.glb', 'Kitchen', 'scan-b', '18_b.glb']) assert(namesAScanRoot(scans, named), named)
  for (const other of ['', 'kitchen', 'scan-a:chair', 'scan-c', 'Kitchen ']) assert(!namesAScanRoot(scans, other), JSON.stringify(other))
  assert(!namesAScanRoot([], 'scan-a'))
})

Deno.test('a patch that is not a scan patch cannot move what the editor would resolve to a whole scan, and nothing else is held back', () => {
  const scans = [{ scanId: 'scan-a', filename: '17_a.glb', name: 'Kitchen' }]
  const matrix = gps()
  for (const scope of ['object', 'point-selection', 'layer', 'world', 'thing'] as const) {
    for (const targetId of ['scan-a', '17_a.glb', 'Kitchen']) {
      const problem = patchProblem({ scope, targetId, transform: { matrix } }, scans)
      assert(problem !== null, `${scope} patch for ${targetId}`)
      assertStringIncludes(problem, 'scan patch')
    }
    assertEquals(patchProblem({ scope, targetId: 'scan-a:chair', transform: { matrix } }, scans), null, `${scope}: a node inside the scan is free`)
  }
  assertEquals(patchProblem({ scope: 'scan', targetId: '17_a.glb', transform: { matrix } }, scans), null, 'a scan patch is how a scan is moved')
  assertEquals(patchProblem({ scope: 'object', targetId: 'scan-a', transform: undefined }, scans), null, 'a label for the scan root needs no matrix')
  assertEquals(patchProblem({ scope: 'object', targetId: 'scan-a', transform: { position: { x: 1, y: 2, z: 3 } } }, scans), null, 'and a move by position only is not a matrix')
  // The transform's own problems come first, and are the same ones patchTransformProblem reports.
  assertEquals(patchProblem({ scope: 'scan', targetId: 'x', transform: { matrix: matrix.slice(0, 15) } }, scans), patchTransformProblem('scan', { matrix: matrix.slice(0, 15) }))
  assertEquals(patchProblem({ scope: 'object', targetId: 'scan-a', transform: 7 }, scans), 'The transform must be an object.')
})

Deno.test('the undo request is a JSON object whose ids, when there, are text; anything else is refused and never read as "not given"', () => {
  assertEquals(parseRevertRequest('{}'), { ok: true, scanId: null, patchId: null })
  assertEquals(parseRevertRequest('{"scanId":"scan-a"}'), { ok: true, scanId: 'scan-a', patchId: null })
  assertEquals(parseRevertRequest('{"scanId":"scan-a","patchId":"patch-1"}'), { ok: true, scanId: 'scan-a', patchId: 'patch-1' })
  assertEquals(parseRevertRequest('{"patchId":"patch-1"}'), { ok: true, scanId: null, patchId: 'patch-1' })
  for (const bad of ['', 'not json', '{"scanId": "scan-', '[]', 'null', '42', '"text"', '{"scanId":12345}', '{"patchId":42}', '{"patchId":["x"]}', '{"scanId":""}', '{"scanId":null}', '{"scanId":"a","patchId":{}}']) {
    const parsed = parseRevertRequest(bad)
    assert(!parsed.ok, bad)
    assert(parsed.message.length > 0)
  }
  assertStringIncludes((parseRevertRequest('{"scanId":12345}') as { message: string }).message, 'scanId')
  assertStringIncludes((parseRevertRequest('{"patchId":42}') as { message: string }).message, 'patchId')
})

Deno.test('a JSON object is read as one, and anything else is not', () => {
  assertEquals(parseJsonObject('{"a":1}'), { a: 1 })
  assertEquals(parseJsonObject('{}'), {})
  for (const other of ['', 'x', '[1]', 'null', '1', '"s"', 'true', '{"a":']) assertEquals(parseJsonObject(other), null, other)
})

// ─── The upload sidecar ──────────────────────────────────────────────────────

const sidecar = (extra: Record<string, unknown>): string => JSON.stringify({
  detectionCount: 4,
  sessionId: 'session-1',
  projectId: 'proj-a',
  geoLat: 51.5,
  geoLng: -0.12,
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'provisional',
  calibration: { method: 'two-point-ground', status: 'provisional', separationM: 1.9, sessionToProject: calibrated() },
  projectTransform: calibrated(),
  ...extra,
})

Deno.test('an upload with a good transform is stored byte for byte as the phone sent it', () => {
  for (const raw of [sidecar({}), JSON.stringify({ detectionCount: 1 }), JSON.stringify({ projectTransform: null }), '{"projectTransform":' + JSON.stringify(gps()) + '}']) {
    const result = sanitiseUploadMetadata(raw)
    assertEquals(result.metadata, raw)
    assertEquals(result.rejected, null)
  }
})

Deno.test('metadata that is not JSON is stored as it arrived and never refused', () => {
  for (const raw of ['not json', '', '{"projectTransform": [1,2']) {
    const result = sanitiseUploadMetadata(raw)
    assertEquals(result.metadata, raw)
    assertEquals(result.rejected, null)
  }
})

Deno.test('JSON that is not an object says nothing about the scan and is stored as an empty one, so reading the sidecar back cannot throw', () => {
  for (const raw of ['[1,2,3]', '"text"', '42', 'null', 'true', '[]']) {
    const result = sanitiseUploadMetadata(raw)
    assertEquals(result.rejected, null, raw)
    assertEquals(result.metadata, '{}', raw)
    // What the server does with a sidecar: read a field off it. A kept `null` throws here, in every world read.
    const stored = JSON.parse(result.metadata) as Record<string, unknown>
    assertEquals(stored['sessionId'], undefined)
  }
})

Deno.test('an upload whose transform is not valid is kept and flagged: the transform is set aside, the rest is stored', () => {
  const skewed = skewedBy(calibrated(), 0.05)
  const result = sanitiseUploadMetadata(sidecar({ projectTransform: skewed }))
  assertNotEquals(result.rejected, null)
  assertStringIncludes(result.rejected!, 'skewed')

  const stored = JSON.parse(result.metadata) as Record<string, unknown>
  // The transform is not used, and nothing says the scan was calibrated by it.
  assertEquals(stored['projectTransform'], null)
  assertEquals(stored['calibrationMethod'], null)
  assertEquals(stored['calibrationStatus'], 'uncalibrated')
  assertEquals(stored['calibration'], null)
  // Everything else the phone said is still there.
  assertEquals(stored['detectionCount'], 4)
  assertEquals(stored['sessionId'], 'session-1')
  assertEquals(stored['projectId'], 'proj-a')
  assertEquals(stored['geoLat'], 51.5)
  // And the refused values are kept, with the reason, so a repair can put them back.
  const flag = stored['projectTransformRejected'] as { reason: string; message: string; original: { projectTransform: number[]; calibration: { separationM: number } } }
  assertEquals(flag.reason, 'skewed')
  assertEquals(flag.message, result.rejected)
  assertEquals(flag.original.projectTransform, skewed)
  assertEquals(flag.original.calibration.separationM, 1.9)
  assertEquals(rejectedTransformMessage(stored), result.rejected)
})

Deno.test('every kind of bad transform is set aside the same way: NaN as null, short, scaled out of range, mirrored', () => {
  const withNull = calibrated() as Array<number | null>
  withNull[12] = null
  const mirrored = calibrated()
  for (const i of [8, 9, 10]) mirrored[i] = -mirrored[i]!
  for (const bad of [withNull, calibrated().slice(0, 15), scaled(calibrated(), 9), mirrored, 'matrix', { not: 'a list' }, 7]) {
    const result = sanitiseUploadMetadata(sidecar({ projectTransform: bad }))
    assertNotEquals(result.rejected, null, JSON.stringify(bad))
    const stored = JSON.parse(result.metadata) as Record<string, unknown>
    assertEquals(stored['projectTransform'], null, JSON.stringify(bad))
    assertEquals(stored['calibrationStatus'], 'uncalibrated')
  }
})

Deno.test('an upload cannot flag itself', () => {
  const claimed = sanitiseUploadMetadata(sidecar({ projectTransformRejected: { message: 'forged' } }))
  assertEquals(claimed.rejected, null)
  assertEquals(rejectedTransformMessage(JSON.parse(claimed.metadata)), undefined)
  // A forged flag beside a bad transform is replaced by the server's own reason.
  const both = sanitiseUploadMetadata(sidecar({ projectTransformRejected: { message: 'forged' }, projectTransform: skewedBy(calibrated(), 0.05) }))
  assertStringIncludes(both.rejected!, 'skewed')
  assertEquals(rejectedTransformMessage(JSON.parse(both.metadata)), both.rejected)
})

Deno.test('a refused value too long to keep is noted by its length, the refused 16 numbers are always kept, and the sidecar stays small', () => {
  const huge = new Array(5000).fill(0.123456789)
  const result = sanitiseUploadMetadata(sidecar({ projectTransform: huge }))
  assertNotEquals(result.rejected, null)
  const flag = (JSON.parse(result.metadata) as { projectTransformRejected: { original: { projectTransform: { omitted: boolean; characters: number }; calibration: unknown } } }).projectTransformRejected
  assertEquals(flag.original.projectTransform.omitted, true)
  assertEquals(flag.original.projectTransform.characters, JSON.stringify(huge).length)
  assert(result.metadata.length < 5000, 'the sidecar did not grow by the size of the refused value')

  // A long calibration record does not take the numbers of the transform with it.
  const bad = skewedBy(calibrated(), 0.05)
  const bulky = sanitiseUploadMetadata(sidecar({ projectTransform: bad, calibration: { points: 'x'.repeat(30_000) } }))
  const kept = (JSON.parse(bulky.metadata) as { projectTransformRejected: { original: { projectTransform: number[]; calibration: { omitted: boolean; characters: number } } } }).projectTransformRejected.original
  assertEquals(kept.projectTransform, bad)
  assertEquals(kept.calibration.omitted, true)
  assert(kept.calibration.characters > 30_000)
})

Deno.test('metadata too long to read is not read: the scan is stored with a sidecar that only says so', () => {
  const pad = (length: number): string => {
    const head = '{"detectionCount":9,"pad":"'
    const tail = '"}'
    return head + 'x'.repeat(length - head.length - tail.length) + tail
  }
  const atTheLimit = pad(MAX_CHECKED_METADATA_CHARS)
  assertEquals(atTheLimit.length, MAX_CHECKED_METADATA_CHARS)
  assertEquals(sanitiseUploadMetadata(atTheLimit), { metadata: atTheLimit, rejected: null }, 'at the limit it is read, and stored as it came')

  const over = sanitiseUploadMetadata(pad(MAX_CHECKED_METADATA_CHARS + 1))
  assertNotEquals(over.rejected, null)
  assertStringIncludes(over.rejected!, 'too long')
  assert(over.metadata.length < 1000, 'the phone\'s text is not copied')
  const stored = JSON.parse(over.metadata) as Record<string, unknown>
  assertEquals(stored['projectTransform'], null)
  assertEquals(stored['calibrationStatus'], 'uncalibrated')
  assertEquals(stored['calibrationMethod'], null)
  assertEquals(rejectedTransformMessage(stored), over.rejected)
})

Deno.test('a reason that the sidecar no longer gives is cleared from the stored row, not left standing', () => {
  // refreshWorldScans lays the fresh manifest over the stored row: { ...scan, ...next }.
  const stored = { scanId: 'scan-a', projectTransformRejected: 'The scan would be skewed.' }
  const repaired = { ...stored, ...rejectedTransformField({ projectTransform: calibrated() }) }
  assertEquals(repaired.projectTransformRejected, undefined)
  assertEquals(JSON.parse(JSON.stringify(repaired)), { scanId: 'scan-a' }, 'and nothing is written for it')
  const kept = { ...stored, ...rejectedTransformField({ projectTransformRejected: { message: 'The scan would be skewed.' } }) }
  assertEquals(kept.projectTransformRejected, 'The scan would be skewed.')
})

Deno.test('the flag is read back as plain words, and a record without one reads as nothing wrong', () => {
  assertEquals(rejectedTransformMessage({}), undefined)
  assertEquals(rejectedTransformMessage({ projectTransformRejected: null }), undefined)
  assertEquals(rejectedTransformMessage({ projectTransformRejected: { message: 'The scan would be skewed.' } }), 'The scan would be skewed.')
  assertEquals(rejectedTransformMessage({ projectTransformRejected: { reason: 'x' } }), 'The saved transform could not be used.')
})

// ─── Undoing a move ──────────────────────────────────────────────────────────

function scanRow(over: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId: 'scan-a',
    projectId: null,
    sessionId: null,
    filename: 'a.glb',
    name: 'a',
    glbUrl: '/scans/a.glb',
    geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localToWorld: calibrated(),
    calibratedLocalToWorld: normaliseZeros(calibrated()),
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
    ...over,
  }
}

let patchCounter = 0
function movePatch(scan: Pick<ScanManifest, 'scanId' | 'filename'>, matrix: number[], over: Partial<EditPatch> = {}): EditPatch {
  patchCounter++
  return {
    patchId: `patch-${patchCounter}`,
    worldId: 'world-test',
    scanId: scan.scanId,
    targetId: scan.filename,
    scope: 'scan',
    transform: { matrix },
    createdAt: new Date(2026, 0, 1, 0, 0, patchCounter).toISOString(),
    ...over,
  }
}

/** What replaying the log in order ends on, which is what applyPatchToWorld and the editor both do. */
function placementAfterReplay(world: Pick<WorldProject, 'scans' | 'editPatches'>, scan: ScanManifest): number[] {
  let matrix = scan.calibratedLocalToWorld!
  for (const patch of world.editPatches) {
    if (patch.scope === 'scan' && (patch.scanId === scan.scanId || patch.targetId === scan.filename) && patch.transform?.matrix) {
      matrix = patch.transform.matrix
    }
  }
  return matrix
}

const moved = (dx: number): number[] => {
  const matrix = calibrated()
  matrix[12] += dx
  return matrix
}

Deno.test('undo takes back the last move, and again the one before, and then the placement the scan arrived with', () => {
  const scan = scanRow()
  const world = { scans: [scan], editPatches: [] as EditPatch[] }
  const first = movePatch(scan, moved(0.1))
  const second = movePatch(scan, moved(0.2))
  world.editPatches.push(first, second)

  const one = planRevert(world, { scanId: 'scan-a' })
  assert(one.ok)
  assertEquals(one.target.patchId, second.patchId)
  assertEquals(one.matrix, moved(0.1))
  assertEquals(one.restoredTo, 'earlier-move')
  world.editPatches.push(buildRevertPatch('world-test', one, { patchId: 'revert-1', actorId: 'u', createdAt: 'now' }))
  assertEquals(placementAfterReplay(world, scan), moved(0.1), 'replaying the log lands on the earlier move')

  const two = planRevert(world, { scanId: 'scan-a' })
  assert(two.ok)
  assertEquals(two.target.patchId, first.patchId, 'the second undo steps back past the first, it does not redo')
  assertEquals(two.matrix, scan.calibratedLocalToWorld)
  assertEquals(two.restoredTo, 'first-placement')
  world.editPatches.push(buildRevertPatch('world-test', two, { patchId: 'revert-2', actorId: 'u', createdAt: 'now' }))
  assertEquals(placementAfterReplay(world, scan), scan.calibratedLocalToWorld)

  const three = planRevert(world, { scanId: 'scan-a' })
  assert(!three.ok)
  assertEquals(three.status, 409)
  assertStringIncludes(three.message, 'no saved move')
})

Deno.test('the undo is itself recorded: an ordinary scan patch naming the one it undid, and it carries the matrix untouched', () => {
  const scan = scanRow()
  const patch = movePatch(scan, moved(0.3))
  const plan = planRevert({ scans: [scan], editPatches: [patch] }, { scanId: 'scan-a' })
  assert(plan.ok)
  const record = buildRevertPatch('world-test', plan, { patchId: 'revert-x', actorId: 'editor-1', createdAt: '2026-02-03T00:00:00.000Z' })
  assertEquals(record.scope, 'scan')
  assertEquals(record.scanId, 'scan-a')
  assertEquals(record.targetId, 'a.glb')
  assertEquals(record.revertsPatchId, patch.patchId)
  assertEquals(record.actorId, 'editor-1')
  assert(record.transform?.matrix?.every((entry, i) => Object.is(entry, scan.calibratedLocalToWorld![i])), 'the stored placement, bit for bit')
  assertEquals(liveScanPlacementPatches([patch, record], scan), [], 'neither the move nor its undo is a live move')
})

Deno.test('a new move after an undo is live again, and undoing it goes to the move before the undone one', () => {
  const scan = scanRow()
  const a = movePatch(scan, moved(0.1))
  const b = movePatch(scan, moved(0.2))
  const world = { scans: [scan], editPatches: [a, b] as EditPatch[] }
  const undoB = planRevert(world, {})
  assert(undoB.ok)
  world.editPatches.push(buildRevertPatch('world-test', undoB, { patchId: 'r1', actorId: 'u', createdAt: 'now' }))
  const c = movePatch(scan, moved(0.5))
  world.editPatches.push(c)
  assertEquals(liveScanPlacementPatches(world.editPatches, scan).map((p) => p.patchId), [a.patchId, c.patchId])
  const undoC = planRevert(world, {})
  assert(undoC.ok)
  assertEquals(undoC.target.patchId, c.patchId)
  assertEquals(undoC.matrix, moved(0.1), 'back to a, because b was already undone')
})

Deno.test('a reset to the stored placement is an ordinary move, and undoing it brings back the move it reset', () => {
  const scan = scanRow()
  const moveA = movePatch(scan, moved(0.4))
  const reset = movePatch(scan, normaliseZeros(scan.calibratedLocalToWorld!))
  const plan = planRevert({ scans: [scan], editPatches: [moveA, reset] }, { scanId: 'scan-a' })
  assert(plan.ok)
  assertEquals(plan.target.patchId, reset.patchId)
  assertEquals(plan.matrix, moved(0.4))
})

Deno.test('undo without a scan takes back the newest move in the whole log, and with a scan only that scan\'s', () => {
  const a = scanRow()
  const b = scanRow({ scanId: 'scan-b', filename: 'b.glb', calibratedLocalToWorld: normaliseZeros(gps()), localToWorld: gps() })
  const moveA = movePatch(a, moved(0.1))
  const moveB = movePatch(b, moved(0.7))
  const moveA2 = movePatch(a, moved(0.2))
  const world = { scans: [a, b], editPatches: [moveA, moveB, moveA2] }
  const newest = planRevert(world, {})
  assert(newest.ok)
  assertEquals([newest.scan.scanId, newest.target.patchId], ['scan-a', moveA2.patchId])
  const ofB = planRevert(world, { scanId: 'scan-b' })
  assert(ofB.ok)
  assertEquals(ofB.target.patchId, moveB.patchId)
  assertEquals(ofB.matrix, b.calibratedLocalToWorld)
  const unknown = planRevert(world, { scanId: 'scan-zzz' })
  assert(!unknown.ok)
  assertEquals(unknown.status, 404)
})

Deno.test('an undo made from a stale view is refused, so it cannot take back a different move than the one the person saw', () => {
  const scan = scanRow()
  const first = movePatch(scan, moved(0.1))
  const second = movePatch(scan, moved(0.2))
  const world = { scans: [scan], editPatches: [first, second] }
  const stale = planRevert(world, { scanId: 'scan-a', patchId: first.patchId })
  assert(!stale.ok)
  assertEquals(stale.status, 409)
  assertStringIncludes(stale.message, 'changed after you opened it')
  const fresh = planRevert(world, { scanId: 'scan-a', patchId: second.patchId })
  assert(fresh.ok)
})

Deno.test('an undo never puts a scan somewhere that makes it vanish: bad matrices in the log are stepped over, and with no first placement it refuses', () => {
  const scan = scanRow()
  const good = movePatch(scan, moved(0.1))
  const broken = calibrated()
  broken[12] = Number.NaN
  const old = movePatch(scan, broken)
  const latest = movePatch(scan, moved(0.2))
  const plan = planRevert({ scans: [scan], editPatches: [good, old, latest] }, { scanId: 'scan-a' })
  assert(plan.ok)
  assertEquals(plan.matrix, moved(0.1), 'the invalid move in between is skipped')

  const onlyBroken = planRevert({ scans: [scan], editPatches: [old, latest] }, { scanId: 'scan-a' })
  assert(onlyBroken.ok)
  assertEquals(onlyBroken.restoredTo, 'first-placement')

  const unknownStart = scanRow({ calibratedLocalToWorld: undefined })
  const refused = planRevert({ scans: [unknownStart], editPatches: [movePatch(unknownStart, moved(0.1))] }, { scanId: 'scan-a' })
  assert(!refused.ok)
  assertEquals(refused.status, 409)
  assertStringIncludes(refused.message, 'was not stored')
})

Deno.test('a first placement that is stored but is not a valid placement is not restored, whatever is wrong with it', () => {
  const withNaN = calibrated()
  withNaN[12] = Number.NaN
  for (const stored of [[1, 2, 3], withNaN, scaled(calibrated(), 5), calibrated().slice(0, 15), 'x' as unknown as number[]]) {
    const scan = scanRow({ calibratedLocalToWorld: stored })
    const refused = planRevert({ scans: [scan], editPatches: [movePatch(scan, moved(0.1))] }, { scanId: 'scan-a' })
    assert(!refused.ok, JSON.stringify(stored))
    assertEquals(refused.status, 409)
  }
})

Deno.test('a patch that changes a label or a note, or carries no matrix, is not a move: it is not in the log of moves and undoing it is not offered', () => {
  const scan = scanRow()
  const note = { ...movePatch(scan, moved(0.1)), transform: undefined, label: 'Kitchen' }
  const partsOnly = { ...movePatch(scan, moved(0.1)), transform: { position: { x: 1, y: 0, z: 0 } } }
  const noMatrix = { ...movePatch(scan, moved(0.1)), transform: { matrix: null as unknown as number[] } }
  assertEquals(liveScanPlacementPatches([note, partsOnly, noMatrix], scan), [])
  const refused = planRevert({ scans: [scan], editPatches: [note, partsOnly, noMatrix] }, { scanId: 'scan-a' })
  assert(!refused.ok)
  assertStringIncludes(refused.message, 'no saved move')
  // Nor does one count as the move that took the scan off its first placement.
  const legacy = scanRow({ calibratedLocalToWorld: undefined, localToWorld: moved(0.4) })
  assertEquals(stampFirstSightPlacements({ scans: [legacy], editPatches: [note, partsOnly] }, () => undefined), true)
  assertEquals(legacy.calibratedLocalToWorld, moved(0.4), 'a scan that only had a label changed still sits at its first placement')
})

Deno.test('a patch that names its scan only by filename, as the editor\'s own replay also accepts, counts in the log like any other', () => {
  const scan = scanRow()
  const byFilename = movePatch(scan, moved(0.25), { scanId: undefined })
  assertEquals(liveScanPlacementPatches([byFilename], scan), [byFilename])
  const plan = planRevert({ scans: [scan], editPatches: [byFilename] }, { scanId: 'scan-a' })
  assert(plan.ok)
  assertEquals(plan.target.patchId, byFilename.patchId)
  // And such a patch means the scan was moved, so its first placement is not read off the moved row.
  const legacy = scanRow({ calibratedLocalToWorld: undefined, localToWorld: moved(0.25) })
  assertEquals(stampFirstSightPlacements({ scans: [legacy], editPatches: [byFilename] }, () => calibrated()), true)
  assertEquals(legacy.calibratedLocalToWorld, calibrated(), 'the upload\'s calibrated placement, not the moved one')
  // With no calibration to read, the move is all there is, and a row that was moved has no first placement to offer.
  const uncalibrated = scanRow({ calibratedLocalToWorld: undefined, localToWorld: moved(0.25) })
  assertEquals(stampFirstSightPlacements({ scans: [uncalibrated], editPatches: [byFilename] }, () => undefined), false)
  assertEquals(uncalibrated.calibratedLocalToWorld, undefined, 'a scan moved by a patch that names only its filename is not stamped with where it was moved to')
  // A patch about another scan is not this scan\'s.
  const other = scanRow({ scanId: 'scan-other', filename: 'other.glb' })
  assertEquals(liveScanPlacementPatches([movePatch(other, moved(1))], scan), [])
})

Deno.test('an entry in the log that is not a patch is skipped, so a damaged world file cannot make every read of it fail', () => {
  const scan = scanRow()
  const real = movePatch(scan, moved(0.1))
  const damaged = [null, undefined, 7, 'x', [1, 2]] as unknown as EditPatch[]
  const log = [...damaged, real, ...damaged]
  assertEquals(liveScanPlacementPatches(log, scan), [real])
  const plan = planRevert({ scans: [scan], editPatches: log }, { scanId: 'scan-a' })
  assert(plan.ok)
  assertEquals(plan.target.patchId, real.patchId)
  const unstamped = scanRow({ calibratedLocalToWorld: undefined, localToWorld: moved(0.3) })
  assertEquals(stampFirstSightPlacements({ scans: [unstamped], editPatches: log }, () => undefined), false, 'one real move, so no first placement to read off the moved row')
  const fresh = scanRow({ calibratedLocalToWorld: undefined })
  assertEquals(stampFirstSightPlacements({ scans: [fresh], editPatches: damaged }, () => undefined), true)
})

Deno.test('PlacementRefused carries the status the route answers with', () => {
  const refusal = new PlacementRefused(409, 'no')
  assertEquals([refusal.status, refusal.message, refusal instanceof Error], [409, 'no', true])
})

// ─── The placement a scan arrived with ───────────────────────────────────────

Deno.test('a scan nobody has moved is stamped with the placement it has, and the stamp is written once', () => {
  const scan = scanRow({ calibratedLocalToWorld: undefined })
  const world = { scans: [scan], editPatches: [] as EditPatch[] }
  assertEquals(stampFirstSightPlacements(world, () => undefined), true)
  assertEquals(scan.calibratedLocalToWorld, calibrated())

  // Later, whatever the row says, the stamp stays: written once, never overwritten.
  scan.localToWorld = moved(9)
  assertEquals(stampFirstSightPlacements(world, () => moved(5)), false)
  assertEquals(scan.calibratedLocalToWorld, calibrated())
})

Deno.test('a stamp is never overwritten even when the stored value is odd, and each scan is stamped on its own', () => {
  const odd = scanRow({ scanId: 'scan-odd', filename: 'odd.glb', calibratedLocalToWorld: [1, 2, 3] })
  const fresh = scanRow({ scanId: 'scan-new', filename: 'new.glb', calibratedLocalToWorld: undefined, localToWorld: gps() })
  const world = { scans: [odd, fresh], editPatches: [] as EditPatch[] }
  assertEquals(stampFirstSightPlacements(world, () => undefined), true)
  assertEquals(odd.calibratedLocalToWorld, [1, 2, 3])
  assertEquals(fresh.calibratedLocalToWorld, gps())
  assertEquals(stampFirstSightPlacements(world, () => undefined), false, 'a second pass finds nothing to do')
})

Deno.test('a minus zero is stored as zero, so the world file and memory hold the same bits', () => {
  const rotation = composeYUpTransform({ x: 1, y: 0, z: 2 }, 0)
  assert(rotation.some((entry) => Object.is(entry, -0)), 'the calibration builders do produce -0')
  const scan = scanRow({ calibratedLocalToWorld: undefined, localToWorld: rotation })
  stampFirstSightPlacements({ scans: [scan], editPatches: [] }, () => undefined)
  assert(scan.calibratedLocalToWorld!.every((entry) => !Object.is(entry, -0)))
  const wire = JSON.parse(JSON.stringify(scan.calibratedLocalToWorld)) as number[]
  assert(wire.every((entry, i) => Object.is(entry, scan.calibratedLocalToWorld![i])))
})

Deno.test('a scan that was moved before the stamp existed gets its calibrated placement from the upload, or none at all', () => {
  const moved1 = scanRow({ scanId: 'scan-1', filename: '1.glb', calibratedLocalToWorld: undefined, localToWorld: moved(0.4) })
  const moved2 = scanRow({ scanId: 'scan-2', filename: '2.glb', calibratedLocalToWorld: undefined, localToWorld: moved(0.4) })
  const moved3 = scanRow({ scanId: 'scan-3', filename: '3.glb', calibratedLocalToWorld: undefined, localToWorld: moved(0.4) })
  const world = {
    scans: [moved1, moved2, moved3],
    editPatches: [movePatch(moved1, moved(0.4)), movePatch(moved2, moved(0.4)), movePatch(moved3, moved(0.4))],
  }
  const sidecar = (filename: string): unknown => ({ '1.glb': calibrated(), '2.glb': undefined, '3.glb': [1, 2, 3] })[filename]
  assertEquals(stampFirstSightPlacements(world, sidecar), true)
  assertEquals(moved1.calibratedLocalToWorld, calibrated(), 'the calibrated placement the scan was uploaded with')
  assertEquals(moved2.calibratedLocalToWorld, undefined, 'a GPS placement that was moved has no first placement to recover')
  assertEquals(moved3.calibratedLocalToWorld, undefined, 'an upload record that is not a valid placement is not used')
  assertEquals(stampFirstSightPlacements(world, sidecar), false)
})

Deno.test('a first placement that would be refused as a patch is not stored, so Reset can never offer a placement the server refuses', () => {
  const withNaN = gps()
  withNaN[12] = Number.NaN
  const skewed = scanRow({ calibratedLocalToWorld: undefined, localToWorld: scaled(gps(), 3) })
  const broken = scanRow({ scanId: 'scan-b', filename: 'b.glb', calibratedLocalToWorld: undefined, localToWorld: withNaN })
  const world = { scans: [skewed, broken], editPatches: [] as EditPatch[] }
  assertEquals(stampFirstSightPlacements(world, () => undefined), false)
  assertEquals([skewed.calibratedLocalToWorld, broken.calibratedLocalToWorld], [undefined, undefined])
})

Deno.test('the sidecar is read for a scan that needs a stamp, and for no other', () => {
  const unpatched = scanRow({ calibratedLocalToWorld: undefined })
  const stamped = scanRow({ scanId: 'scan-stamped', filename: 'stamped.glb' })
  const calls: string[] = []
  stampFirstSightPlacements({ scans: [unpatched, stamped], editPatches: [] }, (filename) => {
    calls.push(filename)
    return calibrated()
  })
  assertEquals(calls, ['a.glb'])
})

Deno.test('a calibration the upload carried is the first placement, whether or not the row sits at it', () => {
  // A row built before its sidecar could be read froze at the GPS or grid placement; the calibration is still the calibrated one.
  const scan = scanRow({ calibratedLocalToWorld: undefined, localToWorld: gps() })
  assertEquals(stampFirstSightPlacements({ scans: [scan], editPatches: [] }, () => calibrated()), true)
  assertEquals(scan.calibratedLocalToWorld, calibrated())
  assertEquals(scan.localToWorld, gps(), 'and the row itself is not moved: only the person resets it')
})

Deno.test('with no usable calibration an unmoved scan\'s first placement is the one its row has', () => {
  const skewed = skewedBy(calibrated(), 0.05)
  for (const sidecar of [undefined, null, skewed, [1, 2, 3], 'x']) {
    const scan = scanRow({ calibratedLocalToWorld: undefined, localToWorld: gps() })
    assertEquals(stampFirstSightPlacements({ scans: [scan], editPatches: [] }, () => sidecar), true, JSON.stringify(sidecar))
    assertEquals(scan.calibratedLocalToWorld, gps(), JSON.stringify(sidecar))
  }
})

