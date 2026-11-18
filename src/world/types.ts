import type { CheckedBy, FitSummary, TapEvidence } from './calibration-evidence.ts'
import type { ScaleKind, ScaleMode } from './scale-mode.ts'

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
  | 'splat-align'
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
  /**
   * Per-keyframe panoptic segmentation: every pixel labelled, yielding both
   * discrete objects and room surfaces. Optional GPU tool — absent runtime
   * completes with a remediation rather than failing (see
   * docs/pipelines/panoptic-scan.md).
   */
  | 'panoptic-scan'
  /**
   * Lift `panoptic-scan`'s 2D thing segments into world space by casting each
   * segment centroid against the scan's own point cloud (see
   * docs/pipelines/panoptic-scan.md § Lifting). Runs after `panoptic-scan`,
   * whose segments sidecar is its input.
   *
   * Separate from `panoptic-scan` rather than folded into it because the two
   * fail for unrelated reasons and a person needs to tell them apart: the scan
   * stage needs a Python venv and a GPU, the lift stage needs a scan GLB with
   * geometry. Merging them would report "panoptic failed" for a missing point
   * cloud, which is the kind of misattributed error this codebase keeps
   * correcting. Re-running the lift is also cheap, and re-running segmentation
   * is not.
   */
  | 'panoptic-lift'
  | 'memory-push'
  | 'export-world'
  | 'optimize-scan'
  /**
   * Compare a scan's walls and obstacles with the Place's other calibrated scans
   * and PROPOSE a small move. It never moves anything itself: the proposal is a
   * job artifact, and a person applies it in the editor as an ordinary scan
   * EditPatch carrying `EditPatchProvenance`. See server/register/place_register.ts.
   */
  | 'place-register'
  /**
   * Delete the camera frames a server has kept longer than its retention setting (`KEYFRAME_RETENTION_DAYS`,
   * server/keyframe_retention.ts). A WorldJob so that it runs one at a time with every other job and never
   * removes a session a reconstruction job is reading. Queued in the default world only, like `optimize-scan`.
   * A request is a dry run (it reports and removes nothing) unless `payload.dryRun` is the boolean `false`. A real pass
   * takes its period from the server's environment alone; a dry run may name `payload.days` to preview one.
   */
  | 'keyframe-purge'

export type WorldJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type ScanReviewStatus = 'ready' | 'needs-review' | 'needs-rescan'

/**
 * `'aligned'` is what an older build's `align-scan` placeholder wrote into worlds on disk. Nothing
 * writes it now: the job has no worker and changes nothing, so it has no outcome to record. The
 * member stays so those world files still type, and the next world refresh derives the status
 * again from the scan's quality, as it did before.
 */
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
  /**
   * How many frame writes the server has accepted for this Place. Absent on a Place saved before
   * this field existed, which reads as 0 (`placeFrameRevision` in ./spatial-frame.ts). The server
   * owns it: a body that carries one is ignored. A frame is replaced only by
   * `PUT /projects/:id/spatial-frame` naming the revision it expects to find.
   */
  spatialFrameRevision?: number
  /**
   * The frames this Place held before the current one, oldest first: one entry each time a write replaced
   * the frame (see {@link FrameHistoryEntry}). Only the server writes it: `applySpatialFrameWrite` will append
   * the entry in the same step as the frame write that replaces the frame, and keep the last 20 (WP-08), and
   * until then nothing writes it. A whole-record PUT carries the stored value over and ignores the body's, as
   * it does for `spatialFrameRevision` (`placeFromBody`, server/wp-a-projects.ts), and so does the phone's
   * copy of the Place (`ProjectStore.updateProject`). The editor will read it, to list scans of an earlier
   * frame as "previous reference" and to count how many a replacement affects (WP-08). Absent on a Place whose
   * frame has not been replaced since the field existed, and on every Place saved before it: a replacement made
   * earlier left no entry, so absence is not proof that the frame was never replaced.
   */
  frameHistory?: FrameHistoryEntry[]
  /**
   * Where this Place is on Earth: its frame registered onto the map (see {@link ProjectGeoreference}).
   * Only `PUT /projects/:id/georeference` will write it (WP-11), never the whole-record PUT, which carries
   * the stored value over. The server will read it when it places a calibrated scan (`resolveWorldOrigin`,
   * `placeCalibratedScan`), and the editor's location readout, the map registration editor (WP-13) and the
   * GeoPose and Companion Memory exports will too. Nothing writes or reads it yet. Absent until a registration
   * is stored, and then every placement stays what it is today. `geoPose` above is the creating phone's
   * one-shot fix, the Place's pin: this does not replace it.
   */
  georeference?: ProjectGeoreference
  /**
   * How many georeference writes the server has accepted for this Place, counted as `spatialFrameRevision`
   * counts frame writes: absent reads as 0, the server owns it, and a write must name the version it
   * expects to find. The georeference route will write it (WP-11). The editor will read it, to name the
   * version it saves over, and the scan refresh will, to place again a scan nothing has moved by hand when the
   * version changes and to flag `ScanManifest.placementStale` on one something has.
   */
  georefVersion?: number
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
  /**
   * Where the server serves the photo from. The path is fixed by Place and role, so a frame records it as it
   * is saved, and the photos are uploaded after the server holds the frame (src/project/frame-sync.ts): the
   * path answers 404 until they have landed. Null on a frame saved before that, when the upload had failed.
   */
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
 * Which sign rule produced a stored session-frame bearing (`anchorBearingDeg`,
 * `projectBearingDeg`). Written as `bearingConvention` on the record beside it.
 *
 * `2` is `deviceBearing + cameraYaw` (`sessionFrameBearingDeg()` in ./geo.ts):
 * the bearing of a session direction is the bearing of session +Z minus that
 * direction's session yaw, so the camera's own yaw is added back. That is
 * computed, against a physical model that shares no code with the app
 * (tests/unit/deno/world_registration.test.ts): a right-handed Y-up session, a
 * camera that looks down its own -Z and a perfect compass. What a phone's
 * compass actually reports is not covered; that needs the spin test on a phone
 * (`compassSpinTerms()` in ./geo.ts).
 *
 * `1` is the rule the app used before (`deviceBearing − cameraYaw`), which is
 * wrong by twice the turn since the session started. It is written only when a
 * tester opens the page with `?bearing=1` to compare the two on a device.
 *
 * A record with no `bearingConvention` was written before the field existed, so
 * it carries rule 1. Its bearing cannot be repaired — the camera pose it needed
 * was never stored — and is not to be read. `readableAnchorBearingDeg()` and
 * `readableProjectBearingDeg()` in ./geo.ts are the one place that is decided.
 */
export type BearingConvention = 1 | 2

/**
 * One check point of a Place frame: a reference point after the landmark and the heading marker, in the
 * Place frame like them. The first-calibration flow will have it tapped (WP-04b) so that a later visit can be
 * checked by where its points land, and not only by how far apart two of them are (src/world/frame-fit.ts).
 * Its `y` is its height in the Place frame, where the landmark's is 0; the fit compares heights as it compares
 * positions (`FrameFit.heightRmsResidualM`).
 */
export interface FrameCheckPoint extends Vec3 {
  /**
   * What the person called the feature, when they named it: it will be typed in the capture flow with the point
   * (WP-04b) and shown beside the point's photo on a return visit, like `pointLabels` for the first two. Absent
   * when it was not named.
   */
  label?: string
  /**
   * The point's reference photo: a human aid, never an input to the fit. The server keeps it with the frame
   * generation that was written with it, so `url` is a frame-scoped path
   * (`/projects/:id/frames/:frameId/ref-check<n>.jpg`, see `framePhotoPath` in ./spatial-frame.ts), and the
   * frame carries the `frameId` it names; the validator also takes the same role in the Place's own photo folder
   * (`/projects/:id/reference-photos/ref-check<n>.jpg`). Null `url` while it is pending, as for the other two photos.
   */
  photo?: CalibrationReferencePhoto
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
      /**
       * The spacing tolerance applied when this frame was made, in metres (`twoPointToleranceM` at the tap noise in use; 0.15
       * on a frame made before the constellation flow). Kept for reading. A later visit is judged by the tolerance in force
       * then (src/ar/calibration-commit.ts), not by this field.
       */
      toleranceM: number
      /**
       * Compass bearing of the **session frame's +Z axis** at capture — the
       * AR session's own axis, not this frame's. The frame's +Z is the
       * landmark→marker baseline, whose bearing is `projectBearingDeg` below.
       * NOT used to build the frame (that comes from the landmark→marker
       * geometry). Null when unavailable, which costs absolute orientation but
       * leaves the frame fully determined.
       *
       * **The frame's bearing, not the device's** (wave 09 ticket 0009). A
       * compass reports where the phone points; `composeYUpTransform` needs
       * where the session's axes point, and the two differ by however the
       * camera was held — by exactly 180° at the session's starting
       * orientation. Produced by `sessionFrameBearingDeg()`.
       *
       * **Read it only through `readableAnchorBearingDeg()`.** A record with no
       * `bearingConvention` carries the rule that was wrong by twice the turn
       * since session start (see {@link BearingConvention}); it cannot be
       * migrated and is not to be read. Nothing in the app reads this field
       * yet.
       */
      anchorBearingDeg: number | null
      /**
       * Compass bearing of **this frame's +Z axis** — the landmark→marker
       * baseline: `anchorBearingDeg` minus the baseline's session yaw. This is
       * the number that orients the frame on a map; `anchorBearingDeg` cannot,
       * because the baseline is wherever the person walked.
       *
       * Data only: nothing places a scan with it yet. Absent on records from
       * before the field existed; null when the compass had no reading. Read it
       * only through `readableProjectBearingDeg()`.
       */
      projectBearingDeg?: number | null
      /** The sign rule `anchorBearingDeg` and `projectBearingDeg` were written under. */
      bearingConvention?: BearingConvention
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
      /**
       * Which generation of the Place's reference this is. A frame is immutable once written, so replacing
       * a Place's frame writes a new one with a new id, and `Project.frameHistory` keeps what it replaced.
       * The capture client will mint it when its calibration builds a frame (a UUID, or the time and random bytes
       * where the page has no `randomUUID`; WP-08). `validateSpatialFrame` checks the format only, and compares
       * it with the generation a frame-scoped photo path names (`framePhotoPath`). The server's replace rule
       * (`applySpatialFrameWrite`) will read it, and it will be copied onto each scan's calibration as
       * `ScanCalibration.frameId`, so the editor can tell scans of this reference from scans of an earlier
       * one (WP-08). An id is any text of the format `isFrameId` accepts, which includes names such as
       * `__proto__`: a consumer that counts or groups by it holds the counts in a `Map`, or in an object it
       * builds with `Object.fromEntries` and reads with `Object.hasOwn`, never in `counts[frameId]`.
       *
       * Absent on every frame written before the field existed. That is an unknown generation: it reads as
       * neutral ("frame not recorded") and never as a different frame. The one-point member carries none: a
       * scan calibrated on that tier is not in a Place frame generation at all.
       */
      frameId?: string
      /**
       * Reference points after the landmark and the heading marker, in the Place frame, at most
       * `MAX_CHECK_POINTS` (3, from ./spatial-frame.ts; the capture flow offers one). The points of the
       * frame are `[landmark, headingMarker, ...checkPoints]` in that order, which is the order
       * `fitRigid2D` takes both its arguments in (src/world/frame-fit.ts): a visit's taps are matched to the
       * stored points by position in that list.
       *
       * The first-calibration flow will write it from the taps, mapped into the Place frame (WP-04b). Never added
       * to an existing frame on a later visit: a later visit's own two-point frame would freeze its error into
       * the reference, so a two-point Place gets check points only through a new frame generation (WP-08). The
       * return-visit fit and the ghosts drawn from it will read it (WP-04b); nothing reads it yet. Absent on every
       * frame written before the field existed, which stays a two-point frame whose check can only be the
       * separation.
       */
      checkPoints?: FrameCheckPoint[]
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
       *
       * Written only when the compass had a reading: the one-point tier refuses
       * to commit without one. A record written before that may have `null`
       * here, and then its frame sits at the session's arbitrary yaw.
       */
      anchorBearingDeg: number | null
      /**
       * The sign rule `anchorBearingDeg` and this frame's heading were written
       * under. Under rule 1 (or none) project +Z lands on north only when the
       * camera happened to face north or south at the tap.
       */
      bearingConvention?: BearingConvention
    }
)

/**
 * Why a write replaced a Place's frame, as the writer states it and the server records it.
 *
 * - `'override'`: a return visit's points did not match the stored ones and the person kept them
 *   ("Replace this Place's reference").
 * - `'upgrade'`: a better reference for the same place: a one-point frame replaced by a two-point one, or a
 *   two-point frame by one with a check point.
 * - `'merge'`: the frame changed because two Places were merged.
 */
export type FrameReplaceReason = 'override' | 'upgrade' | 'merge'

/**
 * One frame a Place held and no longer does: what it was, and when and why it stopped being the Place's.
 * The server will append it to `Project.frameHistory` in the step that replaces the frame, from the frame
 * being replaced (WP-08), and never edit it after. The scans made against it are found by `frameId` in their
 * `ScanManifest.calibrationFrameId`.
 */
export interface FrameHistoryEntry {
  /** The replaced frame's `frameId`. Null when it was written before frame ids existed: an unknown generation. */
  frameId: string | null
  /** When the replaced frame was made: its own `createdAt`, an ISO time. */
  createdAt: string
  /** The replaced frame's method. */
  method: ProjectSpatialFrame['method']
  /** The replaced frame's separation in metres: null when it had none (the one-point method). */
  separationM: number | null
  /** When the server replaced it, an ISO time. */
  supersededAt: string
  reason: FrameReplaceReason
}

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
 * One capture's alignment onto a Place's {@link ProjectSpatialFrame}.
 *
 * Two of the three tiers describe an **AR session**, whose runtime supplied a
 * continuously-tracked local frame that only needed anchoring. The third
 * (`'known-distance'`) describes a capture that had no AR runtime at all — a
 * tripod walked between fixed viewpoints, or an uploaded video — where the
 * "session" frame is the camera solve's own arbitrary one. `sessionToProject`
 * means the same thing in all three cases (carry this capture's own
 * coordinates into project space); only where those coordinates came from
 * differs, and `method` is what says which. Reading `sessionToProject` without
 * branching on `method` would apply a solve-space matrix to AR-space points,
 * which is a plausible-looking wrong answer rather than an error.
 *
 * `status` is a measurement, not a label — wave 09 ticket 0004 restored the
 * producer that ticket 0001 retired, so these words are now backed by an
 * actual check performed at commit time in `src/ar/project-calibration.ts`
 * (and, for the `'known-distance'` tier, in `server/capture/known_distance.ts`):
 * - `'verified'` — reachable on two tiers, and on each only when a second
 *   independent measurement agreed with the first inside `toleranceM`:
 *   `'two-point-ground'` when this visit tapped three or more points and a
 *   least-squares fit of them to the Place's stored ones agreed inside the
 *   limits with nothing in the way of verifying (`checkedBy: 'constellation'`,
 *   src/world/frame-fit.ts). A visit that tapped two and re-measured the
 *   landmark→marker separation inside `toleranceM` is `'provisional'`
 *   (`checkedBy: 'separation'`): a distance says nothing about position or
 *   direction;
 *   `'known-distance'` when a second measured distance spanning a *different*
 *   pair of viewpoints was supplied and the frame built from all of them
 *   predicted every one of them inside tolerance. (The same pair measured
 *   twice is one constraint written twice — the scale absorbs it exactly, so
 *   it stays `'provisional'`.)
 *   `residualM` carries the measured disagreement in both cases.
 * - `'provisional'` — a frame is established, but its agreement with any
 *   previously recorded frame for this Place is unconfirmed. Four ways to
 *   land here: a Place's first calibration (nothing to compare against), a
 *   `'ground-tap-compass'` fallback (a single ground anchor is project-space
 *   (0,0,0) by construction and so cannot be checked against itself), a
 *   `'known-distance'` frame resting on exactly one measured distance (which
 *   fixes the scale exactly, so its own residual would be arithmetic rather
 *   than evidence — see that variant), a pair compared only by its spacing,
 *   or a user overriding a mismatch — which is precisely the case where the
 *   check ran and did *not* pass, so it must never report verified.
 * - `'uncalibrated'` — written by `src/export/gltf.ts`'s `?? 'uncalibrated'`
 *   fallback when a scan has no calibration at all.
 *
 * Values on records written by the #141-era build predate all of this, where
 * `'verified'` did not imply any check had run.
 */
export type ScanCalibration = {
  /** Maps this capture's own local coordinates into project space. See `method`. */
  sessionToProject: number[]
  calibratedAt: string
  status: 'verified' | 'provisional' | 'uncalibrated'
  /**
   * Which engine configuration produced the unit this capture's coordinates are in, and what that unit
   * is worth (see `src/world/scale-mode.ts`). Stamped where the calibration reaches the scanner, by
   * `stampScale` in `src/ar/engine-config.ts`, so it is on the scans that have a calibration and not on
   * a scan that has none. Absent on a record written before units were recorded, on the server's
   * `'known-distance'` tier (its metre stick is a tape, not a runtime), and when the runtime could not say.
   */
  scaleMode?: ScaleMode
  scaleKind?: ScaleKind
  /**
   * The session-space floor height, in metres, the origin sat on when this scan
   * was committed: the landmark's own measured `y`.
   *
   * Recorded with the scan rather than left inside `sessionToProject`'s
   * translation, so the origin's ground height can be read back without
   * decomposing a matrix. Project-space floor is `y = 0` by construction, so
   * the Place-level `ProjectSpatialFrame` needs no field of its own.
   *
   * Optional and nullable so existing records stay valid: a record written
   * before this field simply does not say where its floor was. Read it with
   * `readCalibrationGroundY()` in `./geo.ts`, which turns absence and
   * non-finite values into `null`.
   *
   * This nested record is the canonical one. `ScanManifest.calibrationGroundY`
   * is a flat projection of it, derived by the server.
   */
  groundY?: number | null
  /**
   * `true` when this commit's floor check was bypassed: "Place anchor without
   * floor check", or an off-floor tap accepted by a same-height retry.
   *
   * A bypassed commit is always `'provisional'`, and it never writes the Place's
   * `spatialFrame`, whether as a first creation or as an override. See
   * `mayWritePlaceFrame()` and `committedStatus()` in `src/ar/ground-gate.ts`.
   *
   * Optional so existing records stay valid: a record without it predates the
   * field, and reads as "not recorded". Uncalibrated scans carry no calibration
   * record at all. Their sidecar status `uncalibrated` is their record.
   */
  floorCheckBypassed?: boolean
} & (
  | {
      method: 'two-point-ground'
      separationM: number
      /** The re-measured separation − stored `separationM`, in metres. 0 on the first calibration. */
      residualM: number
      toleranceM: number
      /** Bearing of this session's +Z axis, as on the Place frame (`ProjectSpatialFrame`). Read it through `readableAnchorBearingDeg()`. */
      anchorBearingDeg: number | null
      /**
       * Bearing of the project frame's +Z axis as this one scan's compass saw
       * it: `anchorBearingDeg` minus the session yaw of this scan's own
       * landmark→marker baseline. Every scan of a Place gives its own reading of
       * the same bearing. Data only; absent before the field existed, null with
       * no compass reading.
       */
      projectBearingDeg?: number | null
      /** The sign rule `anchorBearingDeg` and `projectBearingDeg` were written under. */
      bearingConvention?: BearingConvention
      /**
       * The Place frame generation this calibration was measured against: the `frameId` of the Place's stored
       * frame, or of the frame this very calibration wrote on a first calibration or a replacement. The capture
       * client will write it (WP-08). The server already surfaces it as `ScanManifest.calibrationFrameId`
       * (`calibrationFromMeta`), and the editor will read that to tell scans of the current reference from scans
       * of an earlier one (WP-08). Absent when the Place's frame had no id: an unknown generation, which reads as
       * neutral and never as another.
       */
      frameId?: string
      /**
       * `true` when this scan is in no Place frame: its commit wrote no frame and was not matched to the one the Place holds, so its
       * `sessionToProject` is its own pair's and nothing ties it to the Place's. That is a commit whose floor check was bypassed
       * (`floorCheckBypassed`, above: a bypassed commit never writes the Place's frame) that was a first visit, a pair kept over a
       * mismatch, or "Improve this Place's reference". It names no `frameId`, whatever frame the Place holds. Written only when it is
       * true (`leavesScanOutsidePlaceFrame`, src/ar/ground-gate.ts), never `false`: a record in the frame it wrote or matched has no such
       * key, which is every record an earlier build wrote. The server surfaces it as `ScanManifest.calibrationOutsidePlaceFrame`
       * (`calibrationFromMeta`), and every reader asks `isInPlaceFrame` (src/world/frame-generations.ts) what it makes of it.
       */
      outsidePlaceFrame?: true
      /**
       * What this visit's points measured against the Place's stored ones: a least-squares fit of three or more
       * (`summariseFit`, src/world/frame-fit.ts). The capture client will write it on a return visit to a Place
       * whose frame has check points (WP-04b). The server already surfaces its size and disagreement as
       * `ScanManifest.calibrationFitPointsUsed`, `calibrationFitRmsM` and `calibrationFitMaxM`
       * (`calibrationFromMeta`), and only for a fit of three or more points; the editor's chip, the `[probe]` line and
       * the DX2 analysis will read them. Absent when only two points were compared, which is every first
       * calibration and every visit to a Place without check points: a fit of two points is exact and measures
       * nothing (ADR 0005 rule 3), and the one-point member has no such field at all.
       */
      fit?: FitSummary
      /**
       * Which check `status` rests on. `'constellation'`: three or more points were compared with the stored
       * ones, and `fit` backs it. `'separation'`: only the distance between the two points was compared, which
       * proves nothing about where they are or which way they face. The capture client will write it from the
       * verdict (`verifyFit`, `verifyTwoPoint`; WP-04b). The server already surfaces it as
       * `ScanManifest.calibrationCheckedBy`, leaving out a `'constellation'` that no fit of three or more backs, and
       * the editor's chip and the scanner's alignment line will read it to word what was and was not checked.
       * Absent on a record written before the field existed: its status rests on the separation, the only check
       * there was.
       */
      checkedBy?: CheckedBy
      /**
       * What the tap behind the landmark measured: its scatter, its range, where its position came from and
       * how high above the fitted floor it was (`tapEvidence`, src/ar/tap-sampling.ts). The capture client will
       * write it when the flow reads taps through `sampleTap` (WP-05b). Nothing in the app reads it yet: the
       * `[probe]` line and the DX2 and DX5 analyses will, to decide the tap limits. Absent when the flow read its
       * taps another way, and on every record written before taps were sampled.
       */
      tap?: TapEvidence
    }
  | {
      method: 'ground-tap-compass'
      /** Bearing of this session's +Z axis. The frame's own +Z is north by construction on this tier. */
      anchorBearingDeg: number | null
      /** The sign rule `anchorBearingDeg` and the frame's heading were written under. */
      bearingConvention?: BearingConvention
    }
  | {
      /**
       * The metre stick came from the operator, not from the runtime: one
       * physically measured real-world distance between two viewpoints the
       * capture can identify in its own solve.
       *
       * This is the tier for a capture with **no AR poses at all** — the
       * tripod-station path (`server/capture/station_dome.ts`), where each
       * station is a fixed spot the operator can put a tape measure between.
       * The other two tiers cannot reach it: both derive metres from an AR
       * runtime's tracked frame, and there isn't one.
       *
       * `sessionToProject` here carries **camera-solve** coordinates into
       * project space, not AR-session ones, and it determines strictly less
       * than the other tiers do — see `gravityAligned`, and
       * `SplatAlignManifest.determined`, which spells out which of the seven
       * degrees of freedom this actually fixed. Rotation about the up axis is
       * free with a single distance and is *not* invented here; the World
       * Editor's two-point flow is what settles it.
       */
      method: 'known-distance'
      /**
       * The measured distance the whole frame rests on, in metres — the first
       * one, when several were supplied. Named to match the `'two-point-ground'`
       * variant's field: both are "the physical length that proves this frame
       * is in metres".
       */
      separationM: number
      /**
       * RMS disagreement in metres between what this frame predicts and what
       * was measured, over whatever redundancy existed.
       *
       * With two or more measured distances that is a direct check of the
       * scale (each extra distance is one the frame did not get to fit). With
       * exactly one it cannot be — one distance fixes the scale exactly, so
       * that residual is 0 by construction — and it instead carries the
       * strongest independent measurement available: how far, in metres, the
       * frames claimed to share a viewpoint actually land from that viewpoint's
       * centre. That catches a mis-grouped or badly-solved capture; it cannot
       * catch a mis-typed tape reading, and nothing measured from one distance
       * could. Hence `status: 'provisional'` in that case.
       */
      residualM: number
      toleranceM: number
      /**
       * True when the camera solve reported a trustworthy gravity direction and
       * rotated its output onto it, so +Y is up in solve space and this frame
       * inherits a real vertical. False means the solve never established one:
       * the scale is still metric but the frame is tilted by an unknown amount,
       * and nothing here guesses. Read from the solve's own manifest
       * (`ColmapPosesManifest.gravityAligned`) rather than assumed.
       */
      gravityAligned: boolean
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

/**
 * A GPS fix with the compass bearing the phone had when it was taken. It is NOT an OGC GeoPose (OGC 21-056r11,
 * https://www.ogc.org/standards/geopose/), whatever the name suggests: a GeoPose is a position and the
 * orientation of an object, and nothing here is the orientation of a frame. `bearing` is the phone's compass
 * heading, in degrees clockwise from MAGNETIC north (see src/geo/compass-heading.ts), not the bearing of any
 * scan or Place frame. `altitudeM` has no datum the code can name (w3c/geolocation issue 210 records Safari
 * returning height above mean sea level and Chrome on Android the ellipsoid value; OGC's `h` is ellipsoidal),
 * and every number may be null here where OGC requires one. `lng` is `lon` there. An export in the OGC
 * encoding is an explicit conversion, not this type under another name.
 */
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
    /**
     * The compass direction the scene's +z axis points at.
     *
     * `'north'` is what every world file says today. (east, up, north) is a
     * left-handed set of axes, and the AR sessions placed in it are
     * right-handed, so a session placed by rotation alone comes out mirrored.
     *
     * `'south'` is the right-handed scene proposed in ./enu.ts (x east, y up,
     * z south), in which a rotation places a session exactly. No code writes it
     * yet. The editor's compass reads it, so that dial follows whichever the
     * world declares.
     */
    z: 'north' | 'south'
  }
}

/**
 * How a georeference's origin and bearing were obtained.
 *
 * - `'map-click'`: placed by hand on the map: the origin by a click, the bearing from a long edge or two far
 *   clicks.
 * - `'footprint-snap'`: as `'map-click'`, with the origin or the bearing snapped to a building footprint's
 *   vertex or edge.
 * - `'gps-compass'`: a seed from a phone's GPS fix and compass. Approximate, and never averaged into a
 *   registration a person confirmed.
 * - `'course-over-ground'`: the bearing from the GPS track of a straight walk outdoors.
 * - `'typed'`: numbers entered by hand.
 * - `'survey'`: surveyed control points.
 */
export type GeoreferenceSource =
  | 'map-click'
  | 'footprint-snap'
  | 'gps-compass'
  | 'course-over-ground'
  | 'typed'
  | 'survey'

/**
 * Where a Place frame's origin is on Earth. Not a {@link GeoPose}: that is a phone's fix, whose latitude and
 * longitude may be missing, and which carries the phone's heading and an address. A registration has a
 * position or it has none.
 */
export interface GeoreferenceOrigin {
  /** Degrees, WGS84 (EPSG:4326). */
  lat: number
  /** Degrees, WGS84, in [-180, 180]. */
  lng: number
  /**
   * Ellipsoidal height of the origin, metres, or null when it is not known. Never a phone's
   * `coords.altitude`, which is above mean sea level on iOS and above the ellipsoid on Android.
   */
  altitudeM: number | null
  /** Horizontal accuracy, metres, as R68: the radius that holds the true position 68% of the time. */
  accuracyM: number
}

/**
 * A Place's registration onto the map: where its frame's origin is, and which way its +Z axis points.
 *
 * The origin is the Place frame's (0, 0, 0): the landmark, on the floor. `bearingDeg` is the TRUE bearing of
 * the frame's +Z axis, the landmark-to-heading-marker direction, which a compass reading of the session cannot
 * give (the session's +Z is wherever the AR runtime started). `PUT /projects/:id/georeference` will write it
 * (WP-11), with the map registration editor (WP-13) or the Place location panel as the usual client, and the
 * server will read it when it places a calibrated scan (`resolveWorldOrigin`, `placeCalibratedScan`), as will the
 * editor's location readout and the GeoPose and Companion Memory exports. Nothing writes or reads it yet.
 * `Project.georefVersion` counts the writes.
 */
export interface ProjectGeoreference {
  origin: GeoreferenceOrigin
  /**
   * What `origin.altitudeM` is measured from: `'ellipsoid'` (WGS84), or `'unknown'` when there is no height
   * or its datum was not recorded.
   */
  heightDatum: 'ellipsoid' | 'unknown'
  /** TRUE bearing of the Place frame's +Z axis: degrees clockwise from true north, in [0, 360). */
  bearingDeg: number
  /** One standard deviation of `bearingDeg`, degrees. */
  bearingAccuracyDeg: number
  /**
   * The sign rule `bearingDeg` was written under (see {@link BearingConvention}). Only the corrected rule is ever
   * written here, so a bearing from the rule that mirrored east and west cannot be stated in this record.
   */
  convention: 2
  datum: 'WGS84'
  source: GeoreferenceSource
  /**
   * The magnetic declination applied to turn a compass reading into `bearingDeg`, when one was: `deg` is east
   * positive (true = magnetic + `deg`), `model` names the field model, `year` is the decimal year it was
   * evaluated at. Only on a record that used a compass.
   */
  declination?: { deg: number; model: 'WMM2025'; year: number }
  /**
   * The values a seed (`source: 'gps-compass'`) was computed from, kept so it can be recomputed if the model or
   * a sign is corrected. For audit: nothing places a scan from it. Shaped by the seed's writer (WP-11).
   */
  seed?: Record<string, unknown>
  /** When the registration was stored, an ISO time. */
  registeredAt: string
  /**
   * When a person confirmed it, an ISO time. Absent on a seed: a registration without it is unconfirmed, and
   * the map features are for confirmed ones.
   */
  confirmedAt?: string
  /**
   * What the registration was made against: the `frameId` of the Place frame generation (WP-08), or later a
   * fiducial's id. It binds the registration to the anchor's identity and not to the frame's `createdAt`, so a
   * replaced frame is seen to leave the registration behind. Null when the frame had no id, which is a frame
   * written before ids existed: nothing then says which generation the registration belongs to.
   */
  anchorRef: string | null
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
  /** How many times the camera moved at 2 m/s or more. Same number as `fastMotionEvents`; the name stored summaries and the server use. */
  driftEvents: number
  /**
   * `driftEvents` under the name that says what it counts: fast camera moves, a risk to
   * tracking, not a measure of drift. Absent on a summary written before it existed.
   */
  fastMotionEvents?: number
  /**
   * How many times the runtime's frame was interrupted or reported moved since the earlier
   * of the scan's start and the frame its Place calibration was made in (src/ar/frame-epoch.ts):
   * a measured pose jump, a reported reset, tracking back after a relocalization or a long loss,
   * a resume. Each is at least suspect, none is proof that a frame moved. Above zero, `status`
   * is not 'ready'. Absent on a summary written before they were counted, which does not mean
   * there were none.
   */
  frameShifts?: number
  /**
   * Whether the scan's point cloud holds points from more than one stretch of tracking (`frameEpochs.mixedEpochs` in
   * the upload sidecar, src/ar/frame-epoch.ts). Set where the server builds a scan's summary from its sidecar
   * (server/frame_epoch_fields.ts), not by the phone: the phone writes it into `frameEpochs`. It means the cloud spans
   * more than one epoch, not that the epochs disagree. Absent on a sidecar from before it was recorded, which does not
   * mean the cloud is of one.
   */
  mixedEpochs?: boolean
  /** Time spent with degraded tracking since the scan began, in milliseconds. Absent when not measured. */
  limitedMs?: number
  reflectiveWarnings: number
  missingAreas: number
  /**
   * Tracking was unusable when the summary was made, and had been for a while (no pose yet,
   * or the runtime's status degraded for three seconds). One tick of LIMITED is not a loss.
   * Summaries written before that hold read it from the first-pose latch, so were true
   * only before the first pose.
   */
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

/**
 * Where a patch's numbers came from, when a job proposed them and a person applied
 * them. Absent on every patch a person made by hand. The refined placement and the
 * residual that backs it live here and in the patch, never in the scan's raw
 * `sessionToProject`, which stays as the capture measured it.
 */
export interface EditPatchProvenance {
  source: 'place-register'
  /** The WorldJob that proposed this placement. One job is applied at most once. */
  jobId: string
  /** The proposal's score, 0 to 1, as the job reported it. */
  score: number
  /** The measured gap between the two scans' walls after the move, metres. */
  residualM: number
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
  /**
   * For scope 'thing', `transform.position` moves the Thing in the Place frame (the
   * frame of Thing.position) and `label` relabels it. The latest of each wins; see
   * resolveThingEditsForWorld() in src/shared/thing_tags.ts.
   */
  transform?: TransformPatch
  /** `null` is an explicit clear: the target falls back to its AI label. Absent keeps the current label. */
  label?: string | null
  category?: string
  notes?: string
  visible?: boolean
  actorId?: string
  /** Fallback object id for thing-scoped patches if correspondence changes. */
  originTargetId?: string
  /**
   * Set on the record an undo leaves: the `patchId` of the scan placement patch it undid. The record
   * is itself an ordinary scan patch carrying the matrix the scan had before the undone one, so every
   * reader that replays the log in order (applyPatchToWorld, the editor) lands on the same placement
   * without knowing about this field. liveScanPlacementPatches() in ./scan-placement.ts is the one
   * reader that does: it is how a second undo steps back past the first.
   */
  revertsPatchId?: string
  /** Set only on a scan patch a person applied from a place-register proposal. */
  provenance?: EditPatchProvenance
  createdAt: string
}

/**
 * What set a scan's `localToWorld`, last time the server placed it.
 *
 * - `'place-frame'`: the scan's calibration put it in the Place frame, and no georeference moves it from there.
 * - `'georeference'`: the Place frame, carried onto the map by the Place's `georeference`.
 * - `'gps-compass'`: an uncalibrated scan, placed from its phone's GPS fix and compass heading. Approximate.
 * - `'grid'`: nothing usable to place it by: it stands on the default grid.
 */
export type ScanPlacementSource = 'place-frame' | 'georeference' | 'gps-compass' | 'grid'

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
  /**
   * The placement this scan started with, before any manual move: the calibration its upload carried
   * (a usable `projectTransform`) when it has one, even if the row was placed elsewhere, and otherwise
   * where GPS or the grid first put it. Written once and never overwritten, so a bad move can always
   * be taken back to it ("Reset to calibrated" is an ordinary scan patch carrying it). Absent on a
   * scan that was moved before this field existed and whose first placement is not stored anywhere;
   * the editor then offers no reset. Stored with -0 written as 0, so the copy in the world file and
   * the one in memory are the same bits.
   */
  calibratedLocalToWorld?: number[]
  /**
   * Why the upload's `projectTransform` was not used, in plain words, when it was not. The scan was
   * still stored and is placed by GPS or the grid, and its calibration summary reads 'uncalibrated'
   * (server/world/patch_validate.ts). Absent when nothing was wrong.
   */
  projectTransformRejected?: string
  accuracyM: number | null
  geoDistanceM: number | null
  geoOutlier?: boolean
  /** Already written into the upload sidecar (src/export/gltf.ts) but not
   *  previously surfaced back out — lets the editor know whether this scan's
   *  local origin is a real marked physical point worth rendering an anchor for. */
  calibrationMethod?: ScanCalibration['method']
  calibrationStatus?: ScanCalibration['status']
  /**
   * The unit this scan's AR session ran in; see `ScanCalibration['scaleMode']`. Absent when the sidecar
   * names none: a scan uploaded before units were recorded, or one the scanner never calibrated.
   */
  scaleMode?: ScaleMode
  scaleKind?: ScaleKind
  /**
   * This scan's own measured landmark→marker separation, metres, on the
   * `'two-point-ground'` tier. Null on the one-point tier and on anything
   * uncalibrated.
   *
   * Surfaced so the World Editor can draw where this scan *actually* put its
   * heading marker against where the Place's stored frame says it should be.
   * The two differ by the residual, and seeing that gap at room scale is more
   * legible than reading a centimetre figure — across several scans the spread
   * of actual markers around the stored one *is* the repeatability that
   * ticket 0006 measures.
   */
  calibrationSeparationM?: number | null
  /**
   * What the scan's own calibration measured against, in metres, as its sidecar's nested
   * `calibration` record holds it (`calibrationFromMeta` in server/calibration_fields.ts).
   * On the two-point tier it is the re-measured separation minus the Place's stored one:
   * 0 on a Place's first calibration, where nothing was compared. The known-distance tier has a
   * residual of its own (a fit's disagreement), but no sidecar names that tier in the flat summary
   * the tier is read from, so it does not arrive here today. Null on the one-point tier and when
   * the sidecar lacks it.
   */
  calibrationResidualM?: number | null
  /** The tolerance that residual was judged against, in metres. Null when the sidecar lacks it. */
  calibrationToleranceM?: number | null
  /** ISO time of the scan's calibration. Null when the sidecar lacks it. */
  calibratedAt?: string | null
  /**
   * The Place frame generation the scan was calibrated against: `ScanCalibration.frameId` from the sidecar's
   * calibration record (`calibrationFromMeta` in server/calibration_fields.ts), on the two-point tier. The
   * editor will compare it with the Place frame's `frameId` to tell scans of the current reference from scans of
   * an earlier one (WP-08). Absent when the record has none: a scan calibrated before frame ids existed (an
   * unknown generation, which reads as neutral, never as another), a one-point scan, an uncalibrated one.
   *
   * This and the four fields below are never `null`: when the sidecar has no value the server's manifest builder
   * leaves the key `undefined` (`calibrationEvidenceFromMeta`), which is no key in the JSON the editor receives
   * and none in the world file, so a manifest from an older sidecar reads as it always did. The key is there,
   * and not left off, because the world refresh lays the manifest over the row it stored: an absent key would
   * leave a value the sidecar no longer gives (a record the `splat-align` job replaced) standing on the row.
   */
  calibrationFrameId?: string
  /**
   * `true` when the scan is a two-point one that is in no Place frame (`ScanCalibration.outsidePlaceFrame`, from the sidecar's
   * calibration record by `calibrationFromMeta`): its commit wrote no Place frame and was not matched to the one the Place holds, as a
   * commit with a bypassed floor check does on a first visit, over a mismatch, or when improving the reference. It is placed by its own
   * pair alone and names no generation. Absent otherwise (never `false`): every other scan, and every scan from before the key existed.
   * It is not a generation that cannot be named: `calibrationFrameId` absent says "in the frame, which one is not known", and this
   * says "in none". Nobody reads it by itself: `isInPlaceFrame` (src/world/frame-generations.ts) is the one predicate the server's
   * counts, Thing matching and the editor's chip (`frameChipFor`, src/viewer/frame-banner.ts) all ask.
   */
  calibrationOutsidePlaceFrame?: true
  /**
   * Which check the scan's `calibrationStatus` rests on (`ScanCalibration.checkedBy`): `'constellation'`
   * when three or more points were compared with the Place's stored ones and a fit of them backs it,
   * `'separation'` when only the distance between two was. Absent when the record does not say, or says
   * `'constellation'` with no fit of three or more points behind it. The scan list's chip will read it to say
   * what was and was not checked.
   */
  calibrationCheckedBy?: CheckedBy
  /**
   * What the scan's fit of its points to the Place's stored ones measured (`ScanCalibration.fit`): how many
   * points it used, and their root-mean-square and largest horizontal disagreement in metres. Absent when the
   * record has no fit, which includes every two-point visit that compared only the separation, and when its
   * `pointsUsed` is under three: a fit of fewer points is exact and measures nothing, and none of its figures
   * is shown. Whether the disagreement is within what the check allows is `calibrationStatus`'s to say, not
   * these numbers'.
   */
  calibrationFitPointsUsed?: number
  calibrationFitRmsM?: number
  calibrationFitMaxM?: number
  /**
   * How `localToWorld` was last set: see {@link ScanPlacementSource}. The server's placement step will write it
   * (WP-11) and the scan list will read it, to show it beside `placementUncertaintyM`. Absent on a manifest
   * built before placements were recorded, which does not mean the scan was placed one way or another.
   */
  placementSource?: ScanPlacementSource
  /**
   * How far from where `localToWorld` puts it the scan may be on Earth, in metres (R68), when the placement
   * can say. Null or absent when it cannot: a scan placed in the Place frame with no georeference has no
   * position on Earth to be uncertain about, and one on the grid has no estimate. The server's placement step
   * will write it (WP-11) and the scan list will read it.
   */
  placementUncertaintyM?: number | null
  /**
   * True when the Place's georeference has changed since this scan was placed and the scan was not placed again
   * because a person had moved it by hand: its position on Earth is from an older georeference and the scan does
   * not move. The scan refresh will write it when `Project.georefVersion` changes (WP-11) and the scan list will
   * read it. Absent otherwise.
   */
  placementStale?: boolean
  /**
   * The session-space floor height, in metres, this scan's origin sat on — the
   * `groundY` of its `ScanCalibration`, surfaced alongside the separation so a
   * consumer can place the origin decal without reading the sidecar. Null for
   * scans that predate the field or carry no calibration.
   *
   * A flat projection of the nested `ScanCalibration.groundY`, derived by the
   * server the same way `calibrationSeparationM` is. The client never writes
   * this field: the nested record is canonical.
   */
  calibrationGroundY?: number | null
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
  SplatAlignManifest,
  SplatTrainManifest,
  SplatDetectManifest,
  PanopticScanManifest,
  PanopticLiftManifest,
  SplatFinishManifest,
  SplatFinishSizes,
} from './manifests.ts'
