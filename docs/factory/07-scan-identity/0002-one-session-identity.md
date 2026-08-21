# One session identity, end to end

> **Type:** Backend + Frontend
> **Wave:** 07-scan-identity
> **Branch:** `fix/session-identity`
> **Commit style:** `fix(sessions): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None — can land in parallel with 0001. Both edit `main.ts`; see Risks.

## Goal

Make a capture session have exactly one id. Today the client and the server each mint their own,
a permissive regex lets the client's id masquerade as a valid server id, and the result is that
every phone-captured scan names a keyframe directory that does not exist — silently. Collapse the
two namespaces into one, make the id validator prove the directory is real, and set the
`glbFilename` backlink on every path that ends a session, not just manual export.

## The defect, precisely

Two rival session-id namespaces that never reconcile.

| # | Where | What it mints / accepts |
| --- | --- | --- |
| 1 | `src/scene/store.ts:43` | `` this._sessionId = `session-${Date.now()}` `` — no random component at all, and minted once per `DetectionStore` construction |
| 2 | `main.ts:747-755`, `POST /sessions` | `` const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` `` — the only id in the codebase not using `crypto.randomUUID()` |
| 3 | `main.ts:740` | `const SESSION_ID_RE = /^(sess\|session)-[a-z0-9-]+$/` — **accepts both prefixes** |

Because of (3), `sessionDir(id)` (`main.ts:743-745`) happily returns
`scans/sessions/session-<ts>/` for a client-minted id — a path that is never created, because
only `POST /sessions` (`main.ts:749`) ever does the `mkdir`, and it always uses its own `sess-`
id.

The two namespaces meet in the upload metadata. `src/export/gltf.ts:352` writes

```ts
sessionId:  store.sessionId,   // the CLIENT id
```

into the sidecar (and `:134` into the GLB's `scene.userData`, and `:286` into every detection's
`sourceScanIds`), and `main.ts:1385` reads it straight into `ScanManifest.sessionId`. Meanwhile
the `KeyframeStreamer` holds the *server's* id privately (`src/capture/keyframes.ts:122-124`) and
never publishes it. So for every phone-captured scan, `ScanManifest.sessionId` names a
nonexistent directory.

Live in this repo right now: `worlds/default.json` has four scans, all with
`sessionId: "session-1787174216556"` and a `frameSetUrl` of
`/worlds/default/frames/scan-session-1787174216556`. `scans/sessions/` contains **zero
directories**.

### Consequence 1 — frames silently resolve to nothing

`frameObservationsForScan` (`main.ts:2867-2877`) takes the truthy `scan.sessionId`, gets a
plausible-looking `dir` from `sessionDir()`, then:

```ts
try {
  raw = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
} catch {
  return []
}
```

`GET /worlds/:slug/frames/:scanId` (`main.ts:3067-3081`) returns `{ count: 0, frames: [] }` with a
200. No log line, no diagnostic, no difference between "this session had no keyframes" and "this
session id was never real".

### Consequence 2 — the preflight guard is defeated by its own truthiness

`jobFailureReason` (`main.ts:2703-2718`) guards keyframe-dependent jobs with:

```ts
if ((job.type === 'depth-reconstruct' || job.type === 'lingbot-map-reconstruct'
     || job.type === 'splat-train') && scan && !scan.sessionId) {
  return `${job.type} requires RGB keyframe observations. Start keyframe streaming before export.`
}
```

`scan.sessionId` is a non-empty string, so the guard passes. The job clears preflight and fails
later inside the runner, where the message is about a missing directory instead of the intended,
actionable one.

### Consequence 3 — the glbFilename backlink is set on exactly one of four exit paths

`keyframes.rotate({ glbFilename })` — the only call that links a session to its scan — is invoked
from exactly one place, the manual-export callback at `src/main.ts:198-206`. The other three
paths that end or interrupt a session do not pass one:

| Path | Code | `glbFilename` |
| --- | --- | --- |
| Manual export | `src/main.ts:198-206` → `rotate({ glbFilename: uploadedFilename, … })` | set |
| Autosave | `src/main.ts:514-542` — uploads a GLB, never calls `rotate()` or `stop()` | never set; the same server session keeps accumulating keyframes across every autosaved GLB |
| `#stream-btn` toggle off | `src/main.ts:586-593` → `stop({ pointCount, detectionCount, poseCount, qualitySummary })` | absent |
| `pagehide` | `src/main.ts:689-702` → `stop({ … })` | absent |

`POST /sessions/:id/finalize` (`main.ts:837-874`) writes `glbFilename: null` when the body omits
it (`:861`), so `session.json.glbFilename` stays null and `scan_index.ts`'s `byGlb` map
(`scan_index.ts:33-34`, `:56-58`) has nothing to match on.

And the backlink is unreachable anyway while the ids disagree: `sessionForScan`
(`scan_index.ts:80-101`) resolves an **explicit** `meta.sessionId` to that directory *or to
null* — by design, documented at `:70-73` — and never falls back to `byGlb`. So fixing
`glbFilename` alone fixes nothing. Both halves have to land together, which is why they are one
ticket.

## The working reference implementation to copy

`/ingest-video` and `/ingest-photos` are clean end to end, and the AR capture path should look
like them:

- the ingest script mints the id and creates the directory;
- `main.ts:964` and `main.ts:1061` both validate it through `sessionDir()` before using it, and
  reject with a 500 naming the bad id;
- `registerSessionScan` (`main.ts:1414-1439`) sets `filename = \`${sessionId}.glb\``, so
  `scanId`, `sessionId` and `filename` all agree by construction (see its doc comment at
  `:1405-1413`);
- `world_prune.ts:62-75` protects that synthetic filename from the missing-from-disk sweep.

One id, minted once, validated at every boundary, with every derived name falling out of it.
That is the target shape.

## Non-goals

- Do not add a second id field, a `captureSessionId`, or a client/server id mapping table. Per
  ADR 0001 this is one existing concept — the capture Session — being made single-valued, not a
  new one.
- Do not rename the IndexedDB database `'ci-xr-scan'` (`src/shared/storage-keys.ts:75`, CLAUDE.md
  do-not-rename). A `DB_VERSION` bump plus an `onupgradeneeded` migration is fine; a rename is
  not.
- Do not change the on-disk keyframe layout (`scans/sessions/<id>/kf-NNNNN.jpg` +
  `keyframes.jsonl`), `KEYFRAME_FILE_RE`, or `MAX_KEYFRAMES_PER_SESSION`.
- Do not change `scanIdFor`'s derivation — that is ticket 0001.
- Do not rework the keyframe upload queue, its retry/backoff, or the offline pause window
  (`src/capture/keyframes.ts`).
- Do not build a UI for orphaned sessions. Making the failure legible in logs and in the job
  preflight message is the whole scope.
- Do not change `/ingest-video` or `/ingest-photos`. They already work; they are the reference.

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this touches a schema, a
client↔server connection, and a persisted record, so it states what it extends:

| Existing | Where | How used |
| --- | --- | --- |
| the capture Session ("place" data) | `main.ts:731-745` + `src/capture/keyframes.ts` | **extended, not duplicated** — one id namespace replaces two; no parallel concept is added |
| `ScanManifest.sessionId` | `src/world/types.ts:148` | unchanged field, now guaranteed to name a real directory |
| `DetectionStore.sessionId` | `src/scene/store.ts:35`, `:43`, `:55-57` | reused; only its *source* changes. It is already non-readonly for exactly this kind of reassignment — see the doc comment at `:47-54` |
| `KeyframeStreamer` | `src/capture/keyframes.ts:107-135` | already performs `POST /sessions` and holds the server id; it becomes the publisher of that id rather than its sole owner |
| `sessionDir(id)` / `SESSION_ID_RE` | `main.ts:740-745` | reused as the single validation point; tightened, not replaced |
| `sessionForScan` / `loadSessionIndex` | `scan_index.ts:80-101`, `:46-63` | reused unchanged; `byGlb` finally gets populated |
| `registerSessionScan` | `main.ts:1414-1439` | the reference for id/filename agreement |
| `world_prune.ts:62-75` | `pruneScansMissingFromDisk` | already handles session-only scans; must keep doing so |

- **ADR 0002:** browser-importable types must be **declared** in Deno-API-free files
  (`src/world/types.ts`, `src/world/manifests.ts`, `src/shared/*.ts`). This ticket changes types
  on both sides of the wire — `npm run build` (`tsc --noEmit && vite build`) is the real gate;
  `deno check` does not catch cross-runtime import breakage. Run both.
- **No schema library.** Hand-written TS interfaces in `src/world/types.ts`; ad-hoc guards in
  `main.ts` (`asString` at `:1199`, `hasGeoPose`).
- **Hono handlers in `main.ts`. CORS via the existing `isAllowedOrigin()`. Config via
  `Deno.env.get('X') ?? <default>` at module scope** (`SESSIONS_DIR` is `main.ts:137`).
- **ID generation house style:** `crypto.randomUUID()`. `jobId` is
  `job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` (`main.ts:1803`), `patchId` is
  `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` (`main.ts:3022`), member ids/tokens
  are `${role}-${crypto.randomUUID()}` (`main.ts:1444-1446`). **The two session ids are the
  exceptions and are themselves the defect** — `Math.random().toString(36).slice(2, 6)` on the
  server, and nothing at all on the client. The surviving id conforms.
- **ADR 0004:** world writes are serialized per `shareSlug` via `world_lock.ts` — always mutate
  through `updateWorld()`, never write `worlds/*.json` directly. Session records
  (`scans/sessions/<id>/session.json`) are outside that lock and stay outside it; do not extend
  the world lock to cover them in this ticket.
- **Testability:** `SESSION_ID_RE` and `sessionDir` live in `main.ts`, which cannot be imported
  by a test (unconditional top-level side effects: hostname resolution, VLM engine load,
  `Deno.serve`). Extract the validation into its own root module the way `world_prune.ts`,
  `scan_index.ts`, `world_lock.ts` and `world_job_pump.ts` already are — that is the established
  pattern and the only way the tests below can exist.
- **DO NOT RENAME** (CLAUDE.md): IndexedDB `'ci-xr-scan'`, sessionStorage `'ci-xr-geo-fix'`,
  localStorage `'companion-scan-onboarded'`, the service-worker cache/queue/sync names, the GHCR
  image name, the OIDC client id, memory-push `sourceSystem` `'companion-scan'`. A version bump
  plus migration is fine; renaming is not.

## Before implementation

- `main.ts:731-755` — the session block's header comment, `SESSION_ID_RE`, `sessionDir`,
  `POST /sessions`
- `main.ts:757-835` — the keyframe upload and artifact routes; note `:760-764` already does a
  `Deno.stat(dir)` existence check that `sessionDir` itself does not
- `main.ts:837-874` — `POST /sessions/:id/finalize` and where `glbFilename` becomes `null`
- `main.ts:955-978` and `:1052-1076` — the ingest paths, the reference implementation
- `main.ts:1414-1439` — `registerSessionScan` and its doc comment
- `main.ts:2703-2718` — `jobFailureReason`
- `main.ts:2867-2909` — `frameObservationsForScan`
- `main.ts:3067-3081` — `GET /worlds/:slug/frames/:scanId`
- `main.ts:3110-3127` — `findFilenameBySessionId`, which matches `meta.sessionId` against
  `scans/*.json`; it works today *because* both sides carry the same (wrong) client id, and must
  keep working after the change
- `scan_index.ts` in full — especially `:66-101`, the resolution-order contract
- `world_prune.ts:62-88` — the session-only-scan carve-out
- `src/scene/store.ts:34-45` (construction), `:47-61` (why `sessionId` is not readonly),
  `:173-182` (`resumeLatestSession`), `:222-247` (`loadSession`/`adopt`), `:270-280`
  (`onupgradeneeded`, `keyPath: 'sessionId'`)
- `src/capture/keyframes.ts:105-182` — `start`, `stop`, `rotate`
- `src/export/gltf.ts:126-145` (`scene.userData`), `:286` (`sourceScanIds`), `:339-376` (the
  upload metadata sidecar)
- `src/main.ts:198-206`, `:506-542`, `:572-603`, `:676-702` — the four session-exit paths
- `src/export/summary.ts:117`, `:267` and `src/main.ts:1295` — the other consumers of
  `store.sessionId`
- CLAUDE.md "Do not rename", before touching `src/scene/store.ts`

## Open questions & answers

- Q: Which id survives — client-minted or server-minted? — **A: the server-minted one.** The
  `KeyframeStreamer` already calls `POST /sessions` and already holds it
  (`src/capture/keyframes.ts:109-124`); it is the only side that can create the directory the id
  names; and it is exactly how `/ingest-video` and `/ingest-photos` already work, so the AR path
  stops being the odd one out. The alternative — a client-minted, collision-resistant id the
  server accepts and `mkdir`s — needs a new "create session with this id" contract, a new
  server-side trust boundary on a client-supplied path component, and still leaves two minting
  sites to keep in sync. Decided by owner, 2026-08-19.
- Q: What is the client's session id before keyframe streaming starts, or when the server is
  unreachable? — **A: a local-only id, and it must be visibly local.** `DetectionStore` still
  needs an IndexedDB key at construction. Pin the shape as
  `` `local-${crypto.randomUUID()}` `` — conforming to house style, and *deliberately not
  matching* the tightened `SESSION_ID_RE`, so a local id can never be mistaken for a server
  session. When the streamer opens a server session, the store adopts the server id via the
  existing setter (`src/scene/store.ts:55-57`, whose doc comment at `:47-54` describes exactly
  this adopt-don't-fork requirement). A scan exported with a local id writes
  `sessionId: null` into the sidecar rather than a fake one — `ScanManifest.sessionId` is already
  `string | null` (`src/world/types.ts:148`), and `null` is the honest value for "no keyframes
  were streamed". Decided by owner, 2026-08-19.
- Q: How is `SESSION_ID_RE` tightened? — **A:** two changes. (1) Drop the `session-` alternative:
  the pattern accepts only the server's own prefix. (2) `sessionDir` stops being a pure
  string test — add an async `resolveSessionDir(id)` that returns the path only when the
  directory exists, and route the callers that currently assume existence through it. Keep the
  cheap synchronous `sessionDir` for the routes that already `Deno.stat` immediately after
  (`main.ts:760-764`), so the check is not done twice. Decided by owner, 2026-08-19.
- Q: `jobFailureReason` is synchronous (`main.ts:2703`). Making it check the filesystem makes it
  async, which touches every caller. — **OPEN.** Two options: make it `async` and update
  callers, or have `_dispatchWorldJob` resolve a `keyframeCount` (or a "keyframes exist" boolean)
  once before calling it and pass it in. The second is smaller and keeps the function pure —
  recommended — but confirm against the call sites before coding. **Answer before coding.**
- Q: Does the IndexedDB record shape change? — **A: no fields change**, so `DB_VERSION` can stay
  at 1. Only the *value* of `sessionId` changes shape, and `keyPath: 'sessionId'`
  (`src/scene/store.ts:274`) accepts any string. Existing records keep opening and keep loading
  through `resumeLatestSession` (`:173-182`) and the history drawer. Bump the version only if
  implementation forces a field change — and if so, write a real `onupgradeneeded` migration, not
  a fresh store. Decided by owner, 2026-08-19.
- Q: Do existing `session-<ts>` records in a user's browser break? — **A: no, and that is a hard
  requirement.** They remain valid IndexedDB keys and must still list, load, resume and delete.
  What changes is that no *new* record is created with that shape, and no such id is ever sent to
  the server as a session reference. See Risks.
- Q: Should the four existing scans in `worlds/default.json`, whose `sessionId` names a directory
  that never existed, be backfilled to `null`? — **A: yes**, as a small idempotent step folded
  into this ticket: a session id with no directory on disk is not a session. Reuse ticket 0001's
  migration script if it has landed; otherwise do it in this ticket's own one-shot and keep it
  idempotent. Either way it runs inside `withWorldLock` (ADR 0004), never as a direct write.
  Decided by owner, 2026-08-19.
- Q: Autosave currently never rotates the keyframe session, so one directory spans every
  autosaved GLB. Should autosave rotate (finalize + open a fresh session per GLB), or finalize
  without rotating? — **A: rotate**, matching manual export. `rotate()`
  (`src/capture/keyframes.ts:178-182`) is `stop(finalize)` + `start()` and already exists for
  precisely this. One scan ↔ one keyframe session keeps `glbFilename` single-valued, which is
  what `scan_index.ts`'s `byGlb` map assumes ("First writer in readDir order wins",
  `scan_index.ts:33`). Decided by owner, 2026-08-19.

## Files impacted

New:
- `session_id.ts` (repo root) — `SESSION_ID_RE`, `sessionDir`, `resolveSessionDir`, extracted
  from `main.ts` so they are importable and testable, following `world_prune.ts` /
  `scan_index.ts`
- `session_id.test.ts` (repo root) — added to `deno.json`'s `test` task file list

Changed:
- `main.ts` — `POST /sessions` id minting (`:748`); `SESSION_ID_RE`/`sessionDir` moved out
  (`:740-745`) and callers updated (`:758`, `:800`, `:823`, `:838`, `:964`, `:1061`, `:1095`,
  `:2264`, `:2635`, `:2869`); `jobFailureReason` (`:2703-2718`);
  `frameObservationsForScan` (`:2867-2877`) to log a missing directory instead of returning `[]`
  silently
- `src/scene/store.ts` — construction-time id (`:43`) and the adopt path
- `src/capture/keyframes.ts` — publish the server session id to the store on `start()`
- `src/export/gltf.ts` — `sessionId` in `scene.userData` (`:134`), `sourceScanIds` (`:286`), and
  the upload metadata sidecar (`:352`)
- `src/main.ts` — pass `glbFilename` on the autosave path (`:514-542`), the `#stream-btn` toggle
  (`:586-593`) and `pagehide` (`:689-702`)
- `deno.json` — `session_id.test.ts` appended to the `test` task
- `docs/factory/atlas.html` — the "Capture sessions" card at `:424`, the `StreamerStatus` row at
  `:513` and the `ScanManifest`/`FrameObservation` rows at `:535`/`:539` all describe this
  connection; add before/after diff markup per `docs/FACTORY.md` § "The atlas"
- `docs/factory/07-scan-identity/README.md`

Possibly changed (settle the open `jobFailureReason` question first):
- `src/export/summary.ts:117`, `:267` and `src/main.ts:1295` — other `store.sessionId` readers;
  they need no logic change but must be re-read once the id can be `local-…` or null

## Schema required

No new type and no new field. Three existing shapes change what they may contain:

| Shape | Where | Before | After |
| --- | --- | --- | --- |
| `DetectionStore._sessionId` | `src/scene/store.ts:35`, `:43` | `` `session-${Date.now()}` `` at construction, never changed by capture | `` `local-${crypto.randomUUID()}` `` at construction; replaced by the server-minted `sess-…` id once `KeyframeStreamer.start()` succeeds |
| upload metadata sidecar `sessionId` | `src/export/gltf.ts:352` (also `:134`, `:286`) | always the client id | the server session id when one exists, otherwise `null` |
| `ScanManifest.sessionId` | `src/world/types.ts:148` — `string \| null`, unchanged | a string naming a directory that may not exist | a string naming a directory that **does** exist, or `null` |

IndexedDB: database name `'ci-xr-scan'` and `keyPath: 'sessionId'` (`src/scene/store.ts:274`)
both unchanged. `DB_VERSION` stays 1 unless implementation forces a field change; if it does, a
real `onupgradeneeded` migration is required — existing records must keep opening (CLAUDE.md
do-not-rename, and `src/shared/storage-keys.ts:68-75`).

Server session record (`scans/sessions/<id>/session.json`, written at `main.ts:750-751` and
`:862-872`): fields unchanged. `glbFilename` simply stops being null on paths that upload a GLB.

## Definition of Done

- [ ] Exactly one place mints a capture-session id, and it uses `crypto.randomUUID()`
- [ ] `SESSION_ID_RE` no longer accepts the `session-` prefix
- [ ] A session id cannot resolve to a directory that was never created — validation proves
      existence, not just shape
- [ ] `SESSION_ID_RE`/`sessionDir`/`resolveSessionDir` live in an importable module with no
      `main.ts` side effects
- [ ] `DetectionStore` starts with a `local-…` id that deliberately fails `SESSION_ID_RE`, and
      adopts the server id when keyframe streaming opens a session
- [ ] A scan exported with no server session writes `sessionId: null`, not a fake id
- [ ] `frameObservationsForScan` distinguishes "no keyframes" from "no such session" and logs the
      latter
- [ ] `jobFailureReason` returns "…requires RGB keyframe observations. Start keyframe streaming
      before export." when the keyframe directory does not exist — the intended message, at
      preflight, instead of a runner-internal failure later
- [ ] `glbFilename` is set on all four session-exit paths: manual export, autosave,
      `#stream-btn` off, `pagehide`
- [ ] Autosave rotates the keyframe session, so one scan maps to one keyframe session
- [ ] `session.json.glbFilename` is non-null after an autosave, and `scan_index.ts`'s `byGlb`
      resolves that scan
- [ ] Existing `session-<ts>` IndexedDB records still list, resume, load and delete
- [ ] The four scans in `worlds/default.json` whose session directory never existed are
      backfilled to `sessionId: null`, idempotently, inside `withWorldLock`
- [ ] `/ingest-video` and `/ingest-photos` behaviour is byte-for-byte unchanged
- [ ] `deno task check`, `deno task test`, `npm run build`, `npm run verify` all pass

## Tests

- [ ] `session_id.test.ts`: `SESSION_ID_RE` rejects `session-1787174216556` (the client shape)
      and accepts a server-minted `sess-…` id
- [ ] `session_id.test.ts`: `SESSION_ID_RE` rejects a `local-…` store id, so a local id can never
      be mistaken for a server session
- [ ] `session_id.test.ts`: `resolveSessionDir` returns `null` for a well-formed id with **no
      backing directory**, and the path for one that exists (temp dir fixture)
- [ ] `session_id.test.ts`: path-traversal and separator inputs are still rejected (regression
      guard on the existing regex's safety role)
- [ ] Deno test: a keyframe-dependent job (`splat-train`, `lingbot-map-reconstruct`,
      `depth-reconstruct`) whose scan names a directory that does not exist fails **preflight**
      with the exact string `requires RGB keyframe observations. Start keyframe streaming before
      export.`
- [ ] Deno test: the same job with a real keyframe directory passes preflight
- [ ] Deno test: `frameObservationsForScan` on a scan with a nonexistent session directory
      returns `[]` **and** emits a distinguishable log/diagnostic, separate from the
      empty-`keyframes.jsonl` case
- [ ] Deno test: the world backfill sets `sessionId: null` for a scan whose directory is absent,
      leaves a scan with a real directory alone, and is a no-op on a second run
- [ ] `scan_index.test.ts`: extend — a scan whose `meta.sessionId` is `null` resolves through the
      `byGlb` fallback to the session whose `glbFilename` matches (the path that is dead today)
- [ ] `detection_store.test.ts` (`npm run test:store`): a fresh store's id fails
      `SESSION_ID_RE`; adopting a server id moves the live id without forking the record; a
      pre-existing `session-<ts>` record still loads and resumes
- [ ] Playwright (`tests/`): after an autosave, the finalized `session.json` carries a non-null
      `glbFilename` — the assertion that pins Consequence 3
- [ ] Playwright or manual: ending a session via the `#stream-btn` toggle and via `pagehide`
      each produce a non-null `glbFilename`
- [ ] `session_id.test.ts` is appended to `deno.json`'s `test` task file list

```
deno task check
deno task test
npm run build
npm run verify
```

## Acceptance Criteria

- [ ] Given a phone capture with keyframe streaming on, When the scan is exported, Then
      `ScanManifest.sessionId` names a directory that exists under `scans/sessions/`
- [ ] Given that scan, When `GET /worlds/:slug/frames/:scanId` is called, Then `count` is the real
      keyframe count, not 0
- [ ] Given a scan captured with keyframe streaming **off**, Then `ScanManifest.sessionId` is
      `null` and no phantom directory is implied
- [ ] Given a keyframe-dependent job enqueued on a scan with no keyframes, When it is dispatched,
      Then it fails at preflight with the intended human-readable message, not inside the runner
- [ ] Given an autosave, When the session finalizes, Then `session.json.glbFilename` names the
      uploaded GLB and a fresh session is open for the next one
- [ ] Given a tab closed mid-scan, When `pagehide` fires, Then the session finalizes with a
      `glbFilename` when a GLB has been uploaded
- [ ] Given a browser holding `session-<ts>` records from before this change, When the app loads,
      Then those sessions still appear in the history drawer and still resume
- [ ] Given `/ingest-video`, Then its scan's `scanId`, `sessionId` and `filename` still agree
      exactly as they do today

## Risks / potential issues

- **Risk:** Changing the client session-id format interacts with IndexedDB `keyPath: 'sessionId'`
  (`src/scene/store.ts:274`) and with `resumeLatestSession` (`:173-182`), which sorts by
  `startedAt` and adopts the winner. A user mid-walkthrough across the upgrade has records under
  both shapes. — **Mitigation:** the key is an opaque string, so both shapes coexist; sorting is
  on `startedAt`, not on the id. Test the mixed-record case explicitly. Do not "clean up" old
  records — that is data loss, and `'ci-xr-scan'` is on the do-not-rename list precisely because
  its contents are the user's.
- **Risk:** Adopting the server id mid-session moves the live store id. `adopt()`
  (`src/scene/store.ts:245-247`) exists for this, and `:47-54` documents the fork bug that
  happened last time it was not done — but adopting on `start()` while detections already exist
  under the local id could strand the earlier record. — **Mitigation:** decide explicitly whether
  adoption rewrites the existing record under the new key or only takes effect for a session
  started before any capture, and pin it in the store's doc comment. The tests must cover
  "streaming started after three captures".
- **Risk:** Tightening `SESSION_ID_RE` is a hard cutover: any `session-…` id already stored in a
  `scans/*.json` sidecar stops validating. — **Mitigation:** that is the point (it never named a
  real directory), and the world backfill sets those to `null`. But check
  `findFilenameBySessionId` (`main.ts:3110-3127`) and `POST /process-scan`
  (`main.ts:3129-3146`): they match `meta.sessionId` **as a plain string**, not through
  `SESSION_ID_RE`, so they keep working for old sidecars. Confirm this before assuming; a
  regression here silently changes which scan gets processed.
- **Risk:** `main.ts:2264` and `:2635` also call `sessionDir(...)` to build worker inputs. Making
  validation existence-aware could turn a previously-silent path into a new failure mode inside a
  runner. — **Mitigation:** read both call sites before changing the signature; a runner that now
  fails fast with a clear message is an improvement, one that throws an unhandled error is not.
- **Risk:** Autosave rotating the keyframe session means more, shorter sessions and more
  directories under `scans/sessions/`. — **Mitigation:** this is what manual export already does;
  it is also what makes one scan ↔ one session true. Note the directory-count change in the wave
  README; retention is out of scope.
- **Risk:** Sequencing with ticket 0001 — both edit `main.ts`, and 0001 also rewrites world files.
  If both migrations run, order matters for the scan-entry rewrite. — **Mitigation:** both are
  idempotent and touch different fields (`scanId` vs `sessionId`); run 0001's first if both are
  pending. Whichever ticket lands second rebases and folds its backfill into the surviving
  script.
- **Risk:** `src/export/gltf.ts:286` writes `sourceScanIds: [store.sessionId]` into every exported
  detection — a *session* id under a *scan* id's name. Allowing `null` there may surface a latent
  consumer assumption. — **Mitigation:** grep every reader of `sourceScanIds` before changing it;
  if the field genuinely wants a scan id, note it as a follow-up for wave 08 rather than
  redefining it here.
- **Risk:** This ticket changes types on both sides of the wire, which is exactly where
  `deno check` alone gives false confidence (ADR 0002). — **Mitigation:** `npm run build` and
  `npm run verify` are both in the verification list and both must pass.

## Subtasks

1. [ ] Answer the open `jobFailureReason` async-vs-passed-in question against its call sites
2. [ ] Extract `SESSION_ID_RE` / `sessionDir` into `session_id.ts`, add `resolveSessionDir`, and
       update every caller listed in Files impacted
3. [ ] Tighten `SESSION_ID_RE` to the server prefix only; switch `POST /sessions` to
       `crypto.randomUUID()`
4. [ ] Write `session_id.test.ts` and wire it into `deno.json`'s `test` task
5. [ ] Change `DetectionStore`'s construction-time id to `local-${crypto.randomUUID()}` and pin
       the adoption rule in its doc comment
6. [ ] Have `KeyframeStreamer.start()` publish the server id to the store
7. [ ] Make `src/export/gltf.ts` write the server session id, or `null`, in all three places
8. [ ] Set `glbFilename` on the autosave, `#stream-btn` and `pagehide` paths; make autosave
       `rotate()`
9. [ ] Make `frameObservationsForScan` log a missing session directory distinguishably
10. [ ] Make `jobFailureReason` detect a missing keyframe directory and return the intended
        message at preflight
11. [ ] Write the idempotent world backfill (`sessionId: null` for absent directories) inside
        `withWorldLock`, or fold it into ticket 0001's script if that landed first
12. [ ] Extend `scan_index.test.ts` and `detection_store.test.ts`; add the Playwright autosave
        assertion
13. [ ] Verify a real device run end to end: stream keyframes, autosave twice, confirm two
        sessions each with a `glbFilename`, and a non-zero frame count from
        `GET /worlds/default/frames/:scanId`
14. [ ] Confirm `/ingest-video` and `/ingest-photos` are unchanged
15. [ ] Update `atlas.html:424`, `:513`, `:535`, `:539` and the wave README
16. [ ] `deno task check` · `deno task test` · `npm run build` · `npm run verify`
