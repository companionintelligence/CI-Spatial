# Privacy: what Scan collects, keeps and deletes (store note, DRAFT)

**Status: draft for the owner and for counsel. Not legal advice, not yet a published privacy policy.** It is written from
the code as it stands, so each statement can be checked against the file named beside it. Anything the code does not
settle is marked **Not verified** or **Decision**. The App Store and Google Play answers at the end follow from it and
must wait for the decision in section 1.

This is the "privacy note for store labels" of WP-15b step 1 and the conditions decision D15 was approved on: consent
with an easy way to withdraw (Apple 5.1.1(ii)), no feature held back for saying no (5.1.1(ii)), a retention and deletion
policy with a working deletion path (5.1.1(i)), minimisation (5.1.1(iii)), no camera frame sent to a hosted model without
disclosure (5.1.2(i)), no data mining of camera data (5.1.2(vi)), and a camera indication (2.5.14). Counsel's reading of
the engine licence (D16) still gates any store listing and is not part of this note.

## 1. Who runs the server (Decision)

Scan is a client for a **Scan server** that its owner runs: the Deno server in this repository, on a machine the owner
controls (usually reached over Tailscale). Everything below that says "your Scan server" means that server.

- If every person who uses the app runs their own Scan server, the developer receives none of this data, and the store
  labels for what the app sends to the server are "data not collected by the developer".
- If the developer or a publisher runs the server for other people, then the developer holds the photographs, the
  point clouds and the locations below, and the labels must say it is collected, linked to the person and not used for
  tracking.

The code does not decide this. It changes the answers in section 9, and it changes who must publish this note to whom.

## 2. What the app sends, and where

Only to your Scan server unless section 7 says otherwise. "When" is what the person did to make it happen.

| Data | When | Goes to | Code |
|---|---|---|---|
| **Camera frames** (keyframes): JPEG photos, at most 1280 px on the long edge, each with the phone's pose, the camera's field of view, the time and the tracking epoch | Only while the stream is on, and only on a device that has agreed (section 3) | `POST /sessions/:id/keyframes` | `src/capture/keyframes.ts` |
| A scan: point cloud, camera path, floor height, detected objects (label, position, confidence, a small photo crop of each), the calibration, a quality summary, and where it was taken (latitude, longitude, accuracy, compass bearing, street address) | When the person exports | `POST /upload-scan` | `src/export/gltf.ts` |
| One photo per capture, for object detection | When the person captures, in server detection mode (the default). Not sent in on-device mode | `POST /infer` | `src/inference/server.ts`, `src/inference/router.ts` |
| A Place: its name, address, notes, floors and areas, the frame a calibration made, and two **reference photos** (the landmark and the heading marker) | When the person creates or calibrates a Place | `POST /projects`, `PUT /projects/:id`, `POST /projects/:id/reference-photos` | `src/main.ts`, `server/project_media.ts` |
| Photos or a video the person chose to upload, and a person clip with its camera track | When the person chooses them | `POST /ingest-photos`, `POST /ingest-video` | `src/capture/clip-upload.ts`, `src/main.ts` |
| A written summary of a session, with its address | When the person exports it | `POST /upload-summary` | `src/export/summary.ts` |
| The phone's console log | Only with `?debug=remote`, a developer switch | `POST /client-logs` | `src/debug/remote-log.ts` |

On the phone itself the app keeps captures and detections (IndexedDB `ci-xr-scan`), Places and their reference photos, the
list of scan sessions it streamed to (below), settings, and, for the offline queue, up to 24 requests for up to a day
(`public/sw.js`). The iOS app also keeps ARKit's world map of each named Place the scanner runs in
(`Application Support/ScanWorldMaps/<world slug>.worldmap`, and one previous copy), saved every minute while a session runs and
when the app goes to the background (ADR 0010): ARKit's archive of what it mapped of the room, left out of iCloud and device
backups and never sent anywhere. Nothing in the app deletes it; removing the app does. The Android plugin can keep the pose and
heading of one origin anchor in `scan-origin-anchor.json` in the app's files directory (`mobile/README.md`), which is left out of
backup too; nothing in the scanner asks it to yet. The scanner has no analytics, advertising or crash-reporting library: none is in `package.json`, the
Android build (`mobile/android/app/build.gradle`) or the iOS packages (`mobile/ios/App/CapApp-SPM/Package.swift`).

## 3. Camera frames and consent

A camera frame is a photograph of the inside of a home. It can show people, screens and papers.

- **What the person is told.** The side panel has a "Camera frames" row, always on screen, with a switch and one line: what is
  sent, where it goes, what for and that it can be turned off. A tap on Stream shows the full words before anything is
  sent. The words are in `KEYFRAME_CONSENT_COPY` (`src/capture/keyframe-consent.ts`) and say, in short: camera photos and
  where the phone was go to your Scan server to build 3D models; photos can show people, screens and papers; they go only
  to your Scan server; turning it off stops sending at once; frames already sent stay on your server until deleted.
- **The default.** Streaming has always been **off** until a person taps Stream: that is the only start in the scanner
  (`src/main.ts`, the `#stream-btn` handler). Decision D15 makes it **on by default for a scan in a Place**. That is
  built as: on only when this device has agreed, otherwise off. A device that has not agreed, or has withdrawn, starts
  nothing on its own and is not asked until the person taps Stream. A scan outside a Place does not start on its own either.
- **Per device, and per Scan server.** The answer is kept on the device (`localStorage`, `companion-scan-keyframe-consent`)
  with the time, the version of the words it was given for and the Scan server the dialog named. A change to what is sent
  or why raises the version (`KEYFRAME_CONSENT_COPY_VERSION`) and everyone is asked again. A yes is for the server it was
  given to: when the app is pointed at another one (the native app's Scan server setting), the yes stops counting, sending
  stops, the switch reads off and the person is asked again; pointed back, the yes counts again. A withdrawal is never turned
  back into a yes, by a new version or another server. A phone that cannot store the answer asks again on the next visit.
- **No feature depends on it.** Scanning, calibration, export, the editor and every job work the same whether the
  answer is yes, no or never given. The only thing that waits for a yes is sending frames. A test holds this
  (`tests/unit/node/wp-15b-keyframe-controller.test.ts`, the "source shape" tests): nothing but the consent modules and
  the panel row reads the answer. One thing did depend on it by accident and no longer does: the scan's quality verdict
  added "Stream RGB keyframes for reconstruction" to every scan with no frames, which made it read "Review" on a phone that
  had not agreed to send them. The advice is now given only while frames are being sent and none has reached the server
  ("No camera frame has reached your server yet"), and a scan with no frames reads as it would with them
  (`src/capture/quality-monitor.ts`, `tests/unit/node/wp-15b-keyframe-quality.test.ts`). What the answer cannot do is conjure the frames: a reconstruction job (LingBot-Map,
  COLMAP, splat training) on a scan whose frames were never sent has nothing to work from, and says so in the message it
  already gives ("requires RGB keyframe observations"). The same jobs run on the frames of a video or photo set the person
  uploads, which needs no consent because the person chose those files. No feature is paid for, so nothing paid waits on the answer.
- **Withdrawing.** Turning the switch off, from this phone or from another tab on it, stops sending at once: nothing waiting
  in the streamer is sent, the upload in flight is cancelled, and the frames the service worker was holding for when the
  phone is back online are removed instead of sent (`KeyframeStreamer.abandon`, `dropQueuedKeyframes` in `public/sw.js`).
  The recommended and implemented choice for what is already on the server: **it stays until deleted, and the person can
  delete it with one more tap.** The same row then offers "Delete frames this phone sent", which asks to confirm and
  names each session this phone remembers sending to the server in use (kept on the phone,
  `companion-scan-keyframe-sessions`, with the server each was sent to) to `DELETE /sessions/:id`. Deleting is
  never a side effect of turning the switch off: the frames a scan was built from are that scan's data, and a person
  who only wants sending to stop should not lose the model of a room they still want. A stream that is running is stopped
  first, because the session being sent is one of those deleted, and the confirm says so.
  **That list is the phone's own and is not complete, and the words say so** (the confirm says "this phone remembers
  sending", and the row says what the list leaves out): it keeps the newest 500 sessions and counts the older ones it let
  go of; builds before this one did not keep it; a phone whose storage was cleared has none; and a session sent to another
  Scan server is not asked about here (that server would answer "not found", which would read as deleted). What the list
  cannot name goes with its scan, with the retention setting, or through the server.
- **Other clients of the same routes.** The gimbal grid capture and the ingest scripts (`scripts/ingest-*.mjs`) post to the same
  session routes from the owner's own hardware. They are not the phone app and are not asked: the consent here is the phone
  app's, for what a phone sends from a pocket or a hand.
- **What the person sees while it runs.** The Stream button turns green with a count of frames sent, and the row says
  "Sending frames. 12 sent", adding how many were skipped because uploads lagged and how many failed.

## 4. Retention

The setting is the server's `KEYFRAME_RETENTION_DAYS` (`.env.example`, `server/keyframe_retention.ts`).

- **Unset, `off` or `keep`: keep.** The default, because how long a person's own server holds their own rooms is the
  owner's call (Decision: the period). Frames then stay until their scan is deleted. `0` is not accepted: it reads as "no
  limit" to one operator and "keep none" to another, so it keeps everything and the log says so. To keep everything, leave it unset.
- **A number of days turns on a purge** of capture sessions whose last activity (the session's `startedAt` and
  `finalizedAt`, and the modification times of `session.json` and `keyframes.jsonl`) is older than that. A session
  being streamed to, or streamed or finalized this period, is not old. Work a job did on the session later does not
  count, and a purge removes what a job wrote in the folder with the frames. A value that is not a whole number of days
  from 1 to 36500 is ignored with a warning: a typo deletes nothing.
- **It is a WorldJob** (`keyframe-purge`, ADR 0003), queued at boot and once a day, run one at a time with every other job so it
  never removes a session a reconstruction job is reading. It is queued in the default world only. **A request is a dry run
  unless it says `dryRun: false`** (the boolean): a payload that is missing, empty or spells the flag another way (`"true"`, `1`,
  `"yes"`) reports and removes nothing. A real pass takes its period from the server's environment alone. A dry run may name
  `days` to show what a period would remove **before the setting is turned on**, so the first purge need not be the first look:

  ```bash
  curl -X POST "$SCAN_SERVER/worlds/default/jobs" -H 'Content-Type: application/json' \
    -d '{"type":"keyframe-purge","payload":{"dryRun":true,"days":30}}'
  curl "$SCAN_SERVER/worlds/default/jobs"   # the job's `result` is the report, and says if the setting is off
  ```
- **What it never removes.** A session that is a scan's own source (a video, photo set, tripod sweep or person clip a
  person uploaded; their records say `source` or `captureKind`): that is the scan, and deleting the scan deletes it.
  Anything that is not a real session folder directly under the sessions folder. Anything at all when the sessions folder
  is not inside `SCANS_DIR`.
- **Side effect.** A purge removes the whole session folder, including what a job wrote there (poses, a LingBot-Map or
  COLMAP point cloud). A job that needs the frames afterwards fails with the message it already gives for a session with
  no frames ("requires RGB keyframe observations"). Files a job wrote beside the scan (`<scan>.lingbot.glb`, a splat) are
  not in the session folder and stay until the scan is deleted.
- **It logs counts and nothing else**, for example "Retention 90 days: deleted 12 of 340 capture sessions (1.4 GB). Kept 8
  newer or undated and 3 that are a scan's own source. 0 could not be deleted." No session, scan, path or place is named.

## 5. Deletion

| Action | What it removes | Code |
|---|---|---|
| `DELETE /scans/:filename` | The GLB and its sidecar; the optimizer's files; **LingBot-Map's point cloud** (`.lingbot.glb`); **every file a splat job made from the scan** (`.splat.ply`, `.sog`, `.compressed.ply`, their manifests, `.interactions.json`) and a person scan's `.4d/` folder; **the folders SenseNova wrote for the scan's finished jobs** (`.sensenova/<jobId>/`); **the camera-frame sessions only that scan names**; **every world export that holds a copy of it** (`<world>.world.glb`, built again on request), found by what the export holds and not only by which worlds list the scan now, so the export of a world the scan was moved out of goes too, and so does an export that cannot be read as an export, because it cannot be shown not to hold the scan (it goes with a scan that was found: its files or camera frames, a world that lists it, or an export that names it, and the answer's `worldExports` counts every export removed; a request for a scan that is not there is a 404 and removes nothing, whatever exports are in the folder); and the scan from every world: its row, its jobs, its comments and its patches, the placement a move kept in the world it left among them. A session another scan still names is kept, and the answer says which scan holds it. **Refused (409) while a job is running on the scan** (the answer names the job); jobs still waiting for it are cancelled. A scan whose files are already gone but that a world still lists is taken out of the world | `server/scan_deletion.ts`, `server/scan_job_guard.ts`, `server/scan_world_side.ts`, `server/session_deletion.ts` |
| `DELETE /sessions/:id` | One session's frames, poses and job output. Refused (409) for the session an upload is made from. 404 once it is gone | `server/session_deletion.ts` |
| `DELETE /scans?confirm=delete-all` | Every scan, the files the splat and person jobs made from them, `.sensenova/`, every world export, every session, and a scan upload that was cut short; and from every world its scan rows and its scan jobs, and, for a world that held scans, every patch that is not about the whole world (a Thing's relabel is one), its comments and the origin inferred from the scans' locations. A world that holds no scan row, because every scan was moved out of it, is cleaned of what names a scan as well (the placements a move kept, the notes a move handed over, the comments on a scan) and keeps the rest. Refused (409) while a job runs on any scan. A scan still arriving keeps its file. Places and their reference photos stay | `server/scan_deletion.ts`, `server/main.ts` |
| `DELETE /projects/:id` | The Place's **reference photos**, **its world** (`worlds/project-<id>.json`: its name, latitude, longitude and street address, its Things and their observations, comments and share tokens) with the **export** built from it, and then its registry entry, in that order, so a failure (500, a fixed message) leaves a Place that can be deleted again. The save that takes the entry out does not keep the registry it replaces as `projects.json.bak`, which still holds the Place's name, address and location: the backup is made the registry as saved, before the registry is replaced, so it holds no Place the registry does not (a failure there is the same 500, with the Place still listed). A registry that cannot be read is the exception: the backup is left as it was (see `projects.json.bak`, below). A request for that world's address afterwards builds a new world, as it does for any name; it holds none of what the Place's world held (its name, address, Things, comments or share tokens), and lists the stored scans a world for any name lists, which carry their own locations as they do in any world (see "What deletion does not do", below). Refused (409) while the Place holds any scan, an upload scan included (they have no GLB, so they were not counted before). **A Place that is not in the registry** (a merge took it out) is still answered: a world of it that is left, with its export, and its reference photos, are removed (200, `worldsRemoved`), after the notes of the scans that world still lists have been handed to the Place those scans are filed under; refused (409, a fixed message, the world kept as it is) while they cannot be, and 404 when nothing of the Place is left. Only a world that says it is that Place's is touched, and none is while the registry cannot be read (an unreadable registry reads every Place as gone: the answer is the 500 and nothing is removed) | `server/main.ts`, `server/place_deletion.ts`, `server/wp-a-projects.ts` |
| `POST /projects/:id/merge` | The merged-away Place's **reference photos**, first; its registry entry (the registry's backup is made the registry as saved, as above); and, after the scans have been filed under the target and their notes handed to its world (ADR 0011), the merged-away Place's **world and its export**. The answer says `sourceWorldRemoved`: `false` when the world was kept, because a scan is still listed in it (its hand-over is waiting for the other world, or it is an upload with no GLB yet, which a merge never moves), because a job is queued or running in it, because a scan's record still names the Place, or because the registry cannot be read. Asking for the same merge again removes it once nothing is in the way; `DELETE /projects/<the merged-away id>` removes it unless a scan's record still names the Place or the notes of a scan with a file are waiting to be handed over (409 in both). A world that cannot be removed is a 500 with a fixed message, the Places stay merged, and the same request finishes it. The placements a person set by hand over a scan against the merged-away world's origin (ADR 0011 keeps them in that world, and the answer says `handOver.placementsKept` while the world stays) go with the world: the answer does not report them as kept, and counts them as `placementsRemoved`, from the world's own file as it is removed, so a repeat of the merge counts them too | `server/main.ts`, `server/place_deletion.ts` |

How a scan finds its sessions: its own sidecar names one; every session finalized against it names it; and every session that
**follows** it names it. One scan can have several sessions, because the scanner closes a session and opens another after each
export (audit W4-4), so the session open when a walk ends holds the frames taken after the last export and never had a scan of
its own. The streamer finalizes it with `followsGlbFilename`, the scan the stream last exported, in a field of its own (`glbFilename`
keeps its one meaning, the scan made from the session), so deleting that scan takes the trailing frames of the walk with it. A scan that is
still being uploaded (its sidecar is in place, its `.part` is not yet renamed) counts as a user of its sessions for up to an hour,
so deleting another scan that shares one does not take the frames of a scan a moment from being published. The sessions and everything
made from the scan go **before** the scan's own GLB and sidecar (which go last, and only when nothing else failed), and inside a session
`session.json` goes with the folder, after the frames, so a deletion that stops half way leaves a scan that can be deleted again and a
session that can still be found; a file a job writes while the session is being
removed is taken with the folder. A failure is reported (500, with counts, no path) and the scan is kept: a file that cannot be
removed is never answered with a 200. A world file that cannot be read or written is a failure too: the answer is a 500 with a fixed message (the scan's
own files are gone by then, and a second try takes it out of the world). Deleting twice is a success. A job running on a scan would write its outputs after the delete,
which is why the delete is refused then, and why the pump does not start a job for a scan being deleted. All the routes sit behind the
same Companion session guard as the scan routes: once sign-in is on, or `SCAN_REQUIRE_AUTH=1`, none answers without a session.

**The policy for a Place:** deleting a Place never removes keyframes by itself, and never leaves them behind. It is refused while
the Place holds a scan; each scan takes its own frames with it when it is deleted; the reference photos and the Place's world belong
to the Place and go with it, before its registry entry. A merge is a deletion of the merged-away Place, and its world goes with it
once what is in it has been handed over.

**What deletion does not do (read before publishing):**

- **A walk that never exported anything** (the stream ran, the page ended, no autosave or export happened) streamed frames that
  name no scan. Nothing deletes them but the retention setting, `DELETE /sessions/:id`, and "Delete frames this phone sent" (for the
  sessions that phone remembers). This is audit W4-4, still open: one session per scan is not built.
- **Things and their observations** (an object's label and position, found in a scan) stay in a Place's world after a scan is deleted,
  until the Place is deleted. Running the thing-correspondence job again rebuilds the observations from the scans that are left. They
  are not photographs, and removing them changes the editor, so it is a decision.
- **A merged-away Place's world** is removed by the merge, with its export, once nothing in it is waiting (the `POST /projects/:id/merge`
  row above). Until then it stays, with what it holds: the Place's name, location, Things and comments, which `GET /worlds/<slug>` answers to a
  request that carries no token, and its share tokens, which the file holds and that route holds back from such a request. A merge does not hand those over (it hands over a scan's notes, comments and finished jobs): they go with
  the world, as do the notes on the whole Place and the placements a scan had against that world's origin. A world an earlier build's merge left
  (the registry has no such Place) is removed the same way, by `DELETE /projects/<id>` or by asking for the merge again. A world that says it is
  another Place's, which an earlier build's merge re-labelled into it, goes with that Place's deletion.
- **`projects.json.bak` and `projects.json.corrupt-<time>`.** Every save of the Places registry keeps the registry it replaces as
  `projects.json.bak`, so a bad save can be undone; that copy holds every Place that was in the registry, with its name, address and location, until
  the next save. A save that removes a Place (`DELETE /projects/:id`, and the merge) does not keep it: the backup is made the registry as saved. When the
  registry file cannot be read, the first save keeps a copy of its bytes as `projects.json.corrupt-<time>` before it writes a new one, and leaves the
  backup as it was, whatever the save is: the registry written over an unreadable file was built from nothing that could be read (an empty list and the
  default Place), so the backup, the last registry that could be read, is the only copy of the Places the file held, and a save that removed the one
  Place it can find there, the default Place, does not replace it. In that case the backup can still hold the default Place's record. The
  `.corrupt-<time>` copy is the owner's: it holds whatever Places the unreadable file held, no deletion reads, changes or removes it, and it stays
  until the owner removes it.
- **A world that has gone is built again when its address is asked for** (a stale link, an open editor tab). The new world holds none of what the Place's
  world held (its name, address, Things, comments or share tokens), and it lists up to 24 of the stored scans that no Place holds (the ones that look like
  scans) or, when there are none, up to eight of the stored scans of any Place, which carry their own locations as they do in any world: a world for any
  name does, and `GET /worlds/<slug>` answers a request that carries no token. That is how the server builds a world with no Place, and a deletion does
  not change it.
- **SenseNova folders** are found through the scan's jobs in its worlds. The folder of a job that has aged out of a world's job history is
  not found by a single-scan delete; "clear all scans" removes the whole `.sensenova/` folder.
- No button in the editor or the scanner calls `DELETE /scans/:filename` today. The only in-app deletion of server data is
  "Delete frames this phone sent". Wiring "Delete from server" into the scan list is a UI task (Decision: where).
- The phone's own copy (the history drawer, "Clear session") is separate: its confirm already says copies on the server stay.
- Copies a person made are theirs: a downloaded GLB, a shared export, and anything pushed to Companion Memory.
- Backups of the server's disk are the owner's.

## 6. Minimisation (5.1.1(iii))

The frame stream is capped and thinned by the code: a frame is taken only after the camera has moved 0.30 m or turned 20 degrees,
at most one per 1.2 s, at most 1280 px on the long edge, JPEG quality 0.8, with at most three waiting (a frame is skipped, not
queued, when uploads lag), and the server refuses a session past 2 GiB (`KEYFRAME_SESSION_MAX_BYTES`) or 2000 frames. The stream
pauses while the page is hidden. These are limits, not measurements of need: how few frames registration actually requires is
an open question (DX9).

## 7. Third parties

The camera frames themselves go to your Scan server and to no other host: the server runs LingBot-Map, COLMAP, Brush and the other
jobs as local tools, and no server module sends a keyframe elsewhere. The app does contact other services, and the brief for this note
said there are none. That is not so:

| Service | What it receives | When | Code |
|---|---|---|---|
| **OpenStreetMap Nominatim** (`nominatim.openstreetmap.org`) | The phone's latitude and longitude, to six decimal places (about 0.1 m), the page's origin as Referer, and a fixed User-Agent | Each address lookup, once a GPS fix exists. The iOS location prompt says the app "looks up its street address" | `src/geo/geo-tracker.ts` (documented there as F117) |
| **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) | The device's IP address and user agent, to serve the Manrope typeface | When a page loads, unless offline | `index.html`, `viewer.html` |
| **CARTO map tiles** (`basemaps.cartocdn.com`) | Which map tiles are requested, so roughly where the map is centred, and the IP address | When the history drawer's map or the editor's map is shown | `src/main.ts`, `src/viewer/geomap.ts` |
| **Google Play Services for AR (ARCore)**, Android app only | Whatever Google's service collects, under Google's privacy policy | While AR runs | Disclosed in the app's Legal notices (`src/ui/legal-notices.ts`) |

**Not verified:** whether the vendored 8th Wall XR Engine (`public/xr.js`) makes any network request of its own. It cannot be
read for this (the licence bars it and counsel has not answered), so it needs a network capture on a device (below).

Optional, and only if the owner turns them on: Companion Account sign-in with the Companion Portal; pushing a finished scan
(its GLB, splat and detections, not the camera frames) to Companion Memory (`server/memory_push.ts`); off-box person
reconstruction on the host named by `FDANYONE_HOST`, which receives the person clip; and the model host in `OLLAMA_HOST`, which
receives each capture photo for detection and defaults to the same machine. Frames sent to a model host the owner
points at a hosted API would be a 5.1.2(i) disclosure; nothing in the code does so by default.

No camera, depth or ARKit data is used for advertising, marketing or data mining (5.1.2(vi)), and none is sold or shared for
tracking: there is no code that does either.

## 8. Camera indication (Apple 2.5.14)

- While the scanner runs, the live camera picture is the screen's background (letterboxed on some phones). That is the indication inside the app.
- Frames are sent only while the page is in the foreground (the stream pauses when it is hidden), and only while the Stream button
  is green and the row says "Sending frames".
- The operating system's own camera indicator (the iOS dot, Android's privacy indicator) is the platform's. **Not verified:**
  it has not been seen on a device with this build (see below).
- The iOS camera prompt (`NSCameraUsageDescription`) reads "Scan uses the camera to record the walkthrough of a room." It does not
  say that photos can be sent to a Scan server. **Decision:** change it before submission to something like "Scan uses the
  camera to record the walkthrough of a room. If you allow it, photos from the camera are also sent to your Scan server to build
  3D models." It is not edited here because it changes the shipped iOS app.

## 9. Store answers (DRAFT, after section 1)

**Apple App Privacy** (if each person runs their own server, the developer collects none of these; the rows say what is collected if
the developer hosts):

| Data type | Collected | Linked to the person | Used for tracking | Purpose |
|---|---|---|---|---|
| Photos or videos (keyframes, reference photos, uploads) | Yes | Yes | No | App functionality |
| Precise location | Yes | Yes | No | App functionality |
| Other user content (scans, detected objects, summaries) | Yes | Yes | No | App functionality |
| Other data: the Place names, addresses and notes | Yes | Yes | No | App functionality |
| Identifiers, usage data, diagnostics, contacts | No | | | |

`PrivacyInfo.xcprivacy` is drafted (`mobile/ios/App/App/`, in the Xcode project's Resources) with no collected data types and an empty list of required-reason API declarations; the draft's comment lists what the owner must decide (`mobile/README.md`, Not done).

**Google Play Data safety:** the same rows. Data shared with third parties: precise location (Nominatim, to look up an address),
and the approximate map area (CARTO). Camera frames are not shared. Encryption in transit follows the server's HTTPS (Tailscale
certificates); the app refuses a plain-http Scan server address (`src/ui/server-setting.ts`). Deletion: the routes in section 5;
there is no account to delete.

## 10. Open items

| Item | Who | Needs |
|---|---|---|
| Who runs the server, which sets the store labels (section 1) | Owner | Decision |
| The retention period (section 4), default today: keep | Owner | Decision |
| `NSCameraUsageDescription` text (section 8) | Owner | Decision, then an edit in `mobile/ios` |
| A scan-delete control in the editor, and whether Things and their observations stay after their scan is deleted (section 5) | Owner | Decision |
| One keyframe session per scan, so that a walk's frames are one thing to delete (audit W4-4, section 5) | Engineering | Before default-on ships widely |
| Counsel's read of the engine licence and of section 7 (D16) | Counsel | Gates every listing |
| Whether the engine contacts a Niantic service; the OS camera indicator; a `?debug=remote`-free run of the whole scan flow with a network log | Device | A phone and a proxy log |
| When server registration starts to use camera frames to line scans up, the consent words change and `KEYFRAME_CONSENT_COPY_VERSION` becomes 2 | Engineering | Before WP-15b slice 2 ships |
