# Companion Scan Place-First Product Design

**Status:** current product contract. This document supersedes product-facing
uses of "world" as the top-level noun. `WorldProject` remains the compatible
internal scene and ENU-frame record until a storage migration is explicitly
scheduled.

## Product Promise

Companion Scan lets a person build a private, trustworthy spatial record of a
real place. They can capture it with AR, upload existing media, and return to a
desktop editor to inspect, align, process, share, and understand it over time.

The three primary entry points are intentionally equal:

1. **Scan a Place** opens the 8th Wall or WebXR scanner for a new AR capture.
2. **Upload Content from a Place** accepts photos, video, and other media from
   phone or desktop, then follows the same place-selection flow.
3. **Place Scan Editor** opens the existing place workspace at `/editor`.

Capture and upload never need to understand reconstruction tooling. The editor
is where a user decides how much processing to run and reviews its results.

## Canonical Vocabulary

| Term | Meaning | Durable identity |
| --- | --- | --- |
| **Place** | A site a user owns or manages: home, store, workshop, campus, or property. | `projectId` today; product alias `Place` |
| **Area** | A named part of a Place: building, floor, room, wing, zone, or outdoor region. Areas form a tree. | `areaId` |
| **Scan session** | One continuous AR capture or upload ingest event. | `sessionId` |
| **Scan segment** | A non-destructive frame/time range within a session. | planned durable record |
| **Scan** | The spatial/media output associated with a session or segment. | `scanId` |
| **Layer** | A typed, independently visible representation attached to a Scan. | layer manifest ID/type |
| **Thing** | A persistent physical object inferred from multiple observations. | `thingId` |
| **Observation** | One immutable sighting of a Thing or detection in a scan. | observation ID |

`Project` is the existing storage/API name for a Place. It is retained for
backward compatibility, not exposed as a competing user concept. Older
`Floor`/`Room` records are projected into the Area tree, so historical scans
do not need to be re-authored.

## Place Hierarchy

Places can be linked into an optional cross-Place hierarchy. A Place declares
whether it represents a **Building**, **Floor**, or **Room**. A Building only
needs its name; a Floor adds a Building name; a Room adds both a Floor and
Building name. These text values autocomplete from earlier Place and Area
names, and automatically link to a matching prior Place when one exists. For
example, `Home → Ground Floor → Living Room` is a chain of three Place projects,
each with its own scan workspace and share boundary. The server rejects
self-links, missing parents, cycles, and deletion of a Place that still has
linked children.

This does not replace the Area tree inside a Place. Use the Place hierarchy to
connect independently managed project workspaces; use Areas to break one Place
into scan regions such as a wing, floor, room, or outdoor zone.

## Capture And Upload

1. The user chooses **Scan a Place** or **Upload Content from a Place**.
2. The next screen opens the Place picker; it is not a separate control on the
   landing screen.
3. GPS and recent history suggest Places. The user always confirms or creates
   the Place because consumer GPS is not reliable enough to auto-assign rooms.
4. The user optionally chooses or creates an Area.
5. Before AR opens, calibration checks that this device session can align to
   the Place frame. Upload follows equivalent post-ingest alignment.
6. Raw media, poses, hit points, and quality data are retained before inference
   or reconstruction begins.
7. The user can return to the editor immediately. Processing is asynchronous,
   additive, and never overwrites capture source material.

## Spatial Alignment Contract

Each Place has one metric local coordinate system: **ENU, Y-up, meters**. It is
anchored to a geographic pose when one is available, but indoor accuracy comes
from calibrated local references, not GPS.

- GPS, altitude, and compass provide a global suggestion and map anchor.
- A repeatable in-place calibration uses measured raycast reference points to
  calculate `sessionToProject` and a residual error.
- The UI shows calibration state: verified, provisional, or uncalibrated. It
  never implies one-foot precision when the residual does not support it.
- A user can refine a scan transform in the editor and save the correction as
  an append-only patch.
- Alignment jobs may refine a scan after capture, but retain raw AR pose and
  user transform as separate provenance.

The target for repeat captures is less than one foot (0.305 m) relative error
inside a calibrated Area. This is an acceptance target, not a promise based on
GPS alone.

## Editor Information Architecture

The editor route is `/editor`, branded **Companion Scan Spatial Editor**.

### Top Bar

- Compact two-line **Companion / Scan** wordmark.
- Connected Companion Intelligence portal account entry point.
- Current Place name, scan count, layer count, and active/total job indicator.
- **Share** menu with View only, Comment, Edit, Scanner, and owner recovery
  links. Capability links are scoped to the current Place workspace.
- **Views** menu: GIS map, hit points, ground planes, scanned objects, camera
  trail, image frustums, scanned images, ground grid, and Thing tags. Every
  visibility control is independent and reflects the current scene.
- Measure and live controls remain direct because they affect the active view.

### Left Drawer

The left drawer owns navigation, not long processing forms. Its compact tabs
are Project, Scans, Things, Layers, Places, and Edit.

- **Project** sets the Place type and its optional Building/Floor context.
- **Scans** lists scans in the active Place and contains one bounded date range
  control with start and end handles.
- **Things** groups identified objects across the visible scan range and opens
  the source scan when an item is selected.
- **Layers** presents visibility and source data controls near the scene.
- **Places** lists Places and their Area hierarchy, with assignment and
  creation actions.
- **Edit** contains selection-specific transform, annotation, and segmentation
  controls.

Both drawers are user-resizable and have chevron reopen tabs when collapsed.

### Main View

The viewport renders only the current Place workspace. The map is a separate
GIS overlay used to choose Places; it renders above the 3D canvas, never under
tags or geometry. A geographic map is a 1:1 map projection tied to the Place
ENU origin, not a fake room-size texture placed under the scan.

### Right Drawer

The right drawer follows four outcomes for the selected Scan:

1. **Prepare** indexes media, extracts layers, and checks alignment.
2. **Understand** runs semantic analysis and Thing correspondence.
3. **Reconstruct** produces a dense reconstruction and/or Gaussian splat from
   posed keyframes.
4. **Publish** syncs Place and Thing context to Companion Memory and prepares
   an export.

An advanced queue remains available for experts, but is subordinate to this
guided flow. The drawer also shows identified Things. With a selected Scan it
filters to that scan; without one it shows the whole Place, with scan, Area, and
ENU provenance.

## Layer Contract

Layers are source-preserving and individually toggleable.

| Layer | Purpose |
| --- | --- |
| Camera trail | Ordered camera poses through a session. |
| Image frustums | Pyramids showing where captured images were taken. |
| Scanned images | RGB thumbnails/textures associated with posed keyframes. |
| Hit points | Raw or filtered SLAM/depth observations. |
| Ground planes | Detected floors and other planar surfaces. |
| Scanned objects | Source mesh or object geometry. |
| Things and tags | Detections, persistent Things, labels, and optional bounds. |
| Semantic masks | Per-pixel/panoptic outputs linked to source frames. |
| Reconstruction | Dense mesh/point cloud, Gaussian splat, and related sidecars. |

The current manifest types (`points`, `mesh`, `floor`, `detections`, `labels`,
`cameraPath`, `cameraFrustums`, `rgbFrames`, `depth`, `semanticMasks`, `splat`)
implement this contract. New processors add a layer or sidecar; they never
replace raw capture.

## Processing Contract

Processing is reversible and provenance-rich:

1. Validate quality, media completeness, keyframes, and camera poses.
2. Align the scan to the Place frame.
3. Extract source layers and build a usable preview.
4. Run image understanding: panoptic segmentation, depth, pose, and object
   detection through the configured local vision provider.
5. Match observations to durable Things across scans.
6. Run LingBot-Map, photogrammetry, and/or Gaussian splatting.
7. Review outputs, publish approved layers, and export when needed.

SenseNova Vision, LingBot-Map, splat tools, and the local job queue are
processors. The editor must report input requirements, produced artifacts,
error state, and next action rather than exposing worker names alone.

## Sharing, Identity, And Companion Memory

Portal OIDC identifies the human in the editor. It is distinct from the service
connection that writes Place, Scan, Thing, and Observation records to Companion
Memory.

- **Viewer:** inspect the Place without changing it.
- **Commenter:** inspect and add review notes without altering source geometry
  or processing configuration.
- **Editor:** change Areas, scan placement, annotations, and processing.
- **Scanner:** capture into the scoped Place.
- **Owner:** manage sharing and destructive operations.

Share URLs include the current Place scope and capability token. They must not
open a broad, cross-Place scene by accident. Sync records retain Place, Area,
Scan, Thing, time, global geo anchor, local ENU pose, and source artifact
provenance so CI-server can resolve them in memory and GIS views.

## Implementation Rules

- Keep `WorldProject`, `projectId`, `floors`, and `rooms` readable while
  product copy transitions to Place and Areas.
- Add `areaId` alongside existing `floorId` and `roomId`; do not delete legacy
  fields from old sidecars.
- Treat session segmentation as non-destructive ranges of original media and
  poses. A segment can be reassigned or reprocessed without duplication.
- Store raw media, keyframes, poses, calibration result, and source-model
  versions before creating derived layers.
- Resolve Things from immutable observations. A Thing may move or disappear,
  but historical observations must not be rewritten.

## Delivery Checkpoints

| Checkpoint | Product outcome | State |
| --- | --- | --- |
| Place selection | Confirm a suggested/new Place before scan or upload | implemented flow, continue field validation |
| Area model | General Area hierarchy while preserving floors/rooms | compatibility model implemented |
| Calibration | Reference-based session alignment with visible confidence | implemented baseline, needs field tolerance validation |
| Guided processing | Prepare, Understand, Reconstruct, Publish | editor implementation in progress |
| Layer visibility | Independent spatial-view toggles | implemented baseline |
| Sharing | View, comment, edit, scanner, owner links | append-only review comments are available in the editor; the server enforces the commenter role |
| CI sync | Place/Thing/Observation records with provenance | memory-push foundation exists; entity schema integration remains |

## Related Documentation

- [UX and FTUE flow](UX_FLOW.md)
- [UI manual](UI_MANUAL.md)
- [Architecture](../architecture.md)
- [Places and Things implementation wave](../factory/08-places-and-things/README.md)
