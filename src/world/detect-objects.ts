/**
 * splat_analyzer's `interactions.json` — the on-disk shape, and the parse.
 *
 * This is the external splat_analyzer tool's own output (render synthetic views
 * → OWLv2 open-vocab detection → oriented 3D boxes), copied verbatim next to a
 * scan by the `splat-detect` world job (see splat_detect.ts). Its shape is
 * `{ objects: [{ label, position{x,y,z}, rotation{x,y,z,w}, scale{x,y,z},
 * frames: [{ frame_idx, box, score }] }], frame_annotations: {} }` — each object
 * is an oriented bounding box: `position` is the centre, `scale` the full
 * extent, `rotation` a quaternion.
 *
 * Two consumers read it, in two different runtimes:
 *   - `src/viewer/splat-detect-layer.ts` (browser) — draws the boxes
 *   - `memory_push.ts` (Deno) — ships the objects to Companion Memory
 *
 * so the shape and the parse live here once (ADR 0001) rather than being
 * declared twice, in a dependency-free file both runtimes can import (ADR 0002
 * — splat-detect-layer.ts imports `three`, memory_push.ts calls `Deno.*`, so
 * neither is a safe import target for the other).
 *
 * Intentionally NOT part of the RawDetection → WorldDetection →
 * StoredDetection lineage (ADR 0001, and
 * docs/factory/foundation-updates/0007): this is a different producer with a
 * different contract than a VLM detection — do not unify it with
 * `WorldDetection`.
 */
import type { Quat, Vec3 } from './types.ts'

/**
 * One object exactly as the sidecar records it. Only `label` and `position` are
 * required: older sidecars (and the analyzer's degenerate cases) can omit the
 * box, and a consumer that only wants "what was in this room" should still see
 * those entries. Use `DetectObject` when you need a drawable box.
 */
export interface DetectObjectRecord {
  /** As the sidecar wrote it; absent when the entry carried no label. */
  label?: string
  /** Centre of the oriented box, in the analyzed splat's own coordinate frame. */
  position: Vec3
  /** Box orientation (xyzw), when the sidecar carries one. */
  rotation?: Quat
  /**
   * Full side lengths of the box along its **own** axes, in the splat's units.
   * Not axis-aligned, so x/y/z carry no length/width/height meaning.
   */
  scale?: Vec3
  /**
   * The detector's peak per-view score for this object — the value
   * `min_peak_score` gates on. Taken from the max over `frames[].score`, or
   * from an object-level `score`/`confidence` when the sidecar has no frames.
   */
  score?: number
  /** How many rendered views the object was detected in — what `min_votes` gates on. */
  frameVotes?: number
}

/** A record complete enough to draw: it has a label and a box extent. */
export interface DetectObject extends DetectObjectRecord {
  label: string
  scale: Vec3
}

/**
 * Read every object out of a raw interactions.json payload, keeping each field
 * the sidecar actually carried (missing ones stay absent rather than being
 * filled in — nothing here invents a number).
 */
export function parseDetectRecords(payload: unknown): DetectObjectRecord[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>)['objects']
        ?? (payload as Record<string, unknown>)['interactions'])
      : null
  if (!Array.isArray(list)) return []
  const out: DetectObjectRecord[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const position = _vec3(o['position'])
    if (!position) continue
    const record: DetectObjectRecord = { position }
    if (typeof o['label'] === 'string') record.label = o['label']
    const rotation = _quat(o['rotation'])
    if (rotation) record.rotation = rotation
    const scale = _vec3(o['scale'])
    if (scale) record.scale = scale
    const frames = Array.isArray(o['frames']) ? o['frames'] : null
    const score = _score(o, frames)
    if (score !== undefined) record.score = score
    if (frames) record.frameVotes = frames.length
    out.push(record)
  }
  return out
}

/**
 * The drawable subset: records that carry a box extent, with the viewer's
 * long-standing `'object'` placeholder applied to unlabeled entries. A record
 * without a `scale` is dropped rather than given a made-up one.
 */
export function parseDetectObjects(payload: unknown): DetectObject[] {
  const out: DetectObject[] = []
  for (const record of parseDetectRecords(payload)) {
    if (!record.scale) continue
    out.push({ ...record, label: record.label ?? 'object', scale: record.scale })
  }
  return out
}

function _vec3(v: unknown): Vec3 | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!_num(r['x']) || !_num(r['y']) || !_num(r['z'])) return null
  return { x: r['x'] as number, y: r['y'] as number, z: r['z'] as number }
}

function _quat(v: unknown): Quat | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (!_num(r['x']) || !_num(r['y']) || !_num(r['z']) || !_num(r['w'])) return undefined
  return { x: r['x'] as number, y: r['y'] as number, z: r['z'] as number, w: r['w'] as number }
}

/** Peak per-view score, else the object's own score/confidence. */
function _score(o: Record<string, unknown>, frames: unknown[] | null): number | undefined {
  let peak: number | undefined
  for (const f of frames ?? []) {
    if (!f || typeof f !== 'object') continue
    const s = (f as Record<string, unknown>)['score']
    if (_num(s) && (peak === undefined || (s as number) > peak)) peak = s as number
  }
  if (peak !== undefined) return peak
  for (const key of ['score', 'confidence']) {
    if (_num(o[key])) return o[key] as number
  }
  return undefined
}

function _num(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}
