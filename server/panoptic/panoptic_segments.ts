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
 * phantom Things around the room. 1500px is 0.22% of a 720x960 phone keyframe
 * and 0.13% of a 1440x810 video-ingest one.
 *
 * ── Why this is not raised, and why there is no confidence floor ─────────────
 *
 * Measured over three sessions (17-frame phone capture; 32- and 48-frame
 * synthetic ray-traced room), looking for a threshold that separates the labels
 * that are right from the ones that plainly are not:
 *
 *   Area does not separate them. On the real phone capture the *correct* things
 *   are the small ones — swivel chair median 5,370px, box 3,207px, chair
 *   3,530px, monitor 2,343px — while on the synthetic room the misreads are
 *   large: bench 131,461px, door 234,644px, towel 66,768px. Any floor high
 *   enough to cut the misreads deletes most of the real capture's true objects.
 *
 *   Confidence does not separate them either, and the model has already applied
 *   the only defensible floor: Mask2Former's post_process_panoptic_segmentation
 *   drops everything under 0.5, so the observed minimum across all three
 *   sessions is 0.504 — a floor at 0.5 is a no-op, and anything above it is
 *   fitted to these three captures. Worse, the ranking runs the wrong way: on
 *   the synthetic room the *highest*-scoring segments are the wrong ones (sky
 *   0.999 indoors, towel 0.992, door 0.923 in a room with no door), while a
 *   real cabinet on the phone capture scores 0.522 at the low end.
 *
 * So no new threshold is added. A filter that deletes true positives and keeps
 * confident false ones is not a quality gate, it is a way of making the counts
 * look tidier — and the thing this pipeline must not do is report a cleanliness
 * it has not earned. What a misread label needs is a second view of the same
 * surface (the 3-D lift), not a number tuned against these fixtures.
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

/** One label's showing across a run. */
export interface LabelSightings {
  label: string
  /** Segments carrying this label, summed over frames. Sightings, not objects. */
  sightings: number
  /** The most this label appeared in any single frame. */
  maxPerFrame: number
}

export interface SegmentSummary {
  /** Frames that contributed at least one segment. */
  frames: number
  /** Every segment counted once per frame it appears in. */
  sightings: number
  /** Per-label breakdown, most-seen first, ties broken alphabetically. */
  labels: LabelSightings[]
  /**
   * The floor under "how many distinct objects is this?" — see the comment on
   * `summarizePanopticSegments`. Never a count of objects.
   */
  distinctObjectsAtLeast: number
}

/**
 * What a run's segments actually support saying.
 *
 * The counting problem this exists for: one physical object appears in many
 * keyframes as many segments, and nothing here merges them, so a raw segment
 * total is a count of SIGHTINGS. Measured on the 48-frame synthetic fixture:
 * 38 thing segments, of which 30 are the label `step` — one ledge, seen thirty
 * times. "38 objects" would overstate that room by roughly an order of
 * magnitude.
 *
 * Merging them properly needs each sighting's world position, and that is
 * exactly what the 3-D lift cannot supply on these captures: a video keyframe
 * carries no metric capture pose (0 of 48 on this fixture) and solved SfM poses
 * are scale-free, so the lift places nothing. Merging on 2-D evidence instead —
 * label plus centroid or bbox overlap between neighbouring frames — was not
 * done, because it cannot re-identify an object left and revisited, so it would
 * emit another authoritative-looking number wrong by an unknown factor. That is
 * this codebase's recurring defect, not a fix for it.
 *
 * What IS provable without any 3-D: if one frame shows three `chair` segments,
 * the room holds at least three chairs. Summing that per-frame maximum over
 * labels gives `distinctObjectsAtLeast`, a genuine lower bound — 8 for the
 * 48-frame fixture against 38 sightings.
 *
 * One caveat that has to travel with it, because it is a bound on segment
 * identities and not on reality: it is only a bound on *objects* where the label
 * is right. On the synthetic fixture the contributing labels include `towel`,
 * `bench`, `door` and `flag` on untextured noise, so its lower bound of 8 counts
 * misreads as objects. Truncating the tail would not fix that — see
 * MIN_SEGMENT_PIXELS for why neither an area nor a confidence floor separates
 * those from real ones.
 */
export function summarizePanopticSegments(segments: readonly ThingSegment[]): SegmentSummary {
  const perFrame = new Map<string, Map<string, number>>()
  for (const s of segments) {
    let frame = perFrame.get(s.file)
    if (!frame) perFrame.set(s.file, frame = new Map())
    frame.set(s.label, (frame.get(s.label) ?? 0) + 1)
  }

  const totals = new Map<string, { sightings: number; maxPerFrame: number }>()
  for (const frame of perFrame.values()) {
    for (const [label, n] of frame) {
      const t = totals.get(label) ?? { sightings: 0, maxPerFrame: 0 }
      t.sightings += n
      t.maxPerFrame = Math.max(t.maxPerFrame, n)
      totals.set(label, t)
    }
  }

  const labels = [...totals].map(([label, t]) => ({ label, ...t }))
    .sort((a, b) => b.sightings - a.sightings || a.label.localeCompare(b.label))

  return {
    frames: perFrame.size,
    sightings: segments.length,
    labels,
    distinctObjectsAtLeast: labels.reduce((n, l) => n + l.maxPerFrame, 0),
  }
}

/**
 * One log line for a run, worded so the numbers cannot be read as objects.
 *
 * Formatted here rather than at the call site so the wording is covered by the
 * same tests as the counting — the whole point of the line is that "38" never
 * appears next to the word "objects" without the sightings/at-least framing
 * beside it.
 */
export function formatSegmentSummary(kind: string, summary: SegmentSummary, topN = 6): string {
  const top = summary.labels.slice(0, topN).map((l) => `${l.label}×${l.sightings}`).join(', ')
  const rest = summary.labels.length - Math.min(topN, summary.labels.length)
  return `${summary.sightings} ${kind} sighting(s) of ${summary.labels.length} label(s) over ` +
    `${summary.frames} frame(s) — at least ${summary.distinctObjectsAtLeast} distinct ${kind}(s), ` +
    `not ${summary.sightings}${top ? `; ${top}${rest > 0 ? `, +${rest} more` : ''}` : ''}`
}
