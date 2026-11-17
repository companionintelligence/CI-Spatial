/**
 * What the editor does with a place-register proposal, and what it may claim.
 *
 * src/world/register-proposal.ts holds every rule about applying one: which patch
 * Apply writes, when it may be written, and what a second press does. It has no
 * DOM and no THREE, so the rules run here for real. What does not run here is
 * the card and the ghost (src/viewer/register-proposal.ts draws with three.js and
 * the DOM); that they paint on a screen is for a browser, not this file.
 *
 * The order the proposal arrives in is the order the tests follow: the artifact is
 * read back out of a job (it came through JSON, so it is checked, not trusted);
 * Apply builds a patch whose matrix is the correction on top of the scan's
 * placement and whose provenance names the job; pressing Apply twice writes one
 * patch; a scan that has moved since the check is not moved again on the strength
 * of an old measurement; and nothing the editor says calls a scan aligned or
 * verified.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15a-*.test.ts
 * `npm run verify` reaches it through `npm run test:wave`, which runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import type { EditPatch, ScanManifest, WorldJob } from '../../../src/world/types.ts'
import {
  applyRegistrationProposal,
  buildRegisterPatch,
  decomposeMatrix,
  describeRegisterResult,
  findAppliedRegisterPatch,
  matricesAgree,
  multiplyMat4,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  type PlaceRegisterResult,
  readPlaceRegisterResult,
  refusalText,
  type RegisterPatchBody,
  registerApplyState,
  type RegistrationProposal,
  type RegistrationRefusal,
} from '../../../src/world/register-proposal.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const yawTranslation = (yaw: number, tx: number, ty: number, tz: number): number[] => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]
}

/** Where the new scan and its reference sit when the job runs. The new scan sits turned and offset, as a calibration leaves it. */
const MOVING_PLACEMENT = yawTranslation(0.4, 12, 0.02, -3)
const REFERENCE_PLACEMENT = IDENTITY
/** The correction the proposal asks for. */
const CORRECTION = yawTranslation(-0.02, 0.18, 0.01, -0.07)

function proposed(overrides: Partial<RegistrationProposal> = {}): RegistrationProposal {
  return {
    status: 'proposed',
    transform: CORRECTION,
    overlapFraction: 0.91,
    inlierResidualM: 0.031,
    score: 0.86,
    boundedCorrection: {
      translationM: 0.19,
      yawDeg: -1.1,
      dyM: 0.004,
      maxShiftM: 0.34,
      withinBound: true,
      bound: { translationM: 1, yawDeg: 10, dyM: 0.3 },
    },
    reason: null,
    details: {
      movingCells: 800,
      referenceCells: 900,
      movingMatchedFraction: 0.91,
      referenceMatchedFraction: 0.8,
      distinctiveness: 0.95,
      fit: 0.9,
      peakRatio: 0.2,
      nearBestReachM: 0.4,
      verticalChecked: true,
      searchedTranslationM: 2,
      searchedYawDeg: 25,
    },
    ...overrides,
  }
}

function refused(reason: RegistrationRefusal): RegistrationProposal {
  return proposed({ status: 'refused', transform: null, reason, score: 0.12, overlapFraction: 0.31, inlierResidualM: 0.04 })
}

function makeResult(proposal: RegistrationProposal = proposed()): PlaceRegisterResult {
  return {
    proposal,
    moving: { scanId: 'scan-b', filename: '200_b.glb', name: 'Second visit', localToWorld: MOVING_PLACEMENT },
    reference: { scanId: 'scan-a', filename: '100_a.glb', name: 'First visit', localToWorld: REFERENCE_PLACEMENT },
    comparisons: [],
    params: { maxCorrectionTranslationM: 1 },
    comparedAt: '2026-11-16T10:00:00.000Z',
    elapsedMs: 120,
  }
}

function jobFor(result: PlaceRegisterResult, overrides: Partial<WorldJob> = {}): WorldJob {
  return {
    jobId: 'job-1',
    worldId: 'world-project-1',
    type: 'place-register',
    status: 'completed',
    scanId: 'scan-b',
    capabilities: [],
    artifacts: [{ type: PLACE_REGISTER_PROPOSAL_ARTIFACT, label: 'Second visit alignment check', metadata: JSON.parse(JSON.stringify(result)) }],
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:01.000Z',
    ...overrides,
  }
}

const scans = (moving = MOVING_PLACEMENT, reference = REFERENCE_PLACEMENT) =>
  [{ scanId: 'scan-b', localToWorld: moving }, { scanId: 'scan-a', localToWorld: reference }] as Array<Pick<ScanManifest, 'scanId' | 'localToWorld'>>

// ── The matrix helpers agree with three.js ──────────────────────────────────

test('multiplyMat4 is the product three.js takes, and applies the right-hand matrix first', () => {
  const a = yawTranslation(0.7, 1, 2, 3)
  const b = yawTranslation(-0.2, -4, 0.5, 6)
  const mine = multiplyMat4(a, b)
  const theirs = new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).toArray()
  mine.forEach((value, i) => assert.ok(Math.abs(value - theirs[i]!) < 1e-12, `entry ${i}`))

  // A point carried through b and then a lands where the product sends it.
  const point = new THREE.Vector3(2, 1, -1)
  const stepwise = point.clone().applyMatrix4(new THREE.Matrix4().fromArray(b)).applyMatrix4(new THREE.Matrix4().fromArray(a))
  const direct = point.clone().applyMatrix4(new THREE.Matrix4().fromArray(mine))
  assert.ok(stepwise.distanceTo(direct) < 1e-12)
})

test('decomposeMatrix agrees with Matrix4.decompose, including a scale and a mirror', () => {
  const cases: number[][] = [
    MOVING_PLACEMENT,
    multiplyMat4(yawTranslation(2.5, 1, 2, 3), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]),
    // A pitch as well as a yaw: the case a pure yaw would hide a sign error in.
    new THREE.Matrix4().compose(new THREE.Vector3(1, -2, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.2, 0.9)), new THREE.Vector3(1, 1, 1)).toArray(),
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
  ]
  for (const matrix of cases) {
    const mine = decomposeMatrix(matrix)!
    const position = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    new THREE.Matrix4().fromArray(matrix).decompose(position, rotation, scale)
    assert.ok(mine, 'decomposes')
    assert.ok(Math.abs(mine.position.x - position.x) < 1e-12 && Math.abs(mine.position.y - position.y) < 1e-12 && Math.abs(mine.position.z - position.z) < 1e-12)
    assert.ok(Math.abs(mine.scale.x - scale.x) < 1e-12 && Math.abs(mine.scale.y - scale.y) < 1e-12 && Math.abs(mine.scale.z - scale.z) < 1e-12)
    // A quaternion and its negation are one rotation.
    const dot = mine.rotation.x * rotation.x + mine.rotation.y * rotation.y + mine.rotation.z * rotation.z + mine.rotation.w * rotation.w
    assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-12, `rotation differs: dot ${dot}`)
  }
  assert.equal(decomposeMatrix([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), null, 'a singular matrix has no decomposition')
  assert.equal(decomposeMatrix([1, 2, 3]), null)
})

// ── Reading a proposal out of a job ─────────────────────────────────────────

test('readPlaceRegisterResult: a proposal comes back out of the JSON the job stored it as', () => {
  const result = makeResult()
  assert.deepEqual(readPlaceRegisterResult(jobFor(result))?.proposal.transform, CORRECTION)
  assert.equal(readPlaceRegisterResult(jobFor(result))?.reference.name, 'First visit')
})

test('readPlaceRegisterResult: only a completed place-register job with a well-formed artifact is a proposal', () => {
  const result = makeResult()
  assert.equal(readPlaceRegisterResult(jobFor(result, { status: 'processing' })), null, 'a job still running proposes nothing')
  assert.equal(readPlaceRegisterResult(jobFor(result, { type: 'memory-push' })), null)
  assert.equal(readPlaceRegisterResult(jobFor(result, { artifacts: [] })), null)
  assert.equal(readPlaceRegisterResult(jobFor(result, { artifacts: undefined })), null)

  const broken = (change: (metadata: Record<string, any>) => void): WorldJob => {
    const job = jobFor(result)
    change(job.artifacts![0]!.metadata as Record<string, any>)
    return job
  }
  assert.equal(readPlaceRegisterResult(broken((m) => { m['proposal'].transform = [1, 2, 3] })), null, 'a transform that is not 16 numbers')
  assert.equal(readPlaceRegisterResult(broken((m) => { m['proposal'].transform = null })), null, 'proposed without a transform')
  assert.equal(readPlaceRegisterResult(broken((m) => { m['proposal'].inlierResidualM = null })), null, 'proposed without a measured residual')
  assert.equal(readPlaceRegisterResult(broken((m) => { m['moving'].localToWorld = [1] })), null, 'a scan with no placement to compare against')
  assert.equal(readPlaceRegisterResult(broken((m) => { delete m['reference'] })), null)
  assert.equal(readPlaceRegisterResult(broken((m) => { m['proposal'].status = 'applied' })), null)

  const refusal = makeResult(refused('low-overlap'))
  assert.equal(readPlaceRegisterResult(jobFor(refusal))?.proposal.status, 'refused')
  const smuggled = jobFor(refusal)
  ;(smuggled.artifacts![0]!.metadata as Record<string, any>)['proposal'].transform = CORRECTION
  assert.equal(readPlaceRegisterResult(smuggled), null, 'a refusal that carries a transform is not something to offer')
})

test('readPlaceRegisterResult: an artifact written before details.floors existed, and one that has it, both read and apply', () => {
  // The fixture's details are the earlier build's: no `floors`. A record on disk from that build must still load.
  const earlier = makeResult()
  assert.equal('floors' in earlier.proposal.details, false)
  const later = makeResult(proposed({ details: { ...proposed().details, floors: { reference: 'cloud', moving: 'hint-over-cloud' } } }))
  for (const result of [earlier, later]) {
    const read = readPlaceRegisterResult(jobFor(result))
    assert.ok(read, 'it reads back')
    assert.deepEqual(read.proposal.transform, CORRECTION)
    assert.equal(registerApplyState(read, 'job-1', scans(), []), 'ready')
    assert.equal(buildRegisterPatch(read, 'job-1')?.provenance.jobId, 'job-1')
  }
  assert.deepEqual(readPlaceRegisterResult(jobFor(later))?.proposal.details.floors, { reference: 'cloud', moving: 'hint-over-cloud' })
})

// ── The patch Apply writes ──────────────────────────────────────────────────

test('buildRegisterPatch: the correction on top of the placement, with the job named as its source', () => {
  const body = buildRegisterPatch(makeResult(), 'job-1')!
  assert.equal(body.scope, 'scan')
  assert.equal(body.scanId, 'scan-b')
  assert.equal(body.targetId, '200_b.glb', 'the filename, as the gizmo writes it for a scan root')
  assert.ok(matricesAgree(body.transform.matrix, multiplyMat4(CORRECTION, MOVING_PLACEMENT)))
  assert.deepEqual(body.provenance, { source: 'place-register', jobId: 'job-1', score: 0.86, residualM: 0.031 })

  // The matrix, the position and the rotation say one thing, as the gizmo's serializeTransform writes them.
  const rebuilt = new THREE.Matrix4().compose(
    new THREE.Vector3(body.transform.position.x, body.transform.position.y, body.transform.position.z),
    new THREE.Quaternion(body.transform.rotation.x, body.transform.rotation.y, body.transform.rotation.z, body.transform.rotation.w),
    new THREE.Vector3(body.transform.scale.x, body.transform.scale.y, body.transform.scale.z),
  )
  assert.ok(matricesAgree(rebuilt.toArray(), body.transform.matrix, 1e-9))
})

test('buildRegisterPatch: a refusal has no patch', () => {
  assert.equal(buildRegisterPatch(makeResult(refused('ambiguous')), 'job-1'), null)
  assert.equal(buildRegisterPatch(makeResult(proposed({ inlierResidualM: null })), 'job-1'), null)
})

// ── When Apply may run ──────────────────────────────────────────────────────

function appliedPatch(jobId = 'job-1'): EditPatch {
  const body = buildRegisterPatch(makeResult(), jobId)!
  return {
    patchId: 'patch-1',
    worldId: 'world-project-1',
    scanId: body.scanId,
    targetId: body.targetId,
    scope: 'scan',
    transform: body.transform,
    provenance: body.provenance,
    createdAt: '2026-11-16T10:05:00.000Z',
  }
}

test('registerApplyState: ready only while nothing has moved and nothing has been applied', () => {
  const result = makeResult()
  assert.equal(registerApplyState(result, 'job-1', scans(), []), 'ready')
  assert.equal(registerApplyState(makeResult(refused('low-overlap')), 'job-1', scans(), []), 'refused')

  const nudged = yawTranslation(0.4, 12.1, 0.02, -3)
  assert.equal(registerApplyState(result, 'job-1', scans(nudged), []), 'stale', 'the new scan was moved by hand since the check')
  assert.equal(registerApplyState(result, 'job-1', scans(MOVING_PLACEMENT, yawTranslation(0, 1, 0, 0)), []), 'stale', 'the reference was moved')
  assert.equal(registerApplyState(result, 'job-1', [{ scanId: 'scan-b', localToWorld: MOVING_PLACEMENT }], []), 'stale', 'the reference is gone')
})

test('registerApplyState: applied wins over stale, because applying is what moves the scan', () => {
  const moved = multiplyMat4(CORRECTION, MOVING_PLACEMENT)
  assert.equal(registerApplyState(makeResult(), 'job-1', scans(moved), [appliedPatch()]), 'applied')
  assert.equal(registerApplyState(makeResult(), 'job-1', scans(moved), []), 'stale', 'moved with no patch to say why')
  assert.equal(findAppliedRegisterPatch([appliedPatch('job-9')], 'job-1'), null, 'another job is not this one')
  assert.equal(findAppliedRegisterPatch([appliedPatch()], 'job-1')?.patchId, 'patch-1')
})

test('patches written before provenance existed read as they always did, and none of them is an application', () => {
  const legacy: EditPatch[] = [
    // The Edit gizmo's scan patch, the shape every world file on disk has.
    { patchId: 'patch-1', worldId: 'world-1', scanId: 'scan-b', targetId: '200_b.glb', scope: 'scan', transform: { matrix: MOVING_PLACEMENT }, actorId: 'local-editor', createdAt: '2026-08-01T00:00:00.000Z' },
    { patchId: 'patch-2', worldId: 'world-1', targetId: 'thing-1', scope: 'thing', label: 'Sofa', createdAt: '2026-08-02T00:00:00.000Z' },
    { patchId: 'patch-3', worldId: 'world-1', scanId: 'scan-b', targetId: 'scan-b/0-node', scope: 'object', visible: false, createdAt: '2026-08-03T00:00:00.000Z' },
  ]
  assert.equal(findAppliedRegisterPatch(legacy, 'job-1'), null)
  assert.equal(registerApplyState(makeResult(), 'job-1', scans(), legacy), 'ready')
})

// ── Applying, and applying twice ────────────────────────────────────────────

/** An editor world that a posted patch changes, as the real one is changed by the server's reply. */
function editor() {
  const state = { scans: scans(), patches: [] as EditPatch[], posts: [] as RegisterPatchBody[] }
  return {
    state,
    deps: {
      scans: () => state.scans,
      patches: () => state.patches,
      post: async (body: RegisterPatchBody) => {
        state.posts.push(body)
        state.patches.push({
          patchId: `patch-${state.posts.length}`,
          worldId: 'world-project-1',
          scanId: body.scanId,
          targetId: body.targetId,
          scope: body.scope,
          transform: body.transform,
          provenance: body.provenance,
          createdAt: '2026-11-16T10:05:00.000Z',
        })
        state.scans = scans(body.transform.matrix)
      },
    },
  }
}

test('Apply writes the patch with its provenance, once, and a second Apply writes nothing', async () => {
  const { state, deps } = editor()
  const result = makeResult()

  assert.equal(await applyRegistrationProposal(result, 'job-1', deps), 'applied')
  assert.equal(state.posts.length, 1)
  assert.deepEqual(state.posts[0]!.provenance, { source: 'place-register', jobId: 'job-1', score: 0.86, residualM: 0.031 })
  assert.ok(matricesAgree(state.posts[0]!.transform.matrix, multiplyMat4(CORRECTION, MOVING_PLACEMENT)))

  assert.equal(await applyRegistrationProposal(result, 'job-1', deps), 'already-applied')
  assert.equal(await applyRegistrationProposal(result, 'job-1', deps), 'already-applied')
  assert.equal(state.posts.length, 1, 'idempotent: still one patch')
  assert.equal(state.patches.length, 1)
})

test('Apply pressed twice before the first reaches the server still writes one patch', async () => {
  const { state, deps } = editor()
  let release!: () => void
  const slow = { ...deps, post: (body: RegisterPatchBody) => new Promise<void>((resolve) => { release = () => resolve(deps.post(body)) }) }
  const result = makeResult()

  const first = applyRegistrationProposal(result, 'job-1', slow)
  const second = applyRegistrationProposal(result, 'job-1', slow)
  assert.equal(await second, 'already-applied', 'the second press finds the first in flight')
  release()
  assert.equal(await first, 'applied')
  assert.equal(state.posts.length, 1)
})

test('Apply: a refused write can be tried again, and nothing was recorded as applied', async () => {
  const { state, deps } = editor()
  let refuseNext = true
  const flaky = {
    ...deps,
    post: async (body: RegisterPatchBody) => {
      if (refuseNext) {
        refuseNext = false
        throw new Error('This scan has moved since the check.')
      }
      await deps.post(body)
    },
  }
  const result = makeResult()
  await assert.rejects(applyRegistrationProposal(result, 'job-1', flaky), /moved since the check/)
  assert.equal(state.patches.length, 0)
  assert.equal(await applyRegistrationProposal(result, 'job-1', flaky), 'applied', 'the failed press did not leave the job marked in flight')
  assert.equal(state.patches.length, 1)
})

test('Apply: a stale proposal and a refusal write nothing', async () => {
  const stale = editor()
  stale.state.scans = scans(yawTranslation(0.4, 12.5, 0.02, -3))
  assert.equal(await applyRegistrationProposal(makeResult(), 'job-1', stale.deps), 'stale')
  assert.equal(stale.state.posts.length, 0)

  const none = editor()
  assert.equal(await applyRegistrationProposal(makeResult(refused('ambiguous')), 'job-2', none.deps), 'refused')
  assert.equal(none.state.posts.length, 0)
})

// ── What the editor says ────────────────────────────────────────────────────

const WORDS_NO_CHECK_EARNS = /aligned|verified|accurate|correct|perfect/i

test('describeRegisterResult: says what was measured and that nothing moves until applied', () => {
  const { headline, lines } = describeRegisterResult(makeResult())
  assert.equal(headline, 'Proposed move: 19 cm and a 1.1° turn')
  assert.deepEqual(lines, [
    'Compared with First visit.',
    '91% of the smaller scan lines up, about 3 cm apart.',
    'Score 0.86 out of 1.',
    'Nothing moves until you apply it.',
  ])
})

test('describeRegisterResult: reports a height change only when both floors were measured', () => {
  const lifted = proposed()
  lifted.boundedCorrection!.dyM = -0.04
  assert.ok(describeRegisterResult(makeResult(lifted)).lines.includes('Height changes by 4 cm.'))
  const unmeasured = proposed({ details: { ...proposed().details, verticalChecked: false } })
  unmeasured.boundedCorrection!.dyM = -0.04
  assert.ok(!describeRegisterResult(makeResult(unmeasured)).lines.some((line) => line.startsWith('Height')))
})

test('describeRegisterResult: every refusal has a sentence, and none claims what was not earned', () => {
  const reasons: RegistrationRefusal[] = [
    'too-few-points', 'too-large', 'no-floor', 'floor-mismatch', 'low-overlap', 'loose-fit', 'ambiguous', 'correction-too-large', 'low-score',
  ]
  for (const reason of reasons) {
    const { headline, lines } = describeRegisterResult(makeResult(refused(reason)))
    assert.equal(headline, 'No move proposed')
    assert.equal(lines[0], refusalText(reason))
    assert.ok(refusalText(reason).length > 10, reason)
    for (const text of [headline, ...lines]) assert.doesNotMatch(text, WORDS_NO_CHECK_EARNS, `${reason}: ${text}`)
  }
  assert.equal(refusalText('no-geometry'), 'The reference scan has no readable geometry.')
})

test('describeRegisterResult: no figure is printed that does not exist', () => {
  const noResidual = proposed({ inlierResidualM: Number.NaN })
  const lines = describeRegisterResult(makeResult(noResidual)).lines.join(' ')
  assert.doesNotMatch(lines, /NaN|undefined|null/)
  const sparse = makeResult(proposed({ boundedCorrection: null, details: undefined as never }))
  assert.doesNotMatch(describeRegisterResult(sparse).headline, /NaN|undefined/)
  assert.equal(describeRegisterResult(sparse).headline, 'Proposed move')
})
