# Place register

Compares a scan's walls and obstacles with the Place's other calibrated scans
and **proposes** a small move that would line them up better. It measures how
well two scans agree, which nothing else in the app does: the two-point frame's
only check on a return visit is that the baseline length matched, and that is
blind to a shifted or rotated frame.

It never moves anything. A person applies a proposal in the editor, and what
that writes is an ordinary scan EditPatch (owner decision D17, approved).

- Matcher: [`server/register/scan_match.ts`](../../server/register/scan_match.ts) — pure, no Deno API, runs under Node too
- Job: [`server/register/place_register.ts`](../../server/register/place_register.ts)
- Shared types and Apply rules: [`src/world/register-proposal.ts`](../../src/world/register-proposal.ts)
- Editor card and preview: [`src/viewer/register-proposal.ts`](../../src/viewer/register-proposal.ts)

This is slice 1 of server registration: no GPU, no COLMAP, no Python. Slice 2
(joint COLMAP over both scans' keyframes) is a later package. Its building
blocks exist and are tested, and nothing calls them yet; see
[Slice 2 building blocks](#slice-2-building-blocks-no-job-yet).

## What it will not do

1. **Move a scan.** `scan.localToWorld` is untouched by the job.
2. **Set `scan.status`.** `'aligned'` is a claim that something was aligned. A
   proposal nobody has applied, and a run that proposes nothing, align nothing,
   so `applyCompletedJobToWorld` has no branch for this type.
3. **Touch the raw calibration.** The sidecar's `projectTransform` and
   `calibration.sessionToProject` stay as the capture measured them. The refined
   placement is the patch, and the residual that backs it travels with the patch
   as `provenance.residualM`.

## When it runs

- **When a second scan joins a Place.** `POST /upload-scan` queues a
  `place-register` job for the new scan after its `optimize-scan` job, when the
  Place already has another calibrated scan. The hook is `queuePlaceRegisterOnJoin`
  in `server/main.ts`; it is not awaited and a failure is only logged. Set
  `PLACE_REGISTER_AUTO_QUEUE` to `false` in `place_register.ts` to make it
  manual-only. Scans that enter a Place by reassignment or merge are not queued
  (their frames may differ; owner decision D4).
- **By hand.** "Alignment check (proposes a move)" in the editor's Advanced
  queue, or `POST /worlds/:slug/jobs` with `{ "type": "place-register", "scanId": … }`.

It is a `WorldJob` like every other (ADR 0001, ADR 0003): deduped on
`(type, scanId)`, single-flight in the one pump, requeued at boot, bounded in the
world's job history. None of that is re-implemented here. Re-running is safe: it
reads two files and writes the same artifact.

A scan is compared with the Place's **other calibrated scans** (the
`two-point-ground` and `ground-tap-compass` tiers; `known-distance` scans live in
solver coordinates and uncalibrated scans are placed by GPS or on a grid).
Which ones, in what order:

1. Scans filed under the **same area** come first, then scans with no area, each
   newest first. Scans filed under a **different area** are left out: two rooms of
   a similar plan whose frames overlap match each other by coincidence, and the
   score cannot tell that from the right room, but the person's own filing can.
   Putting the same area first means the earlier scan of this room is never
   dropped because newer scans of other rooms filled the list.
2. At most eight are read (`MAX_REFERENCE_CANDIDATES`), one at a time, each
   released after its pair is compared. The first four that can touch the new
   scan are searched (`MAX_REFERENCE_SCANS`); a pair turned away before any search
   (footprints too far apart, no floor, too few wall points) costs almost nothing
   and does not use one up.
3. Before each pair's search the job gives the rest of the server a turn (an
   upload or the event stream), so a job of several searches does not hold the one
   thread for the whole of them.

Nothing to compare, or a scan with no readable geometry, completes with a
`place-register-skip` artifact that says why. It is not a failure.

## What the matcher does

1. Carries each scan's points into the Place frame through its `localToWorld`
   (`readScanGlb` and `collectPointPositions`, the readers `export-world` and
   `panoptic-lift` use; the node hierarchy is applied, which matters for an
   optimized scan).
2. Finds each floor, keeps the points 0.3 to 2.0 m above it, and rasterises them
   into 5 cm occupancy cells with isolated specks removed. A floor is the lowest
   layer with enough points, believed only if it sits within 10 cm of where the
   calibration puts it (`FLOOR_HINT_TOLERANCE_M`; both tiers map the tapped
   landmark to project y = 0). A layer farther from that is a platform, a step or
   a ceiling, and the calibration's floor is used in its place with no height
   claim (`details.floors` says which). Height is corrected only when both floors
   were measured from their clouds. A scan that a patch has placed (moved by hand
   with the Edit gizmo, or by an applied check) gets no promise: it may have been
   lifted, so its floor is wherever its cloud shows it.
3. Chooses which scan the search turns: the one that reaches less far (RMS
   distance from its own centre), or, when the two reach about as far, the one
   with fewer cells. The turn is about that scan's centre, which is where the two
   overlap, so a walk through several rooms is judged by the room it shares with
   the earlier scan and not by the far side of the house. The answer does not
   depend on which scan is called the new one: when the search turned the earlier
   scan, the transform is inverted. What the bound limits is the move of the part
   the two share.
4. Turns pairs whose footprints cannot meet anywhere in the search window away as
   `low-overlap` without searching.
5. Searches x, z and yaw about the vertical (gravity fixes the rest; height comes
   from the two floors) by correlative scan matching: exhaustively at 20 cm, then
   refined at 10, 5 and 2.5 cm around the best eight coarse peaks, with a final
   sub-step polish. Deterministic: no random numbers, and the order of a cloud's
   points does not change the answer.
6. Measures the result at the best position and applies the gates.

### The gates, and what each refusal means

A refusal has `transform: null`, the numbers it measured, and one reason. They
are checked in this order.

| Reason | Meaning |
| --- | --- |
| `too-few-points`, `too-large` | Too little wall in one scan, or a scan that reaches more than 25 m from its own centre |
| `no-floor` | No floor in a cloud and no hint from the calibration |
| `floor-mismatch` | Both floors were measured from their clouds and are more than 0.3 m apart: probably another level |
| `low-overlap` | Under 60% of the smaller scan lines up at the best position, or the two footprints cannot meet anywhere the search reaches |
| `loose-fit` | What lines up is more than 8 cm apart (RMS) |
| `correction-too-large` | The best match needs more than 1.0 m, 10 degrees or 0.3 m of height. The size is reported; no transform is offered |
| `ambiguous` | The walls do not settle one position: another place within the bound fits about as well (a symmetric room, a row of pillars), or the score barely falls as the scan slides (a corridor, two parallel walls, one wall) |
| `low-score` | Every gate passed narrowly; the product above is under 0.5 |

`score` is `overlapFraction` times `distinctiveness` times `fit`. `distinctiveness`
is the smaller of two 0-to-1 tests, one for a second peak and one for how far the
near-best region reaches; `fit` is 1 at or under a 4 cm residual and falls to 0 at
the 8 cm gate. All three are in `details` so a later tuning run can see why a pair
passed or failed. A refusal reports the score it measured, as a proposal does: it
is nearly always low (an ambiguous or loose match scores under 0.3), and
`correction-too-large` keeps the high score its good match earned and reports the
size beside it.

## Constants are adopted, not measured

Every threshold in `scan_match.ts` is **adopted, not measured** (ADR 0005 rule
5). The repo holds no real two-scan captures (`test-data/real` is a README), so
they were set against synthetic rooms. Each carries its own revisit trigger in
the source. The run records the values it used in the artifact's `params`.

## Apply

The editor lists each scan's newest check in the World tab ("Alignment checks"):
what was compared, how much lined up, the proposed move, **Show** (the scan's
points in red where they are and green where the proposal puts them) and
**Apply**. Apply POSTs a scan patch whose matrix is the correction on top of the
scan's placement at proposal time and whose provenance is
`{ source: 'place-register', jobId, score, residualM }`.

There is no Undo button. The check keeps the scan's placement from before
(`moving.localToWorld` in the artifact), the sidecar keeps the capture's own
calibration, and the Edit gizmo can move the scan back; running the check again
afterwards proposes from where the scan now is.

The server holds that provenance to what the job proposed (`guardRegistrationPatch`):
the job exists and proposed a move for this scan; neither this scan nor its
reference has moved since; the matrix and numbers are the job's own. A second
apply of one job, from a second tab or a double press, gets the first patch back
(`duplicate: true`) and writes nothing. A patch without provenance is untouched.

## What it cannot see

- **Identity.** Two different rooms with one plan match perfectly. Filing under
  areas keeps most of them apart (scans filed under another area are not
  compared), but two scans with no area, or two rooms filed under one area, are
  not told apart. Two scans that are both shifted the same way against the
  building cannot be told from correct ones. Only photos, a fiducial or the person
  looking at the preview see that.
- **A turn by the room's own symmetry.** A bare square room turned a quarter turn
  about its own centre, or a bare rectangle turned a half turn, fits itself: the
  answer is "no move", which is right for the walls, and the bound keeps the
  matching turn from being proposed. The walls cannot say which wall is which; a
  doorway, a piece of furniture or a photo can.
- **Mass that is not wall.** Unrelated points between 0.3 and 2.0 m above the
  floor (floating junk, a ceiling at or below 2.0 m, a great deal of furniture)
  flatten the score everywhere, and the check then says the walls do not settle one
  position when they would. It refuses; it does not guess. On synthetic 5 x 4 m
  rooms with the same furniture in both scans, 12 pieces got a proposal in 28 of 40
  pairs and 16 pieces in 6 of 40, none of them wrong; a ceiling at 2.0 m refused
  all 30. Normalising the score against the window's median made those cases
  propose (16 pieces: 38 of 40) and was not adopted: it also proposed positions
  along a single wall that were more than 5 cm out (up to 10 cm) in 10 of 40 pairs. Real clutter is the
  first thing DX9 should show. The band's limits are adopted constants
  (`SLAB_MIN_ABOVE_FLOOR_M`, `SLAB_MAX_ABOVE_FLOOR_M`).
- **A platform within the floor tolerance.** A low platform standing in for a
  barely seen floor is believed if it is within 10 cm of where the calibration
  puts the floor, and then the height change can be up to that far out.
- **Wall ends.** Position along a wall that was scanned for a different length
  each time is weakly determined. The matcher refuses parallel walls on their
  own, but a long wall plus a short unrelated feature can look better than it is:
  in 40 synthetic pairs of two parallel walls against a full room, 1 was proposed,
  9 cm out along the wall (the same either way round).
- **After Apply and a reload**, the red and white calibration pins are drawn
  from `localToWorld`, which a patch replaces. This is true of any scan patch
  (see `addAnchorMarker` in `src/viewer/viewer.ts`) and is not specific to this job.

## Time

A search is arithmetic on the one thread the upload routes and the event stream
share. Measured on synthetic clouds: 0.4 to 2.3 s per pair for 66 000 to 590 000
points over 4 to 24 rooms, and 3 to 7 s per pair for 250 000 points (the phone's
cap) filling a disc of 10 to 24 m radius. The job yields before each pair, not
inside one. The matcher has no Deno dependency precisely so that a worker thread
can run it later; that is the next step if DX9 shows long searches in practice.

## DX9: what real data would settle

Two real scans of one room (different days or lighting, some furniture moved)
and one two-room walk. Record per pair: overlap, inlier residual, score, the
reason when refused, runtime (`comparisons[].elapsedMs`), and the correction
against the manually set truth. That is the only data that can tune the
constants above.

For the joint solve the job that runs it will record the same way: per session the
frames offered, registered and left in other models, the fitted lens against the
prior, the residual (in session units and in Place metres), the scale ratio to the
reference, the up-axis tilt, the pair counts by kind, and `timing.elapsedMs`. The
solve already returns all but the chain's numbers (`colmap-joint.manifest.json`);
those come from `fitSessionToSolver` and `registerSessionsToReference`, and nothing
stores them yet, because no job runs them. The collector the build plan names,
`scripts/dx9-collect.ts`, is not built: it summarises a job's per-pair records, and
that job needs frame ids from WP-08. Those numbers are what set the pair-list
gates, the 100-image limit and the up-axis limit.

## Slice 2 prerequisites seen in the code

- `runColmapPoses` passes `--ImageReader.single_camera 1` to `feature_extractor`
  and matches exhaustively. That is right for the one session it solves, and it
  is unchanged (a golden test pins its command lines and its files). Across
  sessions it was wrong, and exhaustive matching does not scale to a Place's
  worth of keyframes: `runColmapJointPoses` is the answer, see below.
- Keyframe sessions are opened by `KeyframeStreamer.start()` and rotated at each
  autosave and export (`src/main.ts` rotates the session after a successful
  upload), so one scan is one session once streaming is on. Streaming itself is
  a manual toggle ("Stream keyframes to server"); making it default for Place
  scans is owner decision D15.
- `server/splat/splat_align.ts` already does Umeyama between camera sets and is
  the piece to reuse for chaining a session to the Place frame.

## Slice 2 building blocks (no job yet)

What a joint COLMAP registration is made of. The `method: 'sfm'` job itself
(a reference model cached per Place and frame id, the proposal, the editor card)
needs frame ids from WP-08 and is not built. Nothing is applied automatically.

- **One camera per session.** `runColmapJointPoses`
  ([`server/colmap/colmap_joint.ts`](../../server/colmap/colmap_joint.ts); it
  builds its command lines with the builders in
  [`colmap_poses.ts`](../../server/colmap/colmap_poses.ts), which solves one
  session and is unchanged) links each session's keyframes into
  `images/<sessionId>/` and gives each folder a camera of its own
  (`--ImageReader.single_camera_per_folder`), started from that session's own
  field of view in `keyframes.jsonl`
  ([`colmap_sessions.ts`](../../server/colmap/colmap_sessions.ts)). A session
  that reported none is left to COLMAP's default, not given a made-up prior, and
  so is one whose every frame reported exactly 60 degrees (what a runtime says
  before its first real projection) or a field of view outside 20 to 140
  degrees; `prior.ignored` in the report counts what was left out. Its output is
  a work directory of its own, never a session's, however either is spelled
  (relative paths and symbolic links are resolved before the check): poses are
  keyed `<sessionId>/kf-NNNNN.jpg`, the lens of each session is under `cameras`,
  and the model is left in COLMAP's frame. The report says, per session, how many
  frames joined the model, which lens COLMAP fitted, and whether the session
  came out as a model of its own. A session COLMAP cannot tie to the others
  usually does, but not always: with a session whose pictures were mirrored (its
  AR poses right, its images unable to match), COLMAP 3.13.0 and the relaxed
  mapper thresholds put 3 of its 14 frames into the model that held the other two
  sessions, 2 to 3 m from where the cameras were, and the report said registered
  3, unregistered 11. So "registered" is not "joined": the fit and the
  registration's checks (below) are what refuse such a session, and
  `COLMAP_E2E` has that session as a negative control. The thresholds stay the
  single-session ones: with COLMAP's own defaults the same frames were not
  registered, but nothing says what defaults would do to a real session's weaker
  overlap with another, which is DX9. The work directory holds the sessions'
  keyframes as hard links, and COLMAP's feature database. A hard link keeps a
  photograph alive after its session is deleted, so a deletion path (owner
  decision D15) that removes only `scans/sessions/<id>/` leaves those frames
  behind: whoever picks the directory deletes it with the scan or the Place.
- **Pair lists.** [`pair_list.ts`](../../server/register/pair_list.ts) builds the
  list for `matches_importer --match_type pairs`: each image with its next ten
  in capture order, revisits within a session, and, across sessions, frames
  within 3 m and 60 degrees of each other in the Place frame by the AR poses
  ([`session_priors.ts`](../../server/register/session_priors.ts) carries them
  there through each scan's `sessionToProject`, one epoch only, and refuses a
  matrix that is not a column-major similarity, so a row-major one cannot move
  every frame silently). Exhaustive matching is refused beyond about 100 images,
  with the reason, and a list is refused beyond 20,000 pairs as soon as the
  pairs found pass that. The sessions the pairs tie into one group are reported
  (`stats.groups`); the group that matters is the one holding the reference
  session (`pairOptions.referenceSessionId`), else the largest, and every
  session outside it is isolated, even one that has a partner of its own. The
  plan then falls back to exhaustive matching when the image count allows it, and
  says which sessions the poses could not tie. Deterministic.
- **The chain.** [`sim3_chain.ts`](../../server/register/sim3_chain.ts): an
  Umeyama fit per session of its recorded camera centres to the solve's
  (`splat_align.ts`), then `T_new->Place = T_ref x Sim_ref^-1 x Sim_new` for every
  session against the reference, never against each other. The result comes in
  both conventions (`sessionToProject` is column-major,
  `SplatAlignManifest.projectTransform` is row-major) and carries the per-session
  scale ratio, the unit mismatch between runtimes (the scale of the placement is
  that times the scale of the reference's own calibration, 1 for an AR session).
  The up axis is read from the fit to the AR poses, not guessed from the cameras.
  A session is refused when its fit is (too few frames, a straight line, a scale
  that is not positive, a residual past 0.25), and when the solve tips its up
  axis more than 5 degrees against the reference's: every AR frame is
  gravity-aligned, so that angle is the noise of the two fits when the
  registration is right and arbitrary when it is not. Of 4 frames COLMAP placed
  0.5 m from where they were, 7% got past the residual gate and 0.35% past both
  (simulated; the limit is adopted, `MAX_UP_AXIS_TILT_DEG`). `describeCorrection`
  sets a registration against the scan's own calibration in the vocabulary of the
  matcher's proposals (shift, turn, height, with the same limits), plus tilt and
  scale, which those limits do not cover.

What the chain cannot see. A solve that is the mirror image of the AR poses fits a
nearly flat camera path almost as well as the real one, because the proper
rotation the fit is held to turns the path over (simulated: 99 to 100 of 100
registered at a 5 cm spread of camera height, 85 at 10 cm, none from 30 cm);
camera centres alone cannot tell, and a mirrored capture is a bug to find where
it is made. A camera path that is nearly a line (a corridor) leaves the turn about
its own length poorly fixed; the up-axis limit bounds that, and does not remove it
(simulated, a point 3 m off a 20 m by 0.3 m walk: 16% of the registrations refused,
the rest placing it within a median 12 cm and at worst 27 cm, where it was 56 cm
without the limit).

How it was tested. The unit tests stub COLMAP. `COLMAP_E2E=1` runs the real
COLMAP 3.13.0 on a rendered room of three sessions (three lenses, two image
sizes, three AR frames, one unit 12% bigger than the reference's) and checks that
the frames register in one model, each session on its own camera, and that the
chain recovers each session's frame, and then on the same room with one session's
pictures mirrored, which the chain must not register; see
[`colmap_toy_sfm.test.ts`](../../tests/unit/deno/colmap_toy_sfm.test.ts) for the
numbers it measured. That room is easy: no blur, no lighting change, no moved
furniture. Nothing has been measured on a real scan; that is DX9, and it is also
the only thing that can set the constants, which are all adopted (3 m, 60
degrees, the sequence window, the partner caps, the 100-image limit, the pair
cap, the 5 degree up-axis limit, the 20 to 140 degree field-of-view range) and
named as such where they are defined.

Two things the gates trust. Each session's frames reach the Place frame through
its own calibration, so a session whose calibration is wrong by more than the
gates (a one-point frame turned by the baseline's bearing, a frame that moved
after calibration) is not tied by the pair list. And the fit trusts the AR poses
of one epoch, the one the calibration was made in (`frameEpochs.calibrationEpoch`
in the upload sidecar); frames of other epochs go to COLMAP but take no part in
the gates or the fit.
