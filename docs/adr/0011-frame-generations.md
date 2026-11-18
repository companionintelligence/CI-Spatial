# 0011. A Place's frame is replaced by a new generation, never edited

- **Status:** Proposed
- **Date:** 2026-11-17
- **Related:** ADR 0001 (reuse the existing domain model: this extends `ProjectSpatialFrame`, `ScanCalibration`,
  `ScanManifest` and `Project`, and adds no parallel type), ADR 0005 (a frame is established by geometry; rules 3 and 5
  govern what this may claim and how its constants are named), ADR 0002 (the rules both halves share live in a file with
  no Deno reference), ADR 0004 (world files are written under a per-slug lock; the hand-over in decision 7 adds a fourth,
  non-waiting way in, which that ADR does not list), `docs/audits/2026-11-13-goal-readiness.md` (Q1-3, the open question
  this answers), owner decision D4 (new generation, affected scans listed), D6 and D7

## Context

A Place keeps one durable reference, its frame (`Project.spatialFrame`): the landmark, the heading marker and, since
WP-04, check points. Every scan of the Place is placed by its own `sessionToProject`, which maps the scan's session into
that frame, and the editor draws them all in the one world. That only means anything if every scan of the Place was
measured against the *same* frame, and four things broke that without saying so:

1. **Replacing the frame is silent.** `assessTwoPoint` returns `frameChanged: !stored || override`
   (`src/ar/calibration-commit.ts`): the mismatch screen's "Use anyway" and the upgrade of a one-point frame both put a
   different frame under every scan already taken, and the server stored it with no record of what it replaced. A scan
   carried no id of the frame it was measured against, so nothing could tell a scan of the old frame from a scan of the
   new one.
2. **Photos are one file per role.** `POST /projects/:id/reference-photos` writes `ref-<role>.jpg` into the Place's
   folder, so a replaced frame's photos are written over, and a record that points at a path can show another
   calibration's picture.
3. **Merge and reassign move scans between frames.** `POST /projects/:id/merge` deletes the source Place with its frame
   and `rewriteProjectReferences` rewrites only each scan's `projectId`; `PATCH /projects/:id/scans/:scanId`
   (`rewriteScanProject`) rewrites the Place, floor, room and area and nothing else. The scan's `projectTransform` stays
   in the frame it was measured against and is read as if it were in the target's. Merge also relabelled the source's
   world file as the target's (`world.projectId = targetProjectId`), a second world for the target that nothing opens.
4. **A move erases the manual alignment.** `refreshWorldScans` drops a scan whose record no longer files it under the
   world's Place and pruned its edit patches, comments and jobs with it. The placement a person set by hand lives in
   exactly those patches and in the row's `localToWorld`, which a refresh keeps frozen (`localToWorld: scan.localToWorld`),
   so a reassigned scan arrived in the new world re-placed from its record, with its manual alignment gone from both.

The tracers' reading of the code was checked against this tree before anything was built. Three of their statements
were out of date: the commit rule has moved to `src/ar/calibration-commit.ts` (WP-04b step 0), the server now reads and
writes the frame (WP-03a), and the validator already accepts frame ids and frame-scoped photo URLs (S0). One thing was
missing: the merge's relabelling of the source world, which is why a merged scan's patches never reached the target's
world.

## Decision

**1. A frame is immutable once written, and replacing it is a new generation.** A frame carries a `frameId`, minted by
the capture client when its calibration builds the frame (`newFrameId`, `src/world/frame-generations.ts`: a UUID, or on a
page without `randomUUID` the time and random bytes, as `newArRunId` does). The server never mints one, and no client in
the tree this slice was built on calls `newFrameId`: that is the client slice's (WP-08c), and until it is merged every
frame there is has no id and is an unknown generation (decision 3). Replacing the Place's frame writes another
frame with another id. The server keeps what it replaced in `Project.frameHistory`: `{ frameId, createdAt, method,
separationM, supersededAt, reason }`, oldest first. An id names one reference, for good: the id of the held frame on a
frame that is not the held one is refused (`frame-id-reused`), and so is the id of any frame the Place held before (its
history), because scans measured against the earlier frame carry that id and under another frame they would read as scans
of the current one. The photos and names that go with the points (`referencePhotos`, `pointLabels`, a check point's `photo`
and `label`) may be added to a frame under its own id, because that is how a frame is saved in two steps; nothing else may
change.

**2. The server enforces the replacement, in the compare-and-swap write.** `applySpatialFrameWrite`
(`server/wp-a-projects.ts`, WP-03a) is where it lives, so the revision, the replace rule and the history row are one step
under `mutateProjects`. The write is judged in this order: the body, the frame, whether the Place exists, a replay (the
same frame again is `200 unchanged`), then the revision (stale is `409`, whatever else is wrong). Only then:

| The write, against the frame held | Answer |
| --- | --- |
| nothing held | stored; revision 0 to 1 |
| the same generation again (same id, or neither has one and they share `createdAt`) | stored; no history row. When the held frame has an id and this is not the same reference, `409 frame-id-reused`. Two frames with no id that share a `createdAt` are stored as they always were: nothing names them, so nothing can say they differ. **So "immutable once written" is enforced by the server for frames that have an id; a frame with none can still be changed in place by a write that keeps its `createdAt`, as it always could** |
| another generation (the ids differ; an absent id differs from a present one) | refused `409 frame-id-reused` when it takes an id from the history; otherwise needs `replaces: { frameId, reason }`; `reason` is `override`, `upgrade` or `merge` (`reset` is deferred); `replaces.frameId` must equal the held frame's id, or be null when it has none; then stored, with the held frame appended to the history |
| two frames that neither has an id, with different `createdAt` | stored, as every writer did before ids; recorded only if the writer says what it replaces |

A refusal is `409` with the same body as a stale revision, `{ error, code, current: { frame, revision } }`, so a client
that knows only the stale-revision conflict adopts the frame the Place holds, as it does for any lost race. `code` is
`replaces-required`, `replaces-mismatch` or `frame-id-reused`; `error` is a sentence a person can read. A `replaces` that
is not an object with a frame id (or null) and a known reason is a `400`.

**3. An unknown generation is neutral.** Every frame and scan written before ids has none. That reads as "frame not
recorded", never as a different frame: only two known ids that differ read as "previous reference". The one tier that has
no generation at all is the one-point frame (`ground-tap-compass`): a one-point scan is "not in Place frame", as is a
scan that was never calibrated, a known-distance one (its matrix carries the camera solve's own coordinates), and a two-point
scan whose commit wrote no Place frame and matched none: a commit whose floor check was bypassed, on a first visit, over a mismatch
(the button then reads "Record as unverified" and replaces nothing) or in an improve run (`mayWritePlaceFrame` never lets a
bypassed commit write the frame, and `leavesScanOutsidePlaceFrame`, `src/ar/ground-gate.ts`, says what such a commit then is). Its
record says so itself, only when it is true: `ScanCalibration.outsidePlaceFrame` in the nested record, and
`ScanManifest.calibrationOutsidePlaceFrame` in the manifest. That is `isInPlaceFrame` in the shared file, which reads it: the one
predicate the counts and Thing matching (D6) use, and the one the client's chip uses (`frameChipFor`, `src/viewer/frame-banner.ts`,
asks it, and the chip reads "not in Place frame"), so the counts, Thing matching and the chip are one rule. A Thing-matching job leaves those scans out until they are calibrated
and says how many in its result (`scansLeftOutNote`, `server/thing_match.ts`), so a Place whose scans are all out of frame is not
mistaken for one where nothing was found. Things already made from such scans stay.

**4. The history is bounded.** The newest `FRAME_HISTORY_LIMIT` = 20 replaced frames are kept; the oldest drop off. That
figure is the design's (D4), **adopted, not measured (ADR 0005 rule 5)**.

**5. Scans are counted by frame from their own records.** `GET /projects/:id/frame-status` counts the Place's stored
scans from their sidecars (`countScansForProject` in `server/main.ts`, filtered by `scanProjectId(meta)`), not from any
world, through the same `calibrationFromMeta` the scan list reads, so the counts and the chips agree. A world is
a view of the scans, and one the Place's editor may never have opened. One known limit, inherited from that reader: the
`splat-align` job replaces a scan's nested calibration record with a known-distance one and leaves the flat keys alone, and the
frame id is read from the nested record when no flat `calibrationFrameId` key is there, so such a scan counts as "frame not
recorded" and not under the generation it was measured against. The reader prefers the flat key, so a scan whose sidecar
carries it (the client slice writes it at upload) keeps its generation through that job; scans uploaded before it do not, and
`splat-align` has no UI. The statement that a scan is in no Place frame (decision 3) has the same limit and the key is not yet
written flat: the exporter writes `calibrationFrameId` beside the nested record and no `calibrationOutsidePlaceFrame`
(`src/export/gltf.ts`), so a `splat-align` job that replaces the nested record drops the statement from a count read from the
sidecar (`tallyScansByFrame`), while a world row that already carries it keeps it (`refreshWorldScans` leaves a value the sidecar no
longer gives standing, as it must for a value that can only be true). `asOutsidePlaceFrame` (`server/calibration_fields.ts`) reads
the flat key first, so a writer that puts it beside the record closes the gap.

**6. A merge or a moved scan must be in the frame it joins, or say it knows.** `POST /projects/:id/merge` and
`PATCH /projects/:id/scans/:scanId` are `409 frame-mismatch` when the scans would join a Place whose frame is not the one
they were measured against, unless the body carries `acceptFrameMismatch: true`. The flag is a plain yes: it is not
bound to the frames the person was shown (the 409 names them in `target` and `source`), because the consequence of a stale
yes is the same as of a fresh one, scans listed as a previous reference. Two frames agree when they have the same
id; frames with no id are told apart by their record, apart from the photos and names that go with the points, because a Place
that takes a frame keeps a copy that names the photo files of its own folder and is still that frame. A Place with no frame takes the frame the scans were measured
against (revision up by one, its photos copied into its own folder, and on a merge the earlier generations of the source
join its history). A Place that already holds another frame keeps it, and describes the generations the moved scans are
measured against in its own history (`reason: 'merge'`, superseded by the move; on a merge also the generations the source
held before), copying each one's photos into its own folder, so a scan listed as a previous reference can be described and its
photos served by the Place it is in now; a generation it already holds or has described is not described again. A scan that
is not in a Place frame, and a move within the scan's own Place, are never refused. The scans a request names are judged
and filed as one set (`planScanMove`, `server/place_moves.ts`), and the Place changes only once they are filed: a request that
finds nothing to file has changed no Place.

**7. What was made of a scan moves with it.** Reading a world that no longer holds a scan (`refreshWorldScans`) hands the
scan over to the world of the Place its record files it under (`server/world/scan_carry.ts`): its patches, comments and
finished jobs, and, when it is placed by its own record, its row and its hand-set placement, so its manual alignment and the
placement it can be reset to are not lost.

*Placed by its own record* is decided by the sidecar and not by the calibration method it names: the scan's `projectTransform`
is a usable matrix, which is what `scanManifestFromStored` placed the row by. Such a placement is the same in every world, and
so is every placement patch over it (they are absolute matrices). The target keeps a row it already has (one a read built from
the record, or the one the scan came back to) and takes only the placement the merged log ends on; carried patches go into its
log in the order of the time they were made, so a move made there since still wins.

Which frame a scan is in (decision 3) and what its placement is relative to are two questions. A one-point scan is not in
a Place frame, but it has a `projectTransform` and is placed by it, so its row and its hand-set placement travel as a
calibrated scan's do.

A scan that is not placed by its record is placed by the origin of the world it was in (GPS, or the grid), and so is every
placement set by hand over it: a matrix is a position in that world. In another world the same matrix would put the scan
somewhere else, and nothing says what the person meant it to line up with, because a world with calibrated and GPS-placed
scans mixes two frames. It is not converted by the offset between the worlds' origins, which would be right for one reading
and wrong for the other. The placement patches are **kept** in the world they were made in (not destroyed, and found again if
the scan comes back), the scan's row is built again from its record in the world it joins, as it always was, and the answer
says how many were kept (`handOver.placementsKept`) so the editor can tell the person. Its notes, comments and finished jobs
travel. "Manual alignment lost on reassign = 0" holds as: nothing a person did is destroyed; a placement that cannot mean the
same thing in the new Place is not applied there, and is counted.

**A merge does not keep them.** It deletes the merged-away Place, and the world they were kept in goes with the Place once
everything in it has been handed over (Consequences, "A merged-away Place's world is removed"): a scan cannot be filed under a
Place the registry does not have, so it cannot come back, and that world holds the Place's name, location and Things. For a
merge, then, the count is of placements that went, and not of placements kept. The answer says `sourceWorldRemoved`, and
`placementsRemoved` when the world held any, counted from the world's own file as it was removed (a repeat of the merge counts
them too), and it does not say `placementsKept` of a world that is gone. "Manual alignment lost on reassign = 0" is a claim about
a reassign, which is not a deletion. A merge says what it removed: what means the same in the target's world comes with the
scan, and what does not goes with the Place's world and is counted as removed. `DELETE /projects/:id` removes a Place's world in
the same way, with the placements it kept for scans that were moved out of the Place earlier, and does not count them.

Queued and running jobs are dropped, not carried: the pump finds a job by the slug of the world it was queued in, so a job
moved to another world could never run. A scan filed under no Place, or under one the registry does not have, has nowhere to go
and its records are dropped, as they always were. The merge no longer relabels the source's world as the target's: it removes
it, once nothing in it is waiting for the hand-over below.

The hand-over never waits for the other world's lock (the caller holds one, and two callers that each want the other's would
wait for good), so it can be put off, and the module that runs it (`server/world/world_hand_over.ts`) sees to the rest. It is a
fourth way into a world file beside the three ADR 0004 lists (`loadWorld`, `updateWorld`, `mutateWorldFiles`): `editIfFree` in
`server/main.ts` reads and writes the other world with the unlocked primitives under `tryWithWorldLock`
(`server/world/world_lock.ts`), which runs only when the lock is free. That keeps the rule of ADR 0004 where it counts, that no
cycle runs unless it holds the world's lock, and gives up the part that cannot hold here, that a caller waits its turn. A world
that is busy, or that cannot be read or saved, leaves the scan, with every record, in the world it was in, and that failure is
that world's: the old world is still readable. The route that moved the scan reads the old world straight away and a few more
times in the first moments, and answers `handOver: { pending: n }` for scans still waiting; a timer then reads it again, after
1 s and twice as long each time, six times, which finishes the job without anybody reading the old world; and so does anybody's
next read of it. A hand-over still waiting when the server stops is done by the next read of the old world, and until then
the scan and its records are there, where nothing has been taken from them. So the move is complete when the routes answer
unless they say `pending`; they never say it was complete when it was not. A merge removes the merged-away Place's world only
when nothing is waiting in it, so a hand-over that is `pending` still has the world it is read from.

**8. Photos belong to their frame.** `POST /projects/:id/frames/:frameId/reference-photos` and
`GET /projects/:id/frames/:frameId/ref-<role>.jpg` keep a frame's photos in `<Place>/frames/<frameId>/`. The roles are
`FRAME_PHOTO_ROLES`: `landmark`, `heading`, `check1` to `check3` (`headingMarker` is accepted in the upload's `meta` as
the legacy name of `heading`). An upload is taken for the frame the Place holds and for the frames in its history, and
for no other id, so a calibration that lost to another device cannot write over the winner's photos. The legacy path
(`/projects/:id/reference-photos/ref-<role>.jpg`) serves every frame written before ids and is not migrated. Its upload
route is closed (`409 legacy-photos-closed`) once the Place's frame has an id, so those files are never written over
by a later frame's photos, and it still takes the photos of a Place whose frame has none, which is how the phone's
frame code sends them today (`src/project/frame-sync.ts`). The client slice (WP-08c) keeps a phone's own
copy under `<projectId>:<frameId>:<role>`, so that another generation's blob is never shown under a newer record. **A frame with an id names `framePhotoPath` URLs: that is the client's duty, and the server does
not enforce it.** The validator accepts the legacy URL shape for every frame (S0), because writes of frames with and without ids
overlap and refusing it would lock a client out of saving its frame; so a record that gives an id to the shared legacy files
would show the previous frame's pictures. The server never writes over a picture (its routes are per frame, and the legacy
upload is closed), and it cannot make a client name the right file.

**9. The New Place form starts on Building (D7).** A house is one Place with its rooms as Areas, not a chain of Places each
with a frame nothing relates (`NEW_PLACE_DEFAULT_TYPE`, `src/project/new-place-type.ts`). All four types are still offered,
and every Place already saved keeps its type.

## What this reuses

Nothing parallel is added (ADR 0001). The schema is S0's and is not edited here: `ProjectSpatialFrame.frameId`,
`ScanCalibration.frameId`, `ScanManifest.calibrationFrameId`, `Project.frameHistory`, `FrameHistoryEntry` and
`FrameReplaceReason`, with `isFrameId`, `FRAME_PHOTO_ROLES` and `framePhotoPath` from `src/world/spatial-frame.ts`. One optional
flag was added to it afterwards, for decision 3: `ScanCalibration.outsidePlaceFrame` and its manifest projection
`ScanManifest.calibrationOutsidePlaceFrame` (`src/world/types.ts`), written only when true. The
write is WP-03a's `applySpatialFrameWrite`, extended; the counts extend `countScansForProject` and read
`calibrationFromMeta`; the move extends `rewriteScanProject`, `rewriteProjectReferences` and `refreshWorldScans` and uses
`mutateProjects`, `mutateWorldFiles` and `withWorldLock`; the photos extend `server/project_media.ts`; the id is
`newArRunId`'s. New: `src/world/frame-generations.ts` (the rules both halves share), `server/place_frames.ts` (the server's
decisions), `server/place_moves.ts` (what a merge or a moved scan does to the registry), `server/place_frame_routes.ts` (the
status and photo routes), `server/world/scan_carry.ts` (what goes with a scan), `server/world/world_hand_over.ts` (doing it,
and finishing it later), `tryWithWorldLock`, and `src/project/new-place-type.ts`. The logic is in these and not in
`server/main.ts`, which makes each of them and calls them from the registry, the refresh and the two routes. No environment
variable, job, queue or connection is added, and no type that already existed.

## Interface for the client slice (WP-08c)

The client's replace flow, the confirm and the editor's banner are WP-08c's. These are the shapes it builds against, and
the server above answers them as written. Every route is behind the Companion session guard, like the `/projects` routes
beside it; there is no world role on them.

- `PUT /projects/:id/spatial-frame`, body `{ frame, expectedRevision, replaces? }`. `replaces` is
  `{ frameId: string | null, reason: 'override' | 'upgrade' | 'merge' }` and is sent when the frame being written is
  another generation than the Place's (`classifyFrameWrite(held, next) === 'new-generation'`, exported from
  `src/world/frame-generations.ts`, which also exports `parseFrameReplaces`, `FrameReplaces` and `newFrameId`). A frame the
  capture flow builds carries a `frameId` from `newFrameId()`; the photo records it carries name
  `framePhotoPath(projectId, frameId, role)` URLs.
  Answers: `200 { revision, frame }`; `200 { revision, frame, unchanged: true }` for a replay; `409 { error, current }`
  for a stale revision, and `409 { error, code, current }` for the three codes above; `400 { error }`; `404`; `413`.
- `GET /projects/:id/frame-status` answers `FrameStatus` (`src/world/frame-generations.ts`): `projectId`, `frame` (or
  null), `frameId` (or null), `revision`, `scanCount`, `scansByFrame` (frame id to count, two-point scans that name their
  frame), `unrecordedScans` (two-point scans that name none), `notInFrameScans` (never calibrated, one-point,
  known-distance, and two-point scans whose commit wrote no Place frame and matched none), `scansOnCurrentFrame` (what a replacement would leave in a previous reference: the count of the current
  frame's id, or `unrecordedScans` while the current frame has no id) and `history`. `404 { error: 'Not found' }`.
- `POST /projects/:id/merge`, body `{ sourceProjectId, acceptFrameMismatch? }`, and `PATCH /projects/:id/scans/:scanId`,
  body `{ floorId?, roomId?, areaId?, acceptFrameMismatch? }`: `409 FrameMismatchBody` =
  `{ code: 'frame-mismatch', error, target, source, scans }`, where `target` and `source` are `{ frameId, createdAt, method }`
  or null and `error` is a sentence for a person. A client that cannot render the code can show `error`. The sentence says what was
  compared: that the frames differ when both are known, and, for a scan that does not say which frame it was aligned in (it predates
  ids and its Place holds none to compare it with, so `source` is null), that nothing says it is the same. The success answers
  are `{ ok: true }` for a reassign and `{ ok: true, project, alreadyMerged, sourceWorldRemoved }` for a merge, with one
  optional field, `handOver` (`HandOverReport`, `src/world/frame-generations.ts`), present only when it has something to say:
  `pending` (scans whose records have not reached the new Place's world yet; they will) and `placementsKept` (hand-set
  placements that stay in the old world, because they are positions in it; a merge says it only of a world it keeps). The
  merge's answer also says what became of the merged-away Place's world. `sourceWorldRemoved` is `true` when the Place is
  gone and no world of it is left. It is `false` when a world of it was kept: a scan is still listed in it (its hand-over is
  `pending`, or it is an upload with no GLB, which a merge does not move), or a job is queued or running in it; or when the
  Place is not shown to be gone: a scan's record still names it, or the registry cannot be read. Asking for the same merge
  again, or `DELETE /projects/:id`, removes a world that was kept once nothing is in the way. `placementsRemoved` is present
  only when it is above zero: how many hand-set placements went with the world that was removed (the ones `placementsKept`
  counts while their world stays), counted from the world's own file, so that a repeat of the merge counts them too. When a
  world was removed, the answer carries no `placementsKept`. A client that does not know these fields reads the answers it
  always did; one that does can tell the person.
- Photos: `POST /projects/:id/frames/:frameId/reference-photos` (multipart `image`, `meta` with the same fields as the
  legacy route and `role` from `FRAME_PHOTO_ROLES`) answers `{ ok, role, url }`; `GET /projects/:id/frames/:frameId/ref-<role>.jpg`
  answers `image/jpeg`, `404` when there is no such photo. A photo is uploaded after the server holds the frame. A frame that
  has an id sends its photos here, and not to the legacy route, which answers `409 legacy-photos-closed` once the Place's frame
  has an id: a client that gives a frame an id and still uploads its photos to `/projects/:id/reference-photos` loses them.
- **Requests that carry a decision go with `NO_QUEUE_HEADER`** (`src/shared/offline-queue.ts`): a frame write with
  `replaces`, a merge and a reassign. The service worker queues any `POST`, `PUT` or `PATCH` under `/projects` when the
  network is down and replays it later, and it deletes a replayed body on any 4xx other than 401, 403, 408 and 429. A
  replayed `409` is therefore lost with a notice instead of being told to the person who made the decision. The server
  cannot set this header; the callers do.

## Consequences

**Easier.** A scan can be told to be of the current reference or of an earlier one, so "scans silently left in a
superseded frame" is a list and not a surprise; each is counted by `frame-status` and carries `calibrationFrameId`. The
server never writes one reference's photos over another's, and a frame record is never edited in place. A merge or a
reassign across frames cannot happen by accident, and one that is chosen loses nothing a person did without saying so: what
means the same in the new Place comes with the scan, and what cannot stays where it was made and is counted, or, for a merge,
which deletes the merged-away Place's world, goes with that world and is counted as removed (decision 7).

**Harder.** A client that predates ids cannot replace a Place's frame once the Place has an id. Its override is told it lost,
and it adopts the frame the Place holds. That is the intended degradation, and it is what the phone's existing code does for
a lost race, but it means an override from an old app does nothing until the app is updated. A Place whose frame has an id also
takes no photo from the legacy upload route, so an old app that finds one it cannot replace cannot add photos to it either
(the return visit says so: "The saved photo could not be loaded. Place this marker from memory."). History rows are a
record, not a repair: the scans of a previous reference are listed, not re-registered (that is WP-15's proposals, and D16
gates them).

**A merged-away Place's world is removed, not relabelled and not left.** The merge used to relabel the source's world file as
the target's; it no longer does, because that made a second world for the target that nothing opens. It does not leave the
world as it was either, emptied of its scans and still the Place's: nothing opens the world of a Place that is out of the
registry, and it holds that Place's name, location, Things and comments, which `GET /worlds/:slug` answers to a request that
carries no token (docs/operations/PRIVACY.md, section 5), and its share tokens, which that route holds back from such a
request. Once the scans are filed under the target and their notes are handed over, the merge removes the world with its
export (`removeMergedAwayWorld`, `server/main.ts`), unless something in it is waiting: a scan row, a job queued or running, a
scan record that still names the Place, or a registry that cannot be read. A world that cannot be removed is a 500 with a
fixed message, the Places stay merged, and the same request finishes it. What was the world's own goes with it: its name,
location, Things, share tokens, the notes on the whole Place, and the hand-set placements it kept (decision 7), which the
answer counts as `placementsRemoved`. A share link, or an editor tab, still open on the source's world is answered as any
address with no world is: `GET /worlds/:slug` builds a world with no Place (`readWorldUnlocked` and `synthesizeWorld`,
`server/main.ts`), named from the address, which holds none of what the Place's world held (its name, address, Things or
share tokens). It lists up to 24 of the stored scans that no Place holds (the ones that pass `shouldIncludeInWorld`) or, when
there are none, up to eight of the stored scans of any Place (the default world's fallback), which carry their own locations
as they do in any world, and it is saved: `GET /worlds` lists it, with `projectId` null and the scans it lists, as it lists
every world file, and not as an emptied world with no scans. That is how the server answers an address that has no world, so
it is not new to a merge, and it is not decided here: the owner may want such an address to be a 404. No route removes a
world that says it is no Place's.

**The editor's Places panel does not read the new answers yet.** `src/viewer/places.ts` calls merge and assign without looking at
the status, so a refused move is silently nothing there; it is behind `VITE_ENABLE_PLACE_COMPOSER`, which is off. WP-08c reads the
409 and sends `acceptFrameMismatch`, and the composer should stay off until that is merged.

**What this does not do, and does not claim.** A generation id says which reference a scan was measured against. It does
not say the scan is right: ADR 0005 rule 3 still decides what "verified" may mean, and nothing here changes it. An unknown
generation is not proven to be the same frame as another, only not proven different. Two legacy frames written by builds
before ids replace each other without a record, as they did; the history starts with the first id. Video and photo ingest
scans that have no `.glb` on disk are not moved by a reassign or a merge: `refreshWorldScans` keeps a row it has no file for
(a separate, older gap). The scan lists of the two worlds are only as fresh as their last read.

**Backward compatibility, and how it was checked.** Every field added is optional and absent on what is on disk. A Place,
its frame, its scans' sidecars, its world files and its photos as the previous build wrote them are read and served as
before: tests/unit/deno/frame_generations_route.test.ts seeds exactly those (a frame with no id and no revision, sidecars with
no `frameId`, world files with no history, photos in the Place's own folder) and drives the routes against the real server;
the existing frame-route and frame-sync tests, which send frames with no id, pass unchanged. A body the previous build queued
in the service worker (`{ frame, expectedRevision }`) is replayed to this server with the answers it always had. No
IndexedDB database, storage key, queue name, image name or client id was renamed.

**Adopted, not measured (ADR 0005 rule 5).** `FRAME_HISTORY_LIMIT` = 20 (the design's figure), `HAND_OVER_ATTEMPTS` = 5 and
`HAND_OVER_WAIT_MS` = 40 (a world is busy for the few milliseconds of one read or write of its file), `HAND_OVER_RETRY_FIRST_MS` =
1000 and `HAND_OVER_RETRIES` = 6 (a minute of patience for a world that is busy longer or is being repaired), the new Place
default of Building (the owner's recommendation). Each says so where it is defined. Revisit the history bound when a Place is
seen with more generations than it keeps and scans still on the oldest, and the hand-over's patience when an answer says
`pending` for a world that is not broken.

**Revisit this ADR** when a reset (wipe the reference and start again) is offered, which needs a fourth reason and a rule
for the scans it strands; when re-registration of the scans of a previous reference exists; and when the editor's
Place composer (`VITE_ENABLE_PLACE_COMPOSER`) is switched on, which should wait for the client slice's guard rails.
