/**
 * The calibration result carries the frame epoch the flow began in (WP-09b step 1, `CalibrationResult.calibrationEpoch`
 * in src/ar/project-calibration.ts).
 *
 * The modal is driven for real, as tests/unit/node/wp-calibration-characterisation.test.ts drives it, through a provider
 * that has a frame epoch. What is held: the field is there for a provider that has an epoch and absent for one that does
 * not (so every result the characterisation goldens pin is unchanged), it is the epoch the flow began in and not the one
 * at the commit (a shift while the two points were being placed counts against the calibration, as the epoch log's own
 * rule says), it is on both tiers, and a flow that does not commit returns none.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-calibration-epoch.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrationEpochField } from '../../../src/ar/calibration-epoch.ts'
import { FLOOR_Y, loadModal, runScenario, type Scenario } from './support/calibration-flow-driver.ts'

const runModal = await loadModal()

const floor = (x: number, z: number) => ({ x, y: FLOOR_Y, z })

/** A provider whose epoch is `first` the first time it is asked and `later` every time after: so what the flow reads, and when, shows. */
function epochAfterFirstRead(first: number, later: number): { provider: Record<string, unknown>; reads: () => number } {
  let reads = 0
  return {
    provider: { getFrameEpoch: () => (reads++ === 0 ? first : later) },
    reads: () => reads,
  }
}

const TWO_POINT: Scenario['steps'] = [{ tap: floor(1.5, -2) }, { press: 'confirm' }, { tap: floor(3.3, 0.4) }, { press: 'commit' }]
const ONE_POINT: Scenario['steps'] = [{ tap: floor(1.5, -2) }, { press: 'fallback' }]

const scenario = (name: string, steps: Scenario['steps'], provider?: Record<string, unknown>): Scenario => ({
  name,
  about: name,
  steps,
  ...(provider ? { provider } : {}),
})

const resultOf = (outcome: Awaited<ReturnType<typeof runScenario>>): Record<string, unknown> => {
  assert.ok(outcome.closed, 'the modal resolved')
  assert.ok(outcome.result, 'with a calibration')
  return outcome.result as Record<string, unknown>
}

test('a two-point calibration carries the epoch the provider was in', async () => {
  const { provider } = epochAfterFirstRead(3, 3)
  const result = resultOf(await runScenario(runModal, scenario('two-point', TWO_POINT, provider)))
  assert.equal(result['calibrationEpoch'], 3)
  assert.ok(result['calibration'], 'beside the calibration, not instead of it')
})

test('the one-point tier carries it too', async () => {
  const { provider } = epochAfterFirstRead(2, 2)
  const result = resultOf(await runScenario(runModal, scenario('one-point', ONE_POINT, provider)))
  assert.equal(result['calibrationEpoch'], 2)
})

test('it is the epoch the flow began in, not the one at the commit: a shift while the points were placed counts against the calibration', async () => {
  const { provider, reads } = epochAfterFirstRead(4, 5)
  const result = resultOf(await runScenario(runModal, scenario('shift during the flow', TWO_POINT, provider)))
  assert.equal(result['calibrationEpoch'], 4, 'the runtime was in 5 by the commit, and the calibration was made in 4')
  assert.equal(reads(), 1, 'read once, as the flow begins')
})

test('a provider with no epoch signal gives no field, so the result is exactly what it always was', async () => {
  const result = resultOf(await runScenario(runModal, scenario('no epoch', TWO_POINT)))
  assert.equal('calibrationEpoch' in result, false)
  assert.deepEqual(Object.keys(result).sort(), ['calibration', 'referencePhotos', 'spatialFrame'].filter((key) => key in result).sort())
})

test('an epoch that is not a usable number is read as epoch 0, as the epoch log reads it, and is still said', async () => {
  for (const bad of [Number.NaN, -3, 'two']) {
    const result = resultOf(await runScenario(runModal, scenario('bad epoch', TWO_POINT, { getFrameEpoch: () => bad })))
    assert.equal(result['calibrationEpoch'], 0, String(bad))
  }
})

test('a flow the person skips returns nothing, epoch or not', async () => {
  const { provider } = epochAfterFirstRead(1, 1)
  const outcome = await runScenario(runModal, scenario('skipped', [{ press: 'skip' }], provider))
  assert.equal(outcome.closed, true)
  assert.equal(outcome.result, null)
})

test('the helper that builds the field gives nothing for no provider and nothing for one without the member', () => {
  assert.deepEqual(calibrationEpochField(null), {})
  assert.deepEqual(calibrationEpochField(undefined), {})
  assert.deepEqual(calibrationEpochField({}), {})
  assert.deepEqual(calibrationEpochField({ getFrameEpoch: () => 7 }), { calibrationEpoch: 7 })
})
