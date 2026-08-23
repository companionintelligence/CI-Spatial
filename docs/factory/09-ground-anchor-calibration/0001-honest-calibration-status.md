> **Type:** Frontend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `fix/calibration-status-truthfulness`
> **Commit style:** `fix(ar): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None — lands first, independently of every other ticket in this wave.

## Goal

Stop `ScanCalibration.status` reporting `'verified'` for a calibration that was never
verified against anything. As of #141, `status` is set from `existingFrame ? 'verified' :
'provisional'` (`src/ar/project-calibration.ts:124`) — it reports whether a
`spatialFrame` *record existed*, not whether this session's anchor agrees with it.

## The defect, precisely

Before #141, `'verified'` meant something measurable: the flow re-measured three physical
points, computed `distanceResidual()` against the stored `referenceDistancesM`, and rejected
the calibration outright if it exceeded `toleranceM`. `'verified'` was only reachable by
passing that check.

#141 removed the check (correctly — a single tapped point has no second point to diff a
residual against) but kept the word. Today:

- The user taps any ground point. That tap becomes the project origin outright
  (`anchorToProjectTransform(hit.position, bearingDeg)`, `src/world/geo.ts`).
- `existingFrame` is read but never compared to the new tap. It is used only to pick the
  status string and to decide whether to write a new `spatialFrame`.
- If the user taps a spot 3 m from where they tapped last visit, the two scans are
  misaligned by 3 m — and the second one is labelled `'verified'`.

The user-facing string is the sharper end of it: `src/main.ts:957` prints **"Project aligned
to the existing anchor."** on exactly this path. Nothing aligned it to the existing anchor.

This is the same class of defect as the `04-capture-path-truthfulness` wave: a claim the
product cannot honour. It matters more than a cosmetic label because `calibrationStatus` is
persisted into the GLB sidecar and surfaced back through `ScanManifest.calibrationStatus`
(added in #141), where `src/viewer/viewer.ts:addAnchorMarker()` uses it to decide whether a
scan's anchor is worth rendering at all.

## Non-goals

- Do not re-introduce a residual/tolerance gate. #141's reasoning is sound *for a one-point
  frame* — a single anchor cannot self-verify. Making verification genuinely possible is
  ticket 0004's job (a second calibration point, whose separation from the first is a
  room-intrinsic distance a later session must reproduce), not this ticket's.
- Do not change `anchorToProjectTransform()` or any transform math.
- Do not remove `'verified'` from the `status` union — ticket 0004 legitimately produces it
  again once a two-point separation can be measured against the stored reference. This ticket
  stops *fabricating* it, it does not delete the concept.
- Do not touch `src/viewer/viewer.ts`'s `addAnchorMarker()` gating — it renders for both
  `'verified'` and `'provisional'`, so it is unaffected by which of the two this ticket
  produces.

## Pinned conventions

**ADR 0005** — `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md`
governs this wave: a frame's orientation comes from tracked geometry, the compass is metadata
for absolute orientation only, and a `'verified'` status must be backed by a measurement.

**ADR 0001** — touches schema (`ScanCalibration.status` semantics, `src/world/types.ts:127`).
This ticket extends no type and adds no field; it changes which existing union member is
written and the copy describing it. Searched for other producers of
`ScanCalibration.status` before scoping: `src/ar/project-calibration.ts:124` is the only
write site repo-wide (`src/export/gltf.ts` reads it through to the sidecar;
`src/viewer/viewer.ts` reads `ScanManifest.calibrationStatus`). No parallel status concept
exists to reconcile with.

**Existing union, unchanged**: `'verified' | 'provisional' | 'uncalibrated'`
(`src/world/types.ts:127`). Do not add a member — see Open questions for why a new
`'unverified'` member was rejected.

**Copy convention**: the calibration overlay's existing voice is plain, second-person, and
states what happened, not what it hopes (`'No stable surface there. Aim at a textured floor
and tap again.'`). Match it.

## Before implementation

- `src/ar/project-calibration.ts:38-44, 118-132` — `existingFrame`/`isFirstCalibration` and
  the `ScanCalibration` construction that sets `status`.
- `src/main.ts:947-962` — the call site and the two status strings it prints.
- `src/world/types.ts:111-131` — `ProjectSpatialFrame`/`ScanCalibration` as #141 left them.
- `src/viewer/viewer.ts` `addAnchorMarker()` — the one consumer that branches on
  `calibrationStatus`, to confirm this change doesn't alter viewer behavior.

## Open questions & answers

- Q: Add a new `'unverified'` status member instead of reusing `'provisional'`? — A: No.
  `'provisional'` already means exactly "a frame is established but its agreement with any
  prior frame is unconfirmed", which is the true state of *every* calibration the app can
  currently produce. Adding a fourth member would widen a persisted union for no behavioral
  difference and force every reader to handle it. (Decided in this ticket.)
- Q: So `'verified'` becomes unreachable — is a union member with no producer acceptable? —
  A: Yes, deliberately and temporarily, and it should be commented as such in
  `src/world/types.ts` so the next reader doesn't assume it's live. It stays because (a)
  already-persisted scans from #141 carry it and must still deserialize, and (b) ticket 0004
  reintroduces a legitimate producer — a *measured* one, comparing the two-point separation
  against the stored `separationM`. A `'verified'` value found in stored data after this
  ticket means "written by the #141-era build", which the comment must say. (Decided in this
  ticket.)
- Q: Should already-persisted `'verified'` records be migrated/downgraded? — A: No. They are
  not wrong *records*, they were written under a since-corrected meaning, and there is no way
  to retroactively determine whether those anchors actually agreed. A migration would have to
  invent a fact. Left as-is and explained by the type comment. (Decided in this ticket.)

## Files impacted

Changed:
- `src/ar/project-calibration.ts`
- `src/main.ts`
- `src/world/types.ts` (comment only — documenting that `'verified'` has no current producer)

## Schema required

None — no field added, removed, or retyped. `ScanCalibration.status` keeps its existing
three-member union; only which member this code path writes changes, plus a doc comment:

```ts
status: 'verified' | 'provisional' | 'uncalibrated'
```
- `'provisional'` — a frame is established; its agreement with any previously recorded frame
  for this Place is unconfirmed. **Every calibration the app currently produces is this.**
- `'verified'` — no current producer; ticket 0004 restores one by measuring a two-point
  separation against the stored reference. Values present in stored data were written by the
  #141-era build, where the label did not imply an actual check.
- `'uncalibrated'` — unchanged; written by `src/export/gltf.ts`'s `?? 'uncalibrated'` fallback
  when a scan has no calibration at all.

## Definition of Done

- [ ] `src/ar/project-calibration.ts` writes `status: 'provisional'` unconditionally, with a
      comment explaining that a single-point anchor cannot self-verify
- [ ] `src/main.ts`'s post-calibration message no longer claims alignment to an existing
      anchor on the repeat-visit path; both branches state what actually happened
- [ ] The repeat-visit case still tells the user something useful and distinct from the
      first-visit case (that this Place already has an anchor, and that tapping the same
      physical spot is what keeps scans aligned) — the fix is honesty, not silence
- [ ] `src/world/types.ts` carries the status-semantics comment above
- [ ] `npx tsc --noEmit` and `deno task check` pass

## Tests

- [ ] Unit (extends the new `calibration.test.ts` introduced by ticket 0005; if 0005 has not
      landed, create it here and add it to `deno.json`'s `"test"` task string): a calibration
      run against a `Project` **with** an existing `spatialFrame` produces
      `status === 'provisional'`
- [ ] Unit: a calibration run against a `Project` **without** a `spatialFrame` also produces
      `status === 'provisional'`, and still writes a new `spatialFrame`
- [ ] Grep check: no remaining code path writes `status: 'verified'`

```bash
npx tsc --noEmit
deno task check
deno task test
```

## Acceptance Criteria

- [ ] Given a Place with an existing `spatialFrame`, When the user taps to calibrate, Then
      the resulting `ScanCalibration.status` is `'provisional'`, not `'verified'`
- [ ] Given that same repeat visit, When calibration completes, Then the on-screen message
      does not assert that the scan was aligned to the existing anchor
- [ ] Given a first-ever calibration for a Place, Then a `spatialFrame` is still written and
      behavior is otherwise unchanged from #141
- [ ] Given a scan carrying a `'verified'` status persisted by the #141-era build, When the
      World Editor loads it, Then it still renders its anchor exactly as before (no
      deserialization break)

## Risks / potential issues

- **Risk:** Making `'verified'` producerless is a latent trap — a future contributor may read
  the union and assume something still produces it. — **Mitigation:** the required
  `src/world/types.ts` comment says so explicitly, and ticket 0004 is the tracked follow-up
  that gives it a producer again.
- **Risk:** This ticket makes the product *look* worse (every scan now reads "provisional")
  without changing any geometry, which could read as a regression to someone watching the UI.
  — **Mitigation:** it is a regression in claim, not capability; alignment quality is
  unchanged, it just stops being overstated. Tickets 0003/0004 are what actually improve it.
  Worth stating plainly in the PR description.
- **Risk:** `'verified'` will have meant three different things across builds — measured
  against a 3-point triangle (pre-#141), "a record existed" (#141), and measured against a
  two-point separation (post-0004). A reader of stored data cannot tell which without the
  `method` and the build date. — **Mitigation:** `method` is the discriminant that
  disambiguates (`'raycast-reference-triangle'` no longer exists in the type;
  `'ground-tap-compass'` implies the #141 meaning; `'two-point-ground'` implies the measured
  one), and 0004 owns updating this same doc comment when it reintroduces the producer.

## Subtasks

1. [ ] Change the `status` assignment in `src/ar/project-calibration.ts` to `'provisional'`
       with an explanatory comment
2. [ ] Rewrite both post-calibration status strings in `src/main.ts:954-958`
3. [ ] Add the status-semantics comment to `ScanCalibration` in `src/world/types.ts`
4. [ ] Add/extend the unit tests per Tests; register the test file in `deno.json` if new
5. [ ] Grep for any other `'verified'` producer; confirm none remain
6. [ ] `npx tsc --noEmit`, `deno task check`, `deno task test`
