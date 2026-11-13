import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { buildThingObservationIndex, resolveThingTagsForScan } from '../../../src/shared/thing_tags.ts'
import type { EditPatch, Thing, ThingObservation } from '../../../src/world/types.ts'

const thing: Thing = {
  thingId: 'thing-chair',
  worldId: 'world-a',
  canonicalLabel: 'chair',
  representativeTargetId: 'scan-a/chair',
  position: { x: 0, y: 0, z: 0 },
  firstSeenScanId: 'scan-a',
  lastSeenScanId: 'scan-b',
  observationIds: ['obs-a', 'obs-b'],
  createdAt: '',
  updatedAt: '',
  origin: 'matcher',
}

const observations: ThingObservation[] = [
  {
    observationId: 'obs-a',
    thingId: 'thing-chair',
    scanId: 'scan-a',
    sessionId: 'sess-a',
    targetId: 'scan-a/chair',
    label: 'chair',
    canonicalLabel: 'chair',
    confidence: 0.9,
    worldPos: { x: 0, y: 0, z: 0 },
    observedAt: null,
    origin: 'matcher',
  },
  {
    observationId: 'obs-b',
    thingId: 'thing-chair',
    scanId: 'scan-b',
    sessionId: 'sess-b',
    targetId: 'scan-b/chair',
    label: 'chair',
    canonicalLabel: 'chair',
    confidence: 0.8,
    worldPos: { x: 0.1, y: 0, z: 0 },
    observedAt: null,
    origin: 'matcher',
  },
]

function patch(input: Partial<EditPatch>): EditPatch {
  return {
    patchId: input.patchId ?? 'patch-a',
    worldId: 'world-a',
    targetId: input.targetId ?? 'thing-chair',
    scope: input.scope ?? 'thing',
    scanId: input.scanId,
    category: input.category,
    label: input.label,
    notes: input.notes,
    originTargetId: input.originTargetId,
    createdAt: input.createdAt ?? '',
  }
}

Deno.test('thing-scoped tag resolves to a later session observation', () => {
  const result = resolveThingTagsForScan(
    [patch({ scanId: 'scan-a', category: 'my_armchair', originTargetId: 'scan-a/chair' })],
    [thing],
    buildThingObservationIndex(observations),
    'scan-b',
  )
  assertEquals(result.get('scan-b/chair')?.category, 'my_armchair')
})

Deno.test('thing-scoped tag also resolves onto its own session', () => {
  const result = resolveThingTagsForScan(
    [patch({ scanId: 'scan-a', category: 'my_armchair', originTargetId: 'scan-a/chair' })],
    [thing],
    buildThingObservationIndex(observations),
    'scan-a',
  )
  assertEquals(result.get('scan-a/chair')?.category, 'my_armchair')
})

Deno.test('broken thing falls back only to the origin scan object', () => {
  const patches = [patch({ scanId: 'scan-a', category: 'my_armchair', originTargetId: 'scan-a/chair' })]
  const ownScan = resolveThingTagsForScan(patches, [], buildThingObservationIndex([]), 'scan-a')
  const otherScan = resolveThingTagsForScan(patches, [], buildThingObservationIndex([]), 'scan-b')

  assertEquals(ownScan.get('scan-a/chair')?.category, 'my_armchair')
  assertEquals(otherScan.size, 0)
})

Deno.test('later thing patch wins by array order', () => {
  const result = resolveThingTagsForScan(
    [
      patch({ patchId: 'one', scanId: 'scan-a', category: 'chair' }),
      patch({ patchId: 'two', scanId: 'scan-b', category: 'favorite' }),
    ],
    [thing],
    buildThingObservationIndex(observations),
    'scan-a',
  )
  assertEquals(result.get('scan-a/chair')?.category, 'favorite')
})

Deno.test('object patch keeps scan scoping', () => {
  const patches = [patch({ scope: 'object', scanId: 'scan-a', targetId: 'scan-a/chair', category: 'chair' })]
  assertEquals(resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a').size, 1)
  assertEquals(resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-b').size, 0)
})

Deno.test('an explicit null clears a label an earlier patch set', () => {
  const patches = [
    patch({ patchId: 'one', scanId: 'scan-a', label: 'armchair', originTargetId: 'scan-a/chair' }),
    patch({ patchId: 'two', scanId: 'scan-a', label: null, originTargetId: 'scan-a/chair' }),
  ]
  const result = resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a')
  assertEquals(result.get('scan-a/chair')?.label, undefined)
  assertEquals(result.get('scan-a/chair'), {})
})

Deno.test('a clear removes only the field it names', () => {
  const patches = [
    patch({ patchId: 'one', scanId: 'scan-a', label: 'armchair', category: 'seating', originTargetId: 'scan-a/chair' }),
    patch({ patchId: 'two', scanId: 'scan-a', label: null, originTargetId: 'scan-a/chair' }),
  ]
  const result = resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a')
  assertEquals(result.get('scan-a/chair'), { category: 'seating' })
})

Deno.test('a clear reaches every session the thing was seen in', () => {
  const setLabel = patch({ patchId: 'one', scanId: 'scan-a', label: 'armchair', originTargetId: 'scan-a/chair' })
  const clear = patch({ patchId: 'two', scanId: 'scan-a', label: null, originTargetId: 'scan-a/chair' })
  const index = buildThingObservationIndex(observations)
  assertEquals(resolveThingTagsForScan([setLabel], [thing], index, 'scan-b').get('scan-b/chair')?.label, 'armchair')
  assertEquals(resolveThingTagsForScan([setLabel, clear], [thing], index, 'scan-b').get('scan-b/chair')?.label, undefined)
})

Deno.test('a clear on an object removes its label', () => {
  const patches = [
    patch({ scope: 'object', scanId: 'scan-a', targetId: 'scan-a/chair', label: 'armchair' }),
    patch({ scope: 'object', patchId: 'clear', scanId: 'scan-a', targetId: 'scan-a/chair', label: null }),
  ]
  const result = resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a')
  assertEquals(result.get('scan-a/chair')?.label, undefined)
})

Deno.test('an undefined field keeps the label an earlier patch set', () => {
  // A category-only patch says nothing about the label, so the label survives it.
  const patches = [
    patch({ patchId: 'one', scanId: 'scan-a', label: 'armchair', originTargetId: 'scan-a/chair' }),
    patch({ patchId: 'two', scanId: 'scan-a', category: 'seating', originTargetId: 'scan-a/chair' }),
  ]
  const result = resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a')
  assertEquals(result.get('scan-a/chair'), { label: 'armchair', category: 'seating' })
})

Deno.test('an empty string is not a clear and keeps the current label', () => {
  const patches = [
    patch({ patchId: 'one', scanId: 'scan-a', label: 'armchair', originTargetId: 'scan-a/chair' }),
    patch({ patchId: 'two', scanId: 'scan-a', label: '', originTargetId: 'scan-a/chair' }),
  ]
  const result = resolveThingTagsForScan(patches, [thing], buildThingObservationIndex(observations), 'scan-a')
  assertEquals(result.get('scan-a/chair')?.label, 'armchair')
})
