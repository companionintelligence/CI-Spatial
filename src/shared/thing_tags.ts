import type { EditPatch, Thing, ThingObservation, Vec3 } from '../world/types.ts'

export interface ResolvedThingTag {
  category?: string
  label?: string
  notes?: string
}

export function buildThingObservationIndex(
  observations: ThingObservation[],
): Map<string, ThingObservation[]> {
  const index = new Map<string, ThingObservation[]>()
  for (const observation of observations) {
    const bucket = index.get(observation.thingId)
    if (bucket) bucket.push(observation)
    else index.set(observation.thingId, [observation])
  }
  return index
}

export function resolveThingTagsForScan(
  patches: EditPatch[],
  things: Thing[],
  observationIndex: Map<string, ThingObservation[]>,
  scanId: string,
): Map<string, ResolvedThingTag> {
  const thingIds = new Set(things.map(thing => thing.thingId))
  const resolved = new Map<string, ResolvedThingTag>()

  for (const patch of patches) {
    if (patch.scope === 'thing') {
      if (thingIds.has(patch.targetId)) {
        for (const observation of observationIndex.get(patch.targetId) ?? []) {
          if (observation.scanId !== scanId) continue
          applyPatch(resolved, observation.targetId, patch)
        }
      } else if (patch.scanId === scanId && patch.originTargetId) {
        applyPatch(resolved, patch.originTargetId, patch)
      }
      continue
    }

    if (patch.scope === 'object') {
      if (patch.scanId && patch.scanId !== scanId) continue
      applyPatch(resolved, patch.targetId, patch)
    }
  }

  return resolved
}

/**
 * Fold one patch into the tags resolved so far for a target. Per field:
 *
 *   null       clears it, so the target falls back to its AI label
 *   a string   sets it, unless the string is empty
 *   undefined  keeps whatever an earlier patch set
 *
 * An empty string is not a clear. It keeps the current value, as it always has.
 */
function applyPatch(resolved: Map<string, ResolvedThingTag>, targetId: string, patch: EditPatch): void {
  const next: ResolvedThingTag = { ...(resolved.get(targetId) ?? {}) }
  for (const field of ['category', 'label', 'notes'] as const) {
    const value: string | null | undefined = patch[field]
    if (value === null) delete next[field]
    else if (value) next[field] = value
  }
  resolved.set(targetId, next)
}

/** The edits thing-scoped patches make to one Thing: its latest label and the latest position a move set. */
export interface ResolvedThingEdit {
  label?: string
  position?: Vec3
}

/**
 * Resolves the thing-scoped edits in a world, keyed by thingId. Unlike
 * resolveThingTagsForScan, which speaks in one scan's observation ids, this is for
 * a viewer that works on Things themselves (the headset editor). A patch with
 * `label` relabels its Thing; one with `transform.position` moves it, in the same
 * Place frame as Thing.position. Later patches win by array order. Patches for a
 * Thing the world does not hold are skipped.
 */
export function resolveThingEditsForWorld(
  patches: EditPatch[],
  things: Thing[],
): Map<string, ResolvedThingEdit> {
  const thingIds = new Set(things.map(thing => thing.thingId))
  const resolved = new Map<string, ResolvedThingEdit>()

  for (const patch of patches) {
    if (patch.scope !== 'thing' || !thingIds.has(patch.targetId)) continue
    const position = patch.transform?.position
    if (!patch.label && !position) continue
    resolved.set(patch.targetId, {
      ...resolved.get(patch.targetId),
      ...(patch.label ? { label: patch.label } : {}),
      ...(position ? { position: { x: position.x, y: position.y, z: position.z } } : {}),
    })
  }

  return resolved
}
