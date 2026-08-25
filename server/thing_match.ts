import type { ScanManifest, Thing, ThingObservation, Vec3, WorldProject } from '../src/world/types.ts'

export const THING_MATCH_RADIUS_M = 0.75
export const THING_MOVED_MIN_M = 0.15
export const THING_COVERAGE_RADIUS_M = 3.0
export const MAX_THINGS_PER_WORLD = 5000

const SYNONYMS = new Map<string, string>([
  ['armchair', 'chair'],
  ['seat', 'chair'],
  ['stool', 'chair'],
  ['couch', 'sofa'],
  ['settee', 'sofa'],
  ['tv', 'monitor'],
  ['television', 'monitor'],
  ['screen', 'monitor'],
  ['bookcase', 'shelf'],
])

export interface DetectionLike {
  targetId: string
  scanId: string
  sessionId: string | null
  label: string
  confidence?: number | null
  worldPos: Vec3
  observedAt?: string | null
}

export interface ThingMatchResult {
  things: Thing[]
  observations: ThingObservation[]
  artifacts: Array<{ type: string; label: string; metadata: Record<string, unknown> }>
}

export function normalizeThingLabel(label: string): string {
  const token = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean)[0] ?? 'object'
  return SYNONYMS.get(token) ?? token
}

export function runThingCorrespondence(
  world: Pick<WorldProject, 'worldId' | 'things' | 'thingObservations'>,
  detections: DetectionLike[],
  now = new Date().toISOString(),
): ThingMatchResult {
  const things = new Map(world.things.map(thing => [thing.thingId, { ...thing, observationIds: [...thing.observationIds] }]))
  const observations = new Map(world.thingObservations.map(obs => [`${obs.scanId}:${obs.targetId}`, { ...obs }]))
  const artifacts: ThingMatchResult['artifacts'] = []

  for (const detection of detections) {
    const canonical = normalizeThingLabel(detection.label)
    const naturalKey = `${detection.scanId}:${detection.targetId}`
    const existingObservation = observations.get(naturalKey)
    const existingThing = existingObservation ? things.get(existingObservation.thingId) : null
    let thing = existingThing ?? uniqueCandidate([...things.values()], canonical, detection.worldPos)

    if (!thing) {
      if (things.size >= MAX_THINGS_PER_WORLD) throw new Error(`World has more than ${MAX_THINGS_PER_WORLD} things`)
      thing = {
        thingId: `thing-${crypto.randomUUID()}`,
        worldId: world.worldId,
        canonicalLabel: canonical,
        representativeTargetId: detection.targetId,
        position: detection.worldPos,
        firstSeenScanId: detection.scanId,
        lastSeenScanId: detection.scanId,
        observationIds: [],
        createdAt: now,
        updatedAt: now,
        origin: 'matcher',
        changeKind: 'new',
      }
      things.set(thing.thingId, thing)
    } else if (!existingThing) {
      const moved = distance(thing.position, detection.worldPos) >= THING_MOVED_MIN_M
      thing.lastSeenScanId = detection.scanId
      thing.updatedAt = now
      thing.changeKind = moved ? 'moved' : 'matched'
    }

    const observationId = existingObservation?.observationId ?? `thing-obs-${crypto.randomUUID()}`
    const observation: ThingObservation = {
      observationId,
      thingId: thing.thingId,
      scanId: detection.scanId,
      sessionId: detection.sessionId,
      targetId: detection.targetId,
      label: detection.label,
      canonicalLabel: canonical,
      confidence: detection.confidence ?? null,
      worldPos: detection.worldPos,
      observedAt: detection.observedAt ?? null,
      origin: existingObservation?.origin ?? 'matcher',
    }
    observations.set(naturalKey, observation)
    if (!thing.observationIds.includes(observationId)) thing.observationIds.push(observationId)
  }

  for (const detection of detections) {
    const canonical = normalizeThingLabel(detection.label)
    const matches = [...things.values()].filter(thing =>
      thing.canonicalLabel === canonical && distance(thing.position, detection.worldPos) <= THING_MATCH_RADIUS_M
    )
    if (matches.length > 1) {
      artifacts.push({
        type: 'thing-ambiguity',
        label: `Ambiguous ${canonical}`,
        metadata: { scanId: detection.scanId, targetId: detection.targetId, candidates: matches.map(t => t.thingId) },
      })
    }
  }

  return { things: [...things.values()], observations: [...observations.values()], artifacts }
}

function uniqueCandidate(things: Thing[], label: string, pos: Vec3): Thing | null {
  const candidates = things.filter(thing =>
    thing.canonicalLabel === label && distance(thing.position, pos) <= THING_MATCH_RADIUS_M
  )
  return candidates.length === 1 ? candidates[0] : null
}

function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

