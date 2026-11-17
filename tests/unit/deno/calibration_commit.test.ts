/**
 * The calibration commit (src/ar/calibration-commit.ts) under Deno's type checker.
 *
 * The modal that used to hold this logic references `TouchEvent`, `PointerEvent` and `HTMLCanvasElement`, so it
 * could not be imported into a Deno test at all: type-checking it drags the DOM lib in (ADR 0002, and the note at
 * the top of src/ar/ground-gate.ts). This module is the part of it that can, and this file is the proof: `deno test`
 * checks every file it imports before running one, so it passes only while the module, and everything it imports
 * (the constellation flow and the frame fit among them), is free of DOM and Deno references.
 *
 * The claims about what the module does are held in tests/unit/node/wp-calibration-commit.test.ts and
 * tests/unit/node/wp-constellation-flow.test.ts, and in tests/unit/node/wp-calibration-characterisation.test.ts (the modal
 * around it). These are the same contract, written once more for this runtime: a first calibration, a return visit matched
 * and not matched by distance and by a fit of three points, "Use anyway", the one-point tier, and the options' defaults.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  assessTwoPoint,
  buildOnePointCommit,
  buildTwoPointCommit,
  mismatchCopy,
  readTap,
  resolveCommitOptions,
  type TwoPointFrame,
} from '../../../src/ar/calibration-commit.ts'
import { twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { twoPointToleranceM } from '../../../src/world/frame-fit.ts'

const DEFAULTS = resolveCommitOptions({ hitTest: () => Promise.resolve(null) })

const pair = (apart: number) => ({ landmark: { x: 0, y: -1.2, z: 0 }, headingMarker: { x: apart, y: -1.2, z: 0 } })

/** The spacing tolerance a verdict applies at the adopted tap noise: what a scan and a frame record. */
const TOLERANCE_M = twoPointToleranceM(0.03)

const stored = (separationM: number, toleranceM = 0.15): TwoPointFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  toleranceM,
  anchorBearingDeg: null,
})

Deno.test('a first calibration is accepted as provisional and writes the calibration and the Place frame', () => {
  const verdict = assessTwoPoint({ ...pair(3), stored: null, override: false }, DEFAULTS)
  assertEquals(verdict, {
    kind: 'accepted',
    separationM: 3,
    residualM: 0,
    toleranceM: TOLERANCE_M,
    frameChanged: true,
    status: 'provisional',
    sessionToProject: twoPointToProjectTransform(pair(3).landmark, pair(3).headingMarker),
  })
  if (verdict.kind !== 'accepted') return
  const { calibration, spatialFrame } = buildTwoPointCommit(verdict, {
    ...pair(3), frameBearingDeg: 100, bearingConvention: 2, pointLabels: undefined, calibratedAt: '2026-11-16T09:30:00.000Z',
  })
  assertEquals(calibration.method, 'two-point-ground')
  assertEquals(calibration.status, 'provisional')
  assertEquals(spatialFrame?.headingMarker, { x: 0, y: 0, z: 3 })
  assertEquals(spatialFrame?.separationM, 3)
  assertEquals(spatialFrame?.toleranceM, TOLERANCE_M, 'the tolerance a later visit is judged by is the one the verdict applies')
})

Deno.test('a stored pair matched inside the spacing tolerance is provisional and keeps the Place frame; one outside is a mismatch', () => {
  const matched = assessTwoPoint({ ...pair(3.125), stored: stored(3), override: false }, DEFAULTS)
  assert(matched.kind === 'accepted')
  assertEquals([matched.residualM, matched.toleranceM, matched.frameChanged], [0.125, TOLERANCE_M, false])
  assertEquals(matched.status, 'provisional', 'a distance check is never verified')
  assertEquals(matched.comparison?.checkedBy, 'separation')
  const off = assessTwoPoint({ ...pair(3.4), stored: stored(3), override: false }, DEFAULTS)
  assertEquals(off.kind, 'mismatch')
  assert(off.kind === 'mismatch' && mismatchCopy(off.residualM).startsWith('Measured 40 cm further apart than the recorded pair.'))
  const kept = assessTwoPoint({ ...pair(3.4), stored: stored(3), override: true }, DEFAULTS)
  assert(kept.kind === 'accepted' && kept.status === 'provisional' && kept.frameChanged)
})

Deno.test('a pair under the minimum baseline is refused', () => {
  assertEquals(assessTwoPoint({ ...pair(0.9999999999999999), stored: null, override: false }, DEFAULTS), { kind: 'refused', reason: 'too-close' })
  assertEquals(assessTwoPoint({ ...pair(1), stored: null, override: false }, DEFAULTS).kind, 'accepted')
})

Deno.test('one point: a compass reading commits provisionally, and none is refused with its reason', () => {
  const input = { landmark: { x: 1, y: -1.2, z: 2 }, bearingConvention: 2 as const, existingFrame: undefined, calibratedAt: '2026-11-16T09:30:00.000Z' }
  const committed = buildOnePointCommit({ ...input, frameBearingDeg: 90 }, DEFAULTS)
  assert(committed.kind === 'committed' && committed.calibration.status === 'provisional' && committed.spatialFrame?.method === 'ground-tap-compass')
  assertEquals(
    buildOnePointCommit({ ...input, frameBearingDeg: null }, DEFAULTS),
    { kind: 'refused', reason: 'no-compass', text: 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.' },
  )
})

Deno.test('options default to one hit from the host\'s hit test, never disturbed, and the adopted sigma', async () => {
  const asked: Array<[number, number]> = []
  const resolved = resolveCommitOptions({ hitTest: (x, y) => { asked.push([x, y]); return Promise.resolve({ position: { x: 1, y: 0, z: 2 } }) } })
  assertEquals(await readTap(resolved, 0.25, 0.75), { position: { x: 1, y: 0, z: 2 } })
  assertEquals(asked, [[0.25, 0.75]])
  assertEquals(resolved.isDisturbed(), false)
  assertEquals(resolved.sigmaHatM, 0.03)
  const disturbed = resolveCommitOptions({ hitTest: () => Promise.resolve(null), isDisturbed: () => true })
  assertEquals(assessTwoPoint({ ...pair(3), stored: null, override: false }, disturbed), { kind: 'refused', reason: 'disturbed' })
})
