> **Type:** Frontend (schema)
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `feat/two-point-frame-schema`
> **Commit style:** `feat(world): summary`
> **Design:** this ticket is the spec. Informed by the two-point calibration pattern used by
> BIM/AR field tools (see Open questions for the reference and what was taken from it).
> **Dependencies:** None (schema only). Ticket 0004 is the producer/consumer.

## Goal

Add a `'two-point-ground'` calibration method to `ProjectSpatialFrame`/`ScanCalibration`:
an established ground plane, a **landmark** placed on it (the origin — the permanent spot in
the room), and a **heading marker** placed on the same plane, which together define the
project frame's origin, heading, and floor level. Records the landmark→marker separation for
cross-session verification. Keeps #141's `'ground-tap-compass'` as an explicitly-degraded
fallback rather than replacing it.

## Why two points

Two points fix two separate problems that one point plus a compass cannot.

**1. Heading stops depending on the magnetometer.** Today
`anchorToProjectTransform(tapPos, bearingDeg)` takes its entire rotation from the compass, via
`composeYUpTransform`'s `const yaw = ((bearingDeg ?? 0) * DEG_TO_RAD)` (`src/world/geo.ts:61`).
Two consequences, both live today:

- Indoor magnetometer readings are unreliable near steel, wiring, and speakers — the usual
  case for the rooms this app scans. A bearing error rotates the entire scan about the anchor.
- **`bearingDeg: null` silently yields yaw 0.** No compass fix means the frame inherits
  whatever arbitrary heading the AR session happened to boot with. Two such sessions of the
  same room are rotationally misaligned by an unknown amount, with nothing in the data
  recording that it happened. The frame is stored as valid.

With two points, heading is `atan2` of the landmark→marker vector — derived from the same SLAM tracking
that already places the points, needing no magnetometer and degrading no worse than tracking
itself.

**2. Verification stops being circular.** Ticket 0001 removes the false `'verified'` status
because a single anchor is project-space `(0,0,0)` by construction and therefore always
agrees with itself. Two points restore a genuine invariant: **the physical distance between
landmark and heading marker is a property of the room, not of the frame.** A later session
that places both on the same two features must reproduce it. A mismatch proves the wrong
features were used — the same check the retired 3-point system performed with
`referenceDistancesM`, at one third the taps.

**3. The floor becomes shared.** Because the ground plane is established *before* either
marker (ticket 0003) and both markers are projected onto it, project-space `y = 0` is the
room's floor — not "wherever the first tap happened to land". Today a tap on a tabletop puts
the frame's zero plane 0.75 m up, and a later session that taps the actual floor is
vertically offset from it with nothing recording the discrepancy. Establishing the plane
first fixes the third alignment axis, which one point plus a compass never addressed at all.

The compass keeps a real but narrower job: absolute orientation to true north for
GPS/world placement, which two points cannot supply (they give a consistent frame, not an
absolute one). See Open questions.

## Non-goals

- Do not remove `'ground-tap-compass'`. Unlike the pre-#141 3-point method — removed because
  nothing had persisted it — #141 has been merged and may have written real frames. It also
  remains a legitimate fallback when a second point is impractical. Keep it readable and
  writable, marked as the lower-accuracy tier.
- Do not add a third method or a general N-point scheme. Two tiers, one shared consumer.
- Do not store the two points' AR-session-local positions. They are meaningless outside the
  session that captured them (see Schema required).
- Do not add capture UI, yaw math, or residual computation here — this ticket defines the
  shape only. Ticket 0004 implements them.
- Do not change `anchorToProjectTransform()` — ticket 0004 adds a sibling for the two-point
  case rather than overloading it.
- Do not add landmark/verification-point fields. This supersedes the landmark design an
  earlier draft of this wave proposed: landmarks existed only to work around the circularity
  that a second constitutive point removes outright.

## Pinned conventions

**ADR 0005** — `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md`
governs this wave: a frame's orientation comes from tracked geometry, the compass is metadata
for absolute orientation only, and a `'verified'` status must be backed by a measurement.

**ADR 0001** — touches schema. Searched before adding: `ProjectSpatialFrame` /
`ScanCalibration` (`src/world/types.ts:111-131`, as #141 left them) are the Place-level and
session-level calibration records and the correct home; this extends them with a second
`method` member rather than adding a parallel type. Rejected: `WorldProject.originGeoPose`/
`localFrame` (GPS-based, different container); `Thing`/`ThingObservation` (the "things" half
of the model — a calibration reference is not a detected object); any new top-level anchor
type.

**Discriminated union on `method`.** `ProjectSpatialFrame` and `ScanCalibration` become
unions rather than single interfaces with optional fields, so a reader cannot access
`separationM` on a one-point frame without narrowing. Verified by grep this session: nothing
does `interface X extends ProjectSpatialFrame`/`ScanCalibration`, so converting `interface` →
`type` breaks no consumer.

**Reuse `Vec3`** (`src/world/types.ts:157-161`) for positions.

**Field naming**: metre-valued fields carry the existing `M` suffix (`separationM`, matching
`toleranceM`/`referenceDistancesM` from the retired method and `accuracyM`/`geoDistanceM` on
`ScanManifest`); degree-valued fields carry `Deg` (`headingDeg`, matching #141's
`anchorBearingDeg`).

**`version` stays `1`.** The envelope is unchanged; `method` is the discriminant that carries
shape. A `version` bump is for a genuinely breaking envelope change.

## Before implementation

- `src/world/types.ts:107-131` — the two types as #141 left them.
- `src/world/geo.ts:60-98` — `composeYUpTransform` and `anchorToProjectTransform`, including
  the `bearingDeg ?? 0` line that motivates this ticket.
- `src/ar/project-calibration.ts`'s `ScanCalibration`/`ProjectSpatialFrame` construction — the only existing producer, which must keep
  compiling.
- `src/export/gltf.ts:427-432` — the sidecar keys that read `calibration.*` generically.
- `docs/adr/0001-reuse-existing-domain-model.md`.

## Open questions & answers

- Q: What exactly was taken from the cited two-point reference? — A: The core idea (two
  real-world points aligned to define a frame, presented as the accurate method when image
  targets are unavailable), the separate environment-scan/plane-detection step before
  alignment (ticket 0003), and adjust-before-commit on each point (ticket 0004). Not taken:
  its "pick 2 points on a Map/BIM model first" step — that presumes an existing model to pick
  against, which this app does not have on a first calibration. Here the first visit *defines*
  the reference from physical points; later visits reproduce it. (Decided in this ticket.)
- Q: If two points give heading, is the compass still needed? — A: Yes, for a different job.
  Two points give a frame that is *self-consistent across sessions* but arbitrary relative to
  the world — nothing in the landmark→marker direction says which way is north. True north is still needed to place a
  scan on a map or into the ENU world frame (`composeYUpTransform` is already used for exactly
  that on the GPS path, root `main.ts`'s `scanManifestFromStored`). So `'two-point-ground'`
  records `anchorBearingDeg` too, as *metadata* — informative, not load-bearing for the
  frame. This is the key separation: **geometry for relative alignment, compass for absolute
  orientation.** (Decided in this ticket.)
- Q: Store both points, or one point plus heading and distance? — A: Both points, in project
  space. `landmark` is `(0,0,0)` by construction and thus redundant, but storing the pair
  explicitly keeps the record self-describing and lets ticket 0004 render both without
  re-deriving one from `headingDeg` + `separationM` (a derivation that would silently encode
  the yaw convention in a second place). Redundancy here buys clarity at negligible cost.
  (Decided in this ticket.)
- Q: Does `ScanCalibration` need `residualM`/`toleranceM` back? — A: Yes, for the two-point
  member only — they now measure something real (the re-measured separation vs stored `separationM`). They stay
  absent from the `'ground-tap-compass'` member, where nothing can be measured. This is the
  clearest possible statement that verification is available in one tier and not the other.
  (Decided in this ticket.)
- Q: Default tolerance? — A: `DEFAULT_SEPARATION_TOLERANCE_M = 0.15` (15 cm) as a **placeholder
  pending measurement**, pinned here so ticket 0004 does not invent one. Reasoning for the
  starting value: tighter than the retired 3-point method's one-foot (0.3048 m) default,
  because a single distance between two deliberately-chosen features is a cleaner measurement
  than three interdependent ones. But it is a guess, and the only empirical spatial-repeatability
  figure currently in the repo — `DEDUP_RADIUS_M = 0.4` (`src/spatial/resolver.ts:27`), widened
  from 0.3 because same-object captures land "0.3-0.4 m apart" — is more than twice this
  number. That figure measures detection placement rather than a direct floor tap, so it is an
  upper bound, not a refutation; but it is close enough to warrant measuring before shipping.
  **Ticket 0006 measures the real cross-session spread and sets this value.** If the measured
  spread exceeds the tolerance, the check fires on correct calibrations. (Decided in this
  ticket; value pending 0006.)
- Q: Minimum separation between the two points? — A: `MIN_POINT_SEPARATION_M = 1.0`, enforced
  by ticket 0004's capture UI, not the type. Rationale: heading error is roughly hit-test
  noise divided by separation, so short baselines amplify angular error — two points 20 cm
  apart with ~3 cm noise give ~8° of heading uncertainty, which is worse than a decent
  compass. One metre keeps it near 2°. The retired 3-point method used a comparable
  `MIN_REFERENCE_DISTANCE_M = 0.75`. **Note the ~3 cm noise figure is itself assumed** — if
  ticket 0006 measures materially worse hit-test repeatability, this minimum must rise
  proportionally to hold the same angular error. (Decided in this ticket; noise figure pending
  0006.)
- Q: Should the frame carry reference photos of the two marker setups, to help a returning user
  re-place on the same physical spots? — A: Yes — **ticket 0007** adds an optional
  `referencePhotos` field to this member. Specified separately rather than here because it needs
  its own storage path (an IndexedDB blob store plus an upload route), not a plain field, and
  because the frame must remain valid without it. This member's shape is unchanged by that
  ticket apart from the one optional addition. (Decided in this ticket.)

## Files impacted

Changed:
- `src/world/types.ts`

## Schema required

Both types become discriminated unions on `method`:

```ts
/**
 * A Place's durable alignment reference.
 *
 * 'two-point-ground' is the preferred, higher-accuracy tier. An established
 * ground plane fixes the floor (project-space y = 0), a landmark on it fixes
 * the origin, and a second marker on the same plane fixes the heading
 * geometrically — so orientation does not depend on an indoor magnetometer
 * reading, and the recorded separation gives later sessions something real to
 * verify against.
 *
 * 'ground-tap-compass' (from #141) is the single-point fallback for when a
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
      /** Max acceptable deviation from separationM on a later visit. Default 0.15. */
      toleranceM: number
      /**
       * Compass bearing at capture. Records which way project-space north is,
       * for GPS/world placement only — NOT used to build the frame (that comes
       * from the landmark→marker geometry). Null when unavailable, which costs
       * absolute orientation but leaves the frame fully determined.
       */
      anchorBearingDeg: number | null
      /** Optional human descriptions of the two physical features, e.g. "north door frame". */
      pointLabels?: [string, string]
    }
  | {
      method: 'ground-tap-compass'
      /** Load-bearing for this method: the frame's entire heading. Null means the frame sits at the session's arbitrary yaw. */
      anchorBearingDeg: number | null
    }
)

export type ScanCalibration = {
  /** Maps this AR session's local coordinates into project space. */
  sessionToProject: number[]
  calibratedAt: string
  status: 'verified' | 'provisional' | 'uncalibrated'
} & (
  | {
      method: 'two-point-ground'
      separationM: number
      /** the re-measured separation − stored separationM, in metres. 0 on the first calibration. */
      residualM: number
      toleranceM: number
      anchorBearingDeg: number | null
    }
  | {
      method: 'ground-tap-compass'
      anchorBearingDeg: number | null
    }
)
```

## Definition of Done

- [ ] Both types converted to discriminated unions exactly as above, with the doc comments
- [ ] `'ground-tap-compass'` retained with its existing fields, and its degradation documented
- [ ] `version` left at `1`
- [ ] `DEFAULT_SEPARATION_TOLERANCE_M` and `MIN_POINT_SEPARATION_M` exported as named
      constants from `src/world/types.ts` (or a sibling module if that file is
      types-only by convention — check before adding, and say which in the PR)
- [ ] Any existing site that reads a now-narrowed field without checking `method` is fixed by
      narrowing, not by widening the type back
- [ ] `npx tsc --noEmit` and `deno task check` pass

## Tests

- [ ] No behavioral test — type change; the type-check is the verification
- [ ] `npx tsc --noEmit` fails *before* the existing producer
      (`src/ar/project-calibration.ts`'s `ScanCalibration`/`ProjectSpatialFrame` construction) is narrowed, and passes after — proving the
      union actually forces narrowing rather than silently permitting field access
- [ ] A `'two-point-ground'` literal with all required fields type-checks; one missing
      `separationM` does not
- [ ] A `'ground-tap-compass'` literal still type-checks unchanged from #141

```bash
npx tsc --noEmit
deno task check
```

## Acceptance Criteria

- [ ] Given #141's existing `spatialFrame`/`calibration` construction, When narrowed on
      `method`, Then it compiles unchanged in behavior
- [ ] Given a `'two-point-ground'` record, Then `separationM`/`toleranceM`/`residualM` are
      required and reachable only after narrowing
- [ ] Given a `'ground-tap-compass'` record, Then no verification field is reachable at all —
      the type makes "this tier cannot be verified" unstateable rather than merely undocumented
- [ ] Given a frame persisted by #141 (no `landmark`/`headingMarker`), When read, Then it deserializes
      as the `'ground-tap-compass'` member with no migration

## Risks / potential issues

- **Risk:** Two supported methods is the shape ADR 0001 warns about, and could drift into two
  parallel calibration systems. — **Mitigation:** they are two accuracy tiers of one concept
  behind one discriminant, with one producer (ticket 0004) and one consumer path
  (`sessionToProject` → sidecar → `scanManifestFromStored`). The ADR's target is *unrelated*
  duplicates, not a documented fallback tier. Stated here so a reviewer can hold this ticket
  to it.
- **Risk:** `landmark` is stored redundantly (always `(0,0,0)`) and could drift from that
  invariant if a future producer forgets. — **Mitigation:** ticket 0005's test asserts
  `landmark` is the zero vector for any generated two-point frame.
- **Risk:** `interface` → `type` alters two types re-exported across client and server
  (`src/world/types.ts` is the documented cross-runtime import point). — **Mitigation:**
  `npx tsc --noEmit` and `deno task check` both gate Definition of Done; the grep for
  `extends` came back clean this session.
- **Risk:** Keeping `anchorBearingDeg` on both members invites the assumption it means the
  same thing in each — load-bearing in one tier, metadata in the other. — **Mitigation:** the
  per-member doc comments say so explicitly; ticket 0004 must not read it when building a
  two-point frame.

## Subtasks

1. [ ] Convert `ProjectSpatialFrame` to the union above
2. [ ] Convert `ScanCalibration` to the union above
3. [ ] Add the two named constants
4. [ ] Run `npx tsc --noEmit`; confirm it fails only at the existing producer
5. [ ] Narrow that producer on `method` (no behavior change — it still writes
       `'ground-tap-compass'` until ticket 0004 lands)
6. [ ] `npx tsc --noEmit` and `deno task check` clean
