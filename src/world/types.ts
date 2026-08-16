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

export type MemberRole = 'scanner' | 'viewer' | 'editor' | 'owner'

export type WorldJobType =
  | 'ingest'
  | 'extract-layers'
  | 'align-scan'
  | 'merge-points'
  | 'semantic-pass'
  | 'depth-reconstruct'
  | 'lingbot-map-reconstruct'
  | 'splat-train'
  | 'splat-detect'
  | 'splat-finish'
  | 'memory-push'
  | 'export-world'
  | 'optimize-scan'

export type WorldJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type ScanReviewStatus = 'ready' | 'needs-review' | 'needs-rescan'

export type ScanManifestStatus = ScanReviewStatus | 'processing' | 'aligned' | 'error'

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
  targetId: string
  scope: 'scan' | 'object' | 'point-selection' | 'layer' | 'world'
  transform?: TransformPatch
  label?: string
  category?: string
  notes?: string
  visible?: boolean
  actorId?: string
  createdAt: string
}

export interface ScanManifest {
  scanId: string
  sessionId: string | null
  filename: string
  name: string
  glbUrl: string
  metadataUrl?: string
  geoPose: GeoPose
  localToWorld: number[]
  accuracyM: number | null
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

export interface WorldProject {
  worldId: string
  name: string
  shareSlug: string
  originGeoPose: GeoPose
  localFrame: LocalFrame
  scans: ScanManifest[]
  members: WorldMember[]
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
