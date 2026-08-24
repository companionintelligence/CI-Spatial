import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertThrows } from 'jsr:@std/assert@^1.0.0/throws'
import { MAX_THINGS_PER_WORLD, normalizeThingLabel, runThingCorrespondence } from '../../../thing_match.ts'
import type { Thing, ThingObservation } from '../../../src/world/types.ts'

Deno.test('normalizes common object synonyms', () => {
  assertEquals(normalizeThingLabel('Armchair'), 'chair')
  assertEquals(normalizeThingLabel('Television'), 'monitor')
  assertEquals(normalizeThingLabel('settee'), 'sofa')
})

Deno.test('matches a later observation to a unique nearby thing', () => {
  const first = runThingCorrespondence({ worldId: 'world-a', things: [], thingObservations: [] }, [{
    scanId: 'scan-a',
    sessionId: 'sess-a',
    targetId: 'scan-a/chair',
    label: 'armchair',
    confidence: 0.9,
    worldPos: { x: 0, y: 0, z: 0 },
  }], '2026-01-01T00:00:00Z')
  const second = runThingCorrespondence({ worldId: 'world-a', things: first.things, thingObservations: first.observations }, [{
    scanId: 'scan-b',
    sessionId: 'sess-b',
    targetId: 'scan-b/chair',
    label: 'seat',
    confidence: 0.8,
    worldPos: { x: 0.2, y: 0, z: 0 },
  }], '2026-01-02T00:00:00Z')

  assertEquals(second.things.length, 1)
  assertEquals(second.observations.length, 2)
  assertEquals(second.observations[1].thingId, second.things[0].thingId)
})

Deno.test('fails rather than trimming when thing cap is exceeded', () => {
  const things: Thing[] = Array.from({ length: MAX_THINGS_PER_WORLD }, (_, i) => ({
    thingId: `thing-${i}`,
    worldId: 'world-a',
    canonicalLabel: 'chair',
    representativeTargetId: `target-${i}`,
    position: { x: i * 2, y: 0, z: 0 },
    firstSeenScanId: 'scan-a',
    lastSeenScanId: 'scan-a',
    observationIds: [],
    createdAt: '',
    updatedAt: '',
    origin: 'matcher',
  }))
  assertThrows(() => runThingCorrespondence({ worldId: 'world-a', things, thingObservations: [] }, [{
    scanId: 'scan-b',
    sessionId: null,
    targetId: 'target-new',
    label: 'chair',
    worldPos: { x: 99_999, y: 0, z: 0 },
  }]))
})

Deno.test('reuses observation natural key on rerun', () => {
  const observations: ThingObservation[] = [{
    observationId: 'obs-existing',
    thingId: 'thing-a',
    scanId: 'scan-a',
    sessionId: null,
    targetId: 'scan-a/chair',
    label: 'chair',
    canonicalLabel: 'chair',
    confidence: 0.9,
    worldPos: { x: 0, y: 0, z: 0 },
    observedAt: null,
    origin: 'matcher',
  }]
  const things: Thing[] = [{
    thingId: 'thing-a',
    worldId: 'world-a',
    canonicalLabel: 'chair',
    representativeTargetId: 'scan-a/chair',
    position: { x: 0, y: 0, z: 0 },
    firstSeenScanId: 'scan-a',
    lastSeenScanId: 'scan-a',
    observationIds: ['obs-existing'],
    createdAt: '',
    updatedAt: '',
    origin: 'matcher',
  }]
  const result = runThingCorrespondence({ worldId: 'world-a', things, thingObservations: observations }, [{
    scanId: 'scan-a',
    sessionId: null,
    targetId: 'scan-a/chair',
    label: 'chair',
    worldPos: { x: 0, y: 0, z: 0 },
  }])
  assertEquals(result.observations[0].observationId, 'obs-existing')
})
