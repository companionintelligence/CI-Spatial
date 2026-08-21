# Unique scanId per uploaded scan, with backfill migration

> **Type:** Backend
> **Wave:** 07-scan-identity
> **Branch:** `fix/scan-id-per-upload`
> **Commit style:** `fix(world): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Lands in parallel with 0002 — both edit `main.ts`; see Risks for the
> sequencing note.

## Goal

Give every uploaded scan its own `scanId`. Today four different GLBs in `worlds/default.json`
share one id, because the id is derived from the capture session rather than from the upload —
so the viewer draws one of them, edit patches replay onto the wrong one, and every memory push
overwrites the last. Re-derive `scanId` from the uploaded filename (already unique by
construction) and backfill the existing worlds so nothing that pointed at the collided id is
lost.

## The defect, precisely

`main.ts:1359-1363`:

```ts
function scanIdFor(filename: string, meta: Record<string, unknown>): string {
  const sessionId = asString(meta['sessionId'])
  if (sessionId) return `scan-${safeSlug(sessionId)}`
  return `scan-${safeSlug(filename.replace(/\.glb$/, ''))}`
}
```

The filename branch is already correct and already unique. The `sessionId` branch is the bug:
`src/scene/store.ts:43` sets

```ts
this._sessionId = `session-${Date.now()}`
```

once per `DetectionStore` construction — i.e. **once per browser tab**, not once per export.
`runAutoSave()` (`src/main.ts:514-542`) uploads a fresh GLB every time it fires and never
changes that id, so every autosave in one walkthrough writes the same `meta.sessionId`, and
`scanIdFor` hands every one of them the same `scanId`.

Live, in this repo's `worlds/default.json` right now — four distinct GLBs, four distinct
detection counts, one id:

| filename | detectionCount | scanId |
| --- | --- | --- |
| `1787174311700_autosave-room-scan-2026-08-19T21-18-33.glb` | 8 | `scan-session-1787174216556` |
| `1787174371857_autosave-room-scan-2026-08-19T21-19-32.glb` | 10 | `scan-session-1787174216556` |
| `1787174954604_autosave-room-scan-2026-08-19T21-29-15.glb` | 16 | `scan-session-1787174216556` |
| `1787175480232_autosave-room-scan-2026-08-19T21-38-01.glb` | 16 | `scan-session-1787174216556` |

`ScanManifest.scanId` is the primary key of a scan everywhere downstream. Four rows share it.

### What that breaks

Verified at each site, in the order a user meets them:

| Site | Code | Consequence |
| --- | --- | --- |
| `src/viewer/viewer.ts:117`, `:736`, `:756`, `:787` | `loadedScans` is a `Map` keyed by `scanId`; `integrateScanRoot` treats a hit as the *previous LOD generation of the same scan* and calls `worldGroup.remove(previous.root)` | Only the last-loaded root survives. Three of four scans are removed from the scene. |
| `src/viewer/viewer.ts:2172`, `:2179` | `loadedScans.values()` has one entry | The HUD reads **"1 scan loaded"** for four scans. |
| `src/viewer/viewer.ts:602` | per-row visibility checkbox does `loadedScans.get(scan.scanId)` | Four rows in the scan list, one shared root — every checkbox toggles the same object. |
| `src/viewer/viewer.ts:881`, `:883` | `if (patch.scanId && patch.scanId !== scan.scanId && patch.scanId !== scan.filename) continue` | A patch made against one scan replays onto whichever sibling is being integrated. Patches scoped by `targetId === filename` still resolve correctly; ones scoped by `scanId` do not. |
| `memory_push.ts:244`, `:323` | `const sourceId = scan.scanId`, sent as `source_id` | `memory_push.ts:31` and `:90-91` state the contract: idempotency is `(source_system, source_id)` and it is "stable per scan, so re-pushes dedupe". With a shared id, the four scans are *one* memory event on CI-Server, and each push overwrites the previous. |
| `main.ts:1531-1534` | job GC keeps a job when `world.scans.some(scan => scan.scanId === job.scanId)` | Deleting one of the four leaves its jobs alive, because a sibling still matches. Latent today — the four jobs in `worlds/default.json` are `optimize-scan` and carry no `scanId` at all (they key off `payload.filename`) — but live for every job type created through `POST /worlds/:slug/jobs` with a `scanId`. |
| `main.ts:2698-2701` | `scanForJob` = `world.scans.find(scan => scan.scanId === job.scanId ...)` | `.find()` always returns the *oldest* colliding scan. A job enqueued against the newest scan runs against the first. |
| `main.ts:3067-3081` | `GET /worlds/:slug/frames/:scanId` does `world.scans.find(...)` | Same: the frame set for the oldest scan is served for all four. |
| `main.ts:3110-3127` | `findFilenameBySessionId` returns the first `scans/*.json` whose `meta.sessionId` matches | `POST /process-scan` with a sessionId processes an arbitrary one of the four. |

## Non-goals

- Do not change the uploaded-filename scheme. `createScanFileExclusive` (`main.ts:417-435`)
  already guarantees uniqueness atomically — `${ts}_${stem}${suffix}.glb`, with
  `-${crypto.randomUUID().slice(0, 8)}` appended only on a real same-millisecond collision.
  This ticket depends on that guarantee; it must not weaken it.
- Do not change `ScanManifest.sessionId`. It correctly names the walkthrough, and it stays the
  link to the keyframe directory. Fixing *which* id that is belongs to ticket 0002.
- Do not fix the client-side `session-${Date.now()}` id here. That is 0002. This ticket makes
  `scanId` correct **even while the session id stays broken**, which is why it can land first.
- Do not rename `ScanManifest.scanId`, add a second id field, or introduce a `ScanRecord` type.
  Per ADR 0001 this is a change of *derivation*, not of schema.
- Do not add a UI for the migration, and do not run it from `Deno.serve` request handling.
- Do not touch `memory_push.ts`'s idempotency contract itself — only note what the new ids mean
  for already-pushed events (see Risks).

## Pinned conventions

**ADR 0001** (`docs/adr/0001-reuse-existing-domain-model.md`) — this changes how a persisted
field is derived and how a client↔server-visible id is formed, so it states what it extends:

| Existing | Where | How used |
| --- | --- | --- |
| `ScanManifest.scanId` | `src/world/types.ts:147` | **reused unchanged as a field.** Its derivation changes; no new id field is added. |
| `ScanManifest.sessionId` | `src/world/types.ts:148` | untouched — still the walkthrough link |
| `scanIdFor(filename, meta)` | `main.ts:1359` | the single derivation point; keep it the single derivation point |
| `safeSlug(raw, fallback)` | `main.ts:1178` | reused for the slug step; do not write a second slugger |
| `updateWorld(slug, mutate)` / `withWorldLock(slug, fn)` | `main.ts:1588`, `world_lock.ts:51` | every world write, migration included — ADR 0004 |
| `migrate_jobs.ts` + `deno task migrate-jobs` + `migrate_jobs.test.ts` | repo root, `deno.json:tasks` | **the migration pattern to copy** — explicitly invoked, one-shot, idempotent by construction, pure core + thin `import.meta.main` wrapper |
| `pruneScansMissingFromDisk` (`world_prune.ts`), `sessionForScan` (`scan_index.ts`) | repo root | the precedent for extracting a pure function into its own module so it is unit-testable without `main.ts`'s top-level side effects |

- **ADR 0004** (`docs/adr/0004-world-file-writes-are-serialized-per-slug.md`): world writes are
  serialized per `shareSlug`. Never write `worlds/*.json` directly. In-process, mutate through
  `updateWorld()`. The standalone migration script cannot import `main.ts` (unconditional
  top-level side effects: hostname resolution, VLM engine load, `Deno.serve`) — it must import
  `withWorldLock` from `world_lock.ts` and reproduce `updateWorld`'s read → mutate → write shape
  inside the critical section. See the first Open question.
- **ADR 0002**: browser-importable types stay declared in Deno-API-free files
  (`src/world/types.ts`, `src/world/manifests.ts`, `src/shared/*.ts`). No type moves in this
  ticket, but the new migration module must not be imported from `src/`. `npm run build`
  (`tsc --noEmit && vite build`) is the real gate for cross-runtime breakage; `deno check` does
  not catch it.
- **No schema library.** Hand-written TS interfaces in `src/world/types.ts`; ad-hoc guards in
  `main.ts` (`asString` at `:1199`, `hasGeoPose`).
- **ID generation house style:** `crypto.randomUUID()` — `jobId` is
  `job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` (`main.ts:1803`), `patchId` is
  `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` (`main.ts:3022`), member ids and
  tokens are `${role}-${crypto.randomUUID()}` (`main.ts:1444`, `:1446`). `scanId` is
  deliberately **not** random: it is derived, so the same upload always yields the same id and
  the migration is idempotent — the same reasoning `migrate_jobs.ts:81-84` gives for reusing the
  legacy job id.
- **Config:** `Deno.env.get('X') ?? <default>` at module scope. The migration reuses
  `SCANS_DIR` / `WORLDS_DIR` with `main.ts`'s defaults (`main.ts:132`, `:138`), exactly as
  `migrate_jobs.ts:232-233` does.
- **Hono handlers in `main.ts`; CORS via `isAllowedOrigin()`.** No new route in this ticket.
- **DO NOT RENAME** (CLAUDE.md): IndexedDB `'ci-xr-scan'`, sessionStorage `'ci-xr-geo-fix'`,
  localStorage `'companion-scan-onboarded'`, the service-worker cache/queue/sync names, the GHCR
  image name, the OIDC client id, and memory-push `sourceSystem` `'companion-scan'`. This ticket
  changes a `source_id` **value**, never the `source_system` name.

## Before implementation

- `main.ts:1359-1403` — `scanIdFor`, `scanNameFor`, `scanManifestFromStored`. Note `frameSetUrl`
  at `:1397-1399` embeds `scanId` in the URL.
- `main.ts:1603-1666` — `refreshWorldScans`. **Read this before designing the migration.** Line
  `:1640-1650` re-derives every scan's manifest from stored meta on every world read and spreads
  `{ ...scan, ...next }`, so `scanId` is *recomputed on load*. Changing `scanIdFor` therefore
  re-ids the scan entries by itself. What it does **not** re-point is `editPatches[].scanId` and
  `jobs[].scanId` — those are the migration's real work. Note also that the `changed` flag at
  `:1644-1648` does not compare `scanId`, so a re-derivation alone may not persist.
- `main.ts:417-435` — `createScanFileExclusive`, the uniqueness guarantee this ticket leans on.
- `main.ts:1178-1184` — `safeSlug`. Lossy: it lowercases and maps every character outside
  `[a-z0-9_-]` to `-`, then collapses runs. See Risks.
- `main.ts:1526-1537` — `removeScanFromWorlds`; the patch filter at `:1530` compares
  `patch.scanId` against a *filename*, and the job GC at `:1531-1534` is the sibling-match bug.
- `main.ts:1588-1598` (`updateWorld`), `main.ts:1526` (`mutateWorldFiles` caller), `world_lock.ts`
  in full.
- `migrate_jobs.ts` in full — the shape, the header comment, the idempotency argument, and the
  "refuse to silently no-op on a malformed file" stance at `:160-180`. Copy all four.
- `migrate_jobs.test.ts` — the test shape for a migration.
- `src/viewer/viewer.ts:732-798` and `:877-898` — what a duplicate key does to the scene graph.
- `memory_push.ts:28-35`, `:88-92`, `:240-250`, `:320-335` — the idempotency contract.
- `worlds/default.json` — the live four-way collision; it is the fixture.

## Open questions & answers

- Q: Startup check or explicit script? — **A: explicit script**, `migrate_scan_ids.ts` at the
  repo root plus a `deno task migrate-scan-ids` entry, mirroring `migrate_jobs.ts` /
  `deno task migrate-jobs`. Reasons, in order: (1) `migrate_jobs.ts:10-11` already pinned this
  choice for this repo and gave the reason — a boot-time migration re-runs on every restart and
  has to be defended against double-application forever; (2) a boot hook would run inside the
  same process that is about to serve requests, and the interesting failure (a malformed world
  file) should stop an operator, not a server; (3) the pure core stays unit-testable. Decided by
  owner, 2026-08-19.
- Q: ADR 0004 says mutate via `updateWorld()`, but a standalone script cannot import `main.ts`
  — how is the rule honored? — **A:** the script imports `withWorldLock` from `world_lock.ts`
  (it lives in its own module precisely so it is importable without `main.ts`'s side effects —
  see that file's header, `:26-28`) and performs read → mutate → write *inside* the critical
  section, reproducing `updateWorld`'s shape. The lock is in-process only (ADR 0004, "In-process
  only"), so the script must also refuse to run — or loudly warn — while a server is running
  against the same `WORLDS_DIR`. Pin: **run the migration with the server stopped.** Decided by
  owner, 2026-08-19.
- Q: A patch whose `scanId` matched N collided scans must be re-pointed at exactly one. Which? —
  **A: the newest scan of that session**, i.e. the largest `${ts}_` filename prefix, falling back
  to `capturedAt` when the prefix is absent. Rationale: the collided id was minted per
  walkthrough, and a user editing in the World Editor was almost certainly looking at the most
  recent capture of that walkthrough. The choice is a guess and must be logged as one — the
  migration prints one line per ambiguous patch naming the patch id, the candidate count, and the
  scan it chose. Decided by owner, 2026-08-19.
- Q: Are the on-disk scan entries part of the migration, given `refreshWorldScans` re-derives
  `scanId` on every read? — **A:** they are self-healing, but the migration still rewrites them,
  for two reasons: it must not depend on load-order to be correct, and `refreshWorldScans`'s
  `changed` flag (`main.ts:1644-1648`) does not compare `scanId`, so a pure re-derivation may
  never be persisted. Additionally, **add `scanId` to that `changed` comparison** so the file
  and memory cannot drift. Decided by owner, 2026-08-19.
- Q: What if the migration runs *after* a server boot has already re-derived the scan ids? —
  **A:** still correct. `ScanManifest.sessionId` is retained, so the old id is recomputable as
  `scan-${safeSlug(sessionId)}` for any scan at any time. The migration must derive the old id
  that way rather than assuming the file still contains it. Decided by owner, 2026-08-19.
- Q: Should `removeScanFromWorlds` be fixed in this ticket? — **A: yes.** It is two lines, it is
  the direct GC consequence of the collision, and this ticket owns `scanId` derivation. Compute
  the removed scan's `scanId` before filtering and use it for both the patch filter (`:1530`,
  currently comparing a `scanId` against a filename) and the job GC (`:1531-1534`).
- Q: Does `ScanManifest.scanId` semantics changing count as a breaking rename? — **A: no.**
  Nothing in the CLAUDE.md do-not-rename registry names `scanId`. It is a derived value inside a
  file this migration rewrites, not a persisted user key. The one genuinely external consumer is
  `memory_push`'s `source_id` — covered in Risks, and it is a value change, never a
  `source_system` change.

## Files impacted

New:
- `migrate_scan_ids.ts` — pure migration core + `import.meta.main` CLI wrapper, modelled on
  `migrate_jobs.ts`
- `migrate_scan_ids.test.ts` — Deno test, added to `deno.json`'s `test` task file list
- `tests/fixtures/world-scan-id-collision.json` (or a fixture built inline in the test — decide
  in review) reproducing the real four-way collision from `worlds/default.json`

Changed:
- `main.ts` — `scanIdFor` (`:1359-1363`); `refreshWorldScans`'s `changed` comparison
  (`:1644-1648`); `removeScanFromWorlds` (`:1526-1537`)
- `deno.json` — new `migrate-scan-ids` task; `migrate_scan_ids.test.ts` appended to `test`
- `docs/factory/atlas.html` — the `ScanManifest` row at `:535` and the memory-push connection row
  at `:845` ("Idempotent on (source_system, scanId)") both describe the id whose meaning this
  ticket changes; add the before/after diff markup per `docs/FACTORY.md` § "The atlas"
- `docs/factory/07-scan-identity/README.md` — wave README (create with the wave if absent)

## Schema required

**None.** No new field, no new type, no changed type signature.

What changes is the documented **meaning** of an existing field:

| Field | Type | Before | After |
| --- | --- | --- | --- |
| `ScanManifest.scanId` | `string` (`src/world/types.ts:147`) | `scan-${safeSlug(meta.sessionId)}` when a sessionId exists, else `scan-${safeSlug(filenameStem)}` — one id **per capture session** | always `scan-${safeSlug(filenameStem)}` — one id **per uploaded scan** |
| `ScanManifest.sessionId` | `string \| null` (`:148`) | unchanged | unchanged |

Document this in the `scanIdFor` doc comment, in the wave README, and in the atlas diff: it is
the fix, not a breaking rename. `scanId` was always meant to identify a scan; the sessionId
branch made it identify a walkthrough.

Session-backed scans keep working unchanged: `registerSessionScan` (`main.ts:1414-1439`) gives a
video/photo ingest the synthetic filename `${sessionId}.glb`, so the filename-derived id is
`scan-${safeSlug(sessionId)}` — byte-identical to what that path produces today. **The
ingest path's ids do not move.** Only multi-upload AR sessions are re-identified.

## Definition of Done

- [ ] `scanIdFor` derives from the filename only; the `meta.sessionId` branch is gone, and the
      doc comment says why
- [ ] Two uploads sharing one `meta.sessionId` produce two distinct `scanId`s
- [ ] Video/photo-ingest scans keep the exact ids they have today
      (`registerSessionScan`'s `${sessionId}.glb` → `scan-${safeSlug(sessionId)}`)
- [ ] `refreshWorldScans`'s `changed` comparison includes `scanId`, so a re-derivation is
      persisted rather than silently living only in memory
- [ ] `removeScanFromWorlds` filters patches and GCs jobs against the removed scan's *derived
      scanId*, not against its filename
- [ ] `migrate_scan_ids.ts` exists, exports a pure core, and has an `import.meta.main` wrapper
      reading `SCANS_DIR`/`WORLDS_DIR` with `main.ts`'s defaults
- [ ] The migration re-derives every scan's `scanId` in every `worlds/*.json`, and re-points
      every `editPatches[].scanId` and `jobs[].scanId` that named a now-split id
- [ ] Ambiguous patch remaps resolve to the newest scan of that session and each one is logged
      by patch id, candidate count, and chosen scan
- [ ] The migration mutates only inside `withWorldLock(slug, …)` and never writes `worlds/*.json`
      outside it
- [ ] The migration is idempotent: a second run reports nothing to do and leaves every file
      byte-identical
- [ ] The migration refuses to silently no-op on a malformed world file — it throws with a
      message naming the file, matching `migrate_jobs.ts:174-180`
- [ ] `frameSetUrl` is regenerated for every migrated scan (it embeds `scanId`,
      `main.ts:1397-1399`)
- [ ] `deno task migrate-scan-ids` is wired in `deno.json` and documented in the wave README
- [ ] `atlas.html:535` and `:845` state the new `scanId` meaning with a before/after diff
- [ ] `deno task check`, `deno task test`, `npm run verify` all pass

## Tests

- [ ] `migrate_scan_ids.test.ts`: two `StoredScanInfo`s with different filenames and the **same**
      `meta.sessionId` yield two distinct `scanId`s
- [ ] `migrate_scan_ids.test.ts`: a scan with no `meta.sessionId` gets the same id it gets today
      (the existing filename branch is unchanged)
- [ ] `migrate_scan_ids.test.ts`: a `registerSessionScan`-shaped scan (filename
      `${sessionId}.glb`) keeps its current id exactly — this is the regression guard for the
      ingest path
- [ ] `migrate_scan_ids.test.ts`: migrating a fixture world holding the real four-way collision
      (the four filenames and detection counts from `worlds/default.json`) yields **four distinct
      scanIds**, one per filename
- [ ] `migrate_scan_ids.test.ts`: an `EditPatch` whose `scanId` was the collided id is re-pointed
      at the newest scan of that session, and the ambiguity is logged
- [ ] `migrate_scan_ids.test.ts`: an `EditPatch` whose `scanId` matched exactly one scan is
      re-pointed with no ambiguity log
- [ ] `migrate_scan_ids.test.ts`: a `WorldJob` carrying the collided `scanId` is re-pointed by
      the same rule (and an `optimize-scan` job with no `scanId` is left untouched)
- [ ] `migrate_scan_ids.test.ts`: **idempotency** — running the migration twice over the same
      fixture leaves the second run reporting zero changes and the file byte-identical to after
      the first
- [ ] `migrate_scan_ids.test.ts`: a world file that is not valid JSON makes the migration throw,
      not silently skip
- [ ] `migrate_scan_ids.test.ts`: every scan's `frameSetUrl` after migration contains its own new
      `scanId`
- [ ] `world_lock.test.ts` stays green (the migration must not deadlock the lock it borrows)
- [ ] `migrate_scan_ids.test.ts` is appended to `deno.json`'s `test` task file list

```
deno task check
deno task test
npm run verify
```

## Acceptance Criteria

- [ ] Given a walkthrough that autosaves four times, When the four GLBs land, Then
      `worlds/<slug>.json` holds four scans with four distinct `scanId`s
- [ ] Given those four scans, When the World Editor loads the world, Then the HUD reads
      "4 scans loaded" and four roots are present in `worldGroup`
- [ ] Given a transform saved against the third scan, When the world is reloaded, Then the patch
      replays onto the third scan only
- [ ] Given four scans and four `memory-push` jobs, When all four run, Then CI-Server receives
      four distinct `source_id`s and no event overwrites another
- [ ] Given a world file with the four-way collision, When `deno task migrate-scan-ids` runs,
      Then four distinct ids are written and every patch/job reference is re-pointed or logged
- [ ] Given a migrated world file, When the migration is run a second time, Then it reports
      nothing to migrate and the file is unchanged on disk
- [ ] Given a video-ingest scan, When the migration runs, Then its `scanId` is unchanged
- [ ] Given one of four scans is deleted via `DELETE /scans`, Then only that scan's patches and
      jobs are removed, and the siblings' survive

## Risks / potential issues

- **Risk:** `memory_push` has already sent `scan-session-1787174216556` to CI-Server as
  `source_id` (`memory_push.ts:244`, `:323`). Idempotency is `(source_system, source_id)`
  (`memory_push.ts:31`), so re-pushing under the new ids creates **new** memory events rather
  than updating the existing one. The old event stays behind, orphaned, describing whichever
  scan happened to win the collision. — **Mitigation:** this is judged acceptable: the existing
  event is already wrong (it collapses four scans into one), and the alternative — carrying a
  legacy-id alias forward — preserves the wrong record forever. Say so plainly in the commit
  message and the wave README. If an operator needs the old event gone, that is a manual
  CI-Server cleanup, out of scope here. **`sourceSystem` `'companion-scan'` must not change**
  (CLAUDE.md do-not-rename) — only the id value moves.
- **Risk:** `frameSetUrl` embeds `scanId` (`main.ts:1397-1399`), so every stored URL of the form
  `/worlds/default/frames/scan-session-…` becomes a 404 against `main.ts:3067-3081`. —
  **Mitigation:** the migration regenerates `frameSetUrl` from the new id; it is derived, never
  authored. Any client holding a stale URL just refetches the world. (Those URLs return
  `count: 0` today anyway — see ticket 0002.)
- **Risk:** `safeSlug` (`main.ts:1178-1184`) is lossy — it lowercases and maps every character
  outside `[a-z0-9_-]` to `-`, collapsing runs. Two distinct filenames can in principle slug to
  one id (`a.b.glb` and `a-b.glb`), reintroducing a collision through the back door. —
  **Mitigation:** the migration must assert uniqueness of the derived ids within each world and
  fail loudly (not silently dedupe) if two filenames collide; `scanIdFor` should carry a comment
  naming this. In practice the `${ts}_` prefix from `createScanFileExclusive` makes it very
  unlikely, but "very unlikely" is how this bug got here.
- **Risk:** Running the migration while the server is up races it — `world_lock.ts` is
  in-process only (ADR 0004, "In-process only"). — **Mitigation:** pinned above: run with the
  server stopped; the script's header and the wave README both say so, and the script warns.
- **Risk:** Order of operations. If the server boots with the new `scanIdFor` before the
  migration runs, `refreshWorldScans` re-ids the scan entries while patches and jobs still name
  the old id, so those references dangle until the migration runs. — **Mitigation:** the
  migration derives the old id from `ScanManifest.sessionId` rather than reading it out of the
  file, so it works correctly in either order (answered above). Still: run the migration first.
- **Risk:** Both this ticket and 0002 edit `main.ts`, and 0002 also touches `sessionDir` /
  `SESSION_ID_RE`, which `frameObservationsForScan` (`main.ts:2867-2870`) sits next to. —
  **Mitigation:** the two changes are in different functions; land whichever is ready first and
  rebase the other. Neither depends on the other's behaviour.
- **Risk:** `applyStoredPatches` (`src/viewer/viewer.ts:881`, `:883`) also matches on
  `scan.filename`, so filename-scoped patches were never broken and must not be
  double-remapped. — **Mitigation:** the migration only touches `patch.scanId`; it leaves
  `patch.targetId` alone.
- **Risk:** The fixture duplicates real data from `worlds/default.json`, which is a working
  file that may be pruned or regenerated. — **Mitigation:** commit the fixture as its own file
  under `tests/fixtures/` so the test does not depend on the live world.

## Subtasks

1. [ ] Read `migrate_jobs.ts` end to end and `main.ts:1603-1666`; confirm the re-derivation
       behaviour described above before writing any code
2. [ ] Change `scanIdFor` (`main.ts:1359-1363`) to derive from the filename only; document the
       semantics change in its doc comment
3. [ ] Add `scanId` to `refreshWorldScans`'s `changed` comparison (`main.ts:1644-1648`)
4. [ ] Fix `removeScanFromWorlds` (`main.ts:1526-1537`) to filter patches and GC jobs by the
       removed scan's derived `scanId`
5. [ ] Write `migrate_scan_ids.ts`: pure core (world in → world out + summary) plus an
       `import.meta.main` wrapper; mutate only inside `withWorldLock`
6. [ ] Implement the patch/job remap with the newest-scan-of-that-session rule and the
       ambiguity log
7. [ ] Assert derived-id uniqueness per world; fail loudly on a slug collision
8. [ ] Regenerate `frameSetUrl` for every migrated scan
9. [ ] Add the `migrate-scan-ids` task to `deno.json` and append the test to the `test` task
10. [ ] Build the four-way-collision fixture from the real `worlds/default.json` data
11. [ ] Write `migrate_scan_ids.test.ts` covering every box in Tests, idempotency included
12. [ ] Run the migration against the real `worlds/default.json` with the server stopped; confirm
        four distinct ids and a clean second run
13. [ ] Load the World Editor and confirm the HUD reads "4 scans loaded"
14. [ ] Update `atlas.html:535` and `:845` with before/after diff markup, and the wave README
15. [ ] `deno task check` · `deno task test` · `npm run verify`
