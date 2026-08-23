# 0005. Spatial frames are established by geometry and verified by measurement

- **Status:** Proposed
- **Date:** 2026-08-23
- **Related:** `docs/factory/09-ground-anchor-calibration/` (the wave implementing this),
  PRs #141 and #142 (the behaviour this revises), ADR 0001 (the reuse rule this follows)

## Context

A Place's *spatial frame* is the transform that maps one AR session's arbitrary local
coordinates into a stable per-Place frame (`ScanCalibration.sessionToProject`). It is what
makes two scans of the same room line up, and the server prefers it over GPS placement when
present — `scanManifestFromStored()` in root `main.ts` computes
`localToWorld = matrixFromMeta(projectTransform) ?? composeYUpTransform(…geo…)`, with the
inline note that it "takes precedence over metre-scale-inaccurate GPS/compass."

Three successive designs have now defined how that frame is captured, and the differences
between them are the reason this ADR exists.

**1. Three-point reference triangle** (pre-#141). The user tapped three physical points. The
frame came from a Gram-Schmidt basis over them, and repeat visits re-tapped the same three
points and compared pairwise distances against a stored `referenceDistancesM` within a
`toleranceM`. Verification was real: `'verified'` was only reachable by passing that check.
The cost was three taps and a degenerate-triangle failure mode.

**2. One ground tap plus compass** (#141). The user taps once; the tapped point becomes the
origin and the compass bearing supplies the entire rotation. This is a large usability win and
the interaction is right. But it introduced two problems that were not visible as problems:

- **Orientation became a magnetometer reading.** `composeYUpTransform`'s
  `const yaw = ((bearingDeg ?? 0) * DEG_TO_RAD)` is the frame's only rotation input. Indoor
  magnetometers are unreliable near steel, wiring, and speakers — the normal condition for the
  rooms this app scans. Worse, `bearingDeg: null` silently yields yaw 0, so a session with no
  compass fix inherits whatever heading AR tracking happened to boot with. Two such sessions of
  one room are rotationally misaligned by an unknown amount, and the frame is stored as valid.
- **Verification became impossible, but the word stayed.** A single anchor maps to project-space
  `(0,0,0)` by construction, so it always agrees with itself — there is nothing to compare. #141
  correctly dropped `residualM`/`toleranceM`, but kept `status`, now assigned
  `existingFrame ? 'verified' : 'provisional'`. That reports whether a *record existed*, not
  whether anything matched. The user-facing string on that path reads "Project aligned to the
  existing anchor" while nothing aligned it to the existing anchor.

**3. Two ground markers** (this ADR). A landmark and a heading marker, both on an established
ground plane. Heading comes from the vector between them; the distance between them is a
property of the room that a later session must reproduce.

The pattern in the failure is worth naming: the second design lost a *capability* (verification)
and kept its *vocabulary*. Nothing in the type system or the tests noticed, because
`'verified'` is a string and there were no tests. This repo has a wave named
`04-capture-path-truthfulness` about exactly this class of defect — a claim the product cannot
honour — which is what makes it worth a standing rule rather than a one-off fix.

## Decision

**1. A spatial frame's orientation is derived from tracked geometry, not from the compass.**
Two ground markers define origin and heading. The compass is recorded as metadata
(`anchorBearingDeg`) describing which way true north lies, for GPS/world placement — it is
never an input to `sessionToProject`.

The separation is: **geometry for relative alignment, compass for absolute orientation.** Two
markers give a frame that is self-consistent across sessions but says nothing about north; the
compass gives north but not metre-scale precision. Each is used only for the job it can do.

**2. The ground plane is established before any marker is placed, and both markers are
projected onto it.** This makes project-space `y = 0` the room's floor rather than wherever the
first tap landed, and guarantees a horizontal baseline so hit-test noise in `y` cannot tilt the
frame.

**3. A status value that claims verification must be backed by a measurement.** If a method
cannot measure agreement with a previously stored frame, it does not get to report `'verified'`
— it reports `'provisional'`, and its type does not carry residual/tolerance fields at all.
Concretely, the two calibration methods are a discriminated union on `method`, and only the
two-point member has `residualM`/`toleranceM`, so "this tier cannot be verified" is unstateable
rather than merely undocumented.

**4. Lower-accuracy fallbacks are permitted, but must be explicitly tiered.** The one-point
method survives for cases where a second marker is impractical. It is labelled lower-accuracy
in the UI, carries no verification fields, and is never the default. Two tiers of one concept
behind one discriminant is not the parallel-systems duplication ADR 0001 forbids — but a third
mechanism, or an untiered second one, would be.

**5. Tolerance constants are measured, not chosen.** Any threshold governing whether two
spatial observations "match" must cite a measurement. Wave 09's ticket 0006 establishes the
procedure (a taped floor marker, five independent sessions, recorded spread); its output sets
`DEFAULT_SEPARATION_TOLERANCE_M`, `GROUND_TAP_TOLERANCE_M`, and `MIN_POINT_SEPARATION_M`. A
tolerance set below the real repeatability floor makes every correct repeat visit report a
false mismatch, which is worse than no check at all.

## Consequences

**Easier.** Orientation stops depending on the least reliable sensor on the device, and the
`bearingDeg ?? 0` silent-misalignment path becomes unreachable on the primary method. Repeat
visits get a real residual again — the capability the three-point system had and #141 lost —
at two taps instead of three. `y = 0` becomes a shared floor across every calibrated scan of a
Place, an alignment axis no previous design fixed. The existing sidecar keys
`calibrationResidualM`/`calibrationToleranceM` (`src/export/gltf.ts`), which have been writing
`null` since #141 removed the fields they read, carry real values again with no export-path
change.

**Harder.** Two markers is more work than one, on a flow that runs before every scan; the
fallback tier exists so that cost is opt-out rather than imposed. Every consumer of
`ProjectSpatialFrame`/`ScanCalibration` must now narrow on `method` before reading
method-specific fields — deliberate friction, and the compile error is the point. And rule 5
means a tolerance cannot be shipped on intuition, which front-loads device time before the
feature that depends on it can land.

**What this does not solve.** `separationM` proves two markers were the right distance apart,
not that they were the *same* two features — two door frames 2 m apart elsewhere in the room
pass. Genuine identity needs image targets or VPS relocalization (8th Wall's Wayspot Anchors
ship unused inside `public/xr.js`/`public/xr-slam.js`; WebXR's native anchors API is likewise
uncalled). Both are deferred in wave 09 and remain the obvious next tier above this one — which
is why the two-point pattern this borrows from is described by its own vendors as the method to
use *when image targets are unavailable*.

**Applicability beyond calibration.** Rules 3 and 5 are not spatial-specific. Any field that
reports a quality, confidence, or verification verdict — `ScanQualitySummary.status`,
`geoOutlier`, future correspondence confidences — is subject to the same standard: if nothing
measured it, do not name it as though something did. That is the same principle
`04-capture-path-truthfulness` was created to enforce, generalised.
