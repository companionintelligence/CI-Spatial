export type LayerType =
  | 'points'
  | 'mesh'
  | 'floor'
  | 'detections'
  | 'labels'
  | 'cameraPath'
  | 'cameraFrustums'
  | 'rgbFrames'
  | 'depth'
  | 'splat'
  | 'semanticMasks'
  | 'anchor'

/**
 * Capabilities for a shared Place workspace. `commenter` can inspect a place
 * and leave review notes, but cannot change spatial source data.
 */
export type MemberRole = 'scanner' | 'viewer' | 'commenter' | 'editor' | 'owner'

export type WorldJobType =
  | 'ingest'
  | 'extract-layers'
  | 'align-scan'
  | 'merge-points'
  | 'semantic-pass'
  | 'depth-reconstruct'
  | 'thing-correspondence'
  | 'lingbot-map-reconstruct'
  | 'splat-train'
  | 'splat-detect'
  | 'splat-finish'
  | 'sensenova-vision'
  | 'memory-push'
  | 'export-world'
  | 'optimize-scan'

export type WorldJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type ScanReviewStatus = 'ready' | 'needs-review' | 'needs-rescan'

export type ScanManifestStatus = ScanReviewStatus | 'processing' | 'aligned' | 'error'

export type ScanStatus = 'draft' | 'ready' | 'archived'

export interface Room {
  roomId: string
  name: string
  zone?: string
}

/**
 * A named region inside a Place. Floors and rooms remain the legacy storage
 * projection, while Areas are the user-facing hierarchy that can also model a
 * wing, outdoor zone, or sub-building without inventing another Place.
 */
export type AreaKind = 'site' | 'building' | 'floor' | 'room' | 'zone' | 'outdoor'

/** The semantic level represented by a Place/Project in the broader Place graph. */
export type PlaceType = 'building' | 'floor' | 'room' | 'other'

export interface PlaceArea {
  areaId: string
  name: string
  kind: AreaKind
  parentAreaId?: string | null
  floorId?: string | null
  roomId?: string | null
  notes?: string
}

export interface Floor {
  floorId: string
  /** Display label, e.g. "Ground Floor" or "Level 2" */
  name: string
  /** Ordinal level number (0 = ground) */
  level: number
  rooms: Room[]
}

export interface Project {
  projectId: string
  name: string
  /** Optional level for this Place in the cross-project building hierarchy. */
  placeType?: PlaceType
  /** Optional parent Place, such as a Building for a Floor or a Floor for a Room. */
  parentProjectId?: string | null
  /** Human-readable hierarchy context, retained even before a matching parent Place exists. */
  buildingName?: string
  floorName?: string
  roomName?: string
  address?: string
  notes?: string
  /** Location confirmed when this place was created or edited. */
  geoPose?: GeoPose
  /** Stable indoor reference triangle used to align every AR session in this project. */
  spatialFrame?: ProjectSpatialFrame
  createdAt: number
  updatedAt: number
  /**
   * Canonical user-facing containment graph. Older projects can omit this;
   * their `floors` and `rooms` continue to work and are surfaced as Areas.
   */
  areas?: PlaceArea[]
  floors: Floor[]
}

/** `Project` is the durable API/storage name; the product calls it a Place. */
export type Place = Project

/**
 * A Place's durable reference for aligning every AR session to the same
 * physical origin: a single hit-tested ground point plus a compass bearing
 * sampled at tap time. Replaced the original 3-point reference-triangle
 * system (which had no live callers left in the app and no persisted data
 * depending on it, so it was removed outright rather than kept as a second
 * variant).
 */
export interface ProjectSpatialFrame {
  version: 1
  method: 'ground-tap-compass'
  /** True-north bearing sampled at tap time, or null if the compass was unavailable. */
  anchorBearingDeg: number | null
  createdAt: string
}

export interface ScanCalibration {
  method: 'ground-tap-compass'
  /** Matrix that maps the current AR session's local coordinates into project space. */
  sessionToProject: number[]
  anchorBearingDeg: number | null
  calibratedAt: string
  /**
   * - `'provisional'` — a frame is established, but its agreement with any
   *   previously recorded frame for this Place is unconfirmed. **Every
   *   calibration the app currently produces is this**, because a single
   *   ground anchor is project-space (0,0,0) by construction and so cannot be
   *   checked against itself.
   * - `'verified'` — **no current producer.** Values found in stored data were
   *   written by the #141-era build, where the label did not imply an actual
   *   check. Wave 09 ticket 0004 restores a real producer by measuring a
   *   two-point separation against the stored reference.
   * - `'uncalibrated'` — written by `src/export/gltf.ts`'s `?? 'uncalibrated'`
   *   fallback when a scan has no calibration at all.
   */
  status: 'verified' | 'provisional' | 'uncalibrated'
}

export interface ScanEntryQualitySummary {
  coverageScore: number
  lowLightFrames: number
  driftEvents: number
  reflectiveWarnings: number
  pointCount: number
}

export interface ScanEntry {
  scanId: string
  projectId: string | null
  sessionId: string
  /** Filename of the uploaded .glb on the server (if already uploaded) */
  scanFilename?: string
  floorId?: string
  roomId?: string
  /** User-facing area assignment, independent of legacy floor/room fields. */
  areaId?: string | null
  name: string
  status: ScanStatus
  capturedAt: number
  notes?: string
  qualitySummary?: ScanEntryQualitySummary
  calibration?: ScanCalibration
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export interface GeoPose {
  lat: number | null
  lng: number | null
  altitudeM: number | null
  bearing: number | null
  accuracyM: number | null
  fixedAt?: string | null
  address?: string | null
  displayAddress?: string | null
}

export interface LocalFrame {
  type: 'ENU_Y_UP'
  origin: GeoPose
  units: 'meters'
  axes: {
    x: 'east'
    y: 'up'
    z: 'north'
  }
}

export interface LayerManifest {
  id: string
  type: LayerType
  label: string
  visibleByDefault: boolean
  encodedInGlb: boolean
  count?: number | null
  source?: 'glb' | 'sidecar' | 'derived' | 'future'
}

export interface FrameObservation {
  frameId: string
  scanId: string
  rgbUrl: string
  timestamp: number
  pose: { position: Vec3; rotation: Quat }
  intrinsics: {
    width: number
    height: number
    fovYDeg?: number
    fx?: number
    fy?: number
    cx?: number
    cy?: number
  }
  frustum: {
    nearM: number
    farM: number
    fovYDeg: number
    aspect: number
  }
  depthUrl?: string
  semanticMaskUrl?: string
}

export interface ScanQualitySummary {
  coverageScore: number
  coverageText: string
  pointCount: number
  detectionCount: number
  poseCount: number
  keyframeCount: number
  lowLightFrames: number
  driftEvents: number
  reflectiveWarnings: number
  missingAreas: number
  trackingLost: boolean
  status: ScanReviewStatus
  recommendations: string[]
  capturedAt: string
}

export interface TransformPatch {
  position?: Vec3
  rotation?: Quat
  scale?: Vec3
  matrix?: number[]
}

export interface EditPatch {
  patchId: string
  worldId: string
  scanId?: string
  /**
   * For scope 'thing' this is a Thing.thingId; for every other scope it keeps
   * its existing meaning.
   */
  targetId: string
  scope: 'scan' | 'object' | 'point-selection' | 'layer' | 'world' | 'thing'
  transform?: TransformPatch
  label?: string
  category?: string
  notes?: string
  visible?: boolean
  actorId?: string
  /** Fallback object id for thing-scoped patches if correspondence changes. */
  originTargetId?: string
  createdAt: string
}

export interface ScanManifest {
  scanId: string
  projectId: string | null
  /** The Area within the current Place where this scan belongs. */
  areaId?: string | null
  sessionId: string | null
  filename: string
  name: string
  glbUrl: string
  metadataUrl?: string
  geoPose: GeoPose
  localToWorld: number[]
  accuracyM: number | null
  geoDistanceM: number | null
  geoOutlier?: boolean
  /** Already written into the upload sidecar (src/export/gltf.ts) but not
   *  previously surfaced back out — lets the editor know whether this scan's
   *  local origin is a real marked physical point worth rendering an anchor for. */
  calibrationMethod?: ScanCalibration['method']
  calibrationStatus?: ScanCalibration['status']
  capturedAt: string | null
  pointCount: number | null
  detectionCount: number | null
  layerIndex: LayerManifest[]
  frameSetUrl?: string
  qualitySummary?: ScanQualitySummary | null
  status: ScanManifestStatus
}

export interface WorldMember {
  memberId: string
  role: MemberRole
  token: string
  createdAt: string
  expiresAt?: string | null
  revokedAt?: string | null
}

/**
 * An append-only review note in a Place workspace. Comments may concern the
 * whole Place or be anchored to a specific Area, Scan, or persistent Thing.
 */
export interface ReviewComment {
  commentId: string
  worldId: string
  body: string
  scanId?: string | null
  thingId?: string | null
  areaId?: string | null
  actorId: string
  actorRole: MemberRole | 'local'
  createdAt: string
}

export interface WorldJob {
  jobId: string
  worldId: string
  type: WorldJobType
  status: WorldJobStatus
  scanId?: string
  workerId?: string
  capabilities: string[]
  payload?: Record<string, unknown>
  result?: string
  artifacts?: Array<{ type: string; url?: string; label: string; metadata?: Record<string, unknown> }>
  progress?: number
  error?: string
  createdAt: string
  updatedAt: string
}

export interface DetectionObservation {
  observationId: string
  sessionId: string
  label: string
  confidence: number
  description: string
  bbox: [number, number, number, number]
  worldPos: Vec3
  worldRot: Quat
  captureTimestamp: number
  captureIndex?: number
}

export type ThingChangeKind = 'new' | 'matched' | 'moved' | 'removed' | 'ambiguous'

export interface Thing {
  thingId: string
  worldId: string
  /** Place and Area provenance make Things resolvable outside a loaded scene. */
  projectId?: string | null
  areaId?: string | null
  canonicalLabel: string
  representativeTargetId: string
  position: Vec3
  firstSeenScanId: string
  lastSeenScanId: string
  observationIds: string[]
  createdAt: string
  updatedAt: string
  origin: 'matcher' | 'user'
  changeKind?: ThingChangeKind
}

export interface ThingObservation {
  observationId: string
  thingId: string
  scanId: string
  projectId?: string | null
  areaId?: string | null
  sessionId: string | null
  targetId: string
  label: string
  canonicalLabel: string
  confidence: number | null
  worldPos: Vec3
  observedAt: string | null
  origin: 'matcher' | 'user'
}

export interface WorldProject {
  worldId: string
  name: string
  shareSlug: string
  projectId: string | null
  originGeoPose: GeoPose
  localFrame: LocalFrame
  scans: ScanManifest[]
  things: Thing[]
  thingObservations: ThingObservation[]
  members: WorldMember[]
  /** Older world files omit this collection; readers initialize it to `[]`. */
  comments?: ReviewComment[]
  jobs: WorldJob[]
  editPatches: EditPatch[]
  createdAt: string
  updatedAt: string
}

// ─── Pipeline-stage manifests ──────────────────────────────────────────────
// The canonical interfaces live in ./manifests.ts (split out of this file so
// pipeline-stage envelopes — a third family alongside this file's "places"
// types — can be imported standalone from browser code without dragging in
// Deno-only driver code; see that file's header for why). Re-exported here
// because src/world/types.ts is the established cross-runtime import point
// (main.ts and all src/viewer/* already import from it).
export type {
  PipelineManifestBase,
  SplatTrainManifest,
  SplatDetectManifest,
  SplatFinishManifest,
  SplatFinishSizes,
} from './manifests.ts'
