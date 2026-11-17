# 12-origin-calibration-v1

Makes the calibrated origin one thing the scanner shows and records: a crosshair and heading arrow
on the ground with a north tick, the floor it stands on kept for the whole scan, and the origin's
ground height written with the scan.

## What wave 09 already shipped

The two-point ground frame this wave builds on is in place. Wave 09 shipped the staged calibration
flow (ground, landmark, heading point), the frame persisted on `Project.spatialFrame`, one
`ScanCalibration` per scan, the floor gate, and reference photos for return visits. ADR 0005 governs
the frame: geometry fixes the relative alignment, and the compass only sets the absolute orientation
shown on the decal. The origin math lives in `src/world/geo.ts`.

The brief for this wave described the origin as not yet persistent. That was out of date. What wave 09
left open, and what this wave closes, is below.

## What this wave changes

| # | Title | Type | Depends on |
| --- | --- | --- | --- |
| [0001](0001-origin-decal-and-persisted-ground-height.md) | One origin decal (crosshair, heading arrow, north tick); the floor stays up for the scan; `groundY` recorded on the scan | Frontend + schema | 09 (0002, 0004, 0007) |

## Not in this wave

- **Automatic alignment on scan start.** A return visit still re-places the two points. The session
  frame does not exist until the user does that, so the stored origin cannot be drawn earlier. Doing
  it earlier needs relocalisation (VPS or image targets), which wave 09 found and deferred.
- **A single-tap, user-set heading tier.** It would be cheaper to place, but a heading the user sets
  cannot be verified across sessions, and ADR 0005 requires verification before a frame may be called
  verified. The compass-only `'ground-tap-compass'` tier stays as the labelled fallback.
- **The editor's anchor UI.** The Spatial Editor session owns it. `buildAnchorMarker` is unchanged,
  because the viewer and the editor draw it.
- **Native ARKit and ARCore anchors.** The native session owns `src/ar/native.ts` and the iOS and
  Android plugins.
- **Provider changes.** Both runtimes already feed the point cloud that estimates the floor (8th Wall
  feature points, WebXR hit-test samples), and the cloud keeps running through the scan. Neither
  `src/ar/eighthwall.ts` nor `src/ar/webxr.ts` changed.

## Device status

The mock suite proves the decal's parts are in the scene. Whether it sits on the floor, whether the
grid reads at room scale, and whether the north tick agrees with a compass are device questions. They
are DEVICE_TESTING Checklist A § A-origin (O1 to O10), with the same checks on B2 for WebXR.

## Atlas

The diff blocks for this wave are in the Project calibration card, its `ScanCalibration` row, and the
wave 09 stored-pair diff, which this wave supersedes. The atlas points at this folder; it does not
restate the ticket.
