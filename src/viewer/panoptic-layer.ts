/**
 * Placed-objects overlay: the world positions `panoptic-lift` recovered.
 *
 * `panoptic-scan` answers "what is in these frames"; the lift answers "where",
 * and this module is the only place the answer becomes something a person can
 * look at. It lands two sidecars beside the scan (server/panoptic/panoptic_lift.ts:19):
 *
 *   /scans/<base>.panoptic.detections.json      one record per thing segment
 *   /scans/<base>.panoptic-lift.manifest.json   counts + why
 *
 * Same shape as splat-detect-layer.ts: fetch both, build a THREE.Group ready to
 * attach under the scan root so the transform gizmo moves the markers with the
 * scan, and hand the label text + anchors back to the viewer, which owns the
 * projected-label container.
 *
 * ── Why most records draw nothing ────────────────────────────────────────────
 *
 * A record's `confidence` is non-null exactly when its `worldPos` is
 * (panoptic_lift.ts:107-116), so an unplaced segment has no point to draw at:
 * its ray never resolved to a depth. Those are NOT dropped — they are the
 * majority (44 of 50 on the one real session) and the reason the lift keeps
 * per-reason counts at all. They are reported as a sentence instead of a marker,
 * because inventing a position for them is exactly what the lift refuses to do.
 */
import * as THREE from 'three'
import type { ScanManifest, PanopticLiftManifest } from '../world/types'
import type { LiftReason } from '../shared/panoptic_lift'
import { MIN_CONFIDENCE } from '../shared/panoptic_lift'
import { scanArtifactBase } from './splat-layer'

/**
 * Viewer-side read of one lifted segment.
 *
 * Mirrors `PanopticDetectionRecord` (server/panoptic/panoptic_lift.ts:107-138),
 * which is the source of truth. Declared here rather than imported because that
 * module is a Deno driver — it pulls in `@std/path` and the glTF-Transform
 * NodeIO — and the viewer has no business dragging either into its bundle to
 * read a JSON file. Only the fields this overlay uses are listed; the
 * diagnostics it does not draw are left off deliberately.
 */
export interface PanopticDetectionRecord {
  label: string
  confidence: number | null
  worldPos: { x: number; y: number; z: number } | null
  /** Present exactly when worldPos is null. */
  reason?: LiftReason
  file: string
  segmentIndex: number
  segScore: number
  areaPx: number
  depthM?: number
  clusterPoints?: number
  spreadM?: number
}

export interface PanopticDetectionsSidecar {
  schemaVersion: number
  source: 'panoptic-lift'
  sessionId?: string
  scanId?: string
  generatedAt: string
  detections: PanopticDetectionRecord[]
}

/**
 * How much a placement should be believed.
 *
 * Two tiers, not a gradient: the point of the badge is that a reader can sort
 * the room at a glance, and a continuous ramp over a population that spans one
 * decimal place is not legible in a still.
 */
export type PlacementTier = 'firm' | 'marginal'

/**
 * A placement is 'firm' at or above this multiple of the lift's own confidence
 * floor, 'marginal' between the floor and it.
 *
 * The floor is the only threshold the lift publishes, and its own note
 * (src/shared/panoptic_lift.ts:266-284) is explicit that the exact value is a
 * policy choice at a visible break, not a fitted error rate — so a placement
 * sitting a hair above it is precisely the one worth a second look. Doubling it
 * is a split of that band, not a second fitted threshold, and on the one real
 * lift on disk it lands where the data already separates: the six placed
 * segments of sess-a7e2f642 score 0.246 0.250 0.290 0.308 | 0.409 0.433, whose
 * only real gap is 0.308 -> 0.409, and 2 x 0.20 = 0.40 falls inside it.
 *
 * Read against the manifest's `params.minConfidence` rather than the constant,
 * so re-tuning the floor moves the badge with it instead of silently
 * mis-labelling every marker in an old run.
 */
export const FIRM_CONFIDENCE_MULTIPLE = 2

export function placementTier(confidence: number, minConfidence: number): PlacementTier {
  return confidence >= minConfidence * FIRM_CONFIDENCE_MULTIPLE ? 'firm' : 'marginal'
}

/** A drawn placement: its marker, its chip text, and how sure the lift was. */
export interface PanopticMarker {
  /** Chip text, e.g. `swivel chair 25% unsure`. */
  text: string
  position: THREE.Vector3
  /** The marker mesh, so the caller can gate its visibility with the chip's. */
  object: THREE.Object3D
  tier: PlacementTier
  label: string
  confidence: number
  /** One line of provenance for the chip's tooltip. */
  detail: string
}

export interface ScanPanopticLayer {
  scanId: string
  manifest: PanopticLiftManifest
  /** Marker group, ready to attach under the scan root. */
  markerGroup: THREE.Group
  markers: PanopticMarker[]
  /** Segments that produced a position. Equals `markers.length`. */
  placedCount: number
  /** Segments the lift saw but would not place. */
  unplacedCount: number
}

/** URL of a scan's panoptic detections sidecar on the gated artifact route. */
export function panopticDetectionsUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.panoptic.detections.json`)}`
}

/** URL of a scan's panoptic-lift manifest on the gated artifact route. */
export function panopticLiftManifestUrl(scan: ScanManifest): string {
  return `/scans/${encodeURIComponent(`${scanArtifactBase(scan)}.panoptic-lift.manifest.json`)}`
}

// Teal for a firm placement — the same 0x72ddd4 the splat-detect boxes use, so
// "this is a machine-placed object" reads as one thing across both overlays.
// Amber for a marginal one, because a second teal marker at a different opacity
// is not a distinction anyone can make on a still frame.
const FIRM_COLOR = 0x72ddd4
const MARGINAL_COLOR = 0xffb74d

/**
 * Marker radius, metres. Small enough to sit inside furniture rather than
 * swallow it: the lift returns a point, not an extent, and a big glyph would
 * imply a volume it never measured.
 */
const MARKER_RADIUS_M = 0.09

const FIRM_MATERIAL = new THREE.MeshBasicMaterial({
  color: FIRM_COLOR,
  transparent: true,
  opacity: 0.85,
})
// Wireframe, not just a different colour: solid-vs-hollow survives greyscale,
// colour-blindness, and a low-contrast projector, and the confidence split is
// the one thing on this overlay that must not be missable.
const MARGINAL_MATERIAL = new THREE.MeshBasicMaterial({
  color: MARGINAL_COLOR,
  wireframe: true,
  transparent: true,
  opacity: 0.9,
})

/**
 * The word appended to a marginal chip.
 *
 * In the text, not only in the styling, for two reasons: a chip is the only
 * label a screenshot carries, and `label.text` is what object-filter.ts matches
 * on — so `-unsure` hides the doubtful placements and `unsure` shows only
 * those, with no new filter syntax.
 */
export const MARGINAL_LABEL_SUFFIX = 'unsure'

/** Human phrasing for why a segment was not placed. Outcomes, not job names. */
const REASON_TEXT: Record<string, string> = {
  'no-pose': 'the frame does not record where the camera was',
  'degenerate-camera': 'the camera pose was unusable',
  'centroid-off-mask': 'the ray missed the object',
  'no-geometry': 'nothing was scanned behind it',
  // Added after a forced run on solved poses reported 23 of these and the line
  // rendered the bare slug at the reader. Phrased as a distance problem, not a
  // units one: 'out of the depth range' is what the reader can see in the
  // viewport, and `placementVerdictOf` carries the units explanation.
  'out-of-range': 'everything behind it sat outside the range the scan measures in',
  'unsupported': 'too few scanned points to fix a depth',
  'depth-ambiguous': 'its depth was smeared over too wide a range',
  'multi-surface': 'two surfaces at different depths were equally likely',
  'low-confidence': 'the placement was too weak to trust',
}

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason
}

/**
 * Parse a detections sidecar defensively.
 *
 * A record missing a usable `worldPos` is kept, not dropped — it is a segment
 * the lift saw and could not place, and the panel counts it. Only entries that
 * are not objects at all are discarded.
 */
export function parsePanopticDetections(value: unknown): PanopticDetectionRecord[] {
  const raw = (value as PanopticDetectionsSidecar | null)?.detections
  if (!Array.isArray(raw)) return []
  const out: PanopticDetectionRecord[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record['label'] !== 'string') continue
    out.push(item as PanopticDetectionRecord)
  }
  return out
}

/** True when a record carries three finite numbers for a position. */
function positionOf(record: PanopticDetectionRecord): THREE.Vector3 | null {
  const pos = record.worldPos
  if (!pos) return null
  const { x, y, z } = pos
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return new THREE.Vector3(x, y, z)
}

/**
 * Build the marker group from parsed records.
 *
 * Exported so the tiering and text can be exercised without a network or a
 * loaded world, the same seam `buildDetectBoxes` provides for splat-detect.
 */
export function buildPanopticMarkers(
  records: PanopticDetectionRecord[],
  minConfidence: number,
): { group: THREE.Group; markers: PanopticMarker[]; unplacedCount: number } {
  const group = new THREE.Group()
  group.name = 'panoptic-placed-objects'
  const markers: PanopticMarker[] = []
  let unplacedCount = 0

  // One geometry shared by every marker — a scan can carry a hundred segments
  // and each is the same eight triangles.
  const geometry = new THREE.OctahedronGeometry(MARKER_RADIUS_M)

  for (const record of records) {
    const position = positionOf(record)
    if (!position || typeof record.confidence !== 'number') {
      unplacedCount++
      continue
    }
    const tier = placementTier(record.confidence, minConfidence)
    const mesh = new THREE.Mesh(geometry, tier === 'firm' ? FIRM_MATERIAL : MARGINAL_MATERIAL)
    mesh.position.copy(position)
    // A marginal marker draws smaller as well as hollow: three encodings of one
    // fact, so no single rendering condition can flatten it.
    if (tier === 'marginal') mesh.scale.setScalar(0.75)
    mesh.name = `panoptic-${record.label}-${record.file}-${record.segmentIndex}`
    mesh.renderOrder = 2
    mesh.userData['label'] = record.label
    mesh.userData['confidence'] = record.confidence
    mesh.userData['panopticTier'] = tier
    group.add(mesh)

    const percent = Math.round(record.confidence * 100)
    const detailParts = [
      `from ${record.file} segment ${record.segmentIndex}`,
      record.depthM !== undefined ? `${record.depthM.toFixed(2)} m along the ray` : null,
      record.clusterPoints !== undefined ? `${record.clusterPoints} supporting points` : null,
      tier === 'marginal'
        ? `just over the ${Math.round(minConfidence * 100)}% floor — worth checking`
        : null,
    ].filter((part): part is string => part !== null)

    markers.push({
      text: `${record.label} ${percent}%${tier === 'marginal' ? ` ${MARGINAL_LABEL_SUFFIX}` : ''}`,
      position,
      object: mesh,
      tier,
      label: record.label,
      confidence: record.confidence,
      detail: detailParts.join(' · '),
    })
  }

  return { group, markers, unplacedCount }
}

/**
 * Fetch a scan's panoptic sidecars and build the marker overlay. Returns null
 * when the lift has not run for this scan (no manifest), which is the ordinary
 * case, not an error. `fetcher` is injectable so callers can add an access
 * token or point at a test server — same seam as `fetchScanDetectLayer`.
 */
export async function fetchScanPanopticLayer(
  scan: ScanManifest,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<ScanPanopticLayer | null> {
  const manifestResp = await fetcher(panopticLiftManifestUrl(scan))
  if (!manifestResp.ok) return null
  const manifest = (await manifestResp.json()) as PanopticLiftManifest

  const empty = new THREE.Group()
  empty.name = 'panoptic-placed-objects'
  const nothing: ScanPanopticLayer = {
    scanId: scan.scanId,
    manifest,
    markerGroup: empty,
    markers: [],
    placedCount: 0,
    unplacedCount: manifest.undeterminedCount ?? 0,
  }
  if (manifest.status !== 'ok') return nothing

  const detectionsResp = await fetcher(panopticDetectionsUrl(scan))
  if (!detectionsResp.ok) return nothing

  let records: PanopticDetectionRecord[] = []
  try {
    records = parsePanopticDetections(await detectionsResp.json())
  } catch (e) {
    console.warn('[panoptic] detections parse failed:', e)
    return nothing
  }

  // The manifest's floor is authoritative for a run that already happened; the
  // shared constant is only the fallback for a manifest written before params
  // were recorded.
  const minConfidence = manifest.params?.minConfidence ?? MIN_CONFIDENCE
  const { group, markers, unplacedCount } = buildPanopticMarkers(records, minConfidence)
  return {
    scanId: scan.scanId,
    manifest,
    markerGroup: group,
    markers,
    placedCount: markers.length,
    unplacedCount,
  }
}

/**
 * Why a scan has no objects placed in it — grouped by what the reader would
 * have to DO differently, not by the lift's nine internal reasons.
 *
 * Several reasons collapse to one action ('no-geometry' and 'unsupported' are
 * both "scan more of the room"), and two that sound alike need opposite
 * actions: 'out-of-range' is a scale problem no amount of re-scanning fixes,
 * while 'no-geometry' is exactly a coverage problem. That split is the whole
 * point of the type — see the `out-of-range` note in src/shared/panoptic_lift.ts,
 * which cost an evening to find.
 */
export type PlacementBlock =
  /** Nothing has looked for objects in this scan yet. */
  | 'not-attempted'
  /** The frames do not record where the camera was. The video-upload case. */
  | 'no-capture-poses'
  /** Room shape exists, but not at a real-world size, so distances mean nothing. */
  | 'no-real-world-scale'
  /** Not enough of the room is scanned behind the objects. */
  | 'thin-geometry'
  /** Positions were computed and none was trustworthy. */
  | 'weak-placements'
  /** The frames were read and held no discrete objects. */
  | 'nothing-found'
  /** Placement was attempted and errored. */
  | 'failed'
  /** Determinate but none of the above — the reason line carries the detail. */
  | 'other'

export interface PlacementVerdict {
  block: PlacementBlock
  /** One short sentence — the thing a non-expert reads first. */
  headline: string
  /** What was measured and what, if anything, would change it. */
  detail: string
}

/**
 * The reason that accounts for most of the unplaced segments, or null.
 *
 * A single dominant reason is what the copy keys off, because a run is
 * overwhelmingly one-sided in practice: 33 of 44 'unsupported' on the phone
 * capture, 29 of 29 'no-pose' on the video, 23 of 29 'out-of-range' on the
 * video forced onto solved poses. Ties resolve to whichever `Object.entries`
 * yields first, which is stable for a manifest read back from disk.
 */
export function dominantReason(manifest: PanopticLiftManifest): string | null {
  let top: string | null = null
  let topCount = 0
  for (const [reason, count] of Object.entries(manifest.reasons ?? {})) {
    if (count > topCount) {
      top = reason
      topCount = count
    }
  }
  return top
}

const BLOCK_BY_REASON: Record<string, PlacementBlock> = {
  'no-pose': 'no-capture-poses',
  'degenerate-camera': 'no-capture-poses',
  'out-of-range': 'no-real-world-scale',
  'no-geometry': 'thin-geometry',
  'unsupported': 'thin-geometry',
  'low-confidence': 'weak-placements',
  'depth-ambiguous': 'weak-placements',
  'multi-surface': 'weak-placements',
}

/**
 * Say why a scan shows nothing placed, in the words of someone standing in the
 * room rather than someone running the pipeline.
 *
 * Returns null when the scan DID place objects — there is nothing to explain,
 * and a scan that worked must read exactly as it did before this existed.
 * `null` for `layer` means the lift sidecars were asked for and are not there,
 * which is a different situation from every other branch here and is the one
 * case the caller cannot get from a manifest.
 *
 * ## Why the manifest's own `remediation` is not printed
 *
 * The envelope carries one (`liftRemediation`, src/shared/panoptic_lift.ts:745),
 * and reconstruction-quality.ts is right to prefer the producer's own words
 * over composed ones. This one cannot be forwarded as written: it is addressed
 * to whoever runs the pipeline, in its vocabulary — "solved (SfM) poses",
 * "a capture-frame cloud", "the 0.5-5.0 m depth window", "run a colmap-poses
 * job". Every clause of it is true and none of it is actionable by a person who
 * uploaded a video, so the same measured facts are restated below in terms of
 * what they did and what they could do instead. The mapping is one-to-one with
 * `liftRemediation`'s switch, so the two cannot drift apart silently.
 */
export function placementVerdictOf(layer: ScanPanopticLayer | null): PlacementVerdict | null {
  if (!layer) {
    return {
      block: 'not-attempted',
      headline: 'Nothing has looked for things in this scan yet.',
      detail: 'The room itself is here — it just has not been read for objects, '
        + 'so there is nothing to list. Nothing is wrong with the scan.',
    }
  }
  if (layer.placedCount > 0) return null

  const m = layer.manifest
  if (m.status === 'skipped') {
    // Two structural cases cover every skip the driver writes: `pointCount` is
    // 0 exactly when the cloud was the missing input, and absent when the
    // segments were.
    return m.pointCount === 0
      ? {
        block: 'thin-geometry',
        headline: 'There is no scanned shape here to put things against.',
        detail: 'Locating an object means measuring how far away its surface is, '
          + 'and this scan has no surfaces recorded yet. The room has to be built '
          + 'before anything can be placed inside it.',
      }
      : {
        block: 'not-attempted',
        headline: 'This scan’s pictures have not been read for objects yet.',
        detail: 'Nothing has looked at the frames to say what is in them, so there '
          + 'is nothing to place. Nothing is wrong with the scan.',
      }
  }
  if (m.status === 'error') {
    return {
      block: 'failed',
      headline: 'Placing objects in this scan failed.',
      detail: m.error ?? 'No reason was recorded.',
    }
  }

  const seen = m.segmentCount ?? layer.unplacedCount
  if (seen === 0) {
    return {
      block: 'nothing-found',
      headline: 'No objects were found in this scan’s pictures.',
      detail: 'The frames were read and held no distinct things — only surfaces '
        + 'like walls, floors and ceilings.',
    }
  }

  const objects = `${seen} object${seen === 1 ? '' : 's'}`
  const block = BLOCK_BY_REASON[dominantReason(m) ?? ''] ?? 'other'
  switch (block) {
    case 'no-capture-poses':
      // The measured fact, not an inference about the source: keyframes.jsonl
      // for both video sessions on disk records {index, file, timestamp} and
      // nothing else — 0 of 32 and 0 of 48 frames carry a pose, against 17 of
      // 17 on a phone capture. Solved camera positions are not a substitute and
      // are deliberately not offered as one: they have no real-world size, which
      // is the 'no-real-world-scale' case below.
      return {
        block,
        headline: 'This scan cannot say where things are.',
        detail: `Its ${objects} were recognised in the pictures, but the pictures only `
          + 'record what the camera saw — not where the camera was standing. Without that '
          + 'there is nothing to measure a position against. This is normal for a scan '
          + 'built from an uploaded video: a video can rebuild the shape of a room, but it '
          + 'cannot locate anything inside it. Walking the room with the phone scanner '
          + 'records both at once, and that is what puts things on the map.',
      }
    case 'no-real-world-scale':
      // Measured on sess-video-20260830-033839 forced onto solved camera
      // positions: 23 of 29 segments 'out-of-range', cones holding a median of
      // 109 points at depths of 3.6-18.1 in a unitless frame. The geometry is
      // there; the numbers are not metres.
      return {
        block,
        headline: 'This scan’s room has no real-world size.',
        detail: `Each of its ${objects} was traced to a surface, but the room was rebuilt `
          + 'from pictures alone, which fixes its shape and not how big it is. "Two metres '
          + 'away" has no meaning in it, so no position can be trusted. Scanning the room '
          + 'with the phone measures real distances as it goes, and things can be placed in '
          + 'that from the start.',
      }
    case 'thin-geometry':
      return {
        block,
        headline: `Saw ${objects} but could not work out how far away any of them were.`,
        detail: 'Too little of the room is scanned where those objects are, so there is no '
          + 'surface to measure against. Scan again more slowly, pointing the camera at the '
          + 'objects themselves rather than sweeping past them.',
      }
    case 'weak-placements':
      return {
        block,
        headline: `Worked out where ${objects} might be, but trusted none of it.`,
        detail: 'Each one came out either too vague or split between two possible distances. '
          + 'A slower second pass over the same area, closer to the objects, is what '
          + 'sharpens this.',
      }
    default:
      return {
        block: 'other',
        headline: `Saw ${objects} in this scan’s pictures and could not place any of them.`,
        detail: unplacedReasonLine(m) || 'No reason was recorded.',
      }
  }
}

/**
 * One sentence about what the lift achieved for this scan.
 *
 * Names outcomes, never job types: "run panoptic-lift" is not a thing a person
 * reading a room can act on, whereas "walk the room" is. Every "nothing was
 * placed" case defers to `placementVerdictOf` so the layers panel and the
 * Things list cannot say two different things about one scan (ADR 0001).
 */
export function summarizePanopticLayer(layer: ScanPanopticLayer): string {
  const verdict = placementVerdictOf(layer)
  if (verdict) return `${verdict.headline} ${verdict.detail}`

  const m = layer.manifest
  const seen = m.segmentCount ?? layer.placedCount + layer.unplacedCount
  const marginal = layer.markers.filter(marker => marker.tier === 'marginal').length
  const parts = [
    `Placed ${layer.placedCount} of ${seen} object${seen === 1 ? '' : 's'}`,
    marginal > 0 ? `${marginal} marked unsure (hollow amber)` : null,
    layer.unplacedCount > 0 ? `${layer.unplacedCount} could not be placed` : null,
  ].filter((part): part is string => part !== null)
  return `${parts.join(' · ')}.`
}

/** The reason breakdown, longest bucket first, as one readable line. */
export function unplacedReasonLine(manifest: PanopticLiftManifest): string {
  const reasons = Object.entries(manifest.reasons ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
  if (reasons.length === 0) return ''
  return `Not placed: ${reasons.map(([reason, count]) => `${count} because ${reasonText(reason)}`).join('; ')}.`
}
