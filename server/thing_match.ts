import { identityMatrix, transformPoint } from '../src/world/geo.ts'
import { isInPlaceFrame, type PlaceFrameFacts } from '../src/world/frame-generations.ts'
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

/**
 * Whether a scan's detections may be matched to the Place's Things (D6). Only a scan measured in the Place frame
 * may: its detections are positions in that frame, so two of them are comparable. One that was never calibrated, or
 * calibrated with the one-point method, stands where its GPS fix and compass, or its own tapped point, put it, and
 * a position there cannot be told from a position in the Place frame: matched, it would merge Things that are
 * metres apart and duplicate Things that are one. It joins the matching when it is calibrated. Things already
 * made from such a scan are not taken away.
 *
 * So does a scan calibrated with two points whose commit wrote no Place frame and matched none (the floor check was bypassed): it
 * is placed by its own pair, and its positions are in no frame the Things' are in.
 */
export function scanTakesPartInThingMatching(scan: Pick<ScanManifest, 'calibrationMethod' | 'calibrationStatus'> & PlaceFrameFacts): boolean {
  return isInPlaceFrame(scan)
}

/**
 * The sentence a Thing-matching job adds to its result when it left scans out (D6), for the job list, which prints a
 * job's result: a Place whose scans are all uncalibrated has no Things made from them, and the list says why instead of
 * showing a job that did nothing. Nothing at all when no scan was left out.
 */
export function scansLeftOutNote(count: number): string {
  if (!Number.isInteger(count) || count < 1) return ''
  return count === 1
    ? ' 1 scan was left out: it is not in the Place frame.'
    : ` ${count} scans were left out: they are not in the Place frame.`
}

export function normalizeThingLabel(label: string): string {
  const token = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean)[0] ?? 'object'
  return SYNONYMS.get(token) ?? token
}

/**
 * One scan's detections, ready for correspondence. Each position arrives in the scan's own
 * session frame, so it goes through the scan's localToWorld into the Place frame. Without
 * this, two sessions with different origins compared raw coordinates: the same object could
 * duplicate and unrelated objects could merge. A scan with no localToWorld (an older world)
 * keeps its session frame, the same as before.
 */
export function thingLikesForScan(
  scan: { scanId: string; sessionId: string | null; capturedAt?: string | null; localToWorld?: number[] | null },
  withPositions: ReadonlyArray<{ label: string; confidence?: number | null; worldPos: Vec3 }>,
): DetectionLike[] {
  const matrix = scan.localToWorld && scan.localToWorld.length === 16 ? scan.localToWorld : identityMatrix()
  return withPositions.map((detection, index) => {
    const safeName = detection.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
    const name = `${safeName}_${String(index + 1).padStart(3, '0')}`
    return {
      scanId: scan.scanId,
      sessionId: scan.sessionId,
      targetId: `${scan.scanId}:${name}:lod`,
      label: detection.label,
      confidence: detection.confidence,
      worldPos: transformPoint(matrix, detection.worldPos),
      observedAt: scan.capturedAt,
    }
  })
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

