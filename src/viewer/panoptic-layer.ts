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
  'no-pose': 'the frame had no camera pose',
  'degenerate-camera': 'the camera pose was unusable',
  'centroid-off-mask': 'the ray missed the object',
  'no-geometry': 'nothing was scanned behind it',
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
 * One sentence about what the lift achieved for this scan.
 *
 * Names outcomes, never job types: "run panoptic-lift" is not a thing a person
 * reading a room can act on, whereas "walk the room" is.
 */
export function summarizePanopticLayer(layer: ScanPanopticLayer): string {
  const m = layer.manifest
  if (m.status === 'skipped') {
    // Deliberately not the manifest's own `remediation`: it is written for an
    // operator and names the job to run next, which is not something a person
    // looking at a room can act on. Two structural cases cover every skip the
    // driver writes — `pointCount` is 0 exactly when the cloud was the missing
    // input, and absent when the segments were.
    return m.pointCount === 0
      ? 'Nothing to place objects against yet: this scan has no point cloud. '
        + 'The room has to be reconstructed before anything can be placed in it.'
      : 'This scan’s frames have not been read for objects yet, so there is nothing to place.'
  }
  if (m.status === 'error') {
    return `Object placement failed: ${m.error ?? 'unknown error'}`
  }

  const seen = m.segmentCount ?? layer.placedCount + layer.unplacedCount
  if (seen === 0) return 'No discrete objects were found in this scan’s frames.'
  if (layer.placedCount === 0) {
    return `Saw ${seen} object${seen === 1 ? '' : 's'} in the frames but could not place any of them. ` +
      'A capture that rotates in place has almost no parallax, so depth is not recoverable from it — ' +
      'walk the room to give the scan a baseline.'
  }

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
