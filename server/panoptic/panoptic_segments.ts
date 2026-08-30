/**
 * Panoptic worker output → the repo's existing detection model.
 *
 * Pure functions only (JSON in, plain objects out) so the policy below can be
 * tested without a GPU, a model checkout, or a Python runtime — the same reason
 * `protocol/stall.mjs` and `colmap_model.ts` are split out from their drivers.
 *
 * ── Why stuff and things are separated here, and not downstream ──────────────
 *
 * "Panoptic" means every pixel carries exactly one label, so a run returns two
 * genuinely different kinds of segment:
 *
 *   things — discrete, countable, movable: chair, table, lamp, plant
 *   stuff  — unbounded room surface: wall, floor, ceiling
 *
 * `server/thing_match.ts` fuses detections into `Thing`s by label + world
 * position within `THING_MATCH_RADIUS_M` (0.75m). That is exactly right for a
 * chair and exactly wrong for a wall: a wall is tens of metres of surface, so a
 * single physical wall seen across a sweep would land as dozens of "Thing"s at
 * 0.75m spacing, none of which is an object anyone would want in a list.
 *
 * That is not merely untidy. `thing_match.ts` THROWS at `MAX_THINGS_PER_WORLD`,
 * and nothing prunes `world.things` — `removeScanFromWorlds` filters scans,
 * editPatches, comments and jobs, and never touches things. So one panoptic run
 * that piped stuff into fusion could permanently wedge a world's JSON, and
 * deleting the offending scan would not undo it.
 *
 * Hence: the worker reports each segment's own `isThing` flag (it comes from the
 * model's label metadata, which knows the taxonomy), and this module keeps the
 * two apart. Stuff is counted and returned so a caller can still use it for
 * room geometry, but it never becomes a detection.
 *
 * Deliberately NOT hardcoding a stuff/thing table here: which of ADE20K's 150
 * classes are stuff is the model's business, and a table transcribed by hand
 * would be a second, silently-wrong copy of it (ADR 0001's whole point).
 */

/** One segment as the Python worker reports it. */
export interface RawPanopticSegment {
  /** Human label from the model's own id2label, e.g. "chair", "wall". */
  label?: unknown
  /** The model's stuff/thing flag. Absent means unknown — treated as stuff. */
  isThing?: unknown
  /** Mean softmax score for the segment, 0..1. */
  score?: unknown
  /** Pixel area of the mask in the source frame. */
  areaPx?: unknown
  /** Mask centroid in source-frame pixels, [x, y]. */
  centroidPx?: unknown
  /** Mask extent [x0, y0, x1, y1] inclusive. Absent on older segments files. */
  bboxPx?: unknown
  /** Whether the centroid pixel is on the mask. Absent on older files. */
  centroidOnMask?: unknown
}

/** One frame's worth of worker output. */
export interface RawPanopticFrame {
  /** Keyframe filename this came from, matching the session's stored image. */
  file?: unknown
  segments?: unknown
}

/**
 * A discrete object segment, validated.
 *
 * `bboxPx` and `centroidOnMask` are OPTIONAL rather than required, and both
 * halves of that matter. The worker emits them, and the 3-D lift uses both (a
 * tighter angular footprint for an elongated mask, and an outright abstention
 * when the centroid ray misses the object) — but a `panoptic.segments.json`
 * written before they existed is still a perfectly good segments file, and
 * re-running the segmenter costs a GPU pass over up to 64 frames. So a missing
 * field degrades the lift rather than invalidating the file.
 */
export interface ThingSegment {
  file: string
  label: string
  score: number
  areaPx: number
  centroidPx: [number, number]
  /** Mask extent [x0, y0, x1, y1] inclusive, when the worker reported one. */
  bboxPx?: [number, number, number, number]
  /**
   * Whether the centroid pixel is inside the mask. `undefined` means "not
   * reported", which is NOT the same as false — see the lift's
   * 'centroid-off-mask' reason.
   */
  centroidOnMask?: boolean
}

/** A room-surface segment. Same shape; kept apart by type, not by convention. */
export interface StuffSegment extends ThingSegment {}

export interface SplitSegments {
  things: ThingSegment[]
  stuff: StuffSegment[]
  /** Segments rejected as malformed or below `minAreaPx`. */
  dropped: number
}

/**
 * Smallest mask worth keeping, in pixels of the source frame.
 *
 * Panoptic output is dense — every pixel is assigned — so a frame yields a long
 * tail of slivers where two real segments meet, plus specks of a class that is
 * mostly off-frame. Those have unusable centroids: a 30px sliver's centroid is
 * an artefact of the boundary, not a position, and fusing on it would scatter
 * phantom Things around the room. 1500px is ~0.2% of a 720x960 keyframe.
 */
export const MIN_SEGMENT_PIXELS = 1500

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Validate a `[x0, y0, x1, y1]` mask extent. Returns null for anything else,
 * including a degenerate box — a malformed bbox must fall back to the
 * area-derived footprint, not narrow the lift's cone to nothing.
 */
function bbox4(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null
  const n = v.map(finite)
  if (n.some((x) => x === null)) return null
  const [x0, y0, x1, y1] = n as number[]
  if (x1 < x0 || y1 < y0) return null
  return [x0, y0, x1, y1]
}

/**
 * Split one worker payload into things and stuff, dropping anything unusable.
 *
 * A segment whose `isThing` is missing counts as STUFF, not as a thing. That
 * asymmetry is deliberate: the failure modes are not symmetric. Mis-filing a
 * chair as stuff loses one detection, which is recoverable and visible. Mis-
 * filing a wall as a thing pushes toward the un-prunable `MAX_THINGS_PER_WORLD`
 * ceiling described above. When the taxonomy is unknown, take the recoverable
 * error.
 */
export function splitPanopticSegments(
  frames: readonly RawPanopticFrame[],
  minAreaPx: number = MIN_SEGMENT_PIXELS,
): SplitSegments {
  const things: ThingSegment[] = []
  const stuff: StuffSegment[] = []
  let dropped = 0

  for (const frame of frames) {
    const file = typeof frame?.file === 'string' ? frame.file : null
    const segs = Array.isArray(frame?.segments) ? frame.segments as RawPanopticSegment[] : []
    if (!file) {
      dropped += segs.length
      continue
    }
    for (const seg of segs) {
      const label = typeof seg?.label === 'string' ? seg.label.trim() : ''
      const score = finite(seg?.score)
      const areaPx = finite(seg?.areaPx)
      const c = Array.isArray(seg?.centroidPx) ? seg.centroidPx : null
      const cx = c ? finite(c[0]) : null
      const cy = c ? finite(c[1]) : null

      if (!label || score === null || areaPx === null || cx === null || cy === null) {
        dropped++
        continue
      }
      if (score < 0 || score > 1 || areaPx < minAreaPx) {
        dropped++
        continue
      }
      const entry: ThingSegment = {
        file,
        label,
        score,
        areaPx,
        centroidPx: [cx, cy],
        ...(bbox4(seg?.bboxPx) ? { bboxPx: bbox4(seg?.bboxPx)! } : {}),
        ...(typeof seg?.centroidOnMask === 'boolean' ? { centroidOnMask: seg.centroidOnMask } : {}),
      }
      if (seg.isThing === true) things.push(entry)
      else stuff.push(entry)
    }
  }
  return { things, stuff, dropped }
}
