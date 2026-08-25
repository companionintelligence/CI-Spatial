> **Type:** Backend
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/durable-person-clips`
> **Commit style:** `feat(server): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (take vocabulary), 0003 (what gets uploaded); gated on device check C1

## Goal

Accept a person clip and **keep it**. Today `/ingest-video` treats an uploaded video as scratch —
it extracts keyframes and deletes the file. For person capture the clip *is* the durable
artifact, because 4DAnyone consumes the video itself, not frames. This ticket adds a person mode
to the existing route, durable clip storage, video mime types, and the ranged serving the repo
has never had.

## The behaviour being changed, precisely

`server/main.ts:1048-1051`:

```ts
} finally {
  // Always drop the temp video — the keyframe session is the durable artifact.
  await removeIfExists(tmpVideo)
}
```

That comment is correct for walkthrough ingest and wrong for person capture. **Do not delete the
comment or flip it globally** — both statements are true, for different modes. Make the mode
explicit and let each keep its own contract.

## Non-goals

- Do not change walkthrough-video behaviour. An upload without a person/take mode must extract
  keyframes and delete the temp file exactly as it does today, including auto-enqueuing
  `lingbot-map-reconstruct`.
- Do not add a parallel `/ingest-person` route. See Pinned conventions.
- Do not run any reconstruction here. Enqueuing `person-4d-reconstruct` is 0005's job; this
  ticket stops at "the clip is stored, findable, and servable".
- Do not route clips through the service-worker offline queue. See Q&A — this is deliberate.
- Do not add resumable/chunked upload. No such protocol exists anywhere in the repo and adding
  one is its own ticket; if clip sizes demand it, that is a finding, not scope creep to absorb.

## Pinned conventions

**ADR 0001** — touches a client↔server connection, storage layout, and config.

*Route.* Searched for an existing video-upload surface before adding one: `POST /ingest-video`
(`server/main.ts:954`) already does multipart video upload with a Content-Length precheck, an
extension allowlist, temp buffering, and Place/Area association. **Extend it with a mode rather
than adding a route.** `POST /ingest-photos` (`:1064`) is the sibling precedent for how a second
ingest shape reuses the same machinery.

*Storage.* Clips live under the existing session directory, not a new tree:
`$SESSIONS_DIR/<sessionId>/clip.<ext>` plus `pose-track.json`. `SESSIONS_DIR` resolves as
`Deno.env.get('SESSIONS_DIR') ?? \`${SCANS_DIR}/sessions\`` (`server/main.ts:175`) — and note
`scripts/ingest-video.mjs` carries a long comment about why it must resolve this **identically**,
because a deployment that sets them independently otherwise lands keyframes where nothing looks
for them. Any new writer must match that resolution exactly.

*Filename safety.* Follow `KEYFRAME_FILE_RE` (`server/main.ts:782`) and the traversal guard used
on every artifact route: reject a filename containing `/`, `\`, or a leading `.`. Reuse
`roleForReferencePhotoFile()`'s approach from `server/project_media.ts:75` — an **allowlist, not
a sanitiser**. Clip filenames are server-chosen, never client-supplied.

*Mime.* Extend `SPLAT_ARTIFACT_MIME` (`server/main.ts:650`) with `video/mp4` and `video/webm`,
and add the suffixes to the artifact route regex at `:661`. That table is ordered
specific-before-general and the route is deliberately registered **before** the `.glb`-only route
so these suffixes win (see the comment at `:645-649`).

*Extension allowlist* stays `/\.(mp4|mov|m4v|webm|avi|mkv)$/i` as at `server/main.ts:994-997`,
but the **stored** extension derives from the client-reported mime type (0003 persists it), not
from the uploaded filename.

*Limits.* `INGEST_MAX_VIDEO_BYTES` defaults to 1.5 GB (`server/main.ts:181`). It is currently
undocumented in `.env.example` — document it as part of this ticket.

*Serving.* Ranged responses must be a shared helper, not inlined into one route. Nothing in the
repo does ranges today (no `Accept-Ranges`, `Content-Range`, or `206` anywhere in `server/`), so
this is genuinely new — write it once, unit-test it, and leave the existing full-buffer routes
alone rather than opportunistically converting them.

## Before implementation

- `server/main.ts:944-1052` — the whole `/ingest-video` route, especially the Content-Length
  precheck at `:956-960`, the post-parse `video.size` recheck at `:969`, and the `finally` at
  `:1048`.
- `server/main.ts:1064-1168` — `/ingest-photos`, the precedent for a second shape on shared
  machinery.
- `server/main.ts:645-700` — the artifact mime table, the suffix-regex route, and the ordering
  comment.
- `server/main.ts:852-874` — `/sessions/:id/keyframes/:file`, the closest existing per-session
  file server.
- `scripts/ingest-video.mjs` — its header, the `SESSIONS_DIR` resolution comment, and the
  contract that its **last stdout line** is the JSON summary the route parses.
- `public/sw.js:58-71, 155-227` — `QUEUEABLE_WRITE_PREFIXES`, the count/age bound, and
  `queueRequest()`'s whole-body `arrayBuffer()`.
- `src/shared/offline-queue.ts` — `QUEUED_OFFLINE_HEADER` and why `resp.ok` is not enough.
- `docs/adr/0004-world-file-writes-are-serialized-per-slug.md` — any world write goes through
  `updateWorld`, with no I/O inside the mutator.

## Open questions & answers

- Q: Should person clips go through the service-worker offline queue so a lost connection does
  not lose a take? — A: **No.** `public/sw.js:50-57` explains the queue is bounded by count and
  age rather than bytes *precisely* because measuring bytes means reading every queued body into
  memory — the allocation the cap exists to prevent. `queueRequest()` does
  `await request.clone().arrayBuffer()` into IndexedDB; a 1080p clip through that is exactly the
  failure it guards against. `/ingest-video` is correctly absent from
  `QUEUEABLE_WRITE_PREFIXES`, and must stay absent. Losing a clip on a dropped connection is a
  real cost, and the honest mitigation is retry-with-progress in the client, not the queue.
  (Decided in this ticket.)
- Q: Then does this route need the `QUEUED_OFFLINE_HEADER` dance? — A: Only if a clip upload
  ever lands under a queueable prefix such as `/sessions/...`. It does not — it stays on
  `/ingest-video`. Note it here so a later refactor that moves the route does not silently
  inherit the "202 means queued" ambiguity that `src/shared/offline-queue.ts` exists to resolve.
  (Decided in this ticket.)
- Q: Why does serving a clip need ranges at all — the processing subsystem fetches it once? — A:
  Because the *editor* will want to scrub it as a reference beside the reconstruction, and
  because every artifact route today does `Deno.readFile` fully into RAM. A handful of concurrent
  clip requests at full buffer is a straightforward way to exhaust the box. Ranges are the fix
  for both. (Decided in this ticket.)
- Q: Does a person clip create a `ScanManifest` / register a scan, the way video ingest does? —
  A: Yes, for the same reason walkthrough ingest does: a scan is how a capture becomes visible in
  a Place, and the 4D asset needs somewhere to hang. Reuse `registerSessionScan()` with a source
  discriminator so the editor can tell a person capture from a room scan. Do not invent a
  parallel registration path. (Decided in this ticket.)
- Q: Should keyframes still be extracted for a person clip? — A: Yes, cheaply — a handful for
  thumbnails and for the editor's preview, via the existing `scripts/ingest-video.mjs` at a low
  fps. But **not** as the durable artifact and **not** to feed `lingbot-map-reconstruct`, which
  is a place-reconstruction job and has nothing to say about a person. Suppress that
  auto-enqueue in person mode. (Decided in this ticket.)
- Q: What if C1 (0003) says iOS can only record sub-720p? — **OPEN until C1 runs.** It does not
  change this ticket's storage or serving work, but it does change whether person mode should
  reject an under-spec clip at upload or accept it with a recorded warning. Default to accepting
  and recording the measured resolution, so data is never destroyed by a policy decision made
  before the measurement existed.

## Files impacted

New:
- `server/http_range.ts` — parse `Range`, build a `206` with `Content-Range`; pure, unit-tested
- `tests/unit/deno/http_range.test.ts`
- `tests/api-person-capture.spec.ts` (one consolidated spec for the whole wave, rather than one per ticket)

Changed:
- `server/main.ts` — person mode on `/ingest-video`; clip persistence; clip serving route; mime
  table and route regex
- `scripts/ingest-video.mjs` — a low-fps/thumbnail mode flag; must not change default behaviour
- `.env.example` — document `INGEST_MAX_VIDEO_BYTES` and `SESSIONS_DIR` interaction
- `src/world/types.ts` — the scan-source discriminator, if not already expressible

## Schema required

No new type. On-disk layout extends the existing session directory:

```
$SESSIONS_DIR/<sessionId>/
  clip.mp4 | clip.webm      # the durable artifact — NOT deleted
  pose-track.json           # from 0003
  kf-00000.jpg …            # a few thumbnails only, in person mode
  keyframes.jsonl
  session.json              # gains takeId/clientId (0001) and sync (0002)
```

Request additions to `POST /ingest-video` (multipart, all optional — absent means today's
behaviour):

```
mode:      'walkthrough' | 'person'    // default 'walkthrough'
takeId:    string                      // 'take-<8 hex>'
clientId:  string
poseTrack: File                        // pose-track.json from 0003
mimeType:  string                      // client-negotiated; the server does not guess
```

Response stays `202` with the existing shape plus `clipUrl`.

## Definition of Done

- [x] `mode=person` stores the clip durably under the session dir and does **not** delete it
- [x] `mode=walkthrough` (and an absent mode) behaves exactly as today, including the temp-file
      delete and the `lingbot-map-reconstruct` auto-enqueue
- [x] `takeId`, `clientId`, and the pose track are persisted with the session
- [x] `video/mp4` and `video/webm` are in the mime table and the artifact route regex
- [x] A clip is servable, with `Accept-Ranges: bytes` and correct `206`/`Content-Range` for a
      ranged request, and a correct `416` for an unsatisfiable one
- [x] Ranged serving is a reusable helper with its own unit tests, not inlined
- [x] Person mode registers a scan via `registerSessionScan()` with a source discriminator, and
      does not enqueue `lingbot-map-reconstruct`
- [x] `.env.example` documents `INGEST_MAX_VIDEO_BYTES`
- [x] `deno task check` and `deno task test` pass

## Tests

- [x] Unit (`http_range.test.ts`): `bytes=0-`, `bytes=100-199`, `bytes=-500`, a suffix range
      longer than the file, an unsatisfiable start, and a malformed header each produce the
      correct status and headers
- [x] Unit: a request with no `Range` header still returns `200` with `Accept-Ranges: bytes`
- [x] Playwright (`api-person-capture.spec.ts`): upload a small fixture clip in person mode; assert
      the clip persists on disk, is servable whole and ranged, and the pose track round-trips
- [x] Playwright: upload the same fixture in walkthrough mode; assert the temp file is gone and a
      `lingbot-map-reconstruct` job was enqueued — the existing behaviour, unchanged
- [x] Playwright: an over-limit Content-Length is rejected `413` before the body is buffered
- [x] Playwright: a filename containing `..`/`/` cannot escape the session dir on the serve route
- [x] Regression: the existing video-ingest specs pass unedited

```bash
deno task check
deno task test
npx tsc --noEmit
npx playwright test tests/api-person-capture.spec.ts --project=api
```

## Acceptance Criteria

- [x] Given a person-mode upload, When it completes, Then the clip exists under the session
      directory after the request returns and is fetchable by URL
- [x] Given a walkthrough-mode upload, When it completes, Then no video file remains on disk
- [x] Given `Range: bytes=0-1023` on a clip, When served, Then the response is `206` with
      `Content-Range: bytes 0-1023/<size>` and exactly 1024 bytes
- [x] Given `Range: bytes=99999999-` on a smaller clip, When served, Then the response is `416`
- [x] Given two clips uploaded with the same `takeId`, When the sessions are listed, Then both
      are grouped under that take (0001's grouping, exercised end to end)
- [x] Given a person-mode upload, When it completes, Then no `lingbot-map-reconstruct` job exists
      for that scan

## Risks / potential issues

- **Risk:** Clips accumulate without bound. Nothing in this repo prunes session directories, and
  a 1080p clip is orders of magnitude larger than the JPEG keyframes that layout was sized for.
  beta-1's disk is already at 89%. — **Mitigation:** out of scope to solve here, but **must not
  be silent**: state the growth characteristic in `docs/pipelines/4d-person.md` (0008) and record
  it in the wave's "Found and deferred" as retention policy work.
- **Risk:** Making `/ingest-video` modal adds a branch to a route that already has two size
  checks, a temp file, a subprocess, and a `finally`. Modal routes rot. — **Mitigation:** keep
  the mode decision at the top and factor the two tails into named functions rather than
  threading `if (mode === 'person')` through the body; the walkthrough tail must stay literally
  the same code path.
- **Risk:** Range parsing is easy to get subtly wrong (off-by-one on inclusive ends, multi-range
  requests, `bytes=-N` suffix semantics). — **Mitigation:** the unit test list above covers each
  case explicitly; reject multi-range with `200` and the full body rather than implementing
  multipart byte ranges.
- **Risk:** A dropped connection mid-upload loses a take that cannot be re-shot, and the offline
  queue is deliberately unavailable. — **Mitigation:** client-side retry with progress (the XHR
  path in `src/main.ts` already reports `upload.onprogress`); state plainly that an interrupted
  clip upload must be retried from the device while the app is still open.
- **Risk:** `SESSIONS_DIR`/`SCANS_DIR` divergence silently lands clips where nothing looks for
  them — the exact failure `scripts/ingest-video.mjs` documents. — **Mitigation:** resolve
  through the same helper the server already uses; add a test that sets the two independently.

## Subtasks

1. [x] Write `server/http_range.ts` and its unit tests first
2. [x] Add the mode parameter to `/ingest-video`; factor the walkthrough tail out unchanged
3. [x] Implement the person tail: persist clip + pose track, thumbnails only, no reconstruct job
4. [x] Register the scan via `registerSessionScan()` with a source discriminator
5. [x] Add video mimes to `SPLAT_ARTIFACT_MIME` and the artifact route regex
6. [x] Add the clip serve route using the range helper, with the standard traversal guard
7. [x] Add the low-fps/thumbnail flag to `scripts/ingest-video.mjs` without changing its default
8. [x] Document `INGEST_MAX_VIDEO_BYTES` in `.env.example`
9. [x] Write the Playwright specs, including the walkthrough-unchanged regression
10. [x] `deno task check`, `deno task test`, `npx tsc --noEmit`
