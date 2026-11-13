/**
 * Headset world editor: the pure model (src/viewer/xr-world-model.ts) and the thing-edit reader it
 * relies on (src/shared/thing_tags.ts). No DOM, no WebGL. The page's scene and controllers are
 * covered end to end by tests/mock-xr-world.spec.ts.
 *
 * Run: npm run test:xr-world-model
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LABEL_CHOICES,
  STICK_PUSH,
  STICK_RELEASE,
  cycleLabel,
  moveThing,
  thumbstickStep,
  worldSlugFrom,
  type StickLatch,
} from '../../../src/viewer/xr-world-model.ts'
import { resolveThingEditsForWorld } from '../../../src/shared/thing_tags.ts'
import type { EditPatch, Thing } from '../../../src/world/types.ts'

const ROOT = resolve(import.meta.dirname, '../../..')

// ── labels ───────────────────────────────────────────────────────────────────

test('the label list is the fixed headset set, in order, ending with the fallback', () => {
  assert.deepEqual(LABEL_CHOICES, [
    'chair', 'table', 'sofa', 'bed', 'lamp', 'tv', 'shelf', 'desk', 'plant', 'door', 'window', 'other',
  ])
})

test('every choice but the fallback is a semantic tag the desktop editor already uses', () => {
  const source = readFileSync(resolve(ROOT, 'src/viewer/editor.ts'), 'utf8')
  const block = /export const SEMANTIC_TAGS = \[([\s\S]*?)\] as const/.exec(source)
  assert.ok(block, 'SEMANTIC_TAGS not found in src/viewer/editor.ts')
  const tags = new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
  for (const label of LABEL_CHOICES.filter(label => label !== 'other')) {
    assert.ok(tags.has(label), `${label} is not in SEMANTIC_TAGS (src/viewer/editor.ts)`)
  }
})

test('cycleLabel steps forward and back, and wraps at both ends', () => {
  assert.equal(cycleLabel('chair', 1), 'table')
  assert.equal(cycleLabel('table', -1), 'chair')
  assert.equal(cycleLabel('other', 1), 'chair')
  assert.equal(cycleLabel('chair', -1), 'other')
})

test('cycleLabel takes multi-step jumps, modulo the list length', () => {
  assert.equal(cycleLabel('chair', LABEL_CHOICES.length), 'chair')
  assert.equal(cycleLabel('chair', 2), 'sofa')
  assert.equal(cycleLabel('chair', -13), 'other')
})

test('a label outside the list starts before the first choice, or after the last', () => {
  assert.equal(cycleLabel('armchair', 1), 'chair')
  assert.equal(cycleLabel('armchair', -1), 'other')
})

test('cycleLabel always lands on a choice', () => {
  const starts = [...LABEL_CHOICES, 'armchair', '']
  for (const start of starts) {
    for (let step = -13; step <= 13; step++) {
      assert.ok(LABEL_CHOICES.includes(cycleLabel(start, step)), `${start} ${step}`)
    }
  }
})

// ── moves ────────────────────────────────────────────────────────────────────

test('moveThing returns the moved position and leaves its inputs alone', () => {
  const position = { x: 1, y: 1.2, z: -2 }
  const delta = { x: 0.25, y: 0, z: -0.5 }
  const moved = moveThing(position, delta)
  assert.deepEqual(moved, { x: 1.25, y: 1.2, z: -2.5 })
  assert.notEqual(moved, position)
  assert.deepEqual(position, { x: 1, y: 1.2, z: -2 })
  assert.deepEqual(delta, { x: 0.25, y: 0, z: -0.5 })
})

// ── thumbstick ───────────────────────────────────────────────────────────────

test('a push up fires one forward step and does not repeat while held', () => {
  let latch: StickLatch = 'neutral'
  const fired: number[] = []
  for (const y of [0, -0.9, -0.95, -1, -0.9, 0]) {
    const result = thumbstickStep(y, latch)
    latch = result.latch
    fired.push(result.step)
  }
  assert.deepEqual(fired, [0, 1, 0, 0, 0, 0])
})

test('a push down fires one backward step', () => {
  assert.deepEqual(thumbstickStep(0.8, 'neutral'), { step: -1, latch: 'down' })
})

test('the stick must come back to rest before it can fire again', () => {
  let result = thumbstickStep(-0.8, 'neutral')
  assert.equal(result.step, 1)
  result = thumbstickStep(-0.45, result.latch)
  assert.deepEqual(result, { step: 0, latch: 'up' })
  result = thumbstickStep(-0.8, result.latch)
  assert.equal(result.step, 0)
  result = thumbstickStep(0.1, result.latch)
  assert.deepEqual(result, { step: 0, latch: 'neutral' })
  assert.equal(thumbstickStep(-0.8, result.latch).step, 1)
})

test('a push from up straight down fires the other way', () => {
  assert.deepEqual(thumbstickStep(0.8, 'up'), { step: -1, latch: 'down' })
})

test('the dead zone and the push and release thresholds', () => {
  assert.deepEqual(thumbstickStep(0.2, 'neutral'), { step: 0, latch: 'neutral' })
  assert.deepEqual(thumbstickStep(STICK_PUSH, 'neutral'), { step: -1, latch: 'down' })
  assert.deepEqual(thumbstickStep(-STICK_PUSH, 'neutral'), { step: 1, latch: 'up' })
  assert.deepEqual(thumbstickStep(STICK_RELEASE - 0.01, 'down'), { step: 0, latch: 'neutral' })
  assert.deepEqual(thumbstickStep(STICK_RELEASE + 0.1, 'down'), { step: 0, latch: 'down' })
})

// ── which world a page opens ─────────────────────────────────────────────────

test('the world slug follows the desktop viewer: ?world=, then the Place, then default', () => {
  assert.equal(worldSlugFrom(''), 'default')
  assert.equal(worldSlugFrom('?world='), 'default')
  assert.equal(worldSlugFrom('?world=office-2'), 'office-2')
  assert.equal(worldSlugFrom('?project=proj-7'), 'project-proj-7')
  assert.equal(worldSlugFrom('?project='), 'default')
  assert.equal(worldSlugFrom('?project=proj-7&world=custom'), 'custom')
})

// ── thing edits read back from the patch log ─────────────────────────────────

const chair: Thing = {
  thingId: 'thing-chair',
  worldId: 'world-a',
  canonicalLabel: 'chair',
  representativeTargetId: 'scan-a/chair',
  position: { x: 0, y: 1.2, z: -1.5 },
  firstSeenScanId: 'scan-a',
  lastSeenScanId: 'scan-a',
  observationIds: [],
  createdAt: '',
  updatedAt: '',
  origin: 'matcher',
}

function patch(input: Partial<EditPatch>): EditPatch {
  return {
    patchId: input.patchId ?? 'patch-a',
    worldId: 'world-a',
    targetId: input.targetId ?? 'thing-chair',
    scope: input.scope ?? 'thing',
    createdAt: input.createdAt ?? '',
    ...input,
  }
}

test('thing edits keep the latest label and the latest position, keyed by thingId', () => {
  const edits = resolveThingEditsForWorld([
    patch({ patchId: 'one', label: 'table' }),
    patch({ patchId: 'two', transform: { position: { x: 1, y: 1.2, z: -1.5 } } }),
    patch({ patchId: 'three', label: 'sofa' }),
  ], [chair])
  assert.deepEqual(edits.get('thing-chair'), { label: 'sofa', position: { x: 1, y: 1.2, z: -1.5 } })
})

test('thing edits skip other scopes, things the world does not hold, and patches that set neither', () => {
  const edits = resolveThingEditsForWorld([
    patch({ scope: 'object', label: 'desk' }),
    patch({ targetId: 'thing-ghost', label: 'desk' }),
    patch({ category: 'my_armchair' }),
  ], [chair])
  assert.equal(edits.size, 0)
})

test('a resolved position is a copy, not the patch’s own object', () => {
  const position = { x: 1, y: 2, z: 3 }
  const edits = resolveThingEditsForWorld([patch({ transform: { position } })], [chair])
  position.x = 99
  assert.equal(edits.get('thing-chair')?.position?.x, 1)
})
