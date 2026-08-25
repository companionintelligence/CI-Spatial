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
  /**
   * A time-varying splat: one trained Gaussian splat per timestep, played back
   * on a clock. The app's first animated asset — produced by a person capture,
   * not by a room scan.
   */
  | 'splat4d'
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
  | 'colmap-poses'
  | 'splat-train'
  | 'splat-detect'
  | 'splat-finish'
  /**
   * Reconstruct a 4D person from a take.
   *
   * The first job type that *delegates* rather than computing: it hands the
   * take to an off-box subsystem, polls, and ingests the returned sequence.
   * That is not a stylistic choice — the pump is globally single-flight, and
   * training one splat per timestep on the appliance would block every
   * upload's optimize-scan for the better part of an hour.
   */
  | 'person-4d-reconstruct'
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
 * One marker's reference photo — the camera frame at the moment that marker
 * was committed, with the exact tap point recorded so a crosshair can be drawn
 * over it on a return visit (wave 09 ticket 0007).
 *
 * **A human aid, never an input to the transform.** Nothing that builds
 * `sessionToProject` may read this. It exists because `separationM` proves the
 * two points were the right *distance* apart and never that they were the
 * *same two points* — and tapping the correct pair in reverse order passes the
 * separation check while rotating the frame exactly 180°. Only the user can
 * catch that, and only if given something to recognise.
 *
 * Recognition is also why this is a photo rather than the stored points
 * themselves: `landmark` and `headingMarker` are tautological by construction
 * (origin, and +Z at `separationM`), and drawing them in a new session would
 * need the very `sessionToProject` that calibration has not produced yet.
 */
export interface CalibrationReferencePhoto {
  /** Server URL, once uploaded. Null while pending or if the upload never succeeded. */
  url: string | null
  /** Local IndexedDB key for the blob — always present on the capturing device. */
  localKey: string
  /** Normalised 0-1 screen coords of the tap within this frame; a crosshair is drawn here. */
  tapPoint: { x: number; y: number }
  /** Camera pose at capture, so the vantage point is recoverable later. */
  pose: { position: Vec3; rotation: Quat }
  capturedAt: string
}

/**
 * A Place's durable alignment reference.
 *
 * `'two-point-ground'` is the preferred, higher-accuracy tier. An established
 * ground plane fixes the floor (project-space y = 0), a landmark on it fixes
 * the origin, and a second marker on the same plane fixes the heading
 * geometrically — so orientation does not depend on an indoor magnetometer
 * reading, and the recorded separation gives later sessions something real to
 * verify against.
 *
 * `'ground-tap-compass'` (from #141) is the single-point fallback for when a
 * second marker is impractical. Its heading is only as good as the compass fix,
 * a null fix leaves the frame at the AR session's arbitrary startup yaw, and
 * its y = 0 plane is wherever the single tap landed rather than the floor — so
 * frames of this method cannot be verified across sessions.
 */
export type ProjectSpatialFrame = {
  version: 1
  createdAt: string
} & (
  | {
      method: 'two-point-ground'
      /**
       * The origin — the permanent spot in the room, placed on the established
       * ground plane. (0,0,0) in project space by construction; stored
       * explicitly so the record is self-describing.
       */
      landmark: Vec3
      /**
       * The second marker, on the same ground plane, whose direction from the
       * landmark fixes the frame's heading. Its y equals the landmark's, so the
       * baseline is horizontal by construction.
       */
      headingMarker: Vec3
      /** landmark→headingMarker distance in metres — the room-intrinsic invariant a later session must reproduce. */
      separationM: number
      /** Max acceptable deviation from separationM on a later visit. Default `DEFAULT_SEPARATION_TOLERANCE_M`. */
      toleranceM: number
      /**
       * True-north bearing of the **session frame's +Z axis** at capture.
       * Records which way project-space north is, for GPS/world placement only
       * — NOT used to build the frame (that comes from the landmark→marker
       * geometry). Null when unavailable, which costs absolute orientation but
       * leaves the frame fully determined.
       *
       * **The frame's bearing, not the device's** (wave 09 ticket 0009). A
       * compass reports where the phone points; `composeYUpTransform` needs
       * where the session's axes point, and the two differ by however the
       * camera was held — by exactly 180° at the session's starting
       * orientation. Produced by `sessionFrameBearingDeg()`.
       *
       * **Records written before ticket 0009 carry the old meaning and cannot
       * be migrated:** correcting one needs the camera pose at the instant it
       * was sampled, which was never stored. They are wrong by an unknown
       * amount. Nothing in the app reads this field yet, which is the only
       * reason that is survivable.
       */
      anchorBearingDeg: number | null
      /**
       * Optional human descriptions of the two physical features, e.g.
       * "north door frame". Typed during capture (ticket 0007) and shown
       * beside each reference photo on return — a label survives a photo that
       * turns out ambiguous, and it is the only thing that distinguishes point
       * A from point B when both photos look like a stretch of floor.
       *
       * Index 0 is the landmark, index 1 is the heading marker. That order is
       * load-bearing: it is the order the frame's +Z axis is built from.
       */
      pointLabels?: [string, string]
      /**
       * Reference photos of each marker's physical setup, shown on a return
       * visit so the user re-places on the same spots. Purely a human aid —
       * never an input to the transform. Absent when capture or upload
       * failed, which degrades re-acquisition but does not invalidate the
       * frame.
       */
      referencePhotos?: {
        landmark: CalibrationReferencePhoto
        headingMarker: CalibrationReferencePhoto
      }
    }
  | {
      method: 'ground-tap-compass'
      /**
       * Load-bearing for this method: the frame's entire heading. Null means
       * the frame sits at the session's arbitrary yaw.
       *
       * The **session frame's** bearing, not the device's — see the
       * `'two-point-ground'` member's note. The correction matters far more
       * here, because on this tier a 180° error is the frame's orientation
       * rather than unread metadata.
       */
      anchorBearingDeg: number | null
    }
)

/**
 * How well the members of a take agree on the time.
 *
 * A **take** is N simultaneous captures of one subject. Per-timestep
 * reconstruction slices every clip at the same instant and trains one splat
 * from that slice, so if two phones are 100ms apart and the subject is moving
 * at 1m/s, the frames they contribute to one timestep are 10cm apart in the
 * world — two different poses fed to the trainer as if they were one. Nothing
 * downstream can detect that; it shows up as a smeared reconstruction with no
 * error anywhere. So the residual is an input to whether a take is usable, not
 * diagnostics.
 *
 * A discriminated union for the same reason {@link ProjectSpatialFrame} is one
 * (ADR 0005 rule 3): `'measured'` is the only member that may be treated as
 * synchronised, and it is the only member carrying a residual — so a claim of
 * sync is *unstateable* without the measurement backing it, rather than merely
 * undocumented.
 *
 * `'unsynced'` is not a failure. A solo take has nothing to synchronise, and
 * the single-clip densify path never reads this field.
 */
export type TakeSync = {
  version: 1
  measuredAt: string
} & (
  | {
      method: 'measured'
      /**
       * This client's offset from server time, in ms. Applied when slicing
       * frames; never used to mutate a device clock.
       */
      offsetMs: number
      /**
       * Load-bearing: half-width of the offset-corrected disagreement across
       * this take's members, in ms.
       *
       * Computed server-side, where every member's estimate is visible — a
       * single client cannot compute it, which is exactly why a solo take is
       * `'unsynced'` rather than a fabricated zero.
       */
      residualMs: number
      /**
       * Max residual at which members may be sliced as simultaneous.
       * Default `DEFAULT_SYNC_TOLERANCE_MS`, which is **adopted, not
       * measured** — see its definition.
       */
      toleranceMs: number
      /** Round-trip samples behind the estimate, so a thin estimate reads as thin. */
      sampleCount: number
    }
  | {
      method: 'unsynced'
      /** Why no measurement exists. None of these are errors on the solo path. */
      reason: 'solo-take' | 'insufficient-peers' | 'exchange-failed'
    }
)

/**
 * Max inter-member residual at which a take's clips may be sliced as
 * simultaneous.
 *
 * **Adopted, not measured** (ADR 0005 rule 5). Nobody has yet recorded the real
 * spread across two phones on a tailnet, and a network round-trip's accuracy
 * floor is set by path asymmetry, which is unknown here. 50ms is roughly one
 * frame at 20fps — tight enough to be meaningful, loose enough not to reject
 * every take on a Wi-Fi link.
 *
 * **Revisit trigger:** the Checklist C sync procedure in
 * `docs/testing/DEVICE_TESTING.md`. If the measured spread across ≥10 runs
 * exceeds this, the honest response is to raise it and record the measurement —
 * not to keep a tolerance below the real floor, which makes every good take
 * report a false mismatch and is worse than no check at all.
 */
export const DEFAULT_SYNC_TOLERANCE_MS = 50

/**
 * One AR session's alignment onto a Place's {@link ProjectSpatialFrame}.
 *
 * `status` is a measurement, not a label — wave 09 ticket 0004 restored the
 * producer that ticket 0001 retired, so these words are now backed by an
 * actual check performed at commit time in `src/ar/project-calibration.ts`:
 * - `'verified'` — reachable only on the `'two-point-ground'` tier, and only
 *   when this Place already had a stored two-point frame *and* the
 *   re-measured landmark→marker separation matched its `separationM` within
 *   `toleranceM`. `residualM` carries the measured difference.
 * - `'provisional'` — a frame is established, but its agreement with any
 *   previously recorded frame for this Place is unconfirmed. Three ways to
 *   land here: a Place's first calibration (nothing to compare against), a
 *   `'ground-tap-compass'` fallback (a single ground anchor is project-space
 *   (0,0,0) by construction and so cannot be checked against itself), or a
 *   user overriding a separation mismatch — which is precisely the case where
 *   the check ran and did *not* pass, so it must never report verified.
 * - `'uncalibrated'` — written by `src/export/gltf.ts`'s `?? 'uncalibrated'`
 *   fallback when a scan has no calibration at all.
 *
 * Values on records written by the #141-era build predate all of this, where
 * `'verified'` did not imply any check had run.
 */
export type ScanCalibration = {
  /** Maps this AR session's local coordinates into project space. */
  sessionToProject: number[]
  calibratedAt: string
  status: 'verified' | 'provisional' | 'uncalibrated'
} & (
  | {
      method: 'two-point-ground'
      separationM: number
      /** The re-measured separation − stored `separationM`, in metres. 0 on the first calibration. */
      residualM: number
      toleranceM: number
      anchorBearingDeg: number | null
    }
  | {
      method: 'ground-tap-compass'
      anchorBearingDeg: number | null
    }
)

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
  Person4DManifest,
  PipelineManifestBase,
  ColmapPosesManifest,
  SplatTrainManifest,
  SplatDetectManifest,
  SplatFinishManifest,
  SplatFinishSizes,
} from './manifests.ts'
